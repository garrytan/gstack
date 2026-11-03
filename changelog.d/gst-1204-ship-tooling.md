**Three /ship tooling fixes from the gbrain-evals F1 rollout (GST-1204).** Version strings quoted in lane reports no longer trip the secret scan, `gstack-pr-shots` renders on a fresh Capy machine, and `gstack-models` explains why it has no outside-voice role.

### Fixed
- **Secret scan (`pii.ip_public`):** a four-part version that gstack names right before it, shaped like a gstack release (major 0 to 2), is not read as a public IPv4 address. That covers `gstack 1.94.4.0`, `upgraded gstack from 1.93.14.0`, and the install check's trailers `gstack: ok 1.94.4.0 for=ship` and `gstack: fail claude,codex (1.93.37.0)`. It also covers the far end of a range whose first end is a declared version with the same major (`gstack 1.94.4.0 to 1.94.8.0`). Before this, every push and PR-body post that quoted those lines stopped on a MEDIUM finding. Real addresses still report: `gstack 8.8.8.8`, `gstack talks to 8.8.8.8`, `gstack-proxy 1.128.1.0`, `my-gstack 1.94.4.0`, `landed in 1.94.4.0`, `gstack 1.94.4.0 - 8.8.8.8`, and a range with no declared first end.
- **`gstack-pr-shots` and every renderer that uses gstack's own browser:** when Playwright's Chromium isn't installed (the Capy install defers it to first use), the renderer now runs the checkout's `bin/gstack-browser-ensure` once and retries. Before, it stopped with `browse newtab failed: [browse] Starting server...`, which hid the cause. When the install fails, the error names the launch failure and the installer's last line instead of the daemon's banner.
- **`gstack-models resolve --role outside-voice`:** it still exits as a usage error, but now says the outside voice follows the harness, not the model policy, and points to docs/model-policy.md.

### Tests
- `test/redact-context-exemptions.test.ts`: six gstack-named version shapes stay clean; twelve address controls still report MEDIUM.
- `test/aside-render.test.ts`: a missing Chromium runs gstack-browser-ensure once and the render proceeds; the install time doesn't count against the render deadline; a failed install names the launch error; the existing newtab cases are unchanged.
- `test/model-policy-cli.test.ts`: the outside-voice hint.
