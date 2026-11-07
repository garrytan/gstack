# gstack — AI Engineering Workflow

gstack is a collection of SKILL.md files that give AI agents structured roles for
software development. Each skill is a specialist: CEO reviewer, eng manager,
designer, QA lead, release engineer, debugger, and more.

## Available skills

Skills live in `.agents/skills/` (or `~/.claude/skills/gstack/` on Claude Code).
Invoke them by name (e.g., `/office-hours`). This index lists names only; what each
skill does, with examples, is in [docs/skills.md](docs/skills.md). The iOS companion
CLIs (`gstack-ios-qa-daemon`, `gstack-ios-qa-mint`, `gstack-ios-qa-regen`) are in
[docs/howto-ios-testing-with-gstack.md](docs/howto-ios-testing-with-gstack.md).

| Skill | Area |
|-------|------|
| `/office-hours` | plan |
| `/plan-ceo-review` | plan |
| `/plan-design-review` | plan |
| `/plan-devex-review` | plan |
| `/plan-tune` | plan |
| `/autoplan` | plan |
| `/design-consultation` | plan |
| `/spec` | plan |
| `/review` | build + review |
| `/deslop-shared-libs` | build + review |
| `/write-skill` | build + review |
| `/test-audit` | build + review |
| `/codex` | build + review |
| `/claude-code` | build + review |
| `/verify` | build + review |
| `/design-review` | build + review |
| `/design-shotgun` | build + review |
| `/design-html` | build + review |
| `/design-motion` | build + review |
| `/devex-review` | build + review |
| `/qa` | build + review |
| `/qa-only` | build + review |
| `/scrape` | build + review |
| `/skillify` | build + review |
| `/ship` | release + deploy |
| `/land-and-deploy` | release + deploy |
| `/modernize` | release + deploy |
| `/canary` | release + deploy |
| `/landing-report` | release + deploy |
| `/document-release` | release + deploy |
| `/document-generate` | release + deploy |
| `/setup-deploy` | release + deploy |
| `/gstack-upgrade` | release + deploy |
| `/context-save` | operational + memory |
| `/context-restore` | operational + memory |
| `/learn` | operational + memory |
| `/retro` | operational + memory |
| `/health` | operational + memory |
| `/captain` | operational + memory |
| `/benchmark` | operational + memory |
| `/ubicloud` | operational + memory |
| `/runaway-stopper` | operational + memory |
| `/benchmark-models` | operational + memory |
| `/eval-plan` | operational + memory |
| `/cso` | operational + memory |
| `/setup-gbrain` | operational + memory |
| `/sync-gbrain` | operational + memory |
| `/browse` | browser |
| `/open-gstack-browser` | browser |
| `/setup-browser-cookies` | browser |
| `/pair-agent` | browser |
| `/ios-qa` | iOS QA |
| `/ios-fix` | iOS QA |
| `/ios-design-review` | iOS QA |
| `/ios-clean` | iOS QA |
| `/ios-sync` | iOS QA |
| `/careful` | safety + scoping |
| `/freeze` | safety + scoping |
| `/guard` | safety + scoping |
| `/unfreeze` | safety + scoping |
| `/make-pdf` | safety + scoping |
| `/diagram` | safety + scoping |

## Validation discipline

When fixing failures or preparing `/ship`, follow this order:

1. List the known failing cases, their logs and source revision, the demonstrated
   cause, and the smallest check that can prove each repair. Keep one current
   list in `.context/`; update it instead of starting overlapping repair plans.
   Reconcile the runner's failure total with named failures and unhandled or
   module-load errors; the named-test footer alone is not the complete inventory.
2. Resolve base-branch integration and assign one owner per shared file before
   editing. Keep repairs within the observed failures and the user's scope.
   Before a fixture writes through a link, resolve its target and verify it stays
   inside that fixture's temporary root; live skill registrations can point back
   into this checkout.
   When upstream replaces a helper API, inventory every direct caller, mock
   adapter, source snapshot, generated golden, and selection edge before choosing
   focused checks. Verify extracted test adapters supply the current imports and
   result schema; an adapter failure is not evidence that production failed.
   Schedule independent checks independently. Gate a check only on inputs or
   prerequisites it actually needs; an unrelated failure must not serialize the
   whole validation plan. Keep source fixed while tests live-link its files.
3. Diagnose before changing code. Distinguish a product defect, an invalid test
   expectation, a detector/fixture defect, and a launch/environment failure.
   Preserve the original failure. Do not call it pre-existing without evidence.
   Verify pinned runtime tool schemas and defaults before treating omitted fields
   as model noncompliance.
   Check that a bounded evaluation’s fixture scope and automated answers support
   its metric. Do not let the driver approve unrelated expansion, then blame the
   skill for the extra work; preserve required findings and evidence limits.
4. Reproduce with the smallest relevant test. For agent tests, reuse captured
   public events in free regressions, including negative controls, before paying
   for another agent run. Check behavior and acknowledgments; match exact prose
   only when that prose is the contract. Do not lower thresholds, increase model
   budgets, skip cases, or rejudge a failure to manufacture a pass. A
   pre-registered fixed panel is not rejudging.
   For any measured speedup, regression or eval delta, name the limiter that
   moved and the run-to-run variation; a gap smaller than that variation is no
   difference.
   For policy or validation repairs, exercise the actual registered callback with
   representative native input and assert that it uses the helper’s result.
   When renderer or parser failures recur at the same boundary, verify the
   supported input class against the pinned runtime. Keep adversarial controls;
   do not add one spelling or glyph per paid failure.
   For workflow clarity failures, read the complete evaluated excerpt and its
   referenced source. Resolve all demonstrated ambiguities together: order,
   definitions, ownership and approval. Consolidate dense instructions into
   executable steps instead of appending more clauses. Review the resulting
   workflow as a whole; prose snapshots alone do not prove it is clear.
   For each gate, identify when its inputs exist and trace normal,
   skipped/unavailable and late-change paths to catch circular prerequisites or
   bypassed checks.
5. Run required cheap CI checks, including credential scanning, before paid work.
   Also run adjacent cheap checks: generated-content freshness, prompt-size/parity
   limits, source assertions, fixture checks, and dependency selection as
   applicable. A changed prompt must clear these before its eval.
   For skill edits, include `bun test test/parity-suite.test.ts`: its historical
   union-size cap is separate from the other prompt-size and context budgets.
   When workflow wording changes, search the entire test tree for removed
   clauses, including always-loaded prompt guards. Test fixtures containing
   subprocess examples must pass `test/spawnsync-timeout-tripwire.test.ts`;
   its scanner also checks quoted code.
   Run its selected quality judge before long behavioral evaluations that read
   the same changed prompt. If a repair supersedes an active run's inputs, cancel
   that run, preserve completed outcomes, and label unfinished cases as cancelled.
   Check each edit or setup command’s result before running dependent checks. A
   failed edit is not a reason to test the unchanged input again.
6. Declare a fixture actor’s supported interactions before the model starts.
   Keep its answers and permission handling within that declared interface.
   Bind artifact ownership to the same isolated state passed to the child;
   ambient environment paths do not establish ownership. Check whole-file and
   CI supervision against every case and configured retry, not just one attempt.
   Preflight the actual launcher: required binaries, isolated state, display when
   needed, explicit test tier, selection, and expected executed-case counts.
   Match the runtime versions pinned by the workflow and its container image.
   Keep socket-bearing temporary paths short after the runner adds its nested
   directories; exercise that exact layout in the smoke check. Store long-lived
   logs separately from socket directories.
   Verify required tool execution with a no-cost smoke check under that launch
   environment; versions and authentication alone do not prove it works. Set
   private artifact modes explicitly and preserve normal fixture permissions.
   Prove a diagnostic snapshot survives fixture cleanup in the final artifact
   directory before paid work; native snapshots require EVALS_RUN_ID or GSTACK_EVAL_DIR.
   Bind complete spool filenames and classify Bun's out-of-tier describe.skip
   placeholders separately, with zero selected-case credit.
   Put standalone Git fixtures outside another checkout; verify their resolved
   project slug and state root before interpreting a failure.
   Prove a seed commit succeeds there: repository-local author configuration
   does not establish the identity available to a fresh fixture repository.
   Reject missing explicit test files before invoking Bun; it can silently ignore
   a nonexistent file selector and pass the remaining files.
   Preserve exit status through logging. Use the documented detached runner and
   eval lock. Review the final launcher after edits; preparation and `--list`
   modes must not start monitors, retainers, or test processes. Verify this with
   a before/after process check. During long runs, inspect the last public tool
   result and pending permission state; diagnose a blocked actor before waiting
   through its deadline. Preserve cancellation separately from a test verdict.
   Skipped or unstarted cases
   do not satisfy coverage; preserve every attempt. Paid evals never retry, with
   one exception: the gate reruns a red rule, behavior or judge case verdict once
   at the same head (Garry, 2026-10-19: "you can just run the failed test again
   and note that it is flaky"); a pass is green with a flaky annotation and a
   flake record, a second failure is a real red, and harness, INFRA, INCOMPLETE
   or unattributed reds never rerun (`docs/TESTING_INTERNALS.md#flaky-reruns`). Each
   case's kind (`E2E_KINDS`) fixes its trials before the run: `rule` one trial;
   `behavior` a panel of 3 independent trials, PASS at >= 2 with no contract
   violation; `judge` 3 samples on one output, each dimension gated on its
   median (at least 2 of 3 samples) against the unchanged threshold. Never add trials, samples or dispatches after seeing a
   result, never change a kind to change a verdict without pass-rate evidence,
   and report every trial. Quarantine follows `CASE_QUARANTINE`'s entry and exit
   rules only (`EVAL_POLICY`, `docs/TESTING_INTERNALS.md`). A census whose every
   red is machine-classified INFRA or INCOMPLETE may be re-dispatched once as a
   new run; report both runs.
7. Prove all known repairs with focused tests, including affected paid cases.
   Rerun a failed case only after a concrete repair or a demonstrated launch
   correction. Run the remaining required selected evaluations on the integrated
   code. Do not use the full free suite to discover predictable adjacent failures.
   Reuse a passing check when its consumed inputs and relevant environment are
   unchanged. For model judges, compare the expanded prompt, rubric, parameters
   and dependencies; a different commit alone does not invalidate the result.
   Do not resample an unchanged passing judge to simplify launcher configuration.
   Preserve its original source and label the result as reused evidence.
   Use actual prompt builders and compare complete bytes when proving model-input
   identity; preserve literal text in excerpts and record the consumed inputs.
8. Finish review fixes, generation, release metadata, and build before final
   acceptance. Freeze the code, then run `bun run test` once at the end. During
   repair, focused checks replace a full-suite run before every commit. If final
   acceptance unexpectedly fails, retain the failure, diagnose it narrowly, and
   report the changed validation plan before another full run; never retry it
   blindly or claim a pass from an older revision.
9. Publish only with passing required checks, unless the user explicitly grants
   an exception for identified failures. Report revision, actual pass/fail/skip
   counts, and incomplete coverage. A passing subset is not release acceptance.

## Build commands

```bash
bun install              # install dependencies
bun run typecheck        # strict tsc over product code; must report zero errors
bun run typecheck:test   # test-code type-debt ratchet (new diagnostics fail; --write-baseline locks in fixes)
bun run format:cso       # format lib/cso/*.ts (format:cso:check is the CI gate)
bun run test:quick       # fast measured free subset for edit feedback (not acceptance)
bun run test             # complete free suite via the strict shard runner (no API spend)
bun run eval:bg:pr       # changed live probes + selected judges; dispatches CI when HEAD is clean and pushed, else runs locally
bun run eval:bg:release  # fresh complete gate + periodic live coverage (same backend choice)
bun run test:health      # audit success metrics and weekly health from CI history (free; needs gh)
bun run build            # generate docs + compile binaries
bun run gen:skill-docs   # regenerate SKILL.md files from templates
bun run skill:check      # health dashboard for all skills
```

Every other test and eval command (Ubicloud, the Windows subset, one paid tier
or case, branch validation in CI, pass rates, plan previews), with its cost and
prerequisites, is in [Which command do I run?](CONTRIBUTING.md#which-command-do-i-run).
Agents poll `eval:bg:*` logs for the `### gstack-detach EXIT=<code> ###` sentinel
([CLAUDE.md](CLAUDE.md#running-evals-as-an-agent-always-detach-sigterm-proof)).

## Platform support

Support tiers (full: macOS, Linux; minimal: Windows, Gemini models) are in
[docs/support-tiers.md](docs/support-tiers.md).

- **macOS** + **Linux**: full test suite supported.
- **Windows**: minimal support; [docs/support-tiers.md](docs/support-tiers.md)
  says what is promised. Every PR must pass the `windows-smoke` check (`./setup`,
  the core skills start, the fastest Windows-safe tests); the curated
  Windows-safe subset runs nightly on main in `windows-free-tests` and never
  blocks a PR. Setup script (`./setup`) requires Git Bash or
  MSYS today; native PowerShell support is a future expansion. The `bin/gstack-paths`
  helper resolves state roots through `CLAUDE_PLUGIN_DATA` / `GSTACK_HOME` so plugin
  installs work on every platform.
- **CSO native helper**: `/cso` additionally needs Bun's four
  `--no-compile-autoload-*` flags and a native toolchain (static-capable C on
  Linux, Xcode command-line tools on macOS, or VS 2022 C++ Build Tools on
  Windows). Setup installs everything else and leaves `/cso` explicitly
  unavailable when that optional toolchain is absent.
- **Browser and renderer**: the browser skills, `/make-pdf`, and `/diagram` drive
  the Aside browser first, which is macOS 15+ only. On Linux and Windows (or a
  Mac with Aside closed) the readiness check says so once and the same skills use
  gstack's own bundled browser, built by `./setup`.

## Key conventions

- SKILL.md files are **generated** from `.tmpl` templates. Edit the template, not the output.
- Run `bun run gen:skill-docs --host codex` to regenerate Codex-specific output.
- Browser steps in skills are `aside repl` scripts per `scripts/resolvers/aside.ts` (Aside first), each with a `$B` equivalent for the fallback engine — `$B <command>` is the browse binary and is a legitimate tool when the Aside probe does not print `READY`. Local HTML renders through `bin/gstack-render.ts`, which picks the same way.
- Safety skills (careful, freeze, guard) use inline advisory prose — always confirm before destructive operations.
- State paths resolve through one chain owned by `lib/state-root.ts` and its sourced bash twin `bin/gstack-state-root.sh` (`GSTACK_STATE_ROOT` → `GSTACK_HOME` → `GSTACK_STATE_DIR` → gstack's `CLAUDE_PLUGIN_DATA` → `~/.gstack`; see docs/state-root.md). Skill prose uses `GSTACK_STATE_ROOT=$(bin/gstack-paths --get GSTACK_STATE_ROOT)` with its `${GSTACK_STATE_ROOT:?…}` guard (worktree-isolated Claude Code sessions refuse eval); `test/state-root-ratchet.test.ts` rejects hand-rolled chains.
- Browse daemon HTTP routes are entries in `browse/src/routes/table.ts` (its header shows how to add one); never dispatch on `url.pathname` in `server.ts`.
- Both test lanes run shards through `scripts/lib/shard-engine.ts`; the free and paid runners hold lane policy only. PTY harness code lives in `test/helpers/pty/*` behind the `claude-pty-runner.ts` barrel.
- Outside-voice failure prose (auth, timeout, empty, fallback) comes only from `outsideVoiceFailurePolicy()` in `scripts/resolvers/outside-voice.ts`.
- Every env-var-host fence starts with the shared prelude from `scripts/resolvers/runtime-root.ts` (inserted by its post-render pass); never resolve gstack's root by hand in a template.
- Every Codex run's verdict goes through `lib/outside-review-result.ts`; its reason codes live in `lib/gate-outcomes.ts`, each with a `docs/troubleshooting.md` anchor.
- `test/module-size-ratchet.test.ts` keeps refactored owner modules at or under 800 lines (150 per function) and residual files from growing.
- The `claude` CLI binary resolves via `lib/claude-bin.ts` (re-exported from `browse/src/claude-bin.ts` for browse internals; `Bun.which()` + `GSTACK_CLAUDE_BIN` override). Set `GSTACK_CLAUDE_BIN=wsl` plus `GSTACK_CLAUDE_BIN_ARGS='["claude"]'` to run Claude through WSL on Windows.
- Every Bun gstack starts ignores the working directory's `.env` files and `bunfig.toml`: bun shebangs are `#!/usr/bin/env -S bun --no-env-file --config=/dev/null`, skill prose passes `bun --no-env-file --config=/dev/null`, shipped shell files define `GSTACK_BUN_CONFIG` with the line in `test/bun-entry-isolation.test.ts` (`NUL` when `OSTYPE` is `msys` or `cygwin` and `cygpath` is on `PATH`, where native Bun cannot open `/dev/null`, #3415) and pass `bun --no-env-file --config="${GSTACK_BUN_CONFIG:-/dev/null}"`, TypeScript spawns use `bunIsolationArgs()` from `lib/bun-isolation.ts`, and `bun build --compile` adds `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`. `test/bun-entry-isolation.test.ts` enforces all four.
