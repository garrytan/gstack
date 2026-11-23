---
important: blocker
---
**Posting a PR body that lists earlier /ship runs no longer stops for a card number that isn't there.** About 1 in 10 /ship run ids (`<pid>-<epoch>-<8 hex>`) also passes the card-number checksum, so `gstack-post` still asked for a confirmation on those bodies after the phone-number fix. The run id of a well-formed line in the earlier-runs block, and of the ship receipt itself, is now skipped for the card-number check too, only when the whole card-shaped number lies inside that run id; a card number in any other field, or written as a run id of any other shape, is still caught. Reported by @dgrant (#4725).
