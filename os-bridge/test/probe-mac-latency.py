#!/usr/bin/env python3
"""macOS latency probe — p50/p95/p99 over N samples for the computer.* ops.

Usage: python3.12 test/probe-mac-latency.py [host] [n] [tag]

Measures client-side round-trip (send → matching reply) per op:
  computer.observe, computer.screenshot (jpg AND png), computer.click,
  computer.type, computer.watch first-frame.

Prints a table and saves raw samples to /tmp/lat-<tag>.json so before/after
runs can be compared in the final report.
"""
import base64, json, secrets, socket, statistics, struct, sys, time
from pathlib import Path

RIG_HOME = Path.home() / ".rig"
HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 20
TAG = sys.argv[3] if len(sys.argv) > 3 else "run"


class Ws:
    def __init__(self, ip: str, port: int):
        self.sock = socket.create_connection((ip, port), timeout=10)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        headers = (f"GET /ws HTTP/1.1\r\nHost: {ip}\r\nUpgrade: websocket\r\n"
                   f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                   f"Sec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(headers.encode())
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
            opcode = h[0] & 0x0F
            ln = h[1] & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", exact(8))[0]
            if opcode == 8:
                return None
            if opcode in (9, 10):
                exact(ln)
                continue
            payload = exact(ln)
            return json.loads(payload.decode())


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


def pct(samples, p):
    s = sorted(samples)
    if not s:
        return 0.0
    return s[min(len(s) - 1, int(p * len(s)))]


def report(name: str, samples: list, tooks: list):
    took = f"{pct(tooks, .50):7.1f}" if tooks else "      -"
    print(f"{name:26s} n={len(samples):3d} min={min(samples):7.1f} "
          f"p50={pct(samples, .50):7.1f} p95={pct(samples, .95):7.1f} "
          f"p99={pct(samples, .99):7.1f} max={max(samples):7.1f} "
          f"tookMsP50={took}")
    return {"n": len(samples), "min": min(samples), "p50": pct(samples, .50),
            "p95": pct(samples, .95), "p99": pct(samples, .99), "max": max(samples),
            "mean": statistics.fmean(samples), "tookP50": pct(tooks, .50) if tooks else None,
            "samples": samples}


ws = Ws(HOST, 8790)
code = secrets.token_hex(4)
(RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
ws.send({"type": "pair", "code": code, "device": f"lat-{TAG}"})
wait_for(ws, "paired")

ws.send({"type": "computer.state"})
st = wait_for(ws, "computer.state", timeout=15)
print(f"backend={st.get('backend')} perms={st.get('perms')} res={st.get('resolution')}")
if not (st.get("perms", {}).get("inject") and st.get("perms", {}).get("capture")):
    print("FATAL: missing inject/capture permissions"); sys.exit(2)

# give `type` a benign focused target and `click` a known inert point
ws.send({"type": "computer.launch", "app": "open -a TextEdit"})
try:
    wait_for(ws, "computer.launched", timeout=10)
except Exception as e:
    print("launch:", e)
time.sleep(2.0)

# warm up the capture path (first call pays dlopen/graph setup)
timed(ws, {"type": "computer.screenshot", "format": "jpg", "quality": 70}, "computer.screenshot")

results = {}
# bare wallpaper is the inert click target (no icons there on this box)
click_pt = (150, 700)

def run(name, msg, want, count=N, took_key="tookMs"):
    rtt, tooks = [], []
    for _ in range(count):
        d, m = timed(ws, msg, want)
        rtt.append(d)
        if took_key in m:
            tooks.append(float(m[took_key]))
    results[name] = report(name, rtt, tooks)

run("observe", {"type": "computer.observe"}, "computer.observe")
run("screenshot.jpg", {"type": "computer.screenshot", "format": "jpg", "quality": 70}, "computer.screenshot")
run("screenshot.png", {"type": "computer.screenshot", "format": "png"}, "computer.screenshot")
run("click", {"type": "computer.click", "x": click_pt[0], "y": click_pt[1]}, "ok")
run("type(20ch,delay0)", {"type": "computer.type", "text": "probe-latency-0123", "delayMs": 0}, "ok")

# watch first-frame latency: watch → first computer.frame
rtt, tooks = [], []
for _ in range(N):
    t0 = time.perf_counter()
    ws.send({"type": "computer.watch", "intervalMs": 250})
    wait_for(ws, "computer.watching")
    m = wait_for(ws, "computer.frame")
    rtt.append((time.perf_counter() - t0) * 1000.0)
    if "tookMs" in m:
        tooks.append(float(m["tookMs"]))
    ws.send({"type": "computer.unwatch", "watchId": m.get("watchId", "")})
    wait_for(ws, "ok")
results["watch.first-frame"] = report("watch.first-frame", rtt, tooks)

Path(f"/tmp/lat-{TAG}.json").write_text(json.dumps(results, indent=1))
print(f"\nsaved /tmp/lat-{TAG}.json")
