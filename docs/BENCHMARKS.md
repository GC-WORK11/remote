# Benchmarks

All numbers measured on the rig itself — an Apple Silicon macOS VM
(omprd 0.9.0, clang -O2, 1600×1200 display, loopback+LAN WebSocket).
Each figure is a real wire-up request→reply time; nothing here is modeled.

Probe sources: `os-bridge/test/probe-latency.py` (session pipeline) and
`test/client.py`'s `Ws` reference client (computer.* loop).

## computer.* (30 iterations each, p50 / p95 in ms)

| op | p50 | p95 | notes |
|---|---|---|---|
| observe | 16.7 | 19.8 | state+shot bundle |
| screenshot jpg | 15.8 | 17.5 | ~278 KB; captureMs ≈ 3.3 — rest is encode+wire |
| screenshot png | 42.3 | 44.1 | ~2.7 MB — jpg is the wire format for a reason |
| click | 0.3 | 0.6 | CGEventPost round-trip incl. WS |
| type "x" | ~3.0 | — | real key event (UCKeyTranslate reverse-map → true keycode+flags, down+up+1ms settle); not unicode-payload — lands in keycode readers (Simulator/terminals) too |
| type ×20 chars, delay 0 | 26.8 | 28.8 | ~1.3 ms/char sustained |
| move | 0.1 | 0.1 | |
| cursor read | 0.1 | 0.1 | CGEventGetLocation |
| watch first-frame | 20.8 | 24.3 | subscribe → first `computer.frame` (jpg, full screen) |

## session pipeline (stub provider `fake-openai.py`, so model latency = wire only)

| op | ms |
|---|---|
| session.new → session.started (omp cold start) | 657.3 |
| session.request get_state round-trip | 13.4 / 0.9 / 0.7 (calls 1-3, warm ~1ms) |
| prompt → first frame | 3.7 |
| prompt → agent_start | 9.3 |
| prompt → first streamed message_update | 36.0 |
| prompt → prompt_result (1 tool call turn) | 153.8 |
| contextUsage read | 1.0 |
| rig.stats bridge reservoir | p50 26 µs, p95 121 µs, p99 190 µs |

Warm-pool adoption (`session.new` reusing a pre-handshaked spare) was
measured at ~2 ms vs the 0.7–1.4 s cold range (see protocol.md).

## keep-awake

`pmset -g assertions` on the box shows omprd holding both
`PreventUserIdleSystemSleep` and `PreventUserIdleDisplaySleep` — the
`caffeinate -dis` equivalent, held in-process (dies with the daemon).
`rig.status.keepawake` reports `{"held":true,"method":"iopm:idle+display","persistent":true}`.

## Internals pass — Linux/X11 box (omprd, g++ -O2, 1920×1080 Xvfb :99 + xfwm4, stb encoder, loopback ws)

Perf profile under a 50 ms motion-watch (perf record, 30 s): `downscale_inplace`
30.3%, `convert_zpixmap` 16.7%, stb jpg encode ~21% — the capture→convert→scale
chain was the daemon's CPU sink. All BEFORE→AFTER deltas below are same-box
A/B runs of the HEAD binary vs this change's binary; micro-benches are median
of ≥50 runs, p50/p95 reported.

| change | BEFORE | AFTER | notes |
|---|---|---|---|
| watch sustained fps (motion, 50 ms tick) | 7.88 fps @ 14.4% daemon CPU | 7.73 fps @ 10.6% | −26% CPU at equal fps |
| watch captureMs | p50 7.69 ms | p50 2.74 ms (p95 6.55) | retained SHM + fused grab→thumb; −64% |
| watch encodeMs | p50 7.75 ms | p50 7.72 ms | unchanged — encode only pays on real change |
| idle-phase daemon CPU (watch subscribed, no change) | ~3.0% | 1.99% | idle ticks pay grab+thumb only |
| screenshot tookMs | p50 16 ms | p50 17 ms | parity — same fused path now shared with watch |
| child_reader line split, 4 MB buffered burst | p50 1968.9 ms, p95 2228.7 | p50 0.85 ms, p95 0.90 | mechanism-isolated; per-line `erase(0,n)` memmove was O(buf²) |
| session.subscribe ring snapshot, 4096×~10 KB (40 MB ring) | p50 9.9 ms, p95 11.5 | p50 0.011 ms, p95 0.012 | deep copy under `ring_mutex` → filtered pointer copy; emit stalls on a big ring went 10 ms → ~µs |
| end-to-end drain, 4097-frame burst | 191 ms | 184 ms | ws writer-bound — mechanism win doesn't move e2e here |
| replay since=0 over full 4096 ring | 81 ms | 78 ms | same; copy elimination shows up as lock-hold time, not wire time |
| bridgeUs under 3×200-frame fan-in | p50 25–27 µs, p95 36–287, p99 55–1627 | p50 25–53 µs, p95 30–167, p99 45–867 | tail latency improved under slow-client pressure; within run-to-run noise at p50 |
| virtual-desktop lifecycle | `space new` appended forever, never released | claim/reuse/release + tail-shrink; count returns to base after session death | verified by `test/desktop-lifecycle.py` (8/8) against xfwm4 |
| RSS leak check, 1175 session churn+replay+space iters over 10 min + 70 s drain | 25.5 MB start | 36.4 MB end | warmup→33.2 MB, flat 650 iters, one +3.2 MB step, flat again — no per-iter leak; unchanged after drain |

Also shipped: per-watcher grab contexts kill a cross-watcher frame race
(`watch_img` was a backend-global shared between watcher threads); adaptive
watch fidelity under outbox backpressure (>256 KB → q−15/×0.8 scale, >2 MB →
q−30/×0.6) — additive `adaptive`/`quality`/`scale` frame fields only, no
protocol break.

NOT changed after measurement: rpc relay (~3 µs p50 bridge — kernel/writer
bound, nothing to win in parse), session.subscribe live fan-out (already
O(clients) shared_ptr bumps), warm-pool adopt (~0.4–26 ms as before),
nlohmann parse on the rpc path (conditional-parse already in place; didn't
surface in profiles).

## Caveats

- The stub provider returns instantly; real models add their own TTFT —
  these numbers isolate the omprd/omp/WS path cost.
- Screenshots measured with macOS screen-recording permission granted to
  the omprd binary (per-binary TCC grant — every install path needs its own).
- The first run's launchd-installed copy lacked the grant: screenshots
  honestly errored (`CGWindowListCreateImage` denied → `import` fallback
  absent) rather than returning stale pixels.

## Fresh steady-state (HEAD f04c937, macOS arm64, rebuilt binary)

| metric | value |
|---|---|
| omprd RSS (idle, sessions loaded) | 34.9 MB |
| omprd binary size | 1.26 MB |
| `computer.cursor` p50/p95 (ws 127.0.0.1) | 0 ms / 0 ms (sub-ms) |
| `computer.windows` p50/p95 | 1 ms / 1 ms |
| `computer.screenshot` jpg q60 p50/p95 (warm) | 21 ms / 23 ms |
| auto-checkpoint, edit turn | ref captured (`cp/1`) |
| auto-checkpoint, unchanged-tree turn | logged `skipped (unchanged tree)` |
