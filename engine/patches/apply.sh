#!/bin/sh
# Apply our patch stack onto the vendored upstream clone at engine/omp/.
# engine/omp is gitignored (a depth-1 clone of can1357/oh-my-pi); anything we
# change inside it lives here as git patches so a fresh clone is one command
# away from the full fork state.
#
#   git clone --depth 1 https://github.com/can1357/oh-my-pi engine/omp
#   sh engine/patches/apply.sh
#
# To add a change: edit files inside engine/omp, `git -C engine/omp add -N`
# any NEW files, then regenerate:
#   git -C engine/omp diff -- <paths> > engine/patches/00N-name.patch
# (git -C engine/omp reset afterwards clears the intent-to-add entries.)
set -e
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OMP="$HERE/../omp"
if [ ! -d "$OMP/.git" ]; then
	echo "error: $OMP is not a git checkout — clone oh-my-pi there first" >&2
	exit 1
fi
n=0
for p in "$HERE"/*.patch; do
	[ -e "$p" ] || continue
	git -C "$OMP" apply "$p"
	n=$((n + 1))
done
echo "applied $n patch(es) to engine/omp"
