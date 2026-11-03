bump: minor
---
**New skill: /runaway-stopper finds runaway agent threads and subagents, stops them at a clean point, and sets the defaults that keep them from coming back (GST-1279).** One Founderstar thread (FOUN-4) used 6.9B tokens in 13 days, about 4B of it its own context re-read on every step, many of them wakes that ended with nothing to say. One of its /ship subagents reached 485M because it was reused for five /ship runs, so each run re-read every earlier one.

### Added
- **`/runaway-stopper`.** Detect, stop, prevent. A Captain (or the org sweep) fetches its crew's thread data to files in one program and scans it. Own tokens past 500M or a thread active past 3 days means rotate, a subagent past 100M means stop, and empty wakes past 25% or review rounds past 2 per PR are warnings (org rule R70). Captains are reported, never rotated. Threads mid-/ship or mid-merge are deferred. Rotation uses a handoff file and a successor brief (`runaway-stopper/templates/`), and only the thread's own Captain archives it.
- **`gstack-runaway scan`.** The read-only detector behind the skill. It reads `tools.thread.get`, `tools.subagent.list` and transcript data and prints `RUNAWAY:`, `FLAG:`, `DEFER:` and `SWEEP:` lines. It never acts. A thread file it can't read prints `RUNAWAY_INPUT:`, is never counted as OK, and makes the scan exit 1.

### Changed
- **A /ship subagent can meter its own cost exactly, and then gets a 100M cap by default.** A subagent whose brief names its title (`GSTACK_SHIP_TASK_TITLE`) reads its own row of the lane's task list and starts `gstack-ship-budget start --reading-from task`. In observe mode with no `--token-cap`, that run caps at 100M and prints `BUDGET_DEFAULT_CAP: 100M` (single-run /ship subagents measured 64M median, 92M p90 on Nov 3). `--token-cap none` turns it off. Tree-metered subagents, root runs and admit mode are unchanged. The Capy lane guide now says to run each /ship in a fresh subagent titled `ship #<n> at <head7>`.

### Tests
- `test/runaway.test.ts`: FOUN-4's real reading (rotate on own tokens and age, the 485M /ship subagent flagged), live-subagent stop deferred mid-/ship, active-by-recent-turn, a Captain reported but not rotated, the empty-wake rate, the subagent tree, the directory sweep and usage errors, unreadable files, the LOOK verdict, and the skill's call bound and rotation lines. `test/ship-budget-meter-scope.test.ts`: the default cap, its stop, and the cases that must not get it.
