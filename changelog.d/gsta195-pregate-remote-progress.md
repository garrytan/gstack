**`gstack-pregate --remote` no longer dies at 300 s while its gate waits on CI.** CAPY-1 (qm#2837) had a remote gate that waits for a CI run and prints nothing while it waits, so pregate killed it as stalled after 300 s, whatever `--timeout` said, and the heartbeat gave no hint of what the gate was doing (GST-431).

### Fixed
- **The remote gate is bounded by its timeout only** (`--timeout`, else `timeout_s`, else 600 s; the gate also gets it as `PREGATE_TIMEOUT_S`). The stall timer still applies to the lanes runner and guards.
- **The remote gate's heartbeat names its last output line**, so a gate that prints the CI run it is waiting on shows it every 60 s.

### Tests
- `test/pregate-remote.test.ts`: a gate quiet past `--stall-timeout` but inside `--timeout` clears its obligation; a gate past `--timeout` stays uncleared with `PREGATE_INCOMPLETE`.
- `test/pregate-supervise.test.ts`: a heartbeat with `lastLine` names the command's last output line.
