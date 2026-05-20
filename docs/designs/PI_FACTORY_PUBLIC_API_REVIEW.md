# Pi Factory Public API Review

Status: public API/facade review after factory capability safety hardening.

## Goal

Review whether the current factory facade is suitable as the public contract for Pi, future SDK consumers, and eventual web-app integration, without changing implementation. The review focuses on stable surfaces, action boundaries, DTO shape, and known gaps.

## Current public entry points

Primary module: `lib/factory.ts`.

Exports reviewed:

- `planFactoryRun(request, options?)`
- `createFactoryFacade(options)`
- `FactoryFacade`
- `FactoryFacadeOptions`
- `PlanFactoryRunOptions`
- `FactoryRunOperationResult`
- `FactoryRunStatusDto`
- `FactoryRunListItemDto`
- `FactoryArtifactSummaryDto`
- `FactoryArtifactDto`
- `FactoryGateInfoDto`
- `FactoryGateDecisionInput`
- public enum-like types:
  - `FactoryPublicRunStatus`
  - `FactoryPauseKind`
  - `FactoryGateDecisionValue`
  - `FactoryGateStatus`

Supporting core contracts live in `lib/factory-core.ts` and remain pure data/calculation contracts.

## API shape assessment

### What is strong

1. **Pure planning is separated from runtime actions.**
   - `planFactoryRun()` compiles a plan without stores or runtime adapters.
   - This preserves the ACD boundary: planning is calculation; execution is action-backed.

2. **Runtime facade hides wiring.**
   - `createFactoryFacade()` owns event store, artifact store, runner, workflow list, and optional runtime.
   - External consumers do not need to manually reduce events for ordinary status reads.

3. **DTOs are inspectable and user-interface friendly.**
   - `FactoryRunStatusDto` includes public status, pause, progress, artifacts, gates, risks, and summaries.
   - `FactoryRunListItemDto` supports dashboard/list use.
   - `FactoryGateInfoDto` exposes request sequence and allowed decisions.

4. **Gate decision safety is explicit.**
   - Public decisions are forced to `decidedBy: 'user'`.
   - Unknown decisions, non-string reasons, stale request sequences, non-pending gates, and disallowed decisions are rejected.
   - Approve/waive requires a runtime-backed facade because those decisions need resume behavior.

5. **Blocked runs are not persisted as fake status records.**
   - `FactoryRunOperationResult.persisted` distinguishes preflight-blocked plans from durable runs.

6. **Read APIs are conceptually separated from mutating APIs.**
   - `readFactoryRunStatus`, `listFactoryRuns`, `readFactoryArtifact`, and `listFactoryGates` are read surfaces.
   - `runFactoryWorkflow`, `continueFactoryRun`, and `decideFactoryGate` are action surfaces.

## Stability recommendations

Treat these as the current stable public surface for external consumers:

- `planFactoryRun()`
- `createFactoryFacade()`
- `FactoryFacade.runFactoryWorkflow()`
- `FactoryFacade.continueFactoryRun()`
- `FactoryFacade.readFactoryRunStatus()`
- `FactoryFacade.listFactoryRuns()`
- `FactoryFacade.readFactoryArtifact()`
- `FactoryFacade.listFactoryGates()`
- `FactoryFacade.decideFactoryGate()`
- DTOs exported from `lib/factory.ts`

Treat these as lower-level/advanced/internal for now:

- `FactoryRunner`
- `FileFactoryEventStore`
- `FileFactoryArtifactStore`
- raw event envelopes
- `reduceFactoryEvents()` for application-level status display

Those low-level pieces should remain available for tests and advanced adapters, but docs should direct normal consumers through the facade.

## Contract details to preserve

### `planFactoryRun()`

Use for:

- previews;
- capability/risk checks;
- web planning flows;
- dry-run displays;
- validating workflow ids and modes.

Do not use for:

- durable status;
- artifact reads;
- gate decisions;
- runtime resume.

### `runFactoryWorkflow()`

Use for:

- starting action-backed factory runs;
- persisting durable events;
- returning first public operation result.

Important behavior:

- can return `persisted: false` for preflight-blocked runs;
- callers must inspect `missingCapabilities` and `blockingRisks`;
- callers must not assume every operation creates a run directory.

### `continueFactoryRun()`

Use for:

- resuming interrupted, paused, or partially complete runs;
- continuing after gate decisions or manual artifact capture.

Important behavior:

- requires runtime;
- validates persisted context when a request is supplied;
- does not redispatch pending external phases.

### `readFactoryRunStatus()`

Use for:

- status pages;
- Pi `/factory-status`;
- web cockpit read state;
- dashboard resume state.

Important behavior:

- should remain inspection-only;
- errors should be surfaced as corruption/not-found/status-read failures, not silently recovered.

### `listFactoryRuns()`

Use for:

- project run lists;
- dashboard cards;
- recent activity surfaces.

Important behavior:

- current DTO is run-scoped and does not include project/workspace metadata;
- web apps should wrap it rather than changing it prematurely.

### `readFactoryArtifact()`

Use for:

- text/markdown artifact detail reads.

Known limitation:

- `FactoryArtifactDto.content` is text-only. Browser evidence, screenshots, traces, binary files, or external URLs need either metadata-only display or a future artifact content contract.

### `listFactoryGates()`

Use for:

- gate inspection;
- Pi `/factory-gates`;
- web decision queues.

Important behavior:

- returns all declared gates with status, not only pending gates;
- consumers should filter or sort pending gates first in UI;
- gate DTOs may throw on corrupted gate history rather than normalizing invalid state.

### `decideFactoryGate()`

Use for:

- user decisions only.

Important behavior:

- requires `requestSequence`;
- rejects stale decisions;
- rejects decisions for non-pending gates;
- rejects decisions not allowed by the current gate request;
- rejects `approve`/`waive` without runtime because progress would strand;
- maps rejected/cancelled terminal decisions to cancelled run state before attempting runtime resume, so terminal denials do not require otherwise-missing runtime capabilities.

## Web/API bridge implications

The facade is run-scoped. Future web surfaces are project-scoped. Add a wrapper layer:

```text
Workspace
  Project
    FactoryRun[]
```

Do not modify `FactoryRunStatusDto` just to add web-only concepts such as project name, active persona, next action, or artifact display title. Add web wrapper DTOs:

- `ProjectSummaryDto`
- `ProjectCockpitDto`
- `ProjectRunLinkDto`
- `ProjectDecisionQueueItemDto`
- `ProjectArtifactViewDto`
- `ProjectSafetyViewDto`

These wrappers can embed or reference factory DTOs.

## Missing fields for future consumers

Useful additions should be additive and wrapper-first unless a core runtime need appears:

### Run/list surfaces

- project/workspace ids in a wrapper;
- next action;
- resume summary;
- active persona;
- user-facing safety state;
- last event timestamp if different from manifest update.

### Artifacts

- display title;
- subtype;
- status/version;
- linked gate ids;
- content type;
- binary/URI evidence support;
- provenance/source.

### Gates

- supporting artifact ids;
- safety impact;
- what happens next;
- permission/approver hints;
- deadline/expiry if needed later.

### Activity/audit

- actor/persona label;
- event display title;
- linked evidence;
- recovery attempts;
- capability scope at approval time.

## Public API risks

### R1 — Project/run mismatch

The web product will naturally want project-level reads. The current facade is correctly run-level. Do not blur the two.

Recommendation: create a separate project wrapper API later instead of adding project fields to every factory DTO.

### R2 — Artifact content model is text-first

`readFactoryArtifact()` reads text artifacts. Browser evidence and screenshots need content-type/URI support.

Recommendation: keep current text artifact API stable; add a future `readFactoryArtifactContent()` or web evidence endpoint if needed.

### R3 — Gate list semantics can surprise UI consumers

`listFactoryGates()` returns all gates, not only pending gates.

Recommendation: document this clearly and have UI sort pending gates first. Add a future `listPendingFactoryGates()` only if consumer friction appears.

### R4 — Read-status corruption handling is part of the public contract

Normal status reads should fail closed on corrupted/missing manifests or uncommitted tails. This is a security and trust boundary.

Recommendation: preserve inspection-only status behavior and route recovery through explicit mutating APIs/commands.

### R5 — Runtime-backed decisions can surprise read-only consumers

A read-only facade can record reject/cancel terminal decisions, but approve/waive requires runtime to resume. Terminal reject/cancel decisions should not require missing runtime capabilities because they intentionally stop progress.

Recommendation: UI/API docs should explain this. Web APIs should avoid offering approve/waive from a facade that cannot resume.

## Suggested documentation additions

Add a short public API usage section in a future developer-facing doc:

```ts
const plan = planFactoryRun({ workflow: 'qa', goal, cwd, mode: 'review' });

const factory = createFactoryFacade({ runsRoot, workflows, runtime });
const started = await factory.runFactoryWorkflow({ workflow: 'qa', goal, cwd, mode: 'review' });
const status = await factory.readFactoryRunStatus(started.run.runId);
const gates = await factory.listFactoryGates(started.run.runId);
```

Include warnings:

- blocked runs may not persist;
- status reads do not recover;
- gate decisions require current `requestSequence`;
- approve/waive needs runtime;
- artifacts are text-first today.

## Current API regression coverage

After this review, `test/factory-facade.test.ts` includes focused DTO shape coverage for:

- completed run `FactoryRunStatusDto`;
- completed run `FactoryRunListItemDto`;
- text artifact `FactoryArtifactDto`;
- paused gated run `FactoryRunStatusDto`;
- pending `FactoryGateInfoDto` from both status and `listFactoryGates()`;
- terminal gate decisions cancelling even when the runtime cannot resume the gated phase.

`test/factory-runner.test.ts` covers non-review fallback artifact kinds for pending external work and continue-after-error paths.

`test/pi-extension.test.ts` also covers duplicate manual review/QA completion, repeated `/factory-recover-review` idempotency, QA-fix status labeling, untrusted status URI suppression, headless ship-gate rejection, and unsupported ship-gate approval.

## Recommended next API work

1. Draft a project wrapper API design only when the web implementation is approved.
2. Decide binary/URI artifact content strategy before real browser evidence integration.
3. Add facade-backed ship-readiness lifecycle tests only if the public facade becomes responsible for driving gate decisions end-to-end.
4. Keep core pure and avoid importing Pi/web types into `lib/factory-core.ts`.

## Bottom line

`lib/factory.ts` is a good public facade for run-scoped factory consumers today. It should remain the stable inner contract. Future web and SDK apps should wrap it with project/workspace DTOs instead of weakening the event-sourced run model.
