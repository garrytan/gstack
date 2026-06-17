---
name: setup-fleet
version: 1.0.0
description: "Interactive wizard that provisions a cstack autonomous agent fleet on this workstation: creates ~/agents/*/config, sets up QA credentials, and runs fleet.sh install. (cstack)"
triggers:
  - setup fleet
  - install fleet
  - setup agents
  - provision agents
  - new workstation setup
  - fleet setup
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
---

# /setup-fleet — cstack Fleet Setup Wizard

You are setting up a cstack autonomous agent fleet on this workstation.
Your job is to ask the minimum questions needed, then do all the work.
Never ask for something you can discover yourself.

## Step 1 — Discover existing state

Run all of these first. Read the results before asking any questions.

```bash
# Find fleet.conf relative to this repo
FLEET_CONF="$(git rev-parse --show-toplevel 2>/dev/null)/supervisor/fleet.conf"
[ -f "$FLEET_CONF" ] && cat "$FLEET_CONF" || echo "FLEET_CONF_NOT_FOUND"
```

```bash
# Check which agent configs already exist
ls ~/agents/*/config 2>/dev/null && echo "---existing---" || echo "NO_EXISTING_CONFIGS"
```

```bash
# Check which agent dirs exist at all
ls ~/agents/ 2>/dev/null || echo "NO_AGENTS_DIR"
```

```bash
# Check for ANTHROPIC_API_KEY
[ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_KEY: set" || echo "ANTHROPIC_KEY: missing"
```

```bash
# Check for existing QA secrets (prefix unknown yet — check any)
ls ~/.cstack-secrets/ 2>/dev/null || echo "NO_SECRETS_DIR"
```

Parse fleet.conf to get the agent list. Each non-comment, non-blank line is:
`<agent-name>  <role-file>  [model]`

From the role file name, infer the agent's role category:
- `FEATURE_ROLE.md` → feature agent (needs `WORK_REPO_URL`)
- `QA_ROLE.md` → qa agent (no work repo, needs `SECRET_PREFIX` + `QA_BASE_URL`)
- `DOC_ROLE.md` → doc agent (needs `WORK_REPO_URL` for docs)

Determine which agents are already fully configured (config file exists and is
non-empty) vs. which still need setup. Only ask about the ones that need work.

If ALL agents are already configured: tell the user and ask if they want to
re-run install anyway or update a specific config. Do not silently overwrite.

---

## Step 2 — Collect engagement info (one question, not per-agent)

All agents in a fleet share the same control repo and the same engagement slug.
Use AskUserQuestion only for what you cannot discover.

Ask this as a single form-style question covering what's missing. Typical first-run needs:
1. Engagement slug (short name for this project, e.g. `dsti` — used to namespace QA secrets)
2. Control repo URL (git URL, same for all agents)

Then, for each feature/doc agent whose `WORK_REPO_URL` is unknown, ask for the repo URL.
Group them into one question if there are multiple (e.g. "BE work repo, FE work repo").

**Never ask for things you already know:**
- If a config already has the control repo URL, reuse it for other agents.
- If the engagement slug is in an existing config's `SECRET_PREFIX`, reuse it.
- If there is only one feature agent, its domain is obvious from the role file or agent name
  (agent-be → `be`, agent-fe → `fe`, agent-full → `full`).

For QA base URL: default to `http://localhost:3000`. Only ask if the user seems
to be targeting a different host (e.g., they mentioned a staging URL earlier).

**Domain inference rules** (from agent name, when unambiguous):
- `agent-be` or `agent-backend` → `AGENT_DOMAIN=be`
- `agent-fe` or `agent-frontend` → `AGENT_DOMAIN=fe`
- `agent-qa` → `AGENT_DOMAIN=qa`
- `agent-doc` → `AGENT_DOMAIN=doc`
- `agent-full` → `AGENT_DOMAIN=full`
- Ambiguous → ask

**Read repos inference**: QA and doc agents typically need read-only access to
all work repos. Infer `READ_REPOS` as the union of all feature agents' `WORK_REPO_URL`
values. Only ask if there is genuine ambiguity.

---

## Step 3 — Write config files

For each agent that needs a config, create the directory and write the file.

Config file format — write exactly these keys, one per line, no extra whitespace:

**Feature agent** (`FEATURE_ROLE.md`):
```
AGENT_DOMAIN=<be|fe|full>
CONTROL_REPO_URL=<git-url>
WORK_REPO_URL=<git-url>
READ_REPOS="<space-separated git urls of other work repos>"
```

**QA agent** (`QA_ROLE.md`):
```
AGENT_DOMAIN=qa
CONTROL_REPO_URL=<git-url>
WORK_REPO_URL=
READ_REPOS="<space-separated git urls of all work repos>"
SECRET_PREFIX=<engagement-slug>
QA_BASE_URL=<url>
```

**Doc agent** (`DOC_ROLE.md`):
```
AGENT_DOMAIN=doc
CONTROL_REPO_URL=<git-url>
WORK_REPO_URL=<git-url>
READ_REPOS="<space-separated git urls of other work repos>"
```

After writing each file, set permissions:
```bash
chmod 600 ~/agents/<agent-name>/config
```

If a config already exists: read it, merge in any new/missing keys, do not
erase keys that are already correct. Tell the user what changed.

---

## Step 4 — Check ANTHROPIC_API_KEY

If `ANTHROPIC_KEY: missing` was echoed in Step 1, stop here and tell the user:

> `ANTHROPIC_API_KEY` is not set in this shell. Add it to `~/.zshrc` (or `~/.bashrc`):
> ```
> export ANTHROPIC_API_KEY=sk-ant-...
> ```
> Then run `source ~/.zshrc` and re-run `/setup-fleet`.

Do not proceed to install without this key — the agents will fail immediately
and burn the circuit breaker.

---

## Step 5 — QA credentials

Only if the fleet includes a QA agent.

Check if credentials already exist:
```bash
SECRET_PREFIX=<from config>
ls ~/.cstack-secrets/${SECRET_PREFIX}-qa 2>/dev/null \
  && echo "MAIN_CRED: exists" || echo "MAIN_CRED: missing"
```

Also check for actor credentials. Read `qa/actors.json` from the QA agent's
READ_REPOS to find declared roles. If you cannot find `actors.json`, ask the
user what application roles exist for this project.

For each missing credential file, collect credentials via AskUserQuestion.
**Never collect credentials via Bash `read` or echo** — use AskUserQuestion
with the `password` input type so they are masked.

Ask in this format:
> "QA credentials for `<prefix>-qa` (main test account)"
> - Username (email):
> - Password:

Then write the file:
```bash
mkdir -p ~/.cstack-secrets && chmod 700 ~/.cstack-secrets
# Write username on line 1, password on line 2 — NO echo, NO shell expansion
python3 -c "
import sys, os
path = os.path.expanduser('~/.cstack-secrets/<prefix>-<role>')
with open(path, 'w') as f:
    f.write(sys.argv[1] + '\n' + sys.argv[2] + '\n')
os.chmod(path, 0o600)
" "<username>" "<password>"
```

**Security rules:**
- NEVER echo credential values to stdout
- NEVER interpolate credentials into Bash strings that appear in shell history
- NEVER commit credential files
- Use the Python write pattern above to avoid shell expansion and history

After writing, verify:
```bash
wc -l ~/.cstack-secrets/${SECRET_PREFIX}-qa  # should print "2"
stat -f "%Mp%Lp" ~/.cstack-secrets/${SECRET_PREFIX}-qa  # should print "0600"
```

---

## Step 6 — Run fleet.sh install

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
bash "$REPO_ROOT/supervisor/fleet.sh" install
```

If it fails, read the error carefully:
- `Missing config: ~/agents/<name>/config` → config write in Step 3 failed; re-check
- `run-agent.sh not found` → wrong working directory; use the absolute path above
- `launchctl` / `systemd` errors → surface the full error, do not retry blindly

---

## Step 7 — Verify and report

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
bash "$REPO_ROOT/supervisor/fleet.sh" status
```

Report the result in a clean table:

| Agent | Role | Domain | Config | Service | Status |
|-------|------|--------|--------|---------|--------|
| agent-be | FEATURE | be | ✓ | ✓ installed | — |
| agent-qa | QA | qa | ✓ | ✓ installed | — |
| ... | | | | | |

Then give the user the three commands they will use most:

```bash
# Start all agents (if not already running as services)
bash supervisor/fleet.sh start

# Watch live activity
bash supervisor/fleet.sh watch

# Check status
bash supervisor/fleet.sh status
```

If any agent is missing a credential or config item, list it explicitly as
"ACTION NEEDED" with the exact step to fix it.

---

## Hard rules

- NEVER print, log, or commit secrets (`QA_USER`, `QA_PASS`, any credential value)
- NEVER overwrite a config that already has correct values without asking
- NEVER proceed past Step 4 if `ANTHROPIC_API_KEY` is missing
- NEVER force-push; never modify the control repo ledger
