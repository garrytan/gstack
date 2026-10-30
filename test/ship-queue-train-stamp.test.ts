/**
 * Stamped train prefixes (lib/ship-queue-train-stamp.ts): S_i = stamp(merge(S_(i-1), pin_i)) keeps every
 * earlier release, folds only slot i's own fragments (stacked pins included), runs the versions in ORDER
 * with each slot's effective bump, and a tampered earlier entry or a product change is refused.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergePolicy } from '../lib/ship-policy';
import { buildChain } from '../lib/ship-queue-train';
import { stampChain, stampMismatch, type StampChainOptions } from '../lib/ship-queue-train-stamp';
import type { TrainSlot } from '../lib/ship-queue-train-record';
import { BASE_POLICY, cleanup, makeFixtureRepo, type FixtureRepo } from './helpers/restamp-fixture';

const POLICY = { ...BASE_POLICY, release_tool: null, release_outputs: [], changelog_fragments: { dir: 'changelog.d' }, min_gstack_version: '1.91.336.0' };
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

function pin(r: FixtureRepo, name: string, from: string, fragment: string): string {
  r.git('checkout', '-q', '-B', name, from);
  fs.writeFileSync(path.join(r.work, name + '.txt'), name + '\n');
  fs.mkdirSync(path.join(r.work, 'changelog.d'), { recursive: true });
  fs.writeFileSync(path.join(r.work, 'changelog.d', name + '.md'), fragment);
  r.git('add', '-A'); r.git('commit', '-q', '-m', name);
  return r.git('rev-parse', 'HEAD');
}
function chain(r: FixtureRepo, heads: Array<[string, string]>): StampChainOptions {
  const baseSha = r.git('rev-parse', 'origin/main');
  const slots = heads.map(([pr, head]) => ({ pr, head, ready_at: '2026-10-29T00:00:00Z', screen: { mode: 'none' } }) as unknown as TrainSlot);
  const policy = mergePolicy(POLICY, 'test').policy;
  const built = buildChain(r.work, baseSha, slots, policy);
  if (!('prefixes' in built)) throw new Error('chain conflicted');
  return { repoRoot: r.work, base: 'main', policy, policyLabel: 'test', baseSha, slots, plain: built.prefixes, allowRepoCommands: false, now: new Date('2026-10-29T12:00:00Z') };
}
const show = (r: FixtureRepo, rev: string) => r.git('show', rev);

describe('stamped train prefixes', () => {
  test('independent pins: S2 keeps S1\'s release, versions run in order with each slot\'s bump, fragments are gone', () => {
    const r = makeFixtureRepo({ policy: POLICY, prefix: 'train-stamp-' }); repos.push(r);
    const a = pin(r, 'a', 'origin/main', '- a change\n');
    const b = pin(r, 'b', 'origin/main', '---\nbump: minor\n---\n- b change\n');
    const o = chain(r, [['1', a], ['2', b]]);
    const out = stampChain(o);
    if ('code' in out) throw new Error(out.message);
    expect(out.stamped.map(s => s.version)).toEqual(['1.2.4.0', '1.3.0.0']);
    const s2 = out.stamped[1]!.commit;
    expect(show(r, s2 + ':VERSION')).toBe('1.3.0.0');
    const cl = show(r, s2 + ':CHANGELOG.md');
    expect(cl.indexOf('## [1.3.0.0] - 2026-10-29')).toBeLessThan(cl.indexOf('## [1.2.4.0] - 2026-10-29'));
    expect(cl).toContain('- a change');
    expect(cl).toContain('- b change');
    expect(r.git('ls-tree', '-r', '--name-only', s2, '--', 'changelog.d')).toBe('');
    expect(r.git('rev-parse', s2 + '^1')).toBe(out.stamped[0]!.commit);
    expect(r.git('rev-parse', s2 + '^2')).toBe(b);
  }, 60_000);

  test('stacked pins: the child folds only its own fragment; the parent\'s entry appears once', () => {
    const r = makeFixtureRepo({ policy: POLICY, prefix: 'train-stamp-' }); repos.push(r);
    const p = pin(r, 'p', 'origin/main', '- parent change\n');
    const c = pin(r, 'c', p, '- child change\n');
    const out = stampChain(chain(r, [['1', p], ['2', c]]));
    if ('code' in out) throw new Error(out.message);
    const cl = show(r, out.stamped[1]!.commit + ':CHANGELOG.md');
    expect(cl.split('- parent change').length).toBe(2);
    const top = cl.slice(cl.indexOf('## [1.2.5.0]'), cl.indexOf('## [1.2.4.0]'));
    expect(top).toContain('- child change');
    expect(top).not.toContain('- parent change');
  }, 60_000);

  test('a base with a four-part package.json listed in stamp_files keeps four parts in every S_i, read from S_(i-1)', () => {
    const policy = { ...POLICY, stamp_files: ['VERSION', 'package.json', 'CHANGELOG.md', 'changelog.d/*.md'], stamp_patterns: ['"version": "{version}"'] };
    const r = makeFixtureRepo({ policy, prefix: 'train-stamp-' }); repos.push(r);
    const pkg = JSON.parse(fs.readFileSync(path.join(r.work, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(r.work, 'package.json'), JSON.stringify({ ...pkg, version: '1.2.3.0' }, null, 2) + '\n');
    fs.rmSync(path.join(r.work, 'package-lock.json'));
    r.git('add', '-A'); r.git('commit', '-q', '-m', 'four-part manifest'); r.git('push', '-q', 'origin', 'main');
    const a = pin(r, 'a', 'origin/main', '- a change\n');
    const b = pin(r, 'b', 'origin/main', '- b change\n');
    const o = { ...chain(r, [['1', a], ['2', b]]), policy: mergePolicy(policy, 'test').policy };
    const out = stampChain(o);
    if ('code' in out) throw new Error(out.message);
    expect(out.stamped.map(s => JSON.parse(show(r, s.commit + ':package.json')).version)).toEqual(['1.2.4.0', '1.2.5.0']);
  }, 60_000);

  test('a pin\'s manifest edit beside the version line survives the predecessor\'s bump', () => {
    const r = makeFixtureRepo({ policy: POLICY, prefix: 'train-stamp-' }); repos.push(r);
    const a = pin(r, 'a', 'origin/main', '- a change\n');
    r.git('checkout', '-q', '-B', 'b', 'origin/main');
    const file = path.join(r.work, 'package.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), name: 'fixture-b' }, null, 2) + '\n');
    fs.mkdirSync(path.join(r.work, 'changelog.d'), { recursive: true });
    fs.writeFileSync(path.join(r.work, 'changelog.d', 'b.md'), '- b change\n');
    r.git('add', '-A'); r.git('commit', '-q', '-m', 'b');
    const out = stampChain(chain(r, [['1', a], ['2', r.git('rev-parse', 'HEAD')]]));
    if ('code' in out) throw new Error(out.message);
    const s1 = JSON.parse(show(r, out.stamped[0]!.commit + ':package.json'));
    const s2 = JSON.parse(show(r, out.stamped[1]!.commit + ':package.json'));
    expect(s1.version).toBe('1.2.4');
    expect(s2).toMatchObject({ name: 'fixture-b', version: '1.2.5', dependencies: { 'left-pad': '1.2.3' } });
  }, 60_000);

  test('a pin whose CHANGELOG is a symlink refuses before the stamp writes anything outside', () => {
    const r = makeFixtureRepo({ policy: POLICY, prefix: 'train-stamp-' }); repos.push(r);
    const outside = path.join(r.root, 'outside.md');
    fs.writeFileSync(outside, 'keep\n');
    r.git('checkout', '-q', '-B', 'l', 'origin/main');
    fs.rmSync(path.join(r.work, 'CHANGELOG.md'));
    fs.symlinkSync(outside, path.join(r.work, 'CHANGELOG.md'));
    fs.mkdirSync(path.join(r.work, 'changelog.d'), { recursive: true });
    fs.writeFileSync(path.join(r.work, 'changelog.d', 'l.md'), '- l change\n');
    r.git('add', '-A'); r.git('commit', '-q', '-m', 'l');
    const out = stampChain(chain(r, [['1', r.git('rev-parse', 'HEAD')]]));
    expect('code' in out ? out.message : 'stamped').toMatch(/CHANGELOG\.md is a symlink in the merged tree/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep\n');
  }, 60_000);

  test('a tampered earlier version or a product change in S_i is refused', () => {
    const r = makeFixtureRepo({ policy: POLICY, prefix: 'train-stamp-' }); repos.push(r);
    const a = pin(r, 'a', 'origin/main', '- a change\n');
    const b = pin(r, 'b', 'origin/main', '- b change\n');
    const o = chain(r, [['1', a], ['2', b]]);
    const out = stampChain(o);
    if ('code' in out) throw new Error(out.message);
    const s1 = out.stamped[0]!.commit;
    const s2 = out.stamped[1]!;
    const merged = r.git('commit-tree', r.git('merge-tree', '--write-tree', b, s1).split('\n')[0]!, '-p', s1, '-p', b, '-m', 'm');
    expect(stampMismatch(o, merged, s2.commit, o.plain[2]!.tree)).toBeNull();
    const tamper = (file: string, edit: (t: string) => string) => {
      r.git('checkout', '-q', '-f', '--detach', s2.commit);
      fs.writeFileSync(path.join(r.work, file), edit(fs.readFileSync(path.join(r.work, file), 'utf8')));
      r.git('add', '-A');
      return r.git('commit-tree', r.git('write-tree'), '-p', s1, '-p', b, '-m', 'tampered');
    };
    const older = tamper('CHANGELOG.md', t => t.replace('## [1.2.4.0]', '## [1.2.3.9]'));
    expect(stampMismatch(o, merged, older, o.plain[2]!.tree)).toContain('the stamp rewrote or dropped the earlier release entry [1.2.4.0] in CHANGELOG.md');
    const product = tamper('a.txt', () => 'not a\n');
    expect(stampMismatch(o, merged, product, o.plain[2]!.tree)).toContain('a.txt');
  }, 60_000);
});
