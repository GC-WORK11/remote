// ---------------------------------------------------------------------------
// win.hpp — native Win32 computer-use backend, mirrors x11.hpp's surface.
// Zero compile-time dependencies like the other backends: every Win32 entry
// point is resolved at runtime via LoadLibrary/GetProcAddress (user32/gdi32/
// kernel32), matching how x11.hpp dlopens libX11.
//
//   capture : BitBlt the virtual screen → BGRA → RGB8 → downscale → PNG/JPEG
//             via stb (no libpng fast path on Windows — stb is the encoder)
//   input   : SendInput — absolute-pointer mouse events, virtual-key and
//             KEYEVENTF_UNICODE keyboard events; VkKeyScanW for ASCII chars
//   windows : EnumWindows + GetWindowTextW/IsWindowVisible/GetWindowRect
//   control : SetForegroundWindow / WM_CLOSE
//   awake   : SetThreadExecutionState(ES_CONTINUOUS|ES_DISPLAY_REQUIRED|…)
//
// `disp` params are accepted for interface parity and ignored: like macOS,
// Windows has one real session display; there is no Xvfb-style virtual one.
// Coordinates are virtual-screen-relative (0,0 = top-left of the virtual
// desktop bounding box), matching X11 root-window semantics.
// ---------------------------------------------------------------------------
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <objbase.h> // IUnknown/GUID for the VirtualDesktop COM vtables

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STB_IMAGE_WRITE_STATIC
#if defined(_MSC_VER)
#pragma warning(push)
#pragma warning(disable : 4505) // stb keeps unused encoders in the same file
#endif
#include "../daemon/stb_image_write.h"
#if defined(_MSC_VER)
#pragma warning(pop)
#endif

namespace rig {

// Same pixel buffer shape the X11 backend exposes (x11.hpp is not included
// on Windows — no dlfcn/shm — so the shared struct lives here too).
struct MemImage {
	int width = 0, height = 0;
	std::vector<uint8_t> rgb;          // packed RGB8, width*height*3
};

// ---- the backend ----------------------------------------------------------------

struct WinBackend {
	void* lib_user32 = nullptr;
	void* lib_gdi32 = nullptr;
	void* lib_kernel = nullptr;
	bool tried = false;
	bool ok = false;
	// field names mirror x11.hpp so the protocol reply stays identical:
	//   has_xtest = SendInput injection available (always, at integrity level)
	//   has_shm   = screen capture possible (BitBlt on the display DC)
	bool has_shm = false;
	bool has_xtest = false;
	bool session0 = false; // running on a non-interactive window station
	bool used_libpng = false;
	const char* backend = "win32";
	// Last capture() / watch_encode() split timings (diagnostics in replies).
	double last_capture_ms = 0, last_encode_ms = 0;
	MemImage watch_img; // retained watch_probe frame; watch_encode reads it
	const char* capture_encoder() const { return "stb"; }
	std::string error;

	std::mutex m;
	// SendInput reports success even when the target session is inactive;
	// on a headless/Screen-0 context BitBlt still works (the desktop exists).
	std::unordered_map<unsigned long, HWND> id_to_hwnd; // protocol id → real handle

	// user32
	int (*GetSystemMetrics_p)(int) = nullptr;
	HDC (*GetDC_p)(HWND) = nullptr;
	int (*ReleaseDC_p)(HWND, HDC) = nullptr;
	BOOL (*EnumWindows_p)(WNDENUMPROC, LPARAM) = nullptr;
	int (*GetWindowTextW_p)(HWND, LPWSTR, int) = nullptr;
	int (*GetWindowTextLengthW_p)(HWND) = nullptr;
	BOOL (*IsWindowVisible_p)(HWND) = nullptr;
	BOOL (*IsIconic_p)(HWND) = nullptr;
	BOOL (*GetWindowRect_p)(HWND, LPRECT) = nullptr;
	HWND (*GetForegroundWindow_p)() = nullptr;
	BOOL (*SetForegroundWindow_p)(HWND) = nullptr;
	BOOL (*BringWindowToTop_p)(HWND) = nullptr;
	DWORD (*GetWindowThreadProcessId_p)(HWND, LPDWORD) = nullptr;
	BOOL (*AttachThreadInput_p)(DWORD, DWORD, BOOL) = nullptr;
	BOOL (*ShowWindow_p)(HWND, int) = nullptr;
	BOOL (*PostMessageW_p)(HWND, UINT, WPARAM, LPARAM) = nullptr;
	BOOL (*GetCursorPos_p)(LPPOINT) = nullptr;
	HWND (*WindowFromPoint_p)(POINT) = nullptr;
	BOOL (*IsWindow_p)(HWND) = nullptr;
	UINT (*SendInput_p)(UINT, LPINPUT, int) = nullptr;
	SHORT (*VkKeyScanW_p)(WCHAR) = nullptr;
	HWND (*GetShellWindow_p)() = nullptr;
	int (*GetClassNameW_p)(HWND, LPWSTR, int) = nullptr;
	HWINSTA (*GetProcessWindowStation_p)() = nullptr;
	BOOL (*GetUserObjectInformationA_p)(HANDLE, int, PVOID, DWORD, LPDWORD) = nullptr;
	// gdi32
	HDC (*CreateDCW_p)(LPCWSTR, LPCWSTR, LPCWSTR, const void*) = nullptr;
	HDC (*CreateCompatibleDC_p)(HDC) = nullptr;
	HBITMAP (*CreateCompatibleBitmap_p)(HDC, int, int) = nullptr;
	HGDIOBJ (*SelectObject_p)(HDC, HGDIOBJ) = nullptr;
	BOOL (*BitBlt_p)(HDC, int, int, int, int, HDC, int, int, DWORD) = nullptr;
	int (*GetDIBits_p)(HDC, HBITMAP, UINT, UINT, void*, LPBITMAPINFO, UINT) = nullptr;
	BOOL (*DeleteObject_p)(HGDIOBJ) = nullptr;
	BOOL (*DeleteDC_p)(HDC) = nullptr;
	// kernel32 (already loaded in-process; resolved for style consistency)
	int (*WideCharToMultiByte_p)(UINT, DWORD, LPCWCH, int, LPSTR, int, LPCCH, LPBOOL) = nullptr;
	int (*MultiByteToWideChar_p)(UINT, DWORD, LPCCH, int, LPWSTR, int) = nullptr;
	EXECUTION_STATE (*SetThreadExecutionState_p)(EXECUTION_STATE) = nullptr;
	HANDLE (*OpenProcess_p)(DWORD, BOOL, DWORD) = nullptr;
	BOOL (*QueryFullProcessImageNameW_p)(HANDLE, DWORD, LPWSTR, PDWORD) = nullptr;
	BOOL (*CloseHandle_p)(HANDLE) = nullptr;

	template <typename T> static T sym(void* h, const char* n) {
		return h ? reinterpret_cast<T>(reinterpret_cast<void*>(GetProcAddress(static_cast<HMODULE>(h), n))) : nullptr;
	}

	bool init() {
		if (tried) return ok;
		tried = true;
		lib_user32 = LoadLibraryA("user32.dll");
		lib_gdi32 = LoadLibraryA("gdi32.dll");
		lib_kernel = reinterpret_cast<void*>(GetModuleHandleA("kernel32.dll"));
		if (!lib_user32 || !lib_gdi32 || !lib_kernel) { error = "system dlls not loadable"; return false; }
		#define SYM(lib, name) name##_p = sym<decltype(name##_p)>(lib, #name)
		SYM(lib_user32, GetSystemMetrics); SYM(lib_user32, GetDC); SYM(lib_user32, ReleaseDC);
		SYM(lib_user32, EnumWindows); SYM(lib_user32, GetWindowTextW); SYM(lib_user32, GetWindowTextLengthW);
		SYM(lib_user32, IsWindowVisible); SYM(lib_user32, IsIconic); SYM(lib_user32, GetWindowRect);
		SYM(lib_user32, GetForegroundWindow); SYM(lib_user32, SetForegroundWindow);
		SYM(lib_user32, BringWindowToTop); SYM(lib_user32, GetWindowThreadProcessId);
		SYM(lib_user32, AttachThreadInput); SYM(lib_user32, ShowWindow); SYM(lib_user32, PostMessageW);
		SYM(lib_user32, GetCursorPos); SYM(lib_user32, WindowFromPoint); SYM(lib_user32, IsWindow);
		SYM(lib_user32, SendInput);
		SYM(lib_user32, VkKeyScanW); SYM(lib_user32, GetShellWindow); SYM(lib_user32, GetClassNameW);
		SYM(lib_user32, GetProcessWindowStation); SYM(lib_user32, GetUserObjectInformationA);
		SYM(lib_gdi32, CreateDCW); SYM(lib_gdi32, CreateCompatibleDC); SYM(lib_gdi32, CreateCompatibleBitmap);
		SYM(lib_gdi32, SelectObject); SYM(lib_gdi32, BitBlt); SYM(lib_gdi32, GetDIBits);
		SYM(lib_gdi32, DeleteObject); SYM(lib_gdi32, DeleteDC);
		SYM(lib_kernel, WideCharToMultiByte); SYM(lib_kernel, MultiByteToWideChar);
		SYM(lib_kernel, SetThreadExecutionState);
		SYM(lib_kernel, OpenProcess); SYM(lib_kernel, QueryFullProcessImageNameW);
		SYM(lib_kernel, CloseHandle);
		#undef SYM
		if (!GetSystemMetrics_p || !GetDC_p || !EnumWindows_p || !SendInput_p || !VkKeyScanW_p ||
		    !CreateCompatibleDC_p || !CreateCompatibleBitmap_p || !BitBlt_p || !GetDIBits_p) {
			error = "win32 symbols missing";
			return false;
		}
		has_shm = CreateDCW_p != nullptr;   // capture possible once the display DC opens
		has_xtest = SendInput_p != nullptr;  // injection available at this integrity level
		// Session 0 / non-interactive winstation (services, schtasks SYSTEM):
		// SendInput "succeeds" into a void desktop there — flag it once so
		// replies can name the real cause instead of silently no-op'ing.
		session0 = false;
		if (GetProcessWindowStation_p && GetUserObjectInformationA_p) {
			HWINSTA ws = GetProcessWindowStation_p();
			char wname[128] = {}; DWORD need = 0;
			if (ws && GetUserObjectInformationA_p(ws, 2 /*UOI_NAME*/, wname, sizeof(wname) - 1, &need))
				session0 = strcmp(wname, "WinSta0") != 0;
		}
		if (session0) has_xtest = false;
		ok = true;
		return true;
	}

	// ---- geometry helpers -----------------------------------------------------

	void virtual_origin(int& x, int& y, int& w, int& h) {
		x = GetSystemMetrics_p(SM_XVIRTUALSCREEN);
		y = GetSystemMetrics_p(SM_YVIRTUALSCREEN);
		w = GetSystemMetrics_p(SM_CXVIRTUALSCREEN);
		h = GetSystemMetrics_p(SM_CYVIRTUALSCREEN);
		if (w <= 0) w = GetSystemMetrics_p(SM_CXSCREEN);
		if (h <= 0) h = GetSystemMetrics_p(SM_CYSCREEN);
	}

	bool display_size(int& w, int& h) {
		if (!ok) return false;
		int x = 0, y = 0;
		virtual_origin(x, y, w, h);
		return w > 0 && h > 0;
	}
	bool display_size(const std::string& /*disp*/, int& w, int& h) { return display_size(w, h); }

	// coords already live in the virtual-screen space (0,0 = bbox top-left),
	// so the capture-space origin is always (0,0)
	bool display_origin(const std::string& /*disp*/, int& ox, int& oy) { ox = 0; oy = 0; return ok; }
	double scale_factor() { return 1.0; } // Windows reports pixels directly — no point/pixel split
	bool pixel_size(int& w, int& h) { return display_size(w, h); }
	bool pixel_size(const std::string& /*disp*/, int& w, int& h) { return pixel_size(w, h); }

	// ---- capture --------------------------------------------------------------

	static void downscale_inplace(MemImage& img, double scale) {
		if (scale >= 1.0) return;
		int nw = std::max(1, int(img.width * scale));
		int nh = std::max(1, int(img.height * scale));
		std::vector<uint8_t> out(size_t(nw) * nh * 3);
		for (int y = 0; y < nh; y++) {
			int sy0 = int(y * img.height / nh), sy1 = std::max(sy0 + 1, int((y + 1) * img.height / nh));
			for (int x = 0; x < nw; x++) {
				int sx0 = int(x * img.width / nw), sx1 = std::max(sx0 + 1, int((x + 1) * img.width / nw));
				uint32_t r = 0, g = 0, b = 0, n = 0;
				for (int sy = sy0; sy < sy1 && sy < img.height; sy++)
					for (int sx = sx0; sx < sx1 && sx < img.width; sx++) {
						const uint8_t* p = &img.rgb[(size_t(sy) * img.width + sx) * 3];
						r += p[0]; g += p[1]; b += p[2]; n++;
					}
				uint8_t* q = &out[(size_t(y) * nw + x) * 3];
				q[0] = uint8_t(r / n); q[1] = uint8_t(g / n); q[2] = uint8_t(b / n);
			}
		}
		img.rgb = std::move(out);
		img.width = nw;
		img.height = nh;
	}

	// Pixel-only grab: caller coords are virtual-screen-relative (0,0 = bbox
	// top-left), same convention as the X11 root window. Fills img.rgb.
	bool grab_region(const std::string& /*disp*/, int rx, int ry, int rw, int rh,
	                 MemImage& img, std::string& err) {
		std::lock_guard<std::mutex> lock(m);
		if (!init()) { err = error; return false; }
		int vsx = 0, vsy = 0, vsw = 0, vsh = 0;
		virtual_origin(vsx, vsy, vsw, vsh);
		if (rw <= 0 || rw > vsw) rw = vsw;
		if (rh <= 0 || rh > vsh) rh = vsh;
		// translate caller coords into raw DC coords (virtual origin can be
		// negative with a left-of-primary monitor)
		int sx = vsx + rx, sy = vsy + ry;

		HDC screen = CreateDCW_p ? CreateDCW_p(L"DISPLAY", nullptr, nullptr, nullptr) : nullptr;
		if (!screen) screen = GetDC_p(nullptr); // primary-display fallback
		if (!screen) { err = "no display DC"; return false; }
		HDC mem = CreateCompatibleDC_p(screen);
		HBITMAP bmp = mem ? CreateCompatibleBitmap_p(screen, rw, rh) : nullptr;
		if (!mem || !bmp) {
			err = "BitBlt surface alloc failed";
			if (bmp) DeleteObject_p(bmp);
			if (mem) DeleteDC_p(mem);
			if (CreateDCW_p) DeleteDC_p(screen); else ReleaseDC_p(nullptr, screen);
			return false;
		}
		HGDIOBJ old = SelectObject_p(mem, bmp);
		if (!BitBlt_p(mem, 0, 0, rw, rh, screen, sx, sy, SRCCOPY)) {
			err = "BitBlt failed";
			SelectObject_p(mem, old);
			DeleteObject_p(bmp); DeleteDC_p(mem);
			if (CreateDCW_p) DeleteDC_p(screen); else ReleaseDC_p(nullptr, screen);
			return false;
		}
		BITMAPINFO bi{};
		bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
		bi.bmiHeader.biWidth = rw;
		bi.bmiHeader.biHeight = -rh; // top-down rows
		bi.bmiHeader.biPlanes = 1;
		bi.bmiHeader.biBitCount = 32;
		bi.bmiHeader.biCompression = BI_RGB;
		std::vector<uint8_t> bgra(size_t(rw) * rh * 4);
		int rows = GetDIBits_p(mem, bmp, 0, UINT(rh), bgra.data(), &bi, DIB_RGB_COLORS);
		SelectObject_p(mem, old);
		DeleteObject_p(bmp);
		DeleteDC_p(mem);
		if (CreateDCW_p) DeleteDC_p(screen); else ReleaseDC_p(nullptr, screen);
		if (rows != rh) { err = "GetDIBits failed"; return false; }
		img.width = rw;
		img.height = rh;
		img.rgb.resize(size_t(rw) * rh * 3);
		for (size_t i = 0, n = size_t(rw) * rh; i < n; i++) {
			img.rgb[i * 3 + 0] = bgra[i * 4 + 2]; // B
			img.rgb[i * 3 + 1] = bgra[i * 4 + 1]; // G
			img.rgb[i * 3 + 2] = bgra[i * 4 + 0]; // R
		}
		return true;
	}

	// Downscaled RGB thumb for the pixel-differ (watch frames)
	bool grab_thumb(const std::string& disp, int tw, int th, std::vector<uint8_t>& rgb) {
		MemImage img; std::string err;
		if (!grab_region(disp, 0, 0, -1, -1, img, err)) return false;
		rgb.resize(size_t(tw) * th * 3);
		for (int y = 0; y < th; y++) {
			const uint8_t* row = img.rgb.data() + size_t(y * img.height / th) * img.width * 3;
			uint8_t* dst = rgb.data() + size_t(y) * tw * 3;
			for (int x = 0; x < tw; x++) memcpy(dst + x * 3, row + size_t(x) * img.width / tw * 3, 3);
		}
		return true;
	}

	// Encode img.rgb to fmt bytes. stb is the only encoder on Windows
	// (used_libpng stays false; capture_encoder() reports "stb").
	bool encode_memimg(MemImage& img, const std::string& fmt, int jpg_quality,
	                   std::vector<uint8_t>& encoded, std::string& err) {
		used_libpng = false;
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

	// Returns encoded image bytes. fmt: "png" | "jpg".
	bool capture(const std::string& disp, int rx, int ry, int rw, int rh, double scale,
	             const std::string& fmt, int jpg_quality, MemImage& img,
	             std::vector<uint8_t>& encoded, std::string& err) {
		auto t0 = std::chrono::steady_clock::now();
		if (!grab_region(disp, rx, ry, rw, rh, img, err)) return false;
		auto t1 = std::chrono::steady_clock::now();
		downscale_inplace(img, scale);
		bool enc_ok = encode_memimg(img, fmt, jpg_quality, encoded, err);
		auto t2 = std::chrono::steady_clock::now();
		last_capture_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
		last_encode_ms = std::chrono::duration<double, std::milli>(t2 - t1).count();
		return enc_ok;
	}

	// Watch split: probe grabs + thumbs the (optionally regioned) frame and
	// retains it; encode only runs when the differ says pixels changed — idle
	// watch ticks never pay the encode cost. The kept frame lives in watch_img.
	bool watch_probe(const std::string& disp, int rx, int ry, int rw, int rh,
	                 int tw, int th, std::vector<uint8_t>& thumb_rgb, std::string& err) {
		auto t0 = std::chrono::steady_clock::now();
		if (!grab_region(disp, rx, ry, rw, rh, watch_img, err)) return false;
		last_capture_ms = std::chrono::duration<double, std::milli>(
			std::chrono::steady_clock::now() - t0).count();
		thumb_rgb.resize(size_t(tw) * th * 3);
		for (int y = 0; y < th; y++) {
			const uint8_t* row = watch_img.rgb.data() + size_t(y * watch_img.height / th) * watch_img.width * 3;
			uint8_t* dst = thumb_rgb.data() + size_t(y) * tw * 3;
			for (int x = 0; x < tw; x++) memcpy(dst + x * 3, row + size_t(x) * watch_img.width / tw * 3, 3);
		}
		return true;
	}

	bool watch_encode(const std::string& /*disp*/, double scale, const std::string& fmt, int quality,
	                  MemImage& img, std::vector<uint8_t>& encoded, std::string& err) {
		if (watch_img.rgb.empty()) { err = "no probed frame"; return false; }
		auto t0 = std::chrono::steady_clock::now();
		img = watch_img; // copy: the retained frame survives the downscale
		downscale_inplace(img, scale);
		bool enc_ok = encode_memimg(img, fmt, quality, encoded, err);
		last_encode_ms = std::chrono::duration<double, std::milli>(
			std::chrono::steady_clock::now() - t0).count();
		return enc_ok;
	}

	void watch_release() { watch_img.rgb.clear(); watch_img.width = watch_img.height = 0; }

	// Legacy fused path kept for interface parity (one grab feeding differ + encoder).
	bool watch_frame(const std::string& disp, double scale, const std::string& fmt, int quality,
	                 int tw, int th, std::vector<uint8_t>& thumb_rgb, MemImage& img,
	                 std::vector<uint8_t>& encoded, std::string& err) {
		if (!watch_probe(disp, 0, 0, -1, -1, tw, th, thumb_rgb, err)) return false;
		return watch_encode(disp, scale, fmt, quality, img, encoded, err);
	}

	// ---- input ----------------------------------------------------------------

	bool send_input(INPUT& in) { return SendInput_p(1, &in, int(sizeof(INPUT))) == 1; }

	bool motion(const std::string& /*disp*/, int x, int y) {
		std::lock_guard<std::mutex> lock(m);
		if (!ok || !has_xtest) return false;
		int vsx = 0, vsy = 0, vsw = 0, vsh = 0;
		virtual_origin(vsx, vsy, vsw, vsh);
		(void)vsx; (void)vsy; // caller coords are already virtual-relative
		INPUT in{};
		in.type = INPUT_MOUSE;
		in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
		in.mi.dx = LONG(std::clamp<int64_t>(int64_t(x) * 65535 / std::max(1, vsw - 1), 0, 65535));
		in.mi.dy = LONG(std::clamp<int64_t>(int64_t(y) * 65535 / std::max(1, vsh - 1), 0, 65535));
		return send_input(in);
	}

	bool button(const std::string& /*disp*/, int num, bool press) {
		std::lock_guard<std::mutex> lock(m);
		if (!ok || !has_xtest) return false;
		// X11 scroll buttons 4/5 map to a wheel event, same as the mac backend
		if (num == 4 || num == 5) {
			if (!press) return true;
			INPUT in{};
			in.type = INPUT_MOUSE;
			in.mi.dwFlags = MOUSEEVENTF_WHEEL;
			in.mi.mouseData = DWORD(num == 4 ? WHEEL_DELTA : -int(WHEEL_DELTA));
			return send_input(in);
		}
		DWORD flag = 0;
		if (num == 1) flag = press ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
		else if (num == 2) flag = press ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
		else if (num == 3) flag = press ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
		else return false;
		INPUT in{};
		in.type = INPUT_MOUSE;
		in.mi.dwFlags = flag;
		return send_input(in);
	}

	// Wheel scroll: one real wheel event per call — dy > 0 scrolls up,
	// dy < 0 down, dx > 0 right (button 4/5/6/7 semantics, 120/notch).
	bool scroll(const std::string& /*disp*/, int dx, int dy) {
		std::lock_guard<std::mutex> lock(m);
		if (!ok || !has_xtest) return false;
		bool sent = true;
		if (dy != 0) {
			INPUT in{};
			in.type = INPUT_MOUSE;
			in.mi.dwFlags = MOUSEEVENTF_WHEEL;
			in.mi.mouseData = DWORD(dy * int(WHEEL_DELTA));
			sent = send_input(in) && sent;
		}
		if (dx != 0) {
			INPUT in{};
			in.type = INPUT_MOUSE;
			in.mi.dwFlags = MOUSEEVENTF_HWHEEL;
			in.mi.mouseData = DWORD(dx * int(WHEEL_DELTA));
			sent = send_input(in) && sent;
		}
		return sent;
	}

	bool keycode_press(const std::string& /*disp*/, unsigned kc, bool press) {
		std::lock_guard<std::mutex> lock(m);
		if (!ok || !has_xtest) return false;
		INPUT in{};
		in.type = INPUT_KEYBOARD;
		in.ki.wVk = WORD(kc);
		if (!press) in.ki.dwFlags = KEYEVENTF_KEYUP;
		return send_input(in);
	}

	// One UTF-8 byte at a time, like the mac backend: ASCII goes through
	// VkKeyScanW (real keystrokes, works everywhere incl. apps that filter
	// unicode events); multi-byte chars assemble into codepoints and inject
	// via KEYEVENTF_UNICODE.
	uint32_t utf8_pending = 0;
	int utf8_need = 0;

	bool type_char(const std::string& /*disp*/, unsigned char ch) {
		std::lock_guard<std::mutex> lock(m);
		if (!ok || !has_xtest) return false;
		if (ch < 0x80) {
			utf8_pending = 0; utf8_need = 0;
			return emit_ascii(char(ch));
		}
		if (utf8_need > 0) {
			utf8_pending = (utf8_pending << 6) | (ch & 0x3F);
			if (--utf8_need == 0) return type_cp(utf8_pending);
			return true;
		}
		if ((ch & 0xE0) == 0xC0) { utf8_pending = ch & 0x1F; utf8_need = 1; return true; }
		if ((ch & 0xF0) == 0xE0) { utf8_pending = ch & 0x0F; utf8_need = 2; return true; }
		if ((ch & 0xF8) == 0xF0) { utf8_pending = ch & 0x07; utf8_need = 3; return true; }
		return true; // stray continuation byte — drop
	}

	// Caller holds m.
	bool emit_ascii(char ch) {
		// control chars are keys, not text: a unicode/VkKeyScan CR never
		// reaches the layers that key on real VKs (dialog default buttons,
		// consoles, remote clients)
		if (ch == '\n' || ch == '\r') return key_vk(VK_RETURN, true) && key_vk(VK_RETURN, false);
		if (ch == '\t') return key_vk(VK_TAB, true) && key_vk(VK_TAB, false);
		if (ch == 0x08) return key_vk(VK_BACK, true) && key_vk(VK_BACK, false);
		if (ch == 0x1B) return key_vk(VK_ESCAPE, true) && key_vk(VK_ESCAPE, false);
		if (ch == 0x7F) return key_vk(VK_DELETE, true) && key_vk(VK_DELETE, false);
		SHORT ks = VkKeyScanW_p ? VkKeyScanW_p(WCHAR(uint8_t(ch))) : -1;
		if (ks == -1) return type_cp(uint8_t(ch));
		BYTE vk = LOBYTE(ks);
		BYTE st = HIBYTE(ks);
		WORD mods[3]; int nmod = 0;
		if (st & 1) mods[nmod++] = VK_SHIFT;
		if (st & 2) mods[nmod++] = VK_CONTROL;
		if (st & 4) mods[nmod++] = VK_MENU;
		for (int i = 0; i < nmod; i++) key_vk(vk_for_mod(mods[i]), true);
		key_vk(vk, true); key_vk(vk, false);
		for (int i = nmod - 1; i >= 0; i--) key_vk(vk_for_mod(mods[i]), false);
		return true;
	}

	// Full UTF-8 type: decodes to codepoints — ASCII takes the VkKeyScanW
	// keystroke path, everything else KEYEVENTF_UNICODE, delay between chars
	// like the x11/mac siblings.
	bool type_text(const std::string& /*disp*/, const std::string& text, int delay_ms) {
		std::lock_guard<std::mutex> lock(m);
		if (!ok || !has_xtest) return false;
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
			if (cp < 0x80) { if (!emit_ascii(char(cp))) return false; }
			else if (!type_cp(cp)) return false;
			if (delay_ms > 0)
				std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
		}
		return true;
	}

	static WORD vk_for_mod(WORD mod) {
		if (mod == VK_SHIFT) return VK_SHIFT;
		if (mod == VK_CONTROL) return VK_CONTROL;
		if (mod == VK_MENU) return VK_MENU;
		return mod;
	}

	bool key_vk(WORD vk, bool press) {
		INPUT in{};
		in.type = INPUT_KEYBOARD;
		in.ki.wVk = vk;
		if (!press) in.ki.dwFlags = KEYEVENTF_KEYUP;
		return send_input(in);
	}

	bool type_cp(uint32_t cp) {
		WCHAR u[2];
		int n;
		if (cp <= 0xFFFF) { u[0] = WCHAR(cp); n = 1; }
		else {
			cp -= 0x10000;
			u[0] = WCHAR(0xD800 + (cp >> 10));
			u[1] = WCHAR(0xDC00 + (cp & 0x3FF));
			n = 2;
		}
		bool sent = true;
		for (int i = 0; i < n; i++) {
			INPUT dn{}, up{};
			dn.type = INPUT_KEYBOARD; dn.ki.wScan = u[i]; dn.ki.dwFlags = KEYEVENTF_UNICODE;
			up = dn; up.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
			sent = send_input(dn) && sent;
			sent = send_input(up) && sent;
		}
		return sent;
	}

	// ---- queries / window control ----------------------------------------------

	bool query_pointer(const std::string& /*disp*/, int& x, int& y, unsigned long& child) {
		std::lock_guard<std::mutex> lock(m);
		if (!ok) return false;
		POINT p{};
		if (!GetCursorPos_p(&p)) return false;
		int vsx = 0, vsy = 0, vsw = 0, vsh = 0;
		virtual_origin(vsx, vsy, vsw, vsh);
		x = int(p.x) - vsx;
		y = int(p.y) - vsy;
		HWND under = WindowFromPoint_p ? WindowFromPoint_p(p) : nullptr;
		child = under ? (unsigned long)(ULONG_PTR)under : 0;
		return true;
	}

	struct WinInfo {
		unsigned long id = 0;            // low-32 token; id_to_hwnd keeps the HWND
		unsigned long pid = 0;           // owning process id — session window tracking
		std::string app;                 // owning process image basename (no .exe)
		std::string title;
		int x = 0, y = 0;
		unsigned int w = 0, h = 0;
		bool active = false;
	};

	// Owning-process name for a window pid ("Code.exe" → "Code").
	// PROCESS_QUERY_LIMITED_INFORMATION opens elevated/other-integrity
	// processes too, unlike FULL/VM_READ rights.
	std::string app_of_pid(DWORD pid) {
		if (!pid || !OpenProcess_p || !QueryFullProcessImageNameW_p || !CloseHandle_p) return {};
		HANDLE h = OpenProcess_p(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
		if (!h) return {};
		wchar_t buf[1024]; DWORD n = DWORD(sizeof(buf) / sizeof(buf[0]));
		std::wstring w;
		if (QueryFullProcessImageNameW_p(h, 0, buf, &n) && n > 0) w.assign(buf, n);
		CloseHandle_p(h);
		size_t sl = w.find_last_of(L"\\/");
		if (sl != std::wstring::npos) w = w.substr(sl + 1);
		if (w.size() > 4) {
			std::wstring ext = w.substr(w.size() - 4);
			for (auto& c : ext) c = wchar_t(towlower(c));
			if (ext == L".exe") w.resize(w.size() - 4);
		}
		std::string out;
		int need = WideCharToMultiByte_p(CP_UTF8, 0, w.data(), int(w.size()), nullptr, 0, nullptr, nullptr);
		if (need > 0) {
			out.assign(size_t(need), 0);
			WideCharToMultiByte_p(CP_UTF8, 0, w.data(), int(w.size()), out.data(), need, nullptr, nullptr);
		}
		return out;
	}

	std::string utf8_of(HWND wnd) {
		wchar_t buf[1024];
		int n = GetWindowTextW_p(wnd, buf, int(sizeof(buf) / sizeof(buf[0])));
		if (n <= 0) return {};
		int need = WideCharToMultiByte_p(CP_UTF8, 0, buf, n, nullptr, 0, nullptr, nullptr);
		if (need <= 0) return {};
		std::string out(size_t(need), 0);
		WideCharToMultiByte_p(CP_UTF8, 0, buf, n, out.data(), need, nullptr, nullptr);
		return out;
	}

	std::vector<WinInfo> windows(const std::string& /*disp*/) {
		std::lock_guard<std::mutex> lock(m);
		std::vector<WinInfo> out;
		if (!ok) return out;
		id_to_hwnd.clear();
		HWND shell = GetShellWindow_p ? GetShellWindow_p() : nullptr;
		HWND active = GetForegroundWindow_p ? GetForegroundWindow_p() : nullptr;
		int vsx = 0, vsy = 0, vsw = 0, vsh = 0;
		virtual_origin(vsx, vsy, vsw, vsh);
		struct Ctx { WinBackend* self; std::vector<WinInfo>* out; HWND shell, active; int vsx, vsy; };
		Ctx ctx{this, &out, shell, active, vsx, vsy};
		EnumWindows_p(+[](HWND wnd, LPARAM lp) -> BOOL {
			auto* c = reinterpret_cast<Ctx*>(lp);
			WinBackend* self = c->self;
			if (wnd == c->shell) return TRUE;
			if (!self->IsWindowVisible_p(wnd)) return TRUE;
			// skip shell furniture (taskbar, secondary trays, progman)
			wchar_t cls[64]{};
			if (self->GetClassNameW_p) {
				self->GetClassNameW_p(wnd, cls, int(sizeof(cls) / sizeof(cls[0])));
				if (wcscmp(cls, L"Shell_TrayWnd") == 0 || wcscmp(cls, L"Shell_SecondaryTrayWnd") == 0)
					return TRUE;
			}
			std::string title = self->utf8_of(wnd);
			if (title.empty()) return TRUE; // like _NET_CLIENT_LIST: title-bearing windows only
			RECT r{};
			WinInfo wi;
			if (self->GetWindowRect_p(wnd, &r)) {
				wi.x = int(r.left) - c->vsx;
				wi.y = int(r.top) - c->vsy;
				wi.w = unsigned(std::max(0L, r.right - r.left));
				wi.h = unsigned(std::max(0L, r.bottom - r.top));
			}
			DWORD wpid = 0;
			if (self->GetWindowThreadProcessId_p) self->GetWindowThreadProcessId_p(wnd, &wpid);
			wi.pid = (unsigned long)wpid;
			wi.app = self->app_of_pid(wpid);
			wi.title = title;
			wi.active = wnd == c->active;
			wi.id = (unsigned long)(ULONG_PTR)wnd;
			if (self->GetWindowThreadProcessId_p) {
				DWORD wp = 0;
				self->GetWindowThreadProcessId_p(wnd, &wp);
				wi.pid = (unsigned long)wp;
			}
			self->id_to_hwnd[wi.id] = wnd;
			c->out->push_back(wi);
			return TRUE;
		}, reinterpret_cast<LPARAM>(&ctx));
		return out;
	}

	HWND hwnd_of(unsigned long id) {
		auto it = id_to_hwnd.find(id);
		return it != id_to_hwnd.end() ? it->second : reinterpret_cast<HWND>(ULONG_PTR(id));
	}

	bool window_activate(const std::string& /*disp*/, unsigned long id) {
		std::lock_guard<std::mutex> lock(m);
		if (!ok) return false;
		HWND wnd = hwnd_of(id);
		if (!wnd || !IsWindow_p || !IsWindow_p(wnd)) return false;
		if (IsIconic_p && IsIconic_p(wnd)) { if (ShowWindow_p) ShowWindow_p(wnd, SW_RESTORE); }
		else if (ShowWindow_p) ShowWindow_p(wnd, SW_SHOW);
		// SetForegroundWindow fails for background daemons unless the caller is
		// input-attached to the current foreground thread — attach, raise, detach
		DWORD fg = (GetWindowThreadProcessId_p && GetForegroundWindow_p)
			? GetWindowThreadProcessId_p(GetForegroundWindow_p(), nullptr) : 0;
		DWORD me = GetCurrentThreadId();
		bool attached = fg != 0 && fg != me && AttachThreadInput_p && AttachThreadInput_p(me, fg, TRUE);
		if (BringWindowToTop_p) BringWindowToTop_p(wnd);
		BOOL raised = SetForegroundWindow_p ? SetForegroundWindow_p(wnd) : FALSE;
		if (attached) AttachThreadInput_p(me, fg, FALSE);
		return raised != FALSE;
	}

	bool window_close(const std::string& /*disp*/, unsigned long id) {
		std::lock_guard<std::mutex> lock(m);
		if (!ok) return false;
		HWND wnd = hwnd_of(id);
		if (!wnd || !IsWindow_p || !IsWindow_p(wnd)) return false;
		return PostMessageW_p && PostMessageW_p(wnd, WM_CLOSE, 0, 0);
	}

	// Foreground app name: foreground HWND → pid → image basename.
	std::string frontmost_app() {
		std::lock_guard<std::mutex> lock(m);
		if (!ok) return "";
		HWND w = GetForegroundWindow_p ? GetForegroundWindow_p() : nullptr;
		DWORD pid = 0;
		if (w && GetWindowThreadProcessId_p) GetWindowThreadProcessId_p(w, &pid);
		return app_of_pid(pid);
	}

	// Press a key combo ("ctrl+shift+t", "Return", "ctrl+plus") via SendInput.
	// Same vocabulary as x11.hpp/mac.hpp; single chars resolve via VkKeyScanW
	// (its shift-state byte is honored, like the X11 shifted-layer check).
	bool key_combo(const std::string& /*disp*/, const std::string& combo) {
		struct Named { const char* name; WORD vk; };
		static const Named mods[] = {
			{"ctrl", VK_CONTROL}, {"control", VK_CONTROL}, {"shift", VK_SHIFT},
			{"alt", VK_MENU}, {"option", VK_MENU},
			{"meta", VK_LWIN}, {"super", VK_LWIN}, {"win", VK_LWIN},
			{"cmd", VK_LWIN}, {"command", VK_LWIN},
		};
		static const Named named[] = {
			{"return", VK_RETURN}, {"enter", VK_RETURN}, {"esc", VK_ESCAPE}, {"escape", VK_ESCAPE},
			{"tab", VK_TAB}, {"backspace", VK_BACK}, {"delete", VK_DELETE}, {"home", VK_HOME},
			{"end", VK_END}, {"pageup", VK_PRIOR}, {"pagedown", VK_NEXT},
			{"up", VK_UP}, {"down", VK_DOWN}, {"left", VK_LEFT}, {"right", VK_RIGHT},
			{"space", VK_SPACE}, {"plus", VK_OEM_PLUS}, {"minus", VK_OEM_MINUS},
			{"capslock", VK_CAPITAL},
		};
		std::vector<WORD> mod_vks;
		SHORT main_ks = -1;
		WORD main_vk = 0;
		bool force_shift = false;
		std::istringstream iss(combo);
		std::string tok;
		while (std::getline(iss, tok, '+')) {
			std::string low = tok;
			for (char& ch : low) ch = char(std::tolower(unsigned(ch)));
			bool is_mod = false;
			for (auto& n : mods)
				if (low == n.name) { mod_vks.push_back(n.vk); is_mod = true; break; }
			if (is_mod) continue;
			if (main_vk || main_ks != -1) return false; // exactly one non-modifier per combo
			if (tok.size() == 1) {
				unsigned char ch = static_cast<unsigned char>(tok[0]);
				if (ch >= 'A' && ch <= 'Z') { ch = char(ch + 32); force_shift = true; }
				main_ks = VkKeyScanW_p ? VkKeyScanW_p(WCHAR(ch)) : -1;
				if (main_ks == -1) return false;
				main_vk = LOBYTE(main_ks);
				if (HIBYTE(main_ks) & 1) force_shift = true;
			} else {
				for (auto& n : named)
					if (low == n.name) { main_vk = n.vk; break; }
				if (!main_vk && low[0] == 'f' && low.size() <= 3) {
					int fn = std::atoi(low.c_str() + 1);
					if (fn >= 1 && fn <= 12) main_vk = WORD(VK_F1 + fn - 1);
				}
				if (!main_vk) return false;
				main_ks = 0; // resolved directly
			}
		}
		if (!main_vk) return false;
		if (force_shift) mod_vks.push_back(VK_SHIFT);

		std::lock_guard<std::mutex> lock(m);
		if (!ok || !has_xtest) return false;
		for (WORD v : mod_vks) key_vk(v, true);
		key_vk(main_vk, true);
		key_vk(main_vk, false);
		for (auto it = mod_vks.rbegin(); it != mod_vks.rend(); ++it) key_vk(*it, false);
		return true;
	}

	// --- keep-awake -------------------------------------------------------------
	// ES_CONTINUOUS pins the flags until cleared; DISPLAY_REQUIRED keeps the
	// screen on, SYSTEM_REQUIRED stops idle sleep — the IOPMAssertion analog.
	// AWAYMODE lets the session keep running while the machine reports "away"
	// (only honored when the active power plan enables away mode — otherwise
	// it's a documented no-op, not an error). Lid-close still follows the
	// plan's lid action — see the lidClose guidance in rig.stayAwake.
	bool stay_awake(bool on) {
		if (!SetThreadExecutionState_p) return false;
		EXECUTION_STATE st = on
			? EXECUTION_STATE(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED | 0x40 /*ES_AWAYMODE_REQUIRED*/)
			: ES_CONTINUOUS;
		bool held = SetThreadExecutionState_p(st) != 0;
		if (held) awake_held = on;
		return held;
	}
	bool awake_held = false;
	const char* awake_method() { return awake_held ? "execution-state" : "none"; }
	bool awake_held_os() { return awake_held; }

	// window-scoped capture — honest no on win32: sessions get real virtual
	// desktops instead, so a full-display shot IS already session-scoped
	bool capture_window(const std::string& /*disp*/, uint32_t /*wid*/, double /*scale*/,
	                    const std::string& /*fmt*/, int /*quality*/, MemImage& /*img*/,
	                    std::vector<uint8_t>& /*encoded*/, std::string& err) {
		err = "wid-scoped capture not supported on Windows — sessions use their own desktop";
		return false;
	}

	bool request_perms() { return false; } // Windows has no runtime grants to ask for

	// ---- virtual desktops ----------------------------------------------------
	// IVirtualDesktopManagerInternal COM service — undocumented, but the
	// interface IID + vtable order are stable within an OS build; the table
	// below is the Windows 10 21H2 / Server 2022 (build 20348) layout. When
	// the shell refuses the service (other builds), space ops fall back to
	// the documented keyboard shortcuts (Win+Ctrl+D / Win+Ctrl+Left|Right)
	// and the daemon keeps best-effort count/current bookkeeping.
	struct VdIObjectArray : IUnknown {
		virtual HRESULT STDMETHODCALLTYPE GetCount(unsigned int* count) = 0;
		virtual HRESULT STDMETHODCALLTYPE GetAt(unsigned int index, const GUID& iid, void** obj) = 0;
	};
	struct VdIDesktop : IUnknown {
		virtual HRESULT STDMETHODCALLTYPE IsViewVisible(IUnknown* view, int* visible) = 0;
		virtual HRESULT STDMETHODCALLTYPE GetId(GUID* id) = 0;
		virtual HRESULT STDMETHODCALLTYPE Unknown1(void** out) = 0;
		virtual HRESULT STDMETHODCALLTYPE GetName(void** hstr) = 0;
	};
	struct VdIManagerInternal : IUnknown {
		virtual HRESULT STDMETHODCALLTYPE GetCount(HWND h, int* count) = 0;
		virtual HRESULT STDMETHODCALLTYPE MoveViewToDesktop(IUnknown* view, VdIDesktop* d) = 0;
		virtual HRESULT STDMETHODCALLTYPE CanViewMoveDesktops(IUnknown* view, int* can) = 0;
		virtual HRESULT STDMETHODCALLTYPE GetCurrentDesktop(HWND h, VdIDesktop** d) = 0;
		virtual HRESULT STDMETHODCALLTYPE GetDesktops(HWND h, VdIObjectArray** arr) = 0;
		virtual HRESULT STDMETHODCALLTYPE GetAdjacentDesktop(VdIDesktop* from, int dir, VdIDesktop** d) = 0;
		virtual HRESULT STDMETHODCALLTYPE SwitchDesktop(HWND h, VdIDesktop* d) = 0;
		virtual HRESULT STDMETHODCALLTYPE CreateDesktop(HWND h, VdIDesktop** d) = 0;
		virtual HRESULT STDMETHODCALLTYPE RemoveDesktop(VdIDesktop* d, VdIDesktop* fallback) = 0;
		virtual HRESULT STDMETHODCALLTYPE FindDesktop(GUID* id, VdIDesktop** d) = 0;
		virtual HRESULT STDMETHODCALLTYPE GetDesktopSwitchIncludeExcludeViews(VdIDesktop* d, VdIObjectArray** a, VdIObjectArray** b) = 0;
		virtual HRESULT STDMETHODCALLTYPE SetDesktopName(VdIDesktop* d, void* hstr) = 0;
		virtual HRESULT STDMETHODCALLTYPE CopyDesktopState(IUnknown* v0, IUnknown* v1) = 0;
		virtual HRESULT STDMETHODCALLTYPE GetDesktopIsPerMonitor(int* pm) = 0;
	};
	struct VdIServiceProvider : IUnknown {
		virtual HRESULT STDMETHODCALLTYPE QueryService(const GUID& service, const GUID& riid, void** ppv) = 0;
	};

	// The DOCUMENTED per-window API: IVirtualDesktopManager.MoveWindowToDesktop
	// takes a plain HWND + target desktop GUID — no "view" plumbing needed.
	struct VdIDesktopManager : IUnknown {
		virtual HRESULT STDMETHODCALLTYPE IsWindowOnCurrentVirtualDesktop(HWND w, int* on) = 0;
		virtual HRESULT STDMETHODCALLTYPE GetWindowDesktopId(HWND w, GUID* id) = 0;
		virtual HRESULT STDMETHODCALLTYPE MoveWindowToDesktop(HWND w, const GUID& id) = 0;
	};

	static constexpr GUID vd_clsid_shell = {0xC2F03A33, 0x21F5, 0x47FA, {0xB4, 0xBB, 0x15, 0x63, 0x62, 0xA2, 0xF2, 0x39}};
	static constexpr GUID vd_sid_mgr     = {0xC5E0CDCA, 0x7B6E, 0x41B2, {0x9F, 0xC4, 0xD9, 0x39, 0x75, 0xCC, 0x46, 0x7B}};
	static constexpr GUID vd_iid_sp      = {0x6D5140C1, 0x7436, 0x11CE, {0x80, 0x34, 0x00, 0xAA, 0x00, 0x60, 0x09, 0xFA}};
	static constexpr GUID vd_iid_mgr     = {0x094AFE11, 0x44F2, 0x4BA0, {0x97, 0x6F, 0x29, 0xA9, 0x7E, 0x26, 0x3E, 0xE0}};
	static constexpr GUID vd_iid_desktop = {0x62FDF88B, 0x11CA, 0x4AFB, {0x8B, 0xD8, 0x22, 0x96, 0xDF, 0xAE, 0x49, 0xE2}};
	static constexpr GUID vd_clsid_mgr   = {0xAA509086, 0x5CA9, 0x4C25, {0x8F, 0x95, 0x58, 0x9D, 0x3C, 0x07, 0xB4, 0x8A}};
	static constexpr GUID vd_iid_mgr_pub = {0xA5CD92FF, 0x29BE, 0x454C, {0x8D, 0x04, 0xD8, 0x28, 0x79, 0xFB, 0x3F, 0x1B}};

	// ole32 — resolved lazily like the user32/gdi32 syms (space ops only)
	void* lib_ole32 = nullptr;
	HRESULT(WINAPI* CoInitializeEx_p)(void*, DWORD) = nullptr;
	HRESULT(WINAPI* CoCreateInstance_p)(const GUID&, IUnknown*, DWORD, const GUID&, void**) = nullptr;

	std::mutex vdm;                 // serializes space ops + the kbd counters
	int kbd_space_current = -1;     // -1 = unknown (honest -1 in status)
	int kbd_space_count = -1;

	bool vd_ole_init() {
		if (!lib_ole32) {
			lib_ole32 = LoadLibraryA("ole32.dll");
			if (!lib_ole32) return false;
			CoInitializeEx_p = sym<decltype(CoInitializeEx_p)>(lib_ole32, "CoInitializeEx");
			CoCreateInstance_p = sym<decltype(CoCreateInstance_p)>(lib_ole32, "CoCreateInstance");
		}
		return CoInitializeEx_p && CoCreateInstance_p;
	}

	// Acquire the manager for one call — interfaces are released before the
	// space_* callers return, so no COM pointer crosses threads or calls.
	bool vd_open(VdIManagerInternal** out) {
		*out = nullptr;
		if (!vd_ole_init()) return false;
		// MTA per-thread init (0 == COINIT_MULTITHREADED; the old literal 2 is
		// STA — wrong apartment for this call). RPC_E_CHANGED_MODE only means
		// the thread is already COM-initialized differently — still usable,
		// the shell service resolves through the proxy either way.
		HRESULT ci = CoInitializeEx_p(nullptr, 0 /*COINIT_MULTITHREADED*/);
		if (ci < 0 && ci != (HRESULT)0x80010106 /*RPC_E_CHANGED_MODE*/) return false;
		VdIServiceProvider* sp = nullptr;
		HRESULT hr = CoCreateInstance_p(vd_clsid_shell, nullptr, 0x17 /*CLSCTX_ALL*/,
		                              vd_iid_sp, reinterpret_cast<void**>(&sp));
		if (hr < 0 || !sp) return false;
		hr = sp->QueryService(vd_sid_mgr, vd_iid_mgr, reinterpret_cast<void**>(out));
		sp->Release();
		return hr >= 0 && *out;
	}

	static int vd_index_of(VdIManagerInternal* mgr, const GUID& id) {
		VdIObjectArray* arr = nullptr;
		if (mgr->GetDesktops(nullptr, &arr) < 0 || !arr) return -1;
		unsigned int n = 0;
		int idx = -1;
		arr->GetCount(&n);
		for (unsigned int i = 0; i < n; i++) {
			VdIDesktop* d = nullptr;
			if (arr->GetAt(i, vd_iid_desktop, reinterpret_cast<void**>(&d)) >= 0 && d) {
				GUID g{};
				d->GetId(&g);
				d->Release();
				if (memcmp(&g, &id, sizeof(GUID)) == 0) { idx = int(i); break; }
			}
		}
		arr->Release();
		return idx;
	}

	// Shell shortcuts do the work when the COM service won't cooperate:
	// Win+Ctrl+D creates + enters a trailing desktop, Win+Ctrl+Left/Right
	// cycles relatively (absolute index needs a tracked current).
	int kbd_space_new_locked() {
		if (!key_combo("", "win+ctrl+d")) return -1;
		if (kbd_space_count < 0) { kbd_space_count = 2; kbd_space_current = 1; } // assume baseline 1
		else { kbd_space_current = kbd_space_count++; }
		return kbd_space_current;
	}
	bool kbd_space_enter_locked(int idx) {
		if (idx < 0 || kbd_space_current < 0 || kbd_space_count <= 0 || idx >= kbd_space_count) return false;
		int delta = idx - kbd_space_current;
		const char* combo = delta > 0 ? "win+ctrl+right" : "win+ctrl+left";
		for (int i = delta > 0 ? delta : -delta; i > 0; i--)
			if (!key_combo("", combo)) return false;
		kbd_space_current = idx;
		return true;
	}

	int space_current(const std::string& /*disp*/) {
		std::lock_guard<std::mutex> lock(vdm);
		VdIManagerInternal* mgr = nullptr;
		if (!vd_open(&mgr)) return kbd_space_current;
		int idx = -1;
		VdIDesktop* cur = nullptr;
		if (mgr->GetCurrentDesktop(nullptr, &cur) >= 0 && cur) {
			GUID id{};
			cur->GetId(&id);
			idx = vd_index_of(mgr, id);
			cur->Release();
		}
		mgr->Release();
		kbd_space_current = idx; // real truth seeds the kbd bookkeeping
		return idx;
	}
	int space_count(const std::string& /*disp*/) {
		std::lock_guard<std::mutex> lock(vdm);
		VdIManagerInternal* mgr = nullptr;
		if (!vd_open(&mgr)) return kbd_space_count;
		int n = -1;
		mgr->GetCount(nullptr, &n);
		mgr->Release();
		kbd_space_count = n;
		return n;
	}
	// create a fresh trailing desktop and switch to it — returns its index
	int space_new(const std::string& /*disp*/) {
		std::lock_guard<std::mutex> lock(vdm);
		VdIManagerInternal* mgr = nullptr;
		if (!vd_open(&mgr)) return kbd_space_new_locked();
		VdIDesktop* d = nullptr;
		int idx = -1;
		if (mgr->CreateDesktop(nullptr, &d) >= 0 && d) {
			mgr->SwitchDesktop(nullptr, d);
			GUID id{};
			d->GetId(&id);
			idx = vd_index_of(mgr, id);
			d->Release();
		}
		mgr->Release();
		if (idx >= 0) kbd_space_current = idx;
		return idx;
	}
	bool space_enter(const std::string& /*disp*/, int idx) {
		std::lock_guard<std::mutex> lock(vdm);
		VdIManagerInternal* mgr = nullptr;
		if (!vd_open(&mgr)) return kbd_space_enter_locked(idx);
		bool ok2 = false;
		VdIObjectArray* arr = nullptr;
		if (idx >= 0 && mgr->GetDesktops(nullptr, &arr) >= 0 && arr) {
			VdIDesktop* d = nullptr;
			if (arr->GetAt(unsigned(idx), vd_iid_desktop, reinterpret_cast<void**>(&d)) >= 0 && d) {
				ok2 = mgr->SwitchDesktop(nullptr, d) >= 0;
				d->Release();
			}
			arr->Release();
		}
		mgr->Release();
		if (ok2) kbd_space_current = idx;
		return ok2;
	}

	// Uniform id-validation hook for wid-scoped requests (capture itself is
	// not supported here — the daemon still needs to tell "bad id" apart).
	bool window_exists(uint32_t wid) {
		return wid != 0 && IsWindow_p && IsWindow_p(reinterpret_cast<HWND>(ULONG_PTR(wid)));
	}

	// Move every top-level window owned by `pid` onto desktop `idx`.
	// Needs BOTH managers: the internal one to resolve idx → desktop GUID,
	// the documented public one to move the HWNDs. EnumWindows matches on
	// the owning pid; false when COM refuses or the pid owns no window.
	bool window_route_pid(const std::string& /*disp*/, unsigned long pid, int idx) {
		if (pid == 0 || idx < 0) return false;
		std::lock_guard<std::mutex> lock(vdm);
		GUID target{};
		{
			VdIManagerInternal* mgr = nullptr;
			if (!vd_open(&mgr)) return false;
			VdIObjectArray* arr = nullptr;
			bool got = false;
			if (mgr->GetDesktops(nullptr, &arr) >= 0 && arr) {
				VdIDesktop* d = nullptr;
				if (arr->GetAt(unsigned(idx), vd_iid_desktop, reinterpret_cast<void**>(&d)) >= 0 && d) {
					got = d->GetId(&target) >= 0;
					d->Release();
				}
				arr->Release();
			}
			mgr->Release();
			if (!got) return false;
		}
		VdIDesktopManager* dm = nullptr;
		if (CoCreateInstance_p(vd_clsid_mgr, nullptr, 0x17 /*CLSCTX_ALL*/,
		                     vd_iid_mgr_pub, reinterpret_cast<void**>(&dm)) < 0 || !dm)
			return false;
		// collect first, move second — moving a window changes which desktop
		// EnumWindows would surface for the current view
		std::vector<HWND> wins;
		struct RtCtx { std::vector<HWND>* w; unsigned long pid; WinBackend* self; };
		RtCtx ctx{&wins, pid, this};
		if (EnumWindows_p)
			EnumWindows_p([](HWND w, LPARAM lp) -> BOOL {
				auto* c = reinterpret_cast<RtCtx*>(lp);
				DWORD wp = 0;
				c->self->GetWindowThreadProcessId_p(w, &wp);
				if (wp == c->pid && (!c->self->IsWindowVisible_p || c->self->IsWindowVisible_p(w)))
					c->w->push_back(w);
				return TRUE;
			}, reinterpret_cast<LPARAM>(&ctx));
		bool any = false;
		for (HWND w : wins) any |= dm->MoveWindowToDesktop(w, target) >= 0;
		dm->Release();
		return any;
	}
};

static WinBackend g_win;

} // namespace rig
