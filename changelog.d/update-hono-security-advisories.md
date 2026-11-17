---
important: security
---
**hono is pinned to 4.13.16, which fixes five advisories the weekly OSV scan found in 4.13.13 (gstack#4406).** The 2026-11-16 scan (run 43825448246) flagged GHSA-3gg2-335m-rxc6 (CVSS 3.4, the `css` helper) and GHSA-46wx-v44x-9hh2, GHSA-4h7h-rv7c-7m2v, GHSA-4m76-xfj5-7975 and GHSA-h7mg-cq63-vhpq (CVSS 5.3 each: `csrf()`, `validator('form')`, `mount()` and RegExpRouter wildcard middleware). hono reaches gstack only through the dev and test toolchain (`@anthropic-ai/claude-agent-sdk` pulls in `@modelcontextprotocol/sdk`), gstack's own code never imports it or starts a hono server, and none of the affected helpers is used, so no advisory was reachable. Contributor checkouts get the patched version on their next `bun install`.

- **`package.json` overrides**: `hono` moves from 4.13.13 to 4.13.16, the release that fixes all five. `bun.lock` holds the one copy.
- `test/dependency-security.test.ts`: the lockfile floor check now covers `hono >= 4.13.16`. It fails on main.
