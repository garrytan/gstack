/**
 * GST-436: an unclosed code fence must not hide the severity lines and verdict after it.
 * withoutCode() blanks fenced text so a quoted severity is not read as a label; a fence that
 * never closes used to blank the rest of the reply, so a no-findings line before it read as clean.
 */
import { describe, expect, test } from 'bun:test';
import { classifyOutsideReview } from '../lib/outside-review-result';

const NO_ISSUES = 'No issues found in changed.ts.';
const RECOMMEND = 'Recommendation: approve because changed.ts keeps its data.';

describe('an unclosed fence does not hide what follows it (GST-436)', () => {
  // Value: protects=the outside-voice verdict on review gates; fails_when=a reply with NO_FINDINGS, an unclosed
  //   fence and then a [P1] or a not-ready verdict classifies clean; seam=classifyOutsideReview
  test('NO_FINDINGS, an unclosed fence, then [P1] is not clean', () => {
    const text = [NO_ISSUES, '```ts', 'const x = 1;', '[P1] changed.ts drops the last row', RECOMMEND].join('\n');
    const r = classifyOutsideReview({ text, gate: 'review' });
    expect(r.verdict).not.toBe('clean');
    expect(r.verdict).toBe('findings');
    expect(r.findings.highest).toBe('P1');
  });

  test('NO_FINDINGS, an unclosed fence, then Verdict: not ready is not clean', () => {
    const text = [NO_ISSUES, '~~~', 'quoted', RECOMMEND, 'Verdict: not ready'].join('\n');
    expect(classifyOutsideReview({ text, gate: 'review' }).verdict).toBe('findings');
  });

  test('a closed fence still hides a quoted severity', () => {
    const text = [NO_ISSUES, '```', '[P1] quoted from the diff', '```', RECOMMEND].join('\n');
    const r = classifyOutsideReview({ text, gate: 'review' });
    expect(r.verdict).toBe('clean');
    expect(r.findings.highest).toBeNull();
  });
});

describe('an unclosed fence never makes a reply clean (GST-436 review)', () => {
  // Value: protects=the outside-voice verdict on review gates; fails_when=text quoted inside an unclosed fence turns a
  //   not-ready or unverified reply clean; seam=classifyOutsideReview
  test('a quoted Verdict: ready in an unclosed fence does not override a real not-ready', () => {
    const text = ['[P2] parser.ts drops the trailing row.', 'Verdict: not ready', 'Recommendation: fix because parser.ts loses data.', '```md', 'Verdict: ready'].join('\n');
    expect(classifyOutsideReview({ text, gate: 'review' }).verdict).toBe('findings');
  });

  test('a quoted advisory severity in an unclosed fence does not stand in for a tagged review', () => {
    const text = ['Recommendation: hold because I ran out of time.', 'Looking at the fixture:', '```', '[P3] example finding text'].join('\n');
    expect(classifyOutsideReview({ text, gate: 'review' }).verdict).toBe('unverified');
    expect(classifyOutsideReview({ text, gate: 'structured' }).verdict).toBe('unverified');
  });

  test('a quoted no-findings line in an unclosed fence does not conclude the review', () => {
    const text = ['The retry loop in fetch.ts has no cap.', 'Recommendation: fix before merge because the retry loop has no cap.', 'Output of the lint run:', '```text', '$ bun run lint', 'No issues found.'].join('\n');
    expect(classifyOutsideReview({ text, gate: 'review' }).verdict).toBe('unverified');
    expect(classifyOutsideReview({ text, gate: 'structured' }).verdict).toBe('unverified');
  });

  test('many unmatched fences classify in one linear pass', () => {
    const lines: string[] = [];
    for (let n = 3002; n >= 3; n--) lines.push((n % 2 ? '`' : '~').repeat(n));
    const text = [NO_ISSUES, ...lines, '[P1] changed.ts drops the last row', RECOMMEND].join('\n');
    const started = performance.now();
    const r = classifyOutsideReview({ text, gate: 'review' });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(r.verdict).toBe('findings');
  });
});
