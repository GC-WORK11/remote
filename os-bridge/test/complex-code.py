"""Deep code e2e: an agent turn in a real git workspace that must edit files
AND run the workspace's own test script. Host-verified: ./test.sh exits 0,
git diff shows the edits, and the served page contains the new markup.
Usage: python3.12 test/complex-code.py [ip] [port] [cwd]
"""
import json, secrets, subprocess, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from client import Ws, RIG_HOME, wait_for  # noqa: E402

PROMPT = (
    "In this workspace:\n"
    "1) add a button with id=\"theme-toggle\" to index.html (place it inside body)\n"
    "2) in script.js, wire it so clicking toggles a `dark` class on document.body and give body.dark a dark background in the inline style of index.html\n"
    "3) run ./test.sh and report its output\n"
    "Reply DONE when the test prints TEST-PASS."
)


def pair(ip, port):
    RIG_HOME.mkdir(exist_ok=True)
    code = f"{secrets.randbelow(1000000):06d}"
    (RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
    ws = Ws(ip, port)
    ws.send({"type": "pair", "code": code, "device": "complex-code"})
    return Ws(ip, port, token=wait_for(ws, "paired")["token"])


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
    cwd = sys.argv[3] if len(sys.argv) > 3 else str(Path.home() / "demo-work/launchpad")
    ws = pair(ip, port)

    sid = f"cc{secrets.token_hex(3)}"
    ws.send({"type": "session.new", "sessionId": sid, "cwd": cwd, "model": "qwen/qwen3.8-flash"})
    wait_for(ws, "session.started", timeout=30)
    print(f"[spawn] {sid} cwd={cwd}")

    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "prompt", "id": "cc1", "message": PROMPT}})
    t0 = time.time()
    texts, result = [], None
    deadline = time.time() + 300
    while time.time() < deadline and not result:
        try:
            m = wait_for(ws, "rpc", timeout=max(1, min(30, deadline - time.time())))
        except TimeoutError:
            continue  # quiet stretch between frames — keep waiting for prompt_result
        f = m.get("frame", {})
        ev = f.get("assistantMessageEvent") or {}
        if ev.get("type") == "text_end" and ev.get("content"):
            texts.append(ev["content"])
        elif ev.get("type") == "text_delta" and ev.get("delta"):
            texts.append(ev["delta"])
        if f.get("type") == "prompt_result":
            result = f
    print(f"[turn] {time.time()-t0:.1f}s result={'ok' if result else 'TIMEOUT'}")
    joined = " ".join(texts)
    if joined:
        print(f"       reply tail: …{joined[-300:]}")

    # host verification
    r = subprocess.run(["bash", "test.sh"], cwd=cwd, capture_output=True, text=True)
    t_ok = "TEST-PASS" in r.stdout
    print(f"[verify] ./test.sh: {'TEST-PASS' if t_ok else r.stdout + r.stderr}")
    diff = subprocess.run(["git", "diff", "--stat"], cwd=cwd, capture_output=True, text=True).stdout.strip()
    print(f"[verify] git diff --stat: {diff or '(clean)'}")
    page = subprocess.run(["curl", "-s", "http://127.0.0.1:8742/index.html"], capture_output=True, text=True).stdout
    s_ok = "theme-toggle" in page
    print(f"[verify] served page has theme-toggle: {'YES' if s_ok else 'NO'}")

    ws.send({"type": "session.delete", "sessionId": sid})
    ok = bool(result) and t_ok and s_ok and bool(diff)
    print("COMPLEX-CODE", "PASS" if ok else "CHECK")


main()
