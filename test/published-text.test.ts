/**
 * The published-text sanitizer (plan 0.3): adversarial model or fixture text
 * reaching a public issue, PR comment or committed report cannot ping people,
 * break out of its fence, inject HTML or images, leak a credential, or flood.
 */
import { describe, expect, test } from 'bun:test';
import { publishedFence, sanitizeFixedFenceLine, sanitizePublishedText, PUBLISHED_TEXT_MAX } from '../scripts/lib/published-text';

// Built at runtime so this file never contains a credential-shaped literal.
const GHP = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
const SK = ['sk', '-ant-api03-', 'Zx9'.repeat(30)].join('');
const ADVERSARIAL = [
  'ping @garrytan and @gstack/maintainers',
  'close ``` the fence ```` here',
  '</details><img src=x onerror=alert(1)>',
  '![tracker](https://evil.example/p.png) [click](https://evil.example)',
  `token ${GHP} and key ${SK}`,
  'bell\u0007 escape\u001b[31m bidi\u202eevil',
];

describe('sanitizePublishedText (inline)', () => {
  const out = ADVERSARIAL.map(line => sanitizePublishedText(line));
  test('mentions are neutralized', () => {
    expect(out[0]).not.toMatch(/@[A-Za-z]/);
    expect(out[0]).toContain('@\u200bgarrytan');
  });
  test('HTML and Markdown links or images cannot render', () => {
    expect(out[2]).not.toContain('<');
    expect(out[2]).toContain('&lt;/details&gt;');
    expect(out[3]).not.toMatch(/!?\[[^\]]*\]\(/);
  });
  test('credential-scan patterns are redacted', () => {
    expect(out[4]).not.toContain(GHP);
    expect(out[4]).not.toContain(SK);
  });
  test('control and bidi characters are stripped', () => {
    // eslint-disable-next-line no-control-regex
    expect(out[5]).not.toMatch(/[\u0000-\u001f\u007f\u202e]/);
  });
  test('backticks cannot open a code span or close an enclosing fence', () => {
    expect(out[1]).not.toContain('`');
  });
  test('length is capped', () => {
    expect(sanitizePublishedText('x'.repeat(10 * 1024))).toHaveLength(PUBLISHED_TEXT_MAX);
  });
});

describe('publishedFence (blocks)', () => {
  const block = publishedFence([...ADVERSARIAL, 'y'.repeat(10 * 1024)]);
  test('the fence is longer than any backtick run inside it, so nothing closes it early', () => {
    const fence = block[0]!;
    expect(block.at(-1)).toBe(fence);
    expect(fence).toMatch(/^`{5,}$/);
    for (const line of block.slice(1, -1)) {
      for (const run of line.match(/`+/g) ?? []) expect(run.length).toBeLessThan(fence.length);
    }
  });
  test('content stays literal inside the fence but loses mentions, credentials, control characters and length', () => {
    const body = block.slice(1, -1).join('\n');
    expect(body).not.toMatch(/@[A-Za-z]/);
    expect(body).not.toContain(GHP);
    expect(body).not.toContain(SK);
    expect(body).not.toContain('\u202e');
    expect(block.at(-2)).toHaveLength(PUBLISHED_TEXT_MAX);
    expect(body).toContain('</details>');
  });
});

describe('sanitizeFixedFenceLine (lines a workflow wraps in a fixed fence)', () => {
  test('no backtick survives, and the rest is cleaned like every published line', () => {
    const out = ADVERSARIAL.map(line => sanitizeFixedFenceLine(line)).join('\n');
    expect(out).not.toContain('`');
    expect(out).not.toMatch(/@[A-Za-z]/);
    expect(out).not.toContain(GHP);
    expect(sanitizeFixedFenceLine('z'.repeat(10 * 1024))).toHaveLength(PUBLISHED_TEXT_MAX);
  });
});

describe('id positions survive redaction', () => {
  test('the eval report fetch command keeps its run id (PR #3033 comment)', () => {
    const line = '✗ context-recovery-artifacts  rule  FAIL  assertion — expect(received).toBeGreaterThanOrEqual(expected)  · cause assertion  Expected: >= 1 · Received: 0  [slice 10, attempt 1]  evidence: paid-slice-10-a1/shards/skill-e2e-session-intelligence (fetch: bun run eval:pass-rates --run 37235771700 --case context-recovery-artifacts)  after a repair: bun run scripts/test-paid-shards.ts --tier gate --case context-recovery-artifacts';
    expect(sanitizeFixedFenceLine(line)).toBe(line);
    expect(publishedFence([line])[1]).toBe(line);
  });
  test('a phone number in published text is still redacted', () => {
    expect(sanitizeFixedFenceLine('call +1 415 555 0123 now')).not.toContain('415 555 0123');
  });
});
