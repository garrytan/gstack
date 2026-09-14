# Design: Design Shotgun — Browser-to-Agent Feedback Loop

Generated on 2026-03-27
Branch: garrytan/agent-design-tools
Status: LIVING DOCUMENT — update as bugs are found and fixed

## What This Feature Does

Design Shotgun generates multiple AI design mockups, opens them side-by-side in the
user's real browser as a comparison board, and collects structured feedback (pick a
favorite, rate alternatives, leave notes, request regeneration). The feedback flows
back to the coding agent, which acts on it: either proceeding with the approved
variant or generating new variants and reloading the board.

The user never leaves their browser tab. The agent never asks redundant questions.
The board is the feedback mechanism.

## The Core Problem: Two Worlds That Must Talk

```
  ┌─────────────────────┐          ┌──────────────────────┐
  │   USER'S BROWSER    │          │   CODING AGENT       │
  │   (real Chrome)     │          │   (Claude Code /     │
  │                     │          │    Conductor)         │
  │  Comparison board   │          │                      │
  │  with buttons:      │   ???    │  Needs to know:      │
  │  - Submit           │ ──────── │  - What was picked   │
  │  - Regenerate       │          │  - Star ratings      │
  │  - More like this   │          │  - Comments          │
  │  - Remix            │          │  - Regen requested?  │
  └─────────────────────┘          └──────────────────────┘
```

The "???" is the hard part. The user clicks a button in Chrome. The agent running in
a terminal needs to know about it. These are two completely separate processes with
no shared memory, no shared event bus, no WebSocket connection.

## Architecture: How the Linkage Works

```
  USER'S BROWSER                    $D serve (Bun HTTP)              AGENT
  ═══════════════                   ═══════════════════              ═════
       │                                   │                           │
       │  GET /                            │                           │
       │ ◄─────── serves board HTML ──────►│                           │
       │    (with __GSTACK_SERVER_URL      │                           │
       │     injected into <head>)         │                           │
       │                                   │                           │
       │  [user rates, picks, comments]    │                           │
       │                                   │                           │
       │  POST /api/feedback               │                           │
       │ ─────── {preferred:"A",...} ─────►│                           │
       │                                   │                           │
       │  ◄── {received:true} ────────────│                           │
       │                                   │── writes feedback.json ──►│
       │  [inputs disabled,                │   (or feedback-pending    │
       │   "Return to agent" shown]        │    .json for regen)       │
       │                                   │                           │
       │                                   │                  [agent polls
       │                                   │                   every 5s,
       │                                   │                   reads file]
```

### The Three Files

| File | Written when | Means | Agent action |
|------|-------------|-------|-------------|
| `feedback.json` | User clicks Submit | Final selection, done | Read it, proceed |
| `feedback-pending.json` | User clicks Regenerate/More Like This | Wants new options | Read it, delete it, generate new variants, reload board |
| `feedback.json` (round 2+) | User clicks Submit after regeneration | Final selection after iteration | Read it, proceed |

### The State Machine

```
  $D serve starts
       │
       ▼
  ┌──────────┐
  │ SERVING  │◄──────────────────────────────────────┐
  │          │                                        │
  │ Board is │  POST /api/feedback                    │
  │ live,    │  {regenerated: true}                   │
  │ waiting  │──────────────────►┌──────────────┐     │
  │          │                   │ REGENERATING │     │
  │          │                   │              │     │
  └────┬─────┘                   │ Agent has    │     │
       │                         │ 10 min to    │     │
       │  POST /api/feedback     │ POST new     │     │
       │  {regenerated: false}   │ board HTML   │     │
       │                         └──────┬───────┘     │
       ▼                                │             │
  ┌──────────┐                POST /api/reload        │
  │  DONE    │                {html: "/new/board"}    │
  │          │                          │             │
  │ exit 0   │                          ▼             │
  └──────────┘                   ┌──────────────┐     │
                                 │  RELOADING   │─────┘
                                 │              │
                                 │ Board auto-  │
                                 │ refreshes    │
                                 │ (same tab)   │
                                 └──────────────┘
```

### Port Discovery

The agent backgrounds `$D serve` and reads stderr for the port:

```
SERVE_STARTED: port=54321 html=/path/to/board.html
SERVE_BROWSER_OPENED: url=http://127.0.0.1:54321
```

The agent parses `port=XXXXX` from stderr. This port is needed later to POST
`/api/reload` when the user requests regeneration. If the agent loses the port
number, it cannot reload the board.

### Why 127.0.0.1, Not localhost

`localhost` can resolve to IPv6 `::1` on some systems while Bun.serve() listens
on IPv4 only. More importantly, `localhost` sends all dev cookies for every domain
the developer has been working on. On a machine with many active sessions, this
blows past Bun's default header size limit (HTTP 431 error). `127.0.0.1` avoids
both issues.

## Every Edge Case and Pitfall

### 1. The Zombie Form Problem

**What:** User submits feedback, the POST succeeds, the server exits. But the HTML
page is still open in Chrome. It looks interactive. The user might edit their
feedback and click Submit again. Nothing happens because the server is gone.

**Fix:** After successful POST, the board JS:
- Disables ALL inputs (buttons, radios, textareas, star ratings)
- Hides the Regenerate bar entirely
- Replaces the Submit button with: "Feedback received! Return to your coding agent."
- Shows: "Want to make more changes? Run `/design-shotgun` again."
- The page becomes a read-only record of what was submitted

**Implemented in:** `compare.ts:showPostSubmitState()` (line 484)

### 2. The Dead Server Problem

**What:** The server times out (10 min default) or crashes while the user still has
the board open. User clicks Submit. The fetch() fails silently.

**Fix:** The `postFeedback()` function has a `.catch()` handler. On network failure:
- Shows red error banner: "Connection lost"
- Displays the collected feedback JSON in a copyable `<pre>` block
- User can copy-paste it directly into their coding agent

**Implemented in:** `compare.ts:showPostFailure()` (line 546)

### 3. The Stale Regeneration Spinner

**What:** User clicks Regenerate. Board shows spinner and polls `/api/progress`
every 2 seconds. Agent crashes or takes too long to generate new variants. The
spinner spins forever.

**Fix:** Progress polling has a hard 5-minute timeout (150 polls x 2s interval).
After 5 minutes:
- Spinner replaced with: "Something went wrong."
- Shows: "Run `/design-shotgun` again in your coding agent."
- Polling stops. Page becomes informational.

**Implemented in:** `compare.ts:startProgressPolling()` (line 511)

### 4. The file:// URL Problem (THE ORIGINAL BUG)

**What:** The skill template originally used `$B goto file:///path/to/board.html`.
But `browse/src/url-validation.ts:71` blocks `file://` URLs for security. The
fallback `open file://...` opens the user's macOS browser, but `$B eval` polls
Playwright's headless browser (different process, never loaded the page).
Agent polls empty DOM forever.

**Fix:** `$D serve` serves over HTTP. Never use `file://` for the board. The
`--serve` flag on `$D compare` combines board generation and HTTP serving in
one command.

**Evidence:** See `.context/attachments/image-v2.png` — a real user hit this exact
bug. The agent correctly diagnosed: (1) `$B goto` rejects `file://` URLs,
(2) no polling loop even with the browse daemon.

### 5. The Double-Click Race

**What:** User clicks Submit twice rapidly. Two POST requests arrive at the server.
First one sets state to "done" and schedules exit(0) in 100ms. Second one arrives
during that 100ms window.

**Current state:** NOT fully guarded. The `handleFeedback()` function doesn't check
if state is already "done" before processing. The second POST would succeed and
write a second `feedback.json` (harmless, same data). The exit still fires after
100ms.

**Risk:** Low. The board disables all inputs on the first successful POST response,
so a second click would need to arrive within ~1ms. And both writes would contain
the same feedback data.

**Potential fix:** Add `if (state === 'done') return Response.json({error: 'already submitted'}, {status: 409})` at the top of `handleFeedback()`.

### 6. The Port Coordination Problem

**What:** Agent backgrounds `$D serve` and parses `port=54321` from stderr. Agent
needs this port later to POST `/api/reload` during regeneration. If the agent
loses context (conversation compresses, context window fills up), it may not
remember the port.

**Current state:** The port is printed to stderr once. The agent must remember it.
There is no port file written to disk.

**Potential fix:** Write a `serve.pid` or `serve.port` file next to the board HTML
on startup. Agent can read it anytime:
```bash
cat "$_DESIGN_DIR/serve.port"  # → 54321
```

### 7. The Feedback File Cleanup Problem

**What:** `feedback-pending.json` from a regeneration round is left on disk. If the
agent crashes before reading it, the next `$D serve` session finds a stale file.

**Current state:** The polling loop in the resolver template says to delete
`feedback-pending.json` after reading it. But this depends on the agent following
instructions perfectly. Stale files could confuse a new session.

**Potential fix:** `$D serve` could check for and delete stale feedback files on
startup. Or: name files with timestamps (`feedback-pending-1711555200.json`).

### 8. Sequential Generate Rule

**What:** The underlying OpenAI GPT Image API rate-limits concurrent image generation
requests. When 3 `$D generate` calls run in parallel, 1 succeeds and 2 get aborted.

**Fix:** The skill template must explicitly say: "Generate mockups ONE AT A TIME.
Do not parallelize `$D generate` calls." This is a prompt-level instruction, not
a code-level lock. The design binary does not enforce sequential execution.

**Risk:** Agents are trained to parallelize independent work. Without an explicit
instruction, they will try to run 3 generates simultaneously. This wastes API calls
and money.

### 9. The AskUserQuestion Redundancy

**What:** After the user submits feedback via the board (with preferred variant,
ratings, comments all in the JSON), the agent asks them again: "Which variant do
you prefer?" This is annoying. The whole point of the board is to avoid this.

**Fix:** The skill template must say: "Do NOT use AskUserQuestion to ask the user's
preference. Read `feedback.json`, it contains their selection. Only AskUserQuestion
to confirm you understood correctly, not to re-ask."

### 10. The CORS Problem

**What:** If the board HTML references external resources (fonts, images from CDN),
the browser sends requests with `Origin: http://127.0.0.1:PORT`. Most CDNs allow
this, but some might block it.

**Current state:** The server does not set CORS headers. The board HTML is
self-contained (images base64-encoded, styles inline), so this hasn't been an
issue in practice.

**Risk:** Low for current design. Would matter if the board loaded external
resources.

### 11. The Large Payload Problem

**What:** No size limit on POST bodies to `/api/feedback`. If the board somehow
sends a multi-MB payload, `req.json()` will parse it all into memory.

**Current state:** In practice, feedback JSON is ~500 bytes to ~2KB. The risk is
theoretical, not practical. The board JS constructs a fixed-shape JSON object.

### 12. The fs.writeFileSync Error

**What:** `feedback.json` write in `serve.ts:138` uses `fs.writeFileSync()` with no
try/catch. If the disk is full or the directory is read-only, this throws and
crashes the server. The user sees a spinner forever (server is dead, but board
doesn't know).

**Risk:** Low in practice (the board HTML was just written to the same directory,
proving it's writable). But a try/catch with a 500 response would be cleaner.

## The Complete Flow (Step by Step)

### Happy Path: User Picks on First Try

```
1. Agent runs: $D compare --images "A.png,B.png,C.png" --output board.html --serve &
2. $D serve starts Bun.serve() on random port (e.g. 54321)
3. $D serve opens http://127.0.0.1:54321 in user's browser
4. $D serve prints to stderr: SERVE_STARTED: port=54321 html=/path/board.html
5. $D serve writes board HTML with injected __GSTACK_SERVER_URL
6. User sees comparison board with 3 variants side by side
7. User picks Option B, rates A: 3/5, B: 5/5, C: 2/5
8. User writes "B has better spacing, go with that" in overall feedback
9. User clicks Submit
10. Board JS POSTs to http://127.0.0.1:54321/api/feedback
    Body: {"preferred":"B","ratings":{"A":3,"B":5,"C":2},"overall":"B has better spacing","regenerated":false}
11. Server writes feedback.json to disk (next to board.html)
12. Server prints feedback JSON to stdout
13. Server responds {received:true, action:"submitted"}
14. Board disables all inputs, shows "Return to your coding agent"
15. Server exits with code 0 after 100ms
16. Agent's polling loop finds feedback.json
17. Agent reads it, summarizes to user, proceeds
```

### Regeneration Path: User Wants Different Options

```
1-6.  Same as above
7.  User clicks "Totally different" chiclet
8.  User clicks Regenerate
9.  Board JS POSTs to /api/feedback
    Body: {"regenerated":true,"regenerateAction":"different","preferred":"","ratings":{},...}
10. Server writes feedback-pending.json to disk
11. Server state → "regenerating"
12. Server responds {received:true, action:"regenerate"}
13. Board shows spinner: "Generating new designs..."
14. Board starts polling GET /api/progress every 2s

    Meanwhile, in the agent:
15. Agent's polling loop finds feedback-pending.json
16. Agent reads it, deletes it
17. Agent runs: $D variants --brief "totally different direction" --count 3
    (ONE AT A TIME, not parallel)
18. Agent runs: $D compare --images "new-A.png,new-B.png,new-C.png" --output board-v2.html
19. Agent POSTs: curl -X POST http://127.0.0.1:54321/api/reload -d '{"html":"/path/board-v2.html"}'
20. Server swaps htmlContent to new board
21. Server state → "serving" (from reloading)
22. Board's next /api/progress poll returns {"status":"serving"}
23. Board auto-refreshes: window.location.reload()
24. User sees new board with 3 fresh variants
25. User picks one, clicks Submit → happy path from step 10
```

### "More Like This" Path

```
Same as regeneration, except:
- regenerateAction is "more_like_B" (references the variant)
- Agent uses $D iterate --image B.png --brief "more like this, keep the spacing"
  instead of $D variants
```

### Fallback Path: $D serve Fails

```
1. Agent tries $D compare --serve, it fails (binary missing, port error, etc.)
2. Agent falls back to: open file:///path/board.html
3. Agent uses AskUserQuestion: "I've opened the design board. Which variant
   do you prefer? Any feedback?"
4. User responds in text
5. Agent proceeds with text feedback (no structured JSON)
```

## Files That Implement This

| File | Role |
|------|------|
| `design/src/serve.ts` | HTTP server, state machine, file writing, browser launch |
| `design/src/compare.ts` | Board HTML generation, JS for ratings/picks/regen, POST logic, post-submit lifecycle |
| `design/src/cli.ts` | CLI entry point, wires `serve` and `compare --serve` commands |
| `design/src/commands.ts` | Command registry, defines `serve` and `compare` with their args |
| `scripts/resolvers/design.ts` | `generateDesignShotgunLoop()` — template resolver that outputs the polling loop and reload instructions |
| `design-shotgun/SKILL.md.tmpl` | Skill template that orchestrates the full flow: context gathering, variant generation, `{{DESIGN_SHOTGUN_LOOP}}`, feedback confirmation |
| `design/test/serve.test.ts` | Unit tests for HTTP endpoints and state transitions |
| `design/test/feedback-roundtrip.test.ts` | E2E test: browser click → JS fetch → HTTP POST → file on disk |
| `browse/test/compare-board.test.ts` | DOM-level tests for the comparison board UI |

## What Could Still Go Wrong

### Known Risks (ordered by likelihood)

1. **Agent doesn't follow sequential generate rule** — most LLMs want to parallelize. Without enforcement in the binary, this is a prompt-level instruction that can be ignored.

2. **Agent loses port number** — context compression drops the stderr output. Agent can't reload the board. Mitigation: write port to a file.

3. **Stale feedback files** — leftover `feedback-pending.json` from a crashed session confuses the next run. Mitigation: clean on startup.

4. **fs.writeFileSync crash** — no try/catch on the feedback file write. Silent server death if disk is full. User sees infinite spinner.

5. **Progress polling drift** — `setInterval(fn, 2000)` over 5 minutes. In practice, JavaScript timers are accurate enough. But if the browser tab is backgrounded, Chrome may throttle intervals to once per minute.

### Things That Work Well

1. **Dual-channel feedback** — stdout for foreground mode, files for background mode. Both always active. Agent can use whichever works.

2. **Self-contained HTML** — board has all CSS, JS, and base64-encoded images inline. No external dependencies. Works offline.

3. **Same-tab regeneration** — user stays in one tab. Board auto-refreshes via `/api/progress` polling + `window.location.reload()`. No tab explosion.

4. **Graceful degradation** — POST failure shows copyable JSON. Progress timeout shows clear error message. No silent failures.

5. **Post-submit lifecycle** — board becomes read-only after submit. No zombie forms. Clear "what to do next" message.

## Test Coverage

### What's Tested

| Flow | Test | File |
|------|------|------|
| Submit → feedback.json on disk | browser click → file | `feedback-roundtrip.test.ts` |
| Post-submit UI lockdown | inputs disabled, success shown | `feedback-roundtrip.test.ts` |
| Regenerate → feedback-pending.json | chiclet + regen click → file | `feedback-roundtrip.test.ts` |
| "More like this" → specific action | more_like_B in JSON | `feedback-roundtrip.test.ts` |
| Spinner after regenerate | DOM shows loading text | `feedback-roundtrip.test.ts` |
| Full regen → reload → submit | 2-round trip | `feedback-roundtrip.test.ts` |
| Server starts on random port | port 0 binding | `serve.test.ts` |
| HTML injection of server URL | __GSTACK_SERVER_URL check | `serve.test.ts` |
| Invalid JSON rejection | 400 response | `serve.test.ts` |
| HTML file validation | exit 1 if missing | `serve.test.ts` |
| Timeout behavior | exit 1 after timeout | `serve.test.ts` |
| Board DOM structure | radios, stars, chiclets | `compare-board.test.ts` |

### What's NOT Tested

| Gap | Risk | Priority |
|-----|------|----------|
| Double-click submit race | Low — inputs disable on first response | P3 |
| Progress polling timeout (150 iterations) | Medium — 5 min is long to wait in a test | P2 |
| Server crash during regeneration | Medium — user sees infinite spinner | P2 |
| Network timeout during POST | Low — localhost is fast | P3 |
| Backgrounded Chrome tab throttling intervals | Medium — could extend 5-min timeout to 30+ min | P2 |
| Large feedback payload | Low — board constructs fixed-shape JSON | P3 |
| Concurrent sessions (two boards, one server) | Low — each $D serve gets its own port | P3 |
| Stale feedback file from prior session | Medium — could confuse new polling loop | P2 |

## Potential Improvements

### Short-term (this branch)

1. **Write port to file** — `serve.ts` writes `serve.port` to disk on startup. Agent reads it anytime. 5 lines.
2. **Clean stale files on startup** — `serve.ts` deletes `feedback*.json` before starting. 3 lines.
3. **Guard double-click** — check `state === 'done'` at top of `handleFeedback()`. 2 lines.
4. **try/catch file write** — wrap `fs.writeFileSync` in try/catch, return 500 on failure. 5 lines.

### Medium-term (follow-up)

5. **WebSocket instead of polling** — replace `setInterval` + `GET /api/progress` with a WebSocket connection. Board gets instant notification when new HTML is ready. Eliminates polling drift and backgrounded-tab throttling. ~50 lines in serve.ts + ~20 lines in compare.ts.

6. **Port file for agent** — write `{"port": 54321, "pid": 12345, "html": "/path/board.html"}` to `$_DESIGN_DIR/serve.json`. Agent reads this instead of parsing stderr. Makes the system more robust to context loss.

7. **Feedback schema validation** — validate the POST body against a JSON schema before writing. Catch malformed feedback early instead of confusing the agent downstream.

### Long-term (design direction)

8. **Persistent design server** — instead of launching `$D serve` per session, run a long-lived design daemon (like the browse daemon). Multiple boards share one server. Eliminates cold start. But adds daemon lifecycle management complexity.

9. **Real-time collaboration** — two agents (or one agent + one human) working on the same board simultaneously. Server broadcasts state changes via WebSocket. Requires conflict resolution on feedback.
