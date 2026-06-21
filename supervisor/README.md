# supervisor — cstack agent fleet runner

Scripts for starting, stopping, and monitoring the autonomous agent fleet.

| File | Purpose |
|------|---------|
| `run-agent.sh` | Single-agent supervisor loop (v7 — real-time collaboration) |
| `fleet.sh` | Start/stop/status/logs for all agents at once |
| `fleet.conf` | Declare all agents in one place |
| `install.sh` | Register an agent as a launchd (macOS) or systemd (Linux) service |
| `wake-listen.ts` | Supabase Realtime subscriber — wakes idle agents in <1s cross-machine |
| `console/server.ts` | Console HTTP server (v7.1 — auto-detects control repo, gates risky Bash commands, streams live events via SSE) |
| `console/bin/bash` | Risk-gated Bash tool intercept (v7.1 — blocks destructive commands until approved) |
| `console/index.html` | Console UI entry point (v7.1 — serves static HTML with SSE support) |
| `console/console.js` | Console interactive client (v7.1 — card animations, empty states, AI draft panel, ARIA accessibility) |
| `console/styles.css` | Console design system (v7.1 — dark theme, motion tokens, Satoshi/DM Sans/JetBrains Mono typefaces) |
| `console/server-utils.ts` | Utility exports — parsing ledger/mailbox, task ID validation, fleet status reading, SSE helpers, watch handler (v7.1) |
| `console/bash-wrapper.test.ts` | Bun test wrapper that runs bash-wrapper.test.sh inline (v7.1) |
| `console/bash-wrapper.test.sh` | Bash unit tests for risk classification (check_risk) and polling behavior (poll_approval) (v7.1) |
| `console/server.test.ts` | Bun tests for endpoint security — taskId regex validation, agent name validation, needs_human endpoint (v7.1) |
| `console/qa-smoke.sh` | QA smoke test for console UI — asserts page title, nav bar, and Fleet tab are present via gstack browse (v7.1) |

---

## The full workflow

### Step 1 — One-time setup per agent (each machine)

Each agent needs a config file at `~/agents/<agent-name>/config`:

```bash
mkdir -p ~/agents/agent-be
cat > ~/agents/agent-be/config <<EOF
CONTROL_REPO_URL=git@github.com:your-org/your-control-repo.git
WORK_REPO_URL=git@github.com:your-org/your-backend-repo.git
AGENT_DOMAIN=be
EOF
```

Repeat for `agent-fe`, `agent-qa`, `agent-doc`. The `WORK_REPO_URL` is empty for QA/doc agents that only commit to the control repo.

**Optional — enable cross-machine Supabase wake (add to each config):**

```bash
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_KEY=<anon-or-service-role-key>
```

### Step 2 — Edit `fleet.conf` to match your agents

```
# supervisor/fleet.conf
agent-be    FEATURE_ROLE.md    claude-sonnet-4-6
agent-fe    FEATURE_ROLE.md    claude-sonnet-4-6
agent-qa    QA_ROLE.md         claude-sonnet-4-6
agent-doc   DOC_ROLE.md        claude-sonnet-4-6
```

### Step 3 — Choose: development mode or production mode

**Development** (one terminal, agents run in the background, stop when you kill the terminal):

```bash
cd supervisor/
./fleet.sh start    # starts all 4 agents in the background
./fleet.sh status   # see who's running / working / idle
./fleet.sh logs     # tail all 4 logs merged in one stream, Ctrl-C to exit
./fleet.sh stop     # stop all
```

**Production** (agents survive reboot, restart on crash, no terminal window needed):

```bash
cd supervisor/
./fleet.sh install    # registers all 4 as launchd services (macOS)
                      # they start immediately and persist after logout
./fleet.sh status     # shows "service:running" per agent
./fleet.sh uninstall  # removes the services when you're done
```

No need to open four terminals. Everything is driven from `fleet.sh`.

### What `./fleet.sh status` shows

```
AGENT           MODE        STATE     DETAIL
------------------------------------------------------------
agent-be        service     running   [agent-be] iteration start @ control:a3f9c2
agent-fe        bg          idle      2026-06-15T10:42:00Z
agent-qa        bg          working
agent-doc       stopped
```

- **service** — installed via `fleet.sh install`, managed by the OS
- **bg** — started via `fleet.sh start`, runs in the background of this session
- **stopped** — not running (config exists but agent was never started)

---

## Real-time collaboration (v7)

The v7 supervisor adds five layers so agents respond to each other in seconds rather than minutes:

| Layer | What it does | Latency |
|-------|-------------|---------|
| Process supervision | Agents restart on crash via launchd/systemd | — |
| Fast idle polling | `git ls-remote` every 5s (was 30s) | ≤5s |
| Local wake file | Supervisor writes `mailboxes/wake/<agent>` after each push | <1s |
| Supabase Realtime | Cross-machine broadcast via `wake-listen.ts` | ~1s |
| Parallel answer sessions | Detects incoming `awaiting_info` questions mid-session, spawns a focused answer session in a separate git worktree | ~10s |

End-to-end round-trip for an `awaiting_info` Q&A: **~15–30 seconds** (dominated by LLM response time), down from potentially hours with the v6 async mailbox-only approach.

---

## Console intercept — risk-gated Bash tool access (v7.1)

Agents use the Claude Bash tool for all shell operations. To prevent accidental or malicious high-risk commands from executing silently, a thin wrapper at `supervisor/console/bin/bash` intercepts Bash invocations and gates destructive operations.

### How it works

1. **Prepended to PATH.** `run-agent.sh` exports `$SUPERVISOR_DIR/console/bin` first on PATH, so every Bash tool call (from Claude) hits the wrapper before the system bash.

2. **Risk classification.** The wrapper identifies high-risk patterns anywhere in the command string (including chained commands like `cd /tmp && git push`):
   - Git mutations: `git push`, `git rebase`, `git reset`
   - Destructive file ops: `rm -rf`, `chmod -R`, `chown -R`
   - Data/device access: `curl | bash`, `wget | bash`, `dd if=`, `mkfs`, `fdisk`

3. **Low-risk pass-through.** Commands like `git clone`, `ls`, `npm install` execute immediately without gating.

4. **High-risk intercept.** When a high-risk command is detected:
   - Wrapper writes a JSON request file to `$SUPERVISOR_DECISIONS_DIR/<agent>-<request-id>.json`
   - Logs the command to stderr: `[bash-wrapper] HIGH RISK — blocked, awaiting console decision`
   - Polls for an approval response file (`<agent>-<request-id>.decision.json`)
   - If `{"approved": true}` — executes the command
   - If `{"approved": false}` or timeout — blocks and exits with code 1

5. **Fallback when console is down.** If `$SUPERVISOR_DECISIONS_DIR` is not set, the wrapper blocks with a warning and does NOT execute the command. This prevents silent execution when the console is unavailable.

### Accessing decision files

Decision files are stored at `$SUPERVISOR_DIR/console/decisions/<agent>-<id>.json`:

```json
{
  "command": "git push origin main",
  "risk": "high",
  "agent": "agent-be",
  "request_id": "1718825000-1234-56789"
}
```

The console (or human operator) creates a response file with the same name, appending `.decision`:

```json
{
  "approved": true
}
```

### Decision cleanup — automatic garbage collection (v7.1)

Decision files are ephemeral and cleaned up automatically on two schedules to prevent disk accumulation:

**Startup cleanup (AC1/AC2):** When `server.ts` starts, it reads `$SUPERVISOR_DECISIONS_DIR` and deletes any decision files (both request and response `.json` files) that are older than 24 hours. Files newer than 24h are preserved. This handles cases where the console crashes or restarts — stale approvals from previous sessions are garbage-collected, but in-flight approvals created within the last 24h survive the restart.

**Post-approval cleanup (AC3/AC4):** When the console writes an approval response file via `POST /api/approve`, it schedules a cleanup timer with `setTimeout(() => unlink(decisionFile), 60_000)`. This gives the bash wrapper approximately 60 seconds to read and process the decision before the file is removed. The unlink error is swallowed silently in case the wrapper already cleaned it up or the file was removed manually.

**Constraint:** Startup cleanup runs synchronously before `server.listen()` is called, ensuring the server does not bind until the cleanup is complete.

---

## Console server — zero-config control repo discovery (v7.1)

The console server reads task ledgers, mailboxes, and decision files from the control repository. To eliminate manual env setup, `supervisor/console/server.ts` auto-detects the control repo on startup.

### How auto-detection works

When you start the console server:

1. **Check env override.** If `CONTROL_DIR` is set, use that path directly (backward-compatible fallback). Skip the next steps.

2. **Resolve control repo URL.** Read `supervisor/fleet.conf` (same directory as run-agent.sh), skip comment lines and blank lines, take the first agent name. Then read the git remote URL:
   ```bash
   git -C ~/agents/<first-agent>/control remote get-url origin
   ```
   This gives the control repo URL without requiring a separate config file.

3. **Clone if needed.** If `~/agents/console/control` does not exist, clone the control repo there:
   ```bash
   git clone <url> ~/agents/console/control
   ```
   This is a **blocking operation** — the HTTP server does not bind until the clone succeeds.

4. **Skip if already present.** If `~/agents/console/control` already exists, start immediately without re-cloning.

5. **Graceful failure.** If the clone fails (network error, bad URL, missing repo), the server exits with a non-zero code and logs a descriptive error. It does NOT start a server without the control repo.

### Startup log example

```bash
$ bun run supervisor/console/server.ts
[console] CONTROL_DIR not set, auto-detecting...
[console] First agent from fleet.conf: agent-be
[console] Reading control URL from ~/agents/agent-be/control/.git/config
[console] Control URL: git@github.com:my-org/my-control-repo.git
[console] Cloning control repo from git@github.com:my-org/my-control-repo.git...
[console] Clone complete at ~/agents/console/control
[console] Starting HTTP server on port 7842
```

### Setup implications

**Old workflow** (before v7.1):
```bash
CONTROL_DIR=/path/to/control bun run supervisor/console/server.ts
```

**New workflow** (v7.1):
```bash
bun run supervisor/console/server.ts
```

The server now reads `fleet.conf` to find the control repo without manual setup. Operators upgrading from v7.0 can delete any hardcoded `CONTROL_DIR` exports in their systemd/launchd service files.

---

## Localhost-only binding + path parameter validation (v7.1)

The console server implements two security hardening measures to prevent accidental network exposure and path-traversal attacks.

### Localhost binding (AC1/AC2)

The server binds exclusively to `127.0.0.1`, making it unreachable from any network interface:

```javascript
server.listen(PORT, HOSTNAME, ...)  // HOSTNAME = "127.0.0.1"
```

**Verification:**
- **AC1:** `curl http://0.0.0.0:7842/health` → connection refused (server not listening on 0.0.0.0)
- **AC2:** `curl http://127.0.0.1:7842/health` → HTTP 200 with `{"status":"ok"}`

This binding strategy protects against misconfigured firewalls — even if a firewall rule accidentally permits port 7842, the server is not reachable from the network.

### Request path validation (AC3-AC6)

All path parameters are validated before being used as filesystem paths or task identifiers, preventing path traversal attacks.

**agentName validation (AC3):** 
The server maintains a Set of valid agent names read from `fleet.conf` at startup. Any request to `POST /api/mailbox/:agentName` with an unknown agent name is rejected:
```bash
curl -X POST http://127.0.0.1:7842/api/mailbox/unknown-agent
# Response: HTTP 400
# {"error": "unknown agent"}
```

Valid agent names are those listed in `supervisor/fleet.conf`, e.g., `agent-be`, `agent-fe`, `agent-qa`, `agent-doc`.

**taskId validation (AC4/AC5):**
Task identifiers must match the regex `/^[A-Z]+-[0-9]+$/` (uppercase letters, hyphen, digits only). This prevents path traversal via dot segments or slashes. Example validations:

```bash
# AC4: Invalid format — path traversal attempt blocked
curl -X POST http://127.0.0.1:7842/api/unblock/../../etc/passwd
# Response: HTTP 400
# {"error": "invalid task ID"}

# AC5: Valid format — proceeds to processing
curl -X POST http://127.0.0.1:7842/api/unblock/CONS-003 \
  -d '{"decision":"proceed"}'
# Response: HTTP 200
```

The regex rejects:
- Lowercase letters: `cons-003` ✗
- Dot segments: `../../../etc/passwd` ✗
- Slashes: `CONS/003` ✗
- No hyphen: `CONS003` ✗
- Extra characters: `CONS-003!` ✗

**Fleet.conf parsing (AC6):**
At startup, `server.ts` reads `fleet.conf` and builds a Set of all agent names listed in the file. All agents listed in `fleet.conf` are immediately valid; no name rejection happens for legitimate agents. The Set is queried on every request to `/api/mailbox/:agentName`.

### Implementation notes

- **Node.js raw path:** The server uses `node:http.createServer()` instead of `Bun.serve()`. Bun normalizes dot segments before the request handler is called (defeating AC4 validation), whereas `node:http` passes the raw, un-normalized path, allowing the server to validate and reject malicious identifiers.
- **Synchronous validation:** All validations occur synchronously in the request handler. No path is written to disk until validation passes.

---

## Mailbox push resilience — rebase-on-retry (v7.1)

When multiple agents write to the control repository simultaneously, a push can be rejected if another agent's commit arrives first. To handle this gracefully, the `POST /api/mailbox` endpoint automatically retries failed pushes.

### Retry logic

When the console publishes an agent's message to the mailbox:

1. **First push attempt.** The console commits the message to the control repo and pushes:
   ```bash
   git add mailboxes/<agent-name>.md
   git commit -m "mailbox(<agent-name>): console message"
   git push
   ```

2. **Rejection detected.** If the push fails (exit code 1 or 128), the console does NOT retry immediately. Instead:
   - Log: `[gitCommitAndPush] push rejected (exit <code>), retrying with pull --rebase`
   - Rebase locally against the remote branch: `git pull --rebase`
   - Attempt push once more: `git push`

3. **Maximum one retry.** The retry count is hard-capped at 1. If rebase or the second push fails, the endpoint returns HTTP 500 with `{"error":"push failed after retry"}` and does NOT attempt further retries.

4. **Success case — no rebase.** If the first push succeeds, the endpoint returns HTTP 200 immediately; no rebase is attempted (AC4 constraint — avoid unnecessary rebases when they're not needed).

### Conflict handling

If the rebase encounters an irresolvable conflict (e.g., two agents edited the same mailbox file), `git pull --rebase` returns non-zero. The console catches this and returns HTTP 500 with the error message, leaving the working tree in a consistent state for recovery or manual inspection.

### Operator impact

Operators publishing messages via the console UI experience failures only when conflicts are genuinely unresolvable, not when they occur during brief windows of concurrent pushes. Temporary push rejections due to timing are handled transparently.

---

## Approval submission — gating bash commands via console decision (v7.1)

When the bash wrapper detects a high-risk command, it writes a request to the decisions directory and waits for the console operator to approve or reject it. The `POST /api/approve` endpoint handles the approval submission and manages the decision file lifecycle.

### Request and response

**Endpoint:** `POST /api/approve`

**Request body:**
```json
{
  "agentName": "agent-be",
  "requestId": "1718825000-1234-56789",
  "approved": true
}
```

**Response:** HTTP 200 on success:
```json
{
  "ok": true
}
```

**Error responses:**
- HTTP 400: missing `agentName`, `requestId`, or `approved` field
- HTTP 503: `SUPERVISOR_DECISIONS_DIR` env var not set

### Decision file lifecycle

When approval is submitted:

1. **Write decision file:** The endpoint writes to `$SUPERVISOR_DECISIONS_DIR/<agentName>-<requestId>.decision.json` with the approval status (true/false).

2. **Schedule cleanup:** A `setTimeout(() => unlink(decisionFile), 60_000)` timer is scheduled. This gives the bash wrapper approximately 60 seconds to poll and read the decision before the file is removed.

3. **Cleanup on unlink:** If the unlink fails (file already gone, permission error), the error is silently swallowed — the wrapper may have cleaned it up or it may have been deleted manually.

### Operator workflow

Operators see a blocked-command card in the console UI when a high-risk command is detected. Clicking "Approve" or "Reject" calls `POST /api/approve` with the decision. The endpoint returns HTTP 200 immediately, allowing the UI to proceed. The bash wrapper receives the decision within <1 second and executes or blocks accordingly.

---

## AI Draft Suggestions — streaming Claude responses via SSE (v7.1)

The console lets operators request AI-drafted suggestions for blocked tasks, streaming Claude's response token-by-token via Server-Sent Events (SSE). This endpoint integrates with the Anthropic SDK and aborts the stream if the browser disconnects, preventing wasted token consumption.

### Request and response

**Endpoint:** `POST /api/draft-decision`

**Request body:**
```json
{
  "taskId": "CONS-005",
  "agentName": "agent-be",
  "context": "Task spec and agent notes..."
}
```

**Response:** HTTP 200 with `text/event-stream` (SSE format). Each token arrives as a `data:` line containing a JSON-escaped string:
```
data: "The "
data: "operator "
data: "can "
data: "review "
data: "and "
data: "edit "
data: "this "
data: "draft "
data: "before "
data: "submitting."
data: [DONE]
```

### Error handling

If `ANTHROPIC_API_KEY` is not set in the server environment, the endpoint returns HTTP 503 immediately (before reading the body):
```json
{
  "error": "AI drafts unavailable — set ANTHROPIC_API_KEY in your environment"
}
```

If the Anthropic API returns an error during streaming (invalid key, rate limit, etc.), the stream sends an error event and closes gracefully:
```
data: {"error": "invalid API key"}
```

The server process does not crash.

### Disconnection handling

When the browser closes the connection or the user cancels the request mid-stream, the `req.on("close")` callback triggers `AbortController.abort()`. This immediately stops the Anthropic SDK stream, preventing further token consumption. The server logs no additional output after disconnect.

### Implementation details

- **Model:** `claude-haiku-4-5-20251001` (Haiku for cost control — draft suggestions don't need Opus)
- **Max tokens:** 512 per response
- **Abort signal:** Passed to `client.messages.stream({..., signal: controller.signal})`
- **Streaming handler:** `stream.on("text", ...)` catches each token and writes it as an SSE `data:` line
- **Completion sentinel:** Final `data: [DONE]\n\n` event signals end of stream
- **Content type:** Operator supplies `context` (task spec + agent notes) in request body; no hardcoded prompt template

### Use case

When a task is blocked waiting for human decision (e.g., approval request, merge conflict), an operator can click "AI Draft" to get a Claude suggestion. The response appears token-by-token in the console, allowing the operator to review and edit before submitting. If the operator cancels mid-draft or closes the console tab, no additional tokens are charged.

---

## SSE Live Events — real-time log pushing (v7.1)

The console delivers live agent events to connected browsers without polling, using Server-Sent Events (SSE) and `fs.watch` to monitor agent log directories.

### How it works

1. **Server startup.** When `console/server.ts` starts, it reads the agent list from `fleet.conf`. For each agent, it:
   - Creates the log directory if missing (`~/agents/<agent>/logs/` with `mkdir -p`)
   - Registers an `fs.watch` callback on that directory

2. **Live-events.jsonl watching.** When an agent appends a line to its `live-events.jsonl`, the `fs.watch` callback detects the write and triggers a broadcast within <1s.

3. **SSE endpoint.** The `/api/events` endpoint accepts HTTP GET and streams a `ReadableStream<Uint8Array>` to connected browsers. Each browser tab gets its own controller in the `sseClients` Set.

4. **Broadcast to all clients.** When a change is detected, the `broadcast()` function encodes the event and sends it to all connected controllers. Dropped connections are cleaned up automatically.

### Implementation

- **Watcher count:** One `fs.watch()` call per agent in `fleet.conf` (typically 4: agent-be, agent-fe, agent-qa, agent-doc)
- **Event filtering:** Only `live-events.jsonl` changes trigger broadcasts; other files in the log directory are ignored
- **Client registry:** `sseClients` is a `Set<ReadableStreamDefaultController>` populated at `/api/events` GET, cleaned up on disconnect or error
- **Broadcast format:** Each event is encoded as `data: <json>\n\n` where the JSON includes `{ agent, file, ts }`
- **Fallback:** The browser (`index.html`) uses htmx 5s polling as a reconnection fallback; this SSE path handles the push case

### Use case

When an agent writes an approval request or task log line, the console receives it within 1 second on all open browser tabs without a page reload.

---

## Tab navigation and panel switching (v7.1)

The console UI organizes control surfaces into three tabs: **Fleet**, **Queue**, and **Cost**. Each tab is a distinct panel; clicking a tab switches which panel is visible while keeping others hidden.

### Tabs and panels

- **Fleet tab** — Shows agent fleet status (agent names, states, current task, elapsed time, recent tool use)
- **Queue tab** — Shows pending tasks awaiting approval (the approval section from earlier sections)
- **Cost tab** — Placeholder for operational cost tracking (not yet implemented; currently shows static text)

### Implementation

The console UI (`console.js`) renders a `<nav role="tablist">` element with three `<button role="tab">` elements (one per tab). When a tab is clicked:

1. The `onclick` handler finds the corresponding panel element (e.g., `<section id="section-fleet">`)
2. Sets `hidden` attribute on the previously active panel
3. Removes `hidden` attribute from the new panel
4. Updates the active button's `aria-selected` state and styling

Each panel (`section-fleet`, `section-queue`, `section-cost`) is a sibling `<section>` in the DOM. CSS media queries and design tokens ensure tab buttons are styled consistently with the rest of the console.

---

## Fleet status table (v7.1)

The **Fleet tab** displays a real-time table of all agents in the fleet. Each row represents one agent and shows: agent name, current state (badge), current task ID (or "no tasks"), session start time, elapsed time, last tool used, and last summary.

### Table columns

| Column | Content | Source | Updates |
|--------|---------|--------|---------|
| Agent | Agent name (e.g., "agent-be", "agent-qa") | `fleet.conf` / API response | Static per session |
| State | Badge: **WORKING** (green) or **IDLE** (amber) | `presence/<agent>.json` | On state change; <1s via SSE |
| Task | Task ID (e.g., "CONS-015") or "—" if no tasks | `live.json` task field | On task change; <1s via SSE |
| Started | ISO timestamp when agent session started | `live.json` sessionStart | On session change; <1s via SSE |
| Elapsed | Human-readable duration (e.g., "2m 15s") | Calculated: now - sessionStart | Every 5s (client-side timer) |
| Last tool | Tool name (e.g., "Read", "Edit", "Bash") | `live.json` lastTool | On tool change; <1s via SSE |
| Summary | One-line task description | `live.json` lastSummary | On summary change; <1s via SSE |

### State badges

The **State** column uses color-coded badges:

- **WORKING** — Green badge (CSS token `--green`). Shown when agent state in `presence/<agent>.json` is "working".
- **IDLE** — Amber badge (CSS token `--amber`). Shown when agent state is "idle" or not yet reported.

Badges are implemented as `.state-working` and `.state-idle` CSS classes, allowing easy customization of colors via design tokens in `styles.css`.

### Rendering logic

When the console loads or receives a `fleet-update` SSE event, it calls `renderFleet()` which:

1. Fetches `GET /api/fleet` (async JSON response)
2. For each agent in the response, renders a table row with formatted columns:
   - Elapsed time is recalculated as `Date.now() - new Date(sessionStart).getTime()`
   - State badge CSS class is determined by the `state` field
   - Task ID defaults to "—" if missing
3. Replaces the old table with the new one (preserving scroll position when possible)
4. The elapsed-time columns continue to update every 5 seconds via client-side `setInterval` timer (independent of SSE updates)

---

## Real-time fleet updates via SSE (v7.1)

The console uses **Server-Sent Events (SSE)** to push fleet status updates to the browser in real-time. When an agent's state or task changes on the server, the browser's fleet table updates within ~1 second without polling.

### Update trigger

1. **On server.** When any agent's `presence/<agent>.json` or `live.json` is written, the server's `fs.watch` callbacks detect the change and broadcast a `fleet-update` SSE event to all connected consoles.

2. **On browser.** The console receives the SSE event and calls `renderFleet()` to re-fetch `/api/fleet` and re-render the table. The browser does not parse the SSE event payload — it only uses the event type as a trigger to refresh.

### Staleness detection and fallback polling

The console includes a **30-second polling fallback** to handle SSE connection loss or server-side watch failures:

1. When `renderFleet()` completes, it resets a staleness timer (`startFleetStalenessTimer()`)
2. If no new fleet-update SSE event arrives within 30 seconds, the timer fires and triggers another fetch of `/api/fleet`
3. This re-polling continues every 30 seconds until an SSE event is received, which resets the timer

This dual mechanism ensures the fleet table stays fresh even if the SSE connection is temporarily lost or if fs.watch misses a file change.

### Implementation

- **SSE event type:** `fleet-update` (sent by server, received by browser)
- **Event payload:** Empty; browser reacts to the event type, not the body
- **Fallback timer:** `setInterval` every 30 seconds (`FLEET_STALE_MS = 30000`)
- **Timer reset:** Triggered by SSE event AND by successful fetch completion in `renderFleet()`

---

## Fleet status endpoint — real-time agent fleet state (v7.1)

The console lets operators query the current state of all agents in the fleet, showing which agents are working, idle, or have never run. The `GET /api/fleet` endpoint returns a structured snapshot of agent status from `live.json` and `presence.json` files, and complementary `fleet-update` SSE events notify browsers when the fleet state changes.

### How it works

1. **Scheduled querying.** When the console UI loads, it fetches `GET /api/fleet` to populate the fleet status table. This gives operators an immediate view of which agents are active.

2. **Live updates via SSE.** The server watches each agent's `~/agents/<agent>/logs/live.json` file. When live.json changes (e.g., agent starts a new task, session ends), the fs.watch callback broadcasts a `fleet-update` SSE event to connected browsers, triggering a re-fetch of `/api/fleet` without polling.

3. **Data sources.** Each agent's status combines two files:
   - `~/agents/<agent>/control/mailboxes/presence/<agent>.json` — agent state (e.g., "working", "idle", "stopped")
   - `~/agents/<agent>/logs/live.json` — current session details (task, start time, last tool, summary)

### Request and response

**Endpoint:** `GET /api/fleet`

**Response:** HTTP 200 with `Content-Type: application/json` and a JSON array of agent status objects:

```json
[
  {
    "name": "agent-be",
    "state": "working",
    "task": "CONS-012",
    "sessionStart": "2026-06-20T10:00:00Z",
    "lastTool": "Bash",
    "lastSummary": "Implementing fleet endpoint",
    "ended": false
  },
  {
    "name": "agent-qa",
    "state": "stopped",
    "task": null,
    "sessionStart": null,
    "lastTool": null,
    "lastSummary": null,
    "ended": true
  }
]
```

### Handling missing data

**No live.json (agent has never run — AC2):**
```json
{
  "name": "agent-fe",
  "state": "stopped",
  "task": null,
  "sessionStart": null,
  "lastTool": null,
  "lastSummary": null,
  "ended": true
}
```

**Ended session (AC3):** When `live.json` contains `"ended": true`, the `task` field is set to `null` (even if live.json includes a stale task ID). This mirrors the watch.ts fix from an earlier version and prevents displaying outdated task assignments after a session ends.

```json
{
  "name": "agent-qa",
  "state": "running",
  "task": null,
  "sessionStart": "2026-06-20T09:00:00Z",
  "lastTool": "Read",
  "lastSummary": "Session ended",
  "ended": true
}
```

**Missing presence.json (AC5):** If an agent's presence file is unreadable or missing, the `state` defaults to `"stopped"` (not an error). This prevents HTTP errors when agents have not yet written their status file.

### SSE fleet-update events

When `live.json` changes for any agent in the fleet, the fs.watch callback broadcasts a `fleet-update` event:

```javascript
{
  "type": "fleet-update",
  "agent": "agent-be",
  "ts": 1718909802000
}
```

The console client receives this event and re-fetches `/api/fleet` to reflect the latest state. This eliminates the need for polling and keeps the fleet status table synchronized with agent activity in real-time.

### Data fields reference

| Field | Source | Type | Semantics |
|-------|--------|------|-----------|
| `name` | Agent name from fleet.conf | string | Agent identifier (e.g., `agent-be`) |
| `state` | `presence.json` .state field | string | Current agent state (e.g., "working", "idle", "stopped") |
| `task` | `live.json` .task field | string \| null | Current task ID if session is active and ended=false; null if no session or ended=true |
| `sessionStart` | `live.json` .session_start field | string \| null | ISO 8601 timestamp when this session started; null if no session |
| `lastTool` | `live.json` .last_tool field | string \| null | Last tool called by the agent (e.g., "Bash", "Read", "Edit"); null if no session |
| `lastSummary` | `live.json` .last_summary field | string \| null | Last summary or status message from the agent; null if no session |
| `ended` | `live.json` .ended field | boolean | True if the session has ended, false if currently active |

---

## Console UI — design system (v7.1)

The console frontend uses a dark-theme design system coordinated with `docs/DESIGN.md`.

### Typefaces
- **Satoshi** (display/hero) — loaded from Fontshare CDN (weights: 400, 500, 700)
- **DM Sans** (body/UI) — loaded from Google Fonts (weights: 400, 500, 600)
- **JetBrains Mono** (data/code) — loaded from Google Fonts (weights: 400, 500)

All fonts use `display=swap` to prevent invisible text during font load.

### Design tokens
Sourced from `docs/DESIGN.md` and defined in `:root` of `styles.css`:

| Token | Value | Purpose |
|-------|-------|---------|
| `--base` | `#0C0C0C` | Page background |
| `--surface` | `#141414` | Cards, sections |
| `--surface-2` | `#1C1C1C` | Elevated surfaces |
| `--border` | `#262626` | Dividers, outlines |
| `--text` | `#FAFAFA` | Primary text |
| `--text-dim` | `#A1A1AA` | Secondary text |
| `--text-micro` | `#52525B` | Captions, hints |
| `--amber` | `#F59E0B` | Accent (warnings, CTAs) |
| `--green` | `#22C55E` | Success state |
| `--red` | `#EF4444` | Error state |
| `--blue` | `#3B82F6` | Info state |

### Motion variables
Used for consistent timing across transitions and animations:

| Variable | Value | Use case |
|----------|-------|----------|
| `--dur-micro` | 75ms | Micro-interactions (hover, focus) |
| `--dur-short` | 150ms | Quick transitions (fade, slide) |
| `--dur-medium` | 250ms | Page transitions |
| `--ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrance animations (bounce) |
| `--ease-exit` | `cubic-bezier(0.7, 0, 0.84, 0)` | Exit animations (ease-out) |

### Visual effects
- **Grain texture:** `body::after` pseudo-element with SVG `feTurbulence` at 0.03 opacity (fixed position, z-index 9999, non-interactive). Adds subtle surface texture without impacting readability.

### Font sizing
- Body text: 16px (see `docs/DESIGN.md` for rationale)
- Button border-radius: 8px (consistent with accessibility guidelines)

---

## Console UI — Interactive features and polish (v7.1)

The `console.js` file implements a vanilla JavaScript frontend for the console UI, providing real-time task and approval queue management with animations, accessibility, and dynamic content updates via SSE.

### Two-section layout with per-section empty states

The console divides operator workload into two independent sections:

**Human Attention Queue** — Tasks blocked waiting for operator decision (e.g., tasks that failed and need human input).
- Empty state (AC1): Shows "No blocked agents" when the queue is empty, replacing the old single "All clear" banner.
- Header includes an amber badge showing count when populated (e.g., "0 blocked").

**Approval Queue** — High-risk Bash commands awaiting approval.
- Empty state (AC1): Shows "No pending approvals" when the queue is empty.
- Header includes a red badge showing count when populated (e.g., "0 pending").

**All-clear banner (AC2):** When BOTH queues are empty simultaneously, a full-width "All clear — agents are running." banner spans the entire console, replacing the individual empty states. This single banner unifies the visual experience when the fleet is fully idle.

### Card animations

Cards enter and exit the DOM with CSS animations driven by JavaScript:

**Entry animation (AC3):** When a new card arrives via SSE, JavaScript prepends it with the `card-new` class. CSS plays a `slideIn 250ms var(--ease-enter)` animation, using the cubic-bezier bounce easing from the design tokens for a snappy entrance.

**Exit animation (AC4):** When an operator approves or rejects a card, JavaScript:
1. Adds the `card-exit` class to trigger a `fadeOut 150ms forwards` animation
2. Waits 150ms for the fade to complete
3. Removes the card from the DOM
4. Updates queue counts and syncs the UI state

This two-phase exit prevents abrupt disappearance and gives operators visual feedback that their action was registered.

**Spinner and disabled state (AC4a):** When clicking Approve/Reject, the button immediately adds the `loading` class (CSS shows a spinner) and becomes disabled to prevent double-clicks. The disabled state applies to both buttons until the server responds.

### Failure count badge (AC5)

When a task in the Human Attention Queue has `failure_count >= 2`, a amber pill badge appears in the card's meta row (top-right area):

```
⚠ blocked 3 times
```

The badge uses the `--amber` color token and includes both the warning icon and the count. This provides at-a-glance visibility into which tasks have been problematic.

### AI draft panel (AC6)

Tasks that have an AI-drafted suggestion show a collapsible "AI Draft" button. Clicking it reveals a panel below the acceptance criteria with:

1. **Collapsible container:** Toggling the button shows/hides the panel using `aria-expanded` and display state.
2. **Amber disclaimer badge:** Always visible when the panel is expanded, stating "AI draft — review before sending" in the `--amber` color.
3. **Streaming text div:** The drafted text is rendered in a scrollable section (populated by the `POST /api/draft-decision` SSE response).
4. **"Use this draft ↑" button:** A ghost-style button copies the draft text into the textarea below, allowing operators to review and edit before sending.

Example interaction:
1. Operator sees a blocked task with an AI draft available.
2. Clicks "AI Draft" button → panel expands, disclaimer badge is visible.
3. Reads the streamed draft suggestion.
4. Clicks "Use this draft ↑" → text is copied into the textarea.
5. Operator edits the text if needed and clicks "Send back to agent →".

### Textarea with visible label and ARIA (AC7)

The human decision textarea includes:

- **Visible `<label>` element:** Linked to the textarea via `for` attribute and `id` attribute, always visible (not hidden or placeholder-only). Label text: "Your decision".
- **`aria-required="true"`:** Signals to assistive technologies that the field is required before submission.

The textarea uses placeholder text for hints but the actual label is a proper semantic `<label>` element.

### Dynamic document title (AC8)

The browser tab title updates dynamically based on queue state:

- **Pending items (N > 0):** `(N) Fleet Console` (e.g., "(2) Fleet Console")
- **All clear (N = 0):** `Fleet Console`

The title updates every time cards are added or removed, giving operators a quick status check from the browser tab without opening the console.

### SSE reconnect banner (AC9)

When the SSE connection drops (e.g., server restart), an amber banner appears at the top:

```
⚠ Connection lost — reconnecting…
```

The banner includes a spinner animation. When the SSE connection is re-established, the banner disappears automatically. This prevents operator confusion when the console briefly loses its live push stream.

### Keyboard accessibility (AC10)

All interactive buttons are native `<button>` elements:

```html
<button class="btn-approve" aria-label="...">Approve →</button>
```

Native buttons automatically:
- Respond to Enter key (AC10 requirement)
- Respond to Space key
- Are focusable via Tab
- Announce their purpose to screen readers via `aria-label`

No custom key handlers are needed — the browser's native button behavior is leveraged.

### Implementation details

- **No dependencies:** `console.js` uses vanilla JavaScript with no npm packages (htmx is not required for core functionality).
- **Event source:** SSE endpoint is `/api/events` (shared with agent log broadcasting).
- **Event types:** `approval`, `attention`, `resolve` (from the server).
- **HTML escaping:** All dynamic content is escaped via an `esc()` helper function to prevent XSS.
- **State sync:** A `syncState()` function centralizes the logic for updating empty states, counts, badges, and the document title after every card operation.
- **Timer display:** Elapsed time on each card updates every 1 second (minutes:seconds format).

---

## Console test suite (v7.1)

The console includes comprehensive unit and integration tests covering risk classification, approval polling, and endpoint security boundaries. Run all tests with:

```bash
bun test supervisor/console/
```

### Bash wrapper tests — `bash-wrapper.test.sh` + `bash-wrapper.test.ts`

**Risk classification (AC1):** The `check_risk` function classifies commands into security tiers:

| Command | Classification | Example |
|---------|-----------------|---------|
| Destructive git operations | high | `git push origin main`, `git rebase`, `git reset` |
| Recursive file operations | high | `rm -rf /home`, `chmod -R`, `chown -R`, `mkfs`, `fdisk` |
| Pipe-to-shell | high | `curl \| bash`, `wget \| sh` |
| Safe commands | low | `git clone`, `ls`, `bun test`, `cd` |
| Chained operations | high | `cd /tmp && git push origin main` (if any segment is high) |

The classification runs inline in the bash wrapper (`supervisor/console/bin/bash`) before attempting execution. Commands classified as high are sent to the console for operator approval; low-risk commands execute immediately.

**Approval polling (AC2):** When a command is blocked, the wrapper polls for a decision file:

- **Approved path:** If `<agent>-<request-id>.decision.json` appears with `{"approved": true}`, the wrapper executes the command and exits 0.
- **Rejected path:** If the decision file has `{"approved": false}`, the wrapper exits 1 (command blocked).
- **Timeout path:** If no decision file appears within 60s, the wrapper exits 1 (timeout protection prevents indefinite hangs).

All three paths are covered by the test suite.

### Server endpoint tests — `server.test.ts` + `server-utils.ts`

**Task ID validation (AC3):** The `POST /api/unblock/<taskId>` endpoint rejects invalid task IDs:

- Invalid: lowercase IDs (`cons-003`), missing digits (`CONS`), trailing slashes with extra segments
- Valid: uppercase + dash + digits only (regex: `/^[A-Z]+-[0-9]+$/`)
- Response: HTTP 400 if invalid, 200 if valid

**Agent name validation (AC4):** The `POST /api/mailbox/<agentName>` endpoint rejects unknown agents:

- Valid agents are loaded from `fleet.conf` at startup into a `Set`
- Unknown or empty agent names return HTTP 400
- Valid agents return HTTP 200

**Needs-human endpoint (AC5):** The `GET /api/attention` endpoint returns all tasks with `status: needs_human`:

```bash
curl http://127.0.0.1:7842/api/attention
```

Response:
```json
{
  "tasks": [
    {
      "id": "CONS-003",
      "status": "needs_human",
      "domain": "be",
      "description": "..."
    }
  ]
}
```

**Ledger parsing edge cases (AC6):** The `parseTaskLedger()` utility handles empty or missing ledger directories without crashing — returns an empty array.

**Mailbox parsing edge cases (AC7):** The `parseMailboxNotes()` utility handles mailbox files containing only the `<!-- cleared by ... -->` marker without crashing — returns an empty array.

### Test results

All 19 tests pass (5 bash-wrapper + 14 server tests). The 4 new tests cover `GET /api/queue` AC1, AC5, and AC6 — see the Queue tab bootstrap section below. Run the full suite with:

```bash
bun test supervisor/console/     # runs all tests, exit 0 on pass
bun test --timeout 10000 supervisor/console/  # increase timeout if needed
```

## QA smoke testing — browser-based console verification (v7.1)

When QA agents test the console UI, they use `qa-smoke.sh` to verify that the web interface is actually rendering correctly. This smoke test navigates to the console URL, asserts key DOM elements are present, and captures a screenshot as evidence — complementing server-side unit tests with real browser verification.

### When to run

The QA agent runs `qa-smoke.sh` automatically for any task with `human-verify` ACs targeting the console. Example:

```bash
bash supervisor/console/qa-smoke.sh
```

### What the script verifies

The script:
1. Opens `$QA_BASE_URL` (default: `http://localhost:7842`) using `gstack browse`
2. Asserts the page title contains "Fleet Console"
3. Asserts a `nav[role=tablist]` (the tab bar) is visible
4. Asserts the "Fleet" tab button is present in the DOM
5. Captures a timestamped screenshot to `/tmp/console-qa-<timestamp>.png`
6. Prints the screenshot path to stdout so the QA agent can attach it to its report

### Error handling

If `gstack browse` is not on PATH, the script exits with:
```
gstack browse not found — install gstack or set BROWSE_BIN
```

You can override the browse binary with `BROWSE_BIN`:
```bash
BROWSE_BIN=/path/to/custom-browse bash supervisor/console/qa-smoke.sh
```

---

## Static file serving — serving console UI from filesystem (v7.1)

The console server serves the static HTML, CSS, and JavaScript UI files from the `supervisor/console/` directory. This allows operators to access the console at `http://127.0.0.1:7842/` without bundling assets into the binary or requiring a separate web server.

### How it works

When a request arrives at an unmatched path (after all API routes have been checked), the server routes it to the `serveStatic()` utility function:

1. **Path normalization:** If the request is for `/`, it's rewritten to `/index.html`. Other paths are stripped of leading slashes (e.g., `/styles.css` becomes `styles.css`).

2. **Path traversal protection (AC4):** The resolved file path must be inside the root directory. The function calls `resolve(join(rootDir, filePath))` and checks that the result starts with `safeRoot + sep`, blocking attempts like `/../../../etc/passwd` with HTTP 400.

3. **MIME type detection (AC2):** Based on file extension, the server sets the appropriate `Content-Type` header:
   - `.html` → `text/html`
   - `.css` → `text/css`
   - `.js` → `text/javascript`
   - `.json` → `application/json`
   - `.svg` → `image/svg+xml`
   - `.ico` → `image/x-icon`
   - Unknown → `application/octet-stream`

4. **File serving (AC1/AC3):** The server reads the file synchronously and sends it with HTTP 200 and the correct `content-type` and `content-length` headers. If the file does not exist, it returns HTTP 404.

### Request and response

**Requests:**
```
GET / → serves index.html with text/html
GET /index.html → also serves index.html
GET /styles.css → serves styles.css with text/css
GET /console.js → serves console.js with text/javascript
GET /nonexistent.xyz → HTTP 404 Not Found
GET /../../../etc/passwd → HTTP 400 Bad Request (path traversal blocked)
```

**Response headers:**
```
HTTP/1.1 200 OK
Content-Type: text/html
Content-Length: 1234
```

### Handler placement

The static file handler is the **last route** in `supervisor/console/server.ts`, after all API endpoints (`/api/*`). This ensures API requests are never shadowed by static files and provides a safe default for any unmatched path.

### Supported file types

Static serving is optimized for console UI delivery:
- **HTML** (`index.html`) — main UI entry point
- **CSS** (`styles.css`) — design tokens and layout
- **JavaScript** (`console.js`) — interactive client and SSE handling
- **JSON** (for future APIs or config files)
- **SVG** (for icons, if used)
- **ICO** (`favicon.ico`)

### Implementation details

- **Synchronous reads:** `readFileSync()` is safe here because console startup is not performance-critical and files are typically small (<100KB total). Async reads would complicate the response lifecycle.
- **Guard constraint:** The traversal check requires `resolved.startsWith(safeRoot + sep)` to ensure the slash is present. Without the trailing separator, `/home` would accidentally match `/home2/attacker`. The `sep` constant is `node:path.sep` (platform-aware).
- **Error handling:** Any `readFileSync` exception (permission denied, etc.) is caught and returns HTTP 404, treating the file as missing rather than distinguishing permission errors.

---

## Queue tab bootstrap — GET /api/queue endpoint (v7.1)

The console exposes `GET /api/queue` so the Queue tab populates immediately on first load and after a page refresh, without waiting for SSE events. Before this endpoint, a blocked command whose SSE event was missed (e.g., the operator opened the console after the bash wrapper had already sent the event) left the Queue tab blank even though work was waiting.

### Server side — GET /api/queue

**Endpoint:** `GET /api/queue`

**Response:** HTTP 200 with `Content-Type: application/json`:

```json
{
  "approvals": [
    { "id": "REQ-1", "agent": "agent-fe", "command": "rm test.txt", "risk": "low" }
  ],
  "attention": [
    { "id": "CONS-999", "status": "needs_human", "domain": "be", "description": "..." }
  ]
}
```

- **`approvals`** — Unresolved approval request files from `SUPERVISOR_DECISIONS_DIR`. An "unresolved" file is one where `{agent}-{id}.json` exists but the matching `{agent}-{id}.decision.json` does NOT yet exist in the same directory.
- **`attention`** — All tasks with `status: needs_human` from the ledger (same data as `GET /api/attention`).

When `SUPERVISOR_DECISIONS_DIR` is unset, the directory does not exist, or is unreadable, `approvals` returns `[]` — the endpoint never returns 503 or 500 for a missing or absent directory (AC5, AC6).

### readApprovals() — server-utils.ts

The `readApprovals(decisionsDir)` utility reads unresolved approval request files:

1. Returns `[]` immediately if `decisionsDir` is falsy (AC5).
2. Calls `readdirSync(decisionsDir)` — catches any error and returns `[]` so a missing or unreadable directory never causes a 500 (AC6).
3. Builds a `Set` of all `.decision.json` filenames present in the directory.
4. Filters the `.json` files to those without a matching `.decision.json` entry — these are the unresolved requests.
5. Reads and JSON-parses each unresolved file with `readFileSync()`; silently skips any file that fails to parse.

### Client side — fetchQueue() in console.js

`fetchQueue()` is an async function in `console.js` that fetches `GET /api/queue` and renders its results into the existing card containers:

- **Called on tab activate (AC2):** `switchTab('queue')` calls `fetchQueue()` so the Queue tab is populated before any SSE event arrives.
- **Called on SSE reconnect (AC3):** The SSE `open` event handler calls `fetchQueue()` to re-sync the tab after a dropped connection.
- **Deduplication (AC3 constraint):** Before prepending a card, `fetchQueue()` checks `document.getElementById(cardId)` where `cardId` is `approval-{id}` or `attention-{id}`. If the element already exists, that card is skipped. This prevents duplicates when SSE events and the bootstrap fetch both deliver the same item.
- **State sync:** After rendering all cards from the response, `fetchQueue()` calls `syncState()` to update counts, badges, and the document title.

### Document title — AC4

The title format `(N) Fleet Console` (N > 0) / `Fleet Console` (N = 0) is implemented by the pre-existing `syncState()` function with no new code required in CONS-016:

```javascript
document.title = total > 0 ? `(${total}) Fleet Console` : 'Fleet Console';
```

`total = approvalCount + attentionCount`. `fetchQueue()` calls `syncState()` after updating the counts, so the title reflects the bootstrapped queue depth immediately.

### Test coverage

Three new `describe` blocks in `server.test.ts` cover the server-side ACs:

| Describe block | AC | What it asserts |
|---|---|---|
| `GET /api/queue` | AC1 | Returns only unresolved approvals (REQ-1, not REQ-2 which has a `.decision.json`) + needs_human tasks from the ledger |
| `GET /api/queue no decisions dir` | AC5 | `readApprovals(undefined)` → `[]`; `readApprovals("")` → `[]` |
| `GET /api/queue missing dir` | AC6 | `readApprovals(nonexistent-path)` → `[]`, no exception thrown |

Test fixtures in `beforeAll`: one unresolved approval file (`agent-fe-REQ-1.json`), one resolved pair (`agent-fe-REQ-2.json` + `agent-fe-REQ-2.decision.json`). The AC1 test asserts that only REQ-1 appears in the response.

---

## Adding a new agent

1. Add a line to `fleet.conf`
2. Create `~/agents/<new-agent>/config` on the target machine
3. Run `./fleet.sh start` (or `./fleet.sh install` for production)
