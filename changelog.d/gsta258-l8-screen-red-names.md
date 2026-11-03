### Fixed

- **A RED paid screen now names its rule cases.** `gstack-ship-queue ready`, `verify --screen` and `train build` took a screen's red cases only from its behavior and judge panels, so rule cases that failed twice under the flaky-rerun rule never showed up. #3947's screen run 41662815506 printed `SCREEN_VERDICT: … RED flaky=ship-docsync-stale-after` with no `red=` list, and the refusal said "RED on its gate binding". That made it look like the one flaky case had turned the run red, when seven rule cases had actually failed twice. The verdict line and the `QUEUE_SCREEN_RED` refusal now list every case the report marks with ✗ (qa-quick, browse-basic and five more in that run). The verdict itself doesn't change. A case that passes on its one rerun is still green with a FLAKY line, and a case that fails twice is still red.

### Tests

- `test/ship-queue-screen-verdict.test.ts` reads the real gate binding and collector outcomes from run 41662815506. The seven twice-failed rule cases are named red, and the rerun-pass case stays only flaky. Negative control: with just the rerun-pass case left, the run reads GREEN with its FLAKY line. A red that never reran (INFRA, an unreported shard) is still named, and quarantined or passing split panel lines are not.
