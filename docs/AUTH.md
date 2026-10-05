# Provider sign-in — how subscriptions connect

The rig owns every credential. The phone only brokers the flow: it shows the
provider catalog, streams the login child's prompts live, and forwards paste
answers. Tokens never transit or persist on the phone.

## App flow

Drawer → **Providers** → tap a provider in **CONNECT**.

- `auth.login{provider}` spawns `omp login <provider>` on the rig.
- Everything the child prints (URL, instructions, prompts, validation) streams
  to the sheet as `auth.event` frames — `line` for prose, `url` for links,
  `prompt` for "what are you waiting for" tails, `done` for the result.
- A `url` event renders **Open on rig** (opens the rig's own browser — required
  for OAuth flows that callback to loopback) and **Open here** (phone browser).
- A `prompt` event becomes the paste field's placeholder — paste the answer,
  it goes down the child's stdin via `auth.input`.
- `auth.cancel` kills the child. `auth.changed` refreshes the CONNECTED list.
- After sign-in, the provider's models join the model picker automatically
  (`get_login_providers` marks it authenticated; `get_available_models`
  returns its catalog).

## Command Code (subscription)

Command Code is its own provider (`commandcode`) — not Codex, not Claude.
It is an API-key login, not OAuth:

1. Tap `commandcode` → the card prints "Open this URL in your browser:" and
   `https://commandcode.ai/studio` → tap **Open on rig** (or open it yourself
   on the laptop).
2. Sign in to Command Code Studio → create/copy a **Provider API key**
   (`user_...`).
3. Paste it into the sheet's field (placeholder shows the exact prompt text).
4. The rig validates it against `api.commandcode.ai` — a real round-trip;
   a bad key fails 401 and stores nothing.
5. On success, ~84 models land in the picker (claude-sonnet-5 default, gpt-5.x,
   gemini-3.x, kimi, grok…).

Advanced: a key can also be delivered non-interactively —
`auth.login{provider:"commandcode", key:"user_..."}` fast-paths the key into
the child's first prompt (the daemon holds it until readline actually asks,
so it can't be lost to a stdin flush).

## Codex / Claude / others

`openai-codex` (ChatGPT Plus/Pro subscription), `anthropic` (Claude Pro/Max),
and the rest of the ~78-provider catalog follow the same sheet: URL on the
rig's browser, sign in there, callback lands on the rig. API-key providers in
`models.yml` show as CONNECTED without any login step.

## Daemon endpoints (protocol)

| type               | direction | purpose                                      |
| ------------------ | --------- | -------------------------------------------- |
| `auth.list`        | req→res   | catalog rows + `authed` flags                |
| `auth.login`       | req       | spawn login child (`provider`, opt `key`)    |
| `auth.started`     | evt       | child spawned for `provider`                 |
| `auth.event`       | evt       | `{kind: line|url|prompt|done, text, url, ok}`|
| `auth.input`       | req       | paste answer into the child's stdin          |
| `auth.cancel`      | req       | kill the child                               |
| `auth.changed`     | evt       | credential set changed — re-fetch auth.list  |
