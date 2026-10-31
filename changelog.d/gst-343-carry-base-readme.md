**A PR reviewed before #3654 keeps its /ship receipt after it merges main and moves its entry into `changelog.d/` (GST-343, #3606).** #3656 taught carry that a fragment is release metadata, but the base merge also brought in `changelog.d/README.md`. Carry counted that README as a product change, dropped the fragment rule for the whole range, and refused with RECEIPT_CARRY_PRODUCT_CHANGED although the product patch-id was unchanged.

### Fixed
- **Only the branch's own changes turn release-metadata paths back into product** (`bin/gstack-ship-receipt`). A metadata path whose change is not a stamp still counts as product when the branch changed it against the base. A change a base merge brought in no longer does, because its patch against the base is the same at both heads. A README edit the PR makes itself is still refused. Replayed on #3606 (49666bc8 to e28bb62): carry now reports "base merge + release metadata".

### Tests
- `test/gstack-ship-receipt.test.ts`: the fragment carry case now adds `changelog.d/README.md` on main together with the policy, the way #3654 did. It failed before this fix with RECEIPT_CARRY_PRODUCT_CHANGED.
