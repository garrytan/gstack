# Browser / sidebar / server internals

Moved verbatim from CLAUDE.md (token-load reduction). These are the
load-bearing invariants for `browse/src/server.ts`, the Chrome extension,
the sidebar PTY, SSE endpoints, CDP sessions, and the sidebar security
stack. Every rule here is additionally pinned by a CI tripwire test named
in its paragraph.

**Sidebar architecture:** Before modifying `sidepanel.js`, `background.js`,
`content.js`, `terminal-agent.ts`, or sidebar-related server endpoints,
read `docs/designs/SIDEBAR_MESSAGE_FLOW.md`. The sidebar has one primary
surface — the **Terminal** pane (interactive `claude` PTY) — with
Activity / Refs / Inspector as debug overlays behind the footer's
`debug` toggle. The chat queue path was ripped once the PTY proved out;
`sidebar-agent.ts` and the `/sidebar-command` / `/sidebar-chat` /
`/sidebar-agent/event` endpoints are gone. The doc covers the WS auth
flow, dual-token model, and threat-model boundary — silent failures
here usually trace to not understanding the cross-component flow.

**Embedder terminal-agent ownership** (v1.42.1.0+, identity-based kill v1.44.0.0+).
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

**WebSocket auth uses Sec-WebSocket-Protocol, not cookies.** Browsers
can't set `Authorization` on a WebSocket upgrade, but they CAN set
`Sec-WebSocket-Protocol` via `new WebSocket(url, [token])`. The agent
reads it, validates against `validTokens`, and MUST echo the protocol
back in the upgrade response — without the echo, Chromium closes the
connection immediately. `Set-Cookie: gstack_pty=...` is kept as a
fallback for non-browser callers (the cross-port `SameSite=Strict`
cookie path doesn't survive from a chrome-extension origin).

**Cross-pane PTY injection.** The toolbar's Cleanup button and the
Inspector's "Send to Code" action both pipe text into the live claude
PTY via `window.gstackInjectToTerminal(text)`, exposed by
`sidepanel-terminal.js`. No `/sidebar-command` POST — the live REPL is
the only execution surface in the sidebar now.

**`/health` MUST NOT surface any token — and it no longer does** (v1.63+).
The historical headed-mode leak of `AUTH_TOKEN` is fixed: `GET /health` is
liveness/status only in every mode. Token bootstrap is `POST /extension-token`,
which validates the caller's Origin against the pinned extension identity
(the `key` field in `extension/manifest.json` pins the extension ID —
`GSTACK_EXTENSION_ID` in `browse/src/server.ts`, derivation reproducible via
`bun browse/scripts/extension-id.ts`) plus a loopback Host. PTY auth still
flows through `POST /pty-session` only. Don't add any token to `/health`.

**Transport-layer security** (v1.6.0.0+). When `pair-agent` starts an ngrok tunnel,
the daemon binds two HTTP listeners: a local listener (127.0.0.1, full command
surface, never forwarded) and a tunnel listener (locked allowlist: `/connect`,
`/command` with a scoped token + 26-command browser-driving allowlist,
`/sidebar-chat`). ngrok forwards only the tunnel port. Root tokens over the tunnel
return 403. SSE endpoints use a 30-minute HttpOnly `gstack_sse` cookie minted via
`POST /sse-session` (never valid against `/command`). Tunnel-surface rejections go
to `~/.gstack/security/attempts.jsonl` via `tunnel-denial-log.ts`. Before editing
`server.ts`, `sse-session-cookie.ts`, or `tunnel-denial-log.ts`, read
[ARCHITECTURE.md](../ARCHITECTURE.md#dual-listener-tunnel-architecture-v1600) —
the module boundary (no imports from `token-registry.ts` into `sse-session-cookie.ts`)
is load-bearing for scope isolation.

**Unicode sanitization at server egress** (v1.38.0.0+). Every server egress that
ships page-content-derived strings MUST go through `JSON.stringify(payload,
sanitizeReplacer)` for object payloads or `sanitizeLoneSurrogates(body)` for text
bodies. Lone UTF-16 surrogate halves from CDP page content otherwise reach the
Anthropic API as `\uD800`-style escapes and trigger a 400. Wired at four egress
points today: `handleCommandInternal` (HTTP + batch via a sanitizing wrapper around
`handleCommandInternalImpl`) and both SSE producers (`/activity/stream`,
`/inspector/events`). Post-stringify regex is a no-op — `JSON.stringify` has
already escaped the surrogate before regex could match, so the replacer must run
inside the encoding pipeline. Before adding a new SSE/WebSocket writer or HTTP
response in `server.ts`, read
[ARCHITECTURE.md](../ARCHITECTURE.md#unicode-sanitization-at-server-egress-v13800).
`browse/test/server-sanitize-surrogates.test.ts` pins the wiring with invariant
tests, so bypasses fail CI.

**SSE endpoint helper** (v1.51.0.0+). New SSE endpoints in `server.ts` MUST route
through `createSseEndpoint(req, config)` from `browse/src/sse-helpers.ts`. The
helper owns the cleanup contract (abort + enqueue-throw + heartbeat-throw, all
idempotent) and bakes in `sanitizeLoneSurrogates` on every JSON.stringify, so
new subscribers can't accidentally regress either invariant. Inline
`ReadableStream` wiring leaked subscribers when the TCP connection died without
firing `req.signal.abort` (Chromium MV3 service-worker suspend, intermediate
proxy half-close). `/activity/stream`, `/inspector/events`, and `/memory`
(SSE-eligible) all route through it. `browse/test/sse-helpers.test.ts` pins the
cleanup contract.

**CDP session lifecycle** (v1.51.0.0+). Direct `page.context().newCDPSession(page)`
calls outside `browse/src/cdp-bridge.ts` fail CI via the static-grep tripwire in
`browse/test/cdp-session-cleanup.test.ts`. Use `withCdpSession(page, async (s) => {...})`
for one-shot CDP work (try/finally detach) or `getOrCreateCdpSession(page, cache)`
for cached sessions tied to a page's lifetime (close-detach via `Map<page, session>`).
Three sites migrated: cdp-bridge frame events, write-commands archive capture,
cdp-inspector. The helpers prevent the per-session leak class where successful-path
detach happened but error-path detach was missed.

**Setup symlink hardening** (v1.38.0.0+). Every link site in `setup` MUST route
through the `_link_or_copy SRC DST` helper near the `IS_WINDOWS` detection. On
Windows without Developer Mode, plain `ln -snf` produces frozen file copies that
don't refresh on `git pull` — silent staleness across every host adapter. The
helper preserves `ln -snf` on Unix and switches to `cp -R` / `cp -f` on Windows.
`test/setup-windows-fallback.test.ts` enforces a static invariant: a single raw
`ln` call outside the helper body fails CI. Windows users get a one-line note
from `_print_windows_copy_note_once` reminding them to re-run `./setup` after
every `git pull`.

**Sidebar security stack** (layered defense against prompt injection):

| Layer | Module | Lives in |
|-------|--------|----------|
| L1-L3 | `content-security.ts` | server + read path — datamarking, hidden element strip, ARIA regex, URL blocklist, envelope wrapping |
| L4 | `security-classifier.ts` (TestSavantAI ONNX) | **security sidecar subprocess only** (`security-sidecar-entry.ts`, driven by `security-sidecar-client.ts` from server.ts) |
| Canary | `security.ts` (generate/inject/detect) | pure utilities — no production injector today (the chat prompt-builder that injected them was ripped) |
| Combiner | `security.ts` (combineVerdict + THRESHOLDS) | pure, tested; retains transcript/deberta vote handling for LayerSignal inputs no live layer produces anymore |

History note: an L4b Haiku transcript classifier and an opt-in DeBERTa ensemble
(`GSTACK_SECURITY_ENSEMBLE=deberta`) existed until the chat-path agent that
invoked them was ripped; both were deleted as dead code (zero production
callers). Do not re-document them as live.

**Critical constraint:** `security-classifier.ts` CANNOT be imported from the
compiled browse binary. `@huggingface/transformers` v4 requires `onnxruntime-node`
which fails to `dlopen` from Bun compile's temp extract dir — hence the sidecar
subprocess. Only `security.ts` (pure-string operations — canary utilities,
verdict combiner, status) is safe for `server.ts`. See
`~/.gstack/projects/garrytan-gstack/ceo-plans/2026-04-19-prompt-injection-guard.md`
§"Pre-Impl Gate 1 Outcome" for the original architectural decision.

**Thresholds** (in `security.ts`): `BLOCK: 0.85`, `WARN: 0.75`, `LOG_ONLY: 0.40`,
`SOLO_CONTENT_BLOCK: 0.92` (label-less content classifiers can't distinguish
"injection" from "phishing aimed at the user", so their solo bar is higher).
The live L4 path applies these in server.ts's sidecar-scan handling; canary
leak always BLOCKs (deterministic).

**Env knobs:**
- `GSTACK_SECURITY_OFF=1` — emergency kill switch. Classifier stays off even if
  warmed; the L1-L3 filters keep running.
- Classifier model cache: `~/.gstack/models/testsavant-small/` (112MB, first run only)
- Attack log: `~/.gstack/security/attempts.jsonl` — written by
  `tunnel-denial-log.ts` (tunnel-surface rejections; rotates at 10MB, 5 generations)

History note (#2557): the cross-process session state
(`~/.gstack/security/session-state.json`), `getStatus()`, the `/health`
`security` field, and the sidepanel SEC shield were all removed — the state
file lost its only writer when sidebar-agent.ts was ripped, so the shield
reported a permanent 'inactive' or a stale false-green 'protected' from
leftover disk state. The live defenses (L1-L3 filters, L4 sidecar on the
inject-scan path) report through their own call sites, never through
/health. `browse/test/server-security-surface.test.ts` pins both the
removal and the live L4 wiring. Do not re-document these as live.
