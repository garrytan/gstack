# Pi Factory Test Coverage Gap Pass

Status: coverage audit after factory capability safety hardening.

## Goal

Identify the remaining high-value factory test gaps independent of the web-app design work, and record what is already covered so future agents do not re-audit the same ground.

## Scope reviewed

Factory tests:

- `test/factory-core.test.ts`
- `test/factory-event-store.test.ts`
- `test/factory-facade.test.ts`
- `test/factory-runner.test.ts`
- `test/factory-scheduler.test.ts`
- `test/factory-qa-workflow.test.ts`
- `test/factory-ship-workflow.test.ts`
- `test/factory-review-capture.test.ts`
- `test/pi-extension.test.ts`
- `test/pi-runtime-adapter.test.ts`

Factory implementation areas:

- `lib/factory-core.ts`
- `lib/factory.ts`
- `lib/factory-event-store.ts`
- `lib/factory-runner.ts`
- `lib/factory-qa-workflow.ts`
- `lib/factory-ship-workflow.ts`
- `.pi/extensions/pi-gstack/index.ts`

## Coverage already present

### Capability and policy safety

Covered by `test/factory-core.test.ts`, `test/factory-qa-workflow.test.ts`, `test/factory-runner.test.ts`, and `test/pi-extension.test.ts`:

- browser-required phases block when `allowBrowser` is false;
- write-capable phases block when writes are disabled;
- write-capable phases block when command safety profile remains `read-only`;
- `qa-fix` rejects `release-action` via `allowedCommandSafetyProfiles`;
- Pi adapter exposes `/factory-qa` audit mode only and intentionally does not expose `/factory-qa-fix` without a real safe command guard;
- runtime preflight blocks missing capabilities before dispatch.

### Event-store integrity

Covered by `test/factory-event-store.test.ts`:

- unsafe run ids rejected;
- mismatched event run ids rejected;
- event log without manifest fails closed;
- manifest without event log fails closed;
- valid-looking post-manifest tails fail closed;
- torn tails fail closed;
- malformed envelope/event payloads fail closed;
- scheduler-critical persisted phase metadata is validated.

### Gate and resume semantics

Covered by `test/factory-runner.test.ts`, `test/factory-facade.test.ts`, and `test/pi-extension.test.ts`:

- runs pause on human/policy gates;
- runs resume after accepted decisions;
- reject/cancel decisions cancel the run;
- questions capability absence fails closed;
- policy gates do not expose user-approve/waive decisions;
- stale request sequences fail closed;
- reopened gates are pending rather than reusing stale decisions;
- legacy single-request decisions without `requestSequence` remain supported;
- facade requires a runtime for approve/waive decisions that would need resume;
- terminal reject/cancel decisions cancel before runtime resume, even when runtime lacks capabilities needed for later phases;
- Pi `/factory-gates` displays request sequence and `/factory-decide` uses it;
- Pi `/factory-decide` refuses ship-readiness approvals until a ship-capable runtime exists, while still allowing explicit rejection/cancellation.

### QA audit vs QA fix

Covered by `test/factory-qa-workflow.test.ts` and `test/pi-extension.test.ts`:

- `qa` dispatches `/skill:gstack-qa-only` and includes a no-edit safety contract;
- `qa-fix` requires filesystem/git/test/safe-command capabilities in its workflow plan;
- `qa-fix` blocks without explicit writes and a non-destructive safety profile;
- Pi adapter does not expose write-capable QA fix without an enforceable safe-command guard;
- QA status surfaces pending external QA and `/factory-complete-qa` next action.

New in this pass:

- `/factory-complete-qa` refuses runs that reached `qa-execution` without a pending dispatch artifact;
- duplicate manual QA completion after the first successful capture is rejected and does not overwrite the accepted artifact;
- duplicate manual review completion after the first successful capture is rejected and does not overwrite the accepted artifact.

### Ship readiness

Covered by `test/factory-ship-workflow.test.ts`:

- plan-only ship mode includes intake/summary only;
- workflow title/description say ship readiness and no release/deploy execution;
- ship mode includes readiness gates;
- missing CI/PR/questions/test-runner capabilities block;
- workflow does not require write/release-action capabilities in G0;
- runner lifecycle drives ship-readiness gates through pause/resume/completion without filesystem/git/release-action capabilities;
- rejecting a ship-readiness gate cancels safely without executing later phases.

### Status/recovery boundary

Covered by `test/pi-extension.test.ts`:

- `/factory-status` stays read-only when a matching review log exists;
- explicit `/factory-recover-review` performs recovery;
- targeted recovery can complete one run while other pending runs remain pending;
- repeated `/factory-recover-review` after successful capture does not duplicate completion events or captured artifacts;
- factory status does not render untrusted artifact paths or URIs from event payloads.

### Public facade DTO shape

Covered by `test/factory-facade.test.ts`:

- completed run status DTO shape;
- completed run list item DTO shape;
- text artifact detail DTO shape;
- paused gated run status and gate DTO shape;
- `listFactoryGates()` matches the gate DTOs surfaced through status;
- terminal gate decisions cancel safely even when runtime cannot resume the gated phase.

### Runner fallback artifact kinds

Covered by `test/factory-runner.test.ts`:

- pending external-work fallback artifacts derive their kind from the current phase expected output;
- continue-after-error fallback artifacts derive their kind from the current phase expected output;
- non-review workflows such as QA no longer fall back to misleading `review` artifact kinds.

## Remaining useful gaps

### G1 — Binary/URI artifact behavior

Risk: future browser evidence will use screenshots/traces; current artifact facade assumes text content for `readFactoryArtifact` while summaries can include `uri`.

Suggested test/design before implementation:

- decide whether binary/URI evidence remains metadata-only in current facade or needs a separate artifact-read contract.

## Recommended next test increments

1. Decide binary/URI artifact behavior before real browser evidence integration.
2. Add repeated `agent_end` idempotency regression if auto-capture behavior becomes more complex.
3. Add facade-backed ship-readiness lifecycle coverage if the public facade starts owning gate driving instead of the lower-level runner.

## Validation command

Focused suite for this area:

```bash
bun test test/factory-qa-workflow.test.ts test/factory-ship-workflow.test.ts test/factory-scheduler.test.ts test/factory-facade.test.ts test/factory-runner.test.ts test/factory-core.test.ts test/factory-event-store.test.ts test/pi-runtime-adapter.test.ts test/pi-extension.test.ts test/factory-review-capture.test.ts
```
