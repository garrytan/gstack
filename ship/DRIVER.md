<!-- AUTO-GENERATED from ship/DRIVER.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# /ship driver: run /ship from a parent agent

Read this instead of `ship/SKILL.md` when a parent agent on any host runs /ship unattended
(`SESSION_KIND: unattended`): bins do the mechanics; this file holds the phases, the judgment and the
lines each phase prints. Commands live in `<root>/bin/` (`<root>` holds `ship/`). Run each with the
`GSTACK_LAUNCH` assignments your installer printed (`. <the GSTACK_LAUNCH_FILE it printed>`), never
`export $(...)`, `env`, `printenv` or a bare `set` in a tool fence.

**Rules.** A phase is one program (an execute program on Capy, else a shell script) unless it
says otherwise; print its result lines verbatim. `STOP:` (exit 3) means nothing after it ran; `NEXT:`
names the next act. Read a section only when the list at the end sends you, only that heading, never
up front. A STOP or decision this file does not cover: read `ship/SKILL.md` at that step, finish it
there, come back. Unattended, a question with a recommended option takes it (log it); a gate
disposition and every approval stay pending and end the run. Keep a private invocation record
(Release, Decisions, Reviews, Checks, Documentation, Next steps) with every token, tree and path.
Budget: read the host's token counter in the program that runs
`gstack-ship-budget` (`--reading R --prior-reading <last R>`); `check --step <done> --next <step>`
opens each phase, `check --next "$BUDGET_NEXT"` each reader batch; obey `verdict=`.

## 1. Preflight and tests: Steps 0, 0.9, 1, 2, 3, 4, 5

`gstack-ship-budget start --record <rec> [--token-cap <n>] --delegate measured --reading R` and
`gstack-ship-preflight --base <base> --lane <label>=<command>...` (the test commands AGENTS.md or
CLAUDE.md names; then Step 4 bootstraps nothing). Prints `STATUS:`, `DIFF:`, `PR:`, `CARRY:`, `SCOPE:`,
`MERGE:`, `DISTRIBUTION:`, `POLICY:`, `RUNTIME_LINES:` (for `check --runtime-lines`), `PREGATE:`, `LANE:`.
`CARRY: carried` ends the run on its `GSTACK_RESULT:` line. `--delegate measured` delegates a segment
only when a measured call is 150k or more above the host floor (`DELEGATE:`). A lane
passes on `tests_ran: N` with exit 0; `tests_ran: 0` is ZERO-RUN, a failed lane; `unknown` is `count unavailable`.
In-branch failures stop the ship; after a repair rerun with `--tests-only`. `requires-remote` needs
`gstack-pregate clear` before Step 18. The readiness dashboard and a `PERSIST:` hint never replace Step 9.

## 2. Evals and Greptile: Steps 6, 6.5, 10

When prompts, templates, judges or eval harness changed, run the project's eval selector and
pre-merge command (detached past 30 minutes); else record `evals: none affected`. Steps 6.5 and 10 run
only if `gstack-greptile-early detect` finds Greptile.

## 3. Audits: Steps 7, 8, 8.1, 8.2

Bind the plan (this conversation's, else the PR body's `Plan:` line; never a guess). One program:
`gstack-review-packet build --audit test-coverage --base <base> --context <f> --passes-used <n>` and,
with a plan, `--audit plan-completion --plan-file <plan>`, one light-effort reader per `PACKET:`, poll,
return each `out=` LAST line (`AUDIT_SKIPPED:`: none). Coverage at or above target passes; below it,
unattended, generate tests for true gaps only (2 passes, 5 tests each), machine-check and rate them,
rescan gate edits. Plan NOT DONE or UNVERIFIABLE is pending approval; PARTIAL is a PR-body note. Step
8.1 lists the plan's checks for Step 9.2.1. Prints `Coverage:`, `Plan completion:` and Step 8.2's
`Scope Check:`.

## 4. Review: Steps 9, 9.1, 9.2, 9.2.1, 9.3, 9.4

- **Floor:** only a finding that would fail a test, break production, or lose data or secrets blocks; data loss, a trust-boundary bypass and uncapped spend stay CRITICAL. The rest is a PR-body note, never fixed after pass 1, never another pass.
- **Depth:** `gstack-review-plan --base <base> [--depth-floor <d>]`: light (runtime <= 50), standard, or full (gate class or a `DEPTH_ERROR:`); a floor only raises. Dispatch exactly its `DISPATCH:` lines. Gate class runs every reviewer, the Red Team and the native adversarial pass, no hit-rate gating; a fix touching a gate-class path gets a full pass, never a scoped one. `NUMBERS: yes` keeps the outside voice. Core checklist, gate scan and QA always run.
- **Cap:** two full passes plus one fix-check; a blocker still open stops the run, named (path, severity, problem) for the owner. The cap approves nothing.

Call 1, one program (the host's reviewer-packet rule): first entry saves `REVIEW_SINCE`; the plan;
`gstack-review-log --start review` (REVIEW_START, before any diff read); `PASS_HEAD`;
`gstack-review-packet build --only specialist,red-team` (`--range <sha>`
from pass 2); readers; poll; settle; `collect`; on `DISPATCH: red-team` `build --like <dir> --only red-team --findings <dir>/merged.jsonl`,
readers, collect to `pending=0`; `gstack-gate-diff <base>` (keep `GATE_SUMMARY:`).
Call 2: read `review/checklist.md` and the diff (pass 2: `git diff $RANGE_BASE`) together; CRITICAL
pass with Gate Integrity, then INFORMATIONAL. Lead judgment drops nits, hypotheticals, unused
structure, other designs and rules the repo documents otherwise. Step 9.2.1: smoke QA (12
probes, 5 minutes) and Step 8.1's checks, after reading `qa/sections/exploratory.md`.
Fix-First: `gstack-review-read` matches saved Skips (9.3); `gstack-review-scope classify` (`raised_by`
on each finding); the cap before any edit; AUTO-FIX `scope: fix`, the recommended answer on ASK, each
gate-tagged finding `open`; `gstack-review-scope defer` and `render`; `gstack-gate-diff` again after a
fix; `gstack-review-log '<row>' --finish REVIEW_START`; commit. Prints `Pre-Landing Review:`, `Gate edits:`.
Then `gstack-review-plan --pass <P> --last full <flags> --range-base $PASS_HEAD --pass1-depth <d>`:
`NEXT: stop` stops; `full` or `scoped` reruns Step 5 and this phase; `fix-check` is one
`--only fix-check,outside-voice --range $PASS_HEAD --fix-list <f> --tests <f> --callers <f>` packet on
a `--start review-fix-check` token; `done` goes on.

## 5. Adversarial: Step 11

Only the voices the last full-pass plan lists; neither prints `ADVERSARIAL: skipped (review plan)`.
One program: `build --like <Step 9 dir> --only adversarial,outside-voice`, `gstack-review-log --start adversarial-review`
per attempt (PASS_START), the native reader at full effort, the outside voice on another model family
(`gstack-outside-voice run --runner host-subagent --model <id>`), poll, settle, collect; one
`adversarial-review` row per attempt (`--finish PASS_START`). Missing outside coverage is
`unavailable`, never clean. Codex structured review needs `CODEX_MODE: ready` and 200+ lines (P0/P1 is
`GATE: FAIL`). Queued fixes: scope, then Steps 9, 10, 11 again.

## 6. Bind: Step 11.5

`gstack-review-read`: the final Step 9 row and Step 11 native row (or `CURRENT` freshness after a
planned skip) agree on `wtree`, `start_wtree`, `end_wtree`. Save that reviewed tree.

## 7. Release: Steps 12, 13, 14, 14.5, 15, 16, 17

- Step 12: `gstack-ship-release version --base <base> [--bump micro|patch] --why '<line>'`; MINOR or MAJOR is a question.
- Step 13: one user-facing CHANGELOG entry; `gstack-prose-lint CHANGELOG.md --base origin/<base> --gate` until `PROSE_LINT: ok`. Step 14: TODOS.md deferrals and completions.
- Step 14.5, every ship, one program: `gstack-docs-candidate snapshot --out <c> --audit-id <id> --mode edit --base <sha> --docs <roots>`, `gstack-review-packet build --audit docs --candidate <c>`, one light reader, `gstack-docs-candidate apply <c> --findings <out>`, `compare <c>`, `gstack-ship-receipt docs-caps --base <base>`, a post snapshot. Write `.gstack/tmp/docs-audit.json`; print `Documentation:`. One re-audit at most.
- Steps 15, 16: commit features in bisectable chunks, then `gstack-ship-release finish --base <base> --reviewed-tree <t> --docs-post <post> --lane ... [--build <cmd>] --trailer '<t>'`: `ROUTE:`, `DOCS:`, `EVIDENCE:` (FRESH; STALE or MISSING reruns once), `PREGATE:`. Print them, the last `Gate edits:` and each `tests_ran`.
- Step 17: `gstack-ship-release push --branch <branch> [--gate-open <n>]`: `REDACT_PREPUSH:`, `SEALED:`, `PUSH:` (pushed or ALREADY_PUSHED). Its pre-push offer STOP runs Step 17's guard block (`HOOK_STATE:`, `HOOKS_IN_GIT_DIR:`, `PREPUSH_PROMPTED:`); unattended takes the recommended install. Never force-push.

## 8. Publish: Steps 18, 19, 19-C, 20, 21, 22

- Step 18: the open-PR lookup; a title file starting `v<NEW_VERSION> `. `UNATTENDED_SHIP:` with no open PR at HEAD takes Step 18-H.
- Step 19 body: the receipt block; with `CAPY_PR: on` (Step 19-C) What changed, Why, Blast radius, Approvals (`gstack-approvals render`); Summary, Test Coverage, Pre-Landing Review (`REVIEW_LOOP:`, `Gate edits:`, deferred, notes), Exploratory QA, Plan Completion, Verification Results, Issues, TODOS, Documentation (`cat` the saved section), Test plan. `gstack-prose-lint <top> --sections 'Why,Summary,Blast radius' --gate`; `gstack-issue-links`; `gstack-review-scope summary --since "$REVIEW_SINCE" && gstack-ship-receipt write --pr <n> --base <base> --gate @<f> --pregate <f> --issues @<f> --review-loop @<f> --docs @<f> --body <body>`; `gstack-post pr-body` and `pr-title` (a new PR via the host's PR tool; a draft while a gate finding is `open`). `SHIP_RECEIPT:` opens your report.
- Step 20: the ship metrics row via `gstack-review-log`. Step 21 is interactive only.
- Step 22: `gstack-ship-budget close`, then `gstack-ship-receipt result --pr <n>`: `GSTACK_RESULT: skill=ship status=complete run=<dir>`. Under a merge queue, `gstack-ship-queue ready --pr <n> [--screen|--no-screen]` at the pushed head; paste its output.

## Where each STOP sends you (paths under `<root>/ship/`)

- `merge conflicts`: `SKILL.md#step-3-merge-the-base-branch-before-tests`
- `NEXT: carry route`: `SKILL.md#step-1-pre-flight`
- `DISTRIBUTION: candidates=`: `SKILL.md#step-2-distribution-pipeline-check`
- `APPLE:` with a store ask: `sections/apple-release.md#apple-app-store-release`
- `pregate fail` or `incomplete`: `sections/tests.md#step-5-run-tests-on-merged-code`
- a failed or zero-run lane: `sections/tests.md#test-failure-ownership-triage`
- a red eval or a failed free-suite shard: `sections/measure.md#measure-then-fix-loop-a-red-paid-eval-or-a-failed-free-suite-shard`
- Greptile found: `sections/greptile-early.md#step-65-early-greptile-pr-after-the-free-tests-pass`
- coverage below target, a failed audit: `sections/test-coverage.md#step-7-test-coverage-audit`
- plan items NOT DONE or UNVERIFIABLE: `sections/plan-completion.md#gate-logic`
- `REVIEW_COVERAGE_INCOMPLETE` or `NEXT: stop`: `sections/review-army.md#decide-whether-to-repeat-step-9`
- a `REVIEW_SCOPE_*` refusal, the review-log row: `sections/review-army.md#step-94-fix-first-and-persistence`
- a required probe not passed: `sections/review-army.md#step-921-exploratory-qa-before-fix-first`
- native adversarial incomplete, queued fixes: `sections/adversarial.md#finish-the-adversarial-phase`
- Step 11.5 mismatch: `SKILL.md#step-115-bind-the-reviews`
- a `version` STOP: `SKILL.md#step-12-version-bump-auto-decide`
- `Documentation: blocked` or a `DOCS_CAP:` over: `sections/documentation.md#blocked-recovery`
- finish: changed since review: `SKILL.md#2-choose-the-change-route`
- finish: documentation inputs changed: `SKILL.md#3-resolve-documentation-freshness`
- finish: build, lane or pregate STOP: `SKILL.md#4-verify-the-frozen-candidate`
- a push STOP: `SKILL.md#step-17-push`
- unattended, no open PR at HEAD: `sections/handoff.md#step-18-h-handoff-without-a-pr-automation-lanes`
- a receipt write or `gstack-post` refusal: `sections/pr-body.md#compose-the-body-then-publish-through-gstack-post`
- `verdict=stop` or `DELEGATE:`: `sections/budget-handoff.md#budget-and-context-handoff-read-when-a-cap-is-set-or-verdictdelegate-prints`
- `QUEUE_RECEIPT_STALE`: `../docs/ship-policy.md#ship-before-ready`
