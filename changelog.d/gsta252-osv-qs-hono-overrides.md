**The weekly OSV scan is clean again: qs and @hono/node-server are pinned past two Medium advisories (#3843).** The 2026-11-02 scan (run 41406416003) flagged qs 6.16.0 (GHSA-6pq8-jhm2-2vcw, CVSS 6.3, a `qs.stringify` comma-format crash) and @hono/node-server 2.1.1 (GHSA-rmxm-3fg6-px4f, CVSS 5.3, a `serveStatic` double decode that skips middleware). Both reach gstack only through the dev and test toolchain (`@anthropic-ai/claude-agent-sdk` pulls in `@modelcontextprotocol/sdk`), and nothing setup, the build or an installed skill runs loads either one. Installs set up since v1.91.231.0 don't contain them at all. Older installs and contributor checkouts that still carry the dev toolchain get the patched versions on their next `./setup`.

### Fixed
- **`package.json` overrides**: `qs` is pinned to 6.16.2 and `@hono/node-server` to 2.1.6, the newest patch releases inside the ranges express, body-parser and the MCP SDK ask for. `bun.lock` now holds one copy of each, and the separate `body-parser/qs` entry is gone.

### Tests
- `test/dependency-security.test.ts`: the lockfile floor check now covers `qs >= 6.16.1` and `@hono/node-server >= 2.1.3`. Both cases failed on main.
