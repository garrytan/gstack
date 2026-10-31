/**
 * Pairing negative control (next-wave B2/B-a): finding pairs copied verbatim
 * from a real autoplan run. File:line proximity associates findings but never
 * confirms them, and neither does a title match alone: a title match with
 * the same remedy confirms, opposite remedies disagree, different remedies stay
 * unverified; the parent's override with one shared proposal also confirms.
 */
import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/autoplan-pairing/run-20261014-pairs.json';
import { reconcile } from '../lib/autoplan-reconcile';
import { challengeDefault } from '../lib/autoplan-gate';

const pair = (name: string) => fixture.pairs.find(p => p.name.startsWith(name))! as any;
const challenge = (rows: any[], changes = 'direction') => rows.map(r => ({ ...r, user_challenge: true, changes }));

describe('pairing negative control from a real run', () => {
  test('two findings three lines apart on one file are associated but never confirmed, and never recommend b', () => {
    const p = pair('ceo r1 outside-1');
    const [row] = reconcile(p.native, p.outside).rows;
    expect(row).toMatchObject({ disposition: 'unverified', basis: 'file_line', native_id: p.native[0].id });
    expect(row!.resolution).toStartWith('same location, agreement unverified (bin/gstack-capy-install:197)');
    const [n] = challenge(p.native), [o] = challenge(p.outside);
    expect(challengeDefault(row!, n, o)).toMatchObject({ recommended: 'a', basis: 'plan direction; same location, agreement unverified' });
  });

  test('a location match with different titles stays unverified until the parent confirms it with one proposal', () => {
    const p = pair('dx r2 outside-2');
    const [row] = reconcile(p.native, p.outside).rows;
    expect(row!.disposition).toBe('unverified');
    const [confirmed] = reconcile(p.native, p.outside, [{ outside_id: p.outside[0].id, native_id: p.native[0].id, disposition: 'confirmed', resolution: 'same trailer grammar break', proposal: 'keep `gstack: fail <components>` and specify the pins exit' }]).rows;
    expect(challengeDefault(confirmed!, challenge(p.native, 'scope')[0], challenge(p.outside, 'scope')[0])).toMatchObject({ recommended: 'b', basis: 'both voices; shared proposal' });
  });

  test('the same problem on different files is new until the parent associates it; different remedies keep a', () => {
    const p = pair('dx r2 native-2');
    expect(reconcile(p.native, p.outside).rows[0]).toMatchObject({ disposition: 'new', native_id: null });
    const [row] = reconcile(p.native, p.outside, [{ outside_id: p.outside[0].id, native_id: p.native[0].id, disposition: 'confirmed', resolution: 'both: a recommendation edit changes what a seen reply resolves to' }]).rows;
    expect(challengeDefault(row!, challenge(p.native, 'scope')[0], challenge(p.outside, 'scope')[0])).toMatchObject({ recommended: 'a', basis: 'plan direction; remedies differ; no shared proposal' });
  });

  test('the same title with opposite remedies disagrees, as an ordinary finding and as a user challenge; never b', () => {
    const p = pair('constructed same title, opposite');
    const [row] = reconcile(p.native, p.outside).rows;
    expect(row).toMatchObject({ disposition: 'disagree', basis: 'title' });
    expect(row!.resolution).toStartWith('remedies conflict (same title): native "move attempts into a new retry_attempts table"');
    const [n] = challenge(p.native, 'scope'), [o] = challenge(p.outside, 'scope');
    const [crow] = reconcile([n], [o]).rows;
    expect(crow!.disposition).toBe('disagree');
    expect(challengeDefault(crow!, n, o)).toMatchObject({ recommended: 'a', basis: 'plan direction; voices disagree' });
  });

  test('the same title with different remedies is only associated; the same remedy confirms and recommends b', () => {
    const differ = pair('constructed same title, different');
    const [row] = reconcile(differ.native, differ.outside).rows;
    expect(row).toMatchObject({ disposition: 'unverified' });
    expect(row!.resolution).toStartWith('same title, remedies differ');
    expect(challengeDefault(row!, challenge(differ.native, 'scope')[0], challenge(differ.outside, 'scope')[0])).toMatchObject({ recommended: 'a', basis: 'plan direction; remedies differ; no shared proposal' });
    const same = pair('constructed same title, same remedy');
    const [ok] = reconcile(same.native, same.outside).rows;
    expect(ok).toMatchObject({ disposition: 'confirmed', basis: 'title' });
    expect(challengeDefault(ok!, challenge(same.native, 'scope')[0], challenge(same.outside, 'scope')[0])).toMatchObject({ recommended: 'b', basis: 'both voices; same remedy' });
  });
});

describe('plan reviews name a file without a line (GBRA-223 claim 1)', () => {
  const row = (voice: 'native' | 'outside', n: number, f: Record<string, unknown>) => ({ schema_version: 1, run: 'r', id: `r-dx-${voice}-${n}`, phase: 'dx', voice, disposition: 'open', ...f }) as any;
  const native = row('native', 1, { severity: 'Critical', title: 'per-turn resolver call has no hard timeout or fail-open', file: 'src/resolver.ts', resolution: 'add a 2s timeout and fail open' });

  test('a CAP-coded outside title on the same file is associated, unverified, never new', () => {
    const outside = row('outside', 1, { severity: 'Critical', title: 'CAP4:src/resolver.ts:recovery', file: 'src/resolver.ts', resolution: 'bound the call' });
    const { rows, native_only } = reconcile([native], [outside]);
    expect(rows[0]).toMatchObject({ disposition: 'unverified', basis: 'file', native_id: native.id });
    expect(rows[0]!.resolution).toStartWith('same file, agreement unverified (src/resolver.ts)');
    expect(native_only).toEqual([]);
  });

  test('differently worded titles on the same file associate; the best title among same-file natives wins', () => {
    const other = row('native', 2, { severity: 'Medium', title: 'resolver output is not cached between turns', file: 'src/resolver.ts' });
    const outside = row('outside', 1, { severity: 'Critical', title: 'Resolver call has no timeout and can hang the turn', file: 'src/resolver.ts' });
    expect(reconcile([other, native], [outside]).rows[0]).toMatchObject({ disposition: 'unverified', basis: 'file', native_id: native.id });
  });

  test('a CAP code is not part of the title comparison', () => {
    const outside = row('outside', 1, { severity: 'Critical', title: 'CAP4:src/resolver.ts:recovery per-turn resolver call has no hard timeout or fail-open', file: 'src/resolver.ts', resolution: 'add a 2s timeout and fail open' });
    expect(reconcile([native], [outside]).rows[0]).toMatchObject({ disposition: 'confirmed', basis: 'title' });
  });

  test('controls: two lines far apart, or different files, stay new', () => {
    const lined = row('native', 1, { ...native, id: 'r-dx-native-1', line: 10 });
    expect(reconcile([lined], [row('outside', 1, { severity: 'High', title: 'retry loop has no bound', file: 'src/resolver.ts', line: 90 })]).rows[0]!.disposition).toBe('new');
    expect(reconcile([native], [row('outside', 1, { severity: 'High', title: 'CAP6:src/cli.ts:fix', file: 'src/cli.ts' })]).rows[0]!.disposition).toBe('new');
  });
});
