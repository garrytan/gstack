**`gstack-ship-preflight --timeout` reaches Step 5's pregate (GST-1196).** Preflight ran `gstack-pregate` with no way to pass `--timeout`, so on a repo whose `.gstack/pregate.json` sets no `timeout_s`, a test group longer than 600 s always stopped with `PREGATE_INCOMPLETE`. The only workaround was a separate `gstack-pregate --timeout 1800` before finish (gstack-evals #176 and #179).

### Fixed
- **`gstack-ship-preflight`:** `--timeout <s>` (whole seconds, 1 to 3600) is passed to Step 5's pregate as its `--timeout` and overrides the policy's `timeout_s`. When it isn't set, `timeout_s` applies, and the default is 600 s, as the help now says. A bad value exits with usage (2).
- **`docs/pregate.md`:** the `timeout_s` row says preflight now forwards `--timeout`.

### Tests
- `test/ship-preflight.test.ts`: `--timeout 2` bounds a 4 s test under a 600 s policy and `PREGATE_DETAIL` names `--timeout`; 0, 3601, 1.5 and x are usage errors.
