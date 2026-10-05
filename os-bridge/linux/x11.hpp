// remote — native X11 backend (v0.4).
//
// Everything the computer-use pipeline needs, with NO subprocess spawns and
// NO compile-time X dependencies: libX11/libXtst/libXext are dlopen'd at
// runtime and their function pointers resolved once. Xlib is single-threaded,
// so every call goes through one global mutex.
//
//   capture : XShmGetImage (ZPixmap) → RGB8 → downscale → PNG/JPEG via
//             libpng-l1/turbojpeg (dlopen'd) or stb; XGetImage fallback when
//             MIT-SHM is unavailable (real displays, XWayland)
//   input   : XTestFake{Motion,Button,Key}Event, sub-millisecond injection
//   typing  : keysym → keycode via XKeysymToKeycode + shift detection through
//             XGetKeyboardMapping; missing keysyms (unicode > latin-1) get a
//             temporary keycode remap via XChangeKeyboardMapping
//   windows : EWMH _NET_CLIENT_LIST / _NET_WM_NAME / _NET_ACTIVE_WINDOW
//   control : EWMH _NET_ACTIVE_WINDOW / _NET_CLOSE_WINDOW client messages
//
// ABI mirrors below (XImage, XShmSegmentInfo, XClientMessageEvent) match the
// stable libX11 layouts on x86-64/aarch64; the daemon falls back to the
// subprocess path whenever any of this is unavailable.
#pragma once

#include "../daemon/crypto.hpp"

#include <dlfcn.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STB_IMAGE_WRITE_STATIC
// vendored header: unused-function/deprecated noise is not ours to fix
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-function"
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#include "../daemon/stb_image_write.h"
#pragma GCC diagnostic pop

namespace rig {

// set by our X error handler; Xlib's default handler would exit the daemon
inline std::atomic<int> g_x_error_count{0};

// ---- stable libX11 ABI mirrors ------------------------------------------------

using XDisplay = struct _XDisplay;   // opaque
using Window = unsigned long;
using Atom = unsigned long;
using XID = unsigned long;
using Bool = int;
using Status = int;
using KeyCode = unsigned int;
using KeySym = unsigned long;

struct XImageMirror {
	int width, height;
	int xoffset;
	int format;            // ZPixmap == 2
	char* data;
	int byte_order;        // 0 = LSBFirst
	int bitmap_unit;
	int bitmap_bit_order;
	int bitmap_pad;
	int depth;
	int bytes_per_line;
	int bits_per_pixel;
	unsigned long red_mask, green_mask, blue_mask;
	void* obdata;
	void* f[5];            // create/destroy/get_pixel/put_pixel/sub_image/add_pixel
};

struct XShmSegmentInfoMirror {
	int shmid;
	char* shmaddr;
	Bool readOnly;
};

struct XClientMessageMirror {         // first member of the XEvent union
	int type;                          // 33 == ClientMessage
	unsigned long serial;
	Bool send_event;
	XDisplay* display;
	Window window;
	Atom message_type;
	int format;
	union {
		char b[20];
		short s[10];
		long l[5];
	} data;
};

struct MemImage {
	int width = 0, height = 0;
	std::vector<uint8_t> rgb;          // packed RGB8, width*height*3
};

// ---- the backend ----------------------------------------------------------------

struct X11Backend {
	void* lib_x11 = nullptr;
	void* lib_xtst = nullptr;
	void* lib_xext = nullptr;
	bool tried = false;
	bool ok = false;
	bool has_shm = false;
	bool has_xtest = false;
	std::string error;

	std::mutex xmutex;                              // Xlib is single-threaded
	std::map<std::string, XDisplay*> displays;

	// libX11
	XDisplay* (*XOpenDisplay)(const char*) = nullptr;
	int (*XCloseDisplay)(XDisplay*) = nullptr;
	int (*XFlush)(XDisplay*) = nullptr;
	int (*XSync)(XDisplay*, Bool) = nullptr;
	Window (*XRootWindow)(XDisplay*, int) = nullptr;
	int (*XScreenNumberOfScreen)(void*) = nullptr;
	void* (*XScreenOfDisplay)(XDisplay*, int) = nullptr;
	int (*XScreenCount)(XDisplay*) = nullptr;
	Bool (*XQueryPointer)(XDisplay*, Window, Window*, Window*, int*, int*, int*, int*, unsigned int*) = nullptr;
	Status (*XGetGeometry)(XDisplay*, Window, Window*, int*, int*, unsigned int*, unsigned int*, unsigned int*, unsigned int*) = nullptr;
	int (*XTranslateCoordinates)(XDisplay*, Window, Window, int, int, int*, int*, Window*) = nullptr;
	Atom (*XInternAtom)(XDisplay*, const char*, Bool) = nullptr;
	int (*XGetWindowProperty)(XDisplay*, Window, Atom, long, long, Bool, unsigned long, unsigned long*, int*, unsigned long*, unsigned long*, unsigned char**) = nullptr;
	int (*XFree)(void*) = nullptr;
	int (*XSendEvent)(XDisplay*, Window, Bool, long, XClientMessageMirror*) = nullptr;
	int (*XSetInputFocus)(XDisplay*, Window, int, int) = nullptr;
	int (*XRaiseWindow)(XDisplay*, Window) = nullptr;
	KeySym* (*XGetKeyboardMapping)(XDisplay*, KeyCode, int, int*) = nullptr;
	KeyCode (*XKeysymToKeycode)(XDisplay*, KeySym) = nullptr;
	KeySym (*XStringToKeysym)(const char*) = nullptr;
	int (*XDisplayKeycodes)(XDisplay*, int*, int*) = nullptr;
	int (*XChangeKeyboardMapping)(XDisplay*, int, int, KeySym*, int) = nullptr;
	// capture
	XImageMirror* (*XGetImage)(XDisplay*, Window, int, int, unsigned int, unsigned int, unsigned long, int) = nullptr;
	// libXext (MIT-SHM)
	int (*XShmQueryExtension)(XDisplay*) = nullptr;
	Bool (*XShmGetImage)(XDisplay*, Window, XImageMirror*, int, int, unsigned long) = nullptr;
	int (*XShmAttach)(XDisplay*, XShmSegmentInfoMirror*) = nullptr;
	int (*XShmDetach)(XDisplay*, XShmSegmentInfoMirror*) = nullptr;
	XImageMirror* (*XShmCreateImage)(XDisplay*, void*, unsigned int, int, char*,
	                                 XShmSegmentInfoMirror*, unsigned int, unsigned int) = nullptr;
	// error containment
	int (*XSetErrorHandler)(int (*)(XDisplay*, void*)) = nullptr;
	int (*XSetIOErrorHandler)(int (*)(XDisplay*)) = nullptr;

	// libpng/turbojpeg (fast path encoders; stb stays as fallback)
	bool used_libpng = false;
	bool used_turbojpeg = false;
	const char* backend = "x11";
	const char* capture_encoder() const {
		return used_turbojpeg ? "turbojpeg" : used_libpng ? "libpng-l1" : "stb";
	}
	void* lib_png = nullptr;
	unsigned (*png_access_version_number)() = nullptr;
	void* (*png_create_write_struct)(const char*, void*, void*, void*) = nullptr;
	void* (*png_create_info_struct)(void*) = nullptr;
	void (*png_destroy_write_struct)(void**, void**) = nullptr;
	void (*png_set_IHDR)(void*, void*, unsigned int, unsigned int, int, int, int, int, int) = nullptr;
	void (*png_set_compression_level)(void*, int) = nullptr;
	void (*png_set_write_fn)(void*, void*, void (*)(void*, unsigned char*, size_t), void (*)(void*)) = nullptr;
	void (*png_write_info)(void*, void*) = nullptr;
	void (*png_write_row)(void*, unsigned char*) = nullptr;
	void (*png_write_end)(void*, void*) = nullptr;
	// static: the write sink is a non-capturing lambda — it can only reach
	// namespace/qualified names, not `this`
	inline static void* (*png_get_io_ptr)(void*) = nullptr;
	// turbojpeg (fast JPEG; stb stays as fallback)
	void* lib_tj = nullptr;
	void* (*tjInitCompress_p)() = nullptr;
	int (*tjCompress2_p)(void*, const unsigned char*, int, int, int, int,
	                     unsigned char**, unsigned long*, int, int, int) = nullptr;
	void (*tjFree_p)(unsigned char*) = nullptr;
	int (*tjDestroy_p)(void*) = nullptr;
	// libXtst
	int (*XTestFakeMotionEvent)(XDisplay*, int, int, int, unsigned long) = nullptr;
	int (*XTestFakeButtonEvent)(XDisplay*, unsigned int, Bool, unsigned long) = nullptr;
	int (*XTestFakeKeyEvent)(XDisplay*, unsigned int, Bool, unsigned long) = nullptr;

	// libXss — screensaver/DPMS suspend toggle for stay_awake
	void* lib_xss = nullptr;
	bool xss_tried = false;
	Bool (*XScreenSaverSuspend)(XDisplay*, Bool) = nullptr;
	bool awake_held = false;
	bool xss_held = false; // XScreenSaverSuspend actually engaged on a real display

	// OS-level sleep inhibitor (stay_awake): logind's Inhibit("sleep",…) over
	// D-Bus via a dlopen'd libsystemd — the lock lives in the fd we keep.
	// Fallbacks, in order: a `systemd-inhibit … sleep infinity` child (same
	// inhibitor, different owner — dies with the daemon), then XScreenSaver
	// suspend (screen blanking only — honest "xss" method, NOT sleep-proof).
	void* lib_systemd = nullptr;
	bool sd_tried = false;
	int (*sd_bus_open_system_p)(void**) = nullptr;
	int (*sd_bus_call_method_p)(void*, const char*, const char*, const char*, const char*,
	                            void*, void**, const char*, ...) = nullptr;
	int (*sd_bus_message_read_p)(void*, const char*, ...) = nullptr;
	void* (*sd_bus_unref_p)(void*) = nullptr;
	void* (*sd_bus_message_unref_p)(void*) = nullptr;
	int inhibit_fd = -1;          // held logind lock; closing releases it
	void* sd_bus_held = nullptr;  // the bus the fd came over (kept alive)
	pid_t inhibit_pid = -1;       // systemd-inhibit fallback child

	bool init() {
		if (tried) return ok;
		tried = true;
		lib_x11 = dlopen("libX11.so.6", RTLD_NOW | RTLD_GLOBAL);
		if (!lib_x11) { error = "libX11.so.6 not loadable"; return false; }
		lib_xtst = dlopen("libXtst.so.6", RTLD_NOW);
		lib_xext = dlopen("libXext.so.6", RTLD_NOW);
		#define SYM(lib, name) name = (decltype(name))dlsym(lib, #name)
		SYM(lib_x11, XOpenDisplay); SYM(lib_x11, XCloseDisplay);
		SYM(lib_x11, XFlush); SYM(lib_x11, XSync);
		SYM(lib_x11, XRootWindow); SYM(lib_x11, XScreenNumberOfScreen); SYM(lib_x11, XScreenOfDisplay);
		SYM(lib_x11, XScreenCount);
		SYM(lib_x11, XQueryPointer); SYM(lib_x11, XGetGeometry); SYM(lib_x11, XTranslateCoordinates);
		SYM(lib_x11, XInternAtom); SYM(lib_x11, XGetWindowProperty); SYM(lib_x11, XFree);
		SYM(lib_x11, XSendEvent); SYM(lib_x11, XSetInputFocus); SYM(lib_x11, XRaiseWindow);
		SYM(lib_x11, XGetKeyboardMapping); SYM(lib_x11, XKeysymToKeycode); SYM(lib_x11, XStringToKeysym);
		SYM(lib_x11, XGetImage);
		if (lib_xext) {
			SYM(lib_xext, XShmQueryExtension); SYM(lib_xext, XShmGetImage);
			SYM(lib_xext, XShmAttach); SYM(lib_xext, XShmDetach); SYM(lib_xext, XShmCreateImage);
		}
		SYM(lib_x11, XSetErrorHandler); SYM(lib_x11, XSetIOErrorHandler);
		lib_png = dlopen("libpng16.so.16", RTLD_NOW);
		if (lib_png) {
			SYM(lib_png, png_access_version_number);
			SYM(lib_png, png_create_write_struct); SYM(lib_png, png_create_info_struct);
			SYM(lib_png, png_destroy_write_struct); SYM(lib_png, png_set_IHDR);
			SYM(lib_png, png_set_compression_level); SYM(lib_png, png_set_write_fn);
			SYM(lib_png, png_write_info); SYM(lib_png, png_write_row); SYM(lib_png, png_write_end);
			SYM(lib_png, png_get_io_ptr);
			if (!png_create_write_struct || !png_set_IHDR || !png_write_row || !png_get_io_ptr) lib_png = nullptr;
		}
		lib_tj = dlopen("libturbojpeg.so.0", RTLD_NOW);
		if (!lib_tj) lib_tj = dlopen("libturbojpeg.so", RTLD_NOW);
		if (lib_tj) {
			tjInitCompress_p = (decltype(tjInitCompress_p))dlsym(lib_tj, "tjInitCompress");
			tjCompress2_p = (decltype(tjCompress2_p))dlsym(lib_tj, "tjCompress2");
			tjFree_p = (decltype(tjFree_p))dlsym(lib_tj, "tjFree");
			tjDestroy_p = (decltype(tjDestroy_p))dlsym(lib_tj, "tjDestroy");
			if (!tjInitCompress_p || !tjCompress2_p || !tjFree_p || !tjDestroy_p) lib_tj = nullptr;
		}
		if (lib_xtst) { SYM(lib_xtst, XTestFakeMotionEvent); SYM(lib_xtst, XTestFakeButtonEvent); SYM(lib_xtst, XTestFakeKeyEvent); }
		#undef SYM
		if (!XOpenDisplay || !XGetImage || !XKeysymToKeycode) { error = "libX11 symbols missing"; return false; }
		has_shm = lib_xext && XShmQueryExtension && XShmGetImage && XShmAttach && XShmDetach && XShmCreateImage;
		has_xtest = lib_xtst && XTestFakeKeyEvent && XTestFakeButtonEvent && XTestFakeMotionEvent;
		if (XSetErrorHandler) XSetErrorHandler(+[](XDisplay*, void*) -> int {
			g_x_error_count.fetch_add(1);
			return 0;
		});
		if (XSetIOErrorHandler) XSetIOErrorHandler(+[](XDisplay*) -> int {
			// connection death is not recoverable for that display; drop caches
			// so the next use reopens. (Xlib still exits after this returns on
			// true I/O death — see README known-issue.)
			return 0;
		});
		ok = true;
		return true;
	}

	// Cached display connection per display string (":99" etc). The OPEN
	// name is normalized to its screen-agnostic base (":98.1" → ":98"):
	// XTestFakeMotionEvent's screen arg is honored relative to the
	// connection's DefaultScreen on some servers, and a connection that
	// defaults to the target screen makes cross-screen motion a no-op —
	// matching xdotool, which always opens the base name. Per-screen
	// queries still root via screen_of(), so nothing else depends on the
	// connection's default screen.
	XDisplay* display(const std::string& name) {
		auto it = displays.find(name);
		if (it != displays.end()) return it->second;
		std::string base = name;
		size_t col = base.rfind(':'), dot = base.rfind('.');
		if (dot != std::string::npos && col != std::string::npos && dot > col)
			base = base.substr(0, dot);
		XDisplay* d = XOpenDisplay(base.c_str());
		if (d) displays[name] = d;
		return d;
	}

	// The display name's screen index (":0.1" → 1): XOpenDisplay honors it,
	// but every query must root at the SAME screen — hard-coding screen 0
	// mis-aims capture/input on multi-screen X setups. Caller holds xmutex.
	int screen_of(XDisplay* d, const std::string& name) {
		int s = 0;
		size_t dot = name.rfind('.');
		if (dot != std::string::npos && dot + 1 < name.size())
			s = std::atoi(name.c_str() + dot + 1);
		int n = XScreenCount ? XScreenCount(d) : 1;
		return std::clamp(s, 0, std::max(0, n - 1));
	}

	Window root(XDisplay* d, const std::string& disp) {
		return XRootWindow(d, XScreenNumberOfScreen(XScreenOfDisplay(d, screen_of(d, disp))));
	}

	// Display origin in global coords (X11 root is 0,0; kept for interface parity)
	bool display_origin(const std::string& disp, int& ox, int& oy) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!init()) return false;
		XDisplay* d = display(disp);
		if (!d) return false;
		Window rr; int x = 0, y = 0; unsigned int dw = 0, dh = 0, bw = 0, bd = 0;
		if (!XGetGeometry(d, root(d, disp), &rr, &x, &y, &dw, &dh, &bw, &bd)) return false;
		ox = x; oy = y;
		return true;
	}

	// X11 coords are already pixels — no point/px split.
	bool scale_factor(const std::string& /*disp*/, double& f) { f = 1.0; return true; }
	double scale_factor() { return 1.0; }
	// physical pixel space == logical space on X11 (no HiDPI abstraction);
	// still takes disp — the old "" version opened $DISPLAY and reported
	// the WRONG screen's size (or failed headless → pixelResolution missing).
	bool pixel_size(const std::string& disp, int& w, int& h) { return display_size(disp, w, h); }

	// Last capture() / watch_encode() split timings (diagnostics in replies).
	double last_capture_ms = 0, last_encode_ms = 0;
	// SHM unusable on a given display (real displays can lack MIT-SHM or the
	// server may reject big segments) — stop paying setup cost per frame.
	std::set<std::string> shm_broken;

	// One retained grab context per caller: a reusable MIT-SHM segment +
	// XImage, so steady-state grabbing costs no shmget/shmat/attach/detach.
	// Retention is also what makes the watch probe→encode split cheap: the
	// encoder reads the raw frame the probe already pulled (nothing re-polls
	// the server) and idle ticks skip pixel conversion entirely.
	struct GrabCtx {
		XDisplay* d = nullptr;
		XImageMirror* img = nullptr;
		XShmSegmentInfoMirror shm{};
		bool via_shm = false;
		size_t shm_bytes = 0;
		int w = 0, h = 0;
	};
	// Per-thread retained frames: each watcher owns its ctx, so a
	// probe→encode span can never observe another grabber's pixels (the old
	// backend-wide watch_img raced under concurrent watchers — wrong frames
	// cross-client, heap stomp on differing sizes). Map node refs are stable;
	// a thread only ever inserts/erases its own entry, under xmutex.
	std::map<std::thread::id, GrabCtx> grab_ctxs;
	// capture()/record one-shots share a ctx — their spawn_guarded threads are
	// transient; grab+resample is serialized by xmutex so it stays correct.
	GrabCtx capture_ctx;

	bool display_size(const std::string& disp, int& w, int& h) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!init()) return false;
		XDisplay* d = display(disp);
		if (!d) return false;
		Window rr; int x, y; unsigned int bw = 0, bd = 0, dw = 0, dh = 0;
		if (!XGetGeometry(d, root(d, disp), &rr, &x, &y, &dw, &dh, &bw, &bd)) return false;
		w = int(dw); h = int(dh);
		return true;
	}

	// logind Inhibit("sleep", "omprd", why, "block") → returns a lock fd we
	// must keep open for the hold to stay. False when logind/libsystemd is
	// unreachable (containers, non-systemd distros).
	bool logind_inhibit() {
		if (!sd_tried) {
			sd_tried = true;
			lib_systemd = dlopen("libsystemd.so.0", RTLD_NOW);
			if (!lib_systemd) lib_systemd = dlopen("libsystemd.so", RTLD_NOW);
			if (lib_systemd) {
				#define SYM(name) name##_p = (decltype(name##_p))dlsym(lib_systemd, #name)
				SYM(sd_bus_open_system); SYM(sd_bus_call_method);
				SYM(sd_bus_message_read); SYM(sd_bus_unref); SYM(sd_bus_message_unref);
				#undef SYM
				if (!sd_bus_open_system_p || !sd_bus_call_method_p || !sd_bus_message_read_p)
					lib_systemd = nullptr;
			}
		}
		if (!lib_systemd) return false;
		void* bus = nullptr;
		if (sd_bus_open_system_p(&bus) < 0 || !bus) return false;
		void* reply = nullptr;
		int rc = sd_bus_call_method_p(bus, "org.freedesktop.login1", "/org/freedesktop/login1",
		                            "org.freedesktop.login1.Manager", "Inhibit",
		                            nullptr, &reply, "ssss",
		                            "sleep", "omprd", "remote keep-awake", "block");
		if (rc >= 0 && reply) {
			int fd = -1;
			if (sd_bus_message_read_p(reply, "h", &fd) >= 0 && fd >= 0) {
				inhibit_fd = fd;
				sd_bus_held = bus; // keep the connection the fd belongs to
				if (sd_bus_message_unref_p) sd_bus_message_unref_p(reply);
				return true;
			}
			if (sd_bus_message_unref_p) sd_bus_message_unref_p(reply);
		}
		if (sd_bus_unref_p) sd_bus_unref_p(bus);
		return false;
	}

	// The same logind lock taken by the systemd-inhibit binary — dies with
	// the daemon (reaped on release/shutdown like the lid-close child).
	// via_sudo: identical lock through `sudo -n` — boxes where polkit
	// denies Inhibit() to this user (headless VMs deny BOTH sleep and
	// lid-switch: "Failed to inhibit: Access denied"). sudo -n fails fast
	// where NOPASSWD isn't configured.
	bool inhibit_via_sudo = false;
	bool spawn_inhibit_child(bool via_sudo = false) {
		if (inhibit_pid > 0) return true;
		pid_t pid = fork();
		if (pid == 0) {
			if (via_sudo)
				execlp("sudo", "sudo", "-n", "systemd-inhibit",
				       "--what=sleep", "--mode=block",
				       "--why=remote keep-awake", "--", "sleep", "infinity", nullptr);
			else
				execlp("systemd-inhibit", "systemd-inhibit",
				       "--what=sleep", "--mode=block",
				       "--why=remote keep-awake", "--", "sleep", "infinity", nullptr);
			_exit(127);
		}
		if (pid <= 0) return false;
		usleep(400000); // give exec + the D-Bus call a moment to fail or hold
		int st = 0;
		if (waitpid(pid, &st, WNOHANG) == pid) return false; // died = no lock
		inhibit_pid = pid;
		inhibit_via_sudo = via_sudo;
		return true;
	}

	// A lock we hold but don't track as a child — orphaned systemd-inhibit
	// processes from a previous daemon run still block sleep (the inner
	// binary outlives its sudo wrapper when killed). pgrep's `[s]` bracket
	// keeps the pattern from matching the probing shell's own cmdline.
	bool inhibit_lock_alive() {
		// --what=sleep anchors against the lid child's
		// --what=handle-lid-switch:sleep sharing the same why-string
		FILE* p = popen("pgrep -f '[s]ystemd-inhibit --what=sleep.*remote keep-awake' 2>/dev/null", "r");
		if (!p) return false;
		char buf[64];
		bool any = fgets(buf, sizeof(buf), p) != nullptr;
		pclose(p);
		return any;
	}

	// Sweep every sleep lock matching our why-string: tracked child AND
	// stale orphans — they're our own stale assertions, not user policy.
	// (lid locks share the why-string but are released through the
	// g_lid_inhibit_pid path / the drop-in, not here)
	void inhibit_sweep() {
		if (geteuid() == 0)
			(void)!system("pkill -f '[s]ystemd-inhibit --what=sleep.*remote keep-awake' 2>/dev/null");
		else
			(void)!system("sudo -n pkill -f '[s]ystemd-inhibit --what=sleep.*remote keep-awake' 2>/dev/null");
	}

	void awake_release_os() {
		if (inhibit_fd >= 0) { close(inhibit_fd); inhibit_fd = -1; }
		if (sd_bus_held) {
			if (sd_bus_unref_p) sd_bus_unref_p(sd_bus_held);
			sd_bus_held = nullptr;
		}
		if (inhibit_pid > 0) {
			int st = 0;
			kill(inhibit_pid, SIGTERM); // EPERM-harmless for a root child
			for (int i = 0; i < 40 && waitpid(inhibit_pid, &st, WNOHANG) == 0; i++)
				usleep(50000);
			if (waitpid(inhibit_pid, &st, WNOHANG) != 0) inhibit_pid = -1;
		}
		// Killing the sudo wrapper orphans the inner systemd-inhibit, which
		// keeps holding the lock — always sweep by why-string afterwards.
		// Bounded (~10ms); no waitpid on procs we can't reach.
		inhibit_sweep();
		inhibit_via_sudo = false;
	}

	// stay_awake does two layers: the OS sleep inhibitor (logind D-Bus →
	// systemd-inhibit child → nothing) and the X-screensaver blanking toggle.
	// Returns false only when BOTH layers failed — the method string stays
	// honest about which one actually holds.
	bool stay_awake(bool on) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!xss_tried) {
			xss_tried = true;
			lib_xss = dlopen("libXss.so.1", RTLD_NOW);
			if (lib_xss) XScreenSaverSuspend = (decltype(XScreenSaverSuspend))dlsym(lib_xss, "XScreenSaverSuspend");
		}
		if (XScreenSaverSuspend) {
			bool engaged = false;
			for (auto& [name, d] : displays)
				if (XScreenSaverSuspend(d, on ? 1 : 0)) engaged = true;
			xss_held = on && engaged; // only a real suspend call counts — not the empty-displays vacuous pass
		} else {
			xss_held = false;
		}
		bool os_ok;
		if (on)
			// a surviving lock from an earlier run IS held — count it instead
			// of stacking a duplicate inhibitor
			os_ok = inhibit_fd >= 0 || inhibit_pid > 0 || inhibit_lock_alive() ||
			        logind_inhibit() || spawn_inhibit_child() ||
			        spawn_inhibit_child(true /*via sudo -n*/);
		else {
			awake_release_os();
			os_ok = true;
		}
		awake_held = on && os_ok;
		// held = a real OS sleep inhibitor (logind lock / systemd-inhibit child).
		// rig.stayAwake's reply reads this return as `held` — same contract as
		// awake_held_os() and rig.status: screen-blank prevention alone must
		// not read as held. For on:false the honest answer is whatever is
		// still held after the release (normally nothing).
		return on ? os_ok : awake_held_os();
	}

	const char* awake_method() {
		if (inhibit_fd >= 0) return "logind";
		if (inhibit_pid > 0) return inhibit_via_sudo ? "systemd-inhibit(sudo)" : "systemd-inhibit";
		if (inhibit_lock_alive()) return "systemd-inhibit(stale)"; // survives from an earlier run
		if (xss_held) return "xss"; // screen-blank only, not sleep-proof
		return "none";
	}
	// true only when a real OS-sleep inhibitor is held — Xss blanking doesn't count
	bool awake_held_os() { return inhibit_fd >= 0 || inhibit_pid > 0 || inhibit_lock_alive(); }

	// window-scoped capture — honest no on X11: sessions get their own
	// EWMH desktop instead, so a full-display shot IS already session-scoped
	bool capture_window(const std::string& /*disp*/, uint32_t /*wid*/, double /*scale*/,
	                    const std::string& /*fmt*/, int /*quality*/, MemImage& /*img*/,
	                    std::vector<uint8_t>& /*encoded*/, std::string& err) {
		err = "wid-scoped capture not supported on X11 — sessions use their own desktop";
		return false;
	}

	// ---- capture ----

	// Free a ctx's image + shm segment. Callers hold xmutex (XShmDetach is an
	// Xlib call). The segment is already IPC_RMID-marked, so this is just
	// detach bookkeeping; on process death the kernel reaps it regardless.
	void grab_ctx_release_locked(GrabCtx& gc) {
		if (gc.img) {
			if (gc.via_shm && gc.d) XShmDetach(gc.d, &gc.shm);
			// XDestroyImage is a macro — call through the image's f[] table;
			// shm images carry obdata so it won't free gc.shm.shmaddr itself
			if (gc.img->f[1]) reinterpret_cast<void (*)(XImageMirror*)>(gc.img->f[1])(gc.img);
			gc.img = nullptr;
		}
		if (gc.via_shm && gc.shm.shmaddr && gc.shm.shmaddr != reinterpret_cast<char*>(-1))
			shmdt(gc.shm.shmaddr);
		gc.shm = XShmSegmentInfoMirror{};
		gc.via_shm = false; gc.shm_bytes = 0; gc.w = gc.h = 0;
	}

	// Core grab into the caller's retained ctx. Caller holds xmutex.
	// Region is clamped to the root window — an off-edge grab is a BadMatch
	// that used to spuriously poison the SHM path and then fail outright.
	bool grab_locked(const std::string& disp, int rx, int ry, int rw, int rh,
	                 GrabCtx& gc, std::string& err) {
		if (!init()) { err = error; return false; }
		XDisplay* d = display(disp);
		if (!d) { err = "cannot open display " + disp; return false; }
		Window r = root(d, disp);
		unsigned int dw = 0, dh = 0;
		{
			Window rr; int x, y; unsigned int bw, bd;
			XGetGeometry(d, r, &rr, &x, &y, &dw, &dh, &bw, &bd);
		}
		if (rx < 0) rx = 0;
		if (ry < 0) ry = 0;
		if (rx >= int(dw) || ry >= int(dh)) { err = "region outside display"; return false; }
		if (rw <= 0 || rx + rw > int(dw)) rw = int(dw) - rx;
		if (rh <= 0 || ry + rh > int(dh)) rh = int(dh) - ry;

		bool shm_attempted = has_shm && !shm_broken.count(disp) && XShmQueryExtension(d);
		if (shm_attempted) {
			size_t need = size_t(rw) * rh * 4 + 64;
			// retain the segment across grabs; rebuild only when it can't fit
			// or the display/region changed
			if (gc.via_shm && (gc.d != d || gc.shm_bytes < need || gc.w != rw || gc.h != rh))
				grab_ctx_release_locked(gc);
			if (!gc.via_shm) {
				gc.shm.shmid = shmget(IPC_PRIVATE, int(need), IPC_CREAT | 0600);
				if (gc.shm.shmid >= 0) {
					gc.shm.shmaddr = reinterpret_cast<char*>(shmat(gc.shm.shmid, nullptr, 0));
					gc.shm.readOnly = 0;
					if (gc.shm.shmaddr != reinterpret_cast<char*>(-1) && XShmAttach(d, &gc.shm) != 0) {
						// canonical MIT-SHM: server-registered segment + Xlib-made image
						gc.img = XShmCreateImage(d, nullptr, 24, 2 /*ZPixmap*/, gc.shm.shmaddr,
						                         &gc.shm, unsigned(rw), unsigned(rh));
						if (gc.img) {
							gc.d = d; gc.via_shm = true; gc.shm_bytes = need;
							gc.w = rw; gc.h = rh;
							// mark now: the kernel reaps the segment at process
							// death even if this ctx is never released explicitly
							shmctl(gc.shm.shmid, IPC_RMID, nullptr);
						} else {
							XShmDetach(d, &gc.shm);
						}
					}
					if (!gc.via_shm) {
						if (gc.shm.shmaddr && gc.shm.shmaddr != reinterpret_cast<char*>(-1))
							shmdt(gc.shm.shmaddr);
						shmctl(gc.shm.shmid, IPC_RMID, nullptr);
						gc.shm = XShmSegmentInfoMirror{};
					}
				}
			}
			if (gc.via_shm) {
				g_x_error_count = 0;
				if (XShmGetImage(d, r, gc.img, rx, ry, ~0UL)) {
					XSync(d, 0);
					if (g_x_error_count == 0) { XFlush(d); return true; }
				}
				XSync(d, 0);
				g_x_error_count = 0;
				// claimed-but-failed SHM: broken server path — drop the ctx
				// and stop retrying it per frame
				grab_ctx_release_locked(gc);
				shm_broken.insert(disp);
			} else {
				// setup failed (no segment, attach refused) — same conclusion
				shm_broken.insert(disp);
			}
		}

		// Plain XGetImage fallback — still retained in the ctx.
		grab_ctx_release_locked(gc);
		XImageMirror* image = XGetImage(d, r, rx, ry, unsigned(rw), unsigned(rh), ~0UL, 2);
		if (!image) { err = "XGetImage failed"; return false; }
		gc.d = d; gc.img = image; gc.w = rw; gc.h = rh;
		XFlush(d);
		return true;
	}

	bool grab_raw(const std::string& disp, int rx, int ry, int rw, int rh,
	              GrabCtx& gc, std::string& err) {
		std::lock_guard<std::mutex> lock(xmutex);
		return grab_locked(disp, rx, ry, rw, rh, gc, err);
	}

	// Pixel layout of a grabbed XImage (shared by the samplers below).
	struct XChans {
		int bpp, rshift, gshift, bshift;
		unsigned long rm, gm, bm;
		bool lsb;
	};
	static bool ximg_chans(const XImageMirror* img, XChans& c) {
		c.rm = img->red_mask; c.gm = img->green_mask; c.bm = img->blue_mask;
		if (!c.rm || !c.gm || !c.bm) return false;
		c.rshift = __builtin_ctzl(c.rm);
		c.gshift = __builtin_ctzl(c.gm);
		c.bshift = __builtin_ctzl(c.bm);
		c.bpp = img->bits_per_pixel;
		c.lsb = img->byte_order != 1; // 1 = MSBFirst
		return c.bpp == 32 || c.bpp == 24 || c.bpp == 16;
	}
	static inline void ximg_rgb8(const XChans& c, const uint8_t* row, int x, uint8_t* q) {
		if (c.bpp == 32) {
			uint32_t p = reinterpret_cast<const uint32_t*>(row)[x];
			q[0] = uint8_t((p & c.rm) >> c.rshift);
			q[1] = uint8_t((p & c.gm) >> c.gshift);
			q[2] = uint8_t((p & c.bm) >> c.bshift);
		} else if (c.bpp == 24) {
			// packed 3 bytes/px — the 32bpp stride math misreads this format
			uint32_t p = c.lsb
				? uint32_t(row[x * 3]) | (uint32_t(row[x * 3 + 1]) << 8) | (uint32_t(row[x * 3 + 2]) << 16)
				: (uint32_t(row[x * 3]) << 16) | (uint32_t(row[x * 3 + 1]) << 8) | uint32_t(row[x * 3 + 2]);
			q[0] = uint8_t((p & c.rm) >> c.rshift);
			q[1] = uint8_t((p & c.gm) >> c.gshift);
			q[2] = uint8_t((p & c.bm) >> c.bshift);
		} else {
			uint16_t p = reinterpret_cast<const uint16_t*>(row)[x];
			q[0] = uint8_t(((p & c.rm) >> c.rshift) * 255 / (c.rm >> c.rshift));
			q[1] = uint8_t(((p & c.gm) >> c.gshift) * 255 / (c.gm >> c.gshift));
			q[2] = uint8_t(((p & c.bm) >> c.bshift) * 255 / (c.bm >> c.bshift));
		}
	}

	// Fused convert+downscale: box-average source pixels straight off the
	// XImage into output-res RGB. One pass, no intermediate full-res buffer,
	// and the box bounds are column/row LUTs — no per-pixel int division.
	static bool resample_ximage(const XImageMirror* img, double scale, MemImage& out) {
		int w = img->width, h = img->height;
		XChans c;
		if (!ximg_chans(img, c) || w <= 0 || h <= 0) return false;
		int nw = std::max(1, int(w * scale)), nh = std::max(1, int(h * scale));
		out.width = nw; out.height = nh;
		out.rgb.resize(size_t(nw) * nh * 3);
		std::vector<int> sx0(nw), sx1(nw), sy0(nh), sy1(nh);
		for (int x = 0; x < nw; x++) {
			sx0[x] = x * w / nw;
			sx1[x] = std::min(w, std::max(sx0[x] + 1, (x + 1) * w / nw));
		}
		for (int y = 0; y < nh; y++) {
			sy0[y] = y * h / nh;
			sy1[y] = std::min(h, std::max(sy0[y] + 1, (y + 1) * h / nh));
		}
		for (int y = 0; y < nh; y++) {
			uint8_t* q = out.rgb.data() + size_t(y) * nw * 3;
			for (int x = 0; x < nw; x++) {
				uint32_t r = 0, g = 0, b = 0;
				for (int sy = sy0[y]; sy < sy1[y]; sy++) {
					const uint8_t* srow = reinterpret_cast<const uint8_t*>(img->data)
						+ size_t(sy) * img->bytes_per_line;
					if (c.bpp == 32) {
						const uint32_t* prow = reinterpret_cast<const uint32_t*>(srow);
						for (int sx = sx0[x]; sx < sx1[x]; sx++) {
							uint32_t p = prow[sx];
							r += (p & c.rm) >> c.rshift;
							g += (p & c.gm) >> c.gshift;
							b += (p & c.bm) >> c.bshift;
						}
					} else {
						for (int sx = sx0[x]; sx < sx1[x]; sx++) {
							uint8_t px[3];
							ximg_rgb8(c, srow, sx, px);
							r += px[0]; g += px[1]; b += px[2];
						}
					}
				}
				uint32_t n = uint32_t(sx1[x] - sx0[x]) * uint32_t(sy1[y] - sy0[y]);
				q[0] = uint8_t(r / n); q[1] = uint8_t(g / n); q[2] = uint8_t(b / n);
				q += 3;
			}
		}
		return true;
	}

	// Downscaled thumb for the pixel-differ, nearest-sampled straight off the
	// raw XImage — idle watch ticks pay grab + 16K samples, not a
	// full-screen pixel conversion.
	static void thumb_ximage(const XImageMirror* img, int tw, int th,
	                         std::vector<uint8_t>& rgb) {
		int w = img->width, h = img->height;
		XChans c;
		rgb.assign(size_t(tw) * th * 3, 0);
		if (!ximg_chans(img, c) || w <= 0 || h <= 0) return;
		for (int y = 0; y < th; y++) {
			const uint8_t* srow = reinterpret_cast<const uint8_t*>(img->data)
				+ size_t(y * h / th) * img->bytes_per_line;
			uint8_t* dst = rgb.data() + size_t(y) * tw * 3;
			for (int x = 0; x < tw; x++) ximg_rgb8(c, srow, x * w / tw, dst + x * 3);
		}
	}

	// Returns encoded image bytes. fmt: "png" | "jpg".
	bool capture(const std::string& disp, int rx, int ry, int rw, int rh, double scale,
	             const std::string& fmt, int jpg_quality, MemImage& img,
	             std::vector<uint8_t>& encoded, std::string& err) {
		auto t0 = std::chrono::steady_clock::now();
		{
			// shared ctx: resample inside the grab lock so no other capture
			// can overwrite the raw frame mid-read
			std::lock_guard<std::mutex> lock(xmutex);
			if (!grab_locked(disp, rx, ry, rw, rh, capture_ctx, err)) return false;
			if (!resample_ximage(capture_ctx.img, scale, img)) { err = "resample failed"; return false; }
		}
		auto t1 = std::chrono::steady_clock::now();
		bool ok = encode_memimg(img, fmt, jpg_quality, encoded, err);
		auto t2 = std::chrono::steady_clock::now();
		last_capture_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
		last_encode_ms = std::chrono::duration<double, std::milli>(t2 - t1).count();
		return ok;
	}

	// Watch split: probe grabs into the calling thread's retained ctx and
	// thumbs straight off the raw XImage; encode resamples that retained
	// frame only when the differ says pixels changed — idle watch ticks pay
	// grab+thumb, never convert or encode. Per-thread ctxs mean a probe→
	// encode span can never observe another watcher's pixels.
	bool watch_probe(const std::string& disp, int rx, int ry, int rw, int rh,
	                 int tw, int th, std::vector<uint8_t>& thumb_rgb, std::string& err) {
		GrabCtx* gc;
		{
			std::lock_guard<std::mutex> lock(xmutex);
			gc = &grab_ctxs[std::this_thread::get_id()];
		}
		auto t0 = std::chrono::steady_clock::now();
		if (!grab_raw(disp, rx, ry, rw, rh, *gc, err)) return false;
		last_capture_ms = std::chrono::duration<double, std::milli>(
			std::chrono::steady_clock::now() - t0).count();
		thumb_ximage(gc->img, tw, th, thumb_rgb);
		return true;
	}

	bool watch_encode(const std::string& /*disp*/, double scale, const std::string& fmt, int quality,
	                  MemImage& img, std::vector<uint8_t>& encoded, std::string& err) {
		GrabCtx* gc = nullptr;
		{
			std::lock_guard<std::mutex> lock(xmutex);
			auto it = grab_ctxs.find(std::this_thread::get_id());
			if (it != grab_ctxs.end()) gc = &it->second;
		}
		if (!gc || !gc->img) { err = "no probed frame"; return false; }
		auto t0 = std::chrono::steady_clock::now();
		if (!resample_ximage(gc->img, scale, img)) { err = "resample failed"; return false; }
		bool ok = encode_memimg(img, fmt, quality, encoded, err);
		last_encode_ms = std::chrono::duration<double, std::milli>(
			std::chrono::steady_clock::now() - t0).count();
		return ok;
	}

	void watch_release() {
		std::lock_guard<std::mutex> lock(xmutex);
		auto it = grab_ctxs.find(std::this_thread::get_id());
		if (it != grab_ctxs.end()) {
			grab_ctx_release_locked(it->second);
			grab_ctxs.erase(it);
		}
	}

	// Legacy fused path kept for interface parity (one grab feeding differ + encoder).
	bool watch_frame(const std::string& disp, double scale, const std::string& fmt, int quality,
	                 int tw, int th, std::vector<uint8_t>& thumb_rgb, MemImage& img,
	                 std::vector<uint8_t>& encoded, std::string& err) {
		if (!watch_probe(disp, 0, 0, -1, -1, tw, th, thumb_rgb, err)) return false;
		return watch_encode(disp, scale, fmt, quality, img, encoded, err);
	}

	// Encode img.rgb to fmt bytes (libpng-l1 for png, turbojpeg for jpg when
	// available, else stb).
	bool encode_memimg(MemImage& img, const std::string& fmt, int jpg_quality,
	                   std::vector<uint8_t>& encoded, std::string& err) {
		used_libpng = false;
		used_turbojpeg = false;
		if (fmt == "jpg" && lib_tj) {
			void* h = tjInitCompress_p();
			if (h) {
				unsigned char* jbuf = nullptr;
				unsigned long jsize = 0;
				// TJPF_RGB=0, TJSAMP_420=1 — measured several times faster than stb
				int rc = tjCompress2_p(h, img.rgb.data(), img.width, img.width * 3,
				                       img.height, 0 /*TJPF_RGB*/, &jbuf, &jsize,
				                       1 /*TJSAMP_420*/, jpg_quality,
				                       1 /*TJFLAG_FASTDCT*/);
				if (rc == 0 && jbuf && jsize) {
					encoded.assign(jbuf, jbuf + jsize);
					used_turbojpeg = true;
				}
				if (jbuf) tjFree_p(jbuf);
				tjDestroy_p(h);
				if (used_turbojpeg) return true;
			}
		}
		if (fmt != "jpg" && lib_png) {
			// libpng at compression level 1: ~3-4x faster than stb's fixed level
			// libpng passes png_struct as arg1, NOT our io_ptr — fetch it
			auto sink = +[](void* wp, unsigned char* data, size_t size) {
				auto* vec = static_cast<std::vector<uint8_t>*>(png_get_io_ptr(wp));
				vec->insert(vec->end(), data, data + size);
			};
			// libpng's version guard rejects a bare "1.6" on some 1.6.x builds;
			// derive the exact running version (e.g. 10637 -> "1.6.37") instead
			char ver[16] = {};
			const char* verp = nullptr;
			if (png_access_version_number) {
				unsigned v = png_access_version_number();
				snprintf(ver, sizeof(ver), "%u.%u.%u", v / 10000, (v / 100) % 100, v % 100);
				verp = ver;
			}
			void* wp = png_create_write_struct(verp, nullptr, nullptr, nullptr);
			if (wp) {
				void* ip = png_create_info_struct(wp);
				if (ip) {
					encoded.reserve(size_t(img.width) * img.height * 3 / 8 + 8192);
					png_set_write_fn(wp, &encoded, sink, nullptr);
					png_set_compression_level(wp, 1);
					png_set_IHDR(wp, ip, unsigned(img.width), unsigned(img.height),
					             8, 2 /*RGB*/, 0, 0, 0);
					png_write_info(wp, ip);
					for (int y = 0; y < img.height; y++)
						png_write_row(wp, img.rgb.data() + size_t(y) * img.width * 3);
					png_write_end(wp, nullptr);
				}
				png_destroy_write_struct(&wp, ip ? &ip : nullptr);
			}
			if (!encoded.empty()) { used_libpng = true; return true; }
			encoded.clear(); // fall through to stb
		}
		auto sink = +[](void* ctx, void* data, int size) {
			auto* vec = static_cast<std::vector<uint8_t>*>(ctx);
			const uint8_t* p = static_cast<const uint8_t*>(data);
			vec->insert(vec->end(), p, p + size);
		};
		int rc = fmt == "jpg"
			? stbi_write_jpg_to_func(sink, &encoded, img.width, img.height, 3, img.rgb.data(), jpg_quality)
			: stbi_write_png_to_func(sink, &encoded, img.width, img.height, 3, img.rgb.data(), img.width * 3);
		if (rc == 0 || encoded.empty()) { err = "encode failed (" + fmt + ")"; return false; }
		return true;
	}

	// ---- input ----

	bool motion(const std::string& disp, int x, int y) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!has_xtest) return false;
		XDisplay* d = display(disp);
		if (!d) return false;
		// -1 (current screen) would pin motion to wherever the pointer last
		// was — on a multi-screen server a click meant for :0.1 lands on
		// screen 0 while captures read screen 1. Warp to the requested
		// display's own screen so input-space == screenshot-space.
		XTestFakeMotionEvent(d, screen_of(d, disp), x, y, 0);
		XFlush(d);
		// On multi-screen servers the first cross-screen warp can land on
		// the pointer's old screen (Xvfb honors the screen arg only after
		// prior motion + a settle). Verify the sprite reached the target
		// screen and retry a few times with a small delay — bounded ~120ms
		// worst case once per display, zero cost on single-screen.
		if (XScreenCount && XScreenCount(d) > 1 && XQueryPointer) {
			for (int i = 0; i < 4; i++) {
				Window r, c; int rx, ry, wx, wy; unsigned int mask;
				if (XQueryPointer(d, root(d, disp), &r, &c, &rx, &ry, &wx, &wy, &mask))
					break; // pointer is on the requested screen
				std::this_thread::sleep_for(std::chrono::milliseconds(30));
				XTestFakeMotionEvent(d, screen_of(d, disp), x, y, 0);
				XFlush(d);
			}
		}
		return true;
	}

	// Wheel scroll: X11 has no wheel delta — synthesize button 4/5/6/7 clicks.
	// dy > 0 scrolls up (button 4), dy < 0 down (5); dx < 0 left (6), dx > 0
	// right (7). One XFlush for the whole burst — no per-notch sleeps.
	bool scroll(const std::string& disp, int dx, int dy) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!has_xtest) return false;
		XDisplay* d = display(disp);
		if (!d) return false;
		int vb = dy > 0 ? 4 : 5, hb = dx < 0 ? 6 : 7;
		for (int i = 0; i < std::abs(dy); i++) {
			XTestFakeButtonEvent(d, unsigned(vb), 1, 0);
			XTestFakeButtonEvent(d, unsigned(vb), 0, 0);
		}
		for (int i = 0; i < std::abs(dx); i++) {
			XTestFakeButtonEvent(d, unsigned(hb), 1, 0);
			XTestFakeButtonEvent(d, unsigned(hb), 0, 0);
		}
		XFlush(d);
		return true;
	}

	bool button(const std::string& disp, int button_num, bool press) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!has_xtest) return false;
		XDisplay* d = display(disp);
		if (!d) return false;
		XTestFakeButtonEvent(d, unsigned(button_num), press ? 1 : 0, 0);
		XFlush(d);
		return true;
	}

	bool keycode_press(const std::string& disp, KeyCode kc, bool press) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!has_xtest) return false;
		XDisplay* d = display(disp);
		if (!d) return false;
		XTestFakeKeyEvent(d, kc, press ? 1 : 0, 0);
		XFlush(d);
		return true;
	}

	// Types one latin1 char via XTest; returns false if not representable.
	bool type_char(const std::string& disp, unsigned char ch) {
		KeySym sym = ch; // latin1 keysym identity
		std::lock_guard<std::mutex> lock(xmutex);
		if (!has_xtest) return false;
		XDisplay* d = display(disp);
		if (!d) return false;
		return type_cp_locked(d, sym);
	}

	// Press a keysym: direct keycode if one exists, else remap a spare keycode
	// for the duration of the press (the xdotool trick — unicode keysyms like
	// é (0xE9) and → (0x01002192) usually have no keycode assigned).
	bool type_cp_locked(XDisplay* d, KeySym sym) {
		KeyCode kc = XKeysymToKeycode(d, sym);
		KeyCode remapped = 0;
		int orig_per = 0;
		KeySym* orig_map = nullptr; // the keycode's real keysyms, restored after
		if (!kc && XDisplayKeycodes && XChangeKeyboardMapping && XGetKeyboardMapping) {
			int min_kc = 0, max_kc = 0;
			XDisplayKeycodes(d, &min_kc, &max_kc);
			if (temp_kc == 0) {
				// find a keycode with no keysyms assigned
				int per = 0;
				KeySym* map = XGetKeyboardMapping(d, KeyCode(min_kc), max_kc - min_kc + 1, &per);
				if (map) {
					for (int k = max_kc; k >= min_kc; k--) {
						bool empty = true;
						for (int j = 0; j < per; j++)
							if (map[(k - min_kc) * per + j]) { empty = false; break; }
						if (empty) { temp_kc = KeyCode(k); break; }
					}
					XFree(map);
				}
				if (temp_kc == 0) temp_kc = KeyCode(max_kc); // last resort: reuse top slot
			}
			if (temp_kc) {
				orig_map = XGetKeyboardMapping(d, temp_kc, 1, &orig_per);
				KeySym s = sym;
				XChangeKeyboardMapping(d, int(temp_kc), 1, &s, 1);
				XSync(d, 0); // the remap must land before the fake press
				kc = temp_kc;
				remapped = temp_kc;
			}
		}
		if (!kc) { if (orig_map) XFree(orig_map); return false; }
		// Which level does the keysym live at? map = [lvl0, lvl1(Shift),
		// lvl2(AltGr/ISO_Level3), lvl3(AltGr+Shift), then other groups] —
		// keysyms beyond level 1 (e.g. @ [] {} € on de/fr layouts) need
		// ISO_Level3_Shift held, not just Shift.
		bool need_shift = false, need_l3 = false;
		int per = 0;
		KeySym* map = XGetKeyboardMapping(d, kc, 1, &per);
		if (map) {
			for (int i = 0; i < per; i++)
				if (map[i] == sym) { need_shift = (i & 1) != 0; need_l3 = i >= 2; break; }
			XFree(map);
		}
		KeyCode shift_kc = XKeysymToKeycode(d, 0xFFE1 /*Shift_L*/);
		KeyCode l3_kc = XKeysymToKeycode(d, 0xFE03 /*ISO_Level3_Shift*/);
		if (need_l3 && l3_kc) XTestFakeKeyEvent(d, l3_kc, 1, 0);
		if (need_shift && shift_kc) XTestFakeKeyEvent(d, shift_kc, 1, 0);
		XTestFakeKeyEvent(d, kc, 1, 0);
		XTestFakeKeyEvent(d, kc, 0, 0);
		if (need_shift && shift_kc) XTestFakeKeyEvent(d, shift_kc, 0, 0);
		if (need_l3 && l3_kc) XTestFakeKeyEvent(d, l3_kc, 0, 0);
		if (remapped) {
			// restore what the keycode had — writing {0} used to blank a real
			// key's mapping when the spare pool ran out (the max_kc fallback)
			if (orig_map && orig_per > 0)
				XChangeKeyboardMapping(d, int(remapped), orig_per, orig_map, 1);
			else {
				KeySym none = 0;
				XChangeKeyboardMapping(d, int(remapped), 1, &none, 1);
			}
		}
		if (orig_map) XFree(orig_map);
		XFlush(d);
		return true;
	}

	KeyCode temp_kc = 0; // spare keycode reserved for unicode remapping

	// --- virtual desktops ----------------------------------------------
	// Per-session workspaces so parallel agents never share a screen.
	// EWMH client messages + root properties — no xdotool subprocess, no
	// shell-quoted display string. WMs without _NET_DESKTOP support report
	// -1/false honestly (Xvfb runs with a real WM anyway, per omprd's wm
	// probe).

	// 32-bit cardinal property on a window; -1 when absent. Caller holds xmutex.
	long cardinal_prop(XDisplay* d, Window w, const char* prop_name) {
		Atom a = XInternAtom(d, prop_name, 1);
		if (!a) return -1;
		unsigned long n = 0, after = 0, enc = 0;
		unsigned char* data = nullptr;
		int fmt = 0;
		if (XGetWindowProperty(d, w, a, 0, 1, 0, 6 /*XA_CARDINAL*/, &enc, &fmt, &n, &after, &data) != 0 || !data)
			return -1;
		long v = fmt == 32 && n >= 1 ? long(reinterpret_cast<unsigned long*>(data)[0]) : -1;
		XFree(data);
		return v;
	}
	long root_cardinal(const std::string& disp, const char* prop_name) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!init()) return -1;
		XDisplay* d = display(disp);
		return d ? cardinal_prop(d, root(d, disp), prop_name) : -1;
	}

	int space_current(const std::string& disp) {
		return int(root_cardinal(disp, "_NET_CURRENT_DESKTOP"));
	}
	int space_count(const std::string& disp) {
		return int(root_cardinal(disp, "_NET_NUMBER_OF_DESKTOPS"));
	}
	// set _NET_NUMBER_OF_DESKTOPS — the release pool shrinks the tail when
	// trailing desktops are unclaimed and windowless (callers must guarantee
	// that; the WM will happily orphan live windows otherwise)
	bool space_set_count(const std::string& disp, int n) {
		if (n < 1) return false;
		Window r = 0;
		{
			std::lock_guard<std::mutex> lock(xmutex);
			XDisplay* d = display(disp);
			if (!d) return false;
			r = root(d, disp);
		}
		return send_root_message(disp, "_NET_NUMBER_OF_DESKTOPS", r, n, 0, 0, 0, 0);
	}

	// create a fresh trailing workspace and switch to it — returns its index
	int space_new(const std::string& disp) {
		int n = space_count(disp);
		if (n <= 0) return -1;
		if (!space_set_count(disp, n + 1)) return -1;
		// the WM applies the count async — wait for the new index to exist
		for (int i = 0; i < 10 && space_count(disp) <= n; i++)
			std::this_thread::sleep_for(std::chrono::milliseconds(40));
		if (space_count(disp) <= n || !space_enter(disp, n)) return -1;
		return n;
	}
	bool space_enter(const std::string& disp, int idx) {
		if (idx < 0) return false;
		Window r = 0;
		{
			std::lock_guard<std::mutex> lock(xmutex);
			XDisplay* d = display(disp);
			if (!d) return false;
			r = root(d, disp);
		}
		return send_root_message(disp, "_NET_CURRENT_DESKTOP", r, idx, 0 /*timestamp*/, 0, 0, 0);
	}

	// client windows parked on desktop idx (-1 on failure) — the claim pool
	// only reuses/releases an index this reports as empty. Sticky windows
	// (_NET_WM_DESKTOP 0xFFFFFFFF, "on every desktop") don't pin a desktop.
	long desktop_window_count(const std::string& disp, int idx) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!init()) return -1;
		XDisplay* d = display(disp);
		if (!d) return -1;
		Window r = root(d, disp);
		Atom clients = XInternAtom(d, "_NET_CLIENT_LIST", 1);
		if (!clients) return -1;
		unsigned long n = 0, after = 0, enc = 0;
		unsigned char* data = nullptr;
		int fmt = 0;
		if (XGetWindowProperty(d, r, clients, 0, 1024, 0, 0, &enc, &fmt, &n, &after, &data) != 0)
			return -1;
		// an absent/empty client list reads back as Success with no data —
		// that's zero windows, not a failure
		if (!data || n == 0) {
			if (data) XFree(data);
			return 0;
		}
		Atom da = XInternAtom(d, "_NET_WM_DESKTOP", 1);
		long count = 0;
		unsigned long* ids = reinterpret_cast<unsigned long*>(data);
		for (unsigned long i = 0; i < n; i++) {
			long wsd = da ? cardinal_prop(d, ids[i], "_NET_WM_DESKTOP") : -1;
			if (wsd == idx) count++;
		}
		XFree(data);
		return count;
	}

	// wid-scoped capture isn't an X11 thing (windows on other desktops can't
	// be imaged) — the hook exists so the daemon can validate ids uniformly.
	bool window_exists(uint32_t wid) {
		for (auto& d : displays)
			for (auto& w : windows(d.first))
				if (w.id == wid) return true;
		return false;
	}

	// Park every window owned by `pid` (or its descendants — spawned apps go
	// through /bin/sh -c, so the window's _NET_WM_PID is usually a grandchild)
	// on desktop `idx` — EWMH _NET_WM_DESKTOP client message per window (same
	// transport as the space ops; _NET_WM_PID comes straight off
	// _NET_CLIENT_LIST). Honest false when no matching window maps.
	static bool pid_descends_from(long pid, long ancestor) {
		if (pid == ancestor) return true;
#ifdef __linux__
		long cur = pid;
		for (int hops = 0; cur > 1 && hops < 64; hops++) {
			if (cur == ancestor) return true;
			std::ifstream f("/proc/" + std::to_string(cur) + "/stat");
			if (!f) return false;
			std::string line;
			std::getline(f, line);
			size_t rp = line.rfind(')'); // comm may contain spaces/parens
			if (rp == std::string::npos || rp + 4 >= line.size()) return false;
			cur = std::strtol(line.c_str() + rp + 4, nullptr, 10); // field 4 = ppid
		}
#endif
		return false;
	}

	bool window_route_pid(const std::string& disp, long pid, int idx) {
		if (pid <= 0 || idx < 0) return false;
		bool any = false;
		for (auto& w : windows(disp))
			if (w.pid != 0 && pid_descends_from((long)w.pid, pid))
				any |= send_root_message(disp, "_NET_WM_DESKTOP", (Window)w.id, idx, 2, 0, 0, 0);
		return any;
	}

	// Full UTF-8 type: decodes to codepoints — latin-1 keysyms map identity,
	// everything else uses the Unicode keysym convention 0x01000000|cp plus a
	// temporary keycode remap when no key is assigned.
	bool type_text(const std::string& disp, const std::string& text, int delay_ms) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!has_xtest) return false;
		XDisplay* d = display(disp);
		if (!d) return false;
		for (size_t i = 0; i < text.size();) {
			unsigned char ch = uint8_t(text[i]);
			uint32_t cp;
			if (ch < 0x80) { cp = ch; i += 1; }
			else if ((ch & 0xE0) == 0xC0 && i + 1 < text.size()) {
				cp = ((ch & 0x1F) << 6) | (text[i + 1] & 0x3F); i += 2;
			} else if ((ch & 0xF0) == 0xE0 && i + 2 < text.size()) {
				cp = ((ch & 0x0F) << 12) | ((text[i + 1] & 0x3F) << 6) | (text[i + 2] & 0x3F); i += 3;
			} else if ((ch & 0xF8) == 0xF0 && i + 3 < text.size()) {
				cp = uint32_t(ch & 0x07) << 18 | uint32_t(text[i + 1] & 0x3F) << 12 |
				     uint32_t(text[i + 2] & 0x3F) << 6 | uint32_t(text[i + 3] & 0x3F);
				i += 4;
			} else { i += 1; continue; } // stray continuation byte — drop
			// C0 controls aren't latin-1 keysyms — newline/tab/escape need
			// their named keysyms or the press produces nothing (and the remap
			// fallback would burn a keycode on a dead keysym). Others drop.
			if (cp < 0x20 || cp == 0x7F) {
				switch (cp) {
					case 0x08: cp = 0xFF08; break; // BackSpace
					case 0x09: cp = 0xFF09; break; // Tab
					case 0x0A: case 0x0D: cp = 0xFF0D; break; // Return
					case 0x1B: cp = 0xFF1B; break; // Escape
					case 0x7F: cp = 0xFFFF; break; // Delete
					default: continue;
				}
			}
			KeySym sym = cp <= 0xFF ? KeySym(cp) : KeySym(0x01000000UL | cp);
			if (!type_cp_locked(d, sym)) return false;
			if (delay_ms > 0)
				std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
		}
		return true;
	}

	// ---- queries / window control ----

	bool query_pointer(const std::string& disp, int& x, int& y, unsigned long& child) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!ok && !init()) return false;
		XDisplay* d = display(disp);
		if (!d) return false;
		Window r, c; int rx, ry, wx, wy; unsigned int mask;
		if (!XQueryPointer(d, root(d, disp), &r, &c, &rx, &ry, &wx, &wy, &mask)) return false;
		x = rx; y = ry; child = c;
		return true;
	}

	std::string utf8_property(XDisplay* d, Window w, const char* prop_name) {
		Atom a = XInternAtom(d, prop_name, 1);
		if (!a) return {};
		unsigned long nitems = 0, bytes_after = 0, enc = 0;
		unsigned char* data = nullptr;
		Atom type = 0; int fmt = 0;
		(void)type; (void)fmt; (void)enc; (void)bytes_after;
		if (XGetWindowProperty(d, w, a, 0, 8192, 0, 0 /*AnyPropertyType*/, &enc, &fmt, &nitems, &bytes_after, &data) == 0 && data) {
			std::string out(reinterpret_cast<char*>(data), nitems);
			XFree(data);
			return out;
		}
		return {};
	}

	// /proc/<pid>/comm — the owning process name for a window's pid.
	static std::string proc_name(long pid) {
		if (pid <= 0) return {};
		char path[64];
		snprintf(path, sizeof path, "/proc/%ld/comm", pid);
		FILE* f = fopen(path, "r");
		if (!f) return {};
		char buf[128] = {};
		std::string out;
		if (fgets(buf, sizeof buf, f)) {
			buf[strcspn(buf, "\n")] = 0;
			out = buf;
		}
		fclose(f);
		return out;
	}

	struct WinInfo {
		unsigned long id = 0;
		unsigned long pid = 0;   // _NET_WM_PID — used by window_activate on macOS
		std::string app;         // /proc/<pid>/comm — the owning process
		std::string title;
		int x = 0, y = 0;
		unsigned int w = 0, h = 0;
		bool active = false;
	};

	std::vector<WinInfo> windows(const std::string& disp) {
		std::lock_guard<std::mutex> lock(xmutex);
		std::vector<WinInfo> out;
		if (!ok && !init()) return out;
		XDisplay* d = display(disp);
		if (!d) return out;
		Window r = root(d, disp);
		unsigned long active = 0;
		{
			Atom a = XInternAtom(d, "_NET_ACTIVE_WINDOW", 1);
			unsigned long n = 0, after = 0, enc = 0;
			unsigned char* data = nullptr;
			int fmt = 0;
			if (a && XGetWindowProperty(d, r, a, 0, 32, 0, 0, &enc, &fmt, &n, &after, &data) == 0 && data && n >= 1) {
				active = reinterpret_cast<unsigned long*>(data)[0];
				XFree(data);
			}
		}
		Atom clients = XInternAtom(d, "_NET_CLIENT_LIST", 1);
		if (!clients) return out;
		unsigned long n = 0, after = 0, enc = 0;
		unsigned char* data = nullptr;
		int fmt = 0;
		if (XGetWindowProperty(d, r, clients, 0, 1024, 0, 0, &enc, &fmt, &n, &after, &data) != 0 || !data)
			return out;
		Atom pid_atom = XInternAtom(d, "_NET_WM_PID", 1);
		unsigned long* ids = reinterpret_cast<unsigned long*>(data);
		for (unsigned long i = 0; i < n; i++) {
			WinInfo wi;
			wi.id = ids[i];
			wi.title = utf8_property(d, wi.id, "_NET_WM_NAME");
			if (wi.title.empty()) {
				// XFetchName fallback via property: use WM_NAME (latin1)
				wi.title = utf8_property(d, wi.id, "WM_NAME");
			}
			if (pid_atom) {
				unsigned long pn = 0, pafter = 0, penc = 0;
				unsigned char* pdata = nullptr;
				int pf = 0;
				if (XGetWindowProperty(d, wi.id, pid_atom, 0, 1, 0, 6 /*XA_CARDINAL*/,
				                       &penc, &pf, &pn, &pafter, &pdata) == 0 && pdata && pn >= 1) {
					wi.pid = *reinterpret_cast<unsigned long*>(pdata);
					XFree(pdata);
					wi.app = proc_name(long(wi.pid));
				}
			}
			Window rr; int px = 0, py = 0; unsigned int bw = 0, bd = 0;
			if (XGetGeometry(d, wi.id, &rr, &px, &py, &wi.w, &wi.h, &bw, &bd)) {
				int tx = 0, ty = 0; Window junk;
				XTranslateCoordinates(d, wi.id, r, 0, 0, &tx, &ty, &junk);
				wi.x = tx; wi.y = ty;
			}
			wi.active = wi.id == active;
			out.push_back(wi);
		}
		XFree(data);
		return out;
	}

	// Foreground window's owner pid: _NET_ACTIVE_WINDOW + _NET_WM_PID.
	// 0 when nothing reports one (or the window set no pid).
	long frontmost_pid() {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!ok && !init()) return 0;
		for (auto& it : displays) {
			XDisplay* d = it.second;
			if (!d) continue;
			Atom a = XInternAtom(d, "_NET_ACTIVE_WINDOW", 1);
			if (!a) continue;
			unsigned long n = 0, after = 0, enc = 0;
			unsigned char* data = nullptr;
			int fmt = 0;
			if (XGetWindowProperty(d, root(d, it.first), a, 0, 32, 0, 0, &enc, &fmt, &n, &after, &data) != 0 || !data)
				continue;
			unsigned long wid = fmt == 32 && n >= 1 ? reinterpret_cast<unsigned long*>(data)[0] : 0;
			XFree(data);
			if (!wid) continue;
			Atom pa = XInternAtom(d, "_NET_WM_PID", 1);
			if (!pa) continue;
			data = nullptr; n = 0;
			if (XGetWindowProperty(d, (Window)wid, pa, 0, 1, 0, 6 /*XA_CARDINAL*/,
			                       &enc, &fmt, &n, &after, &data) != 0 || !data)
				continue;
			long pid = fmt == 32 && n >= 1 ? (long)reinterpret_cast<unsigned long*>(data)[0] : 0;
			XFree(data);
			if (pid > 0) return pid;
		}
		return 0;
	}

	// Foreground app name: _NET_ACTIVE_WINDOW + _NET_WM_PID → /proc/<pid>/comm.
	// A desktop has one focused window; whichever open display answers is the
	// frontmost app. "" when nothing reports one.
	std::string frontmost_app() {
		long pid = frontmost_pid();
		if (pid <= 0) return "";
		return proc_name(pid);
	}

	bool send_root_message(const std::string& disp, const char* atom_name, Window target,
	                       long l0, long l1, long l2, long l3, long l4) {
		std::lock_guard<std::mutex> lock(xmutex);
		if (!ok && !init()) return false;
		XDisplay* d = display(disp);
		if (!d) return false;
		Window r = root(d, disp);
		Atom a = XInternAtom(d, atom_name, 0);
		if (!a) return false;
		XClientMessageMirror ev{};
		ev.type = 33; // ClientMessage
		ev.display = d;
		ev.window = target;
		ev.message_type = a;
		ev.format = 32;
		ev.data.l[0] = l0; ev.data.l[1] = l1; ev.data.l[2] = l2;
		ev.data.l[3] = l3; ev.data.l[4] = l4;
		long mask = (1L << 20) | (1L << 19); // SubstructureRedirect | SubstructureNotify
		Bool sent = XSendEvent(d, r, 0, mask, &ev);
		XFlush(d);
		return sent != 0;
	}

	bool window_activate(const std::string& disp, unsigned long id) {
		// source=2 (pager) — WMs distrust source=1 clients that fake input;
		// XSetInputFocus as belt-and-suspenders for WMs that ignore the message.
		bool msg = send_root_message(disp, "_NET_ACTIVE_WINDOW", id, 2, 0, 0, 0, 0);
		{
			std::lock_guard<std::mutex> lock(xmutex);
			XDisplay* d = display(disp);
			if (d) {
				if (XRaiseWindow) XRaiseWindow(d, (Window)id);
				if (XSetInputFocus) {
					XSetInputFocus(d, (Window)id, 2 /*RevertToParent*/, 0 /*CurrentTime*/);
				}
				XFlush(d);
			}
		}
		return msg;
	}

	bool window_close(const std::string& disp, unsigned long id) {
		return send_root_message(disp, "_NET_CLOSE_WINDOW", id, 0, 0, 0, 0, 0);
	}

	// Press a key combo ("ctrl+shift+t", "Return", "ctrl+plus") via XTest.
	// Modifier keysyms are held while the main key taps; symbols that live on
	// the shifted layer automatically add Shift.
	bool key_combo(const std::string& disp, const std::string& combo) {
		struct Named { const char* name; KeySym sym; };
		static const Named mods[] = {
			{"ctrl", 0xFFE3}, {"control", 0xFFE3}, {"shift", 0xFFE1}, {"alt", 0xFFE9},
			{"meta", 0xFFEB}, {"super", 0xFFEB}, {"win", 0xFFEB},
		};
		static const Named named[] = {
			{"return", 0xFF0D}, {"enter", 0xFF0D}, {"esc", 0xFF1B}, {"escape", 0xFF1B},
			{"tab", 0xFF09}, {"backspace", 0xFF08}, {"delete", 0xFFFF}, {"home", 0xFF50},
			{"end", 0xFF57}, {"pageup", 0xFF55}, {"pagedown", 0xFF56},
			{"up", 0xFF52}, {"down", 0xFF54}, {"left", 0xFF51}, {"right", 0xFF53},
			{"space", 0x20}, {"plus", 0x2B}, {"minus", 0x2D},
		};
		std::vector<KeySym> mod_syms;
		KeySym main_sym = 0;
		bool force_shift = false;
		std::istringstream iss(combo);
		std::string tok;
		while (std::getline(iss, tok, '+')) {
			std::string low = tok;
			for (char& ch : low) ch = char(std::tolower(unsigned(ch)));
			bool is_mod = false;
			for (auto& n : mods)
				if (low == n.name) { mod_syms.push_back(n.sym); is_mod = true; break; }
			if (is_mod) continue;
			if (main_sym) return false; // exactly one non-modifier per combo
			if (tok.size() == 1) {
				unsigned char ch = static_cast<unsigned char>(tok[0]);
				if (ch >= 'A' && ch <= 'Z') { main_sym = ch + 32; force_shift = true; }
				else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) main_sym = ch;
				else { main_sym = ch; force_shift = isshifted(ch); }
			} else {
				for (auto& n : named)
					if (low == n.name) { main_sym = n.sym; break; }
				if (!main_sym && low[0] == 'f' && low.size() <= 3) {
					int fn = std::atoi(low.c_str() + 1);
					if (fn >= 1 && fn <= 12) main_sym = 0xFFBE + KeySym(fn - 1);
				}
				if (!main_sym) return false;
			}
		}
		if (!main_sym) return false;

		std::lock_guard<std::mutex> lock(xmutex);
		if (!has_xtest) return false;
		XDisplay* d = display(disp);
		if (!d) return false;
		KeyCode main_kc = XKeysymToKeycode(d, main_sym);
		if (!main_kc) return false;
		bool need_shift = force_shift;
		if (!need_shift) {
			int per = 0;
			KeySym* map = XGetKeyboardMapping(d, main_kc, 1, &per);
			if (map && per >= 2) {
				need_shift = map[1] == main_sym && map[0] != main_sym;
				XFree(map);
			}
		}
		KeyCode shift_kc = XKeysymToKeycode(d, 0xFFE1);
		std::vector<KeyCode> mod_kcs;
		for (KeySym s : mod_syms) {
			KeyCode kc = XKeysymToKeycode(d, s);
			if (!kc) return false;
			mod_kcs.push_back(kc);
		}
		for (KeyCode kc : mod_kcs) XTestFakeKeyEvent(d, kc, 1, 0);
		if (need_shift && shift_kc) XTestFakeKeyEvent(d, shift_kc, 1, 0);
		XTestFakeKeyEvent(d, main_kc, 1, 0);
		XTestFakeKeyEvent(d, main_kc, 0, 0);
		if (need_shift && shift_kc) XTestFakeKeyEvent(d, shift_kc, 0, 0);
		for (KeyCode kc : mod_kcs) XTestFakeKeyEvent(d, kc, 0, 0);
		XFlush(d);
		return true;
	}

	static bool isshifted(unsigned char ch) {
		switch (ch) {
			case '!': case '@': case '#': case '$': case '%': case '^': case '&':
			case '*': case '(': case ')': case '_': case '+': case '{': case '}':
			case '|': case ':': case '"': case '<': case '>': case '?': case '~':
				return true;
			default:
				return false;
		}
	}
};

static X11Backend g_x11;

} // namespace rig
