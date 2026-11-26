/**
 * GST-4003: review_exclude_paths takes up to 256 patterns (harness-evals#619 hit the old 64), as long as their exclude
 * pathspecs fit one reader command; and a REVIEW_DIFF_TOO_LARGE fix never suggests hiding docs/ or prints a policy gstack
 * itself would refuse.
 */
import { describe, expect, test } from 'bun:test';
import { tooLargeLine } from '../lib/review-exclude';
import { EXCLUDE_SPEC_MAX_BYTES, MAX_EXCLUDE_PATTERNS, REVIEW_EXCLUDE_KEY_VERSION, excludeSpecBytes, validatePolicy } from '../lib/ship-policy';

const codes = (p: unknown) => validatePolicy(p).map(e => `${e.code}:${e.path}:${e.message}`);
const list = (n: number, width = 0) => Array.from({ length: n }, (_, i) => `results/run-${i}/${'r'.repeat(width)}/**`);
const policy = (patterns: string[]) => ({ review_exclude_paths: patterns, min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION });
const landed = (line: string) => { const m = line.match(/land (\{.*?\}) in /); return m ? JSON.parse(m[1]!) : null; };

describe('the review_exclude_paths cap', () => {
  test('256 patterns validate, 257 do not, and review_content_patterns keeps its 64', () => {
    expect(MAX_EXCLUDE_PATTERNS).toBe(256);
    expect(codes(policy(list(256)))).toEqual([]);
    expect(codes(policy(list(257)))).toEqual(['POLICY_INVALID:review_exclude_paths:more than 256 patterns']);
    expect(codes({ ...policy(list(1)), review_content_patterns: list(65) }).some(c => c.startsWith('POLICY_INVALID:review_content_patterns:more than 64'))).toBe(true);
  });

  test('patterns too long together for one reader command are refused, and no list the old 64 cap admitted is', () => {
    const long = list(120, 200);
    expect(excludeSpecBytes(long)).toBeGreaterThan(EXCLUDE_SPEC_MAX_BYTES);
    expect(codes(policy(long))).toEqual([`POLICY_INVALID:review_exclude_paths:its patterns take ${excludeSpecBytes(long)} argument bytes as exclude pathspecs, more than ${EXCLUDE_SPEC_MAX_BYTES}; merge patterns under a shared folder glob`]);
    const widest = Array.from({ length: 64 }, (_, i) => `d${String(i).padStart(2, '0')}/${'x'.repeat(251)}`);
    expect(widest.every(p => p.length === 255)).toBe(true);
    expect(codes(policy(widest))).toEqual([]);
    const wide = Array.from({ length: 64 }, (_, i) => `d${String(i).padStart(2, '0')}/${'é'.repeat(230)}/**`);
    expect(excludeSpecBytes(wide)).toBeGreaterThan(EXCLUDE_SPEC_MAX_BYTES);
    expect(codes(policy(wide))).toEqual([]);
    expect(codes(policy([...wide, 'x/**']))[0]).toContain('argument bytes as exclude pathspecs');
  });
});

describe('the REVIEW_DIFF_TOO_LARGE fix', () => {
  const none = { state: 'none' as const, base: 'main', source: 'origin/main@abc' };
  test('docs/ is never suggested, whatever its bytes; data folders still are', () => {
    const d = { bytes: 6_000_000, byDir: [['docs', 4_000_000], ['results', 1_500_000], ['src', 500_000]] as Array<[string, number]>,
      byFile: [['docs/report.md', 2_000_000], ['docs/benchmarks/run/results/a.json', 2_000_000], ['results/a.jsonl', 1_500_000], ['src/a.ts', 500_000]] as Array<[string, number]> };
    const line = tooLargeLine('ctx', 'batched', d, none).line;
    expect(line).not.toContain('docs/**');
    expect(landed(line)).toBeNull();
    expect(line).toContain('split the PR');
    const dataHeavy = { ...d, byDir: [['results', 4_500_000], ['docs', 1_000_000], ['src', 500_000]] as Array<[string, number]>,
      byFile: [['results/a.jsonl', 4_500_000], ['docs/report.md', 1_000_000], ['src/a.ts', 500_000]] as Array<[string, number]> };
    expect(landed(tooLargeLine('ctx', 'batched', dataHeavy, none).line).review_exclude_paths).toEqual(['results/**']);
    const byDirOnly = { bytes: 6_000_000, byDir: [['docs', 4_500_000], ['results', 1_400_000]] as Array<[string, number]> };
    expect(tooLargeLine('ctx', 'batched', byDirOnly, none).line).not.toContain('docs/**');
  });

  test('a suggestion that would pass the pattern cap prints no policy JSON and says to merge patterns instead', () => {
    const d = { bytes: 3_000_000, byDir: [['logs', 1_500_000], ['src', 1_500_000]] as Array<[string, number]>, byFile: [['logs/run.log', 1_500_000], ['src/a.ts', 1_500_000]] as Array<[string, number]> };
    const at = (n: number) => tooLargeLine('ctx', 'batched', d, { ...none, state: 'active', record: { patterns: list(n), excluded: 9 } }).line;
    const fits = landed(at(255));
    expect(fits.review_exclude_paths).toHaveLength(256);
    expect(codes(fits)).toEqual([]);
    const full = at(256);
    expect(landed(full)).toBeNull();
    expect(full).toContain('fails validation (more than 256 patterns)');
    expect(full).toContain('merge its patterns under fewer shared folder globs on main');
    expect(full).toEndWith('nothing was written (REVIEW_DIFF_TOO_LARGE)');
  });
});
