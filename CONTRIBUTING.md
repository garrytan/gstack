# Contributing to gstack

Thanks for making gstack better. This guide gets you running fast.

## Quick start

gstack skills are Markdown files Claude Code discovers from a `skills/` directory. Your global install lives at `~/.claude/skills/gstack/`. In dev mode a symlink points your repo there so edits take effect instantly.

```bash
git clone <repo> && cd gstack
bun install                    # install dependencies
bin/dev-setup                  # activate dev mode
```

Edit any `SKILL.md`, invoke it in Claude Code (e.g. `/review`), see changes live. When done:

```bash
bin/dev-teardown               # deactivate — back to global install
```

## Operational self-improvement

gstack learns from failures automatically. After every skill session, the agent logs operational learnings to `~/.gstack/projects/{slug}/learnings.jsonl`. Future sessions surface them automatically.

No setup needed. View with `/learn`.

### Contributor workflow

1. **Use gstack normally** — learnings captured automatically
2. **Check learnings:** `/learn` or `ls ~/.gstack/projects/*/learnings.jsonl`
3. **Fork and clone gstack**
4. **Symlink your fork into the project where you hit the bug:**
   ```bash
   ln -sfn /path/to/your/gstack-fork .claude/skills/gstack
   cd .claude/skills/gstack && bun install && bun run build && ./setup
   ```
   Setup creates per-skill directories with SKILL.md symlinks (`qa/SKILL.md -> gstack/qa/SKILL.md`) and asks your prefix preference. Pass `--no-prefix` to skip.
5. **Fix the issue** — changes are live immediately
6. **Test by using gstack** — verify the fix in the project where you felt the pain
7. **Open a PR from your fork**

### Session awareness

With 3+ gstack sessions open, every question shows which project, branch, and what's happening. Format is consistent across all skills.

## Working on gstack inside the gstack repo

`bin/dev-setup` creates `.claude/skills/` symlinks (gitignored) pointing to your working tree:

```
gstack/                          <- your working tree
├── .claude/skills/              <- created by dev-setup (gitignored)
│   ├── gstack -> ../../         <- symlink back to repo root
│   ├── review/                  <- real directory (short name, default)
│   │   └── SKILL.md -> gstack/review/SKILL.md
│   ├── ship/
│   │   └── SKILL.md -> gstack/ship/SKILL.md
│   └── ...
├── review/
│   └── SKILL.md                 <- edit this, test with /review
├── ship/
│   └── SKILL.md
├── browse/
│   ├── src/                     <- TypeScript source
│   └── dist/                    <- compiled binary (gitignored)
└── ...
```

Setup creates real directories (not symlinks) at the top level with a SKILL.md symlink inside. Names depend on your prefix setting (`~/.gstack/config.yaml`). Short names (`/review`, `/ship`) are default. Run `./setup --prefix` for namespaced names.

## Day-to-day workflow

```bash
bin/dev-setup           # enter dev mode
vim review/SKILL.md     # edit a skill
# > /review             # test it — changes are live
bun run build           # if you edited browse source
bin/dev-teardown        # done for the day
```

## Testing & evals

### Setup

```bash
cp .env.example .env    # set ANTHROPIC_API_KEY=sk-ant-...
bun install
```

Bun auto-loads `.env`. Conductor workspaces inherit it from the main worktree.

### Test tiers

| Tier | Command | Cost | What it tests |
|------|---------|------|---------------|
| 1 — Static | `bun test` | Free | Command validation, snapshot flags, SKILL.md correctness, TODOS-format.md refs, observability unit tests |
| 2 — E2E | `bun run test:e2e` | ~$3.85 | Full skill execution via `claude -p` subprocess |
| 3 — LLM eval | `bun run test:evals` | ~$0.15 standalone | LLM-as-judge scoring of generated SKILL.md docs |
| 2+3 | `bun run test:evals` | ~$4 combined | E2E + LLM-as-judge |

```bash
bun test                     # Tier 1 only (<5s)
bun run test:e2e             # Tier 2 E2E only (needs EVALS=1, can't run inside Claude Code)
bun run test:evals           # Tier 2+3 combined (~$4/run)
```

### Tier 1: Static validation (free)

Runs with `bun test`. No API keys.

- **Skill parser tests** (`test/skill-parser.test.ts`) — Extracts every `$B` command from SKILL.md bash blocks, validates against `browse/src/commands.ts`. Catches typos and invalid flags.
- **Skill validation tests** (`test/skill-validation.test.ts`) — Validates real commands/flags, quality thresholds.
- **Generator tests** (`test/gen-skill-docs.test.ts`) — Verifies placeholders resolve, output includes value hints, enriched descriptions.

### Tier 2: E2E via `claude -p` (~$3.85/run)

Spawns `claude -p` as subprocess with `--output-format stream-json --verbose`. Closest to "does this skill actually work end-to-end?"

```bash
EVALS=1 bun test test/skill-e2e-*.test.ts
```

- Gated by `EVALS=1` (prevents accidental runs)
- Auto-skips inside Claude Code (`claude -p` can't nest)
- API pre-check — fails fast on ConnectionRefused
- Real-time progress: `[Ns] turn T tool #C: Name(...)`
- Saves NDJSON transcripts and failure JSON for debugging

### E2E observability

| Artifact | Path | Purpose |
|----------|------|---------|
| Heartbeat | `e2e-live.json` | Current test status (updated per tool call) |
| Partial results | `evals/_partial-e2e.json` | Completed tests (survives kills) |
| Progress log | `e2e-runs/{runId}/progress.log` | Append-only text log |
| NDJSON transcripts | `e2e-runs/{runId}/{test}.ndjson` | Raw `claude -p` output per test |
| Failure JSON | `e2e-runs/{runId}/{test}-failure.json` | Diagnostic data on failure |

**Live dashboard:** `bun run eval:watch` in a second terminal. Use `--tail` for last 10 lines of progress.log.

```bash
bun run eval:list            # list all eval runs (turns, duration, cost)
bun run eval:compare         # compare two runs — per-test deltas + commentary
bun run eval:summary         # aggregate stats across all runs
```

`eval:compare` generates natural-language Takeaway sections — regressions, improvements, efficiency gains, overall summary. Driven by `generateCommentary()` in `eval-store.ts`. Artifacts accumulate in `~/.gstack-dev/` for debugging and trend analysis.

### Tier 3: LLM-as-judge (~$0.15/run)

Scores generated SKILL.md docs on three dimensions using Claude Sonnet:

- **Clarity** — Can an agent understand instructions without ambiguity?
- **Completeness** — Are all commands, flags, and patterns documented?
- **Actionability** — Can the agent execute tasks using only the doc?

Each scored 1-5. Threshold: **≥ 4** per dimension. Regression test compares against `origin/main` baseline.

- Uses `claude-sonnet-4-6` for scoring stability
- Tests in `test/skill-llm-eval.test.ts`
- Calls Anthropic API directly (works inside Claude Code)

### CI

`.github/workflows/skill-docs.yml` runs `bun run gen:skill-docs --dry-run` on every push/PR. If generated SKILL.md files differ from committed, CI fails.

## Editing SKILL.md files

SKILL.md files are **generated** from `.tmpl` templates. Don't edit `.md` directly.

```bash
vim SKILL.md.tmpl              # edit the template
bun run gen:skill-docs --host all  # regenerate for all hosts
bun run skill:check            # health dashboard (all hosts)
bun run dev:skill              # watch mode — auto-regenerates on save
```

For template authoring best practices, see CLAUDE.md "Writing SKILL templates". To add a browse command: `browse/src/commands.ts`. Snapshot flag: `SNAPSHOT_FLAGS` in `browse/src/snapshot.ts`. Then rebuild.

## Multi-host development

gstack generates SKILL.md for 8 hosts from one set of `.tmpl` templates. Each host is a typed config in `hosts/*.ts`.

**Supported hosts:** Claude (primary), Codex, Factory, Kiro, OpenCode, Slate, Cursor, OpenClaw.

### Generating for all hosts

```bash
bun run gen:skill-docs                    # Claude (default)
bun run gen:skill-docs --host codex       # Codex
bun run gen:skill-docs --host all         # All 8 hosts
bun run build                             # all hosts + compile binaries
```

### What changes between hosts

| Aspect | Example (Claude vs Codex) |
|--------|---------------------------|
| Output directory | `{skill}/SKILL.md` vs `.agents/skills/gstack-{skill}/SKILL.md` |
| Frontmatter | Full (name, description, hooks, version) vs minimal |
| Paths | `~/.claude/skills/gstack` vs `$GSTACK_ROOT` |
| Tool names | "use the Bash tool" vs same (Factory: "run this command") |
| Hook skills | `hooks:` frontmatter vs inline safety advisory prose |
| Suppressed sections | None vs Codex self-invocation sections stripped |

See `scripts/host-config.ts` for the full `HostConfig` interface.

### Testing host output

```bash
bun test                                  # static tests (parameterized for all hosts)
bun run gen:skill-docs --host all --dry-run  # check freshness
bun run skill:check                       # health dashboard (all hosts)
```

### Adding a new host

See [docs/ADDING_A_HOST.md](docs/ADDING_A_HOST.md). Short version:

1. Create `hosts/myhost.ts` (copy from `hosts/opencode.ts`)
2. Add to `hosts/index.ts`
3. Add `.myhost/` to `.gitignore`
4. Run `bun run gen:skill-docs --host myhost`
5. Run `bun test` (parameterized tests auto-cover it)

No generator, setup, or tooling code changes needed.

### Adding a new skill

1. Create `{skill}/SKILL.md.tmpl`
2. Run `bun run gen:skill-docs --host all`
3. Dynamic template discovery picks it up — no static list to update
4. Commit `{skill}/SKILL.md`; external host output is generated at setup time (gitignored)

## Conductor workspaces

`conductor.json` wires workspace lifecycle automatically:

| Hook | Script | What it does |
|------|--------|-------------|
| `setup` | `bin/dev-setup` | Copies `.env`, installs deps, symlinks skills |
| `archive` | `bin/dev-teardown` | Removes symlinks, cleans `.claude/` |

**First-time setup:** Put `ANTHROPIC_API_KEY` in `.env` (see `.env.example`). All workspaces inherit it.

## Things to know

- **SKILL.md files are generated.** Edit `.tmpl`, not `.md`. Run `bun run gen:skill-docs` to regenerate.
- **TODOS.md is the unified backlog.** Organized by skill/component with P0-P4 priorities. `/ship` auto-detects completed items.
- **Browse source changes need a rebuild.** Touch `browse/src/*.ts` → `bun run build`.
- **Dev mode shadows global install.** Project-local skills take priority over `~/.claude/skills/gstack`. `bin/dev-teardown` restores it.
- **`.claude/skills/` is gitignored.** Symlinks never committed.

## Testing your changes in a real project

Symlink your gstack checkout into the project where you actually use it.

### Step 1: Symlink your checkout

```bash
# In your core project (not the gstack repo)
ln -sfn /path/to/your/gstack-checkout .claude/skills/gstack
```

### Step 2: Run setup to create per-skill symlinks

Claude Code discovers skills through individual top-level directories, not through `gstack/` itself.

```bash
cd .claude/skills/gstack && bun install && bun run build && ./setup
```

Setup asks: short names (`/qa`) or namespaced (`/gstack-qa`). Saved to `~/.gstack/config.yaml`. Pass `--no-prefix` or `--prefix` to skip.

### Step 3: Develop

Edit a template, run `bun run gen:skill-docs`, and the next skill invocation picks it up immediately.

### Going back to stable global install

```bash
rm .claude/skills/gstack
```

Per-skill SKILL.md symlinks resolve to the global install automatically.

### Switching prefix mode

```bash
cd .claude/skills/gstack && ./setup --no-prefix   # switch to /qa, /ship
cd .claude/skills/gstack && ./setup --prefix       # switch to /gstack-qa, /gstack-ship
```

Setup cleans up old symlinks automatically.

### Alternative: point global install at a branch

```bash
cd ~/.claude/skills/gstack
git fetch origin && git checkout origin/<branch>
bun install && bun run build && ./setup
```

Affects all projects. Revert: `git checkout main && git pull && bun run build && ./setup`.

## Community PR triage (wave process)

When community PRs accumulate, batch into themed waves:

1. **Categorize** — group by theme (security, features, infra, docs)
2. **Deduplicate** — two PRs fixing the same thing: pick fewer lines changed, close the other with context
3. **Collector branch** — create `pr-wave-N`, merge clean PRs, resolve conflicts, verify with `bun test && bun run build`
4. **Close with context** — every closed PR gets a comment explaining why and what supersedes it
5. **Ship as one PR** — single PR to main, all attributions in merge commits, summary table of what merged/closed

See [PR #205](../../pull/205) (v0.8.3) for the first wave as an example.

## Upgrade migrations

When a release changes on-disk state in ways `./setup` alone can't fix, add a migration script.

### When to add a migration

- Changed how skill directories are created (symlinks vs real dirs)
- Renamed/moved config keys in `~/.gstack/config.yaml`
- Need to delete orphaned files from a previous version
- Changed format of `~/.gstack/` state files

Don't add migrations for: new features, new skills, or code-only changes.

### How to add one

1. Create `gstack-upgrade/migrations/v{VERSION}.sh` matching the VERSION file
2. `chmod +x gstack-upgrade/migrations/v{VERSION}.sh`
3. Must be **idempotent** and **non-fatal** (failures logged, don't block upgrade)
4. Include a comment block: what changed, why, which users are affected

Example:

```bash
#!/usr/bin/env bash
# Migration: v0.15.2.0 — Fix skill directory structure
# Affected: users who installed with --no-prefix before v0.15.2.0
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
"$SCRIPT_DIR/bin/gstack-relink" 2>/dev/null || true
```

### How it runs

During `/gstack-upgrade` (Step 4.75), the upgrade skill scans `gstack-upgrade/migrations/` and runs every `v*.sh` script newer than the user's old version, in version order. Failures are logged but never block the upgrade.

### Testing migrations

`bun test` (tier 1, free) verifies all migration scripts are executable and parse without syntax errors.

## Shipping your changes

```bash
/ship
```

Runs tests, reviews the diff, triages Greptile comments, manages TODOS.md, bumps the version, opens a PR. See `ship/SKILL.md` for the full workflow.
