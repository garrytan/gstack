<!-- AUTO-GENERATED from handoff.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 18-H: Handoff without a PR (automation lanes)

Replaces the pr-body section when the run must not open a PR (`--no-pr`, an
automation lane, an unattended parent said so). Nothing here publishes.

1. Verify-only checks: write Step 16's per-lane pass/fail/skip counts, naming the
   lanes that need a remote (`requires-remote`), to `.gstack/tmp/ship-gate.json`
   as the pr-body section does, then:
   ```bash
   ~/.claude/skills/gstack/bin/gstack-ship-receipt write --base <base> --gate @.gstack/tmp/ship-gate.json
   ```
2. Send the completion message, identifiers first, in this order: the `SHIP_RECEIPT:`
   line and receipt block (`pr: none`); `branch:` and `sha:` (`git rev-parse HEAD`),
   pushed or `not pushed`; `inputs:` the plan or issue, the base SHA and the spend
   cap; `before/after:` one row per claimed metric, measured on base and on this
   SHA with the command used; `escalation:` the one condition that stops the merge
   (a `requires-remote` lane, an open gate finding, an unverified claim) or `none`.
   Full thread ids (`jam_…`) in any cross-thread reference, never a short code.
   Prose may follow the identifiers; nothing may precede them.
3. Skip Steps 19 and 21. Run Step 20 with `"version":null` when NO_VERSION applied.
