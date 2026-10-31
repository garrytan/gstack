**A /ship review pass that only left notes now binds at Step 11.5.** A pass whose findings were all fixed, deferred or noted has no open defect, but a driver could still log it as `issues_found`. Step 11.5 then refused it, and the only way out was an extra rebind pass (CAPY-2, qm#2837). When the tree changes during a pass, the refusal now names the start and end trees and the cheapest repair (GST-430).

**Receipt carry and write handle results PRs with thousands of files (GST-448).** A PR that adds about 8,300 run receipts (harness-evals#147) refused every carry with `git could not compute HEAD's product patch-id: git diff … failed`, and every base move cost it about 3 hours of /ship. The name-only listing ran past a 1 MB output buffer.

### Fixed
- **`gstack-ship-receipt carry` and `write`** read git's path listings with a 256 MB buffer instead of the 1 MB default, so a large PR's `product_patch_id` is recorded and carried. The product patch-id streams `git diff` through a file into `git patch-id --verbatim` and no longer holds the diff in memory. The per-path walk compares only touched paths that changed at either head or either base, so a 6,000-path PR refuses or carries in seconds.
- **`gstack-tree-receipt`** fails closed (`EVIDENCE_IDENTITY_UNKNOWN`) when git cannot produce the diff between the gated and current heads. Before, it read a failed diff as no changes.
- **`gstack-review-log`** records a completed `review` or `review-fix-check` row claimed as `issues_found` as `clean` with zero counts when every finding's action is `fixed`, `auto-fixed`, `deferred` or `noted`. A skipped finding, a gate finding left open, a finding with no action, or an incomplete pass keeps the claimed status.
- **Findings files** (`--findings`) count `auto-fixed`, `deferred` and `noted` actions as resolved, the same as `fixed`.
- **`review_freshness`** for a pass whose tree moved now reads `content changed during review: the tree moved from <start> to <end> while <skill> ran …`, followed by the repair: keep the checkout frozen until every reviewer returns, then rerun on the frozen tree (docs/troubleshooting.md#review-content-changed).

### Tests
- `test/ship-receipt-carry-large-diff.test.ts`: a PR that adds 6,000 receipts under a long directory name writes a receipt with its product patch-id and carries across a base merge. Negative control: one rescored receipt still refuses with `RECEIPT_CARRY_PRODUCT_CHANGED`.
- `test/review-notes-only-pass.test.ts`: a pass with three notes is recorded clean and reads CURRENT. Negative controls: a skipped finding, an open gate finding, a finding with no action, and an incomplete pass keep `issues_found`. Also checks the reason a pass gets when its tree moved.
