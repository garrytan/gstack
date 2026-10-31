# Skill eval contract (what gstack needs from the shared skill eval)

Status: interface request from gstack (GSTA-133) to the gstack-evals Captain (GSTA-2), 2026-10-27. gstack ships no
eval harness of its own; `/write-skill`'s diet mode calls whatever implements this contract. Until it exists, the diet
procedure runs upstream [skill-diet](https://github.com/nicobailon/skill-diet)'s `scripts/eval.mjs` on the same task
files and applies the policy below to its per-task table.

## Call

```
<cli> skill-eval --arms before=<skill-dir>,after=<skill-dir>,none --tasks <tasks.json>
                 --host claude|codex --model <id> --trials 3 --spend-cap <usd> --out <dir>
                 [--dry-run] [--calibrate] [--tasks-only <id,...>]
```

- An arm is a skill folder (SKILL.md plus anything it reads) or `none`. A gstack skill passes its rendered folder.
- `--dry-run` prints the session count and a price estimate and starts nothing. `--spend-cap` is enforced while
  running: the run stops before the next session would pass it and the verdict is INCOMPLETE.
- `--calibrate` runs only the three checks: the agent quotes a line only its arm's copy holds, says it has no skill
  in the `none` arm, and runs a shell command. A real run calibrates first and stops on a failed check.
- Runs locally on a developer or Capy machine first. CI use, if any, is a manual or periodic job; never the free suite.
- Paid sessions bill through the caller's own keys, and the verdict records their cost.

## Tasks

`test/fixtures/skill-evals/<skill>/tasks.json` in the repository that owns the skill:

```json
[{ "id": "stats", "prompt": "one-line request", "setup": "sh \"$SKILL_EVAL_FIXTURES/seed.sh\" full",
   "must": ["regex"], "must_not": ["regex"], "check": "shell command that exits 0", "safety": true }]
```

`setup` and `check` run in the session's work dir; `SKILL_EVAL_FIXTURES` is the tasks file's directory. `must`
patterns match the final answer; `must_not` patterns match its code blocks. `safety: true` marks a task whose
failure fails the diet on its own. Tasks are committed before the skill is cut.

## Output

`<out>/verdict.json`:

```json
{ "verdict": "PASS|FAIL|INCOMPLETE", "reasons": ["REGRESSION stats", "SAFETY no-code-change", "WORSE", "UNCOVERED empty"],
  "harness_version": "…", "model": "…", "trials": 3,
  "calibration": { "skill": true, "none": true, "shell": true },
  "arms": { "before": { "pass_rate": 0.9, "tokens_per_run": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 },
                        "turns_per_run": 0, "opened_skill_rate": 1.0, "files_loaded": { "SKILL.md": 30 }, "cost_usd": 0 } },
  "tasks": { "stats": { "before": [true, true, true], "after": [true, true, false], "none": [false, false, false] } },
  "adjudication": { "blinded": true, "judge_model": "…", "disputed": [] } }
```

Raw transcripts stay under `<out>/runs/`.

## Exit codes

- `0` PASS
- `1` FAIL (a regression, a safety failure, or WORSE)
- `2` INCOMPLETE (spend cap reached, infra failure, timeouts)
- `3` calibration failed

## Policy

- **Per task, not aggregate.** A task whose `before` panel passed (at least 2 of 3) must still pass in `after`
  (at least 2 of 3), or the verdict is FAIL with `REGRESSION <id>`.
- **Safety.** Any failed trial of a `safety` task in `after` is FAIL.
- **Uncovered.** A task every arm fails is reported as `UNCOVERED <id>`; it is never dropped silently.
- **WORSE.** `after`'s overall pass rate lower than `before`'s by more than two standard errors is FAIL.
- **Opened the skill.** Under half of the skill-arm runs opening the skill is a warning: the scores then measure
  the tool's own text.
- **Trials are fixed before the run.** No trials are added after a result. One same-tree rerun of a red task is
  allowed and recorded as flaky; a second failure stands.
- **Blinded adjudication.** A disputed answer goes to a fresh judge that sees the task and the answer, not the arm.

## Notes for implementers (2026-10-28)

Offered to gstack-evals' Lane A (interface v0.4). Nothing above changes; these are conventions gstack's task files
already assume, and one optional field.

- **State root.** gstack skills keep state under one root (docs/state-root.md): `GSTACK_STATE_ROOT` wins, then
  `GSTACK_HOME`. Set both to `<work dir>/.gstack-home` for the agent, `setup` and `check`; `GSTACK_HOME` alone loses
  to a `GSTACK_STATE_ROOT` inherited from the caller's shell, and the agent then writes the caller's real state. A
  task's `seed.sh` creates `.gstack-home` and lists it in `.git/info/exclude`, so `git diff` checks ignore it and
  `check` reads state there (/learn's `add` and `prune-stale`, /office-hours' design-doc and mockup checks). A
  `check` that reads `.gstack-home` first requires it to be a real directory, not a symlink, because `find` does not
  descend into a symlinked start point. /learn's checks read the one project folder named for the work dir, and
  /office-hours' no-code check lists untracked files against `.git/info/exclude` alone, so a `.gitignore` the agent
  writes hides nothing.
- **`resumable`** (optional, in `verdict.json` and any error record): `true` when an INCOMPLETE run can be finished
  with `--resume <out>`, which runs only cells that never ran, under the same lock and trial count, so it adds no
  trials after a result; `false` for a terminal stop, which needs a fix and a fresh run. A missing field reads as
  `false`.
- **Lock.** A paid run needs `tasks.lock.json` committed beside the tasks file; `/write-skill`'s diet step 6 runs
  `--lock` and commits it.
- **Sidecar.** Extensions live in `tasks.ext.json` beside the tasks file, keyed by task id, so this format stays
  unchanged. gstack's free test checks only that each entry names a task in `tasks.json` and uses known keys.
- **Interactive tasks.** /office-hours' `must` patterns grade a headless run that ends where the skill stops for
  input, as upstream skill-diet's runs do. On a host that answers questions from the sidecar's `user` replies, the final answer is
  the session's last message, so the sidecar's `judge` line carries the behavior there. Open for Lane A: grade
  `must` over the run's assistant messages on such hosts, or keep it on the final answer and rely on `judge`.
