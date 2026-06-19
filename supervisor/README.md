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
| `console/styles.css` | Console design system (v7.1 — dark theme, motion tokens, Satoshi/DM Sans/JetBrains Mono typefaces) |

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

## Adding a new agent

1. Add a line to `fleet.conf`
2. Create `~/agents/<new-agent>/config` on the target machine
3. Run `./fleet.sh start` (or `./fleet.sh install` for production)
