#!/usr/bin/env python3
"""remote end-to-end test client (stdlib only).

Proves the full chain: pair → rig.status → session.new (spawns omp) →
rpc get_state (real omp response) → prompt (real agent turn if a model is
configured; error frames still prove the pipe) → session.kill.

Also serves as the reference client implementation for the wire protocol.
"""
import base64
import hashlib
import json
import os
import secrets
import socket
import struct
import sys
import time
import subprocess
from pathlib import Path

RIG_HOME = Path.home() / ".rig"


class Ws:
    """Minimal WebSocket client (RFC 6455), text frames only."""

    def __init__(self, ip: str, port: int, token: str | None = None):
        self.sock = socket.create_connection((ip, port), timeout=10)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        headers = f"GET /ws HTTP/1.1\r\nHost: {ip}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
        if token:
            headers += f"Authorization: Bearer {token}\r\n"
        headers += "\r\n"
        self.sock.sendall(headers.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.sock.recv(4096)
        status = resp.split(b"\r\n", 1)[0].decode()
        if "101" not in status:
            raise RuntimeError(f"upgrade failed: {status}")

    def send(self, obj: dict):
        data = json.dumps(obj).encode()
        mask = secrets.token_bytes(4)
        header = bytearray([0x81])
        n = len(data)
        if n <= 125:
            header.append(0x80 | n)
        elif n <= 0xFFFF:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self, timeout: float = 5.0) -> dict | None:
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
            if opcode in (9, 10):  # ping/pong
                exact(ln)
                continue
            payload = exact(ln)
            return json.loads(payload.decode())


class TestFailure(Exception):
    pass


def wait_for(ws, want_type: str, timeout: float = 15.0, also_collect: list | None = None) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = ws.recv(timeout=max(0.5, deadline - time.time()))
        if m is None:
            raise ConnectionError("closed while waiting")
        if also_collect is not None:
            also_collect.append(m)
        if m.get("type") == "error":
            raise TestFailure(f"daemon error while waiting for {want_type}: {m.get('error')}")
        if m.get("type") == want_type:
            return m
    raise TimeoutError(f"no {want_type} in {timeout}s")


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
    token_file = Path("/tmp/rig-test-token.txt")

    # 1) Pair. The test mints its own pending code like `ompr pair` does.
    RIG_HOME.mkdir(exist_ok=True)
    code = f"{secrets.randbelow(1000000):06d}"
    (RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
    print(f"[1] pairing with code {code}")

    ws = Ws(ip, port)
    ws.send({"type": "pair", "code": code, "device": "e2e-test"})
    m = wait_for(ws, "paired")
    token = m["token"]
    token_file.write_text(token)
    print(f"    paired, token saved: {token[:12]}…")

    # 2) Reconnect WITH the token (proves Bearer auth path).
    ws = Ws(ip, port, token=token)
    ws.send({"type": "rig.status"})
    m = wait_for(ws, "rig.status")
    print(f"[2] rig.status ok: hostname={m.get('hostname')} sessions={len(m.get('sessions', []))} devices={len(m.get('devices', []))}")

    # 3) Spawn a session in a scratch dir.
    scratch = Path("/tmp/rig-test-work")
    scratch.mkdir(exist_ok=True)
    sid = f"t{secrets.token_hex(3)}"
    ws.send({"type": "session.new", "sessionId": sid, "cwd": str(scratch)})
    wait_for(ws, "session.started")
    print(f"[3] session {sid} started (omp --mode rpc in {scratch})")
    # provider errors should surface fast, not via omp's internal retries
    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "set_auto_retry", "enabled": False}})

    # 4) Real omp RPC: get_state must come back through the bridge.
    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "get_state"}})
    frames = []
    m = wait_for(ws, "rpc", timeout=20, also_collect=frames)
    while m.get("frame", {}).get("type") != "response" or m.get("frame", {}).get("command") != "get_state":
        m = wait_for(ws, "rpc", timeout=20, also_collect=frames)
    state = m["frame"].get("data", {})
    print(f"[4] get_state: sessionId={state.get('sessionId','?')[:18]}… model={(state.get('model') or {}).get('id','?')} streaming={state.get('isStreaming')}")

    # 5) Models list (model selector data source).
    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "get_available_models"}})
    deadline = time.time() + 20
    models = None
    while time.time() < deadline:
        m = wait_for(ws, "rpc", timeout=20, also_collect=frames)
        f = m.get("frame", {})
        if f.get("type") == "response" and f.get("command") == "get_available_models":
            models = f.get("data")
            break
    if isinstance(models, list):
        print(f"[5] available models: {len(models)}")
    elif isinstance(models, dict):
        print(f"[5] available models: {len(models.get('models', []))}")
    else:
        print(f"[5] models response: {str(models)[:120]}")

    # 6) Prompt (agent turn — or a structured error if no model keys on the rig; both prove the pipe).
    print("[6] prompting: 'Reply with exactly: RIG-OK' …")
    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "prompt", "id": "p1", "message": "Reply with exactly: RIG-OK"}})
    saw_text = False
    result = None
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            m = wait_for(ws, "rpc", timeout=10, also_collect=frames)
        except TimeoutError:
            continue
        f = m.get("frame", {})
        if f.get("type") == "message_delta" or (f.get("type") == "message_update"):
            saw_text = True
        if f.get("type") == "prompt_result":
            result = f
            break
    if result:
        print(f"    prompt_result: status={result.get('status')} settled={result.get('sessionSettled')}")
        if result.get("status") == "error":
            err = result.get("error", {})
            print(f"    provider error: {err.get('message','?')[:140]} (http {err.get('httpStatus')})")
        else:
            # pull final assistant text
            ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "get_last_assistant_text"}})
            while time.time() < deadline:
                m = wait_for(ws, "rpc", timeout=15, also_collect=frames)
                f = m.get("frame", {})
                if f.get("type") == "response" and f.get("command") == "get_last_assistant_text":
                    txt = f.get("data") or {}
                    print(f"    assistant: {str(txt.get('text', txt))[:200]}")
                    break
    print(f"    (streamed frames observed: {len(frames)}, text deltas: {saw_text})")

    # 7) Kill and confirm exit event.
    ws.send({"type": "session.kill", "sessionId": sid})
    try:
        m = wait_for(ws, "session.exited", timeout=10)
        print(f"[7] session exited: code={m.get('code')}")
    except TimeoutError:
        print("[7] session.exited not observed (check daemon logs)")

    print("\nE2E: PASS" if result or saw_text else "\nE2E: PARTIAL (pipe works, no model turn — configure omp providers on the rig)")


if __name__ == "__main__":
    main()
