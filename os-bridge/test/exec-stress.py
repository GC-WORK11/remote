#!/usr/bin/env python3
"""exec-stress.py — rig.exec terminal-chain stress for omprd.

Proves against a live daemon:
  * concurrent execs stay ordered per execId (started → output* → done)
  * timeoutMs kills the whole process TREE — no orphaned grandchildren
  * 5 MB of output chunks through losslessly
  * exit codes pass through (0, 7, 127, signal)
  * non-UTF8 output can't break ws framing (daemon must sanitize)
  * rig.execKill terminates promptly
  * a disconnecting client orphans nothing (early-kill on dead client)

Run:  python3.12 test/exec-stress.py
Env:  RIG_HOST/RIG_PORT
"""

import asyncio
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from rig import Reporter, connect, recv, recv_type, send


def procs_matching(pattern: str) -> list[str]:
    # argv-visible matcher: `sleep NNN` lines where NNN is EXACTLY the marker
    # duration (`sleep 301`, not `sleep 3010`). `# comment` markers never reach
    # argv — bash parses them away — so a duration is the marker.
    r = subprocess.run(["pgrep", "-fl", pattern], capture_output=True, text=True)
    return [l for l in r.stdout.splitlines()
            if l.strip() and l.rstrip().endswith(pattern)]


async def exec_run(ws, command, timeout_ms=30000, collect=None, **kw):
    """Fire rig.exec, collect exec.* frames until exec.done. Returns (done, outputs)."""
    await send(ws, {"type": "rig.exec", "command": command, "timeoutMs": timeout_ms, **kw})
    started = await recv_type(ws, "exec.started", 10)
    eid = started["execId"]
    outputs = []
    while True:
        m = await recv(ws, 60)
        if m.get("type") == "exec.output" and m.get("execId") == eid:
            outputs.append(m)
        elif m.get("type") == "exec.done" and m.get("execId") == eid:
            return m, outputs
        elif collect is not None:
            collect.append(m)


async def main() -> int:
    R = Reporter("exec-stress")
    ws = await connect()

    # --- concurrent execs: 8 interleaved, per-execId ordering ----------------
    N = 8
    for i in range(N):
        await send(ws, {"type": "rig.exec",
                        "command": f"sleep 0.{i}; echo exec-{i}",
                        "timeoutMs": 15000})
    started_ids = set()
    bag = []  # fast execs finish before all starteds arrive — replay, never drop
    for _ in range(N):
        m = await recv_type(ws, "exec.started", 10, bag=bag)
        started_ids.add(m["execId"])
    R.check(len(started_ids) == N, "8 concurrent exec.started, unique ids")
    per = {e: [] for e in started_ids}
    dones = {}

    def collect(m):
        if m.get("type") == "exec.output" and m["execId"] in per:
            per[m["execId"]].append(m)
        elif m.get("type") == "exec.done" and m["execId"] in per:
            dones[m["execId"]] = m

    for m in bag:
        collect(m)
    while len(dones) < N:
        collect(await recv(ws, 30))
    R.check(all(d["code"] == 0 for d in dones.values()),
            "all concurrent execs code 0")
    joined = b"".join(json.dumps(o).encode() for outs in per.values() for o in outs)
    R.check(all(f"exec-{i}".encode() in joined for i in range(N)),
            "every exec's output arrived under its own execId")

    # --- exit codes ----------------------------------------------------------
    for cmd, want in [("exit 0", 0), ("exit 7", 7), ("nosuch-rig-cmd-xyz", 127)]:
        done, _ = await exec_run(ws, cmd)
        R.check(done["code"] == want and not done["timedOut"],
                f"exit code {want} for '{cmd}'", f"got {done['code']}")
    done, _ = await exec_run(ws, "kill -SEGV $$")
    R.check(done["code"] == -1, "signal death → code -1", f"got {done['code']}")

    # --- timeout kills the whole tree (incl. grandchildren) ------------------
    # sleep durations ARE the markers — they survive `bash -c` exec'ing and
    # show up in ps/pgrep argv. g2's inner bash exits after spawning, leaving
    # sleep 302 reparented to init — still in the exec's process GROUP, so a
    # real group-kill must reap it; anything weaker leaves it burning 300s.
    mark = 300 + (os.getpid() % 150)  # per-run argv marker — overlapping runs don't collide
    cmd = (f"bash -c 'sleep {mark + 1} & "
           f"bash -c \"sleep {mark + 2} &\" & "
           f"sleep {mark}'")
    done, _ = await exec_run(ws, cmd, timeout_ms=800)
    R.check(done["timedOut"], "timeoutMs fired", f"dur={done.get('durationMs')}ms")
    await asyncio.sleep(0.5)
    strays = procs_matching(f"sleep {mark + 1}") + procs_matching(f"sleep {mark + 2}") + \
             procs_matching(f"sleep {mark}")
    R.check(not strays, "timeout killed process tree (grandchildren too)",
            f"strays={strays}")

    # --- execKill -------------------------------------------------------------
    await send(ws, {"type": "rig.exec", "command": f"sleep {mark + 17}",
                    "timeoutMs": 60000})
    st = await recv_type(ws, "exec.started", 10)
    await asyncio.sleep(0.3)               # let it actually spawn
    await send(ws, {"type": "rig.execKill", "execId": st["execId"]})
    t0 = time.monotonic()
    done = None
    while time.monotonic() - t0 < 10:
        m = await recv(ws, 10)
        if m.get("type") == "exec.done" and m.get("execId") == st["execId"]:
            done = m
            break
    R.check(done is not None and done["durationMs"] < 5000,
            "execKill → fast exec.done", f"dur={done and done['durationMs']}ms")
    R.check(not procs_matching(f"sleep {mark + 17}"), "execKill left no strays")

    # --- 5 MB output ----------------------------------------------------------
    total = 0
    chunks = 0
    done, outs = await exec_run(
        ws, "head -c 5000000 /dev/urandom | base64", timeout_ms=60000)
    for o in outs:
        total += len(o["chunk"])
        chunks += 1
    R.check(done["code"] == 0 and total >= 5_000_000 * 4 // 3,
            "5MB payload streamed", f"{total} bytes in {chunks} chunks")

    # --- non-UTF8 bytes must not break the socket -----------------------------
    # strict ws clients die on invalid-UTF8 text frames; after this the daemon
    # must still answer (chunk sanitized, raw bytes preserved in chunkB64).
    try:
        done, outs = await exec_run(
            ws, "printf '\\xff\\xfe\\x80abc\\xed\\xa0\\x80\\n'", timeout_ms=15000)
        blob = "".join(o.get("chunk", "") for o in outs)
        import base64 as b64
        raw = b64.b64decode("".join(o.get("chunkB64", "") for o in outs)) \
            if any("chunkB64" in o for o in outs) else b""
        R.check(done["code"] == 0, "non-UTF8 exec completed", f"code={done['code']}")
        R.check(raw == b"\xff\xfe\x80abc\xed\xa0\x80\n" or "\ufffd" in blob,
                "non-UTF8 delivered losslessly (chunkB64) or sanitized",
                f"b64={raw!r}")
        # socket still alive:
        done2, _ = await exec_run(ws, "echo still-alive")
        R.check(done2["code"] == 0, "socket usable after non-UTF8 frame")
    except (UnicodeDecodeError, Exception) as e:  # websockets raises on bad utf8
        R.check(False, "non-UTF8 output stayed inside ws text frames",
                f"client-side decode error: {e}")

    # --- disconnect kills the running exec (no orphan burn) -------------------
    ws2 = await connect()
    await send(ws2, {"type": "rig.exec", "command": "bash -c 'sleep 331 & wait'",
                     "timeoutMs": 600000})
    await recv_type(ws2, "exec.started", 10)
    await asyncio.sleep(0.4)
    await ws2.close()                       # client dies mid-exec
    await asyncio.sleep(2.0)                # grace for daemon-side notice+kill
    R.check(not procs_matching("sleep 331"),
            "client disconnect reaped the running exec tree")

    return R.done()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
