<!-- AUTO-GENERATED from measure.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Measure-then-fix loop (a red paid eval or a failed free-suite shard)

Every rerun here is **diagnostic, not a verdict**: it never changes the recorded
verdict of the run that failed, its artifacts are labeled `diagnostic` under
`.context/ship-measure/` (never the eval history), and the lane verdict comes
only from the one full gate run at the end. Never raise a budget, lower a
threshold, add a verdict retry or skip a case to get a pass.
`ship-measure` below means `bun run ~/.claude/skills/gstack/scripts/ship-measure.ts`.

**Failed free-suite shard (Step 5).** Before calling the failure pre-existing or
pushing, rerun that shard's exact file list (in run order) with
`ship-measure free --files <f1,f2,...>` (gstack local runs: `--shard <i>`): 10
reruns, rerun 1 alone as the baseline and the rest labeled parallel, each with
its own HOME and state root, the flaky retry off, under a 10-minute cap.
`ship_rerun_backend=ubicloud` with `UBICLOUD_API_KEY` set runs them on one
Ubicloud VM. If the runner cannot take a file list, rerun the whole failing
command 10 times. Report the pass rate, the completed count (for example 6 of 10
completed at the cap) and one failure capture, then continue the triage.

**Red paid eval (Step 6).** For each red case:

1. **Classify.** Read the red line's cause, evidence and Expected/Received
   (`failure_cause`, `failure_detail`; gstack: `bun run eval:pass-rates --run <run> --case <id>`).
   Name it: product change from this branch, detector or actor defect, fixture
   defect, provider event, or model miss. A detector fix gets a free replay test
   before any paid trial. A red that is infrastructure (provider outage, runner
   loss) may skip measurement: `ship-measure skip --case <id> --reason "<why>"`
   labels it `unmeasured` in the PR body. It never counts as a pass.
2. **Show the plan.** Print `ship-measure table` (trials, pass bar, panels and
   budget per kind, from the `ship_measure_*` gstack config keys) and the
   estimate: per-trial cost from pass-rate history times trials, or "estimate unknown".
3. **Measure.** `ship-measure measure --case <id> --round baseline [--cost-per-trial <usd>]`
   runs the case alone on the current head at its kind's count, in parallel. It
   uses the project's documented single-case eval command,
   `--command '<command> {case}'`, found the way Step 4 finds test commands
   (CLAUDE.md/AGENTS.md, then package scripts). gstack's default needs no
   `--command`: `scripts/test-paid-shards.ts --tier <tier> --case <id>`, and it
   accepts standalone judge ids. With no documented single-case command, ask
   once and record the answer in the report. Exit 2 means it needs approval:
   ask once with the reason it printed, then rerun with `--approved`.
4. **Fix at the cause.** Root-cause the failed trials from their captures in
   `.context/ship-measure/<case>/<round>/tNN/` and change the cause.
5. **Re-measure.** `ship-measure measure --case <id> --round round-<n> --fix "<cause and change>"`.
   Exit 0 is at or above target. Exit 1 is below target: return to step 4. Call
   a case fixed only with a named causal change and every failure in the closing
   measurement explained; report "observed k/n after fix at <cause>", never a proven rate.
6. **Stop.** Exit 3 is a named red (repair-round limit or the per-case budget
   exhausted): stop, do not push, and report `ship-measure report` with every trial.

**Gate once.** When every red case measures at or above target, run the full
gate once (Step 6 item 2). When the project's CI runs that gate on push (gstack:
the pull request's `evals` workflow), the push is the gate run: push and read
that run, and do not also start the gate command (gstack's `bun run eval:bg:pr`
on a pushed head dispatches a second paid run). Put the `ship-measure report` table (estimated
and actual spend per case) in the PR body.
