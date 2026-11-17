---
important: blocker
---
**/ship stops asking owners for grants around its own bookkeeping.**

### Fixed
- **A round grant now buys the round its `PR_ROUND_CAP` stop names.** When a pull request past its two review rounds got a read-only final review that found a blocker, the lane's round grant at that head raised the cap by one, but the read-only pass already counted as that round, so the next run was read-only again and no fix round opened (gstack#4272 needed a new PR; ghome#17 needed a second grant). `gstack-ship-receipt stub` now marks a run that started past the cap `read_only`, and once a grant applies, `history` leaves those passes out of `--prior-full`. The granted round also keeps its fix round (its pass 2), and nothing past it plans. A grant now also applies across a base merge that leaves the PR's own added and removed lines byte-identical, since preflight merges the base before the review; a head that changes those lines still needs a new grant. See docs/review-policy.md#rounds-per-pull-request.
