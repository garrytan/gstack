**A real bug now gets the CRITICAL label because of what it breaks, not because of the checklist section or reviewer lens that found it (GSTA-160).** The core checklist, every specialist and the fix-check carry one blocking-floor sentence: a finding that would fail a test, break production, or lose data or secrets, or open a security hole (injection, auth bypass, secret exposure) is CRITICAL, and everything else is INFORMATIONAL. On a preregistered replay of GSTA-11's 12 real gstack bugs, Opus 5.5 with gstack's /review prompts went from 4 to 6 CRITICAL catches out of 36 trials. False alarms on clean decoys fell from 5 to 3 of 24 (Haiku: 7 to 4). The replay's main bar was 10 catches, and Garry approved shipping below it; the remaining gap is GST-389.

### Changed
- The checklist's two passes now set check order, not severity. The headings are "Pass 1 — check first" and "Pass 2 — check second", and the Severity Classification section opens with the floor, so a Pass 2 finding such as a /retro date-window bug can be CRITICAL.
- **One floor sentence, `BLOCKING_FLOOR`** in `scripts/resolvers/review-floor.ts`, builds on the prose voices' floor words in `lib/review-scope.ts` and adds the security clause. The specialist schema line uses it; the fix-check prompt, `review/SKILL.md`, docs/review-policy.md and docs/ship-policy.md carry it word for word, and `ship/SKILL.md`'s review policy line names the same four cases.
- **Shell injection is no longer Python-only.** It covers bash `eval`, `source` and `sh -c` built from a file, environment variable, argument or network value.
- **A state swap before a step that can fail, with no rollback,** is a Pass 1 check (GSTA-159's miss).
- **The Testing specialist files a floor-level product defect as `correctness`,** so it blocks instead of reading as a test gap.

### Tests
- `test/review-severity-floor.test.ts` checks that the floor appears in every copy, that no checklist heading names a severity, that shell injection covers bash, and that the state-swap check exists. It also checks that a `correctness` CRITICAL from the Testing specialist stays blocking through `classifyFindings`.
- `test/review-packets-removed.test.ts` pins five reviewer briefs under a `GSTA-160` replay entry (prereg 4c53e80a; GSTA-167's cohort no-loss arm on these bytes is pending).
