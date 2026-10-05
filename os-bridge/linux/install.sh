#!/bin/sh
# remote install — build omprd, put it on PATH, make it survive reboot,
# print the pairing QR. Idempotent: rerun to rebuild + reinstall.
# No sudo anywhere — platform bits that need it are printed, not run.
set -eu

RIG_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$RIG_DIR/.." && pwd)"
OS="$(uname -s 2>/dev/null || echo unknown)"

say() { printf '%s\n' "$*"; }
die() { say "install: $*" >&2; exit 1; }

# --lid / --with-lid: install the lid-close override now (needs sudo —
# Linux writes the logind + NM wifi-powersave drop-ins, macOS writes the
# pmset sudoers grant). Without it, an interactive Linux run offers the
# same step.
LID_STEP=auto
case "${1:-}" in
    --lid|--with-lid) LID_STEP=yes ;;
    --no-lid) LID_STEP=no ;;
    "") ;;
    *) die "usage: install.sh [--with-lid|--lid|--no-lid]" ;;
esac

# --- find the omp binary the daemon wraps ----------------------------------
OMP_BIN=""
for cand in \
    "$REPO_DIR/node_modules/.bin/omp" \
    "$RIG_DIR/node_modules/.bin/omp" \
    "$(command -v omp 2>/dev/null || true)"; do
    [ -n "$cand" ] && [ -x "$cand" ] && OMP_BIN="$cand" && break
done
[ -n "$OMP_BIN" ] || die "omp not found — run 'npm install' in the repo root first"

# --- pick the install dir: XDG bin, else ~/bin ------------------------------
BIN_DIR="$HOME/.local/bin"
[ -d "$BIN_DIR" ] || BIN_DIR="$HOME/bin"
mkdir -p "$BIN_DIR" "$HOME/.rig"
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "note: $BIN_DIR is not on PATH — add it to your shell profile" ;;
esac

# --- build + install --------------------------------------------------------
say "install: building omprd ($OS)"
( cd "$RIG_DIR" && make )
install -m 0755 "$RIG_DIR/daemon/omprd" "$BIN_DIR/omprd"
say "install: $BIN_DIR/omprd"

# --- phone-approval guard hook ----------------------------------------------
# omp pre-hooks block tool calls before they run; ours asks the phone to
# confirm risky commands (rm -rf, sudo, force-push, curl|sh …). Without it,
# extension confirms resolve to defaults and nothing ever reaches the app.
OMP_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
if [ -f "$RIG_DIR/agent-hooks/pre/guard.ts" ]; then
    mkdir -p "$OMP_AGENT_DIR/hooks/pre"
    install -m 0644 "$RIG_DIR/agent-hooks/pre/guard.ts" "$OMP_AGENT_DIR/hooks/pre/guard.ts" \
        && say "install: phone-approval hook → $OMP_AGENT_DIR/hooks/pre/guard.ts"
fi

DAEMON_ARGS="$BIN_DIR/omprd --omp-bin $OMP_BIN --keep-awake"

# --- boot persistence -------------------------------------------------------
case "$OS" in
Darwin)
    PLIST="$HOME/Library/LaunchAgents/ai.remote.omprd.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.remote.omprd</string>
  <key>ProgramArguments</key><array>
    <string>$BIN_DIR/omprd</string>
    <string>--omp-bin</string><string>$OMP_BIN</string>
    <string>--keep-awake</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$BIN_DIR:/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.rig/omprd.log</string>
  <key>StandardErrorPath</key><string>$HOME/.rig/omprd.log</string>
</dict></plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST" || die "launchctl load failed"
    say "install: launchd service loaded ($PLIST)"
    # Battery lid-close needs one root grant, once. --with-lid writes a
    # sudoers drop-in scoped to exactly the pmset calls the daemon makes;
    # after that `rig.stayAwake` flips SleepDisabled itself, no prompts.
    if [ "${WITH_LID:-0}" = "1" ] || [ "$LID_STEP" = "yes" ]; then
        SUDOERS_LINE="$USER ALL=(ALL) NOPASSWD: /usr/bin/pmset -a disablesleep 1 tcpkeepalive 1, /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a tcpkeepalive 1"
        if sudo -v 2>/dev/null; then
            printf '%s\n' "$SUDOERS_LINE" | sudo tee /etc/sudoers.d/omprd-lid >/dev/null \
                && sudo chmod 0440 /etc/sudoers.d/omprd-lid \
                && sudo pmset -a disablesleep 1 tcpkeepalive 1 \
                && say "install: lid-close grant written (/etc/sudoers.d/omprd-lid) — battery lid-closed stays awake" \
                || say "install: sudoers write failed — run the manual command below"
        else
            say "install: sudo declined — skipping lid grant (rerun with --with-lid anytime)"
        fi
    fi
    # AC-power lid-close is already covered by the daemon's IOPM assertions —
    # battery lid-close is the only piece that needs root, once.
    LID_HINT="  ./install.sh --with-lid   # one-time root grant → battery lid-close stays awake + network reachable (undo: sudo rm /etc/sudoers.d/omprd-lid && sudo pmset -a disablesleep 0)"
    ;;
Linux)
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    # Wrap the unit in systemd-inhibit: sleep + handle-lid-switch block locks
    # held for the unit's lifetime — lid-close covered with no sudo where
    # polkit grants the active session inhibitors (every desktop distro).
    if command -v systemd-inhibit >/dev/null 2>&1; then
        LID_EXEC="$(command -v systemd-inhibit) --what=sleep:handle-lid-switch --mode=block --why=remote -- $DAEMON_ARGS"
    else
        LID_EXEC="$DAEMON_ARGS"
    fi
    cat > "$UNIT_DIR/omprd.service" <<EOF
[Unit]
Description=Remote rig daemon (omprd)
After=network-online.target

[Service]
ExecStart=$LID_EXEC
Restart=always
RestartSec=3
Environment=HOME=$HOME
Environment=PATH=$BIN_DIR:$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
    # Headless boxes (CI, containers, no login session) have no user bus —
    # write the unit anyway, print the manual start, don't abort the install.
    if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload 2>/dev/null; then
        if systemctl --user enable --now omprd; then
            # survives logout with no session — needs loginctl linger
            loginctl enable-linger 2>/dev/null || \
                say "note: run 'loginctl enable-linger' to keep the rig up after logout"
            say "install: systemd user unit enabled ($UNIT_DIR/omprd.service)"
        else
            say "install: systemctl --user enable failed — unit written, start by hand:"
            say "  $DAEMON_ARGS"
        fi
    else
        say "install: no systemd user bus — unit written to $UNIT_DIR/omprd.service"
        say "         start the rig by hand: $DAEMON_ARGS"
    fi
    LID_HINT="  unit wraps omprd in systemd-inhibit (sleep+lid locks where polkit allows).\n  For the always-on drop-in + wifi powersave: sudo $RIG_DIR/install.sh --lid"
    ;;
MINGW*|MSYS*|CYGWIN*)
    say "install: Windows detected — use the native installer instead:"
    say "  powershell -ExecutionPolicy Bypass -File $(cygpath -w "$RIG_DIR" 2>/dev/null || echo "$RIG_DIR")\\install-windows.ps1"
    say "  (installs omprd.exe, registers a hidden logon task, sets lid policy)"
    LID_HINT="  install-windows.ps1 sets LIDACTION=do-nothing when elevated; the daemon also tries via rig.stayAwake {persistent:true}\n  # daemon also holds ES_AWAYMODE_REQUIRED — away-mode keeps WiFi + processes alive"
    ;;
*)
    say "install: unknown OS '$OS' — binary installed, run it by hand:"
    say "  $DAEMON_ARGS"
    LID_HINT=""
    ;;
esac

# --- lid-close + wifi-powersave step (Linux) --------------------------------
# "Close the lid, keep working" needs real root: logind ignores lid switches
# via a drop-in, and a sleeping NIC needs powersave off. Costs battery —
# HandleLidSwitch=ignore means closing the lid never suspends, so an
# unplugged laptop will run flat instead of sleeping. On AC that's the
# point of a rig; on battery, close the lid only when you mean it.
lid_install() {
    command -v sudo >/dev/null 2>&1 || die "--lid needs sudo (or run this script as root)"
    SUDO="sudo"
    [ "$(id -u)" = "0" ] && SUDO=""
    if [ -d /run/systemd/system ] || [ -f /etc/systemd/logind.conf ]; then
        $SUDO mkdir -p /etc/systemd/logind.conf.d
        printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchDocked=ignore\nHandleLidSwitchExternalPower=ignore\n' \
            | $SUDO tee /etc/systemd/logind.conf.d/90-omprd-lid.conf >/dev/null
        $SUDO systemctl try-restart systemd-logind 2>/dev/null \
            || say "note: drop-in written; restart systemd-logind or reboot to apply"
        say "lid:   /etc/systemd/logind.conf.d/90-omprd-lid.conf  (HandleLidSwitch=ignore — persists across reboots)"
    elif [ -d /etc/elogind ]; then
        $SUDO mkdir -p /etc/elogind/logind.conf.d
        printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchDocked=ignore\n' \
            | $SUDO tee /etc/elogind/logind.conf.d/90-omprd-lid.conf >/dev/null
        $SUDO sv restart elogind 2>/dev/null \
            || say "note: elogind drop-in written; restart elogind or reboot to apply"
        say "lid:   /etc/elogind/logind.conf.d/90-omprd-lid.conf"
    else
        say "lid:   no logind/elogind found — lid sleep is firmware; nothing to configure"
    fi
    # wifi powersave: a dozing NIC is still unreachable. NM drop-in is
    # persistent; `iw` toggles live radios too when present.
    if [ -d /etc/NetworkManager/conf.d ]; then
        printf '[connection]\nwifi.powersave=2\n' \
            | $SUDO tee /etc/NetworkManager/conf.d/90-omprd-wifi-powersave.conf >/dev/null
        $SUDO systemctl reload NetworkManager 2>/dev/null || true
        say "wifi:  /etc/NetworkManager/conf.d/90-omprd-wifi-powersave.conf  (powersave=off, persistent)"
    fi
    if command -v iw >/dev/null 2>&1; then
        for n in /sys/class/net/*; do
            i="${n##*/}"
            [ -d "$n/wireless" ] || [ -d "$n/phy80211" ] || continue
            $SUDO iw dev "$i" set power_save off 2>/dev/null \
                && say "wifi:  $i power_save off (live)" \
                || say "wifi:  $i power_save toggle failed — check 'iw dev $i get power_save'"
        done
    fi
    say ""
    say "undo:  sudo rm /etc/systemd/logind.conf.d/90-omprd-lid.conf /etc/NetworkManager/conf.d/90-omprd-wifi-powersave.conf"
    say "       sudo systemctl try-restart systemd-logind NetworkManager"
}

if [ "$OS" = "Linux" ]; then
    DO_LID=""
    case "$LID_STEP" in
        yes) DO_LID=1 ;;
        no) ;;
        auto)
            if [ -t 0 ]; then
                printf '%s' "install: enable lid-close + wifi-powersave override? keeps the rig alive on AC but drains a battery laptop instead of suspending [y/N] "
                read -r a </dev/tty 2>/dev/null || a=""
                case "$a" in [yY]*) DO_LID=1 ;; esac
            fi
            ;;
    esac
    if [ -n "$DO_LID" ]; then lid_install; fi
fi

# --- the connect payload ----------------------------------------------------
say ""
say "install done. point your phone at this QR (or paste the URI in the app):"
"$BIN_DIR/omprd" pair || true
say ""
say "verify: $BIN_DIR/omprd --version   ·   running? pgrep -fl omprd   ·   logs: ~/.rig/omprd.log"
if [ -n "$LID_HINT" ]; then
    say "lid-closed laptop? software can't stop hardware lid sleep — this does:"
    say "$LID_HINT"
fi
