# os-bridge

Your laptop is the computer. Your phone is the remote.

`omprd` (C++20, single file, zero deps beyond vendored nlohmann/json) runs on the
rig, spawns `omp --mode rpc` subprocesses, and multiplexes them to authenticated
WebSocket clients anywhere in the world via Tailscale. No cloud, no same-WiFi.

## Status: v0.8 — measure-first hot path + computer-use "v10"

Instrumented the pipeline end-to-end, then cut the three measured hotspots:

- **`rig.fs.*`** — native C++ file ops beside `rig.exec` (daemon/rigfs.hpp):
  `read`/`write` (atomic tmp+rename, base64 for binary), `glob` (`**`/`?`/`{a,b}`),
  `grep` (literal fast path or regex, ripgrep-style `glob` filter, context lines).
  Measured: read **37 µs**, grep over a generated 1008-file corpus **23 ms**.
- **Conditional parse + shared-payload fan-out** — the child reader used to
  `json::parse` every omp line; now a marker scan (`omprd-`, `"usage"`,
  `prompt_result`, handshake) parses ~0.5% of lines and the rest are forwarded
  raw, wrapped once into a `shared_ptr` broadcast payload (was: string copy per
  client). `rig.stats` reports `linesIn`/`linesParsed`.
- **Warm omp pool** — cold `session.new`→`session.started` measured
  0.66–1.43 s (bun boot); spares spawned per spawn-signature complete the
  handshake in the background, so repeat session.new is **~2 ms**
  (`warm:true` in `session.started`; `RIG_WARM_MAX`=2 default, `RIG_WARM=0` off).
- **Auto-compact** — after each `prompt_result` the daemon re-reads
  `contextUsage`; at ≥`RIG_COMPACT_PCT`% (default 85) it issues `compact`
  itself and broadcasts `session.autoCompact`. Thinking defaults to `low`,
  folded into `provider/model:low` (`RIG_THINKING` overrides).
- **Retire graveyard** — clients/sessions are freed 60 s after unregister,
  fixing a class of stale-pointer crashes seen under load; fd ownership is now
  explicit (stdin closed under the write lock, stdout owned by the reader).
- Tests: `test/client5.py` — 37 checks (rig.fs correctness + latency budgets,
  3-session fan-in bleed/starvation, ring replay) all green; `test/probe-*`
  measure spawn/turn/fan-in/replay/slow-client isolation.

=======
**Computer-use "v10"** — proven on the real display by `test/computer-v10.py`
(13/13 checks: pixel diffs + timing budgets, TextEdit + Simulator):


- **Input path rewritten**: CGEvent posting went from a synchronous 6 ms
  source-flush to a posted-then-1 ms settle — measured click p50 **0.2 ms**,
  p99 **1.3 ms** (30 samples into TextEdit); scroll p99 **0.8 ms** (single
  pixel-unit wheel event, `direction`/`times`/`dx`); unicode type chunked
  UTF-16 (é → € proven on the real display).
- **Screenshot split**: replies now report `captureMs`/`encodeMs` — grab
  ~4 ms, turbojpeg encode ~16 ms for a 1600×1200 frame (jpg p50 **24 ms**,
  quality floor 5, CPU box-downscale before encode for scaled/observe shots,
  no CGContext). libpng-l1 fast path kept for PNG.
- **Adaptive `computer.watch`**: probe/encode split (idle ticks pay only
  grab+thumb), cadence relaxes ×1.5 to `idleIntervalMs` after `idleAfterMs`,
  snaps back on change — frame reports `cadenceMs` it was sent at
  (observed 567 ms mid-idle → 50 ms on change). `region {x,y,w,h}` watches a
  sub-rectangle. Frame arrival **54 ms** after a real change.
- **Coordinate space fixed**: shot-space, window rects and CGEvent coords
  now share ONE space — the union of *display* bounds (origin may be
  negative), bounded grabs so window movement can't drift the mapping;
  `computer.state` reports `displayOrigin`, `scaleFactor` (measured
  shot-px/point ratio) and `pixelResolution`.
- **`computer.window.activate` actually frontmosts** on macOS
  (NSRunningApplication `activateWithOptions:` via objc runtime, `open -a`
  fallback) — proven by fronting Simulator and raising TextEdit back.
- **Client UAF fixed**: the retire graveyard (60 s deferred free) covers
  detached capture/watch/exec threads — a client dying mid-capture used to
  abort the daemon (`mutex lock failed`) — verified by hard-killing a
  streaming client.
- x11.hpp parity: turbojpeg dlopen + XGetImage fallback when MIT-SHM is
  unavailable, unicode temp-keysym remap, watch probe/encode split
  (syntax-verified on this box; runtime is Linux-only).
- Proof: `test/computer-v10.py` — **13/13 checks green** on the real
  display (TextEdit + Simulator, pixel diffs + timing budgets).

## Status: v0.7 — gestures, latency wins, clamshell remote + host-side auth

- `computer.gesture {op}` — `tap`/`doubleTap`/`longPress`/`swipe`/`drag`
  with duration/steps for touch-driven control (protocol.md).
- Measured latency (macOS, client RTT): jpg shot p50 52.7→**27.3 ms**,
  png 209.8→**124.2 ms**, watch first-frame 84→**28.2 ms**, type 3.8→**1.8 ms**
  (`test/probe-mac-latency.py`, `probe-mac-real.py`).
- `rig.stayAwake {on, persistent}` — keep-awake beyond session lifetime
  plus **lid-close prevention** per OS: macOS flips
  `SleepDisabled`+`tcpkeepalive` via `sudo -n pmset` (one-time grant from
  `install.sh --with-lid`, or plain sudo/root), Windows sets
  powercfg `LIDACTION 0` AC+DC, Linux wraps the unit in
  `systemd-inhibit --what=sleep:handle-lid-switch` AND tiers a live
  fallback: unprivileged `handle-lid-switch` inhibitor → root-owned
  `90-omprd-lid.conf` logind drop-in via `sudo -n` (persistent, removed
  on `off`; elogind supported) → honest `needs-root` reply with the exact
  `sudo install.sh --lid` command + `restore` one-liner. Where privilege
  can't be engaged the reply reports `needsPrivilege`/`needsAdmin`+
  `command`+`restore` — control a closed laptop. On Windows the write is
  only `ok` after a re-query reads back 0/0 (powercfg's exit code lies on
  lidless hardware); lidless boxes report `method:"no-lid"`, denied
  writes `method:"needs-admin"`, and `on:false` restores the prior
  indexes. `rig.status` `lidOverride` reports `applied`/`method`/
  `needsPrivilege` for honest UI; stale inhibitors from a dead daemon are
  detected (`systemd-inhibit(stale)`) and swept on release. Wi-Fi
  powersave is disabled per-interface (`iw`) + NM drop-in via
  `install.sh --lid`.
  Windows install: `install-windows.ps1` — hidden per-user logon task +
  lid policy, 5.7 MB RSS measured.
- `rig.authStatus` — `omp auth-broker` surfaced to clients: provider
  OAuth **lives on the host** (`omp auth-broker login <provider>` on the
  laptop, or `--via=user@host` to broker a remote machine's login);
  clients read provider ids/state, never credentials.

## Status: v0.5 — macOS native backend proven live

v0.5 makes `computer.*` **one protocol, three native backends** — all
`dlopen`/`LoadLibrary`-resolved, zero compile-time deps. macOS joins Linux:

- `daemon/mac.hpp` (new): CGEvent injection (unicode typing, drag-aware
  motion), `CGWindowListCreateImage` capture → ImageIO jpeg/png — **no CPU
  RGB copy** — window list/activate/close, `IOPMAssertion` keep-awake,
  `computer.state` → `backend:"coregraphics"` + `perms:{inject,capture}`,
  new `computer.perms` message (`request:true` prompts TCC).
- Proven live on macOS 26 arm64 (`test/probe-mac.py`): real desktop
  1600×1200 jpg 385 KB in 108 ms enc=imageio, cursor exact, `open -a
  TextEdit` launched (pid), type native 346 ms, windows listed.

## Status: v0.4 — wire hardening

- `computer.screenshot` default **jpg** (1080p ≈ 25 ms, ~10× smaller/faster
  than png ≈ 118 ms); reply is `{imageBase64, format, encoder, …}` —
  `encoder` is the real backend: `libpng-l1`, `stb`, `imageio`.
- `computer.actions` (batched steps), `computer.observe` (shot+cursor+
  windows 1 RTT), `computer.drag`, `computer.waitWindow`,
  `computer.window.activate/close`, `computer.cursor`.
- `rig.exec` stays **1.3–1.6 ms**; x11.hpp libpng now probes
  `png_access_version_number` (libpng16 1.6.37 rejected the bare "1.6").

## Status: v0.3 — computer-use subsystem (Linux-first)

v0.3 adds the **computer-use subsystem**: the agent gets its own display —
Xvfb + xfwm4 auto-booted on `:99` — and acts like a user: screenshot, click,
type, key, scroll, launch, window list (`computer.*`), plus `rig.exec`
(native shell execution) and the token ledger
(`session.usage` / `session.stats` / `rig.usage`).

Proven live (`test/client3.py`, ALL GREEN): Xvfb auto-boot → Mousepad launched
on the agent display → click → type `RIG SAYS HI` → ctrl+plus zoom → 18 KB
screenshot of the typed text — **visually verified, caret and all**.

## Status: v0.2 — WORKING, ALL SUITES GREEN

Proven end-to-end (2026-10-01, both suites):
`test/client.py` (basic): pair → token reconnect → spawn → get_state (349
models) → **full streaming agent turn** (`RIG-OK`) → clean kill. **E2E: PASS**.

`test/client2.py` (advanced, v0.2): handshake-gated session ack → replay from
seq 0 → correlated `get_state` → `session.usage` (live context gauge) → real
model turn (39–80 streamed frames) → reconnect + exact incremental replay
(`lastSeq=43 → resumed at 43`) → master fan-outs (`sessions.subagents`,
`sessions.compact` across sessions) → `rig.stats` (**bridge overhead p99 = 1µs**,
queue p50 = 0ms) → `rig.lock` kill switch enforced → live unlock. **ALL GREEN**.

Hardening suites (2026-10-03, all green):
`test/mux-stress.py` — 3 concurrent sessions, 201-frame bursts interleaved on
one socket: strictly increasing per-session seqs, zero cross-talk (no foreign
prompt ids), per-session `omprd-N` request ids answered privately via
`session.response`; mid-burst `session.kill` exits only the target while a
sibling's stream completes undisturbed; `session.subscribe since=` mid-stream
delivers the replay+live union with **0 dupes over 402 frames**; reconnect
resumes strictly past the last seen seq; a >4096-frame backlog replays the
bounded ring contiguously with honest eviction (seqs 1132..5227).
`test/exec-stress.py` — 8 concurrent execs: unique execIds, outputs routed
per-id; exit codes 0/7/127/-1 honest; `timeoutMs` kills the process **tree**
(grandchildren included, verified by argv-visible sleep markers); `execKill`
returns `exec.done` in ~300 ms; 5 MB of stdout streams in ~103 chunked frames;
non-UTF8 bytes arrive losslessly via `chunkB64`; a client disconnect reaps its
in-flight exec tree.
`test/fuzz.py` — every malformed/empty frame answered, wrong-typed fields
rejected, pair brute-force rate-limited (5/min), 10 MB frame parsed-or-errored,
>64 MB declared length closes the conn, bad opcode/UTF-8/mask refused, 60 rapid
TCP drops + 15 ws flaps survived — **RSS +0 MB across the soak** (first 10 MB
parse retains a one-time arena, repeat frames add ~0).

Note: the model provider (kimi-k3 on this rig) stalls intermittently — when it
does, suites fall back to proving the pipe via clean `abort` round-trips.

## Layout

| Path | What |
|---|---|
| `daemon/omprd.cpp` | the daemon: WS server (RFC 6455 from scratch), pairing/auth, session mux, omp child bridge |
| `daemon/rigfs.hpp` | native `rig.fs.*` file ops: read/write (atomic)/glob/grep — no shell |
| `daemon/crypto.hpp` | SHA-1/SHA-256/HMAC/base64/random (public-domain style) |
| `daemon/json.hpp` | vendored nlohmann/json 3.11.3 (only dependency) |
| `cli/ompr` | Python glue: `setup`, `pair` (QR via python-qrcode if present), `status`, `unpack`→`unpair` |
| `test/client.py` | basic e2e + reference WS client (stdlib only) |
| `test/client2.py` | advanced e2e: replay, correlated requests, usage, master fan-outs, stats, lock |
| `test/client3.py` | computer-use e2e: exec latency, Xvfb+WM boot, GUI app, typing, screenshot proof |
| `test/client5.py` | rig.fs correctness + latency budgets, 3-session fan-in bleed/replay |
| `test/fake-omp.sh` | protocol-shaped omp stand-in for load/fan-in tests |
| `test/fake-openai.py` | OpenAI-compat stub server — real omp turns without a provider |
| `test/mux-stress.py` | 3-session mux proof: interleaved frames, zero cross-talk, kill isolation, exactly-once replay/since/reconnect, ring bound |
| `test/exec-stress.py` | terminal-chain proof: concurrent execs, tree kill on timeout/Kill/disconnect, exit codes, 5 MB chunking, non-UTF8 via `chunkB64` |
| `test/fuzz.py` | robustness: malformed json, wrong types, giant/invalid frames, rapid connect-drop, pair brute-force, RSS soak |
| `test/probe-latency.py` | per-turn pipeline breakdown: spawn→first-frame→tool→done |
| `test/probe-load.py` | 3-session fan-in fairness, replay cost, slow-client isolation |
| `test/computer-v10.py` | real-display proof suite: click/scroll/type pixel diffs, window front/raise, watch frames + adaptive cadence, timing budgets — exits non-zero on any regression |
| `protocol.md` | the wire protocol (read this before writing a client) |

## Run it

Three commands:

```
./cli/ompr setup    # tailscale/LAN check, installs omp if missing, builds omprd
./cli/ompr up       # daemonizes omprd (log: ~/.rig/omprd.log); extra args pass through (--bind etc.)
./cli/ompr pair     # one-time code + QR (tailscale → LAN → localhost fallback)
```

Then the phone pairs and drives it. Provider auth stays on the host:

```
./cli/ompr auth list              # oauth-capable providers (claude, codex, gemini, copilot, …)
./cli/ompr auth login claude      # browser OAuth on THIS machine; vault never leaves it
./cli/ompr status                 # daemon + paired devices
```

Manual equivalent: `make && ./daemon/omprd --omp-bin <omp> &` — omp resolution is `--omp-bin` > `OMP_BIN` > fork wrapper > known installs > PATH.

Any OpenAI-compatible endpoint works too — drop it in `~/.omp/agent/models.yml`
(verified live with a QwenCloud Token Plan key driving `qwen3.8-flash` —
vision + reasoning through omprd):

```yaml
providers:
  qwen:
    baseUrl: https://<your-openai-compatible-endpoint>/v1
    apiKey: <key>
    api: openai-completions
    models:
      - id: qwen3.8-flash
        input: [text, image]
        thinking: {mode: effort, efforts: [minimal, low, medium, high]}
```

The daemon picks up new providers on the next `session.new` — no restart.

### Ubuntu bring-up (verified 2026-10-03)

```
sudo apt install g++ make xvfb xfwm4 xterm xdotool x11-utils \
  imagemagick python3-pil zbar-tools   # suite + agent-display deps
make                                  # g++ (Makefile default); outputs daemon/omprd
./daemon/omprd --omp-bin tools/omp-fork.sh --bind 127.0.0.1
```

`--omp-bin` must be absolute or cwd-relative to `os-bridge/`. To run the
fork (`tools/omp-fork.sh`) you need `bun install` inside `engine/omp` and
the `pi_natives.linux-x64-*.node` binaries copied into
`engine/omp/packages/natives/native/` (e.g. from `node_modules/
@oh-my-pi/pi-natives-linux-x64/`) or `session.new` fails at the RPC
handshake. Suites self-manage omprd + boot Xvfb `:99`:
`python3 test/computer-correctness.py` → 65/65 at v0.9.1.

The daemon itself is ~11 MB RSS / ~1.2 MB binary — per-session weight is the omp child, not the rig.

## Security model (v0)

- Binds **only** the Tailscale interface — transport is WireGuard-encrypted, never public
- One-time pairing codes (10 min TTL, single use, minted by `ompr pair` on the rig)
- Per-device bearer tokens (32 random bytes, stored SHA-256-hashed in `~/.rig/devices.json`)
- Unauthenticated connections can do exactly one thing: pair
- `pkill omprd` kills all sessions with it (kill switch)

Not yet in v0 (planned, see ../docs/ROADMAP.md): TLS inside
the tailnet, per-session event replay buffers, approval-surfacing (omp host
tools), artifact range-serving, keep-awake, systemd unit.

## v0.2 subsystems

- **Writer threads + batched writes** — per-client outbound queue drained in ≤64-frame bursts, one syscall per burst; a slow client gets a 10 s grace window once past the soft cap (8 MB / 512 msgs — replay bursts on a weak link shouldn't kill the connection), and is only dropped on sustained overload or the hard ceiling (32 MB / 2048 msgs) — it never blocks others
- **Event ring + replay** — per-session monotonic `seq`, 4096-frame/8 MB replay window, `session.subscribe {since}` for exactly-once reconnects (older history is paged from the session log via `session.history`)
- **Handshake-gated session ack** — `session.started` only fires after omp's RPC handshake; half-born sessions surface as errors
- **Correlated requests** — `session.request` / `session.usage` (daemon mints ids, routes responses privately)
- **Master control** — cross-session fan-outs with deadline aggregation: `sessions.subagents`, `sessions.compact`, `sessions.abortAll`
- **Latency telemetry** — Vitter reservoir sampling (256/window), nearest-rank p50/p95/p99 in `rig.stats`
- **Auth hardening** — constant-time token compare, token-bucket pairing limiter (5 burst, 1/min), live device revocation (devices.json mtime watch), `rig.lock` kill switch picked up live
- **Spawn options** — `tools` (→ `--tools`, incl. computer-use roster), `model`, `thinking`, `yolo` (→ `--auto-approve`)
- **Keep-alive** — idle WS pings every 20s keep tailnet NAT paths warm

## Bugs found & fixed during bring-up (kept for the record)

1. `(key + GUID).begin()/.end()` on two different temporaries → garbage-length
   vector → crash. One string, one lifetime.
2. `std::signal` on glibc = SA_RESTART → SIGTERM never woke `accept()`; old
   daemons squatted the port. Now `sigaction` without SA_RESTART.
3. `SIGCHLD=SIG_IGN` inherited by the omp child (bun) → omp exited instantly
   and silently. Default disposition + explicit reaper instead.
4. `--omp-bin` wasn't plumbed to `session_start` — flag was cosmetic.
5. Orphaned omp children outlive dead clients by design — but reusing their
   session id failed with an error the first test client silently ignored
   (hung). Clients now fail loudly on error frames; ids are unique per run.
6. `session.started` raced omp's boot: acked at spawn, before omp could speak.
   Now gated on the actual RPC handshake response.
7. Writer-thread lifetime: detached thread + `delete Client` = use-after-free;
   now joined by the connection owner before destruction.
8. `xdotool mousemove --sync` hangs forever without a window manager — plain moves only.
9. GUI apps don't map reliably WM-less — the agent's desktop boots Xvfb **and** xfwm4 together.
10. PID recycling faked Xvfb liveness (`kill(pid,0)` on a reused pid) — liveness is
    now a socket connect probe, the only truth.
11. Flat screenshots are legitimately ~390 bytes — size alone proved nothing; the
    assertion now requires *different* pixels, and the final proof is eyeballing the PNG.
12. Snap Firefox: private `/tmp`, unkillable brokers — Profile Missing despite the
    dir existing; native apps (Mousepad) work flawlessly.

## Next

1. Event replay (monotonic ids) + `get_messages` reconnect flow
2. Approvals over remote (omp host tools), artifacts, keep-awake
