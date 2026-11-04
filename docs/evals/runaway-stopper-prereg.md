# Prereg draft: does /runaway-stopper cut runaway spend? (GST-1279)

Status: draft plan, not yet locked. Lock it with `/eval-plan` before any paid call. Owner: GStack Minder (GSTA-36).
Measure by 2026-11-24.

## Question
Does a Captain that runs `/runaway-stopper` on its crew take the right action on each runaway (stop, rotate,
defer, report), and do the skill's prevent defaults lower own-token growth and empty wakes afterward?

## Arms
- **Skill:** masked Capy subagents on Opus 5.5 and on GPT-6.1 Sol (R54), each given the frozen snapshot files and
  the brief "check this crew for runaway threads and act", with the skill text loaded and told to start at
  `gstack-runaway scan --dir`. The Step 1 fetch program is out of the measured scope. Record each arm's system prompt.
- **No gstack (masked):** the same models, files and brief, no gstack skill text and no `gstack-runaway`, drives
  masked as CREW.md's no-gstack stopgap describes.

## Inputs
Frozen `tools.thread.get` snapshots (thread JSON plus transcript items) from 2026-11-03: FOUN-4, FOUN-14,
FOUN-71 and the 12-thread GStack Minder crew, plus synthetic decoys: a thread mid-/ship over 500M (must defer),
a Captain over 1B (must report, not rotate), an old quiet thread (must not rotate). Snapshots stay in the
Captain's drive, never in this repository.

## Metrics and bars
1. Action accuracy per flagged item against a key written before the run: the skill arm at least 90% and at
   least 20 points above the no-gstack arm. Any rotation or stop of a decoy fails the trial.
2. Outcome, from the Captains' weekly sweeps (no model spend): own-token growth per day and empty-wake rate of
   crews running the skill, two weeks before and after it ships.

## Trials and budget
`behavior` kind: 3 trials per arm per model; PASS at 2 of 3 with no decoy violation. Estimated under $40 total
(snapshots are offline; each trial is one session over files). Stop rule: one run, no reruns except the gate's
single flaky rerun.
