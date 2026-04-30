# gstack-build — code-driven phase orchestrator

Standalone CLI that drives a feature-block implementation plan to completion. Replaces the LLM-orchestrated loop in the `/build` skill for long, multi-week plans where context compaction or "Standing by, let me know what's next" stalls become a problem.

## When to use this vs `/build`

| Use the **`/build`** skill when... | Use the **`gstack-build`** CLI when... |
|---|---|
| The plan has 1-3 phases | The plan has 5+ phases or spans weeks |
| You want Claude Code in the loop for visibility | You want to walk away and come back to a finished branch |
| The phases need ad-hoc judgment | Each phase has a clear, scriptable description |
| Quick iteration, exploratory work | Production builds, multi-day work |

The CLI delegates each per-phase task to fresh Claude, Gemini, or Codex subprocesses, so the LLM brain still does the work — it just doesn't drive the loop.

## Install

`gstack-build` is a bash wrapper at `bin/gstack-build` that invokes `build/orchestrator/cli.ts` via `bun`. It's installed automatically when you run gstack's setup. To verify:

```bash
which gstack-build
gstack-build --help
```

If it's not on PATH, add `~/.claude/skills/gstack/bin` to your `PATH` or symlink the binary to `~/.local/bin`.

## Usage

```bash
gstack-build <plan-file> [flags]
```

When the plan lives in a sibling `*-gstack/inbox/living-plan/` or `*-gstack/inbox/` repo, run the command
from the product repo and pass `--project-root "$(git rev-parse --show-toplevel)"`
if there is any ambiguity. Completed living plans are moved to the sibling
`archived/` directory after a successful non-dry-run build. Pass
`--origin-plan <file>` when the living plan was synthesized from a separate
source plan in `*-gstack/inbox/`; after the final completion exam passes, that
origin plan is archived too.

The plan file is organized into semantic feature blocks. The `/build` skill
should reorganize all origin-plan weeks, milestones, blocks, and phases into
feature groups before handing the living plan to this CLI:

```markdown
## Feature 1: Authentication
Origin trace: Week 1 / Phase 2, Week 2 / Phase 1
Acceptance: Login, logout, and session expiry satisfy the source plan.

### Phase 1.1: Auth tests
- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests that cover...
- [ ] **Implementation (Gemini Sub-agent)**: Make all failing tests pass...
- [ ] **Review & QA (review roles)**: Run /review, /codex review, and /gstack-qa...
```

Legacy phase-only plans still run as a single feature named `Full plan`.

Each phase supports two formats:

**TDD format (recommended)** — 3 checkboxes per phase:
```markdown
### Phase 1: Skeleton + parser
- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests that cover...
- [ ] **Implementation (Gemini Sub-agent)**: Make all failing tests pass...
- [ ] **Review & QA (review roles)**: Run /review, /codex review, and /gstack-qa...
```

**Legacy format (still supported)** — 2 checkboxes per phase:
```markdown
### Phase 1: Skeleton + parser
- [ ] **Implementation (Gemini Sub-agent)**: Write parser.ts with...
- [ ] **Review & QA (review roles)**: Run /review, /codex review, and /gstack-qa...
```

Feature and phase numbers can be `N` or `N.M`. The orchestrator processes features in document order, and phases in document order within each feature. Phases missing the `**Implementation` or `**Review` checkbox are skipped with a warning. TDD format phases without a `**Test Specification` checkbox are treated as legacy and skip the Red/Green steps.

## Feature Workflow

For each feature block, the orchestrator:

1. Ensures it is on a feature branch.
2. Runs every incomplete phase through the TDD/review loop.
3. Runs `/ship` and `/land-and-deploy` for that feature unless `--skip-ship` or `--dry-run` is set.
4. Verifies the landed feature against the origin plan when `--origin-plan` is provided.
5. Marks the feature complete and advances to the next feature.

Every atomic feature/phase/gate transition writes a `status` event to `~/.gstack/analytics/build-runs.jsonl` and prints a `[build-status]` line so monitors can observe progress and pause on unresolved issues.

After all features complete, the final exam verifies there are no incomplete phases/features and, for shipped runs, no unmerged remote `feat/*` branches remain. Only then are the living plan and optional origin plan archived.

## TDD Workflow

When a phase has a `**Test Specification` checkbox, the orchestrator runs a 7-step loop:

```
1. Test Specification  — configured test-writer role writes failing tests (Red)
2. Verify Red          — run tests; if they pass, test-writer rewrites stricter tests (cap: GSTACK_BUILD_RED_MAX_ITER)
3. Implementation      — configured primary-impl role implements until tests pass
4. Test+Fix Loop       — run tests; if failing, configured test-fixer role fixes; repeat (cap: GSTACK_BUILD_TEST_MAX_ITER)
5. Review + QA         — configured review, review-secondary, and QA roles; all require GATE PASS
6. Update Plan         — flip all 3 checkboxes [x]
7. Context save        — configured context-save role
```

### Test command detection

The orchestrator auto-detects the test runner by searching the project root (`cwd`) in priority order:

1. `--test-cmd <cmd>` flag (explicit override — takes precedence over everything)
2. `package.json` → `scripts.test` (e.g. `bun test`, `npm test`)
3. `pytest.ini` → `pytest`
4. `pyproject.toml` with `[tool.pytest.ini_options]` → `pytest`
5. `go.mod` → `go test ./...`
6. `Cargo.toml` → `cargo test`
7. None found → warn and skip Red/Green verification (test spec still written; review gates still run)

```bash
# Explicit override — use when auto-detection picks the wrong command:
gstack-build plans/...md --test-cmd "bun test src/"

# Monorepo: runTests splits on whitespace, so use bash -c for shell operators:
gstack-build plans/...md --test-cmd "bash -c 'cd packages/api && bun test'"
```

### Common workflows

```bash
# See what would run, no execution:
gstack-build plans/myproj-impl-plan-20260427.md --print-only

# Walk the full TDD state machine without spawning sub-agents (smoke test):
gstack-build plans/...md --dry-run --test-cmd "bun test"

# Run for real, but stop short of the ship step:
gstack-build plans/...md --skip-ship

# Discard prior state and start over:
gstack-build plans/...md --no-resume

# Local JSON only, no gbrain mirror:
gstack-build plans/...md --no-gbrain
```

### Resume after interrupt

Hit Ctrl-C mid-run? Run the same command again — the orchestrator picks up at the phase that was in flight. State lives at `~/.gstack/build-state/<slug>.json` (and mirrored to gbrain page `<slug>` if gbrain is configured).

To force a fresh start: `gstack-build ... --no-resume` or `rm ~/.gstack/build-state/<slug>.json`.

## Dual Implementor Mode (`--dual-impl`)

Tournament selection: the configured primary and secondary implementors build each TDD phase **in parallel**, in **isolated git worktrees**, and the configured judge picks the winner. The winning commits are cherry-picked back onto the main branch and the existing TDD pipeline (test+fix loop → review gates) takes over from there.

**Prewritten test specs are supported** — if a phase has `[x] **Test Specification` already checked (user wrote the tests before running gstack), dual-impl runs `VERIFY_RED` first to confirm the tests fail, then spawns both implementors. If the prewritten tests pass trivially (before any implementation), the phase fails with a clear message: fix the tests so they fail, then re-run. **Legacy 2-checkbox plans** (no test spec checkbox at all) still skip dual-impl silently and use normal single-implementor behavior.

**Required CLIs**: `gemini`, `codex`, and `claude` must all be on `PATH` (or set `GEMINI_BIN` / `CODEX_BIN` / `CLAUDE_BIN`). The orchestrator does not preflight check these — if Codex fails to produce committed work, `countCommitsSinceBase` returns 0 for the Codex side, making it ineligible. If only Gemini committed, it is auto-selected and dual-tests + judge are skipped (`selectedBy='auto'`). If neither committed, the phase fails. Install all three before running.

This eliminates single-model blind spots: if one implementor takes a structurally wrong approach, the other independent attempt may not, and the judge sees both diffs side-by-side.

```bash
gstack-build plans/...md --dual-impl
```

### Per-phase loop (when `--dual-impl` is active)

```
1. Test Specification  — configured test-writer writes failing tests (Red)
2. Verify Red          — confirm tests fail                            [unchanged]
3. Dual Impl           — createWorktrees, then Promise.all of:
                           - runGemini  in /tmp/gstack-dual-<slug>-pN-<ts>/gemini
                           - runCodexImpl in /tmp/gstack-dual-<slug>-pN-<ts>/codex
                         Each commits to its own branch.
4. Dual Fix Loops      — Promise.all of runDualImplFixLoop on both worktrees:
                         For each implementor:
                           a. run test command
                           b. if tests fail: invoke fix agent (up to DEFAULT_MAX_TEST_ITERATIONS)
                              collecting per-iteration failure output into fixHistory
                           c. repeat until green or iterations exhausted
                         SHA of worktree HEAD captured at test time (geminiTestedCommit /
                         codexTestedCommit) — validated on resume; stale cache detected
                         fail-closed if HEAD has moved since tests ran.
                         Outcomes:
                           → both pass: judge decides (or test hygiene gate below)
                           → one passes: auto-select the passing one
                           → both fail: auto-select fewer-failures winner
                           → both timed out / no signal: fail closed
                         Test hygiene gate: before auto-select, git-diff test files
                         (**/__tests__/**) — if either implementor modified test assertions,
                         route to the configured judge instead of auto-deciding.
5. Judge               — configured judge reads both diffs + test results + fixHistory,
                         emits "WINNER: gemini|codex" + REASONING + HARDENING block
                         (HARDENING: lists concrete bug surfaces from either side's
                         fix history; injected into the review prompt)
6. Apply Winner        — cherry-pick winning branch's commits onto main cwd
                         (patch fallback if cherry-pick conflicts)
7. — handoff —         — phase rejoins impl_done; existing TDD loop runs
8. Test+Fix Loop       — adopted code is verified again on main cwd
9. Review + QA         — final review on main cwd; receives HARDENING notes so
                         the reviewers check for known edge cases from both
                         implementors' failure histories
```

### Worktree isolation

Each phase creates a fresh pair under `os.tmpdir()/gstack-dual-<slug>-p<N>-<timestamp>/`. Branches are named `gstack-dual-p<N>-{gemini|codex}-<timestamp>`. Cleanup behavior by outcome:

- **Successful Apply Winner** → worktrees torn down immediately.
- **Apply Winner failure** (cherry-pick + patch both fail) → worktrees **preserved** for manual recovery; cwd tracking files are restored to HEAD via `git reset --hard HEAD` (only on the specific patch-apply failure branch; `git add` or `git commit` failures after a successful patch leave cwd dirty — check `git status` before recovery). Error message includes the worktree paths.
- **Phase FAIL before Apply — at Dual Tests** (both timed out, or both fail with no parseable failure count) → worktrees torn down immediately after the test result is recorded; `failed` status set. These have no recovery value since there is no winner to cherry-pick.
- **Phase FAIL before Apply — at RUN_DUAL_IMPL** (e.g. neither implementor committed, unexpected crash) → worktrees torn down in the `finally` block; only `failed` status is left in state.
- **Judge failure / malformed verdict** → worktrees torn down; phase status `failed`.

Manual recovery: `git worktree list` to find leftover worktrees, then `git worktree remove --force <path>` + `git branch -D <branch>` to clean up.

### Auto-select vs Judge

- **Both passed tests** → test hygiene gate: if either implementor modified test files (`**/__tests__/**`), the configured judge runs. Otherwise the configured judge runs unconditionally.
- **One passed, one failed** → auto-select the passing one (`selectedBy='auto'`), unless test hygiene gate triggers.
- **Both failed** → auto-select fewer-failures winner via `parseFailureCount` (priority: explicit summary line like "3 failed", then ✗/FAIL marker counts), unless test hygiene gate triggers.
- **Both timed out OR both had no parseable failure count** → fail-closed; phase status `failed`, you resume manually.
- **Judge output malformed (no anchored `WINNER:` line)** → fail-closed; worktrees are torn down.
- **Fix iterations** reported in judge prompt: `null` = fix loop not run (impl crashed or no test command), `0` = passed on first try, `N` = required N fix passes.

### Backward compat

`--dual-impl` is a runtime-only flag. Plans don't need any per-phase frontmatter — when the flag is set, every parsed phase gets `dualImpl=true`. Prewritten test-spec phases (where `[x] **Test Specification` is already checked) now run `VERIFY_RED` first before spawning both implementors. Legacy 2-checkbox plans (no test-spec checkbox at all) still skip dual-impl and use the normal single-implementor path.

## Environment variables

The built-in defaults are data-driven from `build/configure.cm`. Edit that file
to update default role routing, retry caps, or timeout values. Use
`GSTACK_BUILD_CONFIG_FILE` to run with an alternate config file without editing
the repo copy. `GSTACK_BUILD_DEFAULTS_FILE` remains as a legacy alias.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_BIN` | `gemini` | Path to Gemini CLI. |
| `CODEX_BIN` | `codex` | Path to Codex CLI. |
| `CLAUDE_BIN` | `claude` | Path to Claude Code. |
| `GBRAIN_BIN` | `gbrain` | Path to gbrain CLI (optional). |
| `GSTACK_BUILD_CONFIG_FILE` | `build/configure.cm` | Alternate build config file. |
| `GSTACK_BUILD_DEFAULTS_FILE` | `build/configure.cm` | Legacy alias for `GSTACK_BUILD_CONFIG_FILE`. |
| `GSTACK_BUILD_TEST_WRITER_MODEL` | role default | Failing-test writer model. |
| `GSTACK_BUILD_PRIMARY_IMPL_MODEL` | role default | Primary implementation model. |
| `GSTACK_BUILD_TEST_FIXER_MODEL` | role default | Test-fixer model. |
| `GSTACK_BUILD_SECONDARY_IMPL_MODEL` | role default | Dual-impl secondary model. |
| `GSTACK_BUILD_REVIEW_MODEL` | role default | Primary review model. |
| `GSTACK_BUILD_REVIEW_SECONDARY_MODEL` | role default | Secondary review model. |
| `GSTACK_BUILD_QA_MODEL` | role default | QA model. |
| `GSTACK_BUILD_SHIP_MODEL` | role default | Ship model. |
| `GSTACK_BUILD_LAND_MODEL` | role default | Land model. |
| `GSTACK_BUILD_CONTEXT_SAVE_MODEL` | role default | Context-save model. |
| `GSTACK_BUILD_<ROLE>_PROVIDER` | role default | Provider override where supported; dual-impl requires Gemini primary, Codex secondary, Claude judge. |
| `GSTACK_BUILD_<ROLE>_REASONING` | role default | Role reasoning override. |
| `GSTACK_BUILD_<ROLE>_COMMAND` | role default | Command override for review, QA, ship, land, and context-save roles. |
| `GSTACK_BUILD_GEMINI_TIMEOUT` | `600000` | Per-Gemini-call timeout in ms (10 min). |
| `GSTACK_BUILD_CODEX_TIMEOUT` | `900000` | Per-Codex-iteration timeout in ms (15 min). |
| `GSTACK_BUILD_SHIP_TIMEOUT` | `1800000` | Final ship-step timeout in ms (30 min). |
| `GSTACK_BUILD_CODEX_MAX_ITER` | `5` | Hard cap on recursive review gate iterations. |
| `GSTACK_BUILD_TEST_TIMEOUT` | `300000` | Per-test-run timeout in ms (5 min). |
| `GSTACK_BUILD_TEST_MAX_ITER` | `5` | Hard cap on test-fixer iterations when tests fail post-impl. |
| `GSTACK_BUILD_RED_MAX_ITER` | `3` | Hard cap on test-writer re-spec iterations when tests pass trivially (VERIFY_RED). |
| `GSTACK_BUILD_JUDGE_TIMEOUT` | `600000` | Per-judge-call timeout in ms (10 min). Dual-impl only. |
| `GSTACK_BUILD_JUDGE_MODEL` | role default | Model passed to `claude --model` for the judge. Dual-impl only. |
| `GSTACK_BUILD_CODEX_IMPL_SANDBOX` | `workspace-write` | Sandbox mode for `runCodexImpl`. Set to `danger-full-access` to opt in to looser sandboxing (worktrees share .git/remotes — be aware). |

## Living plan storage

`/build` writes synthesized living plans to the workspace's sibling
`*-gstack/inbox/living-plan/` directory. Source plans to execute are searched
first in `*-gstack/inbox/`. The product repo remains the execution root: tests,
sub-agents, review, ship, and land all run from `--project-root` or the current
git worktree. If `gstack-build` is invoked with a plan inside the `*-gstack` repo
and cannot infer the product repo, it exits with instructions to rerun with
`--project-root <repo>`.

## File layout

```
~/.gstack/build-state/
├── <slug>.json                           Live state (atomic temp+rename)
├── <slug>.lock                           O_EXCL lock file (cleared on graceful exit)
└── <slug>/
    ├── phase-1-test-writer-1.log         Test-writer stdout+stderr
    ├── phase-1-gemini-testspec-1-input.md
    ├── phase-1-gemini-testspec-1-output.md
    ├── phase-1-tests-1.log               Test runner stdout+stderr (VERIFY_RED)
    ├── phase-1-gemini-1.log              Implementation Gemini stdout+stderr
    ├── phase-1-tests-1.log               Test runner stdout+stderr (post-impl)
    ├── phase-1-gemini-fix-1.log          Fix-iteration stdout+stderr
    ├── phase-1-codex-1.log
    ├── phase-1-codex-2.log
    └── ship.log

~/.gstack/analytics/build-runs.jsonl   Append-only activity log
```

The `<slug>` is `build-<plan-basename-without-ext>`, e.g. `build-agnt2-impl-plan-20260427`.

## Failure modes

The orchestrator stops at any of these and writes the failure reason into the state file. Resume picks up at the same phase after the user fixes the underlying issue.

| Symptom | Likely cause | Fix |
|---|---|---|
| `Gemini timed out (after 1 retry)` | Phase too large, network blip, or Gemini hung | Raise `GSTACK_BUILD_GEMINI_TIMEOUT`, or split the phase |
| `Review gates failed to converge after N iterations` | The recursive review can't reach `GATE PASS` | Read the phase review logs, fix the underlying issue manually, resume |
| `Codex output did not contain GATE PASS or GATE FAIL` | Codex changed output format, or hit an internal error | Read the log; usually means the codex CLI itself errored |
| `Tests still failing after N fix iterations` | Gemini can't converge; tests and impl are in conflict | Read `phase-N-gemini-fix-*.log`, fix manually, resume |
| `Gemini could not produce failing tests after N attempts` | Tests pass before implementation (trivially-asserting tests) | Read `phase-N-gemini-testspec-*.log`, tighten the phase description, resume |
| `plan checkbox flip failed: line N no longer contains "**Implementation"` | Plan file edited externally between parse and mutate | Re-run; the orchestrator re-parses on every start |
| `another gstack-build instance is running` | Another process holds the lock, or stale lock | Either wait, or `rm ~/.gstack/build-state/<slug>.lock` if you're sure it's stale |

Exit codes: `0` clean run, `1` phase failed, `2` bad args, `3` lock contention, `130` SIGINT.

## Architecture

```
cli.ts          driver loop, signal handling, lock, activity log
parser.ts       plan markdown → Phase[]
phase-runner.ts pure state machine (decideNextAction, applyResult)
sub-agents.ts   gemini/codex/claude CLI wrappers with retries; detectTestCmd; runTests
plan-mutator.ts atomic [ ] → [x] checkbox flip (impl, review, test-spec)
state.ts        ~/.gstack/build-state/<slug>.json + gbrain mirror
gbrain.ts       gbrain CLI wrapper (best-effort, never throws)
ship.ts         configurable /gstack-ship + /gstack-land-and-deploy delegation
types.ts        Phase, PhaseState, BuildState
```

The state machine is the heart of the design and is deliberately a pure function: `(currentPhaseState, lastResult) → (nextAction, newPhaseState)`. The driver in `cli.ts` is the only place with I/O. This makes every state transition trivially unit-testable — see `__tests__/phase-runner.test.ts` for the full transition table.

## Testing

```bash
cd ~/.claude/skills/gstack
bun test build/orchestrator/__tests__/
```

229 tests across 12 files cover: parser edge cases (incl. dual-impl opt stamping), state persistence atomicity, lock contention, every phase-runner state transition (TDD + dual-impl tournament), plan mutator atomicity, ANSI-stripping verdict parser, gbrain frontmatter strip, detectTestCmd detection, prompt-builder shapes (test-spec, dual-impl, judge, fmtFixIter variants, fix history injection, HARDENING format), worktree primitives (createWorktrees / applyWinner / teardownWorktrees against a real temp git repo), parseFailureCount + parseJudgeVerdict + buildCodexImplArgv + parseJudgeVerdict HARDENING extraction, fail-closed paths, and dry-run integration for both single-impl TDD and `--dual-impl` modes.
