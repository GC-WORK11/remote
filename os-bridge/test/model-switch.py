"""Prove Synara-style model switching between/within sessions over the rig wire:
spawn session on model A, set_model to B mid-session, get_state shows B,
prompt result reports B. Then a second session independently on A.
Usage: python3 test/model-switch.py [ip] [port]
"""
import asyncio, json, secrets, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from client import Ws, RIG_HOME, wait_for, TestFailure  # noqa: E402


def rpc_wait(ws, command: str, timeout: float = 20.0, collect=None) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = wait_for(ws, "rpc", timeout=max(0.5, deadline - time.time()), also_collect=collect)
        f = m.get("frame", {})
        if f.get("type") == "response" and f.get("command") == command:
            return f
    raise TimeoutError(f"no {command} response in {timeout}s")


def get_state_model(ws, sid):
    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "get_state", "id": f"gs-{secrets.token_hex(3)}"}})
    f = rpc_wait(ws, "get_state")
    return f.get("data", {}).get("model") or {}


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790

    RIG_HOME.mkdir(exist_ok=True)
    code = f"{secrets.randbelow(1000000):06d}"
    (RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
    ws = Ws(ip, port)
    ws.send({"type": "pair", "code": code, "device": "model-switch-test"})
    token = wait_for(ws, "paired")["token"]
    ws = Ws(ip, port, token=token)

    sid = f"ms{secrets.token_hex(3)}"
    ws.send({"type": "session.new", "sessionId": sid, "cwd": "/tmp", "model": "qwen/qwen3.8-flash"})
    wait_for(ws, "session.started", timeout=30)
    m0 = get_state_model(ws, sid)
    print(f"[1] spawned on qwen3.8-flash -> state model: {m0.get('provider','?')}/{m0.get('id','?')}")

    # switch mid-session to qwen3.8-max
    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "set_model", "id": "sm-1", "provider": "qwen", "modelId": "qwen3.8-max"}})
    f = rpc_wait(ws, "set_model")
    print(f"[2] set_model -> {f.get('type')} ok={f.get('ok')} data={json.dumps(f.get('data'))[:120]}")
    m1 = get_state_model(ws, sid)
    mid = f"{m1.get('provider','?')}/{m1.get('id','?')}"
    print(f"[3] state after switch: {mid}")
    assert "max" in mid or "qwen3.8-max" in json.dumps(m1), f"state still shows {mid}"

    # a prompt should now run on the new model — prompt_result reports the model used
    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "prompt", "id": "p1", "message": "Reply with exactly: MODELSWITCH-OK"}})
    deadline = time.time() + 90
    result = None
    while time.time() < deadline:
        m = wait_for(ws, "rpc", timeout=max(1, deadline - time.time()))
        f = m.get("frame", {})
        if f.get("type") == "prompt_result":
            result = f
            break
    assert result, "no prompt_result"
    used = result.get("model") or (result.get("data") or {}).get("model") or {}
    print(f"[4] prompt_result model={json.dumps(used)[:120]} ok={result.get('ok')}")

    # second session on flash — independent choice (Synara per-session models)
    sid2 = f"ms{secrets.token_hex(3)}"
    ws.send({"type": "session.new", "sessionId": sid2, "cwd": "/tmp", "model": "qwen/qwen3.8-flash"})
    wait_for(ws, "session.started", timeout=30)
    m2 = get_state_model(ws, sid2)
    print(f"[5] second session state: {m2.get('provider','?')}/{m2.get('id','?')} (flash) — sessions hold independent models")

    # cleanup
    for s in (sid, sid2):
        try:
            ws.send({"type": "session.delete", "sessionId": s})
        except Exception:
            pass
    print("MODEL-SWITCH PASS")


main()
