# Pi Software Factory Roadmap

Status: living roadmap after structured factory review auto-capture.

This document is the chunk roadmap for future agents working on the Pi software
factory. Read this after `PI_SOFTWARE_FACTORY_ARCHITECTURE.md` and
`PI_FACTORY_REVIEW_WORKFLOW.md` before planning new factory work.

## Guardrails for every chunk

- Keep `lib/factory-core.ts` pure: no filesystem, shell, browser, network, or Pi SDK calls.
- Keep actions/IO in runtime adapters such as the Pi extension, setup scripts, stores, or dedicated adapter modules.
- Preserve ACD layering:
  - Data: workflow specs, run plans, policy, events, artifacts.
  - Calculations: planning, reduction, matching, validation, selection.
  - Actions: Pi messages, shell/git, filesystem, browser, UI, package install, CI/PRs.
- Use exact `git add` paths. Never `git add .`.
- Do not commit generated `.pi/skills/` unless a future explicit distribution plan says otherwise.
- Do not touch unrelated dirty files. As of this roadmap creation, `CLAUDE.md` and `package-lock.json` may be dirty for unrelated reasons.
- Ask before dependency/package/distribution changes.
- Run focused tests for the chunk and the Pi/factory compatibility checks before committing.
- Use reviewer subagent for meaningful non-trivial implementation chunks, especially adapter/runtime changes.

## Current implemented baseline

The following pieces are already present:

- Pi host generation via `hosts/pi.ts`.
- Pi setup support in `./setup --host pi`.
- Pi runtime sidecar exposure under `.pi/skills/gstack` and `~/.pi/agent/skills/gstack`.
- Pi extension at `.pi/extensions/pi-gstack/index.ts` with:
  - generated skill aliases: `/office-hours`, `/autoplan`, `/review`, `/qa`, `/ship`;
  - `ask_user_question` custom tool;
  - `gstack_browser` custom tool;
  - `/factory-review`, `/factory-status`, `/factory-complete-review`.
- Pure factory core contracts/calculations in `lib/factory-core.ts`.
- Orchestrator/runner/runtime capability contracts:
  - `lib/factory-orchestrator.ts`
  - `lib/factory-runner.ts`
  - `lib/factory-capabilities.ts`
- Durable event and artifact stores:
  - `lib/factory-event-store.ts`
  - `lib/factory-artifact-store.ts`
- First workflow spec:
  - `lib/factory-review-workflow.ts`
- Review artifact auto-capture helpers:
  - `lib/factory-review-capture.ts`

## Completed Chunk A — automatic review artifact capture

Goal: make `/factory-review <goal>` complete from the durable generated
`/skill:gstack-review` review log instead of requiring manual
`/factory-complete-review`, while preserving manual fallback.

Implemented behavior:

- `/factory-review` records durable dispatch metadata for `diff-review`:
  - factory run id;
  - queued skill command;
  - dispatched-at timestamp;
  - commit short SHA.
- The queued `/skill:gstack-review` request includes a `factory_run_id` correlation instruction.
- On Pi `agent_end`, the extension attempts auto-capture for pending factory review runs.
- `/factory-recover-review <run-id>` explicitly attempts recovery for the requested run; `/factory-status <run-id>` is inspection-only.
- Capture source is the durable gstack review log:
  - `$GSTACK_HOME/projects/$SLUG/$BRANCH-reviews.jsonl`
  - `$GSTACK_HOME` defaults to `$HOME/.gstack`.
- Capture selection fails closed unless exactly one log entry matches:
  - `skill === "review"`;
  - complete review status (`clean` or `issues_found`);
  - timestamp after dispatch;
  - matching commit;
  - matching `factory_run_id`.
- Successful capture writes a review artifact, appends `phase_completed` for
  `diff-review`, resumes the runner through `review-summary`, and records
  `run_completed`.
- Missing log, malformed log, missing correlation, missing commit, or ambiguous
  matches leave the run pending.
- `/factory-complete-review` remains a safe fallback and still requires pending
  `diff-review` state.

Important follow-up from Chunk A:

- The `factory_run_id` correlation is currently injected into the queued review
  prompt. Chunk B should formalize this in the generated review skill's durable
  log contract so it is not only an ad hoc prompt addendum.

## Chunk B — harden structured factory review recovery and UX

Recommended next chunk.

Goal: make the first factory workflow operationally robust and easy to inspect.

Scope:

1. Formalize factory correlation in the generated review-log contract.
   - Update `review/SKILL.md.tmpl` so Step 5.8 says: if the input prompt includes
     `factory_run_id`, include that exact value as a top-level `factory_run_id`
     field in the `gstack-review-log` JSON.
   - Add/adjust generation tests so this contract stays present in generated
     review skills, including Pi output.
   - Keep `bin/gstack-review-log` generic unless a concrete need appears.

2. Improve multi-pending auto-capture now that `factory_run_id` exists.
   - `agent_end` should be able to scan all pending factory review runs and
     independently capture each run that has exactly one matching correlated log.
   - Multiple pending runs should not block a specifically correlated match.
   - `/factory-recover-review <run-id>` should recover that target run even when other
     runs are pending.
   - Still fail closed per run on no match, multiple matches, missing commit,
     missing dispatchedAt, or missing `factory_run_id`.

3. Improve status/list/artifact UX.
   - Add `/factory-list` or equivalent if desired.
   - Expand `/factory-status <run-id>` to show useful durable state:
     - status;
     - current phase;
     - completed phases;
     - artifact ids and paths;
     - pending external review metadata;
     - last updated time if available;
     - ambiguity/no-match recovery hints.

4. Add provenance metadata to manual fallback artifacts.
   - For `/factory-complete-review`, include metadata such as:
     - `capturedFrom: "manual-fallback"`;
     - dispatch commit;
     - dispatchedAt;
     - queuedSkillCommand;
     - factoryRunId.
   - Keep the existing requirement that the run is pending `diff-review` before
     fallback completion.

5. Tests to add/update.
   - Generated review skill/template includes optional `factory_run_id` logging rule.
   - Multiple pending runs with distinct correlated log entries capture the correct run(s).
   - `/factory-recover-review <run-id>` can recover a target run while other runs remain pending.
   - Missing/wrong `factory_run_id` leaves a run pending.
   - Manual fallback artifact includes provenance metadata and still works after
     an auto-capture ambiguity/no-match.
   - Existing Chunk A fail-closed cases remain green.

Suggested validation:

```bash
bun test test/factory-review-capture.test.ts test/pi-extension.test.ts test/pi-runtime-adapter.test.ts test/factory-runner.test.ts test/factory-artifact-store.test.ts test/factory-event-store.test.ts test/factory-core.test.ts
bun run gen:skill-docs --host pi --dry-run
bun test test/pi-compatibility.test.ts test/gen-skill-docs.test.ts test/host-config.test.ts
bun -e "await import('./.pi/extensions/pi-gstack/index.ts'); console.log('pi extension import ok')"
```

Suggested commit message:

```text
Harden factory review recovery
```

## Chunk C — add a public factory runtime facade

Goal: make the factory reusable by Pi and external SDK consumers without each
caller manually wiring runner, stores, workflow lists, and adapters.

Scope:

1. Add a public facade module, likely `lib/factory.ts`.
2. Expose high-level APIs such as:
   - `planFactoryRun(...)` for pure planning;
   - `runFactoryWorkflow(...)` for runtime-backed execution;
   - `continueFactoryRun(...)`;
   - `readFactoryRunStatus(...)`;
   - `listFactoryRuns(...)`;
   - `readFactoryArtifact(...)`.
3. Keep pure planning functions separate from action-backed store/runtime helpers.
4. Define stable DTOs for status/list/artifact reads so callers do not need to
   parse event internals.
5. Refactor the Pi extension to use the facade where it reduces duplication.
6. Preserve low-level classes for tests and advanced callers.

Tests:

- External-app-style usage can plan, start, inspect, and continue a review run.
- Facade APIs preserve current Pi extension behavior.
- Core purity remains intact.

Suggested commit message:

```text
Add factory runtime facade
```

## Chunk D — add gate and resume semantics

Goal: turn `GateSpec`, `GateRequest`, and `GateDecision` from mostly data
contracts into executable workflow behavior.

Scope:

1. Teach runner/runtime to emit gate requests for phases that require decisions.
2. Pause runs when a fail-closed or human gate is pending.
3. Add resume behavior after a gate decision event is recorded.
4. Add adapter hooks for asking/deciding gates.
5. Add Pi command support for inspecting/responding to gates, for example:
   - `/factory-gates <run-id>`;
   - `/factory-decide <run-id> <gate-id> <request-sequence> <approve|reject|waive|cancel> [reason]`.
   - `/factory-gates <run-id>` displays the current request sequence for each pending gate.
6. Make cancellation/failure semantics explicit.

Tests:

- Run pauses on gate request.
- Run resumes after accepted decision.
- Fail-closed/default-deny behavior works when no UI/decision is available.
- State reduction remains deterministic.

Suggested commit message:

```text
Add factory gate resume flow
```

## Chunk E — add structured QA workflow

Goal: add the second factory workflow after review, exercising browser/test
capabilities without taking on full release risk.

Scope:

1. Add `FACTORY_QA_WORKFLOW` and include it in `FACTORY_WORKFLOWS`.
2. Add opt-in `/factory-qa <goal-or-url>` command for audit/no-fix QA.
3. Reuse existing generated `/skill:gstack-qa-only` methodology for default audit dispatch, and reserve `/skill:gstack-qa` for explicit write-capable QA-fix runs.
4. Decide whether QA completion can use a durable log, transcript artifact, or
   manual fallback for the first slice.
5. Integrate `gstack_browser` where appropriate, but keep browser actions in adapters.
6. Persist QA artifacts under the same event/artifact store model.

Tests:

- QA workflow plan compiles with required capabilities.
- `/factory-qa` starts and records pending external QA work.
- Status/list/artifact inspection works for QA runs.
- Browser capability absence blocks according to policy when browser phases are selected.

Suggested commit message:

```text
Add structured factory QA workflow
```

## Chunk F — define subagent, parallel, and worktree scheduling

Goal: make factory concurrency semantics real instead of only data labels.

Scope:

1. Define a scheduler abstraction for:
   - serial phases;
   - parallel-readonly phases;
   - isolated-worktree phases.
2. Enforce `maxParallelWriteTimelines`.
3. Add ownership/integration metadata for isolated worktrees.
4. Integrate with Pi SDK sessions or configured Pi subagent extension.
5. Keep destructive/write actions behind explicit policy and user gates.

Tests:

- Readonly phases can fan out and join deterministically.
- Write-capable phases do not run concurrently in one worktree.
- Worktree-required phases fail closed without worktree capability.
- Event order remains reconstructable.

Suggested commit message:

```text
Add factory scheduling policy
```

## Chunk G — add structured ship/release workflow

Goal: port the highest-value action-heavy workflow only after gates, facade,
artifacts, and scheduling are strong enough.

Scope:

1. Add `FACTORY_SHIP_WORKFLOW`.
2. Model release gates for:
   - tests;
   - version bump;
   - changelog;
   - review status;
   - CI;
   - PR creation/update;
   - deploy/release readiness.
3. Add or adapt capabilities for:
   - git write operations;
   - test runner;
   - CI;
   - pull request;
   - package/release checks.
4. Preserve existing `/ship` generated skill behavior until the factory workflow
   is proven.
5. Start opt-in, likely `/factory-ship`.

Tests:

- Plan-only mode shows expected gates/capabilities.
- Missing write/CI/PR capabilities blocks safely.
- Gate decisions resume correctly.
- No production/external action runs in tests without explicit fakes.

Suggested commit message:

```text
Add structured factory ship workflow
```

## Later work — Pi distribution/package path

This can happen alongside or after Chunks C-E depending on priorities.

Open questions:

- How should gstack's Pi extension be packaged for non-dev users?
- Should generated `.pi/skills/` be built during package installation?
- What migration/upgrade path should existing Pi installs use?
- How should extension and generated skills be versioned together?

Possible deliverables:

- Package/install design doc.
- Setup migration tests.
- Pi package smoke test.
- Release checklist updates.

## Quick orientation for future agents

If asked to continue “the next chunk,” default to Chunk B unless a later chunk is
explicitly requested or already completed. Before coding, inspect:

- `docs/designs/PI_SOFTWARE_FACTORY_ARCHITECTURE.md`
- `docs/designs/PI_FACTORY_REVIEW_WORKFLOW.md`
- this file
- `.pi/extensions/pi-gstack/index.ts`
- `lib/factory-*.ts`
- `test/pi-extension.test.ts`
- `test/factory-*.test.ts`

Then verify current git status and avoid unrelated dirty files.
