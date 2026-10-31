**/ship's scoped second pass runs again instead of failing before any reader starts.** After a blocking fix on a small range, `gstack-review-plan` plans a scoped pass: one fix-check, the Red Team and the native adversarial pass on the range. `gstack-review-dispatch pass` refused that plan with `BRIEF_RENDER_FAILED: a pass dispatches no fix-check reader`, because a fix-check is not a pass reader. Every scoped pass failed this way, and GEVA-82 rendered its briefs by hand to get through (GST-619).

### Fixed
- **`gstack-review-dispatch pass` keeps the fix-check out of the pass manifest and prints it as `FIX_CHECK: planned effort=full (Step 3.5 runs it on its own; not in this manifest)`.** The Red Team and the voices are staged as before, and a resumed pass prints the line again. Step 9's decision text in /ship now says to run that fix-check as Step 3.5 beside the scoped pass. No reader is added or removed: the pass runs the readers the plan already lists.

### Tests
- `test/review-pass.test.ts`: a 24-line fix range after a blocking fix plans `NEXT: scoped`; `pass` exits 0, stages only the Red Team and the adversarial pass, prints the `FIX_CHECK:` line, and prints it again on resume. It fails on the previous dispatch code with `BRIEF_RENDER_FAILED`.
