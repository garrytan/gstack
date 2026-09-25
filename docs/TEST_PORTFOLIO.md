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
| Prompt clarity and rubric quality | The registered quality judge for that complete prompt | Tool execution, native acknowledgments or a finished report |
| Native first-question format and substance | Live SDK/PTY question capture | An answered question or a completed workflow; receipts explicitly say `workflowCompleted: false` |
| Stochastic consistency and verbose/carved comparison | Independent captures, with separate stability and A/B oracles | One successful sample reused as three trials, or one prompt version standing in for the other |
| Decisions, findings and report completion | Per-skill native workflow fixtures | The first question alone, screen text without native evidence, or a generic question count |
| Offline deployment and canary report construction | The explicitly simulated workflow fixtures | A real GitHub merge, deployment, rollback or production health check |
| Multi-phase ordering and hand-offs | One uninterrupted Autoplan chain | Four independent successful skill sessions |
| External reviewers, other model providers, browser engines and platform behavior | Their respective live integration fixtures | Prompt parity or a mock transport |

Overlay efficacy experiments retain their full fixture/model/arm/trial matrix.
Security cases retain their source, path, socket, process and lease identities.
These are distinct scenario dimensions, not repeated work to delete.

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
test/plan-count-quoted-frame-ak.test.ts
test/plan-count-truncated-question.test.ts
test/plan-count-preview-footer.test.ts
test/eng-test-plan-edit-approval.test.ts
```

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

## Remaining work, not claimed savings

Report final acceptance with the delivery revision and its actual case inventory.
Complete fresh gate/periodic and cross-platform performance comparisons are not
established by the measurements above.

The longest indivisible live workflow limits the benefit of extra workers.
Historical paid-duration replay suggests better scheduling alone cannot halve
the full lane. A follow-up should unify executable case ownership/counts before
sharing captures between judges or splitting long files: keep each oracle,
scenario, retry and independent-trial requirement explicit. The ordered
Autoplan chain, host integrations and security boundary cases must not be
replaced with cheaper look-alikes.
