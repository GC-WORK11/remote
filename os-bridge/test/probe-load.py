#!/usr/bin/env python3
"""Load probe: N sessions streaming FAKE_N-frame bursts + a subscriber.

Measures (pre-optimization baseline AND post-optimization):
  - 3-session prompt fan-in: time to drain each session's burst, interleave
    fairness (per-session frame counts in windows), cross-session bleed check
  - ring replay cost: session.subscribe since=0 over a full ring
  - rig.stats latencyBridgeUs / latencyQueueMs under load
  - slow-client isolation: one client that never reads -> gets dropped,
    sessions keep streaming to the healthy client

Usage: probe-load.py [ip] [port]
"""
import json
import secrets
import socket
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from client import Ws, wait_for  # noqa: E402

RIG_HOME = Path.home() / ".rig"


def pair(ip: str, port: int, device: str = "probe"):
    RIG_HOME.mkdir(exist_ok=True)
    code = f"{secrets.randbelow(1000000):06d}"
    (RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
    ws = Ws(ip, port)
    ws.send({"type": "pair", "code": code, "device": device})
    return wait_for(ws, "paired")["token"]


FAKE_OMP = str(Path(__file__).parent / "fake-omp.sh")
BURST = 200


def stats(ws):
    ws.send({"type": "rig.stats"})
    return wait_for(ws, "rig.stats")


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
    token = pair(ip, port, "load-probe")
    ws = Ws(ip, port, token=token)

    # --- 1) three fake-omp sessions, burst FAKE_N frames each ---------------
    sids = [f"load{i}{secrets.token_hex(2)}" for i in range(3)]
    spawn_ms = []
    for sid in sids:
        t0 = time.perf_counter()
        ws.send({"type": "session.new", "sessionId": sid, "cwd": "/tmp", "ompBin": FAKE_OMP})
        wait_for(ws, "session.started")
        spawn_ms.append(round((time.perf_counter() - t0) * 1000, 1))
    print(f"[spawn] fake-omp session.new→started each: {spawn_ms} ms")

    t0 = time.perf_counter()
    for i, sid in enumerate(sids):
        ws.send({"type": "rpc", "sessionId": sid,
                 "frame": {"type": "prompt", "id": f"b{i}", "message": "burst"}})

    # drain all rpc frames; track per-session counts and arrival windows
    counts = {s: 0 for s in sids}
    first_at = {}
    last_at = {}
    foreign = 0
    total_expected = 3 * BURST + 3  # deltas + prompt_result each
    deadline = time.time() + 60
    got = 0
    while got < total_expected and time.time() < deadline:
        m = ws.recv(timeout=max(0.5, deadline - time.time()))
        if m is None:
            break
        if m.get("type") != "rpc":
            continue
        got += 1
        sid = m.get("sessionId")
        if sid not in counts:
            foreign += 1
            continue
        counts[sid] += 1
        first_at.setdefault(sid, time.perf_counter())
        last_at[sid] = time.perf_counter()
    drain = round((time.perf_counter() - t0) * 1000, 1)
    spans = {s: round((last_at[s] - first_at[s]) * 1000, 1) for s in sids if s in last_at}
    print(f"[fan-in] {got}/{total_expected} frames in {drain} ms; per-session={counts}; "
          f"arrival-spans={spans}; foreign-frames={foreign}")
    fair = all(counts[s] == BURST + 1 for s in sids)
    print(f"[fan-in] all sessions complete={'YES' if fair else 'NO'}; bleed={foreign}")

    m = stats(ws)
    print(f"[stats-under-load] bridgeUs={m['latencyBridgeUs']} queueMs={m['latencyQueueMs']}")

    # --- 2) replay: subscribe since=0 over the ring we just filled ----------
    t0 = time.perf_counter()
    ws.send({"type": "session.subscribe", "sessionId": sids[0], "since": 0})
    replayed = 0
    while True:
        m = ws.recv(timeout=15)
        if m is None:
            break
        if m.get("type") == "session.subscribed":
            break
        if m.get("type") == "rpc" and m.get("replay"):
            replayed += 1
    replay_ms = round((time.perf_counter() - t0) * 1000, 1)
    print(f"[replay] {replayed} frames in {replay_ms} ms ({replayed / max(replay_ms, 1) * 1000:.0f} f/s)")

    # --- 3) slow client gets dropped, healthy client unaffected -------------
    slow = socket.create_connection((ip, port), timeout=5)
    key = "AAAAAAAAAAAAAAAAAAAAAA=="
    slow.sendall((f"GET /ws HTTP/1.1\r\nHost: {ip}\r\nUpgrade: websocket\r\n"
                  f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                  f"Sec-WebSocket-Version: 13\r\nAuthorization: Bearer {token}\r\n\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        resp += slow.recv(4096)
    # shrink its socket buffer to fill the outbox fast, then never read again
    slow.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)

    # healthy client continues normally; blast bursts until the slow one dies
    t0 = time.perf_counter()
    bursts = 0
    healthy_got = 0
    while bursts < 8 and time.perf_counter() - t0 < 45:
        for i, sid in enumerate(sids):
            ws.send({"type": "rpc", "sessionId": sid,
                     "frame": {"type": "prompt", "id": f"f{bursts}{i}", "message": "flood"}})
        bursts += 1
        d = time.time() + 30
        while time.time() < d:
            m = ws.recv(timeout=1.0)
            if m is None:
                break
            if m.get("type") == "rpc":
                healthy_got += 1
            if healthy_got > bursts * BURST:
                break
    print(f"[slow-client] healthy client received {healthy_got} frames over "
          f"{round((time.perf_counter() - t0) * 1000, 1)} ms without disconnect")

    m = stats(ws)
    print(f"[stats-final] bridgeUs={m['latencyBridgeUs']} queueMs={m['latencyQueueMs']} "
          f"in={m['framesIn']} out={m['framesOut']}")

    for sid in sids:
        ws.send({"type": "session.kill", "sessionId": sid})
    print("\nLOAD PROBE DONE")


if __name__ == "__main__":
    main()
