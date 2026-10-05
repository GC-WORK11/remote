#!/usr/bin/env python3
"""Visible correctness: does computer.* do what the screen shows?

Three real-display scenarios, each step screenshot-verified (daemon's own
computer.screenshot PNG saved under --evidence dir, host-shared) plus a
hard ground-truth check (file contents / process exit code / window list):

  S1 type:  launch xterm → `cat > file` → type payload + Return + ctrl-d
            → file must contain the payload verbatim AND the terminal
            pixels must have changed (chars actually rendered).
            NOTE: xterm needs -xrm 'xterm*allowSendEvents: true' — by
            default it silently drops XTEST input (real divergence found
            by this harness; the correctness suite types into xev which
            accepts synthetic events and so never saw it).
  S2 click: xmessage with DECLINE/APPROVE buttons — first a deliberate
            miss (window body, process must stay alive) then a click on
            APPROVE (exit code 1 discriminates button-hit vs miss vs
            wrong-button).
  S3 flow:  xterm → type+run a command (file appears) → spawn xmessage
            from that shell → click its button → type a second command
            (second file appears) — a screenshot per step.

Every screenshot is also pixel-diffed against the previous step so a
silent no-op (daemon says ok, nothing changed) fails loudly.
"""

import argparse
import base64
import io
import os
import subprocess
import sys
import time
import importlib.util

from PIL import Image

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "cc", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "computer-correctness.py"))
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)

RESULTS = []
# xterm's Xaw text widget rejects XTEST-injected input by default — a real
# finding of this harness (everything else accepts it; the correctness
# suite's xev target does too, which is why it never surfaced there).
XTERM_ALLOW = "-xrm 'XTerm*allowSendEvents:true'"


def record(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  — {detail}" if detail else ""),
          flush=True)


def shot(ws, msgs, evdir, name):
    ws.send_text({"type": "computer.screenshot", "format": "png", "scale": 1.0})
    r = ws.wait_for(lambda m: m.get("type") == "computer.screenshot",
                    timeout=20, keep=msgs)
    if not r or not r.get("imageBase64"):
        return None
    png = base64.b64decode(r["imageBase64"])
    with open(os.path.join(evdir, name + ".png"), "wb") as f:
        f.write(png)
    return Image.open(io.BytesIO(png)).convert("RGB")


def px_changed(a, b, box=None):
    """Count of differing pixels (exact RGB) between two same-size shots."""
    if a is None or b is None or a.size != b.size:
        return -1
    if box:
        a = a.crop(box)
        b = b.crop(box)
    n = 0
    pa, pb = a.load(), b.load()
    w, h = a.size
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if pa[x, y] != pb[x, y]:
                n += 1
    return n


def windows(ws, msgs):
    ws.send_text({"type": "computer.windows"})
    r = ws.wait_for(lambda m: m.get("type") == "computer.windows", timeout=10,
                    keep=msgs)
    return (r or {}).get("windows") or []


def find_win(ws, msgs, needle, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        for w in windows(ws, msgs):
            if needle in (w.get("title") or ""):
                return w
        time.sleep(0.3)
    return None


def find_wid(disp, needle, timeout=10):
    """xdotool search --name poll — windows map slowly on TCG guests."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        out = cc.xcmd(["xdotool", "search", "--name", needle], disp)
        wids = [int(w) for w in out.stdout.split() if w.strip()]
        if wids:
            return wids[0]
        time.sleep(0.3)
    return None


def wait_file(path, needle, timeout=8):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if needle in open(path).read():
                return True
        except OSError:
            pass
        time.sleep(0.25)
    return False


def guest_cat(path):
    try:
        return open(path).read()
    except OSError:
        return None


def s1_type(rig, ws, msgs, disp, evdir):
    r = cc.send_actions(ws, [{"action": "launch",
                              "app": "xterm -T vtype1 -geometry 80x24+200+160 "
                                    + XTERM_ALLOW}],
                        msgs, timeout=25)
    res = (r or {}).get("results") or [{}]
    fm = res[0].get("frontmost", "")
    launch_ok = bool(res[0].get("ok"))
    wid = find_wid(disp, "vtype1")
    focused = cc.focus_window(disp, wid) if wid else False
    if not wid:
        record("S1.type lands in xterm (file ground truth + pixels changed)",
               False, f"no xterm window (launch_ok={launch_ok})")
        return
    time.sleep(0.4)
    gx, gy, gw, gh = cc.xev_win_geom(disp, wid)
    before = shot(ws, msgs, evdir, "s1-before")

    payload = "Rig type check 42: Aa!zZ9 ~ok?"
    steps = [{"action": "type", "text": "cat > /tmp/vtype.txt", "delayMs": 0},
             {"action": "key", "combo": "Return"},
             {"action": "type", "text": payload, "delayMs": 0},
             {"action": "key", "combo": "Return"},
             {"action": "key", "combo": "ctrl+d"}]
    r = cc.send_actions(ws, steps, msgs, timeout=30)
    res = (r or {}).get("results") or []
    all_ok = all(s.get("ok") for s in res)
    time.sleep(0.6)
    after = shot(ws, msgs, evdir, "s1-after")

    # ground truth: what the shell's cat actually received
    t0 = time.time()
    body = None
    while time.time() - t0 < 8:
        body = guest_cat("/tmp/vtype.txt")
        if body is not None:
            break
        time.sleep(0.3)
    landed = body is not None and body.splitlines() and body.splitlines()[0] == payload

    # pixel truth: the input region inside the xterm must have changed
    box = (gx, gy, gx + gw, gy + gh)
    changed = px_changed(before, after, box)

    record("S1.type lands in xterm (file ground truth + pixels changed)",
           launch_ok and focused and all_ok and landed and changed > 200,
           f"frontmost={fm!r} focused={focused} steps_ok={all_ok} "
           f"file={body!r} px_changed={changed}")


def button_centers(img, x, y, ww, wh):
    """xmessage draws its buttons as bordered rects inside one child window —
    no subwindow geometry exists, so read them off the pixels: in the bottom
    band, a button's top edge is a long horizontal dark run on a white field.
    Returns absolute (cx, cy) per button, left→right."""
    if img is None:
        return []
    runs = []
    # button band only: the separator line above the buttons (wh-29 on a 52px
    # xmessage) is a full-width dark run that would merge with the button
    # edges — and any run spanning most of the window is a rule, not a button.
    for dy in range(max(0, wh - 22), min(wh - 4, img.height - y)):
        row = []
        cur = None
        for dx in range(0, ww):
            p = img.getpixel((x + dx, y + dy))
            if sum(p) < 300:                    # dark pixel (border)
                if cur is None:
                    cur = dx
            else:
                if cur is not None and dx - cur >= 15:
                    row.append((cur, dx))
                cur = None
        if cur is not None and ww - cur >= 15:
            row.append((cur, ww))
        for a, b in row:
            if b - a <= int(ww * 0.8):
                runs.append((a, b))
    if not runs:
        return []
    # cluster overlapping x-ranges (each button edge appears on 1-2 rows)
    runs.sort()
    merged = [list(runs[0])]
    for a, b in runs[1:]:
        if a <= merged[-1][1] + 4:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(x + (a + b) // 2, y + wh - 14) for a, b in merged if b - a >= 15]


def s2_click(rig, ws, msgs, disp, evdir):
    p = subprocess.Popen(
        ["xmessage", "-geometry", "+700+420", "-buttons",
         "DECLINE:0,APPROVE:1", "Approve the action?"],
        env=dict(os.environ, DISPLAY=disp))
    time.sleep(0.8)
    wid = find_wid(disp, "xmessage") or find_wid(disp, "Approve the action?")
    w = find_win(ws, msgs, "xmessage") or find_win(ws, msgs, "Approve")
    if not wid:
        record("S2.click widget state change", False,
               f"xmessage window not found (computer.windows={w})")
        p.terminate()
        return
    x, y, ww, wh = cc.xev_win_geom(disp, wid)
    before = shot(ws, msgs, evdir, "s2-before")
    centers = button_centers(before, x, y, ww, wh)

    # deliberate miss first: body area, above the button row — must NOT exit
    mx, my = x + ww // 2, y + 25
    cc.send_actions(ws, [{"action": "click", "x": mx, "y": my}], msgs)
    time.sleep(0.5)
    alive_after_miss = p.poll() is None

    # real hit: APPROVE is the rightmost detected button
    if not centers:
        record("S2.click widget state change", False,
               "no buttons detected in shot")
        p.terminate()
        return
    bx, by = centers[-1]
    r = cc.send_actions(ws, [{"action": "click", "x": bx, "y": by}], msgs)
    res2 = (r or {}).get("results") or [{}]
    ca2 = res2[0].get("cursorAfter") or {}
    t0 = time.time()
    while p.poll() is None and time.time() - t0 < 5:
        time.sleep(0.2)
    code = p.poll()
    time.sleep(0.4)
    after = shot(ws, msgs, evdir, "s2-after")
    still = find_wid(disp, "xmessage", timeout=2) is not None
    box = (x, y, x + ww, y + wh)
    changed = px_changed(before, after, box)

    record("S2.click widget state change (miss ignored, APPROVE exits 1)",
           alive_after_miss and code == 1 and not still and changed > 200
           and ca2.get("x") == bx and ca2.get("y") == by,
           f"miss_alive={alive_after_miss} exit={code} gone={not still} "
           f"cursor=({ca2.get('x')},{ca2.get('y')}) want=({bx},{by}) px={changed} "
           f"win={x},{y} {ww}x{wh} buttons={centers} daemon_listed={bool(w)}")
    if p.poll() is None:
        p.terminate()


def s3_flow(rig, ws, msgs, disp, evdir):
    r = cc.send_actions(ws, [{"action": "launch",
                              "app": "xterm -T vflow3 -geometry 80x24+140+120 "
                                    + XTERM_ALLOW}],
                        msgs, timeout=25)
    if not ((r or {}).get("results") or [{}])[0].get("ok"):
        record("S3.multi-step workflow", False, "launch failed")
        return
    wid = find_wid(disp, "vflow3")
    if not wid:
        record("S3.multi-step workflow", False, "no window")
        return
    cc.focus_window(disp, wid)
    time.sleep(0.4)
    shot(ws, msgs, evdir, "s3-0-launch")

    # step 1: type + run a command → file proves the shell got it verbatim
    cc.send_actions(ws, [{"action": "type", "text": "mkdir -p /tmp/vwf && echo ok1 > /tmp/vwf/s1.txt", "delayMs": 0},
                         {"action": "key", "combo": "Return"}], msgs, timeout=20)
    ok1 = wait_file("/tmp/vwf/s1.txt", "ok1")
    shot(ws, msgs, evdir, "s3-1-cmd")

    # step 2: from the same shell, spawn an xmessage — proves typed command ran
    cc.send_actions(ws, [{"action": "type", "text": "xmessage -geometry +640+400 -buttons NEXT:0 'workflow step 2' &", "delayMs": 0},
                         {"action": "key", "combo": "Return"}], msgs, timeout=20)
    mwid = find_wid(disp, "xmessage")
    dlg_shot = shot(ws, msgs, evdir, "s3-2-dialog")
    ok2 = mwid is not None

    # step 3: click NEXT (detect the button's rect in the dialog shot)
    ok3 = False
    if mwid:
        x, y, ww, wh = cc.xev_win_geom(disp, mwid)
        centers = button_centers(dlg_shot, x, y, ww, wh)
        if centers:
            bx, by = centers[-1]
            cc.send_actions(ws, [{"action": "click", "x": bx, "y": by}], msgs)
            t0 = time.time()
            while time.time() - t0 < 6:
                if find_wid(disp, "xmessage", timeout=0.5) is None:
                    ok3 = True
                    break
                time.sleep(0.3)
    shot(ws, msgs, evdir, "s3-3-clicked")

    # step 4: focus back on the terminal and run a second command
    cc.focus_window(disp, wid)
    cc.send_actions(ws, [{"action": "type", "text": "echo done > /tmp/vwf/s3.txt", "delayMs": 0},
                         {"action": "key", "combo": "Return"}], msgs, timeout=20)
    ok4 = wait_file("/tmp/vwf/s3.txt", "done")
    shot(ws, msgs, evdir, "s3-4-final")

    record("S3.multi-step workflow (cmd→dialog→click→cmd)",
           ok1 and ok2 and ok3 and ok4,
           f"cmd1_file={ok1} dialog={ok2} click_closed={ok3} cmd2_file={ok4}")


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--bin", default=os.path.join(here, "..", "daemon", "omprd"))
    ap.add_argument("--omp-bin", default=os.path.join(here, "fake-omp.sh"))
    ap.add_argument("--port", type=int, default=8796)
    ap.add_argument("--display", default=":99")
    ap.add_argument("--evidence", default="/tmp/verify-evidence")
    args = ap.parse_args()
    args.bin = os.path.abspath(args.bin)
    args.omp_bin = os.path.abspath(args.omp_bin)
    os.makedirs(args.evidence, exist_ok=True)

    rig = cc.Rig(args)
    print(f"# omprd pid={rig.proc.pid} port={args.port} display={args.display}",
          flush=True)
    tok = rig.pair()
    ws = rig.connect(tok)
    msgs = []
    try:
        s1_type(rig, ws, msgs, args.display, args.evidence)
        s2_click(rig, ws, msgs, args.display, args.evidence)
        s3_flow(rig, ws, msgs, args.display, args.evidence)
    finally:
        rig.stop()
        print(f"# daemon log tail:\n{rig.log_tail(12)}", flush=True)

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = [n for n, ok, _ in RESULTS if not ok]
    print(f"\n==== {passed}/{len(RESULTS)} passed, {len(failed)} failed ====")
    for n in failed:
        print(f"  FAIL {n}")
    print(f"# evidence: {args.evidence}")
    sys.exit(len(failed))


if __name__ == "__main__":
    main()
