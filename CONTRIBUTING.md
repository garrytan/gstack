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

### First free check (no API key, no browser)

```bash
bun install --frozen-lockfile
bun run typecheck        # expect no output and exit 0 (about a second)
bun run typecheck:test   # expect "test typecheck ratchet: N known diagnostics, none new."
```

`typecheck` covers product code (`browse/src`, `lib`, `scripts`, `bin`, `hosts`, and the other
entries in `tsconfig.json`) and must stay at zero errors. `typecheck:test` holds test code to the
committed `scripts/typecheck-test-baseline.json`: a new or repeated diagnostic fails and names
the file, TS code and message; fixing diagnostics also fails until you lock the smaller allowance
in with `bun run typecheck:test --write-baseline`. Editing `lib/cso/*.ts`? Run
`bun run format:cso` before committing; CI runs `format:cso:check`. All three run in the required
`free-tests` check.

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

**What CI does on a fork PR.** GitHub never gives a fork PR this repository's
secrets, so CI runs everything that needs none: the required `free-tests` check
(the Linux free suite, typecheck, the macOS and Windows gates), Windows Free
Tests, Skill Docs Freshness, Workflow Lint, Version Gate, Quality gate, the
make-pdf gate, and any path-triggered gates your change touches. E2E Evals
still builds the CI image from your `Dockerfile.ci` without publishing it, and
skips its paid eval jobs, which need provider API keys. That skip is expected
and does not block your PR. It is also not a pass: a maintainer runs the paid
evals from a branch in this repository before merging. A first-time
contributor's runs wait for a maintainer to approve them.

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
├── browse/                      <- /browse skill + gstack's own browser engine (the fallback)
│   ├── src/                     <- TypeScript source
│   └── dist/                    <- compiled binary (gitignored)
├── lib/
│   ├── aside-render.ts          <- local-HTML rendering: Aside first, browse engine fallback
│   └── design-catalog.ts        <- typed design anti-pattern catalog; review/design-checklist.md is generated from it
├── bin/
│   └── gstack-render.ts         <- the CLI skills call to render a local HTML file
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

Codex evals and the GPT benchmark adapter default to `gpt-6-astra`:
explicit model > `GSTACK_CODEX_MODEL` > default. Claude capture and judge
defaults are `claude-fable-5-1`, resolved through `lib/eval-model.ts`:

- Claude session, PTY, and Agent SDK eval runners and the Claude benchmark adapter: explicit model > `EVALS_MODEL` > `GSTACK_EVAL_MODEL_CAPTURE` > `GSTACK_EVAL_MODEL` > default.
- Shared judge calls (including benchmark quality scoring): explicit model > `GSTACK_EVAL_MODEL_JUDGE` > `GSTACK_EVAL_MODEL` > default. `EVALS_MODEL` applies to capture runners, not judges.

Warmup stays on `claude-haiku-4-5`; distill stays on
`claude-haiku-4-5-20251001`. Explicit test and historical benchmark model
selections still win. Known frontier defaults are maintained in releases;
there is no automatic model discovery. Paid-run costs shown below are
historical estimates from before this default change, not measurements of
the new defaults.

### Which command do I run?

| I want to… | Command | Cost / time | Needs |
|---|---|---|---|
| Check an ordinary edit quickly | `bun run test:quick` | Free, about a minute | Bun 1.4.2 |
| Run one free test file while repairing | `bun test <file>` | Free, seconds | Never bare `bun test` for the suite |
| Run full free acceptance before publishing | `bun run test` | Free, a few minutes | Bun 1.4.2 |
| Run the full free suite from a small machine | `bun run test:ubicloud` | Free suite on a billed 16-vCPU VM, about 5 minutes | `UBICLOUD_API_KEY` |
| Run the curated Windows-safe subset | `bun run test:windows` (CI: six `windows-latest` jobs) | Free | Windows, Git Bash |
| Refresh the Windows duration seed | `gh workflow run windows-free-tests.yml --ref <branch> -f record_durations=true`, then commit the `free-test-durations-windows` artifact | Free CI runners | Pushed branch, `gh` with workflow rights |
| Run a native Windows or Dia qualification campaign | `gh workflow run native-qualification.yml --ref <branch> -f mode=<mode>` ([modes](docs/TESTING_INTERNALS.md#windows-free-lane)) | Free CI runners | Pushed branch, `gh` with workflow rights |
| Preview which paid cases my diff selects | `bun run eval:select` (PR profile; `--profile full` for the plain touchfile selection) | Free | — |
| Preview the CI paid slice plan | `bun run scripts/test-paid-shards.ts --tier periodic --list --slice-budget 420 --jobs 2` (diff-selected; `EVALS_ALL=1` lists everything) | Free | — |
| Run paid coverage for my change (agents: detached) | `bun run eval:bg:pr` (foreground: `bun run test:pr`) | API spend for the selected cases only; about 10 minutes when dispatched to CI | Dispatch: a clean, pushed HEAD and `gh`. Local fallback: `ANTHROPIC_API_KEY`, Claude Code CLI, a plain terminal |
| Run the full gate + periodic censuses before a release | `bun run eval:bg:release` (foreground: `bun run test:release`) | The largest API spend; local runs are capped at 4 hours | Same as above |
| Run one paid tier | `bun run test:gate:sharded` / `bun run test:periodic:sharded` (detached: `eval:bg:gate` / `eval:bg:periodic`) | API spend for that tier | Same as above |
| Run one paid case as its CI panel | `bun run scripts/test-paid-shards.ts --tier <tier> --case <case-id> --trials 3` | API spend for that case | Same as above |
| Validate gate cases on a branch in CI | `gh workflow run evals.yml --ref <branch> -f evals_all=true` | CI runners + API spend | Pushed branch, `gh` with workflow rights |
| Validate periodic cases on a branch in CI | `gh workflow run evals-periodic.yml --ref <branch>` (periodic lane only) | CI runners + API spend | Pushed branch, `gh` with workflow rights |
| Validate periodic cases plus the weekly gate census on a branch | `gh workflow run evals-periodic.yml --ref <branch> -f include_gate_census=true` | CI runners + API spend | Pushed branch, `gh` with workflow rights |
| Run the opt-in ML, gitleaks and Swift checks | `gh workflow run platform-qualification.yml --ref <branch>` | Free CI runners | Pushed branch, `gh` with workflow rights |
| Look at past local eval runs | `bun run eval:list` / `eval:compare` / `eval:summary` | Free | Local eval history |
| See a case's pass rate across recent weekly runs | `bun run eval:pass-rates --case <case-id>` | Free | `gh` with repo read access |
| See the audit success metrics and weekly health | `bun run test:health [--since-days 7] [--json] [--enforce]` | Free; 5–20 minutes of `gh` reads | `gh` with repo read access |

Old command names are listed under [Retired commands](#retired-commands).

### Setup

Development and tests require Bun 1.4.2 or newer; CI pins and tests 1.4.2.
Earlier Linux versions can close unrelated live file descriptors during
subprocess garbage collection, causing intermittent browser and HTTP fixture
failures ([upstream diagnosis](https://github.com/oven-sh/bun/issues/34785#issuecomment-5020318035)).

```bash
# 1. Copy .env.example and add your API key
cp .env.example .env
# Edit .env → set ANTHROPIC_API_KEY=sk-ant-...

# 2. Install deps (if you haven't already)
bun install
```

Bun auto-loads `.env` — no extra config. Conductor workspaces inherit `.env` from the main worktree automatically (see "Conductor workspaces" below).

### Test tiers

Functional QA changes need native fixture proof as well as prompt checks. Add declared
CLI or loopback API/worker contracts in isolated temporary repositories, outside this
checkout. Exercise success and adverse paths, durable effects, and setup failure.
Report-only evaluations must leave mutation-capable tools available and independently
detect forbidden writes, including an edit later restored; a clean final diff is not
enough. Validate the observer with deliberately bad controls before a paid run.

For exploratory regressions, retain the actual pre-repair failure, post-repair pass,
original probe and adjacent happy path. Automatic caller tests must enter through
review/ship, not tell the agent to run the component being tested. Documentation tests
must prove the real child completed and the parent used its result before publication;
the existing dispatch-only test is narrower evidence. Register new cases and all
consumed section/resolver inputs in touchfiles, tiers and the PR profile so they run.
Share sanitized reproduction commands and fixture evidence when reporting a problem,
never credentials, private payloads or an entire unreviewed agent transcript.

| Tier | Runs through | What it tests |
|------|--------------|---------------|
| 1 — Static | `bun run test` (free) | Command validation, snapshot flags, Aside contract pins, render-wrapper option mapping, SKILL.md correctness, TODOS-format.md refs, observability unit tests |
| 2 — E2E | The sharded paid runner (`bun run eval:bg:pr`, `eval:bg:release`) | Full skill execution via `claude -p`, PTY and Agent SDK sessions |
| 3 — LLM eval | The same runner; `test/skill-llm-eval*.test.ts` | LLM-as-judge scoring of generated SKILL.md docs |

Pick commands from [Which command do I run?](#which-command-do-i-run).

The PR paid gate uses an explicit short behavioral profile. Every selected quality
judge remains included; the manifest lists deferred behaviors separately from
passes. Unknown source dependencies restore the full gate; the job summary names
each file that caused it and its fix ([PR paid lane fallback](docs/TESTING_INTERNALS.md#pr-paid-lane-fallback)).
A new prompt without
registered coverage fails planning. Known broad behaviors remain visibly deferred
when their prompts change; they do not silently gain PR-pass credit. The full
gate and periodic censuses run fresh weekly and on manual
dispatch of `evals-periodic.yml`; `bun run eval:bg:release` runs both.
Some broad behavioral failures will therefore be found after the PR gate.

Blocking paid lanes (the PR gate and the weekly periodic + gate census) aim for
a median of about 10 minutes including setup. The planner packs recorded wall
times (`scripts/paid-test-durations.json`, per tier) into as many 7-minute
(420-second) runners as the work needs, one file or a tightly packed group each;
files whose cases are short but whose total is long run one case per runner.
Matrix size and each runner's job timeout come from that plan, so a hung runner
fails within its own ceiling. Preview it for free with
`bun run scripts/test-paid-shards.ts --tier periodic --list --slice-budget 420 --jobs 2`.
Complete start-to-finish flows belong to the `marathon` tier
(`describeE2ETier('marathon')`), which runs only in the non-blocking
`evals-marathon.yml` lane (weekly and on dispatch) and never gates a merge.

Verdicts: paid evals never retry. Each case's kind in `E2E_KINDS`
(`test/helpers/touchfiles-data.ts`) fixes its trials before the run, from the
constants in `EVAL_POLICY` (`test/helpers/periodic-exclude-data.ts`):

- `rule` (the default): one trial; any failed assertion fails the case. Use it
  when nothing stochastic decides the verdict, or when the verdict checks a
  contract the product must meet every run (no writes in plan mode, a question
  before a decision, a skill-mandated step, no leaked secret).
- `behavior`: a panel of 3 independent trials run as parallel case shards,
  PASS at 2 or more with no contract violation (`expectContract()`). Use it only
  when a live model choice decides the verdict and an occasional deviation is
  acceptable product behavior; the one-line reason goes in `BEHAVIOR_WHY`.
- `judge`: an LLM judge scoring a fixed input; 3 samples of the same prompt,
  gated on the per-dimension mean (booleans on a majority) against the
  unchanged threshold. An erroring sample fails the panel and is never resampled.

A timed-out, crashed or infrastructure-failed trial counts as a failed trial and
is reported with its class; a missing trial makes the case INCOMPLETE, which
fails the lane. A 2-of-3 pass is reported as `PASS 2/3` with the failed trial's
cause, never as a clean pass. Case budgets and thresholds never change with
this policy. Quarantine (`CASE_QUARANTINE`) and history are described in
`docs/TESTING_INTERNALS.md`; `bun run eval:pass-rates --case <id>` shows a
case's per-trial pass rate with its Wilson interval.

**A census went red?** Follow [docs/evals/census-red.md](docs/evals/census-red.md):
read the red line, inspect its evidence with `bun run eval:pass-rates --run <id>`,
check `--reds` and `--headroom`, repair with a free regression test, and only
then spend one paid run with the line's `after a repair:` command. A red census
on `main` is reported on the weekly tracking issue; a census dispatched on a
branch writes the same report to its run summary and `census-report` artifact.

CI enables verified first-attempt reuse for 16 workflow quality judges for
24 hours within the same PR. The cookie workflow's custom input and the other 11
quality cases stay fresh. PR-profile E2E shards that run once (no retry, so the
pass is provably a first attempt) reuse a pass from the same PR when every
consumed input is byte-identical: the test's import closure, every tracked file
its registered cases' touchfiles and the global touchfiles match, the runner and
workflow, the child's EVALS_/GSTACK_/CLAUDE_/ANTHROPIC_ environment (secret
presence only), the CI image and Claude CLI version (`scripts/e2e-shard-reuse.ts`).
A computed case registration or a touchfile pattern matching nothing keeps the
shard fresh. The weekly census, marathon and release lanes never reuse. Local runs stay fresh unless
the complete scoped cache and runtime configuration is supplied. The key includes complete prompt bytes, generated inputs,
fixtures, runner/rubric code, installed dependencies, model settings and runtime.
The current assertions validate a reused score again. Records retain the original
run, revision and time; reuse never renews that time. Failed, retried, partial or
unknown-input results cannot be reused.
`EVALS_FRESH=1` bypasses reuse; periodic and release runs always bypass it.

Timing goals are under one minute for edit feedback, 3–5 minutes for typical PR
checks, and 60–90 seconds for complete free test execution across isolated CI
machines. They are targets, not timeout reductions or guarantees. The complete
local suite uses available CPU affinity, up to 16 workers on Linux and six on
macOS and Windows; use `test:quick` for the shorter edit loop. On a small dev
box, container, or cloud sandbox, `bun run test:ubicloud` runs the complete suite
on a fresh 16-vCPU Ubicloud VM with the CI lane's environment instead (about
four and a half minutes end to end, including VM boot and setup). The
historical six-worker result below and the
[four-CPU portfolio comparison](docs/TEST_PORTFOLIO.md#measurement-contract)
are machine-specific measurements. CI setup, build and queue time are reported
separately. Refresh measurements with `bun run test:ubicloud --record-durations`
(a laptop recording is not an acceptable seed; see
[free suite duration seed](docs/TESTING_INTERNALS.md#free-suite-duration-seed));
before publication, classify new regressions for quick feedback using that seed
and the existing `QUICK_CORE` list. Do not classify unknown files as fast or use
quick results as release acceptance. The runner retains full logs in
`.context/free-test-logs/` and explains the next repair step on failure; see
[free-runner recovery](docs/TESTING_INTERNALS.md) for details. For full acceptance,
the required free CI lane packs the complete inventory across isolated runners,
then checks every shard's receipt before reporting success. Local worker counts
remain bounded to avoid browser/process contention.

Historical measurements from 2026-09-21:

| Run | Coverage | Elapsed |
|---|---|---|
| Local edit feedback | 861 of 993 free test files | 38 seconds |
| Local complete free suite | All 993 files, six workers | 4m 35s |
| Complete Linux CI | All 993 files, 20 isolated runners | 1m 40s across test steps; 3m 7s including setup and aggregation |

After the 2026-09-29 test audit ([evidence](docs/test-audit-2026-09.md)):

| Run | Coverage | Elapsed |
|---|---|---|
| Complete free suite, `bun run test:ubicloud` (standard-16) | All 857 files, 20,302 passing tests | 136 seconds on the VM; 1,738 seconds of recorded serial test time |

The [Linux CI run](https://github.com/garrytan/gstack/actions/runs/35642667809)
on `25030d68` included one recorded successful retry. Its slowest test step was 77 seconds;
staggered starts made the complete test span longer. Typical PR paid-gate timing
still needs measurement on a small change. Explicitly exempt free-only runner
changes do not select paid work; mapped dependencies take precedence, and unknown
dependencies retain the broad fallback. See the
[coverage boundaries](docs/TEST_PORTFOLIO.md#repeated-work-removed).

When a paid eval fails, fix the product or the harness and add the captured case as one row in
the detector's owner test (the detector → owner table is in
[TEST_PORTFOLIO.md](docs/TEST_PORTFOLIO.md#detector-owner-tests)); never add a new per-incident file.
A row is one `describe` block or table entry next to the others, for example a new
`describe('eng-cache-writes-at', …)` in `test/eng-first-review.test.ts` that loads its fixture and asserts
`engFirstReviewAUQ` on the captured call. Run `bun test <owner-test>`, then
`bun test test/test-of-test-ratchet.test.ts`: the ratchet fails on any new test file that imports only
`test/` code, or that reads a paid test file's source and slices it, and names the owner test to use instead.

Tests on templates and generated SKILL.md use `test/helpers/prompt-structure.ts` (`between`,
`expectTokens`, `expectAbsent`, `expectOrdered`, `expectMentions`): machine-read tokens and step order
exactly, safety rules as case-insensitive keyword co-occurrence in one sentence. Don't pin English
sentences; see [the test value bar](docs/test-value-bar.md).

Follow [Validation discipline in AGENTS.md](AGENTS.md#validation-discipline):
reproduce known failures with focused checks, verify adjacent source and
generation contracts, then run the affected and remaining required selected
evaluations. Finish review fixes and release preparation before running the
full free suite once on the frozen code. During repairs, focused checks replace
a full-suite run before every commit.

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
in a `flake-ledger-<shard>` JSONL artifact; the weekly test-health run fails when
a file flakes in more than 5% of main runs, see
[flake ledger](docs/TESTING_INTERNALS.md#flake-ledger)).
Working in a cloud sandbox? Run `scripts/sandbox-doctor.sh` once per boot to
make the suite run green (details in
[docs/TESTING_INTERNALS.md](docs/TESTING_INTERNALS.md)), or skip the sandbox's
limits entirely with `bun run test:ubicloud`.
Don't type bare `bun test` for the suite: it walks the whole repo, loads paid
eval files, and misses the strict classifier. No API keys needed.

- **Skill parser tests** (`test/skill-parser.test.ts`) — Extracts every `$B` command from SKILL.md bash code blocks and validates against the command registry in `browse/src/commands.ts`. Catches typos, removed commands, and invalid snapshot flags.
- **Skill validation tests** (`test/skill-validation.test.ts`) — Validates that SKILL.md files reference only real commands and flags, and that command descriptions meet quality thresholds. Also cross-checks the skill inventory in AGENTS.md and docs/skills.md.
- **Aside driver contract** (`test/aside-driver.test.ts`) — Browser behaviour in skills is written against `scripts/resolvers/aside.ts` (`{{ASIDE_SETUP}}`) and verified live against the Aside CLI on a Mac. CI cannot run Aside, so the Aside E2E tests self-skip where `aside` is not installed; the static pins (detection, fallback hand-off, consent, credential, one-flow-per-script, sentinel) are what CI proves.
- **Aside render wrapper** (`test/aside-render.test.ts`) — Pins the option mapping and generated script of `lib/aside-render.ts` everywhere, and drives both engines hermetically with fake `aside` / `browse` executables (probe classification, the stdout contract, loopback-server policy, failure paths, the timeout kill, engine choice and the mid-run fallback); the live render (PDF + screenshot through a real Aside) runs only where Aside is open and self-skips elsewhere. make-pdf's render gates (`make-pdf/test/e2e/*-gate.test.ts`) and `test/skill-e2e-diagram.test.ts` are engine-agnostic: they run through whichever engine resolves (`browserAvailable()` — Aside, or the browse binary `bun run build:gates` compiles, which is what Linux CI does) and skip only when neither exists.
- **Render CLI** (`test/gstack-render-cli.test.ts`) — Pins `bin/gstack-render.ts` against a fake daemon (`GSTACK_SKIP_ASIDE=1` + `GSTACK_BROWSE_BIN`): argv guards exit 1 with the usage line, `--help` exits 0, `ENGINE=` first then `OK <path>` then fenced `EVAL` / `PAGE_ERRORS`, `--serve-root` containment, the no-browser first line, and prompt exit after a successful render. `make-pdf/test/cli-exit-codes.test.ts` and `make-pdf/test/setup-smoke.test.ts` pin the `pdf` binary's error-to-exit-code map and `$P setup`'s engine report.
- **Generator tests** (`test/gen-skill-docs.test.ts`) — Tests the template system: verifies placeholders resolve correctly, output includes value hints for flags (e.g. `-d <N>` not just `-d`), enriched descriptions for key commands (e.g. `is` lists valid states, `press` lists key examples).
- **Design detector, catalog, and DESIGN.md** (`test/gstack-design-detect.test.ts`, `test/design-detect-contract.test.ts`, `test/design-catalog.test.ts`, `test/design-checklist-sync.test.ts`, `test/design-md.test.ts`, `test/frontend-scope.test.ts`, `test/impeccable-fixtures.test.ts`) — Drive `bin/gstack-design-detect.ts` through the fake engine in `test/fixtures/fake-impeccable.ts` (probe order, the never-execute-a-repository-file rule, the `--changed` target allow-list, `design_detector: off`, analytics lines, output sanitizing), pin the catalog invariants and the generated `review/design-checklist.md`, round-trip the open DESIGN.md reader/writer, and check the real engine captures (`test/fixtures/impeccable-*.json`, engine 0.1.3) against the contract. `test/dom-dump-hygiene.test.ts` runs `lib/dom-dump.js` in a real Chromium page through the built browse binary; it self-skips without the binary and is opt-in outside CI (`GSTACK_DOM_DUMP_HYGIENE=1`).
- **Tier-alignment invariant** (`test/e2e-tier-alignment.test.ts`) — For every self-gated `test/skill-e2e-*.test.ts` named in a touchfiles dep list, the file's `EVALS_TIER` self-gate must match its declared tier in `E2E_TIERS`. Kills the "inert demotion" class where a test is re-tiered in `touchfiles.ts` but the file still gates on the old tier and keeps running in the wrong lane. Unmapped or mixed-tier files are reported, never silently skipped.
- **Catalog budget** (`test/catalog-budget.test.ts`) — Caps the aggregate discovery surface: the sum of every skill's frontmatter `name` + `description` (what every host loads at discovery, every session) must stay under 1,171 token-equivalents, with a 260-byte per-skill cap. Counting goes through the shared census in `test/helpers/skill-census.ts` (physical files vs authored skills vs registry entries — three deliberately different counts). Adding a skill? The failure message carries the re-measure + ratchet protocol.
- **Context-budget ratchet** (`test/context-budget-ratchet.test.ts`) — CI ceilings on the two token ledgers the catalog budget doesn't cover: the always-on full-frontmatter aggregate and each skill's per-invocation eager tokens (SKILL.md + forced-read references), graded against `test/fixtures/context-budget.json` via `lib/context-bill.ts`. New skills fail until they have a ceiling; ceilings for removed skills must be pruned. Legitimate growth or a landed reduction: re-run `bun test/helpers/capture-context-budget.ts` and commit the refreshed fixture in the same commit, so the change is a visible decision in the diff.
- **Dependency security regressions** (`test/dependency-security.test.ts`) — Run `bun test test/dependency-security.test.ts` to check the resolved `sharp` and `adm-zip` version floors, load Sharp, verify ordinary ZIP extraction, and reject extraction through destination-file and destination-directory symlinks. The symlink cases skip Windows. These checks complement the OSV scan; they do not change its existing exceptions.

### Tier 2: E2E via `claude -p`

Spawns `claude -p` as a subprocess with `--output-format stream-json --verbose`, streams NDJSON for real-time progress, and scans for browse errors. This is the closest thing to "does this skill actually work end-to-end?"

```bash
# Must run from a plain terminal — can't nest inside Claude Code or Conductor
EVALS_RUN_ID="local-$(bun -e 'console.log(crypto.randomUUID())')" EVALS=1 bun test test/skill-e2e-*.test.ts
```

- Gated by `EVALS=1` env var (prevents accidental expensive runs)
- Auto-skips if running inside Claude Code (`claude -p` can't nest)
- API connectivity pre-check — fails fast on ConnectionRefused before burning budget
- Real-time progress to stderr: `[Ns] turn T tool #C: Name(...)`
- Saves full NDJSON transcripts and failure JSON for debugging
- Tests live in `test/skill-e2e-*.test.ts` (split by category), runner logic in `test/helpers/session-runner.ts`

Supply a fresh `EVALS_RUN_ID` for each invocation, including detached runs below.
Functional QA and documentation cases refuse acceptance without it. CI supplies
its own run/attempt/job/slice identity; see [Testing internals](docs/TESTING_INTERNALS.md)
for the retained native-capture artifacts.

**Hermetic by default.** Every E2E runner (claude -p, the real-PTY plan-mode
runner, the Agent SDK runner, plus the codex and gemini runners) spawns its child
through `test/helpers/hermetic-env.ts`: an allowlist-scrubbed environment, a fresh
seeded `CLAUDE_CONFIG_DIR`, a temp `GSTACK_HOME`, and `--strict-mcp-config`. Your
operator `~/.claude` config, MCP servers (gbrain, Conductor), skills, `~/.gstack`
decision logs, and `CONDUCTOR_*` env never leak into the child. The `GITHUB_`
and `EVALS_` prefix rules preserve CI metadata but reject credential-shaped
names such as `GITHUB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, and
`GITHUB_APP_PRIVATE_KEY`. The screen reads every underscore-separated segment, so a trailing qualifier does not carry a name past it (`GITHUB_APP_PRIVATE_KEY_BASE64`, `GITHUB_TOKEN_1`), while a segment that merely contains a credential word stays metadata (`GITHUB_PATH`, `GITHUB_TOKENIZER`). Named provider auth, runner `extraAllow` entries, and
per-test overrides are deliberate exceptions; a name-based rule cannot identify
a secret assigned to an arbitrary metadata name. This keeps local eval signal
aligned with CI instead of disagreeing for reasons unrelated to the code under
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

**Live progress:** a detached run's log under `~/.gstack-dev/eval-runs/` streams each shard's result as it lands; for a CI run use `gh run watch <run-id>`. Per-test progress is in each shard's `progress.log`.

**Eval history tools:**

```bash
bun run eval:list            # list all eval runs (turns, duration, cost per run)
bun run eval:compare         # compare two runs — shows per-test deltas + Takeaway commentary
bun run eval:summary         # aggregate stats + per-test efficiency averages across runs
bun run eval:pass-rates      # per-case trial pass rates + Wilson intervals from recent weekly runs (--case, --runs, --dir, --backfill, --json, --gate)
bun run eval:pass-rates --reds       # verdict reds per census by failure class and cause, all-green probability
bun run eval:pass-rates --headroom   # slowest session per case vs its armed budget (alarm above 85% in --gate)
bun run eval:pass-rates --run <id>   # one census's reds with their values and fetched transcript evidence
```

**Detached runs for agents and long suites.** When an agent (or you, for a run
you don't want to babysit) launches a long eval, use the `eval:bg:*` scripts
(`scripts/eval-bg.ts`). Each picks a backend and prints it:

- **dispatch** (a clean HEAD pushed to garrytan/gstack, with `gh`): runs the
  lane in CI on that exact revision and follows the run from a local log;
- **local** (anything else, or `--local`): runs the sharded paid runner on this
  machine, capped at ceil(1.5 × planned serial seconds / `EVALS_JOBS`) + 20
  minutes, at most 4 hours (`--timeout SECS` overrides).

Both run under `bin/gstack-detach`: a fresh session that escapes a
turn-boundary SIGTERM, a `caffeinate` wrapper that blocks idle-sleep, a machine-wide
`gstack-evals` lock so concurrent worktrees serialize instead of saturating the
model API, a run-scoped log under `~/.gstack-dev/eval-runs/`, and a guaranteed
`### gstack-detach EXIT=<code> ###` sentinel so a poller never mistakes silence
for success. `bun run scripts/eval-bg.ts --help` lists the flags and
`bun run scripts/eval-bg.ts status <log-or-run-id>` reconnects to a run.

```bash
bun run eval:bg:pr           # changed coverage (CI: evals.yml, evals_all=false)
bun run eval:bg:release      # fresh full gate + periodic (CI: both workflows)
bun run eval:bg:gate         # gate tier (CI: evals.yml, evals_all=true)
bun run eval:bg:periodic     # periodic tier (CI: evals-periodic.yml)
```

The local backend runs through
the sharded paid runner (`scripts/test-paid-shards.ts`, also available directly
as `bun run test:gate:sharded` / `bun run test:periodic:sharded`): one Bun
process per test file, an external wall-clock timeout that kills the shard's
whole process group (stray `claude`/`codex` grandchildren included), a per-shard
eval dir (`GSTACK_EVAL_DIR=<evalDir>/shards/<slug>/`), and an aggregate that
distinguishes failed vs timed-out vs never-started shards. The runner also
selects by diff: shards untouched by your branch are reported as
skipped-by-diff, with a selection banner naming the reason (`EVALS_ALL=1`
forces everything). `EVALS_JOBS` sets how many shard processes run at once
(default 8; `test:pr` sets 2); `EVALS_CONCURRENCY` is bun's concurrency WITHIN a shard
(default 2) — they are deliberately separate knobs. `eval:list`,
`eval:compare`, `eval:summary`, and `eval:pass-rates` are shard-aware. Humans running
`bun run test:pr` foreground in their own terminal don't need this — Ctrl-C
is intended there.

**Eval comparison commentary:** `eval:compare` generates natural-language Takeaway sections interpreting what changed between runs — flagging regressions, noting improvements, calling out efficiency gains (fewer turns, faster, cheaper), and producing an overall summary. This is driven by `generateCommentary()` in `eval-store.ts`.

Artifacts are never cleaned up — they accumulate in `~/.gstack-dev/` for post-mortem debugging and trend analysis.

### Tier 3: LLM-as-judge

Uses `claude-fable-5-1` by default to score generated SKILL.md docs on three dimensions.
Override the judge model per run with `GSTACK_EVAL_MODEL_JUDGE`:

- **Clarity** — Can an AI agent understand the instructions without ambiguity?
- **Completeness** — Are all commands, flags, and usage patterns documented?
- **Actionability** — Can the agent execute tasks using only the information in the doc?

Each dimension is scored 1-5 by a panel of 3 samples of the same prompt, drawn
concurrently; each dimension's panel mean must meet that judge's threshold (≥ 4
for most dimensions; see each case). An erroring sample fails the panel. There's also a regression test that compares generated docs against the hand-maintained baseline from `origin/main` — generated must score equal or higher.

Needs `ANTHROPIC_API_KEY` in `.env`. The judge files run in every paid lane
(`bun run eval:bg:pr` selects the ones your diff touches).

- Resolves the judge model through `lib/eval-model.ts`, using the override order above
- Tests live in `test/skill-llm-eval.test.ts`
- Calls the Anthropic API directly (not `claude -p`), so it works from anywhere including inside Claude Code

### Paid-test touchfiles

`test/helpers/touchfiles-data.ts` maps each paid case to the files whose edits select it. Free
`*.test.ts` files are never listed: editing a free test does not run paid evals. `test/touchfiles.test.ts`
derives each paid file's static `test/helpers` / `test/fixtures` import closure, plus the fixture and helper
paths it names in string literals, and fails when that closure is not covered by the case's key. When it
fails, add the named path to the named key and check selection with
`bun run scripts/test-paid-shards.ts --tier gate --profile pr --list`. The rule is a lower bound: a fixture
path the test builds at runtime is not visible to it, so add such paths to the key by hand.

### Add a paid eval

1. **Test file.** Write the case in a paid test file, registered with a literal
   name (`testIfSelected('<case-id>', ...)`), grading the outcome (files, git
   state, native questions, exit status) rather than wording, unless the step
   itself is the contract. Wrap contract assertions in `expectContract()`.
2. **Touchfiles.** Add `'<case-id>': [...]` to `E2E_TOUCHFILES`; `bun test
   test/touchfiles.test.ts` names any missing closure path.
3. **Tier.** Add it to `E2E_TIERS`: `gate` for cheap contracts every PR needs,
   `periodic` for long or model-quality cases, `marathon` for complete flows.
4. **Kind.** Add it to `E2E_KINDS` (`rule` unless a live model choice may
   acceptably deviate; then `behavior` plus a `BEHAVIOR_WHY` line).
   `bun test test/eval-kinds.test.ts` prints the literal to add.
5. **PR profile.** If a PR should run it, add it to `scripts/test-pr-profile.ts`
   and check `bun run scripts/test-paid-shards.ts --tier gate --profile pr --list`.
6. **Try the panel locally.** `bun run scripts/test-paid-shards.ts --tier <tier>
   --case <case-id> --trials 3` runs the same panel CI runs, before you push.

### Retired commands

These package scripts are stubs for one release: each prints its replacement
and exits 1 (`scripts/retired-command.ts`). The next release deletes them.

| Retired | Use instead | Why it was retired |
|---|---|---|
| `test:evals` | `bun run eval:bg:pr` | Tierless: skipped every tier-gated paid file |
| `test:evals:all` | `bun run eval:bg:release` | Tierless: skipped every tier-gated paid file |
| `test:e2e` | `bun run eval:bg:pr` | Tierless: skipped every tier-gated paid file |
| `test:e2e:all` | `bun run eval:bg:release` | Tierless: skipped every tier-gated paid file |
| `test:gate` | `bun run test:gate:sharded` | The single-process fan-out never completed a run |
| `test:periodic` | `bun run test:periodic:sharded` | The single-process fan-out never completed a run |
| `test:codex` | `bun run test:periodic:sharded` | Set no `EVALS_TIER`, so both periodic-tier Codex files ran zero cases |
| `test:codex:all` | `bun run test:periodic:sharded` | Same as `test:codex` |
| `eval:bg` | `bun run eval:bg:pr` | Detached the retired `test:evals` |
| `eval:bg:all` | `bun run eval:bg:release` | Detached the retired `test:evals:all` |
| `eval:flake-rank` | `bun run eval:pass-rates` | Second name for the same script |
| `eval:watch` | Tail the `gstack-detach` log, or `gh run watch <run-id>` | Read a file only the unsharded runner wrote, so it showed nothing for sharded runs |
| `test:audit` | `bun run test` | `test/audit-compliance.test.ts` already runs in the free suite |

### CI

A GitHub Action (`.github/workflows/skill-docs.yml`) generates all hosts on pushes to main and on PRs, then rejects tracked differences and nonignored untracked output. Generation errors also fail the job. Optional ignored host caches are not compared against Git.

Supply-chain gates run alongside it:

- **Quality gate** (`.github/workflows/quality-gate.yml`, every PR and push) — scans the diff's added lines for credentials using gstack's own redact engine (`.github/scripts/gate-secret-scan.mjs`). HIGH findings fail the job; MEDIUM findings surface as an advisory count. Fails closed if the scan can't produce a report. Also runs ShellCheck on the setup/build boundaries.
- **Dependency review** (`.github/workflows/dependency-review.yml`) — reviews dependency changes on PRs that touch `package.json` or `bun.lock` files and fails on high or critical advisories. It and the weekly OSV scan are the dependency gates.
- **OSV scanner** (`.github/workflows/osv-scanner.yml`) — weekly vulnerability scan against the OSV database. Config lives in `.osv-scanner.toml` and is loaded via an explicit `--config` flag (OSV does not auto-discover that filename); every ignore entry needs a reason and an `ignoreUntil` expiry, enforced by `test/osv-config-wiring.test.ts`. A failed main scan upserts the tracking issue "OSV scanner: vulnerable dependency needs triage" and a clean scan closes it; `test/osv-ignore-expiry.test.ts` fails 14 days before any `ignoreUntil`, so an expiring suppression surfaces in a PR.
- **Weekly test health** (`.github/workflows/test-health.yml`, Mondays and on dispatch) — runs `bun run test:health --since-days 7 --enforce`. It fails when a free test file flakes in more than 5% of at least 20 main runs or more than 5 free files are missing from the duration seed, upserts one tracking issue on failure and closes it only when every previously failing check has evidence and passes. Metrics it cannot read print "unavailable: <reason>; next: <step>" and never fail the run.
- **Dependabot** (`.github/dependabot.yml`) — grouped dependency update PRs.
- **OpenSSF Scorecard** (`.github/workflows/scorecard.yml`) — weekly and on main pushes; results in the Security tab and api.scorecard.dev.

- **Platform qualification** (`.github/workflows/platform-qualification.yml`, dispatch and quarterly) — runs the opt-in tests no other lane has prerequisites for: the ML prompt-injection classifier (`SECURITY_BENCH=1`), memory ingest against real gitleaks (`GSTACK_TEST_GITLEAKS`), and the DebugBridge Swift build (`GSTACK_TEST_SWIFT=1`, macOS). `test/platform-qualification-workflow.test.ts` pins each gate to its job.

Every workflow pins its third-party actions to commit SHAs (`test/workflow-action-pins.test.ts`). The PR template (`.github/PULL_REQUEST_TEMPLATE.md`) asks for evidence — tests run, eval output — not promises.

Tests run against the browse binary directly — they don't require dev mode. Anything that needs Aside itself (`test/skill-e2e-aside.test.ts`, the Aside qa/design cases, the live render in `test/aside-render.test.ts`) runs only on a Mac with the Aside app open and self-skips elsewhere; make-pdf's render gates and the `/diagram` E2E run on whichever engine resolves, so CI runs them on the browse binary it builds with `bun run build:gates`.

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

`skill:check` renders all hosts into temporary storage using canonical content
paths and host defaults, validates the complete generated content, and compares
expected tracked artifacts against the checkout. Missing, changed, or nonignored
untracked output fails. Local ignored host caches, including symlinked caches,
are left untouched; the checker works without them. A generation failure cannot
produce a successful check of partial output.

For template authoring best practices (natural language over bash-isms, dynamic branch detection, `{{BASE_BRANCH_DETECT}}` usage), see CLAUDE.md's "Writing SKILL templates" section.

Browser steps in skills are `aside repl` scripts that follow the cookbook in `scripts/resolvers/aside.ts`, each paired with its `$B` equivalent for the fallback engine; run the Aside shape against the Aside CLI before committing. To add a browse command, add it to `browse/src/commands.ts`. To add a snapshot flag, add it to `SNAPSHOT_FLAGS` in `browse/src/snapshot.ts`. Then rebuild.

**Render through `lib/aside-render.ts`; don't bundle puppeteer/Chromium in a
skill.** A skill that needs to rasterize or print its own HTML/JSON (diagrams,
cards, og-images, PDFs) calls `bin/gstack-render.ts` from its template
(`--screenshot`, `--pdf`, `--eval JS --out FILE`) or imports `render` from
`lib/aside-render.ts` in TypeScript (`renderWithAside` / `renderWithBrowse` are
the engine-specific halves; `render` picks between them and retries once on the
browse engine if Aside's CLI cannot start or loses its CDP bridge mid-run). The
wrapper prints through Aside when it is open and through the `browse` daemon
when it is not (`newtab --json`, `goto` the loopback URL, `js` readiness
polling, `pdf --from-file`, `viewport` + `screenshot`, `js --out`, `closetab`)
— the one shared Chromium per box, same flags and `OK <path>` lines,
`ENGINE=aside|browse` saying which one actually rendered, `EVAL` /
`PAGE_ERRORS` lines fenced as untrusted web content. The loopback server
serves one per-render secret URL and never follows a symlink out of its
directory. Sized screenshots are 1x on the fallback (2x on Aside); JPEG
quality and `pageRanges`/`scale` are Aside-only; `--landscape` swaps paper
dimensions. Never `npm i puppeteer`, never download a second Chromium that
drifts out of version sync, never point the renderer at a website. If the
wrapper lacks an option you need, add it to `lib/aside-render.ts` (pin it in
`test/aside-render.test.ts`, and in `test/gstack-render-cli.test.ts` when it
is a CLI flag) so every caller gets it on both paths. Exported test seams:
`pickEngine(fresh, deps)` (inject the probe and the binary resolver),
`serveDir(root, nonce)`, `SAFE_TMP_DIR`, and `PAGE_NUMBER_FOOTER` (the one
page-number footer make-pdf, `gstack-render`, and the browse `pdf` command share).

## Prompt audit at each frontier-model release

When a new frontier Claude model ships, audit the text models read for
instructions the new model over-applies or no longer needs. The audit is
Anthropic's `/claude-api prompt-audit`, a Claude Code skill you run in your own
Claude Code session; gstack only prints what to feed it.

```bash
bun run audit:manifest   # slices of templates, resolvers, overlays, CLAUDE.md and wording-pinning tests (--json for a machine-readable list)
```

1. In Claude Code, run `/claude-api prompt-audit` with the new model as the
   target, one slice at a time, giving it that slice's file list. `s01` is the
   shared text every skill reads (CLAUDE.md, model overlays, preamble
   resolvers); a skill's template and its sections share one slice.
2. Fix findings in templates and resolvers, never in generated SKILL.md files,
   then run `bun run gen:skill-docs --host all`.
3. Treat safety rules as held: reword one only where an eval shows the model
   obeys it both before and after the change.
4. Work through the "tests that pin skill wording" slices last. Where prose
   changed, replace exact-sentence pins with structural or meaning checks
   (the prompt-bytes rule in CLAUDE.md's testing section).
5. `test/archaeology-lint.test.ts` keeps issue numbers and incident stories out
   of the generated text; its failure names the source file to fix.

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
| Suppressed sections | GBrain blocks vs GBrain blocks and Review Army; Codex retains outside-review sections routed to Claude Code |
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

1. Create `hosts/myhost.ts` (copy from `hosts/opencode.ts`), including its
   `tier` and `capabilities`
2. Add to `hosts/index.ts`
3. Add `.myhost/` to `.gitignore`
4. Run `bun run gen:skill-docs --host myhost`
5. Run `bun run test` (parameterized tests auto-cover it)

Rendering needs no generator code. Installing does: an installable host also
needs a setup install arm, a row in `gstack_host_tier`
(`bin/gstack-install-registry.sh`), a README host-matrix row, and the
conformance kit (`test/host-conformance.test.ts`). It ships as `experimental`
until a dated certification record exists; see "Certify your host" and the
install ownership rules in the guide.

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

- **SKILL.md files are generated.** Edit the `.tmpl` template, not the `.md`. Run `bun run gen:skill-docs` to regenerate. The same run generates `review/design-checklist.md` from `lib/design-catalog.ts` and `lib/dom-dump.js` from `lib/dom-dump-script.ts`: edit those sources, never the generated files (`test/design-checklist-sync.test.ts` fails on drift).
- **TODOS.md is the unified backlog.** Organized by skill/component with P0-P4 priorities. `/ship` auto-detects completed items. All planning/review/retro skills read it for context.
- **Browse, make-pdf, design, and `lib/` source changes need a rebuild.** If you touch `browse/src/*.ts`, `make-pdf/src/*.ts`, `design/src/*.ts`, or anything under `lib/` (the canonical `claude-bin.ts`, `error-handling.ts`, and `aside-render.ts` the binaries embed, plus `design-catalog.ts`, whose `MOCKUP_NEVER_NAMES` the design binary's mockup prompt embeds; `browse/src` re-exports the first three), run `bun run build`. `./setup` makes the same call on its own: it rebuilds when any of the three binaries is missing or when those sources, `package.json`, or `bun.lock` are newer than the browse binary (`test/setup-needs-build.test.ts` pins the decision).
- **Dev mode shadows your global install.** Project-local skills take priority over `~/.claude/skills/gstack`. `bin/dev-teardown` restores the global one.
- **Conductor workspaces are independent.** Each workspace is its own git worktree. `bin/dev-setup` runs automatically via `conductor.json`.
- **`.env` propagates across worktrees.** Set it once in the main repo, all Conductor workspaces get it.
- **`.claude/skills/` is gitignored.** The symlinks never get committed.
- **Never write raw `ln -snf` in `setup`.** Every link site in `setup` MUST route through the `_link_or_copy SRC DST` helper near the `IS_WINDOWS` detection. The helper preserves `ln -snf` on Unix and switches to `cp -R` / `cp -f` on Windows without Developer Mode, where plain `ln -snf` produces frozen file copies that don't refresh on `git pull`. `test/setup-windows-fallback.test.ts` enforces this with a static invariant — a single raw `ln` call outside the helper body fails CI.
- **Synchronous subagent dispatches must state the flag.** Claude Code runs Agent-tool subagents in the background by default (since v2.1.198), so any template step that dispatches a subagent and consumes its output must carry `run_in_background: false`. Use the `{{FOREGROUND_DISPATCH_NOTE}}` placeholder (`scripts/resolvers/constants.ts`) instead of hand-writing the guidance, and add the generated carrier file to `GENERATED_WITH_GUIDANCE` in `test/run-in-background-guidance.test.ts` in the same commit — its structural scanner fails CI on any generated dispatch imperative that lacks the flag.
- **Never delete or link over a skill entry `setup` cannot prove is gstack's.** Every destructive site in `setup` (the linker, the alias installer, both prefix-flip cleanups) and in `bin/gstack-relink` goes through the ownership helpers (`_claude_entry_is_ours` / `_claude_entry_owned_strongly` in `setup`, `_entry_is_ours` / `_entry_owned_strongly` in relink). The retired-skill prune (`_prune_stale_generated`) applies the same strong/weak split through its own gate: a real host directory is a candidate only when its SKILL.md carries the generated banner (`_owned_for_windows_refresh`), a host symlink is removed only when it resolves into gstack (`_gstack_target_is_ours`), a bannered real directory is cleaned through `_cleanup_weak_dir`, and a symlink inside the render tree is never followed. A symlink into gstack or the `.gstack-owned` marker proves the whole directory; a byte-identical or generated-banner SKILL.md proves only that file, and a differing one is moved to `~/.gstack/backups/skills/<ts>/` first. `test/setup-link-ownership.test.ts`, `test/setup-cleanup-orphans.test.ts`, `test/setup-prune-stale-generated.test.ts`, and `test/relink.test.ts` pin it. The rule is duplicated in the two scripts until the shared helper filed in TODOS.md lands: change both.
- **`./setup` never fails on Chromium.** The Playwright bootstrap (section `# 2` of `setup`) is best-effort and bounded: every failure becomes a reason code (`skipped`, `chromium-install`, `chromium-install-timeout`, `chromium-install-locked`, `windows-no-node`, `windows-node-modules`, `post-install-launch`) printed in the final summary alongside the browser-dependent skills, and skill registration always runs. `GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT=<seconds>` (default 600) bounds the download; `GSTACK_SKIP_PLAYWRIGHT=1` skips it, the right knob for a no-browser box or a setup-only test loop. `GSTACK_SKIP_ASIDE=1` makes the browser summary (like the skills' probe and the renderer) treat Aside as absent, so the summary never promises a fallback the bootstrap did not deliver (`test/setup-browser-hint.test.ts`). Anything you add after the bootstrap must stay independent of the browser. `test/setup-playwright-best-effort.test.ts` pins the block.

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
