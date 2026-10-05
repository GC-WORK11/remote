#!/usr/bin/env python3
"""Heavy-burst probe: one session emits a 4096-frame burst (fills the ring),
then a full-ring since=0 replay. Run A/B against daemon builds.
Env: FAKE_N controls the fake-omp burst (default 4096).
Usage: probe-burst.py [ip] [port]
"""
import secrets, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from client import Ws, wait_for, RIG_HOME  # noqa: E402

N = int(sys.argv[3]) if len(sys.argv) > 3 else 4096
ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790

RIG_HOME.mkdir(exist_ok=True)
code = f"{secrets.randbelow(1000000):06d}"
(RIG_HOME / "pending.json").write_text(
    __import__("json").dumps({"code": code, "expires": int(time.time()) + 300}))
ws0 = Ws(ip, port)
ws0.send({"type": "pair", "code": code, "device": "burst"})
tok = wait_for(ws0, "paired")["token"]
ws = Ws(ip, port, token=tok)

sid = "burst1"
FAKE_OMP = str(Path(__file__).parent / "fake-omp.sh")
ws.send({"type": "session.new", "sessionId": sid, "cwd": "/tmp", "ompBin": FAKE_OMP})
wait_for(ws, "session.started", timeout=20)

t0 = time.perf_counter()
ws.send({"type": "rpc", "sessionId": sid,
         "frame": {"type": "prompt", "id": "b0", "message": "burst"}})
got = 0
deadline = time.time() + 120
while got < N + 1 and time.time() < deadline:
    m = ws.recv(timeout=10)
    if m is None: break
    if m.get("type") == "rpc" and m.get("sessionId") == sid:
        got += 1
drain = (time.perf_counter() - t0) * 1000
print(f"[burst] {got}/{N+1} frames drained in {drain:.0f} ms ({got/drain*1000:.0f} f/s)")

ws.send({"type": "rig.stats"})
m = wait_for(ws, "rig.stats")
print(f"[stats] bridgeUs={m['latencyBridgeUs']} queueMs={m['latencyQueueMs']}")

# full-ring replay — ring now holds min(N+1,4096) entries
t0 = time.perf_counter()
ws.send({"type": "session.subscribe", "sessionId": sid, "since": 0})
rep = 0
while True:
    m = ws.recv(timeout=30)
    if m is None: break
    if m.get("type") == "session.subscribed": break
    if m.get("type") == "rpc" and m.get("replay"): rep += 1
ms = (time.perf_counter() - t0) * 1000
print(f"[replay] {rep} frames in {ms:.0f} ms ({rep/ms*1000:.0f} f/s) replayedTo={m.get('replayedTo')}")

ws.send({"type": "session.kill", "sessionId": sid})
print("DONE")
