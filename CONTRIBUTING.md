# Contributing to gstack

Thanks for wanting to make gstack better. Whether you're fixing a typo in a skill prompt or building an entirely new workflow, this guide will get you up and running fast.

## Quick start

gstack skills are Markdown files that Claude Code discovers from a `skills/` directory. Normally they live at `~/.claude/skills/gstack/` (your global install). But when you're developing gstack itself, you want Claude Code to use the skills *in your working tree* — so edits take effect instantly without copying or deploying anything.

That's what dev mode does. It symlinks your repo into the local `.claude/skills/` directory so Claude Code reads skills straight from your checkout.

```bash
git clone https://github.com/garrytan/gstack.git && cd gstack
bun install                    # install dependencies
bin/dev-setup                  # activate dev mode
```

> **Full clone vs shallow.** The README's user-facing install uses `--depth 1` for speed. As a contributor, use a full clone (no `--depth` flag) — you'll need history for `git log`, `git blame`, `git bisect`, and reviewing PRs against earlier versions. If you already have a `--depth 1` clone from following the README, promote it to a full clone with `git fetch --unshallow`.

Now edit any `SKILL.md`, invoke it in Claude Code (e.g. `/review`), and see your changes live. When you're done developing:

```bash
bin/dev-teardown               # deactivate — back to your global install
```

## Operational self-improvement

gstack automatically learns from failures. At the end of every skill session, the agent
reflects on what went wrong (CLI errors, wrong approaches, project quirks) and logs
operational learnings to `~/.gstack/projects/{slug}/learnings.jsonl`. Future sessions
surface these learnings automatically, so gstack gets smarter on your codebase over time.

No setup needed. Learnings are logged automatically. View them with `/learn`.

### The contributor workflow

1. **Use gstack normally** — operational learnings are captured automatically
2. **Check your learnings:** `/learn` or `ls ~/.gstack/projects/*/learnings.jsonl`
3. **Fork and clone gstack** (if you haven't already)
4. **Symlink your fork into the project where you hit the bug:**
   ```bash
   # In your core project (the one where gstack annoyed you)
   ln -sfn /path/to/your/gstack-fork .claude/skills/gstack
   cd .claude/skills/gstack && bun install && bun run build && ./setup
   ```
   Setup creates per-skill directories with SKILL.md symlinks inside (`qa/SKILL.md -> gstack/qa/SKILL.md`),
   links each skill's runtime assets alongside (sections/, templates, checklists — everything except
   SKILL.md, tests, build output, and `.tmpl` sources), and asks your prefix preference.
   Pass `--no-prefix` to skip the prompt and use short names.
5. **Fix the issue** — your changes are live immediately in this project
6. **Test by actually using gstack** — do the thing that annoyed you, verify it's fixed
7. **Open a PR from your fork**

This is the best way to contribute: fix gstack while doing your real work, in the
project where you actually felt the pain.

### Session awareness

When you have 3+ gstack sessions open simultaneously, every question tells you which project, which branch, and what's happening. No more staring at a question thinking "wait, which window is this?" The format is consistent across all skills.

## Working on gstack inside the gstack repo

When you're editing gstack skills and want to test them by actually using gstack
in the same repo, `bin/dev-setup` wires this up. It creates `.claude/skills/`
symlinks (gitignored) pointing back to your working tree, so Claude Code uses
your local edits instead of the global install.

```
gstack/                          <- your working tree
├── .claude/skills/              <- created by dev-setup (gitignored)
│   ├── gstack -> ../../         <- symlink back to repo root
│   ├── review/                  <- real directory (short name, default)
│   │   └── SKILL.md -> gstack/review/SKILL.md
│   ├── ship/                    <- or gstack-review/, gstack-ship/ if --prefix
│   │   └── SKILL.md -> gstack/ship/SKILL.md
│   └── ...                      <- one directory per skill
├── review/
│   └── SKILL.md                 <- edit this, test with /review
├── ship/
│   └── SKILL.md
├── browse/
│   ├── src/                     <- TypeScript source
│   └── dist/                    <- compiled binary (gitignored)
└── ...
```

Setup creates real directories (not symlinks) at the top level with a SKILL.md
symlink inside, plus links to each skill's runtime assets (sections/, templates,
checklists). Alias skills (`_gstack-command`, `connect-chrome`) install as
rewritten copies, never symlinks — editing a symlinked alias would corrupt the
generated source. This ensures Claude discovers them as top-level skills, not nested
under `gstack/`. Names depend on your prefix setting (`~/.gstack/config.yaml`).
Short names (`/review`, `/ship`) are the default. Run `./setup --prefix` if you
prefer namespaced names (`/gstack-review`, `/gstack-ship`).

## Day-to-day workflow

```bash
# 1. Enter dev mode
bin/dev-setup

# 2. Edit a skill template (SKILL.md files are generated — edit the .tmpl)
vim review/SKILL.md.tmpl
bun run gen:skill-docs   # or: bun run dev:skill (watch mode, auto-regen on change)

# 3. Test it in Claude Code — changes are live
#    > /review

# 4. Editing browse source? Rebuild the binary
bun run build

# 5. Done for the day? Tear down
bin/dev-teardown
```

### Brain-aware blocks in a dev workspace (gbrain installed)

If gbrain is installed and usable (`bin/gstack-gbrain-detect --is-ok` exits 0),
`bin/dev-setup` keeps your tracked `SKILL.md` files canonical and renders the
brain-aware variant (the `GBRAIN_CONTEXT_LOAD` / `GBRAIN_SAVE_RESULTS` blocks)
into `.claude/gstack-rendered/` (gitignored, per-workspace). It then repoints the
workspace's `SKILL.md` symlinks at that render, so your Claude sessions get the
full gbrain experience while `git status` stays clean. Under the hood, dev-setup
passes `GSTACK_SKIP_GBRAIN_REGEN=1` inline to the nested `./setup` (so it never
dirties tracked source) and runs `gen:skill-docs:user --out-dir .claude/gstack-rendered`,
which rewrites only the section-base paths to point at the render. `bin/dev-teardown`
removes the render. To make the blocks live across your *other* projects' Claude
sessions, run `gstack-config gbrain-refresh`, which renders them to a user render
dir (`${GSTACK_USER_RENDER_DIR:-~/.gstack/render/claude}`, swapped in only on a
successful render) and repoints the installed skills at it via `gstack-relink` —
the global install checkout stays git-clean, and the refresh is guarded so it
never touches a symlinked or non-gstack directory.

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
| 1 — Static | `bun run test` | Free | Command validation, snapshot flags, SKILL.md correctness, TODOS-format.md refs, observability unit tests |
| 2 — E2E | `bun run test:e2e` | ~$4.20 | Full skill execution via `claude -p` subprocess |
| 3 — LLM eval | `EVALS=1 bun test test/skill-llm-eval.test.ts` | ~$0.15 standalone | LLM-as-judge scoring of generated SKILL.md docs |
| 2+3 | `bun run test:evals` | ~$4 combined | E2E + LLM-as-judge (runs both) |

```bash
bun run test                 # Tier 1 only (run before every commit, ~90-100s for the full ~8,700-test suite)
bun run test:e2e             # Tier 2: E2E only (needs EVALS=1, can't run inside Claude Code)
bun run test:evals           # Tier 2 + 3 combined (~$4.35/run)
```

### Tier 1: Static validation (free)

Runs with `bun run test`, which routes through `scripts/test-free-shards.ts`: N
concurrent shard processes under a strict output contract — a shard that exits
without bun's own terminal summary line, or a crashed worker, fails the run, so
silent truncation can never report green. Pass `--verbose` to forward the full
child stream; `--wall-timeout <secs>` overrides the per-shard kill deadline.
`GSTACK_FREE_JOBS=<n>` overrides the shard count (digits only, loud on garbage),
and `GSTACK_FREE_RETRY_FLAKY=1` opts into one serial retry pass for
syscall-supervised sandboxes (off by default locally — dev boxes should see
flakes; the required CI free lane turns it on and uploads every flaky pass
in a JSONL ledger artifact that `bun run eval:flake-rank` folds in).
Working in a cloud sandbox? Run `scripts/sandbox-doctor.sh` once per boot to
make the suite run green (details in
[docs/TESTING_INTERNALS.md](docs/TESTING_INTERNALS.md)).
Don't type bare `bun test` for the suite: it walks the whole repo, loads paid
eval files, and misses the strict classifier. No API keys needed.

- **Skill parser tests** (`test/skill-parser.test.ts`) — Extracts every `$B` command from SKILL.md bash code blocks and validates against the command registry in `browse/src/commands.ts`. Catches typos, removed commands, and invalid snapshot flags.
- **Skill validation tests** (`test/skill-validation.test.ts`) — Validates that SKILL.md files reference only real commands and flags, and that command descriptions meet quality thresholds.
- **Generator tests** (`test/gen-skill-docs.test.ts`) — Tests the template system: verifies placeholders resolve correctly, output includes value hints for flags (e.g. `-d <N>` not just `-d`), enriched descriptions for key commands (e.g. `is` lists valid states, `press` lists key examples).
- **Tier-alignment invariant** (`test/e2e-tier-alignment.test.ts`) — For every self-gated `test/skill-e2e-*.test.ts` named in a touchfiles dep list, the file's `EVALS_TIER` self-gate must match its declared tier in `E2E_TIERS`. Kills the "inert demotion" class where a test is re-tiered in `touchfiles.ts` but the file still gates on the old tier and keeps running in the wrong lane. Unmapped or mixed-tier files are reported, never silently skipped.
- **Catalog budget** (`test/catalog-budget.test.ts`) — Caps the aggregate discovery surface: the sum of every skill's frontmatter `name` + `description` (what every host loads at discovery, every session) must stay under 1,150 token-equivalents, with a 260-byte per-skill cap. Counting goes through the shared census in `test/helpers/skill-census.ts` (physical files vs authored skills vs registry entries — three deliberately different counts). Adding a skill? The failure message carries the re-measure + ratchet protocol.
- **Context-budget ratchet** (`test/context-budget-ratchet.test.ts`) — CI ceilings on the two token ledgers the catalog budget doesn't cover: the always-on full-frontmatter aggregate and each skill's per-invocation eager tokens (SKILL.md + forced-read references), graded against `test/fixtures/context-budget.json` via `lib/context-bill.ts`. New skills fail until they have a ceiling; ceilings for removed skills must be pruned. Legitimate growth or a landed reduction: re-run `bun test/helpers/capture-context-budget.ts` and commit the refreshed fixture in the same commit, so the change is a visible decision in the diff.

### Tier 2: E2E via `claude -p` (~$4.20/run)

Spawns `claude -p` as a subprocess with `--output-format stream-json --verbose`, streams NDJSON for real-time progress, and scans for browse errors. This is the closest thing to "does this skill actually work end-to-end?"

```bash
# Must run from a plain terminal — can't nest inside Claude Code or Conductor
EVALS=1 bun test test/skill-e2e-*.test.ts
```

- Gated by `EVALS=1` env var (prevents accidental expensive runs)
- Auto-skips if running inside Claude Code (`claude -p` can't nest)
- API connectivity pre-check — fails fast on ConnectionRefused before burning budget
- Real-time progress to stderr: `[Ns] turn T tool #C: Name(...)`
- Saves full NDJSON transcripts and failure JSON for debugging
- Tests live in `test/skill-e2e-*.test.ts` (split by category), runner logic in `test/helpers/session-runner.ts`

**Hermetic by default.** Every E2E runner (claude -p, the real-PTY plan-mode
runner, the Agent SDK runner, plus the codex and gemini runners) spawns its child
through `test/helpers/hermetic-env.ts`: an allowlist-scrubbed environment, a fresh
seeded `CLAUDE_CONFIG_DIR`, a temp `GSTACK_HOME`, and `--strict-mcp-config`. Your
operator `~/.claude` config, MCP servers (gbrain, Conductor), skills, `~/.gstack`
decision logs, and `CONDUCTOR_*` env never leak into the child, so local eval
signal matches CI instead of disagreeing for reasons unrelated to the code under
test. The hermetic `CLAUDE_CONFIG_DIR` seeds no skills by default; a PTY test
that types a `/skill` slash command passes `seedSkills: true` to the PTY runner,
which swaps in `hermeticSkillsConfigDir()` — a seeded skill registry that
symlinks the LIVE working tree's SKILL.md files (by design: the skills are the
subject under test, so a snapshot would measure stale copies). Set
`EVALS_HERMETIC=0` to debug against your real operator state (this also
drops `--strict-mcp-config`). The wiring is pinned by `test/hermetic-wiring.test.ts`
(a free static tripwire), two gate-tier isolation canaries in
`test/skill-e2e-hermetic-canary.test.ts`, and the skill-seeding tripwires in
`test/hermetic-skills-seeding.test.ts` / `test/pty-skill-seeding-wiring.test.ts`.

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
bun run eval:list            # list all eval runs (turns, duration, cost per run)
bun run eval:compare         # compare two runs — shows per-test deltas + Takeaway commentary
bun run eval:summary         # aggregate stats + per-test efficiency averages across runs
bun run eval:flake-rank      # rank tests by flake signal: retried passes first, then failure rate (--json, --dir, --since-days)
```

**Detached runs for agents and long suites.** When an agent (or you, for a run
you don't want to babysit) launches a long eval, use the `eval:bg*` scripts. They
wrap the eval command in `bin/gstack-detach`: a fresh session that escapes a
turn-boundary SIGTERM, a `caffeinate` wrapper that blocks idle-sleep, a machine-wide
`gstack-evals` lock so concurrent worktrees serialize instead of saturating the
model API, a run-scoped log under `~/.gstack-dev/eval-runs/`, a per-tier watchdog,
and a guaranteed `### gstack-detach EXIT=<code> ###` sentinel so a poller never
mistakes silence for success.

```bash
bun run eval:bg              # detached test:evals (diff-based)
bun run eval:bg:all          # detached test:evals:all
bun run eval:bg:gate         # detached gate-tier suite
bun run eval:bg:periodic     # detached periodic-tier suite
```

Each prints its log path. The gate and periodic variants run their tier through
the sharded paid runner (`scripts/test-paid-shards.ts`, also available directly
as `bun run test:gate:sharded` / `bun run test:periodic:sharded`): one Bun
process per test file, an external wall-clock timeout that kills the shard's
whole process group (stray `claude`/`codex` grandchildren included), a per-shard
eval dir (`GSTACK_EVAL_DIR=<evalDir>/shards/<slug>/`), and an aggregate that
distinguishes failed vs timed-out vs never-started shards. The runner also
selects by diff: shards untouched by your branch are reported as
skipped-by-diff, with a selection banner naming the reason (`EVALS_ALL=1`
forces everything). `EVALS_JOBS` sets how many shard processes run at once
(default 8); `EVALS_CONCURRENCY` is bun's concurrency WITHIN a shard
(default 2) — they are deliberately separate knobs. `eval:list`,
`eval:compare`, `eval:summary`, and `eval:flake-rank` are shard-aware. Humans running
`bun run test:evals` foreground in their own terminal don't need this — Ctrl-C
is intended there.

**Eval comparison commentary:** `eval:compare` generates natural-language Takeaway sections interpreting what changed between runs — flagging regressions, noting improvements, calling out efficiency gains (fewer turns, faster, cheaper), and producing an overall summary. This is driven by `generateCommentary()` in `eval-store.ts`.

Artifacts are never cleaned up — they accumulate in `~/.gstack-dev/` for post-mortem debugging and trend analysis.

### Tier 3: LLM-as-judge (~$0.15/run)

Uses Claude Sonnet to score generated SKILL.md docs on three dimensions.
Override the judge model per run with `GSTACK_EVAL_MODEL_JUDGE`:

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

Supply-chain gates run alongside it:

- **Quality gate** (`.github/workflows/quality-gate.yml`, every PR and push) — scans the diff's added lines for credentials using gstack's own redact engine (`.github/scripts/gate-secret-scan.mjs`). HIGH findings fail the job; MEDIUM findings surface as an advisory count. Fails closed if the scan can't produce a report. Also gates critical dependency advisories and runs ShellCheck on the setup/build boundaries.
- **Dependency review** (`.github/workflows/dependency-review.yml`) — reviews dependency changes on PRs that touch lockfiles or workflow files.
- **OSV scanner** (`.github/workflows/osv-scanner.yml`) — weekly vulnerability scan against the OSV database. Config lives in `.osv-scanner.toml` and is loaded via an explicit `--config` flag (OSV does not auto-discover that filename); every ignore entry needs a reason and an `ignoreUntil` expiry, enforced by `test/osv-config-wiring.test.ts`.
- **Dependabot** (`.github/dependabot.yml`) — grouped dependency update PRs.

The supply-chain workflows pin their third-party actions to commit SHAs. The PR template (`.github/PULL_REQUEST_TEMPLATE.md`) asks for evidence — tests run, eval output — not promises.

Tests run against the browse binary directly — they don't require dev mode.

## Editing SKILL.md files

SKILL.md files are **generated** from `.tmpl` templates. Don't edit the `.md` directly — your changes will be overwritten on the next build.

```bash
# 1. Edit the template
vim SKILL.md.tmpl              # or browse/SKILL.md.tmpl

# 2. Regenerate for all hosts
bun run gen:skill-docs --host all

# 3. Check health (reports all hosts)
bun run skill:check

# Or use watch mode — auto-regenerates on save
bun run dev:skill
```

For template authoring best practices (natural language over bash-isms, dynamic branch detection, `{{BASE_BRANCH_DETECT}}` usage), see CLAUDE.md's "Writing SKILL templates" section.

To add a browse command, add it to `browse/src/commands.ts`. To add a snapshot flag, add it to `SNAPSHOT_FLAGS` in `browse/src/snapshot.ts`. Then rebuild.

**Don't bundle puppeteer/Chromium in a skill.** `browse` is the one shared
Chromium per box, including offline local-render workloads. A skill that needs to
rasterize its own HTML/JSON (diagrams, cards, og-images) should route through
`browse` — `screenshot --selector` for visual output, `load-html` + `js --out` for
bytes a render function returns — instead of `npm i puppeteer` and downloading a
second Chromium that drifts out of version sync. One install to pin, one daemon to
manage.

## Jargon list (V1 writing style)

gstack's Writing Style section (injected into every tier-≥2 skill's preamble)
glosses technical terms on first use per skill invocation. The list of terms
that qualify for glossing lives at `scripts/jargon-list.json` — ~50 curated
high-frequency terms (idempotent, race condition, N+1, backpressure, etc.).
Terms not on the list are assumed plain-English enough.

**Adding or removing a term:** open a PR editing `scripts/jargon-list.json`.
Run `bun run gen:skill-docs` after the edit — terms are baked into every
generated SKILL.md at gen time, so changes take effect only after regeneration.
No runtime loading; no user-side override. The repo list is the source of truth.

Good candidates for addition: high-frequency terms that non-technical users
encounter in review output without context (common database/concurrency
terminology, security jargon, frontend framework concepts). Don't add terms
that only appear in one or two niche skills — the cost-to-value trade isn't
worth the review overhead.

## Multi-host development

gstack generates SKILL.md files for 10 hosts from one set of `.tmpl` templates.
Each host is a typed config in `hosts/*.ts`. The generator reads these configs
to produce host-appropriate output (different frontmatter, paths, tool names).

**Supported hosts:** Claude (primary), Codex, Factory, Kiro, OpenCode, Slate, Cursor, OpenClaw, Hermes, GBrain.

### Generating for all hosts

```bash
# Generate for a specific host
bun run gen:skill-docs                    # Claude (default)
bun run gen:skill-docs --host codex       # Codex
bun run gen:skill-docs --host opencode    # OpenCode
bun run gen:skill-docs --host all         # All 10 hosts

# Or use build, which does all hosts + compiles binaries
bun run build
```

### What changes between hosts

Each host config (`hosts/*.ts`) controls:

| Aspect | Example (Claude vs Codex) |
|--------|---------------------------|
| Output directory | `{skill}/SKILL.md` vs `.agents/skills/gstack-{skill}/SKILL.md` |
| Frontmatter | Full (name, description, hooks, version) vs minimal (name + description) |
| Paths | `~/.claude/skills/gstack` vs `$GSTACK_ROOT` |
| Tool names | "use the Bash tool" vs same (Factory rewrites to "run this command") |
| Hook skills | `hooks:` frontmatter vs inline safety advisory prose |
| Suppressed sections | None vs Codex self-invocation sections stripped |
| Model overlay | `claude` vs `gpt` (per-host `defaultModel`; `--model` or, at setup time, the Codex `config.toml` model overrides) |

See `scripts/host-config.ts` for the full `HostConfig` interface.

### Testing host output

```bash
# Run all static tests (includes parameterized smoke tests for all hosts)
bun run test

# Check freshness for all hosts
bun run gen:skill-docs --host all --dry-run

# Health dashboard covers all hosts
bun run skill:check
```

### Adding a new host

See [docs/ADDING_A_HOST.md](docs/ADDING_A_HOST.md) for the full guide. Short version:

1. Create `hosts/myhost.ts` (copy from `hosts/opencode.ts`)
2. Add to `hosts/index.ts`
3. Add `.myhost/` to `.gitignore`
4. Run `bun run gen:skill-docs --host myhost`
5. Run `bun run test` (parameterized tests auto-cover it)

Zero generator, setup, or tooling code changes needed.

### Adding a new skill

When you add a new skill template, all hosts get it automatically:
1. Create `{skill}/SKILL.md.tmpl`
2. Run `bun run gen:skill-docs --host all`
3. The dynamic template discovery picks it up, no static list to update
4. Budget it: run `bun test/helpers/capture-context-budget.ts` and commit the refreshed `test/fixtures/context-budget.json` — the context-budget ratchet fails any skill without a ceiling
5. Commit `{skill}/SKILL.md`, external host output is generated at setup time and gitignored

## Conductor workspaces

If you're using [Conductor](https://conductor.build) to run multiple Claude Code sessions in parallel, `conductor.json` wires up workspace lifecycle automatically:

| Hook | Script | What it does |
|------|--------|-------------|
| `setup` | `bin/dev-setup` | Copies `.env` from main worktree, installs deps, symlinks skills, runs `./setup` non-interactively, and (if gbrain is installed) renders brain-aware blocks into `.claude/gstack-rendered/` without dirtying tracked source |
| `archive` | `bin/dev-teardown` | Removes skill symlinks, the `.claude/gstack-rendered/` render, and cleans up `.claude/` directory |

When Conductor creates a new workspace, `bin/dev-setup` runs automatically. It detects the main worktree (via `git worktree list`), copies your `.env` so API keys carry over, and sets up dev mode — no manual steps needed.

`bin/dev-setup` runs `./setup` fully non-interactively (it passes `--plan-tune-hooks=prompt` and closes stdin), so a forwarded Conductor TTY can never hang on a hidden setup prompt. It also never installs the plan-tune Claude Code hooks, which means a throwaway workspace can't rewrite your global `~/.claude/settings.json` to point at an ephemeral worktree path. To install the plan-tune hooks deliberately, run `./setup --plan-tune-hooks` outside dev-setup (or `gstack-config set plan_tune_hooks yes`). The explicit flag counts as an explicit decision: setup's Conductor auto-opt-in for AskUserQuestion hooks fires only on the true silent fall-through (no flag, no `GSTACK_PLAN_TUNE_HOOKS` env var, no `plan_tune_hooks` key literally present in config, checked via `gstack-config has`), so it can never override dev-setup into installing hooks. One stated repair exception: setup's heal-first pass (`gstack-settings-hook prune-stale --repoint`) may prune dead gstack hook entries and re-point existing ones at the stable `~/.claude/skills/gstack` install. That is strictly convergent repair, never a new registration, and registration itself is canonical-only, so an ephemeral tree path can never be baked into settings.json.

**First-time setup:** Put your `ANTHROPIC_API_KEY` in `.env` in the main repo (see `.env.example`). Every Conductor workspace inherits it automatically.

**`GSTACK_*` env prefix (Conductor-injected keys).** Conductor explicitly strips `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from every workspace's process env. The `.env` copy path doesn't restore them either — the strip happens after env inheritance. Users who want paid evals, `/sync-gbrain` embeddings, or `claude-agent-sdk` calls to work in a Conductor workspace must set `GSTACK_ANTHROPIC_API_KEY` and `GSTACK_OPENAI_API_KEY` in Conductor's workspace env config; Conductor passes those through untouched. On the gstack side, TS entry points import `lib/conductor-env-shim.ts` as a side effect, which promotes `GSTACK_FOO_API_KEY` to `FOO_API_KEY` when the canonical name is empty. If you add a new TS entry point that hits a paid API, add `import "../lib/conductor-env-shim";` to the top of the file. Today the shim is imported from `bin/gstack-gbrain-sync.ts`, `bin/gstack-model-benchmark`, `scripts/preflight-agent-sdk.ts`, and `test/helpers/e2e-helpers.ts`.

## Things to know

- **SKILL.md files are generated.** Edit the `.tmpl` template, not the `.md`. Run `bun run gen:skill-docs` to regenerate.
- **TODOS.md is the unified backlog.** Organized by skill/component with P0-P4 priorities. `/ship` auto-detects completed items. All planning/review/retro skills read it for context.
- **Browse source changes need a rebuild.** If you touch `browse/src/*.ts`, run `bun run build`.
- **Dev mode shadows your global install.** Project-local skills take priority over `~/.claude/skills/gstack`. `bin/dev-teardown` restores the global one.
- **Conductor workspaces are independent.** Each workspace is its own git worktree. `bin/dev-setup` runs automatically via `conductor.json`.
- **`.env` propagates across worktrees.** Set it once in the main repo, all Conductor workspaces get it.
- **`.claude/skills/` is gitignored.** The symlinks never get committed.
- **Never write raw `ln -snf` in `setup`.** Every link site in `setup` MUST route through the `_link_or_copy SRC DST` helper near the `IS_WINDOWS` detection. The helper preserves `ln -snf` on Unix and switches to `cp -R` / `cp -f` on Windows without Developer Mode, where plain `ln -snf` produces frozen file copies that don't refresh on `git pull`. `test/setup-windows-fallback.test.ts` enforces this with a static invariant — a single raw `ln` call outside the helper body fails CI.
- **Synchronous subagent dispatches must state the flag.** Claude Code runs Agent-tool subagents in the background by default (since v2.1.198), so any template step that dispatches a subagent and consumes its output must carry `run_in_background: false`. Use the `{{FOREGROUND_DISPATCH_NOTE}}` placeholder (`scripts/resolvers/constants.ts`) instead of hand-writing the guidance, and add the generated carrier file to `GENERATED_WITH_GUIDANCE` in `test/run-in-background-guidance.test.ts` in the same commit — its structural scanner fails CI on any generated dispatch imperative that lacks the flag.
- **Never delete or link over a skill entry `setup` cannot prove is gstack's.** Every destructive site in `setup` (the linker, the alias installer, both prefix-flip cleanups) and in `bin/gstack-relink` goes through the ownership helpers (`_claude_entry_is_ours` / `_claude_entry_owned_strongly` in `setup`, `_entry_is_ours` / `_entry_owned_strongly` in relink). A symlink into gstack or the `.gstack-owned` marker proves the whole directory; a byte-identical or generated-banner SKILL.md proves only that file, and a differing one is moved to `~/.gstack/backups/skills/<ts>/` first. `test/setup-link-ownership.test.ts`, `test/setup-cleanup-orphans.test.ts`, and `test/relink.test.ts` pin it. The rule is duplicated in the two scripts until the shared helper filed in TODOS.md lands: change both.
- **`./setup` never fails on Chromium.** The Playwright bootstrap (section `# 2` of `setup`) is best-effort and bounded: every failure becomes a reason code (`skipped`, `chromium-install`, `chromium-install-timeout`, `chromium-install-locked`, `windows-no-node`, `windows-node-modules`, `post-install-launch`) printed in the final summary alongside the browser-dependent skills, and skill registration always runs. `GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT=<seconds>` (default 600) bounds the download; `GSTACK_SKIP_PLAYWRIGHT=1` skips it, the right knob for a no-browser box or a setup-only test loop. Anything you add after the bootstrap must stay independent of the browser. `test/setup-playwright-best-effort.test.ts` pins the block.

## Testing your changes in a real project

**This is the recommended way to develop gstack.** Symlink your gstack checkout
into the project where you actually use it, so your changes are live while you
do real work.

### Step 1: Symlink your checkout

```bash
# In your core project (not the gstack repo)
ln -sfn /path/to/your/gstack-checkout .claude/skills/gstack
```

### Step 2: Run setup to create per-skill symlinks

The `gstack` symlink alone isn't enough. Claude Code discovers skills through
individual top-level directories (`qa/SKILL.md`, `ship/SKILL.md`, etc.), not through
the `gstack/` directory itself. Run `./setup` to create them:

```bash
cd .claude/skills/gstack && bun install && bun run build && ./setup
```

Setup will ask whether you want short names (`/qa`) or namespaced (`/gstack-qa`).
Your choice is saved to `~/.gstack/config.yaml` and remembered for future runs.
To skip the prompt, pass `--no-prefix` (short names) or `--prefix` (namespaced).

### Step 3: Develop

Edit a template, run `bun run gen:skill-docs`, and the next `/review` or `/qa`
call picks it up immediately. No restart needed.

### Going back to the stable global install

Remove the project-local symlink. Claude Code falls back to `~/.claude/skills/gstack/`:

```bash
rm .claude/skills/gstack
```

The per-skill directories (`qa/`, `ship/`, etc.) contain SKILL.md symlinks that point
to `gstack/...`, so they'll resolve to the global install automatically.

### Switching prefix mode

If you installed gstack with one prefix setting and want to switch:

```bash
cd .claude/skills/gstack && ./setup --no-prefix   # switch to /qa, /ship
cd .claude/skills/gstack && ./setup --prefix       # switch to /gstack-qa, /gstack-ship
```

Setup cleans up the old symlinks automatically. No manual cleanup needed. Only
entries gstack created are removed: a skill of your own that shares a name (a
hand-written `qa/`, say) is left in place and named in setup's final summary.

### Alternative: point your global install at a branch

If you don't want per-project symlinks, you can switch the global install:

```bash
cd ~/.claude/skills/gstack
git fetch origin
git checkout origin/<branch>
bun install && bun run build && ./setup
```

This affects all projects. To revert: `git checkout main && git pull && bun run build && ./setup`.

## Community PR triage (wave process)

When community PRs accumulate, batch them into themed waves:

1. **Categorize** — group by theme (security, features, infra, docs)
2. **Deduplicate** — if two PRs fix the same thing, pick the one that
   changes fewer lines. Close the other with a note pointing to the winner.
3. **Collector branch** — create `pr-wave-N`, merge clean PRs, resolve
   conflicts for dirty ones, verify with `bun run test && bun run build`
4. **Close with context** — every closed PR gets a comment explaining
   why and what (if anything) supersedes it. Contributors did real work;
   respect that with clear communication.
5. **Ship as one PR** — single PR to main with all attributions preserved
   in merge commits. Include a summary table of what merged and what closed.

See [PR #205](../../pull/205) (v0.8.3) for the first wave as an example.

## Upgrade migrations

When a release changes on-disk state (directory structure, config format, stale
files) in ways that `./setup` alone can't fix, add a migration script so existing
users get a clean upgrade.

### When to add a migration

- Changed how skill directories are created (symlinks vs real dirs)
- Renamed or moved config keys in `~/.gstack/config.yaml`
- Need to delete orphaned files from a previous version
- Changed the format of `~/.gstack/` state files

Don't add a migration for: new features (users get them automatically), new
skills (setup discovers them), or code-only changes (no on-disk state).

### How to add one

1. Create `gstack-upgrade/migrations/v{VERSION}.sh` where `{VERSION}` matches
   the VERSION file for the release that needs the fix.
2. Make it executable: `chmod +x gstack-upgrade/migrations/v{VERSION}.sh`
3. The script must be **idempotent** (safe to run multiple times) and
   **non-fatal** (failures are logged but don't block the upgrade).
4. Include a comment block at the top explaining what changed, why the
   migration is needed, and which users are affected.

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

During `/gstack-upgrade`, after `./setup` completes (Step 4.75), the upgrade
skill scans `gstack-upgrade/migrations/` and runs every `v*.sh` script whose
version is newer than the user's old version. Scripts run in version order.
Failures are logged but never block the upgrade.

### Testing migrations

Migrations are tested as part of `bun run test` (tier 1, free). The test suite
verifies that all migration scripts in `gstack-upgrade/migrations/` are
executable and parse without syntax errors.

## Shipping your changes

When you're happy with your skill edits:

```bash
/ship
```

This runs tests, reviews the diff, triages Greptile comments (with 2-tier escalation), manages TODOS.md, bumps the version, and opens a PR. See `ship/SKILL.md` for the full workflow.
