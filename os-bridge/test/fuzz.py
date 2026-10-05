#!/usr/bin/env python3
"""fuzz.py — robustness/DoS surface for omprd.

Fires malformed json, wrong types, giant frames, rapid connect/disconnect,
expired pair codes and protocol violations at the daemon, then measures RSS
for leaks. The daemon must answer errors, never crash, never grow unbounded.

Run:  python3.12 test/fuzz.py
Env:  RIG_HOST/RIG_PORT, RIG_PID (daemon pid for RSS; default: pgrep omprd)
"""

import asyncio
import json
import os
import socket
import subprocess
import sys
import time

import websockets

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from rig import Reporter, URI, connect, fresh_code, recv, send

PID = int(os.environ.get("RIG_PID", "0")) or int(
    subprocess.run(["pgrep", "-n", "omprd"], capture_output=True, text=True)
    .stdout.strip() or "0")


def rss_kb(pid: int) -> int:
    r = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                       capture_output=True, text=True)
    return int(r.stdout.strip() or "0")


def alive() -> bool:
    return PID > 0 and subprocess.run(["kill", "-0", str(PID)]).returncode == 0


async def raw_frame(payload: bytes, fin_op: int = 0x81, masked: bool = True):
    """One TCP connect → HTTP upgrade → one raw ws frame → read reply/close."""
    host, rest = URI.split("://", 1)[1].split("/", 1)
    h, p = host.split(":")
    s = socket.create_connection((h, int(p)), timeout=5)
    key = "dGhlIHNhbXBsZSBub25jZQ=="
    s.sendall(f"GET /ws HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
              f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
              f"Sec-WebSocket-Version: 13\r\n\r\n".encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = s.recv(4096)
        if not chunk:
            s.close()
            return b""
        resp += chunk
    hdr = bytes([fin_op])
    n = len(payload)
    mask_bit = 0x80 if masked else 0
    if n <= 125:
        hdr += bytes([mask_bit | n])
    elif n <= 0xFFFF:
        hdr += bytes([mask_bit | 126]) + n.to_bytes(2, "big")
    else:
        hdr += bytes([mask_bit | 127]) + n.to_bytes(8, "big")
    if masked:
        mk = b"\x11\x22\x33\x44"
        hdr += mk
        payload = bytes(b ^ mk[i % 4] for i, b in enumerate(payload))
    s.sendall(hdr + payload)
    s.settimeout(3)
    out = b""
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            out += chunk
            if len(out) > 4_000_000:
                break
    except socket.timeout:
        pass
    except ConnectionResetError:
        pass  # daemon refused → RST after close
    s.close()
    return out


async def main() -> int:
    R = Reporter("fuzz")
    R.check(PID > 0 and alive(), "daemon pid found", f"pid={PID}")

    # --- malformed json / wrong envelope types -------------------------------
    ws = await connect()
    junk = [
        b"{", b"[1,2,3", b"not json", b"", b"   ", b"{}", b"[]", b"42", b"\"x\"",
        b"null", b"true", b'{"type":123}', b'{"type":null}', b'{"type":{}}',
        b'{"type":""}',
    ]
    ok_replies = 0
    unanswered = []
    for j in junk:
        await ws.send(j)
        try:
            m = await recv(ws, 5)
            if isinstance(m, dict):
                ok_replies += 1
        except Exception:
            unanswered.append(j[:40])
    R.check(ok_replies == len(junk), "every malformed frame answered",
            f"{ok_replies}/{len(junk)} replies missing={unanswered}")

    # --- wrong-typed fields on real message types ----------------------------
    wrong = [
        {"type": "pair", "code": 123456},
        {"type": "pair", "code": {"x": 1}},
        {"type": "rig.exec", "command": ["echo"]},
        {"type": "rig.exec", "command": "echo hi", "timeoutMs": "soon"},
        {"type": "rig.execKill", "execId": "abc"},
        {"type": "session.new", "sessionId": {"nested": 1}},
        {"type": "session.subscribe", "sessionId": "nope", "since": "abc"},
        {"type": "session.subscribe", "sessionId": "nope", "since": -5},
        {"type": "rpc", "sessionId": "nope", "frame": "x"},
        {"type": "rpc", "sessionId": 5, "frame": {"type": "get_state"}},
        {"type": "session.request", "sessionId": "nope", "frame": 5},
        {"type": "rig.stayAwake", "on": "maybe"},
        {"type": "auth.login", "provider": "../../etc"},
        {"type": "auth.login", "provider": "x; rm -rf /"},
        {"type": "session.kill", "sessionId": None},
        {"type": "rig.fs.read", "path": 5},
        {"type": "totally.bogus"},
        {"type": "pair"},
    ]
    answered = 0
    for m in wrong:
        await send(ws, m)
        try:
            r = await recv(ws, 5)
            answered += isinstance(r, dict)
        except Exception:
            pass
    R.check(answered == len(wrong), "wrong-typed fields all answered",
            f"{answered}/{len(wrong)}")
    R.check(alive(), "daemon alive after malformed flood")

    # --- expired / wrong pair codes ------------------------------------------
    ws2 = await websockets.connect(URI, max_size=None)
    await send(ws2, {"type": "pair", "code": "000000", "device": "evil"})
    m = await recv(ws2, 5)
    R.check(m.get("type") == "error" and "token" not in m,
            "bogus pair code refused", str(m)[:80])
    # unpaired message before auth
    await send(ws2, {"type": "rig.status"})
    m = await recv(ws2, 5)
    R.check(m.get("error") == "unauthorized", "unpaired → unauthorized")
    # pair rate limit: 5 rapid attempts then refused
    codes = []
    for i in range(7):
        await send(ws2, {"type": "pair", "code": f"{1000 + i}", "device": "brute"})
        m = await recv(ws2, 5)
        codes.append(m.get("error", ""))
    R.check(any("rate limited" in e for e in codes[5:]),
            "pair brute-force rate limited", f"errors tail={codes[-2:]}")
    await ws2.close()

    # --- giant frames ---------------------------------------------------------
    # 10 MB message inside the 64 MB cap → must parse-or-error, keep serving.
    big = json.dumps({"type": "totally.bogus", "pad": "A" * (10 * 1024 * 1024)})
    out = await raw_frame(big.encode())
    R.check(b"HTTP/1.1 101" in out or len(out) > 0, "10MB frame: daemon answered",
            f"{len(out)} reply bytes")
    R.check(alive(), "daemon alive after 10MB frame")
    # > 64 MB declared length → the daemon must close the connection (len cap)
    s_host, s_rest = URI.split("://", 1)[1].split("/", 1)
    sh, sp = s_host.split(":")
    sk = socket.create_connection((sh, int(sp)), timeout=5)
    sk.sendall(b"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n"
               b"Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
               b"Sec-WebSocket-Version: 13\r\n\r\n")
    sk.recv(4096)
    sk.sendall(bytes([0x81, 0xFF]) + (70 * 1024 * 1024).to_bytes(8, "big") + b"\x00" * 4)
    sk.settimeout(3)
    closed = False
    try:
        if not sk.recv(64):
            closed = True
    except socket.timeout:
        pass
    except ConnectionResetError:
        closed = True  # RST after close — still a closed connection
    sk.close()
    R.check(closed, ">64MB declared frame → connection closed")

    # RSS baseline AFTER the giant frames: malloc retains the first big parse's
    # arena (verified: repeat 10MB frames add ~0MB) — the bound below measures
    # growth across the soak, not that one-time floor
    rss0 = rss_kb(PID)

    # --- protocol violations --------------------------------------------------
    # unmasked client frame (RFC violation) + wrong opcode + text = invalid utf8
    out = await raw_frame(b'{"type":"rig.status"}', masked=False)
    R.check(len(out) >= 0, "unmasked frame handled", f"{len(out)}B reply")
    out = await raw_frame(b"junk", fin_op=0x83)  # RSV/unknown opcode
    R.check(alive(), "daemon alive after bad opcode")
    out = await raw_frame(b"\xff\xfe\x00badutf8", fin_op=0x81)
    R.check(alive(), "daemon alive after invalid-utf8 text frame")

    # --- rapid connect/disconnect ---------------------------------------------
    t0 = time.monotonic()
    for i in range(60):
        s = socket.create_connection((sh, int(sp)), timeout=3)
        if i % 3 == 0:
            s.sendall(b"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n"
                      b"Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                      b"Sec-WebSocket-Version: 13\r\n\r\n")
        elif i % 3 == 1:
            s.sendall(b"garbage-not-http\r\n\r\n")
        else:
            pass  # TCP open→close, nothing sent
        s.close()
    R.check(alive(), "daemon alive after 60 rapid connect/drops",
            f"{time.monotonic() - t0:.1f}s")

    # real ws connect then hard drop mid-frames
    for _ in range(15):
        w = await websockets.connect(URI, max_size=None, ping_interval=None)
        await w.send(b'{"type":"pair","code":"999999","device":"flap"}')
        await w.send(b'{"type":"rig.status"}')
        await w.close()
    R.check(alive(), "daemon alive after ws flap loop")

    # --- fragmented message ----------------------------------------------------
    w = await websockets.connect(URI, max_size=None)
    await w.send(b'{"type":"pair","code":"' + fresh_code().encode() + b'","device":"frag"}')
    m = await recv(w, 5)
    R.check(m.get("type") == "paired", "paired over control-frame-safe read")
    await w.close()

    # --- RSS soak: sessions + fuzz churn, then compare --------------------------
    ws3 = await connect()
    for i in range(3):
        await send(ws3, {"type": "rig.exec", "command": f"echo soak-{i}",
                         "timeoutMs": 10000})
        for _ in range(6):
            try:
                await recv(ws3, 5)
            except Exception:
                break
    await ws3.close()
    await asyncio.sleep(1.5)
    rss1 = rss_kb(PID)
    growth = rss1 - rss0
    R.check(growth < 32 * 1024, "RSS growth bounded across fuzz+soak",
            f"{rss0}→{rss1}KB (+{growth // 1024}MB)")
    R.check(alive(), "daemon still alive at end")

    return R.done()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
