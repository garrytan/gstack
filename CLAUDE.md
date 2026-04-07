# gstack development

## Commands

```bash
bun install             # dependencies
bun test                # free tests (browse+snapshot+skill validation), <2s
bun run test:evals      # paid evals: LLM judge+E2E, diff-based (~$4/run max)
bun run test:evals:all  # all paid evals regardless of diff
bun run test:gate       # gate-tier only (CI default, blocks merge)
bun run test:periodic   # periodic-tier only (weekly cron/manual)
bun run test:e2e        # E2E only, diff-based (~$3.85/run max)
bun run test:e2e:all    # all E2E regardless of diff
bun run eval:select     # preview which tests run based on diff
bun run dev <cmd>       # dev mode, e.g. bun run dev goto https://example.com
bun run build           # gen docs+compile binaries
bun run gen:skill-docs  # regenerate SKILL.md from templates
bun run skill:check     # health dashboard
bun run dev:skill       # watch mode: auto-regen+validate
bun run eval:list       # list eval runs from ~/.gstack-dev/evals/
bun run eval:compare    # compare two runs (auto-picks recent)
bun run eval:summary    # aggregate stats across runs
```

`test:evals` requires `ANTHROPIC_API_KEY`. Codex E2E tests use `~/.codex/` config.
E2E streams progress real-time (`--output-format stream-json --verbose`).
Results persist to `~/.gstack-dev/evals/` with auto-comparison.

**Diff-based selection:** `test:evals`/`test:e2e` auto-select via `git diff` against base.
Tests declare dependencies in `test/helpers/touchfiles.ts`. Global touchfile changes trigger all.
`EVALS_ALL=1` or `:all` variants force all. `eval:select` previews.

**Two tiers:** `gate` or `periodic` in `E2E_TIERS` (touchfiles.ts).
CI runs gate only (`EVALS_TIER=gate`); periodic runs weekly/manually.
New test classification: safety/deterministic→gate | quality/Opus/non-deterministic→periodic | external service→periodic.

## Testing

```bash
bun test           # before every commit, free, <2s
bun run test:evals # before shipping, paid, diff-based (~$4/run max)
```

Both must pass before creating PR.

## Project structure

```
gstack/
├── browse/              # Headless browser CLI (Playwright)
│   ├── src/commands.ts  # Command registry (source of truth)
│   ├── src/snapshot.ts  # SNAPSHOT_FLAGS metadata
│   ├── test/            # Integration tests+fixtures
│   └── dist/            # Compiled binary
├── hosts/               # Typed host configs (one per AI agent)
│   └── index.ts         # Registry: exports all, derives Host type
├── scripts/
│   ├── gen-skill-docs.ts     # Template→SKILL.md generator
│   ├── host-config.ts        # HostConfig interface+validator
│   ├── host-adapters/        # Host-specific adapters
│   ├── resolvers/            # Template resolver modules
│   ├── skill-check.ts        # Health dashboard
│   └── dev-skill.ts          # Watch mode
├── test/
│   ├── helpers/              # skill-parser, session-runner, llm-judge, eval-store
│   ├── fixtures/             # Ground truth, planted-bug fixtures, eval baselines
│   ├── skill-validation.test.ts  # Tier 1: static (free, <1s)
│   ├── gen-skill-docs.test.ts    # Tier 1: generator quality (free)
│   ├── skill-llm-eval.test.ts   # Tier 3: LLM-as-judge (~$0.15)
│   └── skill-e2e-*.test.ts      # Tier 2: E2E via claude -p (~$3.85)
├── design/              # Design binary CLI (GPT Image API)
├── extension/           # Chrome extension (side panel+activity feed+CSS)
├── lib/                 # Shared libraries (worktree.ts)
├── contrib/add-host/    # Contributor-only /gstack-contrib-add-host
├── bin/                 # CLI utilities
├── setup                # One-time setup: build+symlink
├── SKILL.md.tmpl        # Template (edit this, run gen:skill-docs)
├── SKILL.md             # Generated (don't edit)
├── ETHOS.md             # Builder philosophy
└── package.json
```

Skill directories: qa-only, plan-design-review, design-review, ship, review,
plan-ceo-review, plan-eng-review, autoplan, benchmark, canary, codex,
land-and-deploy, office-hours, investigate, retro, document-release, cso,
design-consultation, design-shotgun, open-gstack-browser, connect-chrome,
setup-deploy, checkpoint, health, devex-review, guard, freeze, careful,
unfreeze, learn, browse, setup-browser-cookies, gstack-upgrade, design-html,
plan-devex-review.

## SKILL.md workflow

Generated from `.tmpl` templates:
1. Edit `.tmpl` file
2. Run `bun run gen:skill-docs` (or `bun run build`)
3. Commit both `.tmpl` and generated `.md`

New browse command: add to `browse/src/commands.ts`, rebuild.
New snapshot flag: add to `SNAPSHOT_FLAGS` in `browse/src/snapshot.ts`, rebuild.

**Merge conflicts on SKILL.md:** Never accept either side. Resolve on `.tmpl`
templates and `scripts/gen-skill-docs.ts`, then `bun run gen:skill-docs` to regenerate.

## Platform-agnostic design

Skills never hardcode framework-specific commands/patterns/directories.
1. Read CLAUDE.md for project config
2. If missing, AskUserQuestion
3. Persist answer to CLAUDE.md

## Writing SKILL templates

Templates are prompt templates read by Claude, not bash scripts.
Each bash block runs in a separate shell.

- Natural language for logic/state between blocks, not shell variables
- Detect branch names dynamically (`{{BASE_BRANCH_DETECT}}`)
- Keep bash blocks self-contained
- Express conditionals as English, not nested if/elif/else

## Browser interaction

Use `/browse` skill or `$B <command>`. Never use `mcp__claude-in-chrome__*` tools.

**Sidebar:** Before modifying sidepanel/background/content/sidebar-agent files,
read `docs/designs/SIDEBAR_MESSAGE_FLOW.md` first.

## Dev symlink awareness

`.claude/skills/gstack` may symlink to working directory (gitignored).
Check: `ls -la .claude/skills/gstack`. If symlinked:
- Template changes immediately affect all gstack invocations
- Breaking changes can break concurrent sessions
- During large refactors, `rm .claude/skills/gstack` to use global install

**Prefix:** `skill_prefix` in `~/.gstack/config.yaml`. `--no-prefix`/`--prefix` at setup.
Vendoring is deprecated. Use global install + `./setup --team`.

**Upgrade migrations:** Changes to on-disk state need migration scripts in
`gstack-upgrade/migrations/`. See CONTRIBUTING.md.

## Compiled binaries

**Never commit `browse/dist/` or `design/dist/`.** ~58MB Mach-O arm64 binaries,
tracked by historical mistake. Always use specific `git add <files>`, never `git add .`/`-A`.

## Commit style

Bisect commits. One logical change per commit. Split rename/rewrite/tests into separate commits.

## Community PR guardrails

Always AskUserQuestion before accepting commits that:
1. Touch ETHOS.md (no external edits, period)
2. Remove/soften promotional material (YC refs, founder voice intentional)
3. Change Garry's voice (tone/humor/directness not generic)

No exceptions. No auto-merging.

## CHANGELOG+VERSION style

Branch-scoped. Write at `/ship` time (Step 5), not during development.
4-digit format: `MAJOR.MINOR.PATCH.MICRO`.

Rules:
- Never fold into existing entry from prior version on main
- After merging main: own entry, higher VERSION, topmost position
- After edits: `grep "^## \[" CHANGELOG.md` to verify contiguous sequence
- Write for users, not contributors. "You can now..." not "Refactored the..."
- No internal details (TODOS.md, eval infra). Separate "For contributors" section.

## AI effort compression

Show both scales:

| Task | Human | CC+gstack | Ratio |
|------|-------|-----------|-------|
| Boilerplate | 2d | 15m | ~100x |
| Tests | 1d | 15m | ~50x |
| Feature | 1w | 30m | ~30x |
| Bug fix | 4h | 15m | ~20x |
| Architecture | 2d | 4h | ~5x |
| Research | 1d | 3h | ~3x |

## Search before building

1. "{runtime} {thing} built-in"
2. "{thing} best practice {year}"
3. Official docs

Three layers: tried-and-true (L1), new-and-popular (L2), first-principles (L3).
Prize L3. See ETHOS.md.

## E2E eval failure blame

Never claim "not related" without proof:
1. Run same eval on main, show it fails there too
2. Passes on main but fails on branch → it IS your change
3. Can't verify → say "unverified" and flag as risk

## Long-running tasks

Poll until completion. `sleep 180` + `TaskOutput` loop every 3min.
Full E2E: 30-45min = 10-15 polling cycles. Do all of them.

## E2E test fixtures

Never copy full SKILL.md into fixture (1500-2000 lines causes timeouts).
Extract only needed section. Run targeted tests in foreground, never `pkill` and restart.

## Publishing OpenClaw skills

```bash
clawhub publish openclaw/skills/gstack-openclaw-<name> \
  --slug gstack-openclaw-<name> --name "gstack <Name>" \
  --version X.Y.Z --changelog "description"
```

Auth: `clawhub login`, verify: `clawhub whoami`, search: `clawhub search gstack`.

## Deploying to active skill

```bash
cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main && bun run build
```
