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

**Interactive planning evidence.** Finding-count and autoplan-chain drivers use
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
reported separately. See [Overlay benchmark contract v2](OVERLAY_BENCHMARK_CONTRACT.md)
for exact correctness requirements, retired fanout cases, immutable evidence,
and the limits of a passing result.

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

**The renderer picks the same way, so the render gates are engine-agnostic.**
`/make-pdf`, `/diagram`, and design previews print and screenshot their local
HTML through `lib/aside-render.ts` / `bin/gstack-render.ts`, which render in
Aside when `probeAside()` says `READY` and through the browse engine otherwise.
make-pdf's `*-gate.test.ts` and `test/skill-e2e-diagram.test.ts` (periodic,
paid) gate on `browserAvailable()` (`make-pdf/test/e2e/browser-available.ts`:
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
classification per shard. Local defaults use the available CPU affinity,
floored at one and capped at six; `GSTACK_FREE_JOBS` remains an explicit override.
This does not change the separate CI machine count. Full-suite shards are packed by RECORDED PER-FILE
DURATIONS (LPT, `packShardsByDuration`) when the committed seed
`scripts/free-test-durations.json` exists — refresh it occasionally with
`bun run test:free --record-durations` (each file timed in its own child;
CI never records). Missing seed → silent hash-shard fallback; corrupt seed →
one warning + fallback; unknown files get 75th-percentile pessimism. Packed
shards get duration-aware walls (`max(base, predicted × 3, files × 5s)`). The
legacy `--shards N --shard i` path keeps stable hash indices. Required CI uses
one duration-packed `--ci-plan`, 20 isolated `--ci-run` machines, and a
`--ci-verify` aggregate. `TREE_MUTATING` is EMPTY:
`gen-skill-docs.ts` has a `main()` guard (imports never regenerate; pinned by
`test/gen-skill-docs-import-purity.test.ts`) and `--out-dir` renders every
host, so all former mutators render into mkdtemps and the trailing serial
shard is gone. The map remains a mechanism — a test that genuinely must write
shared artifacts in place earns a reasoned entry and is serialized again.

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
child that can't parse it recomputes locally with one warning). Retry parity
lives in `RETRY_OVERRIDES` (literals; old matrix rows' earned `retries: 2`).
Flake telemetry rides the store: every recorded test carries its 1-based
`attempt` (a pass-on-attempt-2 stays visible forever — bun's own stream hides
it), runs list `flaky_retries`, the report warns on passed-only-on-retry
tests, and `bun run eval:flake-rank` ranks the series (retried passes first,
then failure rate; 60-day recency bound on eval files; the free lane's flake
ledger is folded in from `flakeLedgerPath()` — override with
`GSTACK_FLAKE_LEDGER`, the same env var the CI free lane sets before
uploading the ledger as the `flake-ledger` artifact). Census integrity is
enforced from the free suite: every `E2E_TOUCHFILES` / `LLM_JUDGE_TOUCHFILES`
key must name a living paid test (`test/touchfiles.test.ts`'s reverse
invariant), and `git show <sha>:path` fixtures are banned — vendor the bytes
instead (`test/git-ref-fixture-tripwire.test.ts`).

**Fast PR profile and evidence reuse.** `test:pr` selects the changed cases in
`scripts/test-pr-profile.ts` plus every changed quality judge. `--profile full`
retains the broad census; no case IDs or tier assignments are removed. The plan
records both E2E and judge selections and lists deferred coverage. Executors
receive those selections separately and the report checks actual executed case
counts. Unknown source dependencies restore the broad gate; unmapped prompts
without registered coverage require full validation. Known broad-only prompt
changes are explicitly deferred, not counted as PR passes. Weekly/manual runs of
`evals-periodic.yml` execute both complete censuses fresh; manual `evals.yml`
runs the broad gate. This deliberately moves some defect detection later.

`scripts/eval-input-cache.ts` accepts only complete, clean, first-attempt passes
with matching before/after inputs. The audited workflow-judge adapter hashes the
actual expanded prompt, source/fixture/rubric/runner closure, installed SDK,
model parameters and runtime. Missing/unknown inputs force execution. Receipts
are scoped to the same repository and PR, expire after 24 hours, and contain
public scores and provenance rather than prompts or secrets. Only the 14 cases
using `runWorkflowJudge` are eligible; the other 11 quality cases remain fresh.
CI supplies the scoped cache/runtime configuration; local runs are fresh by
default. Cached scores must
pass current assertions; reused records retain their original source and time
and cannot renew the receipt. Dynamic live-agent runs are currently ineligible.
`EVALS_FRESH=1`, periodic and release validation bypass both lookup and publishing.

**Free test timing and isolation.** `test:quick` is an explicitly partial measured
subset for edit feedback. `test` remains complete local acceptance with its
bounded worker pool. The CI planner inventories every free file and packs them
using `scripts/free-test-durations.json`; each machine runs its assigned shard
serially. Plans and receipts bind the source revision, complete inventory and
strict outcomes; missing, duplicate or mismatched receipts fail the required
aggregate. The existing maximum five-file flaky retry allowance applies across
the entire lane, not separately to every machine. Refresh the full timing list
with `bun run test:free --record-durations`. Profiling records failures faithfully
and is separate from final release acceptance.

**CI planner/executor/report.** `--emit-plan <path> --slices K` computes
selection + the slice plan ONCE (killing per-slice selector divergence);
`--plan <path> --slice i` executors consume the manifest and write
slice-result artifacts; `--report <dir>` reconciles them FAIL-CLOSED (a slice
whose artifact never landed, or a planned shard nobody reported, is a
failure). Under `EVALS_ALL` the hollow-shard guard marks exit-0 shards with
ZERO executed tests `passed-empty` (a failure) — census-health, not just
test runs. evals.yml runs the sliced gate lane per PR — the ONLY paid lane
since the legacy 17-row matrix (22.6 min/$21 per PR serialized ahead of the
slices) was deleted after demonstrated parity; its
`KNOWN_MATRIX_GAPS`/`KNOWN_TIER_UNSET` ratchets retired with it and
`test/evals-workflow-wiring.test.ts` pins the surviving wiring (slice-count
agreement, tier consistency, the shared register-skills composite with its
fail-fast verification loop). evals-periodic.yml runs ALL
periodic-tier files weekly (the coverage contract) minus the reasoned
exclusions in `test/helpers/periodic-exclude-data.ts` (reason + tracking
required per entry; removal re-activates the file), plus a weekly
`EVALS_ALL` gate census, plus a tracking-issue UPSERT on red weeks. The CI
image pins the claude CLI to an exact version (`.github/docker/Dockerfile.ci`,
enforced by `test/ci-image-cli-pin.test.ts` — bumps ride PRs that run the PTY
gate), and every eval-store run records `claude --version`, resolved once in
the runner parent and handed to shard children as `GSTACK_CLAUDE_CLI_VERSION`
(never spawned on a test thread), so a TUI-drift flake hunt is a grep, not
archaeology.

**Timeout policy.** Paid tests use the tiers in
`test/helpers/eval-budgets.ts` (JUDGE/CAPTURE/CAPTURE_LONG/PTY/PTY_LONG);
`test/eval-budgets-policy.test.ts` pins that every tier fits the shard wall
minus overhead and ratchets raw literals. Budget above the wall is fiction.
The registered four-phase exception is `AUTOPLAN_CHAIN_BUDGET` for
`test/skill-e2e-autoplan-chain.test.ts`: 80 minutes of work (four `PTY_LONG`
allocations), an 84-minute session watchdog, an 85-minute Bun test deadline,
and a 172-minute supervised shard wall. The unchanged retry count of one
permits two 85-minute attempts plus two minutes for cleanup. This is a
**specified allocation for the stronger four-phase contract**, not a measured
calibration or statistical upper bound. The historical 900-second failures
remain failures. Models, fixtures, phase assertions and production review
caller timeouts are unchanged; this explicitly changes eval latency/cost policy.

The Autoplan chain explicitly enables native `PreToolUse` approval for edits to
its owned temporary review artifacts. Approval starts with the `/autoplan`
command and requires the exact parent session, prior successful file history,
and a current request digest. Other recorder callers remain observational.
A rejected artifact edit fails the test instead of falling through to terminal
permission input. Approval itself supplies no edit success or phase credit:
the native tool result and all four completed review phases are still required.

`FINDING_RETRY_BUDGETS` also registers six finding files. Each retains its
25-minute case deadline and one retry: the two-case CEO finding-count file has
a 102-minute shard wall, and the five single-case files have 52-minute walls,
including two minutes for cleanup. No per-case budget grows. Overlay wrappers
have a 1,830-second minimum shard wall and run without Bun retries; see the
[overlay contract](OVERLAY_BENCHMARK_CONTRACT.md) for their unchanged work budget.

The quality file reserves 6,400 seconds for all 25 cases and their existing
retry, plus cleanup. Each still has 120 seconds of model work. Its 14 workflow
judges own their deadline and abort signal, with five seconds for terminal
recording inside a ten-second Bun grace; the other 11 retain their existing
120-second Bun timeout. Late responses cannot create records or cache passes.

`resolvePaidShardBudget(files, overrideMs?)` is the canonical per-job resolver.
Autoplan, each registered finding file, and each overlay wrapper require their
own shard, even with `--files-per-shard` above one. Mixed or multi-file overlay
jobs are rejected so ordinary files retain their configured retries. An explicit
CLI `--timeout`, `EVALS_SHARD_TIMEOUT_MS`, or API `timeoutMs` still wins for these
policies, including a lower cap; overlay overrides below their minimum are rejected.
Planner entries and execution results record the effective wall,
its source and policy identifier. Custom drivers must resolve each job instead
of passing their ordinary 1800-second default as an explicit Autoplan cap;
their outer controller/detach wall must also cover the allocated work and cleanup.
`eval:bg:pr` and `eval:bg:periodic` have 72000/66000-second outer caps; the PR
wrapper covers a full-gate fallback at its default two workers. The broad gate
wrapper reserves 33600 seconds, and release reserves 100000 seconds for both
tiers. Legacy monolithic
`eval:bg`/`eval:bg:all` retain their shorter 5400/7200-second caps and do not
promise two complete Autoplan attempts; use the sharded periodic path for this policy.

Periodic CI plans `--slices 8 --autoplan-slice`: the eighth runs only Autoplan.
When overlays are selected, the seventh is reserved for their serial wrappers;
registered finding files are distributed across the remaining ordinary slices
by their supervised walls. Each slice job has a 355-minute cap; Autoplan retains
its 172-minute shard wall. Reconciliation rejects missing, duplicated or misplaced
registered work and absent budget records. The weekly gate census has a
350-minute cap and PR slices have a 220-minute cap. Free supervision tests
verify these bounds against the complete current census, configured retries,
and setup reserve. Ordinary paid tiers and the default 1800-second
shard wall remain unchanged; the registered and overlay policies above supply
exceptions, and unregistered over-ceiling tests still fail policy checks.

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
a broken tree can't masquerade as flaky). The required CI free lane sets the
retry knob too, appending every flaky pass to the JSONL ledger it uploads
(`GSTACK_FLAKE_LEDGER`) — a flaky pass never reds the lane, but it never
disappears either.
