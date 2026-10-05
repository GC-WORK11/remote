// omprd — remote OS-bridge daemon v0.8
//
// The remote-control backend: exposes the rig's omp sessions over an
// authenticated WebSocket and bridges them to `omp --mode rpc` subprocesses
// (ndjson on stdio). Transport security = WireGuard via Tailscale; the daemon
// binds the tailnet IP by default and never the public internet.
//
// subsystems
//   · per-client writer threads with writev() batching — one syscall per burst
//   · per-session monotonic event ring buffers + replay (`since` cursor)
//   · daemon-correlated requests (session.request) + convenience (usage/stats)
//   · master control: cross-session subagent fan-out, remote compaction, abortAll
//   · latency telemetry: reservoir sampling, p50/p95/p99 nearest-rank
//   · auth: timing-safe token compare, token-bucket pairing rate limit,
//     live device revocation (devices.json mtime watch), rig.lock kill switch
//   · session spawn options: tools passthrough (--tools) incl. computer-use,
//     yolo mode opt-in, model preselect
//   · v0.8 hot path: conditional JSON parse (passthrough frames never parse),
//     shared_ptr fan-out (no per-client payload copy), rig.fs native ops,
//     warm omp pool (repeat session.new ≈ instant), auto-compact trigger
//
// Wire protocol: see ../protocol.md
#if defined(_WIN32)
#define _CRT_SECURE_NO_WARNINGS // must precede every CRT header
#endif
#include "crypto.hpp"
#include "json.hpp"
#include "qr.hpp"
#include "rigfs.hpp"
#if defined(_WIN32)
#include "../windows/win.hpp"
#else
#include "../linux/x11.hpp"
#endif
#if defined(__APPLE__)
#include "../macos/mac.hpp"
#include <libproc.h>
#endif

#define OMPRD_VERSION "0.9.2"

#if defined(_WIN32)
#define _CRT_SECURE_NO_WARNINGS
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <tlhelp32.h>
#include <fcntl.h>
#include <io.h>
#include <process.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <arpa/inet.h>
#include <dirent.h>
#include <fcntl.h>
#include <sys/un.h>
#include <poll.h>
#include <sys/uio.h>
#include <unistd.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/wait.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unordered_map>
#include <vector>

#if defined(_WIN32)
// ---- Windows compat seam ----------------------------------------------------
// The daemon body below is written against POSIX names; this block supplies
// them. Sockets are SOCKET-typed (sockfd_t), pipes are CRT fds, and children
// are HANDLEs carried as pid_t. Group-kill (`kill(-pid)`) maps to a per-child
// Job Object — same tree-kill semantics as setsid'd process groups.

using ssize_t = SSIZE_T;
using pid_t = intptr_t;   // a child process HANDLE
using sockfd_t = SOCKET;
using socklen_t = int;

#define MSG_NOSIGNAL 0
#define SIGHUP 1
#define SIGKILL 9
#define WNOHANG 1
#define WIFEXITED(s) (((s) & 0x7f) == 0)
#define WEXITSTATUS(s) (((s) >> 8) & 0xff)
// Windows can't observe a signal death — killed children just have exit
// codes, so WIFSIGNALED is never true here (encoded exit is always <<8)
#define WIFSIGNALED(s) false
#define WTERMSIG(s) 0

static inline ssize_t net_send(sockfd_t fd, const void* p, size_t n, int flags) {
	return ::send(fd, static_cast<const char*>(p), int(n), flags);
}
static inline ssize_t net_recv(sockfd_t fd, void* p, size_t n, int flags) {
	return ::recv(fd, static_cast<char*>(p), int(n), flags);
}
static inline int sock_close(sockfd_t fd) { return ::closesocket(fd); }
static inline ssize_t file_read(int fd, void* p, size_t n) { return ::_read(fd, p, unsigned(n)); }
static inline ssize_t file_write(int fd, const void* p, size_t n) { return ::_write(fd, p, unsigned(n)); }
static inline int file_close(int fd) { return ::_close(fd); }
static inline void usleep(unsigned int us) { Sleep(us / 1000); }

// waitable-pipe readiness: 1 readable, 0 timeout, -1 broken/closed
static int pipe_wait(int fd, int timeout_ms) {
	HANDLE h = reinterpret_cast<HANDLE>(_get_osfhandle(fd));
	if (!h || h == INVALID_HANDLE_VALUE) return -1;
	auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
	for (;;) {
		DWORD avail = 0;
		if (!PeekNamedPipe(h, nullptr, 0, nullptr, &avail, nullptr)) return -1;
		if (avail > 0) return 1;
		int64_t left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count();
		if (left <= 0) return 0;
		Sleep(DWORD(std::min<int64_t>(left, 10)));
	}
}

// ---- process layer ----------------------------------------------------------

struct WinProc { HANDLE proc = nullptr; HANDLE job = nullptr; DWORD os_pid = 0; };
static std::mutex g_procs_mutex;
static std::unordered_map<pid_t, WinProc> g_procs;

static std::string win_last_err() {
	DWORD e = GetLastError();
	char* msg = nullptr;
	FormatMessageA(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
	               nullptr, e, 0, reinterpret_cast<char*>(&msg), 0, nullptr);
	std::string s = msg ? msg : "error " + std::to_string(e);
	if (msg) LocalFree(msg);
	while (!s.empty() && (s.back() == '\r' || s.back() == '\n' || s.back() == ' ')) s.pop_back();
	return s;
}

static std::wstring win_widen(const std::string& s) {
	if (s.empty()) return {};
	int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), nullptr, 0);
	std::wstring w(size_t(n), 0);
	MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), w.data(), n);
	return w;
}

// argv element → Windows command-line quoting (the CreateProcess rules, not cmd's)
static std::string win_arg(const std::string& a) {
	if (!a.empty() && a.find_first_of(" \t\"") == std::string::npos) return a;
	std::string q = "\"";
	int slashes = 0;
	for (char c : a) {
		if (c == '\\') { slashes++; continue; }
		if (c == '"') { q.append(size_t(slashes) * 2, '\\'); q += "\\\""; slashes = 0; continue; }
		q.append(size_t(slashes), '\\'); slashes = 0; q += c;
	}
	q.append(size_t(slashes) * 2, '\\');
	q += '"';
	return q;
}

struct WinSpawnOpts {
	bool want_stdin = false;     // give the child a pipe for its stdin
	bool want_stdout = true;     // give the parent a pipe reading child stdout
	bool merge_stderr = true;    // stderr onto the stdout pipe (run_capture/exec)
	bool detached = false;       // all std handles to NUL (spawn_detached)
	std::string cwd;
	std::vector<std::string> env; // extra NAME=value vars on top of our environment
};

static HANDLE win_null_handle() {
	static HANDLE nul = [] {
		SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
		return CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
		                   FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
	}();
	return nul;
}

// CreateProcess with pipes wired like the fork/dup2 paths do on POSIX.
// Only the listed handles are inherited (PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
// so the listen socket never leaks into a child — the FD_CLOEXEC equivalent.
static pid_t win_spawn(const std::string& cmdline, const WinSpawnOpts& o,
                       int& stdin_fd, int& stdout_fd, std::string* err = nullptr) {
	stdin_fd = -1; stdout_fd = -1;
	SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
	HANDLE in_r = nullptr, in_w = nullptr, out_r = nullptr, out_w = nullptr;
	if (o.want_stdin) {
		if (!CreatePipe(&in_r, &in_w, &sa, 0)) { if (err) *err = win_last_err(); return -1; }
		SetHandleInformation(in_w, HANDLE_FLAG_INHERIT, 0); // parent keeps the write end
	}
	if (o.want_stdout) {
		if (!CreatePipe(&out_r, &out_w, &sa, 0)) {
			if (err) *err = win_last_err();
			if (in_r) { CloseHandle(in_r); CloseHandle(in_w); }
			return -1;
		}
		SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
	}
	// child stderr: merged into stdout, NUL when detached, else a duplicate of
	// our own stderr so omp logging still lands in the daemon's console
	HANDLE err_h = win_null_handle();
	if (o.merge_stderr) err_h = out_w;
	else if (!o.detached) {
		HANDLE mine = GetStdHandle(STD_ERROR_HANDLE);
		HANDLE dup = nullptr;
		if (mine && mine != INVALID_HANDLE_VALUE &&
		    DuplicateHandle(GetCurrentProcess(), mine, GetCurrentProcess(), &dup, 0, TRUE, DUPLICATE_SAME_ACCESS))
			err_h = dup;
	}
	HANDLE inherit[4];
	int n_inh = 0;
	if (in_r) inherit[n_inh++] = in_r;
	if (out_w) inherit[n_inh++] = out_w;
	if (err_h && err_h != out_w && err_h != win_null_handle()) inherit[n_inh++] = err_h;
	if (!n_inh) inherit[n_inh++] = win_null_handle();

	STARTUPINFOEXW si{};
	si.StartupInfo.cb = sizeof(si);
	si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
	si.StartupInfo.hStdInput = o.want_stdin ? in_r : win_null_handle();
	si.StartupInfo.hStdOutput = o.want_stdout ? out_w : win_null_handle();
	si.StartupInfo.hStdError = err_h;
	SIZE_T alen = 0;
	InitializeProcThreadAttributeList(nullptr, 1, 0, &alen);
	si.lpAttributeList = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, alen));
	if (si.lpAttributeList) {
		InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &alen);
		UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
		                          inherit, n_inh * sizeof(HANDLE), nullptr, nullptr);
	}
	PROCESS_INFORMATION pi{};
	std::wstring wcmd = win_widen(cmdline);
	std::wstring wcwd = win_widen(o.cwd);
	// extra env vars ride a copy of our own environment block (UTF-16
	// multi-string): inherit everything, then append/override with o.env
	std::wstring env_block;
	if (!o.env.empty()) {
		if (const wchar_t* cur = GetEnvironmentStringsW()) {
			const wchar_t* end = cur;
			while (*end || *(end + 1)) end++;
			env_block.assign(cur, size_t(end - cur) + 1);
			FreeEnvironmentStringsW(const_cast<LPWCH>(cur));
		}
		for (auto& e : o.env) {
			std::wstring we = win_widen(e);
			env_block.append(we.c_str(), we.size() + 1);
		}
		env_block.push_back(L'\0');
	}
	DWORD flags = EXTENDED_STARTUPINFO_PRESENT | (o.detached ? DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP : CREATE_NO_WINDOW);
	if (!env_block.empty()) flags |= CREATE_UNICODE_ENVIRONMENT;
	BOOL spawned = si.lpAttributeList &&
		CreateProcessW(nullptr, wcmd.data(), nullptr, nullptr, TRUE, flags,
		               env_block.empty() ? nullptr : env_block.data(),
		               wcwd.empty() ? nullptr : wcwd.c_str(), &si.StartupInfo, &pi);
	if (!spawned && err) *err = win_last_err();
	if (si.lpAttributeList) {
		DeleteProcThreadAttributeList(si.lpAttributeList);
		HeapFree(GetProcessHeap(), 0, si.lpAttributeList);
	}
	if (in_r) CloseHandle(in_r);
	if (out_w) CloseHandle(out_w);
	if (!spawned) {
		if (in_w) CloseHandle(in_w);
		if (out_r) CloseHandle(out_r);
		return -1;
	}
	CloseHandle(pi.hThread);
	if (o.want_stdin) stdin_fd = _open_osfhandle(intptr_t(in_w), _O_WRONLY | _O_BINARY);
	else if (in_w) CloseHandle(in_w);
	if (o.want_stdout) stdout_fd = _open_osfhandle(intptr_t(out_r), _O_RDONLY | _O_BINARY);
	else if (out_r) CloseHandle(out_r);
	// per-child job: TerminateJobObject = the POSIX kill(-pgid) tree kill
	HANDLE job = CreateJobObjectW(nullptr, nullptr);
	if (job && !AssignProcessToJobObject(job, pi.hProcess)) { CloseHandle(job); job = nullptr; }
	pid_t pid = pid_t(intptr_t(pi.hProcess));
	{
		std::lock_guard<std::mutex> lock(g_procs_mutex);
		g_procs[pid] = WinProc{pi.hProcess, job, pi.dwProcessId};
	}
	return pid;
}

static long proc_display_id(pid_t pid) {
	std::lock_guard<std::mutex> lock(g_procs_mutex);
	auto it = g_procs.find(pid);
	return it != g_procs.end() ? long(it->second.os_pid) : long(pid);
}

static int kill(pid_t pid, int sig) {
	if (pid < 0) { // process group → the child's job object (tree kill)
		HANDLE job = nullptr;
		{
			std::lock_guard<std::mutex> lock(g_procs_mutex);
			auto it = g_procs.find(-pid);
			if (it != g_procs.end()) job = it->second.job;
		}
		if (!job) { errno = ESRCH; return -1; }
		return TerminateJobObject(job, 1) ? 0 : -1;
	}
	if (sig == 0) { // liveness probe
		DWORD w = WaitForSingleObject(reinterpret_cast<HANDLE>(pid), 0);
		if (w == WAIT_TIMEOUT) return 0;
		errno = ESRCH;
		return -1;
	}
	return TerminateProcess(reinterpret_cast<HANDLE>(pid), 1) ? 0 : -1;
}

static pid_t waitpid(pid_t pid, int* status, int flags) {
	HANDLE h = reinterpret_cast<HANDLE>(pid);
	if (!h) { errno = ECHILD; return -1; }
	DWORD w = WaitForSingleObject(h, (flags & WNOHANG) ? 0 : INFINITE);
	if (w == WAIT_TIMEOUT) return 0;
	if (w != WAIT_OBJECT_0) { errno = ECHILD; return -1; }
	DWORD code = 0;
	GetExitCodeProcess(h, &code);
	if (status) *status = int(code) << 8; // WIFEXITED/WEXITSTATUS encoding
	HANDLE job = nullptr;
	{
		std::lock_guard<std::mutex> lock(g_procs_mutex);
		auto it = g_procs.find(pid);
		if (it != g_procs.end()) { job = it->second.job; g_procs.erase(it); }
	}
	if (job) CloseHandle(job);
	CloseHandle(h);
	return pid;
}

#else // POSIX

using sockfd_t = int;
static inline ssize_t net_send(int fd, const void* p, size_t n, int flags) { return ::send(fd, p, n, flags); }
static inline ssize_t net_recv(int fd, void* p, size_t n, int flags) { return ::recv(fd, p, n, flags); }
static inline int sock_close(int fd) { return ::close(fd); }
static inline ssize_t file_read(int fd, void* p, size_t n) { return ::read(fd, p, n); }
static inline ssize_t file_write(int fd, const void* p, size_t n) { return ::write(fd, p, n); }
static inline int file_close(int fd) { return ::close(fd); }
static inline int pipe_wait(int fd, int timeout_ms) {
	struct pollfd p{fd, POLLIN, 0};
	int r = poll(&p, 1, timeout_ms);
	if (r <= 0) return r;
	if (p.revents & POLLIN) return 1;
	return -1; // HUP/ERR with no data left
}
static long proc_display_id(pid_t pid) { return long(pid); }

#endif

// executable-bit probe: Windows has no x-bit; existence is what the WM/omp
// candidate scans actually need
static inline bool file_x_ok(const char* p) {
#if defined(_WIN32)
	return _access(p, 0) == 0;
#else
	return access(p, X_OK) == 0;
#endif
}

using nlohmann::json;
namespace fs = std::filesystem;
using clock_ = std::chrono::steady_clock;
static int64_t now_ms() { return std::chrono::duration_cast<std::chrono::milliseconds>(clock_::now().time_since_epoch()).count(); }
static int64_t wall_ms() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
static int64_t now_us() { return std::chrono::duration_cast<std::chrono::microseconds>(clock_::now().time_since_epoch()).count(); }

static std::atomic<bool> g_stop{false};
static void on_signal(int) { g_stop = true; }

// std::signal() implies SA_RESTART on glibc, which would keep accept() asleep
// through SIGTERM forever; install without it so the loop observes g_stop.
static void install_stop_signals() {
#if defined(_WIN32)
	std::signal(SIGINT, on_signal);
	std::signal(SIGTERM, on_signal);
	// Ctrl-Break / console close raise here; accept() unblocks via closesocket
	// from the shutdown path and g_stop ends the loop.
	SetConsoleCtrlHandler(+[](DWORD type) -> BOOL {
		if (type == CTRL_BREAK_EVENT || type == CTRL_CLOSE_EVENT) {
			g_stop = true;
			return TRUE;
		}
		return FALSE;
	}, TRUE);
#else
	struct sigaction sa{};
	sa.sa_handler = on_signal;
	sigemptyset(&sa.sa_mask);
	sa.sa_flags = 0; // NO SA_RESTART
	sigaction(SIGINT, &sa, nullptr);
	sigaction(SIGTERM, &sa, nullptr);
#endif
}

static void log(const std::string& msg) {
	auto t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
	char buf[32];
	std::strftime(buf, sizeof(buf), "%H:%M:%S", std::localtime(&t));
	std::cerr << "[" << buf << "] " << msg << "\n";
}

static std::string home_dir() {
#if defined(_WIN32)
	// USERPROFILE is the canonical win path; Git-Bash HOME is a posix-ified
	// path ("/c/Users/...") that fs::path would mangle — prefer it last
	if (const char* h = getenv("USERPROFILE")) return h;
#endif
	if (const char* h = getenv("HOME")) return h;
	return ".";
}

static std::string host_name() {
	if (const char* h = getenv("HOSTNAME")) return h;
#if defined(_WIN32)
	if (const char* h = getenv("COMPUTERNAME")) return h;
#endif
	return "rig";
}

// First credentialed provider/model from ~/.omp/agent/models.yml — the file
// the user wrote to say "these providers have keys on this host". omp's own
// fallback walks the full bundled catalog and picks alphabetically-first
// "authed" entries (dead EOL bedrock models pass the key check), so when a
// client sends no model we pin the file's first entry instead.
static std::vector<std::string> configured_providers() {
	std::ifstream in(home_dir() + "/.omp/agent/models.yml");
	std::vector<std::string> out;
	if (!in) return out;
	std::string line;
	while (std::getline(in, line)) {
		const size_t b = line.find_first_not_of(" \t");
		if (b == std::string::npos || line[b] == '#') continue;
		const size_t e = line.find_last_not_of(" \t");
		const std::string t = line.substr(b, e - b + 1);
		if (b == 2 && t.back() == ':' && t != "models:")
			out.push_back(t.substr(0, t.size() - 1));
	}
	return out;
}

static std::string first_configured_model() {
	std::ifstream in(home_dir() + "/.omp/agent/models.yml");
	if (!in) return "";
	std::string line, prov;
	while (std::getline(in, line)) {
		const size_t b = line.find_first_not_of(" \t");
		if (b == std::string::npos || line[b] == '#') continue;
		const size_t e = line.find_last_not_of(" \t");
		const std::string t = line.substr(b, e - b + 1);
		if (!prov.empty() && t.rfind("- id:", 0) == 0) {
			const size_t v = t.find_first_not_of(" \t", 5);
			if (v != std::string::npos) return prov + "/" + t.substr(v);
		}
		// two-space indented top-level key ending in ':' = a provider name
		if (b == 2 && t.back() == ':' && t != "models:") prov = t.substr(0, t.size() - 1);
	}
	return "";
}

// ---- rig.models: ~/.omp/agent/models.yml → the app's model pill ----------
// Indentation-scoped scanner (providers: <name>: fields + a `models:` list of
// `- key: val` items). apiKey is reported only as keyConfigured/ready — the
// secret value never crosses the wire. `ready` = a credential omp can
// actually use: literal key, resolvable $ENV/env:NAME reference, or an OAuth
// row in the local vault.
static std::string yml_trim(const std::string& s) {
	const size_t b = s.find_first_not_of(" \t");
	if (b == std::string::npos) return "";
	const size_t e = s.find_last_not_of(" \t");
	return s.substr(b, e - b + 1);
}
static std::string yml_unquote(const std::string& s) {
	std::string t = yml_trim(s);
	if (t.size() >= 2 && (t.front() == '"' || t.front() == '\'') && t.back() == t.front())
		return t.substr(1, t.size() - 2);
	return t;
}
// minimal inline YAML value → json: [a, b] | {k: v, ...} | scalar.
// Comma splits are bracket/quote aware: {efforts: [a, b]} stays one value.
static json yml_value(const std::string& s);
static std::vector<std::string> yml_split(const std::string& inner) {
	std::vector<std::string> parts;
	std::string cur;
	int depth = 0;
	char q = 0;
	for (char ch : inner) {
		if (q) { cur += ch; if (ch == q) q = 0; continue; }
		if (ch == '"' || ch == '\'') { q = ch; cur += ch; continue; }
		if (ch == '[' || ch == '{') depth++;
		if (ch == ']' || ch == '}') depth--;
		if (ch == ',' && depth == 0) { parts.push_back(cur); cur.clear(); }
		else cur += ch;
	}
	parts.push_back(cur);
	return parts;
}
static json yml_value(const std::string& s) {
	std::string t = yml_trim(s);
	if (t.size() >= 2 && t.front() == '[' && t.back() == ']') {
		json arr = json::array();
		for (auto& p : yml_split(t.substr(1, t.size() - 2))) {
			std::string v = yml_unquote(p);
			if (!v.empty()) arr.push_back(v);
		}
		return arr;
	}
	if (t.size() >= 2 && t.front() == '{' && t.back() == '}') {
		json obj = json::object();
		for (auto& p : yml_split(t.substr(1, t.size() - 2))) {
			const size_t c = p.find(':');
			if (c == std::string::npos) continue;
			obj[yml_unquote(p.substr(0, c))] = yml_value(p.substr(c + 1));
		}
		return obj;
	}
	if (t == "true") return true;
	if (t == "false") return false;
	// integers only (contextWindow/maxTokens); anything else stays a string
	if (!t.empty() && t.find_first_not_of("0123456789") == std::string::npos) return std::strtoull(t.c_str(), nullptr, 10);
	return yml_unquote(t);
}

// ---------------------------------------------------------------------------
// Latency telemetry — reservoir sampling (Vitter's Algorithm R), nearest-rank
// percentiles over a fixed 256-sample window per metric. O(1) per sample.
// ---------------------------------------------------------------------------

struct Reservoir {
	std::vector<int64_t> samples;
	uint64_t seen = 0;
	std::mutex mutex;

	void add(int64_t v) {
		std::lock_guard<std::mutex> lock(mutex);
		seen++;
		if (samples.size() < 256) { samples.push_back(v); return; }
		// Vitter's Algorithm R: the i-th unseen item replaces a random slot with
		// probability 256/i, yielding a uniform 256-sample window over the stream.
		uint64_t r = 0;
		auto b = rig::random_bytes(8);
		for (int k = 0; k < 8; k++) r = (r << 8) | b[k];
		if (r % seen < 256) samples[size_t(r % samples.size())] = v;
	}

	json percentiles() {
		std::lock_guard<std::mutex> lock(mutex);
		if (samples.empty()) return {{"n", 0}};
		std::vector<int64_t> s = samples;
		std::sort(s.begin(), s.end());
		auto rank = [&](double p) { return s[std::min(s.size() - 1, size_t(p * s.size()))]; };
		return {{"n", s.size()}, {"p50", rank(0.50)}, {"p95", rank(0.95)}, {"p99", rank(0.99)}};
	}
};

static Reservoir g_lat_bridge;   // omp line read → enqueued to clients, µs (daemon overhead)
static Reservoir g_lat_emit;     // enqueue → handed to writer (queue wait, ms)
static std::atomic<uint64_t> g_frames_in{0}, g_frames_out{0};
static std::atomic<uint64_t> g_lines_total{0}, g_lines_parsed{0}; // hot-path parse skip counters

// ---------------------------------------------------------------------------
// Token bucket (integer, ms-resolution): capacity 5, refill 1/min per peer.
// Classic leaky-bucket: tokens += elapsed * rate, clamped to capacity.
// ---------------------------------------------------------------------------

struct TokenBucket {
	int64_t tokens;
	int64_t last_ms;
	static constexpr int64_t CAP = 5;
	bool take() {
		int64_t t = now_ms();
		int64_t mins = (t - last_ms) / 60000;
		if (mins > 0) { tokens += mins; last_ms += mins * 60000; } // keep the sub-minute remainder
		if (tokens > CAP) tokens = CAP;
		if (tokens <= 0) return false;
		tokens--;
		return true;
	}
	TokenBucket() : tokens(CAP), last_ms(now_ms()) {}
};

// ---------------------------------------------------------------------------
// Rig state (~/.rig)
// ---------------------------------------------------------------------------

struct Device {
	std::string hash;   // sha256(token)
	std::string device;
	int64_t paired_at{};
	uint32_t scopes = 7; // read|operate|admin — see scope bits below
};

// Capability scopes — T3's orchestration:read/operate model plus a third
// owner-grade bit. Persisted per device; enforced on every incoming frame.
constexpr uint32_t SCOPE_READ = 1, SCOPE_OPERATE = 2, SCOPE_ADMIN = 4,
                   SCOPE_ALL = SCOPE_READ | SCOPE_OPERATE | SCOPE_ADMIN;

static uint32_t scope_mask(const json& names) {
	uint32_t m = 0;
	for (auto& n : names) {
		std::string s = n.get<std::string>();
		if (s == "read") m |= SCOPE_READ;
		else if (s == "operate") m |= SCOPE_OPERATE;
		else if (s == "admin") m |= SCOPE_ADMIN;
	}
	return m;
}
static json scope_names(uint32_t m) {
	json a = json::array();
	if (m & SCOPE_READ) a.push_back("read");
	if (m & SCOPE_OPERATE) a.push_back("operate");
	if (m & SCOPE_ADMIN) a.push_back("admin");
	return a;
}

// Default bucket is OPERATE — anything that mutates state, spawns work,
// or touches the machine. READ is pure inspection; ADMIN is destructive
// or config-grade.
static uint32_t scope_required(const std::string& t) {
	static const std::unordered_set<std::string> READ_OPS = {
		"rig.status", "rig.stats", "rig.usage", "rig.models",
		"rig.vitals", "sessions.list", "sessions.tree", "sessions.subagents", "session.subscribe",
		"session.forPid", "session.wait",
		"session.history", "session.usage", "session.stats", "rig.fs.list", "rig.fs.stat",
		"rig.fs.read", "rig.fs.glob", "rig.fs.grep", "rig.git.status",
		"rig.git.diff", "rig.pr.info", "rig.pr.checks", "rig.schedule.list",
		"rig.checkpoint.list",
		"computer.state", "computer.perms", "computer.windows",
		"computer.screenshot", "computer.shot_file", "computer.observe",
		"computer.watch", "computer.unwatch", "computer.record.list",
		"computer.record.get", "computer.record.frames", "computer.ui.tree",
		"auth.list", "workspace.status",
	};
	if (READ_OPS.count(t)) return SCOPE_READ;
	static const std::unordered_set<std::string> ADMIN_OPS = {
		"rig.lock", "session.delete", "rig.device.scopes",
		"rig.schedule.remove",
	};
	if (ADMIN_OPS.count(t)) return SCOPE_ADMIN;
	return SCOPE_OPERATE;
}

static std::string sha256_hex(const std::string& s) {
	rig::Bytes b(s.begin(), s.end());
	return rig::to_hex(rig::sha256(b));
}

/// Constant-time equality — no early exit on first differing byte.
static bool constant_time_equal(const std::string& a, const std::string& b) {
	if (a.size() != b.size()) return false;
	volatile unsigned char d = 0;
	for (size_t i = 0; i < a.size(); i++) d |= uint8_t(a[i]) ^ uint8_t(b[i]);
	return d == 0;
}

struct RigState {
	fs::path dir;
	std::vector<Device> devices;
	std::mutex mutex;
	std::mutex pair_mutex; // serializes pair() — pending.json read→consume is not atomic
	int64_t devices_mtime_ns{-1};
	std::atomic<bool> locked{false};

	void load() {
		dir = fs::path(home_dir()) / ".rig";
		fs::create_directories(dir);
		// server secret exists purely so future token derivation can evolve
		fs::path secret_path = dir / "secret";
		if (!fs::exists(secret_path)) {
			std::ofstream f(secret_path);
			f << rig::random_hex(32);
			fs::permissions(secret_path, fs::perms::owner_read | fs::perms::owner_write);
		}
		locked = fs::exists(dir / "locked");
		reload_devices();
	}

	void reload_devices() {
		fs::path dp = dir / "devices.json";
		if (!fs::exists(dp)) { std::lock_guard<std::mutex> l(mutex); devices.clear(); return; }
		try {
			auto mtime = fs::last_write_time(dp).time_since_epoch().count();
			if (mtime == devices_mtime_ns) return; // unchanged since last check
			std::ifstream f(dp);
			json j = json::parse(f);
			std::vector<Device> parsed;
			for (auto& d : j)
				parsed.push_back({d.value("hash", ""), d.value("device", "?"),
				                  d.value("paired_at", int64_t(0)),
				                  uint32_t(d.value("scopes", int64_t(SCOPE_ALL)))});
			std::lock_guard<std::mutex> l(mutex);
			devices = std::move(parsed);
			devices_mtime_ns = mtime;
			log("devices.json reloaded: " + std::to_string(devices.size()) + " device(s)");
		} catch (...) {}
	}

	bool token_valid(const std::string& token, uint32_t* scopes_out = nullptr) {
		if (locked) return false;
		if (token.empty()) return false;
		reload_devices();
		std::string h = sha256_hex(token);
		std::lock_guard<std::mutex> lock(mutex);
		for (auto& d : devices)
			if (constant_time_equal(d.hash, h)) {
				if (scopes_out) *scopes_out = d.scopes;
				return true;
			}
		return false;
	}

	// Consumes the one-time pairing code written by `ompr pair` and mints a device token.
	std::string pair(const std::string& code, const std::string& device, std::string& err) {
		// whole read-check-consume under one lock: two connections racing the
		// same pending code must not both mint tokens from it
		std::lock_guard<std::mutex> plock(pair_mutex);
		if (locked) { err = "rig is locked (rm ~/.rig/locked to unlock)"; return {}; }
		reload_devices();
		fs::path pending = dir / "pending.json";
		if (!fs::exists(pending)) { err = "no pairing pending; run `ompr pair` on the rig"; return {}; }
		json p;
		try {
			std::ifstream f(pending);
			p = json::parse(f);
		} catch (...) { err = "pending.json corrupt; re-run `ompr pair`"; return {}; }
		if (!constant_time_equal(p.value("code", ""), code)) {
			err = "that code doesn't match — check `ompr pair` on the rig and try again";
			return {};
		}
		if (std::chrono::system_clock::to_time_t(std::chrono::system_clock::now()) > p.value("expires", int64_t(0))) {
			fs::remove(pending);
			err = "that code expired — run `ompr pair` on the rig for a new one";
			return {};
		}
		std::string token = rig::random_hex(32);
		// pending.json may narrow the minted token's scopes (ompr pair --scopes)
		uint32_t scopes = uint32_t(p.value("scopes", int64_t(SCOPE_ALL)));
		{
			std::lock_guard<std::mutex> lock(mutex);
			// same name = same device (ompr unpair already removes by name):
			// re-pairing renews the credential instead of stacking a duplicate
			// row whose old token would stay valid
			std::string name = device.empty() ? "unnamed" : device;
			devices.erase(std::remove_if(devices.begin(), devices.end(),
			                             [&](const Device& d) { return d.device == name; }),
			              devices.end());
			devices.push_back({sha256_hex(token), name,
			                   std::chrono::system_clock::to_time_t(std::chrono::system_clock::now()),
			                   scopes});
			save_locked();
			devices_mtime_ns = -1; // force reload path refresh
		}
		fs::remove(pending);
		return token;
	}

	void save_locked() {
		json j = json::array();
		for (auto& d : devices)
			j.push_back({{"hash", d.hash}, {"device", d.device},
			             {"paired_at", d.paired_at}, {"scopes", d.scopes}});
		std::ofstream f(dir / "devices.json.tmp");
		f << j.dump();
		f.close();
		fs::rename(dir / "devices.json.tmp", dir / "devices.json");
		devices_mtime_ns = -1;
	}
};

static RigState g_rig;
static std::string g_omp_bin;
static const int64_t g_boot_ms = now_ms();

// Per-boot service credential minted for omp children only: the daemon
// injects it (plus the loopback URL) into each spawned child's environment so
// in-fork tools can call back into computer.* as an authenticated client.
// Never persisted, never logged — it dies with the daemon process.
static const std::string g_service_token = rig::random_hex(32);
static std::string g_bind_ip;
static int g_port = 8790;

// True when `token` is the per-boot service credential (omp child loopback),
// as opposed to a paired-device token.
static bool is_service_token(const std::string& token) {
	return token.size() == g_service_token.size() && constant_time_equal(token, g_service_token);
}

// rig-call — the in-session wire shim. Materialized to ~/.rig/rig-call at
// boot and exposed to omp children as $OMPD_RIG_CALL so the agent can call
// any rig op from its bash tool. Written for bun (every omp install has it
// — the omp entry is itself #!/usr/bin/env bun); stdlib only.
// The caller's pid rides as callerPid so ops that act on "this session"
// (session.spawn self-parenting) resolve it via the ppid walk.
static const char* RIG_CALL_JS = R"JS(#!/usr/bin/env bun
// rig-call — one-shot omprd op caller for in-session agents.
// omprd injects OMPD_WS + OMPD_TOKEN into every session child; this turns
// them into a single wire call and prints the reply JSON.
//   rig-call <op> ['<json-args>']        — call op, print reply (exit≠0 on error reply)
//   rig-call --no-wait <op> '<json>'     — send and exit (fire-and-forget)
//   rig-call --wait <ms> <op> '<json>'   — override the reply wait
const argv = process.argv.slice(2);
let noWait = false, waitMs = Number(process.env.OMPD_CALL_TIMEOUT_MS || 120000);
while (argv.length && argv[0].startsWith("--")) {
  const f = argv.shift();
  if (f === "--no-wait") noWait = true;
  else if (f === "--wait") waitMs = Number(argv.shift() || 0) || waitMs;
  else { console.error("rig-call: unknown flag " + f); process.exit(2); }
}
const [op, argsJson] = argv;
if (!op) { console.error("usage: rig-call [--no-wait|--wait <ms>] <op> '<json-args>'"); process.exit(2); }
let args = {};
if (argsJson) { try { args = JSON.parse(argsJson); } catch (e) { console.error("rig-call: bad json args: " + e.message); process.exit(2); } }
const url = process.env.OMPD_WS, token = process.env.OMPD_TOKEN;
if (!url || !token) { console.error("rig-call: OMPD_WS/OMPD_TOKEN unset — not inside an omprd session"); process.exit(3); }
const reqId = 1;
const ws = new WebSocket(url, { headers: { Authorization: "Bearer " + token } });
const timer = setTimeout(() => { console.error("rig-call: timed out waiting for reply"); process.exit(4); }, waitMs);
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: op, id: reqId, callerPid: process.pid, ...args }));
  if (noWait) { clearTimeout(timer); process.exit(0); }
});
ws.addEventListener("message", (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id !== reqId && (m.frame || {})._cid !== reqId) return;
  console.log(JSON.stringify(m));
  clearTimeout(timer);
  process.exit(m.type === "error" ? 1 : 0);
});
ws.addEventListener("error", () => { console.error("rig-call: websocket error"); clearTimeout(timer); process.exit(5); });
ws.addEventListener("close", (ev) => { if (!ev.wasClean) { console.error("rig-call: connection closed"); clearTimeout(timer); process.exit(5); } });
)JS";

// path the materialized shim lands at (~/.rig/rig-call), injected into
// children as $OMPD_RIG_CALL
static std::string g_rig_call;

// Rig capabilities the agent inside a session needs to know it has — the
// "harness intelligence": session.spawn/sessions.tree exist and when to
// reach for them. Appended to every child's system prompt via omp's
// --append-system-prompt flag.
static const char* RIG_CAPS_PROMPT = R"PR(
§ Pocket Rig
You are running inside an omprd-managed session on the user's real computer — a rig daemon answers JSON-RPC ops at $OMPD_WS. Call one from bash:

    "$OMPD_RIG_CALL" <op> '<json-args>'

It prints the daemon's reply JSON (nonzero exit on a wire error) and attaches your pid automatically, so ops that act on "this session" resolve it — session.spawn needs no parentId.

- session.spawn {"prompt": "<full self-contained task>", "title"?, "cwd"?} — a child session: a full independent agent on this machine with its own thread in the user's app, running concurrently. USE when work fans out into independent parallel tracks (research X while you do Y; several self-contained slices) — spawn one child per track and keep your own thread for synthesis. Prefer it over your built-in task/subagent tool whenever the user asks for sub-agents or the tracks should be inspectable on their own — spawned children appear as live threads in the user's app while your internal subagents stay invisible outside this session. NEVER spawn for trivial or sequential steps — do those yourself.
- sessions.tree {} — every session with parent→children lineage + busy state; check after spawning to confirm the child landed.
- sessions.list {} — ids, cwd, busy, preview.
- session.wait {"sessionId", "timeoutMs"?} — long-poll until that session's turn settles; the reply carries busy/exited/lastSeq/preview. Call it after spawning instead of a sleep loop; read the child's findings from its transcript files or a session.request follow-up.
- session.request {"sessionId", "frame": {"type": "prompt", "id": "<rid>", "message": "…"}} — send a message into another session; the reply is its turn result and can take minutes (OMPD_CALL_TIMEOUT_MS raises the wait). Fire-and-forget: "$OMPD_RIG_CALL" --no-wait rpc '{"sessionId":"…","frame":{…}}'.
- rig.status {} / rig.vitals {} — hostname, uptime, sessions, keep-awake / battery, load, memory, disk, network of this computer.
- computer.screenshot {} — see the user's actual screen (only when the task genuinely needs the desktop; computer.gesture/computer.cursor for input).
- rig.pr.checks {"url"} — real `gh pr checks` rollup; rig.pr.create {"sessionId", "title"?, "body"?} — real `gh pr create` in that session's cwd.
)PR";

// write ~/.rig/rig-call if missing or stale (content compare) and point
// g_rig_call at it. ~/.rig exists by the time this runs (g_rig.load()).
static void materialize_rig_call() {
	fs::path p = fs::path(home_dir()) / ".rig" / "rig-call";
	std::error_code ec;
	bool same = false;
	if (fs::exists(p, ec) && fs::file_size(p, ec) == std::strlen(RIG_CALL_JS)) {
		std::ifstream in(p, std::ios::binary);
		std::string cur((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		same = cur == RIG_CALL_JS;
	}
	if (!same) {
		std::ofstream f(p, std::ios::binary | std::ios::trunc);
		f << RIG_CALL_JS;
	}
#if !defined(_WIN32)
	fs::permissions(p, fs::perms::owner_all | fs::perms::group_read | fs::perms::group_exec |
	                      fs::perms::others_read | fs::perms::others_exec,
	                ec);
#endif
	g_rig_call = p.string();
}

// auto-compact: a get_state reading at ≥ RIG_COMPACT_PCT % of the context
// window (default 85, 0 disables) makes the daemon issue a compact itself
static int g_compact_pct = [] { const char* e = getenv("RIG_COMPACT_PCT"); return e ? std::atoi(e) : 85; }();
// thinking level folded into provider/model:LEVEL when the client gave a
// model without one — RIG_THINKING overrides ("" disables), default "low"
static std::string g_thinking_default = [] { const char* e = getenv("RIG_THINKING"); return e ? std::string(e) : std::string("low"); }();

// set by rig.stayAwake {on:true}: keep the host awake even with zero live
// sessions — the rig's whole point is being reachable from the phone
static std::atomic<bool> g_keep_awake_persistent{false};
static pid_t g_lid_inhibit_pid = -1;

struct Capture { int code = -1; std::string out; bool timed_out = false; };

// single-quote escaper for shell snippets built from user/session paths
static std::string shell_quote(const std::string& s) {
	std::string q = "'";
	for (char ch : s) q += (ch == '\'') ? "'\\''" : std::string(1, ch);
	q += '\'';
	return q;
}

// synchronous bounded capture — used by rig.authStatus (rig.exec is the
// streaming/async variant for clients)
static Capture run_capture(const std::string& command, int timeout_ms) {
	Capture r;
	int out_fd = -1;
	pid_t pid = -1;
#if defined(_WIN32)
	int in_fd = -1;
	// cmd /s /c "...": /s strips the outer quote pair, inner runs verbatim
	pid = win_spawn("cmd.exe /d /s /c \"" + command + "\"",
	                WinSpawnOpts{.want_stdin = false, .want_stdout = true, .merge_stderr = true,
	                             .cwd = {}, .env = {}},
	                in_fd, out_fd);
	if (pid <= 0) return r;
#else
	int fds[2];
	if (pipe(fds) != 0) return r;
	pid = fork();
	if (pid == 0) {
		::close(fds[0]);
		dup2(fds[1], STDOUT_FILENO);
		dup2(fds[1], STDERR_FILENO);
		::close(fds[1]);
		setpgid(0, 0);
		setenv("TERM", "dumb", 1);
		execl("/bin/bash", "/bin/bash", "-lc", command.c_str(), nullptr);
		_exit(127);
	}
	// parent-side setpgid: the child's own setpgid raced a fast timeout —
	// kill(-pid) could hit ESRCH before the group existed, orphaning the tree
	setpgid(pid, pid);
	::close(fds[1]);
	out_fd = fds[0];
#endif
	auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
	char buf[65536];
	bool open = true;
	while (open) {
		int remain = int(std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count());
		if (remain <= 0) { r.timed_out = true; kill(-pid, SIGKILL); kill(pid, SIGKILL); break; }
		int pr = pipe_wait(out_fd, remain);
		if (pr == 0) { r.timed_out = true; kill(-pid, SIGKILL); kill(pid, SIGKILL); break; }
		if (pr < 0) break;
		ssize_t n = file_read(out_fd, buf, sizeof(buf));
		if (n <= 0) { open = false; break; }
		r.out.append(buf, size_t(n));
		if (r.out.size() > (1u << 20)) r.out.resize(1u << 20);
	}
	file_close(out_fd);
	int status = 0;
	waitpid(pid, &status, 0);
	r.code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
	return r;
}

// best-effort workspace branch for sessions.list — one cheap probe at
// spawn/restore, '' when cwd isn't a git repo, git is missing, or the
// checkout is detached (nothing useful to show there)
static std::string probe_git_branch(const std::string& dir) {
#if defined(_WIN32)
	Capture r = run_capture("git -C \"" + dir + "\" rev-parse --abbrev-ref HEAD 2>NUL", 3000);
#else
	Capture r = run_capture("git -C " + shell_quote(dir) + " rev-parse --abbrev-ref HEAD 2>/dev/null", 3000);
#endif
	if (r.code != 0) return "";
	while (!r.out.empty() && (r.out.back() == '\n' || r.out.back() == '\r' || r.out.back() == ' '))
		r.out.pop_back();
	if (r.out.empty() || r.out == "HEAD" || r.out.size() > 64) return "";
	return r.out;
}

#if defined(_WIN32)
// Lid-close truth on Windows is only ever a RE-QUERY: powercfg
// -setacvalueindex exits 0 even when LIDACTION isn't in the active scheme
// (lidless VMs/desktops/servers accept the write into the void), so a bare
// rc==0 lies. Query first, write, then query again.
static long g_lid_prev_ac = -1, g_lid_prev_dc = -1;  // captured before first override
static bool g_lid_overridden = false;
static bool g_lid_needs_admin = false;

// (-1,-1) = LIDACTION absent from the active scheme or the query failed.
static std::pair<long, long> win_lid_indexes() {
	Capture r = run_capture("powercfg -q SCHEME_CURRENT SUB_BUTTONS LIDACTION", 8000);
	long ac = -1, dc = -1;
	if (r.code != 0) return {ac, dc};
	std::istringstream in(r.out);
	std::string line;
	while (std::getline(in, line)) {
		auto pick = [&](const char* key) -> long {
			auto p = line.find(key);
			if (p == std::string::npos) return -1L;
			return std::strtol(line.c_str() + p + strlen(key), nullptr, 0);
		};
		long v;
		if ((v = pick("AC Power Setting Index:")) >= 0) ac = v;
		else if ((v = pick("DC Power Setting Index:")) >= 0) dc = v;
	}
	return {ac, dc};
}
#endif

#if defined(__APPLE__)
// Same contract as Windows: lid state is what the OS reports, not what
// this process last wrote — a pre-restart `pmset` grant or an
// install.sh --with-lid run both count. `pmset -g` is a small process;
// rig.status is not hot, so read it fresh each call.
static bool mac_lid_disabled() {
	FILE* f = popen("pmset -g 2>/dev/null", "r");
	if (!f) return false;
	char buf[4096];
	std::string out;
	while (fgets(buf, sizeof(buf), f)) out += buf;
	pclose(f);
	auto p = out.find("SleepDisabled");
	if (p == std::string::npos) return false;
	const char* s = out.c_str() + p + 13;
	while (*s == ' ' || *s == '\t') s++;
	return *s == '1';
}
#endif

// ---------------------------------------------------------------------------

// used by the subsystem block below, defined later
struct Client;
static void send_json(Client* c, const nlohmann::json& j);
static bool client_alive(Client* c);

struct RunResult {
	int code = -1;
	bool timed_out = false;
	std::string out;
};

#if !defined(__APPLE__) && !defined(_WIN32)
// X11-only subprocess fallbacks (xdotool/wmctrl/import) — no callers on the
// CG/SendInput backends, so the whole function is gated to keep -Wall clean.
static RunResult run_capture(const std::string& cmd, const std::string& display, int timeout_ms, size_t max_bytes = 32 * 1024 * 1024) {
	int out_fd = -1;
	pid_t pid = -1;
#if defined(_WIN32)
	(void)display;
	int in_fd = -1;
	// cmd /s /c "...": /s strips the outer quote pair, inner runs verbatim
	pid = win_spawn("cmd.exe /d /s /c \"" + cmd + "\"",
	                WinSpawnOpts{.want_stdin = false, .want_stdout = true, .merge_stderr = true,
	                             .cwd = {}, .env = {}}, in_fd, out_fd);
	if (pid <= 0) return {};
#else
	int fds[2];
	if (pipe(fds) != 0) return {};
	pid = fork();
	if (pid == 0) {
		::close(fds[0]);
		dup2(fds[1], STDOUT_FILENO);
		dup2(fds[1], STDERR_FILENO);
		::close(fds[1]);
		setpgid(0, 0); // group leader — a timeout's kill(-pid) reaches grandchildren
		setenv("DISPLAY", display.c_str(), 1);
		setenv("TERM", "dumb", 1);
		unsetenv("WAYLAND_DISPLAY");
		execl("/bin/sh", "/bin/sh", "-c", cmd.c_str(), nullptr);
		_exit(127);
	}
	// parent-side setpgid — same fork-race fix as the other run_capture
	setpgid(pid, pid);
	::close(fds[1]);
	out_fd = fds[0];
#endif
	RunResult r;
	auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
	char buf[65536];
	bool open = true;
	while (open) {
		int remain = int(std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count());
		if (remain <= 0) { r.timed_out = true; kill(-pid, SIGKILL); kill(pid, SIGKILL); break; }
		int pr = pipe_wait(out_fd, remain);
		if (pr < 0) break;
		if (pr == 0) { r.timed_out = true; kill(-pid, SIGKILL); kill(pid, SIGKILL); break; }
		ssize_t n = file_read(out_fd, buf, sizeof(buf));
		if (n <= 0) { open = false; break; }
		if (r.out.size() < max_bytes) {
			size_t take = std::min(size_t(n), max_bytes - r.out.size());
			r.out.append(buf, take);
		}
	}
	file_close(out_fd);
	int status = 0;
	waitpid(pid, &status, 0);
	r.code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
	return r;
}
#endif // !__APPLE__ && !_WIN32

// Bounded whole-message write: a partial write mid-frame corrupts the peer's
// stream (ndjson for omp children) — loop on short writes, give up on a dead
// or persistently full pipe. Callers hold the per-session write_mutex.
static bool write_all_fd(int fd, const char* data, size_t n, int timeout_ms = 5000) {
	size_t off = 0;
	auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
	while (off < n) {
		int remain = int(std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count());
		if (remain <= 0) return false;
#if defined(_WIN32)
		// anonymous pipes have no writable-poll: _write blocks on a full pipe,
		// unblocking with an error when the child dies — the deadline bounds
		// only the retry loop, same net effect for the small ndjson frames here
		ssize_t w = file_write(fd, data + off, n - off);
		if (w < 0) return false; // EBADF/EPIPE — child dead or pipe closed
		off += size_t(w);
#else
		struct pollfd p{fd, POLLOUT, 0};
		int pr = poll(&p, 1, remain);
		if (pr <= 0) return false;
		if (p.revents & (POLLERR | POLLHUP | POLLNVAL)) return false;
		ssize_t w = write(fd, data + off, n - off);
		if (w < 0) { if (errno == EINTR) continue; return false; }
		off += size_t(w);
#endif
	}
	return true;
}

static pid_t spawn_detached(const std::string& cmd, const std::string& display) {
#if defined(_WIN32)
	(void)display;
	int in_fd = -1, out_fd = -1;
	return win_spawn("cmd.exe /d /c " + cmd,
	                 WinSpawnOpts{.want_stdin = false, .want_stdout = false, .detached = true,
	                              .cwd = {}, .env = {}}, in_fd, out_fd);
#else
	pid_t pid = fork();
	if (pid != 0) return pid;
	setsid();
	int devnull = open("/dev/null", O_WRONLY);
	if (devnull >= 0) { dup2(devnull, STDIN_FILENO); dup2(devnull, STDOUT_FILENO); dup2(devnull, STDERR_FILENO); }
	setenv("DISPLAY", display.c_str(), 1);
	unsetenv("WAYLAND_DISPLAY");
	execl("/bin/sh", "/bin/sh", "-c", cmd.c_str(), nullptr);
	_exit(127);
#endif
}

// ---------------------------------------------------------------------------
// Computer-use subsystem — the agent's own display (default a virtual one).
// The REAL desktop is only touched when a client explicitly asks for it.
// ---------------------------------------------------------------------------

// the native backend for this platform — same surface on every OS
#if defined(__APPLE__)
static inline rig::MacBackend& native() { return rig::g_mac; }
#elif defined(_WIN32)
static inline rig::WinBackend& native() { return rig::g_win; }
#else
static inline rig::X11Backend& native() { return rig::g_x11; }
#endif

struct Computer {
#if defined(__APPLE__) || defined(_WIN32)
	// macOS/Windows have no Xvfb-style virtual display — the agent drives the
	// real session display (isolation via a separate session is v0.8+)
	std::string display = "main";
#else
	std::string display = ":99";          // agent's display; ":1" = real session (opt-in per call)
#endif
	int width = 1920, height = 1080;
	pid_t xvfb_pid = -1;
	pid_t wm_pid = -1;
	std::mutex mutex;

	// PIDs get recycled — the only truth is a live socket connection.
	bool x_alive() const {
#if defined(_WIN32)
		return false; // no X server sockets on Windows; ":99" can't come up
#else
		// socket file omits the screen suffix — ":99.0" shares X99's socket;
		// checking X99.0 (never created) would respawn Xvfb over a live server
		std::string sock = "/tmp/.X11-unix/X" + display.substr(1, display.find('.') == std::string::npos
		                                                         ? std::string::npos : display.find('.') - 1);
		int fd = socket(AF_UNIX, SOCK_STREAM, 0);
		if (fd < 0) return false;
		sockaddr_un addr{};
		addr.sun_family = AF_UNIX;
		std::strncpy(addr.sun_path, sock.c_str(), sizeof(addr.sun_path) - 1);
		bool ok = connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0;
		::close(fd);
		return ok;
#endif
	}

	bool xvfb_alive() {
#if defined(__APPLE__) || defined(_WIN32)
		return true; // field kept for protocol compat; readiness is in perms
#else
		return x_alive();
#endif
	}

	// A surviving Xvfb proves nothing about the WM: detached children outlive
	// the daemon that spawned them, and without a WM no client ever receives
	// input focus — key/button events vanish while pointer motion still lands.
	// Every candidate WM publishes _NET_SUPPORTING_WM_CHECK on the root window.
	bool wm_running() {
#if !defined(__APPLE__) && !defined(_WIN32)
		if (!native().init()) return false;
		auto* d = native().display(display);
		if (!d || !native().XInternAtom || !native().XGetWindowProperty || !native().XFree)
			return false;
		auto prop = native().XInternAtom(d, "_NET_SUPPORTING_WM_CHECK", 1);
		if (!prop) return false;
		unsigned long actual = 0, n = 0, after = 0;
		int fmt = 0;
		unsigned char* data = nullptr;
		int rc = native().XGetWindowProperty(d, native().root(d, display), prop,
		                                   0, 1, 0, 4 /*XA_WINDOW*/, &actual, &fmt,
		                                   &n, &after, &data);
		bool ok = (rc == 0 && data && n > 0);
		if (data) native().XFree(data);
		return ok;
#else
		return true;
#endif
	}

	// GUI apps (Firefox/GTK) don't map reliably without a window manager;
	// the agent's desktop is Xvfb + a WM, booted together. (X11 path only —
	// Windows/macOS spawn nothing; the access() probe finds no /usr/bin WM.)
	void spawn_wm() {
		if (wm_pid > 0 && kill(wm_pid, 0) == 0) return;
		if (wm_running()) return; // another WM already owns this display
		const char* wms[] = {"xfwm4", "openbox", "metacity", "marco", "fluxbox"};
		const char* dirs[] = {"/usr/bin/", "/bin/", "/usr/local/bin/"};
		for (const char* wm : wms)
			for (const char* dir : dirs) {
				std::string path = dir + std::string(wm);
				if (!file_x_ok(path.c_str())) continue;
				wm_pid = spawn_detached(path, display);
				log("computer: window manager " + std::string(wm) + " pid " + std::to_string(wm_pid));
				return;
			}
		log("computer: no window manager found — GUI mapping may be unreliable");
	}

	bool boot(const std::string& want_display, int w, int h, std::string& err) {
		std::lock_guard<std::mutex> lock(mutex);
		if (!want_display.empty()) display = want_display;
		if (w) width = w;
		if (h) height = h;
#if defined(__APPLE__) || defined(_WIN32)
		// no Xvfb here — any display name resolves to the live session display;
		// a client copying the Linux ":99" recipe gets the desktop, not an error
		(void)err;
		{
			int dw = 0, dh = 0;
			if (native().display_size(dw, dh)) { width = dw; height = dh; }
		}
		return true;
#else
		if (display.rfind(":99", 0) == 0) {
			if (xvfb_alive()) {
				// adopted display: Xvfb predates us — the WM may not have survived
				spawn_wm();
				return true;
			}
			// spawn_detached can't report an exec failure — preflight the binary
			// so the error names the missing package instead of a timeout
			static const char* xvfb_paths[] = {"/usr/bin/Xvfb", "/bin/Xvfb", "/usr/local/bin/Xvfb"};
			bool have_xvfb = false;
			for (const char* p : xvfb_paths)
				if (file_x_ok(p)) { have_xvfb = true; break; }
			if (!have_xvfb) {
				err = "Xvfb not installed (apt install xvfb) — or request the real desktop's display";
				return false;
			}
			std::string geo = std::to_string(width) + "x" + std::to_string(height) + "x24";
			log("computer: booting Xvfb on " + display + " at " + geo);
			xvfb_pid = spawn_detached("Xvfb " + display + " -screen 0 " + geo + " -nolisten tcp", display);
			// stale socket files survive SIGKILL'd servers — wait for a real
			// connection, then bring up a window manager
			for (int i = 0; i < 60; i++) {
				if (x_alive()) {
					spawn_wm();
					std::this_thread::sleep_for(std::chrono::milliseconds(400)); // let it settle
					return true;
				}
				std::this_thread::sleep_for(std::chrono::milliseconds(50));
			}
			err = "Xvfb did not come up on " + display;
			return false;
		}
#if !defined(__APPLE__) && !defined(_WIN32)
		// non-virtual display: caller takes responsibility. Resolution fields
		// still must tell the truth — refresh from the live backend so a
		// ":98.1"-style target never reports the 1920x1080 seed while
		// pixelResolution and real captures say 640x480.
		{
			int dw = 0, dh = 0;
			if (native().display_size(display, dw, dh) && dw > 0 && dh > 0) {
				width = dw; height = dh;
			}
		}
		return true;
#endif
#endif
	}
};

static Computer g_computer;

// Injected input is serialized process-wide: a click is motion+press+release
// and a drag is motion+press+N×motion+release — each backend call locks only
// its own Xlib round, so concurrent clients' actions could interleave
// mid-sequence (a stolen motion lands a click on the wrong point, an alien
// press/release corrupts a drag). Held for one whole action, or one whole
// actions[] batch, never across sends.
static std::mutex g_input_mutex;

/// Actions may carry coords in shot-space (the pixel space of the last frame
/// the client rendered). When shotW/shotH arrive alongside x/y and differ
/// from the real display size, scale into display pixels here — without them
/// only the top-left corner of the screen was ever reachable.
static void to_display_xy(const std::string& disp, const json& a, int& x, int& y) {
	int dw = 0, dh = 0, ox = 0, oy = 0;
	if (!native().display_size(disp, dw, dh) || dw <= 0 || dh <= 0) return;
	if constexpr (requires { native().display_origin(disp, ox, oy); })
		native().display_origin(disp, ox, oy);
	int sw = a.value("shotW", 0), sh = a.value("shotH", 0);
	// shotX/shotY + shotRW/shotRH let a client click inside a REGION capture:
	// they name the captured area's display-space origin and native size, so
	// shot-space coords map back exactly. Defaults keep the whole-display
	// behaviour unchanged.
	int sx0 = a.value("shotX", 0), sy0 = a.value("shotY", 0);
	double nrw = a.value("shotRW", 0.0), nrh = a.value("shotRH", 0.0);
	if (nrw <= 0) nrw = dw;
	if (nrh <= 0) nrh = dh;
	if (sw > 0 && sh > 0 && (int(nrw) != sw || int(nrh) != sh)) {
		x = int(std::lround(double(x) * nrw / sw));
		y = int(std::lround(double(y) * nrh / sh));
	}
	// origin always applies (multi-monitor/secondary displays can be
	// non-zero; union origin may even be negative), then clamp to the
	// capture space — clicks outside it can never land right
	x += ox + sx0;
	y += oy + sy0;
	x = std::clamp(x, ox, ox + dw - 1);
	y = std::clamp(y, oy, oy + dh - 1);
}

// Why native injection is unavailable, per OS — the actionable cause, not a
// misleading "xdotool exited 127" on systems with no X tools at all.
static std::string input_hint(const std::string& disp) {
#if defined(__APPLE__)
	(void)disp;
	return "no Accessibility (inject) permission — grant omprd in System "
	       "Settings > Privacy & Security > Accessibility "
	       "(computer.perms {request:true} prompts)";
#elif defined(_WIN32)
	(void)disp;
	native().init();
	if (native().session0)
		return "no interactive desktop — omprd is on a session-0 window station; "
		       "run it inside the logged-in session (ompr up --service)";
	return "SendInput unavailable at this integrity level";
#else
	if (native().init() && !native().display(disp))
		return "cannot open display " + disp + " — check DISPLAY/.Xauthority";
	return "xdotool fallback failed — is xdotool installed and DISPLAY reachable?";
#endif
}

struct Session;
static Session* find_session(const std::string& id);
static void session_track_launch(Session* ws, const std::string& disp, long pid);

#if defined(__linux__)
// Is cand the anc pid itself or a descendant? /proc ppid walk, bounded —
// used to tell "the window my launch just mapped is focused" apart from
// "a same-named window left over from an older launch happens to be".
static bool pid_in_tree(long cand, long anc) {
	for (int depth = 0; depth < 16 && cand > 1; depth++) {
		if (cand == anc) return true;
		char path[48];
		snprintf(path, sizeof(path), "/proc/%ld/stat", cand);
		FILE* f = fopen(path, "r");
		if (!f) return false;
		long ppid = 0;
		// "pid (comm with spaces) state ppid …" — ppid is the field after ')'
		char buf[4096];
		if (!fgets(buf, sizeof(buf), f)) { fclose(f); return false; }
		fclose(f);
		const char* rp = strrchr(buf, ')');
		if (!rp) return false;
		ppid = strtol(rp + 3, nullptr, 10); // skip ") S "
		cand = ppid;
	}
	return false;
}
#endif

/// One computer-use action, native X11 first, subprocess fallback.
/// Used by every single-action handler and by computer.actions batches.
// caller must hold g_input_mutex
static bool computer_step(const std::string& disp, const json& a, json& out) {
	std::string act = a.value("action", "");
	int64_t t0 = now_ms();
	std::string method = "native";
	bool ok = true;
	std::string detail;
	std::string wanted_app;
	bool native_ok = native().init();

	if (act == "click" || act == "doubleclick") {
		int x = a.value("x", 0), y = a.value("y", 0), btn = a.value("button", 1);
		to_display_xy(disp, a, x, y);
		if (native_ok && native().motion(disp, x, y)) {
			native().button(disp, btn, true);
			native().button(disp, btn, false);
			if (act == "doubleclick") {
				native().button(disp, btn, true);
				native().button(disp, btn, false);
			}
		} else {
#if defined(__APPLE__) || defined(_WIN32)
			method = "none"; // xdotool is X11-only — report the real cause
			ok = false;
			detail = input_hint(disp);
#else
			method = "xdotool";
			std::string rep = act == "doubleclick" ? "click --repeat 2 --delay 60 " : "click ";
			RunResult r = run_capture("xdotool mousemove " + std::to_string(x) + " " + std::to_string(y) +
			                          " " + rep + std::to_string(btn), disp, 5000);
			ok = r.code == 0;
			detail = r.out.substr(0, 120);
#endif
		}
	} else if (act == "type") {
		std::string text = a.value("text", "");
#if defined(__APPLE__)
		int delay = std::clamp(a.value("delayMs", 8), 0, 500);
#else
		int delay = std::clamp(a.value("delayMs", 4), 0, 500);
#endif
		bool typed_native = false;
		if (native_ok && !text.empty()) {
			// UTF-16 path first (unicode on macOS, temp-keysym on X11)
			if constexpr (requires { native().type_text(disp, text, delay); }) {
				typed_native = native().type_text(disp, text, delay);
			} else {
				typed_native = true;
				for (unsigned char ch : text) {
					if (!native().type_char(disp, ch)) { typed_native = false; break; }
					if (delay) std::this_thread::sleep_for(std::chrono::milliseconds(delay));
				}
			}
		}
		if (!typed_native) {
#if defined(__APPLE__) || defined(_WIN32)
			method = "none";
			ok = false;
			detail = input_hint(disp);
#else
			method = "xdotool";
			std::string esc = "'";
			for (char ch : text) { if (ch == '\'') esc += "'\\''"; else esc += ch; }
			esc += "'";
			RunResult r = run_capture("xdotool type --clearmodifiers --delay " + std::to_string(std::max(delay, 8)) +
			                          " -- " + esc, disp, 30000);
			ok = r.code == 0;
			detail = r.out.substr(0, 120);
#endif
		}
	} else if (act == "key") {
		std::string combo = a.value("combo", "Return");
		if (!(native_ok && native().key_combo(disp, combo))) {
#if defined(__APPLE__) || defined(_WIN32)
			method = "none";
			ok = false;
			detail = input_hint(disp);
#else
			method = "xdotool";
			std::string esc = "'";
			for (char ch : combo) { if (ch == '\'') esc += "'\\''"; else esc += ch; }
			esc += "'";
			RunResult r = run_capture("xdotool key --clearmodifiers " + esc, disp, 5000);
			ok = r.code == 0;
			detail = r.out.substr(0, 120);
#endif
		}
	} else if (act == "scroll") {
		int times = std::clamp(a.value("times", 3), 1, 50);
		int btn = a.value("direction", "down") == "up" ? 4 : 5;
		if (a.contains("x") && a.contains("y")) {
			int sx = a.value("x", 0), sy = a.value("y", 0);
			to_display_xy(disp, a, sx, sy);
#if !defined(__APPLE__) && !defined(_WIN32)
			if (!(native_ok && native().motion(disp, sx, sy)))
				run_capture("xdotool mousemove " + std::to_string(sx) + " " + std::to_string(sy), disp, 3000);
#else
			if (native_ok) native().motion(disp, sx, sy);
#endif
		}
		// backends with a real wheel event take one shot: pixel-unit deltas
		// (macOS) or button 4/5 presses (X11), no 8ms-per-tick loop
		if constexpr (requires { native().scroll(disp, 0, 0); }) {
			int dx = std::clamp(a.value("dx", 0), -50, 50);
			int dy = (btn == 4 ? times : -times);
			if (!native().scroll(disp, dx, dy)) {
#if defined(__APPLE__) || defined(_WIN32)
				method = "none";
				ok = false;
				detail = input_hint(disp);
#else
				method = "xdotool";
				std::string esc = std::to_string(btn);
				RunResult r = run_capture("xdotool click --repeat " + std::to_string(times) + " --delay 30 " + esc, disp, 5000);
				ok = r.code == 0;
#endif
			}
		} else if (native_ok && native().has_xtest) {
			for (int i = 0; i < times; i++) {
				native().button(disp, btn, true);
				native().button(disp, btn, false);
				std::this_thread::sleep_for(std::chrono::milliseconds(8));
			}
		} else {
#if defined(__APPLE__) || defined(_WIN32)
			method = "none";
			ok = false;
			detail = input_hint(disp);
#else
			method = "xdotool";
			RunResult r = run_capture("xdotool click --repeat " + std::to_string(times) + " --delay 30 " + std::to_string(btn), disp, 5000);
			ok = r.code == 0;
#endif
		}
	} else if (act == "drag") {
		int fx = a.value("fromX", 0), fy = a.value("fromY", 0);
		int tx = a.value("toX", 0), ty = a.value("toY", 0);
		to_display_xy(disp, a, fx, fy);
		to_display_xy(disp, a, tx, ty);
		int btn = a.value("button", 1);
		int steps = std::clamp(a.value("steps", 12), 1, 200);
		if (native_ok && native().has_xtest) {
			native().motion(disp, fx, fy);
			native().button(disp, btn, true);
			for (int i = 1; i <= steps; i++) {
				native().motion(disp, fx + (tx - fx) * i / steps, fy + (ty - fy) * i / steps);
				std::this_thread::sleep_for(std::chrono::milliseconds(6));
			}
			native().button(disp, btn, false);
		} else {
#if defined(__APPLE__) || defined(_WIN32)
			method = "none";
			ok = false;
			detail = input_hint(disp);
#else
			method = "xdotool";
			RunResult r = run_capture("xdotool mousemove " + std::to_string(fx) + " " + std::to_string(fy) +
			                          " mousedown " + std::to_string(btn) +
			                          " mousemove --sync " + std::to_string(tx) + " " + std::to_string(ty) +
			                          " mouseup " + std::to_string(btn), disp, 10000);
			ok = r.code == 0;
#endif
		}
	} else if (act == "gesture") {
		// touch-style ops: tap | doubleTap | longPress | swipe | drag.
		// Point ops take x,y; move ops take x1,y1 -> x2,y2 with durationMs/steps.
		std::string op = a.value("op", "");
		bool point_op = op == "tap" || op == "doubleTap" || op == "longPress";
		bool move_op = op == "swipe" || op == "drag";
		if (!point_op && !move_op) {
			out = {{"ok", false}, {"action", act}, {"gesture", op},
			       {"error", "unknown gesture op (tap|doubleTap|longPress|swipe|drag)"}};
			return false;
		}
		int duration = std::clamp(a.value("durationMs", op == "longPress" ? 600 : 300), 0, 10000);
		int x = a.value("x", a.value("x1", a.value("fromX", 0)));
		int y = a.value("y", a.value("y1", a.value("fromY", 0)));
		int x2 = a.value("x2", a.value("toX", x));
		int y2 = a.value("y2", a.value("toY", y));
		to_display_xy(disp, a, x, y);
		to_display_xy(disp, a, x2, y2);
		int steps = std::clamp(a.value("steps", std::max(2, duration / 12)), 1, 500);
		if (native_ok && native().has_xtest) {
			native().motion(disp, x, y);
			native().button(disp, 1, true);
			if (move_op) {
				int per = std::max(1, duration / steps);
				for (int i = 1; i <= steps; i++) {
					native().motion(disp, x + (x2 - x) * i / steps, y + (y2 - y) * i / steps);
					std::this_thread::sleep_for(std::chrono::milliseconds(per));
				}
			} else if (op == "longPress") {
				std::this_thread::sleep_for(std::chrono::milliseconds(duration));
			}
			native().button(disp, 1, false);
			if (op == "doubleTap") {
				std::this_thread::sleep_for(std::chrono::milliseconds(40));
				native().button(disp, 1, true);
				native().button(disp, 1, false);
			}
		} else {
#if defined(__APPLE__) || defined(_WIN32)
			// no xdotool here — report the real cause instead of a misleading 127
			ok = false;
			detail = input_hint(disp);
#else
			method = "xdotool";
			std::ostringstream cmd;
			cmd << "xdotool mousemove " << x << " " << y << " ";
			if (move_op) {
				cmd << "mousedown 1 mousemove --sync " << x2 << " " << y2 << " mouseup 1";
			} else if (op == "doubleTap") {
				cmd << "click --repeat 2 --delay 60 1";
			} else if (op == "longPress") {
				cmd << "mousedown 1 sleep " << (duration / 1000.0) << " mouseup 1";
			} else {
				cmd << "click 1";
			}
			RunResult r = run_capture(cmd.str(), disp, 10000 + duration);
			ok = r.code == 0;
			detail = r.out.substr(0, 120);
#endif
		}
	} else if (act == "wait") {
		std::this_thread::sleep_for(std::chrono::milliseconds(std::clamp(a.value("ms", 100), 0, 60000)));
		method = "sleep";
	} else if (act == "launch") {
		std::string app = a.value("app", "");
		if (app.empty()) { out = {{"ok", false}, {"action", act}, {"error", "app required"}}; return false; }
		{
			// resolve the binary first — a spawn that immediately exec-fails
			// looks identical to a real launch (ok+pid) without this.
			std::string bin = app.substr(0, app.find_first_of(" \t"));
			bool found = false;
#if defined(_WIN32)
			if (bin.find_first_of("/\\") != std::string::npos) {
				found = file_x_ok(bin.c_str());
			} else {
				// same resolution cmd.exe will do at spawn (PATH + PATHEXT)
				char buf[MAX_PATH];
				for (const char* ext : {"", ".exe", ".cmd", ".bat"}) {
					if (SearchPathA(nullptr, bin.c_str(), ext, MAX_PATH, buf, nullptr)) { found = true; break; }
				}
			}
#else
			if (bin.find('/') != std::string::npos) {
				found = ::access(bin.c_str(), X_OK) == 0;
			} else {
				const char* path = getenv("PATH");
				std::string paths = path ? path : "/usr/bin:/bin:/usr/local/bin";
				size_t pos = 0;
				while (pos <= paths.size() && !found) {
					size_t colon = paths.find(':', pos);
					std::string dir = paths.substr(pos, colon == std::string::npos ? std::string::npos : colon - pos);
					if (!dir.empty() && ::access((dir + "/" + bin).c_str(), X_OK) == 0) found = true;
					if (colon == std::string::npos) break;
					pos = colon + 1;
				}
			}
#endif
#if defined(__APPLE__)
			if (!found && bin.find('/') == std::string::npos) {
				// macOS app names aren't PATH binaries — resolve via the .app
				// bundle and launch through `open -a` (LaunchServices), which is
				// what "open TextEdit" means to a user. Exact bundle name first,
				// then case-insensitive substring ("Chrome" → "Google Chrome.app"),
				// shortest match wins.
				std::string want = bin;
				for (auto& c : want) c = (char)tolower((unsigned char)c);
				std::string best;
				for (const char* dir : {"/Applications", "/System/Applications",
				                        "/System/Applications/Utilities", "/Applications/Utilities"}) {
					if (::access((std::string(dir) + "/" + bin + ".app").c_str(), F_OK) == 0) {
						best = bin;
						break;
					}
					DIR* d = ::opendir(dir);
					if (!d) continue;
					while (dirent* de = ::readdir(d)) {
						std::string n = de->d_name;
						if (n.size() < 5 || n.compare(n.size() - 4, 4, ".app") != 0) continue;
						std::string base = n.substr(0, n.size() - 4), low = base;
						for (auto& c : low) c = (char)tolower((unsigned char)c);
						if (low == want) { best = base; break; }
						if (low.find(want) != std::string::npos &&
						    (best.empty() || base.size() < best.size()))
							best = base;
					}
					::closedir(d);
					if (!best.empty() && best.size() == want.size()) break;
				}
				if (!best.empty()) {
					found = true;
					wanted_app = best;
					std::string e = "'";
					for (char ch : best) { if (ch == '\'') e += "'\\''"; else e += ch; }
					e += "'";
					app = "open -a " + e;
					bin = "open";
				}
			}
#endif
			if (!found) { out = {{"ok", false}, {"action", act}, {"error", "no such binary: " + bin}}; return false; }
#if defined(__linux__) || defined(_WIN32)
			// PATH launches get the same focus-wait + frontmost report as macOS
			// .app launches — typing into a still-unmapped window drops keys.
			if (wanted_app.empty()) {
				size_t slash = bin.find_last_of("/\\"); // backslash for win paths
				wanted_app = slash == std::string::npos ? bin : bin.substr(slash + 1);
			}
#endif
		}
		std::string cmdline = app;
		if (a.contains("args") && a["args"].is_array()) {
			for (auto& ar : a["args"]) {
				std::string s = ar.get<std::string>();
#if defined(_WIN32)
				cmdline += " " + win_arg(s);
#else
				std::string e = "'";
				for (char ch : s) { if (ch == '\'') e += "'\\''"; else e += ch; }
				e += "'";
				cmdline += " " + e;
#endif
			}
		}
		pid_t pid = spawn_detached(cmdline, disp);
		method = "spawn";
		detail = std::to_string(proc_display_id(pid));
		if (!wanted_app.empty()) {
			// launching returns before the app's window maps + takes focus —
			// keystrokes typed right after land in whatever was focused.
			// Wait (bounded) for the target to actually become frontmost.
			std::string want = wanted_app;
			for (auto& c : want) c = (char)tolower((unsigned char)c);
#if defined(__linux__)
			// X11 windows map+focus fast when they're coming at all — and a CLI
			// launch (sleep, a build tool) never produces one, so bound tighter
			// than the LaunchServices-era 5s and bail the moment the child exits.
			long long deadline = now_ms() + 1500;
#elif defined(_WIN32)
			long long deadline = now_ms() + 3000;
#else
			long long deadline = now_ms() + 5000;
#endif
#if defined(__APPLE__)
			bool reactivated = false;
#endif
			while (now_ms() < deadline) {
				std::string fm = native().frontmost_app();
				for (auto& c : fm) c = (char)tolower((unsigned char)c);
				bool fm_match = !fm.empty() &&
				    (fm.find(want) != std::string::npos || want.find(fm) != std::string::npos);
				bool done = fm_match;
#if defined(__linux__)
				// A same-named window left by an older launch satisfies the
				// comm-name check instantly while the new app never takes
				// focus — typed bursts then land in the WRONG window. When
				// _NET_WM_PID is available, require the focused window's
				// owner to be this launch's own process tree.
				if constexpr (requires { native().frontmost_pid(); }) {
					long fpid = native().frontmost_pid();
					if (fpid > 0)
						done = pid_in_tree(fpid, (long)pid);
					else if (!fm_match)
						done = false;
				}
#endif
				if (done) break;
#if !defined(__APPLE__)
				int st;
				if (waitpid(pid, &st, WNOHANG) == pid) break; // CLI launch — no window coming
#endif
#if defined(__APPLE__)
				// `open -a` is idempotent — re-running it only re-activates the
				// app. (On X11 a re-spawn would open a second window — instead
				// the caller sees the honest `frontmost` in the reply.)
				if (!reactivated && now_ms() > t0 + 2000) {
					reactivated = true;
					spawn_detached(cmdline, disp);
				}
#endif
				std::this_thread::sleep_for(std::chrono::milliseconds(50));
			}
		}
		if (Session* ws = find_session(a.value("sessionId", "")))
			session_track_launch(ws, disp, (long)pid);
	} else {
		out = {{"ok", false}, {"action", act}, {"error", "unknown action"}};
		return false;
	}

	if (!ok && detail.empty()) detail = input_hint(disp);
	out = {{"ok", ok}, {"action", act}, {"method", method}, {"tookMs", now_ms() - t0}};
	if (act == "gesture") out["gesture"] = a.value("op", "");
	if (act == "launch" && !wanted_app.empty())
		out["frontmost"] = native().frontmost_app();
	if (!detail.empty()) {
		if (act == "launch") out["pid"] = std::stoll(detail);
		else out["detail"] = detail;
	}
	if ((act == "click" || act == "doubleclick" || act == "drag" || act == "gesture") && native_ok) {
		int px = -1, py = -1; unsigned long child = 0;
		if (native().query_pointer(disp, px, py, child))
			out["cursorAfter"] = {{"x", px}, {"y", py}};
	}
	return ok;
}

// ---------------------------------------------------------------------------
// rig.exec — native shell execution. No agent, no model, no omp in the path.
// ---------------------------------------------------------------------------

struct Exec {
	uint64_t id;
	pid_t pid;
	std::atomic<bool> done{false};
	std::chrono::steady_clock::time_point started;
};

static std::mutex g_execs_mutex;
static std::unordered_map<uint64_t, Exec*> g_execs;
static std::atomic<uint64_t> g_exec_counter{0};
static constexpr size_t MAX_CONCURRENT_EXECS = 16;
static std::atomic<uint64_t> g_exec_total{0}, g_exec_ms_total{0}, g_exec_ms_min{UINT64_MAX}, g_exec_ms_max{0};

// UTF-8 tools for exec chunking. ws TEXT frames must be valid UTF-8 — a
// child writing binary/latin-1 bytes, or a multi-byte seq split across
// read()s, aborts strict clients. utf8_tail_hold: how many trailing bytes
// are an incomplete seq to carry into the next chunk. utf8_clean: true if
// the range is already valid (out untouched); else out gets it with each
// invalid byte replaced by U+FFFD.
static size_t utf8_tail_hold(const char* p, size_t n) {
	for (size_t back = 1; back <= n && back <= 4; back++) {
		uint8_t b = uint8_t(p[n - back]);
		if ((b & 0x80) == 0) return 0;
		if ((b & 0xC0) == 0x80) continue;
		size_t need = (b & 0xE0) == 0xC0 ? 2 : (b & 0xF0) == 0xE0 ? 3 : (b & 0xF8) == 0xF0 ? 4 : 0;
		return (need > back) ? back : 0;
	}
	return 0;
}
static bool utf8_clean(const char* p, size_t n, std::string& out) {
	out.clear();
	bool dirty = false;
	size_t i = 0;
	while (i < n) {
		uint8_t b = uint8_t(p[i]);
		size_t len = 0;
		if (b < 0x80) len = 1;
		else if (b >= 0xC2 && b <= 0xDF) len = 2;
		else if (b >= 0xE0 && b <= 0xEF) len = 3;
		else if (b >= 0xF0 && b <= 0xF4) len = 4;
		bool ok = len > 0 && i + len <= n;
		if (ok && len >= 2) {
			uint8_t c1 = uint8_t(p[i + 1]);
			ok = c1 >= 0x80 && c1 <= 0xBF;
			if (b == 0xE0) ok = c1 >= 0xA0 && c1 <= 0xBF;      // no overlong
			else if (b == 0xED) ok = c1 >= 0x80 && c1 <= 0x9F; // no surrogates
			else if (b == 0xF0) ok = c1 >= 0x90 && c1 <= 0xBF; // > U+FFFF
			else if (b == 0xF4) ok = c1 >= 0x80 && c1 <= 0x8F; // <= U+10FFFF
		}
		if (ok) for (size_t k = 2; k < len; k++) {
			uint8_t c = uint8_t(p[i + k]);
			if (c < 0x80 || c > 0xBF) { ok = false; break; }
		}
		if (ok) {
			if (dirty) out.append(p + i, len);
			i += len;
		} else {
			if (!dirty) { dirty = true; out.assign(p, i); }
			out += "\xef\xbf\xbd"; // U+FFFD
			i++;
		}
	}
	return !dirty;
}

static void exec_thread(Client* c, uint64_t exec_id, std::string command, std::string cwd, int timeout_ms) {
	auto t0 = std::chrono::steady_clock::now();
	int out_fd = -1;
	pid_t pid = -1;
#if defined(_WIN32)
	int in_fd = -1;
	pid = win_spawn("cmd.exe /d /s /c \"" + command + "\"",
	                WinSpawnOpts{.want_stdin = false, .want_stdout = true, .merge_stderr = true,
	                             .cwd = cwd, .env = {}},
	                in_fd, out_fd);
	if (pid <= 0) {
		send_json(c, {{"type", "exec.done"}, {"execId", exec_id}, {"code", -1}, {"error", "spawn failed"}});
		return;
	}
#else
	int fds[2];
	if (pipe(fds) != 0) {
		send_json(c, {{"type", "exec.done"}, {"execId", exec_id}, {"code", -1}, {"error", "pipe failed"}});
		return;
	}
	pid = fork();
	if (pid == 0) {
		::close(fds[0]);
		dup2(fds[1], STDOUT_FILENO);
		dup2(fds[1], STDERR_FILENO);
		::close(fds[1]);
		setpgid(0, 0); // group leader — execKill/timeout kills the whole tree
		if (!cwd.empty() && chdir(cwd.c_str()) != 0) { /* fall back to inherited cwd */ }
#if defined(__linux__)
		// execs run on the rig workspace, not the daemon's own display —
		// `open <url>` must pop where the phone is watching.
		if (!g_computer.display.empty()) {
			setenv("DISPLAY", g_computer.display.c_str(), 1);
			unsetenv("WAYLAND_DISPLAY");
		}
#endif
		setenv("TERM", "dumb", 1);
		execl("/bin/bash", "/bin/bash", "-c", command.c_str(), nullptr);
		_exit(127);
	}
	// parent-side setpgid (same group the child picks itself): removes the
	// fork→setpgid race where a fast timeout's kill(-pid) hit ESRCH and left
	// orphaned grandchildren running
	setpgid(pid, pid);
	::close(fds[1]);
	out_fd = fds[0];
#endif
	{
		auto* e = new Exec{exec_id, pid, false, t0};
		std::lock_guard<std::mutex> lock(g_execs_mutex);
		g_execs[exec_id] = e;
	}

	bool timed_out = false;
	auto deadline = t0 + std::chrono::milliseconds(timeout_ms);
	char buf[65536];
	bool open = true;
	std::string carry; // a UTF-8 seq split across reads — head held for the next chunk
	auto emit_chunk = [c, exec_id](std::string& chunk) {
		json out = {{"type", "exec.output"}, {"execId", exec_id}};
		std::string clean;
		if (utf8_clean(chunk.data(), chunk.size(), clean)) out["chunk"] = chunk;
		else {
			out["chunk"] = clean; // U+FFFD-sanitized preview
			out["chunkB64"] = rig::base64_encode(rig::Bytes(chunk.begin(), chunk.end()));
		}
		send_json(c, out);
	};
	while (open) {
		// requester gone — don't run a command nobody will read (also keeps
		// exec_thread inside the ~60s client-retire graveyard window)
		if (!client_alive(c)) { kill(-pid, SIGKILL); kill(pid, SIGKILL); break; }
		int remain = int(std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count());
		if (remain <= 0) { timed_out = true; kill(-pid, SIGKILL); kill(pid, SIGKILL); break; }
		int pr = pipe_wait(out_fd, std::min(remain, 250)); // sliced so !alive is noticed fast
		if (pr < 0) break;
		if (pr == 0) continue;
		ssize_t n = file_read(out_fd, buf, sizeof(buf));
		if (n <= 0) { open = false; break; }
		carry.append(buf, size_t(n));
		size_t hold = utf8_tail_hold(carry.data(), carry.size());
		std::string chunk = carry.substr(0, carry.size() - hold);
		carry.erase(0, chunk.size());
		if (!chunk.empty()) emit_chunk(chunk);
	}
	if (!carry.empty()) emit_chunk(carry); // seq that never completed — emit as broken bytes
	file_close(out_fd);
	int status = 0;
	waitpid(pid, &status, 0);
	int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
	int64_t dur = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
	{
		std::lock_guard<std::mutex> lock(g_execs_mutex);
		auto it = g_execs.find(exec_id);
		if (it != g_execs.end()) { it->second->done = true; delete it->second; g_execs.erase(it); }
	}
	g_exec_total++;
	g_exec_ms_total += uint64_t(dur);
	g_exec_ms_min = std::min(g_exec_ms_min.load(), uint64_t(dur));
	g_exec_ms_max = std::max(g_exec_ms_max.load(), uint64_t(dur));
	json done = {{"type", "exec.done"}, {"execId", exec_id}, {"code", code},
	             {"durationMs", dur}, {"timedOut", timed_out}};
	send_json(c, done);
	log("exec #" + std::to_string(exec_id) + " done code=" + std::to_string(code) + " " + std::to_string(dur) + "ms: " + command.substr(0, 80));
}

// ---------------------------------------------------------------------------
// rig.term.* — interactive pty sessions: the phone's direct shell on the rig.
// term.open spawns a login shell on a pty; term.in feeds raw bytes; term.out
// streams output (same utf8-clean + B64-raw framing as exec.output);
// term.resize applies TIOCSWINSZ; term.close SIGHUPs the process group.
// POSIX-only for now — Windows ConPTY lands separately.
// ---------------------------------------------------------------------------

#if !defined(_WIN32)
#include <sys/ioctl.h>
#if defined(__APPLE__)
#include <util.h>
#else
#include <pty.h>
#endif
#endif

static inline bool client_alive(Client* c);

struct Term {
	uint64_t id;
	pid_t pid{-1};
	int fd{-1};
	Client* owner{nullptr};
	std::atomic<bool> dead{false};
};
static std::mutex g_terms_mutex;
static std::unordered_map<uint64_t, Term*> g_terms;
static std::atomic<uint64_t> g_term_counter{0};
static constexpr size_t MAX_TERMS = 8;

static void term_kill(Term* t) {
	if (t->dead.exchange(true)) return;
#if !defined(_WIN32)
	if (t->pid > 0) { kill(-t->pid, SIGHUP); kill(t->pid, SIGHUP); }
	if (t->fd >= 0) ::close(t->fd);
#endif
}

// client teardown sweeps the owner's ptys — a dead phone must not leave
// shells running. The reader thread still owns waitpid + map erasure.
static void terms_close_for(Client* c) {
	std::lock_guard<std::mutex> lock(g_terms_mutex);
	for (auto& kv : g_terms)
		if (kv.second->owner == c) term_kill(kv.second);
}

#if !defined(_WIN32)
static void term_reader(Client* c, uint64_t term_id) {
	Term* t = nullptr;
	{
		std::lock_guard<std::mutex> lock(g_terms_mutex);
		auto it = g_terms.find(term_id);
		if (it == g_terms.end()) return;
		t = it->second;
	}
	char buf[32768];
	std::string carry;
	uint64_t seq = 0;
	auto emit = [&](std::string& chunk) {
		json out = {{"type", "term.out"}, {"termId", term_id}, {"seq", ++seq}};
		std::string clean;
		if (utf8_clean(chunk.data(), chunk.size(), clean)) out["data"] = chunk;
		else {
			out["data"] = clean;
			out["dataB64"] = rig::base64_encode(rig::Bytes(chunk.begin(), chunk.end()));
		}
		send_json(c, out);
	};
	while (true) {
		if (t->dead.load()) break;
		if (!client_alive(c)) { term_kill(t); break; }
		int pr = pipe_wait(t->fd, 200);
		if (pr < 0) break;
		if (pr == 0) continue;
		ssize_t n = file_read(t->fd, buf, sizeof(buf));
		if (n <= 0) break; // EIO = slave side gone
		carry.append(buf, size_t(n));
		size_t hold = utf8_tail_hold(carry.data(), carry.size());
		std::string chunk = carry.substr(0, carry.size() - hold);
		carry.erase(0, chunk.size());
		if (!chunk.empty()) emit(chunk);
	}
	if (!carry.empty()) emit(carry);
	if (t->fd >= 0) file_close(t->fd);
	int status = 0;
	if (t->pid > 0) waitpid(t->pid, &status, 0);
	int code = WIFEXITED(status) ? WEXITSTATUS(status) : (WIFSIGNALED(status) ? 128 + WTERMSIG(status) : -1);
	send_json(c, {{"type", "term.exit"}, {"termId", term_id}, {"code", code}});
	{
		std::lock_guard<std::mutex> lock(g_terms_mutex);
		auto it = g_terms.find(term_id);
		if (it != g_terms.end()) { delete it->second; g_terms.erase(it); }
	}
}
#endif

// ---------------------------------------------------------------------------
// Forward declarations
// ---------------------------------------------------------------------------

struct Client;
struct Session;
static void enqueue_out(Client* c, const std::string& text);
static void send_json(Client* c, const nlohmann::json& j);
static Session* find_session(const std::string& id);

// ---------------------------------------------------------------------------
// Clients: reader thread + writer thread with writev batching
// ---------------------------------------------------------------------------

struct Client {
	sockfd_t fd;
	std::string name;
	bool authed = false;
	// authenticated by the per-boot service token — an omp child's tool bridge.
	// Service clients get request/reply only: session broadcast frames would
	// poison reply correlation and are off-limits to them anyway.
	bool service = false;
	uint32_t scopes = SCOPE_ALL; // device's capability mask (see scope bits)
	std::atomic<bool> alive{true};

	// outbound queue — writer thread drains it in batched writev()s.
	// payload is shared: broadcast frames pay one refcount bump per client,
	// not a full string copy
	std::mutex out_mutex;
	std::condition_variable out_cv;
	std::deque<std::pair<int64_t, std::shared_ptr<const std::string>>> outbox;
	// atomic: watch threads sample the backlog to scale frame cost down
	// under RTT pressure; writer/enqueue still update it under out_mutex
	std::atomic<size_t> out_bytes{0};
	// first ms the soft outbox cap was exceeded — overload grace clock
	// (reset by the next under-cap enqueue; a stale value only matters if
	// the queue is still over cap, where it correctly reads as "still
	// overloaded since then")
	std::atomic<int64_t> overload_since{0};

	// pairing rate limit per connection
	TokenBucket pair_bucket;

	// exactly-once bookkeeping, per session id: [live_lo,live_hi] = the
	// contiguous range of seqs this client was already handed by the live
	// fanout; replayed_hi = highest seq a session.subscribe replay delivered.
	// Touched only while holding that session's ring_mutex + this seq_mutex.
	std::mutex seq_mutex;
	std::unordered_map<std::string, uint64_t> live_lo, live_hi, replayed_hi;

	int64_t last_activity_ms = now_ms();
	std::thread* writer_th = nullptr; // joined by serve_client before destruction
};

static inline bool client_alive(Client* c) { return c->alive.load(); }

static constexpr size_t OUT_QUEUE_MAX_MSGS = 512;
static constexpr size_t OUT_QUEUE_MAX_BYTES = 8 * 1024 * 1024;
// Over the soft cap a slow client used to be dropped instantly — on a bad
// link the reconnect then replayed the same backlog into the same narrow
// pipe and the kill loop never converged. Now the cap starts a bounded
// grace window instead; only sustained overload (grace expired) or the
// hard ceiling below actually drops the connection.
static constexpr size_t OUT_QUEUE_HARD_MSGS = 2048;
static constexpr size_t OUT_QUEUE_HARD_BYTES = 32 * 1024 * 1024;
static constexpr int64_t OUT_OVERLOAD_GRACE_MS = 10000;
// Replay/History throttles pause at the soft cap and only resume once the
// queue drains to this low-water mark — hovering at the cap would leave
// zero headroom for live frames and burn the grace window.
static constexpr size_t OUT_QUEUE_LOW_MSGS = 128;
static constexpr size_t OUT_QUEUE_LOW_BYTES = 1 * 1024 * 1024;
static constexpr int64_t WRITER_PING_AFTER_MS = 20000;   // send WS ping when idle

static std::set<Client*> g_clients;
static std::mutex g_clients_mutex;

// computer.watch subscribers — client pointer nulled on disconnect, never
// dereferenced outside g_watchers_mutex
struct Watcher {
	std::string id;
	Client* client = nullptr;
	std::string disp;
	std::atomic<bool> stop{false};
	std::thread th;
};
static std::vector<Watcher*> g_watchers;
static std::mutex g_watchers_mutex;
static uint64_t g_watch_counter = 0;

// computer.record — one live capture-to-disk at a time. Frames land under
// <rig>/recordings/<id>/ as f-000001.jpg … + times.txt + meta.json, so a
// recording survives daemon restarts and playback is a file read away.
struct Recorder {
	std::string id;
	Client* client = nullptr;    // finished-event target; nulled on disconnect
	std::string disp;
	std::atomic<bool> stop{false};
	std::atomic<bool> done{false};
	std::string reason;          // stop | maxDuration | shutdown
	int64_t started_wall = 0;
	int64_t started_ms = 0;
	std::atomic<int64_t> stopped_wall{0};
	int max_ms = 600000;
	int interval_ms = 250;
	std::atomic<int> frames{0};
	std::atomic<int> dropped{0};
	std::atomic<int64_t> bytes{0};
	int width = 0, height = 0;
	double scale = 0.5;
	int quality = 70;
	std::thread th;
};
static Recorder* g_rec = nullptr;
static std::mutex g_rec_mutex;

static bool rec_id_ok(const std::string& id) {
	if (id.size() < 5 || id.size() > 64 || id.rfind("rec-", 0) != 0) return false;
	for (char ch : id)
		if (!(isalnum((unsigned char)ch) || ch == '-')) return false;
	return true;
}

static json rec_meta(const Recorder* r, bool live) {
	int64_t end_wall = r->stopped_wall.load();
	int64_t dur = std::max<int64_t>(0, (end_wall ? end_wall : wall_ms()) - r->started_wall);
	json m = {{"id", r->id}, {"startedAt", r->started_wall}, {"durationMs", dur},
	          {"frames", r->frames.load()}, {"dropped", r->dropped.load()},
	          {"bytes", r->bytes.load()}, {"width", r->width}, {"height", r->height},
	          {"scale", r->scale}, {"intervalMs", r->interval_ms},
	          {"format", "jpg"}, {"live", live}};
	m["fps"] = dur > 0 ? double(r->frames.load()) * 1000.0 / dur : 0.0;
	return m;
}

// tolerant field reads — a hand-edited or torn meta.json must never throw
// (record.* work happens on detached threads where a throw is terminate())
static int64_t j_i64(const json& j, const char* k, int64_t def = 0) {
	auto it = j.find(k);
	if (it == j.end()) return def;
	if (it->is_number()) return it->get<int64_t>();
	if (it->is_string()) { try { return std::stoll(it->get<std::string>()); } catch (...) {} }
	return def;
}
static double j_f64(const json& j, const char* k, double def = 0.0) {
	auto it = j.find(k);
	if (it == j.end()) return def;
	if (it->is_number()) return it->get<double>();
	if (it->is_string()) { try { return std::stod(it->get<std::string>()); } catch (...) {} }
	return def;
}
static bool j_bool(const json& j, const char* k, bool def = false) {
	auto it = j.find(k);
	if (it == j.end()) return def;
	if (it->is_boolean()) return it->get<bool>();
	return def;
}
static std::string j_str(const json& j, const char* k) {
	auto it = j.find(k);
	return it != j.end() && it->is_string() ? it->get<std::string>() : "";
}

// meta.json on disk describes settings/timing; the frame files themselves
// describe counts — a daemon killed mid-record leaves a stale "live" meta,
// so frames/bytes/duration are always recounted from what actually landed.
static json rec_disk_meta(const fs::path& dir) {
	json m = json::object();
	try {
		std::ifstream f(dir / "meta.json");
		m = json::parse(f);
	} catch (...) {}
	if (!m.is_object()) m = json::object();
	int files = 0;
	int64_t bytes = 0;
	std::error_code ec;
	for (auto& e : fs::directory_iterator(dir, ec)) {
		std::string name = e.path().filename().string();
		if (name.rfind("f-", 0) == 0 && e.path().extension() == ".jpg") {
			files++;
			bytes += int64_t(e.file_size(ec));
		}
	}
	m["frames"] = files;
	m["bytes"] = bytes;
	m["id"] = dir.filename().string();
	if (!m.contains("durationMs") || j_bool(m, "live")) {
		// never finalized: duration = capture offset of the last written frame
		int64_t last_t = 0;
		std::ifstream tf(dir / "times.txt");
		std::string line, last;
		while (std::getline(tf, last))
			if (!last.empty()) line = last;
		if (!line.empty()) {
			size_t tab = line.find('\t');
			last_t = std::atoll(tab == std::string::npos ? line.c_str() : line.c_str() + tab + 1);
		}
		m["durationMs"] = last_t;
	}
	int64_t dur = j_i64(m, "durationMs");
	m["fps"] = dur > 0 ? files * 1000.0 / double(dur) : 0.0;
	m["live"] = false;
	m["mp4"] = fs::exists(dir / "video.mp4", ec);
	return m;
}

static std::string ws_wrap(const std::string& text) {
	std::string frame;
	size_t len = text.size();
	frame.push_back(char(0x81 - 0x100)); // -127: same byte, fits signed char (C4310)
	if (len <= 125) frame.push_back(char(len));
	else if (len <= 0xFFFF) {
		frame.push_back(char(126));
		frame.push_back(char(len >> 8)); frame.push_back(char(len & 0xFF));
	} else {
		frame.push_back(char(127));
		for (int i = 7; i >= 0; i--) frame.push_back(char((uint64_t)len >> (8 * i)) & 0xFF);
	}
	frame += text;
	return frame;
}

static bool raw_send_all(Client* c, const char* data, size_t n) {
	size_t off = 0;
	while (off < n) {
		ssize_t w = net_send(c->fd, data + off, n - off, MSG_NOSIGNAL);
		if (w <= 0) { c->alive = false; return false; }
		off += size_t(w);
	}
	return true;
}

static void enqueue_out(Client* c, std::shared_ptr<const std::string> text) {
	if (!c->alive) return; // dead client: nothing drains the outbox — don't pile up
	{
		std::lock_guard<std::mutex> lock(c->out_mutex);
		if (c->outbox.size() >= OUT_QUEUE_MAX_MSGS || c->out_bytes + text->size() > OUT_QUEUE_MAX_BYTES) {
			// over the soft cap — grace window: keep accepting while the
			// writer drains; drop only on sustained overload or the hard
			// ceiling. The old instant-kill made reconnect loops on slow
			// links unrecoverable (replay refilled the queue → killed again).
			int64_t now = now_ms();
			int64_t since = c->overload_since.load();
			if (since == 0) { c->overload_since.store(now); since = now; }
			if (c->outbox.size() >= OUT_QUEUE_HARD_MSGS ||
			    c->out_bytes + text->size() > OUT_QUEUE_HARD_BYTES ||
			    now - since > OUT_OVERLOAD_GRACE_MS) {
				log("client " + c->name + " too slow (outbox full) — dropping");
				c->alive = false;
			} else {
				c->out_bytes += text->size();
				c->outbox.emplace_back(now, std::move(text));
			}
		} else {
			c->overload_since.store(0);
			c->out_bytes += text->size();
			c->outbox.emplace_back(now_ms(), std::move(text));
		}
	}
	c->out_cv.notify_one();
	g_frames_out++;
}

static inline void enqueue_out(Client* c, const std::string& text) {
	enqueue_out(c, std::make_shared<const std::string>(text));
}
static inline void enqueue_out(Client* c, std::string&& text) {
	enqueue_out(c, std::make_shared<const std::string>(std::move(text)));
}

static void broadcast(std::shared_ptr<const std::string> text) {
	std::vector<Client*> targets;
	{
		std::lock_guard<std::mutex> lock(g_clients_mutex);
		for (Client* c : g_clients)
			if (c->authed && c->alive && !c->service) targets.push_back(c);
	}
	for (Client* c : targets) enqueue_out(c, text);
}

static void broadcast(const std::string& text) { broadcast(std::make_shared<const std::string>(text)); }

static void writer_thread(Client* c) {
	std::vector<std::shared_ptr<const std::string>> frames;
	while (c->alive && !g_stop) {
		frames.clear();
		{
			std::unique_lock<std::mutex> lock(c->out_mutex);
			c->out_cv.wait_for(lock, std::chrono::milliseconds(500), [&] {
				return !c->outbox.empty() || !c->alive || g_stop;
			});
			if (!c->alive || g_stop) break;
			int64_t waited_from = c->outbox.empty() ? 0 : c->outbox.front().first;
			while (!c->outbox.empty() && frames.size() < 64) {
				auto [enq, text] = c->outbox.front();
				c->outbox.pop_front();
				c->out_bytes -= text->size();
				frames.push_back(std::move(text));
				if (waited_from) g_lat_emit.add(now_ms() - enq);
			}
		}
		// raw control frames (pongs) bypass WS wrapping
		for (auto it = frames.begin(); it != frames.end();) {
			if ((*it)->rfind("__RAW__", 0) == 0) {
				std::string raw = (*it)->substr(7);
				raw_send_all(c, raw.data(), raw.size());
				it = frames.erase(it);
			} else {
				++it;
			}
		}
		if (frames.empty()) {
			// idle keep-alive ping (browsers/clients auto-pong, keeping NAT paths warm)
			if (now_ms() - c->last_activity_ms > WRITER_PING_AFTER_MS) {
				const char ping[2] = {char(0x89 - 0x100), 0};
				if (!raw_send_all(c, ping, 2)) break;
				c->last_activity_ms = now_ms(); // ping cycle restarts the idle clock
			}
			continue;
		}
		// one WS frame per message, gathered into a single write burst
		std::string batch;
		size_t est = 0;
		for (auto& f : frames) est += f->size() + 10;
		batch.reserve(est);
		for (auto& f : frames) batch += ws_wrap(*f);
		if (!raw_send_all(c, batch.data(), batch.size())) break;
	}
}

// Pace one burst producer (session.subscribe replay, session.history page)
// against this client's outbox. enqueue_out's grace window absorbs brief
// floods, but an unthrottled burst would burn the whole grace clock and
// starve live frames racing the same queue. Returns false when the client
// died or could not drain to the low-water mark within 4s — the caller
// should stop the burst and report truncation so the client can resume.
// Hysteresis: once over the soft cap we wait for a drain to low-water, not
// just one slot under, so the queue stops hovering at the kill-adjacent
// level where any live frame burns the overload clock.
static bool outbox_burst_pause(Client* c) {
	bool full;
	{
		std::lock_guard<std::mutex> om(c->out_mutex);
		full = c->outbox.size() >= OUT_QUEUE_MAX_MSGS ||
		       c->out_bytes > OUT_QUEUE_MAX_BYTES / 2;
	}
	if (!full) return c->alive.load();
	int64_t t0 = now_ms();
	while (c->alive.load() && now_ms() - t0 <= 4000) {
		{
			std::lock_guard<std::mutex> om(c->out_mutex);
			if (c->outbox.size() <= OUT_QUEUE_LOW_MSGS &&
			    c->out_bytes <= OUT_QUEUE_LOW_BYTES) return true;
		}
		std::this_thread::sleep_for(std::chrono::milliseconds(5));
	}
	return false;
}

// ---------------------------------------------------------------------------
// Sessions: omp children + event ring buffers + correlated requests
// ---------------------------------------------------------------------------

struct PendingRequest; // forward

struct Fanout {
	Client* client;
	std::string reply_type;
	std::string req_id;      // caller's request id, echoed on the collected reply
	size_t remaining;
	int64_t deadline_ms;
	json collected = json::array();
	bool partial_note = false;
};

struct Session {
	std::string id;
	std::string cwd;
	std::string branch; // probed once at spawn/restore — '' when cwd isn't a git repo
	std::string parent_id; // session.spawn lineage — '' for top-level sessions
	pid_t pid{-1};
	int stdin_fd{-1};
	int stdout_fd{-1};
	std::mutex write_mutex;
	std::atomic<bool> running{false};

	// per-session virtual desktop: the agent's own workspace so parallel
	// coworkers never see each other's windows. x11: workspace index.
	// macOS: fullscreened app name (a fullscreen window IS a Space).
	int desktop{-1};
	int prev_desktop{-1};           // where the user was before space enter
	std::string desktop_disp;       // display the desktop was claimed on
	std::string fs_app;
	std::string prev_app;

	// monotonic event log with bounded replay window
	std::atomic<uint64_t> seq{0};
	std::mutex ring_mutex;
	// shared payload: a subscribe snapshot copies pointers, not megabytes
	// of frame text under the lock
	std::deque<std::pair<uint64_t, std::shared_ptr<const std::string>>> ring;
	size_t ring_bytes = 0;
	static constexpr size_t RING_MAX_BYTES = 8 * 1024 * 1024;
	static constexpr size_t RING_MAX_ENTRIES = 4096;

	// daemon-correlated in-flight requests
	std::mutex pending_mutex;
	std::unordered_map<std::string, PendingRequest*> pending;
	std::atomic<uint64_t> req_counter{0};

	// session.new is only acknowledged once omp's RPC handshake succeeds
	Client* starter = nullptr;
	std::atomic<bool> started_acked{false};

	// token ledger (updated whenever a get_state response passes through)
	std::atomic<int64_t> usage_last{-1};
	std::atomic<int64_t> usage_max{-1};
	std::atomic<int64_t> usage_window{-1};
	// auto-compact trigger bookkeeping
	std::atomic<int64_t> last_auto_check_ms{0};
	std::atomic<int64_t> compact_sent_ms{0};
	// v0.6 cache accounting: provider usage fields harvested off every frame
	// (anthropic cache_read_input_tokens/cache_creation_input_tokens, openai
	// prompt_tokens_details.cached_tokens, deepseek prompt_cache_hit_tokens)
	std::atomic<int64_t> tok_in{0};
	std::atomic<int64_t> tok_out{0};
	std::atomic<int64_t> tok_cache_read{0};
	std::atomic<int64_t> tok_cache_write{0};

	// wall-clock epochs for sessions.list (app inbox timestamps)
	int64_t created_ms = wall_ms();
	std::atomic<int64_t> last_active_ms{0};
	std::atomic<bool> busy{false}; // true while a turn is in flight
	std::atomic<bool> stall_flagged{false}; // set once per silent-busy span; cleared by the next emitted frame
	std::string preview; // last assistant text — under ring_mutex
	std::string title;   // first prompt text — under ring_mutex, persisted in meta
	// inbox bookkeeping, persisted in meta: pin/hide survive restarts and
	// last_read_seq powers the app's unread badges
	std::atomic<bool> pinned{false};
	std::atomic<bool> hidden{false};
	std::atomic<int64_t> last_read_seq{0};

	// which agent runtime the child speaks. "omp" = the fork's rpc protocol
	// (handshake + frames); anything else goes through the harness
	// translator in child_reader and never sees omp-specific frames.
	std::string harness{"omp"};
	std::string conv_id; // claude conversation id — persisted for --resume

	// restart persistence: every emitted frame also appends to
	// ~/.rig/sessions/<id>.jsonl so a daemon restart restores the inbox and
	// its replay history. The omp child itself can't be reclaimed (its pipes
	// die with us) — restored sessions respawn it lazily on the next prompt.
	FILE* persist_fp = nullptr;
	json spawn_opts;                // the session.new opts, kept for respawn
	std::mutex resume_mutex;        // serializes lazy respawn
	std::atomic<bool> restored{false}; // true when rebuilt from disk at boot
	// on lazy respawn the fresh child's open_session replays its whole saved
	// transcript as live frames — already in our log, so swallow them until
	// the omprd-open response (deadline guards forks that never answer)
	std::atomic<bool> suppress_emit{false};
	std::atomic<int64_t> suppress_until_ms{0};

	// workspace window set: pids the session launched + the window ids
	// those pids own (CGWindowID / X Window / HWND token — what
	// workspace.new scopes to and computer.screenshot's wid takes)
	std::vector<long> pids;
	std::vector<unsigned long> wids;
};

struct PendingRequest {
	Client* client;        // who asked (nullptr for fanout members)
	Fanout* fanout;        // set if part of a cross-session fan-out
	Session* session;
	std::string id;        // daemon-minted omprd-N seen by omp
	std::string client_id; // caller's own request id, echoed back verbatim
	int64_t deadline_ms;
	// wire opt-in ("_slim": true on the request): large catalog responses
	// are rewritten to the field subset the requester consumes
	bool slim = false;
};

static std::unordered_map<std::string, Session*> g_sessions;
static std::mutex g_sessions_mutex;
static std::mutex g_fanout_mutex;
static std::vector<Fanout*> g_fanouts;

// retire graveyard: Client/Session objects are deleted 60 s after they're
// unregistered, never at unregister time. Stale pointers — a broadcast
// target snapshot, a pending request's client, a fan-out member, a detached
// reader thread finishing late — stay valid memory and every access is gated
// by the object's own alive/running flag. This kills the whole UAF class
// (observed as 'mutex lock failed' crashes when a session's reader outlived
// its reaping).
struct Retired { int64_t at_ms; std::function<void()> free; };
static std::deque<Retired> g_retired;
static std::mutex g_retired_mutex;

static void retire(std::function<void()> free) {
	std::lock_guard<std::mutex> lock(g_retired_mutex);
	g_retired.push_back({now_ms(), std::move(free)});
}

// A window's owner pid belongs to the launch when it IS the spawned pid or
// descends from it — spawn_detached rides /bin/sh -c, so _NET_WM_PID lands
// on a grandchild, not the tracked root. Linux walks /proc ppid chains;
// other OSes take the exact-pid match (spawned GUI apps own windows
// directly or arrive via a launcher the backend already resolves).
static bool pid_in_session_tree(unsigned long wpid, long root) {
	if ((long)wpid == root) return true;
#if defined(__linux__)
	long cur = (long)wpid;
	for (int hops = 0; cur > 1 && hops < 64; hops++) {
		if (cur == root) return true;
		std::ifstream f("/proc/" + std::to_string(cur) + "/stat");
		if (!f) return false;
		std::string line;
		std::getline(f, line);
		size_t rp = line.rfind(')'); // comm can hold spaces/parens
		if (rp == std::string::npos || rp + 4 >= line.size()) return false;
		cur = std::strtol(line.c_str() + rp + 4, nullptr, 10); // field 4 = ppid
	}
#endif
	return false;
}

// workspace bookkeeping on launch: remember the pid + the windows it owns;
// indexed-desktop OSes then park the new window on the session's own
// desktop so parallel agents never share a screen. Called under
// g_input_mutex from computer_step's launch path. The window can map a
// beat after spawn returns — bounded retries, 2 s worst case.
static void session_track_launch(Session* ws, const std::string& disp, long pid) {
	if (std::find(ws->pids.begin(), ws->pids.end(), pid) == ws->pids.end())
		ws->pids.push_back(pid);
	for (int tries = 0; tries < 8; tries++) {
		size_t before = ws->wids.size();
		for (auto& w : native().windows(disp))
			if (w.pid != 0 && pid_in_session_tree(w.pid, pid) &&
			    std::find(ws->wids.begin(), ws->wids.end(), w.id) == ws->wids.end())
				ws->wids.push_back(w.id);
#if !defined(__APPLE__) // macOS has no indexed desktops to move onto
		if (ws->desktop >= 0 && native().window_route_pid(disp, pid, ws->desktop))
			break;
#endif
		if (ws->wids.size() > before || tries == 7) break;
		std::this_thread::sleep_for(std::chrono::milliseconds(250));
	}
}

static void retire_sweep() {
	std::lock_guard<std::mutex> lock(g_retired_mutex);
	int64_t t = now_ms();
	while (!g_retired.empty() && t - g_retired.front().at_ms > 60000) {
		auto free = std::move(g_retired.front().free);
		g_retired.pop_front();
		free();
	}
}

static Session* find_session(const std::string& id) {
	std::lock_guard<std::mutex> lock(g_sessions_mutex);
	auto it = g_sessions.find(id);
	return it == g_sessions.end() ? nullptr : it->second;
}

// parent pid of a process — 0 on failure. The ancestry walk below uses it
// to answer "which session does this caller live in?": an agent inside a
// session (or a helper it spawned, like rig-call) sends its own pid and
// the daemon climbs ppids until it hits an omp child's pid.
static long proc_ppid(long pid) {
#if defined(_WIN32)
	long ppid = 0;
	HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
	if (snap == INVALID_HANDLE_VALUE) return 0;
	PROCESSENTRY32W e{};
	e.dwSize = sizeof(e);
	if (Process32FirstW(snap, &e))
		do {
			if ((long)e.th32ProcessID == pid) { ppid = (long)e.th32ParentProcessID; break; }
		} while (Process32NextW(snap, &e));
	CloseHandle(snap);
	return ppid;
#elif defined(__APPLE__)
	struct proc_bsdinfo pbi;
	if (proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &pbi, sizeof(pbi)) != (int)sizeof(pbi))
		return 0;
	return (long)pbi.pbi_ppid;
#else
	std::ifstream f("/proc/" + std::to_string(pid) + "/stat");
	if (!f) return 0;
	std::string line;
	std::getline(f, line);
	size_t rp = line.rfind(')'); // comm can hold spaces/parens
	if (rp == std::string::npos || rp + 4 >= line.size()) return 0;
	return std::strtol(line.c_str() + rp + 4, nullptr, 10); // field 4 = ppid
#endif
}

// Which session owns the process tree `pid` lives in? Compares each
// ancestor against the live sessions' omp child pids (proc_display_id
// resolves Windows handle-pids to real OS pids). nullptr = the caller is
// not inside a rig session's process tree.
static Session* session_for_pid(long pid) {
	std::unordered_map<long, Session*> by_pid;
	{
		std::lock_guard<std::mutex> lock(g_sessions_mutex);
		for (auto& [sid, s] : g_sessions)
			if (s->pid > 0) by_pid[proc_display_id(s->pid)] = s;
	}
	for (int depth = 0; depth < 32 && pid > 1; depth++) {
		auto it = by_pid.find(pid);
		if (it != by_pid.end()) return it->second;
		long ppid = proc_ppid(pid);
		if (ppid <= 0 || ppid == pid) break;
		pid = ppid;
	}
	return nullptr;
}

// Temp-index worktree snapshot → hidden ref refs/rig/checkpoints/<sid>/<n>.
// Seeds a throwaway index from HEAD, add -A (untracked included), write-tree,
// commit-tree as a child of HEAD — the user's index and files are never
// touched. Same tree as the latest checkpoint → {ok, skipped} with no new ref.
// Called by the rig.checkpoint.create RPC and the per-turn auto-checkpoint.
static json rig_capture_checkpoint(const std::string& cwd, const std::string& sid,
                                   const std::string& label) {
	std::string ns = "refs/rig/checkpoints/" + sid;
	std::string idx = (fs::temp_directory_path() /
	                   ("rig-cp-" + std::to_string(now_ms()) + ".idx")).string();
	std::string base = "GIT_INDEX_FILE=" + shell_quote(idx) + " git -C " + shell_quote(cwd) + " ";
	Capture inside = run_capture("git -C " + shell_quote(cwd) +
	                                 " rev-parse --is-inside-work-tree 2>/dev/null",
	                             5000);
	if (inside.code != 0 || inside.out.find("true") == std::string::npos)
		return {{"ok", false}, {"error", "not a git worktree"}};
	run_capture(base + "rev-parse --verify HEAD >/dev/null 2>&1 && " + base +
	                    "read-tree HEAD || " + base + "read-tree --empty",
	            8000);
	Capture add = run_capture(base + "add -A 2>&1", 15000);
	if (add.code != 0) {
		std::error_code ec;
		fs::remove(idx, ec);
		std::string e = add.out.empty() ? "git add failed" : add.out;
		if (e.size() > 200) e = e.substr(0, 200);
		return {{"ok", false}, {"error", e}};
	}
	Capture tree = run_capture(base + "write-tree", 8000);
	{
		std::error_code ec;
		fs::remove(idx, ec);
	}
	if (tree.code != 0) return {{"ok", false}, {"error", "write-tree failed"}};
	std::string tree_id = tree.out.substr(0, tree.out.find('\n'));
	// Latest checkpoint for this session — reuse when the worktree is
	// byte-identical (tree equality), no duplicate ref.
	Capture last = run_capture(
		"git -C " + shell_quote(cwd) +
			" for-each-ref --sort=-creatordate --count=1 --format='%(refname)%00%(objectname)' " +
			shell_quote(ns + "/") + " 2>/dev/null",
		8000);
	std::string last_ref, last_commit;
	{
		std::string l = last.out;
		auto p = l.find('\0');
		if (p != std::string::npos) {
			last_ref = l.substr(0, p);
			last_commit = l.substr(p + 1);
			if (!last_commit.empty() && last_commit.back() == '\n') last_commit.pop_back();
		}
	}
	if (!last_ref.empty()) {
		Capture lt = run_capture(
			"git -C " + shell_quote(cwd) + " rev-parse " + shell_quote(last_commit + "^{tree}") +
				" 2>/dev/null",
			8000);
		if (lt.code == 0 && lt.out.find(tree_id) == 0)
			return {{"ok", true}, {"skipped", true}, {"ref", last_ref}, {"tree", tree_id}};
	}
	std::string msg = label.empty() ? "checkpoint" : label;
	std::string mk = "git -C " + shell_quote(cwd) + " commit-tree " + tree_id + " -m " +
	                 shell_quote(msg);
	Capture head =
		run_capture("git -C " + shell_quote(cwd) + " rev-parse --verify HEAD 2>/dev/null", 8000);
	if (head.code == 0 && !head.out.empty()) mk += " -p " + head.out.substr(0, head.out.find('\n'));
	Capture commit = run_capture(mk, 8000);
	if (commit.code != 0) return {{"ok", false}, {"error", "commit-tree failed"}};
	std::string commit_id = commit.out.substr(0, commit.out.find('\n'));
	Capture ls = run_capture(
		"git -C " + shell_quote(cwd) + " for-each-ref --format='%(refname)' " +
			shell_quote(ns + "/") + " 2>/dev/null",
		8000);
	int n = 1;
	{
		std::istringstream lin(ls.out);
		std::string rl;
		while (std::getline(lin, rl)) {
			auto p = rl.rfind('/');
			if (p != std::string::npos) {
				int v = atoi(rl.c_str() + p + 1);
				if (v >= n) n = v + 1;
			}
		}
	}
	std::string refname = ns + "/" + std::to_string(n);
	Capture ur = run_capture(
		"git -C " + shell_quote(cwd) + " update-ref " + shell_quote(refname) + " " + commit_id,
		8000);
	if (ur.code != 0) {
		// A racing same-session capture may have claimed our number between
		// the for-each-ref scan and this update-ref — rescan and retry once.
		Capture ls2 = run_capture(
			"git -C " + shell_quote(cwd) + " for-each-ref --format='%(refname)' " +
				shell_quote(ns + "/") + " 2>/dev/null",
			8000);
		n = 1;
		std::istringstream lin2(ls2.out);
		std::string rl2;
		while (std::getline(lin2, rl2)) {
			auto p = rl2.rfind('/');
			if (p != std::string::npos) {
				int v = atoi(rl2.c_str() + p + 1);
				if (v >= n) n = v + 1;
			}
		}
		refname = ns + "/" + std::to_string(n);
		ur = run_capture(
			"git -C " + shell_quote(cwd) + " update-ref " + shell_quote(refname) + " " + commit_id,
			8000);
		if (ur.code != 0) return {{"ok", false}, {"error", "update-ref failed"}};
	}
	Capture stat = run_capture(
		"git -C " + shell_quote(cwd) + " diff --shortstat HEAD " + commit_id + " 2>/dev/null", 8000);
	return {{"ok", true},       {"ref", refname}, {"commit", commit_id}, {"tree", tree_id},
	        {"n", n},           {"stat", stat.code == 0 ? stat.out : std::string("")}};
}

// defined below the reader; the reader issues these for auto-compact checks
static bool session_request(Session* s, json frame, Client* client, Fanout* fanout, int64_t timeout_ms = 20000);
static void queue_open_session(Session* s);
static void jobs_sweep();

// --- restart persistence (~/.rig/sessions/<id>.{meta.json,jsonl}) ---------

static fs::path rig_sessions_dir() {
	return g_rig.dir / "sessions";
}

static void persist_meta(Session* s) {
	try {
		fs::create_directories(rig_sessions_dir());
		json meta = {{"id", s->id}, {"cwd", s->cwd}, {"created", s->created_ms},
		             {"title", s->title}, {"opts", s->spawn_opts}, {"pid", s->pid},
		             {"parent", s->parent_id}, {"pinned", s->pinned.load()},
		             {"hidden", s->hidden.load()}, {"lastReadSeq", s->last_read_seq.load()},
		             {"harness", s->harness}, {"convId", s->conv_id}};
		std::ofstream f(rig_sessions_dir() / (s->id + ".meta.json"));
		f << meta.dump();
	} catch (...) {}
}

// ring_mutex must already be held — same lock orders ring + file so a
// subscribe snapshot can never observe a frame the log skipped
static void persist_frame(Session* s, const std::string& raw_line) {
	if (!s->persist_fp)
		// .string() — path::c_str() is wchar_t* on Windows and fopen wants char*
		s->persist_fp = fopen((rig_sessions_dir() / (s->id + ".jsonl")).string().c_str(), "a");
	if (!s->persist_fp) return;
	fwrite(raw_line.data(), 1, raw_line.size(), s->persist_fp);
	fputc('\n', s->persist_fp);
	fflush(s->persist_fp); // survives our own exit; fsync reserved for real power loss
}

static void harvest_preview(Session* s, const std::string& raw_line) {
	if (raw_line.find("message_end") == std::string::npos ||
	    raw_line.find("assistant") == std::string::npos) return;
	try {
		auto j = json::parse(raw_line);
		const json& msg = j.contains("message") ? j["message"] : j;
		if (j_str(msg, "role") != "assistant") return;
		std::string text;
		if (msg.contains("content") && msg["content"].is_string()) text = msg["content"].get<std::string>();
		else if (msg.contains("content") && msg["content"].is_array()) {
			for (auto& b : msg["content"])
				if (b.is_object() && j_str(b, "type") == "text") { text = j_str(b, "text"); break; }
		}
		if (!text.empty()) {
			size_t nl = text.find('\n');
			if (nl != std::string::npos) text.resize(nl);
			if (text.size() > 140) text.resize(140);
			s->preview = std::move(text);
		}
	} catch (...) {}
}

static void session_emit(Session* s, std::string raw_line) {
	s->last_active_ms.store(wall_ms());
	s->stall_flagged = false;
	uint64_t seq = 0;
	std::vector<Client*> targets;
	// one alloc total: the moved line becomes the shared ring/fanout payload
	auto raw = std::make_shared<const std::string>(std::move(raw_line));
	{
		std::lock_guard<std::mutex> lock(s->ring_mutex);
		// seq is minted inside the lock so ring order == seq order even if a
		// second emitter ever joins this session
		seq = s->seq.fetch_add(1) + 1;
		harvest_preview(s, *raw);
		s->ring.emplace_back(seq, raw);
		persist_frame(s, *raw);
		s->ring_bytes += raw->size();
		while (s->ring_bytes > Session::RING_MAX_BYTES || s->ring.size() > Session::RING_MAX_ENTRIES) {
			if (s->ring.empty()) break;
			s->ring_bytes -= s->ring.front().second->size();
			s->ring.pop_front();
		}
		// live-delivery marks update under the same lock that orders the ring:
		// a racing subscribe then knows precisely which seqs each client
		// already owns, so replay + fanout together deliver each seq once.
		{
			std::lock_guard<std::mutex> clk(g_clients_mutex);
			for (Client* c : g_clients)
				if (c->authed && c->alive) targets.push_back(c);
		}
		for (Client* c : targets) {
			std::lock_guard<std::mutex> sl(c->seq_mutex);
			if (!c->live_lo.count(s->id)) c->live_lo[s->id] = seq;
			c->live_hi[s->id] = seq;
		}
	}
	// the enqueue burst stays off the ring lock — marking happened inside,
	// delivery order is preserved because subscribers only replay seqs that
	// are neither live-marked nor already replayed
	auto out = std::make_shared<std::string>();
	out->reserve(48 + s->id.size() + raw->size());
	*out += "{\"type\":\"rpc\",\"sessionId\":\"" + s->id + "\",\"seq\":" + std::to_string(seq) + ",\"frame\":";
	*out += *raw;
	*out += "}";
	for (Client* c : targets) enqueue_out(c, out);
}

// ---------------------------------------------------------------------------
// Harnesses — non-omp agent runtimes. The child speaks its own protocol
// (claude: stream-json NDJSON); this layer translates every line into the
// omp-shaped frames below BEFORE session_emit, so ring persistence,
// replay, previews, busy bookkeeping, subscribers and the app all work
// identically downstream.
// ---------------------------------------------------------------------------

// Emit an omp-shaped frame for a non-omp session, keeping the busy
// bookkeeping identical to the omp path (agent_start opens a turn,
// prompt_result/session_settled close it).
static void emit_translated(Session* s, const json& frame) {
	const std::string ft = frame.value("type", "");
	bool busy_now = s->busy.load();
	if (ft == "agent_start") s->busy = true;
	else if (ft == "prompt_result" || ft == "session_settled" || ft == "agent_end")
		s->busy = false;
	if (s->busy.load() != busy_now)
		broadcast(std::string("{\"type\":\"session.busy\",\"sessionId\":\"") + s->id +
		          "\",\"busy\":" + (s->busy.load() ? "true" : "false") + "}");
	session_emit(s, frame.dump());
	g_frames_in++;
}

// claude --print --output-format stream-json --input-format stream-json:
// NDJSON events — system.init, stream_event (anthropic deltas when
// --include-partial-messages), assistant (complete blocks), user
// (tool_results), result (turn outcome + usage + session_id).
static void claude_translate(Session* s, const std::string& line) {
	json j;
	try { j = json::parse(line); } catch (...) { return; }
	const std::string t = j.value("type", "");

	if (t == "system") {
		if (j.value("subtype", "") == "init") {
			if (j.contains("session_id") && j["session_id"].is_string())
				s->conv_id = j["session_id"].get<std::string>();
			emit_translated(s, {{"type", "harness_init"}, {"harness", "claude"},
			                    {"model", j.value("model", "")}});
		}
		return;
	}

	if (t == "stream_event") {
		const json ev = j.value("event", json::object());
		if (ev.value("type", "") == "content_block_delta") {
			const json d = ev.value("delta", json::object());
			if (d.value("type", "") == "text_delta" && d.contains("text")) {
				json delta_ev = {{"type", "text_delta"}, {"delta", d["text"]}};
				emit_translated(s, {{"type", "message_update"},
				                    {"assistantMessageEvent", delta_ev}});
			}
		}
		return;
	}

	if (t == "assistant") {
		const json msg = j.value("message", json::object());
		std::string text;
		for (const json& b : msg.value("content", json::array())) {
			const std::string bt = b.value("type", "");
			if (bt == "text") text += b.value("text", "");
			else if (bt == "tool_use")
				emit_translated(s, {{"type", "tool_execution_start"},
				    {"toolCallId", b.value("id", "")},
				    {"toolName", b.value("name", "")},
				    {"args", b.contains("input") ? b["input"] : json::object()}});
		}
		if (!text.empty()) {
			json msg_content = json::array();
			msg_content.push_back({{"type", "text"}, {"text", text}});
			json msg_obj = {{"role", "assistant"}, {"content", msg_content}};
			emit_translated(s, {{"type", "message_end"}, {"message", msg_obj}});
		}
		return;
	}

	if (t == "user") {
		const json msg = j.value("message", json::object());
		for (const json& b : msg.value("content", json::array())) {
			if (b.value("type", "") != "tool_result") continue;
			json out = {{"type", "tool_execution_end"},
			            {"toolCallId", b.value("tool_use_id", "")}};
			// surface the output tail — the card renders it like omp's
			if (b.contains("content")) {
				std::string txt;
				if (b["content"].is_string()) txt = b["content"].get<std::string>();
				else if (b["content"].is_array())
					for (const json& p : b["content"])
						if (p.value("type", "") == "text") txt += p.value("text", "");
				if (!txt.empty()) out["output"] = txt.substr(0, 4000);
			}
			if (b.contains("is_error") && b["is_error"].is_boolean())
				out["ok"] = !b["is_error"].get<bool>();
			emit_translated(s, out);
		}
		return;
	}

	if (t == "result") {
		if (j.contains("session_id") && j["session_id"].is_string())
			s->conv_id = j["session_id"].get<std::string>();
		const bool ok = !j.value("is_error", false) && j.value("subtype", "") == "success";
		if (j.contains("usage") && j["usage"].is_object()) {
			const json& u = j["usage"];
			const int64_t tok = int64_t(u.value("input_tokens", 0)) + u.value("output_tokens", 0)
			                  + u.value("cache_read_input_tokens", 0)
			                  + u.value("cache_creation_input_tokens", 0);
			if (tok > 0) {
				s->usage_last = tok;
				int64_t prev = s->usage_max.load();
				while (tok > prev && !s->usage_max.compare_exchange_weak(prev, tok)) {}
			}
		}
		json pr = {{"type", "prompt_result"}, {"ok", ok}};
		if (!ok) pr["error"] = j.value("result", j.value("subtype", "turn error"));
		emit_translated(s, pr);
		emit_translated(s, {{"type", "session_settled"}});
		// conv id goes to disk so --resume survives a daemon restart
		persist_meta(s);
		return;
	}
}

static void harness_translate(Session* s, const std::string& line) {
	if (s->harness == "claude") claude_translate(s, line);
}

// argv for non-omp harnesses. claude: streaming NDJSON both ways — the
// phone drives multi-turn over stdin; --resume carries the conversation
// across daemon restarts; bypassPermissions is the remote-rig default
// (nothing at the laptop to click "allow") unless the spawn opts say so.
static std::vector<std::string> build_claude_args(const json& opts, const std::string& conv_id) {
	std::vector<std::string> args = {
		"--print", "--output-format", "stream-json",
		"--input-format", "stream-json", "--verbose",
		"--include-partial-messages",
	};
	std::string perm = opts.value("permissionMode", "bypassPermissions");
	if (!perm.empty()) { args.push_back("--permission-mode"); args.push_back(perm); }
	std::string model = opts.value("model", "");
	if (!model.empty()) { args.push_back("--model"); args.push_back(model); }
	if (!conv_id.empty()) { args.push_back("--resume"); args.push_back(conv_id); }
	return args;
}

// omp protocol-v2 chunks any single frame over ~1MB into
// {"type":"rpc_chunk",chunkId,index,count,byteLength,data(base64)} lines.
// The correlated omprd- id lives inside the payload, so the marker
// prefilter cannot see it — unhandled, a chunked response never reaches
// its PendingRequest (the caller hangs to timeout) and the chunk parts
// pollute the ring/persisted log, replaying to clients as undecodable
// noise. The reader reassembles the parts and re-enters the whole frame
// as one ordinary line.
struct RpcAsm {
	std::string id;
	int count = 0;
	int next = 0;
	int64_t len = 0;
	std::string buf;
	bool active() const { return count > 0; }
	void reset() { id.clear(); count = 0; next = 0; len = 0; buf.clear(); }
};
static constexpr int64_t RPC_CHUNK_MAX_BYTES = 64 * 1024 * 1024;

// Feed one stdout line. Returns true when the line was a chunk part and
// consumed: `whole` stays empty mid-sequence, holds the reassembled frame
// on the last part. Returns false when the line is not a chunk part — a
// pending sequence interrupted by it is abandoned (upstream emits chunks
// contiguously; an interleave means the set is dead).
static bool rpc_chunk_feed(RpcAsm& a, const std::string& line, std::string& whole, Session* s) {
	json cj;
	try { cj = json::parse(line); } catch (...) {
		if (a.active()) a.reset();
		return false;
	}
	if (j_str(cj, "type") != "rpc_chunk") {
		if (a.active()) {
			log("session " + s->id + ": rpc_chunk sequence interrupted — partial frame dropped");
			a.reset();
		}
		return false;
	}
	std::string cid = j_str(cj, "chunkId");
	int idx = cj.contains("index") && cj["index"].is_number_integer() ? cj["index"].get<int>() : -1;
	int cnt = cj.contains("count") && cj["count"].is_number_integer() ? cj["count"].get<int>() : -1;
	int64_t blen = j_i64(cj, "byteLength", -1);
	std::vector<uint8_t> dec;
	bool ok = cnt >= 2 && cnt <= 4096 && idx >= 0 && idx < cnt &&
	          blen > 0 && blen <= RPC_CHUNK_MAX_BYTES &&
	          !cid.empty() && cid.size() <= 128 &&
	          cj.contains("data") && cj["data"].is_string() &&
	          rigfs::base64_decode(cj["data"].get<std::string>(), dec);
	if (ok) {
		if (!a.active()) {
			if (idx != 0) ok = false;
			else {
				a.id = cid; a.count = cnt; a.len = blen;
				a.buf.clear(); a.buf.reserve(size_t(blen));
			}
		} else if (cid != a.id || cnt != a.count || blen != a.len || idx != a.next) {
			ok = false;
		}
	}
	if (ok) {
		a.buf.append(reinterpret_cast<const char*>(dec.data()), dec.size());
		if (a.buf.size() > size_t(a.len)) ok = false;
	}
	if (!ok) {
		log("session " + s->id + ": bad rpc_chunk part — frame dropped");
		a.reset();
		return true; // consumed (and killed the sequence)
	}
	if (++a.next < a.count) return true;
	if (a.buf.size() != size_t(a.len)) {
		log("session " + s->id + ": rpc_chunk byteLength mismatch — frame dropped");
		a.reset();
		return true;
	}
	whole = std::move(a.buf);
	a.reset();
	return true;
}

static void child_reader(Session* s, bool warm = false) {
	std::string buf;
	char chunk[64 * 1024];
	RpcAsm rpc_asm; // protocol-v2 chunk reassembly state (reader-local)
	bool negotiating = !warm; // a warm-adopted child already answered the handshake
	while (!g_stop && s->running) {
		ssize_t n = file_read(s->stdout_fd, chunk, sizeof(chunk));
		if (n <= 0) break;
		buf.append(chunk, size_t(n));
		// Cursor-split consumed lines: erase the consumed prefix ONCE per
		// read() instead of memmoving the tail per line (O(remaining) per
		// line before — quadratic on burst reads).
		size_t pos = 0;
		size_t nl;
		while ((nl = buf.find('\n', pos)) != std::string::npos) {
			std::string line = buf.substr(pos, nl - pos);
			pos = nl + 1;
			if (line.empty() || line == "\r") continue;
			if (!line.empty() && line.back() == '\r') line.pop_back();
			if (s->suppress_emit.load()) {
				// open_session transcript replay — those frames are already in our
				// persisted log; emit nothing until the omprd-open response (or the
				// deadline trips). The negotiate reply must still pass through.
				if (line.find("\"omprd-open\"") != std::string::npos ||
				    now_ms() > s->suppress_until_ms.load())
					s->suppress_emit.store(false);
				else if (line.find("omprd-handshake") == std::string::npos)
					continue;
			}
			// rpc_chunk parts: substring prefilter, then reassemble. A
			// completed frame replaces `line` and falls through the normal
			// path; a non-chunk line passes through unchanged.
			if (rpc_asm.active() || line.find("\"rpc_chunk\"") != std::string::npos) {
				std::string whole;
				if (rpc_chunk_feed(rpc_asm, line, whole, s)) {
					if (whole.empty()) continue;    // mid-sequence part
					line = std::move(whole);        // reassembled frame
				}
			}
			int64_t t0 = now_us();
			g_lines_total++;
			// non-omp harness: the child's protocol differs entirely — run
			// every line through the translator, which emits omp-shaped
			// frames; nothing else on this path understands the wire.
			if (s->harness != "omp") {
				harness_translate(s, line);
				g_lat_bridge.add(now_us() - t0);
				continue;
			}
			// hot path: the overwhelming majority of frames are passthrough
			// (deltas/events). Parse only when a marker proves the daemon must
			// look inside — handshake, correlated omprd- responses, token-usage
			// harvest, turn-completion for the auto-compact check.
			bool need_parse = negotiating
			    || line.find("omprd-") != std::string::npos
			    || line.find("\"usage\"") != std::string::npos
			    || line.find("prompt_result") != std::string::npos
			    || line.find("agent_start") != std::string::npos
			    || line.find("agent_end") != std::string::npos
			    || line.find("session_settled") != std::string::npos
			    || line.find("auto_retry_end") != std::string::npos;
			json j;
			bool parsed = false;
			if (need_parse) {
				try { j = json::parse(line); parsed = true; g_lines_parsed++; } catch (...) {}
			}

			if (parsed && negotiating && j_str(j, "type") == "response" &&
			    j_str(j, "id") == "omprd-handshake") {
				negotiating = false;
				if (j_bool(j, "success")) {
					s->started_acked = true;
					if (s->starter && s->starter->alive)
						send_json(s->starter, {{"type", "session.started"}, {"sessionId", s->id}});
				} else {
					log("session " + s->id + ": omp refused protocol v2: " + j.dump());
					if (s->starter && s->starter->alive)
						send_json(s->starter, {{"type", "error"}, {"error", "omp refused protocol v2"}, {"sessionId", s->id}});
				}
				continue;
			}

			// correlated responses go to their requester (fan-out aware)
			if (parsed && j_str(j, "type") == "response" && j_str(j, "id").rfind("omprd-", 0) == 0) {
				std::string rid = j_str(j, "id");
				PendingRequest* pr = nullptr;
				{
					std::lock_guard<std::mutex> lock(s->pending_mutex);
					auto it = s->pending.find(rid);
					if (it != s->pending.end()) { pr = it->second; s->pending.erase(it); }
				}
				if (pr) {
					// opt-in wire slimming ("_slim" on the request): the full
					// get_available_models catalog runs ~2.5KB/model × N (~1.2MB
					// at 500 models) over a link that may be tailnet-slow, and
					// the phone parses it all on the JS thread. The picker only
					// reads identity/thinking fields — rewrite to that subset.
					if (pr->slim && j_str(j, "command") == "get_available_models" &&
					    j_bool(j, "success") &&
					    j.contains("data") && j["data"].is_object() &&
					    j["data"].contains("models") && j["data"]["models"].is_array()) {
						static const char* keep[] = {
						    "provider", "providerId", "id", "modelId", "name", "label",
						    "thinking", "reasoning", "contextWindow", "maxTokens",
						    "input", "output"};
						json slim_models = json::array();
						for (const json& m : j["data"]["models"]) {
							if (!m.is_object()) { slim_models.push_back(m); continue; }
							json sm = json::object();
							for (const char* k : keep)
								if (m.contains(k)) sm[k] = m[k];
							slim_models.push_back(std::move(sm));
						}
						j["data"]["models"] = std::move(slim_models);
						line = j.dump();
					}
					if (j_str(j, "command") == "get_state" && j_bool(j, "success")) {
						json cu = j.contains("data") && j["data"].is_object() && j["data"].contains("contextUsage")
						          ? j["data"]["contextUsage"] : json::object();
						if (cu.contains("tokens") && cu["tokens"].is_number()) {
							int64_t tok = cu["tokens"].get<int64_t>();
							s->usage_last = tok;
							int64_t prev = s->usage_max.load();
							while (tok > prev && !s->usage_max.compare_exchange_weak(prev, tok)) {}
							if (cu.contains("contextWindow") && cu["contextWindow"].is_number())
								s->usage_window = cu["contextWindow"].get<int64_t>();
							// auto-compact trigger: the ledger just refreshed above
							// the threshold — issue compact on the rig's behalf
							int64_t win = s->usage_window.load();
							if (g_compact_pct > 0 && win > 0 && tok * 100 >= int64_t(g_compact_pct) * win) {
								int64_t t = now_ms();
								int64_t lastc = s->compact_sent_ms.load();
								if (t - lastc > 60000 && s->compact_sent_ms.compare_exchange_strong(lastc, t)) {
									session_request(s, {{"type", "compact"}}, nullptr, nullptr);
									broadcast(std::string("{\"type\":\"session.autoCompact\",\"sessionId\":\"") + s->id +
									          "\",\"tokens\":" + std::to_string(tok) +
									          ",\"window\":" + std::to_string(win) + "}");
									log("auto-compact on " + s->id + " (" + std::to_string(tok) + "/" + std::to_string(win) + ")");
								}
							}
						}
					}
					if (pr->fanout) {
						std::lock_guard<std::mutex> lock(g_fanout_mutex);
						json data = j.contains("data") ? j["data"] : json::object();
						if (data.is_array()) for (auto& e : data) pr->fanout->collected.push_back(e);
						else if (!data.is_null()) pr->fanout->collected.push_back(data);
						if (--pr->fanout->remaining == 0) {
							json reply = {{"type", pr->fanout->reply_type},
							              {"results", pr->fanout->collected}};
							if (!pr->fanout->req_id.empty()) reply["id"] = pr->fanout->req_id;
							enqueue_out(pr->fanout->client, reply.dump());
							delete pr->fanout;
							for (size_t i = 0; i < g_fanouts.size(); i++)
								if (g_fanouts[i] == pr->fanout) { g_fanouts.erase(g_fanouts.begin() + long(i)); break; }
						}
					} else if (pr->client) {
						const std::string& out_id = pr->client_id.empty() ? rid : pr->client_id;
						std::string fwd = "{\"type\":\"session.response\",\"sessionId\":\"" + s->id +
						                  "\",\"id\":\"" + out_id + "\",\"frame\":" + line + "}";
						enqueue_out(pr->client, fwd);
					}
					delete pr;
					continue;
				}
			}

			// line is dead after the emit — move it straight into the ring's
			// shared payload instead of copying
			session_emit(s, std::move(line));
			g_frames_in++;
			g_lat_bridge.add(now_us() - t0);

			// everything below ran only when the prefilter found a marker
			if (parsed) {
				const std::string ft = j_str(j, "type");
				// turn bookkeeping for sessions.list busy flag — mirrors the
				// frame types the app already keys its streaming state on
				bool busy_now = s->busy.load();
				if (ft == "agent_start") s->busy = true;
				else if (ft == "prompt_result" || ft == "session_settled" || ft == "agent_end")
					s->busy = false;
				// auto_retry_end{success:true} is mid-turn — generation
				// continues; only a give-up ends the turn
				else if (ft == "auto_retry_end" && !j_bool(j, "success"))
					s->busy = false;
				if (s->busy.load() != busy_now)
					broadcast(std::string("{\"type\":\"session.busy\",\"sessionId\":\"") + s->id +
					          "\",\"busy\":" + (s->busy.load() ? "true" : "false") + "}");
				// a settled turn is the signal to re-check context fullness
				if (ft == "prompt_result" && g_compact_pct > 0) {
					int64_t t = now_ms();
					int64_t last = s->last_auto_check_ms.load();
					if (t - last > 5000 && s->last_auto_check_ms.compare_exchange_strong(last, t))
						session_request(s, {{"type", "get_state"}}, nullptr, nullptr);
				}
				// T3-style per-turn checkpoint: snapshot the worktree under a
				// hidden ref when the turn ends inside a git repo. Off-thread —
				// git I/O must not stall the reader. Dedup is inside
				// rig_capture_checkpoint (same tree → no new ref).
				if (ft == "prompt_result") {
					std::string sid = s->id, cwd = s->cwd;
					std::thread([sid, cwd] {
						json r = rig_capture_checkpoint(cwd, sid, "");
						if (r.value("ok", false) && !r.value("skipped", false))
							log("checkpoint " + sid + " -> " + r.value("ref", std::string()));
						else if (r.value("skipped", false))
							log("checkpoint " + sid + " skipped (unchanged tree)");
						else
							log("checkpoint " + sid + " failed: " +
							    r.value("error", std::string("unknown")));
					}).detach();
				}
				// harvest provider usage objects — shallow fixed paths only
				const json* u = nullptr;
				for (const char* k : {"usage", "data", "message", "response"}) {
					if (j.contains(k) && j[k].is_object()) {
						const json& c = j[k];
						if (k == std::string("usage")) { u = &c; break; }
						if (c.contains("usage") && c["usage"].is_object()) { u = &c["usage"]; break; }
					}
				}
				if (u) {
					auto i64 = [&](const char* k) -> int64_t {
						return u->contains(k) && (*u)[k].is_number() ? (*u)[k].get<int64_t>() : 0;
					};
					s->tok_in += i64("input_tokens") + i64("prompt_tokens");
					s->tok_out += i64("output_tokens") + i64("completion_tokens");
					s->tok_cache_read += i64("cache_read_input_tokens")
					                   + i64("cached_tokens") + i64("prompt_cache_hit_tokens");
					s->tok_cache_write += i64("cache_creation_input_tokens");
					if (u->contains("prompt_tokens_details") && (*u)["prompt_tokens_details"].is_object()
					    && (*u)["prompt_tokens_details"].contains("cached_tokens")
					    && (*u)["prompt_tokens_details"]["cached_tokens"].is_number())
						s->tok_cache_read += (*u)["prompt_tokens_details"]["cached_tokens"].get<int64_t>();
				}
			}
		}
		if (pos) buf.erase(0, pos);
	}
	if (!s->started_acked && s->starter && s->starter->alive)
		send_json(s->starter, {{"type", "error"}, {"error", "omp exited before RPC handshake"}, {"sessionId", s->id}});
	// this thread owns stdout_fd — the reaper never closes it, so close on
	// the way out (a reap close could race a recycled fd number)
	if (s->stdout_fd >= 0) { file_close(s->stdout_fd); s->stdout_fd = -1; }
	s->running = false;
	log("session " + s->id + " reader done (pid " + std::to_string(s->pid) + ")");
}

// Per-display claimed desktops: session-owned workspace indices, reused
// lowest-first when free. Releasing a session frees its index; the
// trailing tail of _NET_NUMBER_OF_DESKTOPS shrinks while it's both
// unclaimed and windowless — abrupt session death no longer leaks
// desktops forever. X11-only: macOS uses fullscreen-app Spaces and win32
// lacks desktop_window_count/space_set_count, so those backends keep the
// append-only behavior they had.
#if !defined(__APPLE__) && !defined(_WIN32)
static std::map<std::string, std::set<int>> g_claimed_desktops;
static std::map<std::string, int> g_desktop_base; // count before first claim
static std::mutex g_desktops_mutex;

// claim a desktop for a session: lowest unclaimed, windowless index at or
// above the base count, else append via space_new. Enters the desktop.
// Returns the index or -1.
static int desktop_claim(const std::string& disp) {
	std::lock_guard<std::mutex> lk(g_desktops_mutex);
	auto& claimed = g_claimed_desktops[disp];
	if (!g_desktop_base.count(disp)) {
		int n = native().space_count(disp);
		g_desktop_base[disp] = n > 0 ? n : 0;
	}
	int base = g_desktop_base[disp];
	int n = native().space_count(disp);
	if (n <= 0) return -1; // no indexed-desktop backend
	for (int i = base; i < n && i < base + 64; i++) {
		if (claimed.count(i)) continue;
		if (native().desktop_window_count(disp, i) != 0) continue;
		claimed.insert(i);
		native().space_enter(disp, i);
		return i;
	}
	// nothing reusable — append
	int d = native().space_new(disp);
	if (d >= 0) claimed.insert(d);
	return d;
}

// free a session's desktop index; shrink the trailing desktop count while
// the top index is unclaimed and has no windows on it.
static void desktop_release(const std::string& disp, int idx) {
	if (idx < 0) return;
	std::lock_guard<std::mutex> lk(g_desktops_mutex);
	auto it = g_claimed_desktops.find(disp);
	if (it == g_claimed_desktops.end()) { log("desktop_release: no claims for " + disp); return; }
	it->second.erase(idx);
	int base = g_desktop_base.count(disp) ? g_desktop_base[disp] : 0;
	for (;;) {
		int n = native().space_count(disp);
		if (n <= base) break;
		int top = n - 1;
		if (it->second.count(top)) break;
		long wc = native().desktop_window_count(disp, top);
		if (wc != 0) { log("desktop_release: top=" + std::to_string(top) + " has " + std::to_string(wc) + " windows"); break; }
		// never leave the WM sitting on the index we're deleting
		if (native().space_current(disp) == top)
			native().space_enter(disp, base > 0 ? base - 1 : 0);
		if (!native().space_set_count(disp, n - 1)) { log("desktop_release: set_count failed"); break; }
	}
}
#endif

// Send an omp command with a daemon-minted id; route the response privately.
static bool session_resume(Session* s, std::string& err);

// first prompt becomes the thread title (Grok-style inbox names)
static void harvest_live_title(Session* s, const json& frame) {
	if (!s->title.empty() || j_str(frame, "type") != "prompt") return;
	std::string t;
	if (frame.contains("message") && frame["message"].is_string())
		t = frame["message"].get<std::string>();
	else if (frame.contains("message") && frame["message"].is_array()) {
		for (auto& b : frame["message"])
			if (b.is_object() && j_str(b, "type") == "text") { t = j_str(b, "text"); break; }
	}
	size_t nl = t.find('\n');
	if (nl != std::string::npos) t.resize(nl);
	if (t.size() > 80) t.resize(80);
	if (!t.empty()) { s->title = t; persist_meta(s); }
}

static bool session_request(Session* s, json frame, Client* client, Fanout* fanout, int64_t timeout_ms) {
	// non-omp harness: no omp command frames exist on the child's stdin.
	// Answer the control ops the daemon itself issues (abortAll fanout,
	// auto-compact get_state probe) synthetically; anything else is a
	// protocol error the caller should see.
	if (s->harness != "omp") {
		const std::string ft = frame.value("type", "");
		std::string client_id = frame.value("_cid", "");
		auto respond = [&](const json& resp) {
			if (fanout) {
				std::lock_guard<std::mutex> lock(g_fanout_mutex);
				json data = resp.contains("data") ? resp["data"] : json::object();
				fanout->collected.push_back(data);
				if (--fanout->remaining == 0) {
					json reply = {{"type", fanout->reply_type}, {"results", fanout->collected}};
					if (!fanout->req_id.empty()) reply["id"] = fanout->req_id;
					enqueue_out(fanout->client, reply.dump());
					for (size_t i = 0; i < g_fanouts.size(); i++)
						if (g_fanouts[i] == fanout) { g_fanouts.erase(g_fanouts.begin() + long(i)); break; }
					delete fanout;
				}
			} else if (client) {
				const std::string& out_id = client_id.empty() ? "omprd-synth" : client_id;
				enqueue_out(client, "{\"type\":\"session.response\",\"sessionId\":\"" + s->id +
				            "\",\"id\":\"" + out_id + "\",\"frame\":" + resp.dump() + "}");
			}
		};
		if (ft == "abort" || ft == "interrupt") {
			if (s->pid > 0) { kill(-s->pid, SIGINT); kill(s->pid, SIGINT); }
			respond({{"type", "response"}, {"command", ft}, {"success", true}});
			return true;
		}
		if (ft == "get_state") {
			respond({{"type", "response"}, {"command", "get_state"}, {"success", true},
			         {"data", {{"contextUsage", {{"tokens", s->usage_last.load()},
			                                    {"contextWindow", s->usage_window.load()}}}}}});
			return true;
		}
		if (ft == "compact") {
			respond({{"type", "response"}, {"command", "compact"}, {"success", true},
			         {"data", {{"skipped", "harness manages its own context"}}}});
			return true;
		}
		respond({{"type", "response"}, {"command", ft}, {"success", false},
		         {"error", "unsupported on " + s->harness + " harness"}});
		return true;
	}
	if (!s->running.load() && s->stdin_fd < 0) {
		// restored session with no live child — respawn lazily, once
		std::string rerr;
		if (!session_resume(s, rerr)) return false;
	}
	harvest_live_title(s, frame);
	std::string rid = "omprd-" + std::to_string(s->req_counter.fetch_add(1) + 1);
	std::string client_id = frame.value("_cid", "");
	bool slim = frame.contains("_slim") && frame["_slim"].is_boolean() && frame["_slim"].get<bool>();
	frame.erase("_cid");
	frame.erase("_slim"); // wire-only hint — never reaches omp
	frame["id"] = rid;
	auto* pr = new PendingRequest{client, fanout, s, rid, client_id,
	                              now_ms() + timeout_ms, slim};
	{
		std::lock_guard<std::mutex> lock(s->pending_mutex);
		s->pending[rid] = pr;
	}
	std::string line = frame.dump();
	line.push_back('\n');
	std::lock_guard<std::mutex> wlock(s->write_mutex);
	if (s->stdin_fd < 0) {
		// reaped between find_session and the write — drop cleanly
		std::lock_guard<std::mutex> lock(s->pending_mutex);
		s->pending.erase(rid);
		delete pr;
		return false;
	}
	if (!write_all_fd(s->stdin_fd, line.data(), line.size())) {
		std::lock_guard<std::mutex> lock(s->pending_mutex);
		s->pending.erase(rid);
		delete pr;
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// spawn + warm pool
//
// omp children take ~1.4 s to reach a completed RPC handshake (bun cold boot).
// The warm pool keeps a small number of spare children — spawned ahead of
// demand, handshake already answered — so session.new adopts one instantly.
// Spares are keyed by the exact spawn signature (dir + binary + argv) so a
// spare is only ever adopted for a request it would have satisfied anyway.
// RIG_WARM_MAX caps spares (default 2; each is ~100-200 MB RSS of idle bun);
// RIG_WARM=0 disables the pool entirely.
// ---------------------------------------------------------------------------

struct OmpChild { pid_t pid = -1; int stdin_fd = -1; int stdout_fd = -1; };

static OmpChild spawn_omp_child(const std::string& dir, const std::string& omp_bin,
                                const std::vector<std::string>& args, std::string& err,
                                bool merge_stderr = false, bool pin_cwd = true) {
	OmpChild ch;
	// Pin the agent's project dir to the session dir we chose: without --cwd,
	// omp's startup relocates itself out of $HOME (its anti-clutter guard),
	// so a session spawned in $HOME ends up working out of /tmp.
	std::vector<std::string> full_args = args;
	// non-session subcommands (omp login) take no --cwd
	if (pin_cwd) { full_args.push_back("--cwd"); full_args.push_back(dir); }
#if defined(_WIN32)
	// .cmd/.bat shims (npm .bin) and bare names need cmd's PATH+PATHEXT
	// resolution; real .exe paths spawn directly
	std::string inner = win_arg(omp_bin);
	for (auto& a : full_args) inner += " " + win_arg(a);
	std::string low = omp_bin;
	for (char& c : low) c = char(std::tolower(static_cast<unsigned char>(c)));
	bool via_cmd = omp_bin.find_first_of("/\\") == std::string::npos ||
	               (low.size() > 4 && (low.rfind(".cmd") == low.size() - 4 || low.rfind(".bat") == low.size() - 4));
	std::string cmdline = via_cmd ? "cmd.exe /d /s /c \"" + inner + "\"" : inner;
	// computer-use bridge creds for in-fork tools (rig_computer). Loopback
	// only: the child connects to the daemon's own bind address, which the
	// kernel delivers locally even when that address is the tailnet IP.
	WinSpawnOpts o{.want_stdin = true, .want_stdout = true, .merge_stderr = merge_stderr, .cwd = dir,
	               .env = {"OMPD_TOKEN=" + g_service_token,
	                       "OMPD_WS=ws://" + g_bind_ip + ":" + std::to_string(g_port) + "/ws",
	                       "OMPD_RIG_CALL=" + g_rig_call}};
	pid_t pid = win_spawn(cmdline, o, ch.stdin_fd, ch.stdout_fd, &err);
	if (pid <= 0) { err = "spawn failed: " + err; return ch; }
	ch.pid = pid;
	return ch;
#else
	int in_pipe[2], out_pipe[2];
	if (pipe(in_pipe) || pipe(out_pipe)) { err = "pipe failed"; return ch; }

	pid_t pid = fork();
	if (pid < 0) {
		err = "fork failed";
		::close(in_pipe[0]); ::close(in_pipe[1]);
		::close(out_pipe[0]); ::close(out_pipe[1]);
		return ch;
	}
	if (pid == 0) {
		setsid();
		dup2(in_pipe[0], STDIN_FILENO);
		dup2(out_pipe[1], STDOUT_FILENO);
		// auth children write their prompt/URL on stderr — merge so the
		// remote UI can stream it like a terminal.
		if (merge_stderr) dup2(out_pipe[1], STDERR_FILENO);
		::close(in_pipe[0]); ::close(in_pipe[1]);
		::close(out_pipe[0]); ::close(out_pipe[1]);
		if (chdir(dir.c_str()) != 0) { dprintf(2, "omprd child: chdir(%s) failed: %s\n", dir.c_str(), strerror(errno)); _exit(126); }
		// computer-use bridge creds for in-fork tools (rig_computer). Loopback
		// only: the child connects to the daemon's own bind address, which the
		// kernel delivers locally even when that address is the tailnet IP.
		setenv("OMPD_TOKEN", g_service_token.c_str(), 1);
		setenv("OMPD_WS", ("ws://" + g_bind_ip + ":" + std::to_string(g_port) + "/ws").c_str(), 1);
		setenv("OMPD_RIG_CALL", g_rig_call.c_str(), 1);
		std::vector<char*> argv;
		argv.push_back(const_cast<char*>(omp_bin.c_str()));
		for (auto& a : full_args) argv.push_back(const_cast<char*>(a.c_str()));
		argv.push_back(nullptr);
		execvp(omp_bin.c_str(), argv.data());
		dprintf(2, "omprd child: exec(%s) failed: %s\n", omp_bin.c_str(), strerror(errno));
		_exit(127);
	}
	::close(in_pipe[0]); ::close(out_pipe[1]);
	ch.pid = pid;
	ch.stdin_fd = in_pipe[1];
	ch.stdout_fd = out_pipe[0];
	return ch;
#endif
}

// argv assembly — spawn options land as omp flags
static std::vector<std::string> build_omp_args(const json& opts) {
	// No --no-ui: extension UI frames route over the wire so the phone renders
	// real approval cards (extension_ui_request → extension_ui_response).
	std::vector<std::string> args = {"--mode", "rpc"};
	if (opts.contains("tools") && opts["tools"].is_string() && !opts["tools"].get<std::string>().empty())
		args.push_back("--tools=" + opts["tools"].get<std::string>());
	if (opts.value("yolo", false)) args.push_back("--auto-approve");
	// thinking folds into the model spec (`provider/model:level`) — a separate
	// --thinking= flag leaves rpc sessions silent on some omp builds. The
	// rig's default applies when the client named a model but no level.
	std::string model = opts.contains("model") && opts["model"].is_string() ? opts["model"].get<std::string>() : "";
	if (model.empty()) model = first_configured_model();
	std::string think = opts.value("thinking", "");
	if (think.empty()) think = g_thinking_default;
	if (think.size() && model.find(':') == std::string::npos) model += ":" + think;
	if (model.size()) args.push_back("--model=" + model);
	// rig self-awareness: the agent inside knows session.spawn & friends
	// exist and when to use them (text is inline, so it survives installs
	// where no file path would be stable)
	args.push_back("--append-system-prompt=" + std::string(RIG_CAPS_PROMPT));
	return args;
}

static std::string spawn_sig(const std::string& dir, const std::string& omp_bin,
                             const std::vector<std::string>& args) {
	std::string s = dir + "\n" + omp_bin;
	for (auto& a : args) { s += '\n'; s += a; }
	return s;
}

struct WarmChild {
	pid_t pid{-1};
	int stdin_fd{-1};
	int stdout_fd{-1};
	std::string sig;
	// pre-handshake lines the readiness reader skipped (omp's "ready" banner
	// and any banner noise) — emitted into the adopting session's ring so a
	// warm-adopted session replays the same since:0 history a cold start does
	std::vector<std::string> pre;
	// 0 = handshaking, 1 = ready (adoptable — reader thread finished), 2 = dead
	// single atomic so adoption/reaping can't tear between two flags
	std::atomic<int> st{0};
	// when it became ready — a spare nobody adopted in RIG_WARM_IDLE_MS is
	// just a fat idle bun process; the sweep retires it
	std::atomic<int64_t> ready_ms{0};
};

static std::vector<WarmChild*> g_warm;
static std::mutex g_warm_mutex;
static const size_t g_warm_max = [] {
	const char* e = getenv("RIG_WARM_MAX");
	return e ? size_t(std::max(0, std::atoi(e))) : size_t(2);
}();
static const bool g_warm_on = [] {
	const char* e = getenv("RIG_WARM");
	return !(e && std::string(e) == "0");
}();

// spawns one spare for `sig`; a byte-wise reader consumes exactly the
// handshake line and marks the spare ready — adoption can then hand the pipe
// to a session with no buffered bytes lost and no second handshake needed
static void warm_spawn(const std::string& dir, const std::string& omp_bin,
                       const std::vector<std::string>& args, const std::string& sig) {
	std::string err;
	OmpChild ch = spawn_omp_child(dir, omp_bin, args, err);
	if (ch.pid < 0) { log("warm spawn failed: " + err); return; }
	auto* w = new WarmChild;
	w->pid = ch.pid; w->stdin_fd = ch.stdin_fd; w->stdout_fd = ch.stdout_fd; w->sig = sig;
	{
		std::lock_guard<std::mutex> lock(g_warm_mutex);
		g_warm.push_back(w);
	}
	static const std::string hs = "{\"id\":\"omprd-handshake\",\"type\":\"negotiate_protocol\",\"protocolVersion\":2}\n";
	if (file_write(ch.stdin_fd, hs.data(), hs.size()) != (ssize_t)hs.size()) {
		w->st = 2;
		return;
	}
	std::thread([w] {
		// omp prints a {"type":"ready"} announcement before answering —
		// consume lines until the handshake response; any other line is
		// skipped (it never carries bytes the session would need later:
		// pre-handshake output is just the readiness banner)
		std::string line;
		char c;
		int64_t deadline = now_ms() + 15000;
		while (w->st == 0 && now_ms() < deadline) {
			if (!pipe_wait(w->stdout_fd, int(std::max<int64_t>(1, deadline - now_ms())))) break;
			ssize_t n = file_read(w->stdout_fd, &c, 1);
			if (n <= 0) break;
			if (c == '\n') {
				try {
					json j = json::parse(line);
					if (j.value("type", "") == "response" && j.value("id", "") == "omprd-handshake") {
						if (j.value("success", false)) { w->ready_ms = now_ms(); w->st = 1; }
						else { log("warm spare refused protocol v2: " + line.substr(0, 120)); w->st = 2; }
						return;
					}
					// non-handshake line (e.g. the readiness banner) — keep reading
				} catch (...) { /* banner noise isn't guaranteed JSON either */ }
				if (w->pre.size() < 64) w->pre.push_back(line);
				line.clear();
				continue;
			}
			if (c != '\r') line.push_back(c);
			if (line.size() > (1u << 16)) break;
		}
		if (w->st == 0) w->st = 2;
	}).detach();
}

// keeps ≤1 spare per signature in flight and the whole pool under the cap
static void maybe_warm(const std::string& dir, const std::string& omp_bin,
                       const std::vector<std::string>& args, const std::string& sig) {
	if (!g_warm_on || g_warm_max == 0) return;
	{
		std::lock_guard<std::mutex> lock(g_warm_mutex);
		size_t for_sig = 0, live = 0;
		for (auto* w : g_warm) {
			if (w->st == 2) continue;
			live++;
			if (w->sig == sig) for_sig++;
		}
		if (for_sig >= 1 || live >= g_warm_max) return;
	}
	warm_spawn(dir, omp_bin, args, sig);
}

// takes a ready spare for `sig` out of the pool; waits up to ~2 s for one
// still mid-handshake before falling back to a cold spawn
static WarmChild* warm_adopt(const std::string& sig) {
	if (!g_warm_on) return nullptr;
	int64_t deadline = now_ms() + 2000;
	for (;;) {
		bool pending = false;
		{
			std::lock_guard<std::mutex> lock(g_warm_mutex);
			for (auto* w : g_warm) {
				if (w->st == 2 || w->sig != sig) continue;
				if (w->st == 1) {
					g_warm.erase(std::find(g_warm.begin(), g_warm.end(), w));
					return w;
				}
				pending = true;
			}
		}
		if (!pending || now_ms() >= deadline) return nullptr;
		std::this_thread::sleep_for(std::chrono::milliseconds(25));
	}
}

static bool session_start(const std::string& id, const json& opts, std::string& err, Client* starter = nullptr) {
	{
		std::lock_guard<std::mutex> lock(g_sessions_mutex);
		if (g_sessions.count(id)) { err = "session id already exists"; return false; }
	}
	if (g_rig.locked) { err = "rig is locked"; return false; }
	std::string cwd = opts.value("cwd", "");
	std::string dir = cwd.empty() ? home_dir() : cwd;
	if (!fs::is_directory(dir)) { err = "cwd does not exist: " + dir; return false; }

	const std::string harness = opts.value("harness", "omp");
	if (harness != "omp") {
		if (harness != "claude") { err = "unknown harness: " + harness; return false; }
		// non-omp runtimes: no rpc handshake, no open_session bind, no warm
		// pool. Same pipes/pid lifecycle, translated in child_reader.
		std::string bin = opts.value("harnessBin", "");
		if (bin.empty()) bin = "claude";
		bool b_has_sep = bin.find_first_of("/\\") != std::string::npos;
		bool b_is_abs = !bin.empty() && bin[0] == '/';
#if defined(_WIN32)
		b_is_abs = bin.size() > 2 && bin[1] == ':';
#endif
		if (b_has_sep && !b_is_abs)
			bin = fs::absolute(bin).lexically_normal().string();
		std::vector<std::string> args = build_claude_args(opts, "");
		// pin_cwd=false — claude has no --cwd; the fork chdir()s anyway
		OmpChild ch = spawn_omp_child(dir, bin, args, err, false, false);
		if (ch.pid < 0) { err = "spawn " + harness + " failed: " + err; return false; }
		auto* s = new Session;
		s->id = id; s->cwd = dir; s->pid = ch.pid;
		s->stdin_fd = ch.stdin_fd; s->stdout_fd = ch.stdout_fd;
		s->running = true;
		s->starter = starter;
		s->started_acked = true; // no handshake to wait on
		s->spawn_opts = opts;
		s->harness = harness;
		s->branch = probe_git_branch(dir);
		s->last_active_ms.store(wall_ms());
		{
			std::lock_guard<std::mutex> lock(g_sessions_mutex);
			if (g_sessions.count(id)) {
				err = "session id already exists";
				kill(-s->pid, SIGKILL); kill(s->pid, SIGKILL);
				file_close(s->stdin_fd); file_close(s->stdout_fd);
				delete s;
				return false;
			}
			g_sessions[id] = s;
		}
		persist_meta(s);
#if defined(__APPLE__) || defined(_WIN32)
		if (native().init()) native().stay_awake(true);
#endif
		std::thread(child_reader, s, false).detach();
		if (starter && starter->alive)
			send_json(starter, {{"type", "session.started"}, {"sessionId", s->id},
			                    {"harness", harness}});
		log("session " + id + " started on " + harness + " harness (pid " +
		    std::to_string(proc_display_id(ch.pid)) + ", cwd " + dir + ")");
		return true;
	}

	std::string omp_bin = opts.value("ompBin", g_omp_bin);
	// children exec in the session's cwd — a relative path must be made absolute
	// or the exec fails ENOENT; slash-free names stay for the PATH lookup
	bool bin_has_sep = omp_bin.find_first_of("/\\") != std::string::npos;
	bool bin_is_abs = false;
#if defined(_WIN32)
	bin_is_abs = omp_bin.size() > 2 && omp_bin[1] == ':';
#else
	bin_is_abs = !omp_bin.empty() && omp_bin[0] == '/';
#endif
	if (bin_has_sep && !bin_is_abs)
		omp_bin = fs::absolute(omp_bin).lexically_normal().string();

	std::vector<std::string> args = build_omp_args(opts);
	const std::string sig = spawn_sig(dir, omp_bin, args);

	// adoption path: the spare already ran the handshake, so the session is
	// live immediately — session.new→started ≈ 0 ms instead of a cold boot
	if (WarmChild* w = warm_adopt(sig)) {
		auto* s = new Session;
		s->id = id; s->cwd = dir; s->pid = w->pid;
		s->stdin_fd = w->stdin_fd; s->stdout_fd = w->stdout_fd;
		s->running = true;
		s->starter = starter;
		s->started_acked = true;
		s->spawn_opts = opts;
		s->branch = probe_git_branch(dir);
		std::vector<std::string> pre = std::move(w->pre);
		delete w;
		{
			std::lock_guard<std::mutex> lock(g_sessions_mutex);
			if (g_sessions.count(id)) {
				err = "session id already exists";
				kill(-s->pid, SIGKILL);
				kill(s->pid, SIGKILL); // direct fallback for the pre-setsid window
				file_close(s->stdin_fd); file_close(s->stdout_fd);
				delete s;
				return false;
			}
			g_sessions[id] = s;
		}
		persist_meta(s);
#if defined(__APPLE__) || defined(_WIN32)
		if (native().init()) native().stay_awake(true);
#endif
		// the pool reader consumed the spare's pre-handshake output — emit it
		// into this session's ring (banner before session.started, exactly like
		// a cold start) so since:0 replay and the persisted log aren't empty
		for (std::string& l : pre) session_emit(s, std::move(l));
		std::thread(child_reader, s, true).detach();
		queue_open_session(s);
		if (starter && starter->alive)
			send_json(starter, {{"type", "session.started"}, {"sessionId", s->id}, {"warm", true}});
		log("session " + id + " adopted warm spare (pid " + std::to_string(proc_display_id(s->pid)) + ", cwd " + dir + ")");
		maybe_warm(dir, omp_bin, args, sig);
		return true;
	}

	OmpChild ch = spawn_omp_child(dir, omp_bin, args, err);
	if (ch.pid < 0) return false;

	auto* s = new Session;
	s->id = id; s->cwd = dir; s->pid = ch.pid;
	s->stdin_fd = ch.stdin_fd; s->stdout_fd = ch.stdout_fd;
	s->running = true;
	s->starter = starter;
	s->spawn_opts = opts;
	s->branch = probe_git_branch(dir);
	// seed the idle clock at spawn — a 0 would look infinitely idle to the
	// hibernation sweep and kill the child before it can handshake
	s->last_active_ms.store(wall_ms());
	{
		std::lock_guard<std::mutex> lock(g_sessions_mutex);
		if (g_sessions.count(id)) {
			err = "session id already exists";
			kill(-s->pid, SIGKILL);
			kill(s->pid, SIGKILL); // pre-setsid window
			file_close(s->stdin_fd); file_close(s->stdout_fd);
			delete s;
			return false;
		}
		g_sessions[id] = s;
	}
	persist_meta(s);
#if defined(__APPLE__) || defined(_WIN32)
	// live sessions mean the agent is working — hold the system awake
	// (IOPMAssertion / SetThreadExecutionState, no permission needed);
	// released when the last dies
	if (native().init()) native().stay_awake(true);
#endif
	std::thread(child_reader, s, false).detach();

	std::string hs = "{\"id\":\"omprd-handshake\",\"type\":\"negotiate_protocol\",\"protocolVersion\":2}\n";
	{
		std::lock_guard<std::mutex> wlock(s->write_mutex);
		if (!write_all_fd(s->stdin_fd, hs.data(), hs.size())) err = "handshake write failed";
	}
	queue_open_session(s);

	log("session " + id + " started (pid " + std::to_string(proc_display_id(ch.pid)) + ", cwd " + dir +
	    (args.size() > 3 ? ", flags " + std::to_string(args.size() - 3) : "") + ")");
	maybe_warm(dir, omp_bin, args, sig);
	return true;
}

static void session_kill(const std::string& id, int sig = SIGTERM) {
	Session* s = find_session(id);
	if (!s || s->pid <= 0) return;
	kill(-s->pid, sig); // process group (setsid)
	kill(s->pid, sig);  // covers the fork→setsid window where the group doesn't exist yet
	if (sig == SIGKILL || sig == SIGTERM) {
		// escalation watchdog: a TERMed omp child that ignores the signal gets
		// SIGKILL'd after a short grace — session.kill must actually kill.
		// Re-resolves the session pointer: the reaper may have retired/replaced it.
		pid_t victim = s->pid;
		std::thread([id, victim]() {
			for (int i = 0; i < 30; i++) {
				std::this_thread::sleep_for(std::chrono::milliseconds(100));
				std::lock_guard<std::mutex> lock(g_sessions_mutex);
				auto it = g_sessions.find(id);
				if (it == g_sessions.end() || it->second->pid != victim || !it->second->running) return;
			}
			std::lock_guard<std::mutex> lock(g_sessions_mutex);
			auto it = g_sessions.find(id);
			if (it != g_sessions.end() && it->second->pid == victim && it->second->running) {
				kill(-victim, SIGKILL);
				kill(victim, SIGKILL);
			}
		}).detach();
	}
}

// Bind the omp child to this rig session's own transcript dir
// (~/.rig/sessions/<id>/omp/). omp persists its conversation there; a fresh
// child told to open the same dir resumes the MOST RECENT session file — so
// agent memory survives daemon restarts, not just wire history. Sent right
// after the handshake; the serial command queue orders it first in line.
static void queue_open_session(Session* s) {
	try { fs::create_directories(rig_sessions_dir() / s->id / "omp"); } catch (...) {}
	std::string dir = (rig_sessions_dir() / s->id / "omp").string();
	std::string frame = "{\"id\":\"omprd-open\",\"type\":\"open_session\",\"sessionDir\":\"" + dir + "\"}\n";
	std::lock_guard<std::mutex> wlock(s->write_mutex);
	write_all_fd(s->stdin_fd, frame.data(), frame.size());
}

// Lazy respawn for a restored session: its ring/preview survived on disk but
// the omp child's pipes died with the last daemon. A fresh child starts under
// the same session id — the app never sees the restart beyond a resumed
// broadcast; prior frames replay from the persisted log.
static bool session_resume(Session* s, std::string& err) {
	std::lock_guard<std::mutex> lock(s->resume_mutex);
	if (s->running && s->stdin_fd >= 0) return true; // resumer raced us and won
	if (g_rig.locked) { err = "rig is locked"; return false; }
	std::string dir = s->cwd.empty() ? home_dir() : s->cwd;
	if (!fs::is_directory(dir)) dir = home_dir();

	// non-omp harness: respawn the translated child and continue the same
	// conversation — claude's --resume carries it by conv id.
	if (s->harness != "omp") {
		std::string bin = s->spawn_opts.value("harnessBin", "");
		if (bin.empty()) bin = "claude";
		bool b_has_sep = bin.find_first_of("/\\") != std::string::npos;
		bool b_is_abs = !bin.empty() && bin[0] == '/';
#if defined(_WIN32)
		b_is_abs = bin.size() > 2 && bin[1] == ':';
#endif
		if (b_has_sep && !b_is_abs)
			bin = fs::absolute(bin).lexically_normal().string();
		std::vector<std::string> args = build_claude_args(s->spawn_opts, s->conv_id);
		OmpChild ch = spawn_omp_child(dir, bin, args, err, false, false);
		if (ch.pid < 0) return false;
		s->pid = ch.pid;
		s->stdin_fd = ch.stdin_fd;
		s->stdout_fd = ch.stdout_fd;
		s->running = true;
		s->last_active_ms.store(wall_ms());
		std::thread(child_reader, s, false).detach();
		broadcast("{\"type\":\"session.started\",\"sessionId\":\"" + s->id + "\",\"resumed\":true}");
		log("session " + s->id + " resumed on fresh " + s->harness + " child (pid " +
		    std::to_string(proc_display_id(ch.pid)) + ")");
		return true;
	}

	std::string omp_bin = s->spawn_opts.value("ompBin", g_omp_bin);
	bool bin_has_sep = omp_bin.find_first_of("/\\") != std::string::npos;
	bool bin_is_abs = false;
#if defined(_WIN32)
	bin_is_abs = omp_bin.size() > 2 && omp_bin[1] == ':';
#else
	bin_is_abs = !omp_bin.empty() && omp_bin[0] == '/';
#endif
	if (bin_has_sep && !bin_is_abs)
		omp_bin = fs::absolute(omp_bin).lexically_normal().string();

	std::vector<std::string> args = build_omp_args(s->spawn_opts);
	OmpChild ch = spawn_omp_child(dir, omp_bin, args, err);
	if (ch.pid < 0) return false;
	s->pid = ch.pid;
	s->stdin_fd = ch.stdin_fd;
	s->stdout_fd = ch.stdout_fd;
	s->running = true;
	// respawn is fresh activity — without this a hibernated session brought
	// back would instantly re-hibernate on its stale timestamp
	s->last_active_ms.store(wall_ms());
	std::thread(child_reader, s, false).detach();
	std::string hs = "{\"id\":\"omprd-handshake\",\"type\":\"negotiate_protocol\",\"protocolVersion\":2}\n";
	{
		std::lock_guard<std::mutex> wlock(s->write_mutex);
		write_all_fd(s->stdin_fd, hs.data(), hs.size());
	}
	queue_open_session(s);
	// the transcript replay that follows open_session is already in our log
	s->suppress_until_ms.store(now_ms() + 30000);
	s->suppress_emit.store(true);
	broadcast("{\"type\":\"session.started\",\"sessionId\":\"" + s->id + "\",\"resumed\":true}");
	log("session " + s->id + " resumed on fresh omp child (pid " +
	    std::to_string(proc_display_id(ch.pid)) + ")");
	return true;
}

// Idle hibernation — an untouched, not-busy session's omp child costs
// ~50-200 MB of RSS to hold open forever. Hibernate retires the child but
// keeps the session + transcripts in place: the next request lazily
// respawns via session_resume (open_session replays the agent's own
// transcript, so memory survives the swap). pid is cleared BEFORE the kill
// so the reaper's erase-on-death path never sees this session.
// RIG_IDLE_MS overrides the 15-minute default; 0 disables the sweep.
static int64_t idle_ms_limit() {
	static int64_t v = [] {
		const char* e = getenv("RIG_IDLE_MS");
		return e ? std::max<int64_t>(0, atoll(e)) : 15LL * 60 * 1000;
	}();
	return v;
}

static void session_hibernate(Session* s) {
	// caller holds g_sessions_mutex
	if (s->busy.load() || s->pid <= 0) return;
	pid_t victim = s->pid;
	s->pid = -1;
	s->running = false; // child_reader exits on the EOF that follows
	{
		std::lock_guard<std::mutex> wlock(s->write_mutex);
		if (s->stdin_fd >= 0) { file_close(s->stdin_fd); s->stdin_fd = -1; }
	}
	{
		// in-flight asks die with the child — tell them why instead of hanging
		std::lock_guard<std::mutex> plock(s->pending_mutex);
		for (auto& [rid, pr] : s->pending) {
			if (pr->client && pr->client->alive) {
				const std::string& out_id = pr->client_id.empty() ? rid : pr->client_id;
				enqueue_out(pr->client, "{\"type\":\"error\",\"sessionId\":\"" + s->id +
				            "\",\"id\":\"" + out_id + "\",\"error\":\"session hibernated\"}");
			}
			delete pr;
		}
		s->pending.clear();
	}
	kill(-victim, SIGTERM);
	kill(victim, SIGTERM);
	// The corpse is ours now — pid==-1 hides it from the reaper, so a stray
	// waitpid here keeps it from zombifying; escalate if it ignores TERM.
	std::thread([victim]() {
		for (int i = 0; i < 50; i++) {
			pid_t r = waitpid(victim, nullptr, WNOHANG);
			if (r == victim || (r < 0 && errno == ECHILD)) return;
			std::this_thread::sleep_for(std::chrono::milliseconds(100));
		}
		kill(-victim, SIGKILL);
		kill(victim, SIGKILL);
		waitpid(victim, nullptr, 0);
	}).detach();
	persist_meta(s);
	broadcast("{\"type\":\"session.hibernated\",\"sessionId\":\"" + s->id + "\"}");
	log("session " + s->id + " hibernated (idle omp child retired)");
}

// Boot-time restore: rebuild sessions from ~/.rig/sessions so a daemon
// restart (crash, upgrade, reboot) keeps the phone's inbox and thread
// history. Sessions come back idle — no child until the next prompt.
// First user text in the log becomes the thread title — harvested at
// restore for sessions that predate daemon title capture.
static std::string title_from_user_line(const std::string& raw) {
	if (raw.find("user") == std::string::npos) return "";
	try {
		auto j = json::parse(raw);
		if (j_str(j, "type") != "message_start" && j_str(j, "type") != "message_end")
			return "";
		const json& m = j.contains("message") ? j["message"] : j;
		if (j_str(m, "role") != "user") return "";
		std::string t;
		if (m.contains("content") && m["content"].is_string())
			t = m["content"].get<std::string>();
		else if (m.contains("content") && m["content"].is_array())
			for (auto& b : m["content"])
				if (b.is_object() && j_str(b, "type") == "text") { t = j_str(b, "text"); break; }
		size_t nl = t.find('\n');
		if (nl != std::string::npos) t.resize(nl);
		if (t.size() > 80) t.resize(80);
		return t;
	} catch (...) { return ""; }
}

static void restore_sessions() {
	fs::path dir = rig_sessions_dir();
	std::error_code ec;
	if (!fs::is_directory(dir, ec)) return;
#if !defined(_WIN32)
	// generic orphan sweep: when a daemon dies its omp children reparent to
	// init, so ppid==1 + our cli.ts --mode rpc signature = provably ours.
	// Catches session children AND warm spares (which have no meta pid).
	if (FILE* pp = popen("ps -axo ppid=,pid=,command= 2>/dev/null", "r")) {
		char b[1024];
		while (fgets(b, sizeof(b), pp)) {
			long ppid = 0, pid = 0;
			char cmd[768] = {0};
			if (sscanf(b, "%ld %ld %767[^\n]", &ppid, &pid, cmd) == 3
			    && ppid == 1 && strstr(cmd, "cli.ts --mode rpc")) {
				kill(pid_t(-pid), SIGTERM);
				kill(pid_t(pid), SIGTERM);
				log("reaped orphaned omp child " + std::to_string(pid));
			}
		}
		pclose(pp);
	}
#endif
	size_t n = 0;
	for (auto& ent : fs::directory_iterator(dir, ec)) {
		if (ent.path().extension() != ".json" ||
		    ent.path().filename().string().size() < 10 ||
		    ent.path().filename().string().substr(ent.path().filename().string().size() - 10) != ".meta.json")
			continue;
		try {
			json meta;
			{ std::ifstream f(ent.path()); meta = json::parse(f); }
			std::string id = meta.value("id", "");
			if (id.empty()) continue;
#if !defined(_WIN32)
			// orphan reap: a previous daemon died without its cleanup path
			// (crash, SIGKILL, power) leaving the child — ~450 MB of bun —
			// running. meta records the pid it last spawned; if that pid is
			// still alive and still an rpc-mode omp child (ps cmdline match
			// guards pid reuse), it belongs to a dead daemon: TERM the group.
			{
				int64_t old_pid = meta.value("pid", int64_t(0));
				if (old_pid > 0 && kill(pid_t(old_pid), 0) == 0) {
					std::string cmd = "ps -o command= -p " + std::to_string(old_pid) + " 2>/dev/null";
					std::string line;
					if (FILE* pp = popen(cmd.c_str(), "r")) {
						char b[512];
						while (fgets(b, sizeof(b), pp)) line += b;
						pclose(pp);
					}
					if (line.find("--mode rpc") != std::string::npos) {
						kill(pid_t(-old_pid), SIGTERM);
						kill(pid_t(old_pid), SIGTERM);
						log("reaped orphaned omp child " + std::to_string(old_pid) + " of " + id);
					}
				}
			}
#endif
			auto* s = new Session;
			s->id = id;
			s->cwd = meta.value("cwd", home_dir());
			s->branch = probe_git_branch(s->cwd);
			s->created_ms = meta.value("created", wall_ms());
			s->title = meta.value("title", "");
			s->spawn_opts = meta.contains("opts") && meta["opts"].is_object() ? meta["opts"] : json::object();
			s->parent_id = meta.value("parent", s->spawn_opts.value("parentId", ""));
			s->pinned = meta.value("pinned", false);
			s->hidden = meta.value("hidden", false);
			s->last_read_seq = meta.value("lastReadSeq", int64_t(0));
			s->harness = meta.value("harness", "omp");
			s->conv_id = meta.value("convId", "");
			s->restored = true;
			s->started_acked = true;
			fs::path log_path = dir / (id + ".jsonl");
			int64_t last_write = 0;
			std::error_code ec2;
			auto ftime = fs::last_write_time(log_path, ec2);
			if (!ec2) {
				auto sctp = std::chrono::time_point_cast<std::chrono::system_clock::duration>(
					ftime - decltype(ftime)::clock::now() + std::chrono::system_clock::now());
				last_write = std::chrono::system_clock::to_time_t(sctp) * 1000;
			}
			std::ifstream lf(log_path);
			std::string line;
			uint64_t seq = 0;
			while (std::getline(lf, line)) {
				if (line.empty()) continue;
				if (!line.empty() && line.back() == '\r') line.pop_back();
				seq++;
				harvest_preview(s, line);
				if (s->title.empty()) s->title = title_from_user_line(line);
				s->ring.emplace_back(seq, std::make_shared<const std::string>(line));
				s->ring_bytes += line.size();
			}
			// a kill mid-fwrite can only tear the TAIL line (the log is
			// append-only), so strict-parsing just the last frame replaces
			// the old per-line parse — hundreds of MB of transcripts used to
			// take ~a minute of boot CPU, now only the tail is validated
			if (!s->ring.empty() &&
			    json::parse(*s->ring.back().second, nullptr, false).is_discarded()) {
				s->ring_bytes -= s->ring.back().second->size();
				s->ring.pop_back();
				seq--;
			}
			s->seq.store(seq);
			while (s->ring_bytes > Session::RING_MAX_BYTES || s->ring.size() > Session::RING_MAX_ENTRIES) {
				if (s->ring.empty()) break;
				s->ring_bytes -= s->ring.front().second->size();
				s->ring.pop_front();
			}
			s->last_active_ms = last_write ? last_write : s->created_ms;
			if (!s->title.empty()) persist_meta(s); // keep the harvested title
			{
				std::lock_guard<std::mutex> lock(g_sessions_mutex);
				g_sessions[id] = s;
			}
			n++;
		} catch (...) {}
	}
	if (n) log("restored " + std::to_string(n) + " session(s) from disk");
}

static void fanout_sweep() {
	// expire stuck fan-outs and requests; deliver partial results
	std::lock_guard<std::mutex> lock(g_fanout_mutex);
	int64_t t = now_ms();
	for (size_t i = 0; i < g_fanouts.size();) {
		Fanout* f = g_fanouts[i];
		if (t > f->deadline_ms) {
			json reply = {{"type", f->reply_type}, {"results", f->collected}, {"partial", true}};
			if (!f->req_id.empty()) reply["id"] = f->req_id;
			if (f->client && f->client->alive) enqueue_out(f->client, reply.dump());
			delete f;
			g_fanouts.erase(g_fanouts.begin() + long(i));
			continue;
		}
		i++;
	}
	{
		std::lock_guard<std::mutex> slock(g_sessions_mutex);
		for (auto& [id, s] : g_sessions) {
			std::lock_guard<std::mutex> plock(s->pending_mutex);
			for (auto it = s->pending.begin(); it != s->pending.end();) {
				if (t > it->second->deadline_ms) {
					PendingRequest* pr = it->second;
					// expiry used to delete silently — the client's session.request
					// then hung forever. Answer it instead.
					if (pr->client && pr->client->alive) {
						const std::string& out_id = pr->client_id.empty() ? pr->id : pr->client_id;
						enqueue_out(pr->client, "{\"type\":\"error\",\"sessionId\":\"" + s->id +
						            "\",\"id\":\"" + out_id + "\",\"error\":\"omp request timed out\"}");
					}
					delete pr;
					it = s->pending.erase(it);
				} else {
					++it;
				}
			}
		}
	}
}

static void reap_and_cleanup() {
	while (!g_stop) {
		{
			std::lock_guard<std::mutex> lock(g_sessions_mutex);
			for (auto it = g_sessions.begin(); it != g_sessions.end();) {
				Session* s = it->second;
				// restored sessions sit childless until the next prompt respawns
				// omp — waitpid(-1) would spuriously 'reap' them and torch their
				// persisted history, so they never enter this path
				if (s->pid <= 0) { ++it; continue; }
				int status = 0;
				pid_t r = waitpid(s->pid, &status, WNOHANG);
				if (r == s->pid || (r < 0 && errno == ECHILD)) {
					int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
					uint64_t last_seq = s->seq.load();
					broadcast("{\"type\":\"session.exited\",\"sessionId\":\"" + s->id +
					          "\",\"code\":" + std::to_string(code) +
					          ",\"lastSeq\":" + std::to_string(last_seq) + "}");
					log("session " + s->id + " exited code=" + std::to_string(code));
					s->running = false;
			s->busy = false;
					{
						// gate in-flight session_request writes before closing the
						// fd — a recycled fd number could otherwise be written to
						std::lock_guard<std::mutex> wlock(s->write_mutex);
						if (s->stdin_fd >= 0) { file_close(s->stdin_fd); s->stdin_fd = -1; }
					}
					// stdout_fd is owned by the child_reader thread — it closes
					// it on exit; never here (recycled-fd reads)
					{
						// ring_mutex serializes the persist stream: a late-flushing
						// reader can't fwrite through a closed FILE*
						std::lock_guard<std::mutex> rl(s->ring_mutex);
						if (s->persist_fp) { fclose(s->persist_fp); s->persist_fp = nullptr; }
						// a dead session's persisted state has no future — drop it so
						// the dir doesn't fill with finished history. Except during
						// shutdown: a SIGHUP'd child reaped mid-exit must keep its
						// log — boot restore is the whole point
						if (!g_stop) {
							std::error_code rmec;
							fs::remove(rig_sessions_dir() / (s->id + ".meta.json"), rmec);
							fs::remove(rig_sessions_dir() / (s->id + ".jsonl"), rmec);
						}
					}
					{
						std::lock_guard<std::mutex> plock(s->pending_mutex);
						for (auto& [rid, pr] : s->pending) {
							// an in-flight request must not hang forever — tell the
							// asker the session died underneath it
							if (pr->client && pr->client->alive) {
								const std::string& out_id = pr->client_id.empty() ? rid : pr->client_id;
								enqueue_out(pr->client, "{\"type\":\"error\",\"sessionId\":\"" + s->id +
								            "\",\"id\":\"" + out_id + "\",\"error\":\"session exited\"}");
							}
							delete pr;
						}
						s->pending.clear();
					}
					{ // drop this session's delivery marks — ids are user-supplied,
					  // so a recycled id must not inherit exactly-once state
						std::lock_guard<std::mutex> clk(g_clients_mutex);
						for (Client* cl : g_clients) {
							std::lock_guard<std::mutex> sl(cl->seq_mutex);
							cl->live_lo.erase(s->id);
							cl->live_hi.erase(s->id);
							cl->replayed_hi.erase(s->id);
						}
					}
#if !defined(__APPLE__) && !defined(_WIN32)
					// free the session's claimed desktop — abrupt child death used
					// to leak the index (and _NET_NUMBER_OF_DESKTOPS) forever
					if (s->desktop >= 0) desktop_release(s->desktop_disp, s->desktop);
#endif
					retire([s] { delete s; });
					it = g_sessions.erase(it);
				} else {
					// stalled-provider watchdog: a busy session that has emitted no
					// frame for 90s almost surely has a wedged model stream (seen
					// live: vision calls hanging mid-turn at high completion). Flag
					// it once so clients can say so — we never kill the turn here.
					if (s->busy.load() && wall_ms() - s->last_active_ms.load() > 90000
					    && !s->stall_flagged.exchange(true))
						broadcast("{\"type\":\"session.stalled\",\"sessionId\":\"" + s->id +
					          "\",\"silentMs\":" + std::to_string(wall_ms() - s->last_active_ms.load()) + "}");
					// idle hibernation: sessions nobody has touched in
					// RIG_IDLE_MS give their omp child back to the OS — the
					// transcript stays, the next prompt respawns it lazily.
					// started_acked gates it: a session mid-handshake isn't idle,
					// it's still being born.
					int64_t lim = idle_ms_limit();
					if (lim > 0 && !s->busy.load() && s->started_acked.load()
					    && wall_ms() - s->last_active_ms.load() > lim)
						session_hibernate(s);
					++it;
				}
			}
#if defined(__APPLE__) || defined(_WIN32)
			// checked under the session lock so a racing session_start's
			// stay_awake(true) can't be dropped after it fires
			if (g_sessions.empty() && !g_keep_awake_persistent.load()) native().stay_awake(false);
#endif
		}
		{
			// reap dead/dropped warm spares. stdout_fd is owned by the spare's
			// handshake-reader thread — only close it once that thread has
			// finished (st != 0), else a recycled fd could be read by it.
			// Ready spares have a TTL too: a spare nobody adopts within
			// RIG_WARM_IDLE_MS (default 10m, 0 disables) gets marked dead and
			// the same kill+reap path retires it — an unadopted spare is just
			// ~100-200 MB of idle bun held against a maybe.
			static const int64_t warm_idle_lim = [] {
				const char* e = getenv("RIG_WARM_IDLE_MS");
				return e ? std::max<int64_t>(0, atoll(e)) : 10LL * 60 * 1000;
			}();
			std::lock_guard<std::mutex> lock(g_warm_mutex);
			for (size_t i = 0; i < g_warm.size();) {
				WarmChild* w = g_warm[i];
				if (w->st == 1 && warm_idle_lim > 0
				    && now_ms() - w->ready_ms.load() > warm_idle_lim) {
					w->st = 2;
					log("warm spare retired (unadopted past TTL)");
				}
				int status = 0;
				pid_t r = waitpid(w->pid, &status, WNOHANG);
				if (w->st == 2) kill(w->pid, SIGKILL);
				if ((r == w->pid || (r < 0 && errno == ECHILD)) && w->st != 0) {
					file_close(w->stdin_fd); file_close(w->stdout_fd);
					g_warm.erase(g_warm.begin() + long(i));
					retire([w] { delete w; });
					continue;
				}
				i++;
			}
		}
		fanout_sweep();
		retire_sweep();
		jobs_sweep();
		g_rig.locked = fs::exists(g_rig.dir / "locked"); // live kill-switch
		std::this_thread::sleep_for(std::chrono::milliseconds(300));
	}
}

// ---------------------------------------------------------------------------
// Scheduled prompts — Grok "Routines" / OpenClaw heartbeats: replay a prompt
// on an interval against a fresh session. Persisted to ~/.rig/jobs.json so a
// daemon restart doesn't lose routines; a mid-fire flag never survives
// restart (the interval still governs the next run).

struct SchedJob {
	std::string id, prompt, cwd, model;
	int64_t every_sec = 0;
	int64_t next_run_ms = 0, last_run_ms = 0;
	bool enabled = true;
	std::string firing_session; // spawned session, prompt not yet delivered
	int64_t firing_deadline_ms = 0; // handshake can hang forever — give up + retry
};
static std::mutex g_jobs_mutex;
static std::vector<SchedJob> g_jobs;

static void jobs_save_locked() {
	json arr = json::array();
	for (auto& j : g_jobs)
		arr.push_back({{"id", j.id},           {"prompt", j.prompt},
		               {"cwd", j.cwd},         {"model", j.model},
		               {"everySec", j.every_sec}, {"nextRunMs", j.next_run_ms},
		               {"lastRunMs", j.last_run_ms}, {"enabled", j.enabled}});
	try { std::ofstream(g_rig.dir / "jobs.json") << arr.dump(); } catch (...) {}
}

static void jobs_load() {
	try {
		std::ifstream f(g_rig.dir / "jobs.json");
		if (!f) return;
		json arr = json::parse(f);
		std::lock_guard<std::mutex> lock(g_jobs_mutex);
		for (auto& j : arr) {
			SchedJob s;
			s.id = j.value("id", "");
			s.prompt = j.value("prompt", "");
			s.cwd = j.value("cwd", "");
			s.model = j.value("model", "");
			s.every_sec = j.value("everySec", int64_t(0));
			s.next_run_ms = j.value("nextRunMs", int64_t(0));
			s.last_run_ms = j.value("lastRunMs", int64_t(0));
			s.enabled = j.value("enabled", true);
			if (!s.id.empty() && !s.prompt.empty() && s.every_sec > 0)
				g_jobs.push_back(std::move(s));
		}
	} catch (...) {}
}

static json jobs_json_locked() {
	json arr = json::array();
	for (auto& j : g_jobs)
		arr.push_back({{"id", j.id},           {"prompt", j.prompt},
		               {"cwd", j.cwd},         {"model", j.model},
		               {"everySec", j.every_sec}, {"nextRunMs", j.next_run_ms},
		               {"lastRunMs", j.last_run_ms}, {"enabled", j.enabled},
		               {"firing", !j.firing_session.empty()}});
	return arr;
}

// Reaper calls this each 300ms sweep — due jobs spawn through the same
// session_start path clients use; the prompt goes out the moment the child
// reports running (fire-and-forget request: the turn's frames broadcast
// normally so every client sees the routine working).
static void jobs_sweep() {
	int64_t now = wall_ms();
	std::vector<std::pair<std::string, SchedJob>> due;
	std::vector<std::pair<std::string, std::string>> firing; // jobId, sessionId
	std::vector<std::string> wedged; // fired sessions that never came up
	{
		std::lock_guard<std::mutex> lock(g_jobs_mutex);
		for (auto& j : g_jobs) {
			if (!j.enabled) continue;
			if (!j.firing_session.empty()) {
				if (j.firing_deadline_ms && now > j.firing_deadline_ms) {
					wedged.push_back(j.firing_session);
					j.firing_session.clear(); // fall through, re-fire next interval
					j.firing_deadline_ms = 0;
				} else { firing.push_back({j.id, j.firing_session}); continue; }
			}
			if (now >= j.next_run_ms) {
				j.next_run_ms = now + j.every_sec * 1000; // reserve the slot now
				due.push_back({j.id, j});
			}
		}
		if (!wedged.empty()) jobs_save_locked();
	}
	// kill OUTSIDE g_jobs_mutex — session_kill takes g_sessions_mutex and
	// Phase B's find_session holds sessions→jobs the other way
	for (auto& ws : wedged) session_kill(ws);
	for (auto& [jid, job] : due) {
		std::string sid = rig::random_hex(4), err;
		json opts = {{"cwd", job.cwd}};
		if (!job.model.empty()) opts["model"] = job.model;
		if (session_start(sid, opts, err, nullptr)) {
			std::lock_guard<std::mutex> lock(g_jobs_mutex);
			for (auto& j : g_jobs)
				if (j.id == jid) {
					j.firing_session = sid; j.last_run_ms = now;
					j.firing_deadline_ms = now + 30000; // warm ~2ms, cold ~1.4s; 30s = generous
				}
			jobs_save_locked();
			broadcast("{\"type\":\"schedule.fired\",\"jobId\":\"" + jid +
			          "\",\"sessionId\":\"" + sid + "\"}");
		} else {
			broadcast("{\"type\":\"schedule.error\",\"jobId\":\"" + jid +
			          "\",\"error\":" + json(err).dump() + "}");
		}
	}
	for (auto& [jid, sid] : firing) {
		Session* s = find_session(sid);
		if (!s) {
			std::lock_guard<std::mutex> lock(g_jobs_mutex);
			for (auto& j : g_jobs) if (j.id == jid) { j.firing_session.clear(); j.firing_deadline_ms = 0; }
			jobs_save_locked();
			continue;
		}
		if (!s->running.load()) continue; // still handshaking — deadline re-fires
		std::string prompt;
		{
			std::lock_guard<std::mutex> lock(g_jobs_mutex);
			for (auto& j : g_jobs)
				if (j.id == jid) { prompt = j.prompt; j.firing_session.clear(); j.firing_deadline_ms = 0; }
			jobs_save_locked();
		}
		if (!prompt.empty())
			session_request(s, json{{"type", "prompt"}, {"message", prompt}},
			                nullptr, nullptr, 300000);
	}
}

// ---------------------------------------------------------------------------
// WebSocket frame reader (client → daemon)
// ---------------------------------------------------------------------------

static bool ws_recv(Client* c, std::string& out) {
	out.clear();
	auto read_exact = [&](uint8_t* p, size_t n) -> bool {
		size_t off = 0;
		while (off < n) {
			ssize_t r = net_recv(c->fd, p + off, n - off, 0);
			if (r <= 0) return false;
			off += size_t(r);
		}
		return true;
	};
	bool first = true;
	for (;;) {
		uint8_t hdr[2];
		if (!read_exact(hdr, 2)) return false;
		bool fin = hdr[0] & 0x80;
		int op = hdr[0] & 0x0F;
		bool masked = hdr[1] & 0x80;
		uint64_t len = hdr[1] & 0x7F;
		if (len == 126) {
			uint8_t ext[2];
			if (!read_exact(ext, 2)) return false;
			len = (uint64_t(ext[0]) << 8) | ext[1];
		} else if (len == 127) {
			uint8_t ext[8];
			if (!read_exact(ext, 8)) return false;
			len = 0;
			for (int i = 0; i < 8; i++) len = (len << 8) | ext[i];
		}
		if (len > 64 * 1024 * 1024) return false;
		uint8_t mask_key[4] = {0, 0, 0, 0};
		if (masked && !read_exact(mask_key, 4)) return false;
		if (op == 8) return false;                       // close
		if (op >= 8) {                                   // ping/pong control
			if (!fin || len > 125) return false;           // control frames: never fragmented, ≤125
			std::string payload(len, 0);
			if (len && !read_exact(reinterpret_cast<uint8_t*>(payload.data()), len)) return false;
			if (masked)
				for (uint64_t i = 0; i < len; i++) payload[size_t(i)] ^= mask_key[i & 3];
			if (op == 9) {                                 // ping → pong (unmasked payload)
				std::string pong;
				pong.push_back(char(0x8A - 0x100)); pong.push_back(char(len));
				pong += payload;
				enqueue_out(c, "__RAW__" + pong);
			}
			continue; // op==10 pong: consumed above — its payload never reached the stream
		}
		if (op != 0 && op != 1 && op != 2) return false; // unknown opcode — refuse, don't desync
		std::string payload(len, 0);
		if (len && !read_exact(reinterpret_cast<uint8_t*>(payload.data()), len)) return false;
		if (masked)
			for (uint64_t i = 0; i < len; i++) payload[size_t(i)] ^= mask_key[i & 3];
		if (first) first = false;
		out += payload;
		if (fin) return true;
	}
}

static std::string header_value(const std::string& req, const std::string& name) {
	std::string needle = name;
	for (char& ch : needle) ch = char(std::tolower(unsigned(ch)));
	std::istringstream f(req);
	std::string line;
	std::getline(f, line);
	while (std::getline(f, line)) {
		if (!line.empty() && line.back() == '\r') line.pop_back();
		auto colon = line.find(':');
		if (colon == std::string::npos) continue;
		std::string key = line.substr(0, colon);
		for (char& ch : key) ch = char(std::tolower(unsigned(ch)));
		if (key == needle) {
			std::string val = line.substr(colon + 1);
			size_t b = val.find_first_not_of(" \t");
			if (b == std::string::npos) return "";
			size_t e = val.find_last_not_of(" \t");
			return val.substr(b, e - b + 1);
		}
	}
	return "";
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

static void send_json(Client* c, const json& j) { enqueue_out(c, j.dump()); }

// Detached workers must answer errors, never die: an exception escaping one
// of these lambdas is std::terminate — the whole daemon gone for one bad
// field. Wrap every worker so a throw degrades to an error reply.
template <typename F>
static void spawn_guarded(Client* c, F&& f) {
	std::thread([c, fn = std::forward<F>(f)]() mutable {
		try { fn(); }
		catch (const std::exception& e) {
			try { send_json(c, {{"type", "error"}, {"error", std::string("internal: ") + e.what()}}); } catch (...) {}
		} catch (...) {}
	}).detach();
}

static json sessions_json_locked() {
	json arr = json::array();
	for (auto& [id, s] : g_sessions) {
		std::lock_guard<std::mutex> lock(s->ring_mutex);
		arr.push_back({{"id", id}, {"cwd", s->cwd}, {"branch", s->branch}, {"parentId", s->parent_id}, {"pid", proc_display_id(s->pid)}, {"lastSeq", s->seq.load()},
	               {"createdAt", s->created_ms},
	               {"lastAt", s->last_active_ms.load()},
	               {"busy", s->busy.load()},
	               {"alive", s->running.load()},
	               {"title", s->title},
	               {"preview", s->preview},
	               {"pinned", s->pinned.load()},
	               {"hidden", s->hidden.load()},
	               {"lastReadSeq", s->last_read_seq.load()},
	               {"harness", s->harness}});
	}
	return arr;
}

// ---- provider auth surface ------------------------------------------------
// `omp login <provider>` runs ON THIS HOST against the local credential vault
// (~/.omp/agent/agent.db or a configured broker). Credential bytes never cross
// the wire — the client sees catalog entries, state flags, and the login
// child's stdout lines (auth URL, prompts, progress).

static std::vector<std::string> auth_split_lines(const std::string& s) {
	std::vector<std::string> out;
	size_t start = 0, pos;
	while ((pos = s.find('\n', start)) != std::string::npos) {
		out.push_back(s.substr(start, pos - start));
		start = pos + 1;
	}
	if (start < s.size()) out.push_back(s.substr(start));
	return out;
}

// only caller is the POSIX-only sqlite3 vault query below
[[maybe_unused]] static std::string auth_trim(const std::string& s) {
	size_t b = s.find_first_not_of(" \t\r\n");
	if (b == std::string::npos) return "";
	size_t e = s.find_last_not_of(" \t\r\n");
	return s.substr(b, e - b + 1);
}

// provider ids with a live OAuth/api credential row in omp's vault
static std::set<std::string> vault_authed_providers() {
	std::set<std::string> authed;
#if !defined(_WIN32)
	auto vault = run_capture(
	    "sqlite3 -batch \"" + home_dir() + "/.omp/agent/agent.db\" "
	    "\"SELECT provider FROM auth_credentials WHERE disabled_cause IS NULL OR disabled_cause=''\"",
	    8000);
	std::istringstream in(vault.out);
	std::string ln;
	while (std::getline(in, ln)) {
		std::string p = yml_trim(ln);
		if (!p.empty()) authed.insert(p);
	}
#endif
	return authed;
}

static json rig_models_payload() {
	json providers = json::array();
	const std::string path = home_dir() + "/.omp/agent/models.yml";
	std::ifstream in(path);
	const std::set<std::string> authed = vault_authed_providers();
	if (in) {
		std::string line;
		json prov, model;
		int prov_ind = -1, models_ind = -1;
		bool in_providers = false;
		auto flush_model = [&] {
			if (model.is_object() && !model.empty()) prov["models"].push_back(model);
			model = json();
		};
		auto flush_prov = [&] {
			flush_model();
			if (prov.is_object() && prov.contains("id")) {
				std::string key = prov.contains("apiKey") && prov["apiKey"].is_string() ? prov["apiKey"].get<std::string>() : "";
				bool env_ref = false;
				std::string var;
				if (key.rfind("env:", 0) == 0) { env_ref = true; var = key.substr(4); }
				else if (!key.empty() && key.front() == '$') { env_ref = true; var = key.substr(1); }
				if (env_ref) {
					while (!var.empty() && (var.front() == '{' || var.front() == ' ')) var.erase(var.begin());
					while (!var.empty() && (var.back() == '}' || var.back() == ' ')) var.pop_back();
				}
				const bool key_ok = env_ref ? (!var.empty() && getenv(var.c_str()) != nullptr) : !key.empty();
				const bool oauth = authed.count(prov["id"].get<std::string>()) > 0;
				prov["keyConfigured"] = key_ok;
				prov["ready"] = key_ok || oauth;
				for (auto& mm : prov["models"]) {
					if (mm.contains("id")) mm["spec"] = prov["id"].get<std::string>() + "/" + mm["id"].get<std::string>();
					mm["ready"] = prov["ready"];
				}
				prov.erase("apiKey"); // never on the wire
				providers.push_back(prov);
			}
			prov = json();
		};
		while (std::getline(in, line)) {
			const size_t b = line.find_first_not_of(" \t");
			if (b == std::string::npos || line[b] == '#') continue;
			const int ind = int(b);
			const std::string t = line.substr(b, line.find_last_not_of(" \t") - b + 1);
			if (ind == 0) {
				flush_prov();
				in_providers = (t == "providers:");
				prov_ind = -1;
				models_ind = -1;
				continue;
			}
			if (!in_providers) continue;
			if (prov_ind >= 0 && ind <= prov_ind) { flush_prov(); prov_ind = -1; models_ind = -1; }
			if (prov_ind < 0) {
				if (t.back() == ':') {
					prov_ind = ind;
					prov = {{"id", yml_unquote(t.substr(0, t.size() - 1))}, {"models", json::array()}};
				}
				continue;
			}
			// inside a provider block: 'models:' opens the list; de-indent ends it
			if (models_ind >= 0 && ind <= models_ind && t.front() != '-') models_ind = -1;
			if (models_ind < 0 && t == "models:") { models_ind = ind; continue; }
			std::string body = t;
			if (models_ind >= 0 && body.front() == '-') {
				flush_model();
				model = json::object();
				body = yml_trim(body.substr(1));
				if (body.empty()) continue;
			}
			const size_t c = body.find(':');
			if (c == std::string::npos) continue;
			const std::string k = yml_unquote(body.substr(0, c));
			const std::string v = yml_trim(body.substr(c + 1));
			if (v.empty()) continue; // nested block (e.g. thinking handled inline only)
			if (models_ind >= 0 && model.is_object()) model[k] = yml_value(v);
			else prov[k] = yml_value(v);
		}
		flush_prov();
	}
	return {{"type", "rig.models"}, {"providers", providers},
	        {"defaultModel", first_configured_model()},
	        {"path", path}};
}

static json auth_list_payload() {
	json providers = json::array();
	// Catalog: `omp auth-broker list` prints "  <id>   <label>" rows.
	auto cat = run_capture("\"" + g_omp_bin + "\" auth-broker list", 15000);
	std::set<std::string> seen;
	for (auto& ln : auth_split_lines(cat.out)) {
		std::string t = ln;
		while (!t.empty() && (t.front() == ' ' || t.front() == '\t')) t.erase(t.begin());
		if (t.empty() || t.back() == ':' || t.find("  ") == std::string::npos) continue;
		const size_t cut = t.find("  ");
		std::string id = t.substr(0, cut);
		std::string label = t.substr(cut + 2);
		while (!label.empty() && (label.front() == ' ' || label.front() == '\t')) label.erase(label.begin());
		if (id.empty() || id.find(' ') != std::string::npos) continue;
		if (seen.insert(id).second)
			providers.push_back({{"id", id}, {"label", label}, {"authed", false}, {"via", "oauth"}});
	}
	// Authed set: the local vault's credential rows + providers named in
	// models.yml (api-key config). sqlite3 may not exist on every host —
	// treat its absence as "no vault rows", not an error.
	std::set<std::string> authed = vault_authed_providers();
	for (auto& p : configured_providers()) authed.insert(p);
	for (auto& prov : providers)
		if (authed.count(prov.value("id", ""))) prov["authed"] = true;
	// models.yml providers not in the OAuth catalog still get listed.
	for (auto& p : configured_providers()) {
		if (seen.insert(p).second)
			providers.push_back({{"id", p}, {"label", p}, {"authed", true}, {"via", "key"}});
	}
	return {{"type", "auth.list"}, {"providers", providers}};
}

struct AuthProc {
	pid_t pid = -1;
	int stdin_fd = -1;
	int stdout_fd = -1;
	std::string provider;
	std::string pending_key; // written when the child first prompts
};
static AuthProc g_auth;
static std::mutex g_auth_mutex;

static void auth_reader(pid_t pid, int out_fd, std::string provider) {
	std::string buf, partial;
	char chunk[8192];
	for (;;) {
		ssize_t n = file_read(out_fd, chunk, sizeof(chunk));
		if (n <= 0) break;
		buf.append(chunk, size_t(n));
		size_t pos;
		while ((pos = buf.find('\n')) != std::string::npos) {
			std::string line = buf.substr(0, pos);
			buf.erase(0, pos + 1);
			if (!line.empty() && line.back() == '\r') line.pop_back();
			if (line.empty()) continue;
			json ev = {{"type", "auth.event"}, {"provider", provider}, {"kind", "line"}, {"text", line}};
			// surface URLs as their own event so clients can offer an "Open sign-in" button
			size_t u = line.find("http://");
			if (u == std::string::npos) u = line.find("https://");
			if (u != std::string::npos) {
				size_t e = line.find_first_of(" \t\"'<>", u);
				std::string url = line.substr(u, e == std::string::npos ? std::string::npos : e - u);
				ev["url"] = url;
				ev["kind"] = "url";
			}
			broadcast(ev.dump());
			partial.clear();
		}
		// prompts end without a newline ("Paste your API key:") — surface the
		// tail as its own event so the UI can show the input field while omp
		// is still waiting, instead of only learning about it at exit.
		if (buf != partial && !buf.empty()) {
			partial = buf;
			broadcast(json({{"type", "auth.event"}, {"provider", provider}, {"kind", "prompt"}, {"text", buf}}).dump());
			// a queued key rides out right after the prompt — readline flushes
			// anything written before the prompt appeared.
			std::lock_guard<std::mutex> lock(g_auth_mutex);
			if (g_auth.pid == pid && !g_auth.pending_key.empty() && g_auth.stdin_fd >= 0) {
				std::string line = g_auth.pending_key + "\n";
				g_auth.pending_key.clear();
				file_write(g_auth.stdin_fd, line.data(), line.size());
			}
		}
	}
	file_close(out_fd);
	int status = -1;
	waitpid(pid, &status, 0);
	int code = (status >= 0 && WIFEXITED(status)) ? WEXITSTATUS(status) : -1;
	{
		std::lock_guard<std::mutex> lock(g_auth_mutex);
		if (g_auth.pid == pid) { g_auth.pid = -1; g_auth.stdin_fd = -1; g_auth.stdout_fd = -1; g_auth.pending_key.clear(); }
	}
	broadcast(json({{"type", "auth.event"}, {"provider", provider}, {"kind", "done"},
	                {"ok", code == 0}, {"code", code}}).dump());
	// a finished login may have added a provider — nudge clients to refresh
	broadcast(json({{"type", "auth.changed"}}).dump());
}

static void auth_login(const std::string& provider, Client* starter, const std::string& key = "") {
	if (provider.empty() || provider.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::string::npos) {
		send_json(starter, {{"type", "error"}, {"error", "bad provider id"}, {"for", "auth.login"}});
		return;
	}
	std::lock_guard<std::mutex> lock(g_auth_mutex);
	if (g_auth.pid > 0) {
		send_json(starter, {{"type", "error"}, {"error", "auth login already running"}, {"provider", g_auth.provider}});
		return;
	}
	std::string err;
	OmpChild ch = spawn_omp_child(home_dir(), g_omp_bin, {"login", provider}, err, true, false);
	if (ch.pid < 0) {
		send_json(starter, {{"type", "error"}, {"error", "login spawn failed: " + err}});
		return;
	}
	g_auth.pid = ch.pid;
	g_auth.stdin_fd = ch.stdin_fd;
	g_auth.stdout_fd = ch.stdout_fd;
	g_auth.provider = provider;
	send_json(starter, {{"type", "auth.started"}, {"provider", provider}});
	// api-key providers (commandcode, deepseek, …): the client may hand the key
	// up front — auth_reader releases it the moment the child prompts.
	g_auth.pending_key = key;
	std::thread(auth_reader, ch.pid, ch.stdout_fd, provider).detach();
}

static bool auth_input(const std::string& text) {
	std::lock_guard<std::mutex> lock(g_auth_mutex);
	if (g_auth.pid <= 0 || g_auth.stdin_fd < 0) return false;
	std::string line = text + "\n";
	return file_write(g_auth.stdin_fd, line.data(), line.size()) == (ssize_t)line.size();
}

static bool auth_cancel() {
	std::lock_guard<std::mutex> lock(g_auth_mutex);
	if (g_auth.pid <= 0) return false;
	kill(-g_auth.pid, SIGKILL);
	kill(g_auth.pid, SIGKILL);
	return true;
}

#if defined(__linux__)
// ---- Linux lid-close + wifi powersave helpers (rig.stayAwake) ----
// Lid tiers: unprivileged handle-lid-switch inhibitor (polkit-gated) ->
// a logind/elogind drop-in we can write (root daemon or passwordless sudo)
// -> honest "needs-root" with the one-liner. Drop-ins persist across
// reboots and daemon restarts; we only remove ones we wrote ourselves.
static bool g_lid_dropin_ours = false;
static const char* g_lid_dropin_content =
	"[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchDocked=ignore\nHandleLidSwitchExternalPower=ignore\n";

struct LidDropin { bool ok = false; std::string method = "needs-root"; std::string detail; };

// Which drop-in target applies on this machine.
static std::string lid_dropin_path() {
	if (fs::exists("/run/systemd/system") || fs::exists("/etc/systemd/logind.conf"))
		return "/etc/systemd/logind.conf.d/90-omprd-lid.conf";
	if (fs::exists("/etc/elogind"))
		return "/etc/elogind/logind.conf.d/90-omprd-lid.conf";
	return "";
}

static std::string lid_restart_cmd(const std::string& path) {
	return path.find("/etc/elogind") == 0 ? "sv restart elogind" : "systemctl try-restart systemd-logind";
}

static LidDropin linux_lid_dropin_install() {
	LidDropin d;
	std::string path = lid_dropin_path();
	if (path.empty()) { d.method = "unsupported"; d.detail = "no logind or elogind config path found"; return d; }
	std::string dir = fs::path(path).parent_path().string();
	if (geteuid() == 0) {
		std::error_code ec;
		fs::create_directories(dir, ec);
		std::ofstream f(path);
		if (f.good()) {
			f << g_lid_dropin_content;
			f.close();
			Capture r = run_capture(lid_restart_cmd(path), 15000);
			d.ok = fs::exists(path);
			d.method = path.find("elogind") != std::string::npos ? "elogind-dropin" : "logind-dropin";
			if (r.code != 0) d.detail = "drop-in written but '" + lid_restart_cmd(path) + "' failed - reboot or restart logind to apply";
			return d;
		}
		d.detail = "running as root but could not write " + path;
		return d;
	}
	// passwordless sudo covers single-user dev boxes; fails fast otherwise
	std::string cmd = "sudo -n mkdir -p " + dir + " && printf %s '"
		+ std::string(g_lid_dropin_content)
		+ "' | sudo -n tee " + path + " >/dev/null && sudo -n " + lid_restart_cmd(path);
	Capture r = run_capture(cmd, 15000);
	if (fs::exists(path)) {
		d.ok = true;
		d.method = path.find("elogind") != std::string::npos ? "elogind-dropin" : "logind-dropin";
		return d;
	}
	d.detail = "unprivileged inhibit denied, no write access to " + path +
	           (r.code != 0 ? " (sudo -n unavailable)" : "");
	return d;
}

static bool linux_lid_dropin_remove() {
	std::string path = lid_dropin_path();
	if (path.empty() || !fs::exists(path)) return false;
	if (geteuid() == 0) {
		std::error_code ec;
		fs::remove(path, ec);
		run_capture(lid_restart_cmd(path), 15000);
		return !fs::exists(path);
	}
	run_capture("sudo -n rm -f " + path + " && sudo -n " + lid_restart_cmd(path), 15000);
	return !fs::exists(path);
}

// what rig.status reports for lid-close protection right now
static const char* lid_close_method() {
	if (g_lid_inhibit_pid > 0) return "inhibitor";
	std::string path = lid_dropin_path();
	if (!path.empty() && fs::exists(path))
		return path.find("elogind") != std::string::npos ? "elogind-dropin" : "logind-dropin";
	return "none";
}

// can this process write the lid drop-in by itself? cached: sudo NOPASSWD
// state doesn't change mid-session in practice.
static bool sudo_n_probe() {
	static int cached = -1;
	if (cached < 0) cached = system("sudo -n true >/dev/null 2>&1") == 0 ? 1 : 0;
	return cached == 1;
}

// lid-close still unprotected AND the daemon can't fix it alone — the app
// renders "needs sudo on this laptop" off this flag
static bool lid_close_needs_privilege() {
	if (std::strcmp(lid_close_method(), "none") != 0) return false; // already protected
	if (lid_dropin_path().empty()) return false;                    // unsupported, not a sudo problem
	return geteuid() != 0 && !sudo_n_probe();
}

// Keep the radio awake too - a sleeping NIC makes lid-closed survival
// moot. Enumerates wireless ifaces via sysfs, attempts `iw set power_save
// off` (root or sudo -n), reports honestly. AC vs battery: NM applies
// powersave on battery only by default, so AC rigs usually need nothing -
// documented in README, and install.sh --lid writes the persistent drop-in.
static json linux_wifi_powersave() {
	json j = {{"interfaces", json::array()}, {"disabled", json::array()},
	          {"needsRoot", false}, {"persistent", false}};
	std::vector<std::string> ifaces;
	std::error_code ec;
	for (auto& e : fs::directory_iterator("/sys/class/net", ec)) {
		fs::path p = e.path();
		if (fs::exists(p / "wireless") || fs::exists(p / "phy80211"))
			ifaces.push_back(p.filename().string());
	}
	if (ec || ifaces.empty()) { j["note"] = "no wireless interfaces detected"; return j; }
	j["interfaces"] = ifaces;
	bool any_failed = false;
	for (auto& i : ifaces) {
		std::string base = geteuid() == 0 ? "" : "sudo -n ";
		Capture r = run_capture(base + "iw dev " + i + " set power_save off", 8000);
		if (r.code == 0) j["disabled"].push_back(i);
		else any_failed = true;
	}
	// persistent drop-in for NetworkManager-managed boxes (powersave=2 = off)
	bool nm = fs::exists("/etc/NetworkManager/conf.d");
	j["persistent"] = fs::exists("/etc/NetworkManager/conf.d/90-omprd-wifi-powersave.conf");
	if (any_failed) {
		j["needsRoot"] = true;
		j["command"] = "sudo iw dev " + ifaces[0] + " set power_save off"
			+ (nm ? "   - persistent: printf '[connection]\nwifi.powersave=2\n' | sudo tee /etc/NetworkManager/conf.d/90-omprd-wifi-powersave.conf && sudo systemctl reload NetworkManager" : "")
			+ "   - or run: sudo os-bridge/linux/install.sh --lid";
	}
	return j;
}
#endif

static void handle_message(Client* c, const json& m) {
	std::string type = m.value("type", "");
	// direct replies echo the caller"s request id — any client may keep
	// several requests in flight and still match replies to requests
	auto reply = [&](json r) { if (m.contains("id")) r["id"] = m["id"]; send_json(c, r); };
	if (!c->authed && type != "pair") {
		reply({{"type", "error"}, {"error", "unauthorized"}, {"hint", "pair first"}});
		return;
	}
	if (c->authed && !c->service && type != "pair" && !(c->scopes & scope_required(type))) {
		reply({{"type", "error"},
		              {"error", "token lacks the " +
		           std::string((scope_required(type) & SCOPE_ADMIN) ? "admin" :
		                       (scope_required(type) & SCOPE_OPERATE) ? "operate" : "read") +
		           " scope for " + type},
		              {"hint", "re-pair with wider scopes (ompr pair --scopes)"}});
		return;
	}

	if (type == "pair") {
		if (!c->pair_bucket.take()) {
			reply({{"type", "error"}, {"error", "rate limited; wait a minute"}});
			return;
		}
		std::string err;
		std::string token = g_rig.pair(m.value("code", ""), m.value("device", ""), err);
		if (token.empty()) {
			reply({{"type", "error"}, {"error", err}});
			return;
		}
		c->authed = true;
		c->name = m.value("device", "unnamed");
		g_rig.token_valid(token, &c->scopes); // minted device's scope mask
		reply({{"type", "paired"}, {"token", token},
		              {"scopes", scope_names(c->scopes)}});
		log("device paired: " + c->name);
		return;
	}

	if (g_rig.locked) {
		reply({{"type", "error"}, {"error", "rig is locked"}, {"hint", "rm ~/.rig/locked on the rig"}});
		return;
	}

	if (type == "rig.status") {
		size_t n_clients = 0;
		{
			std::lock_guard<std::mutex> lock(g_clients_mutex);
			for (Client* o : g_clients) if (o->authed) n_clients++;
		}
		json devices = json::array();
		{
			std::lock_guard<std::mutex> l(g_rig.mutex);
			for (auto& d : g_rig.devices)
				devices.push_back({{"device", d.device}, {"paired_at", d.paired_at},
				                   {"scopes", scope_names(d.scopes)}});
		}
		json sessions;
		{
			std::lock_guard<std::mutex> lock(g_sessions_mutex);
			sessions = sessions_json_locked();
		}
		json st_reply = {{"type", "rig.status"},
		              {"version", OMPRD_VERSION},
		              {"hostname", host_name()},
		              {"os",
#if defined(_WIN32)
		               "windows"
#elif defined(__APPLE__)
		               "macos"
#else
		               "linux"
#endif
		              },
		              {"uptimeMs", now_ms() - g_boot_ms},
		              {"providers", configured_providers()},
		              {"keepawake",
		               {{"persistent", g_keep_awake_persistent.load()},
		                {"held", native().init() && native().awake_held_os()},
		                {"method", native().init() ? native().awake_method() : "none"},
		                {"needsAdmin",
#if defined(_WIN32)
						 g_lid_needs_admin
#else
						 false
#endif
						},
		                {"lidCloseInhibitor", g_lid_inhibit_pid > 0},
		                {"lidOverride",
#if defined(_WIN32)
						 json{{"applied", g_lid_overridden},
						      {"method", g_lid_overridden ? "powercfg" : (g_lid_needs_admin ? "needs-admin" : "none")}}
#elif defined(__APPLE__)
						 json{{"applied", mac_lid_disabled()},
						      {"method", mac_lid_disabled() ? "pmset" : "none"}}
#else
						 // inhibitor OR the persistent drop-in — either means the lid won't sleep us
						 json{{"applied", std::strcmp(lid_close_method(), "none") != 0},
						      {"method", lid_close_method()},
						      {"needsPrivilege", lid_close_needs_privilege()}}
#endif
						}}},
		              {"devices", devices}, {"sessions", sessions}, {"clients", n_clients}};
		if (m.contains("id")) st_reply["id"] = m["id"];
		send_json(c, st_reply);
		return;
	}

	if (type == "rig.stats") {
		size_t warm_n = 0;
		{
			std::lock_guard<std::mutex> lock(g_warm_mutex);
			for (auto* w : g_warm) if (w->st != 2) warm_n++;
		}
		json rs_reply = {{"type", "rig.stats"},
		              {"uptimeMs", now_ms() - g_boot_ms},
		              {"framesIn", g_frames_in.load()}, {"framesOut", g_frames_out.load()},
		              {"linesIn", g_lines_total.load()}, {"linesParsed", g_lines_parsed.load()},
		              {"warmSpares", warm_n}, {"warmCap", g_warm_max},
		              {"compactPct", g_compact_pct},
		              {"latencyBridgeUs", g_lat_bridge.percentiles()},   // omp→daemon enqueue (µs)
		              {"latencyQueueMs", g_lat_emit.percentiles()}};
		if (m.contains("id")) rs_reply["id"] = m["id"];
		send_json(c, rs_reply);    // enqueue→socket write (ms)
		return;
	}

	if (type == "rig.lock") {
		std::ofstream(g_rig.dir / "locked") << "1";
		g_rig.locked = true;
		{
			std::lock_guard<std::mutex> lock(g_sessions_mutex);
			for (auto& [id, s] : g_sessions) { kill(-s->pid, SIGTERM); kill(s->pid, SIGTERM); }
		}
		reply({{"type", "ok"}, {"for", "rig.lock"}, {"detail", "sessions killed, rig locked"}});
		log("RIG LOCKED by client");
		return;
	}

	if (type == "rig.stayAwake") {
		bool on = m.value("on", true);
		bool persistent = m.value("persistent", false);
		g_keep_awake_persistent = on;
		bool held = native().init() && native().stay_awake(on);
		json lid = {{"attempted", false}};
		// lid-close survival is part of "keep working" — attempt on any
		// stayAwake{on:true}, not only the persistent form.
		if (on) {
			lid["attempted"] = true;
#if defined(__APPLE__)
			// battery lid-close sleep has no unprivileged escape on macOS;
			// tcpkeepalive keeps TCP/WiFi services reachable during sleep.
			// Passwordless sudo first (NOPASSWD sudoers / dev boxes), then a
			// bare pmset for daemons already running as root.
			int rc = system("sudo -n pmset -a disablesleep 1 tcpkeepalive 1 >/dev/null 2>&1");
			if (rc != 0)
				rc = system("pmset -a disablesleep 1 tcpkeepalive 1 >/dev/null 2>&1");
			lid["ok"] = (rc == 0);
			lid["needsPrivilege"] = (rc != 0);
			lid["command"] = "sudo pmset -a disablesleep 1 tcpkeepalive 1";
			lid["restore"] = "sudo pmset -a disablesleep 0";
#elif defined(_WIN32)
			auto [ac0, dc0] = win_lid_indexes();
			if (ac0 < 0 && dc0 < 0) {
				lid["ok"] = false;
				lid["method"] = "no-lid";
				lid["reason"] = "no LIDACTION setting in the active power scheme — lidless hardware (VM, desktop, or server)";
			} else {
				if (!g_lid_overridden) { g_lid_prev_ac = ac0; g_lid_prev_dc = dc0; }
				Capture set = run_capture(
					"powercfg -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 >NUL 2>&1 && "
					"powercfg -setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 >NUL 2>&1 && "
					"powercfg -setactive SCHEME_CURRENT >NUL 2>&1", 15000);
				auto [ac1, dc1] = win_lid_indexes();
				bool applied = (ac0 < 0 || ac1 == 0) && (dc0 < 0 || dc1 == 0);
				g_lid_overridden = applied;
				lid["ok"] = applied;
				lid["method"] = applied ? "powercfg" : "needs-admin";
				if (applied) {
					g_lid_needs_admin = false;
					lid["previous"] = {{"ac", ac0}, {"dc", dc0}};
					lid["restore"] = "rig.stayAwake {on:false} restores the previous indexes";
				} else {
					g_lid_needs_admin = true;
					lid["needsPrivilege"] = true;
					lid["needsAdmin"] = true;
					lid["reason"] = set.code != 0
						? "powercfg set commands failed — run from an elevated shell"
						: "powercfg set did not survive re-query (policy or permissions denied the write)";
					lid["command"] = "admin shell: powercfg -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0; powercfg -setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0; powercfg -setactive SCHEME_CURRENT";
					lid["restore"] = "powercfg -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1; powercfg -setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1; powercfg -setactive SCHEME_CURRENT";
				}
			}
#else
			// Linux lid-close, three honest tiers:
			//   1) unprivileged handle-lid-switch block inhibitor — works where
			//      polkit permits; DENIED on many boxes ("Failed to inhibit:
			//      Access denied" — verified on this Ubuntu VM, uid 1000)
			//   2) a logind/elogind drop-in written by us (root daemon or
			//      sudo -n) — persists across reboots and daemon restarts
			//   3) needs-root: report the exact one-liner
			if (g_lid_inhibit_pid <= 0) {
				pid_t pid = fork();
				if (pid == 0) {
					execlp("systemd-inhibit", "systemd-inhibit",
					       "--what=handle-lid-switch:sleep", "--mode=block",
					       "--why=remote keep-awake", "--", "sleep", "infinity", nullptr);
					_exit(127);
				}
				if (pid > 0) {
					std::this_thread::sleep_for(std::chrono::milliseconds(600));
					int st = 0;
					g_lid_inhibit_pid = waitpid(pid, &st, WNOHANG) == 0 ? pid : -1;
				}
			}
			if (g_lid_inhibit_pid > 0) {
				lid["ok"] = true;
				lid["method"] = "inhibitor";
				lid["restore"] = "rig.stayAwake {on:false} releases the inhibitor";
			} else {
				LidDropin d = linux_lid_dropin_install();
				lid["ok"] = d.ok;
				lid["method"] = d.method;
				lid["needsPrivilege"] = !d.ok;
				if (!d.detail.empty()) lid["detail"] = d.detail;
				if (d.ok) {
					g_lid_dropin_ours = true;
					lid["restore"] = "rig.stayAwake {on:false} removes the drop-in we installed";
				} else {
					lid["command"] = "sudo os-bridge/linux/install.sh --lid   — or by hand: printf '[Login]\\nHandleLidSwitch=ignore\\nHandleLidSwitchDocked=ignore\\nHandleLidSwitchExternalPower=ignore\\n' | sudo tee /etc/systemd/logind.conf.d/90-omprd-lid.conf && sudo systemctl try-restart systemd-logind";
					lid["restore"] = "sudo rm /etc/systemd/logind.conf.d/90-omprd-lid.conf && sudo systemctl try-restart systemd-logind";
				}
			}
#endif
		}
		if (!on && g_lid_inhibit_pid > 0) {
			kill(g_lid_inhibit_pid, SIGTERM);
			for (int i = 0; i < 40 && waitpid(g_lid_inhibit_pid, nullptr, WNOHANG) == 0; i++)
				usleep(50000); // bounded — a stubborn child must not wedge the reply
			if (waitpid(g_lid_inhibit_pid, nullptr, WNOHANG) != 0) g_lid_inhibit_pid = -1;
		}
#if defined(__linux__)
		// remove only the drop-in THIS daemon installed — a user-installed one
		// (install.sh --lid) is persistent policy, not ours to rip out
		if (!on && g_lid_dropin_ours) { linux_lid_dropin_remove(); g_lid_dropin_ours = false; }
#endif
#if defined(__APPLE__)
		if (!on &&
		    system("sudo -n pmset -a disablesleep 0 >/dev/null 2>&1") != 0)
			system("pmset -a disablesleep 0 >/dev/null 2>&1");
#endif
#if defined(_WIN32)
		if (!on && g_lid_overridden) {
			long ac = g_lid_prev_ac >= 0 ? g_lid_prev_ac : 1;   // 1 = sleep, the stock default
			long dc = g_lid_prev_dc >= 0 ? g_lid_prev_dc : 1;
			char cmd[512];
			snprintf(cmd, sizeof cmd,
			         "powercfg -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION %ld >NUL 2>&1 && "
			         "powercfg -setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION %ld >NUL 2>&1 && "
			         "powercfg -setactive SCHEME_CURRENT >NUL 2>&1", ac, dc);
			system(cmd);
			auto [ac2, dc2] = win_lid_indexes();
			lid["restored"] =
			    (g_lid_prev_ac < 0 || ac2 == g_lid_prev_ac) &&
			    (g_lid_prev_dc < 0 || dc2 == g_lid_prev_dc);
			g_lid_overridden = !lid["restored"].get<bool>();
		}
#endif
		json awake = {{"type", "rig.stayAwake"}, {"on", on}, {"persistent", persistent},
		              {"held", held}, {"lidClose", lid}};
#if defined(__linux__)
		// a sleeping NIC makes lid survival moot — check + disable wifi
		// powersave when we can, report honestly when we can't
		if (on) awake["wifi"] = linux_wifi_powersave();
#endif
		if (m.contains("id")) awake["id"] = m["id"];
		send_json(c, awake);
		return;
	}

	if (type == "rig.models") {
		json r = rig_models_payload();
		if (m.contains("id")) r["id"] = m["id"];
		send_json(c, r);
		return;
	}

	if (type == "rig.authStatus") {
		// omp's auth vault lives on this host — clients see provider ids and
		// state, never credential values
		auto r = run_capture("\"" + g_omp_bin + "\" auth-broker status",
		                     std::clamp(m.value("timeoutMs", 15000), 1000, 120000));
		reply({{"type", "rig.authStatus"}, {"ok", r.code == 0},
		              {"code", r.code}, {"timedOut", r.timed_out}, {"output", r.out}});
		return;
	}

	// ---- provider auth surface ----------------------------------------------
	// OAuth/key login happens on THIS host (omp login writes the local vault —
	// credential bytes never cross the wire). The client brokers the flow:
	// auth.list → catalog+state, auth.login → interactive child whose stdout is
	// streamed as auth.event frames, auth.input → paste answers, auth.cancel.
	if (type == "auth.list") {
		reply(auth_list_payload());
		return;
	}
	if (type == "auth.login") {
		auth_login(m.value("provider", ""), c, m.value("key", ""));
		return;
	}
	if (type == "auth.input") {
		reply({{"type", "auth.inputAck"}, {"ok", auth_input(m.value("text", ""))}});
		return;
	}
	if (type == "auth.cancel") {
		reply({{"type", "auth.cancelAck"}, {"ok", auth_cancel()}});
		return;
	}

	if (type == "session.new") {
		std::string id = m.value("sessionId", rig::random_hex(4));
		std::string err;
		if (!session_start(id, m, err, c)) {
			reply({{"type", "error"}, {"error", err}, {"sessionId", id}});
			return;
		}
		// session.started is sent by the child reader once omp completes the
		// RPC handshake — clients never see a half-born session.
		return;
	}

	// session.forPid — which rig session owns the process `pid` lives in?
	// In-session agents send their own pid (rig-call attaches it as
	// callerPid); the daemon climbs the ppid chain to the owning omp child.
	// sessionId:null means the pid is not inside any session's tree — an
	// honest "not me".
	if (type == "session.forPid") {
		long pid = m.value("pid", m.value("callerPid", 0L));
		Session* s = pid > 0 ? session_for_pid(pid) : nullptr;
		json r = {{"type", "session.forPid"}, {"ok", true},
		          {"sessionId", s ? json(s->id) : json(nullptr)}};
		if (s) { r["cwd"] = s->cwd; r["parentId"] = s->parent_id; }
		if (m.contains("id")) r["id"] = m["id"];
		send_json(c, r);
		return;
	}

	// session.wait — the join half of spawn: long-poll until a session's turn
	// settles (busy goes false after starting, or any progress then idle), it
	// exits, or the wait times out. Gives an in-session orchestrator a real
	// rendezvous instead of sleep-loop file polling. Reply carries the state
	// it saw: {busy, running, lastSeq, preview, timedOut, gone}.
	if (type == "session.wait") {
		std::string sid = m.value("sessionId", "");
		Session* s0 = find_session(sid);
		if (!s0) {
			reply({{"type", "error"}, {"error", "no such session"}, {"sessionId", sid}});
			return;
		}
		int64_t timeout_ms = (int64_t)m.value("timeoutMs", 300000.0);
		timeout_ms = std::max<int64_t>(1000, std::min<int64_t>(timeout_ms, 600000));
		uint64_t seq0 = s0->seq.load();
		spawn_guarded(c, [c, m, sid, timeout_ms, seq0] {
			bool saw_busy = false;
			int64_t deadline = now_ms() + timeout_ms;
			while (true) {
				Session* s;
				{
					std::lock_guard<std::mutex> lock(g_sessions_mutex);
					auto it = g_sessions.find(sid);
					s = it == g_sessions.end() ? nullptr : it->second;
				}
				json r = {{"type", "session.wait.result"}, {"ok", true}, {"sessionId", sid}};
				if (m.contains("id")) r["id"] = m["id"];
				if (!s) {
					r["gone"] = true;
					send_json(c, r);
					return;
				}
				if (s->busy.load()) saw_busy = true;
				bool running = s->running.load();
				bool progressed = s->seq.load() > seq0;
				if (!running || ((saw_busy || progressed) && !s->busy.load()) || now_ms() >= deadline) {
					std::string preview;
					{ std::lock_guard<std::mutex> lk(s->ring_mutex); preview = s->preview; }
					r["busy"] = s->busy.load();
					r["running"] = running;
					r["lastSeq"] = s->seq.load();
					r["preview"] = preview;
					r["timedOut"] = now_ms() >= deadline && s->busy.load();
					r["gone"] = false;
					send_json(c, r);
					return;
				}
				std::this_thread::sleep_for(std::chrono::milliseconds(250));
			}
		});
		return;
	}

	// session.spawn — orchestrator fan-out: a child session bound to a parent
	// by parentId. Any authed client can spawn (the app's sub-agents surface);
	// a running agent reaches the same op through the OMPD_WS/OMPD_TOKEN
	// service socket its env carries. `prompt` becomes the child's first turn
	// once the handshake lands; `cwd` defaults to the parent's.
	if (type == "session.spawn") {
		std::string parent_id = m.value("parentId", m.value("parent", ""));
		Session* parent = nullptr;
		// self-spawn: "self"/"auto", or a bare spawn that carries callerPid —
		// resolve the caller's session via the ppid walk so an agent inside a
		// session never has to know its own session id.
		long caller_pid = m.value("callerPid", m.value("pid", 0L));
		bool wants_self = parent_id == "self" || parent_id == "auto";
		if ((wants_self || parent_id.empty()) && caller_pid > 0) {
			parent = session_for_pid(caller_pid);
			parent_id = parent ? parent->id : "";
			if (!parent && wants_self) {
				reply({{"type", "error"},
				       {"error", "caller pid " + std::to_string(caller_pid) + " is not inside a rig session"}});
				return;
			}
		} else if (wants_self) {
			reply({{"type", "error"}, {"error", "parentId \"self\" needs callerPid — the daemon can't tell which session you are without it"}});
			return;
		}
		if (!parent_id.empty() && !(parent = find_session(parent_id))) {
			reply({{"type", "error"}, {"error", "no such parent session"}, {"sessionId", parent_id}});
			return;
		}
		if (parent) {
			// bounded fan-out (Codex-style caps): depth ≤ 6, ≤ 16 live
			// children per parent — a runaway orchestrator can't fork-bomb
			// the laptop.
			int depth = 0;
			size_t live_kids = 0;
			{
				std::lock_guard<std::mutex> lock(g_sessions_mutex);
				for (Session* p = parent; p && !p->parent_id.empty() && depth < 16;) {
					depth++;
					auto it = g_sessions.find(p->parent_id);
					p = it == g_sessions.end() ? nullptr : it->second;
				}
				for (auto& [sid, s] : g_sessions)
					if (s->parent_id == parent_id && s->running.load()) live_kids++;
			}
			if (depth >= 6) {
				reply({{"type", "error"}, {"error", "spawn depth limit (6)"}, {"sessionId", parent_id}});
				return;
			}
			if (live_kids >= 16) {
				reply({{"type", "error"}, {"error", "sub-agent limit (16 live children)"}, {"sessionId", parent_id}});
				return;
			}
		}
		std::string id = m.value("sessionId", rig::random_hex(4));
		json opts = m;
		opts["parentId"] = parent_id;
		if (parent &&
		    (!opts.contains("cwd") || !opts["cwd"].is_string() || opts["cwd"].get<std::string>().empty()))
			opts["cwd"] = parent->cwd;
		// a child inherits the parent's model/thinking when the caller leaves
		// them unset — a qwen parent's sub-agent shouldn't silently run the
		// rig default (measured live: children defaulted to a quota-capped
		// provider and died mid-turn)
		if (parent)
			for (const char* k : {"model", "thinking"})
				if (!opts.contains(k) || !opts[k].is_string() || opts[k].get<std::string>().empty()) {
					std::string v = parent->spawn_opts.value(k, "");
					if (!v.empty()) opts[k] = v;
				}
		std::string err;
		if (!session_start(id, opts, err, c)) {
			reply({{"type", "error"}, {"error", err}, {"sessionId", id}});
			return;
		}
		if (Session* child = find_session(id)) {
			child->parent_id = parent_id;
			std::string prompt = m.value("prompt", "");
			std::string title = m.value("title", "");
			if (title.empty() && !prompt.empty()) {
				title = prompt;
				size_t nl = title.find('\n');
				if (nl != std::string::npos) title.resize(nl);
				if (title.size() > 80) title.resize(80);
			}
			{
				std::lock_guard<std::mutex> lock(child->ring_mutex);
				if (!title.empty()) child->title = title;
			}
			persist_meta(child);
			if (!prompt.empty())
				session_request(child, json{{"type", "prompt"}, {"message", prompt}},
				                nullptr, nullptr, 300000);
		}
		json ev = {{"type", "session.spawned"}, {"sessionId", id}, {"parentId", parent_id}};
		json r = ev;
		if (m.contains("id")) r["id"] = m["id"];
		send_json(c, r);
		broadcast(ev.dump());
		return;
	}

	// sessions.tree — the orchestrator map: the same rows sessions.list
	// serves, decorated with parentId/children/depth so a client can draw
	// parent→child without reconstructing it per thread.
	if (type == "sessions.tree") {
		std::lock_guard<std::mutex> lock(g_sessions_mutex);
		json arr = sessions_json_locked();
		std::unordered_map<std::string, std::string> parent_of;
		std::unordered_map<std::string, json> kids;
		for (auto& [sid, s] : g_sessions) {
			parent_of[sid] = s->parent_id;
			if (!s->parent_id.empty()) {
				if (!kids.count(s->parent_id)) kids[s->parent_id] = json::array();
				kids[s->parent_id].push_back(sid);
			}
		}
		for (auto& e : arr) {
			std::string sid = e.value("id", "");
			e["children"] = kids.count(sid) ? kids[sid] : json::array();
			int depth = 0;
			std::string p = parent_of.count(sid) ? parent_of[sid] : "";
			while (!p.empty() && depth < 16) {
				depth++;
				p = parent_of.count(p) ? parent_of[p] : "";
			}
			e["depth"] = depth;
		}
		json r = {{"type", "sessions.tree"}, {"sessions", arr}};
		if (m.contains("id")) r["id"] = m["id"];
		send_json(c, r);
		return;
	}

	if (type == "session.kill") {
		session_kill(m.value("sessionId", ""));
		reply({{"type", "ok"}, {"for", "session.kill"}});
		return;
	}

	// remove a session for good: running children die via the reaper (it owns
	// their cleanup + session.exited), dead/restored ones are wiped inline —
	// map, persisted files, pending asks, client delivery marks. Broadcast is
	// session.deleted for the inline path, session.exited for the kill path.
	// user-facing thread name — the persona wire gap: auto-titles come from
	// the first prompt; rename is the only way to set "Inbox Manager" by hand
	if (type == "session.rename") {
		Session* s = find_session(m.value("sessionId", ""));
		std::string t = m.value("title", "");
		if (!s || t.empty() || t.size() > 120) {
			reply({{"type", "error"}, {"error", "sessionId + title required"}});
			return;
		}
		size_t nl = t.find('\n');
		if (nl != std::string::npos) t.resize(nl);
		s->title = t;
		persist_meta(s);
		broadcast("{\"type\":\"session.renamed\",\"sessionId\":\"" + s->id +
		          "\",\"title\":" + json(t).dump() + "}");
		reply({{"type", "ok"}, {"for", "session.rename"}, {"title", t}});
		return;
	}

	if (type == "session.delete") {
		std::string sid = m.value("sessionId", "");
		Session* s = find_session(sid);
		if (!s) { reply({{"type", "error"}, {"error", "no such session"}}); return; }
		if (s->pid > 0) {
			session_kill(sid, SIGTERM);
		} else {
			bool erased = false;
			{
				std::lock_guard<std::mutex> lock(g_sessions_mutex);
				auto it = g_sessions.find(sid);
				if (it != g_sessions.end() && it->second == s) {
					{
						std::lock_guard<std::mutex> plock(s->pending_mutex);
						for (auto& [rid, pr] : s->pending) {
							if (pr->client && pr->client->alive)
								enqueue_out(pr->client, "{\"type\":\"error\",\"sessionId\":\"" + sid +
								            "\",\"id\":\"" + rid + "\",\"error\":\"session deleted\"}");
							delete pr;
						}
						s->pending.clear();
					}
					{
						std::lock_guard<std::mutex> clk(g_clients_mutex);
						for (Client* cl : g_clients) {
							std::lock_guard<std::mutex> sl(cl->seq_mutex);
							cl->live_lo.erase(sid); cl->live_hi.erase(sid); cl->replayed_hi.erase(sid);
						}
					}
					{
						std::lock_guard<std::mutex> rl(s->ring_mutex);
						if (s->persist_fp) { fclose(s->persist_fp); s->persist_fp = nullptr; }
						std::error_code rmec;
						fs::remove(rig_sessions_dir() / (sid + ".meta.json"), rmec);
						fs::remove(rig_sessions_dir() / (sid + ".jsonl"), rmec);
					}
					g_sessions.erase(it);
					retire([s] { delete s; });
					erased = true;
				}
			}
			if (erased) {
				broadcast("{\"type\":\"session.deleted\",\"sessionId\":\"" + sid + "\"}");
				log("session " + sid + " deleted");
			}
		}
		reply({{"type", "ok"}, {"for", "session.delete"}});
		return;
	}

	if (type == "sessions.list") {
		std::lock_guard<std::mutex> lock(g_sessions_mutex);
		json r = {{"type", "sessions.list"}, {"sessions", sessions_json_locked()}};
		if (m.contains("id")) r["id"] = m["id"];
		send_json(c, r);
		return;
	}

	// session.meta {sessionId, pinned?, hidden?, lastReadSeq?} — inbox
	// bookkeeping: set whichever fields arrive, persist, then broadcast the
	// change so a second device (or a reopened app) sees the same inbox.
	if (type == "session.meta") {
		Session* s = find_session(m.value("sessionId", ""));
		if (!s) { reply({{"type", "error"}, {"error", "no such session"}}); return; }
		bool touched = false;
		if (m.contains("pinned") && m["pinned"].is_boolean()) {
			s->pinned = m["pinned"].get<bool>(); touched = true;
		}
		if (m.contains("hidden") && m["hidden"].is_boolean()) {
			s->hidden = m["hidden"].get<bool>(); touched = true;
		}
		if (m.contains("lastReadSeq") && m["lastReadSeq"].is_number()) {
			s->last_read_seq = m["lastReadSeq"].get<int64_t>(); touched = true;
		}
		if (touched) {
			persist_meta(s);
			json ev = {{"type", "session.meta"}, {"sessionId", s->id},
			           {"pinned", s->pinned.load()}, {"hidden", s->hidden.load()},
			           {"lastReadSeq", s->last_read_seq.load()}};
			broadcast(ev.dump());
		}
		json r = {{"type", "session.meta"}, {"sessionId", s->id},
		          {"pinned", s->pinned.load()}, {"hidden", s->hidden.load()},
		          {"lastReadSeq", s->last_read_seq.load()}};
		if (m.contains("id")) r["id"] = m["id"];
		send_json(c, r);
		return;
	}

	// replay buffered frames after seq `since`, so reconnects lose nothing.
	// Exactly-once: seqs this client already received live (or already had
	// replayed) are skipped — the live marks are set under this same ring
	// lock by session_emit, so the two paths can never double-deliver or
	// reorder.
	if (type == "session.subscribe") {
		Session* s = find_session(m.value("sessionId", ""));
		if (!s) { reply({{"type", "error"}, {"error", "no such session"}}); return; }
		uint64_t since = 0;
		if (m.contains("since")) {
			const json& sv = m["since"];
			bool ok = false;
			if (sv.is_number_unsigned()) { since = sv.get<uint64_t>(); ok = true; }
			else if (sv.is_number_integer() && sv.get<int64_t>() >= 0) { since = uint64_t(sv.get<int64_t>()); ok = true; }
			else if (sv.is_string()) { // tolerate "42" from js clients that stringify seqs
				const std::string st = sv.get<std::string>();
				if (!st.empty() && st.find_first_not_of("0123456789") == std::string::npos) {
					since = std::strtoull(st.c_str(), nullptr, 10);
					ok = true;
				}
			}
			if (!ok) {
				reply({{"type", "error"}, {"sessionId", s->id},
				              {"error", "since must be a non-negative integer seq"}});
				return;
			}
		}
		uint64_t last_seq = 0;
		{
			// Snapshot under the ring lock: live marks are only written under
			// this same lock by session_emit, so marks+ring are one consistent
			// cut — replay outside the lock can't double-deliver or reorder, and
			// the emit path no longer stalls behind a slow client's replay burst.
			std::deque<std::pair<uint64_t, std::shared_ptr<const std::string>>> snap;
			uint64_t lo = 0, hi = 0, rhi = 0;
			{
				std::lock_guard<std::mutex> lock(s->ring_mutex);
				std::lock_guard<std::mutex> sl(c->seq_mutex);
				auto li = c->live_lo.find(s->id); if (li != c->live_lo.end()) lo = li->second;
				auto ji = c->live_hi.find(s->id); if (ji != c->live_hi.end()) hi = ji->second;
				auto ki = c->replayed_hi.find(s->id); if (ki != c->replayed_hi.end()) rhi = ki->second;
				// since=0 is an explicit from-scratch request: the app rebuilds
				// its thread on every subscribe, so it must get the whole ring
				// again even though an earlier subscribe on this connection
				// already delivered it. replayed_hi only dedupes incremental
				// (since>0) resubscribes, and live marks must be ignored too —
				// a from-scratch rebuild lost that state and needs every seq.
				if (!since) { rhi = 0; lo = 0; hi = 0; }
				// snapshot only the seqs this client actually needs — pointer
				// copies, no frame text duplicated under the lock
				for (auto& e : s->ring) {
					if (e.first <= since || e.first <= rhi) continue;
					if (lo && e.first >= lo && e.first <= hi) continue;
					snap.push_back(e);
				}
			}
			uint64_t new_rhi = rhi;
			for (auto& [seq, raw] : snap) {
				if (!c->alive) break;
				// a replay burst can exceed the outbox cap — enqueue_out would
				// kill the client mid-replay and silently skip seqs. Throttle to
				// drain speed; a client that truly can't keep up gets an explicit
				// truncation error it can resubscribe past (replayed_hi is honest).
				if (!outbox_burst_pause(c)) {
					reply({{"type", "error"}, {"sessionId", s->id},
					              {"error", "replay truncated: client too slow — resubscribe to continue"}});
					break;
				}
				std::string out = "{\"type\":\"rpc\",\"sessionId\":\"" + s->id +
				                  "\",\"seq\":" + std::to_string(seq) + ",\"replay\":true,\"frame\":";
				out += *raw;
				out += "}";
				enqueue_out(c, out);
				last_seq = seq;
				if (seq > new_rhi) new_rhi = seq;
			}
			if (new_rhi != rhi) {
				std::lock_guard<std::mutex> sl(c->seq_mutex);
				c->replayed_hi[s->id] = new_rhi;
			}
		}
		reply({{"type", "session.subscribed"}, {"sessionId", s->id},
		              {"replayedTo", last_seq}, {"liveSeq", s->seq.load()}});
		return;
	}

	// Deep history paging — the bounded ring (32MB/4096 entries) evicts old
	// turns on long-lived sessions, so scroll-back needs the persisted log.
	// seq in the ring is the 1-based line number in <id>.jsonl, stable across
	// restarts, so a page is just a line range: (before-limit, before).
	// Request: {"type":"session.history","sessionId":…,"before":seq,"limit":N}
	// Frames stream oldest→newest as rpc rows with replay+history flags, then
	// a session.history ack {oldestSeq,totalLines,exhausted} — exhausted means
	// seq 1 reached and no earlier pages exist.
	if (type == "session.history") {
		Session* s = find_session(m.value("sessionId", ""));
		if (!s) { reply({{"type", "error"}, {"error", "no such session"}}); return; }
		uint64_t before = 0;
		{
			const json& bv = m["before"];
			bool ok = false;
			if (bv.is_number_unsigned()) { before = bv.get<uint64_t>(); ok = true; }
			else if (bv.is_number_integer() && bv.get<int64_t>() > 0) { before = uint64_t(bv.get<int64_t>()); ok = true; }
			else if (bv.is_string()) {
				const std::string st = bv.get<std::string>();
				if (!st.empty() && st.find_first_not_of("0123456789") == std::string::npos) {
					before = std::strtoull(st.c_str(), nullptr, 10); ok = true;
				}
			}
			if (!ok || before == 0) {
				reply({{"type", "error"}, {"sessionId", s->id},
				              {"error", "before must be a positive integer seq"}});
				return;
			}
		}
		int64_t lim64 = 120;
		if (m.contains("limit") && m["limit"].is_number_integer())
			lim64 = m["limit"].get<int64_t>();
		if (lim64 < 1) lim64 = 1;
		if (lim64 > 400) lim64 = 400;
		const uint64_t limit = uint64_t(lim64);

		fs::path log_path = rig_sessions_dir() / (s->id + ".jsonl");
		std::ifstream lf(log_path);
		if (!lf) {
			reply({{"type", "session.history"}, {"sessionId", s->id},
			              {"oldestSeq", 0}, {"totalLines", 0}, {"exhausted", true}});
			return;
		}
		// Sequential scan keeps memory flat on huge logs — 280MB transcripts
		// exist in the wild; only the wanted window is materialized.
		uint64_t n = 0, hi = before - 1, lo = (before > limit) ? before - limit : 1;
		std::deque<std::pair<uint64_t, std::string>> page;
		std::string line;
		while (std::getline(lf, line)) {
			if (!line.empty() && line.back() == '\r') line.pop_back();
			if (line.empty()) continue; // blank lines don't take seqs (writer never emits them)
			n++;
			if (n < lo || n > hi) continue;
			if (json::parse(line, nullptr, false).is_discarded()) continue;
			page.emplace_back(n, std::move(line));
		}
		for (auto& [seq, raw] : page) {
			if (!c->alive) break;
			// same burst pacing as session.subscribe replay — a 400-frame
			// page pushed back-to-back otherwise floods the outbox under a
			// slow link and burns the client's overload grace clock
			if (!outbox_burst_pause(c)) break;
			std::string out = "{\"type\":\"rpc\",\"sessionId\":\"" + s->id +
			                  "\",\"seq\":" + std::to_string(seq) +
			                  ",\"replay\":true,\"history\":true,\"frame\":";
			out += raw;
			out += "}";
			enqueue_out(c, out);
		}
		reply({{"type", "session.history"}, {"sessionId", s->id},
		              {"oldestSeq", page.empty() ? 0 : page.front().first},
		              {"totalLines", n},
		              {"exhausted", lo <= 1 || page.empty()}});
		return;
	}

	// transparent passthrough — client manages its own command ids
	if (type == "rpc") {
		Session* s = find_session(m.value("sessionId", ""));
		if (!s) {
			reply({{"type", "error"}, {"error", "no such session"}, {"sessionId", m.value("sessionId", "")}});
			return;
		}
		if (!m.contains("frame") || !m["frame"].is_object()) {
			reply({{"type", "error"}, {"error", "rpc.frame must be an omp command object"}});
			return;
		}
		if (!s->running.load() && s->stdin_fd < 0) {
			std::string rerr;
			if (!session_resume(s, rerr)) {
				reply({{"type", "error"}, {"error", "session resume failed: " + rerr}, {"sessionId", s->id}});
				return;
			}
		}
		harvest_live_title(s, m["frame"]);

		// non-omp harness: translate the app's omp-shaped frames into the
		// child's own protocol instead of passing them through. claude's
		// stdin wants a user-message NDJSON object; it also never echoes
		// stdin, so the user's bubble + turn start are committed to the
		// ring synthetically (same slots omp's transcript replay fills).
		if (s->harness != "omp") {
			const std::string ft = m["frame"].value("type", "");
			if (s->harness == "claude" && ft == "prompt") {
				const std::string text = m["frame"].value("message", "");
				json content = json::array();
				content.push_back({{"type", "text"}, {"text", text}});
				json umsg = {{"role", "user"}, {"content", content}};
				emit_translated(s, {{"type", "message_end"}, {"message", umsg}});
				json cframe = {{"type", "user"},
				    {"message", {{"role", "user"}, {"content", content}}}};
				std::string line = cframe.dump();
				line.push_back('\n');
				bool wok;
				{
					std::lock_guard<std::mutex> wlock(s->write_mutex);
					wok = s->stdin_fd >= 0 && write_all_fd(s->stdin_fd, line.data(), line.size());
				}
				if (!wok) {
					reply({{"type", "error"}, {"error", "write to harness failed"}, {"sessionId", s->id}});
					return;
				}
				emit_translated(s, {{"type", "agent_start"}});
				return;
			}
			if (s->harness == "claude" && ft == "interrupt") {
				if (s->pid > 0) { kill(-s->pid, SIGINT); kill(s->pid, SIGINT); }
				return;
			}
			reply({{"type", "error"},
			       {"error", "frame type '" + ft + "' is not supported on the " + s->harness + " harness"},
			       {"sessionId", s->id}});
			return;
		}

		std::string line = m["frame"].dump();
		line.push_back('\n');
		std::lock_guard<std::mutex> wlock(s->write_mutex);
		if (s->stdin_fd < 0 || !write_all_fd(s->stdin_fd, line.data(), line.size()))
			reply({{"type", "error"}, {"error", "write to omp failed"}, {"sessionId", s->id}});
		return;
	}

	// daemon-correlated request — response comes back privately as session.response
	if (type == "session.request") {
		Session* s = find_session(m.value("sessionId", ""));
		if (!s) { reply({{"type", "error"}, {"error", "no such session"}}); return; }
		if (!m.contains("frame") || !m["frame"].is_object()) {
			reply({{"type", "error"}, {"error", "session.request.frame must be an object"}});
			return;
		}
		json frame = m["frame"];
		if (m.contains("id")) frame["_cid"] = m["id"]; // echoed on session.response
		if (!session_request(s, frame, c, nullptr))
			reply({{"type", "error"}, {"error", "write to omp failed"}});
		return;
	}

	// token-efficiency surface: live context usage via get_state (correlated)
	if (type == "session.usage") {
		Session* s = find_session(m.value("sessionId", ""));
		if (!s) { reply({{"type", "error"}, {"error", "no such session"}}); return; }
		json frame = {{"type", "get_state"}};
		if (m.contains("id")) frame["_cid"] = m["id"];
		if (!session_request(s, frame, c, nullptr))
			reply({{"type", "error"}, {"error", "write to omp failed"}});
		return;
	}

	// master control — cross-session fan-outs
	if (type == "sessions.subagents" || type == "sessions.compact" || type == "sessions.abortAll") {
		std::vector<Session*> targets;
		{
			std::lock_guard<std::mutex> lock(g_sessions_mutex);
			for (auto& [id, s] : g_sessions) targets.push_back(s);
		}
		if (targets.empty()) {
			json r = {{"type", type}, {"results", json::array()}};
			if (m.contains("id")) r["id"] = m["id"];
			send_json(c, r);
			return;
		}
		if (type == "sessions.abortAll") {
			for (Session* s : targets) {
				json frame = {{"type", "abort"}};
				session_request(s, frame, nullptr, nullptr, 5000);
			}
			json r = {{"type", "ok"}, {"for", "sessions.abortAll"}, {"sessions", targets.size()}};
			if (m.contains("id")) r["id"] = m["id"];
			send_json(c, r);
			return;
		}
		auto* fanout = new Fanout{c, type, m.value("id", ""), targets.size(), now_ms() + 15000, json::array()};
		{
			std::lock_guard<std::mutex> lock(g_fanout_mutex);
			g_fanouts.push_back(fanout);
		}
		for (Session* s : targets) {
			json frame = type == "sessions.subagents"
			             ? json{{"type", "get_subagents"}}
			             : json{{"type", "compact"}};
			if (type == "sessions.compact" && m.contains("instructions"))
				frame["customInstructions"] = m["instructions"];
			if (!session_request(s, frame, nullptr, fanout)) {
				// same mutex as the reader's decrement — racing paths could
				// otherwise both hit zero and double-delete the fanout
				std::lock_guard<std::mutex> lock(g_fanout_mutex);
				if (--fanout->remaining == 0) {
					json freply = {{"type", fanout->reply_type}, {"results", fanout->collected}};
					if (!fanout->req_id.empty()) freply["id"] = fanout->req_id;
					send_json(c, freply);
					for (size_t i = 0; i < g_fanouts.size(); i++)
						if (g_fanouts[i] == fanout) { g_fanouts.erase(g_fanouts.begin() + long(i)); break; }
					delete fanout;
					return;
				}
			}
		}
		return;
	}

	// ---- native filesystem ops: no agent, no shell, no omp — pure C++ ----
	// read/write are O(µs); glob/grep walk trees and go on a worker thread so
	// a huge scan can't stall the client's reader loop
	if (type.rfind("rig.fs.", 0) == 0) {
		std::string req_id = m.value("id", "");
		auto fs_reply = [c, req_id](const json& data) {
			json r = data;
			r["type"] = "rig.fs.result";
			if (!req_id.empty()) r["id"] = req_id;
			send_json(c, r);
		};
		if (type == "rig.fs.list") {
			fs_reply(rigfs::op_list(m));
			return;
		}
		if (type == "rig.fs.mkdir") {
			fs_reply(rigfs::op_mkdir(m));
			return;
		}
		if (type == "rig.fs.stat") {
			fs_reply(rigfs::op_stat(m));
			return;
		}
		if (type == "rig.fs.read") {
			fs_reply(rigfs::op_read(m));
			return;
		}
		if (type == "rig.fs.write") {
			fs_reply(rigfs::op_write(m));
			return;
		}
		if (type == "rig.fs.glob") {
			json mm = m;
			spawn_guarded(c, [fs_reply, mm] { fs_reply(rigfs::op_glob(mm)); });
			return;
		}
		if (type == "rig.fs.grep") {
			json mm = m;
			spawn_guarded(c, [fs_reply, mm] { fs_reply(rigfs::op_grep(mm)); });
			return;
		}
		send_json(c, {{"type", "error"}, {"error", "unknown rig.fs op: " + type},
		              {"id", req_id.empty() ? json(nullptr) : json(req_id)}});
		return;
	}

	// ---- rig.vitals — the host's own health: battery, uptime, load, disk,
	// memory, wifi. Probes are per-OS and every field is independently
	// nullable: what the machine can't answer comes back null, never a
	// fabricated number. READ-scoped; runs on a worker so a slow probe
	// (powershell, sysctl) can't stall the client's reader loop.
	if (type == "rig.vitals") {
		std::string req_id = m.value("id", "");
		spawn_guarded(c, [c, req_id] {
			json v = {{"ok", true}, {"probedAt", wall_ms()}, {"os",
#if defined(_WIN32)
			           "windows"
#elif defined(__APPLE__)
			           "macos"
#else
			           "linux"
#endif
			         }};

			// battery: pmset / /sys/class/power_supply / Win32_Battery
			v["battery"] = json(nullptr);
#if defined(__APPLE__)
			{
				Capture r = run_capture("pmset -g batt 2>/dev/null", 6000);
				if (r.code == 0 && !r.out.empty()) {
					json b;
					size_t q1 = r.out.find('\'');
					size_t q2 = q1 == std::string::npos ? q1 : r.out.find('\'', q1 + 1);
					if (q1 != std::string::npos && q2 != std::string::npos)
						b["source"] = r.out.substr(q1 + 1, q2 - q1 - 1);
					size_t pct = r.out.find('%');
					if (pct != std::string::npos) {
						size_t s = pct;
						while (s > 0 && isdigit((unsigned char)r.out[s - 1])) s--;
						if (s < pct) b["pct"] = std::atoi(r.out.substr(s, pct - s).c_str());
						// the state word sits between '%' and the next ';'
						size_t st = r.out.find(';', pct);
						if (st != std::string::npos) {
							st++;
							while (st < r.out.size() && r.out[st] == ' ') st++;
							size_t en = r.out.find(';', st);
							if (en == std::string::npos) en = r.out.find('\n', st);
							if (en != std::string::npos && en > st) {
								std::string w = r.out.substr(st, en - st);
								while (!w.empty() && w.back() == ' ') w.pop_back();
								b["state"] = w;
								b["charging"] = w.find("discharg") == std::string::npos &&
								                w.find("charg") != std::string::npos;
							}
						}
					}
					if (!b.empty()) v["battery"] = b;
				}
			}
#elif defined(_WIN32)
			{
				Capture r = run_capture(
					"powershell -NoProfile -Command \"try{$b=Get-CimInstance Win32_Battery;"
					"if($b){'{0}|{1}' -f $b.EstimatedChargeRemaining,$b.BatteryStatus}}catch{}\"",
					15000);
				if (r.code == 0) {
					size_t bar = r.out.find('|');
					if (bar != std::string::npos) {
						json b;
						b["pct"] = std::atoi(r.out.substr(0, bar).c_str());
						int bs = std::atoi(r.out.substr(bar + 1).c_str());
						b["state"] = bs == 2 ? "charging" : bs == 1 ? "discharging" : "unknown";
						b["charging"] = bs == 2;
						v["battery"] = b;
					}
				}
			}
#else
			{
				std::error_code ec;
				for (auto& ent : fs::directory_iterator("/sys/class/power_supply", ec)) {
					std::string name = ent.path().filename().string();
					if (name.rfind("BAT", 0) != 0) continue;
					auto slurp = [&](const char* f) -> std::string {
						std::ifstream in(ent.path() / f);
						std::string s;
						std::getline(in, s);
						return s;
					};
					std::string cap = slurp("capacity"), st = slurp("status");
					if (cap.empty() && st.empty()) continue;
					json b;
					if (!cap.empty()) b["pct"] = std::atoi(cap.c_str());
					if (!st.empty()) {
						b["state"] = st;
						b["charging"] = st == "Charging" || st == "Full";
					}
					v["battery"] = b;
					break;
				}
			}
#endif

			// uptime: kern.boottime / /proc/uptime / GetTickCount64
			v["uptimeSec"] = json(nullptr);
#if defined(_WIN32)
			v["uptimeSec"] = int64_t(GetTickCount64() / 1000);
#elif defined(__APPLE__)
			{
				Capture r = run_capture("sysctl -n kern.boottime 2>/dev/null", 4000);
				if (r.code == 0) {
					// "{ sec = 1700000000, usec = 0 } …" or a bare epoch
					const char* p = strstr(r.out.c_str(), "sec = ");
					long long bt = p ? std::atoll(p + 6) : std::atoll(r.out.c_str());
					if (bt > 0) v["uptimeSec"] = int64_t(time(nullptr) - bt);
				}
			}
#else
			{
				std::ifstream in("/proc/uptime");
				double up = 0;
				if (in >> up) v["uptimeSec"] = int64_t(up);
			}
#endif

			// load: getloadavg on POSIX; Windows reports cpuPct instead
			v["load"] = json(nullptr);
#if defined(_WIN32)
			{
				Capture r = run_capture(
					"powershell -NoProfile -Command \"(Get-CimInstance Win32_Processor |"
					" Measure-Object -Property LoadPercentage -Average).Average\"",
					15000);
				if (r.code == 0) {
					std::string t = r.out;
					if (t.find_first_not_of(" \r\n\t") != std::string::npos)
						v["cpuPct"] = std::atoi(t.c_str());
				}
			}
#else
			{
				double la[3];
				if (getloadavg(la, 3) == 3) v["load"] = {la[0], la[1], la[2]};
			}
#endif

			// disk: free space under the rig dir (std::filesystem, every OS)
			v["disk"] = json(nullptr);
			{
				std::error_code ec;
				auto sp = fs::space(g_rig.dir.empty() ? fs::path(home_dir()) : g_rig.dir, ec);
				if (!ec)
					v["disk"] = {{"free", int64_t(sp.free)},
					             {"avail", int64_t(sp.available)},
					             {"total", int64_t(sp.capacity)}};
			}

			// memory: vm_stat+hw.memsize / /proc/meminfo / GlobalMemoryStatusEx
			v["mem"] = json(nullptr);
#if defined(__APPLE__)
			{
				Capture t = run_capture("sysctl -n hw.memsize 2>/dev/null", 4000);
				Capture vs = run_capture("vm_stat 2>/dev/null", 4000);
				if (t.code == 0 && vs.code == 0) {
					long long total = std::atoll(t.out.c_str());
					long long page = 4096, freep = 0, inact = 0, spec = 0;
					size_t ps = vs.out.find("page size of ");
					if (ps != std::string::npos) page = std::atoll(vs.out.c_str() + ps + 13);
					std::istringstream in(vs.out);
					std::string ln;
					auto field = [](const std::string& l) -> long long {
						size_t c = l.find(':');
						if (c == std::string::npos) return -1;
						std::string d;
						for (size_t i = c + 1; i < l.size(); i++)
							if (isdigit((unsigned char)l[i])) d += l[i];
						return d.empty() ? -1 : std::atoll(d.c_str());
					};
					while (std::getline(in, ln)) {
						if (ln.rfind("Pages free:", 0) == 0) freep = field(ln);
						else if (ln.rfind("Pages inactive:", 0) == 0) inact = field(ln);
						else if (ln.rfind("Pages speculative:", 0) == 0) spec = field(ln);
					}
					if (total > 0) {
						long long avail = (freep + inact + (spec > 0 ? spec : 0)) * page;
						json mm = {{"total", total}, {"avail", avail}};
						if (avail >= 0) mm["usedPct"] = int64_t(100 - avail * 100 / total);
						v["mem"] = mm;
					}
				}
			}
#elif defined(_WIN32)
			{
				MEMORYSTATUSEX ms{};
				ms.dwLength = sizeof(ms);
				if (GlobalMemoryStatusEx(&ms))
					v["mem"] = {{"total", int64_t(ms.ullTotalPhys)},
					            {"avail", int64_t(ms.ullAvailPhys)},
					            {"usedPct", int64_t(ms.dwMemoryLoad)}};
			}
#else
			{
				std::ifstream in("/proc/meminfo");
				std::string ln;
				long long total = -1, avail = -1;
				while (std::getline(in, ln)) {
					if (ln.rfind("MemTotal:", 0) == 0) total = std::atoll(ln.c_str() + 9) * 1024;
					else if (ln.rfind("MemAvailable:", 0) == 0) avail = std::atoll(ln.c_str() + 13) * 1024;
				}
				if (total > 0) {
					json mm = {{"total", total}, {"avail", avail}};
					if (avail >= 0) mm["usedPct"] = int64_t(100 - avail * 100 / total);
					v["mem"] = mm;
				}
			}
#endif

			// wifi: ipconfig getsummary / netsh / iwgetid — ssid only when the
			// OS actually reports one (headless rigs report null)
			v["net"] = json(nullptr);
#if defined(__APPLE__)
			{
				Capture r = run_capture("ipconfig getsummary en0 2>/dev/null", 5000);
				if (r.code == 0) {
					size_t p = r.out.find("SSID : ");
					if (p != std::string::npos) {
						p += 7;
						size_t e = r.out.find('\n', p);
						v["net"] = {{"ssid", r.out.substr(p, e - p)}, {"if", "en0"}};
					}
				}
			}
#elif defined(_WIN32)
			{
				Capture r = run_capture("netsh wlan show interfaces", 8000);
				if (r.code == 0) {
					std::istringstream in(r.out);
					std::string ln;
					while (std::getline(in, ln)) {
						size_t s = ln.find("SSID");
						if (s == std::string::npos || ln.find("BSSID") != std::string::npos)
							continue;
						size_t col = ln.find(':', s + 4);
						if (col == std::string::npos) continue;
						std::string ssid = ln.substr(col + 1);
						size_t a = ssid.find_first_not_of(" \t\r");
						size_t b = ssid.find_last_not_of(" \t\r");
						if (a != std::string::npos) {
							v["net"] = {{"ssid", ssid.substr(a, b - a + 1)}};
							break;
						}
					}
				}
			}
#else
			{
				Capture r = run_capture("iwgetid -r 2>/dev/null", 4000);
				if (r.code == 0) {
					std::string s = r.out;
					size_t a = s.find_first_not_of(" \r\n\t");
					size_t b = s.find_last_not_of(" \r\n\t");
					if (a != std::string::npos) v["net"] = {{"ssid", s.substr(a, b - a + 1)}};
				}
			}
#endif

			json r = v;
			r["type"] = "rig.vitals";
			if (!req_id.empty()) r["id"] = req_id;
			send_json(c, r);
		});
		return;
	}

	// ---- pull-request lookup via the host's gh CLI: real PR state on the
	// phone. Honest fallback — gh missing/unauthed → ok:false, and the
	// client keeps its "not reported" empty state rather than faking data.
	if (type == "rig.pr.info") {
		std::string req_id = m.value("id", "");
		std::string url = m.value("url", "");
		auto shq = [](const std::string& s) {
			std::string o = "'";
			for (char ch : s) { if (ch == '\'') o += "'\\''"; else o += ch; }
			return o + "'";
		};
		json reply_data;
		if (url.rfind("https://", 0) != 0 && url.rfind("http://", 0) != 0) {
			reply_data = {{"ok", false}, {"error", "url required (https://…/pull/N)"}};
		} else {
			// GH_BIN env overrides discovery (non-PATH installs, test rigs);
			// otherwise type -P resolves the real binary — interactive shells
			// may shadow `gh` with a function the daemon inherits via bash -lc.
			Capture r = run_capture(
				"GHBIN=${GH_BIN:-$(type -P gh || true)}; "
				"[ -z \"$GHBIN\" ] && { echo __nogh__; exit 3; }; "
				"\"$GHBIN\" pr view " + shq(url) +
					" --json number,title,state,isDraft,mergeable,statusCheckRollup,"
					"files,additions,deletions,headRefName,baseRefName,author,reviews",
				15000);
			if (r.code == 0) {
				try {
					reply_data = json::parse(r.out);
					reply_data["ok"] = true;
				} catch (...) {
					reply_data = {{"ok", false}, {"error", "gh returned non-JSON"}};
				}
			} else {
				std::string e = r.out.empty() ? "gh unavailable on the rig" : r.out;
				if (e.size() > 200) e = e.substr(0, 200);
				reply_data = {{"ok", false}, {"error", e}};
			}
		}
		json r = reply_data;
		r["type"] = "rig.pr.result";
		if (!req_id.empty()) r["id"] = req_id;
		send_json(c, r);
		return;
	}

	// rig.pr.merge {url, method:'squash'|'merge'|'rebase', deleteBranch?} —
	// the app-facing Merge pill. Real `gh pr merge` on the host; the reply
	// carries gh's own output so the client can show truth, not confetti.
	if (type == "rig.pr.merge") {
		std::string req_id = m.value("id", "");
		std::string url = m.value("url", "");
		std::string method = m.value("method", "squash");
		bool del = m.value("deleteBranch", false);
		auto pr_reply = [c, req_id](const json& data) {
			json r = data;
			r["type"] = "rig.pr.result";
			if (!req_id.empty()) r["id"] = req_id;
			send_json(c, r);
		};
		if ((url.rfind("https://", 0) != 0 && url.rfind("http://", 0) != 0) ||
		    (method != "squash" && method != "merge" && method != "rebase")) {
			pr_reply({{"ok", false}, {"error", "url + method(squash|merge|rebase) required"}});
			return;
		}
		spawn_guarded(c, [pr_reply, url, method, del] {
			std::string cmd =
				"GHBIN=${GH_BIN:-$(type -P gh || true)}; "
				"[ -z \"$GHBIN\" ] && { echo __nogh__; exit 3; }; "
				"\"$GHBIN\" pr merge " + shell_quote(url) + " --" + method +
				(del ? " --delete-branch" : "") + " 2>&1";
			Capture r = run_capture(cmd, 30000);
			std::string out = r.out;
			if (out.size() > 500) out = out.substr(0, 500);
			pr_reply({{"ok", r.code == 0}, {"method", method},
			       {"error", r.code == 0 ? json(nullptr) : json(out.empty() ? "gh merge failed" : out)},
			       {"output", out}});
		});
		return;
	}

	// rig.pr.checks {url} — the live CI rollup via `gh pr checks --json`.
	// gh exits 1 on failures and 8 on pending but still prints JSON — we
	// parse stdout either way and roll our own bucket counts, so a red CI
	// run answers ok:true with state:"fail" instead of looking like a probe
	// error.
	if (type == "rig.pr.checks") {
		std::string req_id = m.value("id", "");
		std::string url = m.value("url", "");
		auto pr_reply = [c, req_id](const json& data) {
			json r = data;
			r["type"] = "rig.pr.result";
			if (!req_id.empty()) r["id"] = req_id;
			send_json(c, r);
		};
		if (url.rfind("https://", 0) != 0 && url.rfind("http://", 0) != 0) {
			pr_reply({{"ok", false}, {"error", "url required (https://…/pull/N)"}});
			return;
		}
		spawn_guarded(c, [pr_reply, url] {
			Capture r = run_capture(
				"GHBIN=${GH_BIN:-$(type -P gh || true)}; "
				"[ -z \"$GHBIN\" ] && { echo __nogh__; exit 3; }; "
				"\"$GHBIN\" pr checks " + shell_quote(url) +
					" --json name,state,bucket,workflow,link,startedAt,completedAt 2>&1",
				30000);
			json checks;
			try { checks = json::parse(r.out); } catch (...) {}
			if (!checks.is_array()) {
				std::string e = r.out.empty() ? "gh unavailable on the rig" : r.out;
				if (e.size() > 200) e = e.substr(0, 200);
				pr_reply({{"ok", false}, {"error", e}});
				return;
			}
			int pass = 0, fail = 0, pend = 0, skip = 0;
			for (auto& ch : checks) {
				std::string b = ch.value("bucket", "");
				if (b == "pass") pass++;
				else if (b == "fail") fail++;
				else if (b == "pending") pend++;
				else skip++;
			}
			pr_reply({{"ok", true}, {"checks", checks},
			          {"rollup", {{"pass", pass}, {"fail", fail}, {"pending", pend},
			                      {"skipped", skip}, {"total", int64_t(checks.size())},
			                      {"state", fail ? "fail" : pend ? "pending" :
			                                pass + skip ? "pass" : "none"}}}});
		});
		return;
	}

	// rig.pr.create {cwd, title?, body?, draft?, base?, head?, fill?} — real
	// `gh pr create` inside the session's repo. gh prints the new PR URL on
	// success; the reply surfaces it verbatim so the app can deep-link the
	// thread's PR card straight to it.
	if (type == "rig.pr.create") {
		std::string req_id = m.value("id", "");
		std::string cwd = m.value("cwd", "");
		std::string title = m.value("title", "");
		std::string body = m.value("body", "");
		bool draft = m.value("draft", false);
		bool fill = m.value("fill", false);
		std::string base = m.value("base", "");
		std::string head = m.value("head", "");
		auto pr_reply = [c, req_id](const json& data) {
			json r = data;
			r["type"] = "rig.pr.result";
			if (!req_id.empty()) r["id"] = req_id;
			send_json(c, r);
		};
		if (cwd.empty() || !fs::is_directory(cwd) || (title.empty() && !fill)) {
			pr_reply({{"ok", false}, {"error", "cwd + title (or fill) required"}});
			return;
		}
		spawn_guarded(c, [pr_reply, cwd, title, body, draft, fill, base, head] {
			std::string cmd =
				"cd " + shell_quote(cwd) + " || exit 4; "
				"GHBIN=${GH_BIN:-$(type -P gh || true)}; "
				"[ -z \"$GHBIN\" ] && { echo __nogh__; exit 3; }; "
				"\"$GHBIN\" pr create" +
				(fill ? " --fill" : "") +
				(title.empty() ? "" : " --title " + shell_quote(title)) +
				(fill ? "" : " --body " + shell_quote(body)) +
				(draft ? " --draft" : "") +
				(base.empty() ? "" : " --base " + shell_quote(base)) +
				(head.empty() ? "" : " --head " + shell_quote(head)) +
				" 2>&1";
			Capture r = run_capture(cmd, 45000);
			std::string out = r.out;
			if (out.size() > 600) out = out.substr(0, 600);
			// the new PR URL is the last https:// token gh prints
			std::string url;
			size_t p = out.rfind("https://");
			if (p != std::string::npos) {
				size_t e = out.find_first_of(" \t\r\n\"'", p);
				url = out.substr(p, e == std::string::npos ? e : e - p);
			}
			pr_reply({{"ok", r.code == 0}, {"url", url}, {"output", out},
			       {"error", r.code == 0 ? json(nullptr) : json(out.empty() ? "gh pr create failed" : out)}});
		});
		return;
	}

	// ---- narrow a paired device's scopes at runtime -----------------------
	// rig.device.scopes {device, scopes:["read","operate","admin"]} — takes
	// effect on the device's NEXT connection (devices.json is the truth);
	// already-connected clients keep their handshake-time mask.
	if (type == "rig.device.scopes") {
		std::string dev = m.value("device", "");
		uint32_t mask = m.contains("scopes") ? scope_mask(m["scopes"]) : 0;
		if (dev.empty() || !mask) {
			reply({{"type", "error"},
			              {"error", "device + non-empty scopes[] required"}});
			return;
		}
		bool found = false;
		{
			std::lock_guard<std::mutex> l(g_rig.mutex);
			for (auto& d : g_rig.devices)
				if (d.device == dev) { d.scopes = mask; found = true; }
			if (found) g_rig.save_locked();
		}
		if (!found) { reply({{"type", "error"}, {"error", "no such device"}}); return; }
		reply({{"type", "ok"}, {"for", "rig.device.scopes"},
		              {"device", dev}, {"scopes", scope_names(mask)}});
		return;
	}

	// ---- revoke a paired device (admin) ------------------------------------
	// rig.device.revoke {device} — drops it from devices.json; its token dies
	// on the next connect (live clients keep their socket).
	if (type == "rig.device.revoke") {
		std::string dev = m.value("device", "");
		bool found = false;
		{
			std::lock_guard<std::mutex> l(g_rig.mutex);
			for (size_t i = 0; i < g_rig.devices.size(); i++)
				if (g_rig.devices[i].device == dev) {
					g_rig.devices.erase(g_rig.devices.begin() + long(i));
					found = true; break;
				}
			if (found) g_rig.save_locked();
		}
		if (!found) { reply({{"type", "error"}, {"error", "no such device"}}); return; }
		reply({{"type", "ok"}, {"for", "rig.device.revoke"}, {"device", dev}});
		return;
	}

	// ---- routines: schedule a prompt to replay on an interval ------------
	// rig.schedule.add {prompt, cwd, everySec, model?, delaySec?} → job row.
	// list/remove/enable manage the ~/.rig/jobs.json table; a fired routine
	// spawns a real session whose turn streams to every client normally.
	if (type.rfind("rig.schedule.", 0) == 0) {
		if (type == "rig.schedule.add") {
			std::string prompt = m.value("prompt", "");
			int64_t every = m.value("everySec", int64_t(0));
			if (prompt.empty() || every < 10) {
				reply({{"type", "error"}, {"error", "prompt + everySec>=10 required"}});
				return;
			}
			SchedJob j;
			j.id = rig::random_hex(4);
			j.prompt = prompt;
			j.cwd = m.value("cwd", "");
			j.model = m.value("model", "");
			j.every_sec = every;
			j.next_run_ms = wall_ms() + int64_t(m.value("delaySec", 0)) * 1000;
			{
				std::lock_guard<std::mutex> lock(g_jobs_mutex);
				g_jobs.push_back(j);
				jobs_save_locked();
			}
			reply({{"type", "rig.schedule.added"}, {"jobId", j.id},
			              {"everySec", j.every_sec}, {"nextRunMs", j.next_run_ms}});
			return;
		}
		if (type == "rig.schedule.list") {
			json arr;
			{ std::lock_guard<std::mutex> lock(g_jobs_mutex); arr = jobs_json_locked(); }
			reply({{"type", "rig.schedule.list"}, {"jobs", arr}});
			return;
		}
		if (type == "rig.schedule.remove") {
			std::string jid = m.value("jobId", "");
			bool found = false;
			{
				std::lock_guard<std::mutex> lock(g_jobs_mutex);
				for (size_t i = 0; i < g_jobs.size(); i++)
					if (g_jobs[i].id == jid) { g_jobs.erase(g_jobs.begin() + long(i)); found = true; break; }
				if (found) jobs_save_locked();
			}
			if (!found) { reply({{"type", "error"}, {"error", "no such job"}}); return; }
			reply({{"type", "ok"}, {"for", "rig.schedule.remove"}, {"jobId", jid}});
			return;
		}
		if (type == "rig.schedule.enable") {
			std::string jid = m.value("jobId", "");
			bool en = m.value("enabled", true), found = false;
			{
				std::lock_guard<std::mutex> lock(g_jobs_mutex);
				for (auto& j : g_jobs)
					if (j.id == jid) {
						j.enabled = en;
						// re-arm from now — toggling a routine must not fire a
						// backlog of missed intervals into fresh sessions
						if (en) j.next_run_ms = wall_ms() + j.every_sec * 1000;
						found = true;
					}
				if (found) jobs_save_locked();
			}
			if (!found) { reply({{"type", "error"}, {"error", "no such job"}}); return; }
			reply({{"type", "ok"}, {"for", "rig.schedule.enable"}, {"jobId", jid}, {"enabled", en}});
			return;
		}
		reply({{"type", "error"}, {"error", "unknown rig.schedule op: " + type}});
		return;
	}

	// ---- per-workspace git surface: what actually changed in this session's
	// project. status parses porcelain v1 into rows + branch/ahead/behind;
	// diff streams the real patch (1MB cap, same as other captures). Cwd
	// comes from the session or an explicit cwd override. ok:false with the
	// real git error when the dir isn't a repo.
	if (type == "rig.git.status" || type == "rig.git.diff") {
		std::string req_id = m.value("id", "");
		std::string cwd = m.value("cwd", "");
		if (cwd.empty()) {
			Session* s = find_session(m.value("sessionId", ""));
			if (!s) { reply({{"type", "error"}, {"error", "sessionId or cwd required"}}); return; }
			cwd = s->cwd;
		}
		auto git_reply = [c, req_id](const json& data) {
			json r = data;
			r["type"] = "rig.git.result";
			if (!req_id.empty()) r["id"] = req_id;
			send_json(c, r);
		};
		if (type == "rig.git.status") {
			spawn_guarded(c, [git_reply, cwd] {
				Capture r = run_capture(
					"git -C " + shell_quote(cwd) + " status --porcelain=v1 --branch 2>&1", 8000);
				if (r.code != 0) {
					std::string e = r.out.empty() ? "git unavailable" : r.out;
					if (e.size() > 200) e = e.substr(0, 200);
					bool notRepo = e.find("not a git repository") != std::string::npos;
					git_reply({{"ok", false}, {"error", e}, {"notRepo", notRepo}});
					return;
				}
				json files = json::array();
				std::string branch, ahead = "0", behind = "0";
				std::istringstream in(r.out);
				std::string line;
				while (std::getline(in, line)) {
					if (line.rfind("## ", 0) == 0) {
						// "## main...origin/main [ahead 2, behind 1]" — take the
						// local name; detached heads show 'HEAD (no branch)'.
						std::string b = line.substr(3);
						auto dots = b.find("...");
						if (dots != std::string::npos) b = b.substr(0, dots);
						auto br = b.find(" [");
						if (br != std::string::npos) b = b.substr(0, br);
						branch = b;
						auto grab = [&](const char* key) {
							auto p = line.find(key);
							if (p == std::string::npos) return;
							size_t i = p + strlen(key);
							std::string n;
							while (i < line.size() && isdigit((unsigned char)line[i])) n += line[i++];
							if (key[0] == 'a') ahead = n.empty() ? "0" : n;
							else behind = n.empty() ? "0" : n;
						};
						grab("ahead "), grab("behind ");
						continue;
					}
					if (line.size() < 4) continue;
					std::string xy = line.substr(0, 2);
					std::string path = line.substr(3);
					auto arrow = path.find(" -> ");
					if (arrow != std::string::npos) path = path.substr(arrow + 4);
					if (path.size() > 1 && path.front() == '"' && path.back() == '"')
						path = path.substr(1, path.size() - 2);
					files.push_back({{"path", path},
					                 {"status", xy},
					                 {"staged", xy[0] != ' ' && xy[0] != '?'},
					                 {"unstaged", xy[1] != ' '}});
				}
				git_reply({{"ok", true}, {"branch", branch},
				       {"ahead", atoi(ahead.c_str())}, {"behind", atoi(behind.c_str())},
				       {"clean", files.empty()}, {"files", files}});
			});
			return;
		}
		// rig.git.diff: unified patch + --stat summary, optional path scope
		// and staged-only flag.
		{
			std::string path = m.value("path", "");
			bool staged = m.value("staged", false);
			spawn_guarded(c, [git_reply, cwd, path, staged] {
				std::string scope = path.empty() ? "" : " -- " + shell_quote(path);
				std::string flag = staged ? " --cached" : "";
				Capture stat = run_capture(
					"git -C " + shell_quote(cwd) + " diff" + flag + " --stat" + scope + " 2>&1", 8000);
				Capture dif = run_capture(
					"git -C " + shell_quote(cwd) + " diff" + flag + scope + " 2>&1", 15000);
				if (dif.code != 0) {
					std::string e = dif.out.empty() ? "git unavailable" : dif.out;
					if (e.size() > 200) e = e.substr(0, 200);
					git_reply({{"ok", false}, {"error", e}});
					return;
				}
				git_reply({{"ok", true}, {"staged", staged}, {"path", path},
				       {"stat", stat.code == 0 ? stat.out : std::string("")},
				       {"diff", dif.out}});
			});
			return;
		}
	}

	// ---- per-turn checkpoints: hidden git refs (refs/rig/checkpoints/<sid>/<n>)
	// capturing the whole worktree, untracked included. A throwaway index is
	// seeded from HEAD and `add -A` + `write-tree` + `commit-tree` run against
	// it, so the real index and working files are never touched. This is the
	// T3 pattern: every turn gets a rewindable snapshot. ----
	if (type == "rig.checkpoint.create" || type == "rig.checkpoint.list" ||
	    type == "rig.checkpoint.restore") {
		std::string req_id = m.value("id", "");
		std::string cwd = m.value("cwd", "");
		std::string sid = m.value("sessionId", "");
		if (cwd.empty()) {
			Session* s = find_session(sid);
			if (!s) { reply({{"type", "error"}, {"error", "sessionId or cwd required"}}); return; }
			cwd = s->cwd;
		}
		if (sid.empty()) {
			Session* s = find_session(m.value("sessionId", ""));
			sid = s ? s->id : "ws";
		}
		std::string label = m.value("label", "");
		std::string ref = m.value("ref", "");
		std::string ns = "refs/rig/checkpoints/" + sid;
		auto cp_reply = [c, req_id](const json& data) {
			json r = data;
			r["type"] = "rig.checkpoint.result";
			if (!req_id.empty()) r["id"] = req_id;
			send_json(c, r);
		};
		if (type == "rig.checkpoint.list") {
			spawn_guarded(c, [cp_reply, cwd, ns] {
				Capture r = run_capture(
					"git -C " + shell_quote(cwd) +
						" for-each-ref --sort=-creatordate --format='%(refname)%00%(creatordate:unix)%00%(subject)' " +
						shell_quote(ns) + " 2>&1",
					8000);
				if (r.code != 0) {
					std::string e = r.out.empty() ? "not a git worktree" : r.out;
					if (e.size() > 200) e = e.substr(0, 200);
					cp_reply({{"ok", false}, {"error", e}});
					return;
				}
				json cps = json::array();
				std::istringstream in(r.out);
				std::string line;
				while (std::getline(in, line)) {
					if (line.empty()) continue;
					auto nul1 = line.find('\0'), nul2 = line.find('\0', nul1 + 1);
					if (nul1 == std::string::npos || nul2 == std::string::npos) continue;
					cps.push_back({{"ref", line.substr(0, nul1)},
					               {"ts", atoll(line.substr(nul1 + 1, nul2 - nul1 - 1).c_str())},
					               {"label", line.substr(nul2 + 1)}});
				}
				cp_reply({{"ok", true}, {"checkpoints", cps}});
			});
			return;
		}
		if (type == "rig.checkpoint.create") {
			spawn_guarded(c, [cp_reply, cwd, sid, label] {
				cp_reply(rig_capture_checkpoint(cwd, sid, label));
			});
			return;
		}
		// rig.checkpoint.restore: dry-run unless confirm:true. Rewinds
		// tracked files to the checkpoint tree and lists (then, on confirm,
		// removes) untracked files the checkpoint doesn't carry — T3-style
		// full rewind, so the preview must be shown first.
		if (ref.empty()) { reply({{"type", "error"}, {"error", "ref required"}}); return; }
		bool confirm = m.value("confirm", false);
		spawn_guarded(c, [cp_reply, cwd, ref, confirm] {
			Capture ver = run_capture(
				"git -C " + shell_quote(cwd) + " rev-parse --verify " + shell_quote(ref) +
					"^{commit} 2>/dev/null",
				8000);
			if (ver.code != 0) {
				cp_reply({{"ok", false}, {"error", "unknown ref " + ref}});
				return;
			}
			// What would a rewind touch? Worktree files that differ from the
			// checkpoint (diff <ref> = worktree vs ref) + untracked files the
			// checkpoint doesn't carry.
			Capture diff = run_capture(
				"git -C " + shell_quote(cwd) + " diff --name-status " + shell_quote(ref) +
					" 2>&1",
				10000);
			Capture untracked = run_capture(
				"git -C " + shell_quote(cwd) + " clean -nd 2>&1", 8000);
			if (!confirm) {
				cp_reply({{"ok", true}, {"dryRun", true}, {"ref", ref},
				          {"wouldChange", diff.code == 0 ? diff.out : std::string("")},
				          {"wouldRemove", untracked.code == 0 ? untracked.out : std::string("")}});
				return;
			}
			Capture rst = run_capture(
				"git -C " + shell_quote(cwd) + " restore --source=" + shell_quote(ref) +
					" --staged --worktree -- . 2>&1",
				15000);
			Capture cln = run_capture(
				"git -C " + shell_quote(cwd) + " clean -fd 2>&1", 15000);
			if (rst.code != 0) {
				std::string e = rst.out.empty() ? "restore failed" : rst.out;
				if (e.size() > 200) e = e.substr(0, 200);
				cp_reply({{"ok", false}, {"error", e}});
				return;
			}
			cp_reply({{"ok", true}, {"restored", ref},
			          {"removed", cln.code == 0 ? cln.out : std::string("")}});
		});
		return;
	}

	// ---- native shell execution: fastest command path, no agent in the loop ----
	if (type == "rig.exec") {
		std::string command = m.value("command", "");
		if (command.empty()) { reply({{"type", "error"}, {"error", "command required"}}); return; }
		{
			std::lock_guard<std::mutex> lock(g_execs_mutex);
			if (g_execs.size() >= MAX_CONCURRENT_EXECS) {
				reply({{"type", "error"}, {"error", "too many concurrent execs"}});
				return;
			}
		}
		uint64_t exec_id = g_exec_counter.fetch_add(1) + 1;
		int timeout = std::clamp(m.value("timeoutMs", 30000), 100, 600000);
		reply({{"type", "exec.started"}, {"execId", exec_id}, {"timeoutMs", timeout}});
		std::string cwd = m.value("cwd", "");
		spawn_guarded(c, [c, exec_id, command, cwd, timeout] { exec_thread(c, exec_id, command, cwd, timeout); });
		return;
	}

	if (type == "rig.execKill") {
		uint64_t eid = m.value("execId", uint64_t(0));
		std::lock_guard<std::mutex> lock(g_execs_mutex);
		auto it = g_execs.find(eid);
		if (it != g_execs.end()) { kill(-it->second->pid, SIGKILL); kill(it->second->pid, SIGKILL); }
		reply({{"type", "ok"}, {"for", "rig.execKill"}});
		return;
	}

	// ---- interactive pty: phone-side terminal into the rig's shell ----
	if (type == "rig.term.open") {
#if defined(_WIN32)
		reply({{"type", "error"}, {"error", "rig.term not supported on Windows yet"}});
		return;
#else
		{
			std::lock_guard<std::mutex> lock(g_terms_mutex);
			if (g_terms.size() >= MAX_TERMS) {
				reply({{"type", "error"}, {"error", "too many open terminals"}});
				return;
			}
		}
		uint64_t tid = g_term_counter.fetch_add(1) + 1;
		int cols = std::clamp(m.value("cols", 120), 8, 500);
		int rows = std::clamp(m.value("rows", 32), 4, 200);
		std::string cwd = m.value("cwd", "");
		std::string shell = m.value("shell", "");
		if (shell.empty()) { const char* s = getenv("SHELL"); shell = s && *s ? s : "/bin/bash"; }
		struct winsize ws { (unsigned short)rows, (unsigned short)cols, 0, 0 };
		int fd = -1;
		pid_t pid = forkpty(&fd, nullptr, nullptr, &ws);
		if (pid == 0) {
			if (!cwd.empty() && chdir(cwd.c_str()) != 0) { /* inherit daemon cwd */ }
			setenv("TERM", "xterm-256color", 1);
#if defined(__linux__)
			if (!g_computer.display.empty()) {
				setenv("DISPLAY", g_computer.display.c_str(), 1);
				unsetenv("WAYLAND_DISPLAY");
			}
#endif
			execl(shell.c_str(), shell.c_str(), "-l", nullptr);
			_exit(127);
		}
		if (pid < 0) { reply({{"type", "error"}, {"error", "forkpty failed"}}); return; }
		{
			auto* t = new Term{tid, pid, fd, c, false};
			std::lock_guard<std::mutex> lock(g_terms_mutex);
			g_terms[tid] = t;
		}
		reply({{"type", "term.opened"}, {"termId", tid}, {"pid", pid}, {"shell", shell}});
		spawn_guarded(c, [c, tid] { term_reader(c, tid); });
		return;
#endif
	}

	if (type == "rig.term.in") {
		uint64_t tid = m.value("termId", uint64_t(0));
		std::string data;
		if (m.contains("dataB64") && m["dataB64"].is_string()) {
			std::vector<uint8_t> b;
			rigfs::base64_decode(m["dataB64"].get<std::string>(), b);
			data.assign(reinterpret_cast<const char*>(b.data()), b.size());
		} else data = m.value("data", "");
		Term* t = nullptr;
		{
			std::lock_guard<std::mutex> lock(g_terms_mutex);
			auto it = g_terms.find(tid);
			if (it != g_terms.end() && it->second->owner == c) t = it->second;
		}
		if (!t || t->dead.load()) { reply({{"type", "error"}, {"error", "no such terminal"}}); return; }
		size_t off = 0;
		while (off < data.size()) {
			ssize_t n = file_write(t->fd, data.data() + off, data.size() - off);
			if (n <= 0) break;
			off += size_t(n);
		}
		return; // term.out confirms receipt — no ack needed
	}

	if (type == "rig.term.resize") {
		uint64_t tid = m.value("termId", uint64_t(0));
		int cols = std::clamp(m.value("cols", 120), 8, 500);
		int rows = std::clamp(m.value("rows", 32), 4, 200);
		Term* t = nullptr;
		{
			std::lock_guard<std::mutex> lock(g_terms_mutex);
			auto it = g_terms.find(tid);
			if (it != g_terms.end() && it->second->owner == c) t = it->second;
		}
		if (!t) { reply({{"type", "error"}, {"error", "no such terminal"}}); return; }
#if !defined(_WIN32)
		struct winsize ws { (unsigned short)rows, (unsigned short)cols, 0, 0 };
		ioctl(t->fd, TIOCSWINSZ, &ws);
#else
		(void)cols; (void)rows;
#endif
		reply({{"type", "ok"}, {"for", "rig.term.resize"}});
		return;
	}

	if (type == "rig.term.close") {
		uint64_t tid = m.value("termId", uint64_t(0));
		Term* t = nullptr;
		{
			std::lock_guard<std::mutex> lock(g_terms_mutex);
			auto it = g_terms.find(tid);
			if (it != g_terms.end() && it->second->owner == c) t = it->second;
		}
		if (t) term_kill(t);
		reply({{"type", "ok"}, {"for", "rig.term.close"}});
		return;
	}

	// ---- computer use: the agent operates a display like a user ----
	// ---- computer use: native X11 pipeline, subprocess fallback ------------
	// workspace.* shares this block — it's the uniform alias for computer.space
	if (type.rfind("computer.", 0) == 0 || type.rfind("workspace.", 0) == 0) {
		std::string disp = m.value("display", "");
		if (disp.empty()) disp = g_computer.display;
		if (disp != g_computer.display || type == "computer.boot") {
			std::string err;
			if (!g_computer.boot(type == "computer.boot" ? m.value("display", "") : disp,
			                     m.value("width", 0), m.value("height", 0), err)) {
				reply({{"type", "error"}, {"error", err}});
				return;
			}
		} else if (disp.rfind(":99", 0) == 0) {
			std::string err;
			if (!g_computer.xvfb_alive()) {
				if (!g_computer.boot("", 0, 0, err)) { reply({{"type", "error"}, {"error", err}}); return; }
			} else {
				// adopted Xvfb: it can outlive the daemon+WM that spawned it —
				// without a WM no client gets input focus, so events silently vanish
				std::lock_guard<std::mutex> lk(g_computer.mutex);
				g_computer.spawn_wm();
			}
		}
		bool native_ok = native().init();

		// computer.boot replies with the same state payload — the display is up
		// by now (or boot() already errored out), so state is the honest ack.
		if (type == "computer.state" || type == "computer.boot") {
			// the real display size is known only after the backend loads —
			// refresh it so resolution never reports the 1920x1080 seed default
			{
				std::lock_guard<std::mutex> lk(g_computer.mutex);
				int dw = 0, dh = 0;
				if (native_ok && native().display_size(disp, dw, dh)) {
					g_computer.width = dw;
					g_computer.height = dh;
				}
			}
			json st = {{"type", "computer.state"}, {"display", g_computer.display},
			           {"xvfbAlive", g_computer.xvfb_alive()},
			           {"resolution", {g_computer.width, g_computer.height}},
			           {"nativeBackend", native_ok},
			           {"backend", native().backend},
			           {"shm", native().has_shm}, {"xtest", native().has_xtest},
			           {"perms", {{"inject", native().has_xtest}, {"capture", native().has_shm}}},
#if defined(__APPLE__) || defined(_WIN32)
			           {"note", "the daemon drives this host's live session display (no virtual displays)"}};
#else
			           {"note", "display ':1' targets the REAL desktop - explicit opt-in per call"}};
#endif
			// capture space = union of display bounds in global points (origin
			// may be negative); scaleFactor = measured shot-px/point ratio
			if constexpr (requires { native().scale_factor(); })
				st["scaleFactor"] = native().scale_factor();
			if constexpr (requires { native().display_origin(disp, std::declval<int&>(), std::declval<int&>()); }) {
				int ox = 0, oy = 0;
				if (native().display_origin(disp, ox, oy))
					st["displayOrigin"] = {{"x", ox}, {"y", oy}};
			}
			if constexpr (requires { native().pixel_size(std::declval<const std::string&>(),
			                                           std::declval<int&>(), std::declval<int&>()); }) {
				int pw = 0, ph = 0;
				if (native().pixel_size(disp, pw, ph))
					st["pixelResolution"] = {pw, ph};
			}
			if (type == "computer.boot") st["booted"] = true;
			reply(st);
			return;
		}

		// permission surface: what the native backend can/can't do, and the
		// one-step way to ask macOS for the grants (TCC prompts)
		if (type == "computer.perms") {
			bool asked = false;
#if defined(__APPLE__)
			if (m.value("request", false)) asked = native().request_perms();
#endif
			json perms = {{"type", "computer.perms"}, {"backend", native().backend},
			              {"perms", {{"inject", native().has_xtest}, {"capture", native().has_shm}}},
			              {"asked", asked}};
			// the actionable next step when a capability is missing
#if defined(__APPLE__)
			if (!native().has_xtest)
				perms["hint"] = "Accessibility not granted — request:true shows the TCC prompt; then enable omprd in System Settings > Privacy & Security > Accessibility";
			else if (!native().has_shm)
				perms["hint"] = "Screen Recording not granted — request:true prompts; restart omprd after granting";
#elif defined(_WIN32)
			if (native().session0)
				perms["hint"] = "session-0 window station has no interactive desktop — run omprd inside the logged-in session";
#else
			if (!native().has_xtest || !native().has_shm)
				perms["hint"] = "XTest/MIT-SHM unavailable — install libXtst/libXext (xdotool remains the input fallback)";
#endif
			if (m.contains("id")) perms["id"] = m["id"];
			send_json(c, perms);
			return;
		}

		// virtual desktops — a dedicated workspace per session so parallel
		// agents never trip over each other's windows. "new" creates +
		// enters the session's desktop, "enter" hops back to it, "leave"
		// returns to whatever was frontmost before. workspace.* is the
		// mission's uniform alias: workspace.new {sessionId} -> {ok,
		// workspace, kind} where kind says what the platform really made.
		bool ws_alias = type == "workspace.new" || type == "workspace.enter" ||
		                type == "workspace.leave" || type == "workspace.status";
		if (type == "computer.space" || ws_alias) {
			std::string action = ws_alias ? type.substr(10) : m.value("action", "status");
			Session* s = find_session(m.value("sessionId", ""));
			json out = {{"type", type}, {"action", action}};
			bool ok = true;
			std::string note;
#if defined(__APPLE__)
			out["kind"] = "fullscreen-space"; // a fullscreen app IS a Space; no public Spaces API
			if (action == "new") {
				std::string front = native().frontmost_app();
				ok = native().space_new(disp);
				if (ok && s) {
					s->prev_app = std::move(front);
					s->fs_app = native().frontmost_app();
					s->desktop = 0;
					out["app"] = s->fs_app;
				}
				note = "fullscreen space — activating the app hops back to it";
			} else if (action == "enter") {
				ok = s && !s->fs_app.empty() && native().app_activate(s->fs_app);
				if (!ok) note = "no space owned — send action:new first";
			} else if (action == "leave") {
				ok = s && !s->prev_app.empty() && native().app_activate(s->prev_app);
			} else if (action == "status") {
				out["frontmost"] = native().frontmost_app();
				if (s) { out["desktop"] = s->desktop; out["app"] = s->fs_app; }
			} else { ok = false; note = "unknown action"; }
			if (s && !s->fs_app.empty()) out["workspace"] = s->fs_app;
#else
			out["kind"] =
#if defined(_WIN32)
				"virtual-desktop";
#else
				"ewmh-desktop";
#endif
			if (action == "new") {
				// idempotent: a session that already owns a desktop gets it back —
				// a retried space new used to grow _NET_NUMBER_OF_DESKTOPS forever
				if (s && s->desktop >= 0) {
					out["desktop"] = s->desktop;
					out["reused"] = true;
					native().space_enter(disp, s->desktop);
				} else {
					int cur = native().space_current(disp);
					// session-bound calls go through the claim pool (reuse/release);
					// sessionless ones keep the old append-only space_new — there is
					// nothing to own the claim, so tracking it would let the shrink
					// delete a desktop this call just reported back.
					int d;
					if (s) {
#if !defined(__APPLE__) && !defined(_WIN32)
						d = desktop_claim(disp);
#else
						d = native().space_new(disp);
#endif
					} else {
						d = native().space_new(disp);
					}
					ok = d >= 0;
					if (ok) {
						if (s) {
							s->prev_desktop = cur;
							s->desktop = d;
							s->desktop_disp = disp;
						} else {
							if (m.contains("sessionId")) note = "no such session — desktop created but nothing bound to it";
						}
						out["desktop"] = d;
					} else note = "no indexed-desktop backend (EWMH _NET_DESKTOP on X11, VirtualDesktop service or key path on win32)";
				}
			} else if (action == "enter") {
				int cur = native().space_current(disp);
				ok = s && s->desktop >= 0 && native().space_enter(disp, s->desktop);
				if (ok) s->prev_desktop = cur;
				else if (!s || s->desktop < 0) note = "session owns no desktop";
			} else if (action == "leave") {
				// per-session prev: parallel sessions used to stomp one shared
				// static, so a leave could hop into someone else's workspace
				ok = s && s->prev_desktop >= 0 && native().space_enter(disp, s->prev_desktop);
				if (!ok && (!s || s->prev_desktop < 0)) note = "no prior desktop recorded";
			} else if (action == "status") {
				out["current"] = native().space_current(disp);
				out["count"] = native().space_count(disp);
				if (s) out["desktop"] = s->desktop;
			} else { ok = false; note = "unknown action"; }
			if (s && s->desktop >= 0) out["workspace"] = s->desktop;
#endif
			if (s && !s->wids.empty()) out["windows"] = s->wids;
			out["ok"] = ok;
			if (!note.empty()) out["note"] = note;
			if (s) out["sessionId"] = s->id;
			reply(out);
			return;
		}

		// single actions — all native-first, microseconds on the XTest path
		if (type == "computer.click" || type == "computer.doubleclick" || type == "computer.type" ||
		    type == "computer.key" || type == "computer.scroll" || type == "computer.drag" ||
		    type == "computer.gesture" || type == "computer.launch") {
			json a = m;
			a["action"] = type.substr(9);
			json out;
			bool ok;
			{
				std::lock_guard<std::mutex> ik(g_input_mutex);
				ok = computer_step(disp, a, out);
			}
			out["type"] = type == "computer.launch" ? "computer.launched" : "ok";
			if (type == "computer.launch") out["display"] = disp;
			reply(out);
			if (type == "computer.launch" && ok) log("computer: launched on " + disp);
			return;
		}

		// batched actions — one round trip, N steps
		if (type == "computer.actions") {
			if (!m.contains("steps") || !m["steps"].is_array()) {
				reply({{"type", "error"}, {"error", "steps[] required"}});
				return;
			}
			bool stop_on_error = m.value("stopOnError", true);
			std::string sid = m.value("sessionId", "");
			spawn_guarded(c, [c, disp, steps = m["steps"], stop_on_error, sid, req_id = m.value("id", "")] {
				int64_t t0 = now_ms();
				json results = json::array();
				bool aborted = false;
				// one batch = one script: held for the whole loop so another
				// client's action can't interleave between steps mid-drag/type
				std::lock_guard<std::mutex> ik(g_input_mutex);
				for (auto& step_c : steps) {
					// launches inside a batch still route to the session's
					// workspace — the batch carries the id the steps lack
					json step = step_c;
					if (!sid.empty() && !step.contains("sessionId")) step["sessionId"] = sid;
					json out;
					bool ok = computer_step(disp, step, out);
					results.push_back(out);
					if (!ok && stop_on_error) { aborted = true; break; }
				}
				json rep = {{"type", "computer.actions"}, {"results", results},
				            {"totalMs", now_ms() - t0}, {"aborted", aborted}};
				if (!req_id.empty()) rep["id"] = req_id;
				send_json(c, rep);
			});
			return;
		}

		if (type == "computer.cursor") {
			int x = -1, y = -1; unsigned long child = 0;
			if (native_ok && native().query_pointer(disp, x, y, child))
				reply({{"type", "computer.cursor"}, {"x", x}, {"y", y}, {"child", child}, {"method", "native"}});
			else {
#if defined(__APPLE__) || defined(_WIN32)
				reply({{"type", "computer.cursor"}, {"x", -1}, {"y", -1},
				              {"method", "none"}, {"hint", input_hint(disp)}});
#else
				RunResult r = run_capture("xdotool getmouselocation --shell", disp, 3000);
				int px = -1, py = -1, scr = -1;
				sscanf(r.out.c_str(), "X=%d\nY=%d\nSCREEN=%d", &px, &py, &scr);
				reply({{"type", "computer.cursor"}, {"x", px}, {"y", py},
				              {"screen", scr}, {"method", "xdotool"}});
#endif
			}
			return;
		}

		// accessibility intelligence: named targets instead of blind pixels.
		// ui.tree dumps the focused/target app's AX tree (role/title/value/
		// rect/depth, depth+node capped); ui.press hits "Save"/"Allow" by
		// name; ui.set fills a labelled field. Backends without AX support
		// report ok:false "unsupported" rather than guessing.
		// pid=0 = "the workspace's app": topmost window owner on the claimed
		// display, falling back to whatever the OS reports as AX-focused.
		[[maybe_unused]] auto ui_target_pid = [&]() -> int {
			if constexpr (requires { native().windows(""); }) {
				auto wins = native().windows(disp);
				if (!wins.empty()) return int(wins.front().pid);
			}
			return 0; // backend resolves AXFocusedApplication itself
		};
		if (type == "computer.ui.tree") {
			int pid = m.value("pid", 0);
			int depth = m.value("depth", 6);
			int cap = m.value("limit", 400);
			std::string req_id = m.value("id", "");
			spawn_guarded(c, [c, pid, depth, req_id, cap, ui_target_pid] {
				json nodes = json::array();
				bool supported = false;
				int used = pid;
				// ui.* is implemented only by the macOS AX backend. if-constexpr
				// can't guard this (native() is non-dependent — discarded branches
				// are still checked), so the calls live behind the platform #if.
#if defined(__APPLE__)
				supported = true;
				if (!used) used = ui_target_pid();
				for (auto& n : native().ui_tree(used, depth, cap))
					nodes.push_back({{"role", n.role}, {"title", n.title},
					                 {"value", n.value}, {"x", n.x}, {"y", n.y},
					                 {"w", n.w}, {"h", n.h}, {"depth", n.depth}});
#endif
				json rep = {{"type", "computer.ui.nodes"}, {"ok", supported},
				            {"pid", used}, {"nodes", nodes},
				            {"count", nodes.size()},
				            {"display", g_computer.display}};
				if (!supported) rep["error"] = "ui tree unsupported on this backend";
				if (!req_id.empty()) rep["id"] = req_id;
				send_json(c, rep);
			});
			return;
		}
		if (type == "computer.ui.press" || type == "computer.ui.set") {
			int pid = m.value("pid", 0);
			std::string title = m.value("title", "");
			std::string role = m.value("role", "");
			std::string value = m.value("value", "");
			std::string req_id = m.value("id", "");
			if (type == "computer.ui.set" && value.empty()) {
				reply({{"type", "error"}, {"error", "value required"},
				              {"id", req_id.empty() ? json(nullptr) : json(req_id)}});
				return;
			}
			spawn_guarded(c, [c, pid, title, role, value, req_id, type, ui_target_pid] {
				bool ok = false;
#if defined(__APPLE__)
				int used = pid ? pid : ui_target_pid();
				if (type == "computer.ui.press") ok = native().ui_press(used, title, role);
				else ok = native().ui_set_value(used, title, value);
#endif
				json rep = {{"type", "computer.ui.result"}, {"ok", ok},
				            {"title", title}, {"display", g_computer.display}};
				if (!ok) rep["error"] = "no matching element or backend unsupported";
				if (!req_id.empty()) rep["id"] = req_id;
				send_json(c, rep);
			});
			return;
		}

		if (type == "computer.screenshot" || type == "computer.observe") {
			std::string fmt = m.value("format", "jpg"); // jpg ≈ 25ms vs png ≈ 140ms at 1080p
			int quality = std::clamp(m.value("quality", 80), 5, 100);
			double scale = std::clamp(m.value("scale", type == "computer.observe" ? 0.5 : 1.0), 0.05, 1.0);
			int rx = 0, ry = 0, rw = -1, rh = -1;
			if (m.contains("region") && m["region"].is_object()) {
				rx = m["region"].value("x", 0);
				ry = m["region"].value("y", 0);
				rw = m["region"].value("w", -1);
				rh = m["region"].value("h", -1);
			}
			// wid scopes the shot to one window — the session-workspace
			// contract on macOS (windows render even occluded/other Space);
			// unset → full display everywhere
			uint32_t wid = m.value("wid", 0u);
			spawn_guarded(c, [c, disp, fmt, quality, scale, rx, ry, rw, rh, type, wid, req_id = m.value("id", "")] {
				int64_t t0 = now_ms();
				std::string err, method = "native";
				std::vector<uint8_t> encoded;
				rig::MemImage img;
				bool ok = false;
				if (wid) {
					// scoped request never degrades to a full-screen shot —
					// that would fake the per-session boundary
					if constexpr (requires { native().window_exists(0u); }) {
						if (!native().window_exists(wid))
							err = "no such window id: " + std::to_string(wid);
					}
					if (err.empty()) {
						if constexpr (requires { native().capture_window(disp, 0u, scale, fmt, quality, img, encoded, err); }) {
							ok = native().capture_window(disp, wid, scale, fmt, quality, img, encoded, err);
							method = "window";
						} else {
							err = "wid-scoped capture not supported on this backend";
						}
					}
				} else {
					ok = native().capture(disp, rx, ry, rw, rh, scale, fmt, quality, img, encoded, err);
				}
#if !defined(__APPLE__) && !defined(_WIN32)
				if (!ok && !wid) {
					method = "import"; // X11-only ImageMagick fallback, full-screen PNG
					RunResult r = run_capture("import -window root png:-", disp, 8000);
					if (r.code == 0 && !r.out.empty()) {
						encoded.assign(r.out.begin(), r.out.end());
						ok = true;
					} else {
						err = r.out.substr(0, 200);
					}
				}
#endif
				if (!ok) {
					json e = {{"type", "error"}, {"error", "screenshot failed: " + err}};
					if (!req_id.empty()) e["id"] = req_id;
					send_json(c, e);
					return;
				}
				json reply = {{"type", type},
				              {"imageBase64", rig::base64_encode(encoded)},
				              {"encoder", native().capture_encoder()},
				              {"format", fmt},
				              {"width", img.width}, {"height", img.height},
				              {"bytes", encoded.size()},
				              {"tookMs", now_ms() - t0},
				              {"method", method}};
				if constexpr (requires { native().last_capture_ms; })
					reply["captureMs"] = native().last_capture_ms;
				if constexpr (requires { native().last_encode_ms; })
					reply["encodeMs"] = native().last_encode_ms;
				fs::path shots = g_rig.dir / "shots";
				std::string fname = "shot-" + std::to_string(now_ms()) + (fmt == "jpg" ? ".jpg" : ".png");
				reply["savedTo"] = (shots / fname).string();

				if (type == "computer.observe") {
					// one round trip = vision payload + full ground state
					int px = -1, py = -1; unsigned long child = 0;
					if (native().query_pointer(disp, px, py, child))
						reply["cursor"] = {{"x", px}, {"y", py}};
					json wins = json::array();
					for (auto& wn : native().windows(disp))
						wins.push_back({{"id", wn.id}, {"app", wn.app}, {"pid", wn.pid},
						                {"title", wn.title}, {"x", wn.x}, {"y", wn.y},
						                {"w", wn.w}, {"h", wn.h}, {"active", wn.active}});
					reply["windows"] = wins;
				}
				if (!req_id.empty()) reply["id"] = req_id;
				send_json(c, reply);
				// the archive write sits off the reply path — the answer is already sent
				fs::create_directories(shots);
				std::ofstream f(shots / fname, std::ios::binary);
				f.write(reinterpret_cast<const char*>(encoded.data()), std::streamsize(encoded.size()));
				// shots are agent scratch (every observe() saves one) — keep the
				// newest 500 or <7d old, whichever is more permissive per file
				try {
					std::vector<std::pair<fs::file_time_type, fs::path>> files;
					for (auto& de : fs::directory_iterator(shots))
						if (de.is_regular_file())
							files.emplace_back(fs::last_write_time(de), de.path());
					std::sort(files.begin(), files.end()); // oldest first
					auto cutoff = fs::file_time_type::clock::now() - std::chrono::hours(24 * 7);
					for (size_t i = 0; i < files.size(); i++) {
						bool stale = files[i].first < cutoff;
						bool overcap = files.size() - i > 500;
						if (stale || overcap) fs::remove(files[i].second);
						else break;
					}
				} catch (...) {}
			});
			return;
		}

		if (type == "computer.shot_file") {
			// Serve an archived shot (~/.rig/shots/*.jpg) back to a client — the
			// app renders "what the agent saw" cards from observe results.
			// Only basenames under the shots dir are served; nothing else.
			std::string name = m.value("name", "");
			if (name.find("savedTo") != std::string::npos) name.clear();
			if (name.empty()) {
				std::string p = m.value("path", "");
				name = fs::path(p).filename().string();
			}
			if (name.empty() || name.find("..") != std::string::npos ||
			    name.find('/') != std::string::npos || name.find('\\') != std::string::npos) {
				reply({{"type", "error"}, {"error", "bad shot name"}});
				return;
			}
			fs::path fp = g_rig.dir / "shots" / name;
			std::ifstream f(fp, std::ios::binary);
			if (!f) {
				reply({{"type", "error"}, {"error", "no such shot"}});
				return;
			}
			std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
			                           std::istreambuf_iterator<char>());
			if (bytes.size() > 8 * 1024 * 1024) {
				reply({{"type", "error"}, {"error", "shot too large"}});
				return;
			}
			std::string ext = fp.extension().string();
			reply({{"type", "computer.shot_file"},
			              {"name", name},
			              {"imageBase64", rig::base64_encode(bytes)},
			              {"format", ext == ".png" ? "png" : "jpg"},
			              {"bytes", bytes.size()}});
			return;
		}

		if (type == "computer.windows") {
			spawn_guarded(c, [c, disp, native_ok, req_id = m.value("id", "")] {
				json wins = json::array();
				std::string method = "native";
				if (native_ok) {
					for (auto& w : native().windows(disp))
						wins.push_back({{"id", w.id}, {"app", w.app}, {"pid", w.pid},
						                {"title", w.title}, {"x", w.x}, {"y", w.y},
						                {"w", w.w}, {"h", w.h}, {"active", w.active}});
				} else {
#if defined(__APPLE__) || defined(_WIN32)
					method = "none";
#else
					method = "wmctrl";
					RunResult r = run_capture("wmctrl -l", disp, 5000);
					std::istringstream iss(r.out);
					std::string line;
					while (std::getline(iss, line)) {
						std::istringstream ls(line);
						std::string wid, desk, host, title;
						ls >> wid >> desk >> host;
						std::getline(ls, title);
						if (!title.empty() && title[0] == ' ') title = title.substr(1);
						if (!wid.empty())
							wins.push_back({{"id", std::stoul(wid, nullptr, 16)}, {"title", title}});
					}
#endif
				}
				json rep = {{"type", "computer.windows"}, {"windows", wins}, {"method", method}};
			if (!req_id.empty()) rep["id"] = req_id;
			send_json(c, rep);
			});
			return;
		}

		if (type == "computer.window.activate" || type == "computer.window.close") {
			spawn_guarded(c, [c, disp, m, type] {
				unsigned long target = static_cast<unsigned long>(m.value("id", uint64_t(0)));
				std::string want = m.value("title", "");
				if (!target && !want.empty())
					for (auto& w : native().windows(disp))
						if (w.title.find(want) != std::string::npos) { target = w.id; break; }
				if (!target) {
					json e = {{"type", "error"}, {"error", "no matching window"}};
					if (m.contains("id")) e["id"] = m["id"];
					send_json(c, e);
					return;
				}
				bool ok = type == "computer.window.activate"
				          ? native().window_activate(disp, target)
				          : native().window_close(disp, target);
#if defined(__APPLE__)
				// activate() returns as soon as the request posts — the focus
				// flip lands asynchronously, so a type right after activate
				// still hits the old app. Poll until AXFocusedApplication
				// reports the target's owner, bounded, so activate→type is
				// reliable. (Z-order can't see keyboard focus.)
				if (ok && type == "computer.window.activate") {
					std::string owner;
					for (auto& w : native().windows(disp))
						if (w.id == target) { owner = w.app; break; }
					if (!owner.empty()) {
						int64_t dl = now_ms() + 800;
						while (now_ms() < dl && native().focused_app() != owner)
							std::this_thread::sleep_for(std::chrono::milliseconds(40));
					}
				}
#endif
				json rep = {{"type", "ok"}, {"for", type}, {"id", target}, {"ok", ok}};
				if (m.contains("id")) rep["reqId"] = m["id"];
				send_json(c, rep);
			});
			return;
		}

		if (type == "computer.waitWindow") {
			std::string want = m.value("title", "");
			int timeout = std::clamp(m.value("timeoutMs", 10000), 100, 60000);
			spawn_guarded(c, [c, disp, want, timeout, req_id = m.value("id", "")] {
				int64_t t0 = now_ms();
				while (now_ms() - t0 < timeout) {
					for (auto& w : native().windows(disp))
						if (!want.empty() && w.title.find(want) != std::string::npos) {
							json rep = {{"type", "computer.waitWindow"}, {"found", true},
							            {"id", w.id}, {"title", w.title}, {"waitedMs", now_ms() - t0}};
						if (!req_id.empty()) rep["reqId"] = req_id;
						send_json(c, rep);
							return;
						}
					std::this_thread::sleep_for(std::chrono::milliseconds(100));
				}
				json rep = {{"type", "computer.waitWindow"}, {"found", false}, {"waitedMs", now_ms() - t0}};
				if (!req_id.empty()) rep["id"] = req_id;
				send_json(c, rep);
			});
			return;
		}

		// push screen-share: a thumb pixel-diff gates full jpg frames — the
		// phone sees changes, not a heartbeat of identical megabytes
		if (type == "computer.watch") {
			// adaptive cadence: intervalMs is the hot tick rate (50..60000,
			// default 250); after idleAfterMs with no changes the tick relaxes
			// ×1.5 up to idleIntervalMs, snapping back on the next change.
			int interval = std::clamp(m.value("intervalMs", 250), 50, 60000);
			int idle_ms = std::clamp(m.value("idleIntervalMs", 2000), interval, 120000);
			int idle_after = std::clamp(m.value("idleAfterMs", 1500), 0, 600000);
			double threshold = std::clamp(m.value("threshold", 2.0), 0.0, 255.0);
			std::string wfmt = m.value("format", "jpg");
			int wq = std::clamp(m.value("quality", 70), 5, 100);
			double wscale = std::clamp(m.value("scale", 0.5), 0.05, 1.0);
			// optional region watch: watch only {x,y,w,h} of the capture space
			int rx = 0, ry = 0, rw = -1, rh = -1;
			if (m.contains("region") && m["region"].is_object()) {
				rx = m["region"].value("x", 0);
				ry = m["region"].value("y", 0);
				rw = m["region"].value("w", -1);
				rh = m["region"].value("h", -1);
			}
			auto* w = new Watcher;
			w->client = c;
			w->disp = disp;
			{
				std::lock_guard<std::mutex> lock(g_watchers_mutex);
				w->id = "w" + std::to_string(++g_watch_counter);
				g_watchers.push_back(w);
			}
			std::string wid = w->id;
			// ack first: the first diff is always "changed" (empty prev), so a
			// fast frame could otherwise race ahead of computer.watching and
			// reach the client with an unknown watchId
			json wrep = {{"type", "computer.watching"}, {"watchId", wid},
			             {"intervalMs", interval}, {"idleIntervalMs", idle_ms},
			             {"idleAfterMs", idle_after}, {"threshold", threshold},
			             {"scale", wscale}, {"format", wfmt}, {"display", disp}};
			if (rw > 0 && rh > 0) wrep["region"] = {{"x", rx}, {"y", ry}, {"w", rw}, {"h", rh}};
			reply(wrep);
			w->th = std::thread([w, interval, idle_ms, idle_after, threshold, wfmt, wq, wscale, rx, ry, rw, rh] {
				try {
				std::vector<uint8_t> prev;
				int64_t seq = 0;
				bool live = true;
				int cadence = interval;          // current tick rate
				int64_t last_change_ms = now_ms();
				while (live && !w->stop && !g_stop) {
					int64_t t0 = now_ms();
					bool changed = true;
					double delta = 0;
					std::vector<uint8_t> cur;
					rig::MemImage img; std::vector<uint8_t> enc; std::string err;
					bool okc = false;
					if constexpr (requires {
						native().watch_probe(w->disp, rx, ry, rw, rh, 160, 100, cur, err) &&
						native().watch_encode(w->disp, wscale, wfmt, wq, img, enc, err); }) {
						// probe/encode split: idle ticks pay only grab+thumb, the
						// encode (the expensive half) runs after a real change
						okc = native().watch_probe(w->disp, rx, ry, rw, rh, 160, 100, cur, err);
					} else {
						// legacy backend: one fused grab+encode per tick
						okc = native().watch_frame(w->disp, wscale, wfmt, wq, 160, 100, cur, img, enc, err);
					}
					if (okc && !cur.empty()) {
						if (!prev.empty() && prev.size() == cur.size()) {
							uint64_t sum = 0;
							for (size_t i = 0; i < cur.size(); i++) sum += std::abs(int(cur[i]) - int(prev[i]));
							delta = double(sum) / cur.size();
							changed = delta >= threshold;
						}
						prev = std::move(cur);
					} else if (!prev.empty()) changed = false; // perm flicker: don't spam
					if (changed && okc) {
						// Adaptive fidelity: when this client's outbox is backlogged —
						// our honest RTT-pressure signal — degrade encode cost until it
						// drains. Frames keep flowing; width/height/shotRW stay
						// truthful to the pixels actually sent.
						int eff_q = wq;
						double eff_scale = wscale;
						size_t backlog;
						{
							std::lock_guard<std::mutex> lk(g_watchers_mutex);
							if (!w->client || !w->client->alive || w->stop) { live = false; break; }
							backlog = w->client->out_bytes.load();
						}
						bool adaptive = false;
						if (backlog > OUT_QUEUE_MAX_BYTES / 4) {
							eff_q = std::max(30, wq - 30); eff_scale = wscale * 0.6; adaptive = true;
						} else if (backlog > 256 * 1024) {
							eff_q = std::max(45, wq - 15); eff_scale = wscale * 0.8; adaptive = true;
						}
						if constexpr (requires {
							native().watch_encode(w->disp, eff_scale, wfmt, eff_q, img, enc, err); }) {
							if (enc.empty()) native().watch_encode(w->disp, eff_scale, wfmt, eff_q, img, enc, err);
						}
						std::lock_guard<std::mutex> lk(g_watchers_mutex);
						if (!w->client || !w->client->alive || w->stop) { live = false; break; }
						json frame = {{"type", "computer.frame"}, {"watchId", w->id},
						              {"seq", ++seq}, {"imageBase64", rig::base64_encode(enc)},
						              {"width", img.width}, {"height", img.height},
						              {"bytes", enc.size()}, {"delta", delta},
						              {"encoder", native().capture_encoder()},
						              {"cadenceMs", cadence},
						              {"tookMs", now_ms() - t0}};
						if (adaptive) {
							frame["adaptive"] = true;
							frame["quality"] = eff_q;
							frame["scale"] = eff_scale;
						}
						if constexpr (requires { native().last_capture_ms; })
							frame["captureMs"] = native().last_capture_ms;
						if constexpr (requires { native().last_encode_ms; })
							frame["encodeMs"] = native().last_encode_ms;
						send_json(w->client, frame);
						last_change_ms = now_ms();
						cadence = interval;
					} else if (now_ms() - last_change_ms >= idle_after) {
						cadence = std::min(idle_ms, std::max(interval, int(cadence * 1.5)));
					}
					int64_t spent = now_ms() - t0;
					if (spent < cadence) std::this_thread::sleep_for(std::chrono::milliseconds(cadence - spent));
				}
				} catch (...) {}
				if constexpr (requires { native().watch_release(); })
					native().watch_release();
				{
					std::lock_guard<std::mutex> lk(g_watchers_mutex);
					for (size_t i = 0; i < g_watchers.size(); i++)
						if (g_watchers[i] == w) { g_watchers.erase(g_watchers.begin() + long(i)); break; }
				}
				retire([w] { delete w; });
			});
			w->th.detach();
			return;
		}
		if (type == "computer.unwatch") {
			std::string wid = m.value("watchId", "");
			int n = 0;
			{
				std::lock_guard<std::mutex> lk(g_watchers_mutex);
				for (auto* w : g_watchers)
					if ((wid.empty() || w->id == wid) && w->client == c) { w->stop = true; n++; }
			}
			reply({{"type", "ok"}, {"for", "computer.unwatch"}, {"stopped", n}});
			return;
		}

		// ---- screen recording to disk ------------------------------------
		// One recording at a time. The capture thread is detached like a
		// watcher's but writes JPEG frames to <rig>/recordings/<id>/ instead
		// of streaming — the app lists, then pulls frames back in ranges.
		if (type == "computer.record.start") {
			int interval = std::clamp(m.value("intervalMs", 250), 50, 10000);
			int max_ms = std::clamp(m.value("maxDurationMs", 600000), 1000, 3600000);
			double rscale = std::clamp(m.value("scale", 0.5), 0.05, 1.0);
			int rq = std::clamp(m.value("quality", 70), 5, 100);
			int rx = 0, ry = 0, rw = -1, rh = -1;
			if (m.contains("region") && m["region"].is_object()) {
				rx = m["region"].value("x", 0);
				ry = m["region"].value("y", 0);
				rw = m["region"].value("w", -1);
				rh = m["region"].value("h", -1);
			}
			{
				std::lock_guard<std::mutex> lk(g_rec_mutex);
				if (g_rec && !g_rec->done.load()) {
					reply({{"type", "error"}, {"error", "already recording"},
					              {"recordingId", g_rec->id}});
					return;
				}
				// a just-finished recorder may still be touched by a stop
				// waiter's tail — retire() defers the free past that window
				if (g_rec) { Recorder* old = g_rec; g_rec = nullptr; retire([old] { delete old; }); }
			}
			auto* r = new Recorder;
			r->id = "rec-" + std::to_string(wall_ms()) + "-" + rig::random_hex(2);
			r->client = c;
			r->disp = disp;
			r->started_wall = wall_ms();
			r->started_ms = now_ms();
			r->max_ms = max_ms;
			r->interval_ms = interval;
			r->scale = rscale;
			r->quality = rq;
			fs::path dir = g_rig.dir / "recordings" / r->id;
			std::error_code ec;
			fs::create_directories(dir, ec);
			if (ec) {
				reply({{"type", "error"}, {"error", "cannot create " + dir.string()}});
				delete r;
				return;
			}
			{ // live meta first: a crash mid-record still leaves a countable listing
				std::ofstream mf(dir / "meta.json");
				mf << rec_meta(r, true).dump(1);
			}
			{
				std::lock_guard<std::mutex> lk(g_rec_mutex);
				g_rec = r;
			}
			r->th = std::thread([r, dir, interval, rscale, rq, rx, ry, rw, rh] {
				std::ofstream times(dir / "times.txt", std::ios::trunc);
				try {
				while (!r->stop.load() && !g_stop.load()) {
					int64_t t0 = now_ms();
					rig::MemImage img;
					std::vector<uint8_t> enc;
					std::string err;
					if (native().capture(r->disp, rx, ry, rw, rh, rscale, "jpg", rq, img, enc, err) && !enc.empty()) {
						int seq = ++r->frames;
						char name[32];
						std::snprintf(name, sizeof(name), "f-%06d.jpg", seq);
						// write-then-rename: a concurrent record.frames read
						// never picks up a half-written JPEG
						fs::path fp = dir / name;
						{
							std::ofstream f(fp.string() + ".tmp", std::ios::binary);
							f.write(reinterpret_cast<const char*>(enc.data()), std::streamsize(enc.size()));
						}
						std::error_code rec;
						fs::rename(fp.string() + ".tmp", fp, rec);
						times << seq << '\t' << (t0 - r->started_ms) << '\n';
						times.flush();
						r->bytes += int64_t(enc.size());
						r->width = img.width;
						r->height = img.height;
					} else {
						r->dropped++;
					}
					if (now_ms() - r->started_ms >= r->max_ms) { r->reason = "maxDuration"; break; }
					int64_t spent = now_ms() - t0;
					if (spent < interval) std::this_thread::sleep_for(std::chrono::milliseconds(interval - spent));
				}
				} catch (...) { if (r->reason.empty()) r->reason = "error"; }
				if (r->reason.empty()) r->reason = g_stop.load() ? "shutdown" : "stop";
				r->stopped_wall = wall_ms();
				{
					std::ofstream mf(dir / "meta.json");
					mf << rec_meta(r, false).dump(1);
				}
				r->done = true;
				{
					std::lock_guard<std::mutex> lk(g_rec_mutex);
					if (r->client && r->client->alive) {
						json fin = rec_meta(r, false);
						fin["type"] = "computer.record.finished";
						fin["reason"] = r->reason;
						send_json(r->client, fin);
					}
				}
			});
			r->th.detach();
			json rep = {{"type", "computer.recording"}, {"id", r->id},
			            {"live", true},
			            {"startedAt", r->started_wall}, {"intervalMs", interval},
			            {"maxDurationMs", max_ms}, {"scale", rscale}, {"quality", rq},
			            {"display", disp}};
			if (rw > 0 && rh > 0) rep["region"] = {{"x", rx}, {"y", ry}, {"w", rw}, {"h", rh}};
			if (m.contains("id")) rep["reqId"] = m["id"];
			send_json(c, rep);
			return;
		}

		if (type == "computer.record.stop") {
			std::string id = m.value("id", m.value("recordingId", ""));
			Recorder* r = nullptr;
			{
				std::lock_guard<std::mutex> lk(g_rec_mutex);
				if (g_rec && (id.empty() || g_rec->id == id)) r = g_rec;
			}
			if (!r) {
				fs::path dir = g_rig.dir / "recordings" / id;
				if (!id.empty() && rec_id_ok(id) && fs::exists(dir)) {
					json rm = rec_disk_meta(dir);
					rm["type"] = "computer.recorded";
					rm["alreadyStopped"] = true;
					if (m.contains("id")) rm["reqId"] = m["id"];
					send_json(c, rm);
					return;
				}
				reply({{"type", "error"}, {"error", "no recording in progress"}});
				return;
			}
			// the reply waits for the capture thread's finalize on a worker so
			// a slow last frame can't stall this client's reader
			spawn_guarded(c, [c, r, req_id = m.value("id", "")] {
				int64_t t0 = now_ms();
				r->stop = true;
				while (!r->done.load() && now_ms() - t0 < 10000)
					std::this_thread::sleep_for(std::chrono::milliseconds(20));
				json rep = rec_meta(r, !r->done.load());
				rep["type"] = "computer.recorded";
				rep["waitedMs"] = now_ms() - t0;
				if (!req_id.empty()) rep["reqId"] = req_id;
				send_json(c, rep);
			});
			return;
		}

		if (type == "computer.record.list") {
			spawn_guarded(c, [c, req_id = m.value("id", "")] {
				json recs = json::array();
				fs::path root = g_rig.dir / "recordings";
				std::error_code ec;
				if (fs::exists(root, ec)) {
					for (auto& e : fs::directory_iterator(root, ec)) {
						std::string rid = e.path().filename().string();
						if (!e.is_directory() || !rec_id_ok(rid)) continue;
						json m;
						{
							std::lock_guard<std::mutex> lk(g_rec_mutex);
							if (g_rec && g_rec->id == rid && !g_rec->done.load())
								m = rec_meta(g_rec, true);
						}
						if (m.is_null()) m = rec_disk_meta(e.path());
						if (j_i64(m, "frames") > 0 || j_bool(m, "live")) recs.push_back(m);
					}
				}
				std::sort(recs.begin(), recs.end(), [](const json& a, const json& b) {
					return j_i64(a, "startedAt") > j_i64(b, "startedAt");
				});
				json rep = {{"type", "computer.recordings"}, {"recordings", recs}};
				if (!req_id.empty()) rep["id"] = req_id;
				send_json(c, rep);
			});
			return;
		}

		if (type == "computer.record.get") {
			std::string id = m.value("id", m.value("recordingId", ""));
			std::string fmt = m.value("format", "meta");
			if (!rec_id_ok(id)) { reply({{"type", "error"}, {"error", "valid recording id required"}}); return; }
			fs::path dir = g_rig.dir / "recordings" / id;
			if (!fs::exists(dir)) { reply({{"type", "error"}, {"error", "no such recording"}}); return; }
			if (fmt == "mp4") {
				// assembled lazily and cached as <dir>/video.mp4; needs ffmpeg
				// on PATH — without it the frame endpoints still fully work
				spawn_guarded(c, [c, dir, id, req_id = m.value("id", "")] {
					fs::path mp4 = dir / "video.mp4";
					int64_t took = 0;
					if (!fs::exists(mp4)) {
						Capture ff = run_capture("command -v ffmpeg || where ffmpeg", 3000);
						if (ff.code != 0 || ff.out.empty()) {
							json e = {{"type", "error"},
							          {"error", "ffmpeg not on PATH — use computer.record.frames"}};
							if (!req_id.empty()) e["id"] = req_id;
							send_json(c, e);
							return;
						}
						json dm = rec_disk_meta(dir);
						double fps = j_f64(dm, "fps", 4.0);
						if (fps <= 0 || fps > 120) fps = 4.0;
						char fr[32];
						std::snprintf(fr, sizeof(fr), "%.3f", fps);
						int64_t t0 = now_ms();
						std::string cmd = "ffmpeg -hide_banner -loglevel error -y -framerate " +
						                  std::string(fr) + " -i \"" + (dir / "f-%06d.jpg").string() +
						                  "\" -c:v libx264 -pix_fmt yuv420p -movflags +faststart \"" +
						                  mp4.string() + "\"";
						Capture r = run_capture(cmd, std::max(15000, int(j_i64(dm, "frames")) * 200));
						took = now_ms() - t0;
						std::error_code rec;
						if (r.code != 0 || !fs::exists(mp4, rec)) {
							json e = {{"type", "error"},
							          {"error", "ffmpeg failed: " + r.out.substr(0, 200)}};
							if (!req_id.empty()) e["id"] = req_id;
							send_json(c, e);
							return;
						}
					}
					int64_t sz = int64_t(fs::file_size(mp4));
					json rep = {{"type", "computer.recording"}, {"id", id}, {"format", "mp4"},
					            {"path", mp4.string()}, {"bytes", sz}, {"tookMs", took}};
					// client outbox caps at 8 MB — inline only small videos;
					// big ones stay server-side, clients play the frame seq
					if (sz <= 6 * 1024 * 1024) {
						std::ifstream f(mp4, std::ios::binary);
						std::vector<uint8_t> buf((std::istreambuf_iterator<char>(f)),
						                         std::istreambuf_iterator<char>());
						rep["dataBase64"] = rig::base64_encode(buf);
					} else {
						rep["tooLarge"] = true;
					}
					if (!req_id.empty()) rep["reqId"] = req_id;
					send_json(c, rep);
				});
				return;
			}
			json rep = rec_disk_meta(dir);
			{
				std::lock_guard<std::mutex> lk(g_rec_mutex);
				if (g_rec && g_rec->id == id && !g_rec->done.load()) rep = rec_meta(g_rec, true);
			}
			rep["type"] = "computer.recording";
			rep["path"] = dir.string();
			if (m.contains("id")) rep["reqId"] = m["id"];
			send_json(c, rep);
			return;
		}

		if (type == "computer.record.frames") {
			std::string id = m.value("id", m.value("recordingId", ""));
			int from = std::clamp(m.value("from", 1), 1, 1000000);
			int count = std::clamp(m.value("count", 60), 1, 500);
			if (!rec_id_ok(id)) { reply({{"type", "error"}, {"error", "valid recording id required"}}); return; }
			fs::path dir = g_rig.dir / "recordings" / id;
			if (!fs::exists(dir)) { reply({{"type", "error"}, {"error", "no such recording"}}); return; }
			spawn_guarded(c, [c, dir, id, from, count, req_id = m.value("id", "")] {
				std::unordered_map<int, int64_t> times;
				{
					std::ifstream tf(dir / "times.txt");
					int seq;
					int64_t t;
					while (tf >> seq >> t) times[seq] = t;
				}
				json dm = rec_disk_meta(dir);
				int total = int(j_i64(dm, "frames"));
				json frames = json::array();
				int64_t payload = 0;
				int seq = from, sent = 0;
				// seqs are contiguous on success — a gap means "past the end"
				for (; seq < from + count && payload < 4 * 1024 * 1024; seq++) {
					char name[32];
					std::snprintf(name, sizeof(name), "f-%06d.jpg", seq);
					fs::path fp = dir / name;
					std::error_code fec;
					if (!fs::exists(fp, fec)) break;
					std::ifstream f(fp, std::ios::binary);
					std::vector<uint8_t> buf((std::istreambuf_iterator<char>(f)),
					                         std::istreambuf_iterator<char>());
					if (buf.empty()) break;
					frames.push_back({{"seq", seq}, {"t", times[seq]},
					                  {"imageBase64", rig::base64_encode(buf)},
					                  {"bytes", buf.size()}});
					payload += int64_t(buf.size());
					sent++;
				}
				json rep = {{"type", "computer.record.frames"}, {"id", id},
				            {"from", from}, {"nextFrom", seq}, {"total", total},
				            {"count", sent}, {"frames", frames}};
				if (!req_id.empty()) rep["reqId"] = req_id;
				send_json(c, rep);
			});
			return;
		}

		if (type == "computer.record.delete") {
			std::string id = m.value("id", m.value("recordingId", ""));
			if (!rec_id_ok(id)) { reply({{"type", "error"}, {"error", "valid recording id required"}}); return; }
			{
				std::lock_guard<std::mutex> lk(g_rec_mutex);
				if (g_rec && g_rec->id == id && !g_rec->done.load()) {
					reply({{"type", "error"}, {"error", "recording in progress — stop it first"}});
					return;
				}
			}
			fs::path dir = g_rig.dir / "recordings" / id;
			std::error_code ec;
			if (!fs::exists(dir, ec)) { reply({{"type", "error"}, {"error", "no such recording"}}); return; }
			fs::remove_all(dir, ec);
			if (ec) { reply({{"type", "error"}, {"error", "delete failed: " + ec.message()}}); return; }
			reply({{"type", "ok"}, {"for", "computer.record.delete"}, {"id", id}, {"deleted", true}});
			return;
		}
	}

	// ---- token ledger ----
	if (type == "session.stats") {
		Session* s = find_session(m.value("sessionId", ""));
		if (!s) { reply({{"type", "error"}, {"error", "no such session"}}); return; }
		json frame = {{"type", "get_session_stats"}};
		if (m.contains("id")) frame["_cid"] = m["id"];
		if (!session_request(s, frame, c, nullptr, 60000))
			reply({{"type", "error"}, {"error", "write to omp failed"}});
		return;
	}

	if (type == "rig.usage") {
		json per = json::array();
		int64_t total_last = 0, total_max = 0;
		int64_t t_in = 0, t_out = 0, t_cr = 0, t_cw = 0;
		{
			std::lock_guard<std::mutex> lock(g_sessions_mutex);
			for (auto& [id, s] : g_sessions) {
				int64_t in = s->tok_in.load(), out = s->tok_out.load(),
				        cr = s->tok_cache_read.load(), cw = s->tok_cache_write.load();
				double hit = (in + cr > 0) ? (100.0 * cr / (in + cr)) : 0.0;
				json cache = {{"in", in}, {"out", out}, {"read", cr}, {"write", cw}, {"hitPct", hit}};
				per.push_back({{"sessionId", id}, {"tokens", s->usage_last.load()},
				               {"peakTokens", s->usage_max.load()}, {"contextWindow", s->usage_window.load()},
				               {"cache", cache}});
				if (s->usage_last > 0) total_last += s->usage_last;
				if (s->usage_max > 0) total_max += s->usage_max;
				t_in += in; t_out += out; t_cr += cr; t_cw += cw;
			}
		}
		double thit = (t_in + t_cr > 0) ? (100.0 * t_cr / (t_in + t_cr)) : 0.0;
		json tcache = {{"in", t_in}, {"out", t_out}, {"read", t_cr}, {"write", t_cw}, {"hitPct", thit}};
		json ru = {{"type", "rig.usage"}, {"sessions", per},
		              {"tokensLive", total_last}, {"tokensPeak", total_max},
		              {"cache", tcache},
		              {"exec", {{"count", g_exec_total.load()},
		                        {"msMin", g_exec_ms_min.load() == UINT64_MAX ? json(nullptr) : json(g_exec_ms_min.load())},
		                        {"msAvg", g_exec_total ? json(g_exec_ms_total.load() / g_exec_total) : json(nullptr)},
		                        {"msMax", g_exec_ms_max.load()}}}};
		if (m.contains("id")) ru["id"] = m["id"];
		send_json(c, ru);
		return;
	}

	reply({{"type", "error"}, {"error", "unknown type"}, {"got", type}});
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

static void serve_client_inner(Client* c) {
	std::string req;
	char buf[4096];
	while (req.find("\r\n\r\n") == std::string::npos) {
		ssize_t n = net_recv(c->fd, buf, sizeof(buf), 0);
		if (n <= 0) return;
		req.append(buf, size_t(n));
		if (req.size() > 64 * 1024) return;
	}

	if (req.rfind("GET /ws", 0) != 0) {
		// unauthenticated diagnostics page — lets any tailnet browser check the rig
		std::lock_guard<std::mutex> lock(g_sessions_mutex);
		json body = {{"name", "omprd"}, {"version", OMPRD_VERSION}, {"uptimeMs", now_ms() - g_boot_ms},
		             {"sessions", g_sessions.size()}};
		std::string b = body.dump();
		std::string resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
		                   "Content-Length: " + std::to_string(b.size()) + "\r\nConnection: close\r\n\r\n" + b;
		net_send(c->fd, resp.data(), resp.size(), MSG_NOSIGNAL);
		return;
	}

	std::string key = header_value(req, "Sec-WebSocket-Key");
	if (key.empty()) {
		std::string resp = "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n";
		net_send(c->fd, resp.data(), resp.size(), MSG_NOSIGNAL);
		return;
	}
	static const std::string WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
	std::string key_material = key + WS_GUID; // one object; two temporaries here would dangle
	std::string accept = rig::base64_encode(rig::sha1(rig::Bytes(key_material.begin(), key_material.end())));
	std::string resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
	                   "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
	if (net_send(c->fd, resp.data(), resp.size(), MSG_NOSIGNAL) != (ssize_t)resp.size()) return;

	{
		std::lock_guard<std::mutex> lock(g_clients_mutex);
		g_clients.insert(c);
	}

	// Bearer header, or ?token= for browser clients (JS WebSocket can't set headers)
	std::string bearer = header_value(req, "Authorization");
	std::string token = bearer.rfind("Bearer ", 0) == 0 ? bearer.substr(7) : "";
	if (token.empty()) {
		size_t q = req.find("token=");
		if (q != std::string::npos && q < req.find("\r\n")) {
			size_t end = req.find_first_of("& ", q);
			token = req.substr(q + 6, end == std::string::npos ? std::string::npos : end - q - 6);
		}
	}
	bool service = !token.empty() && is_service_token(token);
	uint32_t scopes = SCOPE_ALL;
	if (!token.empty() && (service || g_rig.token_valid(token, &scopes))) {
		c->authed = true;
		c->service = service;
		c->scopes = service ? SCOPE_ALL : scopes;
		log(service ? "omp child service channel connected" : "client authenticated by token: " + c->name);
	} else {
		log("client connected, awaiting pairing: " + c->name);
	}

	std::thread* writer = new std::thread(writer_thread, c);
	c->writer_th = writer;

	std::string msg;
	while (!g_stop && c->alive && ws_recv(c, msg)) {
		c->last_activity_ms = now_ms();
		try {
			handle_message(c, json::parse(msg));
		} catch (const json::parse_error& e) {
			send_json(c, {{"type", "error"}, {"error", std::string("bad json: ") + e.what()}});
		} catch (const std::exception& e) {
			send_json(c, {{"type", "error"}, {"error", e.what()}});
		}
	}
}

static void serve_client(sockfd_t fd, const std::string& peer) {
	// A misbehaving client must never take the daemon down.
	auto* c = new Client;
	c->fd = fd;
	c->name = peer;
	try {
		serve_client_inner(c);
	} catch (const std::exception& e) {
		log("client error (" + peer + "): " + e.what());
	}
	c->alive = false;
	c->out_cv.notify_all();
	{
		std::lock_guard<std::mutex> lock(g_clients_mutex);
		g_clients.erase(c);
	}
	{ // detach watchers before the Client they point at is freed
		std::lock_guard<std::mutex> lk(g_watchers_mutex);
		for (auto* w : g_watchers)
			if (w->client == c) { w->stop = true; w->client = nullptr; }
	}
	{ // the recording itself keeps running — only the finished-event target goes
		std::lock_guard<std::mutex> lk(g_rec_mutex);
		if (g_rec && g_rec->client == c) g_rec->client = nullptr;
	}
	terms_close_for(c);
	// the writer owns the socket's send side: join it before touching the fd
	if (c->writer_th) {
		c->writer_th->join();
		delete c->writer_th;
	}
	sock_close(fd);
	retire([c] { delete c; }); // stale refs stay valid until the sweep frees it
	log("client gone: " + peer);
}

// ---------------------------------------------------------------------------

static std::string detect_tailscale_ip() {
	char buf[128];
#if defined(_WIN32)
	FILE* f = _popen("tailscale ip -4 2>NUL", "r");
#else
	FILE* f = popen("tailscale ip -4 2>/dev/null | head -1", "r");
#endif
	if (!f) return "";
	std::string ip;
	if (fgets(buf, sizeof(buf), f)) {
		ip = buf;
		ip.erase(ip.find_last_not_of(" \r\n\t") + 1);
	}
#if defined(_WIN32)
	_pclose(f);
#else
	pclose(f);
#endif
	return ip;
}

// LAN egress interface address: the source IP a UDP "connect" would use —
// no packet is ever sent, so this works offline too.
static std::string detect_lan_ip() {
	sockfd_t s = socket(AF_INET, SOCK_DGRAM, 0);
#if defined(_WIN32)
	if (s == INVALID_SOCKET) return "";
#else
	if (s < 0) return "";
#endif
	sockaddr_in a{};
	a.sin_family = AF_INET;
	a.sin_port = htons(80);
	inet_pton(AF_INET, "8.8.8.8", &a.sin_addr);
	std::string ip;
	if (connect(s, reinterpret_cast<sockaddr*>(&a), sizeof(a)) == 0) {
		sockaddr_in me{};
		socklen_t len = sizeof(me);
		if (getsockname(s, reinterpret_cast<sockaddr*>(&me), &len) == 0) {
			char buf[64];
			if (inet_ntop(AF_INET, &me.sin_addr, buf, sizeof(buf))) ip = buf;
		}
	}
	sock_close(s);
	return ip;
}

// Pairing payload host: tailnet first (reachable from anywhere), then LAN
// (same-network phones), then loopback (same-box testing only).
static std::string detect_best_ip() {
	std::string ip = detect_tailscale_ip();
	if (!ip.empty()) return ip;
	ip = detect_lan_ip();
	if (!ip.empty()) return ip;
	return "127.0.0.1";
}

// Mint a one-time pairing code into ~/.rig/pending.json — the same file the
// running daemon's pair{} handler consumes (and `ompr pair` writes).
static std::string mint_pair_code(uint32_t scopes = SCOPE_ALL) {
	g_rig.load();
	unsigned int n = 0;
	auto rb = rig::random_bytes(4);
	for (uint8_t b : rb) n = (n << 8) | b;
	char code[8];
	std::snprintf(code, sizeof(code), "%06u", n % 1000000);
	json pending = {{"code", code},
	                {"expires", int64_t(std::chrono::system_clock::to_time_t(std::chrono::system_clock::now()) + 600)}};
	if (scopes != SCOPE_ALL) pending["scopes"] = scopes;
	std::ofstream(g_rig.dir / "pending.json") << pending.dump();
	return code;
}

// Render the pairing QR to a PNG (quiet zone + ~12px modules) — used by the
// desktop installer, which pops this file in an image viewer so the phone
// has a big scannable target even when there's no terminal open.
static bool write_pair_qr_png(const std::string& path, const std::string& uri) {
	auto m = rig::qr_matrix(uri);
	if (m.empty()) return false;
	const int n = int(m.size()), scale = 12, quiet = 4;
	const int px = (n + quiet * 2) * scale;
	std::vector<uint8_t> img(size_t(px) * px * 3, 255);
	for (int r = 0; r < n; r++)
		for (int c = 0; c < n; c++) {
			if (m[r][c] != 1) continue;
			for (int dy = 0; dy < scale; dy++)
				for (int dx = 0; dx < scale; dx++) {
					size_t off = (size_t((r + quiet) * scale + dy) * px +
					              size_t((c + quiet) * scale + dx)) * 3;
					img[off] = img[off + 1] = img[off + 2] = 0;
				}
		}
	return stbi_write_png(path.c_str(), px, px, 3, img.data(), px * 3) != 0;
}

// `omprd pair` / `--qr`: the "how does the phone connect" answer — prints a
// deep-link URI plus a scannable terminal QR carrying the same payload.
static void print_pair_qr(const std::string& ip, int port, uint32_t scopes = SCOPE_ALL,
                          const std::string& png_path = "") {
	std::string code = mint_pair_code(scopes);
	// URI hosts with colons need brackets — detect_* only yields IPv4 today,
	// but a --bind override could hand us an IPv6 literal tomorrow.
	std::string host = ip.find(':') != std::string::npos ? "[" + ip + "]" : ip;
	std::string uri = "remote://" + host + ":" + std::to_string(port) + "#" + code;
	std::string qr = rig::qr_ascii(uri);
	std::cout << "\nscan from the Remote app to pair this phone:\n\n";
	if (!qr.empty()) std::cout << qr << "\n";
	else std::cout << "  (payload too long for a terminal QR — paste the link)\n\n";
	std::cout << "  " << uri << "\n\n"
	          << "  (code " << code << ", valid 10 min — or paste the link in the app)\n"
	          << std::endl;
	if (!png_path.empty())
		std::cout << (write_pair_qr_png(png_path, uri)
		                  ? "  QR image: " + png_path + "\n"
		                  : "  (QR image write failed)\n");
}

// Spawned children resolve omp and its bun shebang through PATH, but a
// systemd unit, launchd job or detached shell hands us a sparse PATH that
// misses the user's own bin dirs — prepend the usual ones when they exist.
static void augment_path() {
#if defined(_WIN32)
	const char sep = ';';
	std::vector<std::string> extras;
	if (const char* up = getenv("USERPROFILE"))
		extras.push_back(std::string(up) + "\\.bun\\bin");
#else
	const char sep = ':';
	std::vector<std::string> extras;
	if (const char* home = getenv("HOME"))
		extras = {std::string(home) + "/.bun/bin",
		          std::string(home) + "/.local/bin",
		          std::string(home) + "/bin"};
#endif
	std::string path = getenv("PATH") ? getenv("PATH") : "";
	bool dirty = false;
	for (auto& e : extras) {
		if (!fs::is_directory(e) || path.find(e) != std::string::npos) continue;
		path = e + sep + path;
		dirty = true;
	}
	if (!dirty) return;
#if defined(_WIN32)
	_putenv_s("PATH", path.c_str());
#else
	setenv("PATH", path.c_str(), 1);
#endif
}

int main(int argc, char** argv) {
	install_stop_signals();
#if defined(_WIN32)
	WSADATA wsa;
	WSAStartup(MAKEWORD(2, 2), &wsa);
#else
	std::signal(SIGPIPE, SIG_IGN);
#endif
	// SIGCHLD stays default: the reaper waitpid()s explicitly, so we get real exit codes.

	std::string bind_ip;
	int port = g_port;
	std::string omp_bin;
	bool qr_flag = false;
	bool keep_awake = true; // default on — a rig that sleeps isn't reachable
	for (int i = 1; i < argc; i++) {
		std::string a = argv[i];
		if (a == "--bind" && i + 1 < argc) bind_ip = argv[++i];
		else if (a == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
		else if (a == "--omp-bin" && i + 1 < argc) omp_bin = argv[++i];
		else if (a == "--qr") qr_flag = true;
		else if (a == "--keep-awake") keep_awake = true;
		else if (a == "--no-keep-awake") keep_awake = false;
		else if (a == "--version") { std::cout << "omprd " OMPRD_VERSION "\n"; return 0; }
		else if (a == "pair") {
			// standalone: mint + print while the real daemon is already up.
			// `omprd pair --scopes read` (or read,operate) narrows the minted
			// token — a view-only phone gets watch/list but can't act.
			// `--png <path>` also writes the QR to an image file (installer pops
			// it in the desktop's image viewer — no terminal needed to scan).
			uint32_t scopes = SCOPE_ALL;
			std::string png_path;
			for (int j = i + 1; j + 1 < argc; j++) {
				if (std::string(argv[j]) == "--scopes") {
					json names = json::array();
					std::string csv = argv[j + 1], cur;
					std::istringstream ss(csv);
					while (std::getline(ss, cur, ',')) names.push_back(cur);
					scopes = scope_mask(names);
					if (!scopes) { std::cerr << "unknown scopes: " << csv << "\n"; return 2; }
					j++;
				} else if (std::string(argv[j]) == "--png") {
					png_path = argv[++j];
				}
			}
			print_pair_qr(detect_best_ip(), port, scopes, png_path);
			if (scopes != SCOPE_ALL)
				std::cout << "this token is scoped: " << scope_names(scopes).dump() << "\n";
			return 0;
		}
		else {
			std::cerr << "usage: omprd [--bind ip] [--port n] [--omp-bin path] [--qr]\n"
			          << "             [--keep-awake | --no-keep-awake] | omprd pair [--scopes a,b]\n";
			return 2;
		}
	}

	// Children resolve omp and its bun shebang through PATH — a systemd unit,
	// launchd job or detached shell hands us a sparse PATH, so make sure the
	// usual per-user bin dirs are on it.
	augment_path();

	g_rig.load();
	materialize_rig_call(); // ~/.rig/rig-call — the in-session wire shim
	// tailnet → LAN → loopback; the QR host and the bind address now share
	// the same "best reachable IP" answer.
	if (bind_ip.empty()) bind_ip = detect_best_ip();
	g_bind_ip = bind_ip;
	g_port = port;
	g_omp_bin = [&] {
		if (!omp_bin.empty()) return omp_bin;
		if (const char* env = getenv("OMP_BIN")) return std::string(env);
		// installer payload first, then a per-user omp checkout, then PATH
		const char* home = getenv("HOME");
		if (home) {
			static const char* rel[] = {
				"/.local/share/remote/bin/omp",
				"/.rig/omp/node_modules/.bin/omp",
				"/node_modules/.bin/omp",
			};
			for (const char* r : rel) {
				std::string c = std::string(home) + r;
				if (file_x_ok(c.c_str())) return c;
			}
		}
		return std::string("omp");
	}();
#if defined(_WIN32)
	bool omp_bin_abs = g_omp_bin.size() > 2 && g_omp_bin[1] == ':';
#else
	bool omp_bin_abs = !g_omp_bin.empty() && g_omp_bin[0] == '/';
#endif
	if (g_omp_bin.find_first_of("/\\") != std::string::npos && !omp_bin_abs)
		g_omp_bin = fs::absolute(g_omp_bin).lexically_normal().string();

	restore_sessions(); // ~/.rig/sessions survivors rejoin the inbox
	jobs_load();        // ~/.rig/jobs.json routines resume their intervals

	log("omprd " OMPRD_VERSION " | bind " + bind_ip + ":" + std::to_string(port) +
	    " | omp: " + g_omp_bin + " | devices: " + std::to_string(g_rig.devices.size()) +
	    (g_rig.locked ? " | LOCKED" : ""));

	sockfd_t listen_fd = socket(AF_INET, SOCK_STREAM, 0);
	// children spawned by rig.exec/computer.boot inherit fds — without this
	// a killed daemon leaves the port held by an orphan (learned on the rig).
	// On Windows sockets are not inherited by CreateProcess children at all;
	// win_spawn's PROC_THREAD_ATTRIBUTE_HANDLE_LIST covers the pipe handles.
#if !defined(_WIN32)
	fcntl(listen_fd, F_SETFD, FD_CLOEXEC);
#endif
	int one = 1;
	setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&one), sizeof(one));
	sockaddr_in addr{};
	addr.sin_family = AF_INET;
	addr.sin_port = htons(uint16_t(port));
	if (inet_pton(AF_INET, bind_ip.c_str(), &addr.sin_addr) != 1) {
		log("invalid bind ip: " + bind_ip);
		return 1;
	}
	if (bind(listen_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
#if defined(_WIN32)
		log("bind failed on " + bind_ip + ":" + std::to_string(port) + " — " + win_last_err());
#else
		log("bind failed on " + bind_ip + ":" + std::to_string(port) + " — " + std::strerror(errno));
#endif
		return 1;
	}
	if (listen(listen_fd, 16) < 0) { log("listen failed"); return 1; }
	log("listening.");

	// --keep-awake (default): hold the OS sleep inhibitor from boot — the
	// rig's job is being reachable, not only while a session happens to run.
	// --no-keep-awake returns to session-scoped assertions only.
	if (keep_awake) {
		g_keep_awake_persistent = true;
		bool ok_init = native().init();
		if (ok_init) native().stay_awake(true);
		// "held" means a real OS sleep inhibitor — screensaver-only xss
		// must NOT read as held (seatless boxes get polkit-denied logind).
		bool held = ok_init && native().awake_held_os();
		log("keep-awake: " + std::string(held ? "held" : "unavailable") +
		    " (" + (ok_init ? native().awake_method() : "none") + ")");
	}
	if (qr_flag) print_pair_qr(bind_ip, port);

	std::thread reaper(reap_and_cleanup);
	reaper.detach(); // joinable-thread dtor at exit → terminate called without active exception

	while (!g_stop) {
		sockaddr_in peer{};
		socklen_t plen = sizeof(peer);
		sockfd_t fd = accept(listen_fd, reinterpret_cast<sockaddr*>(&peer), &plen);
#if defined(_WIN32)
		if (fd == INVALID_SOCKET) {
			if (WSAGetLastError() == WSAEINTR) continue;
			break;
		}
#else
		if (fd < 0) {
			if (errno == EINTR) continue;
			break;
		}
#endif
#if !defined(_WIN32)
		// same reason as listen_fd above: spawned children would otherwise
		// hold a dup of this client socket and keep it open past its close.
		fcntl(fd, F_SETFD, FD_CLOEXEC);
#endif
		int nd = 1;
		setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&nd), sizeof(nd));
		char pbuf[64];
		inet_ntop(AF_INET, &peer.sin_addr, pbuf, sizeof(pbuf));
		std::thread(serve_client, fd, std::string(pbuf) + ":" + std::to_string(ntohs(peer.sin_port))).detach();
	}

	log("shutting down; killing sessions");
	{
		std::lock_guard<std::mutex> lock(g_sessions_mutex);
		for (auto& [id, s] : g_sessions) {
			// SIGTERM not SIGHUP — bun ignores HUP and keeps ~450 MB parked;
			// TERM is what session_kill/hibernate use and it actually exits
			if (s->pid > 0) { kill(-s->pid, SIGTERM); kill(s->pid, SIGTERM); }
			// flush + release the persist stream so the log is complete on disk;
			// the files stay — boot restore picks them up next launch. Lock the
			// ring: a reader's in-flight emit shares this FILE*.
			std::lock_guard<std::mutex> rl(s->ring_mutex);
			if (s->persist_fp) { fclose(s->persist_fp); s->persist_fp = nullptr; }
		}
	}
	{
		std::lock_guard<std::mutex> lock(g_warm_mutex);
		for (auto* w : g_warm) { kill(w->pid, SIGTERM); file_close(w->stdin_fd); file_close(w->stdout_fd); retire([w] { delete w; }); }
		g_warm.clear();
	}
	if (g_lid_inhibit_pid > 0) kill(g_lid_inhibit_pid, SIGTERM);
	sock_close(listen_fd);
	return 0;
}
