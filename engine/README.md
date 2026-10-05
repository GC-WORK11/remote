# engine — engine patches

The agent engine under `omprd` is [oh-my-pi](https://github.com/can1357/oh-my-pi)
(`omp`, MIT — © Mario Zechner / Can Bölük / Stencil Labs), running as
`omp --mode rpc` subprocesses — one per session. This directory is **not a
rebrand and not a fork repo**: it is a patchset applied to a vendored
upstream tree.

## Layout

| Path | What |
|---|---|
| `patches/` | Numbered patches, applied in order by `apply.sh` |
| `omp/` | Vendored upstream tree (gitignored — not committed; it's a working tree) |

## The patches

| Patch | Purpose |
|---|---|
| `001-rig-computer-tool` | `rig_computer` — agent-facing computer control (observe/click/type/key/scroll/drag/gesture/window/wait/launch/close/batch) that bridges back to `omprd` over the daemon's wire |
| `002-open-session-preserve-local-cwd` | Session spawn keeps the requested working directory instead of relocating |
| `003-rig-deliver-tool` | `rig_deliver` — the agent hands a file back to the phone as an in-thread deliverable |
| `004-multimodal-download-fallback` | Image/attachment download fallback for providers without native fetch |
| `005-bound-model-discovery-wait` | `awaitBackgroundRefresh` bounded — a wedged provider can no longer serialize the whole RPC queue |

## Applying

```sh
git clone --depth 1 https://github.com/can1357/oh-my-pi engine/omp
engine/patches/apply.sh        # applies 001..NNN in order
```

Point `omprd` at the result:

```sh
./daemon/omprd --omp-bin os-bridge/tools/omp-fork.sh
```

## Rules

- Upstream source policy: model/provider behavior lives in the catalog
  rules (`packages/catalog/src/compat/rules/*.kdl`), not hard-coded in
  TypeScript. After rule changes: `bun run gen:compat`.
- Changes belong in a new numbered patch — never edit earlier patches
  post-merge; `apply.sh` must always rebuild a pristine tree.
- Keep upstream attribution (`LICENSE` in the vendored tree, MIT).
