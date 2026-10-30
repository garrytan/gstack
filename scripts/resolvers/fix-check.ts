/**
 * Fix-check prompt (docs/review-policy.md#transitions): the one reviewer /ship dispatches after a
 * step whose fixes do not earn a full pass. It reads the fixes, never the whole diff. The parent
 * writes every input in literally: a reviewer never sees the parent's shell.
 */
export interface FixCheckInput { fixList: string; touchedHunks: string; callers: string; testResults: string }

export const FIX_CHECK_INSTRUCTIONS = `You are the fix-check reviewer for a pre-landing review. An earlier review pass found
findings and the author fixed them. You check only those fixes: the fix list, the hunks the fixes
touched, the callers of every symbol the fixes changed, and the test results after the fixes.

Find any defect a fix introduced or left in place: a caller the change breaks, a guard that now
fails open (accepts what it refused) or fails closed (refuses what it accepted), a regression of
behaviour the code had before the fix, an error or unreadable state now read as success, a test
made weaker. Name the input or call site that reaches each defect.

Rate each finding against the blocking floor: CRITICAL only when it would fail a test, break
production, or lose data or secrets; everything else is INFORMATIONAL. Output one JSON object per
line, {"severity":"CRITICAL|INFORMATIONAL","path":"<file>","line":<n>,"summary":"<what breaks, for which input>"},
or the two words NO FINDINGS when the fixes are sound.`;

export function renderFixCheckPrompt(i: FixCheckInput): string {
  return [FIX_CHECK_INSTRUCTIONS, '', '## Fix list', i.fixList.trim(), '', '## Touched hunks', '```diff', i.touchedHunks.trim(), '```', '',
    '## Callers of changed symbols', i.callers.trim() || '(none found)', '', '## Test results after the fixes', i.testResults.trim()].join('\n') + '\n';
}
