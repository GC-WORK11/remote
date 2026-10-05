// remote — crypto primitives for the omprd daemon.
// Public-domain style implementations: SHA-1 (RFC 3174, WS handshake only),
// SHA-256 (FIPS 180-4), HMAC-SHA256 (RFC 2104), base64 (RFC 4648).
#pragma once

#if defined(_WIN32)
#define _CRT_RAND_S // exposes rand_s in <stdlib.h>
#endif

#include <array>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

#if defined(__linux__) || defined(__ANDROID__)
#include <sys/random.h>
#endif

namespace rig {

using Bytes = std::vector<uint8_t>;

inline std::string to_hex(const Bytes& in) {
	static const char* d = "0123456789abcdef";
	std::string out;
	out.reserve(in.size() * 2);
	for (uint8_t b : in) { out.push_back(d[b >> 4]); out.push_back(d[b & 0xf]); }
	return out;
}

namespace detail {

inline uint32_t rol32(uint32_t v, int s) { return (v << s) | (v >> (32 - s)); }

struct Sha1 {
	uint32_t h[5]{0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
	uint8_t buf[64]{};
	size_t len{};
	uint64_t total{};

	static void block(uint32_t* h, const uint8_t* p) {
		uint32_t w[80];
		for (int i = 0; i < 16; i++)
			w[i] = (uint32_t(p[i * 4]) << 24) | (uint32_t(p[i * 4 + 1]) << 16) |
			       (uint32_t(p[i * 4 + 2]) << 8) | uint32_t(p[i * 4 + 3]);
		for (int i = 16; i < 80; i++) w[i] = rol32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
		uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
		for (int i = 0; i < 80; i++) {
			uint32_t f, k;
			if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
			else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
			else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
			else { f = b ^ c ^ d; k = 0xCA62C1D6; }
			uint32_t t = rol32(a, 5) + f + e + k + w[i];
			e = d; d = c; c = rol32(b, 30); b = a; a = t;
		}
		h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
	}

	void update(const uint8_t* p, size_t n) {
		total += n;
		while (n) {
			size_t take = std::min(n, sizeof(buf) - len);
			std::memcpy(buf + len, p, take);
			len += take; p += take; n -= take;
			if (len == sizeof(buf)) { block(h, buf); len = 0; }
		}
	}

	Bytes finish() {
		uint64_t bits = total * 8;
		uint8_t pad = 0x80;
		update(&pad, 1);
		uint8_t z = 0;
		while (len != 56) update(&z, 1);
		uint8_t lenb[8];
		for (int i = 0; i < 8; i++) lenb[i] = uint8_t(bits >> (56 - 8 * i));
		update(lenb, 8);
		Bytes out(20);
		for (int i = 0; i < 5; i++) {
			out[i * 4] = uint8_t(h[i] >> 24); out[i * 4 + 1] = uint8_t(h[i] >> 16);
			out[i * 4 + 2] = uint8_t(h[i] >> 8); out[i * 4 + 3] = uint8_t(h[i]);
		}
		return out;
	}
};

struct Sha256 {
	uint32_t h[8]{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
	              0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
	uint8_t buf[64]{};
	size_t len{};
	uint64_t total{};

	static void block(uint32_t* h, const uint8_t* p) {
		static const uint32_t K[64] = {
			0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
			0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
			0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
			0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
			0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
			0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
			0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
			0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
		uint32_t w[64];
		for (int i = 0; i < 16; i++)
			w[i] = (uint32_t(p[i * 4]) << 24) | (uint32_t(p[i * 4 + 1]) << 16) |
			       (uint32_t(p[i * 4 + 2]) << 8) | uint32_t(p[i * 4 + 3]);
		for (int i = 16; i < 64; i++) {
			uint32_t s0 = rol32(w[i - 15], 7) ^ rol32(w[i - 15], 18) ^ (w[i - 15] >> 3);
			uint32_t s1 = rol32(w[i - 2], 17) ^ rol32(w[i - 2], 19) ^ (w[i - 2] >> 10);
			w[i] = w[i - 16] + s0 + w[i - 7] + s1;
		}
		uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
		for (int i = 0; i < 64; i++) {
			uint32_t S1 = rol32(e, 6) ^ rol32(e, 11) ^ rol32(e, 25);
			uint32_t ch = (e & f) ^ ((~e) & g);
			uint32_t t1 = hh + S1 + ch + K[i] + w[i];
			uint32_t S0 = rol32(a, 2) ^ rol32(a, 13) ^ rol32(a, 22);
			uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
			uint32_t t2 = S0 + maj;
			hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
		}
		h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
	}

	void update(const uint8_t* p, size_t n) {
		total += n;
		while (n) {
			size_t take = std::min(n, sizeof(buf) - len);
			std::memcpy(buf + len, p, take);
			len += take; p += take; n -= take;
			if (len == sizeof(buf)) { block(h, buf); len = 0; }
		}
	}

	Bytes finish() {
		uint64_t bits = total * 8;
		uint8_t pad = 0x80;
		update(&pad, 1);
		uint8_t z = 0;
		while (len != 56) update(&z, 1);
		uint8_t lenb[8];
		for (int i = 0; i < 8; i++) lenb[i] = uint8_t(bits >> (56 - 8 * i));
		update(lenb, 8);
		Bytes out(32);
		for (int i = 0; i < 8; i++) {
			out[i * 4] = uint8_t(h[i] >> 24); out[i * 4 + 1] = uint8_t(h[i] >> 16);
			out[i * 4 + 2] = uint8_t(h[i] >> 8); out[i * 4 + 3] = uint8_t(h[i]);
		}
		return out;
	}
};

} // namespace detail

inline Bytes sha1(const Bytes& in) {
	detail::Sha1 s; s.update(in.data(), in.size()); return s.finish();
}

inline Bytes sha256(const Bytes& in) {
	detail::Sha256 s; s.update(in.data(), in.size()); return s.finish();
}

inline Bytes hmac_sha256(const Bytes& key, const Bytes& msg) {
	Bytes k(64, 0);
	if (key.size() > 64) k = sha256(key);
	else std::memcpy(k.data(), key.data(), key.size());
	Bytes ipad(64), opad(64);
	for (int i = 0; i < 64; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
	ipad.insert(ipad.end(), msg.begin(), msg.end());
	Bytes inner = sha256(ipad);
	opad.insert(opad.end(), inner.begin(), inner.end());
	return sha256(opad);
}

inline std::string base64_encode(const Bytes& in) {
	static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	std::string out;
	out.reserve((in.size() + 2) / 3 * 4);
	for (size_t i = 0; i < in.size(); i += 3) {
		uint32_t v = uint32_t(in[i]) << 16;
		if (i + 1 < in.size()) v |= uint32_t(in[i + 1]) << 8;
		if (i + 2 < in.size()) v |= uint32_t(in[i + 2]);
		out.push_back(t[(v >> 18) & 63]); out.push_back(t[(v >> 12) & 63]);
		out.push_back(i + 1 < in.size() ? t[(v >> 6) & 63] : '=');
		out.push_back(i + 2 < in.size() ? t[v & 63] : '=');
	}
	return out;
}

/// Cryptographically-random bytes from the OS.
inline Bytes random_bytes(size_t n) {
	Bytes out(n);
#if defined(_WIN32)
	for (uint8_t& b : out) {
		unsigned int v = 0;
		if (rand_s(&v) != 0) throw std::runtime_error("rand_s failed");
		b = uint8_t(v);
	}
#elif defined(__linux__) || defined(__ANDROID__)
	// getrandom(2) takes no fd — the old /dev/urandom ifstream could not open
	// under fd pressure (sessions + ptys + spares) and its throw tore the
	// whole daemon down mid-request.
	size_t done = 0;
	while (done < n) {
		ssize_t r = ::getrandom(out.data() + done, n - done, 0);
		if (r < 0) {
			if (errno == EINTR) continue;
			throw std::runtime_error("getrandom failed");
		}
		done += size_t(r);
	}
#else
	std::ifstream ur("/dev/urandom", std::ios::binary);
	ur.read(reinterpret_cast<char*>(out.data()), std::streamsize(n));
	if (!ur) throw std::runtime_error("cannot read /dev/urandom");
#endif
	return out;
}

inline std::string random_hex(size_t n_bytes) { return to_hex(random_bytes(n_bytes)); }

} // namespace rig
