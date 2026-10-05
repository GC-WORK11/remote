#!/usr/bin/env bash
# One-command bundle build: compiles omprd, compiles omp to a single binary,
# fetches prebuilt natives, and emits dist/Remote-Setup.run.
#
#   installer/build.sh            # full build
#   installer/build.sh --payload-only
#
# Deps: bash, g++ (build-essential), curl, bun >= 1.1, tar, sed/awk.
# bun install:  curl -fsSL https://bun.sh/install | bash
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(git -C .. rev-parse --show-toplevel 2>/dev/null || echo "$PWD/../..")
OMPDIR="$ROOT/engine/omp"
PAY=payload
DIST=dist
RUN="$DIST/Remote-Setup.run"
# The native cache dir is ~/.omp/natives/<packages/natives version> — derive it
# from the tree, never hardcode (a stale constant lands addons in a dir the
# loader never reads).
NOMP_VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$OMPDIR/packages/natives/package.json" | head -1)
[ -n "$NOMP_VER" ] || NOMP_VER=0.0.0
OMP_SRC="packages/coding-agent/src/cli.ts"

say() { printf '  \033[1m%s\033[0m\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ -d "$OMPDIR" ] || die "omp fork not found at $OMPDIR (clone + apply patches first)"
have g++   || die "g++ missing: apt install build-essential"
have bun   || { have "$HOME/.bun/bin/bun" && export PATH="$HOME/.bun/bin:$PATH"; } || die "bun missing: curl -fsSL https://bun.sh/install | bash"
have tar   || die "tar missing"
have curl  || die "curl missing"

if [ "${1:-}" = "--payload-only" ]; then
  [ -d "$PAY/bin" ] || die "no payload/ — run a full build first"
else
rm -rf "$PAY"; mkdir -p "$PAY/bin" "$PAY/natives" "$PAY/share" "$DIST"

say "1/5 omprd (dynamic + static fallback)"
g++ -O2 -std=c++20 -Wall -Wextra -pthread -o "$PAY/bin/omprd" "$ROOT/os-bridge/daemon/omprd.cpp" -lutil
g++ -O2 -std=c++20 -pthread -static -o "$PAY/bin/omprd.static" "$ROOT/os-bridge/daemon/omprd.cpp" -lutil 2>/dev/null || rm -f "$PAY/bin/omprd.static"
strip "$PAY/bin/omprd" "$PAY/bin/omprd.static" 2>/dev/null || true

say "2/5 omp workspace deps"
(cd "$OMPDIR" && bun install --silent 2>/dev/null || bun install)

say "3/5 omp -> single binary"
# compileCodingAgent supplies the omp-legacy-pi-modules VIRTUAL module via an
# in-memory plugin — raw `bun build --compile` cannot resolve it, and passing
# --external leaves a dangling require that crashes at runtime when legacy
# paths execute. The fork's own build-binary.ts is the supported path.
PAYABS=$(cd "$PAY" && pwd)
(cd "$OMPDIR/packages/coding-agent" && CROSS_TARGET=linux-x64 bun scripts/build-binary.ts)
cp "$OMPDIR/packages/coding-agent/dist/omp-linux-x64" "$PAYABS/bin/omp"

# ompr CLI + phone-approval guard hook ride the payload too.
cp "$ROOT/os-bridge/cli/ompr" "$PAYABS/bin/ompr" 2>/dev/null || true
mkdir -p "$PAYABS/agent-hooks/pre"
cp "$ROOT/os-bridge/agent-hooks/pre/guard.ts" "$PAYABS/agent-hooks/pre/" 2>/dev/null || true

say "4/5 prebuilt natives (npm @oh-my-pi/pi-natives-linux-x64)"
# Fetch the tarball straight from the registry — npm/bun hard-refuse a
# linux-x64 package on a darwin-arm64 host, which used to fail silently.
NATDIR=$(mktemp -d)
curl -fsSL "https://registry.npmjs.org/@oh-my-pi/pi-natives-linux-x64/-/pi-natives-linux-x64-$NOMP_VER.tgz" -o "$NATDIR/pkg.tgz" \
  || die "natives $NOMP_VER not on npm — check packages/natives/package.json"
mkdir -p "$NATDIR/pkg"
tar -xzf "$NATDIR/pkg.tgz" -C "$NATDIR/pkg"
cp "$NATDIR"/pkg/package/*.node "$PAY/natives/"
rm -rf "$NATDIR"
[ -s "$PAY/natives/pi_natives.linux-x64-modern.node" ] || die "modern natives missing"
# the launcher stages addons under ~/.omp/natives/<this version>
printf '%s\n' "$NOMP_VER" > "$PAY/natives/.version"
fi

say "5/5 archive"
cp src/launcher.sh src/install-root.sh "$PAY/"
cp src/pair.html src/omprd-user.service src/omprd@.service src/remote.desktop src/uninstall.sh "$PAY/share/"
chmod +x "$PAY/launcher.sh" "$PAY/install-root.sh" "$PAY/bin/"*
tar -cz -C "$PAY" -f "$DIST/payload.tar.gz" .
cat src/stub.sh "$DIST/payload.tar.gz" > "$RUN"
chmod +x "$RUN"
rm -f "$DIST/payload.tar.gz"

SIZE=$(du -h "$RUN" | cut -f1)
say "done: $RUN ($SIZE)"
