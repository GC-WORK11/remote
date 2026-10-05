#!/bin/sh
# Remote-Setup.run — self-extracting installer.
# Double-click it in a file manager (Run / Run in Terminal) or:
#     sh Remote-Setup.run [--no-system] [--headless]
# Everything below __PAYLOAD__ is a gzipped tar: bin/ natives/ share/ launcher.
set -u
PAYLOAD_LINE=$(awk '/^__PAYLOAD__$/ {print NR + 1; exit 0}' "$0")
TMP=$(mktemp -d "${TMPDIR:-/tmp}/remote.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT
tail -n +"$PAYLOAD_LINE" "$0" | tar -xz -C "$TMP" 2>/dev/null || {
  echo "remote: corrupt archive" >&2; exit 1; }
chmod +x "$TMP/launcher.sh" "$TMP/install-root.sh" 2>/dev/null
"$TMP/launcher.sh" "$@"
RC=$?
exit $RC
__PAYLOAD__
