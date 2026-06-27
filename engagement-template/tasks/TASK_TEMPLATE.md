# <TASK-ID> — <short title>

> Lives at `tasks/<TASK-ID>.md` in the control repo. Linked from the ledger's `spec` column.
> A task may NOT enter the autonomous pool (status: open) until every AC below maps to a check
> or is explicitly marked `human-verify`. An unmapped AC is an authoring error.

## Traceability
- Requirement: REQ-XXX (from REQUIREMENTS.md)  <!-- or "ad hoc" with justification -->
- Repo: <repo-name>                       <!-- the WORK repo this task targets -->
- Domain: <be | fe | full>                <!-- origin domain — never changes after creation -->

## Context
<2–5 sentences: why this task exists, what part of the system it touches, links to prior PROGRESS.md entries or related tasks if relevant.>

## Acceptance criteria
<!-- Given/When/Then where behavior-shaped; plain assertions where not. Number every item. -->
- AC1: Given <precondition>, When <action>, Then <observable outcome>
- AC2: ...
- AC3: ...

## AC → verification mapping
<!-- EVERY AC appears here exactly once. -->
| AC | Verified by | Type |
|---|---|---|
| AC1 | `tests/test_x.py::test_name` | done_check |
| AC2 | `tests/test_x.py::test_other` | done_check |
| AC3 | `e2e/feature.spec.ts` | e2e_check |
| AC4 | PR review — <what the reviewer must confirm and how> | human-verify |
| AC5 | project migration-drift check (see FEATURE_ROLE gate 5) | migration_check |   <!-- include ONLY if schema change is yes, below -->

## Schema / migration impact
<!-- Does this task add or change any DB table, column, index, constraint, enum, default, or seed? -->
- Schema change: <no | yes>
- If **yes**: this task MUST be registered with the `migrations` exclusive lock
  (`kernel/task create ... --locks migrations`, or `locks: migrations` in the spec frontmatter).
  The kernel then guarantees no two schema tasks run concurrently — the lock is held from claim
  until this task's PR actually merges to main (auto-released by the supervisor's merge-reaper),
  so their branches never mint colliding migration numbers. Add the `migration_check` AC row above.

## Out of scope
<!-- Explicit boundaries. Anything an agent might plausibly "helpfully" include — exclude it here. -->
- <item>
- <item>

## Constraints
<!-- Architectural decisions already made; the agent does not re-decide these. -->
- <e.g., follow existing generate_unique_slug pattern; fail-open on Redis errors; no new dependencies without needs_human>

## Definition of done (auto-summary)
All done_check + e2e_check mapped tests pass, full regression passes, every human-verify AC is listed in the PR description with evidence, contract snapshot unchanged or change authorized below.

- Contract change authorized: <no | yes — describe expected openapi.json delta>
