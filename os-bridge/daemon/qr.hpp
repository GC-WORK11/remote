// remote — terminal QR encoder for `omprd --qr` / `omprd pair`.
// Public-domain style implementation: byte mode, EC level L, mask 0,
// versions 1-10 — spec-legal, every scanner decodes it. Zero deps.
// Ported from cli/ompr's vendored _qr_ascii (same algorithm, same output).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace rig {

namespace qrd {

// v1-10, EC level L
static const int kTot[10] = {26, 44, 70, 100, 134, 172, 196, 242, 292, 346}; // total codewords
static const int kEcb[10] = {7, 10, 15, 20, 26, 18, 20, 24, 30, 18};         // EC codewords/block
static const int kBlk[10] = {1, 1, 1, 1, 1, 2, 2, 2, 2, 4};                 // EC blocks
static const int kAli[10][3] = {{0, 0, 0},   {6, 18, 0},  {6, 22, 0},  {6, 26, 0}, {6, 30, 0},
                                {6, 34, 0},  {6, 22, 38}, {6, 24, 42}, {6, 26, 46}, {6, 28, 50}};

struct Gf {
	uint8_t exp[512]{};
	uint8_t log[256]{};
	Gf() {
		int x = 1;
		for (int i = 0; i < 255; i++) {
			exp[i] = uint8_t(x);
			log[x] = uint8_t(i);
			x <<= 1;
			if (x & 0x100) x ^= 0x11D;
		}
		for (int i = 255; i < 512; i++) exp[i] = exp[i - 255];
	}
	uint8_t mul(uint8_t a, uint8_t b) const {
		return (a == 0 || b == 0) ? 0 : exp[log[a] + log[b]];
	}
};

static std::vector<uint8_t> rs_gen(const Gf& gf, int deg) {
	std::vector<uint8_t> poly{1};
	for (int i = 0; i < deg; i++) {
		std::vector<uint8_t> nxt(poly.size() + 1, 0);
		for (size_t j = 0; j < poly.size(); j++) {
			nxt[j] ^= gf.mul(poly[j], gf.exp[i]);
			nxt[j + 1] ^= poly[j];
		}
		poly = nxt;
	}
	return poly;
}

// gen is ascending-degree (x^0 first, leading x^deg=1 last); the shift
// register is descending-degree, so feed gen reversed without its lead.
static std::vector<uint8_t> rs_rem(const Gf& gf, const std::vector<uint8_t>& data,
                                   const std::vector<uint8_t>& gen) {
	std::vector<uint8_t> div(gen.rbegin() + 1, gen.rend());
	std::vector<uint8_t> rem(gen.size() - 1, 0);
	for (uint8_t b : data) {
		uint8_t f = b ^ rem.front();
		rem.erase(rem.begin());
		rem.push_back(0);
		for (size_t j = 0; j < rem.size(); j++) rem[j] ^= gf.mul(div[j], f);
	}
	return rem;
}

} // namespace qrd

/// UTF-8 QR module matrix for `text` — [row][col], 1 = dark, 0 = light.
/// Returns {} when the payload exceeds version 10-L capacity (~2718 bits).
/// The renderers (ASCII terminal, PNG) draw from this one matrix.
inline std::vector<std::vector<int8_t>> qr_matrix(const std::string& text) {
	static const qrd::Gf gf;
	std::string data = text; // QR byte mode is octets — UTF-8 is fine

	int vi = -1;
	for (int i = 0; i < 10; i++) {
		int datacw = qrd::kTot[i] - qrd::kEcb[i] * qrd::kBlk[i];
		int ccbits = (i + 1 >= 10) ? 16 : 8; // byte-mode count field widens at v10
		if (4 + ccbits + 8 * int(data.size()) <= datacw * 8) { vi = i; break; }
	}
	if (vi < 0) return {};
	const int ver = vi + 1;
	const int size = 17 + 4 * ver;
	const int datacw = qrd::kTot[vi] - qrd::kEcb[vi] * qrd::kBlk[vi];

	// bit buffer: mode 0100, 8-bit count, data, terminator, pad EC 11
	std::vector<int> bits;
	bits.reserve(datacw * 8);
	auto put = [&bits](uint32_t val, int n) {
		for (int k = n - 1; k >= 0; k--) bits.push_back(int((val >> k) & 1));
	};
	put(0b0100, 4);
	put(uint32_t(data.size()), ver >= 10 ? 16 : 8);
	for (uint8_t b : data) put(b, 8);
	int term = datacw * 8 - int(bits.size());
	put(0, term < 4 ? term : 4);
	while (bits.size() % 8) bits.push_back(0);
	int pad = 0xEC;
	while (int(bits.size()) < datacw * 8) { put(uint32_t(pad), 8); pad ^= 0xEC ^ 0x11; }
	std::vector<uint8_t> codewords(bits.size() / 8);
	for (size_t i = 0; i < bits.size(); i += 8) {
		uint8_t w = 0;
		for (int k = 0; k < 8; k++) w |= uint8_t(bits[i + k] << (7 - k));
		codewords[i / 8] = w;
	}

	// split into blocks, append RS EC, interleave
	const int nb = qrd::kBlk[vi], epb = qrd::kEcb[vi];
	const int short_len = datacw / nb, nlong = datacw % nb;
	std::vector<std::vector<uint8_t>> blocks;
	size_t pos = 0;
	for (int b = 0; b < nb; b++) {
		int ln = short_len + (b >= nb - nlong ? 1 : 0);
		blocks.emplace_back(codewords.begin() + pos, codewords.begin() + pos + ln);
		pos += size_t(ln);
	}
	std::vector<uint8_t> gen = qrd::rs_gen(gf, epb);
	std::vector<std::vector<uint8_t>> ecs;
	for (auto& blk : blocks) ecs.push_back(qrd::rs_rem(gf, blk, gen));
	std::vector<uint8_t> inter;
	size_t maxd = 0;
	for (auto& b : blocks) maxd = std::max(maxd, b.size());
	for (size_t i = 0; i < maxd; i++)
		for (auto& blk : blocks)
			if (i < blk.size()) inter.push_back(blk[i]);
	for (int i = 0; i < epb; i++)
		for (auto& ec : ecs) inter.push_back(ec[i]);

	// matrix: -1 unset, 0/1 data; func[] marks format/finder/timing modules
	std::vector<std::vector<int8_t>> m(size, std::vector<int8_t>(size, -1));
	std::vector<std::vector<uint8_t>> func(size, std::vector<uint8_t>(size, 0));
	auto set_f = [&](int r, int c, bool dark) {
		if (r >= 0 && r < size && c >= 0 && c < size) { m[r][c] = dark ? 1 : 0; func[r][c] = 1; }
	};
	auto finder = [&](int r, int c) {
		for (int dr = -1; dr < 8; dr++)
			for (int dc = -1; dc < 8; dc++) {
				bool dark = (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
				             (dr == 0 || dr == 6 || dc == 0 || dc == 6 ||
				              (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)));
				set_f(r + dr, c + dc, dark);
			}
	};
	finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
	for (int i = 8; i < size - 8; i++) { set_f(6, i, i % 2 == 0); set_f(i, 6, i % 2 == 0); }
	const int* ali = qrd::kAli[vi];
	int nal = 0;
	while (nal < 3 && ali[nal]) nal++;
	for (int i = 0; i < nal; i++)
		for (int j = 0; j < nal; j++) {
			if ((i == 0 && j == 0) || (i == 0 && j == nal - 1) || (i == nal - 1 && j == 0)) continue;
			int ar = ali[i], ac = ali[j];
			for (int dr = -2; dr <= 2; dr++)
				for (int dc = -2; dc <= 2; dc++)
					set_f(ar + dr, ac + dc, std::max(dr < 0 ? -dr : dr, dc < 0 ? -dc : dc) != 1);
		}
	for (int i = 0; i < 9; i++)
		if (i != 6) { set_f(8, i, false); set_f(i, 8, false); }
	for (int i = 0; i < 8; i++) { set_f(8, size - 1 - i, false); set_f(size - 1 - i, 8, false); }
	set_f(size - 8, 8, true); // dark module
	if (ver >= 7)
		for (int i = 0; i < 18; i++) {
			set_f(i / 3, size - 11 + i % 3, false);
			set_f(size - 11 + i % 3, i / 3, false);
		}

	// zigzag data
	int i = 0, r = size - 1, c = size - 1;
	bool up = true;
	while (c > 0) {
		if (c == 6) c--;
		for (int k = 0; k < size; k++) {
			for (int dc = 0; dc < 2; dc++) {
				int cc = c - dc;
				if (!func[r][cc]) {
					m[r][cc] = (i < int(inter.size()) * 8) ? int8_t((inter[i >> 3] >> (7 - (i & 7))) & 1) : 0;
					i++;
				}
			}
			r += up ? -1 : 1;
		}
		r += up ? 1 : -1;
		up = !up;
		c -= 2;
	}

	// mask 0: (r+c)%2==0 on non-function modules
	for (int rr = 0; rr < size; rr++)
		for (int cc = 0; cc < size; cc++)
			if (!func[rr][cc] && (rr + cc) % 2 == 0) m[rr][cc] ^= 1;

	// format info: level L (01) + mask 0 → data 0b01000; BCH + 0x5412
	int d = 0b01000, rem = d;
	for (int k = 0; k < 10; k++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
	int fbits = ((d << 10) | rem) ^ 0x5412;
	for (int k = 0; k < 6; k++) set_f(k, 8, (fbits >> k) & 1);
	set_f(7, 8, (fbits >> 6) & 1);
	set_f(8, 8, (fbits >> 7) & 1);
	set_f(8, 7, (fbits >> 8) & 1);
	for (int k = 9; k < 15; k++) set_f(8, 14 - k, (fbits >> k) & 1);
	for (int k = 0; k < 8; k++) set_f(8, size - 1 - k, (fbits >> k) & 1);
	for (int k = 8; k < 15; k++) set_f(size - 15 + k, 8, (fbits >> k) & 1);
	if (ver >= 7) {
		rem = ver;
		for (int k = 0; k < 12; k++) rem = (rem << 1) ^ (((rem >> 11) & 1) * 0x1F25);
		int vbits = (ver << 12) | rem;
		for (int k = 0; k < 18; k++) {
			bool bit = (vbits >> k) & 1;
			set_f(k / 3, size - 11 + k % 3, bit);
			set_f(size - 11 + k % 3, k / 3, bit);
		}
	}

	return m;
}

/// UTF-8 QR for `text` rendered as ██/space rows with a 1-module quiet zone.
/// Returns "" when the payload exceeds version 10-L capacity (~2718 bits).
inline std::string qr_ascii(const std::string& text) {
	auto m = qr_matrix(text);
	if (m.empty()) return "";
	const int size = int(m.size());
	std::string out;
	out.reserve(size_t(size + 2) * (size + 2) * 6);
	for (int rr = -1; rr < size + 1; rr++) {
		for (int cc = -1; cc < size + 1; cc++)
			out += (rr >= 0 && rr < size && cc >= 0 && cc < size && m[rr][cc]) ? "██" : "  ";
		out += '\n';
	}
	return out;
}

} // namespace rig
