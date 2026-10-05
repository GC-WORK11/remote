# Remote — Roadmap & Setup Guide

Your laptop is the computer. Your phone is the remote. This is the honest,
tail-to-head state of the project and the exact steps to go from a Linux
laptop to full remote control from Android.

---

## 1. The two files you need

| What | Where | Size |
|------|-------|------|
| **Linux installer** | `Remote-Setup.run` (attached in session / built by `os-bridge/installer/build.sh`) | ~265 MB |
| **Android app** | `remote-*.apk` (attached in session) | ~65 MB |

The `.run` is one self-extracting file: the daemon (`omprd`), the agent
runtime (`omp` — the fork that drives Claude/GPT/Gemini/etc.), the `ompr`
CLI, Rust natives, and every system tweak wired in — no other downloads.

## 2. Linux laptop → Android phone, end to end

```
Remote-Setup.run ─ click ─> pkexec admin prompt (your sudo password)
                  │        — decline → per-user install, still works
                  └─ installs /opt/remote + omprd@you.service (systemd)
                     + lid-close survival (logind drop-in ×3)
                     + wifi powersave off + enable-linger
                  └─ prints a QR code + remote:// link + 6-digit code

phone ─ install APK ─ open ─ welcome screen ─ scan QR (or type the code)
      └─ paired. Inbox fills. You are now driving the laptop from the phone.
```

Re-show the QR any time: app menu → “Pocket Rig — Pair”, or
`~/.local/share/remote/remote-pair`, or `ompr pair`.

**Prefer the terminal path?**
`git clone … && cd remote/os-bridge && ./install.sh --with-lid`
— same result, no admin needed (per-user install).

## 3. Closing the lid — the backpack workflow

The `.run` install writes the logind drop-in that ignores lid-close, kills
wifi powersave, and enables linger. Close the lid, put the laptop in your
bag — omprd keeps serving.

Honest limits, because faking this would burn you:

- **Power**: `HandleLidSwitchExternalPower=ignore` covers unplugged lids on
  most laptops, but some firmware still hard-sleeps on battery. Plug in, or
  test on your hardware once.
- **Away from home**: the QR carries `remote://<tailscale-IP or LAN-IP>:8790#code`.
  On the same wifi it just works. Away from home you need the laptop
  reachable: install Tailscale on the laptop AND the phone — omprd
  auto-binds the Tailscale IP when it exists, so the same QR keeps working
  on LTE. That is the real “work from anywhere” path.
- **Sleep**: if the machine suspends to RAM (low battery, manual suspend),
  nothing can reach it — lid-close ≠ hibernate.

## 4. Your subscription — no API key needed

Providers like Claude/ChatGPT/Gemini subscriptions use **browser login on
the laptop**; the credentials live on the laptop in `~/.omp/agent/`:

- **From the phone**: drawer → 🔑 icon → pick provider → the daemon runs
  `omp login <provider>` and streams the flow — the login page opens in the
  laptop’s own browser (or prints a URL/code on its screen). Finish the
  browser login on the laptop; the phone flips to “connected”.
- **From the laptop directly**: `omp login <provider>` in any terminal —
  same thing; the app notices via `auth.changed`.
- **API-key providers** (deepseek and friends): the app’s provider card has
  a paste-key field — the key is handed to `omp login` over the wire, never
  stored by the app.

## 5. Picking the model

- Thread header → model chip → sheet lists providers/models from the
  laptop’s `~/.omp/agent/models.yml` — tap to switch; the effort slider
  sits in the same sheet.
- Set the default on the laptop once and every new session inherits it;
  per-thread override anytime from the chip.

## 6. What the two modes do

- **Cowork** — phone-style inbox of agent threads: pin/hide/unread,
  long-press sheet (rename, pin, hide, changes, usage, PR, delete),
  sub-agent spawn, computer-use inside the thread (screenshots, terminals
  opened on the laptop display, file actions), notifications on settle.
- **Code** — Cursor-style workspaces inbox: `+` → pick a folder or `+Build`
  a fresh project dir, then inside a thread: files, real git diff,
  checkpoints + restore, a real pty terminal, in-app browser for dev
  servers (Vite/Next/anything on a port), and a live screen/computer view.

## 7. Verified status — what’s real today

| Area | State |
|------|-------|
| Wire + auth pairing | Verified — pair → token → scopes; replay exactly-once |
| Sessions restore on boot | Verified — 53 sessions, ~14 s cold boot |
| Pin / hide / unread | Verified on the wire + in-app this commit |
| Computer-use (screenshot/type/launch) | Verified live on macOS + Linux |
| Checkpoints / diffs / pty / browser | Verified in recorded e2e |
| Lid-close | Installed by `.run`; power-caveat above |
| Notifications | Android 13+ permission + channel fixed |
| Auth broker (OAuth) | Wired; verify `omp login` on YOUR laptop once |
| Windows lane | Documented (ConPTY plan) — not shipped |
| iOS build | Works on sim; App Store needs your Apple account |

## 8. Roadmap — remaining, in order

1. **Linux+Android recorded e2e** — the Ubuntu box is recording the full
   journey video (install → pair → cowork + code tasks) now.
2. **qwen3.8-flash multimodal 400** — image-context bug, fix in flight.
3. ~~Multi-harness drivers~~ — **shipped** (`e6b9eab`): `session.new` takes
   `harness:"claude"` and omprd drives claude-code's stream-json protocol,
   translated into omp-shaped frames so replay/busy/inbox all work. Engine
   picker lives in the Build sheet. Next drivers (codex, gemini-cli) drop
   into `harness_translate` the same way.
4. **Multi-rig switcher** — multiple laptops in one app (pair per rig, host
   picker).
5. **Windows daemon parity** — ConPTY + service install.
6. **APNS push relay** — needs your Apple Developer account.
7. **Tailscale onboarding in-app** — today it’s manual (docs above).

## 9. Daily flow (once set up)

```
laptop: lid closed, in bag, on wifi/Tailscale — omprd@you.service running
phone:  open Remote → inbox → tap thread → prompt → agent works on the
        laptop’s real filesystem → reply streams back → notification
```

New project: Code mode → `+` → `+Build` → new folder → prompt.
Sub-agents: thread → ⊕ spawn → they run as child sessions on the laptop.
Everything the agent does is on the laptop — the phone is the remote.
