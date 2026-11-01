**/ship's review collector keeps every severity label again, so a blocker named after "no CRITICAL issues except" is no longer lost.** v1.92.29.0 (GST-766) skipped any severity word that followed "no", "nothing", "none" and similar words, to stop a reviewer's closing line like "found nothing CRITICAL" from counting as a finding. That also threw away real blockers named in an exception clause: "No CRITICAL issues except the token leak in log.ts:3", "Nothing CRITICAL apart from the auth bypass (auth.ts:9)" and four more wordings collected nothing at all, so the gate never saw them. The collector now reads labels exactly as it did before v1.92.29.0. The reviewer's own Severity and Blocks fields are still recorded beside the label (`stated`), as in v1.92.29.0.

### Known
- **A reviewer's closing summary collects at its label again.** Lines like "found nothing CRITICAL" or "Neither finding is CRITICAL." collect as CRITICAL, the same as before v1.92.29.0. They are known phantoms for lead judgment, and a lost blocker costs more than an extra one.

### Tests
- `test/review-dispatch.test.ts`: the six exception-clause wordings collect CRITICAL for every reader. GST-766's test that a negated label collects nothing now checks that each of those lines keeps its label. GST-435's label-keeping probes (table rows, FIXABLE, negated subjects, closing summaries kept as known phantoms) are added with their HARN-15 and GEVA-77 fixtures under `test/fixtures/review-ledger/`.

### Docs
- `docs/review-policy.md` (collect) says a negated severity word still collects at its label.
