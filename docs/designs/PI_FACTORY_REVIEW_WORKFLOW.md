# Pi Factory Review Workflow Spec

Status: implementation slice 1 — opt-in structured review factory.

## Goal

Make `/review` the first gstack workflow with a structured, event-sourced factory representation that Pi can start and inspect without replacing the existing generated skill flow yet.

## Recommended path decisions

- **Workflow chosen:** `review`.
  - Reason: it is high-value, mostly read-oriented, and produces a clear artifact (`review`) without requiring deploy/package/publish decisions.
- **Rollout mode:** opt-in command first: `/factory-review`.
  - Reason: the existing `/review` generated skill remains stable while the structured runtime matures.
- **Persistence root:** project-local `.gstack/factory/runs/<run-id>/`.
  - Reason: factory runs are project artifacts, not Pi installation artifacts, and should survive Pi session restarts.
- **Execution model:** serial phases with append-only events.
  - Reason: write-capable and parallel-agent scheduling can be added later without changing the event-store contract.
- **Error behavior:** fail closed by default; runner accepts an explicit error hook for greenfield/continuous modes.
  - Reason: default runtime safety stays conservative while callers that intentionally want continuous progress can install a documented hook.
- **Pi command behavior in this slice:** structured dispatch + event trail.
  - Reason: Pi can start a durable factory run now, but the existing generated `gstack-review` skill remains the prompt authority for the actual review methodology until transcript/artifact capture is added.

## Workflow phases

1. `review-intake`
   - Purpose: record the user goal and repository context.
   - Capabilities: `artifact-store`.
   - Artifact: `plan`.
2. `diff-review`
   - Purpose: hand off to the existing gstack review methodology for code inspection.
   - Capabilities: `agent-session`, `git`, `artifact-store`.
   - Artifact: `review`.
3. `review-summary`
   - Purpose: record final structured run summary and next inspection path.
   - Capabilities: `artifact-store`.
   - Artifact: `review`.

## Current Pi commands

- `/factory-review <goal>`
  - Creates an event-sourced run in `.gstack/factory/runs/`.
  - Runs the structured review phases until the external review handoff.
  - Queues `/skill:gstack-review <goal>` for the existing generated review workflow.
  - Leaves the factory run in `running` state with `diff-review` pending until a later artifact-capture slice records the actual review output.
  - Prints run id and status.
- `/factory-status <run-id>`
  - Reads the event store and displays durable state.

## Completion criteria for this slice

- The review workflow is represented as data, not only Markdown.
- The runner can execute phases with fake capabilities in tests.
- The runner can resume from persisted events.
- The runner can represent pending external work without falsely completing the run.
- Pi has opt-in commands to start and inspect structured review runs.
- Existing `/review` behavior is unchanged.

## Next slice

Capture outputs from the generated review skill into first-class factory artifacts, then complete the pending `diff-review` and `review-summary` phases from those artifacts.
