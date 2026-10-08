<!-- AUTO-GENERATED from exploratory.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
# Shared exploratory QA

The **caller** (/qa, /qa-only, /review or /ship) owns decisions, tests, fixes and publication. Discovery writes only reports/evidence
and owned fixture state; no workflows, framework installs or publication.

Complete these Reads in order before writing charters or probing. Await their results before the first probe, never in the same response. Do not repeat a Read already completed in this invocation.
1. Read `sections/scope.md` relative to the installed `qa`/`gstack-qa` SKILL.md directory in full and select the surfaces.
2. Read the selected surface methods below in full.

**Functional surfaces:**
Read `sections/system-functional.md` in full.

**Browser surfaces only:**
Read `sections/qa-patterns.md` in full.

Missing or unreadable assets, prerequisites or permission block affected probes, not independent safe checks. Report QA setup blockers.

## 1. Charter and preflight

Reuse resolved REPORT_DIR; otherwise own a fresh `.gstack/qa-reports` subdirectory.
Write a **charter** per behavior: contract, risk, entrypoint, isolation, exit condition, source, commands and inputs. Save charters as Markdown in the report.

For /review and /ship, no plan/server is required.
Stop after 5 minutes or 12 probes, whichever comes first (SECONDS=300 across surfaces).
Explicit plan checks and revalidation remain required beyond this smoke budget.
For /qa and /qa-only:
- Browser Quick: SECONDS=180. Browser Full/Regression: SECONDS=900.
- Functional Full, Quick and Regression have no default total timer.
Set SECONDS to the shorter mode/caller limit; an unlimited mode uses the caller's bound.
Without a total time limit, do not create DEADLINE_FILE; announce finite command timeouts.
Stop when scoped contracts are tested or blocked.
Clocks/checkpoints use REPORT_DIR; mixed standalone runs use REPORT_DIR/browser and REPORT_DIR/functional, with one final report at REPORT_DIR. Caller paths win.
Names used below (quote every path):
- PROBE_DIR: this surface's owned probe directory per the line above. DEADLINE_FILE: `PROBE_DIR/deadline.json`, which exists only for a bounded run.
- SECONDS: the total probe budget set above. NNN: a fresh three-digit ID (001, 002, ...) for each capture or checkpoint; never reuse one.
- DEADLINE_TOOL = `$HOME/.claude/skills/gstack/bin/gstack-qa-deadline`, the deadline guard: `start` creates DEADLINE_FILE, `status` prints `remainingMs` and `expired`, and `run` executes one command, stopping it at the deadline.
- EVIDENCE_TOOL = `$HOME/.claude/skills/gstack/bin/gstack-qa-evidence`, the functional evidence recorder: `capture` runs one command, stores its exit code, stdout and stderr under `PROBE_DIR/.qa-evidence/NNN/`, and prints status `complete`, `incomplete` or `sensitive`.

Start once before baseline: `bun DEADLINE_TOOL start DEADLINE_FILE SECONDS [EARLIER_UTC]` if bounded.
EARLIER_UTC = caller's absolute deadline, if set.
Functional: `bun EVIDENCE_TOOL capture PROBE_DIR NNN [--public] --deadline DEADLINE_FILE -- COMMAND ARGS`.
Unbounded: use `--timeout-ms MS` instead of `--deadline DEADLINE_FILE`.
--public requires approved public/synthetic output; EVIDENCE_TOOL screens credentials. For complete private captures, await a safe Read of `PROBE_DIR/.qa-evidence/NNN/observation.json` (the decoded stdout). Sensitive/incomplete captures cannot anchor checkpoints.
Bounded browsers: `bun DEADLINE_TOOL run DEADLINE_FILE -- COMMAND ARGS`. No detached probes.
Never reset DEADLINE_FILE/bypass DEADLINE_TOOL. Expiry or an invalid/missing DEADLINE_FILE stops probes; report unfinished coverage. QA_DEADLINE receipts are not observations.

## 2. Probe loop

Each probe is one native command/interaction plus checks, excluding bookkeeping.
Never batch probes.

1. First demonstrate success: output AND durable effects. Guard if bounded; await completion.
2. **Decide whether another probe is needed.** If bounded, run `bun DEADLINE_TOOL status DEADLINE_FILE`.
   If expired or no safe next probe remains, STOP exploration; write the report (§4), not a checkpoint.
   **Publish before probing.** Create (browser) or compose (functional) `exploration-NNN.json` in the probe directory, beside its deadline if bounded, with exactly four top-level fields:
   observationCommand: last completed probe's full outer command, including guard.
   observed: its exact decoded child JSON (no wrapper/extra keys), or its full non-JSON text.
   hypothesis: why nextCommand. nextCommand: exact command/request, guarded if bounded.
   Preserve every safe program-JSON key/value and identity hash unchanged.
   Withhold unsafe values, disclose limits and stop that chain.
   Check fields before publication. No drafts/placeholders or invented safe-path redactions; corrections cannot repair published notes.
   Functional: do not write this file; the next capture publishes it: `bun EVIDENCE_TOOL capture PROBE_DIR NNN --deadline DEADLINE_FILE --after PREV --hypothesis 'why' -- CMD` (PREV: the last complete capture's ID). EVIDENCE_TOOL supplies observed; never transcribe it.
   Browser checkpoints use Write.
   Wait for successful checkpoint publication before dispatch.
   Never backfill or overwrite notes.
3. Run that exact probe; DEADLINE_TOOL enforces the deadline when bounded.
   Report refusals as not-run; retain initial state/inputs/results. Repeat from step 2.
4. Replay the exact failing command/request from the same initial fixture state via steps 2–3 (same native command, fresh capture ID)
   before repair, then minimize via those gates. Expiry leaves confirmation/minimization incomplete.
   Another input or a regression test is not that replay.
5. After source/commands/fixtures change, re-review and return to step 2 for each affected revalidation (unproven=affected). Keep limits/notes; status requires fresh evidence.

## 3. Parent handoff

- **/qa:** parent owns severity, root-cause and Phase 8 regression gates before verified repair.
- **/review:** return before Fix-First; test_stub proposals require ASK approval.
- **Planning:** propose charters only; no execution.

Choose the smallest native test: unit for logic, integration for state/requests; E2E only if smaller tests miss the journey, not automatically both.
Mock only unrelated services.
Never freeze buggy output, weaken tests or delete valid red tests.

## 4. Final report

Use the surface report template; link each checkpoint. Separate browser scores, functional outcomes and proposed/executed tests.
Write PROBE_DIR/annotations.json {evidence: [{capture, command, contract, expected, classification}], limits: ["checkpoint 001"]} (limits: non-empty string array, not an object; browser-only: evidence []); before Markdown `bun EVIDENCE_TOOL materialize PROBE_DIR annotations.json` (fills observed/metadata; prints reportLinks; runs once per PROBE_DIR); you classify. Annotate every safe capture, including failures/replays: an omitted capture is withheld and keeps the verdict inconclusive. Classify a capture taken before an input change `superseded`; it closes when the same command reran on current inputs. Disclose withheld/incomplete evidence.
Evidence is invocation-local; /ship reruns once per invocation.
Missing prerequisites/expectations/observations, timeouts and refusal never pass.
Pass requires all required current-input contracts to pass with no required remainder.
Required failure leaves /review incomplete and /ship blocked unless the user explicitly accepts that named risk; noninteractive runs return blocked. Only nonbehavioral diffs may be not applicable (give a reason); prompts/templates are behavioral.
