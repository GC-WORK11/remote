// ---------------------------------------------------------------------------
// mac.hpp — native macOS computer-use backend, mirrors x11.hpp's surface.
// Everything dlopen'd at runtime; no frameworks at compile time, no ObjC code
// (libobjc runtime calls go through dlsym'd objc_msgSend).
//   inject : CGEvent posting (needs Accessibility TCC grant)
//   capture: CGWindowList + ImageIO/libturbojpeg encode (Screen Recording)
//   awake  : IOPMAssertion (no permission needed)
// `disp` params are accepted for interface parity and ignored: macOS has one
// real session display; there is no Xvfb-style virtual display.
// ---------------------------------------------------------------------------
#pragma once

#include <cstdint>
#include <atomic>
#include <cstring>
#include <string>
#include <vector>
#include <mutex>
#include <set>
#include <unordered_map>
#include <utility>
#include <sstream>
#include <thread>
#include <chrono>
#include <cmath>
#include <dlfcn.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/wait.h>

#include "../linux/x11.hpp" // MemImage, WinInfo shape shared across backends

namespace rig {

// ---- opaque CoreFoundation / CoreGraphics types --------------------------
using CFTypeRef = const void*;
using CFStringRef = const void*;
using CFMutableDataRef = void*;
using CFArrayRef = const void*;
using CFDictionaryRef = const void*;
using CFBooleanRef = const void*;
using CFNumberRef = const void*;
using CGImageRef = const void*;
using CGEventRef = void*;
using CGContextRef = void*;
using CGColorSpaceRef = void*;
using CGImageDestinationRef = void*;
using CFAllocatorRef = const void*; // kCFAllocatorDefault == NULL
struct CGPoint { double x, y; };
struct CGSize { double width, height; };
struct CGRect { CGPoint origin; CGSize size; };

// CGEventTypes.h constants
static constexpr int kCGEventMouseMoved = 5;
static constexpr int kCGEventLeftMouseDown = 1, kCGEventLeftMouseUp = 2;
static constexpr int kCGEventRightMouseDown = 3, kCGEventRightMouseUp = 4;
static constexpr int kCGEventLeftMouseDragged = 6, kCGEventRightMouseDragged = 7;
static constexpr int kCGEventOtherMouseDown = 25, kCGEventOtherMouseUp = 26;
static constexpr int kCGEventOtherMouseDragged = 27;
static constexpr int kCGHIDEventTap = 0;
static constexpr int kCGMouseButtonLeft = 0, kCGMouseButtonRight = 1, kCGMouseButtonCenter = 2;
static constexpr uint64_t kCGEventFlagMaskShift = 0x20000;
static constexpr uint64_t kCGEventFlagMaskControl = 0x40000;
static constexpr uint64_t kCGEventFlagMaskAlternate = 0x80000;
static constexpr uint64_t kCGEventFlagMaskCommand = 0x100000;
static constexpr int kCGScrollEventUnitPixel = 0;
// CGWindowListOption / CGWindowImageOption
static constexpr uint32_t kCGWindowListOptionOnScreenOnly = 1;
static constexpr uint32_t kCGWindowListOptionIncludingWindow = 2;
static constexpr uint32_t kCGWindowListExcludeDesktopElements = 16;
static constexpr uint32_t kCGWindowImageDefault = 0;
// CFNumber / CFString encodings
static constexpr int kCFNumberCGFloatType = 16;
static constexpr int kCFNumberFloat64Type = 13;
static constexpr int kCFNumberSInt32Type = 3;
static constexpr uint32_t kCFStringEncodingUTF8 = 0x08000100;
// host-native premultiplied-first ARGB/BGRA bitmap layout
static constexpr uint32_t kBitmapHostARGB = 2 /*alpha premult first*/ | (2 << 12) /*32Little*/;

struct MacBackend {
	void* lib_cf = nullptr;
	void* lib_cg = nullptr;
	void* lib_as = nullptr;
	void* lib_io = nullptr;
	void* lib_iokit = nullptr;
	bool tried = false;
	bool ok = false;
	// field names mirror x11.hpp so the protocol reply stays identical:
	//   has_xtest  = input injection possible (Accessibility trusted)
	//   has_shm    = screen capture possible (Screen Recording granted)
	bool has_shm = false;
	bool has_xtest = false;
	bool used_libpng = false;
	bool used_turbojpeg = false;
	// per-call timing split, read by the protocol layer for captureMs/encodeMs
	double last_capture_ms = 0, last_encode_ms = 0;
	const char* backend = "coregraphics";
	const char* capture_encoder() const {
		return used_turbojpeg ? "turbojpeg" : used_libpng ? "libpng-l1" : "imageio";
	}

	// CoreFoundation
	void (*CFRelease_p)(CFTypeRef) = nullptr;
	CFStringRef (*CFStringCreateWithCString_p)(CFAllocatorRef, const char*, uint32_t) = nullptr;
	bool (*CFStringGetCString_p)(CFStringRef, char*, long, uint32_t) = nullptr;
	long (*CFArrayGetCount_p)(CFArrayRef) = nullptr;
	CFTypeRef (*CFArrayGetValueAtIndex_p)(CFArrayRef, long) = nullptr;
	CFTypeRef (*CFDictionaryGetValue_p)(CFDictionaryRef, CFTypeRef) = nullptr;
	CFDictionaryRef (*CFDictionaryCreate_p)(CFAllocatorRef, const void**, const void**, long, const void*, const void*) = nullptr;
	bool (*CFNumberGetValue_p)(CFNumberRef, int, void*) = nullptr;
	CFNumberRef (*CFNumberCreate_p)(CFAllocatorRef, int, const void*) = nullptr;
	bool (*CFBooleanGetValue_p)(CFBooleanRef) = nullptr;
	CFMutableDataRef (*CFDataCreateMutable_p)(CFAllocatorRef, long) = nullptr;
	long (*CFDataGetLength_p)(CFTypeRef) = nullptr;
	const uint8_t* (*CFDataGetBytePtr_p)(CFTypeRef) = nullptr;
	// CoreGraphics
	uint32_t (*CGMainDisplayID_p)() = nullptr;
	CGRect (*CGDisplayBounds_p)(uint32_t) = nullptr;
	int (*CGGetActiveDisplayList_p)(uint32_t, uint32_t*, uint32_t*) = nullptr;
	bool (*CGPreflightScreenCaptureAccess_p)() = nullptr;
	bool (*CGRequestScreenCaptureAccess_p)() = nullptr;
	CGImageRef (*CGWindowListCreateImage_p)(CGRect, uint32_t, uint32_t, uint32_t) = nullptr;
	CFArrayRef (*CGWindowListCopyWindowInfo_p)(uint32_t, uint32_t) = nullptr;
	size_t (*CGImageGetWidth_p)(CGImageRef) = nullptr;
	size_t (*CGImageGetHeight_p)(CGImageRef) = nullptr;
	CGEventRef (*CGEventCreateMouseEvent_p)(void*, int, CGPoint, int) = nullptr;
	CGEventRef (*CGEventCreateKeyboardEvent_p)(void*, uint16_t, bool) = nullptr;
	void (*CGEventKeyboardSetUnicodeString_p)(CGEventRef, size_t, const uint16_t*) = nullptr;
	void* (*CGEventSourceCreate_p)(int32_t) = nullptr;
	void (*CGEventPost_p)(int, CGEventRef) = nullptr;
	void (*CGEventSetFlags_p)(CGEventRef, uint64_t) = nullptr;
	CGEventRef (*CGEventCreateScrollWheelEvent_p)(void*, int, uint32_t, int32_t, ...) = nullptr;
	CGEventRef (*CGEventCreate_p)(void*) = nullptr;
	CGPoint (*CGEventGetLocation_p)(CGEventRef) = nullptr;
	int (*CGWarpMouseCursorPosition_p)(CGPoint) = nullptr;
	CGContextRef (*CGBitmapContextCreate_p)(void*, size_t, size_t, size_t, size_t, CGColorSpaceRef, uint32_t) = nullptr;
	CGImageRef (*CGBitmapContextCreateImage_p)(CGContextRef) = nullptr;
	void (*CGContextDrawImage_p)(CGContextRef, CGRect, CGImageRef) = nullptr;
	void (*CGContextRelease_p)(CGContextRef) = nullptr;
	CGColorSpaceRef (*CGColorSpaceCreateDeviceRGB_p)() = nullptr;
	CFTypeRef (*CGImageGetDataProvider_p)(CGImageRef) = nullptr;
	CFTypeRef (*CGDataProviderCopyData_p)(CFTypeRef) = nullptr;
	size_t (*CGImageGetBytesPerRow_p)(CGImageRef) = nullptr;
	size_t (*CGImageGetBitsPerPixel_p)(CGImageRef) = nullptr;
	uint32_t (*CGImageGetBitmapInfo_p)(CGImageRef) = nullptr;
	// Carbon TextInputSources — char→keycode reverse map for real-key typing
	void* lib_hitb = nullptr;
	void* lib_ccore = nullptr;
	void* (*TISCopyCurrentKeyboardLayoutInputSource_p)() = nullptr;
	void* (*TISGetInputSourceProperty_p)(void*, CFStringRef) = nullptr;
	int32_t (*UCKeyTranslate_p)(const void*, uint16_t, uint16_t, uint32_t, uint32_t, uint32_t, uint32_t*, uint32_t, uint32_t*, uint16_t*) = nullptr;
	uint8_t (*LMGetKbdType_p)() = nullptr;
	// ApplicationServices / HIServices
	bool (*AXIsProcessTrusted_p)() = nullptr;
	bool (*AXIsProcessTrustedWithOptions_p)(CFDictionaryRef) = nullptr;
	void* (*AXUIElementCreateSystemWide_p)() = nullptr;
	int (*AXUIElementCopyAttributeValue_p)(void*, CFStringRef, void**) = nullptr;
	int (*AXUIElementGetPid_p)(void*, int*) = nullptr;
	void* (*AXUIElementCreateApplication_p)(int) = nullptr;
	int (*AXUIElementPerformAction_p)(void*, CFStringRef) = nullptr;
	int (*AXUIElementSetAttributeValue_p)(void*, CFStringRef, CFTypeRef) = nullptr;
	int (*AXUIElementSetMessagingTimeout_p)(void*, float) = nullptr;
	int (*AXValueGetValue_p)(void*, int, void*) = nullptr;
	// ImageIO
	CGImageDestinationRef (*CGImageDestinationCreateWithData_p)(CFMutableDataRef, CFStringRef, size_t, CFDictionaryRef) = nullptr;
	void (*CGImageDestinationAddImage_p)(CGImageDestinationRef, CGImageRef, CFDictionaryRef) = nullptr;
	bool (*CGImageDestinationFinalize_p)(CGImageDestinationRef) = nullptr;
	// IOKit power assertions
	int (*IOPMAssertionCreateWithName_p)(CFStringRef, uint32_t, CFStringRef, uint32_t*) = nullptr;
	int (*IOPMAssertionRelease_p)(uint32_t) = nullptr;
	// display mode (HiDPI: points vs pixels) — optional, scale_factor falls to 1
	CFTypeRef (*CGDisplayCopyDisplayMode_p)(uint32_t) = nullptr;
	size_t (*CGDisplayModeGetWidth_p)(CFTypeRef) = nullptr;
	size_t (*CGDisplayModeGetPixelWidth_p)(CFTypeRef) = nullptr;
	void (*CGDisplayModeRelease_p)(CFTypeRef) = nullptr;
	// libturbojpeg (fast JPEG path; ImageIO stays the fallback)
	void* lib_tj = nullptr;
	void* (*tjInitCompress_p)() = nullptr;
	int (*tjCompress2_p)(void*, const unsigned char*, int, int, int, int,
	                    unsigned char**, unsigned long*, int, int, int) = nullptr;
	void (*tjFree_p)(unsigned char*) = nullptr;
	int (*tjDestroy_p)(void*) = nullptr;
	// libobjc — NSRunningApplication for window_activate (no ObjC compilation)
	void* lib_objc = nullptr;
	void* lib_appkit = nullptr;
	void* (*objc_getClass_p)(const char*) = nullptr;
	void* (*sel_registerName_p)(const char*) = nullptr;
	void* (*objc_msgSend_p)() = nullptr; // cast per-call-site signature
	// libpng (fast PNG path; ImageIO stays the fallback) — same trick as x11.hpp
	void* lib_png = nullptr;
	unsigned (*png_access_version_number)() = nullptr;
	void* (*png_create_write_struct)(const char*, void*, void*, void*) = nullptr;
	void* (*png_create_info_struct)(void*) = nullptr;
	void (*png_destroy_write_struct)(void**, void**) = nullptr;
	void (*png_set_IHDR)(void*, void*, unsigned int, unsigned int, int, int, int, int, int) = nullptr;
	void (*png_set_compression_level)(void*, int) = nullptr;
	void (*png_set_write_fn)(void*, void*, void (*)(void*, unsigned char*, size_t), void (*)(void*)) = nullptr;
	void (*png_set_bgr)(void*) = nullptr;
	void (*png_write_info)(void*, void*) = nullptr;
	void (*png_write_row)(void*, unsigned char*) = nullptr;
	void (*png_write_end)(void*, void*) = nullptr;
	// static: the write sink is a non-capturing lambda (same as x11.hpp)
	inline static void* (*png_get_io_ptr)(void*) = nullptr;
	// extern CFString constants (resolved by name, dereferenced)
	CFStringRef kCGWindowNumber = nullptr;
	CFStringRef kCGWindowName = nullptr;
	CFStringRef kCGWindowOwnerName = nullptr;
	CFStringRef kCGWindowOwnerPID = nullptr;
	CFStringRef kCGWindowBounds = nullptr;
	CFStringRef kCGWindowLayer = nullptr;
	CFStringRef kCGWindowIsOnscreen = nullptr;
	CFStringRef kCGImageDestinationLossyCompressionQuality = nullptr;
	CFStringRef kIOPMAssertionTypePreventUserIdleSystemSleep = nullptr;
	CFStringRef kIOPMAssertionTypePreventUserIdleDisplaySleep = nullptr;
	CFStringRef kAXTrustedCheckOptionPrompt = nullptr;
	CFStringRef kTISPropertyUnicodeKeyLayoutData = nullptr;
	const void* kCFTypeDictionaryKeyCallBacks = nullptr;
	const void* kCFTypeDictionaryValueCallBacks = nullptr;
	CFBooleanRef kCFBooleanTrue = nullptr;

	std::mutex m;
	std::set<int> held_buttons;
	void* kbd_src = nullptr;         // shared CGEventSource for unicode typing
	std::unordered_map<uint32_t, std::pair<uint16_t, uint64_t>> keymap; // cp → (keycode, CG flags)
	bool keymap_built = false;
	uint32_t utf8_pending = 0;
	int utf8_need = 0;
	uint32_t sleep_assertion = 0;
	uint32_t display_assertion = 0;
	int64_t perms_checked_ms = 0;
	CGPoint last_pt{0, 0};        // last posted cursor pos — button() skips a
	                              // CGEventCreate+GetLocation round-trip
	CGImageRef watch_shot = nullptr; // retained probed frame for watch_encode
	double measured_scale = 0;    // real capture scale, measured off a full grab
	int meas_pw = 0, meas_ph = 0; //   (display modes lie on VM/HiDPI weirdness)

	template <typename T> static T sym(void* h, const char* n) {
		return h ? reinterpret_cast<T>(dlsym(h, n)) : nullptr;
	}
	static CFStringRef const_str(void* h, const char* n) {
		void** p = h ? static_cast<void**>(dlsym(h, n)) : nullptr;
		return p ? static_cast<CFStringRef>(*p) : nullptr;
	}

	bool init() {
		// TCC preflights are XPC calls (~1.4ms/pair) — cache them for a second
		// instead of paying them on every injected action
		if (tried) { refresh_perms_if_stale(); return ok; }
		tried = true;
		lib_cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", RTLD_LAZY | RTLD_GLOBAL);
		lib_cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY | RTLD_GLOBAL);
		lib_as = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY | RTLD_GLOBAL);
		lib_io = dlopen("/System/Library/Frameworks/ImageIO.framework/ImageIO", RTLD_LAZY | RTLD_GLOBAL);
		lib_iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY | RTLD_GLOBAL);
		if (!lib_cf || !lib_cg) return false;

		CFRelease_p = sym<decltype(CFRelease_p)>(lib_cf, "CFRelease");
		CFStringCreateWithCString_p = sym<decltype(CFStringCreateWithCString_p)>(lib_cf, "CFStringCreateWithCString");
		CFStringGetCString_p = sym<decltype(CFStringGetCString_p)>(lib_cf, "CFStringGetCString");
		CFArrayGetCount_p = sym<decltype(CFArrayGetCount_p)>(lib_cf, "CFArrayGetCount");
		CFArrayGetValueAtIndex_p = sym<decltype(CFArrayGetValueAtIndex_p)>(lib_cf, "CFArrayGetValueAtIndex");
		CFDictionaryGetValue_p = sym<decltype(CFDictionaryGetValue_p)>(lib_cf, "CFDictionaryGetValue");
		CFDictionaryCreate_p = sym<decltype(CFDictionaryCreate_p)>(lib_cf, "CFDictionaryCreate");
		CFNumberGetValue_p = sym<decltype(CFNumberGetValue_p)>(lib_cf, "CFNumberGetValue");
		CFNumberCreate_p = sym<decltype(CFNumberCreate_p)>(lib_cf, "CFNumberCreate");
		CFBooleanGetValue_p = sym<decltype(CFBooleanGetValue_p)>(lib_cf, "CFBooleanGetValue");
		CFDataCreateMutable_p = sym<decltype(CFDataCreateMutable_p)>(lib_cf, "CFDataCreateMutable");
		CFDataGetLength_p = sym<decltype(CFDataGetLength_p)>(lib_cf, "CFDataGetLength");
		CFDataGetBytePtr_p = sym<decltype(CFDataGetBytePtr_p)>(lib_cf, "CFDataGetBytePtr");
		void** p;
		// the *CallBacks externs are STRUCTS — pass their address, never deref
		kCFTypeDictionaryKeyCallBacks = dlsym(lib_cf, "kCFTypeDictionaryKeyCallBacks");
		kCFTypeDictionaryValueCallBacks = dlsym(lib_cf, "kCFTypeDictionaryValueCallBacks");
		p = static_cast<void**>(dlsym(lib_cf, "kCFBooleanTrue"));
		kCFBooleanTrue = p ? static_cast<CFBooleanRef>(*p) : nullptr;

		CGMainDisplayID_p = sym<decltype(CGMainDisplayID_p)>(lib_cg, "CGMainDisplayID");
		CGDisplayBounds_p = sym<decltype(CGDisplayBounds_p)>(lib_cg, "CGDisplayBounds");
		CGGetActiveDisplayList_p = sym<decltype(CGGetActiveDisplayList_p)>(lib_cg, "CGGetActiveDisplayList");
		CGPreflightScreenCaptureAccess_p = sym<decltype(CGPreflightScreenCaptureAccess_p)>(lib_cg, "CGPreflightScreenCaptureAccess");
		CGRequestScreenCaptureAccess_p = sym<decltype(CGRequestScreenCaptureAccess_p)>(lib_cg, "CGRequestScreenCaptureAccess");
		CGWindowListCreateImage_p = sym<decltype(CGWindowListCreateImage_p)>(lib_cg, "CGWindowListCreateImage");
		CGWindowListCopyWindowInfo_p = sym<decltype(CGWindowListCopyWindowInfo_p)>(lib_cg, "CGWindowListCopyWindowInfo");
		CGImageGetWidth_p = sym<decltype(CGImageGetWidth_p)>(lib_cg, "CGImageGetWidth");
		CGImageGetHeight_p = sym<decltype(CGImageGetHeight_p)>(lib_cg, "CGImageGetHeight");
		CGEventCreateMouseEvent_p = sym<decltype(CGEventCreateMouseEvent_p)>(lib_cg, "CGEventCreateMouseEvent");
		CGEventCreateKeyboardEvent_p = sym<decltype(CGEventCreateKeyboardEvent_p)>(lib_cg, "CGEventCreateKeyboardEvent");
		CGEventKeyboardSetUnicodeString_p = sym<decltype(CGEventKeyboardSetUnicodeString_p)>(lib_cg, "CGEventKeyboardSetUnicodeString");
		CGEventSourceCreate_p = sym<decltype(CGEventSourceCreate_p)>(lib_cg, "CGEventSourceCreate");
		CGEventPost_p = sym<decltype(CGEventPost_p)>(lib_cg, "CGEventPost");
		CGEventSetFlags_p = sym<decltype(CGEventSetFlags_p)>(lib_cg, "CGEventSetFlags");
		CGEventCreateScrollWheelEvent_p = sym<decltype(CGEventCreateScrollWheelEvent_p)>(lib_cg, "CGEventCreateScrollWheelEvent");
		CGEventCreate_p = sym<decltype(CGEventCreate_p)>(lib_cg, "CGEventCreate");
		CGEventGetLocation_p = sym<decltype(CGEventGetLocation_p)>(lib_cg, "CGEventGetLocation");
		CGWarpMouseCursorPosition_p = sym<decltype(CGWarpMouseCursorPosition_p)>(lib_cg, "CGWarpMouseCursorPosition");
		CGBitmapContextCreate_p = sym<decltype(CGBitmapContextCreate_p)>(lib_cg, "CGBitmapContextCreate");
		CGBitmapContextCreateImage_p = sym<decltype(CGBitmapContextCreateImage_p)>(lib_cg, "CGBitmapContextCreateImage");
		CGContextDrawImage_p = sym<decltype(CGContextDrawImage_p)>(lib_cg, "CGContextDrawImage");
		CGContextRelease_p = sym<decltype(CGContextRelease_p)>(lib_cg, "CGContextRelease");
		CGColorSpaceCreateDeviceRGB_p = sym<decltype(CGColorSpaceCreateDeviceRGB_p)>(lib_cg, "CGColorSpaceCreateDeviceRGB");
		CGImageGetDataProvider_p = sym<decltype(CGImageGetDataProvider_p)>(lib_cg, "CGImageGetDataProvider");
		CGDataProviderCopyData_p = sym<decltype(CGDataProviderCopyData_p)>(lib_cg, "CGDataProviderCopyData");
		CGImageGetBytesPerRow_p = sym<decltype(CGImageGetBytesPerRow_p)>(lib_cg, "CGImageGetBytesPerRow");
		CGImageGetBitsPerPixel_p = sym<decltype(CGImageGetBitsPerPixel_p)>(lib_cg, "CGImageGetBitsPerPixel");
		CGImageGetBitmapInfo_p = sym<decltype(CGImageGetBitmapInfo_p)>(lib_cg, "CGImageGetBitmapInfo");
		kCGWindowNumber = const_str(lib_cg, "kCGWindowNumber");
		kCGWindowName = const_str(lib_cg, "kCGWindowName");
		kCGWindowOwnerName = const_str(lib_cg, "kCGWindowOwnerName");
		kCGWindowOwnerPID = const_str(lib_cg, "kCGWindowOwnerPID");
		kCGWindowBounds = const_str(lib_cg, "kCGWindowBounds");
		kCGWindowLayer = const_str(lib_cg, "kCGWindowLayer");
		kCGWindowIsOnscreen = const_str(lib_cg, "kCGWindowIsOnscreen");

		AXIsProcessTrusted_p = sym<decltype(AXIsProcessTrusted_p)>(lib_as, "AXIsProcessTrusted");
		AXIsProcessTrustedWithOptions_p = sym<decltype(AXIsProcessTrustedWithOptions_p)>(lib_as, "AXIsProcessTrustedWithOptions");
		AXUIElementCreateSystemWide_p = sym<decltype(AXUIElementCreateSystemWide_p)>(lib_as, "AXUIElementCreateSystemWide");
		AXUIElementCopyAttributeValue_p = sym<decltype(AXUIElementCopyAttributeValue_p)>(lib_as, "AXUIElementCopyAttributeValue");
		AXUIElementGetPid_p = sym<decltype(AXUIElementGetPid_p)>(lib_as, "AXUIElementGetPid");
		AXUIElementCreateApplication_p = sym<decltype(AXUIElementCreateApplication_p)>(lib_as, "AXUIElementCreateApplication");
		AXUIElementPerformAction_p = sym<decltype(AXUIElementPerformAction_p)>(lib_as, "AXUIElementPerformAction");
		AXUIElementSetAttributeValue_p = sym<decltype(AXUIElementSetAttributeValue_p)>(lib_as, "AXUIElementSetAttributeValue");
		AXUIElementSetMessagingTimeout_p = sym<decltype(AXUIElementSetMessagingTimeout_p)>(lib_as, "AXUIElementSetMessagingTimeout");
		AXValueGetValue_p = sym<decltype(AXValueGetValue_p)>(lib_as, "AXValueGetValue");
		kAXTrustedCheckOptionPrompt = const_str(lib_as, "kAXTrustedCheckOptionPrompt");

		CGImageDestinationCreateWithData_p = sym<decltype(CGImageDestinationCreateWithData_p)>(lib_io, "CGImageDestinationCreateWithData");
		CGImageDestinationAddImage_p = sym<decltype(CGImageDestinationAddImage_p)>(lib_io, "CGImageDestinationAddImage");
		CGImageDestinationFinalize_p = sym<decltype(CGImageDestinationFinalize_p)>(lib_io, "CGImageDestinationFinalize");
		kCGImageDestinationLossyCompressionQuality = const_str(lib_io, "kCGImageDestinationLossyCompressionQuality");

		// HIToolbox TextInputSources for the char→keycode reverse map — optional;
		// absence just means every char takes the unicode-string fallback.
		lib_hitb = dlopen("/System/Library/Frameworks/Carbon.framework/Frameworks/HIToolbox.framework/HIToolbox", RTLD_LAZY | RTLD_GLOBAL);
		lib_ccore = dlopen("/System/Library/Frameworks/Carbon.framework/Frameworks/CarbonCore.framework/CarbonCore", RTLD_LAZY | RTLD_GLOBAL);
		TISCopyCurrentKeyboardLayoutInputSource_p = sym<decltype(TISCopyCurrentKeyboardLayoutInputSource_p)>(lib_hitb, "TISCopyCurrentKeyboardLayoutInputSource");
		TISGetInputSourceProperty_p = sym<decltype(TISGetInputSourceProperty_p)>(lib_hitb, "TISGetInputSourceProperty");
		UCKeyTranslate_p = sym<decltype(UCKeyTranslate_p)>(lib_hitb, "UCKeyTranslate");
		LMGetKbdType_p = sym<decltype(LMGetKbdType_p)>(lib_ccore, "LMGetKbdType");
		kTISPropertyUnicodeKeyLayoutData = const_str(lib_hitb, "kTISPropertyUnicodeKeyLayoutData");

		IOPMAssertionCreateWithName_p = sym<decltype(IOPMAssertionCreateWithName_p)>(lib_iokit, "IOPMAssertionCreateWithName");
		IOPMAssertionRelease_p = sym<decltype(IOPMAssertionRelease_p)>(lib_iokit, "IOPMAssertionRelease");
		kIOPMAssertionTypePreventUserIdleSystemSleep = const_str(lib_iokit, "kIOPMAssertionTypePreventUserIdleSystemSleep");
		// Recent macOS no longer exports the constant symbol; the assertion type
		// is a plain CFString name, so fall back to creating it.
		if (!kIOPMAssertionTypePreventUserIdleSystemSleep && CFStringCreateWithCString_p)
			kIOPMAssertionTypePreventUserIdleSystemSleep =
				CFStringCreateWithCString_p(nullptr, "PreventUserIdleSystemSleep", kCFStringEncodingUTF8);
		kIOPMAssertionTypePreventUserIdleDisplaySleep = const_str(lib_iokit, "kIOPMAssertionTypePreventUserIdleDisplaySleep");
		if (!kIOPMAssertionTypePreventUserIdleDisplaySleep && CFStringCreateWithCString_p)
			kIOPMAssertionTypePreventUserIdleDisplaySleep =
				CFStringCreateWithCString_p(nullptr, "PreventUserIdleDisplaySleep", kCFStringEncodingUTF8);

		// display-mode syms for HiDPI detection (points vs device pixels)
		CGDisplayCopyDisplayMode_p = sym<decltype(CGDisplayCopyDisplayMode_p)>(lib_cg, "CGDisplayCopyDisplayMode");
		CGDisplayModeGetWidth_p = sym<decltype(CGDisplayModeGetWidth_p)>(lib_cg, "CGDisplayModeGetWidth");
		CGDisplayModeGetPixelWidth_p = sym<decltype(CGDisplayModeGetPixelWidth_p)>(lib_cg, "CGDisplayModeGetPixelWidth");
		CGDisplayModeRelease_p = sym<decltype(CGDisplayModeRelease_p)>(lib_cg, "CGDisplayModeRelease");

		// libturbojpeg is optional: dlopen the first candidate that exists
		static const char* tj_paths[] = {
			"/opt/homebrew/lib/libturbojpeg.dylib",
			"/usr/local/lib/libturbojpeg.dylib",
			"libturbojpeg.dylib",
		};
		for (const char* p : tj_paths) {
			lib_tj = dlopen(p, RTLD_NOW);
			if (lib_tj) break;
		}
		if (lib_tj) {
			tjInitCompress_p = (decltype(tjInitCompress_p))dlsym(lib_tj, "tjInitCompress");
			tjCompress2_p = (decltype(tjCompress2_p))dlsym(lib_tj, "tjCompress2");
			tjFree_p = (decltype(tjFree_p))dlsym(lib_tj, "tjFree");
			tjDestroy_p = (decltype(tjDestroy_p))dlsym(lib_tj, "tjDestroy");
			if (!tjInitCompress_p || !tjCompress2_p || !tjFree_p || !tjDestroy_p)
				lib_tj = nullptr;
		}

		// libobjc + AppKit for NSRunningApplication-based window_activate
		lib_objc = dlopen("/usr/lib/libobjc.dylib", RTLD_LAZY);
		lib_appkit = dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", RTLD_LAZY);
		if (lib_objc) {
			objc_getClass_p = sym<decltype(objc_getClass_p)>(lib_objc, "objc_getClass");
			sel_registerName_p = sym<decltype(sel_registerName_p)>(lib_objc, "sel_registerName");
			objc_msgSend_p = sym<decltype(objc_msgSend_p)>(lib_objc, "objc_msgSend");
		}

		// libpng is optional: dlopen the first candidate that exists
		static const char* png_paths[] = {
			"/opt/homebrew/lib/libpng16.dylib",
			"/usr/local/lib/libpng16.dylib",
			"/usr/lib/libpng16.dylib",
			"libpng16.dylib",
		};
		for (const char* p : png_paths) {
			lib_png = dlopen(p, RTLD_NOW);
			if (lib_png) break;
		}
		if (lib_png) {
			#define SYM_PNG(name) name = (decltype(name))dlsym(lib_png, #name)
			SYM_PNG(png_access_version_number);
			SYM_PNG(png_create_write_struct); SYM_PNG(png_create_info_struct);
			SYM_PNG(png_destroy_write_struct); SYM_PNG(png_set_IHDR);
			SYM_PNG(png_set_compression_level); SYM_PNG(png_set_write_fn);
			SYM_PNG(png_set_bgr); SYM_PNG(png_write_info); SYM_PNG(png_write_row);
			SYM_PNG(png_write_end); SYM_PNG(png_get_io_ptr);
			#undef SYM_PNG
			if (!png_create_write_struct || !png_set_IHDR || !png_write_row ||
			    !png_get_io_ptr || !png_set_bgr) lib_png = nullptr;
		}

		ok = CFRelease_p && CFStringCreateWithCString_p && CFArrayGetCount_p && CFDictionaryGetValue_p &&
		     CGWindowListCreateImage_p && CGWindowListCopyWindowInfo_p && CGImageGetWidth_p &&
		     CGEventCreateMouseEvent_p && CGEventCreateKeyboardEvent_p && CGEventKeyboardSetUnicodeString_p &&
		     CGEventSourceCreate_p &&
		     CGEventPost_p && CGEventSetFlags_p && CGEventCreateScrollWheelEvent_p && CGEventCreate_p &&
		     CGImageDestinationCreateWithData_p && CGImageDestinationAddImage_p && CGImageDestinationFinalize_p &&
		     kCGWindowNumber && kCGWindowOwnerName && kCGWindowBounds;
		refresh_perms();
		// The first grab + encode pay framework/encoder setup once
		// (~50ms); warm them at init so the first real screenshot
		// request isn't the cold frame.
		if (ok && has_shm) {
			if (CGImageRef s = grab_screen(0, 0, 0, 0)) {
				std::vector<uint8_t> warm;
				encode_jpg_turbo(s, 60, 1.0, warm);
				CFRelease_p(s);
			}
		}
		return ok;
	}

	void refresh_perms() {
		has_xtest = AXIsProcessTrusted_p ? AXIsProcessTrusted_p() : false;
		has_shm = CGPreflightScreenCaptureAccess_p ? CGPreflightScreenCaptureAccess_p() : false;
		perms_checked_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::steady_clock::now().time_since_epoch()).count();
	}

	// TCC preflights are XPC calls (~0.7ms each) — hot capture paths reuse a
	// recent answer instead of paying them per frame. A stale `has_shm` can't
	// produce a wrong capture: a revoked grant makes CGWindowListCreateImage
	// itself fail, which surfaces as the usual error reply.
	void refresh_perms_if_stale() {
		int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::steady_clock::now().time_since_epoch()).count();
		if (now - perms_checked_ms > 1000) refresh_perms();
	}

	// Ask macOS to show the permission prompts; real grants happen in System Settings.
	bool request_perms() {
		if (!ok) return false;
		bool asked = false;
		if (CGRequestScreenCaptureAccess_p && !has_shm) {
			CGRequestScreenCaptureAccess_p();
			asked = true;
		}
		if (AXIsProcessTrustedWithOptions_p && kAXTrustedCheckOptionPrompt && !has_xtest && kCFBooleanTrue) {
			const void* keys[] = {kAXTrustedCheckOptionPrompt};
			const void* vals[] = {kCFBooleanTrue};
			CFDictionaryRef d = CFDictionaryCreate_p(nullptr, keys, vals, 1,
			                                       kCFTypeDictionaryKeyCallBacks,
			                                       kCFTypeDictionaryValueCallBacks);
			if (d) { AXIsProcessTrustedWithOptions_p(d); CFRelease_p(d); asked = true; }
		}
		refresh_perms();
		return asked;
	}

	// Capture space = the union of all ACTIVE DISPLAY bounds in global
	// Quartz coordinates. Deliberately NOT unioned with window rects:
	// windows move (off-screen rects change the union mid-sequence and
	// click coords computed against an older shot land wrong); displays
	// don't. Multi-monitor offsets still work — a display left of the
	// main one pushes the origin negative, matching CGEvent space.
	double cs_x = 0, cs_y = 0, cs_w = 0, cs_h = 0;
	std::atomic<int64_t> cs_ms{-1};
	bool capture_space(double& ux, double& uy, double& uw, double& uh) {
		int64_t t = std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::steady_clock::now().time_since_epoch()).count();
		if (cs_ms.load() >= 0 && t - cs_ms.load() < 300) {
			ux = cs_x; uy = cs_y; uw = cs_w; uh = cs_h;
			return true;
		}
		if (!ok || !CGGetActiveDisplayList_p || !CGDisplayBounds_p) return false;
		uint32_t ids[32] = {}, nd = 0;
		if (CGGetActiveDisplayList_p(32, ids, &nd) != 0 || nd == 0) return false;
		double x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
		for (uint32_t i = 0; i < nd; i++) {
			CGRect b = CGDisplayBounds_p(ids[i]);
			x0 = std::min(x0, b.origin.x); y0 = std::min(y0, b.origin.y);
			x1 = std::max(x1, b.origin.x + b.size.width);
			y1 = std::max(y1, b.origin.y + b.size.height);
		}
		if (x1 <= x0 || y1 <= y0) return false;
		cs_x = ux = x0; cs_y = uy = y0; cs_w = uw = x1 - x0; cs_h = uh = y1 - y0;
		cs_ms.store(t);
		return true;
	}

	bool display_size(int& w, int& h) {
		double ux = 0, uy = 0, uw = 0, uh = 0;
		if (capture_space(ux, uy, uw, uh)) {
			w = int(std::lround(uw));
			h = int(std::lround(uh));
			return true;
		}
		if (!ok || !CGMainDisplayID_p || !CGDisplayBounds_p) return false;
		CGRect b = CGDisplayBounds_p(CGMainDisplayID_p());
		w = int(b.size.width);
		h = int(b.size.height);
		return w > 0 && h > 0;
	}

	// disp-uniform overload so omprd can scale shot-space coords per backend
	bool display_size(const std::string& /*disp*/, int& w, int& h) { return display_size(w, h); }

	// Multi-monitor: the union's global-space origin is wherever the top-left
	// pixel of the captured image lives — negative when windows or displays
	// sit left/above the main display. CGEvent accepts those coords directly.
	bool display_origin(const std::string& /*disp*/, int& ox, int& oy) {
		double ux = 0, uy = 0, uw = 0, uh = 0;
		if (capture_space(ux, uy, uw, uh)) {
			ox = int(std::lround(ux));
			oy = int(std::lround(uy));
			return true;
		}
		if (!ok || !CGMainDisplayID_p || !CGDisplayBounds_p) { ox = oy = 0; return false; }
		CGRect b = CGDisplayBounds_p(CGMainDisplayID_p());
		ox = int(b.origin.x);
		oy = int(b.origin.y);
		return true;
	}

	// backingScaleFactor: CGDisplayBounds reports points; CGDisplayMode reports
	// both — but VM/scaled modes can produce captures at a different pixel size
	// than the mode claims. After the first full-frame grab, the measured
	// ratio (shot px / display points) is the truth; fall back to the mode.
	double scale_factor() {
		if (measured_scale > 0) return measured_scale;
		if (!ok || !CGMainDisplayID_p || !CGDisplayCopyDisplayMode_p ||
		    !CGDisplayModeGetWidth_p || !CGDisplayModeGetPixelWidth_p)
			return 1.0;
		CFTypeRef mode = CGDisplayCopyDisplayMode_p(CGMainDisplayID_p());
		if (!mode) return 1.0;
		size_t pw = CGDisplayModeGetWidth_p(mode);
		size_t px = CGDisplayModeGetPixelWidth_p(mode);
		if (CGDisplayModeRelease_p) CGDisplayModeRelease_p(mode);
		else CFRelease_p(mode);
		if (!pw || !px) return 1.0;
		return double(px) / double(pw);
	}

	// native pixel size (what screenshots actually contain)
	bool pixel_size(int& w, int& h) {
		if (measured_scale > 0 && meas_pw > 0) { w = meas_pw; h = meas_ph; return true; }
		int pw = 0, ph = 0;
		if (!display_size(pw, ph)) return false;
		double s = scale_factor();
		w = int(std::lround(pw * s));
		h = int(std::lround(ph * s));
		return true;
	}
	bool pixel_size(const std::string& /*disp*/, int& w, int& h) { return pixel_size(w, h); }

	// remember the true capture scale from a full-frame grab (caller holds m)
	void note_shot_scale(CGImageRef shot) {
		int dw = 0, dh = 0;
		if (measured_scale <= 0 && shot && display_size(dw, dh) && dw > 0 && dh > 0) {
			size_t sw = CGImageGetWidth_p(shot), sh = CGImageGetHeight_p(shot);
			if (sw && sh) {
				measured_scale = double(sw) / double(dw);
				meas_pw = int(sw);
				meas_ph = int(sh);
			}
		}
	}

	// --- encode: CGImage -> jpeg/png bytes via ImageIO -----------------------
	bool encode_image(CGImageRef img, const std::string& fmt, int quality,
	                  std::vector<uint8_t>& encoded) {
		CFMutableDataRef data = CFDataCreateMutable_p(nullptr, 0);
		if (!data) return false;
		CFStringRef type = CFStringCreateWithCString_p(nullptr, fmt == "jpg" ? "public.jpeg" : "public.png",
		                                             kCFStringEncodingUTF8);
		CGImageDestinationRef dest = CGImageDestinationCreateWithData_p(data, type, 1, nullptr);
		CFRelease_p(type);
		if (!dest) { CFRelease_p(data); return false; }
		CFDictionaryRef props = nullptr;
		if (fmt == "jpg" && kCGImageDestinationLossyCompressionQuality && CFNumberCreate_p) {
			double q = quality / 100.0;
			CFNumberRef qn = CFNumberCreate_p(nullptr, kCFNumberFloat64Type, &q);
			const void* keys[] = {kCGImageDestinationLossyCompressionQuality};
			const void* vals[] = {qn};
			props = CFDictionaryCreate_p(nullptr, keys, vals, 1,
			                           kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks);
			if (qn) CFRelease_p(qn);
		}
		CGImageDestinationAddImage_p(dest, img, props);
		bool ok = CGImageDestinationFinalize_p(dest);
		if (props) CFRelease_p(props);
		if (ok) {
			encoded.assign(CFDataGetBytePtr_p(data),
			               CFDataGetBytePtr_p(data) + CFDataGetLength_p(data));
		}
		CFRelease_p(dest);
		CFRelease_p(data);
		return ok;
	}

	// Box-average downscale of a 32-bit BGRA buffer. CPU-side, ~1-3ms at 1080p
	// — much cheaper than a CGBitmapContext draw for the observe/watch path.
	static bool box_downscale(const uint8_t* src, int sw, int sh, size_t sbpr,
	                          int dw, int dh, std::vector<uint8_t>& dst) {
		if (!src || sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return false;
		dst.assign(size_t(dw) * dh * 4, 0);
		double invx = double(sw) / dw, invy = double(sh) / dh;
		for (int dy = 0; dy < dh; dy++) {
			int y0 = int(dy * invy), y1 = std::min(sh, int(std::ceil((dy + 1) * invy)));
			if (y1 <= y0) y1 = y0 + 1;
			uint8_t* drow = dst.data() + size_t(dy) * dw * 4;
			for (int dx = 0; dx < dw; dx++) {
				int x0 = int(dx * invx), x1 = std::min(sw, int(std::ceil((dx + 1) * invx)));
				if (x1 <= x0) x1 = x0 + 1;
				uint32_t b = 0, g = 0, r = 0, a = 0;
				for (int y = y0; y < y1; y++) {
					const uint8_t* srow = src + size_t(y) * sbpr + size_t(x0) * 4;
					for (int x = x0; x < x1; x++) {
						b += srow[0]; g += srow[1]; r += srow[2]; a += srow[3];
						srow += 4;
					}
				}
				int n = (y1 - y0) * (x1 - x0);
				drow[dx * 4 + 0] = uint8_t(b / n); drow[dx * 4 + 1] = uint8_t(g / n);
				drow[dx * 4 + 2] = uint8_t(r / n); drow[dx * 4 + 3] = uint8_t(a / n);
			}
		}
		return true;
	}

	// Fast JPEG: libturbojpeg over the CGImage's backing store for 32-bit BGRA.
	// `scale` < 1 shrinks on the CPU before compress — the CGContext scaler
	// costs more than the pixels it saves. Anything else keeps ImageIO.
	bool encode_jpg_turbo(CGImageRef src, int quality, double scale,
	                      std::vector<uint8_t>& encoded) {
		if (!lib_tj || !CGImageGetDataProvider_p || !CGDataProviderCopyData_p ||
		    !CGImageGetBitmapInfo_p || !CGImageGetBytesPerRow_p || !CGImageGetBitsPerPixel_p)
			return false;
		constexpr uint32_t kAlphaInfoMask = 0x1F;
		constexpr uint32_t kByteOrderMask = 0x7000, kByteOrder32Little = 2 << 12;
		constexpr uint32_t kAlphaPremultFirst = 2, kAlphaFirst = 4, kAlphaNoneSkipFirst = 6;
		uint32_t bi = CGImageGetBitmapInfo_p(src);
		uint32_t ainfo = bi & kAlphaInfoMask;
		bool af = ainfo == kAlphaPremultFirst || ainfo == kAlphaFirst || ainfo == kAlphaNoneSkipFirst;
		if (CGImageGetBitsPerPixel_p(src) != 32 || (bi & kByteOrderMask) != kByteOrder32Little || !af)
			return false;
		CFTypeRef dp = CGImageGetDataProvider_p(src);
		CFTypeRef raw = dp ? CGDataProviderCopyData_p(dp) : nullptr;
		if (!raw) return false;
		size_t w = CGImageGetWidth_p(src), h = CGImageGetHeight_p(src);
		size_t bpr = CGImageGetBytesPerRow_p(src);
		const uint8_t* pix = CFDataGetBytePtr_p(raw);
		size_t len = size_t(CFDataGetLength_p(raw));
		bool good = pix && bpr >= w * 4 && len >= bpr * h;
		// JPEG drops alpha entirely — ImageIO does the same thing to
		// premultiplied input, so unlike the PNG path no opaque-scan is needed.
		if (good) {
			void* th = tjInitCompress_p();
			if (th) {
				std::vector<uint8_t> down;
				int cw = int(w), ch = int(h);
				size_t cpitch = bpr;
				const uint8_t* csrc = pix;
				if (scale < 0.999) {
					cw = std::max(1, int(std::lround(w * scale)));
					ch = std::max(1, int(std::lround(h * scale)));
					cpitch = size_t(cw) * 4;
					if (box_downscale(pix, int(w), int(h), bpr, cw, ch, down))
						csrc = down.data();
					else { cw = int(w); ch = int(h); cpitch = bpr; }
				}
				unsigned char* jbuf = nullptr;
				unsigned long jsize = 0;
				// TJPF_BGRA=3 (B,G,R,A memory order), TJSAMP_420=1
				int rc = tjCompress2_p(th, csrc, cw, int(cpitch), ch, 3 /*TJPF_BGRA*/,
				                       &jbuf, &jsize, 1 /*TJSAMP_420*/, quality,
				                       1 /*TJFLAG_FASTDCT*/);
				if (rc == 0 && jbuf && jsize)
					encoded.assign(jbuf, jbuf + jsize);
				if (jbuf) tjFree_p(jbuf);
				tjDestroy_p(th);
			}
		}
		CFRelease_p(raw);
		return good && !encoded.empty();
	}

	// Caller must hold m and have checked perms. Full-frame grabs bound to
	// the display union — CGRectNull would composite off-screen windows too
	// and produce an image whose pixel space drifts as windows move.
	// wid > 0 switches to kCGWindowListOptionIncludingWindow: that one
	// window even when occluded or on another Space — the honest per-session
	// scope (the agent's own windows), since Spaces themselves can't be
	// targeted by any public API.
	CGImageRef grab_screen(int rx, int ry, int rw, int rh, uint32_t wid = 0) {
		CGRect bounds{{INFINITY, INFINITY}, {0, 0}}; // CGRectNull = whole desktop
		if (wid)
			return CGWindowListCreateImage_p(
				bounds, kCGWindowListOptionIncludingWindow, wid, kCGWindowImageDefault);
		if (rw > 0 && rh > 0) {
			// region coords are capture-space-local; CG wants global — a
			// display left/above the main one makes the union origin negative
			double ux = 0, uy = 0, uw = 0, uh = 0;
			capture_space(ux, uy, uw, uh);
			bounds.origin.x = rx + ux;
			bounds.origin.y = ry + uy;
			bounds.size.width = rw;
			bounds.size.height = rh;
		} else {
			double ux = 0, uy = 0, uw = 0, uh = 0;
			if (capture_space(ux, uy, uw, uh))
				bounds = CGRect{{ux, uy}, {uw, uh}};
		}
		return CGWindowListCreateImage_p(
			bounds, kCGWindowListOptionOnScreenOnly, 0, kCGWindowImageDefault);
	}

	// Downscale via a bitmap context; returns a new CGImage (caller releases).
	CGImageRef scale_image(CGImageRef shot, double scale) {
		int sw = std::max(1, int(std::lround(CGImageGetWidth_p(shot) * scale)));
		int sh = std::max(1, int(std::lround(CGImageGetHeight_p(shot) * scale)));
		CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB_p();
		CGContextRef ctx = cs ? CGBitmapContextCreate_p(nullptr, size_t(sw), size_t(sh), 8,
		                                              size_t(sw) * 4, cs, kBitmapHostARGB)
		                      : nullptr;
		CGImageRef src = nullptr;
		if (ctx) {
			CGRect dst{{0, 0}, {double(sw), double(sh)}};
			CGContextDrawImage_p(ctx, dst, shot);
			src = CGBitmapContextCreateImage_p(ctx);
			CGContextRelease_p(ctx);
		}
		if (cs) CFRelease_p(cs);
		return src;
	}

	// Fast PNG: libpng-l1 over the CGImage's backing store when the pixels are
	// opaque 32-bit BGRA — ~3x faster than ImageIO. Anything else (translucent
	// window-region captures, other pixel formats) keeps the ImageIO path.
	bool encode_png_fast(CGImageRef src, std::vector<uint8_t>& encoded) {
		if (!lib_png || !CGImageGetDataProvider_p || !CGDataProviderCopyData_p ||
		    !CGImageGetBitmapInfo_p || !CGImageGetBytesPerRow_p || !CGImageGetBitsPerPixel_p)
			return false;
		constexpr uint32_t kAlphaInfoMask = 0x1F;
		constexpr uint32_t kByteOrderMask = 0x7000, kByteOrder32Little = 2 << 12;
		constexpr uint32_t kAlphaPremultFirst = 2, kAlphaFirst = 4, kAlphaNoneSkipFirst = 6;
		uint32_t bi = CGImageGetBitmapInfo_p(src);
		uint32_t ainfo = bi & kAlphaInfoMask;
		bool af = ainfo == kAlphaPremultFirst || ainfo == kAlphaFirst || ainfo == kAlphaNoneSkipFirst;
		if (CGImageGetBitsPerPixel_p(src) != 32 || (bi & kByteOrderMask) != kByteOrder32Little || !af)
			return false;
		CFTypeRef dp = CGImageGetDataProvider_p(src);
		CFTypeRef raw = dp ? CGDataProviderCopyData_p(dp) : nullptr;
		if (!raw) return false;
		size_t w = CGImageGetWidth_p(src), h = CGImageGetHeight_p(src);
		size_t bpr = CGImageGetBytesPerRow_p(src);
		const uint8_t* pix = CFDataGetBytePtr_p(raw);
		size_t len = size_t(CFDataGetLength_p(raw));
		bool good = pix && bpr >= w * 4 && len >= bpr * h;
		// opaque-only fast path: any non-0xFF alpha means premultiplied colors
		// would encode wrong — keep ImageIO for those
		for (size_t y = 0; good && y < h; y++) {
			const uint8_t* row = pix + y * bpr;
			for (size_t x = 0; x < w; x++)
				if (row[x * 4 + 3] != 0xFF) { good = false; break; }
		}
		if (good) {
			// libpng passes png_struct as arg1, NOT our io_ptr — fetch it
			auto sink = +[](void* wp, unsigned char* data, size_t size) {
				auto* vec = static_cast<std::vector<uint8_t>*>(png_get_io_ptr(wp));
				vec->insert(vec->end(), data, data + size);
			};
			char ver[16] = {};
			const char* verp = nullptr;
			if (png_access_version_number) {
				unsigned v = png_access_version_number();
				snprintf(ver, sizeof(ver), "%u.%u.%u", v / 10000, (v / 100) % 100, v % 100);
				verp = ver;
			}
			void* wp = png_create_write_struct(verp, nullptr, nullptr, nullptr);
			void* ip = wp ? png_create_info_struct(wp) : nullptr;
			if (ip) {
				encoded.reserve(w * h / 8 + 8192);
				png_set_write_fn(wp, &encoded, sink, nullptr);
				png_set_compression_level(wp, 1);
				png_set_bgr(wp); // BGRA -> RGBA
				png_set_IHDR(wp, ip, unsigned(w), unsigned(h), 8, 6 /*RGBA*/, 0, 0, 0);
				png_write_info(wp, ip);
				for (size_t y = 0; y < h; y++)
					png_write_row(wp, const_cast<uint8_t*>(pix + y * bpr));
				png_write_end(wp, nullptr);
			}
			if (wp) png_destroy_write_struct(&wp, ip ? &ip : nullptr);
		}
		CFRelease_p(raw);
		return good && !encoded.empty();
	}

	// Shared scale+encode tail for capture / capture_window — jpg rides
	// turbojpeg (scales in-place, so it never pays the CGContext scaler),
	// png prefers libpng-l1, ImageIO is the fallback for both.
	bool encode_shot(CGImageRef shot, const std::string& fmt, int quality, double scale,
	                 MemImage& img, std::vector<uint8_t>& encoded) {
		used_libpng = false;
		used_turbojpeg = false;
		bool ok2 = false;
		int enc_w = 0, enc_h = 0;
		if (fmt == "jpg") {
			ok2 = encode_jpg_turbo(shot, quality, scale, encoded);
			if (ok2) {
				used_turbojpeg = true;
				enc_w = int(CGImageGetWidth_p(shot));
				enc_h = int(CGImageGetHeight_p(shot));
				if (scale < 0.999) {
					enc_w = std::max(1, int(std::lround(enc_w * scale)));
					enc_h = std::max(1, int(std::lround(enc_h * scale)));
				}
			}
		}
		CGImageRef scaled = nullptr;
		if (!ok2) {
			CGImageRef src = shot;
			if (scale < 0.999) {
				scaled = scale_image(shot, scale);
				if (scaled) src = scaled;
			}
			if (fmt == "png") ok2 = encode_png_fast(src, encoded);
			if (ok2) used_libpng = true;
			else ok2 = src && encode_image(src, fmt, quality, encoded);
			if (ok2) {
				enc_w = int(CGImageGetWidth_p(src));
				enc_h = int(CGImageGetHeight_p(src));
			}
		}
		if (ok2) {
			img.width = enc_w;
			img.height = enc_h;
		}
		if (scaled) CFRelease_p(scaled);
		return ok2;
	}

	// img.rgb intentionally empty — encode goes CGImage->ImageIO/turbojpeg with
	// no CPU copy.
	bool capture(const std::string& /*disp*/, int rx, int ry, int rw, int rh, double scale,
	             const std::string& fmt, int quality, MemImage& img,
	             std::vector<uint8_t>& encoded, std::string& err) {
		if (!ok) { err = "coregraphics not loaded"; return false; }
		std::lock_guard<std::mutex> lock(m);
		refresh_perms_if_stale();
		if (!has_shm) {
			err = "screen recording permission not granted (System Settings > Privacy > Screen Recording)";
			return false;
		}
		auto t0 = std::chrono::steady_clock::now();
		CGImageRef shot = grab_screen(rx, ry, rw, rh);
		if (!shot) { err = "CGWindowListCreateImage failed"; return false; }
		if (rw <= 0 && rh <= 0) note_shot_scale(shot); // full-frame only
		auto t1 = std::chrono::steady_clock::now();
		bool ok = encode_shot(shot, fmt, quality, scale, img, encoded);
		if (!ok) err = "ImageIO encode failed";
		auto t2 = std::chrono::steady_clock::now();
		last_capture_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
		last_encode_ms = std::chrono::duration<double, std::milli>(t2 - t1).count();
		CFRelease_p(shot);
		return ok;
	}

	// One window instead of the whole display — the honest half of per-session
	// scoping on macOS (no public Spaces targeting): CGWindowListCreateImage
	// renders the window's own pixels even when occluded or on another Space,
	// so an agent only ever sees the windows it spawned.
	bool capture_window(const std::string& /*disp*/, uint32_t wid, double scale,
	                    const std::string& fmt, int quality, MemImage& img,
	                    std::vector<uint8_t>& encoded, std::string& err) {
		if (!ok) { err = "coregraphics not loaded"; return false; }
		std::lock_guard<std::mutex> lock(m);
		refresh_perms_if_stale();
		if (!has_shm) { err = "screen recording permission not granted"; return false; }
		auto t0 = std::chrono::steady_clock::now();
		CGImageRef shot = grab_screen(0, 0, -1, -1, wid);
		if (!shot) { err = "CGWindowListCreateImage failed"; return false; }
		auto t1 = std::chrono::steady_clock::now();
		bool ok2 = encode_shot(shot, fmt, quality, scale, img, encoded);
		if (!ok2) err = "ImageIO encode failed";
		auto t2 = std::chrono::steady_clock::now();
		last_capture_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
		last_encode_ms = std::chrono::duration<double, std::milli>(t2 - t1).count();
		CFRelease_p(shot);
		return ok2;
	}

	// Thumb a CGImage into tw×th RGB for the pixel differ (caller holds m).
	void thumb_of(CGImageRef shot, int tw, int th, std::vector<uint8_t>& thumb_rgb) {
		CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB_p();
		thumb_rgb.assign(size_t(tw) * th * 3, 0);
		std::vector<uint8_t> rgba(size_t(tw) * th * 4);
		CGContextRef tctx = cs ? CGBitmapContextCreate_p(rgba.data(), size_t(tw), size_t(th), 8,
		                                               size_t(tw) * 4, cs, kBitmapHostARGB)
		                       : nullptr;
		if (tctx) {
			CGRect dst{{0, 0}, {double(tw), double(th)}};
			CGContextDrawImage_p(tctx, dst, shot);
			CGContextRelease_p(tctx);
			for (size_t i = 0; i < size_t(tw) * th; i++)
				memcpy(thumb_rgb.data() + i * 3, rgba.data() + i * 4 + 1, 3); // skip alpha
		} else {
			thumb_rgb.clear();
		}
		if (cs) CFRelease_p(cs);
	}

	// Watch split (same contract as x11.hpp): probe grabs + thumbs the
	// (optionally regioned) frame and retains it in watch_shot; encode runs
	// only when the differ reports a change — idle ticks never pay encode.
	bool watch_probe(const std::string& /*disp*/, int rx, int ry, int rw, int rh,
	                 int tw, int th, std::vector<uint8_t>& thumb_rgb, std::string& err) {
		if (!ok) { err = "coregraphics not loaded"; return false; }
		std::lock_guard<std::mutex> lock(m);
		refresh_perms_if_stale();
		if (!has_shm) { err = "screen recording permission not granted"; return false; }
		auto t0 = std::chrono::steady_clock::now();
		CGImageRef shot = grab_screen(rx, ry, rw, rh);
		if (!shot) { err = "CGWindowListCreateImage failed"; return false; }
		if (rw <= 0 && rh <= 0) note_shot_scale(shot);
		last_capture_ms = std::chrono::duration<double, std::milli>(
			std::chrono::steady_clock::now() - t0).count();
		thumb_of(shot, tw, th, thumb_rgb);
		if (watch_shot) CFRelease_p(watch_shot);
		watch_shot = shot; // retained for watch_encode
		return true;
	}

	bool watch_encode(const std::string& /*disp*/, double scale, const std::string& fmt, int quality,
	                  MemImage& img, std::vector<uint8_t>& encoded, std::string& err) {
		std::lock_guard<std::mutex> lock(m);
		if (!watch_shot) { err = "no probed frame"; return false; }
		auto t0 = std::chrono::steady_clock::now();
		used_libpng = false;
		used_turbojpeg = false;
		bool ok = false;
		int enc_w = 0, enc_h = 0;
		if (fmt == "jpg") {
			ok = encode_jpg_turbo(watch_shot, quality, scale, encoded);
			if (ok) {
				used_turbojpeg = true;
				enc_w = int(CGImageGetWidth_p(watch_shot));
				enc_h = int(CGImageGetHeight_p(watch_shot));
				if (scale < 0.999) {
					enc_w = std::max(1, int(std::lround(enc_w * scale)));
					enc_h = std::max(1, int(std::lround(enc_h * scale)));
				}
			}
		}
		CGImageRef scaled = nullptr;
		if (!ok) {
			CGImageRef src = watch_shot;
			if (scale < 0.999) {
				scaled = scale_image(watch_shot, scale);
				if (scaled) src = scaled;
			}
			if (fmt == "png") ok = encode_png_fast(src, encoded);
			if (ok) used_libpng = true;
			else ok = encode_image(src, fmt, quality, encoded);
			if (ok) {
				enc_w = int(CGImageGetWidth_p(src));
				enc_h = int(CGImageGetHeight_p(src));
			}
		}
		if (ok) {
			img.width = enc_w;
			img.height = enc_h;
		} else {
			err = "encode failed";
		}
		last_encode_ms = std::chrono::duration<double, std::milli>(
			std::chrono::steady_clock::now() - t0).count();
		if (scaled) CFRelease_p(scaled);
		return ok;
	}

	void watch_release() {
		std::lock_guard<std::mutex> lock(m);
		if (watch_shot) { CFRelease_p(watch_shot); watch_shot = nullptr; }
	}

	// One screen grab feeding BOTH the watch differ's thumb and the encoded
	// frame — the old path grabbed the full screen twice per pushed frame.
	// Kept for interface parity; the probe/encode split is preferred.
	bool watch_frame(const std::string& disp, double scale, const std::string& fmt, int quality,
	                 int tw, int th, std::vector<uint8_t>& thumb_rgb, MemImage& img,
	                 std::vector<uint8_t>& encoded, std::string& err) {
		if (!watch_probe(disp, 0, 0, -1, -1, tw, th, thumb_rgb, err)) return false;
		return watch_encode(disp, scale, fmt, quality, img, encoded, err);
	}

	// Downscaled raw RGB thumb for the pixel-differ (watch frames)
	bool grab_thumb(const std::string& /*disp*/, int tw, int th, std::vector<uint8_t>& rgb) {
		if (!ok || !has_shm) return false;
		std::lock_guard<std::mutex> lock(m);
		CGRect bounds{{INFINITY, INFINITY}, {0, 0}};
		CGImageRef shot = CGWindowListCreateImage_p(
			bounds, kCGWindowListOptionOnScreenOnly, 0, kCGWindowImageDefault);
		if (!shot) return false;
		CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB_p();
		std::vector<uint8_t> rgba(size_t(tw) * th * 4);
		CGContextRef ctx = cs ? CGBitmapContextCreate_p(rgba.data(), size_t(tw), size_t(th), 8,
		                                              size_t(tw) * 4, cs, kBitmapHostARGB)
		                      : nullptr;
		if (ctx) {
			CGRect dst{{0, 0}, {double(tw), double(th)}};
			CGContextDrawImage_p(ctx, dst, shot);
			CGContextRelease_p(ctx);
			rgb.resize(size_t(tw) * th * 3);
			for (size_t i = 0; i < size_t(tw) * th; i++)
				memcpy(rgb.data() + i * 3, rgba.data() + i * 4 + 1, 3); // skip alpha
		}
		if (cs) CFRelease_p(cs);
		CFRelease_p(shot);
		return ctx != nullptr;
	}

	// --- injection ------------------------------------------------------------
	// CGEventPost at HID tap is already queued synchronously; the old 6ms
	// "settle" after every press was pure latency. Click path = motion+down+up
	// ≈ 1ms now. Unicode typing keeps its own small gap — see type_text.
	void post(CGEventRef ev, bool settle = false) {
		if (!ev) return;
		CGEventPost_p(kCGHIDEventTap, ev);
		CFRelease_p(ev);
		if (settle) std::this_thread::sleep_for(std::chrono::milliseconds(1));
	}

	bool motion(const std::string& /*disp*/, int x, int y) {
		if (!ok || !has_xtest) return false;
		int type = kCGEventMouseMoved;
		int btn = kCGMouseButtonLeft;
		if (held_buttons.count(1)) { type = kCGEventLeftMouseDragged; btn = kCGMouseButtonLeft; }
		else if (held_buttons.count(3)) { type = kCGEventRightMouseDragged; btn = kCGMouseButtonRight; }
		else if (held_buttons.count(2)) { type = kCGEventOtherMouseDragged; btn = kCGMouseButtonCenter; }
		last_pt = CGPoint{double(x), double(y)};
		// the button arg must match the held one — a right-drag posted as a
		// left-button event confuses apps that distinguish drag buttons
		CGEventRef ev = CGEventCreateMouseEvent_p(nullptr, type, last_pt, btn);
		post(ev);
		return ev != nullptr;
	}

	// One wheel event carries both axes — dx>0 scrolls right, dy>0 scrolls up.
	// The X11-style button-4/5 shim in button() stays for compat; omprd's
	// scroll action prefers this.
	bool scroll(const std::string& /*disp*/, int dx, int dy) {
		if (!ok || !has_xtest) return false;
		CGEventRef ev = CGEventCreateScrollWheelEvent_p(nullptr, kCGScrollEventUnitPixel, 2,
		                                              int32_t(dy * 24), int32_t(dx * 24));
		post(ev);
		return ev != nullptr;
	}

	bool button(const std::string& /*disp*/, int num, bool press) {
		if (!ok) return false;
		// X11 scroll buttons 4/5 map to a wheel event on macOS
		if (num == 4 || num == 5) {
			if (!press) return true;
			return scroll("", 0, num == 4 ? 1 : -1);
		}
		if (!has_xtest) return false;
		int cgbtn = kCGMouseButtonLeft;
		int down = kCGEventLeftMouseDown, up = kCGEventLeftMouseUp;
		if (num == 3) { cgbtn = kCGMouseButtonRight; down = kCGEventRightMouseDown; up = kCGEventRightMouseUp; }
		else if (num == 2) { cgbtn = kCGMouseButtonCenter; down = kCGEventOtherMouseDown; up = kCGEventOtherMouseUp; }
		// last_pt tracks motion(); without a preceding move, fall back to a
		// fresh position query once
		CGPoint pt = last_pt;
		if (pt.x == 0 && pt.y == 0) pt = pointer_pos();
		CGEventRef ev = CGEventCreateMouseEvent_p(nullptr, press ? down : up, pt, cgbtn);
		if (press) held_buttons.insert(num); else held_buttons.erase(num);
		post(ev);
		return ev != nullptr;
	}

	bool keycode_press(const std::string& /*disp*/, unsigned kc, bool press) {
		if (!ok || !has_xtest) return false;
		CGEventRef ev = CGEventCreateKeyboardEvent_p(kbd_source(), uint16_t(kc), press);
		post(ev);
		return ev != nullptr;
	}

	// Keyboard events created with a null event source are silently dropped
	// by modern macOS (verified on this build: type_text delivered through
	// kbd_source lands, keycode events with nullptr do not). One shared
	// HID-system-state source makes every keyboard payload deliver.
	void* kbd_source() {
		if (!kbd_src && CGEventSourceCreate_p)
			kbd_src = CGEventSourceCreate_p(1 /*kCGEventSourceStateHIDSystemState*/);
		return kbd_src;
	}

	// bytes arrive one at a time; assemble UTF-8 and type whole codepoints so
	// emoji/CJK work (X11 path is latin-1 only) — ASCII is byte-identical.
	bool type_char(const std::string& disp, unsigned char ch) {
		if (!ok || !has_xtest) return false;
		if (ch < 0x80) {
			utf8_pending = 0; utf8_need = 0;
			return type_cp(disp, ch);
		}
		if (utf8_need > 0) {
			utf8_pending = (utf8_pending << 6) | (ch & 0x3F);
			if (--utf8_need == 0) return type_cp(disp, utf8_pending);
			return true;
		}
		if ((ch & 0xE0) == 0xC0) { utf8_pending = ch & 0x1F; utf8_need = 1; return true; }
		if ((ch & 0xF0) == 0xE0) { utf8_pending = ch & 0x0F; utf8_need = 2; return true; }
		if ((ch & 0xF8) == 0xF0) { utf8_pending = ch & 0x07; utf8_need = 3; return true; }
		return true; // stray continuation byte — drop
	}

	// Typing posts REAL key events: a UCKeyTranslate reverse-map resolves each
	// codepoint to (keycode, CG flags) once, so apps that read hardware
	// keycodes (iOS Simulator, terminals, games) receive genuine keystrokes
	// and NSTextInput apps receive native characters. Codepoints the layout
	// cannot produce (emoji, CJK without a mapped key) fall back to a
	// CGEventKeyboardSetUnicodeString payload. That fallback must ride a
	// text-path keycode — JIS Eisu (102) — because events on printing
	// keycodes double-deliver (unicode text AND the raw letter: keycode 0
	// injected literal 'a's) while non-text keycodes (F13) never reach the
	// receiving app's input context at all.
	static constexpr uint16_t kUnicodeCarrierKey = 102; // kVK_JIS_Eisu

	void build_keymap() {
		if (keymap_built) return;
		keymap_built = true;
		if (!TISCopyCurrentKeyboardLayoutInputSource_p || !TISGetInputSourceProperty_p ||
		    !UCKeyTranslate_p || !kTISPropertyUnicodeKeyLayoutData) return;
		void* src = TISCopyCurrentKeyboardLayoutInputSource_p();
		if (!src) return;
		CFTypeRef uchr = static_cast<CFTypeRef>(
			TISGetInputSourceProperty_p(src, kTISPropertyUnicodeKeyLayoutData));
		const void* layout = (uchr && CFDataGetBytePtr_p) ? CFDataGetBytePtr_p(uchr) : nullptr;
		if (layout) {
			constexpr uint32_t kNoDead = 1u << 14; // kUCKeyTranslateNoDeadKeysBit
			uint32_t kbtype = LMGetKbdType_p ? LMGetKbdType_p() : 0;
			// UCKeyTranslate modifierKeyState = (carbon mods >> 8) & 0xFF →
			// shift=0x02, option=0x08. CG flags map 1:1 for those two.
			for (uint32_t ucmod : {0u, 2u, 8u, 10u}) {
				uint64_t cgflags = (ucmod & 2 ? kCGEventFlagMaskShift : 0) |
				                   (ucmod & 8 ? kCGEventFlagMaskAlternate : 0);
				for (uint16_t kc = 0; kc < 128; ++kc) {
					uint32_t dead = 0, have = 0;
					uint16_t buf[4];
					if (UCKeyTranslate_p(layout, kc, 0 /*kUCKeyActionDown*/, ucmod, kbtype,
					                     kNoDead, &dead, 4, &have, buf) != 0 || have == 0)
						continue;
					uint32_t cp;
					if (have == 1) cp = buf[0];
					else if (have == 2 && buf[0] >= 0xD800 && buf[0] <= 0xDBFF &&
					         buf[1] >= 0xDC00 && buf[1] <= 0xDFFF)
						cp = 0x10000 + ((buf[0] - 0xD800) << 10) + (buf[1] - 0xDC00);
					else continue; // multi-char dead sequences take the unicode path
					keymap.try_emplace(cp, kc, cgflags); // first hit = fewest mods
				}
			}
		}
		if (CFRelease_p) CFRelease_p(src);
	}

	// UTF-8 → codepoints, dropping stray continuation bytes.
	static std::vector<uint32_t> decode_cps(const std::string& text) {
		std::vector<uint32_t> cps;
		cps.reserve(text.size());
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
			} else { i += 1; continue; }
			cps.push_back(cp);
		}
		return cps;
	}

	// One real key event pair for a codepoint the layout maps; false → caller
	// uses the unicode fallback.
	bool type_cp_realkey(uint32_t cp) {
		auto it = keymap.find(cp);
		if (it == keymap.end() || !CGEventCreateKeyboardEvent_p) return false;
		CGEventRef dn = CGEventCreateKeyboardEvent_p(kbd_source(), it->second.first, true);
		CGEventRef up = CGEventCreateKeyboardEvent_p(kbd_source(), it->second.first, false);
		if (!dn || !up) { if (dn) CFRelease_p(dn); if (up) CFRelease_p(up); return false; }
		if (CGEventSetFlags_p) { CGEventSetFlags_p(dn, it->second.second); CGEventSetFlags_p(up, it->second.second); }
		post(dn);
		std::this_thread::sleep_for(std::chrono::milliseconds(1));
		post(up);
		return true;
	}

	// Unicode fallback for codepoints the layout can't produce: down/up pair
	// carrying UTF-16 units on a non-printing text-path keycode.
	bool type_cp_unicode(const uint16_t* units, size_t n) {
		if (!CGEventKeyboardSetUnicodeString_p) return false;
		CGEventRef dn = CGEventCreateKeyboardEvent_p(kbd_source(), kUnicodeCarrierKey, true);
		CGEventRef up = CGEventCreateKeyboardEvent_p(kbd_source(), kUnicodeCarrierKey, false);
		if (dn) CGEventKeyboardSetUnicodeString_p(dn, n, units);
		if (up) CGEventKeyboardSetUnicodeString_p(up, n, units);
		post(dn);
		std::this_thread::sleep_for(std::chrono::milliseconds(1));
		post(up);
		return dn != nullptr;
	}

	bool type_text(const std::string& /*disp*/, const std::string& text, int delay_ms) {
		if (!ok || !has_xtest) return false;
		build_keymap();
		std::vector<uint32_t> cps = decode_cps(text);
		// Runs of layout-unmapped codepoints batch into ≤24-unit unicode
		// payloads; mapped ones interleave as real key events.
		std::vector<uint16_t> pending;
		auto flush_unicode = [&]() {
			if (pending.empty()) return;
			type_cp_unicode(pending.data(), pending.size());
			pending.clear();
		};
		for (uint32_t cp : cps) {
			auto it = keymap.find(cp);
			if (it != keymap.end()) {
				flush_unicode();
				type_cp_realkey(cp);
				if (delay_ms) std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
				continue;
			}
			if (cp <= 0xFFFF) {
				pending.push_back(uint16_t(cp));
			} else {
				uint32_t v = cp - 0x10000;
				pending.push_back(uint16_t(0xD800 + (v >> 10)));
				pending.push_back(uint16_t(0xDC00 + (v & 0x3FF)));
			}
			if (pending.size() >= 24) flush_unicode();
		}
		flush_unicode();
		return true;
	}

	bool type_cp(const std::string& /*disp*/, uint32_t cp) {
		build_keymap();
		if (type_cp_realkey(cp)) return true;
		uint16_t u[2];
		size_t n;
		if (cp <= 0xFFFF) { u[0] = uint16_t(cp); n = 1; }
		else {
			cp -= 0x10000;
			u[0] = uint16_t(0xD800 + (cp >> 10));
			u[1] = uint16_t(0xDC00 + (cp & 0x3FF));
			n = 2;
		}
		return type_cp_unicode(u, n);
	}

	CGPoint pointer_pos() {
		CGPoint p{0, 0};
		CGEventRef ev = CGEventCreate_p(nullptr);
		if (ev) { p = CGEventGetLocation_p(ev); CFRelease_p(ev); }
		return p;
	}

	bool query_pointer(const std::string& /*disp*/, int& x, int& y, unsigned long& child) {
		if (!ok || !CGEventCreate_p || !CGEventGetLocation_p) return false;
		CGPoint p = pointer_pos();
		x = int(p.x);
		y = int(p.y);
		child = 0;
		return true;
	}

	// --- windows --------------------------------------------------------------
	std::string cf_to_std(CFTypeRef s) {
		if (!s || !CFStringGetCString_p) return {};
		char buf[1024];
		if (CFStringGetCString_p((CFStringRef)s, buf, sizeof(buf), kCFStringEncodingUTF8)) return buf;
		return {};
	}

	double cf_num(CFTypeRef n) {
		double v = 0;
		if (n && CFNumberGetValue_p) CFNumberGetValue_p((CFNumberRef)n, kCFNumberCGFloatType, &v);
		return v;
	}

	// Is `wid` a real window anywhere (any Space, occluded included)?
	// windows() is OnScreenOnly — for the workspace contract the check has
	// to look at every window the system knows: option 0 = all.
	bool window_exists(uint32_t wid) {
		if (!ok || !wid) return false;
		CFArrayRef list = CGWindowListCopyWindowInfo_p(0, 0);
		if (!list) return false;
		long n = CFArrayGetCount_p(list);
		bool found = false;
		for (long i = 0; i < n; i++) {
			CFDictionaryRef w = (CFDictionaryRef)CFArrayGetValueAtIndex_p(list, i);
			if (w && kCGWindowNumber &&
			    (unsigned long)cf_num(CFDictionaryGetValue_p(w, kCGWindowNumber)) == wid) { found = true; break; }
		}
		CFRelease_p(list);
		return found;
	}

	// WinInfo lives inside X11Backend — the shared window shape
	std::vector<X11Backend::WinInfo> windows(const std::string& /*disp*/) {
		std::vector<X11Backend::WinInfo> out;
		if (!ok) return out;
		uint32_t opts = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
		CFArrayRef list = CGWindowListCopyWindowInfo_p(opts, 0);
		if (!list) return out;
		CFStringRef kX = CFStringCreateWithCString_p(nullptr, "X", kCFStringEncodingUTF8);
		CFStringRef kY = CFStringCreateWithCString_p(nullptr, "Y", kCFStringEncodingUTF8);
		CFStringRef kW = CFStringCreateWithCString_p(nullptr, "Width", kCFStringEncodingUTF8);
		CFStringRef kH = CFStringCreateWithCString_p(nullptr, "Height", kCFStringEncodingUTF8);
		long n = CFArrayGetCount_p(list);
		for (long i = 0; i < n; i++) {
			CFDictionaryRef w = (CFDictionaryRef)CFArrayGetValueAtIndex_p(list, i);
			if (!w) continue;
			if (kCGWindowLayer && int(cf_num(CFDictionaryGetValue_p(w, kCGWindowLayer))) != 0) continue;
			X11Backend::WinInfo wi;
			if (kCGWindowNumber) wi.id = (unsigned long)cf_num(CFDictionaryGetValue_p(w, kCGWindowNumber));
			if (kCGWindowOwnerPID) wi.pid = (unsigned long)cf_num(CFDictionaryGetValue_p(w, kCGWindowOwnerPID));
			std::string owner = cf_to_std(CFDictionaryGetValue_p(w, kCGWindowOwnerName));
			std::string name = cf_to_std(CFDictionaryGetValue_p(w, kCGWindowName));
			wi.app = owner;
			wi.title = name.empty() ? owner : owner + " — " + name;
			if (kCGWindowBounds) {
				CFDictionaryRef b = (CFDictionaryRef)CFDictionaryGetValue_p(w, kCGWindowBounds);
				if (b) {
					wi.x = int(cf_num(CFDictionaryGetValue_p(b, kX)));
					wi.y = int(cf_num(CFDictionaryGetValue_p(b, kY)));
					wi.w = int(cf_num(CFDictionaryGetValue_p(b, kW)));
					wi.h = int(cf_num(CFDictionaryGetValue_p(b, kH)));
				}
			}
			// first kept layer-0 entry is the frontmost app's window —
			// i==0 can be a skipped menubar/layer window, leaving no active
			wi.active = out.empty();
			out.push_back(wi);
		}
		for (CFStringRef k : {kX, kY, kW, kH}) if (k) CFRelease_p(k);
		CFRelease_p(list);
		return out;
	}

	// Frontmost the owning app via NSRunningApplication (objc runtime, no
	// compile-time ObjC). activateWithOptions: NSApplicationActivateAllWindows
	// (1) | NSApplicationActivateIgnoringOtherApps (2) — takes ~5ms vs ~150ms
	// for the osascript fork, and doesn't need Automation TCC.
	bool app_activate_pid(long pid) {
		if (!objc_getClass_p || !sel_registerName_p || !objc_msgSend_p || !lib_appkit)
			return false;
		void* cls = objc_getClass_p("NSRunningApplication");
		if (!cls) return false;
		// objc_msgSend must be cast to each call site's signature — the
		// documented idiom; suppress the (expected) type-mismatch warning
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wcast-function-type-mismatch"
		using Send1 = void* (*)(void*, void*, ...);
		void* app = reinterpret_cast<Send1>(objc_msgSend_p)(
			cls, sel_registerName_p("runningApplicationWithProcessIdentifier:"), int(pid));
		if (!app) { return false; }
		// BOOL return — a bool-typed fn ptr so garbage upper bits can't read true.
		// options: NSApplicationActivateAllWindows(1) | ...IgnoringOtherApps(2)
		using SendB = bool (*)(void*, void*, ...);
		bool ok = reinterpret_cast<SendB>(objc_msgSend_p)(app, sel_registerName_p("activateWithOptions:"), 3UL);
#pragma clang diagnostic pop
		return ok;
	}

	// Raise one specific window of an app via AX and make it main. App-level
	// activate alone leaves key-window status to whichever window is topmost;
	// an app that was opened in the background (open -a) can have NO key
	// window at all — keystrokes then get discarded even though the app is
	// focused. AXRaise + AXMain pin THIS window as the key target. Must be
	// called AFTER the app is activated (raise can't key a background app).
	bool ax_raise(int pid, const std::string& name) {
		if (!AXUIElementCreateApplication_p || !AXUIElementCopyAttributeValue_p || !AXUIElementPerformAction_p)
			return false;
		void* app = AXUIElementCreateApplication_p(pid);
		if (!app) return false;
		void* ws = nullptr;
		CFStringRef wk = CFStringCreateWithCString_p(nullptr, "AXWindows", kCFStringEncodingUTF8);
		bool done = false;
		if (wk && AXUIElementCopyAttributeValue_p(app, wk, &ws) == 0 && ws) {
			long n = CFArrayGetCount_p ? CFArrayGetCount_p((CFArrayRef)ws) : 0;
			for (long i = 0; i < n; i++) {
				void* w = (void*)CFArrayGetValueAtIndex_p((CFArrayRef)ws, i);
				void* t = nullptr;
				CFStringRef tk = CFStringCreateWithCString_p(nullptr, "AXTitle", kCFStringEncodingUTF8);
				std::string wt;
				if (tk && AXUIElementCopyAttributeValue_p(w, tk, &t) == 0 && t) wt = cf_to_std((CFTypeRef)t);
				if (tk) CFRelease_p(tk);
				if (wt != name && (name.empty() || wt.find(name) == std::string::npos)) continue;
				CFStringRef ak = CFStringCreateWithCString_p(nullptr, "AXRaise", kCFStringEncodingUTF8);
				if (ak) done = AXUIElementPerformAction_p(w, ak) == 0;
				if (ak) CFRelease_p(ak);
				// AXMain explicitly keys it — AXRaise alone only reorders z
				CFStringRef mk = CFStringCreateWithCString_p(nullptr, "AXMain", kCFStringEncodingUTF8);
				if (mk && AXUIElementSetAttributeValue_p)
					AXUIElementSetAttributeValue_p(w, mk, kCFBooleanTrue);
				if (mk) CFRelease_p(mk);
				break;
			}
		}
		if (ws) CFRelease_p(ws);
		if (wk) CFRelease_p(wk);
		CFRelease_p(app);
		return done;
	}

	// --- accessibility intelligence ----------------------------------------
	// Agents click blind coordinates today; the AX tree gives them named
	// targets ("press the 'Allow' button", "the field labelled API key").
	// Depth + node caps keep a pathological DOM from stalling the daemon.

	struct UiNode {
		std::string role, title, value;
		double x = 0, y = 0, w = 0, h = 0;
		int depth = 0;
	};

	// One element's inspectable strings + rect. Attr keys are alloc'd per
	// read — the AX API takes CFStrings and we can't cache cross-call.
	// lean=true reads only identity attrs (role/title/desc) — press/set
	// walks don't need rects or values and each AX round-trip costs ms.
	void ui_read(void* el, UiNode& n, bool lean) {
		auto attr = [&](const char* key, CFTypeRef* out) -> bool {
			CFStringRef k = CFStringCreateWithCString_p(nullptr, key, kCFStringEncodingUTF8);
			bool okk = k && AXUIElementCopyAttributeValue_p(el, k, (void**)out) == 0 && *out;
			if (k) CFRelease_p(k);
			return okk;
		};
		CFTypeRef v = nullptr;
		if (attr("AXRole", &v)) { n.role = cf_to_std(v); CFRelease_p(v); v = nullptr; }
		if (attr("AXTitle", &v)) { n.title = cf_to_std(v); CFRelease_p(v); v = nullptr; }
		if (n.title.empty() && attr("AXDescription", &v)) { n.title = cf_to_std(v); CFRelease_p(v); v = nullptr; }
		if (lean) return;
		if (attr("AXValue", &v)) {
			// AXValue may be a string, number, or a wrapped struct — take the
			// string only; numbers land in the node's value via cf_to_std too.
			n.value = cf_to_std(v);
			CFRelease_p(v); v = nullptr;
		}
		if (AXValueGetValue_p) {
			if (attr("AXPosition", &v)) {
				CGPoint p{};
				if (AXValueGetValue_p((void*)v, 1 /* kAXValueCGPointType */, &p)) {
					n.x = p.x; n.y = p.y;
				}
				CFRelease_p(v); v = nullptr;
			}
			if (attr("AXSize", &v)) {
				CGSize s{};
				if (AXValueGetValue_p((void*)v, 2 /* kAXValueCGSizeType */, &s)) {
					n.w = s.width; n.h = s.height;
				}
				CFRelease_p(v); v = nullptr;
			}
		}
	}

	void ui_walk(void* el, int depth, int max_depth, std::vector<UiNode>& out, int cap,
	             bool (*match)(const UiNode&, const std::string&, const std::string&),
	             const std::string& want_role, const std::string& want_text, void** hit,
	             const std::string& set_value, bool lean) {
		// copy the node out BEFORE recursing so callers keep data after the
		// children array releases the element
		UiNode n;
		n.depth = depth;
		ui_read(el, n, lean);
		bool matched = match && match(n, want_role, want_text);
		if (matched && !*hit) {
			if (!set_value.empty()) {
				// fill the field: focus first so IME-less apps see the caret,
				// then write AXValue — the string attribute accepts CFString.
				CFStringRef fk = CFStringCreateWithCString_p(nullptr, "AXFocused", kCFStringEncodingUTF8);
				if (fk && AXUIElementSetAttributeValue_p) AXUIElementSetAttributeValue_p(el, fk, kCFBooleanTrue);
				if (fk) CFRelease_p(fk);
				CFStringRef vk = CFStringCreateWithCString_p(nullptr, "AXValue", kCFStringEncodingUTF8);
				CFStringRef vs = CFStringCreateWithCString_p(nullptr, set_value.c_str(), kCFStringEncodingUTF8);
				if (vk && vs && AXUIElementSetAttributeValue_p &&
				    AXUIElementSetAttributeValue_p(el, vk, (CFTypeRef)vs) == 0)
					*hit = el;
				if (vk) CFRelease_p(vk);
				if (vs) CFRelease_p(vs);
				// AXValue refuses on some controls — AXPress of a search field's
				// text area etc.; fall through to press when set failed and the
				// caller asked for both by leaving hit null only if no press.
				if (!*hit) {
					CFStringRef pk = CFStringCreateWithCString_p(nullptr, "AXPress", kCFStringEncodingUTF8);
					if (pk && AXUIElementPerformAction_p(el, pk) == 0) *hit = el;
					if (pk) CFRelease_p(pk);
				}
			} else {
				CFStringRef pk = CFStringCreateWithCString_p(nullptr, "AXPress", kCFStringEncodingUTF8);
				if (pk && AXUIElementPerformAction_p(el, pk) == 0) *hit = el;
				if (pk) CFRelease_p(pk);
			}
		}
		if ((int)out.size() < cap && !n.role.empty() && !lean) out.push_back(std::move(n));
		if (depth >= max_depth || (int)out.size() >= cap) return;
		CFTypeRef kids = nullptr;
		CFStringRef ck = CFStringCreateWithCString_p(nullptr, "AXChildren", kCFStringEncodingUTF8);
		if (!ck || AXUIElementCopyAttributeValue_p(el, ck, (void**)&kids) != 0 || !kids) {
			if (ck) CFRelease_p(ck);
			return;
		}
		CFRelease_p(ck);
		long cnt = CFArrayGetCount_p ? CFArrayGetCount_p((CFArrayRef)kids) : 0;
		// lean walks don't fill `out` — stop on the hit, not the cap
		for (long i = 0; i < cnt && !(*hit && match); i++) {
			if (!lean && (int)out.size() >= cap) break;
			void* kid = (void*)CFArrayGetValueAtIndex_p((CFArrayRef)kids, i);
			ui_walk(kid, depth + 1, max_depth, out, cap, match, want_role, want_text, hit, set_value, lean);
		}
		CFRelease_p(kids);
	}

	// pid<=0 resolves the focused app's pid through AXFocusedApplication.
	int ui_resolve_pid(int pid) {
		if (pid > 0) return pid;
		if (!AXUIElementCreateSystemWide_p || !AXUIElementGetPid_p) return 0;
		void* sys = AXUIElementCreateSystemWide_p();
		if (!sys) return 0;
		void* app = nullptr;
		CFStringRef key = CFStringCreateWithCString_p(nullptr, "AXFocusedApplication", kCFStringEncodingUTF8);
		int rc = key ? AXUIElementCopyAttributeValue_p(sys, key, &app) : -1;
		if (key) CFRelease_p(key);
		CFRelease_p(sys);
		if (rc != 0 || !app) return 0;
		int fpid = 0;
		AXUIElementGetPid_p(app, &fpid);
		CFRelease_p(app);
		return fpid;
	}

	// Every AX call can block on the target's run loop — cap the per-element
	// wait so an unresponsive app degrades to skipped nodes, not a hung rpc.
	void ui_throttle(void* app) {
		if (AXUIElementSetMessagingTimeout_p)
			AXUIElementSetMessagingTimeout_p(app, 0.25f);
	}

	std::vector<UiNode> ui_tree(int pid, int max_depth, int cap) {
		std::vector<UiNode> out;
		if (!AXUIElementCreateApplication_p || !AXUIElementCopyAttributeValue_p) return out;
		pid = ui_resolve_pid(pid);
		if (!pid) return out;
		void* app = AXUIElementCreateApplication_p(pid);
		if (!app) return out;
		ui_throttle(app);
		void* hit = nullptr;
		ui_walk(app, 0, std::clamp(max_depth, 1, 12), out, std::clamp(cap, 1, 2000),
		        nullptr, "", "", &hit, "", false);
		CFRelease_p(app);
		return out;
	}

	static bool ui_match(const UiNode& n, const std::string& want_role,
	                     const std::string& want_text) {
		std::string role = n.role, hay = n.title + "\n" + n.value,
		            r = want_role, t = want_text;
		for (char& c : role) c = char(std::tolower((unsigned char)c));
		for (char& c : hay) c = char(std::tolower((unsigned char)c));
		for (char& c : r) c = char(std::tolower((unsigned char)c));
		for (char& c : t) c = char(std::tolower((unsigned char)c));
		if (!r.empty() && role.find(r) == std::string::npos) return false;
		return t.empty() || hay.find(t) != std::string::npos;
	}

	// Press the first node whose title/value contains `title` (and whose role
	// contains `role`, if given). Element refs die with the parent array, so
	// the action happens inside the walk while the element is still alive.
	bool ui_press(int pid, const std::string& title, const std::string& role) {
		if (!AXUIElementCreateApplication_p || !AXUIElementPerformAction_p) return false;
		pid = ui_resolve_pid(pid);
		if (!pid) return false;
		void* app = AXUIElementCreateApplication_p(pid);
		if (!app) return false;
		ui_throttle(app);
		std::vector<UiNode> scratch;
		void* hit = nullptr;
		ui_walk(app, 0, 12, scratch, 2000, ui_match, role, title, &hit, "", true);
		CFRelease_p(app);
		return hit != nullptr;
	}

	// Fill a text field: focus + AXValue write on the first matching node.
	bool ui_set_value(int pid, const std::string& title, const std::string& value) {
		if (!AXUIElementCreateApplication_p || !AXUIElementSetAttributeValue_p) return false;
		pid = ui_resolve_pid(pid);
		if (!pid) return false;
		void* app = AXUIElementCreateApplication_p(pid);
		if (!app) return false;
		ui_throttle(app);
		std::vector<UiNode> scratch;
		void* hit = nullptr;
		ui_walk(app, 0, 12, scratch, 2000, ui_match, "", title, &hit, value, true);
		CFRelease_p(app);
		return hit != nullptr;
	}

	bool window_activate(const std::string& /*disp*/, unsigned long id) {
		std::string owner, name;
		long pid = 0;
		for (auto& w : windows("")) {
			if (w.id == id) {
				pid = long(w.pid);
				size_t dash = w.title.find(" — ");
				owner = dash == std::string::npos ? w.title : w.title.substr(0, dash);
				name = dash == std::string::npos ? "" : w.title.substr(dash + 5); // " — " is 5 bytes (em dash)
				break;
			}
		}
		if (pid) {
			if (!app_activate_pid(pid)) {
				if (owner.empty()) return false;
				// `open -a` activates via LaunchServices — no Automation TCC
				// consent the way `tell application … to activate` needs.
				if (!app_activate(owner) &&
				    !osascript("tell application \"" + osa_escape(owner) + "\" to activate")) return false;
			}
			// app is (becoming) active — now key the exact window; retry a few
			// times: AXWindows isn't populated until the app's run loop spins
			for (int i = 0; !name.empty() && i < 5; i++) {
				if (ax_raise(int(pid), name)) return true;
				std::this_thread::sleep_for(std::chrono::milliseconds(60));
			}
			return true; // app activated even if the window key didn't stick
		}
		if (owner.empty()) return false;
		return app_activate(owner) ||
		       osascript("tell application \"" + osa_escape(owner) + "\" to activate");
	}

	// --- virtual desktops -------------------------------------------------
	// Public APIs can't create or enumerate real Spaces — but a fullscreened
	// window IS a Space, and activating an app auto-switches to its space.
	// space_new() therefore = fullscreen the frontmost window; space_enter()
	// = activate the owning app; space_leave() = activate the previous app.
	// Ground truth for which app holds keyboard focus: AXFocusedApplication
	// on the system-wide element (title or pid → app name). NSWorkspace.
	// frontmostApplication goes stale in a daemon with no NSApplication
	// connection (observed: it kept reporting Simulator while System Events
	// saw Chrome), and CGWindowList z-order is only stacking — a topmost
	// window is not necessarily the focused one.
	std::string focused_app() {
		if (!AXUIElementCreateSystemWide_p || !AXUIElementCopyAttributeValue_p)
			return "";
		void* sys = AXUIElementCreateSystemWide_p();
		if (!sys) return "";
		void* app = nullptr;
		CFStringRef key = CFStringCreateWithCString_p(nullptr, "AXFocusedApplication", kCFStringEncodingUTF8);
		int rc = key ? AXUIElementCopyAttributeValue_p(sys, key, &app) : -1;
		if (key) CFRelease_p(key);
		CFRelease_p(sys);
		if (rc != 0 || !app) return "";
		std::string name;
		void* t = nullptr;
		CFStringRef tk = CFStringCreateWithCString_p(nullptr, "AXTitle", kCFStringEncodingUTF8);
		if (tk && AXUIElementCopyAttributeValue_p(app, tk, &t) == 0 && t)
			name = cf_to_std((CFTypeRef)t);
		if (tk) CFRelease_p(tk);
		CFRelease_p(app);
		return name;
	}

	std::string frontmost_app() {
		if (std::string f = focused_app(); !f.empty()) return f;
		// fallback: first layer-0 window's owner (z-order front)
		for (auto& w : windows("")) {
			std::string own = w.app.empty() ? w.title : w.app;
			size_t dash = own.find(" — ");
			if (dash != std::string::npos) own = own.substr(0, dash);
			if (!own.empty()) return own;
		}
		return "";
	}

	// `open -a` without a shell: window-owner names come from arbitrary apps
	// — a crafted name with quotes or $(…) must not reach /bin/sh.
	bool app_activate(const std::string& name) {
		if (name.empty()) return false;
		pid_t pid = fork();
		if (pid == 0) {
			int devnull = open("/dev/null", O_WRONLY);
			if (devnull >= 0) { dup2(devnull, STDERR_FILENO); dup2(devnull, STDOUT_FILENO); }
			execl("/usr/bin/open", "open", "-a", name.c_str(), nullptr);
			_exit(127);
		}
		if (pid < 0) return false;
		return wait_kid(pid, 4000);
	}

	bool space_new(const std::string& disp) {
		// ⌃⌘F — fullscreen the front window: it becomes its own Space.
		return key_combo(disp, "cmd+ctrl+f");
	}
	bool space_enter(const std::string& /*disp*/, int /*idx*/) {
		return false; // macOS spaces aren't indexed — enter by app instead
	}

	bool window_close(const std::string& /*disp*/, unsigned long id) {
		std::string owner, name;
		for (auto& w : windows("")) {
			if (w.id == id) {
				size_t dash = w.title.find(" — ");
				owner = dash == std::string::npos ? w.title : w.title.substr(0, dash);
				name = dash == std::string::npos ? "" : w.title.substr(dash + 3);
				break;
			}
		}
		if (owner.empty()) return false;
		if (name.empty())
			return osascript("tell application \"" + osa_escape(owner) + "\" to close window 1");
		return osascript("tell application \"" + osa_escape(owner) + "\" to close (first window whose name contains \"" +
		                 osa_escape(name) + "\")");
	}

	static std::string osa_escape(const std::string& s) {
		std::string e;
		for (char ch : s) { if (ch == '"' || ch == '\\') e += '\\'; e += ch; }
		return e;
	}

	// A blocked Apple Event (TCC automation consent a daemon can't display)
	// stalls the child forever — a bare waitpid would hang the calling tool
	// permanently. Give every osascript 4s, then kill+reap and fail honestly.
	static bool wait_kid(pid_t pid, int timeout_ms) {
		int status = 0;
		for (int waited = 0; waited < timeout_ms; waited += 50) {
			if (waitpid(pid, &status, WNOHANG) == pid)
				return WIFEXITED(status) && WEXITSTATUS(status) == 0;
			std::this_thread::sleep_for(std::chrono::milliseconds(50));
		}
		kill(pid, SIGKILL);
		waitpid(pid, &status, 0);
		return false;
	}

	static bool osascript(const std::string& line) {
		pid_t pid = fork();
		if (pid == 0) {
			int devnull = open("/dev/null", O_WRONLY);
			if (devnull >= 0) { dup2(devnull, STDERR_FILENO); dup2(devnull, STDOUT_FILENO); }
			execl("/usr/bin/osascript", "osascript", "-e", line.c_str(), nullptr);
			_exit(127);
		}
		if (pid < 0) return false;
		return wait_kid(pid, 4000);
	}

	// --- key combos (same vocabulary as x11.hpp) -------------------------------
	bool key_combo(const std::string& /*disp*/, const std::string& combo) {
		if (!ok || !has_xtest) return false;
		uint64_t flags = 0;
		int main_kc = -1;
		bool force_shift = false;
		std::istringstream iss(combo);
		std::string tok;
		while (std::getline(iss, tok, '+')) {
			std::string low = tok;
			for (char& ch : low) ch = char(std::tolower(unsigned(ch)));
			if (low == "ctrl" || low == "control") { flags |= kCGEventFlagMaskControl; continue; }
			if (low == "shift") { flags |= kCGEventFlagMaskShift; continue; }
			if (low == "alt" || low == "option") { flags |= kCGEventFlagMaskAlternate; continue; }
			if (low == "meta" || low == "cmd" || low == "command" || low == "super" || low == "win") {
				flags |= kCGEventFlagMaskCommand; continue;
			}
			if (main_kc >= 0) return false; // exactly one non-modifier
			if (tok.size() == 1) {
				unsigned char ch = static_cast<unsigned char>(tok[0]);
				if (ch >= 'A' && ch <= 'Z') { force_shift = true; ch = char(ch + 32); }
				main_kc = char_keycode(ch);
				if (main_kc < 0 && ch >= 'a' && ch <= 'z') return false;
			} else {
				main_kc = named_keycode(low);
				if (main_kc < 0 && low[0] == 'f' && low.size() <= 3) {
					int fn = std::atoi(low.c_str() + 1);
					if (fn >= 1 && fn <= 12) {
						static const int fkeys[] = {122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111};
						main_kc = fkeys[fn - 1];
					}
				}
			}
			if (main_kc < 0) return false;
		}
		if (main_kc < 0) return false;
		if (force_shift) flags |= kCGEventFlagMaskShift;

		// Post real modifier key events around the main key, like hardware.
		// Setting the flag only on the event is NOT enough: the shared
		// kCGEventSourceStateHIDSystemState merges posted flags cumulatively,
		// so flags set without a matching modifier key-up stay stuck GLOBALLY
		// — every later keyboard event system-wide inherits them (verified:
		// after a "cmd+s" all chars typed arrived as ⌘-chords and vanished).
		struct ModKey { uint64_t flag; int kc; };
		static const ModKey mods[] = {
			{kCGEventFlagMaskCommand, 55},   // cmd-L (54 = R, either works)
			{kCGEventFlagMaskShift, 56},     // shift-L
			{kCGEventFlagMaskAlternate, 58}, // option-L
			{kCGEventFlagMaskControl, 59},   // ctrl-L
		};
		uint64_t acc = 0;
		for (auto& mk : mods) {
			if (!(flags & mk.flag)) continue;
			acc |= mk.flag;
			CGEventRef md = CGEventCreateKeyboardEvent_p(kbd_source(), uint16_t(mk.kc), true);
			if (md) CGEventSetFlags_p(md, acc);
			post(md);
		}
		CGEventRef dn = CGEventCreateKeyboardEvent_p(kbd_source(), uint16_t(main_kc), true);
		CGEventRef up = CGEventCreateKeyboardEvent_p(kbd_source(), uint16_t(main_kc), false);
		if (dn) CGEventSetFlags_p(dn, flags);
		if (up) CGEventSetFlags_p(up, flags); // key released while mods held
		post(dn);
		post(up);
		for (int i = int(sizeof(mods) / sizeof(mods[0])) - 1; i >= 0; i--) {
			if (!(flags & mods[i].flag)) continue;
			acc &= ~mods[i].flag;
			CGEventRef mu = CGEventCreateKeyboardEvent_p(kbd_source(), uint16_t(mods[i].kc), false);
			if (mu) CGEventSetFlags_p(mu, acc);
			post(mu);
		}
		return dn != nullptr && up != nullptr;
	}

	static int named_keycode(const std::string& n) {
		struct N { const char* name; int kc; };
		static const N tbl[] = {
			{"return", 36}, {"enter", 36}, {"esc", 53}, {"escape", 53},
			{"tab", 48}, {"space", 49}, {"backspace", 51}, {"delete", 117},
			{"home", 115}, {"end", 119}, {"pageup", 116}, {"pagedown", 121},
			{"up", 126}, {"down", 125}, {"left", 123}, {"right", 124},
			{"minus", 27}, {"plus", 24}, {"capslock", 57},
		};
		for (auto& e : tbl) if (n == e.name) return e.kc;
		return -1;
	}

	static int char_keycode(unsigned char ch) {
		// US ANSI layout; shifted punctuation unshifts to its base key
		switch (ch) {
			case 'a': return 0; case 's': return 1; case 'd': return 2; case 'f': return 3;
			case 'h': return 4; case 'g': return 5; case 'z': return 6; case 'x': return 7;
			case 'c': return 8; case 'v': return 9; case 'b': return 11; case 'q': return 12;
			case 'w': return 13; case 'e': return 14; case 'r': return 15; case 'y': return 16;
			case 't': return 17; case '1': case '!': return 18; case '2': case '@': return 19;
			case '3': case '#': return 20; case '4': case '$': return 21; case '6': case '^': return 22;
			case '5': case '%': return 23; case '=': case '+': return 24; case '9': case '(': return 25;
			case '7': case '&': return 26; case '-': case '_': return 27; case '8': case '*': return 28;
			case '0': case ')': return 29; case ']': case '}': return 30; case 'o': return 31;
			case 'u': return 32; case '[': case '{': return 33; case 'i': return 34; case 'p': return 35;
			case 'l': return 37; case 'j': return 38; case '\'': case '"': return 39; case 'k': return 40;
			case ';': case ':': return 41; case '\\': case '|': return 42; case ',': case '<': return 43;
			case '/': case '?': return 44; case 'n': return 45; case 'm': return 46; case '.': case '>': return 47;
			case '`': case '~': return 50;
			default: return -1;
		}
	}

	// --- keep-awake ------------------------------------------------------------
	// Two IOPMAssertions = the in-process equivalent of `caffeinate -dis`:
	// PreventUserIdleSystemSleep stops idle system sleep, the DisplaySleep
	// variant keeps the screen on. (caffeinate's -u needs a tty, -m is disk
	// idle — irrelevant for a rig.) Lid-close sleep on battery is NOT
	// something any assertion can stop — that takes `sudo pmset -a
	// disablesleep 1`, surfaced to the client via rig.stayAwake's lidClose.
	bool stay_awake(bool on) {
		if (!ok || !IOPMAssertionCreateWithName_p || !kIOPMAssertionTypePreventUserIdleSystemSleep)
			return false;
		if (!on) {
			if (sleep_assertion && IOPMAssertionRelease_p) {
				IOPMAssertionRelease_p(sleep_assertion);
				sleep_assertion = 0;
			}
			if (display_assertion && IOPMAssertionRelease_p) {
				IOPMAssertionRelease_p(display_assertion);
				display_assertion = 0;
			}
			return true;
		}
		if (sleep_assertion) return true;
		CFStringRef name = CFStringCreateWithCString_p(nullptr, "remote rig", kCFStringEncodingUTF8);
		uint32_t aid = 0;
		int rc = IOPMAssertionCreateWithName_p(kIOPMAssertionTypePreventUserIdleSystemSleep, 255, name, &aid);
		if (rc == 0 && aid) sleep_assertion = aid;
		uint32_t did = 0;
		if (kIOPMAssertionTypePreventUserIdleDisplaySleep) {
			int rc2 = IOPMAssertionCreateWithName_p(kIOPMAssertionTypePreventUserIdleDisplaySleep, 255, name, &did);
			if (rc2 == 0 && did) display_assertion = did;
		}
		if (name) CFRelease_p(name);
		return sleep_assertion != 0;
	}

	// honest mechanism string for rig.status — never claims more than held
	const char* awake_method() {
		if (sleep_assertion && display_assertion) return "iopm:idle+display";
		if (sleep_assertion) return "iopm:idle";
		return "none";
	}
	bool awake_held_os() { return sleep_assertion != 0; }
};

static MacBackend g_mac;

} // namespace rig
