"""proof-real-task.py — REAL task through omprd. No echo. Records every frame.

Runs a real agent turn (qwen3.8-flash via models.yml): the agent must create a
folder + file, then run a command to verify. Dumps the full wire transcript to
proof-<ts>.jsonl for docs/HARNESS-PROOF.md.
"""
import asyncio, json, sys, time
sys.path.insert(0, ".")
from rig import connect

PROMPT = (
    "In /tmp create a folder named rig-proof2, write the file "
    "rig-proof2/hello.txt containing the single line 'remote works', then run "
    "`ls -la /tmp/rig-proof2` to confirm, and finally reply with the word DONE."
)

async def main():
    ws = await connect()  # pairs if needed
    log = open(f"/tmp/proof-{int(time.time())}.jsonl", "w")

    async def send(obj):
        log.write(json.dumps({"dir": "out", **obj}) + "\n")
        await ws.send(json.dumps(obj))

    # 1. session.new
    await send({"type": "session.new", "id": "new-1", "model": "qwen/qwen3.8-flash"})
    sid = None
    t0 = time.time()
    while time.time() - t0 < 60:
        m = json.loads(await asyncio.wait_for(ws.recv(), 55))
        log.write(json.dumps({"dir": "in", **m}) + "\n"); log.flush()
        print("<<", m.get("type"), str(m)[:160])
        if m.get("type") in ("session.created", "session.started") and m.get("sessionId"):
            sid = m["sessionId"]; break
    if not sid:
        print("NO SESSION"); return
    print("SESSION", sid)

    # 2. subscribe (catch live frames)
    await send({"type": "session.subscribe", "id": "sub-1", "sessionId": sid})
    # 3. the REAL prompt
    await send({"type": "rpc", "id": "p-1", "sessionId": sid,
                "frame": {"type": "prompt", "id": "p-1", "message": PROMPT}})

    kinds = {}
    t0 = time.time()
    done = False
    while time.time() - t0 < 240 and not done:
        try:
            m = json.loads(await asyncio.wait_for(ws.recv(), 230))
        except asyncio.TimeoutError:
            print("TIMEOUT waiting"); break
        log.write(json.dumps({"dir": "in", **m}) + "\n"); log.flush()
        k = m.get("type")
        f = m.get("frame") or {}
        fk = f.get("type")
        kinds[f"{k}/{fk}" if fk else k] = kinds.get(f"{k}/{fk}" if fk else k, 0) + 1
        if fk in ("assistant_text", "text_delta", "agent_message_delta"):
            pass
        elif fk in ("tool_call", "tool_result", "exec"):
            print("TOOL:", str(f)[:200])
        elif fk in ("turn_end",):
            print("TURN_END:", str(f)[:150])
        elif fk in ("agent_end", "idle") or (k == "session.busy" and m.get("busy") is False):
            print("AGENT DONE:", str(m)[:150]); done = True
        elif fk == "response" and f.get("id") == "p-1":
            print("PROMPT-ACK:", str(f)[:200])
        elif k in ("rpc.result", "session.ended"):
            print(k, ":", str(m)[:200])
            if fk is None and k == "rpc.result" and m.get("id") == "p-1":
                done = True
        else:
            print("<<", k, fk, str(m)[:150])
    print("KINDS:", json.dumps(kinds, indent=1))
    log.close()

asyncio.run(main())
