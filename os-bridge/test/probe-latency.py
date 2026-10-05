#!/usr/bin/env python3
"""Pipeline latency probe (stdlib only).

Measures the REAL per-turn breakdown through omprd:
  pair -> session.new -> session.started   (omp cold start)
  rpc get_state -> response              (bridge round-trip)
  prompt -> first frame                  (client->daemon->omp->model TTFT)
  prompt -> tool_call/tool_result        (tool loop)
  prompt -> prompt_result                (full turn)
  session.usage                          (token ledger)
  rig.stats                              (daemon reservoir percentiles)

Usage: probe-latency.py [ip] [port] [--model local/stub-model] [--omp <path>]
Prints a latency table at the end.
"""
import json
import secrets
import sys
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
    m = wait_for(ws, "paired")
    return m["token"]


def ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 1)


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
    model = "local/stub-model"
    omp_bin = None
    if "--model" in sys.argv:
        model = sys.argv[sys.argv.index("--model") + 1]
    if "--omp" in sys.argv:
        omp_bin = sys.argv[sys.argv.index("--omp") + 1]

    token = pair(ip, port)
    ws = Ws(ip, port, token=token)

    rows = []
    sid = f"probe{secrets.token_hex(3)}"
    t0 = time.perf_counter()
    req = {"type": "session.new", "sessionId": sid, "cwd": "/tmp", "model": model}
    if omp_bin:
        req["ompBin"] = omp_bin
    ws.send(req)
    wait_for(ws, "session.started")
    spawn_ms = ms(t0)
    rows.append(("session.new→started (omp cold start)", spawn_ms))
    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "set_auto_retry", "enabled": False}})

    # bridge round-trip: rpc get_state -> response frame (x3)
    for i in range(3):
        t0 = time.perf_counter()
        ws.send({"type": "session.request", "sessionId": sid, "frame": {"type": "get_state"}})
        wait_for(ws, "session.response", timeout=20)
        rows.append((f"session.request get_state #{i+1}", ms(t0)))

    # real turn: prompt -> phases
    for label, msg in [("turn1 (tool call)", "run the tool"), ("turn2 (text)", "answer")]:
        phases = {}
        t0 = time.perf_counter()
        ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "prompt", "id": f"p-{label}", "message": msg}})
        deadline = time.time() + 60
        nframes = 0
        while time.time() < deadline:
            m = ws.recv(timeout=max(0.5, deadline - time.time()))
            if m is None:
                break
            nframes += 1
            f = m.get("frame", {})
            ft = f.get("type")
            if ft and ft not in phases:
                phases[ft] = ms(t0)
            if ft == "prompt_result":
                break
        rows.append((f"{label}: →first frame", phases.get(next(iter(phases), "?"), -1)))
        for ph, t in phases.items():
            rows.append((f"{label}: {ph}", t))
        rows.append((f"{label}: frames", nframes))

    # token ledger
    t0 = time.perf_counter()
    ws.send({"type": "session.request", "sessionId": sid, "frame": {"type": "get_state"}})
    m = wait_for(ws, "session.response", timeout=20)
    cu = m.get("frame", {}).get("data", {}).get("contextUsage", {})
    rows.append((f"contextUsage tokens={cu.get('tokens')} window={cu.get('contextWindow')}", ms(t0)))

    ws.send({"type": "rig.stats"})
    m = wait_for(ws, "rig.stats")
    rows.append((f"rig.stats bridgeUs={m.get('latencyBridgeUs')} queueMs={m.get('latencyQueueMs')} in={m.get('framesIn')} out={m.get('framesOut')}", 0))

    ws.send({"type": "rig.usage"})
    try:
        m = wait_for(ws, "rig.usage", timeout=10)
        rows.append((f"rig.usage sessions={json.dumps(m.get('sessions'))}", 0))
    except Exception as e:
        rows.append((f"rig.usage err {e}", 0))

    ws.send({"type": "session.kill", "sessionId": sid})

    print("\n=== LATENCY (ms) ===")
    for label, v in rows:
        print(f"{v:>10}  {label}")


if __name__ == "__main__":
    main()
