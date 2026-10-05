# omprd Windows-lane v04 verification probe.
# pair → rig.status/models → computer.* → real-omp session → fake-omp turn
# → rig.term.open honest fallback → rig.exec → rig.stayAwake lid re-query.
import asyncio, base64, json, os, sys, time

import websockets

URL = "ws://127.0.0.1:8790/ws"
CODE = "424242"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAKE_OMP = os.path.join(REPO, "test", "fake-omp.cmd")
REAL_OMP = r"C:\hostedtoolcache\node\20.19.0\x64\omp.cmd"


async def call(ws, req, expect, timeout=60, pred=None):
    t0 = time.perf_counter()
    await ws.send(json.dumps(req))
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout)
        m = json.loads(raw)
        ok = m.get("type") == expect if isinstance(expect, str) else m.get("type") in expect
        if pred and not pred(m):
            ok = False
        if ok or m.get("type") == "error":
            return m, (time.perf_counter() - t0) * 1000


async def main():
    lat = []
    async with websockets.connect(URL, max_size=None) as ws:
        m, ms = await call(ws, {"type": "pair", "code": CODE, "device": "win-probe"}, "paired")
        assert m.get("type") == "paired" and m.get("token"), f"pair failed: {m}"
        lat.append(("pair", ms, "token minted"))

        m, ms = await call(ws, {"type": "rig.status"}, "rig.status")
        print(f"  rig.status: {json.dumps({k: m.get(k) for k in ('version','backend','sessions','devices','uptime')})}")
        lat.append(("rig.status", ms, m.get("version")))

        m, ms = await call(ws, {"type": "rig.models"}, "rig.models")
        provs = m.get("providers", [])
        assert provs, f"rig.models empty: {m}"
        assert not any("apiKey" in p for p in provs), "apiKey leaked in rig.models reply!"
        specs = [md.get("id") for p in provs for md in p.get("models", [])]
        print(f"  rig.models: providers={[p.get('id') for p in provs]} models={specs} default={m.get('defaultModel')}")
        lat.append(("rig.models", ms, f"{len(provs)} providers"))

        m, ms = await call(ws, {"type": "computer.state"}, "computer.state")
        print(f"  state: backend={m.get('backend')} native={m.get('nativeBackend')} res={m.get('resolution')}")
        assert m.get("backend") == "win32" and m.get("nativeBackend") is True, m
        lat.append(("computer.state", ms, "win32"))

        m, ms = await call(ws, {"type": "computer.screenshot"}, "computer.screenshot", 60)
        img = base64.b64decode(m["imageBase64"])
        assert img[:3] == b"\xff\xd8\xff" and len(img) > 5000, "bad/empty JPEG"
        # real pixels: decode a few bytes past the header + confirm non-uniform data
        assert len(set(img[1000:2000])) > 8, "screenshot looks blank/uniform"
        shot_path = os.path.join(REPO, "test", "shot_win_verify.jpg")
        with open(shot_path, "wb") as f:
            f.write(img)
        lat.append((f"computer.screenshot(jpg {m['width']}x{m['height']}, {len(img)}B)", ms,
                    f"captureMs={m.get('captureMs')} encodeMs={m.get('encodeMs')}"))

        m, ms = await call(ws, {"type": "computer.windows"}, "computer.windows")
        wins = m.get("windows", [])
        assert wins, "computer.windows empty"
        lat.append(("computer.windows", ms, f"{len(wins)} windows"))

        # --- real omp session (handshake for real; provider is a stub) ---
        m, ms = await call(ws, {"type": "session.new", "cwd": os.environ["USERPROFILE"]}, "session.started", 90)
        assert m.get("type") == "session.started", f"session.new failed: {m}"
        real_sid = m["sessionId"]
        lat.append(("session.new (real omp handshake)", ms, f"pid={m.get('pid')}"))

        # --- fake-omp session: scripted full turn ---
        m, ms = await call(ws, {"type": "session.new", "cwd": os.environ["USERPROFILE"],
                                "ompBin": FAKE_OMP}, "session.started", 90)
        assert m.get("type") == "session.started", f"fake session.new failed: {m}"
        fake_sid = m["sessionId"]
        lat.append(("session.new (fake-omp)", ms, f"pid={m.get('pid')}"))

        # a real turn: rpc prompt → message_delta frames → prompt_result
        t0 = time.perf_counter()
        await ws.send(json.dumps({"type": "rpc", "sessionId": fake_sid,
                                  "frame": {"type": "prompt", "text": "say hello"}}))
        deltas, saw_result = 0, None
        while True:
            raw = await asyncio.wait_for(ws.recv(), 60)
            m = json.loads(raw)
            if m.get("type") != "rpc" or m.get("sessionId") != fake_sid:
                continue
            fr = m["frame"]
            if fr.get("type") == "message_delta":
                deltas += 1
            elif fr.get("type") == "prompt_result":
                saw_result = fr
                break
        turn_ms = (time.perf_counter() - t0) * 1000
        assert deltas > 0 and saw_result, f"no turn frames (deltas={deltas}, result={saw_result})"
        assert saw_result.get("usage", {}).get("input_tokens"), "prompt_result lacks usage"
        lat.append(("rpc prompt turn", turn_ms, f"{deltas} deltas -> prompt_result ok"))

        # --- honest fallbacks ---
        m, ms = await call(ws, {"type": "rig.term.open", "cols": 80, "rows": 24},
                           ["term.opened", "error"])
        assert m.get("type") == "error", f"term.open should honestly fail on Windows: {m}"
        print(f"  rig.term.open -> {m.get('error')}  (honest fallback ok)")
        lat.append(("rig.term.open", ms, "honest error (ConPTY pending)"))

        m, ms = await call(ws, {"type": "rig.exec", "command": "echo remote-win"},
                           "exec.done", 30)
        assert m.get("type") == "exec.done" and m.get("code") == 0, f"rig.exec failed: {m}"
        lat.append(("rig.exec", ms, f"code={m.get('code')}"))

        # --- keep-awake: set → the daemon itself re-queries powercfg ---
        m, ms = await call(ws, {"type": "rig.stayAwake", "on": True, "persistent": True},
                           "rig.stayAwake", 30)
        lid = m.get("lidClose", {})
        print(f"  stayAwake on: held={m.get('held')} persistent={m.get('persistent')} lidClose={json.dumps(lid)}")
        assert m.get("held") is True, m
        assert "attempted" in lid or "method" in lid, f"lidClose block missing: {lid}"
        lat.append(("rig.stayAwake on", ms, f"lid.method={lid.get('method')}"))

        m, ms = await call(ws, {"type": "rig.stayAwake", "on": False}, "rig.stayAwake", 30)
        lid2 = m.get("lidClose", {})
        print(f"  stayAwake off: held={m.get('held')} lidClose={json.dumps(lid2)}")
        lat.append(("rig.stayAwake off", ms, f"restored={lid2.get('restored')}"))

        # --- rig.fs native op ---
        m, ms = await call(ws, {"type": "rig.fs.list", "path": os.environ["USERPROFILE"]},
                           "rig.fs.result", 30)
        entries = m.get("entries", [])
        assert m.get("ok") and entries, f"rig.fs.list failed: {m}"
        lat.append(("rig.fs.list", ms, f"{len(entries)} entries"))

        # --- teardown ---
        for sid, name in ((fake_sid, "fake"), (real_sid, "real")):
            m, ms = await call(ws, {"type": "session.kill", "sessionId": sid}, "ok")
            lat.append((f"session.kill ({name})", ms, "ok"))

        m, ms = await call(ws, {"type": "rig.stats"}, "rig.stats")
        lat.append(("rig.stats", ms, "ok"))

        print("\n=== latencies (client round-trip) ===")
        for name, ms, note in lat:
            print(f"  {name:44s} {ms:9.1f} ms  {note}")
        print("\nALL CHECKS PASSED")


asyncio.run(main())
