# Pi Software Factory Roadmap

Status: living roadmap after factory facade, gates, QA, scheduling, ship-readiness, safety hardening, command UX polish, and web-app planning docs.

This document is the chunk roadmap for future agents working on the Pi software factory. Read this after `PI_SOFTWARE_FACTORY_ARCHITECTURE.md` and `PI_FACTORY_REVIEW_WORKFLOW.md` before planning new factory work.

## Guardrails for every chunk

- Keep `lib/factory-core.ts` pure: no filesystem, shell, browser, network, or Pi SDK calls.
- Keep actions/IO in runtime adapters such as the Pi extension, setup scripts, stores, or dedicated adapter modules.
- Preserve ACD layering:
  - Data: workflow specs, run plans, policy, events, artifacts.
  - Calculations: planning, reduction, matching, validation, selection.
  - Actions: Pi messages, shell/git, filesystem, browser, UI, package install, CI/PRs.
- Use exact `git add` paths. Never `git add .`.
- Do not commit generated `.pi/skills/` unless a future explicit distribution plan says otherwise.
- Do not touch unrelated dirty files. At the time of this update, `CLAUDE.md` and `package-lock.json` may be dirty for unrelated reasons.
- Ask before dependency/package/distribution changes.
- Run focused tests for the chunk and Pi/factory compatibility checks before committing.
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
  - `/factory-review`;
  - `/factory-qa` audit/no-fix mode;
  - `/factory-complete-review`;
  - `/factory-complete-qa`;
  - `/factory-recover-review`;
  - `/factory-status` inspect-only status;
  - `/factory-list`;
  - `/factory-gates`;
  - `/factory-decide <run-id> <gate-id> <request-sequence> <approve|reject|waive|cancel> [reason]`.
- Pure factory core contracts/calculations in `lib/factory-core.ts`, including:
  - policy merge;
  - capability risk detection;
  - browser-disabled blocking;
  - command safety profiles;
  - event reduction;
  - workflow/phase/gate/artifact contracts.
- Orchestrator/runner/runtime capability contracts:
  - `lib/factory-orchestrator.ts`;
  - `lib/factory-runner.ts`;
  - `lib/factory-capabilities.ts`.
- Public runtime facade in `lib/factory.ts`:
  - `planFactoryRun()`;
  - `createFactoryFacade()`;
  - run/continue/status/list/artifact/gate/decision DTOs.
- Durable event and artifact stores:
  - `lib/factory-event-store.ts`;
  - `lib/factory-artifact-store.ts`.
- Workflow specs:
  - `lib/factory-review-workflow.ts`;
  - `lib/factory-qa-workflow.ts`;
  - `lib/factory-ship-workflow.ts`.
- Review artifact auto-capture helpers:
  - `lib/factory-review-capture.ts`.
- Scheduler calculations:
  - `lib/factory-scheduler.ts`.
- Web-app planning artifacts:
  - `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md`;
  - `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md`;
  - `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md`.
- Factory hardening/review artifacts:
  - `docs/designs/PI_FACTORY_TEST_COVERAGE_GAP_PASS.md`;
  - `docs/designs/PI_FACTORY_PUBLIC_API_REVIEW.md`;
  - `docs/designs/PI_FACTORY_COMMAND_UX_POLISH.md`.

## Completed Chunk A — automatic review artifact capture

Goal: make `/factory-review <goal>` complete from the durable generated `/skill:gstack-review` review log instead of requiring manual `/factory-complete-review`, while preserving manual fallback.

Implemented behavior:

- `/factory-review` records durable dispatch metadata for `diff-review`:
  - factory run id;
  - queued skill command;
  - dispatched-at timestamp;
  - commit short SHA.
- The queued `/skill:gstack-review` request includes a `factory_run_id` correlation instruction.
- Generated review logs are expected to include top-level `factory_run_id` when present in the prompt.
- On Pi `agent_end`, the extension attempts auto-capture for pending factory review runs.
- `/factory-recover-review <run-id>` explicitly attempts recovery for the requested run.
- `/factory-status <run-id>` is inspection-only and does not auto-capture.
- Capture source is the durable gstack review log:
  - `$GSTACK_HOME/projects/$SLUG/$BRANCH-reviews.jsonl`;
  - `$GSTACK_HOME` defaults to `$HOME/.gstack`.
- Capture selection fails closed unless exactly one log entry matches:
  - `skill === "review"`;
  - complete review status (`clean` or `issues_found`);
  - timestamp after dispatch;
  - matching commit;
  - matching `factory_run_id`.
- Successful capture writes a review artifact, appends `phase_completed` for `diff-review`, resumes the runner through `review-summary`, and records `run_completed`.
- Missing log, malformed log, missing correlation, missing commit, or ambiguous matches leave the run pending.
- `/factory-complete-review` remains a safe fallback and still requires pending `diff-review` state.
- Duplicate manual review completion and repeated recovery are covered by idempotency tests.

## Completed Chunk B — harden structured factory review recovery and UX

Goal: make the first factory workflow operationally robust and easy to inspect.

Implemented behavior:

- Durable review correlation uses `factory_run_id`.
- Multiple pending runs can be recovered independently when a matching correlated log exists.
- Targeted `/factory-recover-review <run-id>` can recover one run while other runs remain pending.
- `/factory-status <run-id>` is inspect-only.
- `/factory-list` lists durable runs with workflow, status, phase, progress, artifacts, gates, and next action.
- `/factory-status <run-id>` shows useful durable state:
  - workflow;
  - mode;
  - goal;
  - status;
  - current phase;
  - progress;
  - completed phases;
  - artifact ids and safe paths;
  - pending external review/QA metadata;
  - last updated time;
  - recovery and next-action hints.
- Manual fallback artifacts include provenance metadata.
- Manual fallback and recovery paths use validated appends/idempotent pending-state checks.

## Completed Chunk C — public factory runtime facade

Goal: make the factory reusable by Pi and external SDK consumers without each caller manually wiring runner, stores, workflow lists, and adapters.

Implemented behavior:

- `lib/factory.ts` exposes:
  - `planFactoryRun(...)` for pure planning;
  - `createFactoryFacade(...)`;
  - `runFactoryWorkflow(...)`;
  - `continueFactoryRun(...)`;
  - `readFactoryRunStatus(...)`;
  - `listFactoryRuns(...)`;
  - `readFactoryArtifact(...)`;
  - `listFactoryGates(...)`;
  - `decideFactoryGate(...)`.
- Public DTOs exist for run operations, status, list items, artifacts, gates, and gate decisions.
- Pure planning remains separate from action-backed store/runtime helpers.
- Facade tests cover external-app-style planning, start, inspect, list, continue, artifact reads, gate lists, and gate decisions.
- Public API review is captured in `docs/designs/PI_FACTORY_PUBLIC_API_REVIEW.md`.

Important current API boundary:

- The facade is **run-scoped**.
- Future web/project APIs should wrap it with workspace/project DTOs rather than changing the pure run contracts prematurely.

## Completed Chunk D — gate and resume semantics

Goal: turn `GateSpec`, `GateRequest`, and `GateDecision` into executable workflow behavior.

Implemented behavior:

- Runner emits gate requests for phases requiring decisions.
- Runs pause when fail-closed or human gates are pending.
- Runs resume after accepted decisions are recorded.
- Rejected/cancelled gates cancel safely.
- Policy gates do not expose user approve/waive decisions.
- Missing questions capability fails closed where required.
- Gate request sequence is authoritative:
  - `/factory-gates <run-id>` displays the current request sequence;
  - `/factory-decide <run-id> <gate-id> <request-sequence> <approve|reject|waive|cancel> [reason]` requires it;
  - stale decisions are rejected.
- Reopened gates are treated as new pending gates rather than reusing stale decisions.
- Legacy single-request decisions without `requestSequence` remain grandfathered for old persisted runs.

## Completed Chunk E — structured QA workflow

Goal: add a second factory workflow after review, exercising browser/test capabilities without taking on release risk.

Implemented behavior:

- `FACTORY_QA_WORKFLOW` represents audit/no-fix QA.
- `FACTORY_QA_FIX_WORKFLOW` represents explicit write-capable QA-fix.
- `FACTORY_WORKFLOWS` includes `review`, `qa`, `qa-fix`, and `ship`.
- `/factory-qa <goal-or-url>` starts an audit/no-fix QA run and dispatches `/skill:gstack-qa-only`.
- `/factory-complete-qa <run-id> <summary>` manually captures QA output for the first slice.
- QA status surfaces pending external QA and `/factory-complete-qa` next action.
- Browser-required QA blocks when browser policy/capability is missing.
- QA-fix requires:
  - explicit writes;
  - `commandSafetyProfile: 'non-destructive-write'`;
  - filesystem/git/test-runner/safe-command-guard capabilities.
- Pi intentionally does **not** expose `/factory-qa-fix` until a real safe command guard can be attested by the adapter.

Remaining QA work:

- Add correlated durable QA log capture if/when the generated QA skill writes a machine-readable durable record.
- Implement a real safe-command guard before exposing write-capable QA fix in Pi.

## Completed Chunk F — subagent, parallel, and worktree scheduling policy

Goal: make factory concurrency semantics real at the calculation/policy layer.

Implemented behavior:

- `lib/factory-scheduler.ts` plans schedule batches for:
  - serial phases;
  - contiguous parallel-readonly phases;
  - isolated-worktree phases.
- Scheduler capabilities are declared by concurrency mode.
- `maxParallelWriteTimelines` clamps invalid values to one write timeline.
- Isolated-worktree phases require ownership/integration metadata.
- Runner preflight accounts for scheduler-required capabilities on resume.

Remaining scheduling work:

- Integrate scheduler dispatch with real Pi SDK sessions/subagents.
- Add isolated worktree ownership/integration execution when write-capable parallelism is approved.

## Completed Chunk G0 — structured ship-readiness workflow

Goal: model ship/release readiness gates without executing release or deployment actions.

Implemented behavior:

- `FACTORY_SHIP_WORKFLOW` is named **Structured Ship Readiness**.
- Description explicitly says it does not execute release or deployment actions.
- Plan-only mode includes only intake and summary.
- Ship mode models gates for:
  - `review-status-clean`;
  - `tests-passing`;
  - `version-bump-ready`;
  - `changelog-ready`;
  - `ci-green`;
  - `pr-ready`;
  - `release-approved`;
  - `deploy-readiness-confirmed`.
- Workflow requires readiness capabilities such as artifact store, test runner, CI, PR, and questions.
- Workflow does not require filesystem/git/release-action capability in G0.
- Runner lifecycle tests drive ship-readiness gates through pause/resume/completion and cancellation without release execution.
- Pi command output labels ship workflow status as readiness-only and says it does not tag, publish, push, or deploy.

Remaining ship work:

- Add a public `/factory-ship` command only if the desired CLI contract is approved.
- Add a future G1 release-action workflow separately if actual tag/publish/push/deploy execution is desired.

## Completed hardening pass — capability honesty and command UX

Implemented safety behavior:

- Browser-disabled policy is blocking for browser-required phases.
- Write-capable phases require explicit writes and a non-read-only safety profile.
- `qa-fix` disallows `release-action` at workflow/plan level.
- Event-store reads fail closed on missing manifests, malformed logs, and uncommitted tails.
- `appendValidated()` validates pending state under the event-store lock for manual captures and gate decisions.
- Terminal gate decisions (`reject`/`cancel`) cancel before attempting runtime resume, so denials remain possible in headless contexts.
- Runner fallback artifacts derive their kind from the current phase expected output instead of assuming `review`.
- Pi status/list/gates output is more actionable and safety-honest:
  - status is inspect-only;
  - status suppresses untrusted event-provided artifact paths/URIs;
  - pending QA says audit-only/no edits, while persisted `qa-fix` runs are labeled as safe-local-write runs;
  - gates show current `requestSequence` and exact `/factory-decide` syntax;
  - ship status says readiness-only/no deploy;
  - ship approval decisions are rejected in Pi until a ship-capable runtime exists, while reject/cancel remains available.

Related docs:

- `docs/designs/PI_FACTORY_TEST_COVERAGE_GAP_PASS.md`
- `docs/designs/PI_FACTORY_PUBLIC_API_REVIEW.md`
- `docs/designs/PI_FACTORY_COMMAND_UX_POLISH.md`

## Web-app planning track — waiting for designer feedback

The web-app planning track is documented but implementation should not start until designer feedback is incorporated and a web stack/location is approved.

Current web planning artifacts:

- `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md`

Current web defaults:

- P0 is a mocked cockpit prototype.
- No production web app implementation yet.
- No dependencies or package manifests should change without approval.
- Project/workspace concepts should wrap run-scoped factory DTOs.
- QA audit and QA fix remain separate.
- Ship readiness is not deployment.

## Current recommended next chunks

### Completed strategy chunk — binary/URI artifact strategy

Goal: decide how browser evidence, screenshots, traces, and external URLs should be exposed through the factory facade and future web/API layers.

Decision captured in `docs/designs/PI_FACTORY_ARTIFACT_CONTENT_STRATEGY.md`:

- keep `readFactoryArtifact()` text-only;
- represent binary/URI evidence through additive content descriptors;
- treat raw event `path`/`uri` as untrusted metadata;
- require artifact-store/runtime provenance for trusted display or retrieval;
- let future web/project wrappers render artifact views from descriptors, not path parsing.

Next implementation work should wait until the descriptor API/change is explicitly approved.

### Next Chunk 1 — safe command guard design

Goal: design and implement a real guard for non-destructive write automation before exposing write-capable QA fix in Pi.

Requirements:

- Block destructive shell/git patterns by enforcement, not prompt prose.
- Cover at minimum:
  - `rm -rf`;
  - `git reset --hard`;
  - `git clean`;
  - force pushes/tags;
  - publish/deploy commands;
  - credential/env dumping.
- Decide where enforcement lives:
  - Pi tool guard;
  - runtime wrapper;
  - command adapter;
  - future SDK capability.
- Add negative regression tests proving denial happens at runtime/tool boundary.

### Next Chunk 2 — project/web wrapper API design

Goal: design project/workspace DTOs around the run-scoped facade when web implementation is approved.

Do this only after designer feedback and stack/location approval.

### Next Chunk 3 — Pi distribution/package path

Goal: design how gstack's Pi extension and generated skills are packaged for non-dev users.

Open questions:

- Should generated `.pi/skills/` be built during package installation?
- How should extension and generated skills be versioned together?
- What migration/upgrade path should existing Pi installs use?

## Quick orientation for future agents

If asked to continue non-design factory work, default to the current recommended next chunks above, not old Chunk B/C/D/E/F/G text.

Before coding, inspect:

- `docs/designs/PI_SOFTWARE_FACTORY_ARCHITECTURE.md`
- `docs/designs/PI_FACTORY_REVIEW_WORKFLOW.md`
- this file
- `.pi/extensions/pi-gstack/index.ts`
- `lib/factory-*.ts`
- `test/pi-extension.test.ts`
- `test/factory-*.test.ts`

Then verify current git status and avoid unrelated dirty files.
