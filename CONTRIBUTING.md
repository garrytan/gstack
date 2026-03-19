# Contributing to gstack-codex

Thanks for wanting to make `gstack-codex` better. Whether you're fixing a prompt,
porting a workflow, or tightening the browser runtime, this guide should get you
productive quickly.

If you are touching Codex-specific behavior, read `docs/codex-fork-ledger.md`
first. It documents the intentional divergences we preserve during upstream rebases.

## Quick start

The canonical install lives at `~/.codex/skills/gstack-codex/`. When you are
developing the fork itself, you usually want Codex to load the skills directly
from your working tree so edits take effect immediately.

That is what dev mode does. It symlinks your repo into the local
`.codex/skills/` directory so Codex reads skills straight from your checkout.

```bash
git clone <repo> && cd gstack-codex
bun install                    # install dependencies
bin/dev-setup                  # activate dev mode
```

Now edit any `SKILL.md`, invoke it in Codex (for example `/review`), and see your
changes live. When you're done developing:

```bash
bin/dev-teardown               # deactivate — back to your global install
```

## Contributor mode

Contributor mode turns gstack into a self-improving tool. Enable it and Codex
will periodically reflect on its gstack experience — rating it 0-10 at the end of
each major workflow step. When something isn't a 10, it thinks about why and files
a report to `~/.gstack/contributor-logs/` with what happened, repro steps, and what
would make it better.

```bash
~/.codex/skills/gstack-codex/bin/gstack-config set gstack_contributor true
```

The logs are for **you**. When something bugs you enough to fix, the report is
already written. Fork `gstack-codex`, symlink your fork into the project where you hit
the issue, fix it, and open a PR.

### The contributor workflow

1. **Use gstack normally** — contributor mode reflects and logs issues automatically
2. **Check your logs:** `ls ~/.gstack/contributor-logs/`
3. **Fork and clone `gstack-codex`** (if you haven't already)
4. **Symlink your fork into the project where you hit the bug:**
   ```bash
   # In your core project (the one where gstack annoyed you)
   ln -sfn /path/to/your/gstack-codex-fork .codex/skills/gstack-codex
   cd .codex/skills/gstack-codex && bun install && bun run build
   ```
5. **Fix the issue** — your changes are live immediately in this project
6. **Test by actually using gstack** — do the thing that annoyed you, verify it's fixed
7. **Open a PR from your fork**

This is the best way to contribute: fix gstack while doing your real work, in the
project where you actually felt the pain.

### Session awareness

When you have 3+ gstack sessions open simultaneously, every decision prompt tells
you which project, which branch, and what's happening. No more staring at a prompt
thinking "wait, which window is this?"

## Working on gstack inside the gstack repo

When you're editing gstack skills and want to test them by actually using gstack
in the same repo, `bin/dev-setup` wires this up. It creates `.codex/skills/`
symlinks (gitignored) pointing back to your working tree, so Codex uses your
local edits instead of the global install.

```
gstack-codex/                    <- your working tree
├── .codex/skills/               <- created locally, gitignored
│   └── gstack-codex -> ../../   <- symlink back to repo root
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

# 3. Test it in Codex — changes are live
#    > /review

# 4. Editing browse source? Rebuild the binary
bun run build

# 5. Done for the day? Tear down
bin/dev-teardown
```

## Testing & evals

### Setup

```bash
# 1. Install deps (if you haven't already)
bun install
```

Codex-based evals use your local Codex CLI auth. If you installed dependencies in
this repo, the package also ships a local `codex` binary via `@openai/codex`.

### Test tiers

| Tier | Command | Cost | What it tests |
|------|---------|------|---------------|
| 1 — Static | `bun test` | Free | Runtime tests, parser checks, generator checks, skill validation |
| 2 — E2E | `bun run test:e2e` | Uses local Codex session | Full skill execution via `codex exec --json` subprocess |
| 3 — LLM eval | `bun run test:llm-eval` | Uses local Codex session | LLM-as-judge scoring of generated SKILL.md docs |
| 2+3 | `bun run test:evals` | Uses local Codex session | E2E + LLM-as-judge (runs both) |
| Smoke | `bun run test:smoke` | Free | Codex pathing, metadata generation, prompt cleanup, fork naming |
| Smoke | `bun run test:exec` | Uses local Codex session | Minimal non-interactive Codex execution smoke test |

```bash
bun test
bun run test:e2e
bun run test:llm-eval
bun run test:evals
bun run test:smoke
bun run test:exec
```

### Tier 1: Static validation (free)

Runs automatically with `bun test`. No API keys needed.

- **Skill parser tests** (`test/skill-parser.test.ts`) — Extracts every `$B` command from SKILL.md bash code blocks and validates against the command registry in `browse/src/commands.ts`. Catches typos, removed commands, and invalid snapshot flags.
- **Skill validation tests** (`test/skill-validation.test.ts`) — Validates that SKILL.md files reference only real commands and flags, and that command descriptions meet quality thresholds.
- **Generator tests** (`test/gen-skill-docs.test.ts`) — Tests the template system: verifies placeholders resolve correctly, output includes value hints for flags (e.g. `-d <N>` not just `-d`), enriched descriptions for key commands (e.g. `is` lists valid states, `press` lists key examples).

### Tier 2: E2E via `codex exec --json`

Spawns `codex exec --json` as a subprocess, streams JSONL events, and scans for
browse/runtime errors. This is the closest thing to "does this skill actually work
end-to-end in Codex?"

```bash
bun run test:e2e
```

- Gated by `EVALS=1` env var in the package scripts (prevents accidental expensive runs)
- Uses the local `codex` CLI instead of a provider SDK harness
- Streams progress to stderr as tool calls happen
- Saves JSONL transcripts and failure snapshots for debugging
- Lives in `test/skill-e2e.test.ts` with shared runner logic in `test/helpers/session-runner.ts`

### E2E observability

When E2E tests run, they produce machine-readable artifacts in `~/.gstack-dev/`:

| Artifact | Path | Purpose |
|----------|------|---------|
| Heartbeat | `e2e-live.json` | Current test status (updated per tool call) |
| Partial results | `evals/_partial-e2e.json` | Completed tests (survives kills) |
| Progress log | `e2e-runs/{runId}/progress.log` | Append-only text log |
| JSONL transcripts | `e2e-runs/{runId}/{test}.ndjson` | Raw `codex exec --json` output per test |
| Failure JSON | `e2e-runs/{runId}/{test}-failure.json` | Diagnostic data on failure |

**Live dashboard:** Run `bun run eval:watch` in a second terminal to see a live dashboard showing completed tests, the currently running test, and cost. Use `--tail` to also show the last 10 lines of progress.log.

**Eval history tools:**

```bash
bun run eval:list            # list all eval runs (turns, duration, cost per run)
bun run eval:compare         # compare two runs — shows per-test deltas + Takeaway commentary
bun run eval:summary         # aggregate stats + per-test efficiency averages across runs
```

**Eval comparison commentary:** `eval:compare` generates natural-language Takeaway sections interpreting what changed between runs — flagging regressions, noting improvements, calling out efficiency gains (fewer turns, faster, cheaper), and producing an overall summary. This is driven by `generateCommentary()` in `eval-store.ts`.

Artifacts are never cleaned up — they accumulate in `~/.gstack-dev/` for post-mortem debugging and trend analysis.

### Tier 3: LLM-as-judge via Codex

Uses `gpt-5.4-mini` by default to score generated `SKILL.md` docs on three dimensions:

- **Clarity** — Can an AI agent understand the instructions without ambiguity?
- **Completeness** — Are all commands, flags, and usage patterns documented?
- **Actionability** — Can the agent execute tasks using only the information in the doc?

Each dimension is scored 1-5. Threshold: every dimension must score **>= 4**.
There is also a regression test that compares generated docs against the
hand-maintained baseline from `origin/main` — generated must score equal or higher.

```bash
bun run test:llm-eval
```

- Default judge model: `gpt-5.4-mini`
- Override with `CODEX_JUDGE_MODEL=<model>`
- Tests live in `test/skill-llm-eval.test.ts`
- Judge calls go through the Codex CLI, so the provider story stays aligned with the fork

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

For template authoring best practices (natural language over bash-isms, dynamic branch detection, `{{BASE_BRANCH_DETECT}}` usage), see AGENTS.md's "Writing SKILL templates" section.

To add a browse command, add it to `browse/src/commands.ts`. To add a snapshot flag, add it to `SNAPSHOT_FLAGS` in `browse/src/snapshot.ts`. Then rebuild.

## Conductor workspaces

If you're using [Conductor](https://conductor.build) to run multiple Codex sessions in parallel, `conductor.json` wires up workspace lifecycle automatically:

| Hook | Script | What it does |
|------|--------|-------------|
| `setup` | `bin/dev-setup` | Copies `.env` from main worktree, installs deps, symlinks skills |
| `archive` | `bin/dev-teardown` | Removes skill symlinks, cleans up `.codex/` directory |

When Conductor creates a new workspace, `bin/dev-setup` runs automatically. It detects the main worktree (via `git worktree list`), copies your `.env` so API keys carry over, and sets up dev mode — no manual steps needed.

**First-time setup:** Put any repo-specific environment variables in `.env` in the main repo (see `.env.example`). Every Conductor workspace inherits them automatically.

## Things to know

- **SKILL.md files are generated.** Edit the `.tmpl` template, not the `.md`. Run `bun run gen:skill-docs` to regenerate.
- **TODOS.md is the unified backlog.** Organized by skill/component with P0-P4 priorities. `/ship` auto-detects completed items. All planning/review/retro skills read it for context.
- **Browse source changes need a rebuild.** If you touch `browse/src/*.ts`, run `bun run build`.
- **Dev mode shadows your global install.** Project-local skills take priority over `~/.codex/skills/gstack-codex`. `bin/dev-teardown` restores the global one.
- **Conductor workspaces are independent.** Each workspace is its own git worktree. `bin/dev-setup` runs automatically via `conductor.json`.
- **`.env` propagates across worktrees.** Set it once in the main repo, all Conductor workspaces get it.
- **`.codex/skills/` is gitignored.** The local dev symlink never gets committed.

## Testing your changes in a real project

**This is the recommended way to develop gstack.** Symlink your gstack checkout
into the project where you actually use it, so your changes are live while you
do real work:

```bash
# In your core project
ln -sfn /path/to/your/gstack-checkout .codex/skills/gstack-codex
cd .codex/skills/gstack-codex && bun install && bun run build
```

Now every gstack skill invocation in this project uses your working tree. Edit a
template, run `bun run gen:skill-docs`, and the next `/review` or `/qa` call picks
it up immediately.

**To go back to the stable global install**, just remove the symlink:

```bash
rm .codex/skills/gstack-codex
```

Codex falls back to `~/.codex/skills/gstack-codex/` automatically.

### Alternative: point your global install at a branch

If you don't want per-project symlinks, you can switch the global install:

```bash
cd ~/.codex/skills/gstack-codex
git fetch origin
git checkout origin/<branch>
bun install && bun run build
```

This affects all projects. To revert: `git checkout main && git pull && bun run build`.

## Shipping your changes

When you're happy with your skill edits:

```bash
/ship
```

This runs tests, reviews the diff, triages Greptile comments (with 2-tier escalation), manages TODOS.md, bumps the version, and opens a PR. See `ship/SKILL.md` for the full workflow.
