---
name: browse-daemon-surface-testing
description: How to runtime-test the browse daemon's snapshot output-path guards, the gstack_sse / gstack_pty session cookies, and the Claude AskUserQuestion hooks without a real `claude` binary or OpenAI key. Use when verifying changes under browse/src (snapshot.ts, path-security.ts, *-session-cookie.ts, server.ts) or hosts/claude/hooks.
---

# Runtime-testing browse daemon surfaces

## Prereqs
- `export PATH=$HOME/.bun/bin:$PATH`.
- Playwright browsers may be missing even though the blueprint installs them —
  if `browse goto` fails to launch, run `bunx playwright install chromium`
  (chromium-headless-shell is the one the daemon actually uses).
- `bun run build` produces `browse/dist/browse`, `design/dist/design`, etc.

## Daemon discovery
The CLI auto-starts the daemon. Port + root bearer token live in
`<repo>/.gstack/browse.json` (`.port`, `.token`). Read them instead of guessing:
`python3 -c "import json;print(json.load(open('.gstack/browse.json'))['port'])"`.

## Snapshot output-path guards
- Annotated screenshot: `browse snapshot -a -o /tmp/x.png` (the path is a value for
  `-o`; `-a` takes no value). Success line: `[annotated screenshot: <path>]`.
- Heatmap: `browse snapshot -H '{"@e1":"green"}' -o /tmp/y.png` — `-H` REQUIRES a
  JSON colormap value, so `-H -o path` fails with "Unknown snapshot flag".
- Safe dirs are `TEMP_DIR` and `process.cwd()`. Any other target must fail with
  `Path must be within: /tmp, <cwd>` (implemented by
  `validatePathAgainstLiveSafeDirs` in `browse/src/path-security.ts`).

## SSE + PTY session cookies (two isolated registries)
- `POST /sse-session` with `Authorization: Bearer <root token>` → `Set-Cookie: gstack_sse=...`.
  That cookie authenticates `GET /activity/stream`, `/inspector/events`, `/memory`.
- `POST /pty-session` requires a live terminal-agent: spawn it yourself with
  `BROWSE_STATE_FILE=<repo>/.gstack/browse.json BROWSE_TERMINAL_BINARY=/bin/bash \
   bun run browse/src/terminal-agent.ts` — the `/bin/bash` override means no
  `claude` binary is needed. It writes `<stateDir>/terminal-port`.
- `GET /ws` on the terminal-agent port needs BOTH an
  `Origin: chrome-extension://<32 chars>` header and a granted token (cookie
  `gstack_pty=<attachToken>` or `Sec-WebSocket-Protocol`), plus normal WS upgrade
  headers; success is `101 Switching Protocols`.
- Isolation invariant worth testing in BOTH directions: feed each registry the
  other's real live token under the *correct* cookie name. A PTY token sent as
  `gstack_sse` must 401 on `/activity/stream`; an SSE token sent as `gstack_pty`
  must 401 on `/ws`. Name-based filtering alone cannot fake these.

## Claude AskUserQuestion hooks (hosts/claude/hooks/*)
Run the wrapper scripts (no `.ts`) and pipe a JSON envelope on stdin. Always set
`GSTACK_STATE_ROOT=$(mktemp -d)`, `GSTACK_QUESTION_LOG_NO_DERIVE=1`, and unset
`GSTACK_HOME`, `CONDUCTOR_WORKSPACE_PATH`, `CONDUCTOR_PORT` (Conductor markers flip
question-preference-hook into a prose deny). Contracts:
- `question-log-hook`: exit 0, empty stdout, one JSONL line under
  `$GSTACK_STATE_ROOT/projects/<slug>/question-log.jsonl`.
- `question-preference-hook`: preference bucket slug is `basename(cwd)` (NOT the
  full gstack-slug), and the question id must be a two-way entry in
  `scripts/question-registry.ts` (e.g. `ship-todos-create`) with a stored
  `never-ask` preference to get the `permissionDecision: deny` path. Pass-through
  must be exit 0 + EXACTLY empty stdout.
- `auq-error-fallback-hook`: `tool_response: "[Tool result missing due to internal error]"`
  → `additionalContext`; a successful answer → bare
  `{"hookSpecificOutput":{"hookEventName":"PostToolUse"}}`.
- Always diff `~/.gstack/hook-errors.log` line count before/after; new lines mean a
  broken import or spawn path even when the hook still exits 0.

## design CLI without a key
`design/dist/design` help works offline. Without `OPENAI_API_KEY` (and without
`~/.gstack/openai.json`), any generate/iterate/check command must exit with
`No OpenAI API key found.` guidance rather than a stack trace. Real
`generateImage`/`visionRequest` coverage needs `OPENAI_API_KEY`.

## Known pre-existing test failures (as of v1.61.0.0 on main)
`browse/test/terminal-agent.test.ts > lazy spawn: claude PTY is spawned in message
handler` and `browse/test/snapshot.test.ts > closetab last tab auto-creates new`
fail on main too — verify against a `git worktree add /tmp/gs-main main` checkout
before calling either a regression.
