#!/bin/sh
# Run the slim omp fork (engine/omp) from source. Point omprd's --omp-bin at
# this to drive the fork instead of the npm-installed omp.
#
#   ./daemon/omprd --omp-bin tools/omp-fork.sh
#
# Overrides: OMP_FORK_DIR (repo-local fork checkout), BUN (bun binary).
HERE="$(cd "$(dirname "$0")" && pwd)"
FORK="${OMP_FORK_DIR:-$HERE/../../engine/omp}"
# No --cwd here: bun --cwd would pin the process to packages/coding-agent and
# the agent's tools would run there instead of the session cwd omprd spawned
# us in. Absolute entry resolves the workspace fine from any directory.
exec "${BUN:-bun}" "$FORK/packages/coding-agent/src/cli.ts" "$@"
