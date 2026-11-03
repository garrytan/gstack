**A base merge next to a reviewed hunk no longer forces a second full review because of the base's own lines.** On founderstar#515, a base merge put 62 lines of another PR, already merged at base, next to the PR's 76 reviewed and unchanged lines in `tests/ui_shots.gd`. The scoped-review section went past its 200-line limit, so `gstack-ship-release finish` took the behavior route, which a review-loop exception can't accept, and asked for Steps 5 to 11.5 again. #3923 hit the same limit when only one trailing context line changed (GST-1226).

### Fixed
- **The scoped-review packet counts only the branch's own lines toward its 200-line section limit.** The base's change and the base-added lines that appear as context in the current hunks are still shown to the reader but no longer count, in finish and in the receipt carry. A section the branch's own lines push past the limit still takes the full loop. Context-only drift is not carried silently: it still gets the scoped read.

### Tests
- `test/ship-rereview-triggers.test.ts`: 210 lines another PR merged at base next to the branch's 76 reviewed lines, and a changed trailing context line beside a 221-line base rewrite, both reach the scoped read (both took the behavior route on main). Negative control: a section the branch's own 230 lines push past the limit still takes the behavior route.
