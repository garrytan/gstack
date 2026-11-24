<!-- AUTO-GENERATED from system-functional.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# Functional QA with repository-native tools

Use documented repository commands, CLI/API clients and job/queue tools, not a new
harness or browser substitution.

## Functional modes

For /qa and /qa-only, within the selected scope:
- **Full** (default): cover every applicable documented contract below.
- **Quick** (`--quick`): check success and the highest-risk changed edge; mark other
  contracts not run.
- **Regression** (`--regression <previous-report>`): before probes, read the supplied
  functional report and linked replay evidence. A missing, unreadable or wrong-target
  baseline blocks regression mode. A browser-only `baseline.json` is not a functional
  baseline. Re-establish owned setup; replay prior failed probes against the documented
  expectation, never recorded buggy output, then check changed adjacent behavior.
  Preserve the prior report; report fixed, still failing and new findings separately.
  Missing safe replay inputs block affected probes, never count as passes.

Mixed runs apply each surface's mode separately. /review and /gstack-ship retain their caller's
bounded smoke and explicit plan checks, not Full exploration.

## Contract map

Record each contract/source, isolated setup, exact probe, expectation and outcome:
pass/fail/blocked/not run/inconclusive/not applicable (reason).

| Contract | Observe |
|---|---|
| Successful execution | Expected return/output and final business effect, not just launch/acceptance |
| Invalid/missing input | One probe per documented input rule of each field (allowed characters, format, sign, range, arity) breaking only it: declared rejection, correct status and no forbidden state change |
| Authentication/authorization | Valid identity, missing/invalid identity, wrong owner/role and durable no-effect boundary |
| CLI process contract | Exact exit code, stdout and stderr separately; resulting file/state changes |
| State transitions | Initial, intermediate and completed/failed states and their permitted transitions |
| Timeout/cancellation | Deadline, partial state, termination of owned work and recovery |
| Retry | Attempts/backoff/terminal state promised by the repository; no unbounded retry |
| Duplicates/idempotency | Repeated request/event and number of durable effects under the documented guarantee |
| Concurrency/order | Controlled competing operations in both relevant completion orders; final invariant |
| Partial-failure recovery | Interrupt after an effect, restart/replay, inspect completion/dead-letter state and duplicates |

Do not impose universal exactly-once delivery. Separate acceptance, enqueue, processing,
retry/dead-letter and final effect; 2xx is not completion. Expected rejection/injected
failure may pass; a missing service preventing execution blocks coverage.

## Execute and retain evidence

1. Apply the shared isolation/permission preflight. Verify cwd, command, environment
   NAMES and safe reset; use synthetic data/credentials.
2. Follow the shared exploratory loop's order and written checkpoints.
   For every probe, inspect initial/final durable state and retain exit/status and
   stdout/stderr separately without masking failure.
3. On timeout, retain partial output/state and stop only owned work. Record setup errors
   and untested contracts; never patch product code to hide missing prerequisites.
4. Record exact command or method/path/headers/body, setup/reset, expected contract/source,
   observed output/state, revision/runtime, evidence paths and limits. Secrets are referenced
   only by environment name. Disclose replay limits caused by redaction.
5. Use `templates/functional-report-template.md` relative to the installed QA SKILL.md.
   Preserve evidence before owned cleanup and disclose leftovers. Return to the caller
   without expanding discovery authority.
