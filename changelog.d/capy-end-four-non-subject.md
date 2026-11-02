**Four free-suite waits now end when the thing they wait for happens: the six files involved spend 18–29 s less in summed per-file runtime, with every assertion intact.** `./setup` returns from a finished child up to ~0.9 s sooner too.

### Changed
- **`setup` `_wait_with_deadline`**: polls every 0.1 s and tracks the deadline on bash's `SECONDS` clock instead of sleeping a whole second per poll. A child that exits at once no longer costs a second. The kill still lands no earlier than the deadline, the exit codes (the child's status, or 124 after the kill) are unchanged, and it runs under bash 3.2.

### Tests
- `test/setup-playwright-best-effort.test.ts`: a child that exits with 3 after 50 ms returns 3 in under 500 ms (the old loop took 1,008 ms); the deadline and kill cases are unchanged. The file drops from ~20.8 s to ~5.9 s on a CI-mirror VM.
- `test/pregate-supervise.test.ts`: the leftover-child case waits for that child's pid to exit (bounded at 3 s) instead of a fixed 2.5 s sleep.
- `test/gstack-detach.test.ts`: the detach and lock bodies wait on files the test writes (bounded at ~10 s, also written in `finally`) instead of `sleep 2` and `sleep 3`.
- `test/qa-probe-gates.test.ts`: the duplicated "judge-named QA workflow gaps (C2)" block is gone (3 tests that repeated the first block).
- `test/context-identity.test.ts`: one `restore(mono)` call serves both assertions.
