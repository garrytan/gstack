---
important: regression
---
- **/ship's second-model review can be rendered on its own for a PR whose diff is over 2 MB again.** Since the cyber_policy retry change (#4350), the 2 MB review-size ceiling exempts the outside voice by its role, but `gstack-review-dispatch render` built its reader without one, so `render --role outside-voice` on a large PR stopped at `REVIEW_DIFF_TOO_LARGE` instead of writing its brief with a sliced diff. The standalone render now passes the role it was asked for. The ceiling's size, which readers it exempts and the pass manifest's own stages are unchanged, and every other reader on the standalone path is still refused over the ceiling.
