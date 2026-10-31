**A merge train now carries up to five READY PRs instead of three.** That means fewer full gates for the same number of PRs. A short train still leaves one hour after its oldest READY.

### Changed
- `.gstack/ship-policy.json`: `train.max_size` goes from 3 to 5 (Garry, 2026-10-31). `fill_hours` stays at 1. `test/gstack-ship-policy.test.ts` pins the new value. Four READY PRs wait for the hour, and the fifth fills the train. The example block in docs/ship-policy.md, which shows gstack's own policy, now reads 5.
