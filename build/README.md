# Build Skill Workflow

The build skill turns an approved plan into shipped code. It has two execution
paths:

- `/build`, the skill prompt in `build/SKILL.md.tmpl`, for short plans where the
  current agent can stay in the loop.
- `gstack-build`, the TypeScript orchestrator in `build/orchestrator/`, for long
  or high-risk plans where the loop must survive context compaction, restarts,
  and multi-hour sub-agent work.

Use the skill when you want guided execution. Use the CLI when the plan is large
enough that "keep going" cannot be trusted to remain in model context.

## Entry Points

`build/SKILL.md.tmpl` is the source of truth for the generated skill. Do not edit
`build/SKILL.md` directly.

The installed command is `bin/gstack-build`, a thin Bash wrapper that resolves
the gstack checkout and runs:

```bash
bun run build/orchestrator/cli.ts <plan-file> [flags]
```

Common commands:

```bash
gstack-build plans/example-impl-plan.md --print-only
gstack-build plans/example-impl-plan.md --dry-run --skip-ship
gstack-build plans/example-impl-plan.md --skip-ship
gstack-build plans/example-impl-plan.md --dual-impl
gstack-build plans/example-impl-plan.md --no-resume
```

## High-Level Flow

1. Find or synthesize a living implementation plan organized into semantic feature blocks.
2. Execute each feature block as a shipped unit of work, with phases inside it.
3. Write failing tests first when the phase uses the TDD format.
4. Implement until tests pass.
5. Run recursive review gates until primary review, secondary review, and QA emit `GATE PASS`.
6. Flip the phase checkboxes in the plan.
7. Persist state and continue to the next phase in the current feature.
8. After a feature's phases are complete, run `/ship` and `/land-and-deploy`.
9. Verify the landed feature against the origin plan, then continue to the next feature.
10. After all features complete, verify no feature branches remain unmerged and archive the living/origin plans.

The CLI owns the durable version of this loop. The skill prompt mirrors the same
workflow for smaller plans and tells the agent when to hand off to the CLI.

## Plan Format

Living plans should regroup all source-plan weeks, milestones, blocks, and phases
into deliverable feature sections. Legacy phase-only plans still run as one
default feature.

The preferred phase shape inside each feature is TDD-first:

```markdown
## Feature 1: Parser workflow
Origin trace: Week 1 / Phase 2
Acceptance: Parser behavior satisfies the source plan.

### Phase 1.1: Parser tests
- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests covering the parser behavior.
- [ ] **Implementation (Gemini Sub-agent)**: Make the tests pass with minimal code.
- [ ] **Review & QA (Codex Sub-agent)**: Run review and fix all findings.
```

Legacy two-checkbox phases are still supported:

```markdown
### Phase 1: Parser
- [ ] **Implementation (Gemini Sub-agent)**: Implement the parser.
- [ ] **Review & QA (Codex Sub-agent)**: Run review and fix all findings.
```

The parser accepts `## Feature N: Name`, `### Phase N: Name`, and decimal
numbers like `### Phase 2.1: Name`. It records the exact checkbox line numbers
so the plan mutator can flip only the intended lines. Checkbox-like text inside
fenced code blocks is ignored.

## Skill-Prompt Path

For short plans, `/build` acts as the orchestrator itself:

1. Locate the sibling `*-gstack` repo and use its `inbox/living-plan/` directory.
2. Ask for confirmation after synthesizing a living plan.
3. Create `.llm-tmp/` for file-path I/O with sub-agents.
4. Ask the configured test-writer role to write failing tests.
5. Verify the tests are red.
6. Ask the configured primary-impl role to implement.
7. Re-run tests and use the configured test-fixer role until green.
8. Run the configured review gates.
9. Run the configured QA role and repeat until all gates emit `GATE PASS`.
10. Update checkboxes, print a phase report, and save context.
11. Repeat without asking between phases unless blocked.
12. Delegate final ship and deploy to the configured ship and land roles.
13. Move the completed living plan from `<gstack-repo>/inbox/living-plan/` to
    `<gstack-repo>/archived/`.

All model handoffs use file-path I/O. Large prompts are written to disk and the
sub-agent is told only which input file to read and which output file to write.
That keeps subprocess prompts small and makes logs inspectable after failure.

## CLI Path

For long plans, `/build` should launch `gstack-build` in the background and
monitor `~/.gstack/build-state/<slug>.json` rather than blocking on the process.
The CLI exists because code can reliably drive the phase loop after the current
LLM context is gone.

Startup sequence:

1. Parse args and the plan file.
2. Print the phase table and parser warnings.
3. Resolve the project root from `--project-root`, the current git repo, or the plan location.
4. Run startup gates unless `--dry-run` or `--skip-ship` is active.
5. Acquire a per-plan lock.
6. Load existing state or create fresh state.
7. Drive phases until all are committed.
8. Ship and verify, unless `--skip-ship` or `--dry-run` is active.
9. Release the lock and append an analytics event.

The state slug is `build-<plan-basename-without-extension>`.

## Startup Gates

The CLI has two preflight gates before phase execution:

- Clean working tree check: tracked staged or modified files fail the run.
  Untracked files are ignored. Use `--skip-clean-check` only when the dirty
  state is intentional.
- Unshipped `feat/*` sweep: remote `origin/feat/*` branches not merged into
  `origin/main` are checked out and passed through `/ship` plus
  `/land-and-deploy`. The sweep is capped and failures warn rather than sink the
  current build. Use `--skip-sweep` when this is not appropriate.

Both gates are skipped by `--dry-run` and `--skip-ship`.

## Phase State Machine

`build/orchestrator/phase-runner.ts` is deliberately pure. It takes the current
phase state and the previous action result, then returns the next action.

Typical TDD phase:

```text
pending
  -> RUN_GEMINI_TEST_SPEC
test_spec_done
  -> VERIFY_RED
tests_red
  -> RUN_GEMINI
impl_done
  -> RUN_TESTS
tests_green
  -> RUN_CODEX_REVIEW
review_clean
  -> MARK_COMPLETE
committed
  -> DONE
```

If tests pass during `VERIFY_RED`, the test specification is considered too
weak and the test-writer role is asked to rewrite stricter tests, capped by
`GSTACK_BUILD_RED_MAX_ITER`.

If tests fail after implementation, the test-fixer role gets recursive fix passes, capped by
`GSTACK_BUILD_TEST_MAX_ITER`.

If any review gate emits `GATE FAIL`, the review loop runs again, capped by
`GSTACK_BUILD_CODEX_MAX_ITER`. The phase cannot be marked complete until
primary review, secondary review, and QA all produce `GATE PASS`.

## Dual-Implementor Mode

`--dual-impl` replaces the single implementation pass with a tournament:

1. Confirm or write failing tests.
2. Create two temporary git worktrees.
3. Run Gemini and Codex implementations in parallel.
4. Run independent test-and-fix loops in each worktree.
5. Choose a winner automatically when only one side passes.
6. Otherwise ask the configured judge to review both diffs and test histories.
7. Cherry-pick the winning commits back to the main working tree.
8. Continue through the normal green-tests and Codex-review loop.

Worktrees live under the OS temp directory with names like
`gstack-dual-<slug>-p<N>-<timestamp>/`. Successful runs tear them down.
Winner-apply failures preserve enough context for recovery.

The judge must emit an anchored `WINNER: gemini` or `WINNER: codex` line. Missing
or malformed verdicts fail closed.

## State, Logs, and Resume

Local state is canonical:

```text
~/.gstack/build-state/
  <slug>.json
  <slug>.lock
  <slug>/
    phase-1-gemini-testspec-1-input.md
    phase-1-gemini-testspec-1-output.md
    phase-1-gemini-testspec-1.log
    phase-1-tests-1.log
    phase-1-gemini-1-input.md
    phase-1-gemini-1-output.md
    phase-1-gemini-1.log
    phase-1-codex-1-input.md
    phase-1-codex-1-output.md
    phase-1-codex-1.log
    ship.log
    land-and-deploy.log
```

State writes use temp-file plus rename. Plan checkbox writes do the same. If
gbrain is available, state is mirrored there on a best-effort basis, but local
JSON remains the source of truth.

Resume is automatic. Re-running the same command loads the state file and
continues from the first non-committed phase. Use `--no-resume` to discard
existing state and start fresh.

The lock file prevents two orchestrators from driving the same plan. A stale
lock can be removed manually only after checking that no `gstack-build` process
is still running.

## Sub-Agent Roles

- `testWriter` writes failing tests.
- `primaryImpl` is the primary implementor.
- `testFixer` fixes test failures.
- `review` and `reviewSecondary` run the review gates.
- `secondaryImpl` acts as the second implementor in `--dual-impl`.
- `judge` judges dual-implementor tournaments.
- `qa`, `ship`, and `land` run QA and release commands.

All role providers, models, reasoning levels, and commands are configured in
`build/configure.cm`.

The CLI talks to these tools through subprocess wrappers in
`build/orchestrator/sub-agents.ts`. Codex stdin is explicitly closed because
`codex exec` can otherwise hang.

## Final Ship

After every feature is committed, the CLI runs the existing release skills instead
of using raw GitHub commands:

```text
<configured ship role command>
<configured land role command>
```

Post-ship verification checks:

- no open PR remains for the feature branch
- no unmerged remote `feat/*` branches remain at the final completion exam
- the working tree is clean
- local `HEAD` matches `origin/main`

The build is marked `completed` only after these guardrails pass.

## Failure Handling

Most failures are terminal for the current run but resumable after repair:

- no executable phases in the plan
- dirty tracked working tree at startup
- lock contention
- Gemini timeout or non-zero exit
- tests fail after the maximum fix iterations
- tests pass before implementation after the maximum red attempts
- review gates cannot converge to `GATE PASS`
- Codex output has no parseable gate verdict
- plan checkbox line no longer matches the parsed marker
- dual-implementor judge output is malformed
- winner cherry-pick and patch fallback both fail
- final ship or post-ship guardrail fails

The logs under the phase directory are the first place to inspect. After fixing
the root cause, re-run the same `gstack-build` command to resume.

## Important Flags

| Flag | Effect |
| --- | --- |
| `--print-only` | Parse the plan and print the phase table. |
| `--dry-run` | Walk the state machine without spawning sub-agents or shipping. |
| `--skip-ship` | Complete phases but skip final ship and deploy. |
| `--no-resume` | Ignore existing state and start fresh. |
| `--no-gbrain` | Use only local JSON state. |
| `--dual-impl` | Run Gemini and Codex implementations in parallel worktrees. |
| `--test-writer-model <m>` | Override failing-test writer model. |
| `--primary-impl-model <m>` | Override primary implementor model. |
| `--test-fixer-model <m>` | Override test-fixer model. |
| `--secondary-impl-model <m>` | Override dual-impl secondary model. |
| `--review-model <m>` | Override primary review model. |
| `--review-secondary-model <m>` | Override secondary review model. |
| `--qa-model <m>` | Override QA model. |
| `--ship-model <m>` | Override ship model. |
| `--land-model <m>` | Override land model. |
| `--<role>-provider <p>` | Override role provider (`claude`, `codex`, `gemini`) where supported. Dual-impl requires Gemini primary, Codex secondary, and Claude judge. |
| `--<role>-reasoning <r>` | Override role reasoning (`low`, `medium`, `high`, `xhigh`). |
| `--<role>-command <cmd>` | Override review, QA, ship, or land command. |
| `--test-cmd <cmd>` | Override automatic test command detection. |
| `--origin-plan <file>` | Source plan to verify after each feature and archive after final completion. |
| `--max-codex-iter N` | Override the review gate loop cap. |
| `--skip-clean-check` | Bypass tracked dirty-file preflight. |
| `--skip-sweep` | Bypass unshipped remote `feat/*` branch sweep. |

## Environment Variables

Default role routing, retry caps, and timeouts live in `build/configure.cm`.
Edit that file when the built-in defaults change; use the env vars below for
per-run overrides. Set `GSTACK_BUILD_CONFIG_FILE` to point at a different
config file.

| Variable | Purpose |
| --- | --- |
| `GEMINI_BIN` | Gemini CLI path. |
| `CODEX_BIN` | Codex CLI path. |
| `CLAUDE_BIN` | Claude CLI path. |
| `GBRAIN_BIN` | Optional gbrain CLI path. |
| `GSTACK_BUILD_CONFIG_FILE` | Alternate build config file. |
| `GSTACK_BUILD_DEFAULTS_FILE` | Legacy alias for `GSTACK_BUILD_CONFIG_FILE`. |
| `GSTACK_BUILD_<ROLE>_PROVIDER` | Role provider override where supported. |
| `GSTACK_BUILD_<ROLE>_MODEL` | Role model override. |
| `GSTACK_BUILD_<ROLE>_REASONING` | Role reasoning override. |
| `GSTACK_BUILD_<ROLE>_COMMAND` | Command override for review, QA, ship, land, and context-save roles. |
| `GSTACK_BUILD_GEMINI_TIMEOUT` | Gemini call timeout in milliseconds. |
| `GSTACK_BUILD_CODEX_TIMEOUT` | Codex call timeout in milliseconds. |
| `GSTACK_BUILD_SHIP_TIMEOUT` | Final ship/deploy timeout in milliseconds. |
| `GSTACK_BUILD_CODEX_MAX_ITER` | Review gate loop cap. |
| `GSTACK_BUILD_TEST_TIMEOUT` | Test command timeout in milliseconds. |
| `GSTACK_BUILD_TEST_MAX_ITER` | Gemini test-fix loop cap. |
| `GSTACK_BUILD_RED_MAX_ITER` | Test-spec rewrite cap when tests pass too early. |
| `GSTACK_BUILD_JUDGE_TIMEOUT` | Dual-impl judge timeout in milliseconds. |
| `GSTACK_BUILD_JUDGE_MODEL` | Claude model used for tournament judging. |
| `GSTACK_BUILD_CODEX_IMPL_SANDBOX` | Codex implementor sandbox override. |

Role env vars use `GSTACK_BUILD_<ROLE>_<FIELD>`, where role is
`TEST_WRITER`, `PRIMARY_IMPL`, `TEST_FIXER`, `SECONDARY_IMPL`, `REVIEW`,
`REVIEW_SECONDARY`, `QA`, `SHIP`, `LAND`, or `JUDGE`, and field is
`PROVIDER`, `MODEL`, `REASONING`, or `COMMAND`. CLI flags override env vars;
env vars override defaults.

## Module Map

| File | Responsibility |
| --- | --- |
| `SKILL.md.tmpl` | Human-facing `/build` workflow and CLI-monitoring instructions. |
| `orchestrator/cli.ts` | CLI args, startup gates, lock, main loop, ship guardrails. |
| `orchestrator/parser.ts` | Markdown plan parser. |
| `orchestrator/phase-runner.ts` | Pure phase state machine. |
| `orchestrator/sub-agents.ts` | Gemini, Codex, Claude, test, verdict, and judge wrappers. |
| `orchestrator/plan-mutator.ts` | Atomic checkbox updates in the plan file. |
| `orchestrator/state.ts` | Local JSON state, gbrain mirror, lock files, log paths. |
| `orchestrator/worktree.ts` | Dual-impl worktree creation, teardown, and winner apply. |
| `orchestrator/ship.ts` | Final `/ship` plus `/land-and-deploy` delegation. |
| `orchestrator/types.ts` | Shared phase and build state types. |

## Testing

Run the focused test suite:

```bash
bun test build/orchestrator/__tests__/
```

The suite covers parser edge cases, state persistence, lock behavior, plan
mutation, test command detection, verdict parsing, phase transitions, dry-run
integration, startup gates, prompt shapes, and dual-implementor worktree flows.

After changing `build/SKILL.md.tmpl`, regenerate generated skill files:

```bash
bun run gen:skill-docs --host codex
```
