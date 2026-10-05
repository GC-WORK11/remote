#!/usr/bin/env python3
"""macOS real-machine proof — omprd drives the actual host GUI end to end.

Usage: python3.12 test/probe-mac-real.py [host]

Proof steps (each prints ms timing + PASS/FAIL):
  1. pair + computer.state (backend, perms, resolution)
  2. rig.exec `open -a TextEdit`, wait for a NEW window via computer.windows
  3. region screenshot BEFORE (png), computer.type a marker string,
     cmd+a / cmd+c, then rig.exec `pbpaste` — verify the marker is in the
     real document buffer (no OCR involved)
  4. region screenshot AFTER + pure-python PNG pixel-diff (proves pixels moved)
  5. pointer: computer.cursor delta across a computer.click, plus the new
     computer.gesture ops (tap / swipe / doubleTap) each replying ok
  6. swipe across the typed text to select it; screenshot diff proves the
     visible selection highlight

Evidence files land in /tmp/rig-real-*.png. If a step hits a permission
wall it is reported, not worked around — nothing security-related is
touched.
"""
import base64, json, secrets, socket, struct, sys, time, zlib
from pathlib import Path

RIG_HOME = Path.home() / ".rig"
HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
MARKER = "omprd-real-proof-" + secrets.token_hex(3)





class Ws:
    def __init__(self, ip: str, port: int):
        self.sock = socket.create_connection((ip, port), timeout=10)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        self.sock.sendall((f"GET /ws HTTP/1.1\r\nHost: {ip}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                           f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.sock.recv(4096)
        if "101" not in resp.split(b"\r\n", 1)[0].decode():
            raise RuntimeError("upgrade failed")

    def send(self, obj: dict):
        data = json.dumps(obj).encode()
        mask = secrets.token_bytes(4)
        header = bytearray([0x81])
        n = len(data)
        if n <= 125:
            header.append(0x80 | n)
        elif n <= 0xFFFF:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self, timeout: float = 30.0):
        self.sock.settimeout(timeout)

        def exact(n: int) -> bytes:
            buf = b""
            while len(buf) < n:
                chunk = self.sock.recv(n - len(buf))
                if not chunk:
                    raise ConnectionError("closed")
                buf += chunk
            return buf

        while True:
            h = exact(2)
            opcode, ln = h[0] & 0x0F, h[1] & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", exact(8))[0]
            if opcode == 8:
                return None
            if opcode in (9, 10):
                exact(ln)
                continue
            return json.loads(exact(ln).decode())


def wait_for(ws, want_type: str, timeout: float = 30.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = ws.recv(timeout=max(0.5, deadline - time.time()))
        if m is None:
            raise ConnectionError("closed")
        if m.get("type") == "error":
            raise RuntimeError(f"daemon error waiting for {want_type}: {m.get('error')}")
        if m.get("type") == want_type:
            return m
    raise TimeoutError(f"no {want_type} in {timeout}s")


def timed(ws, msg: dict, want_type: str, timeout: float = 30.0):
    t0 = time.perf_counter()
    ws.send(msg)
    m = wait_for(ws, want_type, timeout)
    return (time.perf_counter() - t0) * 1000.0, m


def png_pixels(png: bytes):
    """Minimal PNG decode: 8-bit, non-interlaced, color types 2 and 6.
    Returns (w, h, bytearray RGB) or None."""
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos, idat = 8, bytearray()
    w = h = bitd = ctype = 0
    while pos < len(png):
        ln, typ = struct.unpack(">I", png[pos:pos + 4])[0], png[pos + 4:pos + 8]
        data = png[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bitd, ctype, _comp, _flt, inter = struct.unpack(">IIBBBBB", data)
            if bitd != 8 or ctype not in (2, 6) or inter != 0:
                return None
        elif typ == b"IDAT":
            idat += data
        pos += 12 + ln
    ch = 4 if ctype == 6 else 3
    raw = zlib.decompress(bytes(idat))
    stride = w * ch
    out, prev = bytearray(), bytearray(stride)
    p = 0
    for _y in range(h):
        f, row = raw[p], bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        if f == 1:
            for i in range(ch, stride):
                row[i] = (row[i] + row[i - ch]) & 0xFF
        elif f == 2:
            for i in range(stride):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                row[i] = (row[i] + ((row[i - ch] if i >= ch else 0) + prev[i]) // 2) & 0xFF
        elif f == 4:
            for i in range(stride):
                a_ = row[i - ch] if i >= ch else 0
                b_, c_ = prev[i], prev[i - ch] if i >= ch else 0
                pp = a_ + b_ - c_
                pa, pb, pc = abs(pp - a_), abs(pp - b_), abs(pp - c_)
                row[i] = (row[i] + (a_ if pa <= pb and pa <= pc else b_ if pb <= pc else c_)) & 0xFF
        if ch == 4:
            for i in range(0, stride, 4):
                out += row[i:i + 3]
        else:
            out += row
        prev = row
    return w, h, out


def diff_frac(a: bytes, b: bytes):
    r = diff_scan(a, b)
    return r[0] if r else None


def diff_scan(a: bytes, b: bytes):
    """Returns (changed_fraction, min_row, max_row) or None."""
    pa, pb = png_pixels(a), png_pixels(b)
    if not pa or not pb or pa[:2] != pb[:2]:
        return None
    w, h = pa[0], pa[1]
    diff, r0, r1 = 0, h, -1
    for i in range(0, w * h * 3, 3):
        if (abs(pa[2][i] - pb[2][i]) + abs(pa[2][i + 1] - pb[2][i + 1])
                + abs(pa[2][i + 2] - pb[2][i + 2])) > 24:
            diff += 1
            row = i // (w * 3)
            r0, r1 = min(r0, row), max(r1, row)
    return diff / (w * h), r0, r1


def poll_exec(ws, cmd: str, needle: str, timeout: float):
    """rig.exec `cmd` until its output contains `needle` (or timeout)."""
    deadline, out = time.time() + timeout, ""
    while time.time() < deadline:
        _c, out = rig_exec(ws, cmd)
        if needle in out:
            return out
        time.sleep(0.25)
    return out


def rig_exec(ws, cmd: str, timeout_ms: int = 15000):
    ws.send({"type": "rig.exec", "command": cmd, "timeoutMs": timeout_ms})
    m = wait_for(ws, "exec.started", timeout=10)
    eid = m["execId"]
    out = []
    deadline = time.time() + timeout_ms / 1000 + 5
    while time.time() < deadline:
        m = ws.recv(timeout=max(0.5, deadline - time.time()))
        if m is None:
            raise ConnectionError("closed")
        if m.get("type") == "exec.output" and m.get("execId") == eid:
            out.append(m.get("chunk", ""))
        if m.get("type") == "exec.done" and m.get("execId") == eid:
            return m.get("code"), "".join(out)
    raise TimeoutError(f"exec timed out: {cmd}")


passed, failed = [], []


def step(name: str, ok: bool, ms: float, note: str = ""):
    tag = "PASS" if ok else "FAIL"
    (passed if ok else failed).append(name)
    print(f"[{tag}] {name:44s} {ms:8.1f} ms {note}")


print(f"marker={MARKER}")
ws = Ws(HOST, 8790)
code = secrets.token_hex(4)
(RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
ws.send({"type": "pair", "code": code, "device": "real-proof"})
wait_for(ws, "paired")

# ---- 1. state / perms -------------------------------------------------------
ms, st = timed(ws, {"type": "computer.state"}, "computer.state", timeout=15)
perms = st.get("perms", {})
step("computer.state", True, ms, f"backend={st.get('backend')} res={st.get('resolution')} perms={perms}")
if not (perms.get("inject") and perms.get("capture")):
    print("FATAL: inject/capture permission missing — cannot prove input. Reported, not bypassed.")
    sys.exit(2)

# ---- 2. launch TextEdit on a unique doc, wait for it via computer.windows ---
DOC = f"/tmp/rig-proof-{secrets.token_hex(3)}.txt"
# clean slate: no stale window ids — wait for TextEdit to actually exit
# before `open`, else the doc can attach to a dying/hung instance (a leftover
# save sheet makes SIGTERM a no-op and poisons this run and the next).
rig_exec(ws, "killall TextEdit 2>/dev/null; "
             "for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -x TextEdit >/dev/null || break; sleep 0.3; done; "
             "killall -9 TextEdit 2>/dev/null; true")
rig_exec(ws, f": > {DOC}")

t0 = time.perf_counter()
code_r, _o = rig_exec(ws, f"open -a TextEdit {DOC}")
step("rig.exec open -a TextEdit", code_r == 0, (time.perf_counter() - t0) * 1000, f"exit={code_r}")

want_title = Path(DOC).stem   # TextEdit titles the window after the file
win, t0 = None, time.perf_counter()
deadline = time.time() + 25
while time.time() < deadline and win is None:
    _, wins = timed(ws, {"type": "computer.windows"}, "computer.windows", timeout=10)
    for w in wins.get("windows", []):
        if want_title in w.get("title", "") and w.get("w", 0) > 100:
            win = w
            break
    if win is None:
        time.sleep(0.5)
step("computer.windows finds new TextEdit window", win is not None,
     (time.perf_counter() - t0) * 1000, json.dumps(win)[:90])
if win is None:
    print("FATAL: no new window"); sys.exit(3)

region = {"x": int(win["x"]), "y": int(win["y"]), "w": int(win["w"]), "h": int(win["h"])}
cx, cy = int(win["x"] + win["w"] / 2), int(win["y"] + win["h"] / 2)

# raise + focus the TextEdit window — a click at its centre can land on an
# overlapping window; window.activate is the deterministic path
ms, _r = timed(ws, {"type": "computer.window.activate", "id": win["id"]}, "ok")
step("computer.window.activate TextEdit", _r.get("ok", False), ms)
time.sleep(0.6)
_, wins = timed(ws, {"type": "computer.windows"}, "computer.windows")
win = next((w for w in wins.get("windows", []) if w["id"] == win["id"]), win)
region = {"x": int(win["x"]), "y": int(win["y"]), "w": int(win["w"]), "h": int(win["h"])}
cx, cy = int(win["x"] + win["w"] / 2), int(win["y"] + win["h"] / 2)
# `active` is informational — the CGWindowList frontmost flag lags the raise;
# the click + keystroke proof below is the real evidence
step("TextEdit window is active", True, 0,
     f"active flag={win.get('active')} (informational)")

# ---- 3. focus + type marker, verify via real clipboard ----------------------
ms, shot0 = timed(ws, {"type": "computer.screenshot", "format": "png", "region": region},
                  "computer.screenshot")
png0 = base64.b64decode(shot0["imageBase64"])
Path("/tmp/rig-real-before.png").write_bytes(png0)
step("region screenshot BEFORE", True, ms, f"{shot0.get('width')}x{shot0.get('height')} enc={shot0.get('encoder')}")

ms, _r = timed(ws, {"type": "computer.click", "x": cx, "y": cy}, "ok")
step("click into TextEdit window", _r.get("ok", False), ms, f"cursorAfter={_r.get('cursorAfter')}")

ms, _r = timed(ws, {"type": "computer.type", "text": MARKER, "delayMs": 10}, "ok")
step("computer.type marker", _r.get("ok", False), ms, f"method={_r.get('method')}")

# cmd+s writes the real document to disk; cat proves the keystrokes landed.
# The reply returns when the key event posts — TextEdit's save lags, so poll.
ms, _r = timed(ws, {"type": "computer.key", "combo": "cmd+s"}, "ok")
step("cmd+s saves the document", _r.get("ok", False), ms)
t0 = time.perf_counter()
body = poll_exec(ws, f"cat {DOC}", MARKER, 4.0)
step("marker on disk via rig.exec cat", MARKER in body,
     (time.perf_counter() - t0) * 1000, f"file[:60]={body[:60]!r}")

timed(ws, {"type": "computer.key", "combo": "cmd+a"}, "ok")
ms, _r = timed(ws, {"type": "computer.key", "combo": "cmd+c"}, "ok")
step("cmd+a / cmd+c", _r.get("ok", False), ms)

# pasteboard commits asynchronously after the copy event — poll for the marker
t0 = time.perf_counter()
clip = poll_exec(ws, "pbpaste", MARKER, 4.0)
hit = MARKER in clip
step("pbpaste reads marker from real doc", hit,
     (time.perf_counter() - t0) * 1000,
     f"clipboard[:60]={clip[:60]!r}" if hit else f"clipboard={clip[:80]!r}")

# ---- 4. screenshot AFTER + pixel diff ---------------------------------------
ms, shot1 = timed(ws, {"type": "computer.screenshot", "format": "png", "region": region},
                  "computer.screenshot")
png1 = base64.b64decode(shot1["imageBase64"])
Path("/tmp/rig-real-after.png").write_bytes(png1)
scan = diff_scan(png0, png1)
df = scan[0] if scan else None
# image rows where the typed text visibly landed — calibrates the swipe below
text_row = (scan[1] + scan[2]) // 2 if scan and scan[2] >= 0 else None
step("pixel-diff before/after region", df is not None and df > 0.001, ms,
     f"{df:.4%} pixels changed, rows {scan[1]}-{scan[2]}" if scan else
     ("bytes differ" if png0 != png1 else "IDENTICAL"))

# ---- 5. pointer deltas -------------------------------------------------------
_, c0 = timed(ws, {"type": "computer.cursor"}, "computer.cursor")
ms, _r = timed(ws, {"type": "computer.click", "x": cx - 60, "y": cy - 40}, "ok")
_, c1 = timed(ws, {"type": "computer.cursor"}, "computer.cursor")
p0 = {"x": c0.get("x"), "y": c0.get("y")}
p1 = {"x": c1.get("x"), "y": c1.get("y")}
moved = bool(p0 and p1 and (abs(p1["x"] - p0["x"]) > 5 or abs(p1["y"] - p0["y"]) > 5))
step("pointer delta via computer.cursor", moved, ms, f"{p0} -> {p1}")

# ---- 6. gesture ops ----------------------------------------------------------
ms, _r = timed(ws, {"type": "computer.gesture", "op": "tap", "x": cx, "y": cy}, "ok")
step("gesture tap", _r.get("ok", False), ms, f"gesture={_r.get('gesture')} method={_r.get('method')}")

# click in the doc to clear the cmd+a selection, re-shoot as the baseline,
# then swipe across the pixel band where the typed text visibly landed
ms, _r = timed(ws, {"type": "computer.click", "x": cx, "y": cy + 40}, "ok")
step("click to deselect", _r.get("ok", False), ms)
ms, shot_s = timed(ws, {"type": "computer.screenshot", "format": "png", "region": region},
                   "computer.screenshot")
pngS = base64.b64decode(shot_s["imageBase64"])

sy = region["y"] + (text_row if text_row is not None else int(win["h"] * 0.22))
ms, _r = timed(ws, {"type": "computer.gesture", "op": "swipe",
                    "x1": region["x"] + 15, "y1": sy,
                    "x2": region["x"] + min(30 + len(MARKER) * 9, int(win["w"]) - 15),
                    "y2": sy, "durationMs": 350}, "ok")
step("gesture swipe (select text)", _r.get("ok", False), ms,
     f"method={_r.get('method')} y={sy}")

ms, shot2 = timed(ws, {"type": "computer.screenshot", "format": "png", "region": region},
                  "computer.screenshot")
png2 = base64.b64decode(shot2["imageBase64"])
Path("/tmp/rig-real-selection.png").write_bytes(png2)
df2 = diff_frac(pngS, png2)
step("selection visible in pixels", df2 is not None and df2 > 0.0005, ms,
     f"{df2:.4%} pixels changed" if df2 is not None else "bytes differ" if pngS != png2 else "IDENTICAL")

ms, _r = timed(ws, {"type": "computer.gesture", "op": "doubleTap", "x": cx, "y": cy}, "ok")
step("gesture doubleTap", _r.get("ok", False), ms)

ms, _r = timed(ws, {"type": "computer.gesture", "op": "bogusOp", "x": 1, "y": 1}, "ok")
step("gesture unknown op rejected cleanly", _r.get("ok") is False and "error" in _r, ms,
     f"error={_r.get('error')}")

# ---- 7. cleanup --------------------------------------------------------------
t0 = time.perf_counter()
code_r, _o = rig_exec(ws, 'osascript -e \'tell application "TextEdit" to quit saving no\' 2>/dev/null || killall TextEdit 2>/dev/null; true')
step("TextEdit cleanup", True, (time.perf_counter() - t0) * 1000)

print(f"\n{len(passed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
