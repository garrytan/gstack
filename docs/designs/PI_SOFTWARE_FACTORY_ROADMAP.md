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

## Universe AI web/product planning track — design feedback incorporated

The external Claude Design handoff is now imported and reconciled. Product-facing naming should use **Universe AI Software Factory**: a common-user-friendly platform where users can “build anything in the universe with Universe AI,” with visible steps, artifacts, approvals, personas, and safety.

Imported design source:

- `docs/designs/external/universe-ai-wireframes-round-1/software-factory/README.md`
- `docs/designs/external/universe-ai-wireframes-round-1/software-factory/project/Universe AI - Wireframes round 1.html`

Current web/product planning artifacts:

- `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md`
- `docs/designs/PI_SOFTWARE_FACTORY_DESIGN_BRIEF_RECONCILIATION.md`
- `docs/designs/PI_SOFTWARE_FACTORY_P0_PRODUCT_ACCEPTANCE.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_SCREEN_SPEC.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_COMPONENT_MODEL.md`
- `docs/designs/PI_SOFTWARE_FACTORY_PARALLEL_EXECUTION_PLAN.md`
- `docs/designs/PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md`
- `docs/designs/PI_SOFTWARE_FACTORY_ALPHA_BETA_EXECUTION_PLAN.md`
- `docs/designs/PI_SOFTWARE_FACTORY_COCKPIT_BETA1_CONTRACT.md`

Current web defaults:

- Easy Mode is the common-user default.
- Hands-on Mode exposes the 3-bay factory map and detailed cockpit.
- The 9-phase model remains real but is nested under Shape/Build/Ship bays.
- Simple overview is the default day-to-day project layer; detailed cockpit is one click deeper.
- No production web app scaffold exists yet.
- No dependencies or package manifests should change without approval.
- Project/workspace concepts wrap run-scoped factory DTOs.
- QA audit and QA fix remain separate.
- Ship readiness is not deployment.

## Completed parallel Wave 1 — product/API/runtime foundations

A first multi-worktree parallel wave has landed.

Implemented/documented:

- design reconciliation and P0 acceptance criteria;
- web cockpit P0 screen/component specs;
- project/workspace wrapper API first slice in `lib/factory-project.ts`;
- artifact content descriptor first slice in `lib/factory-artifact-content.ts`;
- guarded runtime wrapper first slice in `lib/factory-guarded-runtime.ts`;
- durable QA capture calculations in `lib/factory-qa-capture.ts`;
- Pi distribution/package path design.

Readiness status after Wave 1 is captured in `docs/designs/PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md`:

- internal Pi/CLI factory core: ~70–75%;
- common-user web cockpit/platform: ~45–50%;
- weighted overall production readiness: ~48–52%.

Safety status after Wave 1:

- `/factory-qa-fix` remains hidden.
- Safe-command classifier and guarded runtime wrapper slices exist, but full Pi/agent command-path attestation is still not complete.
- QA audit remains no-edit.
- Status views remain inspect-only.

## Current recommended next chunks

### Completed strategy chunk — binary/URI artifact strategy

Goal: decide how browser evidence, screenshots, traces, and external URLs should be exposed through the factory facade and future web/API layers.

Decision captured in `docs/designs/PI_FACTORY_ARTIFACT_CONTENT_STRATEGY.md`:

- keep `readFactoryArtifact()` text-only;
- represent binary/URI evidence through additive content descriptors;
- treat raw event `path`/`uri` as untrusted metadata;
- require artifact-store/runtime provenance for trusted display or retrieval;
- let future web/project wrappers render artifact views from descriptors, not path parsing.

Implemented after the strategy pass:

- `lib/factory-artifact-content.ts` additive descriptor DTO/helpers;
- `test/factory-artifact-content.test.ts` coverage for text, binary, external URI, bundle descriptors, safe URI validation, and untrusted event metadata.

Remaining implementation work:

- wire descriptors into facade/project wrapper reads where needed;
- add binary storage/download only after a concrete consumer is approved.

### Completed strategy chunk — safe command guard design

Goal: design a real guard for non-destructive write automation before exposing write-capable QA fix in Pi.

Decision captured in `docs/designs/PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md`:

- implement a pure deny-first classifier;
- wrap action-backed command execution outside core;
- fail closed on unknown high-risk commands and parser ambiguity;
- require `safe-command-guard` capability attestation before `qa-fix` can run;
- keep `/factory-qa-fix` hidden until runtime wrapper and negative tests pass.

Implemented after the design pass:

- `lib/factory-command-guard.ts` pure deny-first classifier;
- `test/factory-command-guard.test.ts` coverage for destructive shell/git, unsafe git read flags, bulk `git add`, publish/deploy, secret/env dumping including secret globs and git `rev:path` secret reads, opaque shell syntax, workspace path boundaries, backslash path fail-closed behavior, quoted ripgrep patterns, direct safe project checks, formatter/linter write default-deny behavior, package-script default-deny behavior, and default-deny behavior.

Implemented after the design pass:

- `lib/factory-guarded-runtime.ts` guarded runtime wrapper first slice;
- `test/factory-guarded-runtime.test.ts` proves denied commands are not executed, classifier failures fail closed, allowed commands execute, and `safe-command-guard` is advertised only when wrapper is active.

Remaining implementation work:

- wire guarded runtime into real Pi/agent execution paths;
- ensure all command/file-write pathways are wrapped before advertising guard capability for live `qa-fix`;
- add denial audit artifacts/events;
- only then expose `/factory-qa-fix`.

### Completed implementation/design chunk — project/workspace wrapper API

Implemented/documented:

- `docs/designs/PI_FACTORY_PROJECT_WORKSPACE_API.md`;
- `lib/factory-project.ts` read-only project/workspace projection layer;
- `test/factory-project.test.ts` coverage for dashboard summaries, decision-first resume priority, 3-bay progress, safe-local-fix safety summaries, and ship-readiness handoff state.

Remaining implementation work:

- connect project wrapper to a durable project/workspace catalog;
- integrate artifact content descriptors into project artifact views;
- use wrapper DTOs as the future web/API contract.

### Completed implementation/design chunk — durable QA capture

Implemented:

- `lib/factory-qa-capture.ts` pure parser/correlation/artifact calculations;
- `test/factory-qa-capture.test.ts` coverage for malformed lines, correlation, ambiguity, post-dispatch matching, and browser evidence artifact rendering;
- Pi extension manual QA completion now uses the QA dispatch extractor;
- Pi extension tests install a hermetic project browse runtime for QA command coverage.

Remaining implementation work:

- generated QA skills need to write the durable machine-readable QA log;
- add explicit `/factory-recover-qa` only after the durable QA log contract is emitted by the skill;
- keep audit/no-fix and fix workflows separate.

### Completed strategy chunk — Pi distribution/package path

Decision captured in `docs/designs/PI_FACTORY_DISTRIBUTION_PACKAGE_PATH.md`.

Remaining implementation work:

- build a versioned Pi runtime bundle containing generated `.pi/skills`, runtime sidecars, and extension together;
- keep source-checkout developer mode separate from packaged user mode;
- define upgrade/migration UX before public distribution.

### Completed strategy chunk — production readiness map

Decision captured in `docs/designs/PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md`.

Current production readiness estimate after Wave 1:

- internal Pi/CLI factory core: ~70–75%;
- common-user web cockpit/platform: ~45–50%;
- weighted overall production readiness: ~48–52%.

The map defines Alpha 0/1/2 and Beta 0/1/2 gates. It explicitly says the branch is not production-ready until a real UI/package surface, durable project state, artifact descriptor integration, generated QA logs, live safe-command path attestation, distribution testing, production-like smoke checks, and security review exist.

### Completed strategy chunk — Alpha/Beta autonomous execution plan

Decision captured in `docs/designs/PI_SOFTWARE_FACTORY_ALPHA_BETA_EXECUTION_PLAN.md`.

The plan defines:

- an autonomy envelope that avoids package/dependency, production web scaffold, release/deploy, protected-file, and `/factory-qa-fix` blockers;
- default decisions for project persistence, artifact descriptors, QA logs, command guard posture, ship-readiness language, and distribution dry-runs;
- detailed Alpha 0/1/2 and Beta 0/1/2 deliverables;
- validation contracts by layer;
- next-wave parallel worktree lanes and serial integration order;
- stop/continue rules and no-intervention fallbacks.

### Completed strategy chunk — Beta 2 operations/security contract

Decision captured in `docs/designs/PI_SOFTWARE_FACTORY_BETA_OPERATIONS_SECURITY_CONTRACT.md`.

The contract defines:

- a production-like smoke contract covering module load, facade plan/status/list/artifact reads, project catalog read/write, QA log parse/recover fixtures, guarded denial fixtures, distribution dry-run, and a deferred web `/health` gate;
- a backup/migration plan with `schemaVersion` markers for event store, artifact store, project catalog, durable QA log, denial artifacts, and bundle manifest, plus an atomic bundle-swap rollback rule;
- a security review checklist for command execution, artifact rendering, external URIs, browser evidence, project/workspace path boundaries, prompt-injection surfaces, stale gate decisions, secret redaction, and ship-readiness language;
- consolidated Beta 2 exit gates and a restated production-not-ready list.

### Completed implementation chunk — Alpha 1/Beta 1 cockpit data foundation

Implemented/documented:

- `lib/factory-project-store.ts` durable local project/workspace catalog;
- `test/factory-project-store.test.ts`;
- artifact descriptor integration into project views and facade artifact-content reads;
- `lib/factory-cockpit-view.ts` pure screen-ready view models;
- `test/factory-cockpit-view.test.ts`;
- `docs/designs/PI_SOFTWARE_FACTORY_COCKPIT_BETA1_CONTRACT.md` mobile/responsive and local-vs-hosted workspace boundary contract.

Current status:

- Alpha 1 data/view foundation exists without a production web scaffold.
- Beta 1 common-user journey fixtures are represented in pure view-model tests.
- Production web stack/location remains unapproved and intentionally unchosen.

### Completed implementation chunk — Alpha 0 durable QA recovery

Implemented:

- `bin/gstack-qa-log` durable QA JSONL writer;
- generated QA skill instructions for top-level `factory_run_id` and structured `gstack-qa-log` entries;
- `/factory-recover-qa <run-id>`;
- `agent_end` QA auto-capture alongside review auto-capture;
- tests for recovery, idempotency, ambiguity, missing/wrong correlation, and hidden `/factory-qa-fix`.

### Completed implementation/design chunk — Alpha 2 guard attestation seam

Implemented/documented:

- live execution-path inventory in `docs/designs/PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md`;
- sanitized guard-decision audit helper and callback seam in `lib/factory-guarded-runtime.ts`;
- tests proving audit callbacks cannot change guard outcomes and full command text is redacted.

Decision:

- `/factory-qa-fix` remains hidden because dispatched skill Bash/Read/Write/Edit tool paths are not enforceable from repository code yet.

### Completed implementation chunk — Beta 0 distribution dry-run foundation

Implemented:

- `lib/factory-distribution.ts` manifest/dry-run/stage helpers;
- `test/factory-distribution.test.ts`;
- no publish/install/global side effects.

### Next Chunk 1 — Alpha/Beta validation consolidation

Goal: turn the newly landed Alpha/Beta foundations into a repeatable gate.

Landed in this lane:

- `lib/factory-production-smoke.ts` — deterministic smoke runner that exercises module load (S1), facade plan/status/list/artifact reads (S2-S5), project catalog round-trip (S6), QA log parse + recover fixture (S7-S8), guarded denial audit (S9), and distribution dry-run (S10). Web `/health` (S11) is surfaced as `deferred` per the Beta 2 contract, not stubbed green.
- `test/factory-production-smoke.test.ts` — temp-dir-backed coverage of the runner DTO, including deterministic re-runs, the deferred-web-health invariant, and the §3.4 prohibition on deploy/publish/release/tag/push vocabulary in any check message.

Remaining steps:

- run a reviewer/security pass across the integrated branch;
- update `docs/designs/PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md` with post-Alpha movement.

### Next Chunk 2 — optional no-dependency cockpit prototype or approved web stack

Goal: make the common-user cockpit visible.

Default safe path:

- build a no-dependency static prototype under `docs/prototypes/` only if explicitly approved;
- otherwise keep using `lib/factory-cockpit-view.ts` fixtures as the UI contract.

Blocked path:

- production web app scaffold remains blocked until stack/location and dependency/package changes are approved.

### Next Chunk 3 — QA-fix host-enforcement solution

Goal: unblock write-capable QA fix safely.

Current blocker:

- dispatched Pi/Claude skill Bash/Read/Write/Edit tool paths are outside repository-code enforcement, so `/factory-qa-fix` remains hidden.

Design of record:

- `docs/designs/PI_FACTORY_HOST_GUARD_ENFORCEMENT_DESIGN.md` defines the host-side contract (per-run guarded agent session, file-write classifier, browser sidecar output dir, capability attestation, validation, explicit blockers). `/factory-qa-fix` remains hidden until that design is implemented and validated.

Recommended next steps:

- implement the factory-side primitives from §10 Step 1 (`lib/factory-file-write-guard.ts`, attestation helpers, `createGuardedAgentSession` shim) — all behind the existing hidden-command gate;
- wire the Pi adapter to the shim and add a test-only fake host so §11.3 negative tests can land — `/factory-qa-fix` stays unregistered;
- partner with a host vendor to implement the §5 contract and OS-confine the browse subprocess per §8;
- only then reconsider `/factory-qa-fix` exposure, gated by the §11.5 end-to-end test against the real host.

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
