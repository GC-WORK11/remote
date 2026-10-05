#!/usr/bin/env python3
"""mux-stress.py — session-multiplex + replay stress for omprd.

Proves, against a live daemon:
  * 3 concurrent sessions streaming at once — every emitted frame lands on the
    sessionId it belongs to, seqs strictly increase per session, correlated
    session.request replies return privately to the asker (never broadcast).
  * killing one session mid-stream never disturbs the others.
  * exactly-once replay: subscribe since= while frames are live, disconnect
    mid-replay and resume, and a ring-overflow backlog still comes out
    contiguous + honest.

Sessions spawn with ompBin=test/fake-omp.sh (200 deltas + prompt_result per
prompt) so the whole suite is deterministic and fast.

Run:  python3.12 test/mux-stress.py
Env:  RIG_HOST/RIG_PORT
"""

import asyncio
import json
import sys
import time

import websockets

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from rig import Reporter, connect, kill_all_sessions, recv, recv_type, rpc_collect, send, session_new

FAKE = __file__.rsplit("/", 1)[0] + "/fake-omp.sh"


async def drain_until(ws, pred, timeout=30.0, bag=None):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        m = await recv(ws, max(0.5, timeout - (time.monotonic() - t0)))
        if bag is not None:
            bag.append(m)
        if pred(m):
            return m
    raise AssertionError("drain timed out")


async def main() -> int:
    R = Reporter("mux-stress")
    t_start = time.monotonic()

    # ------------------------------------------------------------------
    # 1) three sessions, interleaved streaming, zero cross-talk
    # ------------------------------------------------------------------
    ws1 = await connect(token="")          # force a fresh pair (also exercises it)
    stale = await kill_all_sessions(ws1)   # sessions outlive their client — a
                                           # crashed run would collide with us
    if stale:
        print(f"  reaped {len(stale)} leftover sessions: {stale}")
    sids = ["mux-a", "mux-b", "mux-c"]
    for sid in sids:
        await session_new(ws1, sid, ompBin=FAKE)
    print("  3 sessions started")

    # session.request BEFORE prompts — correlated get_state per session,
    # replies must come back as session.response to THIS client only.
    req_ids = {}
    for sid in sids:
        await send(ws1, {"type": "session.request", "sessionId": sid,
                         "frame": {"type": "get_state"}})
    responses = []
    for _ in range(3):
        responses.append(await recv_type(ws1, "session.response", 15))
    for m in responses:
        req_ids[m["sessionId"]] = m["id"]
    R.check(set(req_ids) == set(sids), "correlated get_state per session",
            f"ids={req_ids} raw={[(r['sessionId'], r['id']) for r in responses]}")
    R.check(all(r["frame"].get("success") for r in responses),
            "session.response payloads succeed")

    # fire all three prompts back-to-back; frames interleave on one socket
    for i, sid in enumerate(sids):
        await send(ws1, {"type": "rpc", "sessionId": sid,
                         "frame": {"type": "prompt", "id": f"{sid}-p1",
                                   "message": f"burst {sid}"}})
    per_session = {s: [] for s in sids}
    done = set()
    t0 = time.monotonic()
    while len(done) < 3 and time.monotonic() - t0 < 60:
        m = await recv(ws1, 60)
        if m.get("type") != "rpc":
            continue
        sid = m["sessionId"]
        if sid not in per_session:
            continue
        per_session[sid].append(m)
        if m["frame"].get("type") == "prompt_result":
            done.add(sid)
    for sid in sids:
        frames = per_session[sid]
        seqs = [f["seq"] for f in frames]
        R.check(len(frames) >= 201, f"{sid} full burst", f"{len(frames)} frames")
        R.check(seqs == sorted(seqs) and len(set(seqs)) == len(seqs),
                f"{sid} seqs strictly increasing")
        prs = [f for f in frames if f["frame"].get("type") == "prompt_result"]
        R.check(len(prs) == 1 and prs[0]["frame"].get("id") == f"{sid}-p1",
                f"{sid} prompt_result carries own prompt id")
    # zero cross-talk = no frame tagged sid carried another session's stop id
    foreign = [f for sid in sids for f in per_session[sid]
               if f["frame"].get("id", "").startswith(tuple(x + "-" for x in sids if x != sid))]
    R.check(not foreign, "zero cross-talk (no foreign prompt ids)")

    # ------------------------------------------------------------------
    # 2) kill one session mid-stream; the other two keep going
    # ------------------------------------------------------------------
    for sid in ("mux-d", "mux-e"):
        await session_new(ws1, sid, ompBin=FAKE)
    await send(ws1, {"type": "rpc", "sessionId": "mux-d",
                     "frame": {"type": "prompt", "message": "burst d"}})
    await send(ws1, {"type": "rpc", "sessionId": "mux-e",
                     "frame": {"type": "prompt", "message": "burst e"}})
    # let both start streaming, then kill d mid-burst
    await drain_until(ws1, lambda m: m.get("type") == "rpc" and m.get("sessionId") == "mux-d"
                      and m["frame"].get("type") == "message_delta", 15)
    await send(ws1, {"type": "session.kill", "sessionId": "mux-d"})
    skid = []  # mux-e frames drained while we wait for mux-d's exit — keep them
    exit_d = await recv_type(ws1, "session.exited", 15, skid)
    R.check(exit_d["sessionId"] == "mux-d", "session.exited for killed mux-d")
    pre = [m for m in skid if m.get("type") == "rpc" and m.get("sessionId") == "mux-e"]
    # mux-e's prompt_result may already sit in the drained tail — don't wait for a second one
    e_stop = next((m for m in reversed(pre)
                   if m["frame"].get("type") == "prompt_result"), None)
    e_frames = pre
    if e_stop is None:
        more, e_stop = await rpc_collect(ws1, "mux-e", timeout=60)
        e_frames += more
    R.check(len(e_frames) >= 200 and e_stop["frame"].get("status") == "ok",
            "mux-e stream completed undisturbed", f"{len(e_frames)} frames")

    # ------------------------------------------------------------------
    # 3) exactly-once: subscribe since= while live, and reconnect mid-stream
    # ------------------------------------------------------------------
    # fresh burst on mux-a so 'since' overlaps live traffic
    await send(ws1, {"type": "rpc", "sessionId": "mux-a",
                     "frame": {"type": "prompt", "message": "replay race"}})
    # let a few live frames land, then subscribe from seq 1 on a second client
    await drain_until(ws1, lambda m: m.get("type") == "rpc" and m.get("sessionId") == "mux-a"
                      and m.get("seq", 0) >= 5, 15)
    ws2 = await connect()
    await send(ws2, {"type": "session.subscribe", "sessionId": "mux-a", "since": 1})
    pre_sub = []  # replay frames land BEFORE session.subscribed on the wire
    sub = await recv_type(ws2, "session.subscribed", 30, pre_sub)
    seen = set()
    dup = 0
    live_and_replay = 0
    for m in pre_sub:
        if m.get("type") == "rpc" and m.get("sessionId") == "mux-a":
            live_and_replay += 1
            seen.add(m["seq"])
    t0 = time.monotonic()
    while time.monotonic() - t0 < 60:
        m = await recv(ws2, 30)
        if m.get("type") != "rpc" or m.get("sessionId") != "mux-a":
            continue
        live_and_replay += 1
        if m["seq"] in seen:
            dup += 1
        seen.add(m["seq"])
        # only a LIVE prompt_result ends the turn — the ring replays earlier
        # prompts' prompt_results too, and stopping on those undercounts
        if m["frame"].get("type") == "prompt_result" and not m.get("replay"):
            break
    R.check(dup == 0, "since= mid-stream: zero duplicate seqs",
            f"{live_and_replay} frames seen, {dup} dupes")
    R.check(len(seen) > 200, "since= mid-stream: replay+live union complete",
            f"max seq {max(seen)}")
    await ws2.close()

    # reconnect mid-stream: ws3 reads live, drops, comes back with since=
    ws3 = await connect()
    await send(ws3, {"type": "session.subscribe", "sessionId": "mux-a", "since": 0})
    await recv_type(ws3, "session.subscribed", 60)
    await send(ws1, {"type": "rpc", "sessionId": "mux-a",
                     "frame": {"type": "prompt", "message": "reconnect test"}})
    last = 0
    async def read_some():
        nonlocal last
        t0 = time.monotonic()
        n = 0
        while time.monotonic() - t0 < 4:
            try:
                m = await recv(ws3, max(0.2, 4 - (time.monotonic() - t0)))
            except TimeoutError:
                break                      # stream quiet — window over
            if m.get("type") == "rpc" and m.get("sessionId") == "mux-a":
                last = max(last, m["seq"])
                n += 1
        return n
    await read_some()
    await ws3.close()                      # drop mid-stream
    ws3 = await connect()                  # resume on a NEW connection
    await send(ws3, {"type": "session.subscribe", "sessionId": "mux-a", "since": last})
    sub = await recv_type(ws3, "session.subscribed", 60)
    R.check(sub["replayedTo"] >= last or sub["liveSeq"] >= last,
            "reconnect resume: subscribed carries liveSeq",
            f"replayedTo={sub['replayedTo']} liveSeq={sub['liveSeq']}")
    # the earlier burst already settled — a NEW prompt gives us the live
    # prompt_result to close the loop on (resume = replay + live union)
    await send(ws1, {"type": "rpc", "sessionId": "mux-a",
                     "frame": {"type": "prompt", "message": "post-resume"}})
    seqs = set()
    dupes = 0
    t0 = time.monotonic()
    while time.monotonic() - t0 < 60:
        m = await recv(ws3, 30)
        if m.get("type") != "rpc" or m.get("sessionId") != "mux-a":
            continue
        if m["seq"] in seqs:
            dupes += 1
        seqs.add(m["seq"])
        if m["frame"].get("type") == "prompt_result" and m.get("replay") is not True:
            break
    R.check(dupes == 0 and all(s > last for s in seqs),
            "reconnect resume: strictly > lastSeq, no dupes",
            f"{len(seqs)} frames after seq {last}")
    await ws3.close()

    # ------------------------------------------------------------------
    # 4) giant backlog: overflow the 4096-entry ring, replay stays honest
    # ------------------------------------------------------------------
    # ~25 prompts × 201 frames ≈ 5000 > RING_MAX_ENTRIES — oldest must evict,
    # a since=0 replay returns a contiguous suffix, no gaps, no fabrications.
    await session_new(ws1, "mux-big", ompBin=FAKE)
    for i in range(26):
        await send(ws1, {"type": "rpc", "sessionId": "mux-big",
                         "frame": {"type": "prompt", "message": f"big {i}"}})
    last_seq = 0
    n_results = 0
    t0 = time.monotonic()
    while n_results < 26 and time.monotonic() - t0 < 120:
        m = await recv(ws1, 60)
        if m.get("type") == "rpc" and m.get("sessionId") == "mux-big":
            last_seq = m["seq"]
            if m["frame"].get("type") == "prompt_result":
                n_results += 1
    R.check(last_seq > 4096, "backlog overflowed the ring",
            f"lastSeq={last_seq}")
    ws4 = await connect()
    await send(ws4, {"type": "session.subscribe", "sessionId": "mux-big", "since": 0})
    pre_sub = []  # replay frames land before session.subscribed on the wire
    sub = await recv_type(ws4, "session.subscribed", 60, pre_sub)
    got = [m["seq"] for m in pre_sub
           if m.get("type") == "rpc" and m.get("sessionId") == "mux-big" and m.get("replay")]
    want = min(4096, last_seq)
    t0 = time.monotonic()
    while len(got) < want and time.monotonic() - t0 < 60:
        try:
            m = await recv(ws4, 30)
        except TimeoutError:
            break  # stream quiet — replay over, bursts already ended
        if m.get("type") == "rpc" and m.get("sessionId") == "mux-big" and m.get("replay"):
            got.append(m["seq"])
        elif m.get("type") == "rpc" and m.get("sessionId") == "mux-big":
            break  # first live frame = replay finished
    R.check(len(got) == want, "ring replay bounded",
            f"{len(got)} replayed of {last_seq}")
    R.check(got == sorted(got) and got == list(range(got[0], got[0] + len(got))),
            "ring replay contiguous (no gaps)",
            f"seqs {got[0]}..{got[-1]}" if got else "none")
    R.check(got[0] > 1, "oldest seqs evicted honestly", f"first={got[0]}")
    await ws4.close()

    print(f"  (suite ran {time.monotonic() - t_start:.1f}s)")
    return R.done()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
