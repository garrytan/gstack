---
important: blocker
---
**/autoplan no longer asks the owner a third time for changes his "do it" already approved.** When the review rounds run out and the only plan edit since the last gate is the recommendations the owner took in his own words, the run now finishes with no new gate. It prints one `UNREVIEWED:` note saying which revision no reviewer read and why, and `gstack-autoplan rule` records a Captain's or the owner's ruling that closes it, the way /ship ships after its second review round. A change the owner didn't approve still goes to him, now as one item for every phase that hit the cap instead of one item per phase, and a phase that does review the revision still raises its findings. `gstack-autoplan status` shows whether that note is still open. (GST-3753)
