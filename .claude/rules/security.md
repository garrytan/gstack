---
paths:
  - "browse/src/server.ts"
  - "browse/src/sse-session-cookie.ts"
  - "browse/src/tunnel-denial-log.ts"
  - "browse/src/terminal-agent*.ts"
  - "browse/src/sidebar-agent*.ts"
  - "browse/src/token-registry.ts"
  - "browse/src/content-security.ts"
  - "browse/src/security.ts"
  - "browse/src/security-classifier.ts"
  - "browse/test/server-embedder-terminal-port.test.ts"
  - "browse/test/terminal-agent-pid-identity.test.ts"
  - "browse/test/server-sanitize-surrogates.test.ts"
---

# Server / sidebar / security gotchas

## Embedder terminal-agent ownership (v1.42.1.0+, identity-based kill v1.44.0.0+)

`buildFetchHandler` in `browse/src/server.ts` accepts `ServerConfig.ownsTerminalAgent?:
boolean` (default `true`). When `true`, factory shutdown runs the full teardown:
identity-based kill via `killAgentByRecord(readAgentRecord(stateDir))` from
`browse/src/terminal-agent-control.ts` plus `safeUnlinkQuiet` on
`<stateDir>/terminal-port`, `<stateDir>/terminal-internal-token`, and
`<stateDir>/terminal-agent-pid` (the per-boot agent record introduced in v1.44).
Embedders (e.g. the gbrowser phoenix overlay) that pre-launch their own PTY
server must pass `false` so their discovery files survive gstack teardown cycles.
The flag is the third caller-owned teardown gate in `ServerConfig` (alongside
`xvfb?` and `proxyBridge?`); polarity is inverted (explicit bool vs presence) and
documented in the field's JSDoc. CLI `start()` always passes `true` explicitly —
the static-grep test in `browse/test/server-embedder-terminal-port.test.ts` fails
CI if a refactor drops it. Pre-v1.44 used `pkill -f terminal-agent\.ts` (regex
match) which would kill sibling gstack sessions on the same host; the new
`browse/test/terminal-agent-pid-identity.test.ts` static-grep tripwire fails CI
if any source file re-introduces `pkill ... terminal-agent` or `spawnSync('pkill', ...)`.

## WebSocket auth uses Sec-WebSocket-Protocol, not cookies

Browsers can't set `Authorization` on a WebSocket upgrade, but they CAN set
`Sec-WebSocket-Protocol` via `new WebSocket(url, [token])`. The agent reads it,
validates against `validTokens`, and MUST echo the protocol back in the upgrade
response — without the echo, Chromium closes the connection immediately.
`Set-Cookie: gstack_pty=...` is kept as a fallback for non-browser callers (the
cross-port `SameSite=Strict` cookie path doesn't survive from a chrome-extension
origin).

## /health MUST NOT surface any shell-grant token

It already leaks `AUTH_TOKEN` to localhost callers in headed mode (a v1.1+ TODO).
Don't make that worse by adding the PTY session token there. PTY auth flows
through `POST /pty-session` only.

## Transport-layer security (v1.6.0.0+)

When `pair-agent` starts an ngrok tunnel, the daemon binds two HTTP listeners: a
local listener (127.0.0.1, full command surface, never forwarded) and a tunnel
listener (locked allowlist: `/connect`, `/command` with a scoped token + 26-command
browser-driving allowlist, `/sidebar-chat`). ngrok forwards only the tunnel port.
Root tokens over the tunnel return 403. SSE endpoints use a 30-minute HttpOnly
`gstack_sse` cookie minted via `POST /sse-session` (never valid against `/command`).
Tunnel-surface rejections go to `~/.gstack/security/attempts.jsonl` via
`tunnel-denial-log.ts`. Before editing `server.ts`, `sse-session-cookie.ts`, or
`tunnel-denial-log.ts`, read
[ARCHITECTURE.md](../../ARCHITECTURE.md#dual-listener-tunnel-architecture-v1600) —
the module boundary (no imports from `token-registry.ts` into `sse-session-cookie.ts`)
is load-bearing for scope isolation.

## Unicode sanitization at server egress (v1.38.0.0+)

Every server egress that ships page-content-derived strings MUST go through
`JSON.stringify(payload, sanitizeReplacer)` for object payloads or
`sanitizeLoneSurrogates(body)` for text bodies. Lone UTF-16 surrogate halves from
CDP page content otherwise reach the Anthropic API as `\uD800`-style escapes and
trigger a 400. Wired at four egress points today: `handleCommandInternal` (HTTP +
batch via a sanitizing wrapper around `handleCommandInternalImpl`) and both SSE
producers (`/activity/stream`, `/inspector/events`). Post-stringify regex is a
no-op — `JSON.stringify` has already escaped the surrogate before regex could
match, so the replacer must run inside the encoding pipeline. Before adding a new
SSE/WebSocket writer or HTTP response in `server.ts`, read
[ARCHITECTURE.md](../../ARCHITECTURE.md#unicode-sanitization-at-server-egress-v13800).
`browse/test/server-sanitize-surrogates.test.ts` pins the wiring with invariant
tests, so bypasses fail CI.

## Sidebar security stack (layered defense against prompt injection)

| Layer | Module | Lives in |
|-------|--------|----------|
| L1-L3 | `content-security.ts` | both server and agent — datamarking, hidden element strip, ARIA regex, URL blocklist, envelope wrapping |
| L4 | `security-classifier.ts` (TestSavantAI ONNX) | **sidebar-agent only** |
| L4b | `security-classifier.ts` (Claude Haiku transcript) | **sidebar-agent only** |
| L5 | `security.ts` (canary) | both — inject in compiled, check in agent |
| L6 | `security.ts` (combineVerdict ensemble) | both |

**Critical constraint:** `security-classifier.ts` CANNOT be imported from the
compiled browse binary. `@huggingface/transformers` v4 requires `onnxruntime-node`
which fails to `dlopen` from Bun compile's temp extract dir. Only `security.ts`
(pure-string operations — canary, verdict combiner, attack log, status) is safe
for `server.ts`. See `~/.gstack/projects/garrytan-gstack/ceo-plans/2026-04-19-prompt-injection-guard.md`
§"Pre-Impl Gate 1 Outcome" for full architectural decision.

**Thresholds** (in `security.ts`):
- `BLOCK: 0.85` — single-layer score that would cause BLOCK if cross-confirmed
- `WARN: 0.75` — cross-confirm threshold. When L4 AND L4b both >= 0.75 → BLOCK
- `LOG_ONLY: 0.40` — gates transcript classifier (skip Haiku when all layers < 0.40)
- `SOLO_CONTENT_BLOCK: 0.92` — single-layer threshold for label-less content classifiers
  (testsavant, deberta). Intentionally higher than `BLOCK` because these layers can't
  distinguish "this is an injection" from "this looks like phishing aimed at the user."
  The transcript classifier keeps a separate, label-gated solo path at `BLOCK` (0.85).

**Ensemble rule:** BLOCK only when the ML content classifier AND the transcript
classifier both report >= WARN. Single-layer high confidence degrades to WARN —
this is the Stack Overflow instruction-writing FP mitigation. Canary leak
always BLOCKs (deterministic).

**Env knobs:**
- `GSTACK_SECURITY_OFF=1` — emergency kill switch. Classifier stays off even if
  warmed. Canary is still injected; just the ML scan is skipped.
- `GSTACK_SECURITY_ENSEMBLE=deberta` — opt-in DeBERTa-v3 ensemble. Adds
  ProtectAI DeBERTa-v3-base-injection-onnx as L4c classifier for cross-model
  agreement. 721MB first-run download. With ensemble enabled, BLOCK requires
  2-of-3 ML classifiers agreeing at >= WARN (testsavant, deberta, transcript).
  Without ensemble (default), BLOCK requires testsavant + transcript at >= WARN.
- Classifier model cache: `~/.gstack/models/testsavant-small/` (112MB, first run only)
  plus `~/.gstack/models/deberta-v3-injection/` (721MB, only when ensemble enabled)
- Attack log: `~/.gstack/security/attempts.jsonl` (salted sha256 + domain only,
  rotates at 10MB, 5 generations)
- Per-device salt: `~/.gstack/security/device-salt` (0600)
- Session state: `~/.gstack/security/session-state.json` (cross-process, atomic)
