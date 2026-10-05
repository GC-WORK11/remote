# os-bridge wire protocol v0.9

Transport: WebSocket at `ws://<tailnet-ip>:8790/ws`. Encryption: WireGuard
(Tailscale) — the daemon binds the tailnet IP only. App-level auth on top.
`GET /` (any other path) returns an unauthenticated JSON diagnostics blob
(name/version/uptime/sessions) so any tailnet browser can check the rig.

## Authentication

- **Pairing**: `omprd pair` (or `ompr pair`, or `omprd --qr` on the daemon's
  stdout) mints a one-time code (10 min TTL) and prints BOTH a terminal-rendered
  QR and a deep link `remote://{best-host}:{port}#{code}` — best-host resolves
  Tailscale interface IP → LAN IP → 127.0.0.1, the same address the daemon
  binds by default. The app's Scan screen (or manual paste) decodes the URI
  and pairs in one step; the `#fragment` is a 4–8-digit pair code or a token.
  An IPv6 host is bracketed (`remote://[fe80::1]:8790#…`). The QR encoder
  tops out at 271-byte payloads (v10-L); past that the daemon prints just
  the link — paste it instead of scanning.
  `{"type":"pair","code":"123456","device":"Pixel 9"}` → `{"type":"paired","token":"…"}`.
  Rate-limited: token bucket, 5 attempts then ~1/min per connection.
- **Token**: `Authorization: Bearer <token>` on the WS upgrade — or
  `?token=<token>` on the `/ws` URL for browser clients (JS WebSocket cannot
  set headers). Hashes compared constant-time. Revocation is live: delete the
  device from `~/.rig/devices.json`.
- **Kill switch**: `{"type":"rig.lock"}` (or `touch ~/.rig/locked`) — kills all
  sessions, refuses pairing AND tokens until the file is removed (picked up live).
- **Service token**: a per-boot random token minted in-process (never persisted,
  never logged). `spawn_omp_child` injects it into each omp child's env as
  `OMPD_TOKEN` together with `OMPD_WS` (`ws://<bind>:<port>/ws`) — only omp
  children ever see it. It authenticates exactly like a device token at the WS
  upgrade, but the connection is flagged `service`: excluded from session-frame
  broadcasts (request/reply only) so the child's bridge socket isn't flooded
  with rpc traffic. See *Agent-side computer access* below.
- Auth is per-connection, decided at upgrade time.

## Client → daemon

| Message | Effect |
|---|---|
| `pair` | one-time code → device token |
| `rig.status` | hostname, uptime, devices, sessions (with lastSeq), clients, `os`, and `keepawake {persistent, held, method, needsAdmin, lidCloseInhibitor, lidOverride {applied, method, needsPrivilege?}}` — `held` is true only while an OS-level sleep inhibitor is really held; `method` reports what is real: `iopm:idle+display`/`iopm:idle` (macOS), `logind`/`systemd-inhibit`/`systemd-inhibit(sudo)`/`systemd-inhibit(stale)`/`xss` (Linux — `xss` is screensaver-only, NOT sleep-proof), `execution-state` (Windows), `none`. `needsAdmin` (Windows) is true when the last lid-close override attempt was denied for privilege; `lidOverride` reports the lid-close state: `applied` + `method` (`powercfg` verified-by-requery, `needs-admin`, Linux `inhibitor`/`logind-dropin`/`elogind-dropin`, `none`), and on Linux `needsPrivilege` inside it is true when lid-close is unprotected AND the daemon can't write the drop-in itself — UI should show "needs sudo" and relay `lidClose.command` from a `rig.stayAwake` reply. A `systemd-inhibit` child killed mid-flight can orphan the inner lock-holding binary; `method:"systemd-inhibit(stale)"` reports that surviving foreign lock honestly, and `rig.stayAwake{on:false}` sweeps it |
| `rig.stats` | frame counters + latency percentiles (reservoir-sampled): bridge = omp-line→enqueue (µs), queue = enqueue→socket (ms), plus `linesIn`/`linesParsed` (conditional-parse counters), `warmSpares`/`warmCap`, `compactPct` |
| `rig.lock` | kill switch (kills sessions, locks rig) |
| `rig.stayAwake {on, persistent?}` | `on` holds a keep-awake assertion (`held` in reply). `persistent:true` keeps it beyond session lifetime and additionally attempts **lid-close prevention** per OS — macOS `sudo -n pmset -a disablesleep 1 tcpkeepalive 1` first (a one-time grant via `install.sh --with-lid` or root-installed daemons engage it with zero prompts), bare `pmset` as fallback; Windows `powercfg lidaction` AC+DC; Linux tiers: unprivileged `systemd-inhibit --what=handle-lid-switch:sleep` child → write `/etc/systemd/logind.conf.d/90-omprd-lid.conf` (`HandleLidSwitch=ignore`, via `sudo -n` when needed — persistent across reboots, removed on `rig.stayAwake{on:false}`; elogind gets `/etc/elogind/logind.conf.d/`) → `needs-root`. Reply reports `lidClose {attempted, ok, needsPrivilege, needsAdmin, method, reason, previous{ac,dc}, restored, command, restore}` — on Windows the set is only `ok` when a post-write re-query reads back 0/0 (powercfg's exit code alone lies on lidless hardware, where the reply instead says `method:"no-lid"`), a failed-but-zero-exit write reports `method:"needs-admin"` + the exact elevated `command`, and `on:false` restores the pre-override `previous` indexes (`restored:true` on success); on Linux a denied-everything reply is `method:"needs-root"` + `command:"sudo os-bridge/install.sh --lid"` + `restore`, plus a `wifi` block (`iw dev <if> set power_save off` attempted per wireless iface — a dozing NIC is unreachable even when the box stays up). The daemon also takes `--keep-awake` (default ON — hold the OS inhibitor from boot) / `--no-keep-awake`; macOS holds dual IOPM assertions in-process (`iopm:idle+display`, equivalent to `caffeinate -dis`), Linux prefers logind `Inhibit("sleep",…)` over D-Bus then a `systemd-inhibit` child, Windows sets `ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED|ES_AWAYMODE_REQUIRED`. Modern-Standby (S0) caveat: lid override can't stop a WoWLAN-less NIC from sleeping — omprd survives but the link may not |
| `rig.authStatus {timeoutMs?}` | runs `omp auth-broker status` on the host and returns `{ok, code, timedOut, output}` (bounded capture). Provider auth lives in omp's vault **on the laptop** — clients see provider ids/state, never credentials. |
| `rig.models` | parses `~/.omp/agent/models.yml` and returns `{providers:[{id, api, baseUrl, keyConfigured, ready, models:[{id, name, spec("provider/id"), input[], reasoning, thinking?, contextWindow, maxTokens, cost, ready}]}], defaultModel, path}`. `keyConfigured` is true for a literal key or a resolvable `$VAR`/`env:VAR` ref; `ready` = keyConfigured OR an oauth row in the agent vault. Credentials are never sent — `apiKey` is stripped before the reply. Measured on the reference rig: **~10.6 ms round-trip** for a 2-provider file (10-run min) |
| `auth.list` | provider catalog + vault state (`auth.list` reply) for the login sheet |
| `auth.login {provider, key?}` | `auth.started {provider}` → spawns `omp login <provider>` on the host and streams its stdout as `auth.event {provider, kind, text}` — `kind:"url"` carries the OAuth URL for the phone to display ("open on laptop"), `"line"`/`"prompt"` progress, `"done" {code}` ends it, then `auth.changed`. Optional `key` is written to the child's stdin the moment it prompts (api-key providers). Single-flight: a second login while one runs gets an error |
| `auth.input {text}` | writes a line to the login child's stdin (code paste, y/n) → `auth.inputAck {ok}` |
| `auth.cancel` | kills the login child → `auth.cancelAck {ok}` |
| `session.new {sessionId?, cwd?, tools?, model?, thinking?, yolo?, ompBin?}` | spawn omp; **`session.started` is only sent once omp's RPC handshake succeeds** — never a half-born session. `tools` maps to omp `--tools` (e.g. computer/browser), `yolo` adds `--auto-approve`, `ompBin` overrides the omp binary for this session. Thinking folds into the model spec as `provider/model:level` (rig default `RIG_THINKING`, `"low"`). **Warm pool**: a session whose spawn signature was seen before is adopted from a spare child that already completed the handshake — repeat `session.new`→`session.started` measured ~2 ms vs ~0.7–1.4 s cold. Pool: ≤1 spare per signature, `RIG_WARM_MAX` total (default 2), `RIG_WARM=0` disables. `session.started` carries `warm:true` on adoption. |
| `session.kill {sessionId}` | terminate that omp process group: SIGTERM first, a watchdog escalates to SIGKILL ~3 s later if the pid is still alive — the tree can never outlive the request |
| `session.spawn {parentId, sessionId?, prompt?, title?, cwd?, …session.new opts}` | spawn a **child session** under `parentId`: the parent's `cwd` is inherited when `cwd` is empty, every `session.new` option applies, and `prompt` is delivered to the child as its first turn (same path the scheduler uses — lands after the omp handshake). Replies `session.spawned {sessionId, parentId}` (also broadcast so every attached client refreshes). Lineage is persisted in the meta (`parent`) and surfaces as `parentId` in `sessions.list`/`sessions.tree`. Caps: spawn depth 6, ≤16 live children per parent — honest errors `spawn depth limit (6)` / `sub-agent limit (16 live children)`; `no such parent session` for a dead/absent parent. **Inheritance**: an empty `cwd` takes the parent's, and unset `model`/`thinking` are copied from the parent's spawn opts — a child never silently downgrades to the rig default model. SCOPE_OPERATE — agents running inside omp children already hold `OMPD_WS`+`OMPD_TOKEN`, so a fork-side tool can call this RPC. **Self-parenting for in-session callers**: `parentId:"self"` (or `"auto"`), or an omitted `parentId` **with** `callerPid`/`pid` set to a pid inside a session's process tree, resolves the parent by walking the ppid chain (`session_for_pid` — omp → tool → bash → any depth, ≤32 hops; covers warm-pool spares too since identity is ancestry, not env). `self`/`auto` without `callerPid` errors honestly (`parentId "self" needs callerPid…`); an unresolved caller gets `caller pid N is not inside a rig session` for `self`, while a merely-empty `parentId` falls back to a top-level session as before |
| `sessions.tree` | `sessions.list` rows plus `parentId`, `children:[ids]`, `depth` — the parent→children map clients render as the sub-agents section |
| `session.forPid {pid}` | resolves a process id (or `callerPid`) to its owning session by walking the ppid ancestry to a session's omp process — reply `{ok, sessionId|null, cwd?, parentId?}`. Any pid inside the session's tree works: the omp pid itself, a bash/exec/tool grandchild, an MCP-server descendant. READ-scoped — how in-session tooling learns its own sessionId without an env var |
| `session.wait {sessionId, timeoutMs?}` | the join half of spawn — long-poll (worker thread, 250 ms tick, timeout clamped 1 s–10 min, default 5 min) until the target's turn settles: `busy` flips false after being seen true, any seq progress then idle, the process exits, or the deadline hits. Replies `session.wait.result {ok, sessionId, busy, running, lastSeq, preview, timedOut, gone}` — `gone:true` when the session was deleted mid-wait. Fast turns are caught by the seq-progress check even when `busy` was never observed true. READ-scoped; the caller's socket just waits for one reply |

| `sessions.list` | live sessions (id, cwd, pid, lastSeq, createdAt, lastAt — epoch ms, busy — a turn is in flight, preview — last assistant line ≤140 chars, `parentId` — `""` for top-level). `busy` sets on `agent_start` and clears on `prompt_result`, `session_settled`, `agent_end`, a failed `auto_retry_end`, or session exit |
| `rig.vitals` | host health probe — `{ok, os, probedAt, battery:{pct,state,charging,source}|null, uptimeSec|null, load:[1,5,15]|null, cpuPct? (Windows), disk:{free,avail,total}|null, mem:{total,avail,usedPct}|null, net:{ssid,if?}|null}`. Per-OS: macOS `pmset -g batt`/`sysctl kern.boottime`/`vm_stat`/`ipconfig getsummary en0`, Linux `/sys/class/power_supply`/`/proc/uptime`/`/proc/meminfo`/`iwgetid`, Windows `Win32_Battery`/`GetTickCount64`/`GlobalMemoryStatusEx`/`netsh wlan`. Every field independently null on failure — never a fabricated number. READ-scoped, runs on a worker |
| `session.subscribe {sessionId, since}` | replay ring-buffered frames with `seq > since` (marked `"replay":true`), then live; ack `session.subscribed {replayedTo, liveSeq}` — note replay frames precede the ack on the wire. Replays are snapshotted under the ring lock then throttled against the client outbox — a burst can no longer silently kill the connection; once over the soft cap the producer waits for the queue to drain to a low-water mark (hysteresis — the queue stops hovering full where live frames starve), and if the client still can't keep up within ~4 s the daemon sends `{error:"replay truncated: client too slow — resubscribe to continue"}` and you can `session.subscribe` again from `replayedTo`. `since` must be a non-negative integer (unsigned/positive int, or a numeric string like `"42"`) — anything else gets `{type:"error", error:"since must be a non-negative integer seq"}` |
| `rpc {sessionId, frame}` | transparent passthrough — client manages its own command ids; every emitted frame is broadcast with a `seq`. Protocol-v2 `rpc_chunk` parts (omp splits frames >1 MB) are reassembled by the daemon — clients only ever see whole frames |
| `session.request {sessionId, frame}` | daemon-correlated — response delivered privately to you as `session.response`. Optional wire hint `frame._slim: true` asks the daemon to rewrite large catalog responses (`get_available_models`) to the field subset a picker needs — ~10× smaller over the wire; the hint is stripped before omp sees it |
| `session.usage {sessionId}` | convenience: correlated `get_state`; read `frame.data.contextUsage` (tokens / contextWindow / percent) — the token-efficiency gauge |
| `sessions.subagents` | **master fan-out**: `get_subagents` across every session, aggregated into `{results:[…]}` |
| `sessions.compact {instructions?}` | **master fan-out**: compaction across every session |
| `sessions.abortAll` | abort current run in every session |

## Daemon → client

`paired`, `session.started`, `session.exited {code, lastSeq}`,
`session.spawned {sessionId, parentId}` (spawn reply + broadcast),
`session.subscribed`, `rpc {sessionId, seq, replay?, frame}`,
`session.response {sessionId, id, frame}`, `sessions.subagents`,
`sessions.tree`, `rig.vitals`, `rig.pr.result`,
`sessions.compact {results, partial?}`, `session.autoCompact`,
`rig.fs.result`, `ok`, `error {error}`,
plus diagnostics `rig.status` / `rig.stats`.

## Reconnect contract

Every `rpc` frame carries a monotonic `seq`. On reconnect: `sessions.list`
(or remember ids) → `session.subscribe {since: lastSeqYouSaw}` → exactly-once
continuation (ring holds the last 4096 frames / 32 MB per session).

## Daemon-restart persistence

The ring contract survives omprd restarts: every emitted frame is also appended
to `~/.rig/sessions/<id>.jsonl` and spawn opts to `<id>.meta.json`. On boot the
daemon restores each session — inbox rows, previews, `lastAt` (file mtime),
seq numbering, and the full frame ring — with `alive:false` in `sessions.list`
(a restored session has no process yet). A `session.request`/`rpc` to it
lazy-respawns the omp child and broadcasts `session.started {resumed:true}`.

The respawned child is handed `open_session {sessionDir:
~/.rig/sessions/<id>/omp}` at handshake, so omp re-attaches to its own
transcript file — the agent keeps memory across restarts (`resumed:true`,
same session id/file). omp binds the same dir at first spawn too, so the
transcript exists from the first turn.

Semantics: natural session exit deletes the persisted files (sessions stay
ephemeral); daemon shutdown keeps them for the next boot. A torn tail line
(kill mid-write) is dropped at restore. In-flight turns at kill are not
resumed — the agent replays them idempotently on the next prompt.

## Native execution — `rig.exec`

The fastest command path: C++ fork/exec against /bin/bash, no agent, no model.

| Message | Effect |
|---|---|
| `rig.exec {command, cwd?, timeoutMs?}` | `exec.started {execId}` → `exec.output {execId, chunk}` streamed as it runs → `exec.done {code, durationMs, timedOut}`. `chunk` is always valid UTF-8 — output is sanitized chunk-wise with a split-sequence carry; if bytes were lost/altered the frame also carries `chunkB64` (base64 of the raw bytes — take it over `chunk` for lossless pipes). `timeoutMs` clamps 100..600000 and kills the whole process group (grandchildren too); a client disconnect reaps its in-flight execs |
| `rig.execKill {execId}` | kill that exec's process group |

Measured on the reference rig: **1.3–1.6 ms round-trip** for `echo hi` (10-run min/avg).

## Native filesystem — `rig.fs.*`

Pure-C++ file ops, no shell and no agent in the loop (daemon/rigfs.hpp).
read/write answer inline; glob/grep run on a worker thread so a big scan can't
stall the client reader. Every request may carry `id` — the reply
`rig.fs.result` echoes it for correlation — and `cwd` — relative paths resolve
against it, else `$HOME`. Replies include `tookUs` (daemon-side op time, µs).

| Message | Params | Reply fields (`rig.fs.result` +) |
|---|---|---|
| `rig.fs.list` | `path?`, `cwd?`, `showHidden?`, `maxEntries?` (default 2000, cap 20000) | `{ok,path,entries:[{name,type:"dir|file|link|other",size,mtimeMs}],truncated}` — dirs first, then A→Z; powers the app's folder browser |
| `rig.fs.mkdir` | `path`, `cwd?` | `{ok,path,created}` — recursive (`-p` semantics), `created:false` when it already existed |
| `rig.fs.stat` | `path`, `cwd?` | `{ok,path,exists,kind:"dir|file|link|other",size,mtimeMs}` — `exists:false` short-circuits |
| `rig.fs.read` | `path`, `offset?`, `maxBytes?` (default 4 MB, cap 64 MB) | `{ok,path,size,mtimeMs,offset,truncated,content}` — UTF-8 text as `content`, anything else as `contentBase64` |
| `rig.fs.write` | `path`, `content` or `contentBase64`, `append?`, `mkdirs?` (default true), `mode?` | `{ok,path,bytes}` — non-append writes are atomic: tmp `path.rigfs-*.tmp` + fsync + rename |
| `rig.fs.glob` | `pattern`, `cwd?`, `filesOnly?` (default true), `maxResults?` (default 5000, cap 50000) | `{ok,matches:[{path,size,mtimeMs,dir}],count,scanned}` — glob syntax `**` `*` `?` `[…]` `{a,b}` matched against the path relative to cwd |
| `rig.fs.grep` | `pattern`, `cwd?`, `regex?`, `caseInsensitive?`, `glob?`, `context?` (0–8), `maxResults?` (default 500, cap 20000), `maxFileBytes?` (default 32 MB) | `{ok,matches:[{path,line,col,text,context?}],count,scannedFiles}` — literal-string fast path unless `regex:true` or the pattern has regex metachars; `glob` uses ripgrep `-g` semantics (slash-free = basename at any depth) |

Interactive terminals (POSIX only for now — `rig.term.open` on Windows returns an
error until the ConPTY backend lands). One pty per `term.open`, max 8 per daemon;
frames are per-connection — a second client cannot see or type into another's
shell, and disconnecting kills every pty that client opened.

| Message | Params | Reply / events |
|---|---|---|
| `rig.term.open` | `cwd?`, `cols?` (8–500, default 120), `rows?` (4–200, default 32), `shell?` (default `$SHELL`, fallback `/bin/bash`) | `term.opened {termId,pid,shell}` → then `term.out {termId,seq,data[,dataB64]}` frames until `term.exit {termId,code}`. `data` is UTF-8-cleaned; `dataB64` carries the raw bytes when any were scrubbed |
| `rig.term.in` | `termId`, `data` or `dataB64` | no ack — the echoed output via `term.out` confirms it |
| `rig.term.resize` | `termId`, `cols`, `rows` | `ok` — applies `TIOCSWINSZ` so full-screen TUIs lay out correctly |
| `rig.term.close` | `termId` | `ok` — SIGHUPs the process group; `term.exit` still arrives |

Pull-request state rides the laptop's own `gh` CLI — whatever credentials the
user set up there just work. When `gh` is missing or unauthed the reply is
`ok:false` with the real error text so the client can keep its honest empty
state instead of fabricating checks.

| Message | Params | Reply / events |
|---|---|---|
| `rig.pr.info` | `url` (http(s) PR URL; `GH_BIN` env on the daemon overrides `gh` discovery) | `rig.pr.result` — `{ok:true}` + `number,title,state,isDraft,mergeable,additions,deletions,headRefName,baseRefName,author,files[{path}],statusCheckRollup[{name,state,conclusion}],reviews` verbatim from `gh pr view --json`; `{ok:false,error}` (≤200 chars of real stderr) when `gh` is absent or the call fails |
| `rig.pr.checks` | `url` | `rig.pr.result` — `{ok:true, checks:[{name,state,bucket,workflow,link,startedAt,completedAt}], rollup:{pass,fail,pending,skipped,total,state:"pass"|"fail"|"pending"|"none"}}` from `gh pr checks --json` (gh exits non-zero on fail/pending but still prints JSON — parsed either way); `{ok:false,error}` when `gh` is absent/unauthed |
| `rig.pr.create` | `cwd` (required, must exist), `title` (or `fill:true`), `body?`, `draft?`, `base?`, `head?` | `rig.pr.result` — `{ok:true, url, output}` where `url` is the last https:// token `gh pr create` prints; `{ok:false,error,output}` on failure. Runs inside `cwd` so the repo's own remote/auth applies |

Measured on the reference rig: `rig.fs.read` **~37 µs** daemon-side,
`rig.fs.grep` over a generated 1008-file corpus **~23 ms** — see
test/client5.py for the enforced budgets (read <2 ms, grep-1000-files <50 ms).

## Auto-compact

After each `prompt_result` the daemon re-reads `contextUsage` via a private
correlated `get_state`. At ≥ `RIG_COMPACT_PCT`% of the context window
(default **85**, `0` disables; 60 s cooldown) it issues a `compact` itself and
broadcasts `session.autoCompact {sessionId, tokens, window}` so clients can
surface it. `linesParsed` in `rig.stats` shows the conditional-parse rate —
passthrough frames are forwarded without JSON parsing.

## Computer use — `computer.*`

One protocol, one native backend per OS, all `dlopen`/`LoadLibrary` at runtime —
**zero compile-time deps**, subprocess fallback when the native path is missing.

| OS | Backend | Inject | Capture | Agent display |
|---|---|---|---|---|
| Linux | `x11.hpp` (`backend:"x11"`) | libXtst XTest (µs) | MIT-SHM `libXext` → libpng-l1/stb | Xvfb+WM on `:99` (auto-booted) |
| macOS | `mac.hpp` (`backend:"coregraphics"`) | CGEvent HID-tap posts (needs **Accessibility**) | `CGWindowListCreateImage` → libpng-l1 (if present) else ImageIO jpeg/png (needs **Screen Recording**) | real session display (`"main"`) |
| Windows | `win.hpp` (`backend:"win32"`) | `SendInput` via user32 | BitBlt/GetDIBits → GDI+ jpeg/png | real session display |

| Message | Effect |
|---|---|
| `computer.boot {display?, width?, height?}` | bring up Xvfb (virtual) + WM on Linux; on macOS/Windows re-reads real display size |
| `computer.state` | `{display, xvfbAlive, resolution, nativeBackend, backend, shm, xtest, perms:{inject,capture}, scaleFactor, displayOrigin {x,y}, pixelResolution}` — `perms` reports whether injection/capture are actually allowed right now. `resolution`/`displayOrigin` describe the **capture space**: the union of all display bounds in global coordinates (origin may be negative with a display left/above the main one) — the same space screenshots, window rects and CGEvent/XTest coords share. `scaleFactor` is the measured shot-px/point ratio (truth after the first full-frame grab, display-mode value before), `pixelResolution` the display in pixels. |
| `computer.perms {request?}` | same perm map plus a per-OS `hint` telling you how to grant what's missing (macOS TCC pane names, Windows session-0 note, X11 libXtst/libXext packages); `request:true` triggers the OS grant prompts (macOS TCC) |
| `computer.screenshot {format?, quality?, scale?, region?, wid?}` | → `{imageBase64, format, encoder, width, height, bytes, tookMs, captureMs, encodeMs, method, savedTo}`; `wid` scopes the shot to one window — `method:"window"`; macOS renders the window even occluded or on another Space (the session-workspace contract). X11/win32 return an honest error instead of degrading to a full-screen shot. Unset → full display everywhere; **jpg is the default** (~25 ms @1080p vs ~110 ms png), `encoder` reports the real backend (`turbojpeg`/`libpng-l1`/`stb`/`imageio`); `quality` floor is 5; `captureMs`/`encodeMs` split grab vs encode. `scale`<1 downscales on the CPU before encode (box average) |
| `computer.observe` | screenshot + cursor + window list in one round trip (the agent's ground-state call); same split fields as `computer.screenshot` |
| `computer.click {x,y,button?}` / `computer.doubleclick` | move + press/release. Coordinates are display pixels; to click in screenshot space send `shotW`/`shotH` with the shot's pixel size and the daemon scales x/y to the display (also honored on scroll x/y, drag endpoints, gesture x,y,x2,y2). Display space = the capture space from `computer.state` — multi-monitor offsets handled, negative global coords legal. A `display` of `:N.S` names screen S on multi-screen X servers — motion warps to that screen's root (with a bounded verify+retry, ~120 ms worst case, since some servers drop the first cross-screen warp). For a region capture add `shotX`/`shotY`/`shotRW`/`shotRH` naming the captured area's **capture-space** origin and native size (shotX is union-local, *not* global), and shot-space coords map back exactly. All injected input is serialized daemon-side: one whole action, and one whole `computer.actions` batch, lands atomically — a second client's burst can never interleave mid-click, mid-drag, or mid-string. |
| `computer.type {text, delayMs?}` | keystroke injection; full UTF-16 on macOS (chunked unicode press/release per char), any keysym on X11 — missing keysyms (unicode > latin-1) are temporarily mapped onto a free keycode via XChangeKeyboardMapping, then restored. |
| `computer.key {combo}` | `ctrl+plus`, `cmd+space`, `Return` — mods: ctrl/alt(or option)/shift/meta|cmd|super|win |
| `computer.scroll {direction, times, x?, y?, dx?}` | wheel up/down at the pointer; `dx` adds horizontal wheel |
| `computer.drag {fromX,fromY,toX,toY,steps?}` | press → interpolated motion → release |
| `computer.gesture {op, …}` | touch-style ops for direct control: `tap {x,y}`, `doubleTap {x,y}`, `longPress {x,y, durationMs?}` (default 600), `swipe {x1,y1,x2,y2, durationMs?, steps?}` (default 300 ms / duration÷12 steps), `drag {x1,y1,x2,y2, durationMs?, steps?}`. `x`/`y` or `from*`/`to*` aliases accepted. Reply is the standard action envelope `{ok, action:"gesture", gesture:op, method, tookMs, cursorAfter}`; unknown ops return `ok:false` with an `error` field. A backend without injection returns `ok:false` + `detail` — never a crash. |
| `computer.actions {steps:[…], stopOnError?, sessionId?}` | batched actions, one round trip — `gesture` steps batch like any other action; `sessionId` is inherited by every step that doesn't carry its own (launch tracking / workspace attribution) |
| `computer.cursor` | pointer position → `{x, y, method}`; on multi-screen X displays the fallback reply also carries `screen` (the index the pointer is actually on — a `display.screen` query when the pointer sits on another screen reports it there, not the queried screen's coords) |
| `computer.launch {app, args?}` | detached spawn on the agent's display. Reply carries `frontmost` (the focused window's process name — macOS `NSWorkspace`, Linux `_NET_ACTIVE_WINDOW`+`_NET_WM_PID`→`/proc/comm`, Windows `GetForegroundWindow`→exe basename). The daemon waits, bounded, for the launched app to actually take focus before replying so typed keystrokes don't land in the previous window (≤1.5s Linux — also bails early if the child exits, so CLI launches don't stall; ≤3s Windows; ≤5s macOS via LaunchServices/`open -a` re-activation). |
| `computer.windows` | window list `{id,app,pid,title,x,y,w,h,active}` (`app`/`pid` may be empty/0 where the OS can't map a window to a process) |
| `computer.window.activate {id|title}` / `computer.window.close` | raise / close a window — macOS frontmosts the owning app (NSRunningApplication `activateWithOptions:AllWindows|IgnoringOtherApps` via objc runtime, `open -a` fallback), X11 sends `_NET_ACTIVE_WINDOW` |
| `computer.waitWindow {title, timeoutMs?}` | resolve when a matching (un)map happens |
| `computer.watch {intervalMs?, idleIntervalMs?, idleAfterMs?, threshold?, format?, quality?, scale?, region?}` | push screen-share: `computer.watching {watchId}` then `computer.frame {watchId, seq, imageBase64, width, height, bytes, delta, encoder, cadenceMs, tookMs, captureMs?, encodeMs?}` pushed **only when pixels change** — a 160×100 thumb mean-abs-diff ≥ `threshold` (default 2). First frame always sent. **Adaptive cadence**: `intervalMs` (50–60000, default 250) is the hot tick rate; after `idleAfterMs` (default 1500) with no change the tick relaxes ×1.5 per tick up to `idleIntervalMs` (default 2000), snapping back to `intervalMs` on the next change — `cadenceMs` in each frame reports the rate it was sent at. `region {x,y,w,h}` (capture-space points) watches a sub-rectangle only. Probe/encode split: idle ticks pay only grab+thumb, the encode runs after a real change. **Adaptive quality**: when the client's write outbox is backed up (>256KB), the daemon degrades `quality`/`scale` per frame (heavier tiers at >2MB) rather than buffering frames a slow link can't drain — frames sent degraded carry `adaptive:true` plus the effective `quality`/`scale` used, so the client knows `shotRW`-space mapping for that frame. |
| `computer.unwatch {watchId?}` | stop a watcher (all watchers if omitted). Watchers self-remove when their client disconnects. |
| `computer.space {action, sessionId?}` / `workspace.new|enter|leave|status {sessionId}` | per-session workspace isolation — `workspace.*` is the uniform alias over the same machinery; replies carry `kind` (`fullscreen-space`/`virtual-desktop`/`ewmh-desktop`) saying what the OS really made, `workspace` (owning app on macOS / desktop index elsewhere), and `windows` (window ids the session's launches produced — tracked by pid). `new` creates and enters a fresh workspace owned by the session (remembered as `Session.desktop`/`fs_app`); `enter` switches back to it; `leave` restores whatever was frontmost before; `status` reports current state. Linux/X11: EWMH desktops via `_NET_NUMBER_OF_DESKTOPS`/`_NET_CURRENT_DESKTOP` client messages (needs an EWMH-compliant wm — openbox/icewm/xfwm4/kwin etc.) and spawned windows are routed to the session's desktop via `_NET_WM_DESKTOP`. macOS: no public Space API, so `new` injects ⌃⌘F — a fullscreened window IS its own Space — and `enter`/`leave` activate the owning/previous app; isolation is honest-fallback: the session's windows are tracked by pid and `computer.screenshot {wid}` captures them even when occluded. win32: per-session virtual desktop via the internal `IVirtualDesktopManagerInternal` COM service on Win11/Win10 2004+ (`new` creates + switches, `enter` re-switches, `leave` hops back; spawned HWNDs are routed there with `IVirtualDesktopManager::MoveWindowToDesktop`); on older builds without the service it falls back to Win+Ctrl+D / Win+Ctrl+F4 / Win+Ctrl+←·→ key chords (index/status can't be read back that way). |

### Screen recording — `computer.record.*`

Watch streams frames to one client; recording writes them to disk so they
outlive the connection **and the daemon**. One recording at a time. Each
recording is a directory `~/.rig/recordings/<id>/` holding `f-000001.jpg …`
frames, `times.txt` (`seq\t<capture-offset ms>` per frame), and `meta.json`
(id, startedAt, durationMs, frames, dropped, fps, width, height, scale,
intervalMs, format, live). Frame files are renamed into place atomically, so
readers never see a partial JPEG. `list` recounts frames/bytes from disk
rather than trusting meta, so a daemon killed mid-record still lists the
partial recording truthfully (its meta keeps `live:false` absent/last-frame
duration).

| Message | Effect |
|---|---|
| `computer.record.start {intervalMs?, maxDurationMs?, scale?, quality?, region?}` | → `computer.recording {id, live:true, startedAt, intervalMs, maxDurationMs, scale, quality, display, region?}`. `intervalMs` 50–10000 (default 250), `maxDurationMs` safety cap 1000–3600000 (default 600000 — 10 min), `scale` default 0.5, `quality` 5–100 (default 70), `region {x,y,w,h}` records a capture-space sub-rect. Errors `{error:"already recording", recordingId}` while one is live. |
| `computer.record.stop {id?}` | → `computer.recorded {id, startedAt, durationMs, frames, dropped, fps, bytes, width, height, scale, intervalMs, format, live:false, waitedMs}` (omitted `id` stops the live one). Stopping an already-finished id returns the same stats with `alreadyStopped:true`. |
| `computer.record.finished` | pushed to the starter when the capture ends without `record.stop` — `reason: "maxDuration"` (cap hit) or `"shutdown"` (daemon exiting), plus the full stats shape. The client pointer is detached on disconnect; the recording itself keeps going. |
| `computer.record.list` | → `computer.recordings {recordings:[{id, startedAt, durationMs, frames, dropped, fps, bytes, width, height, scale, intervalMs, format, live, mp4}]}`, newest first. Reads the recordings directory — recordings survive daemon restarts. |
| `computer.record.get {id, format?}` | `format:"meta"` (default) → `computer.recording {id, …stats, path, mp4}` (live stats merged when it's the in-flight one). `format:"mp4"` → lazy `ffmpeg -framerate <fps> -i f-%06d.jpg -c:v libx264 -pix_fmt yuv420p -movflags +faststart` into `<dir>/video.mp4`, cached after first build; → `computer.recording {id, format:"mp4", path, bytes, tookMs, dataBase64?}` — `dataBase64` present only when ≤ 6 MB (client outbox is 8 MB), else `tooLarge:true`. Errors when ffmpeg is not on PATH — the frame endpoints still fully work. |
| `computer.record.frames {id, from?, count?}` | range fetch for in-app playback: → `computer.record.frames {id, from, nextFrom, total, count, frames:[{seq, t, imageBase64, bytes}]}` — `from` is 1-based (default 1), `count` ≤ 500 (default 60) with a ~4 MB payload cap per reply; page with `nextFrom` until it exceeds `total`. `t` is the frame's capture offset in ms (playback pacing), `total` the frames on disk (grows while live). |
| `computer.record.delete {id}` | → `ok {for, id, deleted:true}`; refuses while that recording is live (stop it first). |

Linux liveness is verified by **connecting to the X socket**, never by PID. On
macOS `xvfbAlive` is kept for protocol shape but is always true — capability
lives in `perms`. Injection and capture each fail **visibly** (error replies /
per-call `method` falls back to subprocess names) — never silently.

Keep-awake: on macOS the daemon holds `IOPMAssertion(PreventUserIdleSystemSleep)`
while ≥1 omp session is alive, released when the last exits.

**Known issue:** snap-packaged Firefox (Ubuntu default) quarantines `/tmp` and
runs unkillable broker processes — use native apps or a non-snap browser for
browser automation on the agent display.

**macOS unicode typing:** `CGEventKeyboardSetUnicodeString` events must be
created with a real `CGEventSource` — events with a null source are silently
dropped by modern macOS (real-keycode events aren't affected, which is why
`computer.key` worked while `computer.type` didn't). The backend shares one
`kCGEventSourceStateHIDSystemState` source for all unicode press/release pairs.

## Agent-side computer access — `rig_computer` (omp ↔ daemon bridge)

The model inside omp drives the same `computer.*` surface a phone client does —
no second backend, no permission re-grants, identical semantics across OSes.
Design: omprd spawns omp → omp opens a **loopback WS back to its parent** → the
fork's `rig_computer` tool forwards each call as a `computer.*` message.

```
omprd ──spawn(env: OMPD_WS, OMPD_TOKEN)──▶ omp ──WS ?token=──▶ omprd /ws
                                                    (service channel)
```

- **Daemon side** (`omprd.cpp`): mints `g_service_token` (32-byte random hex) at
  boot; injects `OMPD_WS`+`OMPD_TOKEN` in `spawn_omp_child` (covers cold spawns
  AND warm-pool spares — same code path). A service-authed `Client` gets
  request/reply only: `broadcast()` skips it, so phone-client traffic never
  corrupts the bridge's reply correlation.
- **Fork side** (`packages/coding-agent/src/tools/rig-computer.ts`, patch
  `engine/patches/001-rig-computer-tool.patch`): `RigComputerTool` registers
  only when both env vars exist (`createIf` → absent outside omprd). One tool,
  `op` enum covering state/perms/cursor/screenshot/observe/windows/waitWindow/
  activate/close/click/doubleclick/type/key/scroll/drag/gesture/launch/batch;
  `display` forwards per-call. `OmpdBridge` serializes requests on one socket
  (lazy connect, `#tail` promise chain, drops `rpc`/`session.*` frames that
  arrive while awaiting, closes the socket on timeout so a late reply can't
  poison the next request).
- **Images to the model**: `observe`/`screenshot` replies split into a JSON
  meta text block + real `ImageContent` (base64 jpeg/png) — the model sees the
  actual frame, not an OCR approximation.
- Tool flags: `approval:"exec"` (computer control is as powerful as shell),
  `loadMode:"essential"` (always in the schema list), `intent:"optional"`,
  `strict:true`, `interruptible:true`. Prompt text lives in
  `src/prompts/tools/rig-computer.md` per fork rules.

## Agent-side wire calls — `$OMPD_RIG_CALL`

The same service channel lets the model call ANY daemon op from inside a turn —
not just `computer.*`. `spawn_omp_child` also injects `OMPD_RIG_CALL`, pointing
at `~/.rig/rig-call`: a bun shim the daemon materializes at boot (rewritten when
its content changes, chmod 0755 — works in dev and installed layouts alike).

```
"$OMPD_RIG_CALL" <op> '<json-args>'          # prints the reply JSON
"$OMPD_RIG_CALL" --no-wait <op> '<json>'     # fire-and-forget
"$OMPD_RIG_CALL" --wait <ms> <op> '<json>'   # bound the reply wait
```

The shim sends `{type:<op>, id:1, callerPid:process.pid, …args}` over the
service socket, prints the first reply whose `id`/`frame._cid` correlates, and
exits 1 on a wire `error` (timeout: `OMPD_CALL_TIMEOUT_MS`, default 120000).
`callerPid` is the key: `session_for_pid` walks the ppid ancestry from the
calling process (omp → tool → bash grandchild → MCP-server descendant, ≤32
hops) to its session, so `session.spawn` needs no `parentId` and
`session.forPid` answers "which session am I in" for any descendant — ancestry
works where an env var cannot (warm spares exec before their sessionId exists).

Every omp child is also spawned with `--append-system-prompt=<RIG_CAPS_PROMPT>`
— a "§ Pocket Rig" note appended after omp's own generated system prompt that
tells the model the ops exist (session.spawn, sessions.tree, sessions.list,
session.request, rig.status/rig.vitals, computer.screenshot, rig.pr.*), their
exact call shapes, and the judgment rule: spawn a child per independent
parallel track, never for trivial/sequential steps. So the harness's
intelligence is real context, not a faked prompt or a scripted call — the
model decides when to spawn.

## Token ledger

| Message | Effect |
|---|---|
| `session.usage {sessionId}` | correlated `get_state` → `contextUsage` |
| `session.stats {sessionId}` | correlated `get_session_stats` (omp's full stats) |
| `rig.usage` | per-session live/peak tokens + context window, prompt-cache accounting, plus exec latency stats (count/min/avg/max) |

The daemon harvests `contextUsage` from every `get_state` response that flows
through it, so `rig.usage` reflects the last observed truth without polling.
Each session also carries `cache {in, out, read, write, hitPct}` harvested off
every parsed omp frame (anthropic `cache_read_input_tokens` /
`cache_creation_input_tokens`, openai `prompt_tokens_details.cached_tokens`,
deepseek `prompt_cache_hit_tokens`), with a `totals.cache` rollup — the
prompt-cache efficiency gauge.

## The `frame` payload = omp RPC, unchanged

Verbatim [omp RPC commands/events](../omp-src/packages/coding-agent/src/modes/rpc/rpc-types.ts):
`prompt`, `abort`, `steer`, `follow_up`, `get_state`, `get_messages`,
`get/available_models`, `set_model`, `set_thinking_level`, `compact`,
`set_auto_compaction`, `get_subagents`, `steer_subagent`, `cancel_subagent`,
`get_session_stats`, … with responses correlated by `id`, terminal
`prompt_result` per prompt, and `session_settled` when quiet.

`sessions.list` rows also carry `branch` — the session cwd's git branch
probed once at spawn/restore (`git -C <cwd> rev-parse --abbrev-ref HEAD`);
empty string when the cwd isn't a repo, git is missing, or the checkout
is detached.

`session.delete {sessionId}` removes a session for good. A live child is
killed and the reaper finishes its cleanup (`session.exited`); a dead or
restored session is erased inline — map, ~/.rig files, pending asks,
client delivery marks — and `session.deleted {sessionId}` broadcasts.

`rig.git.status {sessionId?|cwd?}` → `rig.git.result` with `{ok, branch,
ahead, behind, clean, files:[{path,status,staged,unstaged}]}` parsed from
`git status --porcelain=v1 --branch` in the session's (or explicit) cwd.
`rig.git.diff {sessionId?|cwd?, path?, staged?}` → `{ok, staged, path,
stat, diff}` — the real `git diff [--cached]` patch + `--stat` summary,
1MB-capped like other captures. Both reply on `rig.git.result` and fail
`ok:false` with the real git error outside a repo.

`rig.pr.merge {url, method:"squash"|"merge"|"rebase", deleteBranch?}` →
`rig.pr.result` with `{ok, method, output, error?}` — runs the host's
`gh pr merge` for real (same GH_BIN/type -P discovery as rig.pr.info).
ok:false carries gh's own stderr (e.g. unauthed host says so verbatim).

`rig.checkpoint.*` — per-turn worktree snapshots as hidden git refs
(`refs/rig/checkpoints/<sessionId>/<n>`). The daemon also auto-captures on
every `prompt_result` inside a git worktree — same tree as the latest
checkpoint skips the ref entirely, so passive turns cost nothing.
`rig.checkpoint.create {sessionId?|cwd?, label?}` → `{ok, ref, commit,
tree, n, stat}` (or `{ok, skipped, ref}` on a tree-identical capture).
`rig.checkpoint.list` → `{ok, checkpoints:[{ref, ts, label}]}`, newest
first. `rig.checkpoint.restore {ref, confirm?}` → dry-run by default:
`{ok, dryRun:true, wouldChange, wouldRemove}` (worktree-vs-ref name-status
+ `clean -nd` preview); `confirm:true` performs the rewind —
`restore --source=<ref> --staged --worktree -- .` + `clean -fd` — and
reports `{ok, restored, removed}`. All reply on `rig.checkpoint.result`.

`computer.ui.tree {pid?, depth?, limit?}` → `computer.ui.nodes` —
the target app's accessibility tree: `[{role,title,value,x,y,w,h,depth}]`.
pid 0/absent = topmost window owner on the claimed display (falls back
to the AX-focused app). depth ≤12, limit ≤2000; AX messaging is throttled
to 250ms/element so a hung app yields skipped nodes, not a hung rpc.
`computer.ui.press {pid?, title, role?}` → `computer.ui.result` — AXPress
the first element whose title/value contains `title` (role substring
filter optional). Verified: pressed Terminal's Shell menu by name in 0.2s.
`computer.ui.set {pid?, title, value}` → `computer.ui.result` — focus +
AXValue write on the first matching text field ("fill the API-key box").
Non-macOS backends report ok:false "unsupported" (compile-time off-ramp).

`session.rename {sessionId,title}` → `{ok,title}` + `session.renamed`
broadcast — user-facing thread name; the auto-title only fires on the
first prompt, so this is the persona wire.

`rig.schedule.add {prompt, cwd, everySec, model?, delaySec?}` →
`rig.schedule.added {jobId,everySec,nextRunMs}`. `rig.schedule.list` →
`rig.schedule.list {jobs:[…]}`. `rig.schedule.remove {jobId}` / 
`rig.schedule.enable {jobId,enabled}` → ok. Each fire spawns a fresh
session via session_start and delivers the prompt as a real prompt —
the turn's frames broadcast like any turn. Broadcasts: `schedule.fired
{jobId,sessionId}` and `schedule.error {jobId,error}`. Jobs persist in
~/.rig/jobs.json across restarts; re-enable re-arms from now (no
missed-interval backlog).

`pair {code,device}` → `{type:"paired",token,scopes:[…]}`. `omprd pair
--scopes read` (or `read,operate`) mints a narrowed token: read =
inspection (list/screenshot/watch/tree/diff), operate = everything that
mutates (sessions, exec, terminal, computer input, schedule add/enable),
admin = destructive (lock, session.delete, schedule.remove,
device.scopes). A denied op replies `token lacks the <scope> scope`.
`rig.device.scopes {device,scopes:[…]}` (admin) rewrites a device's
mask — takes effect on its next connect; `rig.status` shows each
device's scopes.

`rig.device.revoke {device}` (admin) → drops the device from
devices.json — its token dies on next connect (`unauthorized`).
`rig.device.scopes {device,scopes}` (admin) → rewrites its scope mask.
Both persist immediately; live sockets keep their handshake-time mask.

Correlation: every reply echoes the caller's top-level `id` when one was
sent — `session.response` (from `session.request`/`session.usage`/
`session.stats`), the list/status/usage/models/schedule replies,
`ok{for:…}` acknowledgements, async `computer.*`/`record.*` replies, and
`error` frames. `session.response` falls back to the daemon-minted
`omprd-N` when no `id` was supplied — FIFO correlation stays the
fallback. When a reply's `id` field already carries domain data (window
ids in `computer.waitWindow`/window-op `ok` replies, recording ids in
`computer.record*` replies), the request id echoes as `reqId` instead so
the payload stays intact. Async exec/term replies carry their own
correlation (`execId`, `termId`).
