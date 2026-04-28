# gstack-build — code-driven phase orchestrator

Standalone CLI that drives a multi-phase implementation plan to completion. Replaces the LLM-orchestrated loop in the `/build` skill for long, multi-week plans where context compaction or "Standing by, let me know what's next" stalls become a problem.

## When to use this vs `/build`

| Use the **`/build`** skill when... | Use the **`gstack-build`** CLI when... |
|---|---|
| The plan has 1-3 phases | The plan has 5+ phases or spans weeks |
| You want Claude Code in the loop for visibility | You want to walk away and come back to a finished branch |
| The phases need ad-hoc judgment | Each phase has a clear, scriptable description |
| Quick iteration, exploratory work | Production builds, multi-day work |

The CLI delegates each per-phase task to fresh Gemini and Codex subprocesses, so the LLM brain still does the work — it just doesn't drive the loop.

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

The plan file supports two formats:

**TDD format (recommended)** — 3 checkboxes per phase:
```markdown
### Phase 1: Skeleton + parser
- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests that cover...
- [ ] **Implementation (Gemini Sub-agent)**: Make all failing tests pass...
- [ ] **Review & QA (Codex Sub-agent)**: Run codex /gstack-review...
```

**Legacy format (still supported)** — 2 checkboxes per phase:
```markdown
### Phase 1: Skeleton + parser
- [ ] **Implementation (Gemini Sub-agent)**: Write parser.ts with...
- [ ] **Review & QA (Codex Sub-agent)**: Run codex /gstack-review...
```

Phase number can be `N` or `N.M`. The orchestrator processes phases in document order. Phases missing the `**Implementation` or `**Review` checkbox are skipped with a warning. TDD format phases without a `**Test Specification` checkbox are treated as legacy and skip the Red/Green steps.

## TDD Workflow

When a phase has a `**Test Specification` checkbox, the orchestrator runs a 7-step loop:

```
1. Test Specification  — Gemini writes failing tests (Red)
2. Verify Red          — run tests; if they pass, Gemini rewrites stricter tests (cap: GSTACK_BUILD_RED_MAX_ITER)
3. Implementation      — Gemini implements until tests pass
4. Test+Fix Loop       — run tests; if failing, Gemini fixes; repeat (cap: GSTACK_BUILD_TEST_MAX_ITER)
5. Codex Review        — recursive GATE PASS loop (unchanged)
6. Update Plan         — flip all 3 checkboxes [x]
7. Context save        — claude --model sonnet -p /context-save
```

### Test command detection

The orchestrator auto-detects the test runner by searching the project root (`cwd`) in priority order:

1. `--test-cmd <cmd>` flag (explicit override — takes precedence over everything)
2. `package.json` → `scripts.test` (e.g. `bun test`, `npm test`)
3. `pytest.ini` → `pytest`
4. `pyproject.toml` with `[tool.pytest.ini_options]` → `pytest`
5. `go.mod` → `go test ./...`
6. `Cargo.toml` → `cargo test`
7. None found → warn and skip Red/Green verification (test spec still written; Codex review still runs)

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

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_BIN` | `gemini` | Path to Gemini CLI. |
| `CODEX_BIN` | `codex` | Path to Codex CLI. |
| `CLAUDE_BIN` | `claude` | Path to Claude Code (for the ship step). |
| `GBRAIN_BIN` | `gbrain` | Path to gbrain CLI (optional). |
| `GSTACK_BUILD_GEMINI_TIMEOUT` | `600000` | Per-Gemini-call timeout in ms (10 min). |
| `GSTACK_BUILD_CODEX_TIMEOUT` | `900000` | Per-Codex-iteration timeout in ms (15 min). |
| `GSTACK_BUILD_SHIP_TIMEOUT` | `1800000` | Final ship-step timeout in ms (30 min). |
| `GSTACK_BUILD_CODEX_MAX_ITER` | `5` | Hard cap on recursive Codex review iterations. |
| `GSTACK_BUILD_TEST_TIMEOUT` | `300000` | Per-test-run timeout in ms (5 min). |
| `GSTACK_BUILD_TEST_MAX_ITER` | `5` | Hard cap on Gemini fix iterations when tests fail post-impl. |
| `GSTACK_BUILD_RED_MAX_ITER` | `3` | Hard cap on Gemini re-spec iterations when tests pass trivially (VERIFY_RED). |

## File layout

```
~/.gstack/build-state/
├── <slug>.json                           Live state (atomic temp+rename)
├── <slug>.lock                           O_EXCL lock file (cleared on graceful exit)
└── <slug>/
    ├── phase-1-gemini-testspec-1.log     Test-spec Gemini stdout+stderr
    ├── phase-1-gemini-testspec-1-input.md
    ├── phase-1-gemini-testspec-1-output.md
    ├── phase-1-tests-1.log               Test runner stdout+stderr (VERIFY_RED)
    ├── phase-1-gemini-1.log              Implementation Gemini stdout+stderr
    ├── phase-1-tests-1.log               Test runner stdout+stderr (post-impl)
    ├── phase-1-gemini-fix-1.log          Fix-iteration Gemini stdout+stderr
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
| `Codex review failed to converge after N iterations` | The recursive review can't reach `GATE PASS` | Read `phase-N-codex-*.log`, fix the underlying issue manually, resume |
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
ship.ts         final /ship + /land-and-deploy via claude -p
types.ts        Phase, PhaseState, BuildState
```

The state machine is the heart of the design and is deliberately a pure function: `(currentPhaseState, lastResult) → (nextAction, newPhaseState)`. The driver in `cli.ts` is the only place with I/O. This makes every state transition trivially unit-testable — see `__tests__/phase-runner.test.ts` for the full transition table.

## Testing

```bash
cd ~/.claude/skills/gstack
bun test build/orchestrator/__tests__/
```

105 tests across 9 files cover: parser edge cases, state persistence atomicity, lock contention, every phase-runner TDD state transition, plan mutator atomicity, ANSI-stripping verdict parser, gbrain frontmatter strip, detectTestCmd detection, buildGeminiTestSpecPrompt prompt structure, and dry-run TDD integration.
