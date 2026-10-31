**The free suite moves from `ubicloud-standard-2` to `ubicloud-standard-4`, still at 20 shards, because standard-2 made Free Tests slower than its revert rule allows.** #3617's week-1 check measured three paired rounds at main 5ba425af. On standard-2 the slowest shard took 380, 396 and 388 s, against 314, 327 and 336 s on standard-8, and runs finished in 514 to 526 s against 405 to 434 s. On standard-4 the slowest shard took 323, 335 and 317 s, inside standard-8's 313 to 336 s range from the same day's paired runs. Per shard, standard-4 runs 10 to 15 % slower than standard-8 and costs about 57 % as much per run, so it keeps most of the saving without slowing the run's slowest shard.

### Changed
- **`.github/workflows/free-tests.yml`**: `FREE_SUITE_RUNNER` is `ubicloud-standard-4`. The shard count, the dispatch overrides and the `RESOURCES:` line are unchanged.
- **docs/TESTING_INTERNALS.md** names the new runner.
