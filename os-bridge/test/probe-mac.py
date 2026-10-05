#!/usr/bin/env python3
"""macOS backend probe — pair, state, perms, shot, cursor, launch, type, observe."""
import base64, json, secrets, socket, struct, sys, time
from pathlib import Path

RIG_HOME = Path.home() / ".rig"


class Ws:
    def __init__(self, ip: str, port: int):
        self.sock = socket.create_connection((ip, port), timeout=10)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        headers = f"GET /ws HTTP/1.1\r\nHost: {ip}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
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

    def recv(self, timeout: float = 5.0):
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


def wait_for(ws, want_type: str, timeout: float = 15.0) -> dict:
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

def ok(m): print(f"  [ok] {m}")
def fail(m): print(f"  [FAIL] {m}"); sys.exit(1)

host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
ws = Ws(host, 8790)
code = secrets.token_hex(4)
(RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
ws.send({"type": "pair", "code": code, "device": "mac-probe"})
m = wait_for(ws, "paired")
tok = m["token"]

ws.send({"type": "computer.state"})
st = wait_for(ws, "computer.state", timeout=15)
print(json.dumps(st, indent=1))

ws.send({"type": "computer.perms", "request": True})
pm = wait_for(ws, "computer.perms", timeout=15)
print(json.dumps(pm, indent=1))

ws.send({"type": "computer.cursor"})
cur = wait_for(ws, "computer.cursor", timeout=10)
print(json.dumps(cur))

ws.send({"type": "computer.screenshot", "format": "jpg", "quality": 70})
try:
    shot = wait_for(ws, "computer.screenshot", timeout=20)
except Exception as e:
    print("shot failed:", e)
    shot = None
if shot:
    p = Path(f"/tmp/mac-shot.{shot.get('format','jpg')}")
    p.write_bytes(base64.b64decode(shot["imageBase64"]))
    ok(f"shot {shot['width']}x{shot['height']} {shot['bytes']}B enc={shot.get('encoder')} {shot['tookMs']}ms → {p}")

ws.send({"type": "computer.launch", "app": "open -a TextEdit"})
try:
    l = wait_for(ws, "computer.launched", timeout=15)
    ok(f"launched pid={l.get('pid')}")
except Exception as e:
    print("launch:", e)
time.sleep(2.5)

ws.send({"type": "computer.type", "text": "POCKET-RIG MAC BACKEND", "delayMs": 12})
try:
    m = wait_for(ws, "ok", timeout=15)
    ok(f"type method={m.get('method')} {m.get('tookMs')}ms")
except Exception as e:
    print("type:", e)

ws.send({"type": "computer.windows"})
try:
    w = wait_for(ws, "computer.windows", timeout=15)
    for x in w["windows"][:10]:
        print(f"    win {x['id']} [{x.get('w',0)}x{x.get('h',0)}] active={x.get('active')} {x['title'][:60]}")
except Exception as e:
    print("windows:", e)

ws.send({"type": "computer.screenshot", "format": "jpg", "quality": 70})
try:
    shot2 = wait_for(ws, "computer.screenshot", timeout=20)
    p = Path("/tmp/mac-shot2.jpg")
    p.write_bytes(base64.b64decode(shot2["imageBase64"]))
    ok(f"shot2 {shot2['bytes']}B → {p}")
except Exception as e:
    print("shot2:", e)

print("probe done")
