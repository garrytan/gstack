# Prereg: do /ship's reviewers catch more than plain reads at the same spend? (GST-3467)

frozen: 2026-11-22

Status: locked at merge, before any paid call. Owner: GStack Minder (GSTA-36); runner GSTA-798. Paid runs start only
after this file merges. Approved budget: about $1,300, cap $1,500 (GSTA-36, 2026-11-22).

## Question
G1's trial ([ship-conductor-fold-results.md](ship-conductor-fold-results.md)) found that /ship's review panel caught 21
and 22 of 30 planted bugs, against 16 of 30 for one plain review prompt. The panel was ahead or tied in every case, but
10 cases could only detect a 28-point gap and the gap was 20. Its "Why null?" cycle (GST-3467) added two leads:

- one panel reader alone (the first-pass specialist) caught the plant about as often as one plain read (49% against
  53%)
- merging two of G1's existing plain reads would have caught about 70%, close to the panel, at a fraction of its reader
  spend

So the open question is whether the panel catches more because of how its readers are built, or because it reads the
code more times.

Do two plain reads plus /ship's second-model reviewer catch planted bugs as well as /ship's first-pass panel, on Claude
Opus 5.5 and on GPT-6.2 Sol?

## Bars
- lesson: whether a frontier model reviewing a pull request needs a panel of specialized reviewer prompts, or whether two plain reads plus a reviewer from another model family catch as much
- planted-bug catch rate, N2V minus P, per model: no-worse when the paired 95% interval's lower bound is at or above −0.10; higher is better
- planted-bug catch rate, P minus N2V, per model: panel better when the paired 95% interval lies entirely above 0
- secondary, per model: N1 minus P (G1's comparison on more cases), N2 minus N1 (the effect of a second read), N2V minus N2 (the second-model reviewer's addition), each paired with a 95% interval and no bar
- secondary: real problems other than the plant (Scoring); counted only if the judge passes its label check, otherwise reported as unscored
- diagnostics, no bar: cost per run and per caught plant for each arm, and, inside P, which reader named each plant and which found anything no other reader found (G3's count)

## Decisions
Each model's result decides for the /ship host that runs that model (Claude Code runs Opus, Codex runs Sol).
- if N2V is no worse than P (the N2V minus P lower bound is at or above −0.10): /ship's first-pass panel on that host is a candidate to replace with two plain reads plus the second-model reviewer; that change is its own /ship plan, through /autoplan and Garry's approval, and nothing changes from this result alone
- if P is better than N2V (the P minus N2V interval lies entirely above 0): the panel stays on that host, and G3 merges only the readers that find nothing alone (today, the targeted reader)
- if neither: the panel stays on that host, the null is published with this run's smallest detectable difference, and G3's panel question closes on that host
- if the run stops incomplete (spend cap, a harness stop, a scorer below its bar): no decision is taken, the panel stays, and every finished trial is reported

## Arms
- `claude-opus-5-5#ship-panel` (P, Opus): /ship's first review pass without its fix loop; every reader the printed plan names, on the Opus lane, the second-model reviewer on GPT-6.2 Sol (Runs); about $2.80 a trial
- `claude-opus-5-5#no-gstack` (N1, Opus): R1, one plain read with G1's prompt (No-gstack arm); about $0.85 a trial
- `claude-opus-5-5#no-gstack-x2` (N2, Opus): R1 and R2, two independent plain reads, findings pooled; about $1.70 a trial
- `claude-opus-5-5#plain-x2-voice` (N2V, Opus): R1, R2 and V pooled, where V is /ship's second-model reviewer alone (GPT-6.2 Sol); about $1.95 a trial
- `gpt-6.2-sol#ship-panel` (P, Sol): the same first pass on the Sol lane, the second-model reviewer on Claude Opus 5.5; about $2.00 a trial
- `gpt-6.2-sol#no-gstack` (N1, Sol): R1, one plain read with G1's prompt; about $0.35 a trial
- `gpt-6.2-sol#no-gstack-x2` (N2, Sol): R1 and R2 pooled; about $0.70 a trial
- `gpt-6.2-sol#plain-x2-voice` (N2V, Sol): R1, R2 and V pooled, V on Claude Opus 5.5; about $1.60 a trial

## Runs
Every trial starts from the same case checkout, with no earlier context. Opus runs in Claude Code 2.1.292 (`claude -p`),
and Sol in Codex CLI 0.170.0 (`codex exec`), per R110. The CI image pins Codex 0.160.0, but that version has no model
metadata for `gpt-6.2-sol` and warns that it falls back. 0.170.0 is the version gstack's codex-hooks workflow pins, and it
carries the metadata. Per trial, the runner makes these runs on each model: one P run, two plain reads (R1 and R2) and
one second-model review (V).

**P.** The runner runs `gstack-review-dispatch pass --pass p1` on the case head. That runs `gstack-review-plan` with no
flags and renders every reader brief byte for byte. The runner then starts each reader the manifest names, in its stage
order (first, specialists, red-team, voices), as its own headless session in the case checkout. It records the exact
prompt with `sent` and collects each output with `collect`.
- The readers run on the lane model at the reasoning effort the plan names.
- The second-model reviewer runs on the other family's model that gstack's voice settings name for the lane.
- Nothing is fixed, committed or re-reviewed.
- P's findings are every collected reader's output.

**V.** /ship's second-model reviewer alone, run from the brief `gstack-review-dispatch render --role outside-voice` writes
for the case, on the same model as P's reviewer.

The plain-read arms are nested by design (N1 ⊂ N2 ⊂ N2V), so N2 minus N1 isolates the second read and N2V minus N2
isolates the reviewer. P shares no run with them.

**Session settings.** Each session runs:
- with no web tools (Claude Code: `--disallowedTools WebFetch,WebSearch`; Codex: its default, with no web search)
- with shell and file tools on
- with permissions bypassed inside the runner VM
- for at most 30 minutes; one still running then is stopped and scored on what it printed

Plain reads run at reasoning high.

## Comparison
stack: loaded

P loads gstack's review panel and V uses gstack's second-model brief; the question is about that panel.

## No-gstack arm
- arms: `claude-opus-5-5#no-gstack`, `gpt-6.2-sol#no-gstack`
- inputs: the same 30 cases, the same checkout and the same planted bug as P
- prompt: G1's plain prompt, unchanged: "Review this PR (branch `<branch>` against `<base>`, checked out here) for bugs that would fail a test, break production or lose data. List each as path:line and the cause." No SKILL.md, preamble, hooks, installed skills or routing lines
- panel: the same kind (`behavior`, 3 independent trials per case), the same catch rule and the same judge
- report: its rows sit beside P and N2V in every results table and verdict, including when they win
- masking: each plain read runs as a separate Unix user on the runner VM whose home holds no gstack and no Capy drive; the VM mounts no Capy drive at all
- install: `test ! -e ~/.local/share/gstack && test ! -e ~/.claude/skills && test ! -e ~/.codex/skills` as that user before each session
- audit: each plain-read transcript is scanned for reads of a gstack install path or a drive path; a trial that read a gstack skill file is contaminated and scores zero

## Scoring
judge: gemini-4-carbon
labels: 120
agreement: 0.6
per-arm: yes
effort: high
paired: yes
interval: 95%
mdd: about 0.15 on catch rate at 80% power (G1's per-case spread of 0.28 over 30 cases, end critical t of 2.06); if the arms are truly equal, the no-worse test passes about 45% of the time, because −0.10 sits inside one detectable difference; the pilot's spread is printed beside this and no bar moves

**Catches, by rule (primary, no judge).** A trial catches its planted bug when a finding in the arm's pooled findings
names the labelled path, a line within 3 of the labelled line, and at least one cause word. This is rule (a) of G1's
frozen `catch.py` (sha256 9dbb3abf…), run unchanged. No arm edits code, so G1's rule (b) (the regression test passes
after a fix) never applies. Findings are every non-empty line of each collected output and every row of P's
`merged.jsonl`. A case's catch rate in an arm is its catches over 3 trials.

**Real problems, by judge (secondary).** Gemini 4 Carbon, through OpenRouter at reasoning high, is a family no arm
shares. Per case it gets:
- the case diff and the changed source files at the case head
- the plant's labelled hunk and description, so it can label any finding that restates the plant as "plant"
- every finding from every arm and model, each tagged with a shuffled source letter, never an arm name, model or cost

It labels each finding `plant`, `real` or `not_real` against G1's rubric (the blocking floor: it would fail a test,
break production, or lose data or secrets), and groups findings that name the same problem.
- A case's real problems are the union of the real groups across all arms and models.
- Each arm's rate is the share it found, averaged over its 3 trials.

The label check:
- A seeded draw takes 15 findings from each arm's own runs (P's readers; R1 for N1; R2 for N2; V for N2V; on each
  model), 120 in all.
- One labeller (a Claude Opus 5.5 subagent with the rubric and the plant, no access to any judge output) labels them
  blind.
- The labels are frozen with a SHA-256 before the judge sees any.
- `gstack-eval-plan judge --check` must print `JUDGE_AGREEMENT: ok` (kappa at least 0.6, read per arm) before any
  real-problem number counts. Below that, real problems are reported as unscored.

The labeller is the same family as some arms. That is disclosed, and it is why the judge is a third family.

**Comparisons.** Every comparison is paired by case: the per-case difference of catch rates, with a 95% t interval over
the cases. Every trial is reported; nothing is averaged away.

## Models
- reader: claude-opus-5-5 (P readers on the Opus lane; the second-model reviewer on the Sol lane)
- reader: gpt-6.2-sol (P readers on the Sol lane; the second-model reviewer on the Opus lane)
- reader: claude-opus-5-5 (the label-check labeller and the case sealer)

## Cases
30 cases, the same 30 for every arm and model, fully paired. The order is a seeded shuffle (seed 20261122) of all 30.

**G1's 10 sealed cases.** All of them are kept, the saturated ones included, because dropping cases after seeing
their outcomes would select on the result. Their hosts, plants, label file (sha256 f1e81ee2…) and base and head commits
are unchanged.

**20 new cases**, sealed by a separate sealing subagent after this file merges and before any arm runs, by G1's rules:
1. **Host pull request.** A garrytan/gstack pull request merged on or after 2026-07-01 (after both models' training
   cutoffs) whose revert applies to the frozen main commit c2b4f0d2. A revert that conflicts is resolved by hand only in
   docs, test files and the plant's own file; a conflict in any other code file disqualifies the host. Excluded:
   - G1's 10 hosts and their fix commits
   - changes to docs, generated files, VERSION or CHANGELOG only
   - changes to /ship or review tooling itself (`ship/`, `review/`, `lib/ship-*`, `lib/review-*`, `bin/gstack-ship-*`,
     `bin/gstack-review-*`)
2. **Size class**, by changed lines without generated files and lockfiles: 6 small (under 150), 8 medium (150 to 600),
   6 large (over 600). At least 6 of the 20 are hosts that `gstack-review-plan` sends to the full panel.
3. **Planted bug.** One hunk of at most 15 changed lines inside the host's own diff that brings back a real bug a later
   gstack commit fixed (a revert, or a fix whose description or regression test names the failure). It is adapted
   only as far as needed to apply. Before sealing, each plant must:
   - (a) make that fix's regression test, or a test the sealer writes from the fix's description, fail on the planted
     tree and pass without the plant
   - (b) leave the host's existing tests passing
4. **Labels.** The sealer writes one private label file with the same fields as G1's:
   - host, base and head commits, size and review class
   - the plant: path, labelled line, hunk, source fix, and 2 to 4 cause words

   Its SHA-256 is posted on GST-3467 before any trial starts, and the file never enters the repository.

**Checkouts.** Each arm sees a synthetic two-commit repository per case:
- one commit holding the case base tree and one holding the case head tree, under the host's own title
- a local `origin` that has only the base branch
- no other history, so no fix commit can be read
- this file and its results file removed from both trees

Branch names are taken from the host's own branch. No branch, file, commit message or prompt carries an eval word.

## Procedure
1. **Before any trial.**
   - the case sealing above
   - the decoy check (Decoys)
   - the label file's SHA-256 posted on GST-3467
   - the runner's script hashes posted on GST-3467
2. **Pilot (uncounted).** Below.
3. **Counted trials.** 3 per case per model, cases in seed order. Every run of one case and trial (P, R1, R2 and V on
   both models) starts in the same batch.
4. **The interim look** at 15 cases (Interim look).
5. **Judge stage.** After the last counted trial: the 120-label draw, the blind labeller, the frozen hash,
   `judge --check`, then the judge over every finding.
6. **Results.** Every bar and diagnostic, per model and per arm.

Measured per run: the session's own reported cost; for Codex, the tokens priced by `lib/pricing.ts`. Also wall time,
and for P each reader's state, model, effort and output hash.

## Pilot
- share: 3% (2 of 90 case trials per arm)
- counted: no
- ran: on P's outputs the manifest lists every reader the printed plan named, each collected, with `sent` matching the rendered brief's hash and the second-model reviewer on the other family; on N1 and N2 the install check finds no gstack and the transcript audit finds no gstack or drive read; on V the output carries the reviewer brief's clean marker or findings, from the other family
- judge: the labeller and judge are run on the pilot's findings as a dry run of the label format and the per-arm label check; its kappa is printed and does not count
- supply: both pilot cases build their two-commit checkout, `gstack-review-plan` prints a plan on each, typecheck runs on both trees, and every session finishes within 30 minutes; the pilot's measured cost per trial is projected over 90 trials per arm against the cap
- units: one G1 case with a full-panel plan (G1's case 3) and one new case with a light plan, so both case sources and both review depths are drawn
- seed: 20261122 (the pilot cases are fixed above; the counted order is the seeded shuffle, independent of how many sessions run at once)

An arm that fails a check is fixed by a dated change to this file and piloted again, or left out before its counted run
and reported as left out.

## Cost
- paid: $752
- meter: about $450 (sealing $50, pilot $30, the label check and judge $50, this thread's runner work $250, two /ship runs $70); the Ubicloud VM is outside cost.dollars and is reported separately
- ledger: Captain drive reports/GSTA-798.md

| Item | Count | Each | Total |
|---|---|---|---|
| Opus P | 90 | $2.80 | $252 |
| Opus plain reads (R1, R2) | 180 | $0.85 | $153 |
| Opus-lane second-model reviewer (V, on Sol) | 90 | $0.25 | $23 |
| Sol P | 90 | $2.00 | $180 |
| Sol plain reads (R1, R2) | 180 | $0.35 | $63 |
| Sol-lane second-model reviewer (V, on Opus) | 90 | $0.90 | $81 |
| **Counted runs** | | | **$752** |
| Sealing 20 new cases | 1 | $50 | $50 |
| Pilot, uncounted | 1 | $30 | $30 |
| Label check and judge | 1 | $50 | $50 |
| Runner thread: harness, scoring, results | 1 | $250 | $250 |
| /ship of the preregistration and results pull requests | 2 | $35 | $70 |
| **Estimate** | | | **$1,202** |
| Cap (GSTA-36) | | | $1,500 |

## Interim look
- at: 50% (15 cases in seed order, with all 3 trials of every arm on both models)
- looks: 1
- bounds: O'Brien-Fleming for a two-sided 0.05 test, |z| of 2.80 at the look and 1.98 at the end, each applied as its two-sided nominal p (0.0051 at the look, 0.0477 at the end) to the paired t over the cases (14 and 29 degrees of freedom)
- futility: both models' N2V minus P interval at the look's nominal level lies entirely below −0.10, so neither can reach no-worse; the counted trials stop and the panel stays on both hosts

**Stop for the panel.** If P minus N2V crosses the look's bound in P's favour on both models, the counted trials stop
and the panel stays on both hosts. An early stop can only keep the panel: a candidate to replace it needs all 30 cases.
A crossing in N2V's favour does not stop the run. A run that stops early says so in its first line, and its estimates
are reported as possibly overstated.

## Decoys
Before any trial, `catch.py` scores 5 synthetic finding lists per new case, built from the sealed labels, 100 in
all:
- the right file with the line 4 or more away
- the right line with no cause word
- the cause words on another file
- the right file and line with the cause words only inside a path or code span
- one exact match

It must score the 80 decoys 0 and the 20 matches 1. G1's decoy result (40 of 40, 10 of 10) stands for G1's cases.

## Blinding
- **Exposure audit for P readers.** gstack's installed copy holds the fixed version of many planted files, because the
  cases are gstack's own pull requests. Each P reader transcript is audited for any read, diff or grep of a file under
  the gstack install root other than what its brief names (checklists, specialist files and the bin commands it runs).
  A flagged trial stays in every primary comparison. A sensitivity analysis repeats the comparisons without flagged
  trials, and both are reported.
- **Network.** Every transcript is audited for fetches of github.com or of any copy of garrytan/gstack, and a trial
  that fetched one scores zero.
- **The judge** sees shuffled source letters, never an arm, model or price.

## Stop rules
- Spend cap: $1,500 cost.dollars for everything in the Cost table. `budget_exhausted` stops the run with every finished trial reported, and the run does not resume.
- Per session: 30 minutes. A stopped session is scored on what it printed and counted as incomplete.
- Pilot: an arm that fails any Pilot check starts no counted trial until a dated change to this file and a new pilot fix it, or it is left out and reported as left out. A change to a bar, arm or decision is a new preregistration.
- Decoys: `catch.py` below 100 of 100 on the new decoys stops the run before any trial.
- Projection: if the pilot's projection for all trials plus the fixed costs passes $1,500, the run stops and asks GSTA-36 again with the new figure.
- Interim look: the stops in Interim look.
- No retries of a counted session. Harness or infrastructure failures are fixed and that case and trial rerun as a whole batch only when no output of the failed batch was scored; any rerun is reported.

## Held-out exposure
| set | prior exposure (which runs, which models) | reservation (what this run may read) |
|---|---|---|
| G1's 10 sealed cases | G1's 90 trials (Opus 5.5 in Capy threads and the Agent SDK) and its write-ups; no Sol run has seen them | arms read only their two-commit checkout; the runner reads labels to score; the judge reads findings, the case diff, the changed files and the plant |
| the 20 new cases | none: sealed after this file merges, hosts and fixes public on GitHub, all merged after both models' training cutoffs | the same as G1's cases |
| the 120 judge labels | none: drawn from this run's counted findings and labelled blind before the judge sees them | the judge reads them once for `judge --check` |

answers: each case checkout is built by the runner as a fresh two-commit repository with a local origin holding only the base branch; before any session the runner checks that `git log --all` shows exactly those two commits and that no file in the checkout differs from the case head tree, and the runner VM holds no gstack checkout, label file or G1 artifact in any arm user's home

## After the run
Results go to `docs/evals/ship-panel-plain-reads-results.md`. The page opens with two or three plain takeaways and
has one table with a filled row for every arm on both models. It is checked with `gstack-eval-plan results --check`
before any number leaves the run. A null gets one R48 "Why null?" cycle and a KEEP, FIX-METHOD or CUT-CANDIDATE
verdict.
