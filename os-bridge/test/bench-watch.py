#!/usr/bin/env python3
"""Watch-pipeline benchmark: fps + daemon CPU under motion and idle.

Phases:
  1. boot :99 via computer.state, spawn a spinning color window
  2. watch for ~seconds, count frames, sample daemon /proc/<pid>/stat CPU
  3. idle phase: stop the motion, watch keeps probing — CPU per idle tick
  4. screenshot latency: N computer.screenshot calls, p50/p95 tookMs

Usage: bench-watch.py [ip] [port] [seconds]
"""
import json
import secrets
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from client import Ws, wait_for  # noqa: E402

RIG_HOME = Path.home() / ".rig"


def pair(ip: str, port: int, device: str = "bench"):
    RIG_HOME.mkdir(exist_ok=True)
    code = f"{secrets.randbelow(1000000):06d}"
    (RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
    ws = Ws(ip, port)
    ws.send({"type": "pair", "code": code, "device": device})
    return wait_for(ws, "paired")["token"]


def daemon_pid():
    out = subprocess.run(["pgrep", "-x", "omprd"], capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else None


def proc_cpu_ticks(pid: int):
    # utime+stime in jiffies
    with open(f"/proc/{pid}/stat") as f:
        parts = f.read().rsplit(")", 1)[1].split()
    return int(parts[11]) + int(parts[12])


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
    secs = float(sys.argv[3]) if len(sys.argv) > 3 else 8
    interval = int(sys.argv[4]) if len(sys.argv) > 4 else 100

    pid = daemon_pid()
    hz = 100  # USER_HZ on Linux

    token = pair(ip, port, "bench-watch")
    ws = Ws(ip, port, token=token)

    ws.send({"type": "computer.state", "display": ":99"})
    st = wait_for(ws, "computer.state", timeout=20)
    disp = st.get("display", ":99")
    print(f"[state] display={disp} {st.get('resolution')} native={st.get('native')}")

    # --- motion phase: a window that repaints every tick ---------------------
    churn = "/tmp/rigbench/churn"
    if not Path(churn).exists():
        print("[skip] /tmp/rigbench/churn missing — build: gcc -O2 -o churn churn.c -lX11")
    spin = subprocess.Popen([churn, disp],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)

    ws.send({"type": "computer.watch", "intervalMs": interval, "scale": 0.5,
             "quality": 70, "threshold": 2.0})
    wait_for(ws, "computer.watching", timeout=10)

    cpu0 = proc_cpu_ticks(pid)
    t0 = time.perf_counter()
    frames = 0
    cap_ms, enc_ms, took_ms, bytes_seen, deltas = [], [], [], [], []
    while time.perf_counter() - t0 < secs:
        m = ws.recv(timeout=5)
        if m is None:
            break
        if m.get("type") == "computer.frame":
            frames += 1
            if "captureMs" in m: cap_ms.append(m["captureMs"])
            if "encodeMs" in m: enc_ms.append(m["encodeMs"])
            took_ms.append(m.get("tookMs", 0))
            bytes_seen.append(m.get("bytes", 0))
            deltas.append(m.get("delta", 0))
    wall = time.perf_counter() - t0
    cpu1 = proc_cpu_ticks(pid)
    cpu_motion_pct = (cpu1 - cpu0) / hz / wall * 100
    print(f"[watch-motion] {frames} frames in {wall:.1f}s = {frames / wall:.2f} fps | "
          f"daemon CPU {cpu_motion_pct:.1f}% ({(cpu1 - cpu0) / hz:.2f}s) | "
          f"bytes p50={statistics.median(bytes_seen):.0f}")
    if cap_ms:
        print(f"    captureMs p50={statistics.median(cap_ms):.2f} p95={sorted(cap_ms)[int(len(cap_ms) * .95)]:.2f} | "
              f"encodeMs p50={statistics.median(enc_ms):.2f} p95={sorted(enc_ms)[int(len(enc_ms) * .95)]:.2f} | "
              f"tookMs p50={statistics.median(took_ms):.2f}")

    # --- idle phase: kill the churn, watch keeps probing --------------------
    spin.terminate()
    time.sleep(1.5)  # let cadence relax + a few frames flush
    # drain queued frames
    ws.sock.setblocking(False)
    try:
        while ws.sock.recv(1 << 20):
            pass
    except Exception:
        pass
    ws.sock.setblocking(True)

    cpu0 = proc_cpu_ticks(pid)
    t0 = time.perf_counter()
    idle_frames = 0
    while time.perf_counter() - t0 < secs:
        try:
            m = ws.recv(timeout=1.0)
        except Exception:
            break
        if m and m.get("type") == "computer.frame":
            idle_frames += 1
    wall = time.perf_counter() - t0
    cpu1 = proc_cpu_ticks(pid)
    cpu_idle_pct = (cpu1 - cpu0) / hz / wall * 100
    print(f"[watch-idle] {idle_frames} frames in {wall:.1f}s | daemon CPU {cpu_idle_pct:.2f}% "
          f"({(cpu1 - cpu0) / hz:.2f}s) — probe-only ticks")

    # --- screenshot latency ---------------------------------------------------
    shot_ms, shot_bytes = [], []
    for _ in range(20):
        ws.send({"type": "computer.screenshot", "scale": 0.5, "quality": 70})
        m = wait_for(ws, "computer.screenshot", timeout=15)
        shot_ms.append(m["tookMs"])
        shot_bytes.append(m["bytes"])
    shot_ms.sort()
    print(f"[screenshot] n=20 tookMs p50={shot_ms[10]:.1f} p95={shot_ms[18]:.1f} "
          f"bytes p50={statistics.median(shot_bytes):.0f}")

    ws.send({"type": "computer.unwatch"})
    print("BENCH DONE")


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    main()
