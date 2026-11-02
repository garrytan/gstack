**The stamp checks name the branch's lines by position, and the carry and finish accept a kept VERSION claim (GST-979, GST-980).** After GST-963, three gaps were left in the checks that accept a stamp commit, all found by the #3862 reviewers. A base line whose text duplicated a line the branch added got the branch's fork-version bound, so a hand edit of that base copy passed the tree receipt. When a train slot kept its claimed VERSION, a base line moved down to that version also read as a stamp. And the /ship receipt carry and finish refused the fork-version row move the restamp now makes: the carry kept the branch-added row in both product patch-ids (`RECEIPT_CARRY_PRODUCT_CHANGED`), and with a kept VERSION claim the carry and finish read every change as product or behavior.

### Fixed
- **`lib/stamp-only.ts`:** `BranchSide` carries the positions of the branch's lines, and `stampOnlyLine` takes the removed line's position. Only a line at a branch-added position gets the fork-version bound. When the version does not move, only such a line may change.
- **`lib/restamp.ts`:** `parseUnifiedDiff` records each removed line's position on the old side, which the tree receipt, the train checks and finish's `stampedFiles` pass along.
- **`lib/ship-receipt.ts`, `lib/ship-bin-common.ts`:** `stampOnlyText` and `stampedFiles` accept a kept VERSION claim for the branch's own rows and nothing else.
- **`bin/gstack-ship-receipt` carry:** a stamp file the branch changed as product, whose only change since the reviewed head is a stamp on its own rows and which the base did not touch, is left out of the product comparison. The carry records `a stamp on the branch's own rows (<file>)` as the reason. A product edit anywhere else still refuses.

### Tests
- `test/tree-receipt-stamp-sensitive.test.ts`: the bound holds only at the branch line's position, and a kept VERSION refuses a base line moved down.
- `test/restamp-mentions.test.ts`: a hand move of a base row whose text the branch duplicates reads `TREE: changed`, and the carry follows the fork-version row stamp but still refuses a product edit beside it.
- `test/gstack-ship-receipt-docs.test.ts`, `test/ship-rereview-triggers.test.ts`: the carry classifier and finish accept the kept-claim row move and refuse a base row moved the same way.

On main, all five new tests fail.
