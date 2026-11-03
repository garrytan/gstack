- A lane label with a space or a colon, such as `pnpm lint` or `db:test`, no longer goes MISSING right after it carries (TRUT-7, truther#1170). `gstack-evidence` writes a label to the ledger with unsafe characters turned into `_`, but `check`, which `gstack-ship-release finish` and `accept` call, looked it up under the raw label, so /ship stopped with "not FRESH at the pushed head". `run`, `record-ci` and `check` now share one label spelling.

### Tests
- `test/ship-ci-carry.test.ts`: `accept` with the lanes `pnpm lint` and `db:test` carries both and checks them FRESH, and `gstack-evidence check` finds both. It failed before the fix (`EVIDENCE: MISSING label=pnpm lint`).
