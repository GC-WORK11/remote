"""rig.py — shared test scaffolding for omprd wire-protocol suites.

Pair, connect, send/recv over websockets against a live daemon.
Usage:
    from rig import connect, pair, rpc_collect
"""

import asyncio
import json
import os
import subprocess
import time

import websockets

HOST = os.environ.get("RIG_HOST", "127.0.0.1")
PORT = int(os.environ.get("RIG_PORT", "8790"))
URI = f"ws://{HOST}:{PORT}/ws"
PAIR_FILE = os.path.expanduser("~/.rig/pending.json")
TOKEN_FILE = os.path.expanduser("~/.rig/test-token.json")
OMPRD = os.environ.get("RIG_OMPRD",
                       os.path.join(os.path.dirname(__file__), "..", "daemon", "omprd"))


def fresh_code() -> str:
    """Mint a NEW one-time pair code via `omprd pair` and return it."""
    subprocess.run([OMPRD, "pair"], capture_output=True)
    with open(PAIR_FILE) as f:
        return json.load(f)["code"]


def saved_token() -> str | None:
    try:
        with open(TOKEN_FILE) as f:
            return json.load(f)["token"]
    except OSError:
        return None


def save_token(tok: str) -> None:
    with open(TOKEN_FILE, "w") as f:
        json.dump({"token": tok}, f)


async def connect(paired: bool = True, token: str | None = None, uri: str = URI):
    """Open a ws and (by default) pair it. Returns the websocket."""
    tok = token if token is not None else saved_token()
    u = f"{uri}?token={tok}" if tok else uri
    ws = await websockets.connect(u, max_size=None, ping_interval=None)
    if not paired:
        return ws
    if tok:
        return ws  # token path skips pairing entirely
    code = fresh_code()
    await ws.send(json.dumps({"type": "pair", "code": code, "device": "rig-test"}))
    msg = json.loads(await asyncio.wait_for(ws.recv(), 10))
    if msg.get("type") == "paired":
        save_token(msg["token"])
        return ws
    # stale token raced us — pair failed
    raise AssertionError(f"pair failed: {msg}")


async def connect_new():
    """Always pair fresh (new device token) — code is minted per call."""
    return await connect(paired=True, token="")


async def send(ws, obj: dict) -> None:
    await ws.send(json.dumps(obj))


async def recv(ws, timeout: float = 10.0) -> dict:
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def recv_type(ws, want: str, timeout: float = 15.0, bag: list | None = None) -> dict:
    """Read frames until one of type `want` arrives; stash others in `bag`.
    An `error` frame means `want` will never arrive — surface it now instead
    of burning the timeout on a message that's already dead."""
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        m = await recv(ws, max(0.5, timeout - (time.monotonic() - t0)))
        if bag is not None:
            bag.append(m)
        if m.get("type") == want:
            return m
        if m.get("type") == "error":
            raise AssertionError(f"daemon error while waiting for {want}: {m}")
    raise AssertionError(f"timed out waiting for {want}; last bag tail: {(bag or [])[-3:]}")


async def kill_all_sessions(ws) -> list[str]:
    """Kill every session the daemon knows — suites that reuse fixed ids need
    this: sessions outlive the client that spawned them, so a previous run's
    leftovers collide with the next run's session.new."""
    await send(ws, {"type": "sessions.list"})
    m = await recv_type(ws, "sessions.list", 10)
    killed = []
    for s in m.get("sessions", []):
        await send(ws, {"type": "session.kill", "sessionId": s["id"]})
        killed.append(s["id"])
    if killed:
        await asyncio.sleep(0.6)  # let exits land before reusing the ids
    return killed


async def session_new(ws, sid: str, **opts) -> dict:
    await send(ws, {"type": "session.new", "sessionId": sid, **opts})
    return await recv_type(ws, "session.started", 20)


async def rpc_collect(ws, sid: str, stop_types=("prompt_result",), timeout: float = 30.0):
    """Collect rpc frames for `sid` until a frame whose inner type is in
    stop_types. Returns (frames, stop_frame)."""
    frames, stop = [], None
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        m = await recv(ws, max(0.5, timeout - (time.monotonic() - t0)))
        if m.get("type") == "rpc" and m.get("sessionId") == sid:
            frames.append(m)
            if m["frame"].get("type") in stop_types:
                stop = m
                break
    if stop is None:
        raise AssertionError(f"no stop frame for {sid} in {timeout}s ({len(frames)} frames)")
    return frames, stop


GREEN = "\033[32m"
RED = "\033[31m"
DIM = "\033[2m"
RST = "\033[0m"


class Reporter:
    def __init__(self, name: str):
        self.name = name
        self.checks = 0
        self.fails: list[str] = []

    def check(self, cond: bool, label: str, detail: str = "") -> None:
        self.checks += 1
        if cond:
            print(f"  {GREEN}ok{RST}  {label} {DIM}{detail}{RST}")
        else:
            self.fails.append(label)
            print(f"  {RED}FAIL{RST} {label} {DIM}{detail}{RST}")

    def done(self) -> int:
        verdict = "ALL GREEN" if not self.fails else f"{len(self.fails)} FAILURES"
        color = GREEN if not self.fails else RED
        print(f"\n{self.name}: {self.checks} checks — {color}{verdict}{RST}")
        return 0 if not self.fails else 1
