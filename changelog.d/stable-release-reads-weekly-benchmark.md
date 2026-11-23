### For contributors

- **Every stable release plan now prints the weekly benchmark's result, so you can see whether this week's gstack measurably fixes more or fewer bugs than the current stable release.** The release tool reads the weekly record gstack-evals publishes, and a measured drop will hold the regular cut once holding is switched on after two weekly records. Security, data-loss and regression fixes still ship. A hand-run cut can pass a hold with the new `benchmark_waiver` input. See docs/releases.md#weekly-benchmark.
