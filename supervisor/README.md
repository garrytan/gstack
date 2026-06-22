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
| `console/index.html` | Console UI entry point (v7.1 — serves static HTML with SSE support, Pipeline tab panel with domain filter chips and spec panel) |
| `console/console.js` | Console interactive client (v7.1 — card animations, empty states, AI draft panel, ARIA accessibility, Pipeline tab with collapsible status groups, domain filter chips persisted in localStorage, spec panel on card click, `pipeline-update` SSE listener) |
| `console/styles.css` | Console design system (v7.1 — dark theme, motion tokens, Satoshi/DM Sans/JetBrains Mono typefaces, pipeline group/card/filter/spec-panel component styles) |
| `console/server-utils.ts` | Utility exports — parsing ledger/mailbox, task ID validation (`TASK_ID_RE` supports both `CONS-003` and `T13` styles), fleet status reading, SSE helpers, `makeWatchHandler` (reads last `live-events.jsonl` line, caches payload for Last-Event-ID replay), `makeLedgerWatchHandler` (broadcasts `pipeline-update` SSE on `.task` file changes), port resolution, `readLogTail` (JSONL tail reader), `makeRateLimiter` (token-bucket rate limiter), `purgeStaleDecisionFiles` (startup garbage collection of stale decision files), `PipelineTask` type (T13) (v7.1) |
| `console/bash-wrapper.test.ts` | Bun test wrapper that runs bash-wrapper.test.sh inline (v7.1) |
| `console/bash-wrapper.test.sh` | Bash unit tests for risk classification (check_risk) and polling behavior (poll_approval) (v7.1) |
| `console/server.test.ts` | Bun tests for endpoint security, static serving, queue bootstrap, `resolveControlDir`, SSE endpoint (T4 AC1/AC2/AC3/AC5), `makeWatchHandler`, log tail endpoint (T12 AC1-AC7), rate limiter, startup cleanup (T8 AC1-AC4), pipeline endpoint (T13 AC1/AC2), ledger watch handler (T13 AC3), and spec endpoint (T13 AC7) (v7.1) |
| `console/qa-smoke.sh` | QA smoke test for console UI — asserts page title, nav bar, Fleet tab presence, T6 AC1/AC2/AC4/AC5 (Dicebear avatar src, elapsed time format, HIGH risk badge, Unblock button), and T13 AC4/AC5 (pipeline endpoint 200, `pipeline-groups` element in HTML, `tasks` key in pipeline JSON) via gstack browse (v7.1) |

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

2. **Real bash detection.** The wrapper locates the actual system bash to delegate approved commands. It resolves its own canonical path using `BASH_SOURCE[0]` (not `$0`, which is unreliable when invoked via PATH), then iterates `type -ap bash` candidates, comparing each via `realpath` to skip any path — including symlinks — that resolves to itself:
   ```bash
   _SELF=$(realpath "${BASH_SOURCE[0]}" ...)
   while IFS= read -r _cand; do
     _cand_real=$(realpath "$_cand" ...)
     [ "$_cand_real" = "$_SELF" ] && continue
     REAL_BASH="$_cand"; break
   done < <(type -ap bash)
   ```
   This correctly handles setups where a symlink to the wrapper appears earlier on PATH than the system bash.

3. **Risk classification.** The wrapper uses two functions:
   - `check_risk <cmd>` — returns `high` if the command string matches a high-risk pattern anywhere (no `^` anchor so patterns in chained commands are caught).
   - `evaluate_chain_risk <cmd>` — splits the full command on `&&`, `||`, and `;` using `python3 -c "import re, sys; parts = re.split(...)"`, then calls `check_risk` on each segment. A chain like `cd /tmp && git push origin main` is classified `high` because the second segment matches.

   High-risk patterns:
   - Git mutations: `git push`, `git rebase`, `git reset`
   - Destructive file ops: `rm -rf`, `chmod -R`, `chown -R`
   - Data/device access: `curl | bash`, `wget | bash`, `dd if=`, `mkfs`, `fdisk`

4. **Low-risk pass-through.** Commands like `git clone`, `ls`, `npm install` execute immediately without gating.

5. **High-risk intercept.** When a high-risk command is detected:
   - Wrapper writes a JSON request file to `$SUPERVISOR_DECISIONS_DIR/<agent>-<request-id>.json` using `python3 -c "import json, sys; ..."` (no `jq` dependency)
   - Logs the command to stderr: `[bash-wrapper] HIGH RISK — blocked, awaiting console decision`
   - Polls for an approval response file (`<agent>-<request-id>.decision.json`), also parsed with `python3 -c "import json, sys; ..."`
   - If `{"approved": true}` — executes the command
   - If `{"approved": false}` or timeout — blocks and exits with code 1

6. **Fallback when console is down.** If `$SUPERVISOR_DECISIONS_DIR` is not set, the wrapper blocks with a warning and exits 1. This prevents silent execution when the console is unavailable:
   ```
   [bash-wrapper] WARNING: SUPERVISOR_DECISIONS_DIR not set; blocking high-risk command
   ```

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

**Startup cleanup (T8 AC1–AC4):** When `server.ts` starts, `purgeStaleDecisionFiles(dir)` runs a two-pass sweep of `$SUPERVISOR_DECISIONS_DIR`:

- **First pass:** deletes every `*.json` request file whose `mtime` is older than 1 hour, and also deletes the paired `*.decision.json` response file if it exists.
- **Second pass:** deletes any remaining `*.decision.json` files older than 1 hour (even when the paired request file is still fresh — the decision is no longer needed once written).

Files newer than 1 hour are not touched (AC3). If `$SUPERVISOR_DECISIONS_DIR` is not set, empty, or does not exist, the function returns immediately without error (AC4). Per-file stat and unlink errors are caught individually so one unreadable file does not abort the rest of the sweep. Threshold: `Date.now() - mtime.getTime() > 60 * 60 * 1000`.

**Post-approval cleanup:** When the console writes an approval response file via `POST /api/approve`, it schedules a cleanup timer with `setTimeout(() => unlink(decisionFile), 60_000)`. This gives the bash wrapper approximately 60 seconds to read and process the decision before the file is removed. The unlink error is swallowed silently in case the wrapper already cleaned it up or the file was removed manually.

**Constraint (T8 AC5):** Startup cleanup runs synchronously before `server.listen()` is called, ensuring the server does not bind until the cleanup is complete.

---

## Console server — zero-config control repo discovery (v7.1)

The console server reads task ledgers, mailboxes, and decision files from the control repository. Rather than requiring a hardcoded path, `supervisor/console/server.ts` discovers the control repo automatically by scanning each agent's checkout directory.

### How auto-detection works (`resolveControlDir`)

`resolveControlDir(agentDirs: string[])` is exported from `server-utils.ts` and called once at startup. The result is cached in a module-level `controlDir` constant — git is never called again on subsequent requests (AC4).

When you start the console server:

1. **Check env override (AC3).** If the `CONTROL_DIR` environment variable is set, return its value immediately. No git commands are run; the value is used as-is.

2. **Iterate all agent checkout directories (AC1).** Build the list of agent control paths from `fleet.conf`:
   ```
   ~/agents/<each-agent>/control
   ```
   For each path, run:
   ```bash
   git -C <path> remote get-url origin
   ```
   Return the **first** directory whose origin URL contains `seab-group/tshepostack` (substring match — works for both SSH and HTTPS remotes).

3. **Skip unreadable directories silently (AC5).** If a path does not exist, or `git remote get-url` exits non-zero, that entry is skipped without logging and without throwing. The loop continues to the next agent.

4. **Return null on no match (AC2).** If no agent directory yields a matching remote, `resolveControlDir` returns `null` and logs:
   ```
   [resolveControlDir] no agent directory matched control-repo remote
   ```
   The server continues to bind and serve. API routes that require the control repo (mailbox, ledger, attention) will be unavailable, but the static UI and `/health` endpoint still respond.

### Startup log example

```bash
$ bun run supervisor/console/server.ts
[console] CONTROL_DIR not set, auto-detecting...
[console] First agent from fleet.conf: agent-be
[console] Reading control URL from ~/agents/agent-be/control/.git/config
[console] Control URL: git@github.com:my-org/my-control-repo.git
[console] Cloning control repo from git@github.com:my-org/my-control-repo.git...
[console] Clone complete at ~/agents/console/control
Console ready → http://localhost:7842
```

If no agent directory matches:
```bash
$ bun run supervisor/console/server.ts
WARNING: control dir not found — mailbox and ledger routes unavailable
Console server listening on http://127.0.0.1:7842
```

### Using the env override

```bash
CONTROL_DIR=/path/to/control bun run supervisor/console/server.ts
```

The `CONTROL_DIR` env var takes absolute precedence over auto-detection. Use it when the agent checkout directories are not under `~/agents/` (non-standard machine layouts).

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
Task identifiers must match the regex `/^[A-Z]+(-[0-9]+|[0-9]+)$/` (uppercase letters followed by either a hyphen and digits, or digits only). This supports both `CONS-003` style and short-name `T13` style, while blocking path traversal via dot segments or slashes. Example validations:

```bash
# AC4: Invalid format — path traversal attempt blocked
curl -X POST http://127.0.0.1:7842/api/unblock/../../etc/passwd
# Response: HTTP 400
# {"error": "invalid task ID"}

# AC5: Valid formats — both proceed to processing
curl -X POST http://127.0.0.1:7842/api/unblock/CONS-003 \
  -d '{"decision":"proceed"}'
# Response: HTTP 200

curl -X POST http://127.0.0.1:7842/api/unblock/T13 \
  -d '{"decision":"proceed"}'
# Response: HTTP 200
```

The regex rejects:
- Lowercase letters: `cons-003` ✗, `t13` ✗
- Mixed case: `Cons003` ✗
- Dot segments: `../../../etc/passwd` ✗
- Slashes: `CONS/003` ✗
- Extra characters: `CONS-003!` ✗
- Starts with a digit: `3CONS` ✗

**Fleet.conf parsing (AC6):**
At startup, `server.ts` reads `fleet.conf` and builds a Set of all agent names listed in the file. All agents listed in `fleet.conf` are immediately valid; no name rejection happens for legitimate agents. The Set is queried on every request to `/api/mailbox/:agentName`.

### Implementation notes

- **Node.js raw path:** The server uses `node:http.createServer()` instead of `Bun.serve()`. Bun normalizes dot segments before the request handler is called (defeating AC4 validation), whereas `node:http` passes the raw, un-normalized path, allowing the server to validate and reject malicious identifiers.
- **Synchronous validation:** All validations occur synchronously in the request handler. No path is written to disk until validation passes.

---

## Port binding hardening — PORT override, EADDRINUSE crash, ready message (v7.1)

The console server validates the listening port before binding, crashes fast on conflicts, and announces readiness via stdout. These behaviors build on the CONS-003 localhost-only binding constraint.

### Port resolution — `resolvePort()` (AC1/AC2)

Port selection is handled by `resolvePort(portEnv: string | undefined)` exported from `server-utils.ts`:

- Returns `7842` when `PORT` is unset or empty.
- Parses `parseInt(portEnv, 10)` and validates the result is a number in the range 1024–65535.
- Throws `Error('Invalid PORT value: "{value}" — expected a number between 1024 and 65535')` for anything outside that range.

`server.ts` calls `resolvePort(process.env.PORT)` inside an IIFE at module start — before any filesystem reads or network operations:

```bash
# Default port
bun run supervisor/console/server.ts
# → Console ready → http://localhost:7842

# Custom port
PORT=9000 bun run supervisor/console/server.ts
# → Console ready → http://localhost:9000
```

The server always binds to `127.0.0.1` (loopback only) regardless of the PORT value. External network binding is not configurable.

### EADDRINUSE crash (AC3)

If the selected port is already in use when the server attempts to bind, the EADDRINUSE error handler fires:

```
ERROR: port 7842 already in use — is another console running?
```

The message goes to stderr and the process exits with code 1. No fallback port is chosen. The operator must stop the conflicting process or use `PORT=<other>` to select a free port.

### PORT validation (AC5)

An invalid `PORT` value causes the server to exit **before** attempting to bind. The validation error goes to stderr with exit code 1:

```bash
PORT=invalid bun run supervisor/console/server.ts
# stderr: ERROR: Invalid PORT value: "invalid" — expected a number between 1024 and 65535
# exit 1

PORT=80 bun run supervisor/console/server.ts
# stderr: ERROR: Invalid PORT value: "80" — expected a number between 1024 and 65535
# exit 1 (below minimum 1024)
```

### Startup ready message (AC4)

After a successful bind, the server writes the ready line to stdout:

```
Console ready → http://localhost:7842
```

This replaces the old `Console server listening on http://127.0.0.1:7842` message. The new message uses `localhost` (operator-friendly) and includes the arrow format consistent with Node.js ecosystem conventions.

### Test coverage

| AC | Test | Location |
|---|---|---|
| AC1 | `server binds to 127.0.0.1, not 0.0.0.0` | `server.test.ts` — port binding describe |
| AC2 | `resolvePort returns 7842 when PORT is unset` | `server.test.ts` |
| AC2 | `resolvePort returns the numeric PORT value when set` | `server.test.ts` |
| AC2 | `server actually binds to PORT=9999` | `server.test.ts` |
| AC3 | `EADDRINUSE exits 1 with the right error message` | `server.test.ts` — occupier + spawnSync |
| AC5 | `resolvePort throws on non-numeric PORT` | `server.test.ts` |
| AC5 | `resolvePort throws on out-of-range PORT` | `server.test.ts` |
| AC5 | `server exits 1 for PORT=invalid before bind` | `server.test.ts` — temp script + spawnSync |

---

## Mailbox push resilience — fetch-reset-retry (T7)

When multiple agents write to the control repository simultaneously, a push can be rejected if another agent's commit arrives first. To handle this gracefully, `gitCommitAndPush` in `server-utils.ts` automatically retries failed pushes up to three times using a hard-reset sync strategy.

### Retry logic

`gitCommitAndPush(controlDir, commitMessage)` runs the following sequence:

1. **Stage all changes.** `git add -A` — stages every modified and untracked file in the working tree.

2. **Commit.** `git commit -m <commitMessage>`. If the exit code is non-zero (e.g., "nothing to commit"), the function returns void without attempting a push.

3. **Push with up to 3 attempts.** For each attempt:
   - `git push origin HEAD`
   - If exit code 0 — success, return void immediately.
   - If non-zero and more attempts remain:
     ```bash
     git fetch origin
     git reset --hard origin/<branch>   # <branch> resolved at call start via git rev-parse
     git add -A
     git commit -m <commitMessage>
     ```
   - Then retry the push.

4. **After 3 failed push attempts**, throws `Error('git push failed after 3 retries')`.

### Subprocess timeout

Every git subprocess runs with a 30-second kill timeout. A subprocess that hangs is killed and its result is counted as a failure (exit code 1). This prevents a stalled network operation from blocking the event loop indefinitely.

### Why fetch + reset --hard instead of pull --rebase

`git pull --rebase` can leave the working tree in a detached-HEAD state when run non-interactively in CI and automated agent environments. The `fetch + reset --hard` pattern is deterministic: it discards any local-only divergence and aligns the branch exactly with the remote before re-committing. The console's use case (writing a single file and committing it) has no meaningful local-only state to preserve between retries.

### Operator impact

Operators publishing messages via the console UI experience failures only after three genuine concurrent conflicts — rare under normal fleet operation. Temporary push rejections due to brief timing windows are handled transparently.

### Test coverage

| AC | Test | Location |
|---|---|---|
| AC1 | `gitCommitAndPush stages with git add -A and commits` | `server.test.ts` — `describe("gitCommitAndPush")` |
| AC2 | `gitCommitAndPush retries with fetch+reset on push failure` | `server.test.ts` — first push fails; asserts fetch+reset+re-commit+push sequence |
| AC3 | `gitCommitAndPush throws after 3 failed pushes` | `server.test.ts` — all 3 pushes fail; asserts Error thrown |
| AC4 | `gitCommitAndPush resolves void on success` | `server.test.ts` — happy path |
| AC5 | `gitCommitAndPush resolves void when nothing to commit` | `server.test.ts` — commit exits 1; asserts no push attempted |
| AC6 | 30s kill timeout on each Bun.spawn call | PR review (human-verify) |

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
   - Registers an `fs.watch` callback on that directory via `makeWatchHandler(agent, logDir, broadcast, lastEventCache)`

2. **Live-events.jsonl watching (AC2).** When an agent appends a line to its `live-events.jsonl`, the `fs.watch` callback reads the last JSON line, extracts `{ task, tool, summary }`, and broadcasts a named `event: fleet-update` SSE frame with payload `{ type: "fleet-update", agent, task, tool, summary, ts }`. The payload is also cached in `lastEventCache` (a `Map<agent, payload>`) for Last-Event-ID replay. Unreadable files (ENOENT, permission error) are silently skipped — the watcher stays active (AC3).

3. **live.json watching.** When `live.json` changes (agent state change), the callback broadcasts a minimal `event: fleet-update` frame with payload `{ type: "fleet-update", agent, ts }`. The browser reacts to the event type and re-fetches `/api/fleet` to get the latest state.

4. **SSE endpoint (AC1).** The `/api/events` endpoint accepts HTTP GET and upgrades the connection to a streaming Server-Sent Events response. It sets headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, then immediately flushes an initial `: ok\n\n` comment line to prevent proxy buffering. Each browser tab gets its own `ServerResponse` in the `sseClients` Set.

5. **Last-Event-ID replay (AC4).** On reconnect, if the request carries a `Last-Event-ID` header, the server immediately replays the last known `fleet-update` payload for every agent from `lastEventCache`. If an agent has no cached payload (e.g., no `live-events.jsonl` write since startup), it is skipped.

6. **Broadcast to all clients.** When a change is detected, `broadcast(frame)` iterates `sseClients` and writes the complete SSE frame directly to each `ServerResponse`. If a write throws (closed socket), that client is removed from the set.

7. **Keep-alive pings (AC6).** After adding a client to `sseClients`, a `setInterval` runs every 30 seconds writing `: ping\n\n` to the connection. If the write throws, the client is removed and the interval is cleared.

8. **Client disconnect (AC5).** When the SSE connection closes (`req.on("close")`), the server removes the `ServerResponse` from `sseClients` and clears the ping interval. Subsequent broadcasts skip that client.

### Implementation

- **Watcher count:** One `fs.watch()` call per agent in `fleet.conf` (typically 4: agent-be, agent-fe, agent-qa, agent-doc)
- **Event filtering:** `live-events.jsonl` changes broadcast a full payload `{ type, agent, task, tool, summary, ts }`; `live.json` changes broadcast a minimal `{ type, agent, ts }`; all other files are ignored
- **Client registry:** `sseClients` is a `Set<ServerResponse>` (Node.js `http.ServerResponse`) populated at `/api/events` GET, cleaned up on disconnect or write error
- **Broadcast format:** Named SSE frames — `event: fleet-update\ndata: <json>\n\n`
- **Initial heartbeat:** `: ok\n\n` comment line sent immediately after headers (prevents proxy buffering, per AC1)
- **Reconnect replay:** `lastEventCache` is a `Map<string, string>` at module level; cleared on server restart, not persisted. Replayed on reconnect when `Last-Event-ID` header is present
- **Keep-alive interval:** 30-second `: ping\n\n` comment per client; interval cleared on disconnect
- **Error resilience:** Silent `catch` in `makeWatchHandler` for `live-events.jsonl` reads — ENOENT or permission errors skip the broadcast without rethrowing

### Use case

When an agent writes a log line to `live-events.jsonl`, the console receives the structured event within 1 second on all open browser tabs, without a page reload.

---

## Tab navigation and panel switching (v7.1)

The console UI organizes control surfaces into four tabs: **Fleet**, **Queue**, **Pipeline**, and **Cost**. Each tab is a distinct panel; clicking a tab switches which panel is visible while keeping others hidden.

### Tabs and panels

- **Fleet tab** — Shows agent fleet status (agent names, states, current task, elapsed time, recent tool use)
- **Queue tab** — Shows pending tasks awaiting approval (the approval section from earlier sections)
- **Pipeline tab** — Shows all ledger tasks grouped by status (In progress / Blocked / Open / Done), with domain filter chips and a spec panel that opens on card click (T13)
- **Cost tab** — Placeholder for operational cost tracking (not yet implemented; currently shows static text)

### Implementation

The console UI (`console.js`) renders a `<nav role="tablist">` element with four `<button role="tab">` elements (one per tab). When a tab is clicked:

1. The `onclick` handler finds the corresponding panel element (e.g., `<section id="section-fleet">`)
2. Sets `hidden` attribute on the previously active panel
3. Removes `hidden` attribute from the new panel
4. Updates the active button's `aria-selected` state and styling

Each panel (`section-fleet`, `section-queue`, `section-pipeline`, `section-cost`) is a sibling `<section>` in the DOM. CSS media queries and design tokens ensure tab buttons are styled consistently with the rest of the console.

---

## Fleet status table (v7.1)

The **Fleet tab** displays a real-time table of all agents in the fleet. Each row represents one agent and shows: agent name, current state (badge), current task ID (or "no tasks"), session start time, elapsed time, last tool used, and last summary.

### Table columns

| Column | Content | Source | Updates |
|--------|---------|--------|---------|
| Agent | Agent name with 32×32 Dicebear initials avatar | `fleet.conf` / API response | Static per session |
| State | Badge: **WORKING** (green) or **IDLE** (amber) | `presence/<agent>.json` | On state change; <1s via SSE |
| Task | Task ID (e.g., "CONS-015") or "—" if no tasks | `live.json` task field | On task change; <1s via SSE |
| Started | ISO timestamp when agent session started | `live.json` sessionStart | On session change; <1s via SSE |
| Elapsed | Human-readable duration (e.g., "2m 15s") | Calculated: now - sessionStart | Every 10s (client-side timer) |
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
   - Avatar: constructs a Dicebear URL from `a.name`, renders `<img class="fleet-avatar">`. On `onerror`, reveals `.fleet-avatar-fallback` (grey circle `<div>`) instead.
   - Elapsed time base: `baseTs` (from the `fleet-update` SSE event's `ts` field) when available, falling back to `Date.parse(a.sessionStart)` on the initial page load fetch
   - State badge CSS class is determined by the `state` field
   - Task ID defaults to "—" if missing
3. Replaces the old table with the new one (preserving scroll position when possible)
4. The elapsed-time columns continue to update every 10 seconds via client-side `setInterval` timer (independent of SSE updates)

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
- **Event payload:** Two shapes depending on trigger file. `live-events.jsonl` change: `{ type: "fleet-update", agent, task, tool, summary, ts }`. `live.json` change: `{ type: "fleet-update", agent, ts }`. Browser uses the event type as a trigger to re-fetch `/api/fleet`; payload fields are not parsed by the client
- **Last-Event-ID replay:** On reconnect with a `Last-Event-ID` header, the server immediately replays the last known `fleet-update` payload for every agent from `lastEventCache`. Agents with no cached payload are skipped
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

The server emits named `event: fleet-update` SSE frames on two triggers. The payload shape differs by source file:

**`live-events.jsonl` change** — last JSON line parsed, full payload broadcast:

```javascript
{
  "type": "fleet-update",
  "agent": "agent-be",
  "task": "T4",
  "tool": "Bash",
  "summary": "Running tests",
  "ts": 1718909802000
}
```

**`live.json` change** — minimal payload broadcast (agent state change, triggers re-fetch):

```javascript
{
  "type": "fleet-update",
  "agent": "agent-be",
  "ts": 1718909802000
}
```

The console client receives either event type and re-fetches `/api/fleet` to reflect the latest state. This eliminates the need for polling and keeps the fleet status table synchronized with agent activity in real-time.

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

**Palette tokens:**

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

**Typography tokens (T10):**

| Token | Value | Purpose |
|-------|-------|---------|
| `--font-body` | `'Satoshi', 'DM Sans', system-ui, sans-serif` | Body font stack — applied to `body { font-family }` |
| `--font-mono` | `'JetBrains Mono', ui-monospace, monospace` | Monospace font stack — applied to `code` and `.cmd` elements |

**Spacing scale tokens (T10):**

| Token | Value |
|-------|-------|
| `--space-1` | `4px` |
| `--space-2` | `8px` |
| `--space-3` | `12px` |
| `--space-4` | `16px` |
| `--space-6` | `24px` |
| `--space-8` | `32px` |

All `margin`, `padding`, and `gap` values in component rules use these tokens. No raw `px` values remain in component rules.

**Border-radius tokens (T10):**

| Token | Value | Applied to |
|-------|-------|------------|
| `--radius-card` | `6px` | `.card`, `.attention-card`, `.card-textarea`, fleet table rows (responsive) |
| `--radius-badge` | `4px` | `.section-badge`, `.failure-badge`, `.ai-draft-toggle`, `.card-agent-note` corners |
| `--radius-btn` | `6px` | Action buttons |

**Status dot color tokens (T10):**

These are separate from the palette `--green`/`--amber`/`--red` tokens and are used exclusively for the SSE connection status dot and state indicators:

| Token | Value | Purpose |
|-------|-------|---------|
| `--color-green` | `#16a34a` | Connected dot / working state |
| `--color-amber` | `#d97706` | Reconnecting dot |
| `--color-red` | `#dc2626` | Disconnected dot / error state |
| `--color-grey` | `#9ca3af` | Inactive / stopped state |

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

### Font sizing and line height
- Body text: `16px`, `line-height: 1.5` — set via `var(--font-body)` on `body`
- Monospace elements (`code`, `.cmd`): `font-family: var(--font-mono)`, `line-height: 1.6`
- Card border-radius: `6px` (`--radius-card`)
- Badge border-radius: `4px` (`--radius-badge`)
- Button border-radius: `6px` (`--radius-btn`)

---

## Console UI — Interactive features and polish (v7.1)

The `console.js` file implements a vanilla JavaScript frontend for the console UI, providing real-time task and approval queue management with animations, accessibility, and dynamic content updates via SSE.

### Fleet row avatars (AC1)

Each fleet table row renders a 32×32 Dicebear "initials" avatar next to the agent name. The avatar URL is constructed client-side:

```
https://api.dicebear.com/7.x/initials/svg?seed={encodeURIComponent(a.name)}&size=32
```

The `<img class="fleet-avatar">` element is placed next to the agent name text. If the Dicebear CDN is unreachable, the image's `onerror` handler reveals a `.fleet-avatar-fallback` grey circle `<div>` in its place. Below 640px, both the avatar and fallback are hidden via `display: none` to keep the stacked-card layout readable.

### SSE connection status dot (AC3)

The header includes a six-pixel coloured dot (`#sse-dot`) indicating SSE connection health. A `setInterval` polling every 2 seconds checks `es.readyState` and applies CSS classes accordingly:

| readyState | Class | Visual |
|---|---|---|
| `EventSource.OPEN` | (no class) | Green (pulsing) |
| `EventSource.CONNECTING` | `.connecting` | Amber |
| `EventSource.CLOSED` | `.disconnected` | Red (no pulse) |

Color values use the T10 status dot tokens (`--color-green`, `--color-amber`, `--color-red`) — these are distinct from the palette tokens (`--green`, `--amber`, `--red`) and carry the DESIGN.md-specified status dot hex values. The dot also transitions to `.disconnected` immediately on an `error` event, before the auto-reconnect delay fires.

### Unblock inline flow (AC5/AC6)

Attention cards start with a single **Unblock** button. Clicking it:

1. Hides the Unblock button (`hidden` attribute set).
2. Reveals the textarea wrapper (removes `hidden` attribute from `#textarea-wrapper-{id}`).
3. Reveals the **Send reply** button.
4. If an AI draft is available, reveals the AI draft toggle.
5. Focuses the textarea.

Clicking **Send reply** (AC6):

1. Reads the textarea value; if empty, focuses the textarea and returns without submitting.
2. Sets button text to "Sending…" and disables it.
3. POSTs to `POST /api/decision`:
   ```json
   { "action": "unblock", "text": "<operator note>", "agentName": "<ev.agent>", "taskId": "<ev.task_id>" }
   ```
4. After the request settles (success or error), calls `exitCard()` to fade and remove the card.

### Responsive layout (AC8)

Two CSS media query breakpoints ensure the console is usable on mobile:

**640px breakpoint** — fleet table switches from a standard table to a stacked-card layout:
- `<thead>` is hidden; `<tr>` renders as a `display: block` bordered card.
- Each `<td>` uses `td::before { content: attr(data-label) }` to prefix the column name (e.g. "AGENT", "STATE").
- Avatar and avatar-fallback are hidden to save space.
- Row hover background is suppressed (touch devices do not hover).

**375px breakpoint** — padding tightens to keep content readable at iPhone SE width:
- `page-body` padding reduced to `12px 8px 48px`.
- `page-header` padding and gap reduced.
- Approval command font size drops to 11px.
- Card action buttons are allowed to wrap.

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
1. Adds the `card-exit` class to trigger a `fadeOut 300ms forwards` animation
2. Waits 300ms for the fade to complete
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
- **Event types:** `approval`, `attention`, `resolve` (queue/attention events from the server); `pipeline-update` (ledger change events, triggers a `fetchPipeline()` call when the Pipeline tab is active).
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

The test suite uses `env -i + /bin/bash "$WRAPPER"` invocation throughout to avoid shebang-loop `E2BIG` errors that occur when multiple bash wrappers share a PATH. Each test passes a clean, minimal environment (`HOME`, `TMPDIR`, `PATH` pointing to system binaries only).

**REAL_BASH symlink detection (AC1):** A fake `bin/` directory is created containing only a symlink named `bash` that points to the wrapper itself. When the fake bin appears first on PATH, the wrapper's `realpath`-based loop must skip it and find the system bash. The test calls the wrapper via `/bin/bash "$WRAPPER"` (bypassing PATH lookup) and asserts exit 0.

**Chain-risk classification (AC2):** The inline `check_risk` and `evaluate_chain_risk` functions are tested:

| Command | Classification | Reason |
|---------|-----------------|--------|
| `git push origin main` | high | direct git push match |
| `git commit -m "fix"` | not high | no high-risk pattern |
| `bun test` | low | safe command |
| `cd /tmp && git push origin main` | high | `git push` in second segment |
| `rm -rf /home` | high | recursive remove |

**Approval polling via python3 (AC3):** Decision file parsing uses `python3 -c "import json, sys; ..."` — no `jq` dependency. Three paths are verified:

- **Approved path:** Decision file with `{"approved": true}` → wrapper executes the command, exits 0.
- **Rejected path:** Decision file with `{"approved": false}` → wrapper exits 1 (command blocked).
- **Timeout path:** No decision file appears within 3s (test-bounded) → non-zero exit (prevents indefinite hangs).

All three paths use isolated decision directories to prevent cross-test interference.

**SUPERVISOR_DECISIONS_DIR guard (AC6):** When `SUPERVISOR_DECISIONS_DIR` is unset and the wrapper intercepts a high-risk command, it:
- Exits with code 1
- Writes a warning to stderr containing `SUPERVISOR_DECISIONS_DIR`

Both conditions are asserted. This verifies commands are never silently executed when the console is unavailable.

### Server endpoint tests — `server.test.ts` + `server-utils.ts`

**Task ID validation (AC3):** The `POST /api/unblock/<taskId>` endpoint rejects invalid task IDs:

- Invalid: lowercase IDs (`cons-003`), missing digits (`CONS`), trailing slashes with extra segments
- Valid: uppercase letters followed by either hyphen+digits (`CONS-003`) or digits only (`T13`) — regex: `/^[A-Z]+(-[0-9]+|[0-9]+)$/` (T13 extended this from the original `/^[A-Z]+-[0-9]+$/` to support short-name style task IDs)
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

**`resolveControlDir` tests (T2 AC1–AC3, AC5):** Four describe blocks cover the control-repo discovery function:

| Describe block | What it tests |
|---|---|
| `resolveControlDir (AC1)` | Returns the first dir whose git remote URL contains the control-repo slug; other dirs are skipped |
| `resolveControlDir (AC2)` | Returns `null` when all agent dirs have unrelated remote URLs |
| `resolveControlDir (AC3)` | Returns `CONTROL_DIR` env var without calling `git`, even when the path does not exist |
| `resolveControlDir (AC5)` | Does not throw for a non-existent directory path; returns `null` |

Each test creates temporary git repos with `git init` + `git remote add origin <url>` to control exactly which remote URLs are visible. `process.env.CONTROL_DIR` is saved and restored around each test.

AC4 (startup cache) is human-verify: `resolveControlDir` is called once in `server.ts` at module level and the result stored in `const controlDir` — never re-called on subsequent requests.

**T4 SSE tests (T4 AC1–AC3, AC5):** Two `describe` blocks in `server.test.ts` cover the SSE endpoint and watch handler:

| Describe block | What it tests |
|---|---|
| `makeWatchHandler — AC2` | Writes a JSON line to a temp `live-events.jsonl`; asserts the broadcast frame contains `event: fleet-update` and payload fields `{ type, agent, task, tool, summary, ts }`; verifies `lastEventCache` is populated |
| `makeWatchHandler — AC3` | Points handler at a directory with no `live-events.jsonl`; asserts no frame is broadcast and no exception is thrown |
| `makeWatchHandler — live.json` | Triggers handler with `live.json`; asserts a named `event: fleet-update` frame is broadcast |
| `makeWatchHandler — unrelated` | Triggers handler with an unrelated filename; asserts no broadcast |
| `GET /api/events — AC1` | Fetches `/api/events` from a local SSE test server; asserts HTTP 200, SSE headers, and `": ok\n\n"` as the first response chunk |
| `GET /api/events — AC5` | Connects, reads the heartbeat, aborts the connection; asserts the client is removed from `sseClients` within 100ms |

AC4 (Last-Event-ID replay) and AC6 (30s ping interval) are human-verify: AC4 requires a reconnect with a `Last-Event-ID` header to observe replay messages; AC6 requires waiting 30 seconds and confirming `: ping\n\n` is emitted.

### Startup cleanup tests — `server-utils.ts` (T8 AC1–AC4)

`purgeStaleDecisionFiles` is called directly in unit tests using a temporary `cleanup-decisions/` directory. Each test writes files with controlled `mtime` values (via `utimesSync`) then calls the function and asserts the result:

| Test | AC | What it asserts |
|---|---|---|
| `deletes request *.json file older than 1 hour (AC1)` | AC1 | File with mtime 2 hours ago is deleted |
| `also deletes paired *.decision.json when request file is deleted (AC2)` | AC2 | Request + decision pair both deleted when request mtime > 1 hour |
| `deletes old *.decision.json even when request file is not old (AC2)` | AC2 | Old decision file deleted independently by the second pass |
| `does NOT delete request file newer than 1 hour (AC3)` | AC3 | Recently written request file survives the sweep |
| `exits silently when decisionsDir does not exist (AC4)` | AC4 | Non-existent path → no exception thrown |
| `exits silently when decisionsDir is empty string (AC4)` | AC4 | Empty string → no exception thrown |

AC5 (cleanup runs before `server.listen()`) is human-verify: confirmed by `server.ts` calling `purgeStaleDecisionFiles(...)` at line 402, before `server.listen(PORT, HOSTNAME, ...)` at line 413.

### Pipeline view tests — `server.test.ts` (T13 AC1/AC2/AC3/AC7)

Three `describe` blocks cover the T13 pipeline endpoints and the ledger watch handler:

**`describe("GET /api/pipeline")`** — Three mock `.task` files with distinct statuses and controlled `mtime` values are written before the suite. Tests assert:
- Response is HTTP 200 JSON with a `tasks` array and an `updatedAt` field (AC1)
- Each task carries `updated_at` derived from file `mtime` (AC1)
- Tasks within status groups are sorted by `updated_at` descending — most-recently-changed first (AC2)

**`describe("makeLedgerWatchHandler")`** — Tests the exported handler function directly without a live server:

| Test | AC | What it asserts |
|---|---|---|
| `broadcasts single pipeline-update SSE frame for a .task file change` | AC3 | Writes a `.task` file, calls the handler, asserts exactly one SSE frame with `event: pipeline-update`, `task_id`, `status`, and `agent: null` when `claimed_by` is `"-"` |
| `includes claimed_by as agent when not "-"` | AC3 | File with `claimed_by: agent-fe` → `agent` field in payload is `"agent-fe"` |

Non-`.task` filenames and IDs failing `TASK_ID_RE` are silently ignored (no frame broadcast).

**`describe("GET /api/spec/:taskId")`** — Five tests covering AC7:

| Test | AC | What it asserts |
|---|---|---|
| `returns 200 with markdown content for a valid existing taskId` | AC7 | HTTP 200, `content-type: application/json`, body `{ markdown: string }` containing the task ID |
| `returns 400 for invalid taskId (lowercase)` | AC7 | `cons-999` → HTTP 400, error field truthy |
| `returns 400 for invalid taskId (no digits)` | AC7 | `CONS` → HTTP 400 |
| `returns 404 for valid taskId with no spec file` | AC7 | `T13` → HTTP 404, error field truthy |
| `returns 503 when no tasksDir configured` | AC7 | Separate server without `tasksDir` → HTTP 503 |

AC6 (spec panel click opens panel with content) and AC8 (domain filter persists in localStorage) are human-verify.

### Test results

All 79 tests pass (2 bash-wrapper + 77 server tests). Run the full suite with:

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
5. Asserts `GET /api/pipeline` returns HTTP 200 (T13 AC1 prerequisite)
6. Asserts `GET /api/spec/invalid-id` returns HTTP 400 (T13 AC7)
7. Asserts `index.html` contains the `pipeline-groups` container element (T13 AC4/AC5)
8. Asserts the pipeline JSON response contains a `tasks` key (T13 AC4/AC5)
9. Captures a timestamped screenshot to `/tmp/console-qa-<timestamp>.png`
10. Prints the screenshot path to stdout so the QA agent can attach it to its report

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

## Pipeline view — GET /api/pipeline + GET /api/spec/:taskId (T13)

The Pipeline tab gives directors a single-screen answer to "how much work is left?" by reading every task in the ledger and grouping them by status. The view is SSE-driven: initial load calls `GET /api/pipeline`, and any subsequent `.task` file change in the ledger triggers a `pipeline-update` SSE event that refreshes the tab automatically.

### GET /api/pipeline (AC1/AC2)

**Endpoint:** `GET /api/pipeline`

**Response:** HTTP 200 with `Content-Type: application/json`:

```json
{
  "tasks": [
    {
      "id": "T13",
      "status": "documenting",
      "domain": "doc",
      "claimed_by": "agent-doc",
      "failure_count": "0",
      "description": "Pipeline view: GET /api/pipeline + task card layout",
      "updated_at": "2026-06-22T11:00:00.000Z"
    }
  ],
  "updatedAt": "2026-06-22T11:01:00.000Z"
}
```

**`updated_at` field (AC1 extension):** `parseTaskLedger` was extended to return `PipelineTask[]` (a superset of the existing `TaskEntry` type). Each `PipelineTask` carries an `updated_at` ISO string derived from the task file's `mtime`. If the stat call fails, `updated_at` defaults to the Unix epoch.

**Sort order (AC2):** The server sorts tasks within each status group by `updated_at` descending — the most recently changed task appears first. Groups themselves are not sorted by the endpoint; that ordering is applied by the client in `PIPELINE_STATUS_GROUPS`.

### GET /api/spec/:taskId (AC7)

**Endpoint:** `GET /api/spec/:taskId`

Returns the raw markdown content of a task's spec file from `$CONTROL_DIR/tasks/{taskId}.md`.

| Status | Condition |
|---|---|
| 200 | Valid `taskId`, file exists — body: `{ "markdown": "..." }` |
| 400 | `taskId` fails `TASK_ID_RE` — body: `{ "error": "invalid task ID" }` |
| 404 | Valid `taskId` but no spec file at the resolved path — body: `{ "error": "spec not found" }` |
| 503 | `CONTROL_DIR` not configured — body: `{ "error": "CONTROL_DIR not configured" }` |

The `taskId` is validated against `TASK_ID_RE` before any filesystem access. Spec content is fetched at click time (not pre-loaded).

### Pipeline-update SSE event (AC3)

When any `.task` file in `$CONTROL_DIR/ledger/` changes, the server broadcasts a named SSE event to all connected clients:

```
event: pipeline-update
data: {"type":"pipeline-update","task_id":"T13","status":"done","agent":null}
```

The `agent` field is the current `claimed_by` value (null if the task is unclaimed or the field is `"-"`). This event reuses the existing ledger `fs.watch` watcher registered at server startup via `makeLedgerWatchHandler` — no second `fs.watch` call is opened.

The browser listens for `pipeline-update` events and calls `fetchPipeline()` only when the Pipeline tab is currently active. Inactive tabs do not fetch.

### Pipeline tab UI (AC4/AC5)

Tasks are rendered in four collapsible groups, in this order:

| Group | Statuses covered |
|---|---|
| In progress | `in_progress`, `testing`, `documenting` |
| Blocked | `needs_human`, `awaiting_info` |
| Open | `open` |
| Done | `done` |

Each group header shows the group name and a count badge. Groups with zero tasks are collapsed by default (header present, body `hidden`). Clicking a header toggles `aria-expanded` and removes/adds the `hidden` attribute on the body.

Each task card (`<article role="button">`) shows:
- **Task ID** — bold
- **Domain pill** — `domain` field (falls back to `origin_domain` if absent)
- **Agent name** — `claimed_by` field; greyed-out "—" when unclaimed
- **Failure count badge** — amber badge showing `failure_count`, visible only when ≥ 1
- **Time since `updated_at`** — relative time string (e.g., "5m ago", "2h ago")

### Domain filter chips (AC8)

Five chips above the pipeline groups let operators filter by domain: **All**, **be**, **fe**, **doc**, **qa**. The active chip uses a filled style (`.domain-chip-active` CSS class). The selected filter is persisted to `localStorage` under the key `console-pipeline-domain-filter` so it survives page reloads. On filter change, `renderPipeline()` is called immediately with the stored filter.

### Spec panel (AC6)

Clicking any task card (or pressing Enter/Space when the card is focused) opens a slide-in `<aside id="spec-panel">` at the right edge of the Pipeline panel. The panel:

1. Shows the `taskId` as a header
2. Fetches `GET /api/spec/{taskId}` from the server
3. Displays the raw markdown response as `<pre>` content inside `#spec-content`

Content is fetched at click time — not pre-loaded. "Loading…" is displayed while the request is in flight. A close button dismisses the panel.

---

## Log tail endpoint — GET /api/log/:agent (v7.1)

When a director clicks on an agent in the Fleet tab, a log panel opens showing the agent's last 50 events from `live-events.jsonl`. The `GET /api/log/:agent` endpoint seeds this panel on open; subsequent events arrive via the existing SSE stream filtered by agent name.

### Endpoint

**`GET /api/log/:agent?n=<count>`**

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `:agent` | path | — | Must be a name from `fleet.conf`; unknown agents → 404 |
| `?n` | query | `50` | Integer 1–200; non-numeric or > 200 → 400 |

**Response (200):**

```json
{
  "events": [
    { "ts": "2026-06-22T00:00:01Z", "tool": "Bash", "summary": "ran bun test", "path": null },
    { "ts": "2026-06-22T00:00:05Z", "tool": "Read",  "summary": "read README.md", "path": "/Users/user/agents/agent-be/work/README.md" }
  ]
}
```

The response also includes an `X-Log-Lines` header reporting the total number of non-empty lines in the file before the tail (for pagination context).

Each event object always has four fields:

| Field | Type | Notes |
|---|---|---|
| `ts` | string | ISO timestamp from the JSONL line |
| `tool` | string | Tool name (e.g. `Bash`, `Read`, `Edit`) |
| `summary` | string | One-line description of the action |
| `path` | string \| null | File path if present; `null` for events that have no path |

### Error responses

| Status | Condition |
|---|---|
| 400 | `?n` is non-numeric, < 1, or > 200 — body: `{ "error": "n must be 1-200" }` |
| 404 | Agent name not found in `validAgents` (built from `fleet.conf`) |
| 429 | Rate limit exceeded (10 req/s per client IP) — body: `{ "error": "rate limit exceeded" }` |

When the log file is absent or empty, the endpoint returns `200 { "events": [] }` — not 404 or 500 (AC4). This handles the case where an agent has been registered in `fleet.conf` but has not yet written any events.

### readLogTail() — server-utils.ts

`readLogTail(logFile, n)` is the pure utility that reads the JSONL file:

1. Calls `readFileSync(logFile, "utf8")` — any exception (file not found, permission denied) returns `{ events: [], totalLines: 0 }` without rethrowing (AC4).
2. Splits on `\n` and filters blank lines to get `lines[]`; records `totalLines = lines.length`.
3. Slices the last `n` lines with `lines.slice(-n)`.
4. For each line, calls `JSON.parse()` in a try/catch — malformed lines are silently skipped (AC5).
5. Normalizes each parsed object into a `LogEvent` (typed fields with fallbacks to `""` / `null`).
6. Returns `{ events, totalLines }`.

The file is read whole-file in memory. Log files are small (< 100KB in practice) — no streaming or external `tail` process is used (per the spec constraint).

### makeRateLimiter() — server-utils.ts

`makeRateLimiter(maxPerSecond)` returns a `{ check(ip) }` token-bucket guard:

- Keeps a `Map<string, { count, resetAt }>` at module scope — one bucket per client IP.
- On each `check(ip)` call: if the bucket is absent or expired, a fresh bucket (`count=1, resetAt=now+1000ms`) is created and `true` is returned.
- If the bucket is current and `count >= maxPerSecond`, returns `false` (caller responds 429).
- Otherwise increments `count` and returns `true`.
- State resets on server restart (no external cache — per spec constraint).

The server creates one `logRateLimiter = makeRateLimiter(10)` at module scope and shares it across all `/api/log/:agent` requests.

### Implementation in server.ts

The handler is registered after all other API routes and before the static file fallback:

```
GET /api/log/:agent
  → validate agentName ∈ validAgents (404 if not)
  → rate-limit check (429 if over)
  → parse ?n (400 if invalid)
  → readLogTail(~/agents/{agent}/logs/live-events.jsonl, n)
  → respond 200 { events } + X-Log-Lines header
```

Log files are located at `homedir()/agents/{agentName}/logs/live-events.jsonl` — the same path the SSE watcher (`makeWatchHandler`) reads.

### Test coverage (AC1–AC7)

Two new `describe` blocks in `server.test.ts` cover all seven ACs:

| Test | AC | What it asserts |
|---|---|---|
| `returns last 50 of 100 events` | AC1 | 100-line fixture, `?n=50` → 50 events; last event `ts=99` |
| `?n=300 returns 400` | AC2 | Body `{ error: "n must be 1-200" }` |
| `?n=abc returns 400` | AC2 | Non-numeric → same 400 body |
| `unknown agent returns 404` | AC3 | Agent not in Set → 404 |
| `missing log file returns { events: [] }` | AC4 | `readLogTail` called with nonexistent path → `{ events: [], totalLines: 0 }` |
| `malformed JSON lines silently skipped` | AC5 | File with 1 bad line, 2 valid → 2 events returned |
| `X-Log-Lines header equals total line count` | AC6 | 100-line file, header `100` |
| `11th request returns 429` | AC7 | Isolated server, 11 sequential requests → first 10 are 200, 11th is 429 |

---

## Adding a new agent

1. Add a line to `fleet.conf`
2. Create `~/agents/<new-agent>/config` on the target machine
3. Run `./fleet.sh start` (or `./fleet.sh install` for production)
