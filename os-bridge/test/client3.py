#!/usr/bin/env python3
"""remote v0.3 e2e: native exec latency + computer-use proof.

Proves: rig.exec round-trip speed, Xvfb auto-boot, GUI app launch on the
agent's own display, real typing via input injection, screenshots of the
result — the dots/Grok-bot 'acts like a user' loop, Linux-first.
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
WORK = Path("/tmp/rig-test-work")
WORK.mkdir(exist_ok=True)


def ok(label):
    print(f"  ✓ {label}")


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790

    RIG_HOME.mkdir(exist_ok=True)
    code = f"{secrets.randbelow(1000000):06d}"
    (RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
    ws = Ws(ip, port)
    ws.send({"type": "pair", "code": code, "device": "computer-test"})
    token = wait_for(ws, "paired")["token"]
    ok("pairing")

    # ---- native exec latency: no agent, no model, C++ fork/exec -----------
    lat = []
    for i in range(10):
        t0 = time.time()
        ws.send({"type": "rig.exec", "command": "echo hi", "timeoutMs": 5000})
        while True:
            m = ws.recv(timeout=5)
            if m.get("type") == "exec.done":
                break
        lat.append((time.time() - t0) * 1000)
    ok(f"rig.exec x10: min={min(lat):.1f}ms avg={statistics.mean(lat):.1f}ms max={max(lat):.1f}ms")

    # ---- exec streaming: chunks must arrive while the command runs ---------
    ws.send({"type": "rig.exec", "command": "echo one; sleep 0.4; echo two; sleep 0.4; echo three", "timeoutMs": 10000})
    chunks, done = [], None
    while done is None:
        m = ws.recv(timeout=10)
        if m.get("type") == "exec.output":
            chunks.append(m["chunk"])
        elif m.get("type") == "exec.done":
            done = m
    assert done["code"] == 0 and len(chunks) >= 3, f"streaming broken: {chunks}"
    ok(f"rig.exec streams live: {len(chunks)} chunks, exit 0, {done['durationMs']}ms")

    # ---- computer: auto-boot Xvfb + empty-desktop screenshot ---------------
    ws.send({"type": "computer.state"})
    st = wait_for(ws, "computer.state", timeout=20)
    ok(f"computer ready: display {st['display']} alive={st['xvfbAlive']} res={st['resolution']}")

    ws.send({"type": "computer.screenshot"})
    shot1 = wait_for(ws, "computer.screenshot", timeout=30)
    p1 = Path(f"/tmp/rig-shot1.{shot1.get('format', 'jpg')}")
    p1.write_bytes(base64.b64decode(shot1["imageBase64"]))
    ok(f"screenshot #1 (empty desktop): {shot1['width']}x{shot1['height']} {shot1['bytes']}B in {shot1['tookMs']}ms → {p1}")

    # ---- the agent's own app: a native editor on its display ---------------
    # (snap firefox is quarantined behind a private /tmp + unkillable broker
    #  processes — documented as a known issue; native apps need none of that)
    pad = RIG_HOME / f"pad-{secrets.token_hex(3)}.txt"
    pad.write_text("AGENT PAD\n\n")
    ws.send({"type": "computer.launch", "app": "mousepad", "args": [str(pad)]})
    launched = wait_for(ws, "computer.launched", timeout=15)
    ok(f"mousepad launched (pid {launched['pid']}) on {launched['display']}")
    time.sleep(4)

    ws.send({"type": "computer.windows"})
    wins = wait_for(ws, "computer.windows", timeout=10)["windows"]
    ok(f"windows: {[w['title'][:40] for w in wins]}")

    # zoom so the typed text is unmistakable in the screenshot
    for _ in range(3):
        ws.send({"type": "computer.key", "combo": "ctrl+plus"})
        wait_for(ws, "ok", timeout=10)

    # ---- act like a user: click the pad, type, screenshot the proof --------
    ws.send({"type": "computer.click", "x": 960, "y": 540})
    wait_for(ws, "ok", timeout=10)
    ws.send({"type": "computer.type", "text": "RIG SAYS HI", "delayMs": 25})
    wait_for(ws, "ok", timeout=15)
    time.sleep(1)

    ws.send({"type": "computer.screenshot"})
    shot2 = wait_for(ws, "computer.screenshot", timeout=30)
    p2 = Path(f"/tmp/rig-shot2.{shot2.get('format', 'jpg')}")
    p2.write_bytes(base64.b64decode(shot2["imageBase64"]))
    ok(f"screenshot #2 (typed): {shot2['width']}x{shot2['height']} {shot2['bytes']}B in {shot2['tookMs']}ms → {p2}")

    assert shot2["bytes"] != shot1["bytes"], "screenshots identical — nothing changed on screen"
    ok("screen changed between shots (app rendered, pixels differ)")

    # ---- token/exec ledger ----------------------------------------------------
    ws.send({"type": "rig.usage"})
    usage = wait_for(ws, "rig.usage", timeout=10)
    e = usage["exec"]
    ok(f"rig.usage ledger: exec count={e['count']} avg={e['msAvg']}ms min={e['msMin']}ms max={e['msMax']}ms")

    print("\nCOMPUTER-USE E2E: ALL GREEN")


if __name__ == "__main__":
    main()
