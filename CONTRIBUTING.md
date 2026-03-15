# Contributing to gstack

Thanks for wanting to make gstack better. Whether you're fixing a typo in a skill prompt or building an entirely new workflow, this guide will get you up and running fast.

## Quick start

gstack skills are Markdown files that Claude Code discovers from a `skills/` directory. Normally they live at `~/.claude/skills/gstack/` (your global install). But when you're developing gstack itself, you want Claude Code to use the skills *in your working tree* — so edits take effect instantly without copying or deploying anything.

That's what dev mode does. It symlinks your repo into the local `.claude/skills/` directory so Claude Code reads skills straight from your checkout.

```bash
git clone <repo> && cd gstack
bun install                    # install dependencies
bin/dev-setup                  # activate dev mode
```

Now edit any `SKILL.md`, invoke it in Claude Code (e.g. `/review`), and see your changes live. When you're done developing:

```bash
bin/dev-teardown               # deactivate — back to your global install
```

## How dev mode works

`bin/dev-setup` creates a `.claude/skills/` directory inside the repo (gitignored) and fills it with symlinks pointing back to your working tree. Claude Code sees the local `skills/` first, so your edits win over the global install.

```
gstack/                          <- your working tree
├── .claude/skills/              <- created by dev-setup (gitignored)
│   ├── gstack -> ../../         <- symlink back to repo root
│   ├── review -> gstack/review
│   ├── ship -> gstack/ship
│   └── ...                      <- one symlink per skill
├── review/
│   └── SKILL.md                 <- edit this, test with /review
├── ship/
│   └── SKILL.md
├── browse/
│   ├── src/                     <- TypeScript source
│   └── dist/                    <- compiled binary (gitignored)
└── ...
```

## Day-to-day workflow

```bash
# 1. Enter dev mode
bin/dev-setup

# 2. Edit a skill
vim review/SKILL.md

# 3. Test it in Claude Code — changes are live
#    > /review

# 4. Editing browse source? Rebuild the binary
bun run build

# 5. Done for the day? Tear down
bin/dev-teardown
```

## Testing & evals

### Setup

```bash
# 1. Copy .env.example and add your API key
cp .env.example .env
# Edit .env → set ANTHROPIC_API_KEY=sk-ant-...

# 2. Install deps (if you haven't already)
bun install
```

Bun auto-loads `.env` — no extra config. Conductor workspaces inherit `.env` from the main worktree automatically (see "Conductor workspaces" below).

### Test tiers

| Tier | Command | Cost | What it tests |
|------|---------|------|---------------|
| 1 — Static | `bun test` | Free | Command validation, snapshot flags, SKILL.md correctness, TODOS-format.md refs, observability unit tests |
| 2 — E2E | `bun run test:e2e` | ~$3.85 | Full skill execution via `claude -p` subprocess |
| 3 — LLM eval | `bun run test:evals` | ~$0.15 standalone | LLM-as-judge scoring of generated SKILL.md docs |
| 2+3 | `bun run test:evals` | ~$4 combined | E2E + LLM-as-judge (runs both) |

```bash
bun test                     # Tier 1 only (runs on every commit, <5s)
bun run test:e2e             # Tier 2: E2E only (needs EVALS=1, can't run inside Claude Code)
bun run test:evals           # Tier 2 + 3 combined (~$4/run)
```

### Tier 1: Static validation (free)

Runs automatically with `bun test`. No API keys needed.

- **Skill parser tests** (`test/skill-parser.test.ts`) — Extracts every `$B` command from SKILL.md bash code blocks and validates against the command registry in `browse/src/commands.ts`. Catches typos, removed commands, and invalid snapshot flags.
- **Skill validation tests** (`test/skill-validation.test.ts`) — Validates that SKILL.md files reference only real commands and flags, and that command descriptions meet quality thresholds.
- **Generator tests** (`test/gen-skill-docs.test.ts`) — Tests the template system: verifies placeholders resolve correctly, output includes value hints for flags (e.g. `-d <N>` not just `-d`), enriched descriptions for key commands (e.g. `is` lists valid states, `press` lists key examples).

### Tier 2: E2E via `claude -p` (~$3.85/run)

Spawns `claude -p` as a subprocess with `--output-format stream-json --verbose`, streams NDJSON for real-time progress, and scans for browse errors. This is the closest thing to "does this skill actually work end-to-end?"

```bash
# Must run from a plain terminal — can't nest inside Claude Code or Conductor
EVALS=1 bun test test/skill-e2e.test.ts
```

- Gated by `EVALS=1` env var (prevents accidental expensive runs)
- Auto-skips if running inside Claude Code (`claude -p` can't nest)
- API connectivity pre-check — fails fast on ConnectionRefused before burning budget
- Real-time progress to stderr: `[Ns] turn T tool #C: Name(...)`
- Saves full NDJSON transcripts and failure JSON for debugging
- Tests live in `test/skill-e2e.test.ts`, runner logic in `test/helpers/session-runner.ts`

### E2E observability

When E2E tests run, they produce machine-readable artifacts in `~/.gstack-dev/`:

| Artifact | Path | Purpose |
|----------|------|---------|
| Heartbeat | `e2e-live.json` | Current test status (updated per tool call) |
| Partial results | `evals/_partial-e2e.json` | Completed tests (survives kills) |
| Progress log | `e2e-runs/{runId}/progress.log` | Append-only text log |
| NDJSON transcripts | `e2e-runs/{runId}/{test}.ndjson` | Raw `claude -p` output per test |
| Failure JSON | `e2e-runs/{runId}/{test}-failure.json` | Diagnostic data on failure |

**Live dashboard:** Run `bun run eval:watch` in a second terminal to see a live dashboard showing completed tests, the currently running test, and cost. Use `--tail` to also show the last 10 lines of progress.log.

**Eval history tools:**

```bash
bun run eval:list            # list all eval runs
bun run eval:compare         # compare two runs (auto-picks most recent)
bun run eval:summary         # aggregate stats across all runs
```

Artifacts are never cleaned up — they accumulate in `~/.gstack-dev/` for post-mortem debugging and trend analysis.

### Tier 3: LLM-as-judge (~$0.15/run)

Uses Claude Sonnet to score generated SKILL.md docs on three dimensions:

- **Clarity** — Can an AI agent understand the instructions without ambiguity?
- **Completeness** — Are all commands, flags, and usage patterns documented?
- **Actionability** — Can the agent execute tasks using only the information in the doc?

Each dimension is scored 1-5. Threshold: every dimension must score **≥ 4**. There's also a regression test that compares generated docs against the hand-maintained baseline from `origin/main` — generated must score equal or higher.

```bash
# Needs ANTHROPIC_API_KEY in .env — included in bun run test:evals
```

- Uses `claude-sonnet-4-6` for scoring stability
- Tests live in `test/skill-llm-eval.test.ts`
- Calls the Anthropic API directly (not `claude -p`), so it works from anywhere including inside Claude Code

### CI

A GitHub Action (`.github/workflows/skill-docs.yml`) runs `bun run gen:skill-docs --dry-run` on every push and PR. If the generated SKILL.md files differ from what's committed, CI fails. This catches stale docs before they merge.

Tests run against the browse binary directly — they don't require dev mode.

## Editing SKILL.md files

SKILL.md files are **generated** from `.tmpl` templates. Don't edit the `.md` directly — your changes will be overwritten on the next build.

```bash
# 1. Edit the template
vim SKILL.md.tmpl              # or browse/SKILL.md.tmpl

# 2. Regenerate
bun run gen:skill-docs

# 3. Check health
bun run skill:check

# Or use watch mode — auto-regenerates on save
bun run dev:skill
```

To add a browse command, add it to `browse/src/commands.ts`. To add a snapshot flag, add it to `SNAPSHOT_FLAGS` in `browse/src/snapshot.ts`. Then rebuild.

## Conductor workspaces

If you're using [Conductor](https://conductor.build) to run multiple Claude Code sessions in parallel, `conductor.json` wires up workspace lifecycle automatically:

| Hook | Script | What it does |
|------|--------|-------------|
| `setup` | `bin/dev-setup` | Copies `.env` from main worktree, installs deps, symlinks skills |
| `archive` | `bin/dev-teardown` | Removes skill symlinks, cleans up `.claude/` directory |

When Conductor creates a new workspace, `bin/dev-setup` runs automatically. It detects the main worktree (via `git worktree list`), copies your `.env` so API keys carry over, and sets up dev mode — no manual steps needed.

**First-time setup:** Put your `ANTHROPIC_API_KEY` in `.env` in the main repo (see `.env.example`). Every Conductor workspace inherits it automatically.

## Things to know

- **SKILL.md files are generated.** Edit the `.tmpl` template, not the `.md`. Run `bun run gen:skill-docs` to regenerate.
- **TODOS.md is the unified backlog.** Organized by skill/component with P0-P4 priorities. `/ship` auto-detects completed items. All planning/review/retro skills read it for context.
- **Browse source changes need a rebuild.** If you touch `browse/src/*.ts`, run `bun run build`.
- **Dev mode shadows your global install.** Project-local skills take priority over `~/.claude/skills/gstack`. `bin/dev-teardown` restores the global one.
- **Conductor workspaces are independent.** Each workspace is its own git worktree. `bin/dev-setup` runs automatically via `conductor.json`.
- **`.env` propagates across worktrees.** Set it once in the main repo, all Conductor workspaces get it.
- **`.claude/skills/` is gitignored.** The symlinks never get committed.

## Testing a branch in another repo

When you're developing gstack in one workspace and want to test your branch in a
different project (e.g. testing browse changes against your real app), there are
two cases depending on how gstack is installed in that project.

### Global install only (no `.claude/skills/gstack/` in the project)

Point your global install at the branch:

```bash
cd ~/.claude/skills/gstack
git fetch origin
git checkout origin/<branch>        # e.g. origin/v0.3.2
bun install                         # in case deps changed
bun run build                       # rebuild the binary
```

Now open Claude Code in the other project — it picks up skills from
`~/.claude/skills/` automatically. To go back to main when you're done:

```bash
cd ~/.claude/skills/gstack
git checkout main && git pull
bun run build
```

### Vendored project copy (`.claude/skills/gstack/` checked into the project)

Some projects vendor gstack by copying it into the repo (no `.git` inside the
copy). Project-local skills take priority over global, so you need to update
the vendored copy too. This is a three-step process:

1. **Update your global install to the branch** (so you have the source):
   ```bash
   cd ~/.claude/skills/gstack
   git fetch origin
   git checkout origin/<branch>      # e.g. origin/v0.3.2
   bun install && bun run build
   ```

2. **Replace the vendored copy** in the other project:
   ```bash
   cd /path/to/other-project

   # Remove old skill symlinks and vendored copy
   for s in browse plan-ceo-review plan-eng-review review ship retro qa setup-browser-cookies; do
     rm -f .claude/skills/$s
   done
   rm -rf .claude/skills/gstack

   # Copy from global install (strips .git so it stays vendored)
   cp -Rf ~/.claude/skills/gstack .claude/skills/gstack
   rm -rf .claude/skills/gstack/.git

   # Rebuild binary and re-create skill symlinks
   cd .claude/skills/gstack && ./setup
   ```

3. **Test your changes** — open Claude Code in that project and use the skills.

To revert to main later, repeat steps 1-2 with `git checkout main && git pull`
instead of `git checkout origin/<branch>`.

## Shipping your changes

When you're happy with your skill edits:

```bash
/ship
```

This runs tests, reviews the diff, triages Greptile comments (with 2-tier escalation), manages TODOS.md, bumps the version, and opens a PR. See `ship/SKILL.md` for the full workflow.
