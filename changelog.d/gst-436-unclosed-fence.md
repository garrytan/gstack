**An outside review that leaves a code fence open can no longer pass as clean (GST-436).** Before, an outside-voice reply that said no issues were found, opened a code fence it never closed, and then listed a `[P1]` finding or ended with `Verdict: not ready` was classified clean, because everything after the fence was treated as quoted code. Now a fence that never closes is not treated as code, so a severity or not-ready verdict after it still blocks.

### Fixed
- `lib/outside-review-result.ts` reads the reply after an unclosed fence's opening line. Closed fences still hide quoted severities.

### Tests
- `test/outside-review-unclosed-fence.test.ts` covers a `[P1]` and a `Verdict: not ready` after an unclosed fence, plus a closed fence that still hides a quoted `[P1]`.
