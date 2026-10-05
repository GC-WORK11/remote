#!/usr/bin/env python3
"""desktop claim/release lifecycle test — workspace.new idempotency,
per-session desktops, release on session death, count tail-shrink."""
import json, os, secrets, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from client import Ws, wait_for, TestFailure, RIG_HOME

IP, PORT = "127.0.0.1", 8790
results = []

def record(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS" if ok else "FAIL"), name, "—", detail, flush=True)

def pair():
    RIG_HOME.mkdir(exist_ok=True)
    code = f"{secrets.randbelow(1000000):06d}"
    (RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
    ws = Ws(IP, PORT)
    ws.send({"type": "pair", "code": code, "device": "desktest"})
    return wait_for(ws, "paired")["token"]

def rpc_reply(ws, sid, rid, timeout=20):
    while True:
        m = ws.recv(timeout=timeout)
        if m is None: raise ConnectionError("closed")
        if m.get("type") == "error": raise TestFailure(f"daemon error: {m.get('error')}")
        if m.get("type") == "session.response" and m.get("id") == rid: return m

def new_session(ws, sid):
    ws.send({"type": "session.new", "sessionId": sid, "cwd": "/tmp"})
    wait_for(ws, "session.started", timeout=15)
    return sid

def space(ws, sid, action, disp=":99"):
    ws.send({"type": "workspace." + action, "sessionId": sid, "display": disp})
    while True:
        m = ws.recv(timeout=10)
        if m is None: raise ConnectionError("closed")
        if m.get("type") == "workspace." + action and m.get("action") == action:
            return m
        if m.get("type") == "error": raise TestFailure(f"{action}: {m.get('error')}")

def count_for(disp=":99"):
    import subprocess
    out = subprocess.run(["xprop", "-root", "_NET_NUMBER_OF_DESKTOPS"],
                         env=dict(os.environ, DISPLAY=disp), capture_output=True, text=True)
    return int(out.stdout.strip().rsplit("=", 1)[-1]) if out.returncode == 0 else -1

def main():
    tok = pair()
    ws = Ws(IP, PORT, token=tok)
    ws.send({"type": "computer.state", "display": ":99"})
    st = wait_for(ws, "computer.state", timeout=20)
    record("boot :99", st.get("nativeBackend") is True, f"disp={st.get('display')} native={st.get('nativeBackend')}")

    base = count_for()
    record("base desktop count", base > 0, f"count={base}")

    s1, s2 = "deskA", "deskB"
    new_session(ws, s1); new_session(ws, s2)

    r1 = space(ws, s1, "new")
    d1 = r1.get("desktop"); c1 = count_for()
    record("space new s1", r1.get("ok") is True and d1 is not None, f"d={d1} count {base}->{c1}")

    r1b = space(ws, s1, "new")
    record("space new idempotent", r1b.get("reused") is True and r1b.get("desktop") == d1 and count_for() == c1,
           f"d={r1b.get('desktop')} reused={r1b.get('reused')} count={count_for()}")

    r2 = space(ws, s2, "new")
    d2 = r2.get("desktop"); c2 = count_for()
    record("space new s2 distinct", r2.get("ok") is True and d2 != d1, f"d={d2} count={c2}")

    # kill s2 abruptly (SIGKILL the child) → desktop must be released
    ws.send({"type": "session.kill", "sessionId": s2})
    time.sleep(1.2)  # reap sweep is 300ms
    c3 = count_for()
    r3 = space(ws, s1, "status")
    record("release on session death", count_for() <= c2 and c3 <= c2, f"count {c2}->{c3} s1.still={r3.get('desktop')}")

    # s1 still owns its desktop after s2 died
    record("s1 desktop survives s2 death", r3.get("desktop") == d1, f"d={r3.get('desktop')}")

    # kill s1 → everything we added shrinks back to base
    ws.send({"type": "session.kill", "sessionId": s1})
    time.sleep(1.2)
    c4 = count_for()
    record("count shrinks to base", c4 == base, f"count {base}->{c4} (peak {c2})")

    ws.sock.close()
    p = sum(1 for _, ok in results if ok)
    print(f"\n==== {p}/{len(results)} passed ====")
    sys.exit(len(results) - p)

main()
