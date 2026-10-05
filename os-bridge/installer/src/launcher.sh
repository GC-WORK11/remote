#!/bin/sh
# remote launcher — install omprd, start it, show the pairing QR.
# Runs unprivileged; escalates via pkexec (GUI) or sudo only for the optional
# system-wide install. Usage: launcher.sh [--no-system] [--port N] [--headless]
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREFIX="${REMOTE_PREFIX:-$HOME/.local/share/remote}"
RIG_DIR="${RIG_DIR:-$HOME/.rig}"
LOG="$RIG_DIR/installer.log"
PORT="${REMOTE_PORT:-8790}"
WANT_SYSTEM=1
FORCE_HEADLESS=0
for a in "$@"; do
  case "$a" in
    --no-system) WANT_SYSTEM=0 ;;
    --headless)  FORCE_HEADLESS=1 ;;
    --port)      shift_next=port ;;
    --port=*)    PORT="${a#--port=}" ;;
  esac
done

mkdir -p "$RIG_DIR" "$PREFIX/bin" "$PREFIX/share"
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
have() { command -v "$1" >/dev/null 2>&1; }

DESKTOP=0
if [ "$FORCE_HEADLESS" = 0 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}${MIR_SOCKET:-}" ]; then
  DESKTOP=1
fi

notify() { # best-effort desktop notification
  [ "$DESKTOP" = 1 ] && have notify-send && notify-send "Pocket Rig" "$1" 2>/dev/null || true
  log "$1"
}

# ---------------------------------------------------------------- install ---
# User-mode payload install — always, no privilege needed.
install_user() {
  log "installing payload -> $PREFIX"
  cp -u "$HERE/bin/omprd" "$PREFIX/bin/omprd" || return 1
  cp -u "$HERE/bin/omp"   "$PREFIX/bin/omp"   || return 1
  chmod 755 "$PREFIX/bin/omprd" "$PREFIX/bin/omp"
  [ -f "$HERE/bin/ompr" ] && { cp -u "$HERE/bin/ompr" "$PREFIX/bin/ompr"; chmod 755 "$PREFIX/bin/ompr"; }
  cp "$HERE/share/pair.html" "$PREFIX/share/" 2>/dev/null || true
  cp "$HERE/share/remote.desktop" "$PREFIX/share/" 2>/dev/null || true
  cp "$HERE/share/uninstall.sh" "$PREFIX/uninstall.sh" 2>/dev/null || true
  chmod 755 "$PREFIX/uninstall.sh" 2>/dev/null || true
  # ompr on PATH — the terminal+app remote-control CLI
  mkdir -p "$HOME/.local/bin"
  [ -f "$PREFIX/bin/ompr" ] && ln -sf "$PREFIX/bin/ompr" "$HOME/.local/bin/ompr"
  # phone-approval guard hook: pauses risky tool calls until the phone approves
  if [ -f "$HERE/agent-hooks/pre/guard.ts" ]; then
    mkdir -p "$HOME/.omp/agent/hooks/pre"
    cp -u "$HERE/agent-hooks/pre/guard.ts" "$HOME/.omp/agent/hooks/pre/guard.ts"
  fi
  # re-pair entry point: the .desktop file and CLI both call this — it lives
  # at $PREFIX so its $HERE resolves to the installed payload tree
  cp "$HERE/launcher.sh" "$PREFIX/remote-pair"
  cp "$HERE/install-root.sh" "$PREFIX/install-root.sh" 2>/dev/null || true
  chmod 755 "$PREFIX/remote-pair" "$PREFIX/install-root.sh" 2>/dev/null || true
  # omp needs its native addon under ~/.omp/natives/<pkg-version>/ — the
  # loader's first search path. The version rides the payload (written by
  # build.sh); older bundles fall back to a fixed one.
  local natver
  natver=$(cat "$HERE/natives/.version" 2>/dev/null || echo "18.4.9")
  mkdir -p "$HOME/.omp/natives/$natver"
  for n in "$HERE/natives/"*.node; do
    cp -u "$n" "$HOME/.omp/natives/$natver/" || return 1
  done
  # .desktop entry so the launcher reappears in the app menu ("Pocket Rig Pair")
  local apps="$HOME/.local/share/applications"
  mkdir -p "$apps"
  sed "s|@PREFIX@|$PREFIX|g" "$HERE/share/remote.desktop" \
      > "$apps/remote.desktop" 2>/dev/null || true
}

# Optional system install: /opt/remote + omprd@USER systemd service.
# pkexec gives a GUI password prompt on any desktop with policykit;
# plain sudo is the fallback. Never fatal — user-mode install already done.
install_system() {
  [ "$WANT_SYSTEM" = 1 ] || return 1
  if have pkexec; then
    notify "Admin rights needed for a system-wide install (or press Cancel to keep it per-user)"
    if pkexec --disable-internal-agent sh "$HERE/install-root.sh" "$HERE" "$(id -un)" "$HOME" >>"$LOG" 2>&1; then
      return 0
    fi
    log "pkexec declined or failed — trying sudo fallback"
  fi
  # sudo path: needs a tty — spawn a terminal when on a desktop
  if [ "$DESKTOP" = 1 ]; then
    for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal kitty alacritty xterm; do
      if have "$t"; then
        log "opening $t for sudo system install"
        "$t" -e sh -c "sudo sh '$HERE/install-root.sh' '$HERE' '$(id -un)' '$HOME' && echo 'system install OK' || read -r _" 2>/dev/null &
        return 2
      fi
    done
    return 1
  fi
  if [ -t 0 ] && have sudo; then
    sudo sh "$HERE/install-root.sh" "$HERE" "$(id -un)" "$HOME" >>"$LOG" 2>&1
    return $?
  fi
  return 1
}

# ------------------------------------------------------------------ start ---
OMP_BIN="$PREFIX/bin/omp"
OMPRD="$PREFIX/bin/omprd"

# omprd auto-binds tailscale -> LAN -> loopback (same order as the pair URI)
probe_hosts() {
  tailscale ip -4 2>/dev/null | head -1
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' | head -1
  printf '127.0.0.1\n'
}
running() {
  for h in $(probe_hosts); do
    curl -fs -m 2 "http://$h:$PORT/health" >/dev/null 2>&1 && { RIG_HOST="$h"; return 0; }
  done
  return 1
}

start_user() {
  if have systemctl && systemctl --user >/dev/null 2>&1; then
    local unit="$HOME/.config/systemd/user/omprd.service"
    mkdir -p "$HOME/.config/systemd/user"
    sed "s|@PREFIX@|$PREFIX|g" "$HERE/share/omprd-user.service" > "$unit"
    systemctl --user daemon-reload >/dev/null 2>&1
    systemctl --user enable --now omprd >/dev/null 2>&1 && { log "omprd via systemd --user"; return 0; }
  fi
  # detached fallback
  nohup "$OMPRD" --port "$PORT" --omp-bin "$OMP_BIN" >>"$RIG_DIR/omprd.log" 2>&1 &
  echo $! > "$RIG_DIR/omprd.pid"
  log "omprd detached (pid $(cat "$RIG_DIR/omprd.pid"))"
  return 0
}

wait_health() {
  i=0
  while [ $i -lt 40 ]; do
    running && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}

# ------------------------------------------------------------------- pair ---
# `omprd pair` mints ~/.rig/pending.json and prints URI + terminal QR.
mint() {
  local out uri code expires
  out=$("$OMPRD" pair --png "$RIG_DIR/pair-qr.png" 2>>"$LOG") || { log "omprd pair failed"; return 1; }
  uri=$(printf '%s\n' "$out" | sed -n 's/.*\(remote:\/\/[^[:space:]]*\).*/\1/p' | head -1)
  code=$(printf '%s\n' "$uri" | sed 's/.*#//')
  expires=$(( $(date +%s) + 590 ))
  [ -n "$uri" ] || { log "no remote:// URI in omprd pair output"; printf '%s\n' "$out" >>"$LOG"; return 1; }
  # headless path reuses the daemon's own terminal QR verbatim
  [ "$DESKTOP" = 1 ] || printf '%s\n' "$out"
  # ASCII QR into the log either way — an installer.log always has one
  have qrencode && qrencode -t UTF8 "$uri" >>"$LOG" 2>/dev/null || true
  # config for the pair page (file:// can't read ~/.rig directly — generate it)
  cp "$PREFIX/share/pair.html" "$RIG_DIR/pair.html"
  printf 'window.PAIR = {uri: %s, code: %s, expires: %s};\n' \
    "\"$uri\"" "\"$code\"" "$expires" > "$RIG_DIR/pair-config.js"
  PAIR_URI="$uri"; PAIR_CODE="$code"
  log "pair code $code -> $uri"
  return 0
}

show_qr() {
  if [ "$DESKTOP" = 1 ]; then
    # Primary: a rendered PNG of the pair payload opened in the image viewer —
    # survives every browser/WSL quirk because it's just a picture.
    # `omprd pair --png` already wrote it; qrencode is the fallback renderer.
    if [ ! -s "$RIG_DIR/pair-qr.png" ] && have qrencode; then
      qrencode -o "$RIG_DIR/pair-qr.png" -s 8 -m 2 "$PAIR_URI" >>"$LOG" 2>&1 || true
    fi
    if [ -s "$RIG_DIR/pair-qr.png" ]; then
      xdg-open "$RIG_DIR/pair-qr.png" >/dev/null 2>&1 &
      log "pair QR PNG opened via xdg-open ($RIG_DIR/pair-qr.png)"
      return 0
    fi
    log "no PNG renderer — falling through to pair page"
    # WSL: xdg-open/wslview can't hand a browser a Linux path — give the
    # Windows side the \\wsl.localhost\<distro>\ UNC form instead
    if grep -qi microsoft /proc/version 2>/dev/null && have cmd.exe; then
      local rel
      rel=$(printf '%s' "$RIG_DIR/pair.html" | tr '/' '\\')
      local unc="\\\\wsl.localhost\\${WSL_DISTRO_NAME:-Ubuntu}$rel"
      if cmd.exe /c start "" "$unc" >/dev/null 2>&1; then
        log "pair page opened via wsl UNC ($unc)"
        return 0
      fi
      log "wsl UNC open failed — trying Linux openers"
    fi
    for opener in xdg-open gio kde-open5 kde-open wslview sensible-browser; do
      if have "$opener"; then
        case "$opener" in gio) "$opener" open "$RIG_DIR/pair.html" >/dev/null 2>&1 & ;;
                        *)     "$opener" "$RIG_DIR/pair.html" >/dev/null 2>&1 & ;;
        esac
        log "pair page opened via $opener"
        return 0
      fi
    done
    # zenity fallback: at least show the code in a window
    if have zenity; then
      zenity --info --title="Pocket Rig" --width=400 \
        --text="Scan-less pairing.\n\nPair code: <b>$PAIR_CODE</b>\nLink: $PAIR_URI\n\nValid 10 minutes." >/dev/null 2>&1 &
      return 0
    fi
    log "no browser opener found — pair page is at $RIG_DIR/pair.html"
    return 1
  fi
  log "headless: scan the QR above or open $PAIR_URI"
  return 0
}

# pending.json is consumed (deleted) by the daemon when a phone pairs.
watch_pair() {
  local deadline=$(( $(date +%s) + 630 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ ! -f "$RIG_DIR/pending.json" ]; then
      notify "Phone paired — Pocket Rig is connected."
      log "paired"
      return 0
    fi
    sleep 2
  done
  notify "Pair code expired — run Pocket Rig Pair again for a new one."
  return 1
}

# ------------------------------------------------------------------- main ---
log "=== remote launcher (desktop=$DESKTOP system_wanted=$WANT_SYSTEM) ==="

if [ ! -f "$PREFIX/bin/omprd" ] || { [ "$HERE" != "$PREFIX" ] && [ -d "$HERE/bin" ]; }; then
  install_user || { log "payload install failed"; exit 1; }
fi

SYSRC=1
if [ "$WANT_SYSTEM" = 1 ]; then install_system; SYSRC=$?; fi
[ "$SYSRC" = 0 ] && log "system install done (service omprd@$(id -un))"

# SYSRC=2 means the sudo install is still running inside the terminal we
# spawned — give it a moment to enable omprd@USER before falling back to a
# detached per-user daemon that would steal the port from the service.
if [ "$SYSRC" = 2 ]; then
  i=0
  while [ $i -lt 25 ]; do
    if running || systemctl is-active --quiet "omprd@$(id -un)" 2>/dev/null; then
      SYSRC=0
      log "system service came up during settle wait"
      break
    fi
    sleep 1; i=$((i + 1))
  done
fi

if running; then
  log "omprd already listening on $RIG_HOST:$PORT"
else
  # system service preferred when install-root.sh enabled it
  if [ "$SYSRC" = 0 ] && systemctl is-active --quiet "omprd@$(id -un)" 2>/dev/null; then
    log "omprd already up via systemd"
  elif [ "$SYSRC" = 0 ] && have systemctl && systemctl enable --now "omprd@$(id -un)" >>"$LOG" 2>&1; then
    log "started omprd@$(id -un) via systemd"
  else
    start_user
  fi
fi

wait_health || { log "daemon did not come up — see $RIG_DIR/omprd.log"; notify "Pocket Rig failed to start"; exit 1; }
notify "Pocket Rig online — minting a pair code"

mint || exit 1
show_qr
watch_pair
