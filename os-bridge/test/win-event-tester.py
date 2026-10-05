#!/usr/bin/env python3
"""
win-event-tester.py — the Windows twin of the suite's `xev` + `xterm -bg`
windows, in one script (stdlib + ctypes only, zero deps).

  - a real overlapped window that logs every input message to --log,
    one event per line: key down/up, char, button down/up/dblclk,
    motion, wheel — the Windows equivalents of xev's KeyPress/KeyRelease/
    ButtonPress/ButtonRelease/MotionNotify stream.
  - --bg #RRGGBB paints the client area a solid color (xterm -bg role for
    the watch/pixel tests).

Log format (t = GetMessageTime ms):
    hwnd <n>
    key down <name> t=..
    key up <name> t=..
    char <c> t=..            (WM_CHAR — what a text field actually receives)
    button down <n> t=..     (1=L 2=M 3=R)
    button dbl <n> t=..      (WM_*BUTTONDBLCLK)
    button up <n> t=..
    motion x=.. y=.. t=..    (virtual-screen coords)
    wheel <delta> t=..       (±120 per notch)
"""

import argparse
import ctypes
import sys
import time
from ctypes import wintypes

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32
kernel32.GetModuleHandleW.restype = wintypes.HMODULE

# 64-bit-correct prototypes — without them ctypes truncates/overflows handles
LRESULT = ctypes.c_ssize_t
user32.DefWindowProcW.restype = LRESULT
user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT,
                                  wintypes.WPARAM, wintypes.LPARAM]
user32.CreateWindowExW.restype = wintypes.HWND
user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR,
                                   wintypes.LPCWSTR, wintypes.DWORD,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_int, wintypes.HWND, wintypes.HMENU,
                                   wintypes.HINSTANCE, wintypes.LPVOID]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.FillRect.argtypes = [wintypes.HDC, ctypes.POINTER(wintypes.RECT),
                            wintypes.HBRUSH]
user32.BeginPaint.restype = wintypes.HDC
user32.BeginPaint.argtypes = [wintypes.HWND, ctypes.c_void_p]
user32.EndPaint.argtypes = [wintypes.HWND, ctypes.c_void_p]
user32.PostQuitMessage.argtypes = [ctypes.c_int]
user32.LoadCursorW.restype = wintypes.HANDLE
user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR]
gdi32.CreateSolidBrush.restype = wintypes.HBRUSH
gdi32.CreateSolidBrush.argtypes = [wintypes.COLORREF]
user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, wintypes.LPDWORD]
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                             wintypes.UINT, wintypes.UINT]
user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.RegisterClassW.argtypes = [ctypes.c_void_p]
user32.UpdateWindow.argtypes = [wintypes.HWND]
user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]

try:
    user32.SetProcessDPIAware()
except AttributeError:
    pass  # single-monitor 100%-DPI rigs never need it

# ---- constants ---------------------------------------------------------------
WM_KEYDOWN, WM_KEYUP, WM_CHAR = 0x0100, 0x0101, 0x0102
WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK = 0x0201, 0x0202, 0x0203
WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK = 0x0204, 0x0205, 0x0206
WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK = 0x0207, 0x0208, 0x0209
WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_MOUSEHWHEEL = 0x0200, 0x020A, 0x020E
WM_DESTROY, WM_CLOSE, WM_PAINT, WM_ERASEBKGND = 0x0002, 0x0010, 0x000F, 0x0014
WS_OVERLAPPEDWINDOW = 0x00CF0000
WS_EX_TOPMOST = 0x00000008
HWND_TOPMOST = -1
SWP_NOMOVE_NOSIZE = 0x0002 | 0x0001
SW_SHOW = 5
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
MAPVK_VK_TO_CHAR = 2
PM_REMOVE = 0x0001

WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT,
                             wintypes.WPARAM, wintypes.LPARAM)

VK_NAMES = {
    0x08: "backspace", 0x09: "tab", 0x0D: "return", 0x1B: "escape",
    0x10: "shift", 0x11: "control", 0x12: "alt", 0x20: "space",
    0x21: "pageup", 0x22: "pagedown", 0x23: "end", 0x24: "home",
    0x25: "left", 0x26: "up", 0x27: "right", 0x28: "down", 0x2E: "delete",
}
for i in range(1, 13):
    VK_NAMES[0x6F + i] = f"f{i}"


def vk_name(wparam):
    if wparam in VK_NAMES:
        return VK_NAMES[wparam]
    c = user32.MapVirtualKeyW(wparam, MAPVK_VK_TO_CHAR)
    ch = chr(c & 0xFFFF) if c else ""
    if ch and ch.isprintable():
        return ch.lower()
    return f"vk{wparam:02X}"


def now_ms():
    return user32.GetMessageTime() & 0xFFFFFFFF


def screen_xy(lparam):
    # lParam = client coords; convert to virtual-screen coords (suite space)
    x = ctypes.c_short(lparam & 0xFFFF).value
    y = ctypes.c_short(lparam >> 16).value
    pt = wintypes.POINT(x, y)
    user32.ClientToScreen(g_state["hwnd"], ctypes.byref(pt))
    return pt.x - user32.GetSystemMetrics(SM_XVIRTUALSCREEN), \
           pt.y - user32.GetSystemMetrics(SM_YVIRTUALSCREEN)


g_state = {"logf": None, "hwnd": None}


def log(line):
    f = g_state["logf"]
    if f:
        f.write(line + "\n")
        f.flush()


BUTTON_MSGS = {
    WM_LBUTTONDOWN: ("down", 1), WM_LBUTTONUP: ("up", 1), WM_LBUTTONDBLCLK: ("dbl", 1),
    WM_MBUTTONDOWN: ("down", 2), WM_MBUTTONUP: ("up", 2), WM_MBUTTONDBLCLK: ("dbl", 2),
    WM_RBUTTONDOWN: ("down", 3), WM_RBUTTONUP: ("up", 3), WM_RBUTTONDBLCLK: ("dbl", 3),
}


def wnd_proc(hwnd, msg, wparam, lparam):
    if msg == WM_KEYDOWN:
        log(f"key down {vk_name(wparam)} t={now_ms()}")
    elif msg == WM_KEYUP:
        log(f"key up {vk_name(wparam)} t={now_ms()}")
    elif msg == WM_CHAR:
        cp = wparam & 0xFFFF
        ch = chr(cp)
        log(f"char {ch if ch.isprintable() else '\\x%02X' % cp} t={now_ms()}")
    elif msg in BUTTON_MSGS:
        kind, btn = BUTTON_MSGS[msg]
        log(f"button {kind} {btn} t={now_ms()}")
    elif msg == WM_MOUSEMOVE:
        x, y = screen_xy(lparam)
        log(f"motion x={x} y={y} t={now_ms()}")
    elif msg == WM_MOUSEWHEEL:
        delta = ctypes.c_short((wparam >> 16) & 0xFFFF).value
        log(f"wheel {delta:+d} t={now_ms()}")
    elif msg == WM_MOUSEHWHEEL:
        delta = ctypes.c_short((wparam >> 16) & 0xFFFF).value
        log(f"hwheel {delta:+d} t={now_ms()}")
    elif msg == WM_ERASEBKGND and g_state.get("brush"):
        rc = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rc))
        user32.FillRect(wparam, ctypes.byref(rc), g_state["brush"])
        return 1
    elif msg == WM_PAINT and g_state.get("brush"):
        ps = PAINTSTRUCT()
        hdc = user32.BeginPaint(hwnd, ctypes.byref(ps))
        rc = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rc))
        user32.FillRect(hdc, ctypes.byref(rc), g_state["brush"])
        user32.EndPaint(hwnd, ctypes.byref(ps))
        return 0
    elif msg == WM_DESTROY:
        user32.PostQuitMessage(0)
        return 0
    return user32.DefWindowProcW(hwnd, msg, wparam, lparam)


class PAINTSTRUCT(ctypes.Structure):
    _fields_ = [
        ("hdc", wintypes.HDC),
        ("fErase", wintypes.BOOL),
        ("rcPaint", wintypes.RECT),
        ("fRestore", wintypes.BOOL),
        ("fIncUpdate", wintypes.BOOL),
        ("rgbReserved", wintypes.BYTE * 32),
    ]


class WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HANDLE),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
    ]


def force_foreground(hwnd):
    """Same dance win.hpp does — a background-spawned process can't take
    foreground unless its input is attached to the current fg thread."""
    fg = user32.GetForegroundWindow()
    fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    me = kernel32.GetCurrentThreadId()
    attached = fg_tid and fg_tid != me and user32.AttachThreadInput(me, fg_tid, True)
    user32.ShowWindow(hwnd, SW_SHOW)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    if attached:
        user32.AttachThreadInput(me, fg_tid, False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", default="Event Tester")
    ap.add_argument("--log", required=True)
    ap.add_argument("--geom", default="500x400+150+150")  # WxH+X+Y (screen px)
    ap.add_argument("--bg", default="")
    ap.add_argument("--no-topmost", action="store_true")
    args = ap.parse_args()

    wh, xy = args.geom.split("+", 1)
    w, h = (int(v) for v in wh.split("x"))
    x, y = (int(v) for v in xy.split("+"))

    logf = open(args.log, "w", buffering=1)  # line-buffered
    g_state["logf"] = logf

    if args.bg:
        rgb = int(args.bg.lstrip("#"), 16)
        # COLORREF is 0x00BBGGRR — byte0=R, byte2=B (opposite of #RRGGBB)
        g_state["brush"] = gdi32.CreateSolidBrush(
            ((rgb >> 16) & 0xFF) | (rgb & 0xFF00) | ((rgb & 0xFF) << 16))

    cls_name = "RigEventTester"
    wc = WNDCLASSW()
    wc.lpfnWndProc = WNDPROC(wnd_proc)
    wc.hInstance = kernel32.GetModuleHandleW(None)
    wc.hbrBackground = g_state.get("brush") or wintypes.HBRUSH(5 + 1)  # COLOR_WINDOW+1
    wc.lpszClassName = cls_name
    wc.hCursor = user32.LoadCursorW(None, wintypes.LPCWSTR(32512))  # IDC_ARROW
    if not user32.RegisterClassW(ctypes.byref(wc)):
        # class may already be registered by a sibling tester — that's fine
        if kernel32.GetLastError() not in (1410,):  # ERROR_CLASS_ALREADY_EXISTS
            log("registerclass failed")
            sys.exit(2)

    exstyle = 0 if args.no_topmost else WS_EX_TOPMOST
    hwnd = user32.CreateWindowExW(
        exstyle, cls_name, args.title, WS_OVERLAPPEDWINDOW,
        x, y, w, h, None, None, wintypes.HINSTANCE(wc.hInstance), None)
    if not hwnd:
        log("createwindow failed")
        sys.exit(3)
    g_state["hwnd"] = hwnd
    log(f"hwnd {int(ctypes.cast(hwnd, ctypes.c_void_p).value or 0)}")

    force_foreground(hwnd)
    user32.UpdateWindow(hwnd)

    msg = wintypes.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))
    return 0


if __name__ == "__main__":
    sys.exit(main())
