# Sidebar Flow

How the GStack Browser sidebar actually works. Read this before touching
`sidepanel.js`, `background.js`, `content.js`, `terminal-agent.ts`, or
sidebar-related server endpoints.

The sidebar has one primary surface — the **Terminal** pane, an interactive
`claude` PTY. Activity / Refs / Inspector survive as debug overlays behind
the `debug` toggle in the footer. The chat queue path (one-shot `claude -p`,
sidebar-agent.ts) was ripped once the PTY proved out — the Terminal pane is
strictly more capable.

## Components

```
┌─────────────────┐     ┌──────────────┐     ┌──────────────────┐
│  sidepanel.js + │────▶│  server.ts   │────▶│terminal-agent.ts │
│  -terminal.js   │     │  (compiled)  │     │  (non-compiled)  │
│  (xterm.js)     │     │              │     │  PTY listener    │
└─────────────────┘     └──────────────┘     └──────────────────┘
        ▲                       │                      │
        │  ws://127.0.0.1:<termPort>/ws (Sec-WebSocket-Protocol auth)
        └───────────────────────┼──────────────────────▶│ Bun.spawn(claude)
                                │                      │  terminal: {data}
                                │                      ▼
                                │              ┌──────────────────┐
                                │              │  claude PTY      │
                                │              └──────────────────┘
            POST /pty-session   │
            (Bearer AUTH_TOKEN) │
                                ▼
                       ┌──────────────────┐
                       │ pty-session-     │
                       │ cookie.ts        │
                       │ (in-memory token │
                       │  registry)       │
                       └──────────────────┘
                                │
                                │ POST /internal/grant (loopback)
                                ▼
                       ┌──────────────────┐
                       │  validTokens Set │
                       │  in agent memory │
                       └──────────────────┘
```

The compiled browse server can't `posix_spawn` external executables —
`terminal-agent.ts` runs as a separate non-compiled `bun run` process and
owns the `claude` subprocess.

## Startup + first-keystroke timeline

```
T+0ms     CLI runs `$B connect`
            ├── Server starts (compiled)
            └── Spawns terminal-agent.ts via `bun run`

T+500ms   terminal-agent.ts boots
            ├── Bun.serve on 127.0.0.1:0 (random port)
            ├── Writes <stateDir>/terminal-port (server reads it for /health)
            ├── Writes <stateDir>/terminal-internal-token (loopback handshake)
            └── Probes claude → writes claude-available.json

T+1-3s    Extension loads, sidebar opens
            ├── sidepanel-terminal.js: setState(IDLE), shows "Starting Claude Code..."
            └── tryAutoConnect() polls until window.gstackServerPort + token are set

T+ready   tryAutoConnect calls connect()
            ├── POST /pty-session (Authorization: Bearer AUTH_TOKEN)
            │   └── server mints session token, posts /internal/grant to agent
            │   └── responds with {terminalPort, ptySessionToken}
            ├── GET /claude-available (preflight)
            ├── new WebSocket(`ws://127.0.0.1:<terminalPort>/ws`,
            │                 [`gstack-pty.<token>`])
            │   └── Browser sends Sec-WebSocket-Protocol + Origin
            │   └── Agent validates Origin AND token BEFORE upgrading
            │   └── Agent echoes the protocol back (REQUIRED — browser
            │       closes the connection without it)
            ├── On open: send {type:"resize"} then a single \n byte
            └── Agent message handler sees the byte → spawnClaude()
```

## Auth: WebSocket can't send Authorization headers

Browser WebSocket clients can't set `Authorization`. They CAN set
`Sec-WebSocket-Protocol` via the second arg of `new WebSocket(url,
protocols)`. We exploit that:

1. `POST /pty-session` (auth: Bearer AUTH_TOKEN) → server mints a
   short-lived session token, pushes it to the agent over loopback,
   returns it in the JSON body.
2. Extension calls `new WebSocket(url, ['gstack-pty.<token>'])`.
3. Agent reads `Sec-WebSocket-Protocol`, strips `gstack-pty.`, validates
   against `validTokens`, echoes the protocol back. Echo is mandatory —
   without it Chromium closes the connection on receipt of the upgrade
   response.

A `Set-Cookie: gstack_pty=...` header is also returned for non-browser
callers (curl, integration tests). The cookie path was the original v1
design but `SameSite=Strict` cookies don't survive the cross-port jump
from server.ts:34567 → agent:<random> from a chrome-extension origin.
The protocol-token path is what the browser actually uses.

### Dual-token model

| Token | Lives in | Used for | Lifetime |
|-------|----------|----------|----------|
| `AUTH_TOKEN` | `<stateDir>/browse.json`; in-memory in server.ts | `/pty-session` POST (mint cookie + token) | server lifetime |
| `gstack-pty.<...>` (Sec-WebSocket-Protocol) | Browser memory only; agent `validTokens` Set | `/ws` upgrade auth | 30 min, auto-revoked on WS close |
| `INTERNAL_TOKEN` | `<stateDir>/terminal-internal-token`; in agent memory | server → agent loopback `/internal/grant` | agent lifetime |

`AUTH_TOKEN` is **never** valid for `/ws` directly. The session token is
**never** valid for `/pty-session` or `/command`. Strict separation
prevents an SSE or page-content token leak from escalating into shell
access.

## Threat model

The Terminal pane **bypasses the prompt-injection security stack** on
purpose — the user is typing directly to claude, there's no untrusted
page content in the loop. Trust source is the keyboard, same as any
local terminal.

That trust assumption is load-bearing on three transport guarantees:

1. **Local-only listener.** terminal-agent.ts binds `127.0.0.1` only.
   The dual-listener tunnel surface (server.ts `TUNNEL_PATHS`) does
   not include `/pty-session` or `/terminal/*`, so the tunnel returns
   404 by default-deny.
2. **Origin gate.** `/ws` upgrades require
   `Origin: chrome-extension://<id>`. A localhost web page can't mount
   a cross-site WebSocket hijack against the shell because its Origin
   is a regular `http(s)://...`.
3. **Session token auth.** Minted only by an authenticated
   `/pty-session` POST, scoped to one WS, auto-revoked on close.

Drop any one of those three and the whole tab becomes unsafe.

## Lifecycle

- **Eager auto-connect.** Sidebar opens → tryAutoConnect polls for the
  bootstrap globals and connects as soon as they're set. No keypress
  required.
- **One PTY per WS.** Closing the WebSocket SIGINTs claude, then SIGKILLs
  after 3s. The session token is revoked so a stolen token can't be
  replayed.
- **No auto-reconnect on close.** The user sees "Session ended, click to
  start a new session." Auto-reconnect would burn a fresh claude session
  on every reload. v1.1 may add session resumption keyed on tab/session
  id (see TODOS).
- **Manual restart anytime.** A `↻ Restart` button lives in the always-
  visible terminal toolbar — works mid-session, not just from the ENDED
  state.

## Quick-action toolbar

Three browser-action buttons live next to the Restart button at the top
of the Terminal pane:

| Button | Behavior |
|--------|----------|
| 🧹 Cleanup | `window.gstackInjectToTerminal(prompt)` — pipes a "remove ads/banners" instruction into the live PTY. claude in the terminal sees it and acts. |
| 📸 Screenshot | `POST /command screenshot` — direct browse-server call, no PTY involvement. |
| 🍪 Cookies | Navigates to the `/cookie-picker` page. |

The Inspector's "Send to Code" button uses the same `gstackInjectToTerminal`
path to forward CSS inspector data into claude.

## Debug surfaces (Activity / Refs / Inspector)

Behind the `debug` toggle in the footer. SSE-driven, independent of the
Terminal pane:

- **Activity** — streams every browse command via `/activity/stream` SSE.
- **Refs** — REST: `GET /refs` — current page's `@ref` element labels.
- **Inspector** — CDP-based element picker; SSE on `/inspector/events`.

When the debug strip closes, the Terminal pane re-becomes visible.
xterm.js doesn't auto-redraw when its container flips from `display:none`
to `display:flex`, so sidepanel-terminal.js runs a `MutationObserver` on
`#tab-terminal`'s class attribute and forces a fit + refresh when
`.active` returns.

## Files

| Component | File | Runs in |
|-----------|------|---------|
| Sidebar UI shell | `extension/sidepanel.html` + `sidepanel.js` + `sidepanel.css` | Chrome side panel |
| Terminal UI | `extension/sidepanel-terminal.js` + `extension/lib/xterm.js` | Chrome side panel |
| Service worker | `extension/background.js` | Chrome background |
| Content script | `extension/content.js` | Page context |
| HTTP server | `browse/src/server.ts` | Bun (compiled binary) |
| PTY agent | `browse/src/terminal-agent.ts` | Bun (non-compiled) |
| PTY token store | `browse/src/pty-session-cookie.ts` | Bun (compiled, in server.ts) |
| CLI entry | `browse/src/cli.ts` | Bun (compiled binary) |
| State file | `<stateDir>/browse.json` | Filesystem |
| Terminal port | `<stateDir>/terminal-port` | Filesystem |
| Internal token | `<stateDir>/terminal-internal-token` | Filesystem |
| Claude probe | `<stateDir>/claude-available.json` | Filesystem |
| Active tab | `<stateDir>/active-tab.json` | Filesystem (claude reads) |
