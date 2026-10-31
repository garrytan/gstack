**A test can keep an old value on purpose without turning off `literals` (#3490).** When a minimum version goes up, the test that checks the old version is refused has to keep the old value, and pregate failed it with `PREGATE_LITERALS`. The only way out was `warn: ["literals"]`, which turns the check off for every constant. Now that one line can carry `// pregate-literal: NAME=<old value> <reason>`.

### Added
- **`pregate-literal:` markers.** A marker on the flagged line, or on the comment line directly above it, waives that line when it names the changed constant and its old value and gives a reason. Every other line in the file is still checked, and text inside a string is not a marker. The policy has no waiver key, so neither a base nor a pushed `pregate.json` can widen it.
- **Waivers are listed.** `literals` prints each waived line as `waived: <file>:<line>: <NAME> <old> (<reason>)` and adds `marker added on this branch` when the merge-base file lacks the marker, so a reviewer sees every new waiver.

### Changed
- **docs/pregate.md** and **docs/troubleshooting.md** (`PREGATE_LITERALS`) describe the marker.
