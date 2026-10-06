# Testing internals: env keys, hermetic E2E

Moved verbatim from CLAUDE.md (token-load reduction). Read this before
writing or debugging E2E tests, passing `env:` to a runner, or touching
`test/helpers/hermetic-env.ts`.

**Env keys in Conductor workspaces.** The `GSTACK_*` env-shim (v1.39.2.0+,
`lib/conductor-env-shim.ts`) promotes `GSTACK_ANTHROPIC_API_KEY` /
`GSTACK_OPENAI_API_KEY` to their canonical names inside gstack's TS binaries.
Tests run through gstack entrypoints inherit this promotion automatically.
Don't echo the key value to stdout, logs, or shell history. The historical
"never pass `env:` to `runAgentSdkTest`" rule is retired: the failure was
partial-env replacement (the SDK's `Options.env` REPLACES the child's entire
environment, so an object without the key broke auth). The runner now always
passes a COMPLETE hermetic env with per-test `env:` merged last, so per-test
overrides are safe; ambient `process.env.ANTHROPIC_API_KEY` mutation also
still works (the env builder reads process.env at call time).

**Hermetic local E2E (default).** Every E2E runner (claude -p, PTY, Agent
SDK, codex, gemini) spawns children through `test/helpers/hermetic-env.ts`:
allowlist-scrubbed env (operator `CONDUCTOR_*`, `CLAUDE_*`, `GSTACK_*`,
`MCP_*`, `GBRAIN_*`, and credentials like `GH_TOKEN` never reach children),
a fresh seeded `CLAUDE_CONFIG_DIR` (no operator `~/.claude` CLAUDE.md /
MCP servers / skills), a temp `GSTACK_HOME`, and `--strict-mcp-config`.
Local eval signal matches CI. Debug against real operator state with
`EVALS_HERMETIC=0` (restores the legacy env AND drops the strict-MCP flag).
Per-test `env:` overrides merge last, so deliberate contamination
(`CONDUCTOR_WORKSPACE_PATH`, per-test `GSTACK_HOME`) keeps working. The
hermetic config dir seeds NO skills by default; a PTY test that types a
`/skill` slash command must pass `seedSkills: true` to the PTY runner, which
points the child's `CLAUDE_CONFIG_DIR` at `hermeticSkillsConfigDir()` — a
seeded registry that symlinks the LIVE working tree's SKILL.md files (by
design: the skills ARE the subject under test; a snapshot would measure stale
copies). Wiring is pinned by `test/hermetic-wiring.test.ts` (static tripwire),
two gate-tier canaries in `test/skill-e2e-hermetic-canary.test.ts`, and the
seeding tripwires in `test/hermetic-skills-seeding.test.ts` /
`test/pty-skill-seeding-wiring.test.ts`.

Seeded planning sessions also receive an isolated runtime home through
`test/helpers/hermetic-skill-runtime.ts`, so absolute lazy-section paths resolve
to the working tree under test. Explicit per-test home overrides remain intact.
Autoplan resolves each review skill from its own installed host registry.

**Interactive planning evidence.** Native plan-review count drivers use
`observeScreen: true` and await `currentScreen()` before choosing an input. The
existing xterm dependency interprets cursor moves and erases; old menus in the
raw stream cannot establish a current prompt. Snapshots preserve
`terminal.raw.log`, `terminal.visible.log`, and `terminal.screen.log` separately.
Setting `EVALS_RUN_ID` or `GSTACK_EVAL_DIR` retains these snapshots; an output
directory without a run ID gets a stable, unique local ID for that writer.
Completed native transcript calls establish question counts and phase coverage.
Report-aware count tests also require a fresh, complete report and native
completion evidence before accepting a completion heading.

The periodic first-question matrix uses `test/helpers/auq-native-capture.ts`
to match the first public `PreToolUse` AskUserQuestion payload to its current
native display. It grades that question's exact public fields without answering
it or reading model transcripts. `question_captured` records
`workflowCompleted: false`. With `GSTACK_EVAL_DIR`, `EVALS_RUN_ID`, or an explicit
run ID, `native-auq/<run-id>/<test>-<suffix>/capture.json` under the eval directory
retains the public payload, bounded current viewport, and capture outcome.
CEO mode selection uses the actual SDK `AskUserQuestion` permission callback
in `auq-sdk-capture.ts`, with the existing 12-turn and 240-second limits. It
captures the public question and stops without submitting an answer; its
`question_captured` outcome also records `workflowCompleted: false`. The retained
capture survives fixture cleanup. Provider refusals and malformed questions
remain failures. Section-loading captures retain their noninteractive contract.

Shared-code revalidation fixtures pair public tool calls with their successful
results to verify that the current trusted start record was inspected before
completion. A discovered path in tool output counts; a path mentioned only in
instructions or narration does not. Saved public captures cover absolute and
relative paths and discovery followed by a read. The revalidation prompt supplies
the path to the trusted start-record directory and declares the existing turn
limit. It asks the agent to batch independent reads and retrieve the complete
final record; every source, approval, persistence, and completion check still applies. The
path-boundary fixtures use this same execution contract for symlinks, submodules,
ignored files, index flags, and legacy or filtered evidence. Their skip actor
accepts an explicit no-change choice; a preservation word inside an option that
also approves changes cannot authorize edits. Captured native questions exercise
the actual answer callback, and native turn-limit failures still fail even after
a question was answered.

The engineering and DX finding fixtures check coverage of their seeded issues
rather than cap the total number of review questions. Each decision needs a
distinct, completed native question with an offered answer; accepting, rejecting,
or deferring a recommendation all count as reviewing it. Engineering's mandatory
legacy regression tests also need affirmative plan or public-narration evidence.
Additional useful questions are allowed within the existing time limits. Generic
question counts remain diagnostic, and a fresh final review report is required.

E2E tests stream progress in real-time (tool-by-tool via `--output-format stream-json
--verbose`). Results are persisted to `~/.gstack/projects/<slug>/evals/` (legacy
fallback `~/.gstack-dev/evals/`) with auto-comparison
against the previous finalized run (in-flight `_partial` files are never used as
a baseline, so a run can't compare against itself).

The periodic overlay fixtures use a versioned behavior gate with efficacy
reported separately. See [Overlay benchmark contract v4](OVERLAY_BENCHMARK_CONTRACT.md)
for exact correctness requirements, retired fanout cases, immutable evidence,
and the limits of a passing result. Under v4 a completed wrong answer is a
measured correctness result in either arm (`taskCorrect: false` with
`answerError`); only an overlay-ON wrong answer fails the case, so an
overlay-OFF wrong answer stays in the comparison. v3 verdicts keep their
original meaning.

## Coverage ownership

[The test portfolio audit](TEST_PORTFOLIO.md) separates deterministic harness
checks, prompt judges, live first-question captures, completed workflows and
platform integrations. Shared setup is reusable; evidence with different
scenario or independent-trial requirements is not. It records the preserved
coverage and measured component savings from the test-speed refactor.

## Runners: how the suites execute (2026-08 overhaul)

**Aside-only E2E tests self-skip without a live Aside; browser-driving tests
run on either engine.** Every skill that opens a web page drives the Aside AI
browser first (`scripts/resolvers/aside.ts`) and falls back to gstack's own
browse engine when Aside is absent (and Chromium bootstrapped). The cases that
need Aside itself (`test/skill-e2e-aside.test.ts`, `design-review-fix` in
`test/skill-e2e-design.test.ts`) call `asideAvailable()` from
`test/helpers/aside-available.ts` (the same probe the skills run in BROWSER
SETUP) and skip when the `aside` CLI or the Aside app is absent. CI runners have
no Aside, so those run only on macOS dev machines and sit in the periodic tier;
set `GSTACK_SKIP_ASIDE=1` to force the skip locally (which also exercises the
fallback hand-off). The qa E2E files (`test/skill-e2e-qa-workflow.test.ts`,
`test/skill-e2e-qa-bugs.test.ts`) gate on `asideAvailable() ||
fs.existsSync(browseBin)`: the skill's own BROWSER SETUP picks the engine, so
on a Mac they drive Aside and on Linux CI they drive the built browse binary,
skipping only when neither exists. The `$B`-driven E2E cases and `browse/test/`
run on every platform as before, so Linux CI proves the fallback engine live.

**Bootstrap dependency retention is opt-in qualification, not the behavior test.**
`qa-bootstrap` still runs its original unpinned Vitest installation and assertions
on macOS and Linux, including documented unsharded commands. Only a Linux paid
shard runner issues the owned retention scope: it binds each actual fixture and
native lifetime, retains locks, package manifests and the installed file/link
inventory, and acknowledges capture before deleting the fixture. The outer
runner also captures evidence when a callback is killed. Incomplete capture
fails qualification and preserves the source fixture as well as partial evidence.
Other platforms explicitly report retention as unavailable and still execute the
native behavior test. A run without the runner-issued scope earns no retained
dependency qualification credit; candidate acceptance requiring that evidence
must use the Linux sharded path and verify every attempt's complete capture,
acknowledgment and cleanup fallback. A passing unsharded or macOS behavior test
does not substitute for that evidence.

**The renderer picks the same way, so the render gates are engine-agnostic.**
`/make-pdf`, `/diagram`, and design previews print and screenshot their local
HTML through `lib/aside-render.ts` / `bin/gstack-render.ts`, which render in
Aside when `probeAside()` says `READY` and through the browse engine otherwise.
make-pdf's `*-gate.test.ts` and `test/skill-e2e-diagram.test.ts` (periodic,
paid) gate on `browserAvailable()` (`test/helpers/browser-available.ts`:
`asideAvailable() || resolveBrowseBin() !== null`) — on a Mac they print
through Aside, on Linux CI through the browse binary `bun run build:gates`
compiles, and they skip only when neither exists. Only
`test/aside-render.test.ts`'s two live Aside cases (a full round-trip and a
late-readiness `--wait-expr` poll) are Aside-only: its option
mapping and generated-script pins run everywhere, and its fake-executable cases
drive both engines hermetically (fake `aside` / `browse` scripts on PATH pin
probe classification, the stdout contract, loopback-server policy, the timeout
kill, engine choice and the mid-run fallback). `test/gstack-render-cli.test.ts`
does the same for `bin/gstack-render.ts` with `GSTACK_SKIP_ASIDE=1` and
`GSTACK_BROWSE_BIN` pointed at a fake daemon that logs every argv line. A green
gate on Linux proves the fallback engine, not Aside; the Mac run is the Aside
evidence.
The browse-binary leg presumes Chromium bootstrapped: `resolveBrowseBin()`
only checks that the binary (or the `find-browse` shim) exists, never that
Chromium can launch, so on an install where the best-effort Chromium step
was skipped (`GSTACK_SKIP_PLAYWRIGHT=1`) or failed, these gates run and fail
at browser launch instead of skipping. Fix the bootstrap (or move the binary
aside) before running them locally; CI always installs Chromium first.
`test/dom-dump-hygiene.test.ts` is the one free-suite case on the same leg: it
runs `lib/dom-dump.js` (the rendered-DOM dump `/design-review` hands the design
detector) inside a real Chromium page through the built browse binary, so it
self-skips when the binary is absent and, because a cold Chromium launch is
load-sensitive on a busy dev box, runs only in CI or on explicit opt-in
(`GSTACK_DOM_DUMP_HYGIENE=1`).

**Free suite (`bun run test:free`).** `scripts/test-free-shards.ts` runs N
concurrent shard processes (serial within each) with strict-output
classification per shard. Local defaults use the available CPU affinity
(which Bun also bounds by a container's cgroup CPU quota), floored at one and
capped at 16 on Linux and six on macOS and Windows; `GSTACK_FREE_JOBS` remains
an explicit override.
This does not change the separate CI machine count. Full-suite shards are packed by RECORDED PER-FILE
DURATIONS (LPT, `packShardsByDuration`) when the committed seed
`scripts/free-test-durations.json` exists — refresh it with
`bun run test:ubicloud --record-durations`, which times each file in its own
child on a VM with the CI lane's environment and copies the seed back; see
[Free suite duration seed](#free-suite-duration-seed). Missing seed → silent hash-shard fallback; corrupt seed → one warning +
fallback; unknown files get 99th-percentile pessimism, and both full-suite and
`--ci-plan` runs name them on stderr so a new slow file cannot silently become
the long pole. Packed
shards get duration-aware walls (`max(base, predicted × 3, files × 5s)`). The
legacy `--shards N --shard i` path keeps stable hash indices. Required CI uses
one duration-packed `--ci-plan`, 20 ordinary `--ci-run` shards plus a separate
exclusive-fixture shard, and a `--ci-verify` aggregate. CI shards still run on
independent machines without ordering unrelated jobs. The public
`TREE_MUTATING` map now classifies exclusive host-state fixtures; its sole
entry is `test/bootstrap-retention.test.ts`, whose same-UID nondumpable actors
affect host-wide procfs permission checks. Locally, this file runs only after
all parallel shards settle, and cancellation prevents that final phase from
starting. No selected files, retries, budgets, or receipt requirements are
removed. Former generator mutators still render into private output directories;
this serial phase protects process visibility, not in-place doc generation.

Full child output is retained in private files under `.context/free-test-logs/`,
outside each shard's temporary cleanup directory. The runner prints the path at
launch and completion. Losing the log fails the run even when the child exits
successfully. A redirected log directory is rejected before launching a child.
On failure, read that log first: the recovery message distinguishes incomplete
capture, unconfirmed cleanup, deadline expiry and a test/module failure. Fix the
demonstrated cause before rerunning. A focused `bun test` command is offered only
when every failure is attributable to existing selected files; it proves that
repair, not completion of the original selection. Preserve failed attempts when
sharing results, and inspect logs for private data before sharing them.

Before publication, classify new deterministic regressions for quick feedback.
Refresh the timing seed with the existing recorder on fixed inputs; do not edit
source while tests run. Critical boundary controls belong in `QUICK_CORE` when
their feedback cost is justified. Other measured files qualify at two seconds
or less; slow and unmeasured files remain outside quick, not outside full tests.
Report cold setup separately from warm execution, while retaining failed-attempt,
retry and cleanup time in the total cost.

**PTY fixture timing.** Plan-count sessions wake on terminal output or exit,
with at least 250ms between expensive observations and a 2s fallback for
transcript or hook changes that produce no terminal output. New output batches
settle for 250ms before observation so split terminal redraws cannot route input
from their first chunk. Input debounces,
permission guards, and the real CLI's 8s startup grace are unchanged. Synthetic
CLIs can pass `startupReadyMarker` to `runPlanSkillCounting` and emit that exact
marker after installing their input handlers; a missing marker fails before
any command is sent. The marker wait stays inside the existing startup and
total-run deadlines. `test/pty-output-wake.test.ts` covers output, silent waits,
exit, close, missing readiness, split redraws, and continuous redraws. Close and output waits
cancel their losing deadlines so completed workers can exit immediately.

The UI-positive design gate commits the supplied plan as `review-input.md`
before the first model turn. It requires an acknowledged Design focus/rating
question followed by an answered native finding about concrete UI behavior;
setup and outside-review choices cannot satisfy that sequence. Its declared
board actor submits feedback before acknowledging it. The final proof uses
the full native question, not the truncated diagnostic snippet, and proposal
text mentioning "no UI scope" is not treated as an exit verdict. Unknown-command
failures must name the invoked slash command; a child tool rejecting `--help`
is not a skill registration failure. Periodic seeded-finding classifiers
separately verify fixture-owned findings.

**Paid suite (sharded runner, local AND CI).** `scripts/test-paid-shards.ts`
is the single selection engine: 1 file per shard, `EVALS_JOBS` shard
processes × `EVALS_CONCURRENCY` within-shard, per-shard `GSTACK_EVAL_DIR`,
full-stream spooling to per-shard log files (path printed at START and on
failure), never-started/timed-out taxonomy, and parent-computed diff
selection propagated to children via `EVALS_SELECTION_JSON` (fail-open: a
child that can't parse it recomputes locally with one warning). Paid evals
never retry; each case's kind fixes its trials before the run (see "Eval verdict
policy" below). Files in `CASE_SHARDED_FILES` run one registered case per
process (`<file>#<case id>`, an exact `--test-name-pattern`, exactly one executed
case), so a long file of short cases spreads across runners and each case gets
its own SDK semaphore. `test/carve-section-loading.test.ts` is one of them: it registers
one periodic case per carved skill (`carve-section-loading-<skill>`, each with
its own touchfiles and history). Run one case with
`bun run scripts/test-paid-shards.ts --tier periodic --case carve-section-loading-<skill>`.
Trial telemetry rides the store: every recorded test carries its 1-based
`attempt` plus, on an isolated trial shard, its `case_id`, `kind`, `trial`,
`panel` and `policy_version`, and each lane's report uploads one
`trial-outcomes` JSONL line per trial. `bun run eval:pass-rates`
turns that history into per-case pass rates
(see "Pass-rate history" below; free-suite flakes are a separate record, see
[Flake ledger](#flake-ledger)). Census integrity is
enforced from the free suite: every `E2E_TOUCHFILES` / `LLM_JUDGE_TOUCHFILES`
key must name a living paid test (`test/touchfiles.test.ts`'s reverse
invariant), and `git show <sha>:path` fixtures are banned — vendor the bytes
instead (`test/git-ref-fixture-tripwire.test.ts`).

Functional QA and documentation acceptance require an explicit `EVALS_RUN_ID`;
`GSTACK_EVAL_DIR` alone does not satisfy their evidence-ownership guard. For each
local invocation, supply a fresh ID to the documented detached runner:

```bash
EVALS_RUN_ID="local-$(bun -e 'console.log(crypto.randomUUID())')" bun run eval:bg:pr
```

Neither package scripts nor `gstack-detach` invent this identity. CI's PR/manual
slices, periodic slices and weekly gate census supply an ID bound to the workflow
run, attempt, job and slice. Existing slice artifacts retain per-shard snapshots;
separate always-run `native-captures-<EVALS_RUN_ID>` artifacts retain project/legacy
`e2e-runs` and `evals/qa-callers` evidence for 90 days. These diagnostic artifacts
are not collector results and do not establish that an unfinished test passed.

**Fast PR profile and evidence reuse.** `test:pr` selects the changed cases in
`scripts/test-pr-profile.ts` plus every changed quality judge. `--profile full`
retains the broad census; no case IDs or tier assignments are removed. The plan
records both E2E and judge selections and lists deferred coverage. Executors
receive those selections separately and the report checks actual executed case
counts. Unknown source dependencies restore the broad gate (see
[PR paid lane fallback](#pr-paid-lane-fallback)); unmapped prompts
without registered coverage require full validation. Known broad-only prompt
changes are explicitly deferred, not counted as PR passes. Weekly/manual runs of
`evals-periodic.yml` execute both complete censuses fresh; manual `evals.yml`
runs the broad gate. This deliberately moves some defect detection later.

`scripts/eval-input-cache.ts` accepts only complete, clean, first-attempt passes
with matching before/after inputs. The audited workflow-judge adapter hashes the
actual expanded prompt, source/fixture/rubric/runner closure, installed SDK,
model parameters and runtime. Missing/unknown inputs force execution. Receipts
are scoped to the same repository and PR, expire after 24 hours, and contain
public scores and provenance rather than prompts or secrets. Of the 17 cases
using `runWorkflowJudge`, 16 are eligible; the cookie workflow's custom input
does not match the cache adapter and stays fresh, as do the other 11 quality cases.
CI supplies the scoped cache/runtime configuration; local runs are fresh by
default. Cached scores must
pass current assertions; reused records retain their original source and time
and cannot renew the receipt. `scripts/e2e-shard-reuse.ts` extends the same receipts
to PR-profile E2E shards (paid evals never retry, so a pass is structurally a
first attempt): the identity hashes the test's import closure, every tracked file
matched by the touchfiles of every case the file registers plus the global
touchfiles, the runner/workflow/setup actions, the child's environment pins, the
CI image and Claude CLI version, and the shard's case ids, pattern, wall and
concurrency. A computed registration, an unmatched touchfile pattern, a retrying
file, a preload option or a custom endpoint makes the shard ineligible. A reused
shard reports `reused` with its source run and writes `execution: "reused"`
collector records; the report rejects reused outcomes outside the fast PR profile.
`EVALS_FRESH=1`, periodic, marathon and release validation bypass both lookup and publishing.

**Free test timing and isolation.** `test:quick` is an explicitly partial measured
subset for edit feedback. `test` remains complete local acceptance with its
bounded worker pool. The CI planner inventories every free file and packs them
using `scripts/free-test-durations.json`; each machine runs its assigned shard
serially. Plans and receipts bind the source revision, complete inventory and
strict outcomes; missing, duplicate or mismatched receipts fail the required
aggregate. The existing maximum five-file flaky retry allowance applies across
the entire lane, not separately to every machine. Refresh the full timing list
with `bun run test:ubicloud --record-durations`. Profiling records failures faithfully
and is separate from final release acceptance.

**CI planner/executor/report.** `--emit-plan <path> --slice-budget S --jobs J`
(CI) or `--slices K` (local) computes selection + the slice plan ONCE (killing
per-slice selector divergence);
`--plan <path> --slice i` executors consume the manifest and write
slice-result artifacts; `--report <dir>` reconciles them FAIL-CLOSED (a slice
whose artifact never landed, or a planned shard nobody reported, is a
failure). Budget mode (`packBySliceBudget`) places shards longest-recorded-first
into the fullest slice whose estimated wall on J FIFO workers stays within S
seconds, else a new slice; a shard with no recorded wall weighs the whole budget
(its own runner), a shard longer than the budget runs alone, and overlays keep
one final one-at-a-time slice. The manifest's `plan` records each slice estimate
and its own CI job ceiling in `sliceCiTimeoutMinutes`: max(2 × slice budget, the
slice's longest shard supervised wall, the serialized overlay envelope) + 20
minutes setup (`CI_SETUP_ALLOWANCE_MINUTES`); `ciTimeoutMinutes` is the largest of
them. CI derives the matrix (`[range(1; .sliceCount + 1)]`) from the manifest and
indexes each slice's ceiling as its job timeout
(`fromJSON(needs.plan-slices.outputs.slice_timeouts)[matrix.slice]`). Executors
refuse an `EVALS_JOBS` other than the planned J and run their shards longest first.

Each executor's first step records its job start (`GSTACK_SLICE_JOB_STARTED_AT`).
The slice deadline is that start + the slice ceiling − a 5-minute upload reserve:
after it the executor starts no more shards. A shard that never started reports
`not_run` (INFRA, `never-started`); a shard still running is killed and reports
`hung` (TIMEOUT, `timed-out`). The executor checkpoints `slice-N.json` after every
shard start and finish, so a job killed before its final write reports from the
checkpoint (`slice N/M ended before its final result …: TIMEOUT`), never as a
missing slice. `--slices K` keeps the supervised round-robin
baseline re-packed by recorded times for local runs. Durations are recorded per
tier (a file's gate and periodic cases differ); refresh one tier from a
downloaded report directory with `--report <dir> --write-durations`. Under `EVALS_ALL` the hollow-shard guard marks exit-0 shards with
ZERO executed tests `passed-empty` (a failure) — census-health, not just
test runs. evals.yml runs the sliced gate lane per PR — the ONLY paid lane
since the legacy 17-row matrix (22.6 min/$21 per PR serialized ahead of the
slices) was deleted after demonstrated parity; its
`KNOWN_MATRIX_GAPS`/`KNOWN_TIER_UNSET` ratchets retired with it and
`test/evals-workflow-wiring.test.ts` pins the surviving wiring (slice-count
agreement, tier consistency, the shared register-skills composite with its
fail-fast verification loop). Tier `marathon` (complete start-to-finish flows)
is selected positively: a file enters the marathon plan only when it declares
`describeE2ETier('marathon')` or registers a marathon-tier case, and the gate and
periodic planners exclude marathon-only files; `evals-marathon.yml` runs them
weekly and on dispatch, fresh, one file per runner, with its own fail-closed
report and tracking issue, and nothing requires it. evals-periodic.yml runs ALL
periodic-tier files weekly (the coverage contract) minus the reasoned
exclusions in `test/helpers/periodic-exclude-data.ts` (reason + tracking
required per entry; removal re-activates the file), plus a weekly
`EVALS_ALL` gate census. A red census writes one report on every ref, to the
step summary and the `census-report-a<attempt>` artifact: the run's branch, sha
and event, both lanes' summaries, every pass-rate alarm line, the red ledger
and session headroom (`eval:pass-rates --reds` / `--headroom --runs 10 --branch
<ref>`), the all-green estimate and a link to the red-census guide, with
report-derived text passed through `scripts/lib/published-text.ts`. Only a run
on `refs/heads/main` comments on (or opens) the one tracking issue and closes it
on the next green run; the marathon lane does the same with its own issue and
`marathon-report-a<attempt>` artifact. `test/evals-tracking-issue.test.ts`
pins the main-only guard and runs both report scripts. The host-run Codex job
also carries the live Codex multi-block case (`codex-multiblock-live`: `./setup
--host codex` from the job's checkout into a fresh `CODEX_HOME`, the router in
`codex debug prompt-input`, and a later /learn block rooted by its own
prelude), and the periodic lane runs the design default-model smoke
(`design-model-smoke`), a visible SKIPPED with no coverage credit when
`OPENAI_API_KEY` is absent. The CI
image pins the claude CLI to an exact version (`.github/docker/Dockerfile.ci`,
enforced by `test/ci-image-cli-pin.test.ts` — bumps ride PRs that run the PTY
gate), and every eval-store run records `claude --version`, resolved once in
the runner parent and handed to shard children as `GSTACK_CLAUDE_CLI_VERSION`
(never spawned on a test thread), so a TUI-drift flake hunt is a grep, not
archaeology.

<a id="eval-verdict-policy"></a>
**Eval verdict policy** (`EVAL_POLICY` version 2 in
`test/helpers/periodic-exclude-data.ts`; version 1 pre-registered 2026-09-29,
version 2 approved 2026-10-04 with the decision memo in
[test-audit-2026-10.md](test-audit-2026-10.md)). Paid evals
never retry. Each live case has exactly one kind in `E2E_KINDS`
(`test/helpers/touchfiles-data.ts`; `test/eval-kinds.test.ts` enforces coverage),
and the kind fixes its trials before the run:

- `rule` (default): one trial; any failed assertion fails the verdict. For
  cases where nothing stochastic decides the verdict, or where it checks a
  contract the product must meet every run.
- `behavior`: a panel of `n = 3` independent trials, launched together as
  isolated case shards on different slices (key `<file>#<id>~t<N>`). All three
  always run: no early stop and no conditional extra trial. PASS when at least
  `k = 2` pass and no trial violated a contract (`expectContract()` stamps
  `failure_class: 'contract'`). Each behavior case names its tolerated deviation
  in `BEHAVIOR_WHY` and must have a literal registration so it can run alone.
- `judge`: an LLM judge scoring a fixed input. `judgePanel()`
  (`test/helpers/llm-judge.ts`) draws 3 samples of the same prompt concurrently
  inside the unchanged `JUDGE_MS`; numeric dimensions gate on the per-dimension
  median of exactly 3 samples, so at least 2 of 3 must meet the unchanged
  threshold (`judgePanelMedian()`; no dimension compensates for another, and
  any other sample count fails closed), booleans on a strict majority. Panel
  logs show every sample and the mean for information; the median is the gate
  (EVAL_POLICY v3, approved 2026-10-06). A sample that errors (refusal, truncation,
  non-JSON, a malformed field) fails the panel and is never resampled; a
  refusal counts as an unscored panel only when every sample refused.
  `callJudge`'s 429 backoff happens before any model output and is transport,
  not a verdict retry. The workflow-judge cache stores whole panels only.
  The `rule` case auq-matrix uses the same panel inside its one execution: each
  skill's single native capture has its recommendation substance scored by 3
  judge samples, gated on their median against the unchanged minimum of 4, and a
  failed sample fails the panel without resampling (approved 2026-10-04 for
  censuses after the change).

`panelVerdict()` (`test/helpers/eval-store.ts`) is the single verdict
function the report, `collector-outcomes.json`, the PR comment and pass-rates
all use. A timed-out, crashed or infrastructure-failed trial is a failed trial
recorded with its class; a missing or duplicate trial record makes the verdict
INCOMPLETE, which fails the lane; a 2/3 PASS is shown as `PASS 2/3` with the
failed trial's cause. A manual re-run adds trials under a new run attempt and
never replaces the first attempt's verdict. A red census is never rerun on
unchanged inputs: each red is diagnosed as product, test/detector, harness or
infra and resolved by a concrete repair and a fresh census, or listed as a named
red. The one exception: a census whose every red verdict is machine-classified
INFRA or INCOMPLETE (missing slice artifact, runner loss, API error before the
first model turn) may be re-dispatched once as a new run, and both runs are
reported. Changing any `EVAL_POLICY` constant after seeing census results needs
Garry's re-approval, a `version` bump and a fresh census;
`test/periodic-exclude-policy.test.ts` pins the approved values.

### Ship measure

**Measure-then-fix: diagnostic trials are not verdicts** (`scripts/ship-measure.ts`).
When a paid case goes red during /ship, /ship measures that case alone before it
reruns the full gate: classify the red line, measure, fix at the cause,
re-measure, then run the gate once (`ship/sections/measure.md`). The repeated
runs are **diagnostic measurement, not verdict retries**, so they fit the
no-retry rule above: they never change the recorded verdict of the run that
failed, every trial and measurement file says `"label": "diagnostic"` and
`"verdict": null`, and they are written under `.context/ship-measure/<case>/<round>/t<NN>/`
(one directory per baseline, repair round and trial; an existing round is never
overwritten). The runner refuses an output directory inside the project eval
dir, so pass-rate history and CI uploads never read a diagnostic trial as a
verdict. The lane verdict still comes only from the full gate run. Each trial
runs through gstack's single-case runner (`scripts/test-paid-shards.ts --tier
<tier> --case <id> --trials 1`; a standalone judge id runs its file with only
that judge selected and needs its own passing record) or through the project's
documented single-case command (`--command '<command> {case}'`, split on
whitespace, no shell).

Counts per kind come from gstack config (`bin/gstack-config`), so a measurement
is pre-registered before it runs:

| Kind | Trials (config key, default) | Meets target when |
|---|---|---|
| `rule` | `ship_measure_rule_trials`, 10 | at least 90% of trials pass (9 of 10) |
| `behavior` | `ship_measure_behavior_panels`, 4 panels of 3 (12 trials) | every panel passes at its own 2 of 3 with no contract violation, and at least 90% of trials pass (11 of 12) |
| `judge` | `ship_measure_judge_outputs`, 10 outputs | at least 90% of outputs pass (9 of 10); an output passes when 2 of its 3 judge samples pass |

`ship_measure_budget_usd` (default 25) is an estimated admission budget per red
case across the baseline, every repair round and judge scoring: before each
batch the runner reserves the estimated cost of every concurrent trial and
admits only what fits beside what was already spent, then reconciles actual
costs after the batch. When the next trial no longer fits it stops with a named
red. A case with no per-trial estimate, or one above
`ship_measure_ask_per_trial_usd` (default 2), asks once before any trial runs;
with no estimate it then runs one calibration trial alone. `ship_measure_max_rounds`
(default 3) limits repair rounds. `ship-measure report` prints the PR-body table:
each measurement as "observed k/n" (after the named fix for a repair round),
target, estimated and actual spend. A red the user declares infrastructure is
recorded with `ship-measure skip` and shows as `unmeasured`, never as a pass. A
case is called fixed only with a named causal change and every failure in the
closing measurement explained; the weekly census, not the loop, reports
long-term reliability.

The same rule covers a failed free-suite shard: `ship-measure free` reruns that
shard's exact file list 10 times (rerun 1 alone as the baseline, the rest in
parallel at `max(1, floor(cores / shard concurrency))`), each with its own HOME,
state root and flake ledger and with `GSTACK_FREE_RETRY_FLAKY=0`, under a
10-minute wall cap that reports a partial count. Browse daemons in a rerun pick
free random ports, as in the normal suite. `ship_rerun_backend=ubicloud` runs the
reruns on one Ubicloud VM through `bun run test:ubicloud --diagnostic`, which
also sets the flaky retry off. The seeded paid case `ship-measure-seeded-flake`
(periodic, `behavior`) drives /ship through this loop against a stub eval
command that fails trial slots 2, 5 and 9 until its list is sorted.

<a id="failure-causes"></a>
**Failure causes and details** (diagnostic only; verdicts unchanged under v1).
Every failed trial record keeps `failure_class` (`assertion`, `contract`,
`timeout`, `infra`: the field verdicts, INFRA re-dispatch and pass rates read)
and its 300-character `error` exactly as before. `failureCauseOf()`
(`test/helpers/eval-store.ts`, called by both record builders, including the
JUnit census for PTY and JUnit-only cases) adds an optional `failure_cause`
with a one-line `failure_cause_evidence`. It never changes `failure_class`.
The highest-precedence cause with evidence wins:

| `failure_cause` | Recorded when | First step |
|---|---|---|
| `contract` | `expectContract()` stamped a contract violation | fix the product; a violation fails a behavior panel outright |
| `pre_turn_infra` | the trial failed before the first model turn (`failure_class: 'infra'`) | check the runner and API status; an all-INFRA census is re-dispatched once |
| `api_error` | a session ended on an API error (for PTY, the `API Error:` panel on an idle turn) or the runner's exit reason was `error_api` | read the evidence line; a provider outage is a named red |
| `refusal` | the structured stop reason was a refusal (phrases only as a last resort; quoted refusal text in a tool result does not count) | check whether the fixture prompt invites the refusal |
| `provider_stall` | a session that streamed partial messages saw no event of any kind, thinking deltas included, for `STALL_WINDOW_MS` (120 s) while a model request was in flight and no tool, permission prompt, hook or subagent was outstanding; sessions without partial messages are never stalls | read the session ledger row; still a failed trial under v1 |
| `session_timeout` | a runner's armed session timeout fired | `eval:pass-rates --headroom`; cut work, never raise the budget |
| `observer_timeout` | the test's observer gave up waiting for an outcome (`outcome=timeout`) | read the transcript tail: a missed detector or a product that never answered |
| `assertion` | a check failed after the session ran (`session completed; check failed` when it ended normally) | the Expected/Received values or judge dimensions |
| `unknown` | the trial failed with no evidence for any cause above | inspect the shard directory |

A detector, harness or product fault is a human diagnosis, never a cause.
Readers before this field accept the new records (a frozen v1 reader runs over
them in `test/eval-store.test.ts`); an unknown cause from a newer gstack is
rejected with `unknown failure_cause "<x>" (written by a newer gstack; update
this checkout to read it)`.

`failure_detail` carries the values `error` cannot hold: a failed Bun matcher's
`{expected, received}`, or for a judge one `{dimension, mean, threshold,
samples, rationale}` entry per failing dimension (since EVAL_POLICY v3 `mean`
holds the panel's gating median), each part capped at 200
characters. `sessions[]` (at most 32) summarizes the trial's session-ledger
rows. `cost_known: false` marks a record or trial whose harness captured no
billing: PTY and Codex sessions never bill, and an SDK session bills only with a
terminal `total_cost_usd`. An absent field means known. Census and marathon
cost lines print the known sum and `N of M trial(s) cost unknown`, never a bare
total over unknowns.

<a id="session-ledger"></a>
**Session ledger.** Every runner (session-runner, the Agent SDK runner
including `runSharedInteractive`, the PTY session and `runRecordedCodexEval`)
appends one best-effort line per armed session to
`$GSTACK_EVAL_DIR/session-ledger.jsonl` (`test/helpers/session-ledger.ts`):
a stable key `<runner>:<label>#n`, the exact `budget_ms` it armed, monotonic
`elapsed_ms`, the `end` reason, sanitized evidence, `billed`, and a compact
liveness summary (longest in-request silence, the last event kind, any tool open
at the end). `claude -p` sessions stream partial messages for this summary;
transcripts keep their shape and size (full stream diagnostics only with
`publicStreamDiagnostics`). A failed ledger write never fails a trial; a trial
without ledger rows has no `sessions` and its headroom is `unknown`, never
scored. The ledger rides in each slice artifact beside the shard results.

**Quarantine** (`CASE_QUARANTINE`, same file). An entry needs: a per-trial rate
below 95% over at least 10 post-policy trials of the case's current input
identity (pre-policy backfill may justify only an initial entry, labeled as
such); a written diagnosis in `reason` whose `failureClass` is `detector`,
`harness` or `model-latency` (a product defect is fixed or listed as a named
red, never quarantined); unchanged case touchfiles in the change that adds it;
and an owner, tracking pointer, `enteredAt` date and measurable `exit`. A
quarantined case still runs its full panel and reports in every lane but cannot
fail it, except on a hard break (0 of n) or a contract violation, and it never
counts as passing coverage. At most 10% of a blocking tier (gate, periodic) may
be quarantined. The weekly report fails when an entry passes its exit rule (at
least 97% over at least 10 trials) without being removed, when an entry is 8
weekly runs old, or when a tier is over its cap.

**Pass-rate history** (`bun run eval:pass-rates`, `scripts/eval-flake-rank.ts`).
It reads the `trial-outcomes` artifact of the last N completed weekly
`evals-periodic.yml` runs, meaning scheduled runs on `main` plus `main`
dispatches, plus completed branch census runs in the same window (flags:
`--case`, `--runs N`, `--branch` to inspect one branch, `--dir`, `--backfill`,
`--json`, `--gate`, and the views `--headroom`, `--reds`,
`--run <id>`; `--help` works offline, and an unknown flag or case id exits 2
before anything is fetched; every view prints its `scope:` line). A branch trial counts only toward a series `main` has also
run (same case-owned bytes, `HARNESS_VERSION`, model and CLI); a branch never
starts or becomes a case's current series, and weeks for quarantine expiry
count `main` runs only. It prints
per-case per-trial pass rates with 95% Wilson intervals. A series is one case
under one input identity ([Harness version](#harness-version)), per model,
Claude CLI version and policy version
([Pass-rate policy versions](#pass-rate-policy-versions)); a change starts a
new series and older ones stay visible. Labels: INCONCLUSIVE below 10 trials, BROKEN when the latest run is
0/n after a prior interval at or above 95%, FLAKY when failures leave the
interval straddling 95%, FAILING when the whole interval is below it, PASSING
otherwise. `--backfill` imports legacy slice artifacts as pre-policy trials
(first attempt only; a record that names no registry id is listed as
unattributed, never guessed); they are display-only. `--gate` (the weekly
report) fails with ACTION REQUIRED, on post-policy trials of the current series
only, when a non-quarantined blocking case meets the entry rule (proposing an
entry), when a `rule` case does (rule case behaving like behavior: fix or
reclassify), when a blocking case's current identity is significantly below its
previous one (one-sided Fisher exact, α = 0.05, at least 6 trials each side,
Holm-controlled across the cases tested), on the quarantine rules above, and
with a `[headroom]` alarm when a case's slowest session ran above
`HEADROOM_FAIL` (85%) of the budget it armed. History that cannot be fetched
fails the gate closed.

The views (`scripts/lib/eval-history.ts`): `--headroom` lists each case's
slowest armed session against its budget (warn above `HEADROOM_WARN`, 75%;
`insufficient` below 3 samples; timed-out samples marked censored; `unknown`
without a session ledger, with the case wall beside it as a labelled upper
bound) and the census critical path from the slice job timings. `--reds` lists
verdict reds per census lane by failure class and cause, pooled and shrunk
per-case red rates, and the all-green probability Π(1 − p_i) over the latest
census's cases with an interval, labelled an approximation because verdicts are
not proven independent. `--run <id>` is one census's triage: each red with its
values and history, and the transcript evidence it downloads from only the
slices its reds name (a slice artifact over 64 MB is reported, not fetched).
The three thresholds `HEADROOM_WARN`, `HEADROOM_FAIL` and `STALL_WINDOW_MS`
live in `test/helpers/eval-budgets.ts`, outside `EVAL_POLICY`; a slow case gets
less work, never a larger budget. The red-census walkthrough is
[docs/evals/census-red.md](evals/census-red.md).

**The arithmetic.** With per-trial pass rate p, the chance a single case goes
red (a false red while the product works, the catch rate once it has
regressed):

| p | 1 trial | 2-of-3 panel |
|---|---|---|
| 0.99 | 1.0% | 0.03% |
| 0.95 | 5.0% | 0.72% |
| 0.90 | 10.0% | 2.8% |
| 0.70 | 30.0% | 21.6% |
| 0.30 | 70.0% | 78.4% |

The panel removes most false reds at healthy rates, but it catches a 0.95 → 0.70
regression in one run only 21.6% of the time (a single trial 30%, retry-until-green
3%), so drift detection is the history rule's job, not the per-run verdict's.
The Fisher alarm is weak at the minimum sample (5.4% power for 0.95 → 0.70 at
6 trials a side), and ten straight passes still leave a 72% Wilson lower bound:
after this policy lands, every series starts INCONCLUSIVE.

A lane is all green with probability Π p_rule × Π P(≥2 of 3 | p_behavior) ×
Π p_judge. For the current registry (PR gate worst case: 107 rule cases and 24
judges; weekly census: 190 rule, 22 behavior and 25 judge verdicts), with rule
and judge verdicts at p_rule:

| p_rule | full PR gate | weekly, behavior p = 0.90 | 0.95 | 0.97 |
|---|---|---|---|---|
| 0.99 | 26.8% | 6.2% | 9.8% | 10.9% |
| 0.995 | 51.9% | 18.2% | 29.0% | 32.1% |
| 0.999 | 87.7% | 43.2% | 68.7% | 76.1% |

The rule term dominates: a green lane on a working product needs rule cases to
be near-deterministic (0.999), which is why failing detectors are converted to
outcome checks and product defects are fixed or named, and why each census
reports its all-green probability from the measured rates (`eval:pass-rates
--reds`, carried into the census report).

**Timeout policy.** Paid tests use the tiers in
`test/helpers/eval-budgets.ts` (JUDGE/CAPTURE/CAPTURE_LONG/PTY/PTY_LONG);
`test/eval-budgets-policy.test.ts` pins that every tier fits the shard wall
minus overhead and ratchets raw literals. Budget above the wall is fiction.
No paid test may exceed the ordinary tiers.

`FINDING_RETRY_BUDGETS` also registers the CEO split-overflow and Eng
multi-finding batching files. Each retains its 25-minute case deadline and runs
once (paid evals never retry) in a 27-minute shard wall including two minutes for
cleanup. No per-case budget grows. Overlay wrappers
have a 1,830-second minimum shard wall and run without Bun retries; see the
[overlay contract](OVERLAY_BENCHMARK_CONTRACT.md) for their unchanged work budget.

The quality file reserves its whole-file wall (3,170 seconds) for every case run
once, plus cleanup. Each still has 120 seconds of model work. Its 17 workflow
judges own their deadline and abort signal, with five seconds for terminal
recording inside a ten-second Bun grace; the other 11 retain their existing
120-second Bun timeout. Late responses cannot create records or cache passes.

The ship documentation file reserves 4,920 seconds for four 600-second cases and
eight 300-second fault cases, run once, plus cleanup; in CI each case runs as its
own shard. The standalone
documentation child retains its 600-second case. The five review/ship explorer
cases reserve 1,695 seconds, run once, including finalization grace.
These are whole-file supervision limits, not additional model work per case.

The shared-library path file reserves 1,920 seconds for its three serial
600-second cases, run once, plus 120 seconds for cleanup; in CI each case runs as
its own shard with a 720-second wall (a registered file's case shard supervises
`caseMs` times its allowed attempts plus the reserve). Its
registered budget keeps the file in its own shard and binds the expected wall
to both the saved plan and the execution receipt; missing or stale budget
records fail reconciliation. Case deadlines and model budgets do not grow.

`resolvePaidShardBudget(files, overrideMs?)` is the canonical per-job resolver.
Each registered finding file and each overlay wrapper requires its
own shard, even with `--files-per-shard` above one. Mixed or multi-file overlay
jobs are rejected. An explicit
CLI `--timeout`, `EVALS_SHARD_TIMEOUT_MS`, or API `timeoutMs` still wins for these
policies, including a lower cap; overlay overrides below their minimum are rejected.
Planner entries and execution results record the effective wall,
its source and policy identifier. Custom drivers must resolve each job instead
of passing their ordinary 1800-second default as an explicit cap;
their outer controller/detach wall must also cover the allocated work and cleanup.
The paid census counts are printed by `--list` for each tier.
`eval:bg:<pr|gate|periodic|release>` runs `scripts/eval-bg.ts`. On the local
backend its outer cap is ceil(1.5 × planned serial seconds / `EVALS_JOBS`) + 20
minutes, at most 4 hours, computed from `scripts/paid-test-durations.json` for
the lane's current plan (`--timeout SECS` overrides). On the dispatch backend the
CI job ceilings above bound the run, and the local follower stops after 4 hours.
`test/eval-detach-timeout-floor.test.ts` pins the cap formula, the 4-hour
ceiling, the backend choice, the sentinel on both backends, the conclusion
mapping and dispatch dedupe.

CI plans with `--slice-budget 420 --jobs 2` for the PR gate, the periodic census
and the weekly gate census (the gate census also `--skip-judges`), and
`--slice-budget 1 --jobs 1` (one file per runner) for marathon. The live plans
must fit their workflow's `max-parallel` so every slice starts at once, and every
per-slice ceiling must stay within 360 minutes; `test/evals-workflow-wiring.test.ts`
recomputes both from the complete census. Reconciliation rejects missing,
duplicated or misplaced registered work, absent budget records, case shards that
did not execute exactly their case, and reused results outside the PR profile.
Ordinary paid tiers and the default 1800-second shard wall remain unchanged; the
registered and overlay policies above supply exceptions, and unregistered
over-ceiling tests still fail policy checks.

Session timeouts are two-phase: a silent API dies at the startup grace (90s
local / 300s CI floor, distinct exit reason `timeout_startup`) and the work
budget arms on the first byte — the total wall never grows
(`test/session-runner-startup-grace.test.ts` pins the floor). A timed-out
session kills its whole detached process group (claude, codex, and gemini
runners alike — `test/session-runner-groupkill.test.ts`), so a stray
grandchild can't stretch a 600s budget past 1400s. And sync spawns can't
wedge a shard: every `spawnSync`/`execSync`/`execFileSync`/`Bun.spawnSync`
in the test trees must carry a `timeout`, enforced by
`test/spawnsync-timeout-tripwire.test.ts` with a shrink-only exemption
ratchet.

**Anchor-sliced `setup` harnesses.** `setup` is one large bash script, so the
free tests that pin its linker, cleanup, retired-skill prune, browser hint,
rebuild decision, and Chromium-bootstrap behavior never run the whole thing.
They slice the source by anchor (`extractFn(name)` takes
`name() {` through the next `\n}\n`; `test/setup-playwright-best-effort.test.ts`
slices the `# 2. Ensure Playwright's Chromium is available` block up to
`# 2b.`), join the extracted functions with stubbed collaborators, and execute
the REAL bash under a temp `HOME` with stubbed probes and installers. Two rules
keep the harness honest: renaming a function or anchor comment in `setup` fails
the test with `function not found` / `anchor not found` instead of silently
testing nothing, and `test/setup-link-ownership.test.ts` and
`test/setup-playwright-best-effort.test.ts` throw on any `command not found` on
stderr as harness drift (a helper the test forgot to extract) rather than
letting it degrade into a pass. Files: `test/setup-link-ownership.test.ts`,
`test/setup-cleanup-orphans.test.ts`, `test/setup-playwright-best-effort.test.ts`,
`test/setup-prune-stale-generated.test.ts` (`_prune_stale_generated` against a
temp render tree plus host dirs: host cleanup after the generator already
pruned, symlink targets survive, frontmatter-renamed skills, foreign links),
`test/setup-browser-hint.test.ts` (`_browser_hint` and the bootstrap summary
across Aside present/absent, bootstrap ok/failed/skipped, `GSTACK_SKIP_ASIDE`),
and `test/setup-needs-build.test.ts` (the `NEEDS_BUILD` block sliced between
two anchors: every binary and source set flips it, Windows `.exe` suffixes).
`test/relink.test.ts` shells out to a copy of the real `bin/gstack-relink`
against a temp `GSTACK_INSTALL_DIR` / `GSTACK_SKILLS_DIR`, and
`test/hook-scripts.test.ts` runs the real `careful/bin/check-careful.sh` and
`freeze/bin/check-freeze.sh` with JSON payloads on stdin (including the
`GSTACK_HOME` state-root parity against `bin/gstack-paths`).

### Pass-rate policy versions

Readers score only trials recorded under their own `EVAL_POLICY.version`.
Trials from an older policy are shown display-only. Trials from a newer policy
are ignored with a printed count ("ignored N trial(s) recorded under a policy
newer than vX"). When you see that line, run pass-rates from a checkout at or
after the commit that bumped the version. The supported rollback of a policy
change is reverting its writer commit; the reader-compatibility commit before it
stays.

### Harness version

Under `EVAL_POLICY` v2 a case's series identity is the bytes the case owns (its
paid test file, its fixtures and its skills' prompt files, including the
generated SKILL.md) plus `HARNESS_VERSION`, keyed with model, Claude CLI version
and policy version (`scripts/eval-trial-series.ts`). Each trial also records the
full consumed-input fingerprint as provenance. `scripts/harness-version.json`
pins every shared-harness file (`GLOBAL_TOUCHFILES` plus the session runners, the
PTY harness, the e2e gate and the LLM judge) by blob hash. When
`test/harness-version.test.ts` fails, run one of:

```bash
bun run scripts/bump-harness-version.ts --non-behavioral "<why no verdict can change>"  # no series reset
bun run scripts/bump-harness-version.ts --bump "<what behavior changed>"                # new series for every case
```

On a merge conflict in the manifest, take the higher version, then rerun the
script.

## Ubicloud VMs (`bun run test:ubicloud`)

`bun run test:ubicloud [test:free args]` runs the free suite on an ephemeral
Ubicloud VM instead of the local machine. It is the fast path from small dev
boxes, containers, and cloud sandboxes, and the way to record the duration seed
in the CI lane's environment. It needs `UBICLOUD_API_KEY` (a project token from
the Ubicloud console) plus `bash`, `curl`, `python3`, `ssh`, `ssh-keygen`, and
`tar` locally.

`scripts/ubicloud/ubi-runner.sh` creates the VM (`UBI_SIZE`, default
`standard-16`; `UBI_LOCATION`, default `eu-central-h1`) and streams the
checkout to it: tracked files, untracked files that are not ignored, and
`.git`, so uncommitted edits are tested. It then runs
`scripts/ubicloud/setup-free-suite.sh`, which mirrors the `free-suite` CI job
(same Bun pin, Playwright Chromium with its setuid sandbox helper, Xvfb,
poppler, emoji fonts, zsh for the bash+zsh portability arms (#2669), generated
host outputs, gate binaries, and the CSO helper), and runs `xvfb-run -a bun run test:free` with `GSTACK_EXPECT_BINARIES=1`
and `GSTACK_FREE_RETRY_FLAKY=1`. Shard logs are copied to
`.context/ubicloud/<timestamp>/`, and the VM is destroyed on every exit path.
The exit status is the suite's. `--diagnostic` instead runs /ship's free-shard
measurement (`scripts/ship-measure.ts free`, see [ship-measure](#ship-measure))
with `GSTACK_FREE_RETRY_FLAKY=0`.

A stock Ubuntu 24.04 VM differs from a GitHub-hosted runner in three ways that
the scripts correct: the login umask is `002` (group-writable directories fail
the CSO private-state checks), AppArmor blocks the unprivileged user
namespaces Chromium's sandbox needs, and `clang` and `python3-venv` are absent
(required by the Dia readiness and Python runner tests).

VMs are named `ubirun-<epoch>-<hex>`. Every new VM first destroys `ubirun-*`
VMs older than `UBI_GC_HOURS` (default 12), so an interrupted client cannot
leak one for long. For other commands, use the runner directly:
`scripts/ubicloud/ubi-runner.sh run --setup <script> -- '<command>'`, or its
`up` / `ssh` / `sync` / `pull` / `down` steps (`--help` lists them).

## Cloud sandboxes (Vercel / Conductor cloud workspaces)

Syscall-supervised sandboxes need environment setup before `bun run test` can
run green: run `scripts/sandbox-doctor.sh` once per boot. It documents and
treats the full failure taxonomy (missing /dev/fd, 64M /dev/shm, spurious
access(2) EACCES from the seccomp supervisor under load, full-capability
processes defeating chmod-denial tests, no X server, no git identity, and
Conductor's git-shim exit-code laundering). The doctor seeds `TMPDIR`,
`DISPLAY`, and the runner knobs into `~/.bashrc`, so open a new shell (or
`source ~/.bashrc`) before running the suite. Then:

```bash
setpriv --ambient-caps=-all --bounding-set=-all bun run test
```

Two runner knobs exist for these environments (both no-ops unless set):
`GSTACK_FREE_JOBS` overrides the shard count in either direction (2 is the measured sweet spot — one
serial mega-shard and 6-way sharding both saturate the per-process syscall
supervisor), and `GSTACK_FREE_RETRY_FLAKY=1` re-runs attributed failures once
serially, downgrading a clean retry to a loud FLAKY-PASS (capped at 5 files so
a broken tree can't masquerade as flaky). The required CI free lane and the
Windows lane set the retry knob too, appending every flaky pass to the JSONL ledger it uploads
(`GSTACK_FLAKE_LEDGER`) — a flaky pass never reds the lane, but it never
disappears either ([Flake ledger](#flake-ledger)).

## Test selection and tiers

Moved verbatim from CLAUDE.md (#2096 size limit).

**Diff-based test selection:** the sharded paid runner (`test:pr`, `eval:bg:pr`,
`test:gate:sharded`) selects tests based on `git diff` against the base branch.
Each test declares its file dependencies in `test/helpers/touchfiles.ts`. Changes
to global touchfiles (session-runner, eval-store, touchfiles.ts itself) trigger
all tests. Use `EVALS_ALL=1` to force all tests. Run `eval:select` to preview
which tests would run; it applies the PR profile by default, and
`--profile full` shows the plain touchfile selection. Commands by task: [CONTRIBUTING.md](../CONTRIBUTING.md#which-command-do-i-run).

**Two-tier system:** Tests are classified as `gate` or `periodic` in `E2E_TIERS`
(in `test/helpers/touchfiles.ts` — a facade over `touchfiles-data.ts` +
`test-selection.ts`). CI runs the changed fast PR profile and selected judges
per PR via evals.yml's sliced lane
(planner manifest → executors → fail-closed report; engine =
scripts/test-paid-shards.ts, the same runner as local eval:bg:pr); the free
suite runs on every PR via `.github/workflows/free-tests.yml` (a REQUIRED
check, secretless — fork PRs get real signal); ALL periodic tests run weekly
via evals-periodic.yml (EVALS_ALL, minus the reasoned exclusions in
`test/helpers/periodic-exclude-data.ts` — reason + tracking required per
entry), plus a weekly EVALS_ALL gate census. Use `EVALS_TIER=gate` or
`EVALS_TIER=periodic` to filter locally. When adding new E2E tests, classify them:
1. Safety guardrail or deterministic functional test? -> `gate`
2. Quality benchmark, Opus model test, or non-deterministic? -> `periodic`
3. Requires external service (Codex, Gemini)? -> `periodic`

Tier declarations are enforced by `test/e2e-tier-alignment.test.ts` (free, runs
in `bun test`): a `skill-e2e-*` file named in a touchfiles dep list whose
`EVALS_TIER` self-gate disagrees with its declared tier in `E2E_TIERS` fails the
suite. Files not named in any dep list are reported, not enforced — keep both
in sync.

### PR paid lane fallback

PR selection (`scripts/test-pr-profile.ts`) classifies every changed file. A file
mapped by a paid case's touchfiles selects that case. These files are exempt and
select nothing: docs, any non-paid `*.test.ts(x)`, `FREE_ONLY_PR_FILES` (the
free and paid duration seeds, `scripts/ubicloud/**`, every workflow that runs no
paid evals, and free-only tools), and the fixtures in `FREE_FIXTURES`
(`test/helpers/free-fixtures-data.ts`, each fixture with its free consumers).
`PAID_WORKFLOW_FILES` (`evals.yml`, `evals-periodic.yml`, `evals-marathon.yml`)
and any other unknown file restore the full gate (`prCoverage.mode =
full-fallback`). The job summary and PR comment list each file that caused a
fallback with one of three labels:

- **needs touchfile entry**: a paid test, helper or fixture no case maps; add it
  to the owning case in `E2E_TOUCHFILES` (`test/helpers/touchfiles-data.ts`).
- **add to FREE_ONLY_PR_FILES**: a file only free lanes read; add it to the list
  in `scripts/test-pr-profile.ts` (or a fixture to `FREE_FIXTURES`).
- **real unknown dependency**: shared code (bin/, lib/, resolvers, hosts, setup)
  whose dependents are not mapped; the full gate is the correct result.

`test/free-fixtures.test.ts` holds the inventory: each `test/fixtures/**` path
belongs to a paid touchfile or `FREE_FIXTURES`, and each workflow to the paid or
free-only list. Editing a paid test file runs its own gate cases on the PR when
their Bun test is named by the case id; the file's other cases stay deferred with
a reason that says to name the test by its case id.

### PR receipts, recovery and debounce

Passes and failures of single-trial shards are written as receipts at the
execution boundary, so a cancelled run's finished work survives. The
`recover-receipts` job runs `scripts/recover-receipts.ts` from the base ref with
`actions: read`: it merges the receipts of at most 5 completed, cancelled
`evals.yml` runs of the same PR (oldest first, negatives before passes, so a newer
FAIL blocks an older PASS) and hands the store to `plan-slices`, which keeps
`contents: read` only. Its `recovery.json` checkpoint never advances past an
unresolved run. `plan-slices` turns reuse off when recovery degraded, the
checkpoint is missing or a cancelled run is still unresolved; recovery itself
never fails the run, and the job summary names the reason (rate limit with its
reset time, `gh auth status`, the 60-second budget). The whole store is saved by
`slices-report`.

On a `synchronize` push, when another run for the same PR started in the last 15
minutes, the debounce job waits 90 seconds before planning; a run that outlives
the wait reports "superseded by <sha>". PR labels: `evals-no-debounce` skips the
wait and `evals-fresh` turns receipt reuse off. Labels apply from the next push,
because adding a label does not start `evals.yml`.

## Free suite runner, judge reuse and engine skips

Moved verbatim from CLAUDE.md (#2096 size limit).

`bun run test` routes through `scripts/test-free-shards.ts` (N concurrent
shard processes, serial within each, packed by recorded per-file durations
when `scripts/free-test-durations.json` exists — refresh it with
`bun run test:ubicloud --record-durations`; strict-output classification per
shard: a shard without bun's terminal summary line FAILS — silent truncation
cannot report green). `TREE_MUTATING` lists the files that still run in their
own trailing serial shard (today only `test/bootstrap-retention.test.ts`, for
host-wide procfs visibility); gen-skill-docs tests no longer need it (main()
guard, and `--out-dir` renders every host into mkdtemps — see
docs/TESTING_INTERNALS.md). Never type bare `bun test` for the suite: it
walks the whole repo, loading paid eval files and missing the strict
classifier.
It covers skill validation, gen-skill-docs quality checks, browse
integration tests, the Aside contract pins, and the render-wrapper pins.
`bun run test:pr` runs the selected short live behaviors and quality judges.
It reports deferred broad coverage; unknown dependencies restore the full gate,
and an unmapped prompt without registered coverage blocks planning. Full free
acceptance and required PR checks must pass before publishing. CI can reuse the
16 workflow-judge passes for 24 hours when their complete consumed inputs and
runtime match; records preserve original provenance. The cookie workflow's custom
input, the other 11 judge cases, dynamic agent tests, and local runs without
scoped cache configuration stay fresh.
Scheduled/manual full coverage and `test:release` always run fresh.
See [testing policy](CONTRIBUTING.md#test-tiers) for commands and measured targets.
Anything that needs Aside
itself (`test/skill-e2e-aside.test.ts`, the Aside qa/design E2E cases, the
live render in `test/aside-render.test.ts`) runs only on a Mac with the Aside
app open and self-skips elsewhere (`asideAvailable()`). make-pdf's render
gates and `test/skill-e2e-diagram.test.ts` run through whichever engine
resolves (`browserAvailable()` — Aside, or the browse binary CI builds with
`bun run build:gates`) and skip only when neither exists; the fallback
engine's own tests run everywhere.

### Real-home tripwire

No free test may write the developer's real home. `scripts/lib/free-home-guard.ts`
snapshots `~/.gstack`, `~/.claude`, `~/.codex`, `~/.agents` and `~/.config/gstack`
(live session logs excluded) and fails the run when an entry changes.

- A shard that runs alone (`--shard`, CI, the exclusive host-state shard, the
  flaky retry) owns its window, so the failure names its files.
- Full-suite shards run concurrently on one HOME and cannot tell whose write a
  change was. The runner guards that whole phase once and names no shard.
- `bun run scripts/test-free-shards.ts --attribute-home` names the writer: it
  runs every file alone with a private HOME (browser cache and git identity
  still come from the real home) and reports each file that wrote a watched
  surface. The retained shard directory keeps the written files as evidence.

Fix a writer with `usePrivateStateRoot()` (`test/helpers/private-state-root.ts`)
or a child HOME/GSTACK_HOME, and resolve product state paths at write time,
never at import.

### Flake ledger

`GSTACK_FREE_RETRY_FLAKY=1` reruns a failing free test file once, serially. A
clean retry turns the shard green as a flaky pass and appends an entry to that
shard's flake ledger, uploaded as `flake-ledger-<shard>` (90-day retention). The
Monday "Weekly test health" workflow (`bun run test:health --enforce`) reads
main's ledgers through `scripts/lib/ci-history.ts` and fails when a file flakes
in more than 5% of main free-tests runs over a window of at least 20 runs; a
window thinner than 20 runs in the last 7 days widens to the newest 20 runs, and
fewer than 20 runs is report-only. `bun run test:health flake-summary <dir>`
prints a run's ledgers as a table. A flaky file is fixed at source; the retry
never masks it. `bun run eval:pass-rates` lists only the local ledger
(`flakeLedgerPath()`, overridden by `GSTACK_FLAKE_LEDGER`).

The aggregate job of `free-tests.yml` downloads every `flake-ledger-*` artifact
of the run and appends `bun run scripts/test-health-report.ts flake-summary <dir>`
to its job summary. The Windows lane uploads `flake-ledger-windows-<shard>`.

Free-suite flake rules:

- Bun gives a child `stdio: 'pipe'` a unix socketpair. A test that must hold a
  write blocked uses a FIFO the test never reads (`test/qa-evidence.test.ts`,
  `test/qa-deadline.test.ts`), not a paused child stream: socket capacity follows
  `net.core.{w,r}mem_default` and the parent's reader.
- A test that rewrites CI provenance variables (`CI`, `GITHUB_*`, `CI_*`)
  restores them. Free shards run many files in one process, and a later browse
  daemon without `CI=true` launches Chromium sandboxed.
- Handshakes with a runner wait for the runner's own observable effect (its
  progress line, a coalesced read count), not for a fixture side file or a timer.

### Free suite duration seed

`scripts/free-test-durations.json` drives shard packing; files missing from it
pack at the seed's 99th percentile. Acceptable seeds come from
`bun run test:ubicloud --record-durations` (each file timed in its own child on a
VM with the CI lane's environment) or a CI recording. A 4-core laptop or
small-sandbox recording is not acceptable: browser and display tests skip or slow
down there, so the seed misstates them.

- `--ci-plan` warns in the job summary, with the refresh command, when more than 5
  files are unseeded; it never fails a PR. `--ci-verify` lists shards that ran
  longer than 1.5× their prediction and at least 30 seconds over.
- The weekly test-health run fails its enforced `unseeded-free-files` check
  ("stale seed: N unseeded file(s) > 5") when more than 5 free test files are
  missing from the seed, so contributors without Ubicloud access learn within a
  week that it needs a refresh.
- `test/free-seed-ratchet.test.ts` (run with full history in `free-tests.yml`'s
  `free-plan` job, `GSTACK_FREE_SEED_BASE=$(git merge-base HEAD origin/main)`)
  fails when a seeded file over 60 seconds is missing from
  `scripts/free-test-seed-allowlist.json`, when an allowlist entry is stale (gone,
  or no longer over 60 seconds), or when an entry is added relative to the
  merge-base copy without a `todo`. An annotated exception is
  `{file, reason, todo}` and the test prints it. A merge-base without the
  allowlist file counts as the first allowlist. Fix a failure by splitting the
  file, then rerun `bun run test:ubicloud --record-durations`.

### Windows free lane

`windows-free-tests.yml` plans on Linux (`--windows-only --ci-plan --shards 6`),
runs one strict serial shard per `windows-latest` job
(`bun run test:windows --ci-run`), and verifies every shard receipt on Linux
(`--windows-only --ci-verify`). Packing uses Windows-measured durations from
`scripts/free-test-durations-windows.json`; refresh them with
`gh workflow run windows-free-tests.yml --ref <branch> -f record_durations=true`,
then download the `free-test-durations-windows` artifact and commit it.

Curation lives in `scripts/lib/windows-curation.ts`. Every Windows plan and
`--list` prints the curated count and the top exclusion reasons (also in the job
summary). Files a probe proved safe despite a `/tmp` literal are force-included
(`WINDOWS_PROBE_SAFE`). `test/windows-native-workflows.test.ts` holds
`WINDOWS_CURATED_FLOOR`; when Windows-safe tests are deleted on purpose, lower it
in the same PR with a reason.

Native qualification campaigns (Windows cookie extraction, Windows launch
diagnostics, Dia on macOS) run only on dispatch of `native-qualification.yml`:

```bash
gh workflow run native-qualification.yml --ref <branch> -f mode=<cookie-native|windows-native-diagnostics|dia-native|dia-launch-comparison|dia-gui-readiness>
```

### Real-setup install fixture

Tests that run the real `setup` use `test/helpers/install-fixture.ts`. Each test
file builds one read-only seed checkout and clones it per test with
copy-on-write file copies (plain copy fallback), never hard links. Writes go
through `put`, `setVersion` and the `fixture*Sync` helpers; files register
`afterEach(cleanupFixtures)` and `afterAll(cleanupSeed)`.
`test/install-fixture.test.ts` is the isolation tripwire: writes in one clone
leave the seed and sibling clones unchanged.

### Test-only timing knobs

Defaults are the product's; tests shrink them instead of waiting real time:
`GSTACK_RENDER_SLACK_MS` (`lib/aside-render.ts`, default 10000),
`GSTACK_MEMORABLE_LOCK_TRIES` (`bin/gstack-memorable`, default 50 tries of 0.1 s),
the `recordGraceMs` option of `test/helpers/office-hours-attempt.ts` (default
5000) and the `timeoutMs` argument of `clearCookieTargetStorage(page, origin,
timeoutMs)` (default 15000).

## Running evals as an agent: detach

Moved verbatim from CLAUDE.md (#2096 size limit). The short rule stays in
CLAUDE.md; this is the full mechanism.

When **you (an agent/harness)** launch a long eval/benchmark run, run it through
`bin/gstack-detach` — NEVER as a plain backgrounded Bash task. A plain background
task lives in the harness's process group, so a SIGTERM ("polite quit") on a turn
boundary, a stopped Monitor, or an interruption kills the run mid-flight (observed:
`script "test:gate" was terminated by signal SIGTERM` ~40 min into a run of the
since-retired single-process runner). On macOS
the run can also die to idle-sleep. `gstack-detach` fixes both: a fresh session
(escapes the group SIGTERM) wrapped in `caffeinate -i` (blocks idle-sleep).

- Use `bun run eval:bg:<pr|gate|periodic|release>` (`scripts/eval-bg.ts`). It
  prints `[eval-bg] backend=<dispatch|local> …` and `gstack-detach LOG <path>` and
  returns at once. Both backends run under `gstack-detach` with the machine-wide
  `gstack-evals` lock (concurrent worktrees serialize instead of saturating the
  shared model API) and a **run-scoped** log under `~/.gstack-dev/eval-runs/`
  whose first line names the backend, the run and the tested revision.
  - **Dispatch** (default when HEAD is clean and equal to its pushed branch on
    `garrytan/gstack`, checked with `gh api`, and `gh` can dispatch): `pr` and
    `gate` dispatch `evals.yml` (`evals_all=false` with `base_ref`/`base_sha` for
    `pr`, `evals_all=true` for `gate`), `periodic` dispatches `evals-periodic.yml`,
    `release` dispatches both. Every dispatch passes `expected_sha` (the workflow
    fails fast when the checked-out revision differs) and a `nonce` that appears
    in the run name (`E2E Evals [eval-bg <nonce>]`), which is how the log finds
    and follows its run. A queued, running or green dispatch with the same
    revision and inputs is followed instead of dispatched again. Dispatched runs
    are validation runs: fresh and never writing PR receipts, except that a `pr`
    dispatch on a branch with an open same-repo PR passes `pr_receipts=<PR>` and
    reads that PR's receipts read-only.
  - **Local** (dirty tree, unpushed commits, a fork, no `gh`, or `--local` /
    `GSTACK_EVAL_BG_MODE=local`): the sharded paid runner
    (`scripts/test-paid-shards.ts`) on this machine, capped at
    ceil(1.5 × planned serial seconds / `EVALS_JOBS`) + 20 minutes, at most 4 hours
    (`--timeout SECS` overrides). One Bun process per test file, an external
    wall-clock timeout that kills the shard's process GROUP (stray
    `claude`/`codex` grandchildren included), a per-shard
    `GSTACK_EVAL_DIR=<evalDir>/shards/<slug>/` honored by the `EvalCollector`
    constructor, and an aggregate that separates failed vs timed-out vs
    never-started shards. `EVALS_JOBS` sets the shard process count (default 8,
    2 for `pr`); `EVALS_CONCURRENCY` is bun's --max-concurrency WITHIN a shard
    (default 2). Export `ANTHROPIC_API_KEY` first (never pass keys in argv).
  - `--dispatch` refuses with the fix ("commit and push, or rerun with --local")
    instead of falling back.
  `eval:list` / `eval:compare` / `eval:summary` / `eval:pass-rates` read the shard
  dirs too. For any other long agent job, call
  `gstack-detach [--lock NAME] [--timeout SECS] [--label LBL] -- <cmd>` directly.
- Then **poll the printed logfile** with a death-aware watcher: break on the
  guaranteed `### gstack-detach EXIT=<code> ###` sentinel (0 passed, 1 failed,
  130 cancelled, 2 other on both backends; silence is never mistaken for success).
  `bun run scripts/eval-bg.ts status <log-or-run-id>` reconnects and prints
  running, passed, failed, cancelled or incomplete (died without a sentinel). The detached run survives
  even if your watcher gets reaped, so re-checking the log always works. Keep
  checking until the sentinel appears or the user tells you to stop; a long run is
  expected, and a promise to check later is not a result. At each check, report
  which tests passed, which are still running, and any failures so far.
- Why the lock: a shared dev box with several Conductor worktrees will rate-limit
  the model API if two eval suites run at once (15-way concurrency each), which
  mass-times-out E2E tests. The lock makes the second run WAIT, not collide.
- Humans running `bun run test:pr` foreground in their own terminal don't need
  this — Ctrl-C is intended there. Detachment is for agent-launched runs only.
