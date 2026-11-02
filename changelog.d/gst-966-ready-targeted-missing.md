**The queue now refuses a head whose required targeted review is missing or failed (GST-966).** On gstack-evals#140, the receipt showed `REVIEW_TARGETED: required=auth receipt=legacy verdict=missing` and `gstack-ship-queue ready` still exited 0, so a skipped required reader looked the same as a clean one.

### Fixed
- **`lib/ship-receipt-depth.ts`:** `ready`, `train build` and `land` refuse `QUEUE_RECEIPT_TARGETED_MISSING` when the head needs a targeted class (money, gate, auth or secret) that no done targeted pass in the receipt covers: no pass recorded, a failed or unrun pass, or a pass on other classes. The line says `verdict=failed` when the recorded pass failed. A head that needs no targeted class passes as before. `train build` and `land` print the `REVIEW_TARGETED:` line with the refusal.

### Tests
- `test/gstack-ship-queue.test.ts`: `ready` on an auth head with #140's receipt shape (missing) and with a failed pass refuses with the new code; a done pass and a head that needs no class pass. On main the missing case exits 0.
