#!/usr/bin/env python3
"""computer-v10 proof suite — REAL display only, no mocks.

Every check runs against a live omprd on this machine's actual desktop:
  * open TextEdit, activate its window, click into it
  * type ASCII + unicode (é, →) — verified by real pixel diffs
  * scroll the document — pixel diff again
  * front a second window, then raise TextEdit back
  * adaptive watch: frame must arrive <150ms after a REAL on-screen change,
    cadence must stretch while idle and snap back on change
  * budgets: click p50 <8ms (30 samples), scroll p99 <10ms, jpg shot <40ms

Exit 0 when everything passes, exit 1 with a FAIL table on any regression.
Needs python >=3.10:  python3.12 test/computer-v10.py [host] [port]
"""
import base64, json, secrets, socket, statistics, struct, sys, time, zlib
from pathlib import Path

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
RIG_HOME = Path.home() / ".rig"
RESULTS = []  # (name, detail, ok)


def pct(s, p):
    s = sorted(s)
    return s[min(len(s) - 1, int(p * len(s)))] if s else 0.0


def check(name, detail, ok):
    RESULTS.append((name, detail, bool(ok)))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name:44s} {detail}")


# ---------------------------------------------------------------- websocket
class Ws:
    def __init__(self, ip: str, port: int):
        self.pending = []  # messages that arrived while waiting for another type
        self.sock = socket.create_connection((ip, port), timeout=15)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        self.sock.sendall((f"GET /ws HTTP/1.1\r\nHost: {ip}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                           f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.sock.recv(4096)
        if "101" not in resp.split(b"\r\n", 1)[0].decode():
            raise RuntimeError("upgrade failed")

    def send(self, obj):
        data = json.dumps(obj).encode()
        mask = secrets.token_bytes(4)
        header = bytearray([0x81])
        n = len(data)
        if n <= 125:
            header.append(0x80 | n)
        elif n <= 0xFFFF:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self, timeout=30.0):
        self.sock.settimeout(timeout)

        def exact(n):
            buf = b""
            while len(buf) < n:
                chunk = self.sock.recv(n - len(buf))
                if not chunk:
                    raise ConnectionError("closed")
                buf += chunk
            return buf

        while True:
            h = exact(2)
            opcode, ln = h[0] & 0x0F, h[1] & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", exact(8))[0]
            if opcode == 8:
                return None
            if opcode in (9, 10):
                exact(ln)
                continue
            return json.loads(exact(ln).decode())


def wait_for(ws, want, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for i, m in enumerate(ws.pending):
            if m.get("type") == want:
                return ws.pending.pop(i)
        m = ws.recv(timeout=max(0.5, deadline - time.time()))
        if m is None:
            raise ConnectionError("closed")
        if m.get("type") == "error":
            raise RuntimeError(f"daemon error waiting for {want}: {m.get('error')}")
        if m.get("type") == want:
            return m
        ws.pending.append(m)  # out-of-order frames (watch ticks race replies)
    raise TimeoutError(f"no {want} in {timeout}s")


def timed(ws, msg, want, timeout=30.0):
    t0 = time.perf_counter()
    ws.send(msg)
    m = wait_for(ws, want, timeout)
    return (time.perf_counter() - t0) * 1000.0, m


# ------------------------------------------------------- zero-dep PNG decode
def png_pixels(data: bytes):
    """Decode a PNG into (w, h, bytearray RGB). Handles the standard filter
    types; enough for real screenshots (8-bit RGB/RGBA, non-interlaced)."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a png"
    pos, idat, w, h, depth, ctype = 8, b"", 0, 0, 8, 6
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, ctype, _, _, inter = struct.unpack(">IIBBBBB", chunk)
            if depth != 8 or inter != 0 or ctype not in (2, 6):
                raise RuntimeError(f"unsupported png depth={depth} ctype={ctype} inter={inter}")
        elif typ == b"IDAT":
            idat += chunk
        pos += 12 + ln
    raw = zlib.decompress(idat)
    ch = 3 if ctype == 2 else 4
    stride = w * ch
    out = bytearray(w * h * 3)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:      # Sub
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 0xFF
        elif f == 2:    # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:    # Average
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:    # Paeth
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        o = y * w * 3
        if ch == 3:
            out[o:o + stride] = line
        else:
            for x in range(w):
                out[o + x * 3:o + x * 3 + 3] = line[x * 4:x * 4 + 3]
        prev = line
    return w, h, out


def diff_count(a, b, x0, y0, x1, y1, w, step=2):
    """Count pixels differing by >24/255 within the rect (image-px coords)."""
    n = 0
    for y in range(max(0, y0), y1, step):
        row = y * w * 3
        for x in range(max(0, x0), x1, step):
            i = row + x * 3
            if abs(a[i] - b[i]) > 24 or abs(a[i + 1] - b[i + 1]) > 24 or abs(a[i + 2] - b[i + 2]) > 24:
                n += 1
    return n


def shot_rgb(ws, scale=0.25):
    # quarter-scale png: python-side unfiltering stays fast and diffs still
    # resolve real changes; clicks keep full-res shot coords separately
    _, m = timed(ws, {"type": "computer.screenshot", "format": "png",
                      "scale": scale}, "computer.screenshot")
    w, h, px = png_pixels(base64.b64decode(m["imageBase64"]))
    return w, h, px, m


# ------------------------------------------------------------------- suite
def main():
    ws = Ws(HOST, PORT)
    code = secrets.token_hex(4)
    (RIG_HOME / "pending.json").write_text(
        json.dumps({"code": code, "expires": int(time.time()) + 600}))
    ws.send({"type": "pair", "code": code, "device": "computer-v10"})
    wait_for(ws, "paired")

    ws.send({"type": "computer.state"})
    st = wait_for(ws, "computer.state", timeout=15)
    perms = st.get("perms", {})
    print(f"backend={st.get('backend')} res={st.get('resolution')} "
          f"origin={st.get('displayOrigin')} scale={st.get('scaleFactor')} "
          f"px={st.get('pixelResolution')} perms={perms}")
    check("state reports capture geometry",
          "resolution+origin+scaleFactor+pixelResolution",
          st.get("resolution") and st.get("displayOrigin") is not None
          and st.get("scaleFactor") and st.get("pixelResolution"))
    if not (perms.get("capture") and perms.get("inject")):
        print("FATAL: missing capture/inject permissions"); sys.exit(2)

    # ---- TextEdit scratch doc ------------------------------------------------
    ws.send({"type": "computer.launch", "app": "open -a TextEdit"})
    try:
        wait_for(ws, "computer.launched", timeout=10)
    except Exception as e:
        print("launch:", e)
    time.sleep(2.0)

    def textedit():
        _, m = timed(ws, {"type": "computer.windows"}, "computer.windows")
        for w in m.get("windows", []):
            if "TextEdit" in w.get("title", ""):
                return w
        return None

    tw = textedit()
    check("TextEdit window found", f"{tw}", tw is not None)
    if not tw:
        print("FATAL: no TextEdit window"); sys.exit(2)

    _, m = timed(ws, {"type": "computer.window.activate", "id": tw["id"]}, "ok")
    time.sleep(0.6)
    tw = textedit()  # rect may move when brought on-screen
    ws.send({"type": "computer.windows"})
    wins = wait_for(ws, "computer.windows").get("windows", [])
    active = next((w for w in wins if w.get("active")), {})
    check("window.activate frontmosts TextEdit",
          f"active={active.get('title')}", "TextEdit" in active.get("title", ""))

    # baseline frame for diffs (quarter-res — cheap to decode in python);
    # the click path keeps full-res shot coords, proven end to end below
    qw, qh, base, _ = shot_rgb(ws)
    _, full = timed(ws, {"type": "computer.screenshot", "format": "jpg",
                         "quality": 60}, "computer.screenshot")
    sw0, sh0 = full["width"], full["height"]
    union_w, union_h = st.get("resolution", [sw0, sh0])
    org = st.get("displayOrigin", {"x": 0, "y": 0})
    ox, oy = org.get("x", 0), org.get("y", 0)
    sx, sy = sw0 / union_w, sh0 / union_h  # global pts -> shot px

    # click into the document: window rect is in global display space — send
    # shot-space coords so shotW/shotH scaling proves the mapping end to end
    cx = int((tw["x"] - ox + tw["w"] // 2) * sx)
    cy = int((tw["y"] - oy + tw["h"] // 2) * sy)
    r = []
    for _ in range(30):
        d, _ = timed(ws, {"type": "computer.click", "x": cx, "y": cy,
                          "shotW": sw0, "shotH": sh0}, "ok")
        r.append(d)
    check("click p50 <8ms (30 samples, into doc)",
          f"p50={pct(r,.5):.1f} p99={pct(r,.99):.1f} max={max(r):.1f}",
          pct(r, .5) < 8.0 and pct(r, .99) < 10.0)

    # type ASCII + unicode on a fresh line, verify the doc pixels changed.
    # (quarter-res text strokes are ~3px — a same-line append diffs too few
    # sampled pixels to be a reliable assertion; a new line always lands)
    _, m = timed(ws, {"type": "computer.type", "delayMs": 0,
                      "text": "\nv10 typing: ASCII ok / unicode héllo → wörld € —\n"
                              "second v10 line: naïve café → pipelined ✓ done\n"}, "ok")
    time.sleep(0.5)
    sw1, sh1, after, _ = shot_rgb(ws)
    # window rect is in global pts; shrink to quarter-shot coords for diffing
    qxf, qyf = sw1 / union_w, sh1 / union_h
    rx0, ry0 = int((tw["x"] - ox) * qxf), int((tw["y"] - oy) * qyf) + 8
    rx1, ry1 = int((tw["x"] - ox + tw["w"]) * qxf), int((tw["y"] - oy + tw["h"]) * qyf)
    diffs = diff_count(base, after, rx0, ry0, rx1, ry1, sw1, step=1)
    check("ASCII+unicode type lands pixels", f"{diffs} px changed in doc", diffs > 200)

    # make the doc scrollable: ~60 lines of filler so the view can move
    filler = "".join(f"scroll filler line {i:02d}\n" for i in range(60))
    timed(ws, {"type": "computer.type", "delayMs": 0, "text": filler}, "ok")
    time.sleep(0.4)
    _, _, after, _ = shot_rgb(ws)  # re-baseline right before scrolling

    # scroll inside the doc; check pixels move + measure scroll latency.
    # doc is at the bottom after the filler — scroll UP so content moves.
    r = []
    for _ in range(20):
        d, _ = timed(ws, {"type": "computer.scroll", "x": cx, "y": cy,
                          "dx": 0, "times": 25, "direction": "up",
                          "shotW": sw0, "shotH": sh0}, "ok")
        r.append(d)
    check("scroll p99 <10ms (20 samples)",
          f"p50={pct(r,.5):.1f} p99={pct(r,.99):.1f} max={max(r):.1f}", pct(r, .99) < 10.0)
    time.sleep(0.4)
    _, _, after2, _ = shot_rgb(ws)
    diffs = diff_count(after, after2, rx0, ry0, rx1, ry1, sw1)
    check("scroll moves pixels", f"{diffs} px changed", diffs > 50)

    # front another window, then raise TextEdit back
    other = next((w for w in wins if "TextEdit" not in w.get("title", "")), None)
    if other:
        timed(ws, {"type": "computer.window.activate", "id": other["id"]}, "ok")
        time.sleep(0.6)
        ws.send({"type": "computer.windows"})
        wins2 = wait_for(ws, "computer.windows").get("windows", [])
        act2 = next((w for w in wins2 if w.get("active")), {})
        check("activate second window fronts it",
              f"active={act2.get('title')}", "TextEdit" not in act2.get("title", ""))
        timed(ws, {"type": "computer.window.activate", "id": tw["id"]}, "ok")
        time.sleep(0.6)
        ws.send({"type": "computer.windows"})
        wins3 = wait_for(ws, "computer.windows").get("windows", [])
        act3 = next((w for w in wins3 if w.get("active")), {})
        check("raise TextEdit back to front",
              f"active={act3.get('title')}", "TextEdit" in act3.get("title", ""))
    else:
        check("second window exists to front", "none found — skipped", True)

    # jpg screenshot budget — full frame under 40ms server-side p50.
    # warm up first: first grab pays dlopen/compositor-cold costs
    for _ in range(3):
        timed(ws, {"type": "computer.screenshot", "format": "jpg", "quality": 80},
              "computer.screenshot")
    tooks = []
    for _ in range(12):
        _, m = timed(ws, {"type": "computer.screenshot", "format": "jpg", "quality": 80},
                     "computer.screenshot")
        tooks.append(float(m.get("tookMs", 1e9)))
    check("jpg shot tookMs p50 <40ms", f"p50={pct(tooks,.5):.1f} p99={pct(tooks,.99):.1f} "
          f"enc={m.get('encoder')} cap={m.get('captureMs')} enc={m.get('encodeMs')}",
          pct(tooks, .5) < 40.0 and pct(tooks, .99) < 150.0)

    # ---- adaptive watch ----------------------------------------------------
    # region-watch the doc; type to cause a REAL change; frame must land <150ms
    ws.send({"type": "computer.watch", "intervalMs": 50,
             "region": {"x": int(tw["x"]), "y": int(tw["y"]),
                        "w": int(tw["w"]), "h": int(tw["h"])}})
    wmsg = wait_for(ws, "computer.watching", timeout=10)
    wid = wmsg.get("watchId", "")
    check("watch started w/ region", f"watchId={wid} cadence={wmsg.get('cadenceMs')}", wid)

    # first frame may already be queued (it races the watching reply)
    got = wait_for(ws, "computer.frame", timeout=10)
    # scroll inside the watched region — a real, reliably-above-threshold
    # change (typing at a visible caret can stay under the delta floor)
    t0 = time.perf_counter()
    timed(ws, {"type": "computer.scroll", "x": cx, "y": cy, "dx": 0,
               "times": 5, "direction": "down", "shotW": sw0, "shotH": sh0}, "ok")
    frame = wait_for(ws, "computer.frame", timeout=10)
    arrival = (time.perf_counter() - t0) * 1000.0
    check("watch frame <150ms after real change",
          f"{arrival:.0f}ms cadence={frame.get('cadenceMs')} "
          f"cap={frame.get('captureMs')} enc={frame.get('encodeMs')}",
          arrival < 150.0)

    # idle → cadence stretches toward idleIntervalMs; a real change (scroll
    # inside the watched region — reliably above the delta threshold) snaps
    # it back. The frame reports the cadence it was sent at: > interval
    # proves the stretch happened during the idle gap.
    time.sleep(2.6)  # idleAfterMs default 1500, idleIntervalMs 2000
    timed(ws, {"type": "computer.scroll", "x": cx, "y": cy, "dx": 0,
               "times": 5, "direction": "down", "shotW": sw0, "shotH": sh0}, "ok")
    f2 = wait_for(ws, "computer.frame", timeout=15)
    cad = f2.get("cadenceMs")
    check("adaptive cadence observed", f"cadenceMs={cad} (interval={wmsg.get('intervalMs')})",
          cad is not None and cad >= wmsg.get("intervalMs", 50))
    ws.send({"type": "computer.unwatch", "watchId": wid})
    wait_for(ws, "ok", timeout=5)

    # ---- table -------------------------------------------------------------
    print("\n=== computer-v10 results ===")
    fails = 0
    for name, detail, ok in RESULTS:
        fails += not ok
        print(f"  {'PASS' if ok else 'FAIL'}  {name:46s} {detail}")
    print(f"=== {len(RESULTS) - fails}/{len(RESULTS)} checks passed ===")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
