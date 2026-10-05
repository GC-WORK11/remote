# remote Linux installer

One double-clickable artifact that installs the rig daemon and shows a
pairing QR on screen: `dist/Remote-Setup.run`.

## What it does

```
run file ──> extract payload ──> user-mode install (~/.local/share/remote)
              (omprd + omp + ompr + pi-natives + guard hook; ompr -> ~/.local/bin)
          ──> optional system install (pkexec GUI prompt -> /opt/remote
              + systemd omprd@<user> service; Cancel/decline -> stays per-user)
              also drops: logind.conf.d lid-ignore ×3, NM wifi-powersave=2,
              `iw power_save off` now, enable-linger — close the lid, keep working
          ──> start omprd (system service, systemd --user, or detached nohup)
          ──> omprd pair -> mint one-time code (~/.rig/pending.json)
          ──> desktop: open ~/.rig/pair.html in the default browser
              headless: print the terminal QR + remote:// link
          ──> phone scans QR -> paired -> desktop notification
```

The QR payload is the same `remote://IP:PORT#CODE` the daemon's own
`omprd pair` prints — `omprd` picks the host the same way for the bind and
the URI: Tailscale IP when `tailscale ip -4` answers, else the LAN egress
IP, else `127.0.0.1`.

## Build

```bash
# on any Linux box with the repo checked out (engine must exist):
sudo apt install build-essential curl tar
curl -fsSL https://bun.sh/install | bash   # bun >= 1.1 for --compile
os-bridge/installer/build.sh
# -> os-bridge/installer/dist/Remote-Setup.run
```

`build.sh` compiles `daemon/omprd.cpp` twice (dynamic + `-static` fallback),
compiles `engine/omp` to ONE self-contained binary via the fork's own
`CROSS_TARGET=linux-x64 build-binary.ts` (raw `bun build --compile` drops the
`omp-legacy-pi-modules` virtual module — the fork's compile script supplies it
via an in-memory plugin), downloads the prebuilt Rust natives from npm
(`@oh-my-pi/pi-natives-linux-x64`), and appends the gzipped payload to a
POSIX self-extracting stub (no makeself dependency).

`build.sh --payload-only` repacks `payload/` after editing `src/` scripts —
fast iteration without recompiling binaries.

## Runtime deps (target machine)

| Component          | Needed by                | Debian/Ubuntu package |
|--------------------|--------------------------|------------------------|
| bash/sh, tar, gzip | extractor + launcher     | base system            |
| curl OR wget OR bash /dev/tcp | health check    | `curl` (base on Ubuntu)|
| systemd (optional) | service mode             | `systemd` (default)    |
| pkexec (optional)  | GUI admin prompt         | `polkitd` / `policykit-1` (default on Ubuntu Desktop) |
| xdg-open/gio/wslview | opens the pair page    | `xdg-utils` (default)  |
| notify-send (opt.) | status toasts            | `libnotify-bin`        |
| zenity (optional)  | code dialog if no browser| `zenity`               |

Everything optional degrades cleanly: no pkexec → sudo-in-terminal →
per-user install; no xdg-open → zenity dialog; nothing → terminal QR.
No glibc/libstdc++ constraint on omprd beyond the `ldd` baseline of the
build distro (a `-static` binary is shipped as `bin/omprd.static` in the
payload for exotic targets).

## Headless vs desktop

- **Desktop** (`$DISPLAY`/`$WAYLAND_DISPLAY` set): pkexec GUI prompt →
  pair page in the default browser with a rendered QR + code + deep link →
  `notify-send` when the phone connects.
- **Headless** (SSH/server, or `--headless`): no GUI deps used; the ASCII
  QR and `remote://` link print to the terminal; daemon starts via
  `systemd --user` when available else detached `nohup` with a pidfile in
  `~/.rig/omprd.pid`.
- `--no-system` skips the pkexec/sudo step entirely (per-user install only).

## Files installed

```
~/.local/share/remote/{bin/omprd, bin/omp, bin/ompr, remote-pair, share/, uninstall.sh}
~/.local/bin/ompr                                            (terminal/app remote CLI)
~/.local/share/applications/remote.desktop               (re-pair entry point)
~/.omp/natives/18.6.0/pi_natives.linux-x64-*.node
~/.omp/agent/hooks/pre/guard.ts                              (phone-approval hook)
~/.rig/{pair.html, pair-config.js, pending.json, installer.log, omprd.log}
(opt) /opt/remote + /etc/systemd/system/omprd@.service   [system install]
(opt) /etc/systemd/logind.conf.d/90-omprd-lid.conf           [lid-close survival]
(opt) /etc/NetworkManager/conf.d/90-omprd-wifi-powersave.conf [wifi powersave off]
```

Re-show the QR any time: app menu → “Pocket Rig — Pair”, or
`~/.local/share/remote/remote-pair`.

Remove everything: `~/.local/share/remote/uninstall.sh` (system bits need
root: `pkexec …/uninstall.sh --root-bits $USER`).

## Verified

All scripts pass `bash -n`/`sh -n`; the launcher was logic-audited path-by-
path (install, escalation, start, mint, open, watch). End-to-end click → QR →
phone `paired` is exercised on real Ubuntu in the project's walkthrough lane
(`docs/WALKTHROUGH.md`).
