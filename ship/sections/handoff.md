<!-- AUTO-GENERATED from handoff.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 18-H: Handoff without a PR (automation lanes)

Replaces the pr-body section when the run must not open a PR (`--no-pr`, an
automation lane, an unattended parent said so). Nothing here publishes. What an
unattended run may do is docs/unattended.md#what-an-unattended-session-may-do.

1. Verify-only checks: write Step 16's per-lane pass/fail/skip counts, naming
   `requires-remote` lanes, to `.gstack/tmp/ship-gate.json` as the pr-body
   section does, then (with its Issue links flags; ask nothing):
   ```bash
   ~/.claude/skills/gstack/bin/gstack-issue-links --base <base> --out .gstack/tmp/issues.json
   ~/.claude/skills/gstack/bin/gstack-ship-receipt write --base <base> --gate @.gstack/tmp/ship-gate.json --issues @.gstack/tmp/issues.json --out .gstack/tmp/ship-receipt.md
   ```
   When Step 11 saved `.gstack/tmp/targeted.json`, add `--review-targeted @.gstack/tmp/targeted.json` to that write.
2. Send the completion message, identifiers first, in this order: the `SHIP_RECEIPT:`
   line and receipt block; `branch:` and `sha:` (`git rev-parse HEAD`),
   pushed or `not pushed`; `inputs:` the plan or issue, the base SHA and the spend
   cap; `before/after:` one row per claimed metric, measured on base and on this
   SHA with the command used; `escalation:` the one condition that stops the merge
   (a `requires-remote` lane, an open gate finding, an unverified claim) or `none`.
   `issues:` its lines, unpromoted candidates and lookup failures.
   Full thread ids (`jam_…`) cross-thread.
3. Skip Steps 19 and 21. Run Step 20 with `"version":null` when NO_VERSION applied, then
   Step 22 with `--body .gstack/tmp/ship-receipt.md`.

### Multi-lane runs

Lanes push a WIP commit after each step and gate a pushed SHA.
