#!/usr/bin/env python3
"""WALKTHROUGH e2e driver — the real user journey over one paired socket.

Uses the REAL `ompr pair` code (from ~/.rig/pending.json, minted by the CLI)
rather than minting its own: this is exactly what the app does when you scan
the QR — pair -> token -> Bearer reconnect -> rig.status -> computer.* ->
session.new -> prompt -> session.kill.

Evidence (screenshot frame bytes) lands in /tmp/journey-evidence/.

usage: python3.12 journey-e2e.py [host] [port]
"""
import json
import sys
import time
import base64
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from client import Ws, wait_for, TestFailure  # reuse the reference client

RIG_HOME = Path.home() / ".rig"
EVIDENCE = Path("/tmp/journey-evidence")
EVIDENCE.mkdir(exist_ok=True)


def wait_type(ws, want, timeout=15.0, sink=None):
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = ws.recv(timeout=max(0.5, deadline - time.time()))
        if m is None:
            raise ConnectionError("closed")
        if sink is not None:
            sink.append(m)
        if m.get("type") == "error":
            raise TestFailure(f"daemon error: {m.get('error')}")
        if m.get("type") == want:
            return m
    raise TimeoutError(f"no {want} in {timeout}s")


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
    log = lambda *a: print(*a, flush=True)

    # -- STEP 1: pairing (what `ompr pair` + the phone actually do) ----------
    pending = json.loads((RIG_HOME / "pending.json").read_text())
    code = pending["code"]
    log(f"[1] pair — real ompr code {code} (remote://{ip}:{port}#{code})")
    ws = Ws(ip, port)
    ws.send({"type": "pair", "code": code, "device": "walkthrough-e2e"})
    m = wait_type(ws, "paired")
    token = m["token"]
    log(f"    paired — device 'walkthrough-e2e', token {token[:14]}…")
    (Path("/tmp/journey-token.txt")).write_text(token)

    # -- STEP 2: reconnect with the bearer token (app resume path) -----------
    ws = Ws(ip, port, token=token)
    ws.send({"type": "rig.status"})
    m = wait_type(ws, "rig.status")
    log(f"[2] rig.status — host={m.get('hostname')} "
        f"sessions={len(m.get('sessions', []))} devices={[d.get('device') for d in m.get('devices', [])]}")

    # -- STEP 3: computer.* on the real display ------------------------------
    ws.send({"type": "computer.state"})
    m = wait_type(ws, "computer.state")
    log(f"[3] computer.state — display={m.get('display')} resolution={m.get('resolution')} "
        f"pixelResolution={m.get('pixelResolution')} backend={m.get('backend')!r}")

    ws.send({"type": "computer.perms"})
    m = wait_type(ws, "computer.perms")
    log(f"    computer.perms — backend={m.get('backend')} perms={m.get('perms') or m}")

    ws.send({"type": "computer.boot"})
    m = wait_type(ws, "computer.state", timeout=10)
    log(f"    computer.boot — display now {m.get('display')} resolution={m.get('resolution')} booted={m.get('booted')}")

    ws.send({"type": "computer.screenshot", "scale": 0.5})
    m = wait_type(ws, "computer.screenshot", timeout=30)
    img = m.get("imageBase64") or m.get("pngBase64") or ""
    ext = m.get("format", "jpg")
    f = EVIDENCE / f"screenshot-main.{ext}"
    f.write_bytes(base64.b64decode(img))
    log(f"    computer.screenshot — {len(img)//1024}KB b64 ({ext} encoder={m.get('encoder')}) -> {f}")

    ws.send({"type": "computer.windows"})
    m = wait_type(ws, "computer.windows", timeout=15)
    wins = m.get("windows", [])
    log(f"    computer.windows — {len(wins)} windows: "
        f"{[w.get('title','')[:28] for w in wins[:6]]}")

    ws.send({"type": "computer.launch", "action": "launch", "app": "TextEdit"})
    try:
        m = wait_type(ws, "computer.launched", timeout=15)
        log(f"    computer.launch TextEdit — ok={m.get('ok')} pid={m.get('pid')} "
            f"frontmost={m.get('frontmost')} display={m.get('display')}")
    except TimeoutError:
        log("    computer.launch — no launched reply (check log)")

    # -- STEP 4: session.new + a REAL agent turn -----------------------------
    sid = "walkthrough-e2e"
    scratch = Path("/tmp/rig-walkthrough-work"); scratch.mkdir(exist_ok=True)
    ws.send({"type": "session.new", "sessionId": sid, "cwd": str(scratch)})
    wait_type(ws, "session.started")
    log(f"[4] session.new — omp --mode rpc up in {scratch}")
    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "set_auto_retry", "enabled": False}})

    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "get_state"}})
    frames = []
    m = wait_type(ws, "rpc", timeout=20, sink=frames)
    while m.get("frame", {}).get("command") != "get_state":
        m = wait_type(ws, "rpc", timeout=20, sink=frames)
    st = m["frame"].get("data", {})
    log(f"    get_state — model={(st.get('model') or {}).get('id')} streaming={st.get('isStreaming')}")

    log("    prompting 'Reply with exactly: RIG-OK' (fake-openai drives a real turn: tool call -> text)")
    ws.send({"type": "rpc", "sessionId": sid,
             "frame": {"type": "prompt", "id": "p1", "message": "Reply with exactly: RIG-OK"}})
    saw_delta = saw_tool = False
    result = None
    deadline = time.time() + 90
    while time.time() < deadline:
        try:
            m = wait_type(ws, "rpc", timeout=10, sink=frames)
        except TimeoutError:
            continue
        f = m.get("frame", {})
        t = f.get("type")
        if t == "message_update" and f.get("assistantMessageEvent", {}).get("type") == "text_delta":
            saw_delta = True
        if t in ("tool_call", "tool_result") or "tool" in str(t):
            saw_tool = True
        if t == "prompt_result":
            result = f
            break
    log(f"    prompt_result — status={result and result.get('status')} "
        f"text_deltas={saw_delta} tool_frames={saw_tool} frames={len(frames)}")

    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "get_last_assistant_text"}})
    deadline = time.time() + 15
    while time.time() < deadline:
        m = wait_type(ws, "rpc", timeout=10, sink=frames)
        f = m.get("frame", {})
        if f.get("type") == "response" and f.get("command") == "get_last_assistant_text":
            log(f"    assistant text: {str((f.get('data') or {}).get('text'))[:120]}")
            break

    # -- STEP 5: sessions.list (what the app's inbox shows) ------------------
    ws.send({"type": "sessions.list"})
    try:
        m = wait_type(ws, "sessions.list", timeout=10)
        log(f"[5] sessions.list — {len(m.get('sessions', []))} session(s) visible to the app")
    except Exception as e:
        log(f"[5] sessions.list — {e}")

    # -- STEP 6: session.kill ------------------------------------------------
    ws.send({"type": "session.kill", "sessionId": sid})
    try:
        m = wait_type(ws, "session.exited", timeout=10)
        log(f"[6] session.kill — exited code={m.get('code')}")
    except TimeoutError:
        log("[6] session.exited not seen")

    log("\nJOURNEY E2E: PASS" if result else "\nJOURNEY E2E: PARTIAL")


if __name__ == "__main__":
    main()
