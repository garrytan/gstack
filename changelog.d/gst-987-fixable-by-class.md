**/ship's finding collector lets the native reviewer's own Severity field decide outside gate and risk reviews.**

### Fixed

- On a review whose class is not gate and that carries no risk reason (security, secrets, auth, money, user data), a native adversarial finding marked FIXABLE with its own `Severity: Medium` or `Severity: Low` now collects at that severity instead of CRITICAL. Gate and risk reviews, depth errors and any collect without a pass manifest keep collecting FIXABLE as CRITICAL, and a FIXABLE finding with no Severity field still collects as CRITICAL. (GST-987)
