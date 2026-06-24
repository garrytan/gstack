# supervisor — cstack agent fleet runner

Scripts for starting, stopping, and monitoring the autonomous agent fleet.

| File | Purpose |
|------|---------|
| `run-agent.sh` | Single-agent supervisor loop (v7 — real-time collaboration) |
| `fleet.sh` | Start/stop/status/logs for all agents at once |
| `fleet.conf` | Declare all agents in one place |
| `install.sh` | Register an agent as a launchd (macOS) or systemd (Linux) service |
| `wake-listen.ts` | Supabase Realtime subscriber — wakes idle agents in <1s cross-machine |
| `console/server.ts` | Console HTTP server (v7.1 — auto-detects control repo, gates risky Bash commands, streams live events via SSE; T11: fleet control routes — POST /api/fleet/stop, /restart, /pause, /resume; T11-amended: shim removed — `validAgents` built solely from `controlDir/fleet.conf` via `rebuildValidAgents()`, called at startup and on workspace switch; T15-amended: `POST /api/fleet/restart` calls `kernel/task fail {taskId} --agent {agentName} --role human` via `spawnSync` before stopping and relaunching — returns 500 if fail exits non-zero, skips if agent holds no claimed task; T5: `handleDraftDecision` rewritten — Anthropic SDK dependency removed, endpoint now appends a timestamped human note block to the agent's mailbox file and calls `gitCommitAndPush`) |
| `console/bin/bash` | Risk-gated Bash tool intercept (v7.1 — blocks destructive commands until approved) |
| `console/index.html` | Console UI entry point (v7.1 — serves static HTML with SSE support, Pipeline tab panel with domain filter chips and spec panel) |
| `console/console.js` | Console interactive client (v7.1 — card animations, empty states, AI draft panel, ARIA accessibility, Pipeline tab with collapsible status groups, domain filter chips persisted in localStorage, spec panel on card click, `pipeline-update` SSE listener; T13-amended: `pipelineBootstrapped` one-shot guard on tab activate, `fetchPipeline()` called on SSE reconnect, all SSE listeners fixed from `currentEs` → `es`) |
| `console/styles.css` | Console design system (v7.1 — dark theme, motion tokens, Satoshi/DM Sans/JetBrains Mono typefaces, pipeline group/card/filter/spec-panel component styles) |
| `console/server-utils.ts` | Utility exports — parsing ledger/mailbox, task ID validation (`TASK_ID_RE` supports both `CONS-003` and `T13` styles), fleet status reading, SSE helpers, `makeWatchHandler` (reads last `live-events.jsonl` line, caches payload for Last-Event-ID replay), `makeLedgerWatchHandler` (broadcasts `pipeline-update` SSE on `.task` file changes), port resolution, `readLogTail` (JSONL tail reader), `makeRateLimiter` (token-bucket rate limiter), `purgeStaleDecisionFiles` (startup garbage collection of stale decision files), `PipelineTask` type (T13); T11: `readPidFile` (reads PID from a pid file), `stopProcess` (SIGTERM + SIGKILL-after-5s async stop), `defaultIsProcessAlive` (signal-0 liveness check), `defaultKillFn` (signal sender), `KillFn`/`IsAliveFn` injectable types; T14: `computeStuckSignals` (reads each agent's JSONL tail + ledger, returns `StuckAgent[]` with silent/loop/fail_storm signals), `StuckAgent` type; T9: `readAndValidatePostBody` (validates Content-Type header + JSON body for all POST handlers; returns `{ ok: true; json: unknown; raw: string }` on success or `{ ok: false; statusCode: number; error: string }` on failure) (v7.1) |
| `console/bash-wrapper.test.ts` | Bun test wrapper that runs bash-wrapper.test.sh inline (v7.1) |
| `console/bash-wrapper.test.sh` | Bash unit tests for risk classification (check_risk) and polling behavior (poll_approval) (v7.1) |
| `console/server.test.ts` | Bun tests for endpoint security, static serving, queue bootstrap, `resolveControlDir`, SSE endpoint (T4 AC1/AC2/AC3/AC5), `makeWatchHandler`, log tail endpoint (T12 AC1-AC7), rate limiter, startup cleanup (T8 AC1-AC4), pipeline endpoint (T13 AC1/AC2), ledger watch handler (T13 AC3), spec endpoint (T13 AC7), pipeline bootstrap guard (T13-amended AC2), SSE reconnect pipeline bootstrap (T13-amended AC4), fleet control endpoints (T11 AC1-AC8), stuck detection engine (T14 AC1-AC8), fleet.conf-based validAgents (T11-amended AC2/AC3/AC4), malformed JSONL resilience (T14-amended AC2/AC3/AC4), T9 edge-case coverage (malformed JSON body AC1, missing Content-Type AC2, concurrent SSE AC3, rawPath dot-segment preservation AC4, parseMailboxNotes edge cases AC5, makeWatchHandler rename+change AC6, GET /api/fleet absent fleet.conf AC7, qa-smoke.sh AC8), and BUG-2 regression guard (static grep: `computeStuckSignals` must not receive the undefined `agentList` variable) (131 total: 2 bash-wrapper + 129 server) |
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

If you want the same machine to run two projects at once, create a separate config file for each project and give every agent a unique name. The config file name still follows `~/agents/<agent-name>/config`, so the names need to be different even if the roles are the same.

Example: Project A uses `proj-a-*` and Project B uses `proj-b-*`.

```bash
# Project A
mkdir -p ~/agents/proj-a-fe
cat > ~/agents/proj-a-fe/config <<EOF
CONTROL_REPO_URL=git@github.com:your-org/project-a-control.git
WORK_REPO_URL=git@github.com:your-org/project-a-frontend.git
AGENT_DOMAIN=fe
EOF

mkdir -p ~/agents/proj-a-be
cat > ~/agents/proj-a-be/config <<EOF
CONTROL_REPO_URL=git@github.com:your-org/project-a-control.git
WORK_REPO_URL=git@github.com:your-org/project-a-backend.git
AGENT_DOMAIN=be
EOF

# Project B
mkdir -p ~/agents/proj-b-fe
cat > ~/agents/proj-b-fe/config <<EOF
CONTROL_REPO_URL=git@github.com:your-org/project-b-control.git
WORK_REPO_URL=git@github.com:your-org/project-b-frontend.git
AGENT_DOMAIN=fe
EOF

mkdir -p ~/agents/proj-b-qa
cat > ~/agents/proj-b-qa/config <<EOF
CONTROL_REPO_URL=git@github.com:your-org/project-b-control.git
WORK_REPO_URL=
AGENT_DOMAIN=qa
EOF
```
cat > ~/agents/cms-agent-be/config <<EOF
CONTROL_REPO_URL=https://github.com/seab-group/dsti-website-cms-control.git
WORK_REPO_URL=https://github.com/seab-group/dsti-website-cms.git
AGENT_DOMAIN=be
EOF

Then create a matching `fleet.conf` for each project. For example:

```bash
# ~/agents/project-a/fleet.conf
proj-a-fe    FEATURE_ROLE.md    claude-sonnet-4-6
proj-a-be    FEATURE_ROLE.md    claude-sonnet-4-6
proj-a-qa    QA_ROLE.md         claude-sonnet-4-6
proj-a-doc   DOC_ROLE.md        claude-sonnet-4-6

# ~/agents/project-b/fleet.conf
proj-b-fe    FEATURE_ROLE.md    claude-sonnet-4-6
proj-b-be    FEATURE_ROLE.md    claude-sonnet-4-6
proj-b-qa    QA_ROLE.md         claude-sonnet-4-6
proj-b-doc   DOC_ROLE.md        claude-sonnet-4-6
```

Start whichever fleet you want by pointing `FLEET_CONF` at the right file:

```bash
FLEET_CONF=~/agents/project-a/fleet.conf ./fleet.sh start
FLEET_CONF=~/agents/project-b/fleet.conf ./fleet.sh start
```

**macOS production install (launchd)** — agents start immediately and survive logout/reboot:

```bash
cd supervisor

./install.sh agent-be     FEATURE_ROLE.md  claude-sonnet-4-6
./install.sh agent-fe     FEATURE_ROLE.md  claude-sonnet-4-6
./install.sh agent-qa     QA_ROLE.md       claude-haiku-4-5
./install.sh agent-doc    DOC_ROLE.md      claude-haiku-4-6
./install.sh cms-agent-be FEATURE_ROLE.md  claude-sonnet-4-6
./install.sh cms-agent-fe FEATURE_ROLE.md  claude-sonnet-4-6
./install.sh cms-agent-qa QA_ROLE.md       claude-haiku-4-5
./install.sh cms-agent-doc DOC_ROLE.md     claude-haiku-4-6
```

Check status:

```bash
./fleet.sh status
```

To remove all services:

```bash
./fleet.sh uninstall
```

**Linux production install (systemd)** — same per-agent config files, installed as systemd user services with `install.sh`.

Example for one Linux machine running Project A:

```bash
mkdir -p ~/agents/proj-a-fe
cat > ~/agents/proj-a-fe/config <<EOF
CONTROL_REPO_URL=git@github.com:your-org/project-a-control.git
WORK_REPO_URL=git@github.com:your-org/project-a-frontend.git
AGENT_DOMAIN=fe
EOF

mkdir -p ~/agents/proj-a-be
cat > ~/agents/proj-a-be/config <<EOF
CONTROL_REPO_URL=git@github.com:your-org/project-a-control.git
WORK_REPO_URL=git@github.com:your-org/project-a-backend.git
AGENT_DOMAIN=be
EOF

cd supervisor
./install.sh proj-a-fe FEATURE_ROLE.md claude-sonnet-4-6
./install.sh proj-a-be FEATURE_ROLE.md claude-sonnet-4-6
./install.sh proj-a-qa QA_ROLE.md claude-sonnet-4-6
./install.sh proj-a-doc DOC_ROLE.md claude-sonnet-4-6
```

After install, Linux manages them with `systemctl --user`:

```bash
systemctl --user status cstack-proj-a-fe
systemctl --user stop cstack-proj-a-fe
systemctl --user disable --now cstack-proj-a-fe
```

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

If you want to run Project A and Project B at the same time on the same machine, give each project its own agent names. The supervisor keys everything off `~/agents/<agent-name>/config`, log directories, presence files, and launchd/systemd labels, so `agent-fe` can only belong to one project at a time.

The supported pattern is to namespace the names, for example:

```bash
# Project A
proj-a-fe
proj-a-be
proj-a-qa
proj-a-doc

# Project B
proj-b-fe
proj-b-be
proj-b-qa
proj-b-doc
```

You can keep separate `fleet.conf` files and point `FLEET_CONF` at the one you want to start, but the agent names still need to be unique across all concurrent projects.

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

Valid agent names are those in the `validAgents` Set, which is loaded from `controlDir/fleet.conf` at startup (T11-amended AC1). If that file is absent, `validAgents` is empty and every agent name is rejected (T11-amended AC2). `supervisor/fleet.conf` is read only to locate agent log directories — it is not the source for name validation.

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

**Fleet.conf parsing (AC6 / T11-amended AC1–AC3):**
At startup, `server.ts` calls `rebuildValidAgents(controlDir)`, which reads `controlDir/fleet.conf` and builds `validAgents` — a `Set<string>` of all agent names listed in the file. All agents listed in `fleet.conf` are immediately valid. If `controlDir/fleet.conf` is absent or unreadable, `validAgents` is set to an empty `Set` and a warning is written to stderr; the server continues (T11-amended AC2). When the workspace changes (via `POST /api/workspace-switch`), `rebuildValidAgents` is called again with the new `controlDir`; if the new `fleet.conf` is absent, `validAgents` is emptied rather than kept from the previous workspace (T11-amended AC3). The Set is queried on every request to `/api/mailbox/:agentName`.

**POST body validation — `readAndValidatePostBody` (T9 AC1/AC2):**
All POST endpoints (`/api/mailbox/:agentName`, `/api/approve`, `/api/draft-decision`) call `readAndValidatePostBody(req)` before any filesystem or git operation. The function checks the `Content-Type` header (must include `application/json`) and parses the request body as JSON. A wrong content type or unparseable body produces an immediate HTTP 400 response. The function returns a discriminated union: `{ ok: true; json: unknown; raw: string }` on success or `{ ok: false; statusCode: number; error: string }` on failure. Prior to T9, each handler read raw body bytes and called `JSON.parse` independently, and a missing `Content-Type` header was silently accepted.

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

## Human notes to agents — POST /api/draft-decision (T5 / T9)

The console lets operators send a note directly into an agent's mailbox, tied to a specific task. The server validates the request, appends a formatted block to the agent's mailbox file in the control repo, and commits the change. This replaces the earlier CONS-005 Anthropic SDK SSE stub, which was a placeholder. The endpoint is now a plain JSON endpoint with no streaming and no external API dependency.

### Request and response

**Endpoint:** `POST /api/draft-decision`

**Required headers:** `Content-Type: application/json`

**Request body:**
```json
{
  "agentName": "agent-be",
  "taskId": "T9",
  "text": "Please use the pattern from server-utils.ts for the new endpoint."
}
```

**Response:** HTTP 200 JSON on success:
```json
{ "ok": true }
```

### Validation

All three fields are required. The server applies the following checks in order and returns immediately on the first failure:

1. `Content-Type` header must include `application/json` — returns 400 with `{ "error": "content-type must be application/json" }` if not.
2. Request body must be valid JSON — returns 400 with `{ "error": "invalid JSON body" }` if not.
3. `agentName` must be a member of `validAgents` (loaded from `controlDir/fleet.conf`) — returns 400 with `{ "error": "unknown agent" }` if not.
4. `taskId` must match `TASK_ID_RE` — returns 400 with `{ "error": "invalid taskId" }` if not.
5. `text` must be a non-empty string — returns 400 with `{ "error": "text required" }` if not.
6. `controlDir` must be configured — returns 503 with `{ "error": "control dir not configured" }` if not.

### Mailbox append format

The appended block uses the standard agent-loop mailbox format:

```
## from: human | <ISO-timestamp> | re: <taskId>
<text>
```

The file written is `$controlDir/mailboxes/<agentName>.md`. After appending, the server calls `gitCommitAndPush(controlDir, "console: note for <agentName> re <taskId>")`. If the push fails, the endpoint returns HTTP 500 with `{ "error": "git push failed" }`.

### AC → verification mapping

| AC | Test | Location |
|---|---|---|
| AC1 — malformed body → 400 | `describe("malformed JSON body (AC1)")` — draft-decision test | `server.test.ts` |
| AC2 — missing Content-Type → 400 | `describe("missing Content-Type (AC2)")` — draft-decision test | `server.test.ts` |

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

## Fleet control endpoints (T11)

Operators can stop, restart, pause, or resume any agent directly from the Fleet tab. The four `POST /api/fleet/*` endpoints send OS-level signals to the agent process, whose PID is read from `supervisor/pids/{agentName}.pid` — a file written by `run-agent.sh` when it spawns Claude.

### Endpoints

| Endpoint | Action | Signal(s) | Returns |
|---|---|---|---|
| `POST /api/fleet/stop?agent=<name>` | Graceful stop | SIGTERM; SIGKILL after 5 s if still alive | `{ ok: true }` |
| `POST /api/fleet/restart?agent=<name>` | Stop then re-launch | SIGTERM / SIGKILL (per stop), then spawns `run-agent.sh <name>` | `{ ok: true }` immediately after spawn |
| `POST /api/fleet/pause?agent=<name>` | Suspend execution | SIGSTOP | `{ ok: true }` |
| `POST /api/fleet/resume?agent=<name>` | Resume execution | SIGCONT | `{ ok: true }` |

### How stop works

`stopProcess(pid, opts)` in `server-utils.ts` is an async function that:

1. Checks process liveness via `process.kill(pid, 0)` (signal 0 — no effect, ESRCH if not found).
2. If already dead: returns immediately. No signal sent. This covers both the stale-PID case (AC6) and the idempotent double-stop case (AC8).
3. Sends SIGTERM.
4. Starts a 50 ms poll loop checking liveness every 50 ms.
5. If the process has not exited after `stopTimeoutMs` (default 5000 ms), sends SIGKILL and resolves.
6. If the process exits before the timeout fires, clears the timer and resolves.

`restart` (T15-amended) first checks whether the agent holds a claimed ledger task by calling `parseTaskLedger(join(controlDir, "ledger"))` and finding an entry where `claimed_by === agentName`. If one exists, it calls `spawnSync(join(controlDir, "kernel", "task"), ["fail", taskId, "--agent", agentName, "--role", "human"])` to record the failure as human-initiated. If that subprocess exits non-zero, the handler returns HTTP 500 `{ error: "kernel/task fail exited with code N" }` and aborts without restarting. If no claimed task exists, the fail step is skipped. After the fail step (or skip), `restart` calls `stopProcess` then spawns `run-agent.sh <agentName>` as a detached subprocess with `stdio: 'ignore'` and calls `proc.unref()`, so the console server does not wait for or track the new Claude session.

### Error responses

| Condition | Status | Body |
|---|---|---|
| `agentName` not in `validAgents` (from `controlDir/fleet.conf`) | 400 | `{ error: 'unknown agent' }` |
| PID file does not exist at `pids/{agentName}.pid` | 404 | `{ error: 'pid file not found' }` |
| Process is not running — pause or resume only (AC6) | 409 | `{ error: 'process not running' }` |
| `kernel/task fail` exits non-zero — restart only (T15-amended AC3) | 500 | `{ error: 'kernel/task fail exited with code N' }` |

For `stop` and `restart`, a stale PID (process already exited) is handled silently — `stopProcess` returns immediately and the response is `{ ok: true }`. This makes `stop` idempotent (AC8).

### SSE broadcast after stop and restart (AC7)

After `stopProcess` resolves (and after `run-agent.sh` is spawned for restart), the server broadcasts a `fleet-update` SSE event to all connected browsers:

```json
{
  "type": "fleet-update",
  "agent": "agent-be",
  "action": "stop",
  "ts": 1718909802000
}
```

The `action` field is `"stop"` or `"restart"`. `pause` and `resume` do not broadcast — they are silent, low-latency operations.

### Implementation constraints

- PID file path: `join(supervisorDir, 'pids', '{agentName}.pid')`. `supervisorDir` is `dirname(__dirname)` (the directory containing `console/`) — never hardcoded.
- `readPidFile` returns `null` for missing files, unreadable files, and non-positive integer content. The server returns 404 when `readPidFile` returns `null`.
- Signal calls are wrapped in `try/catch` — the process may exit between the liveness check and the `process.kill` call.
- macOS only: Windows process signals are out of scope.

### AC → verification mapping

| AC | What it tests |
|---|---|
| AC1 | `stopProcess` sends SIGTERM first, then SIGKILL after timeout when process stays alive |
| AC2 | `POST /api/fleet/restart` stops the agent then spawns `run-agent.sh <agentName>` (T15-amended: preceded by `kernel/task fail --role human` when a claimed task exists) |
| AC3 | `POST /api/fleet/pause` sends SIGSTOP to the agent's PID |
| AC4 | `POST /api/fleet/resume` sends SIGCONT to the agent's PID |
| AC5 | Unknown agent name → 400 on all four endpoints |
| AC6 | Stale PID: stop → 200 (no signal); pause/resume → 409 |
| AC7 | `fleet-update` SSE event broadcast after stop and restart; NOT after pause |
| AC8 | Double stop when process is dead → 200 both times |

---

## Fleet control — validAgents hardening (T11-amended)

T11 used `supervisor/fleet.conf` (the file that lists all agents for log-watcher setup) as the source for `validAgents`. T11-amended removes that shim: `validAgents` is now built exclusively from `controlDir/fleet.conf` — the fleet.conf inside the control repo checkout, which is the authoritative source of agent registration.

### What changed

| Component | Before (T11) | After (T11-amended) |
|---|---|---|
| `validAgents` source | `supervisor/fleet.conf` (hardcoded path) | `controlDir/fleet.conf` (workspace-resolved at runtime) |
| Missing `fleet.conf` at startup | Fatal — server exited with error | Non-fatal — `validAgents` emptied, warning to stderr, server continues |
| Workspace switch | Not supported | `rebuildValidAgents(newControlDir)` called; if new file absent, `validAgents` emptied |
| `GET /api/fleet` agent list | `agentList` from supervisor fleet.conf | `[...validAgents]` from control fleet.conf |

### rebuildValidAgents

`rebuildValidAgents(dir: string)` is a module-level function in `server.ts`:

```typescript
function rebuildValidAgents(dir: string): void {
  if (!dir) { validAgents = new Set(); return; }
  const confPath = join(dir, "fleet.conf");
  try {
    validAgents = new Set(parseFleetConf(readFileSync(confPath, "utf8")));
  } catch {
    process.stderr.write(`WARNING: fleet.conf not found at ${confPath} — no agents valid\n`);
    validAgents = new Set();
  }
}
```

It is called:
1. Once at startup with the resolved `controlDir`.
2. On `POST /api/workspace-switch` with the new `controlDir` from the request body.

### supervisorAgentList — separation of concerns

The `supervisorAgentList` (read from `supervisor/fleet.conf`) is kept as a separate, startup-only list used exclusively for log-watcher directory setup. It is never used for request validation. This separation means the log-watchers continue to cover all agents even if the workspace has no fleet.conf.

### AC → verification mapping

| AC | What it tests |
|---|---|
| AC1 | No hardcoded agent list remains in `server.ts`; `validAgents` built from `parseFleetConf(readFileSync(join(controlDir, 'fleet.conf'), 'utf-8'))` |
| AC2 | Missing `controlDir/fleet.conf` → `validAgents` empty → any `POST /api/mailbox/:name` returns 400 |
| AC3 | `POST /api/workspace-switch` with a new `controlDir` rebuilds `validAgents`; switching to a workspace with absent fleet.conf empties `validAgents` |
| AC4 | `GET /api/fleet` returns only agents present in `validAgents`; returns empty array when `validAgents` is empty |

---

## Stuck detection engine (T14)

The console can detect when an agent is stuck — claimed on a task but showing no observable progress — and report it via `GET /api/stuck`. Three signal types cover the most common failure modes. A `stuck` SSE event fires edge-triggered when a new signal is detected for an agent, at most once per 60-second evaluation window.

### Signal types

| Signal | Detection rule | `detail` format |
|---|---|---|
| `fail_storm` | Agent's current task has `failure_count >= 2` and `status` is not `needs_human` or `awaiting_info` | `"{N} failed attempts"` |
| `loop` | Last 5 valid JSONL events in `live-events.jsonl` all share the same non-null `tool` field | `"looping on {tool}"` |
| `silent` | `ts` of the last valid JSONL event is more than 600 seconds before `Date.now()` | `"silent for {X}m"` |

**Signal precedence:** `fail_storm` > `loop` > `silent`. When multiple signals would fire for the same agent, only the highest-precedence one is reported.

**Idle suppression (AC8):** Agents whose current task `status` is `needs_human`, `awaiting_info`, `complete`, or `open` are excluded from all stuck checks. They are already in human hands or have no active claim.

### GET /api/stuck (AC1)

**Endpoint:** `GET /api/stuck`

**Response:** HTTP 200 with `Content-Type: application/json`:

```json
{
  "stuck": [
    {
      "agent": "agent-be",
      "signal": "fail_storm",
      "detail": "3 failed attempts",
      "since": "2026-06-23T08:00:00.000Z"
    },
    {
      "agent": "agent-fe",
      "signal": "silent",
      "detail": "silent for 15m",
      "since": "2026-06-23T08:00:00.000Z"
    }
  ]
}
```

The endpoint never returns 500. A missing or unreadable log file for one agent causes that agent to be skipped gracefully; signals for other agents are still returned (AC6).

### computeStuckSignals() — server-utils.ts

`computeStuckSignals(agents, agentsHome, ledgerDir, nowMs?)` is the pure utility underlying the endpoint:

1. **Reads the ledger** via `parseTaskLedger(ledgerDir)` to build a map of `agent → { failureCount, status }` for all currently claimed tasks.
2. **For each agent** in the `agents` list:
   - Checks AC8 idle suppression first — skips agents in terminal/waiting statuses.
   - Checks `fail_storm` — highest precedence, no JSONL read needed.
   - Reads `~/agents/{agent}/logs/live-events.jsonl` using `readFileSync` + `split("\n").slice(-20)`. Missing or unreadable file → `catch` block → `continue` to next agent (AC6).
   - Parses each of the last 20 lines with `try { JSON.parse(line) } catch { return null }` then filters nulls — one malformed line does not throw or truncate results (AC5).
   - Checks `loop`: if at least 5 valid events exist and the last 5 all share the same non-null `tool`, emits `loop`.
   - Checks `silent`: if the last valid event's `ts` is more than `STUCK_SILENT_SECONDS` (600) seconds before `nowMs`, emits `silent`.
3. Returns `StuckAgent[]` — one entry per stuck agent.

The `nowMs` parameter is injectable for deterministic test control.

### Edge-triggered SSE broadcast (AC7)

Each call to `GET /api/stuck` also runs the SSE broadcast logic in `server.ts`:

- **`prevStuckSignals`** — a module-level `Map<string, string>` (agent → last reported signal). Cleared on server restart.
- **`lastStuckBroadcast`** — a module-level `Map<string, number>` (agent → last broadcast timestamp ms). Cleared on server restart.
- A `stuck` SSE event fires for an agent only when: (1) the new signal differs from the previous signal, AND (2) at least 60 seconds have elapsed since the last broadcast for that agent.

```
event: stuck
data: {"agent":"agent-be","signal":"fail_storm","detail":"3 failed attempts"}
```

The event fires at most once per 60-second window per agent, even if the endpoint is polled more frequently. Agents that are no longer stuck are removed from `prevStuckSignals` on the next evaluation.

### AC → verification mapping (T14)

| AC | Verified by |
|---|---|
| AC1 | `describe("GET /api/stuck")` — response is HTTP 200 JSON with `stuck` array; each entry has `agent`, `signal`, `detail`, `since` string fields |
| AC2 | Test writes JSONL event 11 minutes ago; asserts `signal=silent`, `detail` contains `"11m"` |
| AC3 | Test writes 5 JSONL events with `tool: "Edit"`; asserts `signal=loop`, `detail="looping on Edit"` |
| AC4 | Test writes ledger with `failure_count=2`, `status=in_progress`; asserts `signal=fail_storm`, `detail="2 failed attempts"` |
| AC5 | Test injects `}{broken json line` before a valid old JSONL line; asserts HTTP 200, valid array, silent signal for the agent |
| AC6 | Test agent `stuck-missing` has no `live-events.jsonl`; asserts it is absent from stuck array, other agents still present, no 500 |
| AC7 | Two sequential calls to an isolated edge server; asserts broadcast fires exactly once on the first call, zero times on the second (same signal) |
| AC8 | Test writes ledger with `status=needs_human`, `failure_count=3`; asserts agent absent from stuck list |

### AC → verification mapping (T14-amended)

| AC | Verified by | Type |
|---|---|---|
| AC1 | PR review — `grep 'JSON.parse' supervisor/console/server-utils.ts` confirms all JSONL-line parsing in `readLogTail` and `computeStuckSignals` is wrapped in per-line try/catch returning null | human-verify |
| AC2 | `describe("stuck detection malformed JSONL")` — 20-line fixture with malformed lines at positions 4, 11, 17; asserts `signal=loop` (loop detected from 17 valid Bash events) | done_check |
| AC3 | Same describe block — `GET /api/stuck` returns HTTP 200 even when JSONL contains malformed lines; no 500 | done_check |
| AC4 | Same describe block — all-malformed JSONL file (`}{broken` × 5); asserts `{ stuck: [] }` HTTP 200 | done_check |
| AC5 | PR review — grep across `server.ts` and `server-utils.ts` confirms no bare `JSON.parse` call on JSONL line content (all are on full-file `readFileSync` results or request body buffers, which use separate error handling) | human-verify |

---

## Stuck alert UI (T15)

T15 wires the `GET /api/stuck` endpoint (T14) into the console frontend. When one or more agents are stuck, a red alert card appears above the Queue attention section without navigating away from the current tab. Clicking "Force restart" opens a native `<dialog>` confirm modal that POSTs to the T11 restart endpoint.

### Stuck alert slot

A `<section id="stuck-alert-slot">` is placed immediately above `section-attention` in `index.html`. It carries `aria-live="assertive"` so screen readers announce new stuck alerts and starts `hidden`. `console.js` manages visibility:

- `hidden` attribute present → card section is not shown (zero agents stuck)
- `hidden` attribute removed → section visible, contains one `<article class="stuck-alert-card">`

The slot is permanent in the DOM across all tab switches — it is not inside any tab panel.

### State

Two module-level Maps track stuck state:

| Map | Key | Value | Purpose |
|---|---|---|---|
| `stuckAgents` | agent name | `{ agent, signal, detail, since }` | Current set of stuck agents (entry present = stuck) |
| `agentLastTaskId` | agent name | task ID string | Last `task` field seen in a `fleet-update` SSE event — used for AC6 auto-dismiss comparison |

### Bootstrap and SSE

On page load, `fetchStuck()` calls `GET /api/stuck` and populates `stuckAgents` from the response array, then calls `renderStuckSection()`. `fetchStuck()` is also called in the SSE `open` handler so stuck state is refreshed on reconnect.

The `stuck` SSE event (`event: stuck`) is handled separately:

```js
es.addEventListener('stuck', (e) => {
  const ev = JSON.parse(e.data);
  if (!ev.agent) return;
  stuckAgents.set(ev.agent, { agent: ev.agent, signal: ev.signal, detail: ev.detail, since: ev.since || new Date().toISOString() });
  renderStuckSection();
});
```

`since` falls back to `new Date().toISOString()` if the SSE payload omits it (the T14 SSE payload does not include `since`; only the REST response does).

### Rendering — AC3 (one card, earliest since)

`renderStuckSection()` selects the agent with the earliest (oldest) `since` timestamp and renders exactly one card. If more than one agent is stuck, a `+N more` badge is appended to the card header where N = total stuck count − 1:

```html
<span class="stuck-more-badge" aria-label="2 more stuck agents">+2 more</span>
```

The card structure (`buildStuckCard()`):

```
<article class="stuck-alert-card card-new" id="stuck-{agentName}" aria-label="Stuck agent: {agent}">
  <div class="stuck-card-header">
    <span class="stuck-signal-dot" />   <!-- pulsing red dot -->
    <span class="stuck-agent-name">{agent}</span>
    [+N more badge if multi]
    <span class="stuck-card-spacer" />
    <span class="stuck-since">{relativeTime(since)}</span>
  </div>
  <div class="stuck-detail">{detail}</div>
  <div class="stuck-card-actions">
    <button class="btn-force-restart" data-agent="{agent}">Force restart</button>
  </div>
</article>
```

The `id="stuck-{agentName}"` attribute ensures DOM deduplication — `renderStuckSection()` replaces the container's `innerHTML` on every update.

### Auto-dismiss — AC6

The `fleet-update` SSE handler checks every incoming event against `stuckAgents`. If the update carries a new `task` value (agent moved on) or an `action` of `stop` or `restart`, `dismissStuckAgent(agent)` is called:

```js
const movedOn = ev.task != null && ev.task !== prev;
const stopped = ev.action === 'stop' || ev.action === 'restart';
if (movedOn || stopped) dismissStuckAgent(ev.agent);
```

`dismissStuckAgent()` removes the agent from `stuckAgents`, applies the `card-exit` animation (same as other card removals), then calls `renderStuckSection()` to show the next-earliest stuck agent if any remain.

### Force restart modal — AC4/AC5/AC7/AC8

The modal is a native `<dialog id="restart-modal">` element placed after the `</div>` closing tag of the page body and before `<script src="console.js">`:

```html
<dialog id="restart-modal" class="restart-modal" aria-labelledby="restart-modal-heading">
  <h2 class="restart-modal-heading" id="restart-modal-heading">Restart agent?</h2>
  <p class="restart-modal-body"></p>
  <div class="restart-modal-actions">
    <button class="btn-modal-cancel">Cancel</button>
    <button class="btn-modal-restart btn-danger">Restart agent</button>
  </div>
</dialog>
```

`initRestartModal()` (called once on page load after the script is parsed) wires up three close paths (AC7):

| Interaction | Handler |
|---|---|
| Backdrop click | `modal.addEventListener('click', e => { if (e.target === modal) modal.close(); })` |
| Cancel button | `btn-modal-cancel` click → `modal.close()` |
| Escape key | Native `<dialog>` behavior — no handler required |

`showRestartModal(agent)` populates the modal before opening it (AC4):

- Heading: `Restart {agent}?`
- Body: `Current task {task_id} will be marked failed. This cannot be undone.` — `task_id` is read from `agentLastTaskId.get(agent)` or `"current task unknown"` if not yet seen.
- Restart button label: `Restart {agent}`

On confirm (AC5), the restart button:

1. Sets `btn.textContent = 'Restarting…'` and `btn.disabled = true`
2. POSTs to `/api/fleet/restart?agent={encodeURIComponent(agent)}`
3. Calls `modal.close()` in `.finally()` regardless of fetch outcome

`<dialog>.showModal()` provides native focus trapping — tab focus cannot leave the modal while it is open (AC8 constraint satisfied automatically).

### Styles

T15 adds two new style blocks to `styles.css`:

**`.stuck-alert-card`** — red left/top accent, surface background, with `.stuck-signal-dot` (`@keyframes stuckPulse` at 1.6 s, red fill). `.stuck-more-badge` uses `color-mix(in srgb, var(--red) 15%, transparent)` for a muted red chip. `.btn-force-restart` matches the badge treatment with a 1 px red border and hover darkening.

**`.restart-modal`** — inherits surface background and border tokens; `::backdrop` is `rgba(0,0,0,0.7)`. `.btn-danger` uses the same `color-mix` red pattern as the Force restart button; `:disabled` reduces opacity to 0.5.

### AC → verification mapping (T15)

| AC | Verified by | Type |
|---|---|---|
| AC1 | `qa-smoke.sh` — `GET /api/stuck` returns 200; response body contains `"stuck"` key | e2e_check |
| AC2 | `qa-smoke.sh` — `index.html` contains `stuck-cards`; `id="stuck-alert-slot"` appears before `id="section-attention"` in DOM line order | e2e_check |
| AC3 | PR review — inject 3 stuck agents via `window.__injectStuck`; confirm single card with "+2 more" badge | human-verify |
| AC4 | PR review — click Force restart; confirm modal heading `"Restart agent-be?"`, body references task ID, Cancel + red "Restart agent-be" buttons | human-verify |
| AC5 | PR review — click Restart in modal; confirm POST fires to `/api/fleet/restart?agent=agent-be`; button shows "Restarting…" and is disabled | human-verify |
| AC6 | PR review — inject stuck then `window.__injectFleetUpdate` with new `task`; confirm card fades out | human-verify |
| AC7 | PR review — press Escape; confirm modal closes (native `<dialog>` behavior); backdrop click closes modal; Cancel closes modal | human-verify |
| AC8 | PR review — inspect DOM; confirm `<dialog>` element present (`tagName=DIALOG`), placed before `<script src="console.js">` so `initRestartModal()` finds it on parse | human-verify |

### GET /api/stuck — server.ts fix (cb261a1)

This branch also includes a one-line fix to the `GET /api/stuck` handler in `server.ts`: the `agents` argument passed to `computeStuckSignals()` was changed from `agentList` (a `string[]` from `supervisor/fleet.conf`, set up for log-watcher purposes) to `[...validAgents]` (spread from the `Set<string>` that governs request validation, sourced from `controlDir/fleet.conf` per T11-amended). Without this fix, stuck detection would check agents from the wrong fleet registry whenever a workspace switch occurred.

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
3. **Draft text div:** The drafted text is rendered in a scrollable section. The operator types or pastes a note here, which is sent via `POST /api/draft-decision` to append it to the agent's mailbox.
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
- **Event types:** `approval`, `attention`, `resolve` (queue/attention events from the server); `pipeline-update` (ledger change events, triggers a `fetchPipeline()` call when the Pipeline tab is active); `stuck` (edge-triggered alert when an agent is stuck, triggers `renderStuckSection()` to show or update the stuck alert card above the Queue attention section).
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

### Pipeline view tests — `server.test.ts` (T13 AC1/AC2/AC3/AC7 + T13-amended AC2/AC4)

Three `describe` blocks cover the T13 pipeline endpoints and the ledger watch handler, plus two additional blocks added by T13-amended that verify the SSE-only bootstrap behavior via static analysis of `console.js`:

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

**`describe("T13-amended AC2: console.js pipeline bootstrap guard")`** — Three static-analysis tests against the `console.js` source text (no live server needed):

| Test | AC | What it asserts |
|---|---|---|
| `pipelineBootstrapped guard variable is present in console.js` | AC2 | Source contains the identifier `pipelineBootstrapped` |
| `fetchPipeline in switchTab is conditional on pipelineBootstrapped` | AC2 | First 1000 chars of `switchTab` body contain both `pipelineBootstrapped` and `fetchPipeline()` |
| `no setInterval or setTimeout polls /api/pipeline` | AC1 | Regexes `/setInterval\b[^;]*pipeline/i` and `/setTimeout\b[^;]*fetchPipeline/i` both return false |

**`describe("T13-amended AC4: SSE open handler calls fetchPipeline on reconnect")`** — One static-analysis test:

| Test | AC | What it asserts |
|---|---|---|
| `fetchPipeline is called inside the SSE open event handler` | AC4 | Slices the `addEventListener('open'` handler body from source and asserts it contains `fetchPipeline()` |

### Fleet control tests — `server.test.ts` (T11 AC1–AC8)

T11 adds 25 new tests across 8 describe blocks. A shared `fleetServer` (port 7849) is created with injectable `killFn`, `isAliveFn`, `spawnFn`, and `broadcastFn` so all fleet control logic can be exercised without sending real OS signals or spawning real processes. One pid file is pre-written: `agent-be.pid` = `12345`. `agent-qa` has no pid file (used for 404 tests).

**`describe("stopProcess (AC1)")`** — 3 tests against the exported utility directly:

| Test | AC | What it asserts |
|---|---|---|
| `sends SIGTERM first, then SIGKILL after timeout when process stays alive` | AC1 | `isAliveFn` always returns true; asserts `SIGTERM` before `SIGKILL` in signal order |
| `sends SIGTERM and resolves without SIGKILL when process dies after SIGTERM` | AC1 | `isAliveFn` flips false on SIGTERM; asserts SIGTERM present, SIGKILL absent |
| `returns immediately without sending any signal when process is already dead (AC6/AC8)` | AC6/AC8 | `isAliveFn` always false; asserts zero signals sent |

**`describe("fleet control unknown agent → 400 (AC5)")`** — 5 tests:

| Test | AC | What it asserts |
|---|---|---|
| `POST /api/fleet/stop returns 400 for unknown agent` | AC5 | `agent=unknown-agent` → HTTP 400 with error body |
| `POST /api/fleet/restart returns 400 for unknown agent` | AC5 | Same for restart |
| `POST /api/fleet/pause returns 400 for unknown agent` | AC5 | Same for pause |
| `POST /api/fleet/resume returns 400 for unknown agent` | AC5 | Same for resume |
| `POST /api/fleet/stop returns 400 when agent query param is missing` | AC5 | Missing `?agent=` → HTTP 400 |

**`describe("POST /api/fleet/stop (AC1/AC6/AC8)")`** — 4 tests via HTTP:

| Test | AC | What it asserts |
|---|---|---|
| `returns 200 { ok: true } when process is dead (stale PID / AC6 / AC8)` | AC6/AC8 | `isAliveFn = () => false`; 200, no signals sent |
| `returns 200 { ok: true } and sends SIGTERM when process is alive` | AC1 | `isAliveFn` flips false on kill; 200, SIGTERM sent to PID 12345 |
| `returns 404 when pid file does not exist` | AC1 | `agent=agent-qa` (no pid file) → HTTP 404 |
| `is idempotent — second call when process is dead also returns 200 (AC8)` | AC8 | Two consecutive stop calls both return 200 |

**`describe("POST /api/fleet/restart (AC2)")`** — 2 tests:

| Test | AC | What it asserts |
|---|---|---|
| `stops the agent then spawns run-agent.sh with the agent name` | AC2 | SIGTERM sent, then `spawnFn` called once with `agentName = "agent-be"` and script path containing `run-agent.sh` |
| `spawns run-agent.sh even when process was already dead` | AC2 | `isAliveFn = () => false`; stop is a no-op but spawn still fires |

**`describe("POST /api/fleet/pause (AC3/AC6)")`** — 2 tests:

| Test | AC | What it asserts |
|---|---|---|
| `sends SIGSTOP to the agent's PID when process is alive (AC3)` | AC3 | `isAliveFn = () => true`; exactly one kill call with `{ pid: 12345, signal: "SIGSTOP" }` |
| `returns 409 { error: 'process not running' } when process is not alive (AC6)` | AC6 | `isAliveFn = () => false` → HTTP 409, error body |

**`describe("POST /api/fleet/resume (AC4/AC6)")`** — 2 tests:

| Test | AC | What it asserts |
|---|---|---|
| `sends SIGCONT to the agent's PID when process is alive (AC4)` | AC4 | `isAliveFn = () => true`; exactly one kill call with `{ pid: 12345, signal: "SIGCONT" }` |
| `returns 409 { error: 'process not running' } when process is not alive (AC6)` | AC6 | `isAliveFn = () => false` → HTTP 409, error body |

**`describe("fleet-update SSE broadcast (AC7)")`** — 3 tests:

| Test | AC | What it asserts |
|---|---|---|
| `broadcasts fleet-update event after stop` | AC7 | After stop call, `broadcastFn` called once; frame contains `event: fleet-update`; payload `{ type: "fleet-update", agent: "agent-be", action: "stop", ts: number }` |
| `broadcasts fleet-update event after restart` | AC7 | After restart call, broadcast fires with `action: "restart"` |
| `does NOT broadcast fleet-update after pause (AC7 scope: stop/restart only)` | AC7 | After pause call, `broadcastFn` call count is zero |

**`describe("readPidFile")`** — 4 unit tests:

| Test | What it asserts |
|---|---|
| `returns the numeric PID when the file contains a valid integer` | File containing `"42\n"` → returns `42` |
| `returns null when the file does not exist` | Non-existent path → `null` |
| `returns null for non-numeric content` | File containing `"not-a-pid\n"` → `null` |
| `returns null for zero or negative PID` | File containing `"0\n"` → `null` |

### T11-amended tests — validAgents from fleet.conf (AC2/AC3/AC4)

T11-amended adds 7 new tests across 3 describe blocks. Each block uses a `makeFleetConfHandler` factory that mirrors the `server.ts` T11-amended implementation: `validAgents` is sourced from `controlDir/fleet.conf` and can be rebuilt via `POST /api/workspace-switch`. Three isolated HTTP servers are used (ports 7850–7852) so no state bleeds between blocks.

**`describe("missing fleet.conf — validAgents empty (AC2)")`** — port 7850, 2 tests:

| Test | AC | What it asserts |
|---|---|---|
| `known agent returns 400 when fleet.conf is absent (no fallback list)` | AC2 | No fleet.conf in control dir; POST to `/api/mailbox/agent-be` → 400 |
| `all four standard agents return 400 when fleet.conf is absent` | AC2 | Each of agent-be/qa/fe/doc → 400; confirms no hardcoded fallback exists |

**`describe("workspace switch validAgents (AC3)")`** — port 7851, 3 tests:

| Test | AC | What it asserts |
|---|---|---|
| `workspace A agents are valid before switch` | AC3 | Workspace A fleet.conf lists agent-be/agent-qa; agent-be → 200, agent-fe → 400 |
| `after workspace switch validAgents reflects new workspace fleet.conf` | AC3 | POST `/api/workspace-switch` with workspace B dir (agent-fe/agent-doc); agent-fe → 200, agent-be → 400; response body includes new agent list |
| `switch to workspace with absent fleet.conf empties validAgents` | AC3 | Switch to dir with no fleet.conf; response `agents` array is empty; agent-fe → 400 |

**`describe("GET /api/fleet reflects validAgents from fleet.conf (AC4)")`** — port 7852, 2 tests:

| Test | AC | What it asserts |
|---|---|---|
| `GET /api/fleet returns only agents present in validAgents set` | AC4 | Fleet.conf lists agent-be + agent-qa only; response length 2; agent-fe and agent-doc absent |
| `GET /api/fleet returns empty array when validAgents is empty` | AC4 | Switch to workspace with no fleet.conf; GET `/api/fleet` → `[]` |

### Stuck detection tests — `server.test.ts` (T14 AC1–AC8)

T14 adds 8 new tests in one `describe` block. Two isolated HTTP servers are created: a shared `stuckServer` (port 7851) hosting six synthetic agents that cover all signal types, and a dedicated `stuckEdgeServer` (port 7852) with fresh module-level state to verify edge-triggered SSE without interference from other tests. A `makeStuckHandler` factory mirrors the `server.ts` implementation with injectable `broadcastCooldownMs` so the 60-second cooldown can be bypassed in tests.

**Test fixtures** written in `beforeAll`:

| Agent | What is set up |
|---|---|
| `stuck-silent` | JSONL with one event 11 minutes ago |
| `stuck-loop` | JSONL with 5 consecutive `tool: "Edit"` events (recent ts) |
| `stuck-fail` | Ledger entry: `failure_count=2`, `status=in_progress`; recent JSONL |
| `stuck-malformed` | JSONL: `}{broken json line` then one valid event 15 minutes ago |
| `stuck-missing` | Log directory exists but no `live-events.jsonl` file |
| `stuck-suppressed` | Ledger: `status=needs_human`, `failure_count=3`; recent JSONL |

**`describe("GET /api/stuck")`** — 8 tests:

| Test | AC | What it asserts |
|---|---|---|
| `AC1: returns { stuck: StuckAgent[] } with correct shape` | AC1 | HTTP 200; `body.stuck` is an array; `stuck-silent` entry has `agent`, `signal`, `detail`, `since` as strings; `since` is a valid date |
| `AC2: silent detection — ts 11 minutes ago, signal=silent, detail contains '11m'` | AC2 | `stuck-silent` entry: `signal="silent"`, `detail` contains `"11m"` |
| `AC3: loop detection — 5 events with tool='Edit', signal=loop, detail='looping on Edit'` | AC3 | `stuck-loop` entry: `signal="loop"`, `detail="looping on Edit"` |
| `AC4: fail_storm — failure_count=2 and status=in_progress, signal=fail_storm` | AC4 | `stuck-fail` entry: `signal="fail_storm"`, `detail="2 failed attempts"` |
| `AC5: malformed JSONL line skipped — returns 200 with valid array, not 500` | AC5 | HTTP 200; `stuck-malformed` entry present (bad line skipped, valid old ts → silent) |
| `AC6: missing log file — agent skipped gracefully, others still returned, no 500` | AC6 | HTTP 200; `stuck-missing` absent; `stuck-silent` still present |
| `AC7: edge-triggered SSE — broadcasts once for new signal, suppresses same signal on re-evaluation` | AC7 | First call: exactly 1 broadcast for `stuck-edge`, `event: stuck`, payload has `agent="stuck-edge"` and `signal="silent"`; second call (same signal): 0 broadcasts |
| `AC8: agent with needs_human status not reported as stuck` | AC8 | `stuck-suppressed` absent from stuck array despite `failure_count=3` |

### Malformed JSONL resilience tests — `server.test.ts` (T14-amended AC2–AC4)

T14-amended adds a `describe("stuck detection malformed JSONL")` block with 3 tests across two isolated HTTP servers:

- **Port 7853** (`malformedMixedServer`): serves a 20-line `live-events.jsonl` with malformed lines at positions 4, 11, and 17 (0-indexed). The remaining 17 lines are valid `Bash` events with recent timestamps.
- **Port 7854** (`malformedAllServer`): serves a 5-line `live-events.jsonl` where every line is `}{broken`.

| Test | AC | What it asserts |
|---|---|---|
| `AC2: 20-line file with 3 malformed lines — signals computed from 17 valid lines` | AC2 | `GET /api/stuck` returns HTTP 200; `malformed-mixed` agent entry present with `signal="loop"` (17 valid Bash events → last 5 identical tools → loop detected) |
| `AC3: malformed JSONL lines do not cause a 500 — endpoint always returns 200` | AC3 | `GET /api/stuck` against the mixed-malformed server returns HTTP 200, not 500 |
| `AC4: all-malformed JSONL file → { stuck: [] } with HTTP 200` | AC4 | `GET /api/stuck` against the all-malformed server returns HTTP 200; `body.stuck` has length 0 (no valid events to compute signals from) |

### Force restart --role human tests — server.test.ts (T15-amended AC1–AC5)

T15-amended adds a `describe("fleet/restart role human (T15-amended)")` block with 3 tests on a dedicated HTTP server (port 7870). The `makeFleetControlHandler` factory gains two optional injectable parameters: `ledgerDir` (path to a temp ledger directory) and `taskFailFn((argv: string[]) => number)` (mocks the `kernel/task fail` subprocess and records the argv it was called with).

| Test | AC | What it asserts |
|---|---|---|
| `AC1/AC5: calls kernel/task fail with --role human argv when agent has a claimed task` | AC1/AC5 | POST `/api/fleet/restart?agent=agent-be`; `TASK-001.task` has `claimed_by: agent-be`; `taskFailFn` receives `["fail", "TASK-001", "--agent", "agent-be", "--role", "human"]`; response 200; `spawnCalls` contains `"agent-be"` |
| `AC3: returns 500 when kernel/task fail exits non-zero and does not restart` | AC3 | `taskFailFn` returns exit code 1; response 500 `{ error: "kernel/task fail exited with code 1" }`; `spawnCalls` is empty (agent not restarted) |
| `AC4: skips kernel/task fail and restarts when agent has no claimed task` | AC4 | `TASK-003.task` is claimed by `agent-qa`, not `agent-be`; `taskFailFn` is not called; response 200; `spawnCalls` contains `"agent-be"` |

Each test writes its own temp ledger file and cleans up with `unlinkSync`. Module-level `t15aTaskFailCalls`, `t15aSpawnCalls`, and `t15aMockTaskFailCode` are reset before each test case to prevent cross-test contamination.

### T16 test expansion — `server.test.ts` (T16 AC1–AC4 + T16-amended AC1–AC4)

T16 adds 4 describe blocks (T16 section) and 4 more (T16-amended section) — 8 new server tests in total, each in its own isolated describe block so they are individually findable by `git bisect`. All are appended after the existing test suite; no existing describe blocks were modified.

**T16 AC1 — `describe("fleet/stop stale PID")`** (1 test, reuses port 7849 fleet server):

| Test | AC | What it asserts |
|---|---|---|
| `PID file exists but process does not exist (ESRCH) → 200 { ok: true }` | AC1 | `mockIsAlive = () => false` (simulates `process.kill(pid, 0)` throwing ESRCH); POST `/api/fleet/stop?agent=agent-be` → HTTP 200, `{ ok: true }`; `fleetKillCalls` has length 0 (no signal sent to a non-running process) |

**T16 AC2 — `describe("stuck 4-event loop")`** (1 test, pure unit):

| Test | AC | What it asserts |
|---|---|---|
| `exactly 4 matching tool events does NOT trigger loop signal (threshold is 5)` | AC2 | `computeStuckSignals` called with a JSONL file containing exactly 4 consecutive `Bash` events; result must NOT contain a `loop` signal for `agent-4evt` (threshold is 5) |

**T16 AC3 — `describe("stuck precedence")`** (1 test, pure unit):

| Test | AC | What it asserts |
|---|---|---|
| `fail_storm signal returned when both fail_storm and loop conditions are met` | AC3 | Ledger has `failure_count=2, status=in_progress` (fail_storm met) AND JSONL has 5 identical `Bash` events (loop met); `computeStuckSignals` returns a single entry with `signal="fail_storm"` for `agent-prec` — precedence rule confirmed (`fail_storm` checks before `loop` and uses `continue`) |

**T16 AC4 — `describe("log n=0")`** (1 test, own server port 7860):

| Test | AC | What it asserts |
|---|---|---|
| `?n=0 returns 400 { error: 'n must be 1-200' } (boundary below minimum)` | AC4 | `makeLogHandler` wired on port 7860; GET `/api/log/agent-be?n=0` → HTTP 400, `{ error: "n must be 1-200" }` |

---

**T16-amended AC1 — `describe("POST /api/fleet/stop stale PID")`** (1 test, own server port 7857):

Uses `defaultIsProcessAlive` (the real `process.kill(pid, 0)` liveness check) and `defaultKillFn` (the real signal sender). PID file is written with `2147483647` (max signed 32-bit int — guaranteed not to exist).

| Test | AC | What it asserts |
|---|---|---|
| `PID file exists but process.kill(pid, 0) throws ESRCH → stop returns 200 { ok: true }` | AC1 | POST `/api/fleet/stop?agent=agent-be` → HTTP 200, `{ ok: true }` |

**T16-amended AC2 — `describe("GET /api/stuck 4-event loop")`** (1 test, pure unit):

| Test | AC | What it asserts |
|---|---|---|
| `4 consecutive same-tool events does NOT produce loop signal (threshold is 5)` | AC2 | 4 `Edit` events in JSONL; no `loop` entry for `agent-4loop` in `computeStuckSignals` result |

**T16-amended AC3 — `describe("GET /api/stuck precedence")`** (1 test, pure unit):

| Test | AC | What it asserts |
|---|---|---|
| `fail_storm takes precedence over loop when both conditions are met` | AC3 | Ledger task `PREC-1` has `failure_count=2, status=in_progress` (fail_storm); JSONL has 5 `Edit` events (loop); `computeStuckSignals` entry for `agent-prec` has `signal="fail_storm"` |

**T16-amended AC4 — `describe("GET /api/log n=0")`** (1 test, own server port 7858):

| Test | AC | What it asserts |
|---|---|---|
| `?n=0 returns 400 { error: 'n must be 1-200' } (boundary case)` | AC4 | Separate `makeLogHandler` on port 7858 (independent lifecycle from T16 AC4's port 7860); GET `?n=0` → HTTP 400, `{ error: "n must be 1-200" }` |

### Draft-decision tests — server.test.ts (T5 AC1–AC7)

T5 adds a `describe("POST /api/draft-decision")` block with 7 tests across two isolated HTTP servers:

- **Port 7855** (`draftServer`): uses `draftTestDir` as `controlDir`, `draftValidAgents` Set (`agent-be`, `agent-qa`, `agent-fe`, `agent-doc`), and `mockGit` (captures args, optionally throws). Mailbox files are created in `draftMailboxDir = join(draftTestDir, "mailboxes")`.
- **Port 7856** (`draftNoCtrlServer`): uses empty string as `controlDir` to exercise the 503 path without touching the filesystem.

| Test | AC | What it asserts |
|---|---|---|
| `AC1: appends correct mailbox block to {controlDir}/mailboxes/{agentName}.md` | AC1 | POST returns 200; `agent-be.md` contains `## from: human \| {ISO ts} \| re: T5` followed by `looks good` |
| `AC2: calls gitCommitAndPush with correct commit message on success` | AC2 | POST returns `{ ok: true }`; `capturedGitArgs.msg === "console: note for agent-qa re CONS-123"`; `capturedGitArgs.dir === draftTestDir` |
| `AC3: unknown agentName → 400 { error: 'unknown agent' }` | AC3 | `agentName: "agent-unknown"` → HTTP 400, body `{ error: "unknown agent" }` |
| `AC4: taskId failing TASK_ID_RE → 400 { error: 'invalid taskId' }` | AC4 | `taskId: "invalid"` → HTTP 400, body `{ error: "invalid taskId" }` |
| `AC5: empty text → 400 { error: 'text required' }` | AC5 | `text: ""` → HTTP 400, body `{ error: "text required" }` |
| `AC6: gitCommitAndPush throws → 500 { error: 'git push failed' }` | AC6 | `gitShouldFail = true` → HTTP 500, body `{ error: "git push failed" }` |
| `AC7: CONTROL_DIR not set → 503 { error: 'control dir not configured' }` | AC7 | Request to port 7856 (empty `controlDir`) → HTTP 503, body `{ error: "control dir not configured" }` |

The test infrastructure uses a `makeDraftDecisionHandler` factory (mirrors `handleDraftDecision` in `server.ts`) with injectable `controlDir`, `validAgents`, and `gitFn` to avoid side-effects on the real control repo. `capturedGitArgs` and `gitShouldFail` are module-level mutable state reset per test. Temp directory and both servers are torn down in `afterAll`.

### BUG-2 regression guard — server.test.ts

BUG-2 adds one static-analysis test that prevents the `agentList` ReferenceError from being silently reintroduced by a future merge conflict. The bug arose because T14 introduced `computeStuckSignals(agentList, ...)` using the pre-T11-amended variable name, while T11-amended had already renamed `agentList` to `supervisorAgentList`. The server crash was already fixed in main; this test locks the fix.

**`describe("BUG-2: GET /api/stuck agentList regression guard")`** — 1 test:

| Test | What it asserts |
|---|---|
| `server.ts passes validAgents (not agentList) to computeStuckSignals` | Reads `server.ts` source with `readFileSync` and asserts `/computeStuckSignals\s*\(\s*agentList\b/` does not match. Any merge conflict that reintroduces the wrong variable name fails this test immediately, before the server even boots. |

### Test results

All 131 tests pass (2 bash-wrapper + 129 server tests). Run the full suite with:

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
9. Asserts `GET /api/stuck` returns HTTP 200 with a `"stuck"` key in the response body (T15 AC1)
10. Asserts `index.html` contains a `stuck-cards` container element (T15 AC1/AC2)
11. Asserts `id="stuck-alert-slot"` appears before `id="section-attention"` in the HTML source (T15 AC2 — slot is above the Queue attention section)
12. Asserts `GET /api/pipeline` returns HTTP 200 with `content-type: application/json` (T16 AC6)
13. Asserts `GET /api/stuck` returns HTTP 200 with `content-type: application/json` (T16 AC6)
14. Asserts `GET /api/log/smoke-test-agent` returns HTTP 200 with `content-type: application/json` (T16 AC6)
15. Asserts `POST /api/fleet/stop?agent=smoke-test-agent` (mock PID 99999 — non-running) returns `{ ok: true }` (T16 AC7)
16. Captures a timestamped screenshot to `/tmp/console-qa-<timestamp>.png`
17. Prints the screenshot path to stdout so the QA agent can attach it to its report

Items 12–14 use a `check_json` helper that calls `curl -D -` to capture response headers inline and checks both HTTP status and `Content-Type: application/json`. Items 14–15 require `CONTROL_DIR` to be set so `validAgents` is populated — the script creates a temporary `CONTROL_DIR` with a single-line `fleet.conf` listing `smoke-test-agent`, and writes a mock PID file at `supervisor/pids/smoke-test-agent.pid` containing `99999`. Both are cleaned up by the `EXIT` trap.

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

## Pipeline view — GET /api/pipeline + GET /api/spec/:taskId (T13 / T13-amended)

The Pipeline tab gives directors a single-screen answer to "how much work is left?" by reading every task in the ledger and grouping them by status. The view is SSE-only: on first tab activation `GET /api/pipeline` is called once to bootstrap the view, and every subsequent `.task` file change in the ledger triggers a `pipeline-update` SSE event that refreshes the tab automatically. There is no polling fallback — the SSE reconnect path handles connection drops by calling `GET /api/pipeline` again on reconnect.

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

The browser listens for `pipeline-update` events and calls `fetchPipeline()` only when the Pipeline tab is currently active. Inactive tabs do not fetch. There is no polling fallback for the pipeline view — connection drops are handled by the SSE reconnect path (see below).

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

### SSE-only bootstrap and reconnect guard (T13-amended AC2/AC3/AC4)

T13-amended removes the original polling fallback from the pipeline view and introduces a one-shot bootstrap guard:

**`pipelineBootstrapped` flag (AC2):** A module-level boolean in `console.js`. When the Pipeline tab is activated for the first time in a session, `switchTab('pipeline')` checks the flag: if `false`, it calls `fetchPipeline()` and sets the flag to `true`. Subsequent tab switches do not re-fetch. This prevents redundant initial loads while still ensuring the first activation always gets fresh data.

**SSE reconnect behavior (AC4):** The `EventSource` `open` event handler (which fires on initial connect and on every reconnect after a drop) calls `fetchPipeline()` and sets `pipelineBootstrapped = true`. This ensures the pipeline data is refreshed exactly once per reconnect. The flag is reset implicitly by the reconnect re-setting it to `true` on open — the subsequent tab switch guard then correctly skips the second fetch.

**No polling fallback (AC3):** When the SSE connection drops, the console shows the existing "Reconnecting…" banner (the shared SSE status dot in the header). The pipeline view does not start polling `GET /api/pipeline` on connection loss. The banner dismisses and data refreshes when SSE reconnects.

**Bug fix — SSE listeners on `es` (not `currentEs`):** Prior to T13-amended, all six `EventSource.addEventListener` calls inside `connect()` were attached to `currentEs` (which was `null` at call time) instead of `es` (the newly created `EventSource`). T13-amended corrects all six listeners (`open`, `approval`, `attention`, `resolve`, `fleet-update`, `error`) and the paired `currentEs.close()` call to use `es`.

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

---

## Adding agents for a second project when Project A is already installed

Existing launchd services for Project A are **not affected** — each service is keyed off the agent name, so new agents with different names install independently alongside existing ones.

### Steps

**1. Create config files for the new project's agents:**

```bash
mkdir -p ~/agents/proj-b-fe
cat > ~/agents/proj-b-fe/config <<EOF
CONTROL_REPO_URL=git@github.com:your-org/project-b-control.git
WORK_REPO_URL=git@github.com:your-org/project-b-frontend.git
AGENT_DOMAIN=fe
EOF

mkdir -p ~/agents/proj-b-be
cat > ~/agents/proj-b-be/config <<EOF
CONTROL_REPO_URL=git@github.com:your-org/project-b-control.git
WORK_REPO_URL=git@github.com:your-org/project-b-backend.git
AGENT_DOMAIN=be
EOF

# Add qa and doc agents similarly, leaving WORK_REPO_URL empty if they only commit to the control repo
```

**2. Add the new agents to `supervisor/fleet.conf`** (existing Project A lines stay untouched):

```
# Project A — already installed, leave these alone
agent-be    FEATURE_ROLE.md    claude-sonnet-4-6
agent-fe    FEATURE_ROLE.md    claude-sonnet-4-6
agent-qa    QA_ROLE.md         claude-haiku-4-5
agent-doc   DOC_ROLE.md        claude-haiku-4-6

# Project B — new agents
proj-b-fe   FEATURE_ROLE.md    claude-sonnet-4-6
proj-b-be   FEATURE_ROLE.md    claude-sonnet-4-6
proj-b-qa   QA_ROLE.md         claude-haiku-4-5
proj-b-doc  DOC_ROLE.md        claude-haiku-4-6
```

**3. Install only the new agents (macOS launchd):**

```bash
cd supervisor
./install.sh proj-b-fe  FEATURE_ROLE.md  claude-sonnet-4-6
./install.sh proj-b-be  FEATURE_ROLE.md  claude-sonnet-4-6
./install.sh proj-b-qa  QA_ROLE.md       claude-haiku-4-5
./install.sh proj-b-doc DOC_ROLE.md      claude-haiku-4-6
```

Do **not** re-run `./install.sh` for Project A agents — they are already running as services and don't need to be reinstalled.

**4. Verify all agents are running:**

```bash
./fleet.sh status
```

You should see both Project A and Project B agents listed, each showing `service running`.

### Key rule

Agent names must be unique across all projects on the same machine. Prefixing with the project name (`proj-a-`, `proj-b-`, `cms-`) prevents collisions in config files, log directories, and launchd service labels.
