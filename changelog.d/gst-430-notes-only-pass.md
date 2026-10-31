**A /ship review pass that only left notes now binds at Step 11.5.** A pass whose findings were all fixed, deferred or noted has no open defect, but a driver could still log it as `issues_found`. Step 11.5 then refused it, and the only way out was an extra rebind pass (CAPY-2, qm#2837). When the tree changes during a pass, the refusal now names the start and end trees and the cheapest repair (GST-430).

### Fixed
- **`gstack-review-log`** records a completed `review` or `review-fix-check` row claimed as `issues_found` as `clean` with zero counts when every finding's action is `fixed`, `auto-fixed`, `deferred` or `noted`. A skipped finding, a gate finding left open, a finding with no action, or an incomplete pass keeps the claimed status.
- **Findings files** (`--findings`) count `auto-fixed`, `deferred` and `noted` actions as resolved, the same as `fixed`.
- **`review_freshness`** for a pass whose tree moved now reads `content changed during review: the tree moved from <start> to <end> while <skill> ran …`, followed by the repair: keep the checkout frozen until every reviewer returns, then rerun on the frozen tree (docs/troubleshooting.md#review-content-changed).

### Tests
- `test/review-notes-only-pass.test.ts`: a pass with three notes is recorded clean and reads CURRENT. Negative controls: a skipped finding, an open gate finding, a finding with no action, and an incomplete pass keep `issues_found`. Also checks the reason a pass gets when its tree moved.
