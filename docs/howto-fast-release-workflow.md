# Fast release workflow

`/ship` and `/land-and-deploy` keep the same safety gates while avoiding repeated
work. The release is one bounded transaction from local verification to the
production canary.

On Codex, `/ship` is also split into on-demand sections. The initial skill no
longer loads every coverage, plan, review, Greptile, and documentation procedure
up front; each section is read in full only when its step applies.

## What runs once

`/ship` fetches the base, runs every applicable full test suite with the project's
normal concurrency, then launches independent coverage, plan, and specialist
review audits in parallel. It refreshes the base immediately before versioning so
a sibling workspace cannot silently claim the same release number.

If a review applies a fix, the workflow stays in the same invocation. It runs
targeted tests and a focused review of that repair. Two repair rounds are allowed;
a third round stops and reports a real loop. A final full suite runs once only when
code or the fetched base changed after the initial test result.

## What `/land-and-deploy` reuses

GitHub checks on the PR's exact head SHA are authoritative when they include a
successful test, build, or typecheck job. The deploy workflow records those check
names and does not repeat the same test suite locally. A local test fallback still
runs when CI is absent, incomplete, stale, or the repository defines an extra
local-only gate.

A readiness report with no warnings or blockers merges automatically because the
user already invoked `/land-and-deploy`. Any warning or blocker stops the fast path
and requires a decision. CI failure, ambiguous conflicts, review loops, deploy
failure, and unhealthy production canaries remain hard stops.

## Evidence rules

Evidence can be reused only for identical inputs: the same HEAD, fetched base SHA,
and code files. Metadata-only VERSION, CHANGELOG, and PR-body changes do not
invalidate code tests. Repairs invalidate only the affected audits during the
loop, while the final full-suite gate protects the exact code that will be pushed.

The intended repeat-release path is:

1. One full local test window with normal parallelism.
2. Coverage, plan, and review analysis in parallel.
3. Zero to two targeted repair rounds without user reinvocation.
4. One final full gate only if code or base changed.
5. CI wait, exact-SHA readiness reuse, merge, deploy detection, and production canary.
