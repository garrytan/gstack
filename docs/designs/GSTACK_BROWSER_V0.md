# GStack Browser V0 — The AI-Native Development Browser

**Date:** 2026-03-30
**Author:** Garry Tan + Claude Code
**Status:** Phase 1a shipped, Phase 1b in progress
**Branch:** garrytan/gstack-as-browser

## The Thesis

Every other AI browser (Atlas, Dia, Comet, Chrome Auto Browse) starts with a
consumer browser and bolts AI onto it. GStack Browser inverts this. It starts
with Claude Code as the runtime and gives it a browser viewport.

The agent is the primary citizen. The browser is the canvas. Skills are
first-class capabilities. You don't "use a browser with AI help." You use
an AI that can see and interact with the web.

This is the IDE for the post-IDE era. Code lives in the terminal. The product
lives in the browser. The AI works across both simultaneously. What Cursor did
for text editors, GStack Browser does for the browser.

## What It Is Today (Phase 1a, shipped)

A double-clickable macOS .app that wraps Playwright's Chromium with the gstack
sidebar extension baked in. You open it and Claude Code can see your screen,
navigate pages, fill forms, take screenshots, inspect CSS, clean up overlays,
and run any gstack skill. All without touching a terminal.

```
GStack Browser.app (389MB, 189MB DMG)
├── Compiled browse binary (58MB) — CLI + HTTP server
├── Chrome extension (172KB) — sidebar, activity feed, inspector
├── Playwright's Chromium (330MB) — the actual browser
└── Launcher script — binds project dir, sets env vars
```

Launch → Chromium opens with sidebar → extension auto-connects to browse server
→ agent ready in ~5 seconds.

## What It Will Be

### Phase 1b: Developer UX (next)

**Command Palette (Cmd+K):** The signature interaction. Opens a fuzzy-filtered
skill picker. Type "/qa" to start QA testing, "/investigate" to debug, "/ship"
to create a PR. Skills are fetched from the browse server, not hardcoded. The
palette is the entry point to everything.

**Quick Screenshot (Cmd+Shift+S):** Capture the current viewport and pipe it into
the sidebar chat with "What do you see?" context. The AI analyzes the screenshot
and gives you actionable feedback. Visual bug reports in one keystroke.

**Status Bar:** A persistent 30px bar at the bottom of every page. Shows agent
status (idle/thinking), workspace name, current branch, and auto-detected dev
servers. Click a dev server pill to navigate. Always-visible context about what
the AI is doing.

**Auto-Detect Dev Servers:** On launch, scans common ports (3000, 3001, 4200,
5173, 5174, 8000, 8080). If exactly one server is found, auto-navigates to it.
Dev server pills in the status bar for one-click switching.

### Phase 2: BoomLooper Integration

The sidebar connects to BoomLooper's Phoenix/Elixir APIs instead of a local
`claude -p` subprocess. BoomLooper provides:

- **Multi-agent orchestration.** Spawn 5 agents in parallel, each with its own
  browser tab. One runs QA, one does design review, one watches for regressions.
- **Docker infrastructure.** Each agent gets an isolated container. The browser
  inside the container tests the dev server. No port conflicts, no state leakage.
- **Session persistence.** Agent conversations survive browser restarts. Pick up
  where you left off.
- **Team visibility.** Your teammates can watch what your agents are doing in
  real-time. Like pair programming, but the pair is 5 AI agents and you're the
  conductor.

### Phase 3: Browse as BoomLooper Tool

The browse binary becomes an MCP tool in BoomLooper. Agents in Docker containers
use browse commands to test dev servers, take screenshots, fill forms, and verify
deployments. Cross-platform compilation (linux-arm64/x64) required.

### Phase 4: Chromium Fork (trigger-gated)

When the extension side panel hits hard API limits, GStack Browser ships to
external users, build infra exists, and the business justifies maintenance:
fork Chromium. Brave's `chromium_src` override pattern, CC-powered 6-week
rebases (2-4 hours with CC vs 1-2 weeks human). ~20-30 files modified.

### Phase 5: Native Shell

SwiftUI/AppKit app shell with native sidebar, isolated Chromium service. Full
platform integration. May be superseded by Phase 4 if the Chromium fork includes
a native sidebar.

## Vision: What an AI Browser Can Do

### 1. See What You See

The browser is the AI's eyes. Not through screenshots (though it can do that),
but through DOM access, CSS inspection, network monitoring, and accessibility
tree parsing. The AI understands the page structure, not just the pixels.

**Today:** `snapshot` command returns an accessibility-tree representation of any
page. The AI can "see" every button, link, form field, and text element. Element
references (`@e1`, `@e2`) let the AI click, fill, and interact.

**Next:** Real-time page observation. The AI notices when a page changes, when an
error appears in the console, when a network request fails. Proactive debugging
without being asked.

**Future:** Visual understanding. The AI compares before/after screenshots to catch
visual regressions. Pixel-level design review. "This button moved 3px left and the
font changed from 14px to 13px."

### 2. Act on What It Sees

Not just reading pages, but interacting with them like a human user would.

**Today:** Click, fill, select, hover, type, scroll, upload files, handle dialogs,
navigate, manage tabs. All via simple commands through the browse server.

**Next:** Multi-step user flows. "Log in, go to settings, change the timezone,
verify the confirmation message." The AI chains commands with verification at each
step.

**Future:** Autonomous QA agent. "Test every link on this page. Fill every form.
Try to break it." The AI runs exhaustive interaction testing without a script.
Finds bugs a human tester would miss because it tries combinations humans don't
think of.

### 3. Write Code While Browsing

This is the key differentiator. The AI can see the bug in the browser AND fix it
in the code simultaneously.

**Today:** The sidebar chat connects to Claude Code. You say "this button is
misaligned" and the AI reads the CSS, identifies the issue, and proposes a fix.
The `/design-review` skill takes screenshots, identifies visual issues, and
commits fixes with before/after evidence.

**Next:** Live reload loop. The AI edits CSS/HTML, the browser auto-reloads, the
AI verifies the fix visually. No human in the loop for simple visual fixes.
"Fix every spacing issue on this page" becomes a 30-second task.

**Future:** Full-stack debugging. The AI sees a 500 error in the browser, reads
the server logs, traces to the failing line, writes the fix, and verifies in the
browser. One command: "This page is broken. Fix it."

### 4. Understand the Whole Stack

The browser isn't just a viewport. It's a window into the application's health.

**Today:**
- Console log capture — every `console.log`, `console.error`, and warning
- Network request monitoring — every XHR, fetch, websocket, and static asset
- Performance metrics — Core Web Vitals, resource timing, paint events
- Cookie and storage inspection — read and write localStorage, sessionStorage
- CSS inspection — computed styles, box model, rule cascade

**Next:**
- Network request replay — "replay this failing request with different params"
- Performance regression detection — "this page is 200ms slower than yesterday"
- Dependency auditing — "this page loads 47 third-party scripts"
- Accessibility auditing — "this form has no labels, these colors fail contrast"

**Future:**
- Full application telemetry — CPU, memory, GPU usage in real-time
- Cross-browser testing — same test suite across Chrome, Firefox, Safari
- Real user monitoring correlation — "this bug affects 12% of production users"

### 5. The Workspace Model

The browser IS the workspace. Not a tab in a workspace. The workspace itself.

**Today:** Each browser session is bound to a project directory. The sidebar shows
the current branch. The status bar shows detected dev servers.

**Next:** Multi-project support. Switch between projects without closing the
browser. Each project gets its own set of tabs, its own agent, its own context.
Like VSCode workspaces, but for the browser.

**Future:** Team workspaces. Multiple developers share a browser workspace. See
each other's agents working. Collaborative debugging where one person navigates
and the other watches the AI fix things in real-time.

### 6. Skills as Browser Capabilities

Every gstack skill becomes a browser capability.

| Skill | Browser Capability |
|-------|-------------------|
| `/qa` | Test every page, find bugs, fix them, verify fixes |
| `/design-review` | Screenshot → analyze → fix CSS → screenshot again |
| `/investigate` | See the error in browser → trace to code → fix → verify |
| `/benchmark` | Measure page performance → detect regressions → alert |
| `/canary` | Monitor deployed site → screenshot periodically → alert on changes |
| `/ship` | Run tests → review diff → create PR → verify deployment in browser |
| `/cso` | Audit page for XSS, open redirects, clickjacking in real browser |
| `/office-hours` | Browse competitor sites → synthesize observations → design doc |

The command palette (Cmd+K) is the hub. You don't need to know the skills exist.
You type what you want, the fuzzy filter finds the right skill, and the AI runs it
with the browser as context.

### 7. The Design Loop

AI-powered design is a loop, not a handoff.

```
Generate mockup (GPT Image API)
  → Review in browser (side-by-side with live site)
  → Iterate with feedback ("make the header taller")
  → Approve direction
  → Generate production HTML/CSS
  → Preview in browser
  → Fine-tune with /design-review
  → Ship
```

The browser closes the gap between "what it looks like in Figma" and "what it
looks like in production." Because the AI can see both simultaneously.

### 8. The Security Loop

CSO review in a real browser, not just static analysis.

- Inject XSS payloads into every input field, check if they execute
- Test CSRF by replaying requests from a different origin
- Check for open redirects by navigating to crafted URLs
- Verify CSP headers are actually enforced (not just present)
- Test auth flows by manipulating cookies and tokens in real-time
- Check for clickjacking by loading the site in an iframe

Static analysis catches patterns. Browser testing catches reality.

### 9. The Monitoring Loop

Post-deploy canary monitoring, in a real browser.

```
Deploy → Browser loads production URL
  → Screenshot baseline
  → Every 5 minutes: screenshot, compare, check console
  → Alert on: visual regression, new console errors, performance drop
  → Auto-rollback if critical error detected
```

Synthetic monitoring with AI judgment. Not just "did the page return 200" but
"does the page look right and work correctly."

## Architecture

```
+-------------------------------------------------------+
|                  GStack Browser                        |
|                                                        |
|  +------------------+  +---------------------------+  |
|  |   Chromium        |  |   Extension Side Panel    |  |
|  |   (Playwright)    |  |   ├── Chat (Claude Code)  |  |
|  |                   |  |   ├── Activity Feed        |  |
|  |   ┌────────────┐  |  |   ├── Element Refs         |  |
|  |   │ Status Bar  │  |  |   ├── CSS Inspector        |  |
|  |   └────────────┘  |  |   ├── Command Palette      |  |
|  +--------┬──────────+  |   └── Settings             |  |
|           │              +-------------┬--------------+  |
+-----------┼────────────────────────────┼─────────────────+
            │                            │
            v                            v
  +---------┴-----------+    +-----------┴-----------+
  |  Browse Server      |    |  Sidebar Agent        |
  |  (HTTP + SSE)       |    |  (claude -p wrapper)  |
  |  :34567             |    |  Runs gstack skills   |
  |                     |    |  Per-tab isolation     |
  |  Commands:          |    |                       |
  |  goto, click, fill  |    |  Future: BoomLooper   |
  |  snapshot, screenshot|   |  GenServer agents     |
  |  css, inspect, eval |    |                       |
  +---------┬-----------+    +-----------┬-----------+
            │                            │
            v                            v
  +---------┴-----------+    +-----------┴-----------+
  |  User's App         |    |  Claude Code          |
  |  localhost:3000     |    |  (reads/writes code)  |
  |  (or any URL)       |    |                       |
  +---------------------+    +-----------------------+
```

## Competitive Landscape

| Browser | Approach | Differentiator | Weakness |
|---------|----------|---------------|----------|
| **Atlas** | Chromium fork + AI layer | Agentic browser, "OWL" isolated Chromium | Consumer-focused, no code integration |
| **Dia** | AI-native browser | Clean UI, built for AI interaction | No dev tools, no code editing |
| **Comet** | AI browser | Multi-agent browsing | Early, unclear dev workflow |
| **Chrome Auto Browse** | Extension | Google's own, deep Chrome integration | Extension-only, no code editing |
| **Cursor** | VSCode fork + AI | Best-in-class code editing | No browser viewport |
| **GStack Browser** | CC runtime + browser viewport | See bug in browser, fix in code, verify | Currently macOS-only, no consumer features |

GStack Browser doesn't compete with consumer browsers. It competes with the
workflow of switching between browser and editor. The goal is to make that switch
invisible.

## Design System

From DESIGN.md:
- **Primary accent:** Amber-500 (#F59E0B) — agent active, focus states, pulse
- **Background:** Zinc-950 (#09090B) through Zinc-800 (#27272A) — dark, dense
- **Typography:** JetBrains Mono (code/status), DM Sans (UI/labels)
- **Border radius:** 8px (md), 12px (lg), full (pills)
- **Motion:** Pulse animation on agent active, 200ms transitions
- **Layout:** Sidebar (right), status bar (bottom), palette (centered overlay)

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| .app bundle | **SHIPPED** | 389MB, launches in ~5s |
| DMG packaging | **SHIPPED** | 189MB compressed |
| `GSTACK_CHROMIUM_PATH` | **SHIPPED** | Custom Chromium binary support |
| `BROWSE_EXTENSIONS_DIR` | **SHIPPED** | Extension path override |
| Auth via `/health` | **SHIPPED** | Replaces .auth.json file approach, auto-refreshes on server restart |
| Build script | **SHIPPED** | `scripts/build-app.sh` |
| Model routing | **SHIPPED** | Sonnet for actions, Opus for analysis (`pickSidebarModel`) |
| Debug logging | **SHIPPED** | 40+ silent catches → prefixed console logging across 4 files |
| No idle timeout (headed) | **SHIPPED** | Browser stays alive as long as window is open |
| Cookie import button | **SHIPPED** | One-click in sidebar footer, opens `/cookie-picker` |
| Sidebar arrow hint | **SHIPPED** | Points to sidebar, hides only when sidebar actually opens |
| Architecture doc | **SHIPPED** | `docs/designs/SIDEBAR_MESSAGE_FLOW.md` |
| Command palette | Planned | Phase 1b |
| Quick screenshot | Planned | Phase 1b |
| Status bar | Planned | Phase 1b |
| Dev server detection | Planned | Phase 1b |
| BoomLooper integration | Future | Phase 2 |
| Cross-platform | Future | Phase 3 |
| Chromium fork | Trigger-gated | Phase 4 |
| Native shell | Deferred | Phase 5 |

## The 12-Month Vision

```
TODAY (Phase 1)               6 MONTHS (Phase 2-3)          12 MONTHS (Phase 4-5)
─────────────                 ──────────────────            ────────────────────
macOS .app wrapper            BoomLooper multi-agent         Chromium fork OR
Extension sidebar             Docker containers              Native SwiftUI shell
Local claude -p agent         Team workspaces                Cross-platform
Single project                Linux/x64 browse               Auto-update
Manual skill invocation       Autonomous QA loops            Skill marketplace
                              Performance monitoring          Plugin API
                              Real-time collaboration         Enterprise features
```

The 12-month ideal: you open GStack Browser, it detects your project, starts
your dev server, runs your test suite, and reports what's broken. You say "fix
it" and the AI fixes every bug, verifies each fix visually, and creates a PR.
You review the PR in the same browser, approve it, and the AI deploys it and
monitors the canary. All in one window.

That's the browser as AI workspace. Not a browser with AI bolted on. An AI
with a browser bolted on.

## Review History

This plan went through 4 reviews:

1. **CEO Review** (`/plan-ceo-review`, SELECTIVE EXPANSION) — 9 scope proposals,
   3 accepted (Cmd+K, Cmd+Shift+S, status bar), 5 deferred, 1 skipped
2. **Design Review** (`/plan-design-review`) — scored 5/10 → 8/10, 9 design
   decisions added, 2 approved mockups generated
3. **Eng Review** (`/plan-eng-review`) — 4 issues found, 0 critical gaps,
   test plan produced
4. **Codex Review** (outside voice) — 9 findings, 3 critical gaps caught
   (server bundling, auth file location, project binding). All resolved.

The Codex review caught 3 real architecture gaps that survived 3 prior reviews.
Cross-model review works.
