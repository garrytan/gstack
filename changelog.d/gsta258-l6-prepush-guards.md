- Housekeeping checks now run before every push instead of after a CI round (GST-1138, ship-90-90 plan). `gstack-pregate --stage guards --allow-repo-commands` runs only generated-file freshness (`regen`) and the repo's `guards`, each only for the files the branch touched, and writes `.gstack/tmp/pregate-guards.json` so it never replaces the full run's record. `gstack-ship-release push` runs it before every push, early or final, prints `GUARDS:`, and stops with the guard's fix when one fails, pushing nothing. A pass already recorded at HEAD's exact tree, by push itself or by `finish`'s preflight, is reused instead of rerun. See docs/pregate.md#prepush.
- gstack declares its own guards in `.gstack/pregate.json`: typecheck, the skill size guards, the parity suite, the context-budget ratchet, the module-size ratchet, the /ship goldens and the CLAUDE.md size cap. gbrain had 64 of 93 red heads from checks like these, and #3908 went red on the context-budget ratchet. Every gstack at or above this repo's version floor already reads the `guards` key, so the floor does not move.

### Tests
- `test/pregate-guards.test.ts`: `--stage guards` runs only `regen` and `guards`, writes its own record and refuses `--only` and `--from-run`; gstack's guard list validates, names test files that exist and fires only on its own inputs.
- `test/ship-release.test.ts`: a failing guard stops the push with its fix and pushes nothing; a pass at the same tree is reused, and a new commit runs the guards again.

On main, all five new tests fail.
