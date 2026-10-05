#!/usr/bin/env python3
"""remote v0.4 e2e: native X11 pipeline under brutal, asserted thresholds.

Every latency claim is measured and ASSERTED, not narrated. The interactive
scenario is a real user flow: launch an app, wait for its window, click in,
type text with hotkeys, observe the machine state in one round trip, manage
windows, batch a whole action sequence in a single round trip.
"""
import base64
import json
import secrets
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from client import Ws, wait_for  # noqa: E402

RIG_HOME = Path.home() / ".rig"

# brutal but fair budgets (ms) — native XTest/XShm path, measured with margin
BUDGET_CLICK_MS = 15        # single click round trip
BUDGET_KEY_MS = 15          # single hotkey round trip
BUDGET_TYPE_MS = 120        # 20 chars typed
BUDGET_SHOT_PNG_MS = 120    # full-res PNG capture+encode 1080p
BUDGET_OBSERVE_MS = 150     # screenshot + cursor + windows in one RTT
BUDGET_BATCH_MS = 250       # 8-step batch in one RTT


def ok(label):
    print(f"  ✓ {label}")


def fail(msg):
    print(f"  ✗ {msg}")
    sys.exit(1)


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790

    RIG_HOME.mkdir(exist_ok=True)
    code = f"{secrets.randbelow(1000000):06d}"
    (RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
    ws = Ws(ip, port)
    ws.send({"type": "pair", "code": code, "device": "v4-brutal"})
    wait_for(ws, "paired")
    ok("pairing")

    # native backend must be live
    ws.send({"type": "computer.state"})
    st = wait_for(ws, "computer.state", timeout=20)
    assert st["nativeBackend"] and st["shm"] and st["xtest"], f"native backend not available: {st}"
    ok(f"native backend: shm={st['shm']} xtest={st['xtest']} on {st['display']}")

    # ---- single-action latency, asserted -----------------------------------
    lat = []
    for _ in range(10):
        t0 = time.time()
        ws.send({"type": "computer.click", "x": 100, "y": 100})
        r = wait_for(ws, "ok", timeout=5)
        lat.append((time.time() - t0) * 1000)
        assert r["method"] == "native", f"click not native: {r}"
    if statistics.mean(lat) > BUDGET_CLICK_MS:
        fail(f"click avg {statistics.mean(lat):.1f}ms > {BUDGET_CLICK_MS}ms budget")
    ok(f"click x10: avg {statistics.mean(lat):.1f}ms min {min(lat):.1f}ms — native XTest (budget {BUDGET_CLICK_MS}ms)")

    t0 = time.time()
    ws.send({"type": "computer.key", "combo": "ctrl+a"})
    r = wait_for(ws, "ok", timeout=5)
    dt = (time.time() - t0) * 1000
    assert r["method"] == "native"
    if dt > BUDGET_KEY_MS:
        fail(f"key {dt:.1f}ms > {BUDGET_KEY_MS}ms")
    ok(f"key combo ctrl+a: {dt:.1f}ms native (budget {BUDGET_KEY_MS}ms)")

    t0 = time.time()
    ws.send({"type": "computer.type", "text": "NATIVE-V4-TYPING-1234567890", "delayMs": 2})
    r = wait_for(ws, "ok", timeout=10)
    dt = (time.time() - t0) * 1000
    assert r["method"] == "native"
    if dt > BUDGET_TYPE_MS:
        fail(f"type {dt:.1f}ms > {BUDGET_TYPE_MS}ms")
    ok(f"type 29 chars: {dt:.1f}ms native (budget {BUDGET_TYPE_MS}ms)")

    # cursor truth: query must match where we moved
    ws.send({"type": "computer.actions", "steps": [{"action": "click", "x": 555, "y": 444}], "stopOnError": True})
    wait_for(ws, "computer.actions", timeout=10)
    ws.send({"type": "computer.cursor"})
    cur = wait_for(ws, "computer.cursor", timeout=5)
    if abs(cur["x"] - 555) > 2 or abs(cur["y"] - 444) > 2:
        fail(f"cursor mismatch: {cur}")
    ok(f"cursor verified at ({cur['x']},{cur['y']}) after click — X server agrees")

    # ---- capture pipeline, asserted ------------------------------------------
    t0 = time.time()
    ws.send({"type": "computer.screenshot", "format": "png"})
    png = wait_for(ws, "computer.screenshot", timeout=15)
    dt = (time.time() - t0) * 1000
    assert png["method"] == "native", f"capture not native: {png['method']}"
    if png["tookMs"] > BUDGET_SHOT_PNG_MS:
        fail(f"png shot {png['tookMs']}ms > {BUDGET_SHOT_PNG_MS}ms")
    png_bytes = png["bytes"]
    ok(f"screenshot PNG full 1080p: {png_bytes}B in {png['tookMs']}ms native XShm (budget {BUDGET_SHOT_PNG_MS}ms)")

    ws.send({"type": "computer.screenshot", "format": "jpg", "quality": 70, "scale": 0.5})
    thumb = wait_for(ws, "computer.screenshot", timeout=15)
    assert thumb["method"] == "native" and thumb["width"] == 960, thumb
    ok(f"vision payload JPG q70 scale 0.5: {thumb['bytes']}B ({thumb['bytes']*100//max(1,png_bytes)}% of PNG), {thumb['width']}x{thumb['height']}, {thumb['tookMs']}ms")

    # ---- interactive scenario: real app, real typing, one-shot observe -------
    pad = RIG_HOME / f"v4pad-{secrets.token_hex(3)}.txt"
    pad.write_text("V4 PAD\n\n")
    ws.send({"type": "computer.launch", "app": "mousepad", "args": [str(pad)]})
    launched = wait_for(ws, "computer.launched", timeout=10)
    ws.send({"type": "computer.waitWindow", "title": "Mousepad", "timeoutMs": 8000})
    ww = wait_for(ws, "computer.waitWindow", timeout=12)
    assert ww["found"], "mousepad window never appeared"
    ok(f"launched mousepad (pid {launched['pid']}), window found in {ww['waitedMs']}ms: '{ww['title'][:40]}'")

    # observe = vision payload + cursor + windows + active in ONE round trip
    t0 = time.time()
    ws.send({"type": "computer.observe", "format": "jpg", "quality": 70, "scale": 0.5})
    obs = wait_for(ws, "computer.observe", timeout=15)
    dt = (time.time() - t0) * 1000
    assert obs["method"] == "native"
    assert "cursor" in obs and any(w.get("active") for w in obs["windows"]), f"observe incomplete: {list(obs)}"
    if dt > BUDGET_OBSERVE_MS:
        fail(f"observe {dt:.1f}ms > {BUDGET_OBSERVE_MS}ms")
    active_title = next(w["title"][:30] for w in obs["windows"] if w.get("active"))
    ok(f"observe ONE round trip: shot+cursor+windows+active in {dt:.0f}ms, active='{active_title}' (budget {BUDGET_OBSERVE_MS}ms)")

    # batch: the full user flow in a single round trip
    win = next(w for w in obs["windows"] if w.get("active"))
    cx, cy = win["x"] + win["w"] // 2, win["y"] + win["h"] // 2
    steps = [
        {"action": "click", "x": cx, "y": cy},
        {"action": "key", "combo": "ctrl+a"},
        {"action": "type", "text": "BRUTAL BATCH PIPELINE", "delayMs": 2},
        {"action": "key", "combo": "Return"},
        {"action": "type", "text": "second line typed natively", "delayMs": 2},
        {"action": "key", "combo": "ctrl+a"},
        {"action": "wait", "ms": 50},
        {"action": "key", "combo": "Home"},
    ]
    t0 = time.time()
    ws.send({"type": "computer.actions", "steps": steps, "stopOnError": True})
    batch = wait_for(ws, "computer.actions", timeout=20)
    dt = (time.time() - t0) * 1000
    assert not batch["aborted"] and all(s["ok"] for s in batch["results"]), f"batch step failed: {batch['results']}"
    native_all = all(s["method"] in ("native", "sleep") for s in batch["results"])
    assert native_all, f"non-native step: {batch['results']}"
    if batch["totalMs"] > BUDGET_BATCH_MS:
        fail(f"batch {batch['totalMs']}ms > {BUDGET_BATCH_MS}ms")
    ok(f"8-step batch ONE round trip: {batch['totalMs']}ms total (budget {BUDGET_BATCH_MS}ms), all native")

    # visual proof of the batch typing
    ws.send({"type": "computer.screenshot", "format": "png", "region": {"x": win["x"], "y": win["y"], "w": min(1600, win["w"]), "h": min(400, win["h"])}})
    proof = wait_for(ws, "computer.screenshot", timeout=15)
    Path("/tmp/rig-v4-proof.png").write_bytes(base64.b64decode(proof["imageBase64"]))
    ok(f"region capture of the typed text: {proof['width']}x{proof['height']} {proof['bytes']}B → /tmp/rig-v4-proof.png")

    # ---- window management ----------------------------------------------------
    ws.send({"type": "computer.windows"})
    wins = wait_for(ws, "computer.windows", timeout=10)["windows"]
    assert any("Mousepad" in w["title"] for w in wins) and all("x" in w for w in wins), f"window geometry missing: {wins}"
    ok(f"windows with geometry+active flags: {[(w['title'][:24], w['active']) for w in wins]}")

    # the batch typed into Mousepad — save first (file arg → no dialog) so the
    # close isn't held by a Save Changes modal
    ws.send({"type": "computer.key", "combo": "ctrl+s"})
    wait_for(ws, "ok", timeout=10)
    time.sleep(0.5)
    ws.send({"type": "computer.window.activate", "title": "Mousepad"})
    wait_for(ws, "ok", timeout=10)
    ws.send({"type": "computer.window.close", "title": "Mousepad"})
    wait_for(ws, "ok", timeout=10)
    time.sleep(1)
    ws.send({"type": "computer.waitWindow", "title": "Mousepad", "timeoutMs": 2000})
    gone = wait_for(ws, "computer.waitWindow", timeout=6)
    assert not gone["found"], "window did not close"
    ok("window activate → close → verified gone (EWMH)")

    # regression guard: v0.3 surface still works through the native path
    ws.send({"type": "computer.scroll", "times": 2})
    wait_for(ws, "ok", timeout=10)
    ws.send({"type": "rig.exec", "command": "echo v4-regression", "timeoutMs": 5000})
    done = None
    while done is None:
        m = ws.recv(timeout=10)
        if m.get("type") == "exec.done":
            done = m
    assert done["code"] == 0
    ok("regression: scroll + rig.exec still green")

    print("\nV4 BRUTAL E2E: ALL GREEN — every latency budget held")


if __name__ == "__main__":
    main()
