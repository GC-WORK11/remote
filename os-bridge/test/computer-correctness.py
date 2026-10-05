#!/usr/bin/env python3
"""
computer-correctness.py — real-display correctness suite for omprd.

Runs against a live daemon on a real display (Xvfb :99 that omprd boots
itself, or the interactive desktop on Windows). No mocks: clicks are verified
with `xdotool getmouselocation` (Win32 GetCursorPos), typed input with `xev`
keysym capture (win-event-tester.py's WM_* log), and screen pixels with PIL
on decoded frames.

Usage:
    python3 computer-correctness.py [--bin ./daemon/omprd] [--port 8790]
                                    [--display :99] [--keep] [-v]

Exit code is the number of failed tests (0 = all green).
"""

import argparse
import base64
import io
import json
import os
import secrets
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time

try:
    from PIL import Image
except ImportError:
    print("PIL required (apt install python3-pil) — cannot pixel-verify without it")
    sys.exit(3)

IS_WIN = os.name == "nt"
HERE = os.path.dirname(os.path.abspath(__file__))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass  # Windows console is cp1252 — test names carry →, ≠, ×

if IS_WIN:
    import ctypes
    from ctypes import wintypes
    _u32 = ctypes.windll.user32
    _k32 = ctypes.windll.kernel32
    try:
        _u32.SetProcessDPIAware()
    except AttributeError:
        pass
    _SM_XVIRT, _SM_YVIRT = 76, 77
    _SM_CXVIRT, _SM_CYVIRT = 78, 79

    # 64-bit-correct prototypes — without them ctypes truncates/overflows handles
    _u32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    _u32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
    _u32.GetWindowThreadProcessId.restype = wintypes.DWORD
    _u32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, wintypes.LPDWORD]
    _u32.GetForegroundWindow.restype = wintypes.HWND
    _u32.SetForegroundWindow.argtypes = [wintypes.HWND]
    _u32.BringWindowToTop.argtypes = [wintypes.HWND]
    _u32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    _u32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    _u32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    _u32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _u32.IsWindowVisible.argtypes = [wintypes.HWND]
    _k32.GetCurrentThreadId.restype = wintypes.DWORD

    def _vorigin():
        return (_u32.GetSystemMetrics(_SM_XVIRT), _u32.GetSystemMetrics(_SM_YVIRT))

    def win_virtual_size():
        w = _u32.GetSystemMetrics(_SM_CXVIRT) or _u32.GetSystemMetrics(0)
        h = _u32.GetSystemMetrics(_SM_CYVIRT) or _u32.GetSystemMetrics(1)
        return w, h

    def win_cursor_pos():
        """Pointer position in virtual-screen (suite) coordinates."""
        pt = wintypes.POINT()
        _u32.GetCursorPos(ctypes.byref(pt))
        vx, vy = _vorigin()
        return pt.x - vx, pt.y - vy

    def win_set_cursor(x, y):
        vx, vy = _vorigin()
        _u32.SetCursorPos(x + vx, y + vy)

    def win_find_hwnd(title=None, pid=None):
        """First visible top-level window matching title substring and/or pid."""
        found = []
        WNDENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def cb(hwnd, lp):
            if not _u32.IsWindowVisible(hwnd):
                return True
            if pid is not None:
                wp = wintypes.DWORD()
                _u32.GetWindowThreadProcessId(hwnd, ctypes.byref(wp))
                if wp.value != pid:
                    return True
            if title is not None:
                n = _u32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(max(n + 1, 2))
                _u32.GetWindowTextW(hwnd, buf, n + 1)
                if title not in buf.value:
                    return True
            found.append(hwnd)
            return True

        _u32.EnumWindows(WNDENUM(cb), 0)
        return found[0] if found else None

    def win_rect(hwnd):
        rc = wintypes.RECT()
        _u32.GetWindowRect(hwnd, ctypes.byref(rc))
        vx, vy = _vorigin()
        return rc.left - vx, rc.top - vy, rc.right - rc.left, rc.bottom - rc.top

    def win_foreground(hwnd):
        """AttachThreadInput trick — same as win.hpp's window_activate."""
        fg = _u32.GetForegroundWindow()
        tid = _u32.GetWindowThreadProcessId(fg, None) if fg else 0
        me = _k32.GetCurrentThreadId()
        attached = tid and tid != me and _u32.AttachThreadInput(me, tid, True)
        _u32.ShowWindow(hwnd, 5)  # SW_SHOW
        _u32.BringWindowToTop(hwnd)
        ok = _u32.SetForegroundWindow(hwnd)
        if attached:
            _u32.AttachThreadInput(me, tid, False)
        return bool(ok)

    def win_is_foreground(hwnd):
        return _u32.GetForegroundWindow() == hwnd


# ---------------------------------------------------------------------------
# minimal websocket client (stdlib only — abuse tests need raw frame control)
# ---------------------------------------------------------------------------


class WSError(Exception):
    pass


class WS:
    """RFC6455 client: masked sends, fragmentation reassembly, control frames."""

    def __init__(self, host, port, path="/ws", headers=None, timeout=10):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n")
        for h in (headers or []):
            req += h + "\r\n"
        req += "\r\n"
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WSError("handshake failed: " + resp[:100].decode(errors="replace"))
            resp += chunk
        head, self._rxbuf = resp.split(b"\r\n\r\n", 1)
        if b"101" not in head.split(b"\r\n", 1)[0]:
            raise WSError("upgrade refused: " + head.split(b"\r\n", 1)[0].decode(errors="replace"))
        self._msg = b""
        self.closed = False

    def _read_exact(self, n):
        while len(self._rxbuf) < n:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                self.closed = True
                raise WSError("eof")
            self._rxbuf += chunk
        out, self._rxbuf = self._rxbuf[:n], self._rxbuf[n:]
        return out

    def send_frame(self, op, payload=b"", fin=True, mask=True):
        b0 = (0x80 if fin else 0) | op
        n = len(payload)
        out = bytes([b0])
        flag = 0x80 if mask else 0
        if n <= 125:
            out += bytes([flag | n])
        elif n <= 0xFFFF:
            out += bytes([flag | 126]) + struct.pack(">H", n)
        else:
            out += bytes([flag | 127]) + struct.pack(">Q", n)
        if mask:
            mk = secrets.token_bytes(4)
            out += mk + bytes(b ^ mk[i & 3] for i, b in enumerate(payload))
        else:
            out += payload
        self.sock.sendall(out)

    def send_text(self, obj):
        self.send_frame(1, json.dumps(obj).encode())

    def send_raw_bytes(self, data):
        self.sock.sendall(data)

    def recv_message(self, timeout=15):
        """One complete text/binary message; control frames handled inline."""
        self.sock.settimeout(timeout)
        while True:
            hdr = self._read_exact(2)
            fin, op = hdr[0] & 0x80, hdr[0] & 0x0F
            n = hdr[1] & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read_exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read_exact(8))[0]
            payload = self._read_exact(n) if n else b""
            if op == 8:
                self.closed = True
                raise WSError("close frame")
            if op == 9:                       # ping -> pong
                self.send_frame(0xA, payload, mask=False)
                continue
            if op == 0xA:
                return ("pong", payload)
            self._msg += payload
            if fin:
                out, self._msg = self._msg, b""
                return ("msg", out)

    def recv_json(self, timeout=15):
        kind, payload = self.recv_message(timeout)
        if kind == "pong":
            return {"type": "__pong__", "payload": payload.decode(errors="replace")}
        return json.loads(payload.decode(errors="replace"))

    def wait_for(self, pred, timeout=15, keep=None):
        """Read messages until pred(msg) is true. keep collects every message."""
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                m = self.recv_json(timeout=max(1, timeout - (time.time() - t0)))
            except (WSError, socket.timeout, json.JSONDecodeError):
                return None
            if keep is not None:
                keep.append(m)
            if pred(m):
                return m
        return None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass
        self.closed = True


# ---------------------------------------------------------------------------
# harness
# ---------------------------------------------------------------------------

RESULTS = []


def record(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  — {detail}" if detail else ""), flush=True)


def xcmd(args, display, timeout=10):
    env = dict(os.environ, DISPLAY=display)
    return subprocess.run(args, env=env, capture_output=True, text=True, timeout=timeout)


def mouse_pos(display):
    if IS_WIN:
        return win_cursor_pos()
    out = xcmd(["xdotool", "getmouselocation", "--shell"], display).stdout
    x = y = -1
    for line in out.splitlines():
        if line.startswith("X="):
            x = int(line[2:])
        elif line.startswith("Y="):
            y = int(line[2:])
    return x, y


def display_size(display):
    if IS_WIN:
        return win_virtual_size()
    out = xcmd(["xdpyinfo"], display).stdout
    for line in out.splitlines():
        if "dimensions:" in line:
            w, h = line.split("dimensions:")[1].split()[0].split("x")
            return int(w), int(h)
    raise RuntimeError("xdpyinfo: no dimensions")


def jpg_pixels(b64):
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def mean_rgb(img):
    return tuple(int(v) for v in img.resize((1, 1)).getpixel((0, 0)))


def rgb_close(rgb, want, tol=45):
    return rgb is not None and all(abs(a - b) <= tol for a, b in zip(rgb, want))


def frame_inner(m):
    """session rpc wrapper → inner omp frame dict."""
    f = m.get("frame")
    return f if isinstance(f, dict) else {}


class Rig:
    """omprd lifecycle under a scratch HOME (devices/pending/recordings isolated)."""

    def __init__(self, args, home=None, port=None, warm=False):
        self.port = port if port is not None else args.port
        self.display = args.display
        self.home = home or tempfile.mkdtemp(prefix="rigtest-home-")
        os.makedirs(os.path.join(self.home, ".rig"), exist_ok=True)
        self.logf = tempfile.NamedTemporaryFile(prefix="omprd-test-", suffix=".log", delete=False)
        env = dict(os.environ)
        env["HOME"] = self.home
        if IS_WIN:
            env["USERPROFILE"] = self.home  # omprd's home_dir() reads USERPROFILE first
        env["RIG_WARM"] = "1" if warm else "0"   # deterministic: pool off unless testing it
        env["RIG_WARM_MAX"] = "3"
        env["OMP_BIN"] = args.omp_bin
        # --bind 127.0.0.1: omprd defaults to detect_best_ip() (tailnet/LAN) —
        # the suite stays hermetic on loopback regardless of host networking.
        self.proc = subprocess.Popen(
            [args.bin, "--port", str(self.port), "--bind", "127.0.0.1"],
            env=env, stdout=self.logf, stderr=subprocess.STDOUT,
            start_new_session=True)
        t0 = time.time()
        while time.time() - t0 < 10:
            if self.proc.poll() is not None:
                raise RuntimeError("omprd exited early: " + self.log_tail(50))
            try:
                s = socket.create_connection(("127.0.0.1", self.port), 0.3)
                s.close()
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("omprd never listened")

    def pair(self, device="testbench", port=None):
        """Write pending.json directly, consume it via the pair command."""
        code = "%06d" % secrets.randbelow(1000000)
        with open(os.path.join(self.home, ".rig", "pending.json"), "w") as f:
            json.dump({"code": code, "expires": int(time.time()) + 300}, f)
        ws = WS("127.0.0.1", port or self.port)
        ws.send_text({"type": "pair", "code": code, "device": device})
        m = ws.recv_json()
        assert m.get("type") == "paired", f"pair failed: {m}"
        tok = m["token"]
        ws.close()
        return tok

    def connect(self, token):
        return WS("127.0.0.1", self.port, headers=[f"Authorization: Bearer {token}"])

    def alive(self):
        return self.proc.poll() is None

    def log_tail(self, n=30):
        try:
            with open(self.logf.name, errors="replace") as f:
                return "\n".join(f.read().splitlines()[-n:])
        except OSError:
            return "<no log>"

    def stop(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.logf.close()


# ---------------------------------------------------------------------------
# A. coordinate correctness
# ---------------------------------------------------------------------------

def send_actions(ws, steps, msgs, timeout=15):
    ws.send_text({"type": "computer.actions", "steps": steps})
    return ws.wait_for(lambda m: m.get("type") == "computer.actions", timeout=timeout, keep=msgs)


def test_coordinates(rig, tok, disp):
    ws = rig.connect(tok)
    msgs = []
    ws.send_text({"type": "computer.state"})
    st = ws.wait_for(lambda m: m.get("type") == "computer.state", timeout=15, keep=msgs)
    if not st or not st.get("nativeBackend"):
        record("A0.computer.state/native backend", False, f"state={st} log={rig.log_tail(5)}")
        return
    record("A0.computer.state native backend up", True,
           f"resolution={st.get('resolution')} shm={st.get('shm')} xtest={st.get('xtest')}")
    W, H = display_size(disp)

    def click_verify(name, ax, ay, want, tol=1, extra=None):
        send_actions(ws, [dict({"action": "click", "x": ax, "y": ay}, **(extra or {}))], msgs)
        time.sleep(0.2)
        gx, gy = mouse_pos(disp)
        err = max(abs(gx - want[0]), abs(gy - want[1]))
        record(name, err <= tol, f"want={want} got=({gx},{gy}) err_px={err}")

    click_verify("A1.click exact pixel (300,250)", 300, 250, (300, 250))
    click_verify("A2.click corner (0,0)", 0, 0, (0, 0))
    click_verify("A3.click far corner (W-1,H-1)", W - 1, H - 1, (W - 1, H - 1))

    # shot-space scaling: client saw a half-scale screenshot
    click_verify("A4.shot-space 0.5 scale", 240, 135, (480, 270), tol=2,
                 extra={"shotW": W // 2, "shotH": H // 2})

    # region shot-space: capture {400,300,800x600}, click (40,30) in it
    click_verify("A5.region shot-space", 40, 30, (440, 330), tol=1,
                 extra={"shotX": 400, "shotY": 300, "shotRW": 800, "shotRH": 600,
                        "shotW": 800, "shotH": 600})

    # out-of-range clamps into the display, never errors
    send_actions(ws, [{"action": "click", "x": -500, "y": -500}], msgs)
    gx, gy = mouse_pos(disp)
    record("A6.click clamps to display", gx >= 0 and gy >= 0, f"got=({gx},{gy})")

    send_actions(ws, [{"action": "click", "x": 99999, "y": 99999}], msgs)
    gx, gy = mouse_pos(disp)
    record("A7.click huge coords clamp", gx < W and gy < H, f"got=({gx},{gy})")
    ws.close()


# ---------------------------------------------------------------------------
# B. input fidelity (xev event capture)
# ---------------------------------------------------------------------------

XEV_LOG = (os.path.join(tempfile.gettempdir(), "rig-xev-events.log")
           if IS_WIN else "/tmp/xev-events.log")
TESTER = os.path.join(HERE, "win-event-tester.py")

# color-window geometry: xterm's "80x24" is chars, not px — same spot, real size
COLOR_GEOM = "300x200+300+200"


def spawn_xev(display, size="500x400+150+150"):
    # xev stdout is block-buffered on a pipe — events would sit unseen for
    # minutes. Redirect to a file and parse that instead. Stale xev windows
    # must die first: a name search would hand us the OLD window, focus it,
    # and the fresh log would show zero events.
    if IS_WIN:
        title = f"Event Tester {os.getpid()}"
        p = subprocess.Popen([sys.executable, TESTER,
                              "--title", title, "--log", XEV_LOG,
                              "--geom", size],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # the tester opens the log itself; suite parses from file offsets
        t0 = time.time()
        while time.time() - t0 < 8:
            hwnd = win_find_hwnd(title=title, pid=p.pid)
            if hwnd:
                return p, hwnd
            if p.poll() is not None:
                return p, None
            time.sleep(0.2)
        return p, None
    subprocess.run(["pkill", "-x", "xev"], capture_output=True)
    time.sleep(0.3)
    lf = open(XEV_LOG, "w")
    # stdbuf -oL: xev block-buffers stdio to a file — without it events only
    # appear when the buffer fills or the process exits
    p = subprocess.Popen(["stdbuf", "-oL", "xev", "-geometry", size],
                         stdout=lf, stderr=subprocess.DEVNULL,
                         text=True, env=dict(os.environ, DISPLAY=display))
    p._logf = lf
    t0 = time.time()
    while time.time() - t0 < 6:
        r = xcmd(["xdotool", "search", "--name", "Event Tester"], display)
        wids = [int(w) for w in r.stdout.split() if w.strip()]
        if wids:
            return p, wids[0]
        time.sleep(0.25)
    r = xcmd(["xdotool", "getactivewindow"], display)
    try:
        return p, int(r.stdout.strip())
    except ValueError:
        return p, None


def spawn_color_window(display, hexcolor, geom=None):
    """A colored content window. xsetroot is invisible under xfwm4's
    compositor (root reads back black), so screen-change tests must paint a
    real window instead."""
    geom = geom or (COLOR_GEOM if IS_WIN else "80x24+300+200")
    if IS_WIN:
        # always-on-top solid window — the win-event-tester doubles as xterm -bg
        p = subprocess.Popen([sys.executable, TESTER,
                              "--title", f"rigcolor-{hexcolor}-{os.getpid()}",
                              "--log", os.devnull, "--geom", geom,
                              "--bg", hexcolor],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        t0 = time.time()
        while time.time() - t0 < 8:
            hwnd = win_find_hwnd(pid=p.pid)
            if hwnd:
                return p, hwnd
            if p.poll() is not None:
                return p, None
            time.sleep(0.2)
        return p, None
    p = subprocess.Popen(["xterm", "-bg", hexcolor, "-geometry", geom,
                          "-e", "sleep", "600"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env=dict(os.environ, DISPLAY=display))
    t0 = time.time()
    while time.time() - t0 < 6:
        r = xcmd(["xdotool", "search", "--pid", str(p.pid)], display)
        wids = [int(w) for w in r.stdout.split() if w.strip()]
        if wids:
            return p, wids[0]
        time.sleep(0.25)
    return p, None


def win_center(display, wid):
    x, y, w, h = xev_win_geom(display, wid)
    return x + w // 2, y + h // 2


def frame_pixel(img, dx, dy, scale=1.0):
    """Pixel in a (possibly scaled) frame corresponding to display (dx,dy)."""
    fx = min(max(0, int(dx * scale)), img.width - 1)
    fy = min(max(0, int(dy * scale)), img.height - 1)
    return img.getpixel((fx, fy))


def screen_rgb(display, x, y, sz=8):
    """Mean color of an sz x sz patch around display (x,y) — ground truth."""
    if IS_WIN:
        try:
            from PIL import ImageGrab
            vx, vy = _vorigin()
            img = ImageGrab.grab(bbox=(x - sz // 2 + vx, y - sz // 2 + vy,
                                       x + sz // 2 + vx, y + sz // 2 + vy))
            return mean_rgb(img.convert("RGB"))
        except Exception:
            return None
    tmp = "/tmp/scr-probe.png"
    xcmd(["import", "-window", "root", "-crop",
          f"{sz}x{sz}+{x - sz // 2}+{y - sz // 2}", tmp], display, timeout=8)
    try:
        return mean_rgb(Image.open(tmp).convert("RGB"))
    except Exception:
        return None


def wait_screen_color(display, x, y, want, timeout=8):
    """A window existing isn't pixels painted — poll the real screen first."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if rgb_close(screen_rgb(display, x, y), want):
            return True
        time.sleep(0.25)
    return False


def xev_win_geom(display, wid):
    if IS_WIN:
        return win_rect(wid)
    r = xcmd(["xwininfo", "-id", str(wid)], display)
    x = y = w = h = 0
    for line in r.stdout.splitlines():
        ls = line.strip()
        if ls.startswith("Absolute upper-left X:"):
            x = int(ls.split(":")[1])
        elif ls.startswith("Absolute upper-left Y:"):
            y = int(ls.split(":")[1])
        elif ls.startswith("Width:"):
            w = int(ls.split(":")[1])
        elif ls.startswith("Height:"):
            h = int(ls.split(":")[1])
    return x, y, w, h


def focus_window(display, wid, timeout=6.0):
    """windowactivate --sync asks; the WM answers on ITS schedule — on a slow
    (TCG) guest injected keys that beat the grant vanish into the void. Poll
    getactivewindow until the focus is real. Returns True once it is."""
    if not wid:
        return False
    if IS_WIN:
        t0 = time.time()
        while time.time() - t0 < timeout:
            win_foreground(wid)
            if win_is_foreground(wid):
                return True
            time.sleep(0.2)
        return False
    xcmd(["xdotool", "windowactivate", "--sync", str(wid)], display, timeout=5)
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = xcmd(["xdotool", "getactivewindow"], display, timeout=3)
        if r.stdout.strip() == str(wid):
            return True
        time.sleep(0.2)
    return False


def drain_xev(p):
    """Mark the current end of xev's log as the baseline for the next read."""
    lf = getattr(p, "_logf", None)
    if lf is not None:
        lf.flush()
    try:
        p._pos = os.path.getsize(XEV_LOG)
    except OSError:
        p._pos = 0


def win_tester_events(p, settle=0.3):
    """Parse the win-event-tester log since drain_xev — mirrors xev_events'
    tuple shape: key up/down→press/release, char→char, button→bpress/
    brelease/bdbl, motion, wheel±120→("wheel","+120"/"-120")."""
    time.sleep(settle)
    try:
        with open(XEV_LOG, errors="replace") as f:
            f.seek(getattr(p, "_pos", 0))
            lines = f.read().splitlines()
    except OSError:
        lines = []
    evts = []
    for line in lines:
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "key":
            evts.append(("press" if parts[1] == "down" else "release", parts[2]))
        elif parts[0] == "char" and len(parts) >= 2:
            evts.append(("char", parts[1]))
        elif parts[0] == "button" and len(parts) >= 3:
            evts.append(({"down": "bpress", "up": "brelease", "dbl": "bdbl"}[parts[1]],
                         parts[2]))
        elif parts[0] == "motion":
            evts.append(("motion", ""))
        elif parts[0] == "wheel" and len(parts) >= 2:
            evts.append(("wheel", parts[1]))
    return evts


def xev_events(p, settle=0.3, dedupe=False):
    """Parse key/button/motion events from xev's log since drain_xev.

    `xev -id` selects overlapping masks on the same window — one real
    press/release pair shows up as a triplet [release_prev@t, press@t,
    release@t]: a phantom copy of the PREVIOUS char's release restamped to
    the current time, then the real press+release pair. With dedupe=True,
    collapse verbatim (kind, keysym, ms-time) dupes and drop any release
    whose keysym wasn't also pressed at that timestamp. H-test bursts never
    put two events with identical (kind, keysym) inside one millisecond;
    B-tests run with dedupe off so 120 identical chars can't be undercounted.

    On Windows this reads the win-event-tester log instead (same tuples,
    plus "char" events for WM_CHAR and "wheel"/"bdbl" for wheel/dblclk).
    """
    if IS_WIN:
        return win_tester_events(p, settle)
    time.sleep(settle)
    try:
        p._logf.flush()
        with open(XEV_LOG, errors="replace") as f:
            f.seek(getattr(p, "_pos", 0))
            lines = f.read().splitlines()
    except OSError:
        lines = []
    evts = []          # (kind, data, ms_time)
    seen = set()
    for i, line in enumerate(lines):
        if "KeyPress event" in line or "KeyRelease event" in line:
            ks = ""
            et = ""
            # xev layout: event line, then "root ... time N" detail, THEN the
            # "state 0xN, keycode NN (keysym ...)" line — scan forward.
            for j in range(i + 1, min(i + 5, len(lines))):
                if " event," in lines[j]:
                    break
                if not et and "time " in lines[j]:
                    et = lines[j].split("time ")[1].split(",")[0].strip()
                if "keysym" in lines[j]:
                    try:
                        ks = lines[j].split("keysym")[1].split(",")[1].strip().rstrip(")")
                    except (IndexError, ValueError):
                        ks = lines[j].strip()[-30:]
            kind = "press" if "Press" in line else "release"
            cur = (kind, ks, et)
            if dedupe and cur in seen:
                continue
            seen.add(cur)
            evts.append(cur)
        elif "ButtonPress event" in line or "ButtonRelease event" in line:
            btn = ""
            et = ""
            for j in range(i + 1, min(i + 4, len(lines))):
                if " event," in lines[j]:
                    break
                if not et and "time " in lines[j]:
                    et = lines[j].split("time ")[1].split(",")[0].strip()
                if "button" in lines[j] and "state" in lines[j]:
                    try:
                        btn = lines[j].split("button")[1].split(",")[0].strip()
                    except (IndexError, ValueError):
                        btn = lines[j].strip()[-20:]
            kind = "bpress" if "Press" in line else "brelease"
            cur = (kind, btn, et)
            if dedupe and cur in seen:
                continue
            seen.add(cur)
            evts.append(cur)
        elif "MotionNotify" in line:
            et = ""
            for j in range(i + 1, min(i + 4, len(lines))):
                if " event," in lines[j]:
                    break
                if "time " in lines[j]:
                    et = lines[j].split("time ")[1].split(",")[0].strip()
                    break
            cur = ("motion", "", et)
            if dedupe and cur in seen:
                continue
            seen.add(cur)
            evts.append(cur)
    if dedupe:
        # drop -id's phantom releases: keep a release only if the same keysym
        # was also pressed at the same timestamp (real pairs share the time)
        pressed = {(d, t) for k, d, t in evts if k in ("press", "bpress")}
        evts = [e for e in evts
                if e[0] in ("press", "bpress", "motion")
                or (e[1], e[2]) in pressed]
    return [(k, d) for k, d, _ in evts]


def test_input(rig, tok, disp):
    ws = rig.connect(tok)
    msgs = []
    ws.send_text({"type": "computer.state"})
    ws.wait_for(lambda m: m.get("type") == "computer.state", timeout=15, keep=msgs)

    p, wid = spawn_xev(disp)
    if not wid:
        for b in ("B1", "B2", "B3", "B4", "B5"):
            record(b + ".xev window never mapped", False, "no wid")
        p.terminate()
        ws.close()
        return
    focus_window(disp, wid)
    wx, wy, ww, wh = xev_win_geom(disp, wid)
    cx, cy = wx + ww // 2, wy + wh // 2

    # -- B1: 200-char burst — nothing dropped, nothing reordered
    # Windows verifies at WM_CHAR (what a text field receives); X11 verifies
    # key-release keysyms — same contract, different event surface.
    char_kind = "char" if IS_WIN else "release"
    text = "".join(chr(97 + (i % 26)) for i in range(200))
    focused = focus_window(disp, wid)
    drain_xev(p)
    send_actions(ws, [{"action": "type", "text": text, "delayMs": 0}], msgs, timeout=40)
    evts = xev_events(p, settle=1.0)
    got = [d for k, d in evts if k == char_kind and len(d) == 1 and d.isalpha()]
    # xev may split shifted modifiers as separate keysyms; filter to a-z stream
    got = [g for g in got if g in "abcdefghijklmnopqrstuvwxyz"]
    dropped = len(text) - len(got)
    ordered = got == list(text)
    record("B1.type 200-char burst (0 drops, 0 reorders)",
           dropped == 0 and ordered,
           f"typed={len(text)} received={len(got)} dropped={dropped} ordered={ordered} focused={focused}")

    # -- B2: modifiers / shifted symbols
    focus_window(disp, wid)
    drain_xev(p)
    send_actions(ws, [{"action": "type", "text": "@#%", "delayMs": 0}], msgs)
    evts = xev_events(p, settle=0.6)
    names = {d for k, d in evts if k == ("char" if IS_WIN else "release")}
    want_syms = {"@", "#", "%"} if IS_WIN else {"at", "numbersign", "percent"}
    record("B2.shifted symbols @#%", want_syms <= names,
           f"keysyms={sorted(names)[:14]}")

    # -- B3: double click = 2 press + 2 release
    # Windows reports the second press as WM_LBUTTONDBLCLK ("bdbl") — a real
    # double click, so press+dblclk counts the two presses.
    drain_xev(p)
    send_actions(ws, [{"action": "doubleclick", "x": cx, "y": cy}], msgs)
    evts = xev_events(p, settle=0.6)
    presses = len([e for e in evts if e == ("bpress", "1")]) + \
        len([e for e in evts if e == ("bdbl", "1")])
    br = [e for e in evts if e == ("brelease", "1")]
    record("B3.doubleclick = 2 press/release", presses == 2 and len(br) == 2,
           f"press={presses} release={len(br)}")

    # -- B4: drag press → motion(s) → release, cursor ends at toX/toY
    drain_xev(p)
    sx, sy = cx - 60, cy - 40
    tx, ty = cx + 60, cy + 40
    send_actions(ws, [{"action": "drag", "fromX": sx, "fromY": sy,
                       "toX": tx, "toY": ty, "steps": 8}], msgs, timeout=20)
    evts = xev_events(p, settle=0.6)
    kinds = [k for k, _ in evts]
    # the drag's initial move to (fromX,fromY) logs a Motion before the press;
    # what must hold is press → some motion → release afterwards
    ip = kinds.index("bpress") if "bpress" in kinds else -1
    im = next((i for i, k in enumerate(kinds) if k == "motion" and i > ip), -1)
    ir = len(kinds) - 1 - kinds[::-1].index("brelease") if "brelease" in kinds else -1
    seq_ok = ip >= 0 and im > ip and ir > im
    gx, gy = mouse_pos(disp)
    record("B4.drag press→motion→release lands at toX,toY",
           seq_ok and abs(gx - tx) <= 1 and abs(gy - ty) <= 1,
           f"cursor=({gx},{gy}) want=({tx},{ty}) seq_ok={seq_ok}")

    # -- B5: scroll direction + magnitude
    # X11 sees ButtonPress 4/5; Windows sees WM_MOUSEWHEEL ±120/notch.
    if IS_WIN:
        win_set_cursor(cx, cy)
    else:
        xcmd(["xdotool", "mousemove", str(cx), str(cy)], disp)
    drain_xev(p)
    send_actions(ws, [{"action": "scroll", "x": cx, "y": cy, "direction": "up", "times": 3}], msgs)
    evts = xev_events(p, settle=0.5)
    if IS_WIN:
        # win backend emits one wheel event carrying the full delta
        # (times*120) — same notch count a real app accumulates.
        up = sum(int(e[1]) for e in evts if e[0] == "wheel")
        ok_up = up == 3 * 120
    else:
        b4 = len([e for e in evts if e == ("bpress", "4")])
        b5 = len([e for e in evts if e == ("bpress", "5")])
        ok_up = b4 == 3 and b5 == 0
    drain_xev(p)
    send_actions(ws, [{"action": "scroll", "x": cx, "y": cy, "direction": "down", "times": 5}], msgs)
    evts = xev_events(p, settle=0.5)
    if IS_WIN:
        dn2 = -sum(int(e[1]) for e in evts if e[0] == "wheel")
        ok_down = dn2 == 5 * 120
        detail = f"up→wheel+{up} | down→wheel-{dn2}"
    else:
        b5d = len([e for e in evts if e == ("bpress", "5")])
        b4d = len([e for e in evts if e == ("bpress", "4")])
        ok_down = b5d == 5 and b4d == 0
        detail = f"up3→b4={b4},b5={b5} | down5→b5={b5d},b4={b4d}"
    record("B5.scroll direction+magnitude (up=btn4, down=btn5)",
           ok_up and ok_down, detail)

    # -- B6: two clients' type bursts must not interleave at char level.
    # A click/drag/type is a multi-call X sequence — without daemon-side
    # serialization a second client's action can steal the pointer mid-burst.
    ws2 = rig.connect(tok)
    drain_xev(p)
    ta = "q" * 120
    tb = "z" * 120
    ws.send_text({"type": "computer.actions",
                  "steps": [{"action": "type", "text": ta, "delayMs": 1}]})
    ws2.send_text({"type": "computer.actions",
                   "steps": [{"action": "type", "text": tb, "delayMs": 1}]})
    r1 = ws.wait_for(lambda m: m.get("type") == "computer.actions", timeout=20, keep=msgs)
    r2 = ws2.wait_for(lambda m: m.get("type") == "computer.actions", timeout=20, keep=msgs)
    evts = xev_events(p, settle=0.8)
    got = "".join(d for k, d in evts if k == char_kind and len(d) == 1 and d in "qz")
    contiguous = got in (ta + tb, tb + ta)
    record("B6.concurrent type bursts stay contiguous",
           r1 is not None and r2 is not None and contiguous,
           f"len={len(got)} contiguous={contiguous} sample={got[:20]!r}…{got[-20:]!r}")
    ws2.close()

    p.terminate()
    ws.close()


# ---------------------------------------------------------------------------
# H. launch → focus race: a GUI launch must report + hold frontmost by the
# time the reply lands, or the first keystrokes vanish into the old window.
# ---------------------------------------------------------------------------

def test_launch(rig, tok, disp):
    msgs = []
    ws = rig.connect(tok)

    # H1: daemon launches xterm — reply reports frontmost, and a zero-delay
    # burst typed immediately after lands intact (xev -id attaches to the
    # launched window and records what really arrived). Unique title per
    # run: earlier suite runs leave same-titled xterms behind, which both
    # confuses `search --name` and lets the daemon's frontmost comm-match
    # pass on a STALE window — the daemon now waits on the launched pid's
    # tree, and this test names a window only this run can own.
    title = f"riglaunchH1-{os.getpid()}"
    if IS_WIN:
        # the event tester IS the launched window — its own log captures the
        # burst, no post-attach needed (xev -id role drops out entirely).
        launch_app = f'python "{TESTER}" --title "{title}" --log "{XEV_LOG}" ' \
                     f'--geom 480x360+120+120'
        want_front = "python"
    else:
        xcmd(["sh", "-c", "pkill -f 'xterm -T riglaunchH[1]' 2>/dev/null; true"], disp)
        launch_app = f"xterm -T {title}"
        want_front = "xterm"
    r = send_actions(ws, [{"action": "launch", "app": launch_app}],
                     msgs, timeout=20)
    res = (r or {}).get("results") or [{}]
    fm = res[0].get("frontmost", "")
    took = res[0].get("tookMs", -1)
    wid = None
    t0 = time.time()
    while time.time() - t0 < 8:
        if IS_WIN:
            hwnd = win_find_hwnd(title=title)
            if hwnd:
                wid = hwnd
                break
        else:
            out = xcmd(["xdotool", "search", "--name", title], disp)
            wids = [int(w) for w in out.stdout.split() if w.strip()]
            if wids:
                wid = wids[0]
                break
        time.sleep(0.25)

    got = []
    if wid:
        if IS_WIN:
            p = type("T", (), {"_pos": 0})()  # log offset holder — tester owns the file
            time.sleep(0.5)                  # let the window take foreground
            drain_xev(p)
            text = "launchrace" * 5          # 50 chars
            send_actions(ws, [{"action": "type", "text": text, "delayMs": 0}],
                         msgs, timeout=30)
            evts = xev_events(p, settle=1.0, dedupe=True)
            got = [d for k, d in evts if k == "char" and len(d) == 1 and d.isalpha()]
            got = [g for g in got if g in "abcdefghijklmnopqrstuvwxyz"]
        else:
            lf = open(XEV_LOG, "w")
            p = subprocess.Popen(["stdbuf", "-oL", "xev", "-id", str(wid)],
                                 stdout=lf, stderr=subprocess.DEVNULL, text=True,
                                 env=dict(os.environ, DISPLAY=disp))
            p._logf = lf
            time.sleep(0.5)                      # let xev select() attach
            drain_xev(p)
            text = "launchrace" * 5              # 50 chars
            send_actions(ws, [{"action": "type", "text": text, "delayMs": 0}],
                         msgs, timeout=30)
            # Count presses, not releases: at delayMs=0 the native path delivers
            # ~25 keys/ms, so real same-char repeats share a millisecond and the
            # dedupe's "no identical (kind,keysym) inside 1ms" assumption no
            # longer holds — releases collapse and undercount. xev -id's phantom
            # duplication is release-only, so raw alpha presses are an exact
            # count of keys the window actually received.
            evts = xev_events(p, settle=1.0, dedupe=False)
            got = [d for k, d in evts if k == "press" and len(d) == 1 and d.isalpha()]
            got = [g for g in got if g in "abcdefghijklmnopqrstuvwxyz"]
            p.terminate()
    record("H1.launch → frontmost reported, burst lands intact",
           bool(res[0].get("ok")) and fm == want_front and got == list("launchrace" * 5),
           f"frontmost={fm!r} tookMs={took} wid={wid} received={len(got)}/50")

    # H2: CLI launch never maps a window — the focus-wait must bail on child
    # exit, not burn the whole budget.
    r = send_actions(ws, [{"action": "launch",
                           "app": 'python -c "pass"' if IS_WIN else "true"}],
                     msgs, timeout=20)
    res = (r or {}).get("results") or [{}]
    record("H2.launch CLI app bails fast (no focus stall)",
           bool(res[0].get("ok")) and res[0].get("tookMs", 99999) < 1500,
           f"tookMs={res[0].get('tookMs')} frontmost={res[0].get('frontmost')!r}")

    # H3: unknown binary still errors, daemon stays up.
    r = send_actions(ws, [{"action": "launch", "app": "definitely-no-such-bin-xyz"}],
                     msgs, timeout=15)
    res = (r or {}).get("results") or [{}]
    record("H3.launch unknown binary → ok:false",
           res[0].get("ok") is False and rig.alive(),
           f"err={res[0].get('error')!r}")
    ws.close()


# ---------------------------------------------------------------------------
# C. protocol integrity
# ---------------------------------------------------------------------------

def test_protocol(rig, tok):
    msgs = []
    ws = rig.connect(tok)

    ws.send_frame(1, b"{not json at all")
    m = ws.recv_json(timeout=5)
    record("C1.malformed JSON → error", m.get("type") == "error", f"got={m.get('type')}")

    ws.send_text({"type": "computer.actions", "steps": [{"action": "click", "x": "banana", "y": {}}]})
    m = ws.wait_for(lambda mm: mm.get("type") in ("computer.actions", "error"), timeout=10, keep=msgs)
    record("C2.wrong-typed coords → error/reply, daemon alive",
           m is not None and rig.alive(), f"type={m and m.get('type')}")

    ws.send_text({"type": "computer.bogusXYZ"})
    m = ws.wait_for(lambda mm: mm.get("type") == "error", timeout=5, keep=msgs)
    record("C3.unknown command → error", m is not None, f"err={m and m.get('error')}")

    ws.send_frame(0x9, b"hi-ping", mask=False)     # ping — unmasked is fine server-side
    kind, payload = ws.recv_message(timeout=5)
    record("C4.ping→pong echo payload", kind == "pong" and payload == b"hi-ping",
           f"kind={kind} payload={payload!r}")

    ws.send_text({"type": "rig.stats"})
    m = ws.wait_for(lambda mm: mm.get("type") == "rig.stats", timeout=5, keep=msgs)
    record("C5.parser still in sync after control frame", m is not None, "")

    part1 = b'{"type":"rig.st'
    part2 = b'ats"}'
    ws.send_frame(0x1, part1, fin=False)
    ws.send_frame(0x0, part2, fin=True)
    m = ws.wait_for(lambda mm: mm.get("type") == "rig.stats", timeout=5, keep=msgs)
    record("C6.fragmented message reassembled", m is not None, "")

    try:
        ws.sock.sendall(struct.pack(">BB", 0x81, 0xFF) +
                        struct.pack(">Q", 80 * 1024 * 1024) + b"AAAA")
        died = False
        try:
            ws.recv_message(timeout=4)
        except (WSError, socket.timeout, ConnectionError, BrokenPipeError):
            died = True
        record("C7.oversized declared frame → conn dropped, no crash",
               died and rig.alive(), "")
    except OSError:
        record("C7.oversized declared frame → conn dropped, no crash", rig.alive(), "")
    ws.close()

    try:
        ws2 = rig.connect(tok)
        ws2.send_raw_bytes(b"\x00\x01\x02\x03 not-a-ws-frame \xff\xfe")
        try:
            ws2.recv_message(timeout=3)
        except Exception:
            pass
        ws2.close()
    except Exception:
        pass
    record("C8.garbage bytes survived, daemon alive", rig.alive(), "")

    ws3 = WS("127.0.0.1", rig.port, headers=["Authorization: Bearer " + "deadbeef" * 4])
    ws3.send_text({"type": "rig.stats"})
    m = ws3.wait_for(lambda mm: mm.get("type") == "error", timeout=5)
    ws3.close()
    record("C9.bad bearer token → unauthorized", m is not None and "unauthorized" in str(m.get("error", "")),
           f"got={m}")

    code = "%06d" % secrets.randbelow(1000000)
    with open(os.path.join(rig.home, ".rig", "pending.json"), "w") as f:
        json.dump({"code": code, "expires": int(time.time()) + 300}, f)
    wsa = WS("127.0.0.1", rig.port); wsa.send_text({"type": "pair", "code": code, "device": "t1"})
    m1 = wsa.recv_json(); wsa.close()
    wsb = WS("127.0.0.1", rig.port); wsb.send_text({"type": "pair", "code": code, "device": "t2"})
    m2 = wsb.recv_json(); wsb.close()
    record("C10.consumed pair code rejected",
           m1.get("type") == "paired" and m2.get("type") == "error",
           f"first={m1.get('type')} second={m2.get('type')}:{m2.get('error')}")

    wsc = WS("127.0.0.1", rig.port)
    wsc.send_text({"type": "pair", "code": "000000", "device": "t3"})
    m3 = wsc.recv_json(); wsc.close()
    record("C11.wrong pair code → error", m3.get("type") == "error", f"{m3.get('error')}")


# ---------------------------------------------------------------------------
# D. session lifecycle
# ---------------------------------------------------------------------------

def session_new(rig, tok):
    ws = rig.connect(tok)
    ws.send_text({"type": "session.new", "cwd": rig.home})
    m = ws.wait_for(lambda mm: mm.get("type") in ("session.started", "error"), timeout=15)
    sid = m and m.get("sessionId")
    return ws, sid, m


def session_prompt(ws, sid, rid="p1"):
    ws.send_text({"type": "session.request", "sessionId": sid,
                  "frame": {"id": rid, "type": "prompt", "text": "hi"}})


def seqs_for(msgs, sid):
    return [m["seq"] for m in msgs
            if m.get("sessionId") == sid and isinstance(m.get("seq"), int)]


def collect_until(ws, pred, timeout=30):
    msgs = []
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            m = ws.recv_json(timeout=max(1, timeout - (time.time() - t0)))
        except (WSError, socket.timeout, json.JSONDecodeError):
            break
        msgs.append(m)
        if pred(m):
            break
    return msgs


def test_sessions(rig, tok):
    ws = rig.connect(tok)
    ws.send_text({"type": "session.request", "sessionId": "sess-dead",
                  "frame": {"id": "x", "type": "prompt", "text": "hi"}})
    t0 = time.time()
    m = ws.wait_for(lambda mm: mm.get("type") == "error", timeout=8)
    record("D1.request on dead session → error fast", m is not None and time.time() - t0 < 8,
           f"{m and m.get('error')}")

    wsA, sidA, _ = session_new(rig, tok)
    wsB, sidB, _ = session_new(rig, tok)
    record("D2.session.new x2 → distinct ids",
           bool(sidA and sidB and sidA != sidB), f"A={sidA} B={sidB}")

    session_prompt(wsA, sidA, "pa")
    session_prompt(wsB, sidB, "pb")
    frA = collect_until(wsA, lambda m: frame_inner(m).get("type") == "prompt_result", timeout=40)
    frB = collect_until(wsB, lambda m: frame_inner(m).get("type") == "prompt_result", timeout=40)
    seqA = seqs_for(frA, sidA)
    seqB = seqs_for(frB, sidB)
    deltaA = [f for f in frA if f.get("sessionId") == sidA and frame_inner(f).get("type") == "message_delta"]
    untagged = [f for f in frA if "sessionId" not in f and f.get("type") == "rpc"]
    okA = len(deltaA) >= 50 and seqA == sorted(seqA) and len(seqA) == len(set(seqA))
    okB = seqB == sorted(seqB) and len(seqB) == len(set(seqB)) and len(seqB) >= 50
    record("D3.interleaved sessions: per-session seq order, no dupes",
           okA and okB and not untagged,
           f"A: n={len(seqA)} dupes={len(seqA) - len(set(seqA))} | B: n={len(seqB)} dupes={len(seqB) - len(set(seqB))} untagged={len(untagged)}")

    # D5 subscribe mid-turn → replayed seqs, exactly-once vs live marks.
    # Exactly-once = every seq in [1..replayedTo] delivered precisely once —
    # live broadcast and replay streams may interleave non-monotonically.
    session_prompt(wsA, sidA, "pc")
    time.sleep(0.1)
    wsS = rig.connect(tok)
    wsS.send_text({"type": "session.subscribe", "sessionId": sidA, "since": 0})
    got = collect_until(wsS, lambda m: m.get("type") == "session.subscribed", timeout=40)
    sub = next((m for m in got if m.get("type") == "session.subscribed"), None)
    time.sleep(0.4)  # drain any live stragglers still in flight
    wsS.close()
    rt = (sub or {}).get("replayedTo") or 0
    # count seqs inside the REPLAY stream only — a live frame emitted while
    # the replay is draining legitimately arrives both ways (live fanout +
    # replay flag); exactly-once applies within each delivery, not across.
    rseqs = [m["seq"] for m in got
             if m.get("sessionId") == sidA and isinstance(m.get("seq"), int)
             and m.get("replay")]
    dupes = len(rseqs) - len(set(rseqs))
    missing = [s for s in range(1, rt + 1) if s not in set(rseqs)]
    record("D5.subscribe replay exactly-once (all of [1..replayedTo])",
           sub is not None and dupes == 0 and not missing and rt >= 200,
           f"replayedTo={rt} n={len(rseqs)} dupes={dupes} missing={len(missing)}")

    # same-client resubscribe with since=0: the app rebuilds its thread on
    # every subscribe, so the ring replays in FULL — live marks + replayed_hi
    # reset (86d9f4e). The replay must cover [1..replayedTo] again with each
    # seq sent exactly once within this replay (earlier live deliveries are
    # intentionally re-sent — that's what a rebuild asks for).
    wsA.send_text({"type": "session.subscribe", "sessionId": sidA, "since": 0})
    got = collect_until(wsA, lambda m: m.get("type") == "session.subscribed", timeout=10)
    replayed = [m for m in got if m.get("replay")]
    rseqs = [m["seq"] for m in replayed
             if m.get("sessionId") == sidA and isinstance(m.get("seq"), int)]
    rdupes = len(rseqs) - len(set(rseqs))
    rmissing = [s for s in range(1, rt + 1) if s not in set(rseqs)]
    record("D6.same-client since=0 resubscribe → full ring, exactly-once",
           len(replayed) > 0 and rdupes == 0 and not rmissing,
           f"replayed={len(replayed)} n={len(rseqs)} dupes={rdupes} missing={len(rmissing)} rt={rt}")

    # new client resubscribe with since → only seq>since, no dupes
    wsS2 = rig.connect(tok)
    wsS2.send_text({"type": "session.subscribe", "sessionId": sidA, "since": 50})
    got2 = collect_until(wsS2, lambda m: m.get("type") == "session.subscribed", timeout=10)
    wsS2.close()
    seqs2 = seqs_for(got2, sidA)
    leaked = [s for s in seqs2 if s <= 50]
    record("D7.resubscribe since=50 → only >50, no dupes",
           not leaked and len(seqs2) == len(set(seqs2)) and bool(seqs2),
           f"n={len(seqs2)} min={seqs2[:1]} leaked={len(leaked)}")

    # D8 omp crash mid-turn → error not hang; daemon survives
    wsC, sidC, m = session_new(rig, tok)
    if sidC:
        pid = m.get("pid")
        if not pid:
            wsC.send_text({"type": "rig.status"})
            st = wsC.wait_for(lambda mm: mm.get("type") == "rig.status", timeout=5)
            for s in (st or {}).get("sessions", []):
                if s.get("id") == sidC:
                    pid = s.get("pid")
        if pid:
            # Windows Python has no SIGKILL — os.kill maps any non-CTRL
            # signal to TerminateProcess, which IS the hard kill we want.
            os.kill(int(pid), getattr(signal, "SIGKILL", signal.SIGTERM))
            time.sleep(0.4)
        session_prompt(wsC, sidC, "pcr")
        t0 = time.time()
        m = wsC.wait_for(lambda mm: mm.get("type") in ("error", "session.exited"), timeout=12)
        ok = m is not None and time.time() - t0 < 12
        record("D8.omp crash mid-turn → error, no hang", ok,
               f"pid={pid} got={m and (m.get('type'), m.get('error'))}")
    else:
        record("D8.omp crash mid-turn → error, no hang", False, "no session id")

    ws.send_text({"type": "rig.stats"})
    m = ws.wait_for(lambda mm: mm.get("type") == "rig.stats", timeout=5)
    record("D9.daemon healthy after crash", m is not None and rig.alive(), "")
    for s in (ws, wsA, wsB, wsC):
        s.close()


# ---------------------------------------------------------------------------
# G. session busy flag (sessions.list in-flight indicator)
# ---------------------------------------------------------------------------

def inner_type(m):
    f = m.get("frame")
    return f.get("type") if isinstance(f, dict) else None


def session_busy(ws, sid, timeout=4.0):
    """Last observed busy value for sid, polling sessions.list."""
    t0 = time.time()
    seen = None
    while time.time() - t0 < timeout:
        ws.send_text({"type": "sessions.list"})
        m = ws.wait_for(lambda mm: mm.get("type") == "sessions.list", timeout=3)
        for s in (m or {}).get("sessions", []):
            if s.get("id") == sid:
                seen = s.get("busy")
        if seen is not None:
            return seen
        time.sleep(0.05)
    return seen


def wait_busy(ws, sid, want, timeout=5.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = session_busy(ws, sid, timeout=1.5)
        if v == want:
            return True
        time.sleep(0.05)
    return False


def scenario_prompt(ws, sid, scenario, rid):
    ws.send_text({"type": "session.request", "sessionId": sid,
                  "frame": {"id": rid, "type": "prompt",
                            "text": f"SCENARIO:{scenario}"}})


def test_busy(rig, tok):
    ws, sid, m0 = session_new(rig, tok)
    if not sid:
        record("G1.busy toggles across a turn", False, f"no session: {m0}")
        record("G2.auto_retry_end success keeps busy", False, "no session")
        record("G3.agent_end clears busy", False, "no session")
        return

    # G1: busy flips true mid-turn, false on settle
    scenario_prompt(ws, sid, "busy", "g1")
    saw_true = wait_busy(ws, sid, True, timeout=4.0)
    collect_until(ws, lambda m: inner_type(m) == "prompt_result", timeout=8)
    saw_false = wait_busy(ws, sid, False, timeout=4.0)
    record("G1.busy toggles across a turn", saw_true and saw_false,
           f"saw_busy={saw_true} saw_idle={saw_false}")

    # G2: auto_retry_end{success:true} is mid-turn — busy must survive it
    scenario_prompt(ws, sid, "retry", "g2")
    frames = collect_until(ws, lambda m: inner_type(m) == "auto_retry_end", timeout=8)
    hit = any(inner_type(m) == "auto_retry_end" for m in frames)
    busy_after_retry = session_busy(ws, sid, timeout=2.0)
    collect_until(ws, lambda m: inner_type(m) == "prompt_result", timeout=8)
    settled = wait_busy(ws, sid, False, timeout=4.0)
    record("G2.auto_retry_end success keeps busy",
           hit and busy_after_retry is True and settled,
           f"retry_frame={hit} busy_after_retry={busy_after_retry} settled={settled}")

    # G3: a turn ending on agent_end (no prompt_result) must still clear
    scenario_prompt(ws, sid, "agentend", "g3")
    collect_until(ws, lambda m: inner_type(m) == "agent_end", timeout=8)
    cleared = wait_busy(ws, sid, False, timeout=4.0)
    record("G3.agent_end clears busy", cleared, f"cleared={cleared}")

    ws.close()


# ---------------------------------------------------------------------------
# E. watch correctness
# ---------------------------------------------------------------------------

def test_watch(rig, tok, disp):
    ws = rig.connect(tok)
    msgs = []

    # xfwm4 composites the root black — paint real windows instead
    pb, wb = spawn_color_window(disp, "#2050C8")
    cxb, cyb = win_center(disp, wb)
    blue_up = wait_screen_color(disp, cxb, cyb, (0x20, 0x50, 0xC8))

    ws.send_text({"type": "computer.watch", "intervalMs": 120, "scale": 0.25,
                  "quality": 80, "threshold": 1.0})
    ack = ws.wait_for(lambda m: m.get("type") == "computer.watching", timeout=10, keep=msgs)
    wid = ack and ack.get("watchId")
    early = [m for m in msgs if m.get("type") == "computer.frame" and m.get("watchId") != wid]
    record("E1.watch ack precedes frames for its id", wid is not None and not early,
           f"watchId={wid} stray_frames={len(early)}")

    frame = ws.wait_for(lambda m: m.get("type") == "computer.frame" and m.get("watchId") == wid,
                        timeout=10, keep=msgs)
    rgb = frame_pixel(jpg_pixels(frame["imageBase64"]), cxb, cyb, 0.25) if frame else None
    record("E2.first frame reflects screen color",
           blue_up and rgb_close(rgb, (0x20, 0x50, 0xC8)),
           f"rgb={rgb} want≈(32,80,200) screen_up={blue_up}")

    ws.send_text({"type": "computer.unwatch", "watchId": wid})
    ws.wait_for(lambda m: m.get("type") == "ok", timeout=5, keep=msgs)
    ws.send_text({"type": "computer.watch", "intervalMs": 120, "scale": 1.0,
                  "region": {"x": cxb - 100, "y": cyb - 50, "w": 200, "h": 100}})
    ack2 = ws.wait_for(lambda m: m.get("type") == "computer.watching", timeout=5, keep=msgs)
    wid2 = ack2 and ack2.get("watchId")
    fr = ws.wait_for(lambda m: m.get("type") == "computer.frame" and m.get("watchId") == wid2,
                     timeout=10, keep=msgs)
    rgb3 = mean_rgb(jpg_pixels(fr["imageBase64"])) if fr else None
    record("E3.region watch → frames sized to region",
           fr is not None and fr.get("width") == 200 and fr.get("height") == 100 and
           rgb_close(rgb3, (0x20, 0x50, 0xC8)),
           f"w={fr and fr.get('width')} h={fr and fr.get('height')} rgb={rgb3}")

    # stop → change content → resume → first frame must be the NEW color
    ws.send_text({"type": "computer.unwatch", "watchId": wid2})
    ws.wait_for(lambda m: m.get("type") == "ok", timeout=5, keep=msgs)
    pb.terminate()
    pr, wr = spawn_color_window(disp, "#C02020")
    cxr, cyr = win_center(disp, wr)
    red_up = wait_screen_color(disp, cxr, cyr, (0xC0, 0x20, 0x20))
    ws.send_text({"type": "computer.watch", "intervalMs": 120, "scale": 0.25, "threshold": 0.0})
    ack3 = ws.wait_for(lambda m: m.get("type") == "computer.watching", timeout=5, keep=msgs)
    wid3 = ack3 and ack3.get("watchId")
    fr = ws.wait_for(lambda m: m.get("type") == "computer.frame" and m.get("watchId") == wid3,
                     timeout=10, keep=msgs)
    rgb = frame_pixel(jpg_pixels(fr["imageBase64"]), cxr, cyr, 0.25) if fr else None
    record("E4.resume after change → fresh frame (not stale)",
           red_up and rgb_close(rgb, (0xC0, 0x20, 0x20)),
           f"rgb={rgb} screen_up={red_up}")

    # live change detection: repaint while watching → green frame arrives
    pr.terminate()
    pg, wg = spawn_color_window(disp, "#20C050")
    cxg, cyg = win_center(disp, wg)
    t0 = time.time()
    fr = ws.wait_for(lambda m: m.get("type") == "computer.frame" and
                     m.get("watchId") == wid3 and
                     rgb_close(frame_pixel(jpg_pixels(m["imageBase64"]), cxg, cyg, 0.25),
                               (0x20, 0xC0, 0x50)),
                     timeout=12, keep=msgs)
    record("E5.screen change detected promptly", fr is not None,
           f"in {time.time() - t0:.2f}s")
    ws.send_text({"type": "computer.unwatch", "watchId": wid3})
    pg.terminate()
    ws.close()


# ---------------------------------------------------------------------------
# F. record correctness
# ---------------------------------------------------------------------------

def test_record(rig, tok, disp):
    ws = rig.connect(tok)
    msgs = []

    ws.send_text({"type": "computer.record.start", "intervalMs": 120, "scale": 0.3})
    m = ws.wait_for(lambda mm: mm.get("type") in ("computer.recording", "error"), timeout=10, keep=msgs)
    rid = m and m.get("id")
    ok = bool(rid and m.get("live"))
    record("F1.record.start → live id", ok, f"id={rid} err={m and m.get('error')}")
    if not rid:
        ws.close()
        return

    ws.send_text({"type": "computer.record.start", "intervalMs": 120})
    m2 = ws.wait_for(lambda mm: mm.get("type") in ("computer.recording", "error"), timeout=10, keep=msgs)
    record("F2.start while recording → error", m2 is not None and m2.get("type") == "error",
           f"{m2 and m2.get('error')}")

    time.sleep(1.4)  # ~11 frames at 120ms
    ws.send_text({"type": "computer.record.stop", "id": rid})
    m3 = ws.wait_for(lambda mm: mm.get("type") in ("computer.recorded", "error"), timeout=15, keep=msgs)
    frames_n = (m3 or {}).get("frames", 0)
    dur = (m3 or {}).get("durationMs", 0)
    record("F3.stop → frames+duration recorded",
           m3 is not None and m3.get("type") == "computer.recorded" and frames_n >= 3 and dur >= 500,
           f"frames={frames_n} durationMs={dur} err={m3 and m3.get('error')}")

    ws.send_text({"type": "computer.record.stop", "id": rid})
    m4 = ws.wait_for(lambda mm: mm.get("type") in ("computer.recorded", "error"), timeout=8, keep=msgs)
    record("F4.stop twice → idempotent recorded (no hang)",
           m4 is not None and m4.get("type") == "computer.recorded" and m4.get("id") == rid,
           f"reply={m4 and m4.get('type')} waitedMs={m4 and m4.get('waitedMs')}")

    ws.send_text({"type": "computer.record.list"})
    m5 = ws.wait_for(lambda mm: mm.get("type") == "computer.recordings", timeout=8, keep=msgs)
    ids = [r.get("id") for r in (m5 or {}).get("recordings", [])]
    record("F5.record.list shows recording", rid in ids, f"ids={ids[:5]}")

    ws.send_text({"type": "computer.record.get", "id": rid, "format": "meta"})
    m6 = ws.wait_for(lambda mm: mm.get("type") in ("computer.recording", "error"), timeout=8, keep=msgs)
    record("F6.record.get meta consistent",
           m6 is not None and m6.get("id") == rid and int(m6.get("frames", 0)) == int(frames_n),
           f"frames={m6 and m6.get('frames')} want={frames_n}")

    ws.send_text({"type": "computer.record.frames", "id": rid, "from": 1, "count": 3})
    m7 = ws.wait_for(lambda mm: mm.get("type") == "computer.record.frames", timeout=10, keep=msgs)
    frs = (m7 or {}).get("frames", [])
    record("F7.record.frames from=1 count=3",
           m7 is not None and len(frs) == 3 and frs[0].get("seq") == 1,
           f"n={len(frs)}")

    ws.send_text({"type": "computer.record.frames", "id": rid, "from": 99999, "count": 5})
    m8 = ws.wait_for(lambda mm: mm.get("type") == "computer.record.frames", timeout=8, keep=msgs)
    record("F8.record.frames out-of-range → empty",
           m8 is not None and m8.get("count") == 0 and not m8.get("frames"),
           f"count={m8 and m8.get('count')}")

    for bad in ["", "../etc", "nonexistent-xyz"]:
        ws.send_text({"type": "computer.record.get", "id": bad})
        mm = ws.wait_for(lambda q: q.get("type") == "error", timeout=5, keep=msgs)
    record("F9.record.get bad ids → errors, alive", rig.alive(), "")

    rdir = os.path.join(rig.home, ".rig", "recordings", rid)
    with open(os.path.join(rdir, "meta.json"), "w") as f:
        f.write("{corrupt!!! not json")
    ws.send_text({"type": "computer.record.list"})
    m9 = ws.wait_for(lambda mm: mm.get("type") == "computer.recordings", timeout=8, keep=msgs)
    ids2 = [r.get("id") for r in (m9 or {}).get("recordings", [])]
    record("F10.corrupt meta.json → list survives, frames recounted",
           rid in ids2 and rig.alive(), f"ids={ids2[:5]}")

    ws.send_text({"type": "computer.record.delete", "id": rid})
    m10 = ws.wait_for(lambda mm: mm.get("type") in ("computer.deleted", "ok", "error"), timeout=8, keep=msgs)
    gone = not os.path.exists(rdir)
    record("F11.record.delete removes dir", bool(m10) and gone,
           f"reply={m10 and m10.get('type')} exists={os.path.exists(rdir)}")
    ws.close()


# ---------------------------------------------------------------------------
# P. pass-2: mid-turn lifecycle, warm pool, multi-screen
# ---------------------------------------------------------------------------

def inner_id(m):
    f = m.get("frame")
    return f.get("id") if isinstance(f, dict) else None


def test_midturn(rig, tok):
    # P1: a second prompt fired mid-turn is queued at the child — both turns
    # complete, results arrive in issue order, seqs stay contiguous.
    # NOTE: session_request rewrites client ids to omprd-N, so omprd-1 is the
    # SCENARIO:busy turn and omprd-2 the interleaved burst.
    ws, sid, m0 = session_new(rig, tok)
    if not sid:
        for n in ("P1.prompt mid-turn queued, ordered results",
                  "P2.session.kill mid-turn → exited + request errors",
                  "P3.SIGKILL mid-turn → exited, ring contiguous"):
            record(n, False, f"no session: {m0}")
        return
    scenario_prompt(ws, sid, "busy", "pbusy")   # ~0.9s turn
    time.sleep(0.15)
    session_prompt(ws, sid, "p2")               # lands while turn 1 still streaming
    got = collect_until(
        ws, lambda m: inner_type(m) == "prompt_result" and inner_id(m) == "omprd-2",
        timeout=25)
    results = [inner_id(m) for m in got if inner_type(m) == "prompt_result"]
    seqs = seqs_for(got, sid)
    busy_bcast = [m for m in got if m.get("type") == "session.busy"]
    record("P1.prompt mid-turn queued, ordered results",
           results == ["omprd-1", "omprd-2"] and seqs == sorted(seqs)
           and len(seqs) == len(set(seqs)) and len(seqs) >= 200,
           f"results={results} seqs={len(seqs)} busybcast={len(busy_bcast)}")

    # P2: protocol-level kill mid-turn → session.exited, then request errors.
    ws2, sid2, _ = session_new(rig, tok)
    scenario_prompt(ws2, sid2, "busy", "k1")
    time.sleep(0.25)                            # mid-turn of the ~0.9s scenario
    ws2.send_text({"type": "session.kill", "sessionId": sid2})
    got2 = collect_until(ws2, lambda m: m.get("type") in ("session.exited", "error"),
                         timeout=8)
    exited = any(m.get("type") == "session.exited" for m in got2)
    time.sleep(0.5)                             # reaper sweep removes the session
    ws2.send_text({"type": "session.request", "sessionId": sid2,
                   "frame": {"type": "prompt", "text": "after-kill"}})
    m = ws2.wait_for(lambda mm: mm.get("type") == "error", timeout=6)
    seqs2 = seqs_for(got2, sid2)
    record("P2.session.kill mid-turn → exited + request errors",
           exited and m is not None and seqs2 == sorted(seqs2),
           f"exited={exited} err={m and m.get('error')} seqs={len(seqs2)}")
    ws2.close()

    # P3: SIGKILL mid-turn (omp crash) → exited broadcast, request errors,
    # every delivered frame valid JSON, seqs contiguous 1..k (a mid-printf
    # death must not leak a torn line into the ring).
    ws3, sid3, _ = session_new(rig, tok)
    ws3.send_text({"type": "rig.status"})
    st = ws3.wait_for(lambda m: m.get("type") == "rig.status", timeout=5)
    pid3 = next((s.get("pid") for s in (st or {}).get("sessions", [])
                 if s.get("id") == sid3), None)
    scenario_prompt(ws3, sid3, "busy", "k2")
    time.sleep(0.25)
    if pid3:
        os.kill(int(pid3), getattr(signal, "SIGKILL", signal.SIGTERM))
    got3 = collect_until(ws3, lambda m: m.get("type") == "session.exited", timeout=8)
    exited3 = any(m.get("type") == "session.exited" for m in got3)
    time.sleep(0.5)
    ws3.send_text({"type": "session.request", "sessionId": sid3,
                   "frame": {"type": "prompt", "text": "zombie"}})
    m = ws3.wait_for(lambda mm: mm.get("type") == "error", timeout=6)
    seqs3 = seqs_for(got3, sid3)
    # The ring's earliest seq (the omprd-open response) can be consumed by the
    # rig.status wait_for above on Windows, where the open_session reply lands
    # before the status reply; assert the delivered seqs are gap-free rather
    # than anchored at 1.
    contiguous = bool(seqs3) and seqs3 == list(range(seqs3[0], seqs3[0] + len(seqs3)))
    ws3.send_text({"type": "rig.stats"})
    healthy = ws3.wait_for(lambda mm: mm.get("type") == "rig.stats", timeout=5) is not None
    record("P3.SIGKILL mid-turn → exited, ring contiguous",
           exited3 and m is not None and contiguous and healthy,
           f"exited={exited3} err={m and m.get('error')} seqs={len(seqs3)} contiguous={contiguous}")
    for c in (ws3, ws):
        c.close()


def test_multiscreen(rig, tok):
    if IS_WIN:
        # Xvfb multi-screen doesn't exist on Windows — the win backend reports
        # one virtual display; multi-monitor space coverage is not portable here.
        print("SKIP P4-P6 multi-screen (Xvfb-only)", flush=True)
        return
    """Two-screen Xvfb :98 — the '.screen' suffix must hold end-to-end:
    state/capture report screen 1's own geometry and clicks warp the pointer
    onto that screen (bug: motion() used -1/DefaultScreen → shots read
    screen 1 while input landed on screen 0). True RandR multi-output
    offsets (one screen, several CRTCs, negative origins) can't be faked on
    Xvfb — it exposes a single CRTC — so this exercises the multi-head path
    that exists, and the offset gap is documented, not hidden."""
    xv = subprocess.Popen(["Xvfb", ":98", "-screen", "0", "800x600x24",
                           "-screen", "1", "640x480x24", "-nolisten", "tcp"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            if os.path.exists("/tmp/.X11-unix/X98"):
                break
            time.sleep(0.1)
        ws = rig.connect(tok)
        ws.send_text({"type": "computer.state", "display": ":98.1"})
        st = ws.wait_for(lambda m: m.get("type") == "computer.state", timeout=10)
        res = (st or {}).get("resolution")
        px = (st or {}).get("pixelResolution")
        record("P4.multi-screen: state reports screen-1 geometry",
               res == [640, 480] and px == [640, 480],
               f"resolution={res} pixel={px} scaleFactor={(st or {}).get('scaleFactor')}")

        # P5: click aimed at :98.1 — XTest's screen arg is honored only
        # when the server supports cross-screen warps; multi-screen Xvfb
        # honors it inconsistently (xdotool itself fails standalone). The
        # bar: coords must land pixel-exact on SOME screen, and the daemon
        # must match xdotool's demonstrated ceiling in the same run.
        def cursor_screens():
            """Which screen holds the pointer + its coords, via the
            daemon's own query_pointer (native=True iff the pointer is on
            that screen's root; the xdotool fallback carries screen=N)."""
            out = {}
            for d in (":98.0", ":98.1"):
                ws.send_text({"type": "computer.cursor", "display": d})
                m = ws.wait_for(lambda mm: mm.get("type") == "computer.cursor",
                                timeout=8)
                if m:
                    out[d] = (m.get("method"), m.get("x"), m.get("y"),
                              m.get("screen"))
            return out

        def landed():
            info = cursor_screens()
            for scr, d in enumerate((":98.0", ":98.1")):
                if info.get(d, (None,))[0] == "native":
                    return scr, info[d][1], info[d][2], info
            # fallback reply names the real screen
            for d in (":98.0", ":98.1"):
                v = info.get(d)
                if v and v[0] == "xdotool" and v[3] in (0, 1):
                    return v[3], v[1], v[2], info
            return -1, -1, -1, info

        ws.send_text({"type": "computer.actions", "display": ":98.1",
                      "steps": [{"action": "click", "x": 100, "y": 50}]})
        ws.wait_for(lambda m: m.get("type") == "computer.actions", timeout=10)
        time.sleep(0.3)
        s1, x1, y1, _ = landed()
        xcmd(["xdotool", "mousemove", "--screen", "1", "100", "50"], ":98")
        time.sleep(0.3)
        xs, xx, xy, _ = landed()
        ws.send_text({"type": "computer.actions", "display": ":98.1",
                      "steps": [{"action": "click", "x": 100, "y": 50}]})
        ws.wait_for(lambda m: m.get("type") == "computer.actions", timeout=10)
        time.sleep(0.3)
        s2, x2, y2, info = landed()
        coords_exact = all(abs(v - 100) <= 2 for v in (x1, x2)) and \
            all(abs(v - 50) <= 2 for v in (y1, y2))
        server_can_cross = xs == 1
        daemon_ok = coords_exact and (
            s1 == 1 or s2 == 1 or not server_can_cross)
        record("P5.multi-screen: click honors display.screen up to server ceiling",
               daemon_ok,
               f"daemon=(scr{s1},{x1},{y1})/(scr{s2},{x2},{y2}) "
               f"xdotool=(scr{xs},{xx},{xy}) cross={'yes' if server_can_cross else 'no'}"
               f" want=(100,50)@:98.1")
        # honesty check: cursor query on a screen the pointer is not on
        # must not misreport that screen — the fallback reply names the
        # pointer's real screen.
        v = cursor_screens().get(":98.1" if s2 == 0 else ":98.0")
        record("P5b.multi-screen: cursor on other screen reports real screen",
               v is not None and v[0] == "xdotool" and v[3] == s2,
               f"reply={v} pointer_on=scr{s2}")

        ws.send_text({"type": "computer.screenshot", "display": ":98.1",
                      "format": "png", "scale": 1.0})
        m = ws.wait_for(lambda m: m.get("type") == "computer.screenshot", timeout=10)
        img = jpg_pixels(m["imageBase64"]) if m and m.get("imageBase64") else None
        record("P6.multi-screen: capture is screen-1 pixels",
               img is not None and img.size == (640, 480),
               f"size={img and img.size}")

        # restore the agent display so later sections keep hitting :99
        ws.send_text({"type": "computer.state", "display": ":99"})
        ws.wait_for(lambda m: m.get("type") == "computer.state", timeout=10)
        ws.close()
    finally:
        xv.terminate()
        try:
            xv.wait(timeout=5)
        except Exception:
            xv.kill()


def test_warm_pool(args):
    """Warm spare pool: first session.new cold-spawns + refills; a second
    same-sig new adopts the spare (warm:true). Concurrent news all start —
    the pool caps spares, never blocks callers."""
    rig2 = Rig(args, port=args.port + 2, warm=True)
    try:
        tok2 = rig2.pair()
        ws = rig2.connect(tok2)
        ws.send_text({"type": "session.new", "cwd": rig2.home})
        m1 = ws.wait_for(lambda m: m.get("type") in ("session.started", "error"), timeout=15)
        sid1 = m1 and m1.get("sessionId")
        time.sleep(2.0)  # spare finishes its handshake → adoptable
        ws.send_text({"type": "session.new", "cwd": rig2.home})
        m2 = ws.wait_for(lambda m: m.get("type") in ("session.started", "error"), timeout=15)
        record("P7.warm spare adopted (second same-sig new)",
               m1 is not None and m1.get("type") == "session.started"
               and m2 is not None and m2.get("type") == "session.started"
               and m2.get("warm") is True,
               f"first.warm={m1 and m1.get('warm')} second.warm={m2 and m2.get('warm')}")

        conns, sids = [], []
        for _ in range(4):
            c = rig2.connect(tok2)
            conns.append(c)
            c.send_text({"type": "session.new", "cwd": rig2.home})
        for c in conns:
            m = c.wait_for(lambda m: m.get("type") in ("session.started", "error"), timeout=15)
            if m and m.get("sessionId"):
                sids.append(m["sessionId"])
            c.close()
        record("P8.4 concurrent session.new → all start, distinct",
               len(sids) == 4 and len(set(sids)) == 4,
               f"started={len(sids)} distinct={len(set(sids))}")
        if sid1:
            ws.send_text({"type": "session.kill", "sessionId": sid1})
        ws.close()
    finally:
        rig2.stop()


# ---------------------------------------------------------------------------

def test_token_restart(args, tok, home):
    """token survives a daemon restart via devices.json."""
    rig2 = Rig(args, home=home, port=args.port + 1)
    try:
        ws = rig2.connect(tok)
        ws.send_text({"type": "rig.stats"})
        m = ws.wait_for(lambda mm: mm.get("type") == "rig.stats", timeout=5)
        ws.close()
        record("C12.token survives daemon restart (devices.json)", m is not None, "")
    finally:
        rig2.stop()


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--bin", default=os.path.join(
        here, "..", "daemon", "omprd.exe" if IS_WIN else "omprd"))
    ap.add_argument("--omp-bin", default=os.path.join(
        here, "fake-omp.cmd" if IS_WIN else "fake-omp.sh"))
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--display", default="main" if IS_WIN else ":99")
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    args.bin = os.path.abspath(args.bin)
    args.omp_bin = os.path.abspath(args.omp_bin)
    try:
        os.chmod(args.omp_bin, 0o755)
    except OSError:
        pass  # Windows has no exec bit — .cmd runs via cmd.exe

    rig = Rig(args)
    print(f"# omprd pid={rig.proc.pid} port={args.port} display={args.display} HOME={rig.home}", flush=True)
    tok = rig.pair()
    print("# paired: token minted", flush=True)

    try:
        test_coordinates(rig, tok, args.display)
        test_input(rig, tok, args.display)
        test_launch(rig, tok, args.display)
        test_protocol(rig, tok)
        test_sessions(rig, tok)
        test_busy(rig, tok)
        test_watch(rig, tok, args.display)
        test_record(rig, tok, args.display)
        test_midturn(rig, tok)
        test_multiscreen(rig, tok)
        home = rig.home
        rig.stop()
        test_warm_pool(args)
        test_token_restart(args, tok, home)
    finally:
        if rig.alive():
            rig.stop()
        print(f"# daemon log tail:\n{rig.log_tail(15)}", flush=True)

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = [n for n, ok, _ in RESULTS if not ok]
    print(f"\n==== {passed}/{len(RESULTS)} passed, {len(failed)} failed ====")
    for n in failed:
        print(f"  FAIL {n}")
    sys.exit(len(failed))


if __name__ == "__main__":
    main()
