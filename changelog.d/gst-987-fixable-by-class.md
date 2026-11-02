**/ship's finding collector lets the native reviewer's own Severity field decide outside gate and risk reviews.**

### Fixed

- On a code or docs review with no risk reason (security, secrets, auth, money, user data), no depth error and no history or floor escalation, a native adversarial finding marked FIXABLE that states its own `Severity: Medium` or `Severity: Low` and `Blocks: no` now collects at that severity instead of CRITICAL. Gate and risk reviews, and any collect without this pass's manifest, keep collecting FIXABLE as CRITICAL, and so does a FIXABLE finding without `Blocks: no` or without a Severity field. (GST-987)
