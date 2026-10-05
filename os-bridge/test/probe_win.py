# omprd Windows-backend verification probe.
# Exercises pair → computer.state/screenshot/windows and reports latencies.
import asyncio, base64, json, sys, time

import websockets

URL = "ws://127.0.0.1:8790/ws"
CODE = "424242"


async def call(ws, req, expect_type, timeout=30):
    t0 = time.perf_counter()
    await ws.send(json.dumps(req))
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout)
        m = json.loads(raw)
        if m.get("type") == expect_type or m.get("type") == "error":
            ms = (time.perf_counter() - t0) * 1000
            return m, ms


async def main():
    async with websockets.connect(URL, max_size=None) as ws:
        results = []

        m, ms = await call(ws, {"type": "pair", "code": CODE, "device": "probe"}, "paired")
        assert m.get("type") == "paired" and m.get("token"), f"pair failed: {m}"
        token = m["token"]
        results.append(("pair", ms, "ok"))

        m, ms = await call(ws, {"type": "computer.state"}, "computer.state")
        assert m.get("type") == "computer.state", f"computer.state failed: {m}"
        print(f"  state: backend={m.get('backend')} native={m.get('nativeBackend')} "
              f"shm={m.get('shm')} xtest={m.get('xtest')} res={m.get('resolution')}")
        assert m.get("backend") == "win32" and m.get("nativeBackend") is True, m
        results.append(("computer.state", ms, "ok"))

        m, ms = await call(ws, {"type": "computer.screenshot", "format": "png"}, "computer.screenshot", 60)
        assert m.get("type") == "computer.screenshot", f"screenshot failed: {m}"
        b64 = m.get("imageBase64", "")
        assert len(b64) > 1000, "imageBase64 empty/tiny"
        img = base64.b64decode(b64)
        assert img[:8] == b"\x89PNG\r\n\x1a\n", f"bad PNG magic: {img[:8]!r}"
        results.append(("computer.screenshot(png %dx%d, %dB)" % (m["width"], m["height"], len(img)), ms, f"tookMs={m.get('tookMs')}"))

        m, ms = await call(ws, {"type": "computer.screenshot"}, "computer.screenshot", 60)
        assert m.get("type") == "computer.screenshot", f"screenshot jpg failed: {m}"
        img = base64.b64decode(m["imageBase64"])
        assert img[:3] == b"\xff\xd8\xff", f"bad JPEG magic: {img[:3]!r}"
        results.append(("computer.screenshot(jpg %dx%d, %dB)" % (m["width"], m["height"], len(img)), ms, f"tookMs={m.get('tookMs')}"))

        m, ms = await call(ws, {"type": "computer.windows"}, "computer.windows")
        wins = m.get("windows", [])
        assert m.get("type") == "computer.windows" and wins, f"windows empty: {m}"
        results.append(("computer.windows", ms, f"{len(wins)} windows"))
        for w in wins[:8]:
            print(f"  win: id={w['id']} active={w['active']} {w['w']}x{w['h']} @({w['x']},{w['y']}) {w['title'][:60]!r}")

        # input path: cursor query (native query_pointer)
        m, ms = await call(ws, {"type": "computer.cursor"}, "computer.cursor")
        results.append(("computer.cursor", ms, str({k: m.get(k) for k in ("x", "y", "method")})))

        m, ms = await call(ws, {"type": "rig.stats"}, "rig.stats")
        results.append(("rig.stats", ms, "ok"))

        print("\n=== latencies (client round-trip) ===")
        for name, ms, note in results:
            print(f"  {name:44s} {ms:8.1f} ms  {note}")
        print("\nALL CHECKS PASSED")


asyncio.run(main())
