# Mascot 3D renders

CGI renders of the blob mascots painted into `philosophers-hero.jpg` /
`mobile/assets/philosophers.jpg` (see also `mascots-3x.jpg` for the 2-D state
sheet). Same characters, re-rendered as soft-body 3-D: gumdrop body, slightly
irregular silhouette, two cream bead eyes, stub feet, warm candle-ish key from
the upper left + cool rim from the right — matches the painting's light so they
composite straight onto it.

All PNGs carry a real alpha channel (transparent background). Singles are
512x512; `mascot-rose-hero.png` and `mascots-group.png` are 1024x1024.

## Naming

`mascot-<color>-<pose>.png`

- colors: `indigo`, `rose`, `lavender`, `gold`, `plum`
- poses: `idle`, `peek`, `jump`, `sleepy`

| File | Intended use |
| --- | --- |
| `mascot-rose-hero.png` (1024) | Landing hero float — the pink one from the laptop, large |
| `mascots-group.png` (1024) | The family huddled — landing "meet the mascots" section |
| `mascot-*-idle.png` | Default presence — corner buddy, empty states, about section |
| `mascot-*-peek.png` | Anchored to a bottom edge (the blob is cut flat) — peeks over section breaks, footers, cards |
| `mascot-*-jump.png` | Confetti / success moments, loading celebratory states |
| `mascot-*-sleepy.png` | Idle/hibernated session states, 404/offline empty states |

## App-side guidance

- `mobile/assets/mascots-3d/` holds the same set for the Expo app (empty inbox,
  pairing success, hibernated-session rows, offline state).
- Sizes: use the 512s for everything up to ~256 px display size; reach for the
  1024s above that or where the render is the focal point.
- Don't tint or recolor — the five colors are the roster. New poses/colors are
  new renders, not filters.
- Lighting direction is baked (warm left, cool right). Mirroring the files is
  fine for right-edge placement; don't rotate more than a few degrees.

Generated with the painting assets as reference input, alpha extracted with
bria-rmbg-2.0. Re-render rather than upscale if a larger size is ever needed.
