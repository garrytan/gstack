**/retro shows which skills fought you this week: a "Friction by skill" row lists the top three skills by questions asked, errors and aborts in this project.** Before, /retro counted skill runs but said nothing about which skills caused back-and-forth, so a skill that kept stopping to ask questions or kept failing never showed up in the report you use to decide what to fix next.

### Added
- **`gstack-retro-metrics` prints `FRICTION:` lines** (top three skills, with runs, questions, typed answers, errors and aborts) plus a `FRICTION_SOURCES:` line, computed by `lib/retro-friction.ts` for the exact retro window. Runs and outcomes come from this project's `timeline.jsonl`, which is written on every run whether or not telemetry is on, unattended sessions included. Questions come from this project's question log when question tuning is on; when it is off, the row says questions are not tracked instead of showing zero. Only outcomes actually recorded as error or abort count, machine-made answers are not counted as questions, and questions the Claude Code hook logs without knowing which skill asked are left out, so no question counts twice and no `/unknown` row appears. Another project's logs never count. If Bun is missing or the helper fails, the script prints `FRICTION: unavailable` and the rest of the metrics are unchanged.
- **/retro shows a "Friction by skill" row** when any skill had friction in the window, for example `/ship 7 of 12 runs (4 questions, 3 aborts)`.

### Changed
- **/retro's optional-input notes are shorter**: each one says "Read the path it prints" instead of repeating the path, which keeps /retro's always-loaded prompt under its size cap with the new row.

### Tests
- `test/retro-friction.test.ts`: window edges, explicit outcomes only (the stop hook's `unknown` completions are ignored), hook rows taking precedence over agent rows, hook rows with no skill left out, repeated tool calls, machine answers, unsafe skill names, malformed lines, ties and the top three.
- `test/gstack-retro-metrics.test.ts`: a project with both logs plus another project's timeline (not counted), an empty prior window, and a failing `bun` that still ends with `RETRO_METRICS_END: ok`.

Thanks to @thesohamdatta for the idea in #3417. This is a new implementation; no code from that PR was used.
