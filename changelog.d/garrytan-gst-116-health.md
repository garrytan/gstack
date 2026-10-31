**`/health` now finds its tools with gstack's detector, the same one `/verify` uses, and a test proves it still finds every check it found before.** /health Step 1 used to carry its own shell block for detecting a type checker, linter, test runner, knip, shellcheck and gbrain, a second copy of the list in `lib/checks.ts`. It now runs `gstack-checks detect --for health`. Scoring, the gbrain sub-score and history are unchanged. GST-116, PR 2 of 2.

### Changed
- **`gstack-checks detect --for health`** prints one `DIMENSION <name> <command>  (<source>)` line per tool, or `DIMENSION <name> none  (<reason>)` so Step 2 can record the category as skipped with its reason. A `## Health Stack` section in CLAUDE.md still wins row for row, test rows included. Otherwise it applies /health's own rules, including a knip or shellcheck found on PATH and gbrain when `~/.gbrain/config.json` exists. It reads files and PATH and runs nothing.

### Tests
- `test/health-detect-no-loss.test.ts` runs the old Step 1 block, frozen verbatim in `test/fixtures/health-detect-legacy.sh`, beside the new detector on 16 fixture repos and two PATH and HOME setups. Every check the old block printed must still be found. Dropping the knip or gbrain rule fails the test.
