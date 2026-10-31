**/ship's review collection keeps a list item's title when its label first appears in a later paragraph, and no reviewer wording can hide a blocker.** In HARN-15's ship2 run the native adversarial voice wrote "4. **The host lock is not atomic** (`qm-stack.ts:66-76`)", two detail bullets, and then an indented "Fix: … FIXABLE. Severity: Low." paragraph. `collect` stored the finding as the Fix paragraph alone, so the lead could not tell which finding it was. What reviewers see is unchanged, and every brief renders byte for byte as before.

### Fixed
- **A list item whose label first appears in an indented later paragraph collects as that item.** The finding now starts with the item's first line. A labeled item's own labeled later paragraph is still its own finding.

### Known
- **A reader's own closing summary still collects at its label.** Lines like "I found three INFORMATIONAL issues and no CRITICAL ones", "found nothing CRITICAL" and GEVA-77's "Neither finding is CRITICAL." collect as CRITICAL, and `judge` won't let the lead drop them, so the lead folds each one. Three drafts of a rule that dropped such labels each lost a real blocker in review (for example "The token leak in log.ts:3 blocks the merge. Nothing else is CRITICAL."), so the drop was removed. A follow-up will tag these lines `summary_candidate` and let `judge` dismiss a tagged line on record. "Severity: Low (not High)" collects as High, the same as before.

### Tests
- `test/review-dispatch.test.ts`: every line the three review rounds found losing its label (exception clauses, negated subjects, "else" and "other", a blocker named in an earlier sentence), fix-check 5's table rows and INFORMATIONAL cases, and harness-evals #152's native FIXABLE findings collect at their label; the HARN-15 and GEVA-77 summaries are listed as known phantoms that keep their label; the ship2 native reply collects 6 findings with item 4's title. Fixtures under `test/fixtures/review-ledger/` (already registered to that test).

### Docs
- `docs/review-policy.md` (collect) describes the later-paragraph rule and the closing-summary phantom.
