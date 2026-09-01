---
name: browse
description: Use when fast headless browser for qa testing and site dogfooding. (Ported from gstack to Hermes)
version: 1.0.0
author: gstack (port: Hermes Agent)
license: MIT
metadata:
  hermes:
    tags: [gstack, ported, workflow]
    related_skills: [hermes-agent, hermes-agent-skill-authoring]
    upstream: https://github.com/garrytan/gstack/blob/main/browse/SKILL.md
---
## When to Use

Navigate any URL, interact with
elements, verify page state, diff before/after actions, take annotated screenshots, check
responsive layouts, test forms and uploads, handle dialogs, and assert element states.
~100ms per command. Use when you need to test a feature, verify a deployment, dogfood a
user flow, or file a bug with evidence. Use when asked to "open in browser", "test the
site", "take a screenshot", or "dogfood this".

## Preamble

_Replaces the gstack `gstack-skill-start` preamble. In Hermes, use `session_search` to recover prior context, then proceed._

## Artifacts Sync

_Replaces gstack artifacts sync. In Hermes, `session_search` handles cross-session context recovery automatically._

## Model-Specific Behavioral Patch (claude)

The following nudges are tuned for the claude model family. They are
**subordinate** to skill workflow, STOP points, AskUserQuestion gates, plan-mode
safety, and /ship review gates. If a nudge below conflicts with skill instructions,
the skill wins. Treat these as preferences, not rules.

**Todo-list discipline.** When working through a multi-step plan, mark each task
complete individually as you finish it. Do not batch-complete at the end. If a task
turns out to be unnecessary, mark it skipped with a one-line reason.

**Think before heavy actions.** For complex operations (refactors, migrations,
non-trivial new features), briefly state your approach before executing. This lets
the user course-correct cheaply instead of mid-flight.

**Dedicated tools over Bash.** Prefer Read, Edit, Write, Glob, Grep over shell
equivalents (cat, sed, find, grep). The dedicated tools are cheaper and clearer.

## Voice

Direct, concrete, builder-to-builder. Name the file, function, command, and user-visible impact. No filler.

No em dashes. No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, multifaceted. Never corporate or academic. Short paragraphs. End with what to do.

The user has context you do not. Cross-model agreement is a recommendation, not a decision. The user decides.

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — completed with evidence.
- **DONE_WITH_CONCERNS** — completed, but list concerns.
- **BLOCKED** — cannot proceed; state blocker and what was tried.
- **NEEDS_CONTEXT** — missing info; state exactly what is needed.

Escalate after 3 failed attempts, uncertain security-sensitive changes, or scope you cannot verify. Format: `STATUS`, `REASON`, `ATTEMPTED`, `RECOMMENDATION`.

## Operational Self-Improvement

_Replaces gstack `gstack-learnings-log`. In Hermes, durable learnings are saved via the `memory` tool, and reusable workflows become `skill_manage` entries._

## Telemetry

_Replaces `gstack-skill-end`. In Hermes, log durable facts to `memory` and continue. The Hermes gateway handles cross-session metrics._

## Section index — Read each section when its situation applies

This skill is a decision-tree skeleton. The steps below point to on-demand
sections. Read a section in full before doing its step; do not work from memory.

| When | Read this section |
|------|-------------------|
| using any command or snapshot flag beyond the Most-Used Commands table — the full generated reference for every browse command, its argument shape, and every snapshot flag | `sections/command-list.md` |

## Core QA Patterns

### 1. Verify a page loads correctly
```bash
terminal goto https://yourapp.com
terminal text                          # content loads?
terminal console                       # JS errors?
terminal network                       # failed requests?
terminal is visible ".main-content"    # key elements present?
```

### 2. Test a user flow
```bash
terminal goto https://app.com/login
terminal snapshot -i                   # see all interactive elements
terminal fill @e3 "user@test.com"
terminal fill @e4 "password"
terminal click @e5                     # submit
terminal snapshot -D                   # diff: what changed after submit?
terminal is visible ".dashboard"       # success state present?
```

### 3. Verify an action worked
```bash
terminal snapshot                      # baseline
terminal click @e3                     # do something
terminal snapshot -D                   # unified diff shows exactly what changed
```

### 4. Visual evidence for bug reports
```bash
terminal snapshot -i -a -o /tmp/annotated.png   # labeled screenshot
terminal screenshot /tmp/bug.png                # plain screenshot
terminal console                                # error log
```

Two behaviors that silently invalidate screenshots (#2445 — designed, but
surprising):
- **`hover` scrolls its target into view.** Hovering anything below the fold
  scrolls the page first, so a "rest state" shot taken afterwards captures
  the wrong section with exit 0. Before a rest-state screenshot, hover only
  something already visible, and assert position when it matters:
  `terminal js "window.scrollY"` should be `0` (or your intended offset).
- **The tab persists across sessions.** The daemon keeps its tab between your
  sessions, so `reload` or `screenshot` without a preceding `goto` can act on
  whatever page earlier work left open. Start verification passes with an
  explicit `terminal goto <url>`, never a bare `reload`.

### 5. Find all clickable elements (including non-ARIA)
```bash
terminal snapshot -C                   # finds divs with cursor:pointer, onclick, tabindex
terminal click @c1                     # interact with them
```

### 6. Assert element states
```bash
terminal is visible ".modal"
terminal is enabled "#submit-btn"
terminal is disabled "#submit-btn"
terminal is checked "#agree-checkbox"
terminal is editable "#name-field"
terminal is focused "#search-input"
terminal js "document.body.textContent.includes('Success')"
```

### 7. Test responsive layouts
```bash
terminal responsive /tmp/layout        # mobile + tablet + desktop screenshots
terminal viewport 375x812              # or set specific viewport
terminal screenshot /tmp/mobile.png
```

### 8. Test file uploads
```bash
terminal upload "#file-input" /path/to/file.pdf
terminal is visible ".upload-success"
```

### 9. Test dialogs
```bash
terminal dialog-accept "yes"           # set up handler
terminal click "#delete-button"        # trigger dialog
terminal dialog                        # see what appeared
terminal snapshot -D                   # verify deletion happened
```

### 10. Compare environments
```bash
terminal diff https://staging.app.com https://prod.app.com
```

### 11. Show screenshots to the user
After `terminal screenshot`, `terminal snapshot -a -o`, or `terminal responsive`, always use the read_file tool on the output PNG(s) so the user can see them. Without this, screenshots are invisible.

### 12. Render local HTML (no HTTP server needed)
Two paths, pick the cleaner one:
```bash
# HTML file on disk → goto file:// (absolute, or cwd-relative)
terminal goto file:///tmp/report.html
terminal goto file://./docs/page.html        # cwd-relative
terminal goto file://~/Documents/page.html   # home-relative

# HTML generated in memory → load-html reads the file into setContent
echo '<div class="tweet">hello</div>' > /tmp/tweet.html
terminal load-html /tmp/tweet.html
```

`goto file://...` is usually cleaner (URL is saved in state, relative asset URLs resolve against the file's dir, scale changes replay naturally). `load-html` uses `page.setContent()` — URL stays `about:blank`, but the content survives `viewport --scale` via in-memory replay. Both are scoped to files under cwd or `$TMPDIR`.

### 13. Retina screenshots (deviceScaleFactor)
```bash
terminal viewport 480x600 --scale 2       # 2x deviceScaleFactor
terminal load-html /tmp/tweet.html        # or: terminal goto file://./tweet.html
terminal screenshot /tmp/out.png --selector .tweet-card
# → /tmp/out.png is 2x the pixel dimensions of the element
```
Scale must be 1-3 (gstack policy cap). Changing `--scale` recreates the browser context; refs from `snapshot` are invalidated (rerun `snapshot`), but `load-html` content is replayed automatically. Not supported in headed mode.

### 14. Offline render mode (rasterize your own HTML/JSON, zero network)

This is the blessed path for "I just want to turn my own local HTML or JSON into a
PNG/PDF/bytes on disk" — Excalidraw diagrams, tweet/quote cards, og-images,
report rasterization. It is **plain headless, shared Chromium, no proxy, no Xvfb,
no anti-bot stealth**. Default `terminal` is already exactly this; you do not pass
`--headed` or `--proxy`. One Chromium per box, shared by every skill — **do not
`npm i puppeteer` and ship a second browser** (see the note under the cheatsheet).

Two output shapes, pick by what you have:

**A) Visual output → `screenshot --selector` (preferred).** If the thing you want
is a picture of something on the page, screenshot it. The PNG is written from the
browser process straight to disk — the image bytes never cross the CDP wire.

```bash
echo '<div id="card" style="width:400px;height:200px;background:#1da1f2;color:#fff;padding:20px">hi</div>' > /tmp/card.html
terminal viewport 480x600 --scale 2
terminal load-html /tmp/card.html
terminal screenshot /tmp/card.png --selector '#card'   # disk path — no megabytes over CDP
```
(Use the disk path, NOT `screenshot --base64` — base64 serializes the bytes back
through the command channel, which is the cost you're trying to avoid.)

**B) Bytes a function returns → `js --out` / `eval --out`.** When a library hands
you the result as a return value (a base64 data URL, a blob, computed JSON) rather
than painting a stable element — e.g. Excalidraw's export function returns a PNG
data URL — write the evaluate result straight to disk. `--out` decodes a
`data:*;base64,...` result to raw bytes automatically (pass `--raw` to write the
literal string). The payload is written by the daemon and never serialized back
out to the CLI/stdout.

```bash
# Load the render bundle, signal readiness, then render-to-file.
terminal load-html /tmp/excalidraw-export.html        # bundle sets window.__render + a #done flag
terminal wait '#done'                                  # deterministic ready handshake
terminal js "window.__render(SCENE_JSON)" --out /tmp/diagram.png   # data URL → decoded PNG on disk
```

`--out` is a WRITE: it needs the `write` scope and is never allowed over the
pair-agent tunnel (a remote agent can't write to your disk). Parent directories
are created; malformed base64 errors instead of writing corrupt bytes. Pick A when
you can (no CDP transfer at all); reach for B only when the bytes come back as a
return value.

## Puppeteer → browse cheatsheet

Migrating from Puppeteer? Here's the 1:1 mapping for the core workflow:

| Puppeteer | browse |
|---|---|
| `await page.goto(url)` | `terminal goto <url>` |
| `await page.setContent(html)` | `terminal load-html <file>` (or `terminal goto file://<abs>`) |
| `await page.setViewport({width, height})` | `terminal viewport WxH` |
| `await page.setViewport({width, height, deviceScaleFactor: 2})` | `terminal viewport WxH --scale 2` |
| `await (await page.$('.x')).screenshot({path})` | `terminal screenshot <path> --selector .x` |
| `await page.screenshot({fullPage: true, path})` | `terminal screenshot <path>` (full page default) |
| `await page.screenshot({clip: {x, y, w, h}, path})` | `terminal screenshot <path> --clip x,y,w,h` |
| `const r = await page.evaluate(fn)` | `terminal js "<expr>"` (result to stdout) |
| `fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1],'base64'))` | `terminal js "<expr>" --out <file>` (data URL auto-decoded) |

Worked example (the tweet-renderer flow — Puppeteer → browse):

```bash
# Generate HTML in memory, render at 2x scale, screenshot the tweet card.
echo '<div class="tweet-card" style="width:400px;height:200px;background:#1da1f2;color:white;padding:20px">hello</div>' > /tmp/tweet.html
terminal viewport 480x600 --scale 2
terminal load-html /tmp/tweet.html
terminal screenshot /tmp/out.png --selector .tweet-card
# /tmp/out.png is 800x400 px, crisp (2x deviceScaleFactor).
```

Aliases: typing `setcontent` or `set-content` routes to `load-html` automatically. Typing a typo (`load-htm`) returns `Did you mean 'load-html'?`.

**Don't bundle your own puppeteer/Chromium.** `browse` is the one shared Chromium
per box. Skills that need to rasterize local HTML/JSON (diagrams, cards, og-images)
should route through `browse` — `screenshot --selector` for visual output,
`load-html` + `js --out` for bytes a function returns — instead of
`npm i puppeteer` and downloading a second Chromium that drifts out of version sync.
One install to pin, one daemon's lifecycle to manage.

## Session Persistence (opt-in)

By default the headless daemon's cookies and tab state die with it — a crash,
version auto-restart, or `browse stop` logs you out of everything (#778).
Opt in to persistence with `BROWSE_PERSIST_STATE=1` in the daemon's
environment: the daemon then snapshots cookies + per-tab
URL/localStorage/sessionStorage to `<stateDir>/session-state.json` (0600)
every 30 seconds and at clean shutdown, and restores it on the next launch.

Facts that matter:
- **Default OFF.** Cookies on disk are a real cost; the user opts in.
- **Headless only.** Headed mode's persistent Chromium profile already owns
  its state; replaying tabs would clobber the user's window.
- **Never persisted:** loaded HTML and tab ownership — a tampered state file
  cannot smuggle content past load-html's checks or forge ownership. Cookies
  for localhost, `.internal`, and cloud-metadata addresses are dropped on
  restore.
- **Corrupt state** is moved to `session-state.json.corrupt` (kept for
  diagnosis) and the daemon boots fresh — persistence can never block a
  launch. The boot log says which happened: `Session state restored: N
  cookies / M tabs` or `fresh session`.

## User Handoff

When you hit something you can't handle in headless mode (CAPTCHA, complex auth, multi-factor
login), hand off to the user:

```bash
# 1. Open a visible Chrome at the current page
terminal handoff "Stuck on CAPTCHA at login page"

# 2. Tell the user what happened (via AskUserQuestion)
#    "I've opened Chrome at the login page. Please solve the CAPTCHA
#     and let me know when you're done."

# 3. When user says "done", re-snapshot and continue
terminal resume
```

**When to use handoff:**
- CAPTCHAs or bot detection
- Multi-factor authentication (SMS, authenticator app)
- OAuth flows that require user interaction
- Complex interactions the AI can't handle after 3 attempts

The browser preserves all state (cookies, localStorage, tabs) across the handoff.
After `resume`, you get a fresh snapshot of wherever the user left off.

## Headed Mode + Proxy + Anti-Bot Sites

For sites that block headless browsers, fingerprint Playwright defaults, or require routing through an authenticated SOCKS5 proxy (residential VPN, etc.), browse exposes three coordinated flags:

```bash
# Headed mode — visible Chromium window. Auto-spawns Xvfb on Linux
# containers without DISPLAY (no extra setup needed on Debian/Ubuntu).
browse --headed goto https://example.com

# SOCKS5 with auth (Chromium can't prompt for SOCKS5 creds itself —
# browse runs a local 127.0.0.1 bridge that handles the auth handshake).
browse --proxy socks5://user:pass@residential.proxy.host:1080 goto https://example.com

# HTTP/HTTPS proxy (passes through to Chromium directly):
browse --proxy http://corp-proxy:3128 goto https://example.com

# Browser-triggered file download (Content-Disposition, redirect chain,
# anti-bot CDN — falls back from page.request.fetch() to browser native
# download handler):
browse download "https://protected.example.com/file" /tmp/file.bin --navigate

# Combined: headed + proxy + navigate-download
browse --headed --proxy socks5://user:pass@host:1080 \
  download "https://protected.example.com/file" /tmp/file.bin --navigate
```

**Credential policy.** Pass creds via either the URL (`socks5://user:pass@host`) OR the env vars `BROWSE_PROXY_USER` and `BROWSE_PROXY_PASS` — never both. Browse refuses with a clear hint when both are set, because silent override creates "works on my machine" debugging traps.

**Daemon discipline.** Browse runs as a long-lived daemon. `--proxy` and `--headed` change daemon-startup config, so they only apply on a fresh daemon. If a daemon is already running with different config, browse refuses and tells you to `browse disconnect` first. No silent restart that would drop tab state, cookies, or logged-in sessions.

**Stealth.** When `--headed` or `--proxy` are set, browse masks `navigator.webdriver` (the obvious automation tell) via Chromium's `--disable-blink-features=AutomationControlled` plus a small init script. We do NOT fake `navigator.plugins`, `navigator.languages`, or `window.chrome` — modern fingerprinters check those for consistency, and synthesizing fixed values can flag MORE bot-like, not less.

**Container support.** `--headed` on Linux without `DISPLAY` automatically picks a free X display (`:99`, `:100`, ...) and spawns Xvfb. Cleanup on `browse disconnect` validates the recorded PID's `/proc/<pid>/cmdline` matches `Xvfb` AND start-time matches before sending any signal — no PID-reuse footguns. Standard Debian/Ubuntu containers work out of the box; minimal images (alpine, distroless) may also need fonts/dbus/gtk libs for headed Chromium to render.

**Failure modes.** SOCKS5 upstream rejected or unreachable → fail-fast at startup with a redacted error after 3 retries (5s budget). Mid-stream upstream drop → browse kills the affected client connection only; no transport retries (which could corrupt browser traffic). Mismatched daemon config → exit 1 with a `browse disconnect` hint.

## CSS Inspector & Style Modification

### Inspect element CSS
```bash
terminal inspect .header              # full CSS cascade for selector
terminal inspect                      # latest picked element from sidebar
terminal inspect --all                # include user-agent stylesheet rules
terminal inspect --history            # show modification history
```

### Modify styles live
```bash
terminal style .header background-color #1a1a1a   # modify CSS property
terminal style --undo                              # revert last change
terminal style --undo 2                            # revert specific change
```

### Clean screenshots
```bash
terminal cleanup --all                 # remove ads, cookies, sticky, social
terminal cleanup --ads --cookies       # selective cleanup
terminal prettyscreenshot --cleanup --scroll-to ".pricing" --width 1440 ~/Desktop/hero.png
```

## Most-Used Commands

The commands that cover most QA sessions (`terminal <command>`):

| Command | What it does |
|---------|--------------|
| `goto <url>` | Navigate (also `file://` paths) |
| `snapshot -i` | Accessibility tree with @e refs for interactive elements (`-D` diff, `-C` cursor-interactive @c refs, `-a -o <png>` annotated shot) |
| `click <sel>` / `fill <sel> <val>` | Interact — CSS selectors or @refs |
| `text` / `html [sel]` | Page text / HTML |
| `js "<expr>"` | Run JavaScript, result to stdout |
| `is <state> <sel>` | Assert visible/hidden/enabled/disabled/checked/editable/focused |
| `console` / `network` | JS errors / failed requests |
| `screenshot <path>` | Full-page PNG (`--selector <sel>` for one element) |
| `wait <sel>` | Wait for element (max 10s) |
| `viewport WxH` | Set viewport (`--scale 2` for retina) |

Everything else (extraction, tabs, dialogs, uploads, meta/server commands, and the
full snapshot-flag reference) lives in the generated section below — read it before
reaching for a command that is not in this table.

> **STOP.** Before using any command or snapshot flag beyond the Most-Used Commands table — the full generated reference for every browse command, its argument shape, and every snapshot flag, Read `~/.hermes/skills/gstack/browse/sections/command-list.md` and execute it
> in full. Do not work from memory — that section is the source of truth for this step.
