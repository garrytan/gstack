/**
 * PR 2 of the /ship + /review convergence lane: the review-scope follow-ups
 * from PR 1's review notes. A Step 11 late defer is a review-log row that
 * counts under deferred and is not a pass.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LATE_DEFER_SKILL, reviewLoopLine, summarizeReviewLoop } from '../lib/review-scope';
import { reviewFreshness } from '../lib/review-evidence';

describe('late defers from Step 11', () => {
  test('a review-late-defer row adds its deferred findings, is not counted as a pass, and is invisible to review freshness', () => {
    const late = { skill: LATE_DEFER_SKILL, via: 'ship', timestamp: '2026-10-26T10:30:00Z', pass: 2, review_scope: 'frozen', findings: [
      { fingerprint: 'c:9:z', blocking: true, action: 'deferred', issue: null }, { fingerprint: 'b:1:y', blocking: true, action: 'deferred', issue: 5 }] };
    const rows = [
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:00:00Z', pass: 1, review_scope: 'frozen', findings: [
        { fingerprint: 'a:1:x', blocking: true, action: 'auto-fixed' }, { fingerprint: 'b:1:y', blocking: true, action: 'deferred', issue: 5 }] },
      { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:20:00Z', pass: 2, review_scope: 'frozen', findings: [] },
      late,
      { skill: 'adversarial-review', via: 'ship', timestamp: '2026-10-26T10:25:00Z', findings: [{ fingerprint: 'd:1:w', blocking: true, action: 'deferred' }] },
    ];
    const s = summarizeReviewLoop(rows, '2026-10-26T09:30:00Z');
    expect(s).toEqual({ passes: 2, blocking_found: 3, deferred: 2, noted: 0, fixed: 1, scope: 'frozen', rounds: 2 });
    expect(reviewLoopLine(s)).toBe('REVIEW_LOOP: passes=2 blocking_found=3 deferred=2 noted=0 fixed=1 scope=frozen');
    expect(LATE_DEFER_SKILL).toBe('review-late-defer');
    // A `review` row logged without a start token would be the newest review row and read UNVERIFIED; the late-defer row is not a diff review at all.
    expect(reviewFreshness(late, 'abc')).toBeUndefined();
    expect(reviewFreshness({ ...late, skill: 'review' }, 'abc')?.status).toBe('UNVERIFIED');
  });
});

describe('checklist rules with ids (docs/review-policy.md)', () => {
  const checklist = fs.readFileSync(path.resolve(import.meta.dir, '../review/checklist.md'), 'utf8');
  const policy = fs.readFileSync(path.resolve(import.meta.dir, '../docs/review-policy.md'), 'utf8');
  const section = (first: string, last: string) => checklist.slice(checklist.indexOf(first), checklist.indexOf(last));

  test('prereg-with-results is a Pass 1 gate-integrity ASK finding about the pairing, repaired by a split', () => {
    const gate = section('#### Gate Integrity', '#### Approval Classes and Data Repairs');
    expect(gate).toContain('`prereg-with-results`, ASK');
    expect(gate).toMatch(/preregistration .*results, scores or verdict/);
    expect(gate).toContain('the finding is the pairing, not either half');
    expect(gate).toMatch(/split them \(the preregistration lands first/);
    expect(policy).toContain('`prereg-with-results` (Pass 1, Gate Integrity, ASK)');
  });

  test('test-keyboard-count-loop is a Pass 2 informational rule that keeps a counted loop only when the count is the behavior', () => {
    const pass2 = section('### Pass 2 — INFORMATIONAL', '## Sideways sweep');
    expect(pass2).toContain('#### Keyboard-Count Test Loops');
    expect(pass2).toContain('(`test-keyboard-count-loop`)');
    expect(pass2).toContain('Locate the target by role, label or test id');
    expect(pass2).toContain('a counted loop stays only when the count itself is the behavior under test');
    expect(policy).toContain('`test-keyboard-count-loop` (Pass 2, informational)');
    expect(policy).toContain('gstack-coauthor-trailers');
  });
});
