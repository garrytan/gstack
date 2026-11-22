# Preview a frontend for /design-review --build

Three commands, from the app's repo, with gstack installed at
`~/.claude/skills/gstack`:

```bash
P=~/.claude/skills/gstack/design-review/templates/preview-fixtures.mjs
node $P start --root . --fixtures .gstack-preview/fixtures --port 5300 --state ~/.gstack/preview-5300 &
# PREVIEW: ready url=http://127.0.0.1:5300/ mode=vite state=<home>/.gstack/preview-5300 log=<home>/.gstack/preview-5300/preview.log

curl -s -H 'x-gstack-scenario: owner' http://127.0.0.1:5300/api/members
# [{"name":"Dana Whitfield","role":"Owner"},{"name":"Omar Haddad","role":"Editor"}]

node $P stop --state ~/.gstack/preview-5300
# PREVIEW: stopped port=5300
```

The template runs the app's own Vite (resolved from `--root`'s
`node_modules`, with the app's own config; gstack never installs Vite) plus a
fixture plugin. `--static` serves a directory of built or hand-written
files instead, with the same fixture API; gstack's own tests use that mode on
`test/fixtures/ui-spacing/preview/`. It runs under Node or Bun.

## What it guarantees

- **Loopback only.** It listens on 127.0.0.1; any other `--host` exits 3
  (`PREVIEW_HOST`).
- **An owned port.** The port is strict: if something holds it, it exits 4
  (`PREVIEW_PORT`) instead of moving. `--port 0` picks a free one and the
  ready line names it.
- **A private, redacted log.** `<state>/preview.log` (mode 0600, directory
  0700) has one line per API request (and, under `--static`, per page or
  asset request); a URL's userinfo and the values of token-like
  parameters are replaced with `REDACTED`.
- **No live backend.** Every request under the API prefix (`--api`, default
  `/api/`) is answered from a fixture or with a 501. Anything outside the
  prefix is the app's (SPA routes still serve), except a path the app's own
  dev-server proxy forwards, which gets a 501 too (a WebSocket upgrade does
  not). An app that calls an
  absolute API URL on another origin still reaches that host, so point its
  API base at the preview. `preflight` prints `mutations=fixtures-only` only
  when the preview's own probe route, `/api/__gstack-preview`, answers at
  every loopback state's origin without a redirect. A page that merely
  carries the script, a redirect, or a custom `--api` prefix is
  `mutations=unknown`, and the loop then drives no changed action. The Vite
  plugin applies to the dev server only, so a build never carries the script.
- **A clean stop.** `stop` (or SIGTERM/SIGINT) closes the server, removes
  `<state>/preview.json` and exits 0.

## Scenarios

A state's URL names its scenario: `http://127.0.0.1:5300/settings?as=owner`.
A script injected first into every HTML page keeps `?as=` for the tab and
adds an `x-gstack-scenario` header to every same-origin `fetch` and
`XMLHttpRequest`, so the server's API calls see the scenario even though
their own URLs carry none. A request without the header falls back to its own
`?as=`, then to its Referer's `?as=`.

## Fixtures

One file per scenario, `<fixtures>/<scenario>.json` (letters, digits, dot,
dash, underscore):

```json
{ "version": 1, "routes": {
  "GET /api/members": { "status": 200, "json": [{ "name": "Dana Whitfield", "role": "Owner" }] },
  "GET /api/members/:id": { "status": 200, "json": { "name": "Dana Whitfield" }, "delay_ms": 600 },
  "DELETE /api/members/:id": { "status": 409, "json": { "error": "The only owner cannot be removed." } } } }
```

A route key is a method and a path; `:name` matches one segment. `json`
sends JSON, `body` sends text, `headers` adds headers, `delay_ms` delays
the answer (for busy states). A declared error (the 409 above) is a fixture
like any other: it is how an error state is shown, and it never counts against
the run.

### Failures

Each failure is an RFC 9457 problem document (`application/problem+json`,
status 501, header `x-gstack-preview: <code>`) with `code`, `detail`
naming the route and scenario, and `fix` naming the file to edit. Each is
also appended to `<state>/unhandled.jsonl`, which the build receipt reads:
a state whose scenario hit one is `incomplete`, even when the page caught
the error and still rendered.

| Code | Means | Fix |
|------|-------|-----|
| <a id="preview-unhandled"></a>`PREVIEW_UNHANDLED` | the scenario file has no route for this method and path | add the route to that file, restart the preview and start a fresh run from preflight: every 501 the preview recorded during a run keeps its receipt incomplete |
| <a id="preview-unknown-scenario"></a>`PREVIEW_UNKNOWN_SCENARIO` | no `<scenario>.json`, or it is not JSON | add or fix the file |
| <a id="preview-no-scenario"></a>`PREVIEW_NO_SCENARIO` | an API call with no scenario at all | open the page with `?as=<scenario>` |
| <a id="preview-live-proxy"></a>`PREVIEW_LIVE_PROXY` | the path matches the app's `server.proxy`, a live backend | serve it under the API prefix from a fixture |

Start failures print `PREVIEW: fail code=<CODE> <detail> | fix: <fix>`:
`PREVIEW_NO_VITE` (no `node_modules/vite` at or above `--root`: install
it in the app, or use `--static`), `PREVIEW_CONFIG` (Vite could not load
the app's config), `PREVIEW_STATE` (the state directory is a symlink or
another user's), `PREVIEW_PORT`, `PREVIEW_HOST` and `PREVIEW_USAGE`.
Usage and host errors exit 3, the rest 4.

To use the plugin from the app's own `vite.config`:
`import { gstackPreviewFixtures } from '<path>/preview-fixtures.mjs'` and add
`gstackPreviewFixtures({ fixtures: '.gstack-preview/fixtures', stateDir: '<dir>' })` to
`plugins`.

## Inventory

`/design-review --build` lists the states it will check in an inventory
file, which `gstack-design-build` reads:

```json
{ "version": 1, "within": "section.access", "fixtures": ".gstack-preview/fixtures", "touched": ["src/access.ts"],
  "viewports": ["1440x900", "375x812"],
  "states": [
    { "name": "owner", "url": "http://127.0.0.1:5300/settings?as=owner", "expect": ".rows .row" },
    { "name": "remove-confirm", "mode": "screenshot", "steps": "click Remove on the second row" } ] }
```

`within` is the section the lint measures. `expect` is a selector only
that state renders; the lint marks the state `STATE_MISMATCH` when it is
absent, and the receipt records whether it passed. `fixtures` and
`touched` (untracked files the loop created) are part of the tree identity
the receipt is bound to. `viewports` defaults to 1440x900 and 375x812. At
least one state must be a URL state; screenshot-only states are never counted
as linted.

## Build receipt

`gstack-design-build` (on gstack's `bin`) decides the run's outcome in
code:

| Command | Does |
|---------|------|
| `preflight --inventory <f> [--grant-remote <host>]` | browser first (gstack's own browser is started for real: one tab opened and closed), then target authorization (loopback, or a host named in a grant), then that each URL answers; prints `PREFLIGHT: ok …` or the run's final `DESIGN_BUILD:` line (`NO_BROWSER`, [`BROWSER_SANDBOX`](troubleshooting.md#chromium-sandbox-unavailable), `UNAUTHORIZED_TARGET`, `NO_PREVIEW`) |
| `admit <saved gstack-skill-start output>` | maps a refused design-review start to `DESIGN_BUILD: unrendered code=INSTALL` |
| `plan --inventory <f> --run-dir <d> [--waivers <f>]` | writes the lint's state file and prints the exact `LINT_CMD:` (carrying `--waivers` when given; a `waived` receipt needs it) and one `SHOT:` path per state and viewport |
| `verify-start --inventory <f> --run-dir <d>` | records the tree identity right before the read-only final pass |
| `receipt --inventory <f> --run-dir <d> --rounds <n> [--preview <state dir>] [--waivers <f>]` | writes `receipt.json` (0600) under `$GSTACK_STATE_ROOT/projects/$SLUG/designs/design-build-<head>-<tree>/` and prints the one `DESIGN_BUILD:` line; it reads `--preview`, the state directory each running preview names, and the default per-port directory of any loopback origin where no preview answers; without `--preview`, a preview that keeps no record (the plugin without `stateDir`) makes the run `incomplete` (`PREVIEW_UNRECORDED`) |
| `check --inventory <f> --receipt <file>` | reprints the line while the tree is unchanged, else `DESIGN_BUILD: stale code=TREE_CHANGED` |

```
DESIGN_BUILD: <clean|waived|open|incomplete|unrendered|stale> code=<CODE> linted=<L>/<URL states> shot=<S>/<states> screenshot_only=<k> open=<n> waived=<n> rounds=<r> viewports=<list> tree=<id> receipt=<path> [(<detail>)] [| fix: <fix>]
```

The verdict comes from the lint's JSON (`app.verdict`, `app.states[]`,
the findings), never its exit status. `clean` needs every URL state measured
at every planned viewport, every state screenshotted, no preview failure for
its scenario, evidence no older than `verify-start`, the same tree as then,
and nothing open. The tree identity hashes HEAD, every tracked change, the
`touched` files and the fixture directory. Exit 0 clean or waived, 1 open,
4 incomplete, unrendered or stale, 3 usage (including `--rounds` above 3).
