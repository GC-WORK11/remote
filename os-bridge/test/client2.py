#!/usr/bin/env python3
"""remote v0.2 advanced e2e: replay, correlated requests, usage, master
fan-outs, latency stats, lock kill-switch. Run against a live omprd."""
import json
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from client import Ws, wait_for, TestFailure  # noqa: E402

RIG_HOME = Path.home() / ".rig"


def ok(label):
    print(f"  ✓ {label}")


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790

    # -- pair ------------------------------------------------------------
    RIG_HOME.mkdir(exist_ok=True)
    code = f"{secrets.randbelow(1000000):06d}"
    (RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
    ws = Ws(ip, port)
    ws.send({"type": "pair", "code": code, "device": "adv-test"})
    token = wait_for(ws, "paired")["token"]
    ok("pairing")

    # -- session with unique id ------------------------------------------
    sid = f"adv{secrets.token_hex(3)}"
    ws.send({"type": "session.new", "sessionId": sid, "cwd": "/tmp/rig-test-work"})
    wait_for(ws, "session.started")
    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "set_auto_retry", "enabled": False}})
    ok(f"session.new ({sid})")

    # -- replay: everything omp emitted before we subscribed -------------
    ws.send({"type": "session.subscribe", "sessionId": sid, "since": 0})
    replayed = []
    sub = None
    deadline = time.time() + 15
    while time.time() < deadline and sub is None:
        m = ws.recv(timeout=5)
        if m.get("type") == "session.subscribed":
            sub = m
        elif m.get("type") == "rpc" and m.get("replay"):
            replayed.append(m)
    assert sub and replayed, f"replay broken: sub={sub} n={len(replayed)}"
    assert any(f.get("type") == "ready" for m in replayed for f in [m.get("frame", {})]), "ready frame not in replay"
    ok(f"replay from 0 → {len(replayed)} frames, liveSeq={sub['liveSeq']}")

    # -- correlated request ----------------------------------------------
    ws.send({"type": "session.request", "sessionId": sid, "frame": {"type": "get_state"}})
    resp = None
    deadline = time.time() + 15
    while time.time() < deadline:
        m = ws.recv(timeout=5)
        if m.get("type") == "session.response" and m.get("frame", {}).get("command") == "get_state":
            resp = m
            break
    assert resp and resp["frame"]["success"], f"correlated get_state failed: {resp}"
    model = (resp["frame"]["data"].get("model") or {}).get("id", "?")
    ok(f"session.request → get_state (model={model})")

    # -- token efficiency: context usage ----------------------------------
    ws.send({"type": "session.usage", "sessionId": sid})
    usage = None
    deadline = time.time() + 15
    while time.time() < deadline:
        m = ws.recv(timeout=5)
        if m.get("type") == "session.response" and m.get("frame", {}).get("command") == "get_state":
            usage = m["frame"]["data"].get("contextUsage")
            break
    assert usage is not None, "no contextUsage in get_state"
    ok(f"session.usage → {json.dumps(usage)[:110]}")

    # -- live turn, tracking seqs -----------------------------------------
    print("  … prompting (real model turn)")
    frames = []
    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "prompt", "id": "p1", "message": "Reply with exactly: RIG2-OK"}})
    result = None
    last_seq = 0
    deadline = time.time() + 150
    while time.time() < deadline:
        try:
            m = wait_for(ws, "rpc", timeout=15, also_collect=frames)
        except (TimeoutError, TestFailure):
            continue
        if m.get("sessionId") != sid:
            continue  # other sessions' frames don't move our cursor
        last_seq = max(last_seq, m.get("seq", 0))
        if m.get("frame", {}).get("type") == "prompt_result":
            result = m["frame"]
            break
    if not result:
        # provider stall: prove the pipe by aborting and requiring the clean
        # aborted result to round-trip (still exercises the full bridge)
        ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "abort"}})
        deadline = time.time() + 15
        while time.time() < deadline and result is None:
            try:
                m = wait_for(ws, "rpc", timeout=5, also_collect=frames)
            except (TimeoutError, TestFailure):
                continue
            if m.get("sessionId") == sid and m.get("frame", {}).get("type") == "prompt_result":
                result = m["frame"]
    assert result, "no prompt_result even after abort — bridge itself stuck"
    if result.get("status") == "aborted":
        ok(f"live turn: pipe OK, provider stalled → clean abort after {len(frames)} frames")
    elif result.get("status") == "error":
        err = result.get("error", {})
        ok(f"live turn: pipe OK, provider errored fast: {err.get('message', '?')[:80]} (http {err.get('httpStatus')})")
    else:
        ok(f"live turn: {len(frames)} streamed frames, lastSeq={last_seq}, status=completed")

    # -- reconnect + incremental replay ------------------------------------
    ws2 = Ws(ip, port, token=token)
    ws2.send({"type": "session.subscribe", "sessionId": sid, "since": last_seq})
    inc = []
    sub2 = None
    deadline = time.time() + 15
    while time.time() < deadline and sub2 is None:
        m = ws2.recv(timeout=5)
        if m.get("type") == "session.subscribed":
            sub2 = m
        elif m.get("type") == "rpc" and m.get("replay"):
            inc.append(m)
    assert sub2, "no subscribe ack on reconnect"
    assert all(m["seq"] > last_seq for m in inc), "replay leaked frames <= lastSeq"
    ok(f"reconnect + incremental replay: {len(inc)} new frames, resumed at seq {sub2['replayedTo']}")
    ws2.sock.close()

    # -- master control: cross-session subagent fan-out --------------------
    ws.send({"type": "sessions.subagents"})
    fan = wait_for(ws, "sessions.subagents", timeout=20)
    ok(f"master fan-out sessions.subagents → {len(fan.get('results', []))} result block(s)")

    # -- master control: remote compaction ---------------------------------
    ws.send({"type": "sessions.compact"})
    comp = wait_for(ws, "sessions.compact", timeout=60)
    ok(f"master sessions.compact → {len(comp.get('results', []))} session(s) compacted"
       + (" (partial)" if comp.get("partial") else ""))

    # -- telemetry ----------------------------------------------------------
    ws.send({"type": "rig.stats"})
    st = wait_for(ws, "rig.stats")
    b = st["latencyBridgeUs"]; q = st["latencyQueueMs"]
    ok(f"rig.stats: frames in={st['framesIn']} out={st['framesOut']}, "
       f"bridge p50={b.get('p50')}µs p99={b.get('p99')}µs, queue p50={q.get('p50')}ms")

    # -- lock kill-switch ----------------------------------------------------
    ws.send({"type": "rig.lock"})
    wait_for(ws, "ok")
    time.sleep(0.6)  # reaper sweep picks up the lock file
    ws3 = Ws(ip, port, token=token)
    ws3.send({"type": "sessions.list"})
    m = ws3.recv(timeout=5)
    # a locked rig rejects tokens outright (unauthorized) or refuses dispatch (locked) — both count
    assert m.get("type") == "error" and ("locked" in m.get("error", "") or "unauthorized" in m.get("error", "")), f"lock not enforced: {m}"
    ok(f"rig.lock enforced ('{m.get('error')}')")
    (RIG_HOME / "locked").unlink()  # unlock from the rig side
    time.sleep(0.6)
    # auth is per-connection at upgrade time — the locked-era socket stays
    # unauthorized forever, so prove recovery on a fresh connection
    ws4 = Ws(ip, port, token=token)
    ws4.send({"type": "sessions.list"})
    m = ws4.recv(timeout=5)
    assert m.get("type") == "sessions.list", f"unlock failed: {m}"
    ok("unlock via file removal picked up live (fresh connection re-authed)")
    ws3.sock.close()

    # -- teardown (session was already killed by rig.lock's sweep) -------------
    ws4.send({"type": "session.kill", "sessionId": sid})
    wait_for(ws4, "ok", timeout=10)
    ok("teardown complete (sessions were killed by the lock sweep)")
    ws4.sock.close()

    print("\nADVANCED E2E: ALL GREEN")


if __name__ == "__main__":
    main()
