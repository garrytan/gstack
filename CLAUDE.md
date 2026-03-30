# gstack development

## Commands

```bash
bun install          # install dependencies
bun test             # run free tests (browse + snapshot + skill validation)
bun run test:evals   # run paid evals: LLM judge + E2E (diff-based, ~$4/run max)
bun run test:evals:all  # run ALL paid evals regardless of diff
bun run test:gate    # run gate-tier tests only (CI default, blocks merge)
bun run test:periodic  # run periodic-tier tests only (weekly cron / manual)
bun run test:e2e     # run E2E tests only (diff-based, ~$3.85/run max)
bun run test:e2e:all # run ALL E2E tests regardless of diff
bun run eval:select  # show which tests would run based on current diff
bun run dev <cmd>    # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run build        # gen docs + compile binaries
bun run gen:skill-docs  # regenerate SKILL.md files from templates
bun run skill:check  # health dashboard for all skills
bun run dev:skill    # watch mode: auto-regen + validate on change
bun run eval:list    # list all eval runs from ~/.gstack-dev/evals/
bun run eval:compare # compare two eval runs (auto-picks most recent)
bun run eval:summary # aggregate stats across all eval runs
```

`test:evals` requires `ANTHROPIC_API_KEY`. Codex E2E tests (`test/codex-e2e.test.ts`)
use Codex's own auth from `~/.codex/` config — no `OPENAI_API_KEY` env var needed.
E2E tests stream progress in real-time (tool-by-tool via `--output-format stream-json
--verbose`). Results are persisted to `~/.gstack-dev/evals/` with auto-comparison
against the previous run.

**Diff-based test selection:** `test:evals` and `test:e2e` auto-select tests based
on `git diff` against the base branch. Each test declares its file dependencies in
`test/helpers/touchfiles.ts`. Changes to global touchfiles (session-runner, eval-store,
touchfiles.ts itself) trigger all tests. Use `EVALS_ALL=1` or the `:all` script
variants to force all tests. Run `eval:select` to preview which tests would run.

**Two-tier system:** Tests are classified as `gate` or `periodic` in `E2E_TIERS`
(in `test/helpers/touchfiles.ts`). CI runs only gate tests (`EVALS_TIER=gate`);
periodic tests run weekly via cron or manually. Use `EVALS_TIER=gate` or
`EVALS_TIER=periodic` to filter. When adding new E2E tests, classify them:
1. Safety guardrail or deterministic functional test? -> `gate`
2. Quality benchmark, Opus model test, or non-deterministic? -> `periodic`
3. Requires external service (Codex, Gemini)? -> `periodic`

## Testing

```bash
bun test             # run before every commit — free, <2s
bun run test:evals   # run before shipping — paid, diff-based (~$4/run max)
```

`bun test` runs skill validation, gen-skill-docs quality checks, and browse
integration tests. `bun run test:evals` runs LLM-judge quality evals and E2E
tests via `claude -p`. Both must pass before creating a PR.

## Project structure

```
gstack/
├── browse/          # Headless browser CLI (Playwright)
│   ├── src/         # CLI + server + commands
│   │   ├── commands.ts  # Command registry (single source of truth)
│   │   └── snapshot.ts  # SNAPSHOT_FLAGS metadata array
│   ├── test/        # Integration tests + fixtures
│   └── dist/        # Compiled binary
├── scripts/         # Build + DX tooling
│   ├── gen-skill-docs.ts  # Template → SKILL.md generator
│   ├── resolvers/   # Template resolver modules (preamble, design, review, etc.)
│   ├── skill-check.ts     # Health dashboard
│   └── dev-skill.ts       # Watch mode
├── test/            # Skill validation + eval tests
│   ├── helpers/     # skill-parser.ts, session-runner.ts, llm-judge.ts, eval-store.ts
│   ├── fixtures/    # Ground truth JSON, planted-bug fixtures, eval baselines
│   ├── skill-validation.test.ts  # Tier 1: static validation (free, <1s)
│   ├── gen-skill-docs.test.ts    # Tier 1: generator quality (free, <1s)
│   ├── skill-llm-eval.test.ts   # Tier 3: LLM-as-judge (~$0.15/run)
│   └── skill-e2e-*.test.ts       # Tier 2: E2E via claude -p (~$3.85/run, split by category)
├── qa-only/         # /qa-only skill (report-only QA, no fixes)
├── plan-design-review/  # /plan-design-review skill (report-only design audit)
├── design-review/    # /design-review skill (design audit + fix loop)
├── ship/            # Ship workflow skill
├── review/          # PR review skill
├── plan-ceo-review/ # /plan-ceo-review skill
├── plan-eng-review/ # /plan-eng-review skill
├── autoplan/        # /autoplan skill (auto-review pipeline: CEO → design → eng)
├── benchmark/       # /benchmark skill (performance regression detection)
├── canary/          # /canary skill (post-deploy monitoring loop)
├── codex/           # /codex skill (multi-AI second opinion via OpenAI Codex CLI)
├── land-and-deploy/ # /land-and-deploy skill (merge → deploy → canary verify)
├── office-hours/    # /office-hours skill (YC Office Hours — startup diagnostic + builder brainstorm)
├── investigate/     # /investigate skill (systematic root-cause debugging)
├── retro/           # Retrospective skill (includes /retro global cross-project mode)
├── bin/             # CLI utilities (gstack-repo-mode, gstack-slug, gstack-config, etc.)
├── document-release/ # /document-release skill (post-ship doc updates)
├── cso/             # /cso skill (OWASP Top 10 + STRIDE security audit)
├── design-consultation/ # /design-consultation skill (design system from scratch)
├── design-shotgun/  # /design-shotgun skill (visual design exploration)
├── connect-chrome/  # /connect-chrome skill (headed Chrome with side panel)
├── design/          # Design binary CLI (GPT Image API)
│   ├── src/         # CLI + commands (generate, variants, compare, serve, etc.)
│   ├── test/        # Integration tests
│   └── dist/        # Compiled binary
├── extension/       # Chrome extension (side panel + activity feed)
├── lib/             # Shared libraries (worktree.ts)
├── docs/designs/    # Design documents
├── setup-deploy/    # /setup-deploy skill (one-time deploy config)
├── .github/         # CI workflows + Docker image
│   ├── workflows/   # evals.yml (E2E on Ubicloud), skill-docs.yml, actionlint.yml
│   └── docker/      # Dockerfile.ci (pre-baked toolchain + Playwright/Chromium)
├── setup            # One-time setup: build binary + symlink skills
├── SKILL.md         # Generated from SKILL.md.tmpl (don't edit directly)
├── SKILL.md.tmpl    # Template: edit this, run gen:skill-docs
├── ETHOS.md         # Builder philosophy (Boil the Lake, Search Before Building)
└── package.json     # Build scripts for browse
```

## SKILL.md workflow

SKILL.md files are **generated** from `.tmpl` templates. To update docs:

1. Edit the `.tmpl` file (e.g. `SKILL.md.tmpl` or `browse/SKILL.md.tmpl`)
2. Run `bun run gen:skill-docs` (or `bun run build` which does it automatically)
3. Commit both the `.tmpl` and generated `.md` files

To add a new browse command: add it to `browse/src/commands.ts` and rebuild.
To add a snapshot flag: add it to `SNAPSHOT_FLAGS` in `browse/src/snapshot.ts` and rebuild.

**Merge conflicts on SKILL.md files:** NEVER resolve conflicts on generated SKILL.md
files by accepting either side. Instead: (1) resolve conflicts on the `.tmpl` templates
and `scripts/gen-skill-docs.ts` (the sources of truth), (2) run `bun run gen:skill-docs`
to regenerate all SKILL.md files, (3) stage the regenerated files. Accepting one side's
generated output silently drops the other side's template changes.

## Platform-agnostic design

Skills must NEVER hardcode framework-specific commands, file patterns, or directory
structures. Instead:

1. **Read CLAUDE.md** for project-specific config (test commands, eval commands, etc.)
2. **If missing, AskUserQuestion** — let the user tell you or let gstack search the repo
3. **Persist the answer to CLAUDE.md** so we never have to ask again

This applies to test commands, eval commands, deploy commands, and any other
project-specific behavior. The project owns its config; gstack reads it.

## Writing SKILL templates

SKILL.md.tmpl files are **prompt templates read by Claude**, not bash scripts.
Each bash code block runs in a separate shell — variables do not persist between blocks.

Rules:
- **Use natural language for logic and state.** Don't use shell variables to pass
  state between code blocks. Instead, tell Claude what to remember and reference
  it in prose (e.g., "the base branch detected in Step 0").
- **Don't hardcode branch names.** Detect `main`/`master`/etc dynamically via
  `gh pr view` or `gh repo view`. Use `{{BASE_BRANCH_DETECT}}` for PR-targeting
  skills. Use "the base branch" in prose, `<base>` in code block placeholders.
- **Keep bash blocks self-contained.** Each code block should work independently.
  If a block needs context from a previous step, restate it in the prose above.
- **Express conditionals as English.** Instead of nested `if/elif/else` in bash,
  write numbered decision steps: "1. If X, do Y. 2. Otherwise, do Z."

## Browser interaction

When you need to interact with a browser (QA, dogfooding, cookie setup), use the
`/browse` skill or run the browse binary directly via `$B <command>`. NEVER use
`mcp__claude-in-chrome__*` tools — they are slow, unreliable, and not what this
project uses.

## Vendored symlink awareness

When developing gstack, `.claude/skills/gstack` may be a symlink back to this
working directory (gitignored). This means skill changes are **live immediately** —
great for rapid iteration, risky during big refactors where half-written skills
could break other Claude Code sessions using gstack concurrently.

**Check once per session:** Run `ls -la .claude/skills/gstack` to see if it's a
symlink or a real copy. If it's a symlink to your working directory, be aware that:
- Template changes + `bun run gen:skill-docs` immediately affect all gstack invocations
- Breaking changes to SKILL.md.tmpl files can break concurrent gstack sessions
- During large refactors, remove the symlink (`rm .claude/skills/gstack`) so the
  global install at `~/.claude/skills/gstack/` is used instead

**Prefix setting:** Skill symlinks use either short names (`qa -> gstack/qa`) or
namespaced (`gstack-qa -> gstack/qa`), controlled by `skill_prefix` in
`~/.gstack/config.yaml`. When vendoring into a project, run `./setup` after
symlinking to create the per-skill symlinks with your preferred naming. Pass
`--no-prefix` or `--prefix` to skip the interactive prompt.

**For plan reviews:** When reviewing plans that modify skill templates or the
gen-skill-docs pipeline, consider whether the changes should be tested in isolation
before going live (especially if the user is actively using gstack in other windows).

## Compiled binaries — NEVER commit browse/dist/ or design/dist/

The `browse/dist/` and `design/dist/` directories contain compiled Bun binaries
(`browse`, `find-browse`, `design`, ~58MB each). These are Mach-O arm64 only — they
do NOT work on Linux, Windows, or Intel Macs. The `./setup` script already builds
from source for every platform, so the checked-in binaries are redundant. They are
tracked by git due to a historical mistake and should eventually be removed with
`git rm --cached`.

**NEVER stage or commit these files.** They show up as modified in `git status`
because they're tracked despite `.gitignore` — ignore them. When staging files,
always use specific filenames (`git add file1 file2`) — never `git add .` or
`git add -A`, which will accidentally include the binaries.

## Commit style

**Always bisect commits.** Every commit should be a single logical change. When
you've made multiple changes (e.g., a rename + a rewrite + new tests), split them
into separate commits before pushing. Each commit should be independently
understandable and revertable.

Examples of good bisection:
- Rename/move separate from behavior changes
- Test infrastructure (touchfiles, helpers) separate from test implementations
- Template changes separate from generated file regeneration
- Mechanical refactors separate from new features

When the user says "bisect commit" or "bisect and push," split staged/unstaged
changes into logical commits and push.

## Community PR guardrails

When reviewing or merging community PRs, **always AskUserQuestion** before accepting
any commit that:

1. **Touches ETHOS.md** — this file is Garry's personal builder philosophy. No edits
   from external contributors or AI agents, period.
2. **Removes or softens promotional material** — YC references, founder perspective,
   and product voice are intentional. PRs that frame these as "unnecessary" or
   "too promotional" must be rejected.
3. **Changes Garry's voice** — the tone, humor, directness, and perspective in skill
   templates, CHANGELOG, and docs are not generic. PRs that rewrite voice to be
   more "neutral" or "professional" must be rejected.

Even if the agent strongly believes a change improves the project, these three
categories require explicit user approval via AskUserQuestion. No exceptions.
No auto-merging. No "I'll just clean this up."

## CHANGELOG + VERSION style

**VERSION and CHANGELOG are branch-scoped.** Every feature branch that ships gets its
own version bump and CHANGELOG entry. The entry describes what THIS branch adds —
not what was already on main.

**When to write the CHANGELOG entry:**
- At `/ship` time (Step 5), not during development or mid-branch.
- The entry covers ALL commits on this branch vs the base branch.
- Never fold new work into an existing CHANGELOG entry from a prior version that
  already landed on main. If main has v0.10.0.0 and your branch adds features,
  bump to v0.10.1.0 with a new entry — don't edit the v0.10.0.0 entry.

**Key questions before writing:**
1. What branch am I on? What did THIS branch change?
2. Is the base branch version already released? (If yes, bump and create new entry.)
3. Does an existing entry on this branch already cover earlier work? (If yes, replace
   it with one unified entry for the final version.)

**Merging main does NOT mean adopting main's version.** When you merge origin/main into
a feature branch, main may bring new CHANGELOG entries and a higher VERSION. Your branch
still needs its OWN version bump on top. If main is at v0.13.8.0 and your branch adds
features, bump to v0.13.9.0 with a new entry. Never jam your changes into an entry that
already landed on main. Your entry goes on top because your branch lands next.

**After merging main, always check:**
- Does CHANGELOG have your branch's own entry separate from main's entries?
- Is VERSION higher than main's VERSION?
- Is your entry the topmost entry in CHANGELOG (above main's latest)?
If any answer is no, fix it before continuing.

**After any CHANGELOG edit that moves, adds, or removes entries,** immediately run
`grep "^## \[" CHANGELOG.md` and verify the full version sequence is contiguous
with no gaps or duplicates before committing. If a version is missing, the edit
broke something. Fix it before moving on.

CHANGELOG.md is **for users**, not contributors. Write it like product release notes:

- Lead with what the user can now **do** that they couldn't before. Sell the feature.
- Use plain language, not implementation details. "You can now..." not "Refactored the..."
- **Never mention TODOS.md, internal tracking, eval infrastructure, or contributor-facing
  details.** These are invisible to users and meaningless to them.
- Put contributor/internal changes in a separate "For contributors" section at the bottom.
- Every entry should make someone think "oh nice, I want to try that."
- No jargon: say "every question now tells you which project and branch you're in" not
  "AskUserQuestion format standardized across skill templates via preamble resolver."

## AI effort compression

When estimating or discussing effort, always show both human-team and CC+gstack time:

| Task type | Human team | CC+gstack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate / scaffolding | 2 days | 15 min | ~100x |
| Test writing | 1 day | 15 min | ~50x |
| Feature implementation | 1 week | 30 min | ~30x |
| Bug fix + regression test | 4 hours | 15 min | ~20x |
| Architecture / design | 2 days | 4 hours | ~5x |
| Research / exploration | 1 day | 3 hours | ~3x |

Completeness is cheap. Don't recommend shortcuts when the complete implementation
is a "lake" (achievable) not an "ocean" (multi-quarter migration). See the
Completeness Principle in the skill preamble for the full philosophy.

## Search before building

Before designing any solution that involves concurrency, unfamiliar patterns,
infrastructure, or anything where the runtime/framework might have a built-in:

1. Search for "{runtime} {thing} built-in"
2. Search for "{thing} best practice {current year}"
3. Check official runtime/framework docs

Three layers of knowledge: tried-and-true (Layer 1), new-and-popular (Layer 2),
first-principles (Layer 3). Prize Layer 3 above all. See ETHOS.md for the full
builder philosophy.

## Local plans

Contributors can store long-range vision docs and design documents in `~/.gstack-dev/plans/`.
These are local-only (not checked in). When reviewing TODOS.md, check `plans/` for candidates
that may be ready to promote to TODOs or implement.

## E2E eval failure blame protocol

When an E2E eval fails during `/ship` or any other workflow, **never claim "not
related to our changes" without proving it.** These systems have invisible couplings —
a preamble text change affects agent behavior, a new helper changes timing, a
regenerated SKILL.md shifts prompt context.

**Required before attributing a failure to "pre-existing":**
1. Run the same eval on main (or base branch) and show it fails there too
2. If it passes on main but fails on the branch — it IS your change. Trace the blame.
3. If you can't run on main, say "unverified — may or may not be related" and flag it
   as a risk in the PR body

"Pre-existing" without receipts is a lazy claim. Prove it or don't say it.

## Long-running tasks: don't give up

When running evals, E2E tests, or any long-running background task, **poll until
completion**. Use `sleep 180 && echo "ready"` + `TaskOutput` in a loop every 3
minutes. Never switch to blocking mode and give up when the poll times out. Never
say "I'll be notified when it completes" and stop checking — keep the loop going
until the task finishes or the user tells you to stop.

The full E2E suite can take 30-45 minutes. That's 10-15 polling cycles. Do all of
them. Report progress at each check (which tests passed, which are running, any
failures so far). The user wants to see the run complete, not a promise that
you'll check later.

## E2E test fixtures: extract, don't copy

**NEVER copy a full SKILL.md file into an E2E test fixture.** SKILL.md files are
1500-2000 lines. When `claude -p` reads a file that large, context bloat causes
timeouts, flaky turn limits, and tests that take 5-10x longer than necessary.

Instead, extract only the section the test actually needs:

```typescript
// BAD — agent reads 1900 lines, burns tokens on irrelevant sections
fs.copyFileSync(path.join(ROOT, 'ship', 'SKILL.md'), path.join(dir, 'ship-SKILL.md'));

// GOOD — agent reads ~60 lines, finishes in 38s instead of timing out
const full = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
const start = full.indexOf('## Review Readiness Dashboard');
const end = full.indexOf('\n---\n', start);
fs.writeFileSync(path.join(dir, 'ship-SKILL.md'), full.slice(start, end > start ? end : undefined));
```

Also when running targeted E2E tests to debug failures:
- Run in **foreground** (`bun test ...`), not background with `&` and `tee`
- Never `pkill` running eval processes and restart — you lose results and waste money
- One clean run beats three killed-and-restarted runs

## Deploying to the active skill

The active skill lives at `~/.claude/skills/gstack/`. After making changes:

1. Push your branch
2. Fetch and reset in the skill directory: `cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main`
3. Rebuild: `cd ~/.claude/skills/gstack && bun run build`

Or copy the binaries directly:
- `cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse`
- `cp design/dist/design ~/.claude/skills/gstack/design/dist/design`
