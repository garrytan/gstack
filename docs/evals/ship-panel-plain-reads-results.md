# /ship's review panel against two plain reads and a second-model review: results (GST-3467)

We learned that a single plain "review this PR" prompt misses far more planted bugs than /ship's first review pass, and that two plain reads plus /ship's second-model reviewer close most of that gap but cost as much per run and were not shown to be no worse. You should keep /ship's review panel on both Claude Code and Codex: the substitute saves no money, and it trailed the panel on both models.
We also learned that the second-model reviewer is the part that earns its keep. Adding it to two plain reads raised the catch rate by 14 points on Claude Opus 5.5 and 10 points on GPT-6.2 Sol, with both intervals above zero.

Preregistration: [ship-panel-plain-reads-prereg.md](ship-panel-plain-reads-prereg.md), frozen 2026-11-22 and merged before any paid call. G1's earlier trial is [ship-conductor-fold-results.md](ship-conductor-fold-results.md). Every interval below is the paired t interval over the 30 cases at the end bound's level (two-sided 0.0477, a 95.2% interval), as preregistered. Differences are in percentage points.

The model judge failed its label check, so real problems other than the planted bug are unscored. Against 120 blind hand labels, its agreement was kappa 0.51 overall, under the preregistered bar of 0.6, and it fell below the bar on 5 of the 8 arms. The results check therefore reports exactly one issue, `EVAL_JUDGE_UNCHECKED`, which the preregistration allows. Every catch number on this page comes from the frozen rule-based scorer, not from the judge.

## What worked

- **The panel beat one plain read clearly on Opus.** The panel caught 71 of 90 planted bugs (78.9%), and one plain read caught 38 of 90 (42.2%). The difference is −36.7 points (−48.7 to −24.6). On Sol the panel caught 58 of 90 (64.4%) and one plain read caught 46 of 90 (51.1%), a difference of −13.3 (−28.7 to +2.0).
- **The second-model reviewer adds real catches.** Two plain reads plus the reviewer, compared with two plain reads alone, gained +14.4 points on Opus (+5.9 to +23.0) and +10.0 on Sol (+1.8 to +18.2).
- **A second plain read helps Opus, not Sol.** Opus gained +17.8 (+9.9 to +25.7) from a second read. Sol gained +1.1 (−2.9 to +5.1): its two reads mostly found the same things. On Sol this contrast also carries the network rule: in one trial (N3, trial 3), the first read caught the plant but the second read fetched from GitHub, so the pooled pair scored zero.

## What didn't

- **Neither model met the no-worse bar.** The bar was a lower bound at or above −10 points for N2V minus P (two plain reads plus the reviewer, minus the panel). Opus came out at −4.4 (−14.8 to +5.9) and Sol at −2.2 (−20.0 to +15.6). The panel was not shown to be better either: on both models, P minus N2V includes zero.
- **The preregistered decision is "neither" on both hosts.** The panel stays on Claude Code and on Codex, and G3's panel question closes on both. The planned smallest detectable difference was about 15 points at 80% power. With the spread this run actually saw, it was 14.6 points on Opus and 25.1 points on Sol.
- **The substitute costs as much as the panel.** Per run, the panel cost $1.60 on Opus and $1.19 on Sol. Two plain reads plus the reviewer cost $1.61 and $1.41. Swapping would buy no saving.
- **Sol's plain reads lost 36 of 180 runs to a frozen network rule.** The preregistration scores a run zero if it fetched anything from github.com. Sol's plain reads often fetched other projects' source files from GitHub to check an integration the PR touched, in 7 of 30 cases. Only 2 runs touched garrytan/gstack at all, and those read CI run lists, not code. Opus never fetched GitHub. Without that rule, which is an unplanned view, Sol's N2V minus P is +11.1 (−1.4 to +23.6), which would clear the no-worse bar. The primary result keeps the rule as frozen.

## Results

Every arm, on both models, 30 cases and 3 trials per case. "Caught" counts trials whose pooled findings named the planted bug under the frozen `catch.py` rule (a). "Real problems" is the secondary judge measure (Scoring).

| Arm | Model | Reads | Caught (of 90) | Catch rate | Minus the panel (95.2%) | Cost per run | Cost per catch | Real problems found (judge, secondary) |
|---|---|---|---|---|---|---|---|---|
| `claude-opus-5-5#ship-panel` | Claude Opus 5.5 | /ship first pass (second-model reviewer on Sol) | 71 | 78.9% | reference | $1.60 | $2.03 | unscored |
| `claude-opus-5-5#no-gstack` | Claude Opus 5.5 | one plain read | 38 | 42.2% | −36.7 (−48.7 to −24.6) | $0.66 | $1.55 | unscored |
| `claude-opus-5-5#no-gstack-x2` | Claude Opus 5.5 | two plain reads | 54 | 60.0% | −18.9 (−30.7 to −7.1) | $1.30 | $2.16 | unscored |
| `claude-opus-5-5#plain-x2-voice` | Claude Opus 5.5 | two plain reads + second-model reviewer on Sol | 67 | 74.4% | −4.4 (−14.8 to +5.9) | $1.61 | $2.16 | unscored |
| `gpt-6.2-sol#ship-panel` | GPT-6.2 Sol | /ship first pass (second-model reviewer on Opus) | 58 | 64.4% | reference | $1.19 | $1.85 | unscored |
| `gpt-6.2-sol#no-gstack` | GPT-6.2 Sol | one plain read | 46 | 51.1% | −13.3 (−28.7 to +2.0) | $0.50 | $0.98 | unscored |
| `gpt-6.2-sol#no-gstack-x2` | GPT-6.2 Sol | two plain reads | 47 | 52.2% | −12.2 (−28.2 to +3.8) | $1.00 | $1.92 | unscored |
| `gpt-6.2-sol#plain-x2-voice` | GPT-6.2 Sol | two plain reads + second-model reviewer on Opus | 56 | 62.2% | −2.2 (−20.0 to +15.6) | $1.41 | $2.26 | unscored |

Secondary contrasts, paired, no bar. The plain arms are nested, so on Opus a pooled arm never scores below the arm inside it. On Sol the network rule zeroes a whole pooled arm when any of its runs fetched GitHub, so N2 lost the one catch N1 had made in trial 3 of N3. The Sol N2 minus N1 interval therefore reflects both the second read and that rule: 2 cases gained a catch and 1 case lost one.

| Contrast | Claude Opus 5.5 | GPT-6.2 Sol |
|---|---|---|
| second read: N2 minus N1 | +17.8 (+9.9 to +25.7) | +1.1 (−2.9 to +5.1) |
| second-model reviewer: N2V minus N2 | +14.4 (+5.9 to +23.0) | +10.0 (+1.8 to +18.2) |
| one plain read: N1 minus P | −36.7 (−48.7 to −24.6) | −13.3 (−28.7 to +2.0) |

Sensitivity analyses for N2V minus P. The first two are preregistered; the third is not:

| View | Claude Opus 5.5 | GPT-6.2 Sol |
|---|---|---|
| primary, all 30 cases | −4.4 (−14.8 to +5.9) | −2.2 (−20.0 to +15.6) |
| without G2, the case that keeps its instruction file (29 cases) | −4.6 (−15.3 to +6.1) | ±0.0 (−17.8 to +17.8) |
| without the panel trials flagged by the exposure audit | −5.3 (−19.6 to +9.0), 62 trials in 25 cases | +5.1 (−14.8 to +25.0), 64 trials in 26 cases |
| unplanned: GitHub fetches not zeroed | unchanged (Opus fetched nothing) | +11.1 (−1.4 to +23.6) |

Inside the panel (G3's count), counting by reader output file:

| Panel reader | Opus: ran / named the plant / only one to name it | Sol: ran / named the plant / only one to name it |
|---|---|---|
| first-pass reader (adversarial-native) | 90 / 52 / 7 | 89 / 46 / 16 |
| specialist batch | 90 / 39 / 3 | 90 / 16 / 1 |
| red team | 60 / 20 / 2 | 59 / 7 / 1 |
| second-model reviewer | 75 / 45 / 3 | 74 / 33 / 8 |
| targeted reader | 21 / none / none | 20 / 5 / none |

The targeted reader again never named a plant that no other reader named.

## The judge's label check

Gemini 4 Carbon labelled every finding from every arm, about 5,100 in all. A blind Claude Opus 5.5 labeller, who never saw the judge's output, labelled a seeded draw of 120 findings, 15 from each arm on each model. Those labels were frozen with a SHA-256 hash before the judge ran. The judge and the labeller agreed on 90 of 120 findings. The judge was the more lenient of the two: it called 22 of the labeller's 90 "not real" findings real, while the reverse happened 3 times. They agreed on the planted bug in 16 of the 21 findings the labeller marked as the plant. Per-arm kappa ranged from −0.02 to 1.00 on 15 labels each, and 5 of the 8 arms fell below 0.6. Because the judge missed its bar, no real-problem number is published.

## Why null?

The preregistered "Why null?" check, for both models:

- **Did the panel run?** Yes, in 179 of 180 panel trials every reader its printed plan named ran and was collected. In the other trial (Sol, N11, trial 2), /ship's own collect step rejected the specialist reader's reply because it did not name the checkout it reviewed, so the later readers never started. That trial was scored on what it printed. 5 of the 30 cases had no second-model reviewer in the plan (G9, N8, N10, N14, N21), so the panel ran without it there, as /ship ships.
- **Do the tasks fit?** Mostly. All 30 plants are real bugs that gstack later fixed, brought back into real gstack pull requests. 17 of 30 cases on Opus and 12 on Sol were caught in every trial by both the panel and the substitute, so those cases cannot separate the arms. On Opus, only 8 cases differed at all: the panel led in 5 and the substitute in 3.
- **Were there enough samples?** On Opus, yes, as planned: the detectable difference was 14.6 points against a planned 15. On Sol, no: the case-to-case spread was much larger, and the detectable difference grew to 25.1 points. The network rule accounts for much of that, because without it the spread of N2V minus P falls from 0.47 to 0.33, though that is still above Opus's 0.27.
- **Does the frontier model do it unaided?** Not with one read. One plain read trailed the panel by 37 points on Opus. Two reads plus the second-model reviewer came close, but at the same price as the panel.

Verdict: **KEEP** /ship's first-pass panel on both hosts. The one substitute that came close costs the same on Opus and more on Sol, so there was nothing to gain from a swap even if it had passed. The method lesson for the next Sol measurement is to block only fetches of the repository under test, not all of github.com; that is a new preregistration if anyone needs the question answered for Codex.

## Departures from the preregistration

Each change to the plan (case mix, N19, Codex web search, judge batching) was recorded on GST-3467 before the work it affected. The other items are notes on how the run went, reported in full.

- **Case mix.** Only 4 large hosts passed the frozen sealing rules: the other large candidates conflicted in two or more code files, had their plant already caught by existing tests, or had no later real-bug fix inside the host's own lines. Two medium backups (N20, N21) filled the empty large slots, and all 30 cases stayed. The new cases are 6 small, 10 medium and 4 large, not 6/8/6. Candidate N19 was excluded because its plant sits under `.github/`, and `catch.py` strips the leading dot from paths, so it could never score a catch.
- **Base trees that do not typecheck.** Seven new cases (N5, N7, N10, N13, N17, N18, N20) have base trees that fail typecheck, because the reverted base still references code the host pull request added. The frozen rules do not require a typecheck, so these cases stayed. Every planted head typechecks.
- **Web search on Sol.** Codex CLI turns on live web search under full access by default, which the preregistration did not expect. The first 84 counted sessions were voided before any were scored. Web search was turned off, and the counted run restarted from the first case. The voided outputs are kept and not counted.
- **GitHub zeroing.** As frozen, any run that fetched github.com scored zero. That zeroed 18 R1 runs and 18 R2 runs on Sol and 1 Sol panel run. See What didn't.
- **Exposure audit.** 54 panel trials (28 Opus, 26 Sol) were flagged for reading a file under the gstack install root that their brief did not name. They stay in the primary comparison; the sensitivity table drops them.
- **Harness notes.** 5 Opus plain reads (3 first reads, 2 second reads) hit the 30-minute limit and were scored on what they printed. 1 second-model review (N18, trial 1, on the Opus side) reported the reviewer unavailable and scored on its empty output. Codex sessions looked for an `AGENTS.md` file; the checkouts had none, so nothing was read.
- **Judge batching.** The preregistered judge made one call per case. That ran out of output on every case except G10, because the model spent its whole 65,536-token output limit reasoning before it wrote any labels. The fix, recorded on GST-3467 before any of the judge's labels were kept, uses the same model, rubric and context but sends at most 60 findings per call. Each call reserves 80% of the output limit for reasoning, which is OpenRouter's mapping for effort "high". A second call per case groups the real findings into problems. The judge's numbers are unscored either way.
- **One panel trial stopped early.** Sol, N11, trial 2: /ship's collect step rejected one reader's reply, and that trial was scored on what it printed. The preregistration allows a rerun only when no output of the batch was scored, and other runs in that batch had been scored, so it was not rerun.
- **Reasoning effort.** Panel readers ran on the model under test at the effort the plan names, mapped medium to medium, light to low and full to high. That mapping is the runner's own reading, not a gstack setting. Plain reads ran at high and the second-model reviewer at medium.
- **Interim look.** At 15 cases, no stop bound was crossed (posted on GST-3467), and the run continued to 30.
