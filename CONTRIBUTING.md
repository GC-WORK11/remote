# Contributing

## Layout

- `os-bridge/` — the daemon (`daemon/omprd.cpp`, single translation unit),
  CLI (`cli/ompr`), tests (`test/`), installer (`installer/`). Build with
  `make` inside `os-bridge/`; test with `python3 test/client.py`.
- `mobile/` — the Expo app. `npx tsc --noEmit` and `npx expo lint` must stay
  clean. Install packages with `npx expo install` (SDK-pinned versions).
- `engine/patches/` — numbered patch files applied on upstream oh-my-pi.
  The vendored `engine/omp/` tree is gitignored; change the patch, not
  the tree, and keep `apply.sh` able to rebuild a pristine tree.

## Ground rules

- **Protocol stability:** `os-bridge/protocol.md` is the contract. Frame
  changes need a doc update and a matching test.
- **No credentials, ever:** keys live in the engine vault on the rig.
  Nothing provider-shaped may be committed, logged, or sent to the phone.
- **Honest claims:** if a feature is partial or platform-gated, say so in
  `docs/COMPAT.md` — don't paper over it in README.
- **Measured, not vibes:** latency claims go through
  `os-bridge/test/probe-*.py` or the `rig.stats` reservoir — include the
  numbers in the PR.

## PRs

Keep diffs focused. The daemon is intentionally a single TU with zero
external deps — vendored single-headers (`json.hpp`, `stb_image_write.h`)
are the exception, not a license to add libraries.
