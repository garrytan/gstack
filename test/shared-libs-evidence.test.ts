import { describe, expect, test } from 'bun:test';
import { canReuseSharedLibsAdvisory, sharedLibsFingerprint } from '../lib/review-evidence';

const source = {
  evidence_paths: ['src/z.ts', 'src/a.ts'],
  helper_target: { path: 'lib/shared.ts', symbol: 'parseResult' },
};
// Fixed independently from the specified UTF-8 JSON tuple, not another call to the helper.
const fingerprint = 'shared-libs:bb1ca4abd2783be0a39a15e40c38e670930fad23812c33df6b979047b92522da';
const branchId = '0d6e4079e36703ebd37c00722f5891d28b0e2811dc114b129215123adcce3605';
const wtree = 'a'.repeat(40);

describe('shared-library structural identity', () => {
  test('matches the versioned fixed digest and ignores caller ordering, duplicate paths and report details', () => {
    expect(sharedLibsFingerprint(source)).toBe(fingerprint);
    expect(sharedLibsFingerprint({
      ...source, evidence_paths: ['src/a.ts', 'src/z.ts', 'src/a.ts'],
      line: 999, summary: 'a different rendering', fingerprint: 'untrusted model text',
    })).toBe(fingerprint);
    expect(source.evidence_paths).toEqual(['src/z.ts', 'src/a.ts']);
  });

  test('each source path, target path and target symbol changes the identity', () => {
    for (const changed of [
      { ...source, evidence_paths: ['src/z.ts', 'src/b.ts'] },
      { ...source, evidence_paths: ['src/z.ts', 'src/A.ts'] },
      { ...source, evidence_paths: [...source.evidence_paths, 'src/third.ts'] },
      { ...source, helper_target: { ...source.helper_target, path: 'lib/Shared.ts' } },
      { ...source, helper_target: { ...source.helper_target, symbol: 'ParseResult' } },
    ]) expect(sharedLibsFingerprint(changed)).not.toBe(fingerprint);
  });

  test('preserves Unicode and spaces without path normalization or locale-dependent sorting', () => {
    const unicode = { ...source, evidence_paths: ['src/é.ts', 'src/Z file.ts', 'src/a.ts'] };
    expect(sharedLibsFingerprint(unicode)).toBe(sharedLibsFingerprint({
      ...unicode, evidence_paths: ['src/a.ts', 'src/é.ts', 'src/Z file.ts'],
    }));
    expect(sharedLibsFingerprint(unicode)).not.toBe(sharedLibsFingerprint({
      ...unicode, evidence_paths: ['src/é.ts', 'src/Z file.ts', 'src/a.ts'],
    }));
    expect(sharedLibsFingerprint({ ...source, evidence_paths: ['src/ leading.ts'] })).toBeDefined();
    // Emoji's UTF-16 leading surrogate sorts before U+E000, unlike code-point sorting.
    expect(sharedLibsFingerprint({
      ...source, evidence_paths: ['src/\ue000.ts', 'src/é.ts', 'src/😀.ts', 'src/a.ts', 'src/Z file.ts'],
    })).toBe('shared-libs:e48c488d014da5440e9922a6500f91b33605650b93222247d1c29b89d6638255');
  });

  test('rejects missing and malformed structures, including sparse path arrays', () => {
    const malformed: unknown[] = [
      undefined, null, false, 1, '', [], {}, { evidence_paths: source.evidence_paths },
      { ...source, evidence_paths: [] }, { ...source, evidence_paths: 'src/a.ts' },
      { ...source, evidence_paths: [null] }, { ...source, evidence_paths: [1] },
      { ...source, evidence_paths: Array(1) },
      { ...source, helper_target: null }, { ...source, helper_target: [] },
      { ...source, helper_target: { path: 'lib/shared.ts' } },
      { ...source, helper_target: { path: 'lib/shared.ts', symbol: '' } },
      { ...source, helper_target: { path: 'lib/shared.ts', symbol: '  ' } },
      { ...source, helper_target: { path: 'lib/shared.ts', symbol: 42 } },
      { ...source, helper_target: { path: 'lib/shared.ts', symbol: 'parse\nResult' } },
    ];
    for (const value of malformed) expect(sharedLibsFingerprint(value)).toBeUndefined();
  });

  test('rejects paths that cannot be reused as unambiguous Git-relative source locations', () => {
    for (const path of [
      '', ' ', '/src/a.ts', 'C:/src/a.ts', 'C:src/a.ts', '\\src\\a.ts', 'src\\a.ts',
      './src/a.ts', '../src/a.ts', 'src/../a.ts', 'src/./a.ts', 'src//a.ts', 'src/',
      '.git/config', 'nested/.git/config', 'src/a\0.ts', 'src/a\n.ts', 'src/a\t.ts',
    ]) {
      expect(sharedLibsFingerprint({ ...source, evidence_paths: [path] })).toBeUndefined();
      expect(sharedLibsFingerprint({ ...source, helper_target: { path, symbol: 'parseResult' } })).toBeUndefined();
    }
  });
});

function evidence() {
  return {
    prior: {
      ...source, fingerprint, advisory: true, severity: 'INFORMATIONAL', action: 'skipped',
      snapshot_covered_paths: [...source.evidence_paths],
    },
    current: { ...source, advisory: true, severity: 'INFORMATIONAL' },
    review: {
      skill: 'review', completed: true, converged: true, status: 'clean', wtree,
      review_binding: { state: 'verified', start_wtree: wtree, end_wtree: wtree, branch_id: branchId },
    },
    snapshot: { wtree, branch_id: branchId, covered_paths: [...source.evidence_paths] },
  };
}

describe('shared-library advisory skip reuse', () => {
  test('requires identity, trusted unchanged binding and coverage, independently of unrelated defects', () => {
    const { prior, current, review, snapshot } = evidence();
    expect(canReuseSharedLibsAdvisory(prior, current, review, snapshot)).toBe(true);
    expect(canReuseSharedLibsAdvisory(prior, current, {
      ...review, status: 'issues_found', issues_found: 1, critical: 1,
    }, snapshot)).toBe(true);
  });

  test('advisories cannot suppress defects, fixed findings, malformed identities or forged saved hashes', () => {
    const { prior, current, review, snapshot } = evidence();
    for (const changed of [
      { ...prior, advisory: false }, { ...prior, advisory: undefined },
      { ...prior, severity: 'CRITICAL' }, { ...prior, severity: undefined },
      { ...prior, action: 'fixed' }, { ...prior, action: 'auto-fixed' }, { ...prior, action: undefined },
      { ...prior, fingerprint: 'shared-libs:invented' }, { ...prior, fingerprint: undefined },
      { ...prior, evidence_paths: undefined }, { ...prior, helper_target: undefined },
      { ...prior, helper_target: { ...source.helper_target, symbol: 'otherHelper' } },
    ]) expect(canReuseSharedLibsAdvisory(changed, current, review, snapshot)).toBe(false);
    for (const changed of [
      { ...current, advisory: false }, { ...current, advisory: undefined },
      { ...current, severity: 'CRITICAL' }, { ...current, fingerprint: 'shared-libs:invented' },
    ]) expect(canReuseSharedLibsAdvisory(prior, changed, review, snapshot)).toBe(false);
  });

  test('rejects legacy, mismatched, incomplete and non-review binding evidence', () => {
    const { prior, current, review, snapshot } = evidence();
    for (const changed of [
      {}, { ...review, skill: 'ship' }, { ...review, skill: 'plan-eng-review' },
      { ...review, completed: false }, { ...review, completed: undefined },
      { ...review, converged: false }, { ...review, converged: undefined },
      { ...review, wtree: undefined }, { ...review, review_binding: undefined },
      ...['uncaptured', 'changed', 'incomplete'].map(state => ({
        ...review, review_binding: { ...review.review_binding, state },
      })),
      { ...review, review_binding: { ...review.review_binding, start_wtree: 'b'.repeat(40) } },
      { ...review, review_binding: { ...review.review_binding, end_wtree: 'b'.repeat(40) } },
      { ...review, review_binding: { ...review.review_binding, branch_id: undefined } },
    ]) expect(canReuseSharedLibsAdvisory(prior, current, changed, snapshot)).toBe(false);
    for (const changed of [
      {}, { ...snapshot, wtree: 'unknown' }, { ...snapshot, wtree: 'b'.repeat(40) },
      { ...snapshot, branch_id: 'b'.repeat(64) }, { ...snapshot, branch_id: 'unknown' },
    ]) expect(canReuseSharedLibsAdvisory(prior, current, review, changed)).toBe(false);
  });

  test('every secondary caller must be positively covered, even when the Git tree is unchanged', () => {
    const { prior, current, review, snapshot } = evidence();
    // Callers exclude symlinks, dirty submodules, transformed files, assume-unchanged
    // and skip-worktree index entries from covered_paths.
    // The canonical Git tree can remain unchanged while that raw source changes.
    for (const covered_paths of [undefined, [], ['src/a.ts'], ['src/z.ts'], Array(2), ['../outside.ts']]) {
      expect(canReuseSharedLibsAdvisory(prior, current, review, { ...snapshot, covered_paths })).toBe(false);
    }
    expect(canReuseSharedLibsAdvisory(null, current, review, snapshot)).toBe(false);
    expect(canReuseSharedLibsAdvisory(prior, null, review, snapshot)).toBe(false);
    expect(canReuseSharedLibsAdvisory(prior, current, null, snapshot)).toBe(false);
    expect(canReuseSharedLibsAdvisory(prior, current, review, null)).toBe(false);
  });

  test('prior coverage must be complete and valid; legacy records require revalidation', () => {
    const { prior, current, review, snapshot } = evidence();
    for (const snapshot_covered_paths of [
      undefined, null, 'src/a.ts', [], ['src/a.ts'], ['src/z.ts'],
      Array(2), ['../outside.ts'], ['src/a.ts', 1],
    ]) {
      expect(canReuseSharedLibsAdvisory({ ...prior, snapshot_covered_paths }, current, review, snapshot)).toBe(false);
    }
  });

  test('removing a prior transformation cannot reuse different raw source under the same tree hash', () => {
    const { prior, current, review, snapshot } = evidence();
    // A prior clean filter normalized different raw caller bytes to this same tree.
    // It is now removed and current raw bytes match the tree, so current coverage
    // is complete. The original decision still lacks prior raw-to-blob coverage.
    expect(canReuseSharedLibsAdvisory({ ...prior, snapshot_covered_paths: [] }, current, review, snapshot)).toBe(false);
    expect(canReuseSharedLibsAdvisory(prior, current, review, snapshot)).toBe(true);
  });
});
