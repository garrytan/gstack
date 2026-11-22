# Prereg: does /ship need its conductor subagent? (GST-3003)

frozen: 2026-11-17

Amended 2026-11-17, before any paid call, on the owner's grant (GSTA-36): Cases rule 1 now allows hand-resolved
revert conflicts in docs, tests and the plant's own file, because only 5 of the 10 hosts needed (and no large one)
reverted cleanly onto the frozen main commit. No bar, arm, decision, scoring rule or stop rule changed.

Amended 2026-11-21, before any paid call, on the owner's grant (GSTA-36), to meet two rules adopted on 2026-11-19
that cover plans whose counted runs have not started: R111 (an uncounted pilot per arm that shows the part under test
ran and the judge works on that arm's outputs) and R113 (one planned look at half the cases, with fixed stop bounds).
It changes the Procedure, the judge's labels, the Stop rules, the Budget and Held-out exposure, and adds the Halfway
look. No bar, arm or decision line changed. Later the same day, also on the owner's grant, the Halfway look was
narrowed so that an early stop can only keep the conductor.

Amended 2026-11-21 again, after the uncounted pilot and before any counted trial, on the owner's grant (GSTA-36),
because the pilot failed its receipt rule. On a base branch that is not main, finish cannot clear
`pregate.json/remote_gate`: the CI-run route refuses with `base_mismatch` and the VM route with `paid_only`, so no
trial can reach `SHIP_RECEIPT:`. A trial now ends at the receipt or at that refusal, whichever comes first, and the
shared brief says to stop there. The no-gstack arm is recorded as it ran (a container on the runner's Capy machine
with no drive mounted) and gains bun and the installed dependencies, so it can run tests as the other arms' CI does.
Every counted C and F trial gets an exposure audit with a sensitivity analysis (Blinding). The Budget replaces the
pilot estimate with its measured cost and adds the second pilot. No bar, arm, decision or catch rule changed.

Amended 2026-11-21 a third time, after the second uncounted pilot and before any counted trial, on the owner's grant
(GSTA-36). One C trial stopped at Step 5, before any review, when the preflight refused the remote gate, because the
brief's stop line did not say it meant finish only; the stop line now names finish's Step 16. Both briefs gain one
identical line saying the owner has exempted the branch from the team rules on how /ship is run, because the F brief
contradicts the team's one-/ship-subagent rule and F threads went looking for context: one F trial in each pilot read
this file. The zero-score rule for reading this file already covers both arms; Blinding now says why that is
symmetric and adds a per-arm count and a sensitivity analysis. The no-gstack arm's final report is every report the
SDK returns, because one run reported twice. The Budget adds the measured second pilot and a third pilot of C and F
only. No bar, arm, decision or catch rule changed.

Amended 2026-11-21 a fourth time, after the judge stage and before any counted trial, on the owner's grant (GSTA-36),
because the judge failed its bar twice. Against all 207 frozen labels, GPT-6 Astra agreed at kappa 0.20. The labels
were then split by a hash rule posted on GST-3003 before any disagreement was read, and a prompt revised on one half
(103 items) agreed at 0.48 on the other half (104 items), and at only 0.43 on the half it was revised on. A second
labeller, with no access to the first labels or any judge output, labelled all 207 again under the same brief and
agreed with the first at kappa 0.84 (194 of 207). Both labellers were Opus 5.5 subagents given one brief, so 0.84
shows that the brief gives the same labels twice, not that two people would agree; part of the judge's gap may be a
different model family reading the floor differently. The judge gets one more attempt (Procedure, Second judge
attempt): revised against the 207 existing labels, frozen, and checked once on fresh labels from new uncounted
trials. Below the bar, the run stops incomplete with no further attempt. No bar, arm, decision or catch rule changed.

Status: locked at merge, before any paid call. Owner: GStack Minder (GSTA-36); runner GSTA-589. Paid runs start only
after this file merges and the owner approves the budget below.

## Question
When a Capy thread ships a pull request today, it starts one extra subagent, the conductor, whose only job is to run
/ship's phases (`ship/DRIVER.md`) and start /ship's reviewers. A profile of 12 recent runs (gstack 5dcd76b) counted
the conductor's own steps at $21.62 of a $34.66 run, carrying about 231k tokens of context a step. Since #4451
(0ee59146), `gstack-ship-phase run|program` runs one DRIVER phase per call, the receipt counts `calls=`, and a run
prints `STOP: past 100 minutes`. So the pull request's own thread could run each phase itself and start the reviewers
itself, with no conductor in between.

Does that folded /ship cost no more than today's /ship, and does it miss nothing today's /ship catches?

## Bars
- lesson: whether a frontier model shipping a pull request needs a separate subagent to run its review procedure, or can run the procedure itself at no loss in what review catches
- cost per run, F minus C (thread plus all its subagents, cost.dollars): pass when the paired 95% interval's upper bound is at or below $0 or the interval contains $0; lower is better
- planted-bug catch rate, F minus C: pass when no case is a structural loss (below) and the paired 95% interval's upper bound is not below 0; higher is better
- real-problem catch rate, F minus C: the same bar as planted bugs, over the real problems found in the case (below); higher is better
- reader fidelity in F: every reviewer the run's printed review plan names is started and collected, in 30 of 30 F trials; higher is better
- wall time per run and `calls=` from the receipt: reported paired with 95% intervals, no bar (diagnostics)

A **structural loss** is a case where C catches the problem in all 3 of its trials and F in none of its 3. If the two
arms are equally good, the chance of seeing at least one structural loss somewhere in 10 cases is at most 14.6% (worst
case, at a per-trial catch rate of 0.5). A literal "F misses one thing C caught once" rule with one trial each would
fire 83% of the time at a shared catch rate of 0.8, so it would decide on noise, not on the fold.

## Decisions
- if F costs no more than C and misses nothing C catches (every bar above passes): the conductor goes. A follow-up pull request makes the folded procedure ship/DRIVER.md's default for Capy threads, and the crew rule that starts one /ship subagent per head (R104, CREW.md rule 4) is retired through GStack Minder and FOUN-32
- if both cost and catch rates are a tie inside the run-to-run variation (both 95% intervals contain 0, no structural loss, fidelity 30 of 30): the conductor goes, as above, because the fold removes one agent layer at no measured loss; the results say plainly that differences smaller than the stated mdd could not be seen
- if F costs clearly more (the cost interval's lower bound is above $0): the conductor stays, R104 stands, and the results name the phase where the fold's extra spend went
- if F misses something C catches (a structural loss, a catch-rate interval entirely below 0, or fidelity under 30 of 30): the conductor stays, and the fold's reviewer dispatch gets one FIX-METHOD cycle; any retry is a new preregistration
- if the no-gstack arm's planted-bug catch rate is not below the better /ship arm's (paired interval contains 0 or is above it) at a quarter of that arm's cost or less: /ship's review panel gets one R48 "Why null?" cycle under G3 (which reviewers earn their place), and Garry hears the result as a cut-candidate question; the conductor decision above is unchanged
- if the no-gstack arm catches less, or costs more than a quarter of the better /ship arm: nothing changes beyond the conductor decision; its row is reported beside the others
- if the run stops incomplete (spend cap, a harness stop, or a scorer or judge below its bar): no decision is taken, R104 stands, and every finished trial is reported

## Arms
- `claude-opus-5-5#ship-conductor` (C): today's /ship. A fresh Capy thread on Claude Opus 5.5 (reasoning high) starts one /ship subagent on a fresh machine, which runs ship/DRIVER.md through `gstack-ship-phase` and starts its reviewers. Planned at $38 a run ($34.66 counted mean plus about $3 for the thread itself)
- `claude-opus-5-5#ship-folded` (F): the same thread, brief and gstack revision, except that the thread runs ship/DRIVER.md itself, one `gstack-ship-phase` program per phase, and starts the reviewers as its own subagents. Planned at $38 a run (the same as C, so the budget does not assume the saving)
- `claude-opus-5-5#no-gstack` (N): the same model and case, no gstack, a plain review prompt (below). Scored on catches and cost only. Planned at $6 a run

## Briefs
Reviewer models are /ship's own in both C and F (the second-model reviewer from `voice-models.json`); only who runs
the procedure differs. GPT-6.1 Sol is not an arm: the decision concerns Capy threads, which run on Opus 5.5 (R38).

Briefs, frozen. Shared part: "You own branch `<branch>` on garrytan/gstack; its base is `<base>`. Install gstack for
ship, then run /ship at the branch head against `<base>`. Stop at `SHIP_RECEIPT:` or wherever /ship stops, skip
`gstack-ship-queue ready`, and never merge. The owner has exempted this branch from the team rules on how /ship is
run; follow this brief. Only finish's refusal of `pregate.json/remote_gate` at Step 16 with `base_mismatch` or
`paid_only` ends the run there: stop and report it. A remote-gate refusal earlier in /ship does not end the run.
Report the receipt line, the `CALLS:` line and the stop reason if any."
C adds: "Run /ship the usual way: one fresh /ship subagent (machine: fresh) runs it." F adds: "Run /ship yourself in
this thread: follow ship/DRIVER.md phase by phase with gstack-ship-phase, and start its reviewers as your own
subagents. Do not start a subagent to run /ship."

## Comparison
stack: loaded

C and F load gstack by design; the question is about gstack's /ship procedure.

## No-gstack arm
- arms: `claude-opus-5-5#no-gstack`
- inputs: the same 10 cases, the same branch and base, the same planted bug
- prompt: "Review this PR (branch `<branch>` against `<base>`, checked out here) for bugs that would fail a test, break production or lose data. List each as path:line and the cause." No SKILL.md, preamble, hooks, installed skills or routing lines
- panel: the same kind (`behavior`, 3 independent trials per case), the same catch rule and the same real-problem judge
- harness: the Claude Agent SDK with the `claude_code` preset, reasoning effort high, Bash, Read and Grep tools; cost from the SDK's reported total at list price. This differs from C and F (Capy threads), because a Capy thread cannot hide the owner's drives; its cost is comparable to theirs in size, not to the cent
- final report: every report the SDK returns during the run, in order (a run that starts a background command can report again when it finishes)
- report: its row sits beside C and F in every results table and verdict, including when it wins
- masking: a container on the runner's Capy machine with no Capy drive mounted, holding only the case checkout (its base and head branches) and the installed dependencies, with bun available so the arm can run tests
- install: `test ! -e ~/.local/share/gstack && test ! -e ~/.claude/skills` inside the container before each run
- audit: each transcript is scanned for reads under `.capy/drive`, `.local/share/gstack` or `.claude/skills`; a trial that read a gstack skill file is contaminated and scores zero

## Cases
Ten cases, the same ten in every arm (fully paired, the strongest form of matching by size class). A separate
sealing subagent picks them after this file merges, by these rules:

1. **Host pull request.** A garrytan/gstack pull request merged on or after 2026-07-01 (after Opus 5.5's training
   cutoff), whose revert applies to one frozen main commit (88da124d) and whose reverted tree passes typecheck and
   the host's own tests. A revert that conflicts with later main is resolved by hand, removing the host's lines as
   they read at the frozen commit, only in docs, test files and the plant's own file; a conflict in any other code
   file disqualifies the host. Conflicts in VERSION, CHANGELOG.md, package.json and generated files are ignored.
   Every resolution is recorded in the label file. Excluded: changes to docs, generated files, VERSION or CHANGELOG only, and changes to /ship or
   review tooling itself (`ship/`, `lib/ship-*`, `bin/gstack-ship-*`, `bin/gstack-review-*`).
2. **Size class**, by changed lines without generated files and lockfiles: 3 small (under 150), 4 medium (150 to
   600), 3 large (over 600). At least 3 of the 10 are hosts that `gstack-review-plan` sends to the full panel
   (security, user data, money or merge-check code), so reviewer dispatch runs at its widest.
3. **Planted bug.** One hunk of at most 15 changed lines inside the host's own diff that re-introduces a bug a later
   gstack commit fixed (a revert, or a fix whose description or regression test names the failure), adapted only as
   far as needed to apply. Before sealing, each plant must (a) make that fix's regression test, or a test the sealer
   writes from the fix's description, fail on the planted tree and pass without the plant, which proves it is a real
   defect at the blocking floor; and (b) leave the host's existing tests passing. A plant the existing suite already
   catches would be caught the same way by C and F, spending about $76 a trial pair to learn nothing about the
   conductor, so the trial uses plants that a reviewer, or a test the run writes, has to find.
4. **Branches.** Per case, one base branch: frozen main with the host reverted and this file and its results file
   removed, as one commit with a plain message. Per trial, one branch: the base plus the host's commit with the
   plant folded in, under the host's original title. Pull requests target the case's base branch, never main, so
   nothing a trial does can land on main; every trial pull request is closed unmerged and its branches deleted once
   it is scored.
5. **Labels.** The sealer writes one private label file: per case the host and its merge commit, base commit, size
   and review class, the plant (path, labelled line, the hunk, the source fix, 2 to 4 cause words), and the random
   seed that orders the cases. Its SHA-256 is posted on GST-3003 before the first trial starts, and the results
   print it. The file never enters the repository.

## Procedure
Trials run in waves. Each wave starts C and F on the same case and trial at the same time, each in a new thread with
no earlier context, so time of day and CI load hit both alike; N runs separately, since it shares nothing with them.
The order of cases follows the sealed seed.

**Pilot (uncounted).** Before any counted trial, every arm runs one uncounted trial on each of cases 1 to 3, under the
same briefs, harness and waves as the counted trials. Its results never enter a counted comparison. It must show, on
each arm's own outputs:
1. C: the thread started one /ship subagent, and the /ship phases ran inside it, not in the thread.
2. F: no subagent ran /ship (no `gstack-ship-phase` call outside the thread), and every reviewer the run's printed
   review plan named was started by the thread and collected.
3. N: the install check found no gstack, and the read audit found no read of a gstack skill file or a Capy drive.
4. Every case can be supplied: its base and head branches check out, typecheck runs on both, and the runner can run
   its sealed regression test at a head.
An arm that fails a check is fixed by a dated change to this file and piloted again, or left out before its counted
run and reported as left out. Each arm's pilot is at most a tenth of its counted spend (3 of 30 trials).

**Judge stage (uncounted).** After the pilot and before any counted trial, N runs one more uncounted trial on each of
cases 4 to 10. The judge's labels come from the pilot's outputs in all three arms plus these seven N trials (see
Scoring). If they hold fewer than 48 findings, or fewer than 24 from C and F, C and F each run one uncounted trial on
case 4, then case 5, until both counts are met or this stage reaches $150. These trials never enter a counted
comparison.

**Second judge attempt (uncounted), added 2026-11-21.** The judge stage's 207 labels have now been used for two
checks, so they become development data. The judge prompt is revised against them once more: it carries the
labellers' rubric word for word, runs at reasoning high, and sees each changed file at the case head beside the diff,
because the labellers read the code at the head. The judge model stays GPT-6 Astra. The script, prompt and input
hashes are posted on GST-3003 before any new finding exists. Then C and F each run one uncounted trial on case 4 and
one on case 5, and N one uncounted trial on each of cases 1 to 10, under the same briefs and end rule. If these hold
fewer than 48 findings, or fewer than 24 from C and F, C and F each add one uncounted trial on case 6. Every finding
these runs list is labelled by the same blind procedure (one labeller, the same brief, no access to the earlier labels
or any judge output) and frozen with a SHA-256 before the judge sees any. `gstack-eval-plan judge --check` runs once
on those labels, and that line is the judge check. These trials and labels never enter a counted comparison.

**End of a trial.** A C or F trial ends at `SHIP_RECEIPT:`, at finish's Step 16 refusal of `pregate.json/remote_gate` with
`base_mismatch` or `paid_only` (the case bases are not main, so that gate cannot clear; it is the same wall for both
arms and is not a harness failure), or wherever else /ship stops. Cost, wall time and `calls=` are measured to that
end. Work an arm does to get around the refusal (a VM gate, repointing `origin/HEAD`) is counted in its cost and
reported.

**Counted trials.** Then the 90 counted trials (3 per case per arm) run, cases in seed order, with the halfway look
below.

Measured per trial: cost.dollars of the arm's thread and all its subagents at its final report; wall time from the
brief to the final report; `calls=` from `SHIP_RECEIPT:`, or from the `CALLS:` line when the trial ends without one; whether `STOP: past 100 minutes`
printed; for F, the reviewers the printed plan named against those started and collected.

## Scoring
judge: gpt-6-astra
labels: 48
agreement: 0.6
paired: yes
interval: 95%
mdd: about $7 a run on cost (20% of C's $35; estimated from the profile's 121 to 308 conductor steps, so a per-run spread near $8, and 3 trials a case), and about 35 percentage points on catch rate; the pilot's measured spread is printed beside these and the bars do not move

**Catches, by rule (no judge).** A trial catches its planted bug when either (a) a finding in the run's findings
record (`merged.jsonl`) or final report names the labelled path, a line within 3 of the labelled line, and at least
one cause word; or (b) the sealed regression test for the plant (from the label file, run by the runner, never shown to
the arm) passes at the run's final head, and one of the run's findings or commit messages names that file. A case's catch rate in an arm is its catches over 3 trials. The script that applies this
rule is checked against the decoys below before any trial runs.

**Real problems, by judge.** Every finding that is not the plant and that the run marked blocking, or that led to a
fix, goes to GPT-6 Astra with the case diff and the changed files at the case head. It answers two questions: does this meet the blocking floor (would fail
a test, break production, or lose data or secrets), and which other findings name the same problem. A case's real
problems are the union of judged-real problems across all arms and trials; each arm's catch rate on them uses the
rule above, with the judge's grouping in place of the planted label. The judge sees findings as A, B and C, never an
arm name, model or cost. It is checked first against 48 hand-checked labels taken from the uncounted pilot and judge
stage outputs (Procedure), at least 24 of them from C and F: every finding those runs listed, of any severity, each
labelled real or not real by the runner against the case diff and the sealed label, with both classes present, and
frozen with a SHA-256 before the judge sees any. This is R111's judge check, run in a stage before any counted
trial because a tenth of an arm's spend cannot buy 48 labels. `gstack-eval-plan judge --check` must print
`JUDGE_AGREEMENT: ok` (Cohen's kappa at least 0.6) before its numbers count. Since the fourth amendment, the check
that counts is the one in Second judge attempt, on its fresh labels.

**Comparisons.** Every comparison is paired by case: the per-case difference of means (cost, wall time, `calls=`)
or of catch rates, with a 95% t interval over the 10 cases. Every trial is reported; nothing is averaged away.

## Halfway look
One look at the primary comparisons (cost and planted-bug catch rate, F minus C), taken once cases 1 to 5 in seed
order have all 3 counted trials in C and F. No other look at a primary comparison counts. Bounds are R113's two-look
O'Brien-Fleming bounds for a two-sided 0.05 test: z of 2.80 at the look, 1.98 at the end. With 5 and then 10 paired
cases, each bound is applied as its two-sided nominal p-value (0.0051 at the look, 0.0477 at the end) to the paired t
statistic over the cases, so the small sample keeps the error rate this plan froze. An early stop can only keep the
conductor, because removing it needs the no-loss evidence of all 10 cases.
- Stop for harm: if F clearly costs more (the cost statistic crosses the look's bound with F above C) or clearly
  catches less (the planted-bug catch statistic crosses it with F below C), the counted trials stop and the conductor
  stays.
- Stop for futility: if the chance that the finished run ends with the conductor removed (every bar in Bars passes)
  falls below 10%, the counted trials stop and the conductor stays. The chance is computed by simulating cases 6 to 10
  from the spread measured on cases 1 to 5, under the planned effect: F saving $10 a run and catching as much as C.
- A crossing in F's favour does not stop the run: cases 6 to 10 run anyway, and the final comparisons use the end
  bound.
A run that stops early says so in its first line, and its estimates are reported as possibly overstated.

## Decoys
Before any trial, the catch script scores 50 synthetic finding lists built from the sealed labels, 5 per case: the
right file with the line 4 or more away; the right line with no cause word; the cause words on another file; a final
head with the planted lines reworded but the bug kept (the sealed regression test still fails); and one exact match. It must score the 40 decoys 0 and the 10
matches 1. A decoy pass proves the rule rejects near misses and does not credit a cosmetic edit as a fix.

## Blinding
- Arms see a real project: the garrytan/gstack checkout, plain branch names taken from each host's own branch, and
  the host's own commit title. No branch, file, commit message, prompt or label the trial controls carries an eval word.
- This file and its results file are removed from every case base, and the label file never enters the repository.
  The installed gstack copy (`~/.local/share/gstack`) still holds this file, so every C and F transcript is scanned
  for reads of it or of the label file's path, and a trial that read either scores zero. The rule is the same for C
  and F: both arms install the same gstack copy and fetch the same `origin/main`, so both can read this file the same
  way, and both briefs carry the same text, including the exemption line that removed the F-only reason to look for
  context. Each arm's count of such reads is reported, and the sensitivity analysis below also repeats the
  comparisons with those trials left out instead of scored zero, so a difference in how often the arms read this file
  cannot alone decide a bar.
- Each arm's checkout keeps git history, where the original fix commit lives. Lookups of the planted path's history
  (`git log -S`, `git log -p`, `git blame` on that file) are counted per trial, and catches made after one are
  reported separately as well as in the totals.
- Exposure audit, per counted C and F trial, over the thread and every subagent transcript the runner can read: reads of
  crew notes, handoffs or reports that name this trial, a trial thread or GST-3003; and any diff or history against
  `origin/main` that covers the planted path (each plant re-introduces a bug that a later main commit fixed, and C
  and F fetch `origin/main` because gstack's conflict guard needs it). Flagged trials stay in every primary
  comparison; a sensitivity analysis repeats the comparisons without them, and both are reported. The pilot found one
  arm that read the crew notes and this file on main, which is why the audit exists.
- The judge sees A, B and C, never an arm, model or price.

## Stop rules
- Spend cap: $3,250 cost.dollars for everything in the budget table (the approved figure replaces it if lower). `budget_exhausted` stops the run with every finished trial reported, and the run does not resume.
- Per trial: $150 or 4 hours. A trial stopped there is recorded as incomplete, with its cost at the stop counted (a lower bound, flagged), and scored on what it caught by then.
- Pilot: if any pilot trial fails one of the Procedure's four checks, or a C or F pilot trial ends without a receipt for a harness reason (machine, install, CI wiring; the remote_gate refusal in End of a trial is not one), no counted trial starts; the fix is a dated change to this file and a new pilot, or the arm is left out and reported as left out; a change to a bar, arm or decision is a new preregistration.
- Judge stage: the judge stage reaching $150 without 48 labels, 24 of them from C and F, stops the run before any counted trial.
- Second judge attempt: the judge below kappa 0.6 on its fresh labels stops the run incomplete, with no further attempt; the judge stage and the second attempt together reaching $150 without those labels stops the run before any counted trial.
- Halfway look: the stops in the Halfway look section.
- The catch script below 50 of 50 on decoys (before any trial), or the judge below kappa 0.6 (after the judge stage, before any counted trial): stop; fix the script or the judge prompt and relabel; never lower a bar.
- Projection: if the pilot's projection for all 90 trials plus the fixed costs exceeds the approved budget, stop and ask again with the new figure.
- No retries of a counted trial, with the one exception AGENTS.md allows: a red case may rerun once at the same head as a new panel, reported as flaky. Harness or infrastructure failures never rerun.

## Budget (all-in estimate, cost.dollars)
| Item | Count | Each | Total |
|---|---|---|---|
| C trials | 30 | $38 | $1,140 |
| F trials | 30 | $38 | $1,140 |
| N trials | 30 | $6 | $180 |
| Sealing: picking hosts and plants, proving each plant | 1 | $60 | $60 |
| Pilot, uncounted: one trial of cases 1 to 3 in each arm (measured) | 1 | $83 | $83 |
| Second pilot, uncounted, after the 2026-11-21 amendment (measured) | 1 | $73 | $73 |
| Third pilot, uncounted, C and F only, after the third 2026-11-21 amendment | 1 | $75 | $75 |
| Judge stage, uncounted: N on cases 4 to 10 | 7 | $6 | $42 |
| Judge: 48 labels plus about 300 findings on GPT-6 Astra | 1 | $80 | $80 |
| Second judge attempt, uncounted: C and F on cases 4 and 5, N on cases 1 to 10, one labeller | 1 | $80 | $80 |
| Second labeller (measured $3) and the fourth amendment's /ship | 1 | $35 | $35 |
| Runner: waves, audits, scoring, results write-up | 1 | $150 | $150 |
| /ship of the results pull request | 1 | $35 | $35 |
| **Estimate** | | | **$3,173** |
| Cap (approved by GSTA-36) | | | $3,250 |

The first judge stage did not need its extra C and F trials. If the second judge attempt needs case 6, its two trials add about $27 (worst case $3,200), still inside the cap. That sits under R71's $4,000 guideline for an eval with a GPT-6 Astra judge. If F saves what the profile predicts
(about $10 a run), the actual total is near $2,873. Machines, CI minutes and the runner VM are not in cost.dollars and
are reported separately. Each case gets 3 trials because AGENTS.md gives a `behavior` case a panel of 3, and because
one trial each would let noise decide the "misses nothing" bar (see Bars).

## Held-out exposure
| set | prior exposure (which runs, which models) | reservation (what this run may read) |
|---|---|---|
| the 10 sealed cases (hosts, plants, labels) | none: picked after this file merges; hosts and fixes are public on GitHub, all merged after Opus 5.5's June 2026 training cutoff | arms read only their case checkout; the runner reads labels to score; the judge reads findings, the case diff and the changed files at the case head, never the labels |
| the 48 judge labels | none: findings from this run's own uncounted pilot and judge-stage trials, labelled before the judge sees them | the judge reads them once for `judge --check`; they never enter a counted comparison; after two checks they are development data for the second judge attempt |
| the second judge attempt's fresh labels | none: findings from that attempt's own uncounted trials, which start after the revised judge's hashes are posted | the judge reads them once for `judge --check`; they never enter a counted comparison |

## After the run
Results go to `docs/evals/ship-conductor-fold-results.md`, opening with two or three plain takeaways, with one table
holding a filled row for C, F and N, checked with `gstack-eval-plan results --check` before any number leaves the
run. Counts that may be zero (structural losses, contaminated trials, history lookups) are reported in prose, outside
the tables. A null gets one R48 "Why null?" cycle and a KEEP, FIX-METHOD or CUT-CANDIDATE verdict.
