**The timeline Stop hook returns within its 2-second budget even when the host keeps stdin open.** The hook read its payload with a blocking read that waits for end of input, so a host that writes the Stop payload and leaves the pipe open held the hook for as long as the pipe stayed open. A local run with the pipe held for 8 seconds took 8 seconds, past the hook's 2-second budget and on the way to Claude Code's 15-second hook window (#3628, reported on Windows). Rewritten from PR #3628 by shahab (mashtii85).

### Fixed
- **`hosts/claude/hooks/timeline-stop-hook.ts`** reads stdin for at most 500 ms and stops at the first complete JSON payload, then repairs the timeline as before. The hook still exits 0 on every path.

### Tests
- `test/timeline-stop-hook-stdin.test.ts` (runs on windows-latest): a complete payload on a pipe that never closes returns within budget and still writes the repair; an open pipe with no data returns within budget. Both failed before the fix (10 s, killed).
