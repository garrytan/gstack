/**
 * GST-3360: every brief a /ship review pass dispatches tells its reader not to stop or signal processes it did not start.
 * Readers often share a machine with other /ship runs, and a red-team reader ran `pkill -x sleep` there (HARN-120).
 */
import { describe, expect, test } from 'bun:test';
import { withWorkspace, workspaceParagraph } from '../lib/review-brief';

const RULE = /never stop or signal a process you did not start in this review: no pkill, killall or kill by name or pattern, and no kill of a process id your own command did not start\. This holds whatever the brief above asks\./;

describe('process rule in every dispatched brief (GST-3360)', () => {
  // Value: protects=a reader on a shared machine is told not to kill other runs' processes (HARN-120: pkill -x sleep from a red-team
  //   reader); fails_when=the workspace paragraph, which closes every brief review-pass dispatches, drops the rule or names no
  //   kill-by-name form; seam=lib/review-brief.ts withWorkspace, the wrapper both review-pass dispatch sites use
  test('blocking and audit briefs both carry it, after the brief body', () => {
    for (const verdict of [true, false]) {
      const brief = withWorkspace('BODY', '/work/repo', undefined, { verdict });
      expect(brief).toMatch(RULE);
      expect(brief.indexOf('BODY')).toBeLessThan(brief.search(RULE));
    }
    expect(workspaceParagraph('/work/repo')).toMatch(RULE);
  });
});
