**/ship's review collection keeps every label a reviewer writes, and new tests lock that in.** GST-435 tried three ways to stop a reader's own closing summary ("I found three INFORMATIONAL issues and no CRITICAL ones", "Neither finding is CRITICAL.") from collecting as a CRITICAL finding. Each version lost a real blocker in review, for example "The token leak in log.ts:3 blocks the merge. Nothing else is CRITICAL." A fix that kept a list item's title when its label first shows up in a later paragraph also put labels on the wrong finding in review. Collection is unchanged from before, and the tests now hold it there. What reviewers see is unchanged too, and every brief renders byte for byte as before.

### Known
- **A reader's own closing summary still collects at its label.** Lines like "I found three INFORMATIONAL issues and no CRITICAL ones", "found nothing CRITICAL" and GEVA-77's "Neither finding is CRITICAL." collect as CRITICAL, and `judge` won't let the lead drop them, so the lead folds each one. A follow-up will tag these lines `summary_candidate` and let `judge` dismiss a tagged line on record.
- **A list item whose label first appears in an indented later paragraph still collects as that paragraph alone.** In HARN-15's ship2 run, native item 4 ("The host lock is not atomic") collected as its "Fix: …" paragraph without its title. The fix is deferred to the same follow-up.
- "Severity: Low (not High)" collects as High, as before.

### Tests
- `test/review-dispatch.test.ts`: every line the GST-435 review rounds found losing or lowering a label collects at its label, including exception clauses, negated subjects, "else" and "other", and a blocker named in an earlier sentence. So do fix-check 5's table rows and harness-evals #152's native FIXABLE findings. The HARN-15 and GEVA-77 summaries are listed as known phantoms that keep their label. An indented JSON finding, an indented label heading and a later `Blocks: yes` under a list item keep their label on the right finding. Fixtures under `test/fixtures/review-ledger/` (already registered to that test).

### Docs
- `docs/review-policy.md` (collect) says a closing summary collects at its label and the lead folds it.
