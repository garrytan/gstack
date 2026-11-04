bump: micro
---
### Fixed
- **`/runaway-stopper` no longer reports a clean sweep when it was run from outside the crew.** The skill tells big crews to run its scan from a fresh automation thread. That thread belongs to no crew, so its crew list came back empty and the scan checked only itself, then printed a clean `SWEEP:`. The program now takes the Captain's code (`captain`) and writes the crew list to `crew.json`. `gstack-runaway scan --dir` treats an empty list as `RUNAWAY_INPUT` and exits 1.
