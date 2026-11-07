/**
 * base_merge (GST-1772): the policy key's values and floor, and the receipt's record of a head that
 * leaves origin/<base> unmerged. Step 3's and finish's behavior is in ship-preflight.test.ts and
 * ship-release.test.ts.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { BASE_MERGE_KEY_VERSION, minimumReader, validatePolicy } from '../lib/ship-policy';
import { receiptBaseMerge } from '../lib/ship-receipt';
import { shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(60_000);
const fixtures: ShipFx[] = [];
const fx = (...a: Parameters<typeof shipFixture>) => { const f = shipFixture(...a); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

describe('base_merge', () => {
  // Value: protects=base_merge takes only auto | on-conflict | always, and a non-default value needs min_gstack_version at its introducing release;
  //   fails_when=a misspelled mode is accepted or an older gstack reads on-conflict as an unknown key; why_new=GST-1772 adds the key; seam=validatePolicy; no_claim=Step 3 behavior
  test('policy: three values, and a non-default value needs the floor', () => {
    const codes = (p: unknown) => validatePolicy(p).map(e => `${e.code}:${e.path}`);
    expect(codes({ base_merge: 'on-conflict', min_gstack_version: BASE_MERGE_KEY_VERSION })).toEqual([]);
    expect(codes({ base_merge: 'always', min_gstack_version: BASE_MERGE_KEY_VERSION })).toEqual([]);
    expect(codes({ base_merge: 'auto' })).toEqual([]);
    expect(codes({ base_merge: 'never', min_gstack_version: BASE_MERGE_KEY_VERSION })).toEqual(['POLICY_INVALID:base_merge']);
    expect(codes({ base_merge: 'on-conflict' }).length).toBeGreaterThan(0);
    expect(minimumReader({ base_merge: 'on-conflict' })).toBe(BASE_MERGE_KEY_VERSION);
  });

  // Value: protects=the receipt records the base tip, how far behind the head is and whether that base still merges, only for a head that lacks origin/<base>;
  //   fails_when=a head holding the base gets a record, behind is miscounted, or a conflicting base reads clean; why_new=GST-1772 (CAPY-1 asked for the record); seam=git merge-tree; no_claim=the PR body's rendering
  test('receipt: a head behind a clean or conflicting base is recorded; a head holding the base is not', () => {
    const f = fx({}, { 'src/a.ts': 'export const a = 2;\n' });
    expect(receiptBaseMerge(f.work, 'main', 'HEAD')).toBeUndefined();
    f.advanceBase({ 'docs/new.md': '# new\n' });
    f.git('fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const tip = f.git('rev-parse', 'origin/main').stdout.trim();
    expect(receiptBaseMerge(f.work, 'main', 'HEAD')).toEqual({ base: tip, behind: 1, mergeable: 'clean' });
    f.advanceBase({ 'src/a.ts': 'export const a = 3;\n' });
    f.git('fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    expect(receiptBaseMerge(f.work, 'origin/main', 'HEAD')).toEqual({ base: f.git('rev-parse', 'origin/main').stdout.trim(), behind: 2, mergeable: 'conflict' });
  });
});
