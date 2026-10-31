**`test/cso-snapshot-state.test.ts` no longer hangs when a paused contender is resumed too early.**

### Fixed
- The five paused-contender tests resume a child only once `ps` shows it stopped. Each child marks its pause and then stops itself in two steps, and a SIGCONT that arrived between the two did nothing, so the child stayed stopped and the test timed out (Free Tests 41117003351). With a 200 ms delay injected between the two steps, main failed 3 and then 5 of the 5 tests across two runs, and this change passed 5 of 5 both times. A child that exits, or never stops within 2 s, now fails with a named error instead of hanging. Timing bounds are unchanged.
