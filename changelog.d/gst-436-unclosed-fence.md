**An unclosed code fence in an outside review no longer hides a later `[P1]` or not-ready verdict (GST-436).** Before, an outside-voice reply that said no issues were found, opened a code fence it never closed, and then listed a `[P1]` finding or ended with `Verdict: not ready` was classified clean, because everything after the fence was treated as quoted code. Now a P0 or P1 severity or a last `Verdict: not ready` after an unclosed fence still blocks. Text inside that fence still can't make a reply clean, so a quoted `Verdict: ready`, `[P3]` or `No issues found.` there is ignored, as before.

### Fixed
- `lib/outside-review-result.ts` reads the reply after an unclosed fence's opening line for severities (P0 and P1, or Critical and High words, block), an unparsed label (which makes the review `unverified`) and a last `Verdict: not ready`. The evidence for clean (a parsed severity, the last verdict line, the no-findings conclusion) keeps that text blanked. Closed fences still hide quoted severities.
- Fence matching is one pass, and an opener counts only when a later marker of its kind is at least as long. A reply with thousands of unmatched fences classifies in milliseconds instead of rescanning the rest once per fence.

### Tests
- `test/outside-review-unclosed-fence.test.ts` covers:
  - a `[P1]` and a `Verdict: not ready` after an unclosed fence
  - a closed fence that still hides a quoted `[P1]`
  - a quoted `Verdict: ready`, `[P3]` or `No issues found.` inside an unclosed fence, which stays findings or unverified
  - 3,000 unmatched fences
