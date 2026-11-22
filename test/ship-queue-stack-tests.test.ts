/**
 * train build --dry-run --stack-tests read a git failure listing a PR's added files as "no new test files" and passed the slot
 * (GST-3201; the round-1 /ship note on #4502, crew/lib/ship-queue-stack-tests.ts). An unread list is not an empty one.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { newTestFiles, stackTestLine, stackTests } from '../crew/lib/ship-queue-stack-tests';

const ROOT = path.resolve(import.meta.dir, '..');
const MISSING = '0000000000000000000000000000000000000001';

describe('stack tests fail closed when git cannot list the added files', () => {
  // Value: protects=a slot whose added test files cannot be listed is red, not "no new test files"; fails_when=a git failure reads
  //   as an empty list again; why_new=the fail-open had no test; seam=the real git diff on this checkout with a base that does not
  //   exist; no_claim=running the selected files on a prefix worktree
  test('a base git cannot resolve is an error, and the slot fails with it', () => {
    const listed = newTestFiles(ROOT, MISSING, 'HEAD');
    expect('error' in listed && listed.error).toBeTruthy();
    const [r] = stackTests(ROOT, MISSING, [{ pr: '1', head: 'HEAD', ready_at: '', screen: 'none' } as any], [{ index: 0, commit: 'HEAD', tree: '', pr: null }, { index: 1, commit: 'HEAD', tree: '', pr: '1' }]);
    expect(r!.ok).toBe(false);
    expect(stackTestLine(r!)).toStartWith('STACK_TESTS: #1 T1 FAIL: cannot list the test files it adds: ');
  });

  test('negative control: a readable empty list still passes as no new test files', () => {
    expect(newTestFiles(ROOT, 'HEAD', 'HEAD')).toEqual({ files: [] });
    const [r] = stackTests(ROOT, 'HEAD', [{ pr: '1', head: 'HEAD', ready_at: '', screen: 'none' } as any], [{ index: 0, commit: 'HEAD', tree: '', pr: null }, { index: 1, commit: 'HEAD', tree: '', pr: '1' }]);
    expect(stackTestLine(r!)).toBe('STACK_TESTS: #1 T1 no new test files');
  });
});
