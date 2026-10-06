<!-- /autoplan restore point: "~/.gstack/projects/garrytan-gstack/garrytan-ship-measure-fix-loop-plan-autoplan-restore-20261006-184436.md" -->
# /ship measure-then-fix loop for a red paid eval (issue #3034, October 2026)

Status: plan, approved for the next wave by Garry ("yeah ok build it in the next wave"); reviewed by /autoplan (CEO, DX, Eng; design skipped, no UI); not implemented. One PR.

## Implementation plan

### What changes, in one paragraph

Today `/ship` stops at the first red paid eval (`ship/sections/tests.md.tmpl`, Step 6.3: "If any eval fails: Show failures and available costs, then **STOP**"), and whoever is driving improvises, usually by fixing something, pushing and rerunning the whole ~130-case gate (~$90, ~12 minutes) to learn one bit about one case. On PR #3033 that happened six times, with a different single red each time. After this PR, `/ship` runs a fixed loop on each red case alone: classify the red, prove any detector or fixture fix for free first, check without any model spend that a trial really selects the case, show the cost, measure the case 10 times in parallel on throwaway Ubicloud VMs inside the CI image, fix at the cause, measure again, and only then run the gate. The loop stops patching after 3 rounds on one case and rethinks the test instead; it caps gate runs per ship; and a case it cannot fix ends as a named red that stops the ship with a decision, never a quiet pass. Every measurement trial is labelled diagnostic and can never become a verdict or enter pass-rate history. The PR body gets one table row per red case and a line with the gate's predicted all-green chance.

### What success means

The loop exists to cut three numbers per ship, and the PR-body summary reports all three: full-gate executions, total paid spend (measurement plus gates), and wall time from the first red to a trustworthy lane verdict. It does not make an unchanged stochastic case more reliable: measuring only tells us which cases need a fix. The gate-level problem (about 130 verdicts, each a little noisy, so an all-green gate is unlikely even when every case is healthy: 26.8% at a 99% per-verdict rate, per `docs/TESTING_INTERNALS.md`) is shown on every ship and its root fix is named under "Next, not in this PR".

### Base and evidence

Base: origin/main `55f8151` (v1.91.30.0, #3033). The pieces the loop stands on already exist:

- `scripts/test-paid-shards.ts --case <id> [--trials N] [--list]` runs one E2E case through the CI panel runner (`runCaseDiagnosis()` in `scripts/lib/paid-report.ts`), and every red report line prints an "after a repair: ..." command (`afterRepairCommand()`), which for a standalone judge is a `bun test` with `EVALS_JUDGE_SELECTION_JSON` and an exact name filter.
- Failed trial records carry `failure_class`, `failure_cause`, `failure_cause_evidence` and `failure_detail` (`test/helpers/eval-store.ts`, `failureCauseOf()`), and `bun run eval:pass-rates --run <id> --case <id>` prints one red's values, history and transcript pointer; `eval:pass-rates --reds` prints the latest census's all-green probability.
- Detector replay corpora exist (`test/detector-corpus-*.test.ts`, `test/eng-batching-native-replay.test.ts`).
- The PR lane reuses verified first-attempt passes when every consumed input is byte-identical (`scripts/e2e-shard-reuse.ts`); a change to a global touchfile or the paid runner invalidates every receipt, which is why #3033's pushes reran the whole gate.
- `scripts/ubicloud/ubi-runner.sh` has `up | sync | ssh | pull | down | gc` and `--pass NAME` for secrets; the CI image is built from `.github/docker/Dockerfile.ci` and published as `ghcr.io/garrytan/gstack/ci`.

Gaps found while planning, each closed by this PR:

1. `--case` writes its shard records into the normal project eval dir (`getProjectEvalDir()`, `~/.gstack/projects/<slug>/evals`), which `eval:list`, `eval:compare` and `eval:summary` read as ordinary runs. Diagnostic trials are unlabelled today.
2. `--case --list` proves selection statically only. Both #3033 selector bugs (the CLI deadlocking when the library imported the running entry module, and a single-case file filtered by a test name that did not exist) passed static selection and failed only when a trial ran.
3. `--case` accepts only E2E ids (`test-paid-shards.ts:825`), so a red standalone judge has no single-case trial runner.
4. A case whose file registers only that case (`mode: 'file'`) runs its trials one after another (`paid-report.ts:93-100`), so 10 trials take 10 trial walls.
5. The repo copy of `ubi-runner.sh` destroys every `ubirun-*` VM older than 12 hours on each `up`, whoever owns it. The user-scope ubicloud skill's copy already tags VMs with `UBI_OWNER` and sweeps only the caller's VMs.
6. AGENTS.md (Validation discipline, item 7: "Rerun a failed case only after a concrete repair or a demonstrated launch correction") and TESTING_INTERNALS ("A red census is never rerun on unchanged inputs") forbid a measurement on unchanged inputs unless diagnostic measurement is carved out in writing.
7. `windows-free-tests.yml` can only be dispatched for the whole curated lane; there is no way to rerun one shard's exact file list.

### The loop, as /ship executes it

Step 6.3 becomes "If any eval fails: run the measure-then-fix loop below." The prose in the skill stays short: "run `gstack-eval-measure status`, do what its Next column says, and follow these rules". The mechanics live in one CLI, `bin/gstack-eval-measure` (resolved through the `runtime-root.ts` prelude like `gstack-detach`, so it works from any repository; `bun run eval:measure` is the alias inside gstack; source `scripts/eval-measure.ts`). Its `--help` works offline, lists every subcommand with one example, and says which values are deliberately not overridable (N, the bar, extend-once, mechanical `provider`) and why. Every step writes to one ledger, `.context/eval-repair/<branch-slug>.json` (`gstack-slug`'s sanitized branch, so `/` never nests), which is the single current failure list that AGENTS.md's Validation discipline item 1 asks for. The CLI refuses to write the ledger into a tracked or unignored path and prints the `.gitignore` line to add.

**Words.** A *trial* is one verdict-shaped run of the case (one judge panel for a judge, one session for a behavior case). A *batch* is N trials launched together. A *round* is one repair plus one fresh batch. A *loop* starts when `inventory` reads a new gate run's reds and ends when every red case reaches a terminal state; rounds count per loop, while gate runs and spend count per ship (per branch) and survive `reset --reason`, which archives a loop without deleting it. A *gate run* is one execution of the project's pre-merge eval command.

**Command contract.** `status`, `decide`, `collect` and `start` take `--json` and return `{loop_id, cases: [{case, state, blockers, next}], spend, reserve, caps}`. Exit codes: 0 done or MEETS, 10 running, 20 BELOW or EXTEND (a diagnostic red, not a broken tool), 30 needs input (an approval or a classification), 40 refused (with a reason code), 50 infrastructure failure, lost or void batch, 2 usage. Every refusal prints a stable reason code, the problem, its cause, the exact next command and a `docs/troubleshooting.md` anchor, following the `lib/gate-outcomes.ts` pattern; tests pin the codes.

| Subcommand | What it records or does |
|---|---|
| `doctor` | backend credentials, Ubicloud quota (`usage`), CI image tag resolution, model keys, `gh` auth; prints the backend it will use and why. Runs implicitly first in `start`. |
| `inventory [--run <id> \| --dir <eval dir> \| --cases a,b]` | with no argument, reads the pointer Step 6.2 writes after every gate run (`.context/eval-repair/<branch-slug>.last-gate.json`: CI run id or local eval dir); `--run` for a CI run, `--dir` for a local run, `--cases` for an adapter project. Opens a loop. Each red becomes a target of one kind: *case* (measurable), *file* (a keyless file or an id several files register, measured by file), or *run* (a missing slice artifact, an unattributed module-load error, an INFRA-only census), which is never measured: it routes to the existing INFRA re-dispatch rule or to a free fix of the load error. |
| `classify --trial <batch>/<n> --route <r> --tag <t> --evidence <path:line>` | one immutable record per failed trial (a later record supersedes, never edits); the case's route is the summary of its trials; refuses `provider` unless `failure_cause` and its evidence say so |
| `proof --case <id> --test <file> [--negatives <dir>] [--contract <file>]` | runs the free check twice itself: on the pre-fix snapshot (must fail on the capture) and on the current snapshot (must pass and still reject every negative), recording both tree hashes; `--contract` records the contract mapping |
| `probe --case <id>` | the selection probe below |
| `start --case <id> [--backend ubicloud\|local] [--size S] [--image ref \| --build-image] [--dry-run]` | doctor, pre-registration, launch; idempotent per batch id (a repeat returns the running batch); `--dry-run` prints the plan, estimate and VM size without creating anything |
| `collect [--case <id>]` | before completion: "running, k/N done, next check ~HH:MM PT" with exit 10; after: pulls, decides, destroys |
| `decide --case <id>` | applies the bar to the case's batches |
| `note --case <id> --scope … --design … --budget …` | the stop rule's re-evaluation note |
| `gate` | the only way the loop pushes: reserves the gate's estimate, pushes, adopts the one run for the head SHA (see Gate), records it and inventories its reds |
| `approve --cap batch\|case\|ship\|gate --usd N --question <ref>` | records the approval, the question it answered and the time; like the ledger hashes, a tripwire against accidental edits, not proof of who answered (the PR table is the audit trail) |
| `status`, `table`, `cancel`, `reset --reason`, `demo` | state with a Next column; the PR-body table; cancel and destroy; archive a loop; the credential-free demo |

1. **Inventory.** `gstack-eval-measure inventory` writes one row per red verdict: case id, kind, run id, source SHA, `failure_class`, `failure_cause`, evidence and Expected/Received (from `eval:pass-rates --run <id>` for CI runs, the eval store for local runs). It reconciles the runner's red count with the named reds and any module-load errors, sorts each red into a case, file or run target, and prints the gate's predicted all-green probability (see the PR-body report). Without `gh` auth it says exactly that and how to fix it.
2. **Classify each red** into one route (table below) with a fine-grained tag and a diagnosis that cites evidence. `provider` is assigned mechanically, only when `failure_cause` is `api_error`, or `pre_turn_infra` with provider or transport evidence (an HTTP 429 or 5xx, a connection reset); the agent cannot choose it. A `pre_turn_infra` without that evidence (a crash or module-load failure) is a harness defect. A `refusal` is not mechanical: it usually means the fixture or prompt invites it, so it is classified with a citation like any other red. A red with `failure_cause: unknown` or no readable capture is `unclassified` and is measured before anything is fixed.
3. **Free proof first.** If the route is fix-test-infra, write or extend a free check from the captured events and record it with `proof`: it must fail on the captured red, pass after the fix, and still reject every known-bad example (see "Repairs must not weaken the test"). No paid trial runs for that case until this step is green.
4. **Selection probe (no model spend).** `gstack-eval-measure probe --case <id>` runs one trial through the exact CLI path the paid trial will use, with every provider endpoint pointed at a closed local port, an invalid key, and `GSTACK_EVAL_CLIENT_RETRIES=0`, a new override the SDK runner (default 3 retries), the PTY and Codex launchers and `llm-judge.ts`'s retry loop honor. Session-ledger rows are written when a session ends, too late to stop on, so each of the four runners (claude-p, Agent SDK, PTY, Codex) and the judge caller gains one line, written only when `GSTACK_PROBE_FILE` is set, recording `{test_name, runner}` the moment it is about to send its first model request. The probe passes when the started tests match the case's selection mode (name mode: exactly one test, mapping to `<id>` through `caseIdForTestName()`; file mode: at least one test, all from the case's file, none from another file), every started test reached a probe line, and no other test ran; the probe then stops the process group. It fails at a wall of 120 seconds or the case's recorded setup time plus 60 seconds, whichever is larger (injectable for tests). Each failure mode has its own reason code; a missing local tool (Bun, the Claude CLI) is a setup failure with a remedy, and only a selection failure is a harness defect to fix before spending. The same probe runs first on the VM before its trials, so a remote environment problem stops the batch before any model call (the VM's own minutes are billed and shown). An adapter without a probe records "probe unavailable", and its first batch's selection is the check: a batch with 0 or mismatched trial results is void and is not a round.
5. **Pre-register and estimate.** Before any result exists, the ledger records per case and batch: N, the bar that will decide it, the input identity, the estimate and the caps (see Cost guard), with a schema version and a hash of each pre-registered block. The CLI prints the estimate and continues without asking when it is under the caps. A pre-registered field edited outside the CLI is refused ("ledger edited outside gstack-eval-measure: field X"), and a lock (pid, host, start time) stops two sessions writing one ledger; a lock whose pid is dead or older than its TTL is reclaimed and the reclaim shows in `status`.
6. **Measure.** Baseline batch on the current head: N trials in parallel on detached Ubicloud VMs (see Infrastructure). `start` first freezes the source: a temporary index (`GIT_INDEX_FILE`) takes `git add -A` of the working tree, `git write-tree` gives one tree hash covering tracked, untracked-unignored and deleted files, and that tree, not the live directory, is what gets measured and identified. Each VM receives `git archive` of the tree into a fresh repository with that tree committed, so linked worktrees work and half-finished edits to other cases never ride along; local trials check out the same tree into a temporary worktree. The baseline is skipped only when step 3 reproduced the red deterministically from captured events; the ledger then records "before: reproduced by replay, 0 paid trials". `start` prints the deadline in PT and a suggested wake time; the skill prose names the host's wait (a Capy `wait` timer, or polling the `gstack-detach` sentinel on Claude Code and Codex).
7. **Decide** with the measurement bar and its precedence rules: MEETS, EXTEND (N more on identical inputs, pooled, once), fix round, or BELOW. A batch below strict whose failed trials nobody has classified returns *needs-classify* (exit 30) with Next "classify t2, t6, t9, then decide"; EXTEND is possible only after every failure has a route or is marked unclassified after review. The VM-side runner applies the early-stop rule itself (the pure `measure-bar.ts` is synced with the tree) and cancels remaining trials once the outcome is certain; an early-stopped batch has its own state, never confused with a void one.
8. **Fix round.** Fix at the cause, rerun its free proof, rerun the probe if the trial path changed, then measure a fresh batch. A fix changes the case's inputs, so the new batch starts a new pool; trials never pool across a fix. Never raise a budget, lower a threshold, change a kind or add a verdict retry to reach the bar.
9. **Stop rule.** After 3 fix rounds on one case without MEETS, stop patching and re-evaluate (see Stop rule).
10. **Gate.** When every case that went red MEETS, `gstack-eval-measure gate` runs exactly one gate for the new head SHA and is the only way the loop pushes. With an open PR on gstack, the push itself starts `evals.yml` (`pull_request`, with its verified-pass reuse), and `gate` adopts that run; it never also calls `eval:bg:pr`, whose duplicate check matches only dispatches, so that pairing would buy two gates. With no PR yet, `gate` dispatches through `eval:bg:pr` or runs the project's command locally under `gstack-detach`, as Step 6.2 does. It reserves the gate's estimate before pushing, and it reads every `evals.yml` run for the branch's head SHAs from `gh`, so a gate started any other way is counted too. The red gate that opened the loop is gate 1. That run's verdicts are the lane verdict for Step 6. Later `/ship` pushes (review fixes, VERSION, CHANGELOG) follow Step 16's existing evidence rules and also go through `gate` when the loop is open. A new red starts the loop for that case. A red on a case the loop already brought to MEETS is re-measured on the gate's inputs before any fix; it counts as a round only when a fix follows. At most 3 gate runs per ship, counting gate 1 and surviving `reset`; a fourth needs Garry (see Terminal states).
11. **Report.** `gstack-eval-measure table` writes the PR-body table, the three success numbers and Step 19's evidence record.

**Interrupted work.** Every operation is keyed by loop and batch id and is safe to repeat. A coordinator that slept, lost its connection or restarted runs `status`, which shows each running batch with its VM, deadline, reserved spend and the exact recovery command. A batch whose sentinel never arrives by its deadline, whose VM vanished, or whose results could not be pulled is *lost*: it is not a round, its estimate stays counted as spend, and it may be re-dispatched once. On the VM, each batch packs its results into one archive with a manifest (expected trial count, every file's hash); `collect` pulls it, checks the manifest, retries once after 60 seconds, and only then destroys the VM, recording "captures lost" if both pulls failed. `ubi-runner.sh down` today runs `destroy && log` and then deletes its local state unconditionally, so a failed destroy looks like success and loses the SSH key; the port keeps state until Ubicloud confirms the VM is gone and treats an already-absent VM as done, and `pull` reports "nothing matched" as a failure to the CLI. Runner state lives under `$GSTACK_STATE_ROOT/ubicloud/`, and every `status` and `start` destroys this owner's VMs that are past their recorded deadline plus 30 minutes and deletes stale `measure/*` scratch refs. `status` shows lost, void and early-stopped batches distinctly.

**Credential-free demo.** `gstack-eval-measure demo` runs the paid E2E's seeded fixture locally with no keys and no VM: inventory, probe, a 10-trial baseline at 7/10, the prepared fix, 10/10, and the table, in under two minutes with the expected output printed. It is the five-minute introduction for a new maintainer and a free test of the whole command sequence.

Free-test reds (Step 5) use the same loop; see Free-suite flakes.

```
red verdict(s) ──> inventory ──> classify ──┬─ fix-test-infra ─> free proof ─┐
                                            ├─ unclassified ─────────────────┤
                                            ├─ fix-product / runtime / cut ──┤
                                            └─ qualifies (provider, ...) ────┤
                                                                             v
            probe (no model spend; local, then VM) ─> estimate ─> measure batch (N, diagnostic)
                                                               │
                         ┌──────────── EXTEND (once, pooled) <─┤
                         v                                     │
                       decide ──BELOW──> fix round (≤3, then re-evaluate, ≤1 reset) ─┐
                         │                                                          │
                       MEETS                     named red <── second exhaustion <──┘
                         │                           │
                 all reds MEET? ── yes ─> gate (≤3 per ship) ─> GREEN ─> report
                                                     │            
                                                    RED ──> new case: loop again
                       named red ──> STOP: needs-decision (waive | quarantine proposal | revert)
```

### Routes and classification

Six routes decide what happens; the fine tag is evidence for the ledger and the PR table.

| Route | Fine tags | How it is recognised | What the loop does | Free proof before paid trials | Can count toward the 8/10 bar |
|---|---|---|---|---|---|
| fix-product | `product`, `contract` | the case passes on base and fails on head, or evidence points at changed product code (CLAUDE.md blame protocol); `failure_cause: contract` | fix the product | the free test that pins the behavior or contract | no: a regression |
| fix-test-infra | `detector`, `test-assertion`, `grader`, `fixture` | correct behavior, wrong verdict: a progress detector matched only exact wording (plan-ceo-split-overflow); a regex lacked "authenticity" (cso-diff-mode); a grader prompt mis-scored good output (office-hours preservation judge); a wrong fixture or scripted actor | fix the evaluator at the cause | replay over captured events plus the corpus, or the judge's control bundles (judge cost only), with known-bad controls | no while the fix is pending |
| cut-work | `budget`, `hang` | `session_timeout`, headroom above `HEADROOM_FAIL`, `provider_stall`, or an `observer_timeout` whose transcript shows no progress (office-hours marathon) | cut the work: smaller fixture, fewer steps, split the case; never a larger budget. A hang is first diagnosed as budget, detector or provider | `eval:pass-rates --headroom` before and after; the session ledger row | no: a timeout or hang |
| runtime | `runtime` | the failure follows the runtime, not the code (Bun 1.4.0 on Windows) | pin, work around or upgrade the runtime in the same PR; reproduce on the pinned runtime first | a free test on the affected runtime (Windows lane dispatch) | no |
| qualifies | `provider`, `judge-noise`, `model-miss` | `provider`: mechanically, `failure_cause` is `api_error`, or `pre_turn_infra` with provider or transport evidence. `judge-noise`: a judge sample at the threshold under the v3 median gate. `model-miss`: the model did the wrong thing within the case's tolerated deviation, citing the transcript line where it deviated and the free checks that ruled out detector, assertion and grader | nothing to fix; measure | none | yes |
| unclassified | `unclassified` | no evidence for any route above | measure first to get more captures, then reclassify | none | no |

A red whose route has a pending fix is fixed, not accepted. `gstack-eval-measure decide` refuses MEETS (qualified) while any failed trial lacks a route, or a `model-miss` lacks its transcript citation, and the PR body lists every qualified MEETS under its own heading.

### Repairs must not weaken the test

A fix-test-infra or cut-work repair changes what the case checks, so it carries a short contract mapping in the ledger: the contract the case named before, the contract after, and why they are the same. Its free proof keeps every known-bad example the old check rejected (the case's corpus negatives plus at least one synthetic bad output written for this repair) and shows the new check still rejects them. A repair that cannot keep its negatives, or that narrows the named contract, is a scope change and goes through the stop rule's re-evaluation, not a fix round.

### The measurement bar and pooling

The bar is the one Garry accepted after #3033. It filters ship-time reds; it is not a claim that the case is healthy, and pass-rate history stays the drift detector. Each row also prints its next-gate red risk at the measured rate (for a behavior case, 1 − P(at least 2 of 3)).

Unit of measurement:

- `rule` case: one trial is one run of the case. N = 10.
- `judge` case (E2E judge-kind or standalone `LLM_JUDGE_TOUCHFILES` judge): one trial is one 3-sample `judgePanel()` gated on its median, exactly as the verdict runs. N = 10.
- `behavior` case: trials launch in whole panels of 3 (`<file>#<id>~t<N>`), N = 12 (4 panels), and the bar applies to the per-trial count with the same proportions.

Decision for a batch of N trials (counts round up):

- **MEETS (strict):** passes ≥ 0.9·N, so ≥ 9/10 (≥ 11/12).
- **MEETS (qualified):** passes ≥ 0.8·N, so ≥ 8/10 (≥ 10/12), every failed trial is classified, and every route is qualifies (none is a timeout, a hang, a regression or a route with a pending fix).
- **EXTEND:** not MEETS but passes ≥ 0.7·N (7/10, or 8/10 that does not qualify). Run N more trials on identical inputs and decide once on the pooled 2N with the same proportions: ≥ 18/20 strict, or ≥ 16/20 qualified. There is no third batch.
- **BELOW:** anything else (≤ 6/10), or a pooled 2N that does not meet. Go to a fix round.

Precedence, applied in this order before the counts above:

1. A contract violation, or a product regression from this branch, in any trial: fix-product. Never MEETS, whatever the count.
2. Below strict (< 0.9·N) with any red on a route that has a pending fix (fix-test-infra, cut-work, runtime): a fix round now. No EXTEND, because extending would only re-measure a known defect.
3. Otherwise the counts decide: strict, qualified, EXTEND or BELOW. Strict needs no classification, as Garry's bar says. A strict MEETS that left a red with a known fix still gets that fix in this PR (discovered defects are repaired, not deferred), and because the fix changes the case's own inputs, the case is measured once more on the fixed tree; it is MEETS only on that tree.
4. Evidence that arrives during an EXTEND batch (a capture that reveals a fixable defect) cancels the extension and starts a fix round; the extension's trials are kept in the ledger as diagnostic evidence.

**When MEETS goes stale.** MEETS is bound to the frozen tree it was measured on. At every `gate`, the CLI recomputes each MEETS case's series identity from the gate's tree. If the case's own bytes (its test file, fixtures, prompt files) changed, MEETS is stale and the case is measured again before the gate. If only shared harness inputs changed (another case's fix in a shared helper), MEETS stands with a "shared inputs changed" mark in `status` and the PR table, and the gate is the check; this avoids a re-measurement cascade every time a shared detector is fixed.

Identical inputs means the same case series identity (case-owned bytes plus `HARNESS_VERSION`, from `scripts/eval-trial-series.ts`), the same full consumed-input fingerprint, model, Claude CLI version, policy version, CI image digest, vCPU per trial, the per-key concurrency limit and runner setup. The series identity is computed from the frozen tree's temporary index, because `scripts/eval-trial-series.ts` reads blob ids with `git ls-files -s` and would otherwise hash the index rather than the working-tree bytes being measured. `gstack-eval-measure` refuses to pool batches whose identities differ and names the field that differs.

Why these numbers (binomial, per-trial rate p):

| true p | ≤ 8/10 (strict misses) | MEETS strict, one batch | MEETS strict with one extension | MEETS if every red qualified, with extension |
|---|---|---|---|---|
| 0.97 | 3.5% | 96.5% | 98.9% | 99.97% |
| 0.95 | 8.6% | 91.4% | 95.9% | 99.8% |
| 0.90 | 26.4% | 73.6% | 80.4% | 97.2% |
| 0.80 | 62.4% | 37.6% | 40.8% | 75.3% |
| 0.70 | 85.1% | 14.9% | 15.6% | 42.3% |

The last column is why only the qualifies route counts: a 70% case whose reds all "qualified" would pass the qualified bar 42% of the time, so a red with a known defect behind it must be fixed instead, and `provider` cannot be chosen by the agent.

### Stop rule and terminal states

A fix round is one concrete repair plus one fresh measurement. `gstack-eval-measure` counts rounds per case in the ledger and refuses a fourth measurement until `note` has recorded a re-evaluation answering three questions with evidence:

- **Scope:** is the case testing the contract it names, or something incidental (wording, ordering, a detector's view of progress)?
- **Design:** would an outcome check, a structured signal, a smaller fixture or a split case make the result deterministic?
- **Budget fit:** does one trial fit Garry's ~10-minute eval target and its armed budget (`eval:pass-rates --headroom`)? A case whose single trial cannot fit gets less work, not more time.

The agent then picks the new approach itself and continues; the counter resets once. Every case ends in one of two terminal states, and the loop has two approval gates on the way:

| | When | What /ship does |
|---|---|---|
| terminal: MEETS | the bar is met on the case's frozen tree, and MEETS is not stale (see When MEETS goes stale) | eligible for the gate |
| terminal: named red | the second approach is exhausted, or a fix needs a policy, threshold, kind or budget change | stops before the gate with a needs-decision report for Garry: waive under the existing explicit exception path, file a quarantine proposal (diagnostic trials can be cited in its reason but never count toward its trial minimum), or revert the change that caused it. The gate never runs on a named red's account. |
| approval gate: spend cap | the next batch would pass a measurement cap | asks once with the estimate and the ledger; approval is recorded with `approve`; declining makes the case a named red |
| approval gate: gate cap | a fourth gate run on this ship would be needed (gate 1 is the red gate that opened the loop) | asks once with the reds so far and the predicted all-green probability |

Only policy, threshold, budget and cap questions go to Garry. Routine spend under the caps never asks. Every question uses one fixed template: the problem in plain English, the options with what each costs and what happens next, a recommended option, and one question answerable with a letter.

### Cost guard

- **Estimate first.** Per trial: the mean `cost_usd` of the case's current series from pass-rate history; else the case's recorded wall from `scripts/paid-test-durations.json` times the tier's mean cost per second. Trials whose harness bills nothing (`cost_known: false`: PTY and Codex) use the wall-based estimate and are labelled estimated. Plus VM time at the Ubicloud list rate for the size used. The estimate prints with its source.
- **Caps (defaults, overridable per project).** Measurement and gates are capped separately, so the two never contradict each other. Measurement: ask only when one batch is estimated above $30, a case's cumulative measurement spend would pass $60, or the ship's total measurement spend (model plus VM time, free-suite batches included) would pass $150. Gates: capped by count (3 per ship, above), not dollars; their cost is reserved before each push and reported. The worst case without a question is therefore three gates (about $270 for a full gstack gate) plus $150 of measurement. Caps count per ship (per branch, across `reset`) against known spend plus the estimate reserved for every trial whose cost is unknown, so unknown billing cannot slip under a cap. A project overrides them with a `caps:` line in its Eval measurement block or `GSTACK_MEASURE_CAPS`; `status` prints the effective values and their source.
- **Actuals.** Each batch records its known cost and the count of trials whose cost is unknown, using the existing `formatCost()` wording. The table shows the sum and the reserve.
- **Rate limits.** The ledger caps concurrent model sessions per API key across all running batches (default 10, recorded in the identity), so several red cases measured at once do not throttle each other or other threads' gates.
- **Void batches.** If more than 30% of a batch's trials fail with affirmative provider or transport evidence (an `api_error`, a 429 or 5xx, a connection reset, at any turn), the batch is void (an outage or throttle, not a measurement) and may be re-dispatched once, mirroring the census INFRA rule. A `pre_turn_infra` failure without that evidence never voids a batch: crashes and module-load failures are harness defects, and their evidence is kept. Both batches are reported.

### Eval-store labelling

Diagnostic trials must never become verdicts or enter EVAL_POLICY v3 pooling or series history. Three independent guards, so any one failing still leaves two:

1. **Separate place.** Every diagnostic trial writes under `$GSTACK_STATE_ROOT/projects/<slug>/eval-diagnostics/<loop-id>/<batch>/`, never `getProjectEvalDir()`. `runCaseDiagnosis()` takes the eval dir from `gstack-eval-measure`, and a bare `--case` defaults there too.
2. **Separate schema and filename.** The per-trial ledger is `diagnostic-trials.jsonl` with schema `gstack-diagnostic-trial/v1`. It never matches the `trial-outcomes*.jsonl` glob that `eval:pass-rates` imports, and `parseTrialOutcomes()` rejects its schema, so older checkouts reject it too.
3. **Explicit label.** Shard children run with `GSTACK_EVAL_PURPOSE=diagnostic`; every `EvalResult` and trial record they write carries `purpose: "diagnostic"` and `diagnostic: { loop_id, case, batch, round }`, and diagnostic `EvalResult` files use their own filename prefix and schema version, so `isFinalizedEvalResultFile()` and the legacy `backfillEvalFiles()` import in `eval:pass-rates` (which read eval JSON independently of the JSONL parser) reject them structurally. `runPaidReport()` and the `trial-outcomes` writer refuse a record with `purpose: "diagnostic"`; `eval:pass-rates --dir` skips them with a printed count; `eval:list`, `eval:compare` and `eval:summary` mark them `[diagnostic]` and exclude them from trends.

Two reuse paths could also carry diagnostic results into verdict evidence, and both are closed at their owners: `prepareWorkflowJudgeCache()` (`test/helpers/workflow-judge-cache.ts`, whose cache purpose is hard-coded to `gate`) neither looks up nor publishes receipts when `GSTACK_EVAL_PURPOSE=diagnostic`, and diagnostic runs unset `EVALS_CACHE_DIR` and `EVALS_CACHE_PR` so `e2e-shard-reuse.ts` never writes receipts for them.

`docs/TESTING_INTERNALS.md` gains a short "Diagnostic measurement (not verdict retries)" subsection under the eval verdict policy, and AGENTS.md item 7 and the census rule gain one carve-out sentence each: a diagnostic measurement under this loop may run on unchanged inputs; it never yields, replaces or pools into a verdict. `EVAL_POLICY` constants and version are unchanged.

### Infrastructure: detached trials on Ubicloud, run the way CI runs them

The coordinator machine may sleep (a Capy turn ending, a laptop lid), so the trial process must not live there.

Why Ubicloud and not a CI dispatch: a CI run needs the measured code pushed, and every push to the PR branch starts the PR's own paid lane (`evals.yml` runs on `pull_request`, `cancel-in-progress`), so each fix round would buy an unwanted gate run and cancel the one in flight. Ubicloud measures the frozen working tree, including uncommitted fixes, and runs nothing else. A paid measurement workflow dispatched on a scratch ref would also avoid the PR lane; it is the recorded alternative (TODOS.md) if the VM path proves costly to keep faithful.

- **One shared CI trial script.** CI's paid step is more than the image: it runs as the `runner` user (the image creates it but does not select it, and Claude's permission-bypass mode refuses root), restores dependencies from `/opt/node_modules_cache`, builds the checkout, seeds interactive configuration, registers runtime resources and authenticates Codex into its own home (`evals.yml`, around lines 360-450). That sequence moves into one script, `scripts/ci/paid-trial-env.sh`, which both `evals.yml` and the measurement backend call, so they cannot drift. SDK, PTY and standalone-judge trials are each qualified on it once (the real-path smoke).
- **Same CPU per trial as CI.** CI runs paid slices on `ubicloud-standard-8` with `EVALS_JOBS=2`, about 4 vCPU per trial. Measurement keeps that: `standard-16` VMs running 4 trials each, so a 10-trial batch uses 3 VMs and a 12-trial behavior batch 3 VMs. vCPU per trial is in the pooling identity, because a crowded VM inflates walls into fake timeouts, which is exactly what the cut-work route reads.
- **Launch.** `start` runs `doctor` and the local probe, then per VM: `ubi-runner.sh up` (owner-tagged), the frozen tree as a fresh repository, and a new `ubi-runner.sh env NAME --pass K...` subcommand. `env` writes a separate Docker-format file (`~/.ubirun-docker.env`, literal `KEY=value` lines, mode 0600, values with newlines rejected), because the existing `~/.ubirun-env` holds shell `export K=%q` lines that `docker run --env-file` cannot read. One `ssh` then starts, under `gstack-detach --label measure-<case>-b<batch> --timeout <wall>`, the remote probe and then the trials through `scripts/ci/paid-trial-env.sh` inside the CI image with `docker run --user runner --env-file ~/.ubirun-docker.env` (never `-e K=V`, which would put values in the VM's process list) and `GSTACK_EVAL_PURPOSE=diagnostic`. It records the VM names, deadline and log paths in the ledger and returns at once.
- **The image.** The tag is the one `evals.yml` computes with `hashFiles(Dockerfile.ci, bun.lock, patches/**)`; `measure-remote.ts` reimplements that hash and a test checks it against a published tag. When the tag is not published (a fork, or a changed Dockerfile not yet built), the VM builds the image, which takes longer than the batch target; `start` says so in its estimate. The image digest is in the pooling identity.
- **Dead-man switch.** The VM schedules `sudo shutdown -h +<wall + 30 min>`. A halted VM may still bill, so the switch only stops runaway trials; destruction is the coordinator's `status`/`start` sweep of VMs past deadline plus 30 minutes.
- **Collect.** `collect` (run when a timer wakes the coordinator) polls the remote logs for `### gstack-detach EXIT=<code> ###`, pulls and checks each archive, writes `diagnostic-trials.jsonl`, prints the decision and destroys the VMs, on every path (success, failure, missing sentinel after the deadline, `cancel`). The ledger's `vm` field is cleared only after Ubicloud confirms the VM is gone.
- **The runner.** `scripts/ubicloud/ubi-runner.sh` is replaced wholesale by the user-scope skill copy (owner tagging with `UBI_OWNER`, owner-scoped `gc`, `usage`, the quota-refused message) with its tests, plus the `env` subcommand and the `down` and `pull` fixes above, so the copies stop drifting.
- **Parallel cases.** Red cases are measured in parallel, each with its own VMs, after checking `usage` against the shared quota and within the per-key session cap.
- **Local backend.** Projects without Ubicloud use `gstack-detach` on the coordinator with parallel jobs defaulting to half the machine's cores; the job count is part of the pooling identity, and the ledger records that a sleeping coordinator can lose the batch.
- **Isolation for parallel file-mode trials.** Each trial already gets its own `GSTACK_EVAL_DIR` and `TMPDIR`; it also gets its own `HOME` and `GSTACK_STATE_ROOT`, so a file-mode case running beside itself cannot share ports, fixture dirs or state.

The ~10-minute target applies to a measurement batch. A typical repair path is sequential: about 2 minutes for inventory and probe, a 10- to 15-minute baseline batch, the fix, a 10- to 15-minute re-measure, then the gate (~12 minutes when everything reruns, less with reuse), so about 40 to 50 minutes from first red to verdict, against six full gates (over an hour of gate wall plus repair time between runs, ~$540) on #3033.

### Free-suite flakes and Windows lanes

A free-test red goes through the same steps with no model spend (its VM time still counts toward the ship's measurement cap): classify, free proof, then measure by rerunning the failing shard's exact file list, in the same order, from the run's plan artifact. Before calling a free red a product bug, the loop checks the known local traps (Bun version against the CI pin, the Capy git author wrapper) and records them as `runtime` when they apply.

- **A diagnostic plan, not a replayed CI plan.** Today's plan validator requires the original revision and every free file exactly once, and the Windows lane enables retries whose verifier accepts a failed first attempt followed by a pass. Measurement therefore uses a new diagnostic plan type (`--diagnostic-plan`): source-plan provenance (run id, shard), the frozen tree's hash, the ordered file list and repetition ids 1..N, with retries disabled and only first-attempt outcomes counted. The executor and verifier learn this plan type together.
- Linux: on one Ubicloud VM (`test:ubicloud` setup), the diagnostic plan's N = 10 repetitions, four isolated copies at a time (each with its own temp state, `HOME` and state root).
- Windows: `windows-free-tests.yml` gains two `workflow_dispatch` inputs, `files` (the exact newline-separated list) and `repeat` (1 to 10). They reach the plan step only through `env:`, never `${{ inputs.files }}` inside `run:` (script injection), and the plan step builds the diagnostic plan from them with retries disabled. The measured code is pushed to a scratch ref, `measure/<branch-slug>`, and the dispatch targets it: every workflow in `.github/workflows/` triggers only on pull requests, pushes to main, schedules or dispatch, so the scratch push starts nothing else, and the ref is deleted after collection. The dispatch's concurrency group is already per run (`windows-free-${{ github.run_id }}`), so measurement dispatches never cancel the PR's own Windows lane or each other.
- The free bar is 10/10 after the fix. A free test is meant to be deterministic, so any failure in the measurement is a defect to fix; the before-rate is reported for the table. `GSTACK_FREE_RETRY_FLAKY` stays a CI safety net, not evidence.

### Other projects: an explicit adapter, never a guess

`/ship` runs the automatic loop for another project only when its CLAUDE.md or AGENTS.md declares an "Eval measurement" block (version 1):

```
eval-measurement: v1
trial:    <command that runs ONE trial, with {case} and {trial}>
results:  exit-code | junit <path with {trial}>
kind:     rule | behavior | judge        (optional; default rule)
probe:    <command with {case}>          (optional)
cost:     <per-trial estimate, e.g. "$0.40">   (optional; without it the first batch asks)
caps:     batch=$30 case=$60 ship=$150   (optional; measurement caps)
setup:    <script run once on a fresh VM>  (required for backend ubicloud)
secrets:  <names of env vars to forward>   (optional; default none)
backend:  ubicloud | local               (optional)
measure:  on | off                       (optional; off keeps today's show-and-stop)
```

The loop runs `trial` N times with `{trial}` = 1..N, so each trial has its own result: with `exit-code`, 0 is a pass and anything else a failure with the log tail as evidence; with `junit`, the file must hold exactly one testcase. Reds come from `inventory --cases a,b` (the project names its red cases from its own report). The pooling identity is the frozen tree's hash (tracked plus untracked-unignored files; the CLI refuses when the `results` path is not ignored, so trial outputs never change it) plus the command, so any source change starts a new pool. Case ids from `inventory --cases` must match `^[A-Za-z0-9._/-]+$` before they are substituted into `trial`. An adapter project on Ubicloud gets a bare VM prepared by its own `setup:` script, never gstack's CI image, and receives only the variables its `secrets:` line names: by default nothing is forwarded, so a repository's `trial:` command never sees Garry's keys unless the project asks for them by name. A project without a probe gets the void-batch check instead. `gstack-eval-measure doctor` validates the block at `/ship` start. Without a block, `/ship` keeps today's behavior for that project's evals (show failures and costs, stop) and prints a copy-paste template of the block with a docs link.

gstack's built-in adapter is richer: `scripts/test-paid-shards.ts --tier <tier> --case {case} --trials {N}` (standalone judges through their selection command), the eval store's per-trial records, kinds from `E2E_KINDS`, `failure_cause`, and the series identity. The same `measure: off` switch exists as `GSTACK_MEASURE=off`. The bar, stop rule, cost guard, ledger and table are the same everywhere.

### PR-body report table

`ship/sections/pr-body.md.tmpl`'s Eval Results section gains the table `gstack-eval-measure table` prints, one short row per case that went red:

```
| Case | Route | Before → After | Bar | Next-gate red risk | Spend |
|---|---|---|---|---|---|
| cso-diff-mode | fix-test-infra (test-assertion) | 6/10 → 10/10 | MEETS strict | 0/10 failed (95% upper bound 28%) | $7.80 |
```

Next-gate red risk is the measured failure fraction with its sample size and the 95% Wilson upper bound, never a bare point estimate (a behavior row converts it to the panel's 1 − P(at least 2 of 3)). Each row has a `<details>` block with the red's run and trial, the fix and its commit, rounds, batch ids, and each failed trial's sanitized failure line and Expected/Received (through `scripts/lib/published-text.ts`), so a reviewer can audit a qualified result without the VM; full captures stay under the diagnostics dir for 14 days. Below the table, in order: the three success numbers (gate runs, total spend including gates and VM time, first red to verdict); "Measurement trials are diagnostic and are not verdicts. Lane verdict: <gate run link> <GREEN|RED>."; the predicted all-green probability for the gate that ran, computed over that gate's selected cases from pass-rate history and labelled as an approximation with its interval; qualified MEETS under their own heading with each red's citation; named reds with their re-evaluation notes and the decision asked.

### Tests

Free (all deterministic, no API spend):

- `test/eval-measure-bar.test.ts`: the decision table, applied after precedence. 9/10 MEETS; 8/10 with only qualifies reds MEETS qualified; 8/10 with a timeout, a hang or a pending-fix route is a fix round (precedence 2); 8/10 with an unclassified-after-review red or an uncited `model-miss` is EXTEND; a sub-strict batch with unreviewed failures is needs-classify; 7/10 EXTEND; 6/10 BELOW; pooled 18/20 and qualified 16/20 MEETS; 17/20 unqualified BELOW; a third batch refused; pooling across a changed identity (including the image digest) refused with the field named; behavior N = 12 thresholds; judge trials counted as panels; `provider` cannot be set by hand when `failure_cause` disagrees, and `pre_turn_infra` without provider evidence never becomes `provider` or voids a batch; a refusal is not mechanical; early stop fires exactly when the outcome is certain; MEETS goes stale when case-owned bytes change and carries a mark when only shared inputs change.
- `test/eval-measure-ledger.test.ts`: the precedence rules (a contract violation at 10/10 is never MEETS; 7/10 with a pending detector fix is a fix round, not EXTEND; 9/10 with a known defect gets the fix and one more batch on the fixed tree; new evidence cancels an EXTEND); per-trial `classify` records are immutable and superseded, never edited; `proof` records both tree hashes; caps count per ship across `reset`; gate 1 is the red gate; a stale lock with a dead pid is reclaimed; the `--json` shape and every exit code; the reason codes; a pre-registered field edited outside the CLI is refused; the lock; a repeated `start` returns the running batch; a lost batch is not a round, keeps its reserve and allows one re-dispatch; `reset` archives; pre-registered fields are immutable after a batch starts; the measurement-cap check counts the unknown-cost reserve and returns "needs approval" with the estimate, and gate cost is reserved before each push; a fourth round is refused without a re-evaluation note; a second exhaustion yields named red; a fourth gate run asks; a void batch (> 30% of trials with provider or transport evidence) allows exactly one re-dispatch, and a batch of module-load failures is never void; the baseline-skip path records "reproduced by replay"; a fix-test-infra round without a contract mapping and kept negatives is refused.
- `test/eval-measure-labelling.test.ts`: `parseTrialOutcomes()` and a frozen copy of the current reader reject `diagnostic-trials.jsonl`; `runPaidReport()` refuses `purpose: diagnostic`; `eval:pass-rates --dir` skips them with a count; `eval:summary` marks and excludes them; bare `--case` defaults to the diagnostics dir.
- `test/eval-measure-probe.test.ts`: the real `--case <id> --probe` CLI path against fixture paid files, with a timeout on every spawn and an injected few-second wall: a name-mode case passes at its probe line; a multi-test file-mode case (shaped like `plan-mode-no-op`, six tests) passes; a judge id passes; each of the four runners and the judge caller writes its probe line and honors `GSTACK_EVAL_CLIENT_RETRIES=0`; negative controls reproduce both #3033 bugs (a single-case file whose name filter matches nothing fails with "0 tests ran"; a runner that imports the entry module fails at the wall instead of hanging), a test from another file, and a slow-failing client with retries left on.
- `test/eval-measure-ubicloud.test.ts` (beside `test/ubicloud-runner.test.ts`): with a stub runner, `start` returns before trials finish and records the VM; `collect` pulls the archive (with one retry) before destroying the VM on success, failure, a missing sentinel and cancel; owner-scoped `gc` never touches another owner's VM; keys never appear in argv, logs, the VM's process list or the docker invocation (`env` writes a 0600 Docker-format file, and a real `docker run --env-file` against a stub image reads it); a failed `destroy` keeps local state and reports failure; an empty `pull` is a failure; an archive whose manifest does not match is refused; the image-tag hash matches a known published tag; VMs past deadline are swept; file-mode trials launch in parallel with separate `HOME` and state roots (one fixture file run twice side by side shares nothing); `doctor` reports each missing prerequisite with its fix.
- `test/eval-measure-gate.test.ts`: with a stub `gh`, a push to a branch with an open PR plus `gate` yields exactly one counted gate (the `pull_request` run), never an extra `eval:bg:pr` dispatch; a run started outside `gate` is still counted; the estimate is reserved before the push; a fourth gate asks.
- `test/eval-measure-isolation.test.ts`: a diagnostic run neither looks up nor publishes workflow-judge receipts and never writes E2E reuse receipts, even with `EVALS_CACHE_DIR` set in the parent; the complete legacy import pipeline (`backfillEvalFiles()` and `isFinalizedEvalResultFile()`), not only `parseTrialOutcomes()`, ignores diagnostic `EvalResult` files.
- `test/eval-measure-demo.test.ts`: `gstack-eval-measure demo` completes with no keys and no network and prints the documented output; a non-gstack fixture with a v1 Eval measurement block runs `trial` once per trial for both `exit-code` and `junit`; a missing block prints the template.
- `test/ship-measure-loop.test.ts`: the generated `ship/SKILL.md` and `ship/sections/tests.md` (Claude and Codex hosts) contain the loop's steps in order, "diagnostic, not verdict", the stop rule, the terminal states, the gate cap and the cap question, and no longer contain "If any eval fails: Show failures and available costs, then **STOP**" for the adapter path. It anchors on step headings and named rules, not paragraphs.
- `test/free-tests-workflow-wiring.test.ts` additions: the Windows dispatch inputs reach `run:` only through `env:`, the diagnostic plan disables retries and counts first attempts, and the per-run concurrency group is unchanged. `test/evals-workflow-wiring.test.ts`: `evals.yml`'s paid step calls `scripts/ci/paid-trial-env.sh`.
- Adjacent required checks: `bun run gen:skill-docs` freshness (both hosts), `test/parity-suite.test.ts`, prompt-size budgets, `test/spawnsync-timeout-tripwire.test.ts`, `test/module-size-ratchet.test.ts`, `test/harness-version.test.ts` (eval-store changes are recorded with `--non-behavioral` if no verdict can change), `test/state-root-ratchet.test.ts` for the new diagnostics path, and credential scanning.

Real-path smoke (no model spend, a few cents of VM time, once before acceptance): `gstack-eval-measure start --dry-run`, then `start --probe-only --case <a gate case>` on a real Ubicloud VM, which exercises doctor, up, sync, env, image pull, the remote probe, collect and down with no model call. Its log goes in the PR.

Paid E2E, `test/skill-e2e-ship-measure-loop.test.ts`, case `ship-measure-fix-loop`, gate tier (diff-selected), kind `behavior` (a panel of 3; tolerated deviation: wording and order of the agent's notes, not the loop's steps):

- Fixture: a tiny repo whose CLAUDE.md declares the "Eval measurement" block, including `cost:` (so the first batch does not ask) and a `.gitignore` covering `.context/` and the results path. Its eval command is a free script with a seeded outcome: before the fix, trials 2, 6 and 9 of every 10 fail (30%). The red the agent starts with is an `observer_timeout` whose capture was truncated, so it is `unclassified` and must be measured first. The baseline batch's three failures each leave a full capture showing a wording variant the exact-match detector misses. The prepared fix (`fixes/detector-structured-signal.patch`) makes the detector read a structured event; after it, all trials pass. The trial command logs every invocation, its arguments and `GSTACK_EVAL_PURPOSE` to an invocation ledger. Measurement uses the local detached backend; this case tests the loop, not Ubicloud.
- The agent starts at Step 6.3 with the red gate result on disk (workflow excerpt of the tests section plus the PR-body template, as other ship E2Es do), so one trial fits the ~10-minute target.
- Outcome assertions, read from the invocation ledger and files rather than the transcript: the first red is recorded `unclassified`; the probe ran before the first measured trial; the estimate printed and nothing asked (under cap); a baseline batch of 10 ran with purpose diagnostic and measured 7/10; the red was then reclassified fix-test-infra (`detector`) citing a baseline capture; a replay test over the captures failed before the patch and passed after it, and still rejects the fixture's known-bad capture; the detector file changed and no threshold, budget, kind or policy file did; a second batch of 10 measured 10/10 on a new identity; the gate ran exactly once and after the second batch; the PR body has the row with 7/10 before and 10/10 after and the three success numbers.
- `expectContract()` violations: the gate runs before MEETS; an EXTEND batch starts after the baseline (the captures show a fixable detector, so precedence requires a fix round); any measured trial lacks the diagnostic purpose; a threshold, budget or kind changed.

### Files and ownership

One PR, one owner (the implementing thread) for every shared file. If the PR stalls, the first cuts, in order, are the Windows `repeat` dispatch, the non-gstack adapter block and the lister marking in `eval:list`/`eval:compare`; everything else is the core.

- `ship/sections/tests.md.tmpl` (Step 6.3 rewrite and the free-test hook in Step 5's triage) and `ship/sections/pr-body.md.tmpl` (table); regenerated `ship/SKILL.md`, `ship/sections/*.md` and the Codex host outputs.
- New: `bin/gstack-eval-measure` (host-neutral entry, `runtime-root.ts` prelude), `scripts/eval-measure.ts` (argument parsing and dispatch for the subcommands in the command contract, offline `--help`), `scripts/lib/measure-bar.ts` (pure decision, precedence, pooling identity, next-gate risk), `scripts/lib/measure-ledger.ts` (ledger, pre-registration hashes, lock, rounds, loops, terminal states, spend, reason codes), `scripts/lib/measure-remote.ts` (Ubicloud and local backends, doctor), `scripts/lib/measure-adapter.ts` (the v1 block parser and per-trial runner), `test/fixtures/measure-demo/` (the seeded fixture shared by the demo and the paid E2E). Each under the 800-line module ratchet.
- `scripts/test-paid-shards.ts` (`--probe`, judge ids for `--case`, diagnostics dir default and a notice saying where a bare `--case` wrote its diagnostic results), `scripts/lib/paid-report.ts` (`runCaseDiagnosis()` purpose, dir, parallel file-mode trials, judge trials; `runPaidReport()` refusal; `afterRepairCommand()` red-line hints lead with `gstack-eval-measure start --case <id>`), `test/helpers/eval-store.ts` (`purpose` field, diagnostic schema and filename prefix, writer refusal), `test/helpers/workflow-judge-cache.ts` and `scripts/e2e-shard-reuse.ts` (no lookup or publication for diagnostic runs), the four session runners and `test/helpers/llm-judge.ts` (the probe line and `GSTACK_EVAL_CLIENT_RETRIES`), `ship/sections/tests.md.tmpl` Step 6.2 (writes the last-gate pointer), `scripts/eval-flake-rank.ts` (`--dir` skip count), `scripts/eval-list.ts`, `scripts/eval-compare.ts`, `scripts/eval-summary.ts` (marking).
- `scripts/ubicloud/ubi-runner.sh` (replaced by the skill copy with its tests; new `env` subcommand; `down` and `pull` fixes), new `scripts/ci/paid-trial-env.sh` (the shared CI paid-trial bootstrap) called from `.github/workflows/evals.yml`, `scripts/test-free-shards.ts` (the diagnostic plan type in planner, executor and verifier), `.github/workflows/windows-free-tests.yml` (dispatch inputs).
- `package.json` (`eval:measure` alias), `test/helpers/touchfiles-data.ts` (tier, kind, `BEHAVIOR_WHY` and touchfiles for `ship-measure-fix-loop`), `scripts/harness-version.json` if a pinned harness file changes.
- Docs: `docs/TESTING_INTERNALS.md` (diagnostic measurement subsection, Ubicloud trial backend), `AGENTS.md` (item 7 carve-out, `eval:measure` in Build commands), `CLAUDE.md` (one pointer under Running evals as an agent), `docs/evals/census-red.md` (a worked example: red, unclassified, baseline 7/10, detector fix, 10/10, gate, using the demo fixture), `docs/troubleshooting.md` (one anchor per reason code), `CONTRIBUTING.md` (the `--case` row now says its results are diagnostic, plus an `eval:measure` row linking the worked example), `TODOS.md` (the "Next" items), `CHANGELOG.md`, `VERSION`.
- The tests listed above.

This PR changes the paid runner, eval store and session runners, which are global touchfiles pinned in `scripts/harness-version.json`, so its own gate reruns every case: expect one full ~$90 gate for it. Every harness change is written to be inert unless its environment variable is set (`GSTACK_EVAL_PURPOSE`, `GSTACK_PROBE_FILE`, `GSTACK_EVAL_CLIENT_RETRIES`), which CI never sets, so the bump is recorded with `bump-harness-version.ts --non-behavioral` and no series resets. If review finds a behavioral change, the bump becomes `--bump`, every series restarts, and the cost estimator falls back to wall-based estimates until history rebuilds.

### Risks

- **Diagnostic trials leak into verdict history.** Three independent guards plus a frozen-reader test. Residual: a hand-run `bun test` with `EVALS=1` outside `gstack-eval-measure` is unlabelled, as it is today.
- **The qualified bar passes a weak case.** Only the qualifies route counts, `provider` is mechanical, `model-miss` must cite a transcript deviation, and every qualified MEETS is listed separately in the PR. A misclassified `model-miss` is the remaining hole, visible to the reviewer.
- **Repairs make the test easier instead of correct.** Contract mapping plus kept negatives, enforced by the ledger; a narrowed contract goes to re-evaluation.
- **The gate keeps rotating reds.** Measurement cannot fix that by itself; it is bounded (3 gate runs per ship, measurement caps, gate cost reserved before each push) and made visible (predicted all-green probability in every ship); the root fix is the next item below.
- **Ten trials cannot tell 90% from 95%.** True, and stated; the next-gate risk column shows what the bar leaves.
- **Cost overrun or a provider outage burning trials.** Caps with an unknown-cost reserve, checked before launch; void-batch rule; actuals in the table.
- **Leaked VMs or a shared-quota squeeze.** Destroy on every collect path with confirmation, a coordinator sweep of VMs past deadline, owner-scoped gc, `usage` before a fleet. A halted VM may still bill, so the dead-man shutdown is not relied on for cost. A Capy machine replaced while a batch runs loses its SSH keys: `down` still works by name, so the batch is lost but not leaked.
- **Throttling inside a measurement.** A per-key session cap across batches; mid-session 429s void a batch instead of counting as `provider` reds.
- **Diagnostic results reaching gate reuse.** Workflow-judge and E2E receipts are disabled for diagnostic runs at their owners, tested even when the parent environment sets the cache variables.
- **Harness series reset.** If the runner changes are not inert, every series restarts (see Files); the PR says which.
- **The VM environment drifts from CI.** Trials run inside the CI image through the same `paid-trial-env.sh` CI uses, as `runner`, at CI's vCPU per trial; the image digest and vCPU are in the pooling identity; the remote probe runs first. The image tag hash is a reimplementation of GitHub's `hashFiles` and is tested against a published tag; an unpublished tag means a slow build, shown in the estimate.
- **Patch chasing.** Round counter enforced by the CLI, re-evaluation note required, one reset, then a named red that stops the ship.
- **The E2E is itself flaky.** The fixture's eval outcomes are seeded and free, so only the agent varies; behavior panel; outcome assertions from the invocation ledger.
- **Prompt growth in /ship.** Step 6.3 stays a short list (run `status`, follow Next, the rules); mechanics live in the CLI help and TESTING_INTERNALS. Parity and prompt-size checks gate it.
- **The CLI surface grows past what the loop needs.** Every subcommand records one fact the ledger enforces, and nothing else. The adapter is versioned (`v1`) so later fields do not break existing blocks.
- **Policy text drift.** AGENTS.md item 7 and the census rule change by one sentence each; `test/periodic-exclude-policy.test.ts` still passes because no constant moves.

### Not in scope

- Any `EVAL_POLICY` constant, kind, threshold, panel size or budget change.
- Automatic quarantine entries.
- Running paid diagnostic trials in CI (the Windows free-suite measurement does use a CI dispatch on a scratch ref).
- A fresh full-/ship marathon case (the E2E enters at Step 6.3).
- Changing how the full gate itself is selected or sharded.
- Showing diagnostic trials in pass-rate history, even display-only (TODOS.md).

### Next, not in this PR

- **Off-ship qualification sweep.** A scheduled N = 10 sweep on main over the cases pass-rate history flags (lowest rates and the worst contributors to the gate's all-green probability), using the same `eval:measure` CLI, so most flaky cases are fixed before any ship hits them. This is the lever on the gate-level problem; it needs Garry's go-ahead on its weekly spend.
- **A gate verdict rule that tolerates a measured-noise red** would be an `EVAL_POLICY` change and needs Garry's approval and a fresh census; listed only so it is not forgotten.

<!-- autoplan-accepted:ceo -->
- Success is reported as gate runs, total spend including gates, and first-red-to-verdict time; tested by the ledger and E2E table assertions.
- Gate runs capped at 3 per ship; a fourth asks; the predicted all-green probability prints every ship.
- Terminal states MEETS, named red (stops the ship with needs-decision), over cap, gate cap; tested in the ledger test.
- `provider` is mechanical; `model-miss` requires a transcript citation; qualified MEETS listed separately; tested in the bar test.
- Repairs carry a contract mapping and keep known-bad negatives; enforced by the ledger; tested.
- Spend caps include gate runs and an unknown-cost reserve.
- Trials run inside the CI image; image digest in the pooling identity.
- `--case` supports standalone judges; file-mode trials run in parallel.
- Probe runs locally and on the VM, with client retries zero, stopping at the first armed session; $0 real-path smoke before acceptance.
- Six routes with fine tags; early cancel when BELOW is certain; ledger path uses the branch slug.
- E2E first red is unclassified so the baseline is required; baseline-skip covered by a free test.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- `bin/gstack-eval-measure` is the host-neutral entry; the ledger path must be ignored by git or the CLI refuses.
- Recording commands: `classify --route --tag --evidence`, `proof --test --negatives --contract`, `note`, `gate --run`, `approve --cap --usd --by`; tested.
- Command contract: `--json` shape and exit codes 0, 10, 20, 30, 40, 50, 2; reason codes with troubleshooting anchors; tested.
- `doctor` runs before spend; `inventory` without arguments reads the last gate run, with `--run`, `--dir` and `--cases`.
- Loops, `reset --reason`, ledger hashes and lock; idempotent `start`; lost batches are not rounds, keep their reserve and may be re-dispatched once; pull-then-destroy with one retry.
- Precedence rules for contract, pending-fix, strict-with-known-fix and evidence during EXTEND; tested; the E2E's 7/10 baseline goes to a fix round.
- `ubi-runner.sh env` writes a 0600 env file; trials use `docker run --env-file`; a test checks argv, logs, the VM process list and the docker invocation.
- Credential-free `demo` on the shared fixture; adapter v1 runs one trial per invocation; missing block prints the template.
- PR table: 6 columns plus `<details>` with sanitized failure lines; risk with sample size and Wilson upper bound; all-green over the gate that ran.
- "No model spend" wording; VM time counted toward the loop cap; Windows measurement on a scratch ref.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- `gate` is the only push path while a loop is open; it reserves the estimate, adopts exactly one run for the head SHA (the `pull_request` run when a PR exists), and counts every `evals.yml` run for the branch from `gh`; tested with a stub `gh`.
- Measurement runs on a frozen tree (temporary index, `git write-tree`, `git archive` into a fresh repo); the identity comes from that tree; vCPU per trial, image digest and the per-key session cap are in the identity.
- `scripts/ci/paid-trial-env.sh` is shared by `evals.yml` and the VM backend; trials run as `runner` at 4 vCPU per trial (standard-16, 4 trials each).
- MEETS goes stale when case-owned bytes change; shared-input changes add a mark and leave the check to the gate; a strict MEETS with a known defect gets the fix and one more batch.
- `decide` returns needs-classify for unreviewed sub-strict failures; `classify --trial` records are immutable; `proof` runs the check on both trees.
- Probe: a probe line under `GSTACK_PROBE_FILE` in the four runners and the judge caller, `GSTACK_EVAL_CLIENT_RETRIES=0`, file-mode cardinality rule, injectable wall; all harness changes inert unless their variables are set, recorded `--non-behavioral` or else `--bump` with the consequence stated.
- Diagnostic runs never look up or publish judge or E2E receipts; diagnostic `EvalResult` files are structurally rejected by the legacy import; tested through the full pipeline.
- Void needs affirmative provider or transport evidence; mid-session 429s count; `refusal` is not mechanical.
- Free-suite measurement uses a diagnostic plan type with retries off and first attempts only; Windows inputs pass through `env:`.
- `ubi-runner.sh` is replaced by the skill copy plus `env` (Docker-format 0600 file) and fixed `down`/`pull`; VMs past deadline are swept by the coordinator; runner state lives under the state root.
- Caps: measurement $30 batch, $60 case, $150 ship; gates capped at 3 per ship counting the red gate; per branch across `reset`. This replaces the CEO block's "$250 including gates" and its listing of over cap and gate cap as terminal states (they are approval gates).
- Adapter: bare VM with `setup:`, `secrets:` allowlist defaulting to none, case-id regex, outputs ignored.
<!-- /autoplan-accepted:eng -->
## Review record

### Autoplan run (2026-10-06, Capy adaptation)

Host: Capy (Claude model), reading the installed Claude Code gstack skills. Native phase voices ran as Capy subagents on the shared machine, each given the snapshot tool's `nativeDispatchPrompt` verbatim; the outside voice was the Codex CLI (`codex-cli 0.160.1`, `gpt-6-astra`, API-key login) through the phase's own runner and `lib/outside-review-result.ts`. Claude Code hooks (the phase-publication guard) do not run in Capy, so the phase gates were followed as written but not hook-enforced. UI scope: 0 term matches, design phase skipped. DX scope: required (31 term matches; developer tool, agent-primary).

### Phase 1: CEO review (mode SELECTIVE EXPANSION, autoplan override)

**Premises.**

- P1 "The pain is ship-time cost and latency of single-case reds": valid. Evidence: #3033's six full-gate runs, issue #3034, Garry's 2026-10-05 instruction.
- P2 "Measuring the red case alone, then gating once, ends the treadmill": partly wrong, raised by both voices. With ~130 verdicts an all-green gate is unlikely even when every case is healthy (TESTING_INTERNALS: 26.8% at 0.99). Accepted fix: success is defined as fewer gate runs, less spend and less time; gate runs are capped at 3; the gate's predicted all-green probability prints every ship; the root fix (an off-ship sweep) is named as Next.
- P3 "Classification can be trusted to the agent": too trusting. Accepted fix: `provider` is mechanical, `model-miss` needs a transcript citation, qualified MEETS is listed separately; tightening further is a Garry decision (G2).
- P4 "Generic over any project's eval command": both voices say this is the weakest part and should be cut or narrowed. Treated as a User Challenge (the parent's brief asked for it); the plan narrows it to an explicit adapter block with no guessing and keeps it.

**What already exists.** `--case`/`--trials`/`--list` and `runCaseDiagnosis()` (single-case panel runner); `afterRepairCommand()` (judge selection command); `failureCauseOf()` and the `failure_*` fields; `eval:pass-rates --run/--reds/--headroom`; detector replay corpora; PR-lane verified-pass reuse (`e2e-shard-reuse.ts`); `ubi-runner.sh` and `setup-free-suite.sh`; the CI image; `gstack-detach` and the eval lock. The plan builds on each; the new code is the decision logic, the ledger and the remote backend.

**Dream state delta.**

```
CURRENT                         THIS PLAN                               12-MONTH IDEAL
first red -> STOP; driver   -> fixed loop: classify, free proof,    -> flaky cases found and fixed off-ship
improvises; full gate per      $0 probe, measured batches on VM,       by a weekly sweep; ship-time loop is
push; one bit per $90          gate capped; named reds stop ship       the rare fallback; gate green >50%
```

**Dual voices: consensus table.**

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                            Claude  Codex  Consensus
  1. Premises valid?                   partly  partly CONFIRMED (gate-level math undercuts "gate once")
  2. Right problem to solve?           partly  partly CONFIRMED (symptom fix; off-ship sweep is the lever)
  3. Scope calibration correct?        no      no     CONFIRMED (too broad; generic + Windows first cuts)
  4. Alternatives sufficiently explored? no    no     CONFIRMED (CI dispatch dismissed too fast)
  5. Competitive/market risks covered? yes     n/a    single-voice (low external risk; opportunity cost)
  6. 6-month trajectory sound?         partly  partly CONFIRMED (needs terminal states and gate cap)
```

Native (Claude subagent) and outside (Codex) findings, with dispositions:

| # | Finding | Voice | Severity | Disposition |
|---|---|---|---|---|
| C1 | "Gate once" fails the gate-level math; loop can still treadmill | both | critical / P1 | Accepted: success metrics, gate cap 3, predicted all-green line, Next: off-ship sweep |
| C2 | Bar described as "next gate will not go red", not what it measures | Claude | high | Accepted: honest wording, next-gate red risk column |
| C3 | Agent chooses the qualified bar through classification | Claude | high | Accepted: mechanical `provider`, cited `model-miss`, separate PR heading; stricter cap to Garry (G2) |
| C4 | Named red has no defined outcome; no total bound | both | high / P1 | Accepted: terminal-state table; named red stops the ship with needs-decision |
| C5 | Repairs can weaken the test | Codex | P1 | Accepted: contract mapping plus kept negatives, enforced by the ledger |
| C6 | 10-minute promise vague; file-mode trials serial; behavior N=12 over jobs cap; free reruns sequential | Codex | P1 | Accepted: target applies per batch, critical path stated, parallel file-mode trials, VM sized by N, four parallel free copies |
| C7 | Spend caps omit gate runs and unknown-billing trials | both | medium / P1 | Accepted: ship cap $250 including gates, unknown-cost reserve |
| C8 | Hand-mirrored VM environment will drift | Claude | medium | Accepted: trials run inside the CI image, digest in identity |
| C9 | CI dispatch alternative dismissed too fast | both | medium / P2 | Accepted as a written comparison: a push starts the PR's paid lane and cancels it, so CI dispatch cannot measure unpushed fixes; Ubicloud kept |
| C10 | Local probe cannot prove the remote environment | Codex | P2 | Accepted: the probe runs first on the VM too; $0 real-path smoke before acceptance |
| C11 | Judges have no `--case` path | Codex | P2 | Accepted: `--case` takes judge ids through their selection command |
| C12 | E2E contradicts the baseline-skip rule | Codex | P2 | Accepted: the E2E's first red is unclassified, so the baseline is required; baseline-skip covered by a free test |
| C13 | Why did verified-pass reuse not stop #3033's reruns? | Codex | P2 | Answered: #3033 changed global touchfiles; the gate step now names reuse; this PR's own gate will rerun all |
| C14 | Collapse the 13-class taxonomy to ~6 routes | Claude | high | Accepted: 6 routes, fine tags as evidence |
| C15 | Probe vs client retries | both | medium | Accepted: retries forced to zero, stop at first armed session, slow-client negative control |
| C16 | Early cancel once BELOW is certain | Claude | low | Accepted |
| C17 | Ledger path with `/` | Claude | low | Accepted: `gstack-slug` branch |
| C18 | Diagnostic trials are good health data; show in history | Claude | medium | Deferred to TODOS.md (display-only column); conflicts with the brief's "never enter series history" unless Garry wants it |
| C19 | Generic adapter and Windows repeat exceed #3034 | both | high / P2 | User Challenge U1 (kept, narrowed, first cuts named) |

**Review sections 1-10 (condensed; each was examined against the amended plan).**

1. Architecture. New components: `eval-measure` CLI over `measure-bar` (pure), `measure-ledger` (state) and `measure-remote` (Ubicloud/local); they call existing `test-paid-shards`, `eval-store` and `ubi-runner`. Coupling added: the CLI reads eval-store records and pass-rate history; no existing module depends on the new ones except `/ship` prose. Rollback: revert the PR; `/ship` returns to STOP-on-red; ledgers under `.context/` are inert.
2. Error and rescue map: see registry below.
3. Security. New surface: API keys sent to a VM. Mitigation: `--pass` env forwarding (never argv), VM-scoped ephemeral SSH keys, owner-tagged VMs, destroy on every path. Fixture/model text reaching the PR body goes through `scripts/lib/published-text.ts`, as other report text does. No new dependencies.
4. Data flow and edge cases. Zero reds: loop not entered. One trial record missing: batch INCOMPLETE, never MEETS. Batch over deadline: collect marks it incomplete, destroys the VM, counts spend. Two reds in the same file: measured as separate cases, one VM each. Concurrent ships on one machine: ledgers keyed by branch slug, VMs by owner and batch.
5. Code quality. Three small modules plus a CLI under the size ratchet; the decision function is pure and table-tested; no duplication of `panelVerdict()` (the bar is a different question and says so).
6. Tests: see the Tests section; each new codepath has a free test, the loop has a paid E2E, the remote path has a $0 smoke.
7. Performance. The batch wall is one trial plus ~4 minutes of setup; the critical path is stated; parallel cases cost one VM each.
8. Observability. The ledger is the trace (every batch, VM, identity, spend and decision); `eval:measure status` prints it; the PR table is the durable record.
9. Deployment. Ships as a gstack release; no migration; the old behavior is the fallback for projects without an adapter.
10. Trajectory. Reversibility 4/5. The CLI is reusable by the off-ship sweep, which is the intended next step.

**Error and rescue registry.**

| Codepath | What can go wrong | Rescue | User sees |
|---|---|---|---|
| probe (local or VM) | 0 tests, wrong test, hang, missing record | fail fast at 120 s; treat as harness defect | "probe failed: <reason>; fix before spending" |
| start | Ubicloud quota, create failure, sync failure, image pull denied | quota: print `usage`; pull denied: build from Dockerfile.ci; other: destroy and report | the cause and the VM name, no partial batch |
| collect | missing sentinel past deadline, pull failure, SSH lost | mark batch incomplete, destroy VM, count spend | "batch b2 incomplete: <reason>; VM destroyed" |
| decide | missing records, mixed identities, unclassified reds | INCOMPLETE or refuse to pool, naming the field | the refusal and the next command |
| batch | > 30% pre-first-turn infra | void, one re-dispatch | both batches in the table |
| caps | estimate over cap, unknown cost | ask once with the estimate | one question with the ledger |
| gate | new red, 4th gate needed | loop again; ask at the gate cap | the predicted all-green line and reds so far |

**Failure modes registry.**

| Failure mode | Likelihood | Impact | Covered by |
|---|---|---|---|
| diagnostic trial pooled as verdict | low | high | three guards, frozen-reader test |
| weak case passes qualified bar | medium | medium | mechanical provider, citations, separate PR heading |
| repair weakens test | medium | high | contract mapping, kept negatives |
| leaked VM | low | medium | destroy on every path, dead-man, owner gc |
| VM env differs from CI | medium | medium | CI image, digest in identity, remote probe |
| endless gate treadmill | medium | high | gate cap, spend cap with gates, predicted all-green line |
| probe false failure from client retries | medium | low | retries zero, stop at first armed session |

**NOT in scope** and **Next**: as listed in the Implementation plan.

**Completion summary (CEO).** Mode SELECTIVE EXPANSION. Premises challenged: 4 (1 valid, 2 partly wrong and fixed, 1 raised as User Challenge). Findings: 19 (17 accepted, 1 deferred, 1 User Challenge). Expansions accepted in blast radius: gate cap and predicted all-green line, terminal states, contract mapping, CI image, judge `--case`, parallel file-mode trials, remote probe and $0 smoke. Deferred: diagnostic history column, off-ship sweep (Next). Spec review: adapted, the native CEO voice reviewed the full plan once in place of the separate 0H spec-review subagent loop.

<!-- autoplan-accepted:ceo -->
- Success is reported as gate runs, total spend including gates, and first-red-to-verdict time; tested by the ledger and E2E table assertions.
- Gate runs capped at 3 per ship; a fourth asks; the predicted all-green probability prints every ship.
- Terminal states MEETS, named red (stops the ship with needs-decision), over cap, gate cap; tested in the ledger test.
- `provider` is mechanical; `model-miss` requires a transcript citation; qualified MEETS listed separately; tested in the bar test.
- Repairs carry a contract mapping and keep known-bad negatives; enforced by the ledger; tested.
- Spend caps include gate runs and an unknown-cost reserve.
- Trials run inside the CI image; image digest in the pooling identity.
- `--case` supports standalone judges; file-mode trials run in parallel.
- Probe runs locally and on the VM, with client retries zero, stopping at the first armed session; $0 real-path smoke before acceptance.
- Six routes with fine tags; early cancel when BELOW is certain; ledger path uses the branch slug.
- E2E first red is unclassified so the baseline is required; baseline-skip covered by a free test.
<!-- /autoplan-accepted:ceo -->

### Phase 2: design review

Skipped: no UI scope (0 matches for view and rendering terms). Not a completed review.

### Phase 2.5: DX review (mode DX POLISH, autoplan override)

**Product type and personas.** A developer tool driven by an agent. Primary: the agent running `/ship` (Claude or Codex) that must follow the loop from skill prose and CLI output, across turn boundaries and machine sleep. Secondary: Garry, who reads the PR table and answers the rare cap or named-red question. Tertiary: a maintainer of another project with paid evals who wants the loop.

**Empathy narrative (the agent).** "The gate came back with one red, `cso-diff-mode`. Before, I had to decide on my own whether to push and rerun everything. Now I run `gstack-eval-measure status`: it shows one case, state `new`, Next `inventory`. Inventory tells me the red is an assertion with an Expected/Received pair. I classify it as a test assertion with the evidence line, write the replay test, `proof` records it, `probe` says the trial selects exactly that case, `start` prints a $6 estimate and a deadline at 3:40 PM PT and returns. I set a timer. When I wake, `collect` says 6/10, BELOW, Next: fix round. I fix the regex at the cause, `proof` again, `start` again: 10/10, MEETS strict. `status` says Next: gate. Nothing asked me a question, and the PR table writes itself."

**Developer journey.**

| Stage | Before this review | After |
|---|---|---|
| Discover | Step 6.3 prose names `bun run eval:measure` (gstack only) | `gstack-eval-measure status` works in any repo; `demo` shows the whole loop in under 2 minutes |
| Set up | Ubicloud failures surfaced mid-`start` | `doctor` checks credentials, quota, image tag, keys and `gh`, and names the backend |
| First result | `inventory --run <id>` needed a CI run id | `inventory` with no argument reads the gate run just recorded, CI or local |
| Daily loop | 9 subcommands, several enforced facts with no command to record them | each enforced fact has one recording command; `status` Next column; `--json` and exit codes |
| Failure | refusals named a field at best | reason code, cause, next command and troubleshooting anchor for every refusal; lost and void batches defined |
| Resume | undefined after sleep or restart | every operation keyed by loop and batch id and safe to repeat; `status` shows the recovery command |

**TTHW.** First meaningful output for a new maintainer: `gstack-eval-measure demo`, under 2 minutes, no keys (target met: under 5 minutes). First real measurement after a red on a configured gstack machine: about 2 minutes to a passing probe and estimate, then one batch wall (10 to 15 minutes). For another project: add the v1 block (template printed by `/ship`), run `doctor`, then the same loop.

**Dual voices: consensus table.**

```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?          no      no     CONFIRMED (no demo, no preflight, CI-only inventory)
  2. API/CLI naming guessable?         partly  partly CONFIRMED (missing recording commands, no --json/exit codes)
  3. Error messages actionable?        no      partly CONFIRMED (reason codes, lost batches, recovery)
  4. Docs findable & complete?         partly  partly CONFIRMED (worked example, adapter semantics)
  5. Upgrade path safe?                partly  partly CONFIRMED (--case behavior change, old hints)
  6. Dev environment friction-free?    no      partly CONFIRMED (ssh --pass does not exist; local jobs; Windows push)
```

| # | Finding | Voice | Severity | Disposition |
|---|---|---|---|---|
| D1 | CLI unreachable outside gstack | Claude | critical | Accepted: `bin/gstack-eval-measure` with the runtime-root prelude; ledger path must be ignored |
| D2 | Enforced facts have no recording command | both | critical / P2 | Accepted: `classify` flags, `proof`, `note`, `gate`, `approve` |
| D3 | `ssh` with `--pass` does not exist in `ubi-runner.sh` | Claude | critical | Accepted: new `env` subcommand, `docker run --env-file`, process-list test |
| D4 | Conflicting decision rules; E2E 7/10 vs EXTEND | Codex | P1 | Accepted: precedence rules; E2E 7/10 with detector reds is a fix round |
| D5 | No recovery contract for interrupted work | Codex | P1 | Accepted: idempotent operations, lost batches, pull-then-destroy with one retry |
| D6 | Adapter cannot supply per-trial semantics | Codex | P1 | Accepted: v1 block runs one trial per invocation; still the first cut (User Challenge U1) |
| D7 | `inventory` needs a CI run id and `gh` | Claude | high | Accepted: no-argument inventory, `--dir`, explicit auth message |
| D8 | No preflight | Claude | high | Accepted: `doctor`, implicit in `start` |
| D9 | No `--json` or exit codes | both | high / P2 | Accepted: command contract |
| D10 | Ledger lifecycle undefined | Claude | high | Accepted: loops, `reset --reason`, caps per loop |
| D11 | Refusals lack problem, cause, fix, docs | Claude | high | Accepted: reason codes and anchors |
| D12 | No five-minute path | Codex | P2 | Accepted: `demo` on the shared seeded fixture |
| D13 | Old hints keep teaching the old path | Codex | P2 | Accepted: red-line hints, bare `--case` notice, CONTRIBUTING row |
| D14 | "$0" and "free" hide VM charges | Codex | P2 | Accepted: "no model spend", VM time shown and counted |
| D15 | All-green and risk numbers overstate precision | Codex | P2 | Accepted: computed over the gate that ran, labelled; risk with sample size and Wilson upper bound |
| D16 | Captures not reviewer-accessible | Codex | P2 | Accepted: sanitized per-trial failure lines in `<details>`; captures kept 14 days |
| D17 | Terminology drift | Claude | medium | Accepted: glossary; two terminal states and two approval gates |
| D18 | `collect` timing left to the agent | Claude | medium | Accepted: PT deadline, wake hint, running exit code |
| D19 | 12-column PR table | Claude | medium | Accepted: 6 columns plus `<details>` |
| D20 | Ledger integrity, lock | Claude | medium | Accepted |
| D21 | Needs-decision report format | Claude | medium | Accepted: fixed plain-English template |
| D22 | Probe-unavailable behavior | Claude | medium | Accepted: void-batch check |
| D23 | Cap override, opt-out, backend flags, local jobs | Claude | medium | Accepted |
| D24 | Windows measurement needs a push | Claude | medium | Accepted: scratch ref `measure/<branch-slug>`; checked that no workflow triggers on non-main pushes |
| D25 | Scratch-ref CI as a paid backend instead of local | Claude | medium | Taste T1: kept Ubicloud as primary per the brief; a CI scratch-ref paid backend goes to TODOS.md |

**DX scorecard (before → after this phase).**

| Dimension | Before | After | Note |
|---|---|---|---|
| Getting started | 5 | 8 | demo and doctor; real runs still need Ubicloud and model keys |
| API/CLI design | 6 | 8 | one recording command per enforced fact, `--json`, exit codes |
| Errors and debugging | 5 | 8 | reason codes, recovery, lost vs void |
| Documentation | 6 | 8 | worked example, adapter v1 semantics, glossary |
| Upgrade path | 6 | 8 | `--case` change announced in its output and CHANGELOG |
| Environment and tooling | 5 | 8 | CI image, env file, local job sizing, Windows scratch ref |
| Community and ecosystem | 6 | 6 | internal tooling; the adapter is the only outside-facing part |
| Measurement and feedback | 6 | 8 | three success numbers per ship; the off-ship sweep is Next |
| **Overall** | **5.6** | **7.8** | |

**DX implementation checklist.** `--help` offline with one example per subcommand; `demo` under 2 minutes with documented output; `doctor` before any spend; `--json` and exit codes pinned in tests; every refusal has a reason code, cause, next command and anchor; `status` Next column; idempotent `start`; pull-then-destroy; adapter block template printed when absent; CHANGELOG entry for the `--case` behavior change.

<!-- autoplan-accepted:dx -->
- `bin/gstack-eval-measure` is the host-neutral entry; the ledger path must be ignored by git or the CLI refuses.
- Recording commands: `classify --route --tag --evidence`, `proof --test --negatives --contract`, `note`, `gate --run`, `approve --cap --usd --by`; tested.
- Command contract: `--json` shape and exit codes 0, 10, 20, 30, 40, 50, 2; reason codes with troubleshooting anchors; tested.
- `doctor` runs before spend; `inventory` without arguments reads the last gate run, with `--run`, `--dir` and `--cases`.
- Loops, `reset --reason`, ledger hashes and lock; idempotent `start`; lost batches are not rounds, keep their reserve and may be re-dispatched once; pull-then-destroy with one retry.
- Precedence rules for contract, pending-fix, strict-with-known-fix and evidence during EXTEND; tested; the E2E's 7/10 baseline goes to a fix round.
- `ubi-runner.sh env` writes a 0600 env file; trials use `docker run --env-file`; a test checks argv, logs, the VM process list and the docker invocation.
- Credential-free `demo` on the shared fixture; adapter v1 runs one trial per invocation; missing block prints the template.
- PR table: 6 columns plus `<details>` with sanitized failure lines; risk with sample size and Wilson upper bound; all-green over the gate that ran.
- "No model spend" wording; VM time counted toward the loop cap; Windows measurement on a scratch ref.
<!-- /autoplan-accepted:dx -->

### Phase 3: Eng review (always last)

**Scope challenge, grounded in code.** Read: `scripts/test-paid-shards.ts` (`--case`, lines 808-896), `scripts/lib/paid-report.ts` (`caseSelection`, `runCaseDiagnosis`, `afterRepairCommand`), `test/helpers/eval-store.ts` (trial schema and validator), `test/helpers/session-ledger.ts` (rows written at session end), `scripts/eval-flake-rank.ts` (`--dir` import, `trial-outcomes*` glob), `scripts/eval-trial-series.ts` (`git ls-files -s` identity), `scripts/e2e-shard-reuse.ts`, `test/helpers/workflow-judge-cache.ts`, `scripts/ubicloud/ubi-runner.sh` (`down`, `sync`, `pull`, `run --pass`), `.github/workflows/evals.yml` and `windows-free-tests.yml` triggers, `.github/docker/Dockerfile.ci`. Complexity check: about 30 files touched and 6 new modules, above the 8-file threshold; per the autoplan override the scope is not reduced, and each new module owns one concern (decision, ledger, remote, adapter, CLI, fixture). The first cuts if the PR stalls stay as listed in Files.

**Architecture.**

```
                    ship/sections/tests.md.tmpl (Step 6.2 pointer, Step 6.3 loop prose)
                                         |
                              bin/gstack-eval-measure
                                         |
                              scripts/eval-measure.ts (CLI, --json, exit codes)
               ______________________/   |    \______________________________
              /                          |                                    \
  lib/measure-bar.ts            lib/measure-ledger.ts                 lib/measure-remote.ts ----> ubi-runner.sh (ported, env)
  (pure: bar, precedence,       (.context ledger, lock, loops,          |   \--> scripts/ci/paid-trial-env.sh <-- evals.yml
   identity, risk, early stop)   caps, reason codes)                    |         (inside the CI image, --user runner)
              \                          |                              v
               \                         |                 scripts/test-paid-shards.ts --case/--probe
                \                        |                              |
  lib/measure-adapter.ts (v1 block)      |                 lib/paid-report.ts runCaseDiagnosis (parallel, judges)
                                         |                              |
                       eval-diagnostics/<loop>/<batch>/  <--- runners (probe line, retries env) + eval-store (purpose)
                       diagnostic-trials.jsonl (own schema)        |
                                         X  never  ---> trial-outcomes*.jsonl, pass-rates series, judge/E2E receipts
```

**Codepath-to-test map.**

| Codepath | Test |
|---|---|
| bar, precedence, pooling, stale MEETS, risk | `eval-measure-bar.test.ts` |
| ledger, lock, loops, caps per ship, per-trial classify, proof, reason codes, `--json`, exit codes | `eval-measure-ledger.test.ts` |
| probe across four runners and the judge caller, file mode, #3033 negatives | `eval-measure-probe.test.ts` |
| remote: env file, docker `--env-file`, `down`/`pull` fixes, manifest, image tag, sweep, isolation | `eval-measure-ubicloud.test.ts` |
| gate adoption, no double gate, reservation | `eval-measure-gate.test.ts` |
| labelling and reuse isolation, full legacy import | `eval-measure-labelling.test.ts`, `eval-measure-isolation.test.ts` |
| demo and adapter v1 | `eval-measure-demo.test.ts` |
| skill prose | `ship-measure-loop.test.ts` |
| workflows | `free-tests-workflow-wiring.test.ts`, `evals-workflow-wiring.test.ts` |
| whole loop with an agent | paid E2E `ship-measure-fix-loop` |
| real VM path | $0-model real-path smoke, log in the PR |

The test plan artifact is at `~/.gstack/projects/garrytan-gstack/garrytan-ship-measure-fix-loop-plan-eng-review-test-plan-20261006.md`.

**Dual voices: consensus table.**

```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Architecture sound?               partly  no     CONFIRMED (gate double-launch, CI fidelity, identity)
  2. Test coverage sufficient?         partly  partly CONFIRMED (probe signal, gate accounting, legacy import)
  3. Performance risks addressed?      no      partly CONFIRMED (vCPU per trial, rate limits)
  4. Security threats covered?         partly  partly CONFIRMED (env file format, adapter secrets, workflow input)
  5. Error paths handled?              partly  no     CONFIRMED (down/pull false success, void rule, needs-classify)
  6. Deployment risk manageable?       yes     partly CONFIRMED with caveat (HARNESS_VERSION inertness)
```

| # | Finding | Voice | Severity | Disposition |
|---|---|---|---|---|
| E1 | Push plus `eval:bg:pr` launches two gates; caps checked after spending | both | high / P1 | Accepted: `gate` is the only push path, adopts the `pull_request` run, reserves first, counts every run from `gh` |
| E2 | VM runs ~1.6 vCPU per trial vs CI's 4 | Claude | high | Accepted: standard-16 with 4 trials each; vCPU in identity |
| E3 | CI image alone is not CI (root user, cached deps, builds, Codex auth) | both | high / P1 | Accepted: shared `scripts/ci/paid-trial-env.sh`, `--user runner` |
| E4 | Identity hashes the index, not working bytes; `.git` sync breaks linked worktrees | Codex | P1 | Accepted: frozen tree via temporary index, `git archive` to a fresh repo |
| E5 | Live-tree edits race parallel batches | Claude | medium | Accepted: same frozen tree |
| E6 | Shared fixes make other cases' MEETS stale | both | high / P1 | Accepted: stale on case-owned bytes; shared-input mark otherwise |
| E7 | Strict exception contradicts "MEETS on latest inputs" | Codex | P1 | Accepted: the known fix is made and the case measured once more |
| E8 | `--env-file` cannot read `export K=%q` lines | Claude | high | Accepted: separate Docker-format 0600 file, tested with real docker |
| E9 | `collect` would EXTEND before failures are classified | Claude | high | Accepted: needs-classify state |
| E10 | No session-armed signal; retries not overridable; file-mode cardinality | both | high / P1 | Accepted: probe line under `GSTACK_PROBE_FILE`, `GSTACK_EVAL_CLIENT_RETRIES`, file-mode rule, four runners tested |
| E11 | Judge receipts and legacy eval-JSON import bypass the labels | Codex | P1 | Accepted: disabled at owners; structural filename/schema; full import pipeline tested |
| E12 | Void rule would discard harness defects as outages | Codex | P1 | Accepted: void needs affirmative provider evidence |
| E13 | Free-shard replay conflicts with the plan validator and retries | Codex | P1 | Accepted: diagnostic plan type, retries off, first attempts only |
| E14 | `down` reports success after a failed destroy; empty `pull` succeeds | Codex | P1 | Accepted: fixed in the port; tested |
| E15 | Per-trial classification and revision-bound proofs | both | medium / P2 | Accepted: `classify --trial`, `proof` records both trees |
| E16 | Some reds have no measurable case | Codex | P2 | Accepted: case, file and run targets |
| E17 | Cap contradictions and `reset` bypass | Claude | medium | Accepted: measurement caps in dollars, gates by count, per ship across reset, gate 1 is the red gate |
| E18 | Rate limits at 10x load | Claude | medium | Accepted: per-key session cap; 429 voids |
| E19 | Lost SSH keys; halted VMs may bill | Claude | medium | Accepted: state under the state root, coordinator sweep; halted-VM billing flagged as unverified |
| E20 | Early cancel needs a driver | Claude | medium | Accepted: VM-side early stop |
| E21 | Stale lock | Claude | medium | Accepted |
| E22 | Adapter on VMs and secrets; id injection | Claude | medium | Accepted: bare VM with `setup:`, `secrets:` allowlist default none, id regex |
| E23 | Three copies of `ubi-runner.sh` | Claude | low | Accepted: replace wholesale with the skill copy |
| E24 | Adapter tree hash changes with outputs | Claude | low | Accepted |
| E25 | `refusal` is not mechanical | Claude | low | Accepted |
| E26 | Gate accounting test, parallel file-mode isolation, E2E preconditions, injectable wall, receipt guard | Claude | medium/low | Accepted |
| E27 | Windows `files` input injection; scratch ref leak; capture retention; approval forgeability | Claude | medium/low | Accepted: `env:` passing, sweep, 14-day sweep, honest tripwire wording |
| E28 | Image tag hash and fork builds; HARNESS_VERSION fallout; `paid-report.ts` size; last-gate pointer; exit 20 ambiguity | Claude | medium/low | Accepted: tested hash, slow-build estimate, inert-by-env changes with the `--bump` fallback stated, logic in `measure-*`, Step 6.2 pointer, prose branches on `--json` state |

**Performance.** The batch wall is one trial plus about 4 minutes of VM and image setup when the image is published; a 10-trial batch uses 3 standard-16 VMs (48 vCPU) for that time; the slowest path is an unpublished image build. Memory and storage are bounded by one archive per batch.

**Failure modes with critical gaps.** None left open after the dispositions above. Two residuals are named rather than closed: halted-VM billing on Ubicloud is unverified (the coordinator sweep, not the dead-man switch, bounds cost), and HARNESS_VERSION inertness is a claim the implementation's review must confirm.

**NOT in scope (eng).** A paid measurement workflow on scratch refs (TODOS.md alternative), diagnostic trials in history, any `EVAL_POLICY` change.

**Completion summary (Eng).** Findings: 28 groups from two voices, all accepted or folded; 0 open critical gaps; 2 named residuals. Test plan written to disk. TODOS.md items to add in the implementation PR: off-ship qualification sweep; scratch-ref CI measurement backend; display-only diagnostic history column.

<!-- autoplan-accepted:eng -->
- `gate` is the only push path while a loop is open; it reserves the estimate, adopts exactly one run for the head SHA (the `pull_request` run when a PR exists), and counts every `evals.yml` run for the branch from `gh`; tested with a stub `gh`.
- Measurement runs on a frozen tree (temporary index, `git write-tree`, `git archive` into a fresh repo); the identity comes from that tree; vCPU per trial, image digest and the per-key session cap are in the identity.
- `scripts/ci/paid-trial-env.sh` is shared by `evals.yml` and the VM backend; trials run as `runner` at 4 vCPU per trial (standard-16, 4 trials each).
- MEETS goes stale when case-owned bytes change; shared-input changes add a mark and leave the check to the gate; a strict MEETS with a known defect gets the fix and one more batch.
- `decide` returns needs-classify for unreviewed sub-strict failures; `classify --trial` records are immutable; `proof` runs the check on both trees.
- Probe: a probe line under `GSTACK_PROBE_FILE` in the four runners and the judge caller, `GSTACK_EVAL_CLIENT_RETRIES=0`, file-mode cardinality rule, injectable wall; all harness changes inert unless their variables are set, recorded `--non-behavioral` or else `--bump` with the consequence stated.
- Diagnostic runs never look up or publish judge or E2E receipts; diagnostic `EvalResult` files are structurally rejected by the legacy import; tested through the full pipeline.
- Void needs affirmative provider or transport evidence; mid-session 429s count; `refusal` is not mechanical.
- Free-suite measurement uses a diagnostic plan type with retries off and first attempts only; Windows inputs pass through `env:`.
- `ubi-runner.sh` is replaced by the skill copy plus `env` (Docker-format 0600 file) and fixed `down`/`pull`; VMs past deadline are swept by the coordinator; runner state lives under the state root.
- Caps: measurement $30 batch, $60 case, $150 ship; gates capped at 3 per ship counting the red gate; per branch across `reset`. This replaces the CEO block's "$250 including gates" and its listing of over cap and gate cap as terminal states (they are approval gates).
- Adapter: bare VM with `setup:`, `secrets:` allowlist defaulting to none, case-id regex, outputs ignored.
<!-- /autoplan-accepted:eng -->

Superseded wording in earlier accepted blocks (blocks are immutable, so the replacement is stated here): the DX block's `gate --run` and `approve --by` became `gate` (adopts the run itself) and `approve --question`; the CEO block's "stopping at the first armed session" became the explicit probe line; "VM time counted toward the loop cap" became the ship's measurement cap.

### Phase 4: final approval gate

**Decision audit trail (auto-decisions).**

| # | Phase | Decision | Classification | Principle | Rejected |
|---|---|---|---|---|---|
| 1 | 0 | Design phase skipped (0 UI term matches) | mechanical | scope rule | running design review |
| 2 | 0 | DX phase run (developer tool, agent-primary) | mechanical | scope rule | skipping DX |
| 3 | 0.5 | Codex CLI installed and logged in with the API key for the outside voice | mechanical | P6, Garry's standing Codex setup | single-model review |
| 4 | CEO | Mode SELECTIVE EXPANSION | mechanical | autoplan override | other modes |
| 5 | CEO | Accept gate cap, success metrics, terminal states, contract mapping, CI image, judge `--case`, parallel file mode, remote probe | mechanical | P1, P2 (blast radius) | leaving them out |
| 6 | CEO | Defer the diagnostic-history display column | taste | P3; the brief says never enter series history | shipping it now |
| 7 | CEO | Keep and narrow the generic adapter and Windows repeat | user challenge U1 | brief's direction stands | cutting them |
| 8 | DX | Mode DX POLISH; accept all DX critical and high findings | mechanical | P1, P5 | |
| 9 | DX | Keep Ubicloud as the paid backend; scratch-ref CI backend to TODOS.md | taste T1 | brief's infrastructure lesson | CI scratch-ref backend now |
| 10 | Eng | Never reduce scope; accept all eng findings | mechanical | autoplan override, P1 | |
| 11 | Eng | Split caps: measurement in dollars, gates by count | taste T2 | P5 explicit | one combined dollar cap |
| 12 | Eng | Shared-input changes mark MEETS instead of forcing re-measurement | taste T3 | P3 pragmatic | re-measure every case on any shared change |
| 13 | Eng | Strict MEETS with a known defect: fix it and measure once more | taste T4 | repair-in-this-PR preference | leaving the defect, or fixing without re-measuring |
| 14 | Close | Strip the snapshot tool's baseline-edit records from the committed doc | mechanical | readability; they duplicate the plan text | committing ~280 KB of single-line comments |

**User challenges (both voices agreed to change the stated direction).**

- **U1: cut the generic non-gstack adapter and the Windows repeat dispatch from this PR.** You said: the loop is generic over a project's eval command, and Windows lanes use a `workflow_dispatch` of `windows-free-tests.yml`. Both CEO voices and the DX outside voice recommend cutting them: #3034's pain is gstack's paid gate, other projects rarely have paid LLM evals with costs, and an adapter that guesses semantics would be unreliable. What we might be missing: Garry may want gstack's /ship to work for other repos now, and Windows flakes did cost #3033 time (Bun 1.4.0). If wrong: cutting delays both by a wave; keeping costs about 6 files and one versioned block format. Your direction stands: both are kept, narrowed (an explicit versioned block that runs one trial per invocation, never guessing; a diagnostic plan on a scratch ref), and named as the first cuts if the PR stalls.

**Taste choices.** T1 Ubicloud over a CI scratch-ref backend for paid trials (alternative recorded); T2 separate measurement and gate caps; T3 marking rather than re-measuring on shared-input changes; T4 fix-and-remeasure for a strict MEETS with a known defect.

**Phase coverage.**

| Phase | Host | Native voice | Outside voice (Codex) | Consensus |
|---|---|---|---|---|
| CEO | Capy (Claude) | completed, 18 issues | completed, 7 findings | 5 of 6 confirmed, 1 single-voice |
| Design | skipped, no UI scope | n/a | n/a | n/a |
| DX | Capy (Claude) | completed, 24 issues | completed, 8 findings | 6 of 6 confirmed |
| Eng | Capy (Claude) | completed, ~30 issues | completed, 11 findings | 6 of 6 confirmed |

Capy adaptations: native voices ran as Capy subagents given the snapshot tool's dispatch prompts verbatim; Claude Code's phase-publication hooks do not exist in Capy, so phase gates were followed but not hook-enforced; phase reports were sent as progress messages in the Capy thread; the CEO spec-review loop was folded into the native CEO voice (one review, not up to three launches); per-phase task JSONL files were not written, because the Files and ownership list is the task list. The final approval question goes to Garry through the parent thread.

Status: awaiting Garry's approval.
