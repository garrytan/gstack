# Browser — Complete Reference

gstack's browser surface in one document. Headless Chromium daemon, ~70+
commands, ref-based element selection, codifiable browser-skills, real-browser
mode with a Chrome side panel, an in-sidebar Claude PTY, an ngrok pair-agent
flow, and a layered prompt-injection defense — all behind a compiled CLI that
prints plain text to stdout. ~100-200ms per call. Zero context-token overhead.

If you've used gstack in the last release or two, the productivity loop is the
new headline: `/scrape <intent>` drives a page once, `/skillify` codifies the
flow into a deterministic Playwright script, and the next `/scrape` on the
same intent runs in ~200ms instead of ~30 seconds of agent re-exploration.

---

## Quick start

```bash
# One-time: build the binary (browse/dist/browse, ~58MB)
bun install && bun run build

# Set $B once and forget about it
B=./browse/dist/browse           # or ~/.claude/skills/gstack/browse/dist/browse

# Drive a page
$B goto https://news.ycombinator.com
$B snapshot -i                   # @e refs you can click/fill/inspect later
$B click @e30                    # click ref 30 from the snapshot
$B text                          # get clean page text
$B screenshot /tmp/hn.png

# Codify a repeated flow
/scrape latest hacker news stories
/skillify                        # writes ~/.gstack/browser-skills/hn-front/...
/scrape hacker news front page   # second call: 200ms via the codified skill

# Watch Claude work in real time
$B connect                       # headed Chromium + Side Panel extension
```

---

## Table of contents

1. [What it is](#what-it-is)
2. [The productivity loop — `/scrape` + `/skillify`](#the-productivity-loop)
3. [Architecture](#architecture)
4. [Command reference](#command-reference)
5. [Snapshot system + ref-based selection](#snapshot-system)
6. [Browser-skills runtime](#browser-skills-runtime)
7. [Domain-skills (per-site agent notes)](#domain-skills)
8. [Real-browser mode (`$B connect`)](#real-browser-mode) — including [`--headed` + `--proxy` + `--navigate` (v1.28.0.0)](#headed-mode--proxy--browser-native-downloads-v12800)
9. [Side Panel + sidebar agent](#side-panel--sidebar-agent)
10. [Pair-agent — remote agents over an ngrok tunnel](#pair-agent)
11. [Authentication + tokens](#authentication)
12. [Prompt-injection security stack (L1–L6)](#security-stack)
13. [Screenshots, PDFs, visual inspection](#screenshots-pdfs-visual)
14. [Local HTML — `goto file://` vs `load-html`](#local-html)
15. [Batch endpoint](#batch-endpoint)
16. [Console, network, dialog capture](#capture)
17. [JS execution — `js` + `eval`](#js-execution)
18. [Tabs, frames, state, watch, inbox](#tabs-frames-state)
19. [CDP escape hatch + CSS inspector](#cdp)
20. [Performance + scale](#performance)
21. [Multi-workspace isolation](#multi-workspace)
22. [Environment variables](#environment-variables)
23. [Source map](#source-map)
24. [Development + testing](#development)
25. [Cross-references](#cross-references)
26. [Acknowledgments](#acknowledgments)

---

## What it is

A compiled CLI binary that talks to a persistent local Chromium daemon over
HTTP. The CLI is a thin client — it reads a state file, sends a command,
prints the response to stdout. The daemon does the real work via
[Playwright](https://playwright.dev/).

Everything that was a Chrome MCP server in the early days now happens through
plain stdout. No JSON-schema framing, no protocol negotiation, no persistent
WebSocket — Claude's Bash tool already exists, so we use it.

Three escalating modes:

- **Headless** (default). Daemon runs Chromium with no visible window. Fastest,
  cheapest, what skills like `/qa`, `/design-review`, `/benchmark` use by
  default.
- **Headed via `$B connect`**. Same daemon, but Chromium is visible (rebranded
  as "GStack Browser") with the Side Panel extension auto-loaded. You watch
  every command tick through in real time.
- **Pair-agent over a tunnel**. Daemon binds a second listener that ngrok
  forwards. A remote agent (Codex, OpenClaw, Hermes, anything that can speak
  HTTP) drives your local browser through a 26-command allowlist with a
  scoped, single-use token.

---

## The productivity loop

The shipped headline of v1.19.0.0. Two gstack skills wrap the browser-skills
runtime so the second time you ask Claude to scrape a page, it runs in ~200ms.

### `/scrape <intent>`

One entry point for pulling page data. Three paths under the hood:

1. **Match path (~200ms)** — agent runs `$B skill list`, semantically matches
   the intent against each skill's `triggers:` array + `description` + `host`,
   and runs `$B skill run <name>` if a confident match exists.
2. **Prototype path (~30s)** — no match, agent drives the page with `$B goto`,
   `$B text`, `$B html`, `$B links`, etc., returns the JSON, and appends a
   one-line "say `/skillify`" suggestion.
3. **Mutating-intent refusal** — verbs like *submit*, *click*, *fill* route
   to `/automate` (Phase 2b, P0 in `TODOS.md`). `/scrape` is read-only by
   contract.

### `/skillify`

Codifies the most recent successful `/scrape` prototype into a permanent
browser-skill on disk. Eleven steps, three locked contracts:

- **D1 — Provenance guard.** Walks back ≤10 agent turns for a clearly-bounded
  `/scrape` result. Refuses with one specific message if cold. No silent
  synthesis from chat fragments.
- **D2 — Synthesis input slice.** Extracts ONLY the final-attempt `$B` calls
  that produced the JSON the user accepted, plus the user's intent string.
  Drops failed selectors, drops chat, drops earlier-session content.
- **D3 — Atomic write.** Stages everything to `~/.gstack/.tmp/skillify-<spawnId>/`,
  runs `$B skill test` against the temp dir, and only renames into the final
  tier path on test pass + user approval. Test fail or rejection: `rm -rf` the
  temp dir entirely. No half-written skill ever appears in `$B skill list`.

Mutating-flow sibling `/automate` is split out as P0 in `TODOS.md` and ships
on the next branch — same skillify machinery, per-mutating-step confirmation
gate when running non-codified.

See [`docs/designs/BROWSER_SKILLS_V1.md`](docs/designs/BROWSER_SKILLS_V1.md)
for the full design + decision trail.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code                                                    │
│                                                                 │
│  $B goto https://staging.myapp.com                              │
│       │                                                         │
│       ▼                                                         │
│  ┌──────────┐    HTTP POST     ┌──────────────┐                 │
│  │ browse   │ ──────────────── │ Bun HTTP     │                 │
│  │ CLI      │  127.0.0.1:rand  │ daemon       │                 │
│  │          │  Bearer token    │              │                 │
│  │ compiled │ ◄──────────────  │  Playwright  │──── Chromium    │
│  │ binary   │  plain text      │  API calls   │    (headless    │
│  └──────────┘                  └──────────────┘     or headed)  │
│   ~1ms startup                  persistent daemon               │
│                                 auto-starts on first call       │
│                                 auto-stops after 30 min idle    │
└─────────────────────────────────────────────────────────────────┘
```

### Daemon lifecycle

1. **First call.** CLI checks `<project>/.gstack/browse.json` for a running
   server. None found — it spawns `bun run browse/src/server.ts` in the
   background. Daemon launches headless Chromium via Playwright, picks a
   random port (10000–60000), generates a bearer token, writes the state
   file (chmod 600), starts accepting requests. ~3 seconds.
2. **Subsequent calls.** CLI reads the state file, sends an HTTP POST with
   the bearer token, prints the response. ~100-200ms round trip.
3. **Idle shutdown.** After 30 minutes of no commands, daemon shuts down and
   cleans up the state file. Next call restarts it.
4. **Crash recovery.** If Chromium crashes, the daemon exits immediately —
   no self-healing, don't hide failure. CLI detects the dead daemon on the
   next call and starts a fresh one.

### Multi-workspace isolation

Each project root (detected via `git rev-parse --show-toplevel`) gets its
own daemon, port, state file, cookies, and logs. No cross-workspace
collisions. State at `<project>/.gstack/browse.json`.

| Workspace | State file | Port |
|-----------|-----------|------|
| `/code/project-a` | `/code/project-a/.gstack/browse.json` | random (10000–60000) |
| `/code/project-b` | `/code/project-b/.gstack/browse.json` | random (10000–60000) |

---

## Command reference

~70 commands across read, write, and meta. Selectors accept CSS, `@e` refs
from `snapshot`, or `@c` refs from `snapshot -C`. Full table:

### Reading

| Command | Description |
|---------|-------------|
| `text [sel]` | Clean page text (or scoped to a selector) |
| `html [sel]` | innerHTML, or full page HTML if no selector |
| `links` | All links as `text → href` |
| `forms` | Form fields as JSON |
| `accessibility` | Full ARIA tree |
| `media [--images\|--videos\|--audio] [sel]` | Media elements with URLs, dimensions, types |
| `data [--jsonld\|--og\|--meta\|--twitter]` | Structured data: JSON-LD, OG, Twitter Cards, meta tags |

### Inspection

| Command | Description |
|---------|-------------|
| `js <expr>` | Run inline JavaScript expression in page context, return as string |
| `eval <file>` | Run JS from a file (path under /tmp or cwd; same sandbox as `js`) |
| `css <sel> <prop>` | Computed CSS value |
| `attrs <sel\|@ref>` | Element attributes as JSON |
| `is <prop> <sel\|@ref>` | State check: visible, hidden, enabled, disabled, checked, editable, focused |
| `console [--clear\|--errors]` | Captured console messages |
| `network [--clear]` | Captured network requests |
| `dialog [--clear]` | Captured dialog messages |
| `cookies` | All cookies as JSON |
| `storage` / `storage set <key> <val>` | Read both localStorage + sessionStorage; set localStorage |
| `perf` | Page load timings |
| `inspect [sel] [--all] [--history]` | Deep CSS via CDP — full rule cascade, box model, computed styles |
| `ux-audit` | Page structure for behavioral analysis: site ID, nav, headings, text blocks, interactive elements |
| `cdp <Domain.method> [json-params]` | Raw CDP method dispatch (deny-default; allowlist in `cdp-allowlist.ts`) |

### Navigation

| Command | Description |
|---------|-------------|
| `goto <url>` | Navigate to URL (`http://`, `https://`, `file://`) |
| `load-html <file>` | Load local HTML in memory (no `file://` URL; survives viewport scale changes) |
| `back`, `forward`, `reload` | Standard nav |
| `url` | Current page URL |
| `wait <sel\|--networkidle\|--load>` | Wait for element, network idle, or page load (15s timeout) |

### Interaction

| Command | Description |
|---------|-------------|
| `click <sel\|@ref>` | Click element |
| `fill <sel> <val>` | Fill input |
| `select <sel> <val>` | Select dropdown option (value, label, or visible text) |
| `hover <sel>` | Hover element |
| `type <text>` | Type into focused element |
| `press <key>` | Playwright keyboard key (case-sensitive: Enter, Tab, ArrowUp, Shift+Enter, Control+A, ...) |
| `scroll [sel\|@ref]` | Scroll element into view, or jump to page bottom if no selector |
| `viewport [<WxH>] [--scale <n>]` | Set viewport size + optional `deviceScaleFactor` 1-3 (retina screenshots) |
| `upload <sel> <file> [...]` | Upload file(s) |
| `dialog-accept [text]` | Auto-accept next alert/confirm/prompt; text is sent for prompts |
| `dialog-dismiss` | Auto-dismiss next dialog |

### Style + cleanup

| Command | Description |
|---------|-------------|
| `style <sel> <prop> <val>` | Modify CSS property (with undo support) |
| `style --undo [N]` | Undo last N style changes |
| `cleanup [--ads\|--cookies\|--sticky\|--social\|--all]` | Remove page clutter |
| `prettyscreenshot [--scroll-to <sel\|text>] [--cleanup] [--hide <sel>...] [path]` | Clean screenshot with optional cleanup, scroll, hide |

### Visual

| Command | Description |
|---------|-------------|
| `screenshot [--selector <css>] [--viewport] [--clip x,y,w,h] [--base64] [sel\|@ref] [path]` | Five modes: full page, viewport, element crop, region clip, base64 |
| `pdf [path] [--format letter\|a4\|legal] [...]` | PDF with full layout: format, width/height, margins, header/footer templates, page numbers, --tagged for accessibility, --toc waits for Paged.js |
| `responsive [prefix]` | Three screenshots: mobile (375x812), tablet (768x1024), desktop (1280x720) |
| `diff <url1> <url2>` | Text diff between two URLs |

### Cookies + headers

| Command | Description |
|---------|-------------|
| `cookie <name>=<value>` | Set cookie on current page domain |
| `cookie-import <json>` | Import cookies from JSON file |
| `cookie-import-browser [browser] [--domain d]` | Import from installed Chromium browsers (interactive picker, or `--domain` for direct import) |
| `header <name>:<value>` | Set custom request header (sensitive values auto-redacted) |
| `useragent <string>` | Set user agent (triggers context recreation, invalidates refs) |

### Tabs + frames

| Command | Description |
|---------|-------------|
| `tabs` | List open tabs |
| `tab <id>` | Switch to tab |
| `newtab [url] [--json]` | Open new tab; `--json` returns `{tabId, url}` for programmatic use |
| `closetab [id]` | Close tab |
| `tab-each <command> [args...]` | Fan out a command across every open tab; returns JSON |
| `frame <sel\|@ref\|--name n\|--url pattern\|main>` | Switch to iframe context (or back to main); clears refs |

### Extraction

| Command | Description |
|---------|-------------|
| `download <url\|@ref> [path] [--base64]` | Download URL or media element using browser cookies |
| `scrape <images\|videos\|media> [--selector] [--dir] [--limit]` | Bulk download all media from page; writes `manifest.json` |
| `archive [path]` | Save complete page as MHTML via CDP |

### Snapshot

| Command | Description |
|---------|-------------|
| `snapshot [-i] [-c] [-d N] [-s sel] [-D] [-a] [-o path] [-C]` | Accessibility tree with `@e` refs; `-i` interactive only, `-c` compact, `-d N` depth, `-s` scope, `-D` diff vs previous, `-a` annotated screenshot, `-C` cursor-interactive `@c` refs |

### Server lifecycle

| Command | Description |
|---------|-------------|
| `status` | Daemon health + mode (headless / headed / cdp) |
| `stop` | Shut down daemon |
| `restart` | Restart daemon |
| `connect` | Launch headed GStack Browser with Side Panel extension |
| `disconnect` | Close headed Chrome, return to headless |
| `focus [@ref]` | Bring headed Chrome to foreground (macOS); `@ref` also scrolls into view |
| `state save\|load <name>` | Save or load browser state (cookies + URLs) |

### Handoff

| Command | Description |
|---------|-------------|
| `handoff [reason]` | Open visible Chrome at current page for user takeover (CAPTCHA, MFA, complex auth) |
| `resume` | Re-snapshot after user takeover, return control to AI |

### Meta + chains

| Command | Description |
|---------|-------------|
| `chain` (JSON via stdin) | Run a sequence of commands. Pipe `[["cmd","arg1",...],...]` to `$B chain`. Stops at first error. |
| `inbox [--clear]` | List messages from sidebar scout inbox |
| `watch [stop]` | Passive observation — periodic snapshots while user browses; `stop` returns summary |

### Browser-skills runtime

| Command | Description |
|---------|-------------|
| `skill list` | List all browser-skills with resolved tier (project > global > bundled) |
| `skill show <name>` | Print SKILL.md |
| `skill run <name> [--arg k=v...] [--timeout=Ns]` | Spawn the skill script with a per-spawn scoped token |
| `skill test <name>` | Run the skill's `script.test.ts` against bundled fixtures |
| `skill rm <name> [--global]` | Tombstone a user-tier skill |

### Domain-skills

| Command | Description |
|---------|-------------|
| `domain-skill save\|list\|show\|edit\|promote-to-global\|rollback\|rm <host?>` | Per-site agent notes (host derived from active tab). Lifecycle: quarantined → active (after N=3 successful uses without classifier flag) → global (explicit promote) |

Aliases: `setcontent`, `set-content`, `setContent` → `load-html` (canonicalized
before scope checks, so a read-scoped token can't use the alias to run a
write command).

---

## Snapshot system

The browser's key innovation is **ref-based element selection** built on
Playwright's accessibility tree API. No DOM mutation. No injected scripts.
Just Playwright's native AX API.

### How `@ref` works

1. `page.locator(scope).ariaSnapshot()` returns a YAML-like accessibility tree.
2. The snapshot parser assigns refs (`@e1`, `@e2`, ...) to each element.
3. For each ref, it builds a Playwright `Locator` (using `getByRole` + nth-child).
4. The ref→Locator map is stored on `BrowserManager`.
5. Later commands like `click @e3` look up the Locator and call `locator.click()`.

### Ref staleness detection

SPAs can mutate the DOM without navigation (React router, tab switches,
modals). When this happens, refs collected from a previous `snapshot` may
point to elements that no longer exist. `resolveRef()` runs an async
`count()` check before using any ref — if the element count is 0, it throws
immediately with a message telling the agent to re-run `snapshot`. Fails fast
(~5ms) instead of waiting for Playwright's 30-second action timeout.

### Extended snapshot features

- **`--diff` (`-D`).** Stores each snapshot as a baseline. On the next `-D`
  call, returns a unified diff showing what changed. Use this to verify that
  an action (click, fill, etc.) actually worked.
- **`--annotate` (`-a`).** Injects temporary overlay divs at each ref's
  bounding box, takes a screenshot with ref labels visible, then removes the
  overlays. Use `-o <path>` to control the output.
- **`--cursor-interactive` (`-C`).** Scans for non-ARIA interactive elements
  (divs with `cursor:pointer`, `onclick`, `tabindex>=0`) using `page.evaluate`.
  Assigns `@c1`, `@c2`... refs with deterministic `nth-child` CSS selectors.
  These are elements the ARIA tree misses but users can still click.

---

## Browser-skills runtime

Per-task directories that codify a repeated browser flow into a deterministic
Playwright script. The compounding layer.

### Anatomy of a browser-skill

```
browser-skills/<name>/
├── SKILL.md                        # frontmatter + prose contract
├── script.ts                       # deterministic Playwright-via-browse-client logic
├── _lib/browse-client.ts           # vendored copy of the SDK (~3KB, byte-identical to canonical)
├── fixtures/<host>-<date>.html     # captured page for fixture-replay tests
└── script.test.ts                  # parser tests against the fixture (no daemon required)
```

The bundled reference is `browser-skills/hackernews-frontpage/`: scrapes the
HN front page, returns 30 stories as JSON. Try it:

```bash
$B skill list                            # shows hackernews-frontpage (bundled)
$B skill show hackernews-frontpage
$B skill run hackernews-frontpage        # JSON of 30 stories in ~200ms
$B skill test hackernews-frontpage       # runs script.test.ts against fixture
```

### Three-tier storage

`$B skill list` walks all three in priority order; first hit wins. Resolved
tier is printed inline next to each skill name:

| Tier | Path | When |
|------|------|------|
| **Project** | `<project>/.gstack/browser-skills/<name>/` | Project-specific skills (committed or gitignored) |
| **Global** | `~/.gstack/browser-skills/<name>/` | Per-user skills, all projects |
| **Bundled** | `<gstack-install>/browser-skills/<name>/` | Ships with gstack, read-only |

### Trust model

Two orthogonal axes — daemon-side capability and process-side env — independently
configured.

| Axis | Mechanism | Default |
|------|-----------|---------|
| **Daemon-side capability** | Per-spawn scoped token bound to read+write scope (browser-driving commands minus admin: `eval`, `js`, `cookies`, `storage`). Single-use clientId encodes skill name + spawn id. Revoked when spawn exits. | Always scoped — never the daemon root token |
| **Process-side env** | `trusted: true` frontmatter passes `process.env` minus `GSTACK_TOKEN`. `trusted: false` (default) drops everything except a minimal allowlist (LANG, LC_ALL, TERM, TZ) and pattern-strips secrets (TOKEN/KEY/SECRET/PASSWORD, AWS_*, ANTHROPIC_*, OPENAI_*, GITHUB_*, etc.) | Untrusted (must opt in) |

`GSTACK_PORT` and `GSTACK_SKILL_TOKEN` are injected last, so a parent process
can't override them.

### Output protocol

stdout = JSON. stderr = streaming logs. Exit 0 / non-zero. Default 60s
timeout, override via `--timeout=Ns`. Max stdout 1MB (truncate + non-zero
exit if exceeded). Matches `gh` / `kubectl` / `docker` conventions.

### How the SDK distribution works

Each skill ships its own copy of `browse-client.ts` at `_lib/browse-client.ts`,
byte-identical to the canonical `browse/src/browse-client.ts`. `/skillify`
copies the canonical SDK alongside every generated script. Each skill is
fully self-contained: copy the directory anywhere, it runs. Version drift
impossible — the SDK is frozen at the version the skill was authored against.

### Atomic write discipline (`/skillify` D3)

`browse/src/browser-skill-write.ts` provides three primitives:

- `stageSkill(opts)` — writes files to `~/.gstack/.tmp/skillify-<spawnId>/<name>/`
  with restrictive perms.
- `commitSkill(opts)` — atomic `fs.renameSync` into the final tier path.
  Refuses to follow symlinked staging dirs (`lstat` check), refuses to
  clobber existing skills, runs `realpath` discipline on the tier root.
- `discardStaged(stagedDir)` — `rm -rf` the staged dir + per-spawn wrapper.
  Idempotent. Called on test failure or approval rejection.

There is no "almost shipped" state. Tests pass + user approves = atomic
rename. Tests fail or user rejects = staging vanishes.

See [`docs/designs/BROWSER_SKILLS_V1.md`](docs/designs/BROWSER_SKILLS_V1.md)
for the full design rationale.

---

## Domain-skills

Different mental model from browser-skills: agent-authored *notes* about a
site (not deterministic scripts). One per hostname. Lifecycle:

1. `domain-skill save <host>` — agent writes a note about the site (e.g.,
   "GitHub: PR creation needs `--draft` flag for non-staff", "X.com: timeline
   uses cursor pagination, not page numbers"). Default state: **quarantined**.
2. After **N=3** successful uses without the L4 prompt-injection classifier
   flagging the note, it auto-promotes to **active**.
3. `domain-skill promote-to-global <host>` lifts it to the global tier
   (machine-wide, all projects).
4. `domain-skill rollback <host>` demotes; `domain-skill rm <host>` tombstones.

The classifier flag is set automatically by the L4 prompt-injection scan;
agents do not set it manually.

Storage:
- Per-project: `<project>/.gstack/domain-skills/<host>.md`
- Global: `~/.gstack/domain-skills/<host>.md`

Source: `browse/src/domain-skills.ts`, `domain-skill-commands.ts`.

---

## Real-browser mode

`$B connect` launches **GStack Browser** — a rebranded Chromium controlled by
Playwright with the Side Panel extension auto-loaded and anti-bot stealth
patches applied. You watch every command tick through a visible window in
real time.

```bash
$B connect              # launches GStack Browser, headed
$B goto https://app.com # navigates in the visible window
$B snapshot -i          # refs from the real page
$B click @e3            # clicks in the real window
$B focus                # bring window to foreground (macOS)
$B status               # shows Mode: cdp
$B disconnect           # back to headless mode
```

The window has a subtle golden shimmer line at the top and a floating
"gstack" pill in the bottom-right corner so you always know which Chrome
window is being controlled.

### What "GStack Browser" means

Not your daily Chrome — a Playwright-managed Chromium with custom branding
in the Dock and menu bar, anti-bot stealth (sites like Google and NYTimes
work without captchas), a custom user agent, and the gstack extension
pre-loaded via `launchPersistentContext`. Your regular Chrome with your tabs
and bookmarks stays untouched.

### When to use headed mode

- **QA testing** where you want to watch Claude click through your app
- **Design review** where you need to see exactly what Claude sees
- **Debugging** where headless behavior differs from real Chrome
- **Demos** where you're sharing your screen
- **Pair-agent** sessions (the remote agent drives your local browser)

### CDP-aware skills

When in real-browser mode, `/qa` and `/design-review` automatically skip
cookie import prompts and headless workarounds — the headed browser already
has whatever session you logged into.

### Headed mode + proxy + browser-native downloads (v1.28.0.0)

Three coordinated flags for sites that block headless browsers, fingerprint
Playwright defaults, or sit behind authenticated upstream proxies:

```bash
# Visible Chromium. Auto-spawns Xvfb on Linux containers without DISPLAY.
$B --headed goto https://example.com

# SOCKS5 with auth — Chromium can't prompt for SOCKS5 creds, so $B runs a
# local 127.0.0.1 bridge that handles the auth handshake.
$B --proxy socks5://user:pass@residential.proxy.host:1080 goto https://example.com

# HTTP/HTTPS proxy passes through to Chromium directly.
$B --proxy http://corp-proxy:3128 goto https://example.com

# Browser-native download for Content-Disposition, redirect chains, anti-bot
# CDNs where page.request.fetch() falls over.
$B download "https://protected.example.com/file" /tmp/file.bin --navigate

# Combined.
$B --headed --proxy socks5://user:pass@host:1080 \
   download "https://protected.example.com/file" /tmp/file.bin --navigate
```

**Credential policy.** Pass creds via the URL (`socks5://user:pass@host`) OR
the env vars `BROWSE_PROXY_USER` / `BROWSE_PROXY_PASS` — never both. `$B`
refuses with a clear hint when both are set; silent override created
"works on my machine" debugging traps.

**Daemon discipline.** `--proxy` and `--headed` are daemon-startup config.
A running daemon with config A meeting a new invocation with config B exits
1 with a `browse disconnect` hint instead of silently restarting and dropping
tab state, cookies, or sessions.

**Stealth scope.** When `--headed` or `--proxy` are set, `$B` masks
`navigator.webdriver` only — via Chromium's
`--disable-blink-features=AutomationControlled` plus a small init script.
We do NOT fake `navigator.plugins`, `navigator.languages`, or `window.chrome`
— modern fingerprinters check those for consistency, and synthesizing fixed
values can flag MORE bot-like, not less. ChromeDriver's `cdc_` runtime
artifacts and the Permissions API patch are still cleaned up.

**Container support.** `--headed` on Linux without `DISPLAY` walks the
display range (`:99`, `:100`, ...) until `xdpyinfo` reports a free slot,
then spawns Xvfb. Cleanup-on-disconnect validates the recorded PID's
`/proc/<pid>/cmdline` matches `Xvfb` AND start-time matches before sending
any signal — no PID-reuse footguns. Skips spawn entirely when
`WAYLAND_DISPLAY` is set (Chromium uses Wayland natively). Standard
Debian/Ubuntu containers work out of the box; minimal images (alpine,
distroless) may need fonts/dbus/gtk libs for headed Chromium to render.

**Failure modes.** SOCKS5 upstream rejected or unreachable — fail-fast at
startup with a redacted error after 3 retries (5s budget). Mid-stream
upstream drop — bridge kills the affected client connection only; no
transport retries that could corrupt browser traffic.

---

## Side Panel + sidebar agent

The Chrome extension that ships baked into GStack Browser shows a live
activity feed of every browse command in a Side Panel, plus `@ref` overlays
on the page, plus an interactive Claude PTY inside the sidebar.

### The Terminal pane (the headline)

The Side Panel's primary surface is the **Terminal pane** — a live `claude -p`
PTY you can type into directly from the sidebar. Activity / Refs / Inspector
are debug overlays behind the footer's `debug` toggle. WebSocket auth uses
`Sec-WebSocket-Protocol` (browsers can't set `Authorization` on a WebSocket
upgrade), and the PTY session token is a 30-minute HttpOnly cookie minted
via `POST /pty-session`.

The toolbar's Cleanup button and the Inspector's "Send to Code" action both
pipe text into the live Claude PTY via `window.gstackInjectToTerminal(text)`,
exposed by `sidepanel-terminal.js`. There's no separate `/sidebar-command`
POST — the live REPL is the only execution surface.

### Activity feed

A scrolling feed of every browse command — name, args, duration, status,
errors. Shows up in real time as Claude works. Backed by SSE (`/activity/stream`)
that accepts the Bearer token OR the HttpOnly `gstack_sse` session cookie
(30-minute stream-scope cookie minted via `POST /sse-session`).

### Refs tab

After `$B snapshot`, shows the current `@ref` list (role + name) so you can
see what Claude is targeting.

### CSS Inspector

Powered by `$B inspect` (CDP-based). Click any element on the page to see the
full CSS rule cascade, computed styles, box model, and modification history.
The "Send to Code" button injects a description into the Claude PTY.

### Sidebar architecture

| Component | Where it lives | Notes |
|-----------|----------------|-------|
| Side Panel UI | `extension/sidepanel.js`, `sidepanel-terminal.js` | Chrome extension surface |
| Background SW | `extension/background.js` | Manages tab events, port management |
| Content script | `extension/content.js` | Page overlays, `gstack` pill |
| Terminal agent | `browse/src/terminal-agent.ts` | PTY spawn, lifecycle, auth |
| Sidebar utilities | `browse/src/sidebar-utils.ts` | URL sanitization, helpers |

Before modifying any of these, read the comment block in `CLAUDE.md` under
"Sidebar architecture" — silent failures here usually trace to not understanding
the cross-component flow.

### Manual install (for your regular Chrome)

If you want the extension in your everyday Chrome (not the Playwright-controlled
one):

```bash
bin/gstack-extension    # opens chrome://extensions, copies path to clipboard
```

Or do it manually: `chrome://extensions` → toggle Developer mode → Load
unpacked → navigate to `~/.claude/skills/gstack/extension` → pin the
extension → enter the port from `$B status`.

---

## Pair-agent

Remote AI agents (Codex, OpenClaw, Hermes, anything that speaks HTTP) can
drive your local browser through an ngrok tunnel. The whole flow is gated
by a 26-command allowlist, scoped tokens, and a denial log.

### How it works

```bash
/pair-agent                     # generates a setup key, prints connection instructions
# Copy the instructions to the remote agent
# Remote agent runs:
#   POST <tunnel-url>/connect with setup key → gets a scoped token (24h, single client)
#   POST <tunnel-url>/command with token → runs allowed commands
```

### Dual-listener architecture (v1.6.0.0+)

When `pair-agent` activates, the daemon binds **two HTTP listeners**:

- **Local listener** (`127.0.0.1:LOCAL_PORT`). Full command surface. Never
  forwarded by ngrok. Used by your Claude Code, the Side Panel, anything
  on your machine.
- **Tunnel listener** (`127.0.0.1:TUNNEL_PORT`). Locked allowlist —
  `/connect`, `/command` (scoped tokens + 26-command browser-driving
  allowlist), `/sidebar-chat`. ngrok forwards only this port.

Root tokens sent over the tunnel return 403. SSE endpoints use a 30-minute
HttpOnly `gstack_sse` cookie (never valid against `/command`).

### The 26-command tunnel allowlist

Defined in `browse/src/server.ts` as `TUNNEL_COMMANDS`. Pure gate function
`canDispatchOverTunnel(command)` is exported for unit testing. Set:

```
goto, click, text, screenshot, html, links, forms, accessibility,
attrs, media, data, scroll, press, type, select, wait, eval,
newtab, tabs, back, forward, reload, snapshot, fill, url, closetab
```

Notably absent: `pair`, `unpair`, `cookies`, `setup`, `launch`, `restart`,
`stop`, `tunnel-start`, `token-mint`, `state`, `connect`, `disconnect`. A
remote agent that tries them gets a 403 plus a fresh entry in the denial log.

### Tunnel denial log

`~/.gstack/security/attempts.jsonl` — append-only, salted SHA-256 of source
+ domain only (no raw IP, no full request body), rotates at 10MB with 5
generations. Per-device salt at `~/.gstack/security/device-salt` (mode 0600).

See [`docs/REMOTE_BROWSER_ACCESS.md`](docs/REMOTE_BROWSER_ACCESS.md) for the
full operator guide.

### Tab ownership

Scoped tokens default to `tabPolicy: 'own-only'`. A paired agent can `newtab`
to create its own tab and drive that tab freely, but it can't `goto`, `fill`,
or `click` on tabs another caller owns. `tabs` lists ALL tab metadata (an
accepted tradeoff — see ARCHITECTURE.md), but `text`/`html`/`snapshot` content
of unowned tabs is blocked by ownership checks.

---

## Authentication

Three token types, three lifetimes, three scopes.

| Token | Generated by | Lifetime | Scope |
|-------|--------------|----------|-------|
| **Root token** | Daemon startup (random UUID) | Daemon process lifetime | Full command surface, local listener only — 403 over tunnel |
| **Setup key** | `POST /pair` | 5 minutes, one-time use | Single redemption: present at `/connect`, get a scoped token |
| **Scoped token** | `POST /connect` (with setup key) | 24 hours | Per-client, allowlist-bound, optionally tab-scoped |

The root token is written to `<project>/.gstack/browse.json` with chmod 600.
Every command that mutates browser state must include
`Authorization: Bearer <token>`.

### SSE session cookie (v1.6.0.0+)

SSE endpoints (`/activity/stream`, `/inspector/events`) accept the Bearer
token OR a 30-minute HttpOnly `gstack_sse` cookie minted via
`POST /sse-session`. The `?token=<ROOT>` query-param auth is no longer
supported. This is what lets the Chrome extension subscribe to the activity
feed without putting the root token in extension storage.

### PTY session cookie

The Terminal pane uses a separate session cookie, `gstack_pty`, minted via
`POST /pty-session`. Different scope — can spawn / drive the live `claude`
PTY, can't dispatch arbitrary `/command` calls. `/health` endpoint MUST NOT
surface this token.

### Token registry

`browse/src/token-registry.ts` handles mint/validate/revoke for all three
types, plus per-token rate limiting. Setup keys are single-use; scoped
tokens have a sliding 24h window; the root token is rotated on each daemon
startup.

---

## Security stack

Layered defense against prompt injection. Every layer runs synchronously on
every user message and every tool output that could carry untrusted content
(Read, Glob, Grep, WebFetch, page text from `$B`).

| Layer | Module | Lives in |
|-------|--------|----------|
| **L1** Datamarking | `content-security.ts` | both server + sidebar agent |
| **L2** Hidden-element strip | `content-security.ts` | both |
| **L3** ARIA + URL blocklist + envelope wrapping | `content-security.ts` | both |
| **L4** TestSavantAI ML classifier (22MB ONNX) | `security-classifier.ts` | sidebar-agent only* |
| **L4b** Claude Haiku transcript check | `security-classifier.ts` | sidebar-agent only |
| **L5** Canary token (session-exfil detection) | `security.ts` | both — inject in compiled, check in agent |
| **L6** `combineVerdict` ensemble | `security.ts` | both |

\* `security-classifier.ts` cannot be imported from the compiled browse
binary — `@huggingface/transformers` v4 requires `onnxruntime-node` which
fails to `dlopen` from Bun compile's temp extract dir. The compiled binary
runs L1–L3, L5, L6 only.

### Thresholds

- `BLOCK: 0.85` — single-layer score that would cause BLOCK if cross-confirmed
- `WARN: 0.75` — cross-confirm threshold. When L4 AND L4b both >= 0.75 → BLOCK
- `LOG_ONLY: 0.40` — gates transcript classifier (skip Haiku when all layers < 0.40)
- `SOLO_CONTENT_BLOCK: 0.92` — single-layer threshold for label-less content classifiers

### Ensemble rule

BLOCK only when the ML content classifier AND the transcript classifier both
report >= WARN. Single-layer high confidence degrades to WARN — this is the
Stack Overflow instruction-writing FP mitigation. **Canary leak always
BLOCKs (deterministic).**

### Env knobs

- `GSTACK_SECURITY_OFF=1` — emergency kill switch. Classifier stays off
  even if warmed. Canary is still injected; just the ML scan is skipped.
- `GSTACK_SECURITY_ENSEMBLE=deberta` — opt-in DeBERTa-v3 ensemble. Adds
  ProtectAI DeBERTa-v3-base-injection-onnx as L4c classifier. 721MB
  first-run download. With ensemble enabled, BLOCK requires 2-of-3 ML
  classifiers agreeing at >= WARN.
- Classifier model cache: `~/.gstack/models/testsavant-small/` (112MB, first
  run only) plus `~/.gstack/models/deberta-v3-injection/` (721MB, only when
  ensemble enabled).
- Attack log: `~/.gstack/security/attempts.jsonl` (salted SHA-256 + domain
  only, rotates at 10MB, 5 generations).
- Per-device salt: `~/.gstack/security/device-salt` (0600).
- Session state: `~/.gstack/security/session-state.json` (cross-process,
  atomic).

A shield icon in the sidebar header shows the live status. See
ARCHITECTURE.md § "Prompt injection defense" for the full threat model.

---

## Screenshots, PDFs, visual

### Screenshot modes

| Mode | Syntax | Playwright API |
|------|--------|----------------|
| Full page (default) | `screenshot [path]` | `page.screenshot({ fullPage: true })` |
| Viewport only | `screenshot --viewport [path]` | `page.screenshot({ fullPage: false })` |
| Element crop (flag) | `screenshot --selector <css> [path]` | `locator.screenshot()` |
| Element crop (positional) | `screenshot "#sel" [path]` or `screenshot @e3 [path]` | `locator.screenshot()` |
| Region clip | `screenshot --clip x,y,w,h [path]` | `page.screenshot({ clip })` |

Element crop accepts CSS selectors (`.class`, `#id`, `[attr]`) or `@e`/`@c`
refs. **Tag selectors like `button` aren't caught by the positional
heuristic** — use the `--selector` flag form.

`--base64` returns `data:image/png;base64,...` instead of writing to disk —
composes with `--selector`, `--clip`, `--viewport`.

Mutual exclusion: `--clip` + selector, `--viewport` + `--clip`, and
`--selector` + positional selector all throw.

### Retina screenshots — `viewport --scale`

`viewport --scale <n>` sets Playwright's `deviceScaleFactor` (context-level,
1–3 cap):

```bash
$B viewport 480x600 --scale 2
$B load-html /tmp/card.html
$B screenshot /tmp/card.png --selector .card
# .card at 400x200 CSS pixels → card.png is 800x400 pixels
```

`--scale N` alone (no `WxH`) keeps the current viewport size. Scale changes
trigger a context recreation, which invalidates `@e`/`@c` refs — rerun
`snapshot` after. HTML loaded via `load-html` survives the recreation via
in-memory replay. Rejected in headed mode (real browser controls scale).

### PDF generation

`pdf` accepts the full Playwright surface plus a few additions:

- **Layout:** `--format letter|a4|legal`, `--width <dim>`, `--height <dim>`,
  `--margins <dim>`, `--margin-top/right/bottom/left <dim>`
- **Structure:** `--toc` (waits for Paged.js if loaded), `--outline`,
  `--tagged` (PDF/A accessibility), `--print-background`,
  `--prefer-css-page-size`
- **Branding:** `--header-template <html>`, `--footer-template <html>`,
  `--page-numbers`
- **Tabs:** `--tab-id <N>` to render a specific tab
- **Large payloads:** `--from-file <payload.json>` (avoids shell argv limits)

### Responsive screenshots

`responsive [prefix]` — three screenshots in one call: mobile (375x812),
tablet (768x1024), desktop (1280x720). Saves as `{prefix}-mobile.png` etc.

### `prettyscreenshot`

Combines cleanup + scroll + element hide in one call:

```bash
$B prettyscreenshot --cleanup --scroll-to "hero section" --hide ".cookie-banner" /tmp/clean.png
```

---

## Local HTML

Two ways to render HTML that isn't on a web server:

| Approach | When | URL after | Relative assets |
|----------|------|-----------|-----------------|
| `goto file://<abs-path>` | File already on disk | `file:///...` | Resolve against file's directory |
| `goto file://./<rel>`, `goto file://~/<rel>` | Smart-parsed to absolute | `file:///...` | Same |
| `load-html <file>` | HTML generated in memory, no parent-dir context needed | `about:blank` | Broken (self-contained HTML only) |

Both are scoped to files under cwd or `$TMPDIR` via the same safe-dirs
policy as `eval`. `file://` URLs preserve query strings and fragments (SPA
routes work).

`load-html` has an extension allowlist (`.html`, `.htm`, `.xhtml`, `.svg`) and
a magic-byte sniff to reject binary files mis-renamed as HTML. 50MB size cap
(override via `GSTACK_BROWSE_MAX_HTML_BYTES`).

`load-html` content survives later `viewport --scale` calls via in-memory
replay (TabSession tracks the loaded HTML + waitUntil). The replay is
purely in-memory — HTML is never persisted to disk via `state save` to
avoid leaking secrets or customer data.

---

## Batch endpoint

`POST /batch` sends multiple commands in a single HTTP request. Eliminates
per-command round-trip latency — critical for remote agents over ngrok where
each HTTP call costs 2-5s.

```json
POST /batch
Authorization: Bearer <token>

{
  "commands": [
    {"command": "text", "tabId": 1},
    {"command": "text", "tabId": 2},
    {"command": "snapshot", "args": ["-i"], "tabId": 3},
    {"command": "click", "args": ["@e5"], "tabId": 4}
  ]
}
```

Each command routes through `handleCommandInternal` — full security pipeline
(scope checks, domain validation, tab ownership, content wrapping) enforced
per command. Per-command error isolation: one failure doesn't abort the
batch. Max 50 commands per batch. Nested batches rejected. Rate limiting:
1 batch = 1 request against the per-agent limit.

Pattern: agent crawling 20 pages opens 20 tabs (individual `newtab` or
batch), then `POST /batch` with 20 `text` commands → 20 page contents in
~2-3 seconds total vs ~40-100 seconds serial.

---

## Capture

Console, network, and dialog events flow into O(1) circular buffers (50,000
capacity each), flushed to disk asynchronously via `Bun.write()`:

- Console: `.gstack/browse-console.log`
- Network: `.gstack/browse-network.log`
- Dialog: `.gstack/browse-dialog.log`

The `console`, `network`, and `dialog` commands read from the in-memory
buffers (not disk) so capture is real-time even when disk is slow.

Dialogs (alert, confirm, prompt) are auto-accepted by default to prevent
browser lockup. `dialog-accept <text>` controls prompt response text.

---

## JS execution

`js` runs an inline expression. `eval` runs a JS file. Both run in the
**same JS sandbox** — the only difference is inline-vs-file. Both support
`await` — expressions containing `await` are auto-wrapped in an async
context:

```bash
$B js "await fetch('/api/data').then(r => r.json())"   # auto-wrapped
$B js "document.title"                                  # no wrap needed
$B eval my-script.js                                    # file with await
```

For `eval` files, single-line files return the expression value directly.
Multi-line files need explicit `return` when using `await`. Comments
containing the literal token "await" don't trigger wrapping.

Path safety: `eval` rejects paths outside cwd or `/tmp`. `js` doesn't read
files at all.

---

## Tabs, frames, state

### Tabs

```bash
$B tabs                          # list all open tabs
$B tab 3                         # switch to tab 3
$B newtab https://example.com    # open new tab, switch to it
$B newtab --json                 # programmatic: returns {"tabId":N,"url":...}
$B closetab                      # close current
$B closetab 2                    # close tab 2
$B tab-each "text"               # run "text" on every tab, return JSON
```

`tab-each <command>` fans out a command across every open tab and returns a
JSON array — handy for "give me the text of every tab I have open."

### Frames

```bash
$B frame "#stripe-iframe"        # switch to iframe by selector
$B frame @e7                     # by ref
$B frame --name "checkout"       # by name attribute
$B frame --url "stripe.com"      # by URL pattern match
$B frame main                    # back to top frame
```

Refs are cleared on switch (the iframe has its own AX tree).

### State save/load

```bash
$B state save my-session         # save cookies + URLs to .gstack/browse-state-my-session.json
$B state load my-session         # restore
```

In-memory `load-html` content is intentionally NOT persisted (avoid leaking
secrets to disk).

### Watch

```bash
$B watch                         # passive observation: snapshot every 5s while user browses
$B watch stop                    # return summary of what changed
```

Useful when you're driving the browser manually and want Claude to see what
you did at the end without spamming `snapshot` calls.

### Inbox

```bash
$B inbox                         # list messages from sidebar scout
$B inbox --clear                 # clear after reading
```

The sidebar scout (a background process the Chrome extension can spawn) drops
notes for Claude when the user surfaces something they want noticed. Stored
in `.gstack/browser-scout.jsonl`.

---

## CDP

### `$B cdp` — raw Chrome DevTools Protocol dispatch

Deny-default. Only methods enumerated in `browse/src/cdp-allowlist.ts`
(`CDP_ALLOWLIST` const) are reachable; any other method returns 403. Each
allowlist entry declares scope (tab vs browser) and output (trusted vs
untrusted). Untrusted methods (data-exfil-shaped, e.g.
`Network.getResponseBody`) get UNTRUSTED-envelope wrapped output.

```bash
$B cdp Page.getLayoutMetrics
$B cdp Network.enable
$B cdp Accessibility.getFullAXTree --json '{"max_depth":5}'
```

To discover allowed methods: read `browse/src/cdp-allowlist.ts`.

### `$B inspect` — CDP-based CSS inspector

```bash
$B inspect ".header"                # full rule cascade for the header
$B inspect ".header" --all          # include user-agent rules
$B inspect ".header" --history      # show modification history
```

Returns the matched rule cascade with specificity, computed styles, the box
model, and (with `--history`) every CSS modification made via `$B style` since
the page loaded. Powered by a persistent CDP session per page in
`browse/src/cdp-inspector.ts`.

### `$B ux-audit`

```bash
$B ux-audit
```

Returns JSON with site identity, navigation, headings (capped 50), text
blocks, interactive elements (capped 200) — page structure for behavioral
analysis without dumping the full HTML. Used by `/qa` and `/design-review`
for cheap coverage maps.

---

## Performance

| Tool | First call | Subsequent calls | Context overhead per call |
|------|-----------|------------------|---------------------------|
| Chrome MCP | ~5s | ~2-5s | ~2000 tokens (schema + protocol) |
| Playwright MCP | ~3s | ~1-3s | ~1500 tokens (schema + protocol) |
| **gstack browse** | **~3s** | **~100-200ms** | **0 tokens** (plain text stdout) |
| **gstack browse + codified skill** | **~3s** | **~200ms** | **0 tokens** (single skill invocation) |

In a 20-command browser session, MCP tools burn 30,000–40,000 tokens on
protocol framing alone. gstack burns zero. The codified-skill path takes a
20-command session down to a single `$B skill run` call.

### Why CLI over MCP

MCP works well for remote services. For local browser automation it adds
pure overhead:

- **Context bloat** — every MCP call includes full JSON schemas. A simple
  "get the page text" costs 10x more context tokens than it should.
- **Connection fragility** — persistent WebSocket/stdio connections drop
  and fail to reconnect.
- **Unnecessary abstraction** — Claude already has a Bash tool. A CLI that
  prints to stdout is the simplest possible interface.

gstack skips all of this. Compiled binary. Plain text in, plain text out.
No protocol. No schema. No connection management.

---

## Multi-workspace

Each project root (detected via `git rev-parse --show-toplevel`) gets its
own daemon, port, state file, cookies, and logs. No cross-workspace
collisions.

| Workspace | State file | Port |
|-----------|-----------|------|
| `/code/project-a` | `/code/project-a/.gstack/browse.json` | random (10000–60000) |
| `/code/project-b` | `/code/project-b/.gstack/browse.json` | random (10000–60000) |

Browser-skills three-tier lookup walks project → global → bundled, so a
project-tier skill at `/code/project-a/.gstack/browser-skills/foo/` shadows
the global `~/.gstack/browser-skills/foo/` only inside project-a.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSE_PORT` | 0 (random 10000–60000) | Fixed port for the HTTP server (debug override) |
| `BROWSE_IDLE_TIMEOUT` | 1800000 (30 min) | Idle shutdown timeout in ms |
| `BROWSE_STATE_FILE` | `.gstack/browse.json` | Path to state file |
| `BROWSE_SERVER_SCRIPT` | auto-detected | Path to `server.ts` |
| `BROWSE_CDP_URL` | (none) | Set to `channel:chrome` for real-browser mode |
| `BROWSE_CDP_PORT` | 0 | CDP port (used internally) |
| `BROWSE_HEADLESS_SKIP` | 0 | Skip Chromium launch entirely (test harness only) |
| `BROWSE_TUNNEL` | 0 | Activate the dual-listener tunnel architecture (requires `NGROK_AUTHTOKEN`) |
| `BROWSE_TUNNEL_LOCAL_ONLY` | 0 | Test-only — bind both listeners locally without ngrok |
| `GSTACK_BROWSE_MAX_HTML_BYTES` | 52428800 (50MB) | `load-html` size cap |
| `GSTACK_SECURITY_OFF` | unset | Emergency kill switch — disable ML classifier |
| `GSTACK_SECURITY_ENSEMBLE` | unset | Set to `deberta` for 3-classifier ensemble (721MB download) |

---

## Source map

```
browse/
├── src/
│   ├── cli.ts                   # Thin client — reads state, sends HTTP, prints
│   ├── server.ts                # Bun HTTP daemon — routes commands, dual-listener
│   ├── browser-manager.ts       # Chromium lifecycle, tabs, ref map, crash detection
│   ├── socks-bridge.ts          # Local 127.0.0.1 SOCKS5 bridge that handles auth handshakes Chromium can't speak
│   ├── proxy-config.ts          # --proxy URL parsing + cred resolution (URL vs env, fail-fast on both)
│   ├── proxy-redact.ts          # Cred-redaction helper for any proxy URL surfaced to logs/errors
│   ├── xvfb.ts                  # Xvfb auto-spawn + orphan cleanup with PID + start-time validation
│   ├── stealth.ts               # navigator.webdriver mask + cdc_ cleanup + Permissions API patch
│   ├── browse-client.ts         # Canonical SDK — what skills import as _lib/browse-client.ts
│   ├── snapshot.ts              # AX tree → @e/@c refs → Locator map; -D/-a/-C handling
│   ├── read-commands.ts         # Non-mutating: text, html, links, js, css, is, dialog, ...
│   ├── write-commands.ts        # Mutating: goto, click, fill, upload, dialog-accept, ...
│   ├── meta-commands.ts         # state, watch, inbox, frame, ux-audit, chain, diff, ...
│   ├── browser-skills.ts        # 3-tier walk + frontmatter parser + tombstones
│   ├── browser-skill-commands.ts # $B skill list/show/run/test/rm + spawnSkill
│   ├── browser-skill-write.ts   # D3 atomic stage/commit/discard helper for /skillify
│   ├── skill-token.ts           # mintSkillToken / revokeSkillToken (per-spawn, scoped)
│   ├── domain-skills.ts         # Per-site agent notes (state machine: quarantined→active→global)
│   ├── domain-skill-commands.ts # $B domain-skill save/list/show/edit/promote/rollback/rm
│   ├── cdp-allowlist.ts         # Deny-default CDP method allowlist
│   ├── cdp-bridge.ts            # CDP session lifecycle bridge
│   ├── cdp-commands.ts          # $B cdp dispatcher
│   ├── cdp-inspector.ts         # $B inspect — persistent CDP session per page
│   ├── activity.ts              # ActivityEntry, CircularBuffer, SSE subscribers, privacy filtering
│   ├── buffers.ts               # Console/network/dialog circular buffers (O(1) ring)
│   ├── tab-session.ts           # Per-tab session state (load-html replay, ref map scope)
│   ├── token-registry.ts        # Mint/validate/revoke for root + setup keys + scoped tokens
│   ├── sse-session-cookie.ts    # 30-min HttpOnly cookie for /activity/stream + /inspector/events
│   ├── pty-session-cookie.ts    # Separate scope: live Claude PTY auth
│   ├── tunnel-denial-log.ts     # ~/.gstack/security/attempts.jsonl writer (salted)
│   ├── path-security.ts         # validateOutputPath / validateReadPath / validateTempPath
│   ├── url-validation.ts        # URL safety checks for goto
│   ├── content-security.ts      # L1-L3: datamarking, hidden strip, ARIA, URL blocklist, envelopes
│   ├── security.ts              # L5 canary + L6 verdict combiner + thresholds
│   ├── security-classifier.ts   # L4 ML classifier (TestSavant + optional DeBERTa ensemble)
│   ├── terminal-agent.ts        # Side Panel Claude PTY manager (auth + lifecycle)
│   ├── sidebar-utils.ts         # Sidebar URL sanitization + helpers
│   ├── cookie-import-browser.ts # Decrypt + import cookies from real Chromium browsers
│   ├── cookie-picker-routes.ts  # HTTP routes for /cookie-picker/*
│   ├── cookie-picker-ui.ts      # Self-contained HTML/CSS/JS for cookie picker
│   ├── network-capture.ts       # Network request capture for $B network
│   ├── media-extract.ts         # Media element extraction for $B media
│   ├── project-slug.ts          # Project slug derivation for state paths
│   ├── error-handling.ts        # safeUnlink / safeKill / isProcessAlive
│   ├── platform.ts              # OS detection (macOS, Linux, Windows)
│   ├── telemetry.ts             # Anonymous opt-in usage telemetry
│   ├── find-browse.ts           # Locate running daemon or bootstrap
│   └── config.ts                # Config resolution (env / files)
├── test/                        # Integration tests + HTML fixtures
└── dist/
    └── browse                   # Compiled binary (~58MB, Bun --compile)

browser-skills/
└── hackernews-frontpage/        # Bundled reference skill
    ├── SKILL.md
    ├── script.ts
    ├── _lib/browse-client.ts
    ├── fixtures/hn-2026-04-26.html
    └── script.test.ts

scrape/SKILL.md.tmpl             # /scrape gstack skill — match-or-prototype entry point
skillify/SKILL.md.tmpl           # /skillify gstack skill — codify last /scrape into permanent skill
```

---

## Development

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- Playwright's Chromium (installed automatically by `bun install`)

### Quick start

```bash
bun install                      # install deps + Playwright Chromium
bun test                         # all integration tests (~3s for browse-only)
bun run dev <cmd>                # run CLI from source (no compile)
bun run build                    # compile to browse/dist/browse
```

### Dev mode vs compiled binary

During development, use `bun run dev` instead of the compiled binary. It runs
`browse/src/cli.ts` directly with Bun, so you get instant feedback:

```bash
bun run dev goto https://example.com
bun run dev text
bun run dev snapshot -i
bun run dev click @e3
```

The compiled binary (`bun run build`) is only needed for distribution. It
produces a single ~58MB executable at `browse/dist/browse` using Bun's
`--compile` flag.

### Running tests

```bash
bun test                                    # all tests
bun test browse/test/commands               # command integration tests
bun test browse/test/snapshot               # snapshot tests
bun test browse/test/cookie-import-browser  # cookie import unit tests
bun test browse/test/browser-skill-write    # D3 atomic-write helper tests
bun test browse/test/tunnel-gate-unit       # canDispatchOverTunnel pure tests
```

Tests spin up a local HTTP server (`browse/test/test-server.ts`) serving HTML
fixtures from `browse/test/fixtures/`, then exercise the CLI against those
pages.

### Adding a new command

1. Add the handler in `read-commands.ts` (non-mutating) or `write-commands.ts`
   (mutating), or `meta-commands.ts` (server / lifecycle).
2. Register the route in `server.ts`.
3. Add the entry to `COMMAND_DESCRIPTIONS` in `browse/src/commands.ts` (with
   a clear `description` and `usage` — the `gen-skill-docs` validation
   suite enforces no `|` characters in `description`).
4. Add a test case in `browse/test/commands.test.ts` with an HTML fixture
   if needed.
5. Run `bun test` to verify.
6. Run `bun run build` to compile.
7. Run `bun run gen:skill-docs` to regenerate SKILL.md (the command appears
   in the command-reference table downstream).

### Adding a new browser-skill

For a hand-written skill: copy `browser-skills/hackernews-frontpage/`,
update SKILL.md frontmatter, rewrite `script.ts` against your target site,
re-capture the fixture, update the parser test. `bun test` validates the
SKILL.md contract (sibling SDK byte-identity, frontmatter schema).

For an agent-written skill: drive the page once with `/scrape <intent>`,
say `/skillify`, accept the proposed name in the approval gate. The skill
lands at `~/.gstack/browser-skills/<name>/` after the test passes.

### Deploying to the active skill

The active skill lives at `~/.claude/skills/gstack/`. After making changes:

```bash
cd ~/.claude/skills/gstack
git fetch origin && git reset --hard origin/main
bun run build
```

Or copy the binary directly:

```bash
cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse
```

---

## Cross-references

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system-level architecture, dual-listener tunnel design, prompt-injection defense threat model
- [`CLAUDE.md`](CLAUDE.md) — project-level instructions, sidebar architecture notes, security-stack constraints
- [`docs/REMOTE_BROWSER_ACCESS.md`](docs/REMOTE_BROWSER_ACCESS.md) — operator guide for `/pair-agent` (setup keys, scoped tokens, denial log)
- [`docs/designs/BROWSER_SKILLS_V1.md`](docs/designs/BROWSER_SKILLS_V1.md) — design doc for browser-skills runtime (Phase 1 + 2a + roadmap)
- [`scrape/SKILL.md`](scrape/SKILL.md) — `/scrape` skill: match-or-prototype data extraction
- [`skillify/SKILL.md`](skillify/SKILL.md) — `/skillify` skill: codify last `/scrape` into permanent skill
- [`TODOS.md`](TODOS.md) — `/automate` (Phase 2b P0), Phase 3 resolver injection, Phase 4 eval + sandbox

---

## Acknowledgments

The browser automation layer is built on [Playwright](https://playwright.dev/)
by Microsoft. Playwright's accessibility tree API, locator system, and
headless Chromium management are what make ref-based interaction possible.
The snapshot system — assigning `@ref` labels to AX tree nodes and mapping
them back to Playwright Locators — is built entirely on top of Playwright's
primitives. Thank you to the Playwright team for building such a solid
foundation.

The prompt-injection L4 layer uses
[TestSavantAI/distilbert-v1.1-32](https://huggingface.co/TestSavantAI/distilbert-v1.1-32)
(112MB ONNX), and the optional ensemble layer uses
[ProtectAI/deberta-v3-base-prompt-injection-v2](https://huggingface.co/protectai/deberta-v3-base-prompt-injection-v2)
(721MB ONNX) — both run locally via `@huggingface/transformers`.

The CDP escape hatch is gated by an allowlist directly inspired by Codex's
T2 outside-voice review during the v1.4 design pass: deny-default with an
explicit allowlist, not allow-default with a denylist.
