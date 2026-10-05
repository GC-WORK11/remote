#!/bin/sh
# remote uninstall — stop the daemon, remove payload, units, drop-ins.
# The admin parts need root: run `pkexec <this> --root-bits <user>` via sudo,
# or run the whole script as the user and pass --system with sudo yourself.
set -eu

USER_HOME="${REMOTE_HOME:-$HOME}"
PREFIX="${REMOTE_PREFIX:-$USER_HOME/.local/share/remote}"
RIG_DIR="${RIG_DIR:-$USER_HOME/.rig}"
TUSER="${REMOTE_USER:-$(id -un)}"

say() { printf '%s\n' "$*"; }

if [ "${1:-}" = "--root-bits" ]; then
  # runs as root: remove the system-level pieces only
  TUSER="${2:?--root-bits <user>}"
  systemctl disable --now "omprd@$TUSER" 2>/dev/null || true
  systemctl disable --now omprd-lid-inhibit 2>/dev/null || true
  rm -f /etc/systemd/system/omprd@.service
  rm -f /etc/systemd/system/omprd-lid-inhibit.service
  rm -f "/etc/systemd/system/multi-user.target.wants/omprd@$TUSER.service"
  rm -f "/etc/systemd/system/multi-user.target.wants/omprd-lid-inhibit.service"
  rm -f /etc/sudoers.d/omprd-lid
  rm -f /etc/systemd/logind.conf.d/90-omprd-lid.conf
  rm -f /etc/NetworkManager/conf.d/90-omprd-wifi-powersave.conf
  systemctl daemon-reload 2>/dev/null || true
  systemctl try-restart systemd-logind 2>/dev/null || true
  systemctl try-restart NetworkManager 2>/dev/null || true
  rm -rf /opt/remote
  rm -f /usr/local/bin/omprd
  say "removed system service + drop-ins for $TUSER"
  exit 0
fi

say "stopping omprd…"
systemctl --user disable --now omprd 2>/dev/null || true
systemctl stop "omprd@$TUSER" 2>/dev/null || true
if command -v sudo >/dev/null 2>&1; then
  sudo systemctl disable --now "omprd@$TUSER" 2>/dev/null || true
  sudo systemctl daemon-reload 2>/dev/null || true
fi
[ -f "$RIG_DIR/omprd.pid" ] && kill "$(cat "$RIG_DIR/omprd.pid")" 2>/dev/null || true
pkill -x omprd 2>/dev/null || true

rm -rf "$PREFIX"
rm -f "$USER_HOME/.local/bin/ompr"
rm -f "$USER_HOME/.local/share/applications/remote.desktop"
rm -f "$USER_HOME/.config/systemd/user/omprd.service"
systemctl --user daemon-reload 2>/dev/null || true
rm -f "$USER_HOME/.omp/agent/hooks/pre/guard.ts"

say "removed user install ($PREFIX)"
say "kept: $RIG_DIR (sessions, tokens) — delete manually if you want it gone"
say "for the system-service + lid drop-ins, run: pkexec '$0' --root-bits $TUSER"
