**A CSO hardening test now fails at the Git step that broke instead of passing without testing anything.** `fixtureGit` in `test/cso-git-hardening.test.ts` threw only on a non-zero exit status. When Git was killed by its 30-second timeout or could not start, `spawnSync` returned a `null` status, and the helper treated that as success. If that happened to the `git replace` step, the test that checks a security snapshot ignores replaced history would pass without a replacement in place. The helper now throws on a spawn error or any status other than 0, and the message names the Git arguments, the status and the signal.

### Tests
- `test/cso-git-hardening.test.ts`: `fixtureGit` throws on `result.error` or `status !== 0` (#3476).
