#!/bin/sh
# remote system install — runs under pkexec/sudo.
# Args: <payload-dir> <target-user> <target-home>
set -eu
PAYLOAD="$1"
TUSER="$2"
THOME="$3"
DEST=/opt/remote

mkdir -p "$DEST/bin" "$DEST/share"
cp "$PAYLOAD/bin/omprd" "$DEST/bin/omprd"
cp "$PAYLOAD/bin/omp"   "$DEST/bin/omp"
chmod 755 "$DEST/bin/omprd" "$DEST/bin/omp"
cp "$PAYLOAD/natives/"*.node "$DEST/bin/" 2>/dev/null || true
cp "$PAYLOAD/share/"* "$DEST/share/" 2>/dev/null || true
ln -sf "$DEST/bin/omprd" /usr/local/bin/omprd

# per-user system service: omprd@<user> runs the daemon AS that user —
# sessions never run as root.
if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
  sed "s|@USER_HOME@|$THOME|g" "$PAYLOAD/share/omprd@.service" \
      > /etc/systemd/system/omprd@.service
  # Root lid-close inhibitor: systemd-inhibit needs a "block" lock for
  # handle-lid-switch, which only root may hold. This tiny always-on unit
  # carries it; the logind drop-in below is the belt where inhibitors can't.
  cat > /etc/systemd/system/omprd-lid-inhibit.service <<'EOF'
[Unit]
Description=Pocket Rig lid-close inhibitor (keeps this laptop reachable)
After=systemd-logind.service
Wants=systemd-logind.service

[Service]
Type=simple
ExecStart=/usr/bin/systemd-inhibit --what=handle-lid-switch --who=omprd --why="Remote keeps this laptop reachable" --mode=block /usr/bin/sleep infinity
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "omprd@$TUSER" >/dev/null 2>&1 || true
  systemctl enable --now omprd-lid-inhibit >/dev/null 2>&1 || true
fi
# user services must survive logout on a headless box
command -v loginctl >/dev/null 2>&1 && loginctl enable-linger "$TUSER" 2>/dev/null || true

# ---- lid-close survival -------------------------------------------------
# The laptop stays reachable with the lid shut: logind must not suspend on
# lid close, and wifi must not drop into powersave (which adds ~300-1000ms
# latency spikes or drops the Tailscale path entirely).
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/90-omprd-lid.conf <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
systemctl try-restart systemd-logind 2>/dev/null || true

if command -v nmcli >/dev/null 2>&1 || [ -d /etc/NetworkManager ]; then
  mkdir -p /etc/NetworkManager/conf.d
  cat > /etc/NetworkManager/conf.d/90-omprd-wifi-powersave.conf <<'EOF'
[connection]
wifi.powersave=2
EOF
  systemctl try-restart NetworkManager 2>/dev/null || true
fi
# live switch too — the drop-in only bites on reconnect
for w in /sys/class/net/*/wireless; do
  iface=${w%/wireless}; iface=${iface##*/}
  iw dev "$iface" set power_save off 2>/dev/null || true
done

# Scoped sudoers grant: the daemon's own lid/keep-awake paths use `sudo -n`
# (stay_awake inhibitor, logind drop-in write/remove, NM powersave off).
# Same shape as the macOS install.sh --with-lid pmset grant.
if [ -d /etc/sudoers.d ]; then
  cat > /etc/sudoers.d/omprd-lid <<EOF
Cmnd_Alias OMPRD_LID = /usr/bin/systemd-inhibit *, /usr/bin/tee /etc/systemd/logind.conf.d/*, /usr/bin/mkdir -p /etc/systemd/logind.conf.d, /usr/bin/rm -f /etc/systemd/logind.conf.d/*, /usr/bin/systemctl try-restart systemd-logind, /usr/bin/systemctl reload NetworkManager, /usr/bin/systemctl try-restart NetworkManager, /usr/sbin/iw dev * set power_save off
$TUSER ALL=(root) NOPASSWD: OMPRD_LID
EOF
  chmod 440 /etc/sudoers.d/omprd-lid
  visudo -c -f /etc/sudoers.d/omprd-lid >/dev/null 2>&1 || rm -f /etc/sudoers.d/omprd-lid
fi
# ---- end lid-close -------------------------------------------------------

echo "remote installed to $DEST (service omprd@$TUSER)"
