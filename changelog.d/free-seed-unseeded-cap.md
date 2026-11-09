---
important: blocker
---
- **Free Tests no longer fails every PR's plan when the test-duration seed goes stale.** Test files missing from `scripts/free-test-durations.json` are still packed at the seed's 99th percentile, but when that estimate would push a CI shard's job past the 90-minute cap, `--ci-plan --job-setup-seconds` now cuts the shard's prediction back to the cap instead of throwing `FREE_JOB_TIMEOUT_OVER_CAP`. Recorded durations are never cut, so a shard whose seeded files alone need more than 90 minutes still fails the plan, and plans under the cap are unchanged. The seed is refreshed from a new recording (196 files had no recorded time), and a weekly seed PR that is closed without merging now opens a blocker issue, which closes when a seed PR from the recorder merges.
