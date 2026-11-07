# Test portfolio: coverage ownership and repeated work

Audit source: `06ed920a974809ebedc6bcbbe402fb81f5944598`, September 24, 2026.
This is a coverage inventory and a focused refactor, not a claim that every
test assertion is interchangeable with another assertion about the same skill.

## One owner for each kind of evidence

Tests can share setup or inspect the same public capture. They must not count
one capture twice when the contract requires independent trials. In particular,
free parser tests, a prompt-quality score, and a completed live workflow prove
different things even when they mention the same skill.

| Responsibility | Owner | What this evidence does not replace |
| --- | --- | --- |
| Selection, budgets, process ownership, cleanup, native-event parsing and recorded failure controls | Free runner and fixture regressions | A live model choosing or completing the right workflow |
| Generated files, host parity, section manifests and complete input identity | Free generation and structural tests | An agent actually loading the required section |
| Facts several skills must state alike (review-bot history paths, columns, record types, categories) | Free cross-file fact tests (`test/review-bot-history-facts.test.ts`) | An agent acting on those facts in a live run |
| Native first-question format and substance | Live SDK/PTY question capture | An answered question or a completed workflow; receipts explicitly say `workflowCompleted: false` |
| Stochastic consistency and verbose/carved comparison | Independent captures, with separate stability and A/B oracles | One successful sample reused as three trials, or one prompt version standing in for the other |
| Decisions, findings and report completion | Per-skill native workflow fixtures | The first question alone, screen text without native evidence, or a generic question count |
| Offline deployment and canary report construction | The explicitly simulated workflow fixtures | A real GitHub merge, deployment, rollback or production health check |
| Multi-phase ordering and hand-offs | The production phase-publication hook, pinned by the free `test/autoplan-publication-guard.test.ts`; no paid chain eval since the 2026-09 audit (TODOS: "No paid eval runs the full /autoplan chain") | A live model completing CEO → Design → DX → Eng |
| External reviewers, other model providers, browser engines and platform behavior | Their respective live integration fixtures | Prompt parity or a mock transport |

Overlay efficacy experiments retain their full fixture/model/arm/trial matrix.
Security cases retain their source, path, socket, process and lease identities.
These are distinct scenario dimensions, not repeated work to delete.

## Detector owner tests

A captured paid failure becomes one row (a `describe` block or table entry) in its detector's owner test,
never a new per-incident file; `test/test-of-test-ratchet.test.ts` enforces this. Owners after the
2026-09 audit ([evidence](test-audit-2026-09.md)):

| Detector | Owner test |
| --- | --- |
| `hasStaleFillRaceFinding` | `test/ceo-section-loading-fixture.test.ts` |
| `generateModelOverlay` / `resolveModel` (overlay phrases) | `test/model-overlays.test.ts` |
| `coverageAuditVerdict` / `coverageAuditReadEvidence` | `test/coverage-audit-evidence.test.ts` |
| Autoplan phase completion (`autoplanPhaseCompletions`) | `test/autoplan-phase-observer.test.ts` |
| `findNativeAutoDecision` and auto-decision state | `test/native-auto-decide.test.ts` |
| `claudeOutsideExecutions` | `test/outside-voice-evidence.test.ts` |
| `engStep0Boundary` / `engSetupAUQ` / `engFirstReviewAUQ` | `test/eng-first-review.test.ts` |
| `hasNativePlanTerminal` (completion and hand-off) | `test/plan-count-completion.test.ts` |
| `createPlanCountPermissionGuard` | `test/plan-count-file-permission.test.ts` |
| CEO mode option parsing (`ceo-mode-option`) | `test/ceo-mode-option.test.ts` |
| Plan scope selection (`plan-scope-selection`) | `test/plan-scope-selection.test.ts` |
| `planCountPrerequisitePick` | `test/plan-count-prerequisite.test.ts` |

## Functional QA contract map

The deterministic owners below protect the failure boundary; their live partners
prove that an agent follows it. A shared fixture or captured event does not replace
an independent live trial. All free owners run in `bun run test`; quick eligibility
depends on measured duration or an explicit `QUICK_CORE` entry, not this table.

| Contract | Deterministic owner | Necessary live boundary | Host and lane |
| --- | --- | --- | --- |
| CLI/API/webhook QA without browser setup | `qa-functional-fixture`, `qa-functional-evidence`, `qa-lazy-sections` | `skill-e2e-qa-functional`: CLI and webhook report sessions | Linux/macOS free; selected PR gate; Windows only where curated |
| Report-only preserves local and remote authority | `qa-only-capability`, `qa-functional-observer`, `qa-functional-observer-atomic`, `qa-caller-authority` | Independent report-only sessions with synthetic owned endpoints/auth | Linux kernel observation; free callback controls plus selected PR gate |
| Repair reproduces the defect, adds a failing regression and rechecks adjacent behavior | `qa-fix-loop-fixture`, `qa-functional-evidence` | `skill-e2e-qa-functional-fix`: CLI and webhook repair sessions | Free controls plus selected PR gate |
| Review and Ship actually explore | `qa-exploratory-callers`, `qa-caller-report-observer`, `qa-caller-review-plan`, `qa-checkpoint-evidence` | `skill-e2e-qa-callers`: actual Review/Ship callers | Free captures plus selected PR gate |
| Smoke expiry preserves required plan checks | `qa-deadline`, `qa-deadline-selection`, `qa-browser-deadline-evidence` | `ship-exploratory-plan-checks` | Free deadline/dispatch controls plus selected PR gate |
| Late changes invalidate affected results | `qa-caller-freshness-order`, `qa-deadline-publication-observer`, `shared-libs-revalidation-prompt` | `ship-exploratory-late-input` and the existing late-input documentation handoff | Free stale-input controls plus selected PR gate |
| Documentation completes before publication and respects protected files | `docsync-authority`, `docsync-atomic-writes`, `docsync-report-interface`, `docsync-lifecycle-interface` | `skill-e2e-ship-docsync`, `skill-e2e-docsync-spawned` | Free state/permission controls; registered gate/periodic scenarios retain their tiers |
| Cancellation drains owned work before another attempt | `shared-libs-cancellation`, `session-runner-stream-lifecycle`, `agent-sdk-runner`, `paid-shard-settlement` | Existing actual shared-library/SDK caller scenarios | Free real-callback/process controls; registered live gate/periodic trials remain independent |
| Missing tools or incomplete results never become verified coverage | `qa-probe-gates`, `qa-supervision-selection`, `test-free-shards`, `test-free-shards-capture`, `paid-shards` | `ship-exploratory-unavailable` and existing reporting-boundary sessions | Free negative controls plus selected PR gate; unsupported hosts remain unexecuted |

Names without a suffix refer to `test/<name>.test.ts`. Keep missing, stale,
duplicate, selected-but-unstarted, malformed/truncated and observer-overflow
controls distinct from legitimate empty selections. File restoration cannot
replace write observation, and a clean local tree cannot prove that an external
request made no mutation. Fixture endpoints and credentials must be synthetic
and owned; specifically authorized functional requests remain permitted.

Functional fixtures register their existing closed command policy as a native
PreToolUse hook, so an unsupported request is refused before execution. The
callback regression invokes the registered command with native hook input,
observes an isolated mutation target and permits the owned webhook positive
control. This is a command boundary, not a sandbox for arbitrary target code.
Its private CLI configuration is outside the observed product tree, and the
fixture's existing cleanup owns both directories.

Review/Ship observations now use the same strict native event decoder as QA
checkpoints and documentation. Caller-specific handoff/freshness interpretation
stays separate. Original missing, orphaned and duplicate-call controls were run
before replacing three incidental error-wording assertions with rejection checks;
the existing positive attribution case still runs, and a completed-ID reuse
negative control prevents incomplete evidence from becoming green.

## Complete inventory, not just the fast subset

At the audited revision, all 1,124 tracked Bun test files partition into 1,010 free
files and 114 paid files. The paid inventory contains 207 registered E2E
selection IDs (84 gate and 123 periodic) and 25 main quality-judge IDs. IDs,
files, model calls, samples, attempts and executed Bun tests are different
counts; use the run manifest and receipts rather than substituting one for
another.

The full gate and periodic manifests plan 153 file processes across 112 unique
files. Forty-one files appear in both manifests because they contain mixed-tier
cases; that does not establish 41 duplicated scenarios. Brain privacy and ship
idempotency have existing explicit exclusions, iOS needs hardware, and the spec
quality file contains a TODO. The iOS fixture's native Swift smoke test is
outside this Bun-file census and requires its platform runtime. Unavailable
or excluded work is not coverage.

Existing sources remain authoritative:

- `test/helpers/paid-test-set.ts` owns the free/paid file boundary.
- `test/helpers/touchfiles-data.ts` owns registered dependency and tier data.
- `scripts/test-pr-profile.ts` owns the deliberately partial PR profile.
- `test/helpers/eval-budgets.ts` owns supervision and retry exceptions.
- The free and paid shard runners own inventory, scheduling and reconciliation.

`test:quick` and `test:pr` are feedback lanes, not full release acceptance. This
refactor does not remove cases, shrink samples, change tiers, lower thresholds,
shorten production deadlines, or move checks to a later cadence.

## Repeated work removed

**Synthetic terminal startup.** The 42 fake-terminal scenarios in nine files
emit their existing readiness marker only after installing handlers. They no
longer spend the real CLI's eight-second grace waiting for an already-ready
fake. Native CLI grace, terminal geometry, observation delays, scenario inputs
and all existing assertions stay intact.

**Publication polling.** Invalid/unavailable-journal cases still call the real
hook and transcript reader through all 40 polling intervals. A scoped serial
fake clock removes wall-clock sleeping, while controls verify the full logical
deadline, late arrival, and restoration after success and failure. The real
delayed-journal and shell-transport cases still use real time.

**Native watchdog setup.** Compile the identical source once per test file and
copy the executable into each case's isolated directory. Every watchdog still
executes; only duplicate checks of the same compiler result are consolidated.
Mutable work directories and cleanup ownership are never pooled.

**Independent live captures.** Start all three consistency captures through the
existing three-query semaphore and both A/B arms concurrently. Await every
settlement before cleanup, retain sibling failures, and attempt cleanup for
every owned directory. Consistency judging remains sequential; A/B has at most
two simultaneous judges. The free regression exercises the actual registered
callbacks, native capture receipts, semaphore and judge request builder.

**Runner ownership.** Path normalization belongs to the existing shared strict
output utility, not the free runner. The paid runner no longer imports the free
runner to use it. Exact free-only exemptions cover the free runner and the free
AUQ replay worker, with paid import-closure and selection controls. Mapped
dependencies still win; unknown dependencies retain the broad fallback. No
directory-wide exemption is introduced.

**Local scheduling.** Default free workers use available CPU affinity, with a
floor of one and the existing cap of six. Each shard stays serial internally,
and explicit `GSTACK_FREE_JOBS` overrides keep their previous meaning. The
separate 20-machine CI plan is unchanged. Windows free-test CI explicitly retains
its two-worker budget rather than inheriting the local default; local worker
gains are not CI gains.

## Measurement contract

Compare original and edited code on the same machine, runtime, launch
environment and workload. Preserve failure and retry records. Count the full
case/sample inventory and report skips and unavailable platforms separately.
Do not subtract failures from elapsed time or use a smaller selection as proof
that the complete suite got faster.

### Functional-QA cleanup measurement — September 28, 2026

On the same four-CPU Linux machine, using Bun 1.4.0, Node 22.20.0 and Claude
Code 2.1.251, the existing duration recorder measured all 1,113 free files.
The refreshed seed selects 931 files for quick feedback: 90 newly included and
20 newly excluded by measured cost, a net increase of 70. No files remain
unclassified. All 182 slow files remain in the complete suite. The functional
command observer, checkpoint decoder and log-capture controls are explicit
quick-core cases; each measured under two seconds.

| Existing command / attempt | Executed scope | Result | Wall time |
| --- | --- | --- | ---: |
| `bun run test:free --record-durations` | 1,113 files | 29,175 pass, 5 fail, 131 skip | 680.64s |
| `bun run test:quick`, first measured attempt | 931 files | 22,160 pass, 2 fail, 100 skip | 125.39s |
| `bun run test:quick`, repaired attempt | The same 931 files | 22,162 pass, 0 fail, 100 skip | 52.43s |

The profile's five failures came from the machine's Git identity wrapper
overwriting synthetic fixture authors. Running the two affected files with native
Git in the isolated test environment passed all 59 tests in 75.32s; normal checkout
commits retained the configured identity. Both quick attempts used that corrected
environment. Their two telemetry timeouts used Bun's synchronous piped-input
path; the repair reuses the existing file-backed command capture helper without
changing commands, assertions or deadlines. The seed retains observed costs,
including failed attempts; it is a scheduling hint, not a passing receipt.

Cold dependency installation took 0.477s and the integrated build took 3.84s,
separate from warm test execution; CLI installation was not independently timed.
An earlier 63.37s profile was cancelled for a decoder repair, with an additional
scoped browser cleanup, and earns no completion credit. Failed, cancelled and
repair runs are costs, not time removed from the workflow. The quick target of
one minute was met on this machine, but these measurements establish neither a
cross-environment speedup nor full release, live-model or Windows acceptance.

### Earlier component comparisons

Measured component comparisons:

| Workload | Before | After | Coverage retained |
| --- | ---: | ---: | --- |
| Nine synthetic-terminal files, serial aggregate | 165.87s | 72.98s | 81 tests, 1,593 assertions, 42 PTY scenarios |
| Publication guard and watchdog files, serial aggregate | 56.57s | 9.63s | 245 original tests; three additional clock controls |
| Two live periodic AUQ files, same machine and runtime | 325.09s | 136.40s | Two tests, five independent captures, all original grading rules |

Exact selectors for the synthetic-terminal comparison:

```text
test/plan-count-fixture.test.ts
test/plan-count-design-ui-recovery.test.ts
test/plan-count-native-input.test.ts
test/plan-count-empty-review.test.ts
test/plan-count-owned-permission.test.ts
test/plan-count-file-permission.test.ts
test/plan-count-truncated-question.test.ts
test/plan-count-preview-footer.test.ts
test/eng-test-plan-edit-approval.test.ts
```

The quoted-frame selector was folded into `test/plan-count-file-permission.test.ts` in the 2026-09 audit.

The publication/watchdog pair is `test/autoplan-publication-guard.test.ts` and
`test/cso-watchdog.test.ts`. The live pair is
`test/skill-e2e-auq-consistency.test.ts` and
`test/skill-e2e-auq-verbose-vs-carved-ab.test.ts`, using the default three
consistency samples plus the two A/B captures.

These are separate comparisons; do not add their percentages or call them a
complete paid-suite result. The terminal aggregate is 56% faster, the two
publication/watchdog files are 83% faster, and the live AUQ pair is 58% faster.
Watchdog assertion counts fall only because identical compilation is checked
once; all behavioral and security assertions remain.

The matched complete local free-suite comparison used the same four-CPU Linux
machine, Bun 1.4.0, Node 24.18.0, built artifacts, display and isolated Git
configuration. Neither run set a worker override: the original default used two
workers and the changed default used four.

| Complete free-suite result | Original | Performance refactor |
| --- | ---: | ---: |
| Wall time | 887.82s | 413.78s |
| Passing cases | 25,504 | 25,547 |
| Failing cases | 0 | 0 |
| Skipped cases | 60 | 60 |
| Assertions | 199,132 | 200,351 |
| Test files | 1,010 | 1,012 |

This is a 53.4% local reduction. Case-level reconciliation retained every original
passing identity except the intentionally renamed worker-default policy test,
added 43 cases, and retained the exact same 60 skipped identities. This comparison
predates the additional fixture and deployment-workflow regression cases; final
acceptance must cover those too. It is not a measurement of the separate CI
matrix or the complete paid census.

The exact historical PR #2956 diff selected 84 gate IDs plus 25 judges because
the free runner was treated as an unknown paid dependency. Replaying that diff
after the boundary repair selects the intended 26 fast IDs plus the same 25
judges. A free-runner-only diff selects no paid work. That is routing accuracy,
not a fresh full-census runtime improvement.

## Evidence validity

After integrating main's September 28 Ubicloud improvements, the scheduling seed
uses upstream's CI-environment timings for shared files and preserves the 52
previously measured branch-only entries. These are scheduling hints from two
machines, not a matched performance comparison or acceptance result. Refresh
the whole seed with `bun run test:ubicloud --record-durations` when measuring a
new common baseline; do not infer a speedup by adding these measurements.

Check the executable actually used by each SDK, print-mode and terminal launcher.
A CLI version cached during preflight does not prove the version used by later
sessions if PATH contents change. Use native session-init versions, terminal
startup captures or process witnesses, and keep runtime controls effective after
the hermetic environment is constructed.

Captured-event regressions prove the validator accepts valid evidence and rejects
invalid evidence. They do not turn an old failed model run into a pass. Preserve
every configured retry attempt and distinguish actual registrations from filtered
or out-of-tier placeholders. A retained passing judge is reusable only when its
complete request, rubric, parameters and relevant dependencies match; native
behavioral acceptance follows its separate freshness contract.

## Paid cases of the retired standalone /plan-eng-review (GST-1698)

The skill's methodology still ships: `plan-eng-review/` is /autoplan's Phase 3
methodology source, bound into each run by the methodology snapshot. Cases that
check that methodology or Phase 3's required outputs stay. Cases that checked
the standalone interactive entry, which no longer ships, are retired. None was
quarantined: `CASE_QUARANTINE` holds flaky cases that keep running, and these
cases are not flaky, their entry point is gone.

| Case | Fate | Why, and what still proves the contract |
| --- | --- | --- |
| `plan-eng-review` (SDK) | kept | Runs the methodology source over a plan, the bytes Phase 3 loads. |
| `plan-eng-coverage-audit` (gate) | kept | Phase 3 must produce the codepath-to-test diagram; the case reads the same methodology and sections. |
| `plan-eng-review-artifact` (PTY checkpoint) | kept | Phase 3 must leave a test plan on disk; the case's Test review writes it from the same section. |
| `journey-plan-eng` | kept, retargeted | Architecture-review requests now route to /autoplan (#4108). |
| `plan-eng-multi-finding-batching` | retired, excluded | Checks one interactive question per finding; Phase 3 auto-decides findings. `PERIODIC_CI_EXCLUDE` stops its weekly run; deleting it with its counter helpers is a TODOS.md item. |
| `plan-eng-review-plan-mode` | retired, deleted | Standalone plan-mode handshake; the ceo, design and devex plan-mode cases and `plan-mode-no-op` keep the shared contract. |
| `plan-eng-finding-floor` | retired, deleted | Interactive first-finding question; the ceo, design and devex floors keep the shared floor. |
| `plan-eng-review-artifact-full` | retired, deleted | Fresh standalone marathon run; the checkpoint case keeps the artifact requirement. |
| `plan-eng-review-format-coverage`, `plan-eng-review-format-kind` | retired, deleted | Format of standalone questions; the ceo format cases keep the shared question format. |
| `carve-section-loading-plan-eng-review` | retired, deleted | Model-driven section loading on standalone entry; Phase 3 gets the methodology through the snapshot instead. |
| `auq-matrix-plan-eng-review`, the eng rows of `plan-mode-no-op` | retired rows | Standalone entry; the other skills' rows keep both files' contracts. |

## Remaining work, not claimed savings

Report final acceptance with the delivery revision and its actual case inventory.
Complete fresh gate/periodic and cross-platform performance comparisons are not
established by the measurements above.

The longest indivisible live workflow limits the benefit of extra workers.
Historical paid-duration replay suggests better scheduling alone cannot halve
the full lane. A follow-up should unify executable case ownership/counts before
sharing captures between judges or splitting long files: keep each oracle,
scenario, retry and independent-trial requirement explicit. Host integrations
and security boundary cases must not be replaced with cheaper look-alikes; the
retired Autoplan chain eval needs a replacement that fits the ordinary tiers.
