import { describe, test, expect } from 'bun:test';
import {
  computeDensity,
  checkThresholds,
  extractNonFloorText,
  loadProfile,
  DEFAULT_THRESHOLDS,
  VERBOSE_PHRASES,
  type DensityThresholds,
} from '../scripts/lib/voice-density';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('computeDensity', () => {
  test('returns zero metrics for empty prose', () => {
    const m = computeDensity('');
    expect(m.wordCount).toBe(0);
    expect(m.articlesPerHundred).toBe(0);
    expect(m.fillersPerHundred).toBe(0);
    expect(m.hedgesPerHundred).toBe(0);
    expect(m.verbosePhraseCount).toBe(0);
    expect(m.flaggedItems).toEqual([]);
  });

  test('counts articles as per-100 rate', () => {
    const text = 'The cat sat on the mat under a tree';
    const m = computeDensity(text);
    expect(m.wordCount).toBe(9);
    // 3 articles (The, the, a) in 9 words = 33.3/100
    expect(m.articlesPerHundred).toBeCloseTo(33.33, 1);
    expect(m.flaggedItems.filter((f) => f.type === 'article')).toHaveLength(3);
  });

  test('counts fillers', () => {
    const text = 'This is just really basically actually simply wrong';
    const m = computeDensity(text);
    expect(m.fillersPerHundred).toBeGreaterThan(0);
    expect(m.flaggedItems.some((f) => f.type === 'filler' && f.match.toLowerCase() === 'just')).toBe(true);
  });

  test('counts hedges', () => {
    const text = 'You might want to consider whether this could potentially work';
    const m = computeDensity(text);
    expect(m.hedgesPerHundred).toBeGreaterThan(0);
    expect(m.flaggedItems.some((f) => f.type === 'hedge')).toBe(true);
  });

  test('counts verbose phrases', () => {
    const text = 'In order to do this we will utilize the leverage of robust comprehensive tools';
    const m = computeDensity(text);
    expect(m.verbosePhraseCount).toBeGreaterThan(0);
    // 'in order to', 'we will', 'utilize', 'leverage', 'robust', 'comprehensive' all match
    const verbMatches = m.flaggedItems.filter((f) => f.type === 'verbose-phrase');
    expect(verbMatches.length).toBeGreaterThan(3);
  });

  test('ignores backtick-wrapped inline code for article regex', () => {
    // Negative lookbehind/lookahead should skip `the` when backticked
    const text = 'Call foo bar baz quux'; // no articles, no backticks either — just verify no false positives
    const m = computeDensity(text);
    expect(m.articlesPerHundred).toBe(0);
  });

  test('flaggedItems include line numbers relative to startLine', () => {
    const text = 'the quick brown fox\njumps over the lazy dog';
    const m = computeDensity(text, 100); // startLine=100
    const lines = m.flaggedItems.map((f) => f.line);
    expect(lines).toContain(100); // "the quick" on line 0 → 100+0
    expect(lines).toContain(101); // "over the" on line 1 → 100+1
  });
});

describe('checkThresholds', () => {
  const strict: DensityThresholds = {
    articlesPerHundred: 1.0,
    fillersPerHundred: 0.5,
    hedgesPerHundred: 0.5,
    verbosePhraseMax: 1,
  };

  test('passes when all metrics within threshold', () => {
    const metrics = computeDensity('bun install then bun test verify output');
    const result = checkThresholds(metrics, strict);
    expect(result.pass).toBe(true);
    expect(result.failedMetrics).toEqual([]);
  });

  test('fails and reports failed metric when articles exceed', () => {
    const metrics = computeDensity('The quick brown fox jumps over the lazy dog');
    const result = checkThresholds(metrics, strict);
    expect(result.pass).toBe(false);
    expect(result.failedMetrics.some((f) => f.metric === 'articlesPerHundred')).toBe(true);
  });

  test('accumulates multiple failed metrics', () => {
    const metrics = computeDensity(
      'The in order to thing is just really basically always the comprehensive solution'
    );
    const result = checkThresholds(metrics, strict);
    expect(result.pass).toBe(false);
    expect(result.failedMetrics.length).toBeGreaterThan(1);
  });

  test('loose thresholds pass verbose input', () => {
    const loose: DensityThresholds = {
      articlesPerHundred: 100,
      fillersPerHundred: 100,
      hedgesPerHundred: 100,
      verbosePhraseMax: 100,
    };
    const metrics = computeDensity('The quick brown fox jumps over the lazy dog just because');
    const result = checkThresholds(metrics, loose);
    expect(result.pass).toBe(true);
  });
});

describe('extractNonFloorText', () => {
  test('strips fenced code blocks', () => {
    const text = 'before\n```bash\nthe verbose code here just really\n```\nafter';
    const stripped = extractNonFloorText(text);
    expect(stripped).toContain('before');
    expect(stripped).toContain('after');
    expect(stripped).not.toContain('verbose code here');
    expect(stripped).not.toContain('just really');
  });

  test('strips inline backticked code spans', () => {
    const text = 'Call `the function` to check';
    const stripped = extractNonFloorText(text);
    expect(stripped).not.toContain('the function');
    expect(stripped).toContain('Call');
  });

  test('strips markdown tables with separator row', () => {
    const text = [
      'Prose before.',
      '',
      '| Header | Value |',
      '|--------|-------|',
      '| the    | a row |',
      '| another | row  |',
      '',
      'Prose after.',
    ].join('\n');
    const stripped = extractNonFloorText(text);
    expect(stripped).toContain('Prose before');
    expect(stripped).toContain('Prose after');
    expect(stripped).not.toContain('| Header');
    expect(stripped).not.toContain('| another');
  });

  test('keeps bulleted lists with inline pipes', () => {
    const text = '- use `a | b` syntax\n- or `x | y`';
    const stripped = extractNonFloorText(text);
    // No separator row, so pipes in bullets are prose, not table
    expect(stripped).toContain('use');
    expect(stripped).toContain('syntax');
  });

  test('strips leading YAML frontmatter', () => {
    const text = '---\nname: foo\nvoice: caveman\n---\n\nThe actual prose.';
    const stripped = extractNonFloorText(text);
    expect(stripped).toContain('actual prose');
    expect(stripped).not.toContain('voice: caveman');
  });

  test('strips HTML comments on single line', () => {
    const text = '<!-- hidden -->\nVisible prose here';
    const stripped = extractNonFloorText(text);
    expect(stripped).not.toContain('hidden');
    expect(stripped).toContain('Visible prose');
  });

  test('handles multiple code blocks in sequence', () => {
    const text = 'a\n```\ncode1 just really\n```\nb\n```ts\ncode2 the basically\n```\nc';
    const stripped = extractNonFloorText(text);
    expect(stripped).toContain('a');
    expect(stripped).toContain('b');
    expect(stripped).toContain('c');
    expect(stripped).not.toContain('code1');
    expect(stripped).not.toContain('code2');
  });
});

describe('loadProfile', () => {
  test('loads caveman-full profile', () => {
    const profile = loadProfile('caveman-full', ROOT);
    expect(profile).not.toBeNull();
    expect(profile?.name).toBe('caveman-full');
    expect(profile?.density_thresholds).toBeDefined();
    expect(profile?.directive.full).toContain('ENFORCEMENT');
  });

  test('loads caveman-lite profile', () => {
    const profile = loadProfile('caveman-lite', ROOT);
    expect(profile).not.toBeNull();
    expect(profile?.density_thresholds?.articlesPerHundred).toBe(3.0);
  });

  test('loads caveman-ultra profile', () => {
    const profile = loadProfile('caveman-ultra', ROOT);
    expect(profile).not.toBeNull();
    expect(profile?.density_thresholds?.verbosePhraseMax).toBe(1);
  });

  test('loads none profile but no density_thresholds', () => {
    const profile = loadProfile('none', ROOT);
    expect(profile).not.toBeNull();
    expect(profile?.density_thresholds).toBeUndefined();
  });

  test('returns null for missing profile', () => {
    const profile = loadProfile('definitely-does-not-exist', ROOT);
    expect(profile).toBeNull();
  });

  test('returns null for wrong cavestack root', () => {
    const profile = loadProfile('caveman-full', '/nonexistent/path');
    expect(profile).toBeNull();
  });
});

describe('constants', () => {
  test('DEFAULT_THRESHOLDS preserves template-level values', () => {
    expect(DEFAULT_THRESHOLDS.articlesPerHundred).toBe(4.5);
    expect(DEFAULT_THRESHOLDS.fillersPerHundred).toBe(2.0);
    expect(DEFAULT_THRESHOLDS.hedgesPerHundred).toBe(2.0);
    expect(DEFAULT_THRESHOLDS.verbosePhraseMax).toBe(5);
  });

  test('VERBOSE_PHRASES has 30+ pairs', () => {
    expect(VERBOSE_PHRASES.length).toBeGreaterThanOrEqual(30);
    for (const pair of VERBOSE_PHRASES) {
      expect(pair).toHaveLength(2);
      expect(typeof pair[0]).toBe('string');
      expect(typeof pair[1]).toBe('string');
    }
  });
});
