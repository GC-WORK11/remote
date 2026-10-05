// rigfs.hpp — rig.fs: native filesystem ops for the wire protocol.
//
// The agent harness's highest-frequency ops (read/write/glob/grep) without a
// shell, a subprocess, or any dependency — open/pread/pwrite + a recursive
// walk over std::filesystem. Replies carry tookUs so clients can budget.
//
// Security: the daemon is the trust boundary (same posture as rig.exec) —
// paths resolve against the caller's cwd (default $HOME); there is no jail.
#pragma once
#include "crypto.hpp"
#include "json.hpp"

#include <fcntl.h>
#include <sys/stat.h>
#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif

#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <regex>
#include <string>
#include <unordered_set>
#include <system_error>
#include <vector>

namespace rigfs {

using nlohmann::json;
namespace fs = std::filesystem;
using clk = std::chrono::steady_clock;

static int64_t us_since(clk::time_point t0) {
	return std::chrono::duration_cast<std::chrono::microseconds>(clk::now() - t0).count();
}

// ---------------------------------------------------------------------------
// win32 compat: CRT fd layer (_wopen/_read/_write/_commit/_wstat64) with
// _O_BINARY always set — without it the CRT mangles CRLF on binary files
// ---------------------------------------------------------------------------
#if defined(_WIN32)
// `struct ::_stat64` must be qualified: sys/stat.h also declares a _stat64()
// FUNCTION which shadows the tag in ordinary lookup, and an unqualified
// `struct _stat64` in a using-alias makes MSVC declare a fresh rigfs::_stat64.
using rigfs_stat_t = struct ::_stat64;
// ssize_t is POSIX-only; the CRT fd layer returns int (widened).
using ssize_t = int64_t;
static int rigfs_open(const fs::path& p, int flags, int mode = 0) {
	return _wopen(p.c_str(), flags | _O_BINARY, mode ? mode : (_S_IREAD | _S_IWRITE));
}
static int rigfs_read(int fd, void* b, size_t n) { return _read(fd, b, unsigned(n)); }
static int rigfs_write(int fd, const void* b, size_t n) { return _write(fd, b, unsigned(n)); }
static int rigfs_close(int fd) { return _close(fd); }
static int rigfs_fsync(int fd) { return _commit(fd); }
static int rigfs_stat(const fs::path& p, rigfs_stat_t* st) { return _wstat64(p.c_str(), st); }
static int rigfs_fstat(int fd, rigfs_stat_t* st) { return _fstat64(fd, st); }
static int rigfs_pread(int fd, void* b, size_t n, int64_t off) {
	if (_lseeki64(fd, off, SEEK_SET) < 0) return -1;
	return _read(fd, b, unsigned(n));
}
static bool rigfs_is_reg(const rigfs_stat_t& st) { return (st.st_mode & _S_IFMT) == _S_IFREG; }
static bool rigfs_is_dir(const rigfs_stat_t& st) { return (st.st_mode & _S_IFMT) == _S_IFDIR; }
static const char* rigfs_home() { const char* h = getenv("USERPROFILE"); return h ? h : ""; }
#else
using rigfs_stat_t = struct stat;
static int rigfs_open(const fs::path& p, int flags, int mode = 0666) {
	return ::open(p.c_str(), flags, mode);
}
static ssize_t rigfs_read(int fd, void* b, size_t n) { return ::read(fd, b, n); }
static ssize_t rigfs_write(int fd, const void* b, size_t n) { return ::write(fd, b, n); }
static int rigfs_close(int fd) { return ::close(fd); }
static int rigfs_fsync(int fd) { return fsync(fd); }
static int rigfs_stat(const fs::path& p, rigfs_stat_t* st) { return ::stat(p.c_str(), st); }
static int rigfs_fstat(int fd, rigfs_stat_t* st) { return ::fstat(fd, st); }
static ssize_t rigfs_pread(int fd, void* b, size_t n, int64_t off) { return pread(fd, b, n, off_t(off)); }
static bool rigfs_is_reg(const rigfs_stat_t& st) { return S_ISREG(st.st_mode); }
static bool rigfs_is_dir(const rigfs_stat_t& st) { return S_ISDIR(st.st_mode); }
static const char* rigfs_home() { const char* h = getenv("HOME"); return h ? h : "/"; }
#endif

static int64_t mtime_ms(const rigfs_stat_t& st) {
#if defined(_WIN32)
	return int64_t(st.st_mtime) * 1000;
#elif defined(__APPLE__)
	return int64_t(st.st_mtimespec.tv_sec) * 1000 + int64_t(st.st_mtimespec.tv_nsec) / 1000000;
#else
	return int64_t(st.st_mtim.tv_sec) * 1000 + int64_t(st.st_mtim.tv_nsec) / 1000000;
#endif
}

static fs::path resolve(const std::string& path, const std::string& cwd) {
	fs::path p = path.empty() ? fs::path(cwd) : fs::path(path);
	if (p.is_relative()) {
		fs::path base = cwd.empty() ? fs::path(rigfs_home()) : fs::path(cwd);
		p = base / p;
	}
	return p.lexically_normal();
}

// ---------------------------------------------------------------------------
// base64 decode (write path takes contentBase64 for binary-safe writes)
// ---------------------------------------------------------------------------
static bool base64_decode(const std::string& in, std::vector<uint8_t>& out) {
	static const int8_t T[256] = {
		-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
		-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-2,-1,-1,
		-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
		-1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
		-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
		-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
		-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
		-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1};
	uint32_t acc = 0;
	int bits = 0;
	out.clear();
	out.reserve(in.size() * 3 / 4);
	for (char ch : in) {
		int8_t v = T[uint8_t(ch)];
		if (v == -2) break;          // '=' padding
		if (v < 0) continue;         // whitespace etc.
		acc = (acc << 6) | uint32_t(v);
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out.push_back(uint8_t((acc >> bits) & 0xFF));
		}
	}
	return true;
}

static bool valid_utf8(const std::string& s) {
	for (size_t i = 0; i < s.size();) {
		uint8_t c = uint8_t(s[i]);
		uint32_t cp;
		size_t n;
		if (c < 0x80) { i++; continue; }
		if ((c >> 5) == 0x6) { cp = c & 0x1F; n = 1; }
		else if ((c >> 4) == 0xE) { cp = c & 0x0F; n = 2; }
		else if ((c >> 3) == 0x1E) { cp = c & 0x07; n = 3; }
		else return false;
		if (i + n >= s.size()) return false;
		for (size_t k = 1; k <= n; k++) {
			uint8_t cc = uint8_t(s[i + k]);
			if ((cc >> 6) != 0x2) return false;
			cp = (cp << 6) | (cc & 0x3F);
		}
		if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
		i += n + 1;
	}
	return true;
}

// ---------------------------------------------------------------------------
// glob → regex ("**" crosses '/', "*" and "?" stay within a segment)
// ---------------------------------------------------------------------------
static std::regex glob_regex(const std::string& pat, bool icase = false) {
	std::string re = "^";
	for (size_t i = 0; i < pat.size(); i++) {
		char c = pat[i];
		if (c == '*') {
			if (i + 1 < pat.size() && pat[i + 1] == '*') {
				re += ".*";
				i++;
				if (i + 1 < pat.size() && pat[i + 1] == '/') i++; // "**/" eats the slash
			} else {
				re += "[^/]*";
			}
		} else if (c == '?') {
			re += "[^/]";
		} else if (c == '[') {
			size_t j = i + 1;
			if (j < pat.size() && (pat[j] == '!' || pat[j] == '^')) j++;
			if (j < pat.size() && pat[j] == ']') j++;
			while (j < pat.size() && pat[j] != ']') j++;
			if (j < pat.size()) {
				re += pat.substr(i, j - i + 1);
				i = j;
			} else {
				re += "\\[";
			}
		} else if (c == '{') {
			size_t j = i + 1, depth = 1;
			while (j < pat.size() && depth) {
				if (pat[j] == '{') depth++;
				else if (pat[j] == '}') depth--;
				j++;
			}
			if (depth == 0) {
				re += "(";
				for (size_t k = i + 1; k < j - 1; k++) re += (pat[k] == ',') ? '|' : pat[k];
				re += ")";
				i = j - 1;
			} else {
				re += "\\{";
			}
		} else if (std::strchr("\\.^$|()+", c)) {
			re += '\\';
			re += c;
		} else {
			re += c;
		}
	}
	re += "$";
	return std::regex(re, icase ? std::regex::icase : std::regex::ECMAScript);
}

// relative path of `entry` under `root`, posix separators
static std::string rel_of(const fs::path& entry, const fs::path& root) {
	std::error_code ec;
	fs::path r = fs::relative(entry, root, ec);
	return (ec ? entry : r).generic_string();
}

static bool looks_binary(const char* buf, size_t n) {
	return n && memchr(buf, 0, n) != nullptr;
}

// ---------------------------------------------------------------------------
// rig.fs.read {path, cwd?, offset?, maxBytes?}
//   → {path, size, mtimeMs, truncated, content|contentBase64, tookUs}
// ---------------------------------------------------------------------------
static json op_read(const json& m) {
	auto t0 = clk::now();
	fs::path p = resolve(m.value("path", ""), m.value("cwd", ""));
	int fd = rigfs_open(p, O_RDONLY);
	if (fd < 0) return {{"ok", false}, {"error", "open failed: " + std::string(std::strerror(errno))}, {"path", p.string()}, {"tookUs", us_since(t0)}};
	rigfs_stat_t st {};
	if (rigfs_fstat(fd, &st) != 0 || !rigfs_is_reg(st)) {
		rigfs_close(fd);
		return {{"ok", false}, {"error", "not a regular file"}, {"path", p.string()}, {"tookUs", us_since(t0)}};
	}
	uint64_t size = uint64_t(st.st_size);
	uint64_t offset = std::min<uint64_t>(m.value("offset", uint64_t(0)), size);
	uint64_t maxb = std::min<uint64_t>(m.value("maxBytes", uint64_t(4) << 20), uint64_t(64) << 20);
	uint64_t want = std::min<uint64_t>(size - offset, maxb);
	std::string buf;
	buf.resize(size_t(want));
	size_t got = 0;
	while (got < want) {
		ssize_t n = rigfs_pread(fd, buf.data() + got, size_t(want - got), int64_t(offset + got));
		if (n <= 0) break;
		got += size_t(n);
	}
	rigfs_close(fd);
	buf.resize(got);
	json r = {{"ok", true}, {"path", p.string()}, {"size", size},
	          {"mtimeMs", mtime_ms(st)},
	          {"offset", offset}, {"truncated", size - offset > got}};
	if (valid_utf8(buf)) r["content"] = buf;
	else r["contentBase64"] = rig::base64_encode(rig::Bytes(buf.begin(), buf.end()));
	r["tookUs"] = us_since(t0);
	return r;
}

// ---------------------------------------------------------------------------
// rig.fs.write {path, cwd?, content?|contentBase64?, append?, mkdirs?, mode?}
//   atomic by default (tmp file + rename over the target)
//   → {path, bytes, tookUs}
// ---------------------------------------------------------------------------
static json op_write(const json& m) {
	auto t0 = clk::now();
	fs::path p = resolve(m.value("path", ""), m.value("cwd", ""));
	std::string payload;
	if (m.contains("contentBase64")) {
		std::vector<uint8_t> raw;
		base64_decode(m.value("contentBase64", ""), raw);
		payload.assign(reinterpret_cast<const char*>(raw.data()), raw.size());
	} else {
		payload = m.value("content", "");
	}
	bool append = m.value("append", false);
	if (m.value("mkdirs", true)) {
		std::error_code ec;
		fs::create_directories(p.parent_path(), ec);
	}
	int flags = O_WRONLY | O_CREAT;
	if (append) flags |= O_APPEND;
	int fd;
	fs::path tmp;
	if (append) {
		fd = rigfs_open(p, flags);
	} else {
		tmp = p.parent_path() / (".rigfs-" + p.filename().string() + "-" + rig::random_hex(4) + ".tmp");
		fd = rigfs_open(tmp, flags | O_TRUNC);
	}
	if (fd < 0) return {{"ok", false}, {"error", "open failed: " + std::string(std::strerror(errno))}, {"path", p.string()}, {"tookUs", us_since(t0)}};
	size_t wrote = 0;
	while (wrote < payload.size()) {
		ssize_t n = rigfs_write(fd, payload.data() + wrote, payload.size() - wrote);
		if (n <= 0) { rigfs_close(fd); return {{"ok", false}, {"error", "write failed: " + std::string(std::strerror(errno))}, {"tookUs", us_since(t0)}}; }
		wrote += size_t(n);
	}
	rigfs_fsync(fd);
	rigfs_close(fd);
	std::error_code ec;
	if (!append) {
		fs::rename(tmp, p, ec);
		if (ec) {
			fs::remove(tmp);
			return {{"ok", false}, {"error", "rename failed: " + ec.message()}, {"path", p.string()}, {"tookUs", us_since(t0)}};
		}
	}
	if (m.contains("mode")) {
		fs::permissions(p, static_cast<fs::perms>(m.value("mode", 0644)), ec);
	}
	return {{"ok", true}, {"path", p.string()}, {"bytes", payload.size()}, {"tookUs", us_since(t0)}};
}

// ---------------------------------------------------------------------------
// rig.fs.glob {pattern, cwd?, maxResults?, filesOnly?}
//   → {matches:[{path,size,mtimeMs}], count, scanned, tookUs}
// ---------------------------------------------------------------------------
static json op_glob(const json& m) {
	auto t0 = clk::now();
	std::string pat = m.value("pattern", "");
	if (pat.empty()) return {{"ok", false}, {"error", "pattern required"}, {"tookUs", us_since(t0)}};
	fs::path root = resolve("", m.value("cwd", ""));
	size_t maxr = std::min<size_t>(m.value("maxResults", size_t(5000)), size_t(50000));
	bool files_only = m.value("filesOnly", true);
	std::regex re;
	try { re = glob_regex(pat); }
	catch (const std::regex_error& e) { return {{"ok", false}, {"error", std::string("bad glob: ") + e.what()}, {"tookUs", us_since(t0)}}; }
	json matches = json::array();
	size_t scanned = 0;
	std::error_code ec;
	// A `*` listing should be shallow — the recursive walk descends into
	// permission-denied dirs (TCC-protected ~/Desktop & co on macOS) where an
	// errored increment can re-emit the same entry hundreds of times.
	bool shallow = pat.find("**") == std::string::npos &&
	               pat.find('/') == std::string::npos;
	std::unordered_set<std::string> seen;
	auto emit = [&](const fs::path& p) {
		bool is_file = fs::is_regular_file(p, ec);
		if (ec) { ec.clear(); return; }
		if (files_only && !is_file) return;
		if (!is_file && !fs::is_directory(p, ec)) { if (ec) ec.clear(); return; }
		if (ec) { ec.clear(); return; }
		std::string rel = rel_of(p, root);
		if (!std::regex_match(rel, re)) return;
		if (!seen.insert(rel).second) return;
		rigfs_stat_t st {};
		if (rigfs_stat(p, &st) != 0) return;
		matches.push_back({{"path", rel},
		                   {"size", uint64_t(st.st_size)},
		                   {"mtimeMs", mtime_ms(st)},
		                   {"dir", !is_file}});
	};
	if (shallow) {
		fs::directory_iterator it(root, fs::directory_options::skip_permission_denied, ec), end;
		if (ec) return {{"ok", false}, {"error", "cannot list " + root.string() + ": " + ec.message()}, {"tookUs", us_since(t0)}};
		for (; it != end && matches.size() < maxr; it.increment(ec)) {
			if (ec) { ec.clear(); continue; }
			scanned++;
			emit(it->path());
		}
	} else {
		fs::recursive_directory_iterator it(root, fs::directory_options::skip_permission_denied, ec), end;
		if (ec) return {{"ok", false}, {"error", "cannot walk " + root.string() + ": " + ec.message()}, {"tookUs", us_since(t0)}};
		for (; it != end && matches.size() < maxr; it.increment(ec)) {
			if (ec) { ec.clear(); continue; }
			scanned++;
			emit(it->path());
		}
	}
	return {{"ok", true}, {"matches", matches}, {"count", matches.size()},
	        {"scanned", scanned}, {"tookUs", us_since(t0)}};
}

// ---------------------------------------------------------------------------
// rig.fs.grep {pattern, cwd?, path?, glob?, regex?, caseInsensitive?, maxResults?,
//              context?, maxFileBytes?}
//   literal patterns take a memmem fast path; regex only when asked/needed.
//   → {matches:[{path,line,col,text}], count, scannedFiles, tookUs}
// ---------------------------------------------------------------------------
static bool regex_meta(const std::string& p) {
	return p.find_first_of("\\.^$|()[]{}*+?") != std::string::npos;
}

static json op_grep(const json& m) {
	auto t0 = clk::now();
	std::string pat = m.value("pattern", "");
	if (pat.empty()) return {{"ok", false}, {"error", "pattern required"}, {"tookUs", us_since(t0)}};
	fs::path root;
	std::string one = m.value("path", "");
	if (!one.empty()) {
		root = resolve(one, m.value("cwd", ""));
	} else {
		root = resolve("", m.value("cwd", ""));
	}
	bool icase = m.value("caseInsensitive", false);
	bool use_regex = m.contains("regex") ? m.value("regex", false) : regex_meta(pat);
	size_t maxr = std::min<size_t>(m.value("maxResults", size_t(500)), size_t(20000));
	uint64_t maxfb = std::min<uint64_t>(m.value("maxFileBytes", uint64_t(32) << 20), uint64_t(256) << 20);
	int want_ctx = std::clamp(m.value("context", 0), 0, 8);

	std::regex re;
	std::string needle = pat;
	if (icase && !use_regex) {
		for (char& ch : needle) ch = char(std::tolower(unsigned(ch)));
	}
	if (use_regex) {
		try {
			re = std::regex(pat, icase ? std::regex::icase : std::regex::ECMAScript);
		} catch (const std::regex_error& e) {
			return {{"ok", false}, {"error", std::string("bad regex: ") + e.what()}, {"tookUs", us_since(t0)}};
		}
	}
	std::regex file_re;
	bool has_file_filter = m.contains("glob") && !m.value("glob", "").empty();
	// ripgrep -g semantics: a slash-free glob matches the basename at any
	// depth ("*.log" hits a/b/c.log); a slashed pattern matches the relpath
	bool file_glob_basename = has_file_filter && m.value("glob", "").find('/') == std::string::npos;
	if (has_file_filter) {
		try { file_re = glob_regex(m.value("glob", "")); }
		catch (const std::regex_error& e) { return {{"ok", false}, {"error", std::string("bad glob: ") + e.what()}, {"tookUs", us_since(t0)}}; }
	}

	json matches = json::array();
	size_t scanned = 0;
	std::vector<fs::path> files;
	std::error_code ec;
	if (fs::is_regular_file(root, ec)) {
		files.push_back(root);
		root = root.parent_path();
	} else {
		fs::recursive_directory_iterator it(root, fs::directory_options::skip_permission_denied, ec), end;
		if (ec) return {{"ok", false}, {"error", "cannot walk " + root.string() + ": " + ec.message()}, {"tookUs", us_since(t0)}};
		for (; it != end && files.size() < 200000; it.increment(ec)) {
			if (ec) { ec.clear(); continue; }
			if (it->is_regular_file(ec)) files.push_back(it->path());
		}
	}

	std::string buf;
	buf.reserve(1 << 16);
	for (const fs::path& f : files) {
		if (matches.size() >= maxr) break;
		std::string rel = rel_of(f, root);
		if (has_file_filter) {
			std::string fname;
			const std::string& tgt = file_glob_basename ? (fname = f.filename().string()) : rel;
			if (!std::regex_match(tgt, file_re)) continue;
		}
		rigfs_stat_t st {};
		if (rigfs_stat(f, &st) != 0 || uint64_t(st.st_size) > maxfb) continue;
		int fd = rigfs_open(f, O_RDONLY);
		if (fd < 0) continue;
		scanned++;
		// read whole file (≤maxFileBytes); line-split in memory
		buf.resize(size_t(st.st_size));
		size_t got = 0;
		while (got < buf.size()) {
			ssize_t n = rigfs_read(fd, buf.data() + got, buf.size() - got);
			if (n <= 0) break;
			got += size_t(n);
		}
		rigfs_close(fd);
		buf.resize(got);
		if (looks_binary(buf.data(), std::min<size_t>(got, 512))) continue;

		size_t pos = 0;
		uint64_t lineno = 0;
		size_t file_match_start = matches.size(); // after-context only feeds this file's hits
		std::vector<std::string> ctx_before;
		while (pos <= got && matches.size() < maxr) {
			size_t nl = buf.find('\n', pos);
			size_t len = (nl == std::string::npos) ? got - pos : nl - pos;
			std::string_view line(buf.data() + pos, len);
			if (!line.empty() && line.back() == '\r') line = line.substr(0, line.size() - 1);
			lineno++;
			pos = (nl == std::string::npos) ? got + 1 : nl + 1;
			std::string text(line.substr(0, 400));

			// feed open after-context windows from earlier hits on this file
			for (size_t mi = file_match_start; mi < matches.size(); mi++)
				if (matches[mi].contains("_ctx_remain") && matches[mi]["_ctx_remain"].get<int>() > 0) {
					matches[mi]["context"].push_back({{"line", lineno}, {"text", text}, {"match", false}});
					matches[mi]["_ctx_remain"] = matches[mi]["_ctx_remain"].get<int>() - 1;
				}

			size_t col = std::string::npos;
			if (use_regex) {
				std::match_results<std::string_view::const_iterator> mm;
				if (std::regex_search(line.begin(), line.end(), mm, re)) col = size_t(mm.position());
			} else if (icase) {
				std::string lower(line);
				for (char& ch : lower) ch = char(std::tolower(unsigned(ch)));
				col = lower.find(needle);
			} else {
				col = line.find(needle);
			}
			if (col != std::string::npos) {
				json hit_j = {{"path", rel}, {"line", lineno}, {"col", col + 1}, {"text", text}};
				if (want_ctx) {
					json ctx = json::array();
					for (size_t k = 0; k < ctx_before.size(); k++)
						ctx.push_back({{"line", lineno - ctx_before.size() + k}, {"text", ctx_before[k]}, {"match", false}});
					hit_j["context"] = ctx;
					hit_j["_ctx_remain"] = want_ctx;
				}
				matches.push_back(hit_j);
			}
			if (want_ctx) {
				ctx_before.push_back(text);
				if (ctx_before.size() > size_t(want_ctx)) ctx_before.erase(ctx_before.begin());
			}
		}
	}
	for (auto& jt : matches) jt.erase("_ctx_remain");
	return {{"ok", true}, {"matches", matches}, {"count", matches.size()},
	        {"scannedFiles", scanned}, {"tookUs", us_since(t0)}};
}

// ---------------------------------------------------------------------------
// rig.fs.list {path?, cwd?, showHidden?, maxEntries?}
//   directory listing for the app's folder browser
//   → {path, entries:[{name, type:"dir|file|link|other", size, mtimeMs}], truncated, tookUs}
// ---------------------------------------------------------------------------
static json op_list(const json& m) {
	auto t0 = clk::now();
	fs::path p = resolve(m.value("path", ""), m.value("cwd", ""));
	bool hidden = m.value("showHidden", false);
	size_t maxn = std::min<size_t>(m.value("maxEntries", size_t(2000)), 20000);
	std::error_code ec;
	if (!fs::is_directory(p, ec))
		return {{"ok", false}, {"error", ec ? ec.message() : "not a directory"}, {"path", p.string()}, {"tookUs", us_since(t0)}};
	json entries = json::array();
	size_t count = 0;
	bool truncated = false;
	for (const auto& de : fs::directory_iterator(p, fs::directory_options::skip_permission_denied, ec)) {
		if (ec) break;
		std::string name = de.path().filename().string();
		if (!hidden && !name.empty() && name[0] == '.') continue;
		if (count >= maxn) { truncated = true; break; }
		std::string type = "other";
		std::error_code sec;
		if (de.is_symlink(sec)) type = "link";
		else if (de.is_directory(sec)) type = "dir";
		else if (de.is_regular_file(sec)) type = "file";
		uint64_t size = 0;
		int64_t mt = 0;
		rigfs_stat_t st {};
		if (rigfs_stat(de.path(), &st) == 0) { size = uint64_t(st.st_size); mt = mtime_ms(st); }
		entries.push_back({{"name", name}, {"type", type}, {"size", size}, {"mtimeMs", mt}});
		count++;
	}
	std::sort(entries.begin(), entries.end(), [](const json& a, const json& b) {
		bool ad = a.value("type", "") == "dir", bd = b.value("type", "") == "dir";
		if (ad != bd) return ad;
		return a.value("name", "") < b.value("name", "");
	});
	return {{"ok", true}, {"path", p.string()}, {"entries", entries},
	        {"truncated", truncated}, {"tookUs", us_since(t0)}};
}

// rig.fs.mkdir {path, cwd?} → {path, created, tookUs}
static json op_mkdir(const json& m) {
	auto t0 = clk::now();
	fs::path p = resolve(m.value("path", ""), m.value("cwd", ""));
	std::error_code ec;
	bool made = fs::create_directories(p, ec);
	if (ec) return {{"ok", false}, {"error", ec.message()}, {"path", p.string()}, {"tookUs", us_since(t0)}};
	return {{"ok", true}, {"path", p.string()}, {"created", made}, {"tookUs", us_since(t0)}};
}

// rig.fs.stat {path, cwd?} → {exists, type, size, mtimeMs, tookUs}
static json op_stat(const json& m) {
	auto t0 = clk::now();
	fs::path p = resolve(m.value("path", ""), m.value("cwd", ""));
	rigfs_stat_t st {};
	if (rigfs_stat(p, &st) != 0)
		return {{"ok", true}, {"path", p.string()}, {"exists", false}, {"tookUs", us_since(t0)}};
	std::error_code ec;
	std::string kind = "other";
	if (fs::is_symlink(fs::symlink_status(p, ec))) kind = "link";
	else if (rigfs_is_dir(st)) kind = "dir";
	else if (rigfs_is_reg(st)) kind = "file";
	return {{"ok", true}, {"path", p.string()}, {"exists", true}, {"kind", kind},
	        {"size", uint64_t(st.st_size)}, {"mtimeMs", mtime_ms(st)}, {"tookUs", us_since(t0)}};
}

} // namespace rigfs
