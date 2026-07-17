# GStack 2.0 status

**Current state: BASELINED AND MAPPED — NOT IMPLEMENTED, NOT VERIFIED, NOT
DONE.**

This checklist separates evidence capture from delivery so generated plans or
passing narrow tests cannot be mistaken for a completed rewrite.

## Phase checklist

- [x] Freeze the audit base at
  `bb57306d98c97011b0919c6132705a15b1579781`.
- [x] Record template/output/section, line, byte, repeated-preamble, catalog,
  host, and installer-discovery baselines.
- [x] Capture the baseline command logs without relabeling pre-existing
  failures as passes.
- [x] Flatten and reconcile every frozen open issue/PR snapshot into one
  deterministic map (755 unique items from 1,184 endpoint records).
- [x] Trace all 16 required PRs to their detail snapshots, changed-file
  snapshots, component, judgment module, and replacement-test contract.
- [ ] Review and approve the GStack 2.0 architecture and migration contract.
- [ ] Convert heuristic backlog dispositions into accepted product/engineering
  decisions. `NEEDS_EVIDENCE` is intentionally the majority disposition.
- [ ] Implement the consolidated judgment modules and runtime components.
- [ ] Implement the replacement contract tests named in `BACKLOG-MAP.json`.
- [ ] Prove legacy setup migration and standard-installer discovery without
  root/nested skill shadowing.
- [ ] Prove behavior and safety parity across all 10 generated hosts.
- [ ] Re-run the broad, Windows-safe, design, and iOS suites with complete
  terminal summaries; separate repaired baseline failures from regressions.
- [ ] Produce release evidence and make an explicit ship/no-ship decision.

## Evidence index

| Evidence | Path | State |
|---|---|---|
| Measured baseline | [`BASELINE.md`](./BASELINE.md) | Recorded |
| Baseline command results and failures | [`TEST-EVIDENCE.md`](./TEST-EVIDENCE.md) | Recorded; baseline is not green |
| Deterministic backlog generator | [`../../scripts/gstack2/generate-backlog-map.ts`](../../scripts/gstack2/generate-backlog-map.ts) | Implemented and locally validated |
| Complete mapped backlog | [`BACKLOG-MAP.json`](./BACKLOG-MAP.json) | Generated from frozen snapshots |
| Baseline logs | `/tmp/gstack2-baseline-logs/` | External/ephemeral audit evidence |
| time-attack snapshots | `/tmp/gstack2-{open-items,open-prs,label}-pages.json` | External/ephemeral frozen input |
| garrytan snapshots | `/tmp/gstack2-upstream-{open-items,open-prs,label}-pages.json` | External/ephemeral frozen input |
| Required PR evidence | `/tmp/gstack2-port-prs/{610,...,2189}{,-files}.json` | External/ephemeral frozen input |

## Interpretation rules

- `PORT_JUDGMENT` means “port the decision/policy with a replacement test,”
  not “apply the upstream patch verbatim.”
- `FIX_IN_GSTACK_2` still requires a reproduced defect.
- `NEEDS_EVIDENCE`, `DEFER_COMMUNITY`, and
  `SUPERSEDED_BY_CONSOLIDATION` remain review decisions, not closed GitHub
  items. The generator performs no external mutation.
- The heuristic map is deterministic triage. Title-first and narrow body rules
  make it auditable, but human approval is still required before implementation
  or upstream disposition changes.
