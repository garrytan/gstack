import { describe, expect, test } from 'bun:test';
import { parseFindings, rank, statesNoBlocks } from '../lib/review-ledger';

const F = '```';
const blocking = (reader: string, lines: string[], raises: boolean) =>
  parseFindings(reader, lines.join('\n'), raises).filter(f => (rank(f.label) ?? 0) >= 4 && !statesNoBlocks(f.raw)).map(f => f.raw.split(' | ')[0]);
const READERS = ['red-team', 'adversarial-native', 'outside-voice', 'fix-check'];
const LEAK = '**2. Token leak in log.ts:3 (CRITICAL).** Blocks: yes';

describe('a code fence never hides a blocker (GST-1409, fail closed)', () => {
  // Value: protects=a fence counts only when it opens and closes inside one finding without crossing a heading or finding marker, so
  //   an unclosed or boundary-crossing fence parses as prose and its finding still blocks; fails_when=the GSTA-275 round-2 shapes
  //   collect without the CRITICAL (the parked daf4fc2 pre-scan lost all five); why_new=GSTA-275 r2 red team; seam=parseFindings;
  //   no_claim=that a fenced quote is never a phantom (a quoted heading still collects, by design)
  test.each([
    ['an unclosed fence pairs with a later finding\'s closer', ['**1. Minor naming (INFORMATIONAL).** in a.ts:1', F + 'ts', 'const x = 1;', '', LEAK, F + 'bash', 'curl x', F]],
    ['a bare fence after a blank line under a complete finding', ['- INFORMATIONAL: naming nit in a.ts:1', '', F, LEAK, F]],
    ['a bare fence under a finding with no heading', ['The naming in a.ts:1 is INFORMATIONAL.', '', F, LEAK, F]],
    ['a fence right after a heading whose fields came first', ['**1. Minor naming (INFORMATIONAL).** in a.ts:1. Severity: Low. Blocks: no.', F, LEAK, F]],
    ['the same after a blank line', ['**1. Minor naming (INFORMATIONAL).** in a.ts:1. Severity: Low. Blocks: no.', '', F, LEAK, F]],
  ])('%s: the fenced finding still blocks', (_shape, lines) => {
    for (const reader of READERS) for (const raises of [true, false]) expect(blocking(reader, lines, raises)).toContain(LEAK);
  });
  test('under a fieldless heading a fenced Blocks: yes takes no field, and the heading stays a blocker for lead judgment', () => {
    const lines = ['**1. Webhook auth bypass in lib/auth.ts:42 (FIXABLE).**', 'Any caller can post.', '', 'I probed it with:', F, 'Blocks: yes', F, '', 'Severity: Medium', 'Blocks: no'];
    for (const reader of READERS) for (const raises of [true, false]) expect(blocking(reader, lines, raises)).toEqual([lines[0]]);
  });
});

describe('a closed fence inside a finding that already states its fields is its body (GST-1409)', () => {
  // Value: protects=a probe input quoted in a fence right after a finding's own Severity and Blocks fields collects nothing, so the
  //   finding keeps its stated severity; fails_when=a quoted Blocks: yes or Severity: Critical inside that fence raises a phantom
  //   CRITICAL; why_new=GSTA-275 GST-1406 p2 phantoms; seam=parseFindings; no_claim=fences under a fieldless heading (fail closed above)
  test.each([
    ['inline fields', ['**1. Retry cap off by one in q.ts:7 (Medium).** The loop runs once more. Severity: Low. Blocks: no.', F, 'Blocks: yes', 'the probe said FIXABLE here', 'Severity: Critical', F]],
    ['field lines', ['**1. Retry cap off by one in q.ts:7.** The loop runs once more.', 'Severity: Low', 'Blocks: no', F, 'Blocks: yes', 'Severity: Critical', F]],
  ])('%s: one record at its stated Severity, noting the code block', (_shape, lines) => {
    for (const reader of ['red-team', 'adversarial-native']) for (const raises of [true, false]) {
      const found = parseFindings(reader, lines.join('\n'), raises);
      expect(found.map(f => f.label)).toEqual(['Low']);
      expect(found[0]!.raw).toMatch(/\(code block: \d lines\)$/);
    }
  });
  test('controls: a fenced JSON finding, a labelled list item and a clean marker inside the fence keep it prose', () => {
    const head = '**1. Minor naming in a.ts:1 (INFORMATIONAL).** Rename it. Severity: Low. Blocks: no.';
    expect(parseFindings('fix-check', [head, F, '{"severity":"CRITICAL","path":"log.ts","line":3,"summary":"token leak"}', F].join('\n'), true).map(f => f.label)).toContain('CRITICAL');
    expect(parseFindings('red-team', [head, F, '- CRITICAL: token leak in log.ts:3', F].join('\n'), true).map(f => f.label)).toContain('CRITICAL');
  });
});
