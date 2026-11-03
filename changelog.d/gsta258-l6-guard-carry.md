- A pregate guard whose exact command already passed at this tree no longer runs again (GST-1186). When the base branch's `ship_lanes_from` maps the command, it is carried from the verified CI run through the same `gstack-evidence record-ci` path /ship lanes use (`GUARD: <id> carried runs=…`); otherwise a counted ledger pass of that command at the same working tree stands (`GUARD: <id> reused …`, and the new read-only `gstack-evidence passed -- <command>`). Repos whose suites are guards, like founderstar, stop rerunning about six minutes of suites per /ship. See docs/pregate.md#guard-carry.
- Known limit: `ship_lanes_from` is still read from `origin/<base>` only, so the PR that adds a mapping cannot carry from it.

### Tests
- `test/ship-ci-carry.test.ts`: in founderstar's shape (guards only, no lanes), `check-quick` carries from CI, `play-through` reuses a same-tree ledger pass, `assets` runs, and a dirty tree carries nothing. It fails without the guard carry.
