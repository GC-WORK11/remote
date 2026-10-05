# Compatibility matrix — Remote (phone ↔ rig)

What actually works where, and what's only been compiled. `VERIFIED` means
it ran on real hardware/VM and produced observable output; `UNTESTED` means
the code path exists and compiles but nobody has driven it end-to-end.

## Daemon (omprd) by host OS

| Capability | Linux | macOS | Windows |
|---|---|---|---|
| Build (`make`, C++20) | VERIFIED — g++ `-O2 -std=c++20`, zero warnings, omprd 1.22 MB @ `e430453` | VERIFIED — clang `-O2 -std=c++20`, zero warnings, omprd ~1 MB, arm64 @ `a65e886` | VERIFIED (Server 2022, earlier round) |
| Pairing (`ompr pair` QR → token) | VERIFIED — ASCII QR zbarimg-decodes to `{"url","code"}`; pair→token→rig.status live | VERIFIED — fresh device paired on a LAN address this round | VERIFIED (same wire frames) |
| `session.new` → prompt round-trip | VERIFIED — rpc `prompt` → `text_delta` stream → `prompt_result{status:"completed"}` ~1s | VERIFIED — real turn against local OpenAI-completions stub: `text_delta` stream → `prompt_result"completed"`, 0.6s on warm-adopted session; subscribe replays since:0 (replayedTo=4) | VERIFIED |
| `rig.exec` (exec.started/output/done) | VERIFIED (earlier round) | VERIFIED — `uname -s` → `Darwin`, code=0, 3ms | same wire shape (win.hpp exec thread) |
| `rig.fs.*` (glob/read/write/grep) | VERIFIED (earlier round) | VERIFIED — glob `/tmp`→10 matches; write→read round-trip after POSIX mode-000 fix (`a65e886`) | win.hpp carries the `_wopen` mode guard already |
| Keep-awake (sleep) | VERIFIED — `systemd-inhibit --what=sleep` held (sudo child), `rig.status keepawake.held:true, method:"systemd-inhibit(sudo)"` | VERIFIED (`iopm:idle+display`) | VERIFIED (`ES_CONTINUOUS|ES_SYSTEM_REQUIRED|…`) |
| Lid-close survival | VERIFIED TIERS — `install.sh --lid` wrote `/etc/systemd/logind.conf.d/90-omprd-lid.conf` (`HandleLidSwitch=ignore` ×3) + `try-restart systemd-logind` (logind active-since timestamp confirms); `rig.status lidOverride{applied:true, method:"logind-dropin"}`. Unprivileged inhibitor + `needs-root` honest-report tiers also verified. A *physical* lid-close is UNTESTED (VMs have no lid) | VERIFIED (`pmset disablesleep` tiers) | PARTIAL — `powercfg lidaction` write verified incl. `no-lid` honesty on lidless hardware; real lid-close untested |
| Wi-Fi powersave | CODE-VERIFIED — `install.sh --lid` writes `/etc/NetworkManager/conf.d/90-omprd-wifi-powersave.conf` (`wifi.powersave=2`) when NM exists (skipped honestly on this VM — no NM); `iw dev <if> set power_save off` per wireless iface | n/a | n/a |
| Computer-use (X11/screen/input) | VERIFIED — Xvfb+xfwm4 boot, screenshot/input/window-list frames; phone "See your screen" shows live 1920×1080 X11 stream + pointer coords | VERIFIED (CGEvent) | VERIFIED (SendInput, Server 2022) |
| `remote://` deep link | VERIFIED — `omprd --qr` prints `remote://host:port#code` | same | same |

## Android app

| Fact | Status |
|---|---|
| `minSdkVersion` | **24** (Android 7.0) — aapt2 manifest binary @ HEAD |
| `targetSdkVersion` | 36 |
| ABIs in dev/universal APK | `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` (aapt2 `native-code` + zip `lib/` listing). Ship policy = ARM only (`-PreactNativeArchitectures=armeabi-v7a,arm64-v8a`); x86/x86_64 exist for emulators |
| Cleartext `ws://` on LAN | `usesCleartextTraffic=true` in manifest (required ≥API 28; Android can't express LAN-IP cleartext via networkSecurityConfig — no IP-literal domain rules) |
| Google Mobile Services | **None required** — zero play-services/firebase deps; safe for Chinese ROMs |
| Permissions (final) | CAMERA (QR scan), INTERNET, VIBRATE, ACCESS_NETWORK_STATE — RECORD_AUDIO / SYSTEM_ALERT_WINDOW / legacy storage stripped via `app.json android.blockedPermissions` (injects `tools:node="remove"` at prebuild) |
| Pairing entry points | VERIFIED — QR (JSON `{url,code}`), `remote://pair?url=&code=`, `remote://host#code`, `remote://host#token`, IPv6 literal, bare `host#code` (default port 8790) — all parse through the app's own `parseRigUri` |
| e2e on x86_64 emulator | VERIFIED — pair → drawer → thread → prompt → streamed reply → Cowork/Code toggle → keep-awake round-trip → live X11 screen stream (recorded). v2 round adds: re-pair via onboarding → cowork turn spawning a real terminal on the rig display → Changes sheet Files patch → Checkpoints preview + restore → pty terminal commands → in-app browser → done-dots (recorded, HEAD `0dd8389`) |
| Take-over input (rig stream) | PARTIAL — control handoff flips cleanly and raw `computer.click` over the wire moves the :99 pointer (daemon+input path VERIFIED at wire level). Works from real touch; on the emulator `adb input tap`/`swipe` can't drive the stream's RN gesture handlers (injected synthetic events never reach `onGestureEvent`), so end-to-end touch was not provable from an emulator — needs a physical-device check |
| Composer text input vs `adb input text` | EMULATOR QUIRK — `input text` races the RN controlled `TextInput` (garbled/dropped chars, `&&` splits on the device shell). Per-char `input keyevent` is race-proof. Production typing from a real keyboard is unaffected |
| e2e on a physical device | UNTESTED — no physical Android device on hand |
| e2e on ARM device | UNTESTED — emulator was x86_64; arm64-v8a ABI packaged but not run |
| Release APK (`:app:assembleRelease`) | VERIFIED this round — 72 MB universal at `mobile/android/mobile/build/outputs/apk/release/app-release.apk`: `native-code` = `arm64-v8a`+`armeabi-v7a` only, minSdk 24, targetSdk 36, `usesCleartextTraffic=true`, debug-keystore signed |
| Hardware back handling | FIXED this round (`85ed5ec`) — drawer: back closes drawer (was: popped route, drawer stayed); `code/folders` picker: back walks up one dir or cancels the inline new-folder row; sheets already dismissed on back via `useSheetEnter` |
| Left-edge drawer open vs gesture nav | DOCUMENTED GAP — the 26px left-edge pan strip sits inside the system back-gesture zone; under gesture nav the OS claims those swipes, so edge-open can't fire. Hamburger button is the working open path; back now closes the drawer |

## Phone pairing steps per host OS

The flow is identical on every OS — only the daemon internals differ.

**Same Wi-Fi / LAN**

1. On the laptop: `ompr pair` (or the tray/menu "Pair phone") — prints the
   QR plus a `link: remote://<ip>:8790#<code>` line.
2. On the phone: Remote app → **Scan the QR on your computer** → point at the
   terminal QR. The app extracts `{url, code}` and finishes pairing itself.
   No QR camera? Choose **Paste the link instead** and paste the
   `remote://…#code` line `ompr pair` printed, or **Type the address
   yourself** and enter `host-ip : 8790` + the 6-digit code. Pasting the
   `remote://` link into the address field also works — it parses and
   pairs in one tap (VERIFIED on Android release build).
3. Done — the phone holds a long-lived token; the laptop drops the code.

**Away from home (Tailscale)**

Same steps — install Tailscale on both devices first so the phone can reach
`ws://<tailscale-ip>:8790`. The QR/link embed whichever IP omprd bound.

**USB / emulator (dev only)**

`adb reverse tcp:8790 tcp:8790`, then pair to `127.0.0.1 : 8790` — verified
end-to-end on the Android emulator.

## Notes

- **Checkpoint auto-capture silent-skip (found in the v2 demo):** a session
  with 6 `prompt_result`s had only checkpoint refs cp1–cp4 — the last two
  turns captured nothing, and the `prompt_result` trigger thread only logged
  on `ok && !skipped`, so an `ok:false` (or silent skip) left no trace.
  FIXED upstream (`72fde54`): outcome is now logged and a ref-collision
  retry was added.
- **`rig.hostOpen` on Linux (found + fixed this lane):** the launcher's
  `os` arg was never passed so the linux branch was unreachable (`1c92b3d`),
  and the `xdg-open ||` fallback could never fire — `xdg-open` exits 0 via
  w3m in DE-less daemon envs, and `command -v google-chrome` misses the
  `$HOME/.local/bin` shim. Now: `xdg-open` only under a real DE
  (`XDG_CURRENT_DESKTOP`/`DESKTOP_SESSION`), else probe browser binaries in
  PATH + `$HOME/.local/bin` launched with `--new-window` (`e774c4f`).
  VERIFIED on the emulator — Example Domain opened as a real Chrome window
  on :99.
- **Windows bind gap (found this round):** `install-windows.ps1` launched
  omprd with `--bind 127.0.0.1` — loopback only, so a phone could never
  reach it over LAN while the pairing QR advertised the LAN IP. The
  loopback default was deliberate (Tailscale/ssh -L for remote), but it
  made the primary same-Wi-Fi flow impossible. FIXED this round: new
  `-Bind` parameter — `-Bind ""` omits the flag so omprd auto-detects
  (LAN IP, matching the QR); loopback remains the shipped default, and
  the probe + pairing instructions adapt to the bind. Windows Firewall
  allow for omprd.exe is still manual (printed at install). On
  macOS/Linux omprd binds `detect_best_ip()` (a single LAN IP) — note
  loopback connects are refused there too, so `adb reverse` must target
  the bound LAN IP, not 127.0.0.1.
- **Only `ws://` exists** — no TLS anywhere (`OMPD_WS`, pairing QR, CLI).
  `usesCleartextTraffic=true` is a hard requirement on Android; documented
  above.
- **No Android emulator on a macOS VM** (this round): the box is macOS
  arm64 — no /dev/kvm and HVF reports `HV_UNSUPPORTED` on AVD boot
  (nested virt disabled; accel-check output is misleading). e2e proof
  this round is wire-level + web, not an emulated APK.
- `os-bridge/Makefile`: added missing `win.hpp` to the daemon deps this
  round.
- Windows: cannot be driven from this box. The wire protocol is OS-agnostic —
  the same JSON frames the Android e2e consumed (`pair`, `auth`,
  `session.new`, `rpc prompt`→`prompt_result`, computer/x11 frames) were
  verified on a Windows Server 2022 machine in an earlier round (PR #2
  lineage). Android↔Windows pairing is byte-identical; the row stays
  UNTESTED here because no fresh run happened this round.
- Keep-awake vs lid-close are different tiers: the sleep inhibitor holds
  while omprd runs; lid-close additionally needs the OS-level override
  (drop-in/pmset/powercfg) or reports `needs-root`/`needs-admin` + the exact
  command, never a fake success.
