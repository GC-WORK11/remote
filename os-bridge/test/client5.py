#!/usr/bin/env python3
"""client5 — v0.8 feature tests (stdlib only).

Part A: rig.fs native ops — correctness and latency budgets.
  read  (small file)   daemon tookUs < 2000 µs
  write (atomic + append + base64 + mkdirs round-trips)
  glob  (recursive patterns)
  grep  1000-file corpus, tookUs < 50000 µs (50 ms)

Part B: 3-session fan-in — parallel fake-omp streams must not bleed
across sessions and must not starve: each session gets its full burst.

Usage: client5.py [ip] [port] [--omp <fake-omp path>] [--burst N]
"""
import base64
import json
import os
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from client import Ws, wait_for, TestFailure  # noqa: E402

RIG_HOME = Path.home() / ".rig"
CORPUS = Path("/tmp/rig-fs-corpus")
N_FILES = 1000
BURST = 200

PASS = []
FAIL = []


def check(name: str, ok: bool, detail: str = ""):
    (PASS if ok else FAIL).append(name)
    print(f"    {'ok  ' if ok else 'FAIL'} {name}{'  — ' + detail if detail else ''}")


def pair(ip: str, port: int) -> str:
    RIG_HOME.mkdir(exist_ok=True)
    code = f"{secrets.randbelow(1000000):06d}"
    (RIG_HOME / "pending.json").write_text(json.dumps({"code": code, "expires": int(time.time()) + 300}))
    ws = Ws(ip, port)
    ws.send({"type": "pair", "code": code, "device": "client5"})
    token = wait_for(ws, "paired")["token"]
    ws.sock.close()
    return token


def fs_call(ws: Ws, op: str, params: dict, timeout: float = 15.0) -> tuple[dict, float]:
    """Send rig.fs.<op>, wait for its rig.fs.result (matched by id). Returns (frame, rtt_ms)."""
    rid = f"c5-{secrets.token_hex(4)}"
    t0 = time.perf_counter()
    ws.send({"type": f"rig.fs.{op}", "id": rid, **params})
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = ws.recv(timeout=max(0.5, deadline - time.time()))
        if m is None:
            raise ConnectionError("closed during rig.fs")
        if m.get("type") == "error":
            raise TestFailure(f"rig.fs.{op} → error: {m.get('error')}")
        if m.get("type") == "rig.fs.result" and m.get("id") == rid:
            return m, (time.perf_counter() - t0) * 1000
    raise TimeoutError(f"no rig.fs.result for {op}")


def build_corpus():
    CORPUS.mkdir(parents=True, exist_ok=True)
    for i in range(N_FILES):
        body = "".join(f"line {j} of file {i}\n" for j in range(20))
        if i % 7 == 0:
            body += f"MARKER_LINE_{i} needle\n"
        (CORPUS / f"file_{i:04d}.txt").write_text(body)
    nested = CORPUS / "sub"
    nested.mkdir(exist_ok=True)
    for i in range(5):
        (nested / f"deep_{i}.txt").write_text(f"MARKER_LINE_deep_{i} needle\n")
    (CORPUS / "binary.bin").write_bytes(bytes(range(256)) * 4)
    expected_markers = len(range(0, N_FILES, 7)) + 5
    return expected_markers


def part_fs(ws: Ws):
    print("[A] rig.fs")
    expected_markers = build_corpus()
    plain_file = CORPUS / "file_0001.txt"

    # --- read ---
    content = plain_file.read_text()
    m, rtt = fs_call(ws, "read", {"path": str(plain_file)})
    check("read: ok+content", m.get("ok") and m.get("content") == content)
    check("read: size+mtime", m.get("size") == len(content.encode()) and m.get("mtimeMs", 0) > 0)
    us = m.get("tookUs", -1)
    check("read: <2ms daemon", 0 <= us < 2000, f"tookUs={us} rtt={rtt:.2f}ms")

    # cwd-relative resolution
    m, _ = fs_call(ws, "read", {"path": "file_0002.txt", "cwd": str(CORPUS)})
    check("read: cwd-relative", m.get("ok") and "file 2" in m.get("content", ""))

    # offset + maxBytes truncation
    m, _ = fs_call(ws, "read", {"path": str(plain_file), "offset": 5, "maxBytes": 20})
    check("read: offset+maxBytes", m.get("ok") and m.get("content") == content[5:25])
    check("read: truncated flag", m.get("truncated") is True and m.get("offset") == 5)

    # binary → base64 channel
    m, _ = fs_call(ws, "read", {"path": str(CORPUS / "binary.bin")})
    raw = base64.b64decode(m.get("contentBase64", ""))
    check("read: binary→base64", m.get("ok") and "content" not in m and raw == (CORPUS / "binary.bin").read_bytes())

    # missing file → clean error, not a crash
    rid = "c5-missing"
    ws.send({"type": "rig.fs.read", "id": rid, "path": str(CORPUS / "nope.txt")})
    m = wait_for(ws, "rig.fs.result")
    check("read: missing file", m.get("ok") is False and bool(m.get("error")))

    # --- write ---
    target = CORPUS / "sub" / "wrote" / "new.txt"  # mkdirs path
    m, _ = fs_call(ws, "write", {"path": str(target), "content": "hello rig.fs\n"})
    check("write: ok+bytes", m.get("ok") and m.get("bytes") == 13)
    check("write: mkdirs", target.read_text() == "hello rig.fs\n")
    check("write: atomic (no .tmp)", not list((CORPUS / "sub" / "wrote").glob("*.tmp")))

    m, _ = fs_call(ws, "write", {"path": str(target), "content": "again\n", "append": True})
    check("write: append", m.get("ok") and target.read_text() == "hello rig.fs\nagain\n")

    payload = bytes(range(256))
    m, _ = fs_call(ws, "write", {"path": str(CORPUS / "b64.bin"), "contentBase64": base64.b64encode(payload).decode()})
    check("write: base64", m.get("ok") and (CORPUS / "b64.bin").read_bytes() == payload)

    # --- glob ---
    m, _ = fs_call(ws, "glob", {"pattern": "*.txt", "cwd": str(CORPUS)})
    check("glob: top-level *.txt", m.get("ok") and m.get("count") == N_FILES, f"count={m.get('count')}")

    m, _ = fs_call(ws, "glob", {"pattern": "**/*.txt", "cwd": str(CORPUS)})
    check("glob: recursive **/*.txt", m.get("ok") and m.get("count") == N_FILES + 5 + 1,
          f"count={m.get('count')} (want {N_FILES + 6})")

    m, _ = fs_call(ws, "glob", {"pattern": "sub/deep_?.txt", "cwd": str(CORPUS)})
    check("glob: ? wildcard", m.get("ok") and m.get("count") == 5, f"count={m.get('count')}")

    m, _ = fs_call(ws, "glob", {"pattern": "**/{deep_0,deep_1}.txt", "cwd": str(CORPUS)})
    check("glob: {a,b} alternation", m.get("ok") and m.get("count") == 2, f"count={m.get('count')}")

    # --- grep ---
    m, rtt = fs_call(ws, "grep", {"pattern": "MARKER_LINE", "cwd": str(CORPUS)}, timeout=30)
    us = m.get("tookUs", -1)
    check("grep: literal markers", m.get("ok") and m.get("count") == expected_markers,
          f"count={m.get('count')} want={expected_markers}")
    check("grep: <50ms on 1000 files", 0 <= us < 50000, f"tookUs={us} rtt={rtt:.2f}ms scanned={m.get('scannedFiles')}")

    m, _ = fs_call(ws, "grep", {"pattern": r"deep_\d", "cwd": str(CORPUS), "regex": True})
    check("grep: regex mode", m.get("ok") and m.get("count") == 5, f"count={m.get('count')}")

    m, _ = fs_call(ws, "grep", {"pattern": "marker_line", "cwd": str(CORPUS), "caseInsensitive": True})
    check("grep: caseInsensitive", m.get("ok") and m.get("count") == expected_markers,
          f"count={m.get('count')}")

    m, _ = fs_call(ws, "grep", {"pattern": "MARKER_LINE_deep", "cwd": str(CORPUS), "context": 1})
    hit = next((x for x in m.get("matches", []) if x.get("path", "").endswith("deep_0.txt")), {})
    check("grep: context lines", m.get("ok") and len(hit.get("context", [])) == 1)

    m, _ = fs_call(ws, "grep", {"pattern": "MARKER_LINE", "cwd": str(CORPUS), "glob": "deep_*.txt"})
    check("grep: glob filter", m.get("ok") and m.get("count") == 5, f"count={m.get('count')}")

    m, _ = fs_call(ws, "grep", {"pattern": "needle", "cwd": str(CORPUS), "maxResults": 3})
    check("grep: maxResults cap", m.get("ok") and m.get("count") == 3)


def part_fanin(ws: Ws, omp_bin: str):
    print("[B] 3-session fan-in (no bleed, no starvation)")
    sids = [f"c5-{ch}{secrets.token_hex(3)}" for ch in "abc"]
    spawned = []
    for sid in sids:
        t0 = time.perf_counter()
        ws.send({"type": "session.new", "sessionId": sid, "cwd": "/tmp", "ompBin": omp_bin})
        m = wait_for(ws, "session.started", timeout=30)
        warm = m.get("warm", False)
        spawned.append((sid, time.perf_counter() - t0, warm))
        print(f"    session {sid}: started in {spawned[-1][1]*1000:.0f}ms{' (warm)' if warm else ''}")

    for sid in sids:
        ws.send({"type": "rpc", "sessionId": sid, "frame": {"type": "prompt", "id": f"p-{sid}", "message": "flood"}})

    got = {sid: [] for sid in sids}
    foreign = 0
    done = set()
    deadline = time.time() + 60
    first_seen = {}
    while time.time() < deadline and len(done) < len(sids):
        try:
            m = ws.recv(timeout=max(0.5, deadline - time.time()))
        except TimeoutError:
            continue
        if m is None:
            break
        if m.get("type") != "rpc":
            continue
        sid = m.get("sessionId")
        f = m.get("frame", {})
        if sid not in got:
            foreign += 1
            continue
        got[sid].append(f)
        if sid not in first_seen:
            first_seen[sid] = time.perf_counter()
        if f.get("type") == "prompt_result":
            done.add(sid)

    for sid in sids:
        deltas = [f for f in got[sid] if f.get("type") == "message_delta"]
        seqs = [f.get("seq") for f in deltas]
        check(f"fan-in {sid}: full burst", len(deltas) == BURST, f"got {len(deltas)}/{BURST}")
        check(f"fan-in {sid}: seq contiguous", seqs == list(range(1, BURST + 1)))
        check(f"fan-in {sid}: settled", sid in done)
    check("fan-in: zero foreign frames", foreign == 0, f"foreign={foreign}")
    # fairness: every session saw its first frame before any session fully drained
    spread = (max(first_seen.values()) - min(first_seen.values())) * 1000 if len(first_seen) == 3 else -1
    check("fan-in: all sessions streaming", len(first_seen) == 3, f"first-frame spread {spread:.0f}ms")

    # ring replay: subscribe since=0 must reproduce one session's stream
    # exactly — count every replayed rpc frame and its sessionId
    ws.send({"type": "session.subscribe", "sessionId": sids[0], "since": 0})
    replay = []
    replay_foreign = 0
    deadline = time.time() + 15
    while time.time() < deadline:
        m = ws.recv(timeout=max(0.5, deadline - time.time()))
        if m is None:
            break
        if m.get("type") == "session.subscribed":
            break
        if m.get("type") == "rpc" and m.get("replay"):
            if m.get("sessionId") == sids[0]:
                replay.append(m.get("frame", {}))
            else:
                replay_foreign += 1
    replay_deltas = [f for f in replay if f.get("type") == "message_delta"]
    check("replay: exact burst", len(replay_deltas) == BURST, f"got {len(replay_deltas)}")
    check("replay: no foreign frames in ring", replay_foreign == 0, f"foreign={replay_foreign}")

    for sid in sids:
        ws.send({"type": "session.kill", "sessionId": sid})
    time.sleep(0.5)


def main():
    ip = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
    omp_bin = str(Path(__file__).parent / "fake-omp.sh")
    if "--omp" in sys.argv:
        omp_bin = sys.argv[sys.argv.index("--omp") + 1]

    token = pair(ip, port)
    ws = Ws(ip, port, token=token)
    ws.send({"type": "rig.status"})
    m = wait_for(ws, "rig.status")
    print(f"[0] connected: {m.get('hostname')} v-sessions={len(m.get('sessions', []))}")

    part_fs(ws)
    part_fanin(ws, omp_bin)

    ws.send({"type": "rig.stats"})
    m = wait_for(ws, "rig.stats")
    print(f"[stats] in={m.get('framesIn')} out={m.get('framesOut')} "
          f"lines={m.get('linesIn')} parsed={m.get('linesParsed')} "
          f"bridgeUs={m.get('latencyBridgeUs')} queueMs={m.get('latencyQueueMs')} "
          f"warm={m.get('warmSpares')}/{m.get('warmCap')}")

    print(f"\n=== client5: {len(PASS)} passed, {len(FAIL)} failed ===")
    if FAIL:
        print("FAILED: " + ", ".join(FAIL))
        sys.exit(1)


if __name__ == "__main__":
    main()
