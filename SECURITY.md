# Security

Remote's attack surface is one authenticated WebSocket on the rig. The
threat model and current guarantees are documented in `docs/AUTH.md`.

## Reporting a vulnerability

Do **not** open a public issue. Report privately via GitHub's
"Report a vulnerability" flow (Security → Advisories) on this repository,
or by contacting the maintainer listed on the repo profile.

Include: the affected component (`omprd`, `ompr`, the app, the engine
patches), the wire frame or call path involved, and a reproduction.
A proof-of-concept that stays on loopback is appreciated.

## Notes for users

- Pairing codes are one-time, 10-min TTL, and rate-limited. Bearer tokens
  are stored SHA-256-hashed on the rig (`~/.rig/devices.json`) — revoke
  any device from the app's device list or by deleting the entry.
- The daemon executes real shell commands and real input injection on the
  host. Only pair devices you own, on networks you trust. Tailscale is the
  recommended transport; a bare LAN bind exposes the port to that LAN.
- This codebase is unaudited. Small surface is not a proof of safety.
