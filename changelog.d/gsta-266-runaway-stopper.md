bump: minor
---
**New skill: /runaway-stopper finds runaway agent threads and subagents, stops them at a clean point, and sets the defaults that keep them from coming back (GST-1279).** One Founderstar thread (FOUN-4) used 6.9B tokens in 13 days, about 4B of it its own context re-read on every step, many of them wakes that ended with nothing to say. One of its /ship subagents reached 485M because it was reused for five /ship runs, so each run re-read every earlier one.

### Added
- **`/runaway-stopper`.** Detect, stop, prevent. A Captain (or the org sweep) fetches its crew's thread data to files in one program and scans it. Own tokens past 500M or a thread active past 3 days means rotate, a subagent past 100M means stop, and empty wakes past 25% or review rounds past 2 per PR are warnings (org rule R70). Captains are reported, never rotated. Threads mid-/ship or mid-merge are deferred. Rotation uses a handoff file and a successor brief (`runaway-stopper/templates/`), and only the thread's own Captain archives it.
- **`gstack-runaway scan`.** The read-only detector behind the skill. It reads `tools.thread.get`, `tools.subagent.list` and transcript data and prints `RUNAWAY:`, `FLAG:`, `DEFER:` and `SWEEP:` lines. It never acts.

### Changed
- **A /ship subagent gets an 80M token cap by default.** An observe-mode `gstack-ship-budget start` run as a subagent with no `--token-cap` now caps at 80M and prints `BUDGET_DEFAULT_CAP: 80M`, below the 100M stop line. `--token-cap none` turns it off. Root runs and admit mode are unchanged. The Capy lane guide now says to run each /ship in a fresh subagent.

### Tests
- `test/runaway.test.ts`: FOUN-4's real reading (rotate on own tokens and age, the 485M /ship subagent flagged), live-subagent stop deferred mid-/ship, active-by-recent-turn, a Captain reported but not rotated, the empty-wake rate, the subagent tree, the directory sweep and usage errors. `test/ship-budget-meter-scope.test.ts`: the default cap, its stop, and the cases that must not get it.
