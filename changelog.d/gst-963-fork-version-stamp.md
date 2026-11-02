**A version stamp the branch added at its fork point's version now counts as stale after the base moves (GST-963).** On gbrain #8425, a branch added a row that named the fork point's version. After main moved past it, `gstack-restamp` skipped the row ("no tentative mention") and `gstack-ship-release finish` routed the line as a behavior change, so the stamp kept the old version and the docs stage flagged a product edit.

### Fixed
- **`lib/restamp.ts`:** a stamp_patterns match on a branch-added line that names the fork point's version is rewritten to the new version, like a mention of a newer tentative version. Lines the branch did not add, and versions below the fork point, are left alone.
- **`lib/ship-bin-common.ts`:** finish routes such a line as metadata (a stamp file), not behavior.
- **One stamp bound for the writer and every check** (`lib/restamp.ts` `stampOnlyLine` with the branch's side): the tree receipt behind `gstack-ship-queue stamp`, `verify` and the gate-ahead replay, the /ship receipt carry, and finish's route now accept a moved version on a line the branch added at or above the fork-point version. Before, the tree receipt and the carry still floored every line at the gated head's VERSION, so the stamp commit the writer now makes would have read `TREE: changed` and stopped the train with `QUEUE_STAMP_NOT_STAMP_ONLY`. The same move on a base line is still refused.

### Tests
- `test/restamp-mentions.test.ts`: a branch-added row at the fork version after the base moved is restamped and its file is routed as metadata. On main, the stage reports `skipped` and ROUTE counts the file as behavior.
- `test/ship-rereview-triggers.test.ts`: the GST-895 fork-version case now routes as metadata.
- `test/restamp-mentions.test.ts`: `gstack-tree-receipt` reads the GST-963 stamp commit as `same-modulo-stamps` (it read `TREE: changed` before the shared bound), refuses the same move on a base row, and still accepts the GST-895 lost-slot stamp. `test/gstack-ship-receipt-docs.test.ts`: the carry takes the fork-version bound only on the branch's own line.
