# Team Server Mode — running a fleet of gstack agents on one shared machine

gstack's default model is one human, one laptop, one session at a time. Team mode
(`gstack-team-init`) already solves "many humans, many laptops, one repo." This
document describes the third topology, which is becoming the common one: **many
concurrent AI agents sharing a single server** — a cloud devbox, a Codespace, a
CI runner pool, or an always-on build machine where several Claude Code (or
Codex/OpenClaw) sessions work the same checkout simultaneously.

This is a pattern doc: everything here works with gstack as shipped today. It
was extracted from a production deployment (Skoor, skoor.ai) that runs multiple
concurrent agents against one shared workspace around the clock, and it is
written so a future `gstack-server-init` could automate it.

## What breaks without it

Running N agents as the same OS user on one machine collides on four kinds of
shared state:

| Shared state | Failure mode |
|---|---|
| The git checkout | Agent A switches branches mid-task; agent B's in-flight edits now sit on the wrong branch. `git add -A` by one agent commits another agent's half-finished work. |
| `~/.gstack/` (sessions, learnings, config) | Sessions are keyed by `$PPID`, which is unique per process but anonymous — nothing attributes a checkpoint commit, timeline event, or learning to a specific agent. Two agents appending to `learnings.jsonl` interleave safely (appends are atomic) but their lessons are indistinguishable. |
| Ship/land pipelines | Two agents run `/ship` or `/land-and-deploy` on the same repo at the same time: races on version bump, CHANGELOG, and merge order. |
| Credentials | One shared token in the remote URL or env means no per-agent blast radius and no audit trail of who pushed what. |

## The pattern — seven rules

### 1. Every agent has an identity

Give each session a stable agent id and thread it through everything the agent
writes:

```bash
export GSTACK_AGENT_ID="qa-bot-2"     # set by whatever spawns the session
```

Use it in checkpoint commit trailers (`[gstack-agent: qa-bot-2]`), timeline log
entries, and learning entries. Attribution turns "something broke the tree an
hour ago" from archaeology into a one-line grep. Until gstack reads this
variable natively, put it in the session's prompt/CLAUDE.md so skills include it
in the structured bodies they already write.

### 2. Never switch branches in the shared checkout

The shared checkout is read-mostly common ground. An agent that needs a branch
creates a **worktree** and works there:

```bash
git worktree add "$REPO/.gstack-worktrees/$GSTACK_AGENT_ID/my-feature" -b my-feature origin/main
```

Corollaries: stage only files you created or edited (never `git add -A` in a
shared tree), pin the SHA you branched from when you report work, and remove
the worktree when the branch merges. `/spec --execute` already does this —
it spawns into a fresh worktree. Make it the rule for every agent, not just
spec execution.

### 3. One sanctioned writer per shared artifact

Any file more than one agent updates (a task board, a status dashboard, an
index) gets a single writer script that does an atomic read-modify-write and
regenerates derived views. Agents call the script; they never hand-edit the
file. This is the same discipline `gstack-jsonl-merge` applies to JSONL state —
extend it to every shared artifact. A one-line lock (`flock`) inside the writer
makes concurrent calls safe.

### 4. The brain is a git repo, not a home directory

Per-machine memory (`~/.gstack/projects/*/learnings.jsonl`) evaporates when the
server is rebuilt and is invisible to agents on other machines. Push shared
memory — learnings, decisions, retro outputs, design docs — to a **private git
repo** that every agent pulls on session start. gstack already ships this as
memory sync (`gstack-brain-init`); in server mode it stops being optional and
becomes the coordination substrate: the repo is where an agent learns what the
fleet learned yesterday.

The secret-scanning that memory sync performs before push (AWS keys, tokens,
PEM blocks, JWTs) is load-bearing here — a fleet writes far more state than a
human, and one leaked credential in a shared brain is leaked to every agent
that pulls it.

### 5. Serialize the ship lane

Merging is the one step that must be single-file. Take a per-repo lock before
`/ship`'s push/PR/merge phase and release it after deploy verification:

```bash
exec 9>"/tmp/gstack-ship-$(basename "$REPO").lock"
flock -w 600 9 || { echo "another agent is shipping — queueing"; exit 1; }
```

Daemons follow the same rule gstack's iOS QA daemon already uses: single
instance via flock on a pidfile. Everything else — planning, building, QA —
stays parallel; only the merge lane is serial.

### 6. Scoped credentials, per-surface

- The platform token a runner gets (e.g. a Codespaces `GITHUB_TOKEN`) is usually
  scoped to one repo. Don't widen it. Cross-repo work uses a separate PAT with
  the minimum scopes, injected per-command (`GH_TOKEN=… gh …`), never written
  into git config.
- Deploy tokens (Vercel/Railway/Fly) live in env or a secret store, never in the
  brain repo (rule 4's scanner is the backstop, not the policy).
- Enable gstack's pre-push credential hook everywhere:
  `gstack-config set redact_prepush_hook true` — with N agents pushing, the
  probability that *someone* stages a secret rises with N.

### 7. Headless sessions block; they never prompt

Server-mode sessions are frequently `SESSION_KIND: headless` (spawned, CI,
cron). gstack's preamble already detects this. The hard rule: a headless
session that hits a decision a human must make **blocks and reports** — it
never auto-answers its own AskUserQuestion, and it never renders prose
questions to nobody and proceeds. Pair this with deploy verification by health
endpoint (not by watching a terminal) so an unattended `/land-and-deploy` can
still prove the deploy landed.

## Threat model (why the hardening is shaped this way)

| Threat | Mitigated by |
|---|---|
| Agent commits another agent's work-in-progress | Rule 2 (worktrees + stage-only-own-files) |
| Untraceable bad change ("which agent did this?") | Rule 1 (identity in commits/logs) |
| Lost/duplicated updates to shared boards | Rule 3 (sanctioned writer + lock) |
| Fleet amnesia after server rebuild; knowledge silos per machine | Rule 4 (git-backed brain) |
| Double-merge / version-bump races | Rule 5 (ship lock) |
| One compromised agent exfiltrates broad credentials | Rule 6 (scoped, per-command tokens) |
| Secret lands in shared memory and propagates to all agents | Rule 4 scanner + Rule 6 pre-push hook |
| Headless agent silently self-approves a human decision | Rule 7 (block, don't guess) |
| Prompt-injected agent pushes hostile state to the fleet | Rules 3+4: hostile writes are confined to attributed, reviewable git history and sanctioned writers — `git revert` is the recovery path |

## Adoption checklist

- [ ] Spawner sets `GSTACK_AGENT_ID` per session; CLAUDE.md tells agents to include it in commits and shared-state writes
- [ ] CLAUDE.md rule: no branch switching in the shared checkout; worktrees under `.gstack-worktrees/<agent-id>/`
- [ ] Every shared artifact has exactly one writer script (atomic + flock)
- [ ] Private brain repo initialized (`gstack-brain-init`); agents pull on session start, push on session end
- [ ] Ship lock wrapper installed; `/land-and-deploy` configured via `/setup-deploy` so verification is endpoint-based
- [ ] `redact_prepush_hook` enabled; cross-repo PATs injected per-command only
- [ ] Headless sessions verified to block on human decisions

## Relationship to existing gstack modes

| Mode | Topology | State home |
|---|---|---|
| Default | 1 human, 1 laptop | `~/.gstack` |
| Team mode (`gstack-team-init`) | N humans, N laptops, 1 repo | `~/.gstack` per laptop |
| **Server mode (this doc)** | N agents, 1 machine (or a small pool) | worktrees + git-backed brain + sanctioned writers |

Server mode composes with team mode: a fleet machine bootstrapped with
`gstack-team-init required` guarantees every spawned session has gstack before
these rules apply.
