# Per-PR review rounds replay: results (GST-2673)

We learned that a reviewer shown only the diff since the last reviewed head catches planted one-line bugs but missed
every real fault that later full review rounds had caught. You should give a pull request's final head a full review
before it merges, and treat a diff-only re-check as advice: that is what gstack's /ship now does.

Preregistration: [pr-round-count-prereg.md](pr-round-count-prereg.md), locked 2026-11-13 before any paid call. All
figures below are counts with 95% Wilson intervals.

## What worked

- **Counting rounds per pull request works.** The counter reads the receipt history the PR body already keeps. Over
  306 gstack PRs with receipts it changed no plan (none had three or more /ship runs, 295 had one). In the other
  crew's sample of 88 PRs, 2 had three or more runs and both had gone past two rounds, which is the case the stop rule
  is for.
- **The re-check reader finds planted bugs and stays quiet on clean heads.** On gstack's own PRs it found 22 of 24
  seeded faults (0.92, 0.74 to 0.98) and flagged no blocker on 12 clean heads (0 of 12, 0 to 0.24).

## What didn't

- **It missed all 8 real faults.** Another crew's internal product supplied 8 faults that review fixes had created
  after round 1 and a later full round had caught. The re-check reader found 0 of 8 (0 to 0.32). Paired against the
  full round that found each one (8 of 8 by construction), the difference is -1.00 (-1.00 to -0.68). It wrote no
  finding on 34 of 36 reads, so the scorer is not the cause. The other 2 reads, both on one fault, named the right
  file and fault 14 lines from the labelled line, outside the preregistered 3-line window; read leniently that is 1 of
  8 (0.02 to 0.47). It flagged none of 3 clean heads from that sample.
- **Bar 1 failed.** Recall over all 32 positives was 22 of 32 (0.69, 0.51 to 0.82), under the 0.85 bar. Bar 2 held:
  0 of 15 controls failed (0 to 0.20). The preregistered verdict is FIX-METHOD.
- **Why null?** The reader did read the range. The real faults sit in it, but each is wrong only against code, data
  or deployment order outside the diff (a migration that sorts before the backfill it depends on, a sign-in id
  compared against the wrong field), while every seeded fault is visible on its changed line. The 8 faults come from
  3 PRs, so they are not independent draws; even counting each PR as one draw, missing all of them at a true recall of
  0.85 has odds of about 1 in 300. The reader had no repository access, as preregistered, so a reader that can open
  files may do better; that is not measured.

## What changed

The count and the stop at two full rounds stay. A head whose own added and removed lines are byte-identical to the
reviewed head's keeps its receipt, as before. Any other head gets a fresh full review, the PR's last before merge; a
PR already at two full rounds gets one read-only full review with no fix round. The scoped re-check still writes its
packet, but it never carries a receipt, and that also changes the carry re-check that was already on main
([rounds per pull request](../review-policy.md#rounds-per-pull-request)). The drift threshold Part 1 was to tune is
gone with the re-check route: it never fired on either sample.

## Departures from the preregistration

- 15 controls ran, not 16: the other crew's sample had 3 clean later heads, not 4.
- The private leg ran twice. The first run's scorer dropped findings written in bold, and its raw output was deleted
  before that was noticed, so it could not be rescored. The prereg forbids rerunning a harness failure; the rerun,
  with the repaired scorer, is the one reported above.
