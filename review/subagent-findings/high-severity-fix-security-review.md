## Scope
Reviewed the current uncommitted factory hardening changes in the following security/fail-closed areas only:
- QA write honesty
- browser policy blocking
- status/recovery mutation boundaries
- event-store tail/recovery integrity
- gate-decision validation paths

## Critical Findings
- None.

## High / Medium Findings
- `lib/factory-event-store.ts:84` — Missing-manifest reads still auto-recover by rebuilding and rewriting `manifest.json` from the full `events.jsonl`; `factory-status` explicitly claims read-only behavior but triggers this path via `.pi/extensions/pi-gstack/index.ts:413` and facade status reads via `lib/factory.ts:185`. Impact: a missing/deleted manifest causes inspection commands to mutate durable state and bless any valid-looking event log as authoritative without an explicit recovery action, which keeps recovery availability-first instead of fail-closed. Confidence: high. Recommended fix: make manifest-missing runs fail closed on normal reads/list/status, and move manifest reconstruction behind an explicit recovery command or a writer-authenticated crash marker protocol.

- `lib/factory.ts:496` — Facade gate-history parsing overwrites earlier orphan `gate_decision` state when a later `gate_requested` for the same gate arrives; runner-side validation correctly fail-closes this at `lib/factory-runner.ts:368`, but status/list/facade parsing can misrepresent the malformed run as a fresh pending gate instead of invalid state. Impact: `/factory-status`, `/factory-gates`, and facade-driven decisions can operate on corrupted gate history until execution time, weakening the fail-closed boundary around gate decisions. Confidence: medium-high. Recommended fix: preserve and reject any decision-before-request history in facade parsing, or add a shared gate-history validator that both runner and facade use before surfacing gate state.

- `.pi/extensions/pi-gstack/index.ts:290` — Manual review completion, manual QA completion, and review auto-recovery append `phase_completed` after an unlocked state check (`.pi/extensions/pi-gstack/index.ts:358`, `.pi/extensions/pi-gstack/index.ts:644`) instead of validating pending state under the event-store lock. Impact: concurrent or repeated capture/recovery attempts can overwrite shared captured artifact ids and append stale completion events after another actor already finished the phase, corrupting the audit trail instead of failing closed. Confidence: medium. Recommended fix: switch these completion paths to `appendValidated(...)` with a pending-phase recheck under lock, and avoid fixed artifact ids for stale/duplicate captures.

## Low / Hardening
- None in reviewed scope.

## Secret Handling
- None found in reviewed scope.

## Validation / Follow-up
- Add a regression test proving `factory-status`/facade status reads do not create or rewrite manifests when `manifest.json` is missing.
- Add a facade/status test for the sequence: `gate_decision` before `gate_requested`, then later `gate_requested` for the same gate, asserting the facade fails closed instead of showing a pending gate.
- Add duplicate/replay tests for `/factory-complete-review`, `/factory-complete-qa`, and `/factory-recover-review` to confirm stale second completions are rejected and captured artifacts are not overwritten.

## Summary
QA audit/fix separation and browser-policy blocking look materially improved, but the hardening pass still has integrity gaps around manifest recovery, read-only status mutation boundaries, and fail-closed gate/capture validation.