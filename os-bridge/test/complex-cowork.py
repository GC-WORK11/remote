"""Deep cowork e2e: one prompt that must chain real host side effects.
Verifiable afterwards: a folder+file lands on the Desktop, sw_vers output is
reported correctly, and a Finder window opens on the folder.
Usage: python3.12 test/complex-cowork.py [ip] [port]
"""
import json, secrets, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from client import Ws, RIG_HOME, wait_for  # noqa: E402

DIR = Path.home() / "Desktop" / "rig-proof-2"
PROMPT = (
    "Do ALL of this with your tools on this Mac, then reply DONE:\n"
    f"1) create the folder {DIR} containing a file proof.txt whose content is exactly: it works\n"
    "2) run `sw_vers` and report the exact ProductVersion it prints\n"
    f"3) open the folder {DIR} in Finder\n"
    "Keep the reply to one short line per step."
)


def pair(ip, port):
    RIG_HOME.mkdir(exist_ok=True)
    code = f"{secrets.randbelow(1000000):06d}"
    (RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
    ws = Ws(ip, port)
    ws.send({"type": "pair", "code": code, "device": "complex-cowork"})
    return Ws(ip, port, token=wait_for(ws, "paired")["token"])


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
    ws = pair(ip, port)

    if DIR.exists():
        import shutil
        shutil.rmtree(DIR)

    sid = f"cx{secrets.token_hex(3)}"
    ws.send({"type": "session.new", "sessionId": sid, "cwd": "/tmp", "model": "qwen/qwen3.8-flash"})
    wait_for(ws, "session.started", timeout=30)
    print(f"[spawn] {sid} on qwen3.8-flash")

    ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "prompt", "id": "cx1", "message": PROMPT}})
    t0 = time.time()
    texts, result = [], None
    deadline = time.time() + 240
    while time.time() < deadline and not result:
        m = wait_for(ws, "rpc", timeout=max(1, deadline - time.time()))
        f = m.get("frame", {})
        ev = (f.get("assistantMessageEvent") or {})
        if ev.get("type") == "text_end" and ev.get("content"):
            texts.append(ev["content"])
        elif ev.get("type") == "text_delta" and ev.get("delta"):
            texts.append(ev["delta"])
        d = f.get("data")
        if isinstance(d, dict) and d.get("text"):
            texts.append(d["text"])
        elif isinstance(d, str):
            texts.append(d)
        if f.get("type") == "prompt_result":
            result = f
    print(f"[turn] {time.time()-t0:.1f}s result={'ok' if result else 'TIMEOUT'}")
    joined = " ".join(texts)
    if joined:
        print(f"       reply tail: …{joined[-300:]}")

    # host-side verification — the effects, not the transcript
    f_ok = (DIR / "proof.txt").exists() and (DIR / "proof.txt").read_text().strip() == "it works"
    print(f"[verify] proof.txt on Desktop: {'YES' if f_ok else 'NO'}")
    import subprocess
    vers = subprocess.run(["sw_vers", "-productVersion"], capture_output=True, text=True).stdout.strip()
    v_ok = vers in joined
    print(f"[verify] sw_vers {vers} reported in reply: {'YES' if v_ok else 'NO'}")
    try:
        wins = subprocess.run(
            ["osascript", "-e", 'tell application "Finder" to count windows'],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        print(f"[verify] Finder windows open: {wins}")
    except Exception as e:
        print(f"[verify] Finder check failed: {e}")

    ws.send({"type": "session.delete", "sessionId": sid})
    ok = bool(result) and f_ok and v_ok
    print("COMPLEX-COWORK", "PASS" if ok else "CHECK")


main()
