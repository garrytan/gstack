/**
 * Versions at release (docs/ship-policy.md#release-stamp): gstack-restamp --release folds every fragment on the base
 * under base + their bump, classifyRelease accepts exactly that stamp, gstack-release-stamp open pushes it as
 * release/<version> and opens its PR, the Version Gate passes it, and land --pin merges it without a receipt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyRelease, openRelease } from '../lib/release-stamp';
import { loadPolicyFromBase, MERGE_KEY_VERSION } from '../lib/ship-policy';
import { classifyTrainHead } from '../lib/version-gate-train';
import { BASE_POLICY, cleanup, makeFixtureRepo, readFile, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const POLICY = { ...BASE_POLICY, changelog_fragments: { dir: 'changelog.d', required_checks: ['free-tests'] }, merge: 'direct', min_gstack_version: MERGE_KEY_VERSION };
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

/** A fixture whose main carries two landed fragments (one bump: minor) and a tentative stamp_paths mention, like PRs landed unstamped under merge: direct. */
function landed(fragments: Record<string, string> = { 'a.md': '- a change\n', 'b.md': '---\nbump: minor\n---\n- b feature\n' }): FixtureRepo {
  const repo = makeFixtureRepo({ policy: POLICY, prefix: 'gstack-release-stamp-fx-' });
  repos.push(repo);
  fs.mkdirSync(path.join(repo.work, 'changelog.d'), { recursive: true });
  for (const [name, body] of Object.entries(fragments)) fs.writeFileSync(path.join(repo.work, 'changelog.d', name), body);
  fs.writeFileSync(path.join(repo.work, 'docs', 'feature.md'), 'since: 1.2.9.0\n');
  fs.writeFileSync(path.join(repo.work, 'feature.txt'), 'product\n');
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'land unstamped PRs');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', '--detach', 'origin/main');
  return repo;
}
const policyOf = (repo: FixtureRepo) => { const l = loadPolicyFromBase(repo.work, 'main'); if ('detail' in l && !('policy' in l)) throw new Error('no policy'); return (l as any).policy; };
function stampRelease(repo: FixtureRepo): string {
  const r = runBin(repo, 'gstack-restamp', ['--release', '--base', 'main', '--allow-repo-commands']);
  expect(r.status).toBe(0);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'release');
  return repo.git('rev-parse', 'HEAD');
}

describe('gstack-restamp --release', () => {
  test('folds every fragment on the base under base + their bump, regenerates outputs and moves the tentative mention', () => {
    const repo = landed();
    const r = runBin(repo, 'gstack-restamp', ['--release', '--base', 'main', '--allow-repo-commands']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('STAMP_VERSION: 1.3.0.0');
    expect(readFile(repo, 'VERSION').trim()).toBe('1.3.0.0');
    expect(JSON.parse(readFile(repo, 'package.json')).version).toBe('1.3.0');
    const cl = readFile(repo, 'CHANGELOG.md');
    expect(cl).toMatch(/## \[1\.3\.0\.0\] - \d{4}-\d{2}-\d{2}\n\n- a change\n\n- b feature\n/);
    expect(cl).toContain('## [1.2.3.0] - 2026-10-01\n\n- base release');
    expect(fs.existsSync(path.join(repo.work, 'changelog.d', 'a.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo.work, 'changelog.d', 'b.md'))).toBe(false);
    expect(readFile(repo, 'generated/digest.md')).toBe('# digest v1.3.0.0\nbody\n');
    expect(readFile(repo, 'docs/feature.md')).toBe('since: 1.3.0.0\n');
    expect(readFile(repo, 'docs/notes.md')).toContain('Previous release v1.2.3.0.');
  });

  test('takes its bump from the fragments: --bump with --release is a usage error', () => {
    const repo = landed();
    const r = runBin(repo, 'gstack-restamp', ['--release', '--bump', 'major', '--base', 'main', '--allow-repo-commands']);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain('drop --bump');
    expect(readFile(repo, 'VERSION').trim()).toBe('1.2.3.0');
  });

  test('refuses off a clean checkout of origin/<base>, and with no fragment to release', () => {
    const repo = landed();
    repo.git('checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(repo.work, 'side.txt'), 'x\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'side');
    const off = runBin(repo, 'gstack-restamp', ['--release', '--base', 'main', '--allow-repo-commands']);
    expect(off.status).not.toBe(0);
    expect(off.err).toContain('RELEASE_STAMP_INVALID');
    expect(readFile(repo, 'VERSION').trim()).toBe('1.2.3.0');
    const empty = landed({});
    const none = runBin(empty, 'gstack-restamp', ['--release', '--base', 'main', '--allow-repo-commands']);
    expect(none.status).not.toBe(0);
    expect(none.err).toContain('RELEASE_STAMP_EMPTY');
  });
});

describe('classifyRelease and the Version Gate', () => {
  test('accept exactly the release stamp of the merge base', () => {
    const repo = landed();
    const base = repo.git('rev-parse', 'origin/main');
    const head = stampRelease(repo);
    expect(classifyRelease({ repoRoot: repo.work, policy: policyOf(repo), mergeBase: base, head })).toEqual({ ok: true, version: '1.3.0.0', fragments: ['changelog.d/a.md', 'changelog.d/b.md'] });
    expect(classifyTrainHead({ repoRoot: repo.work, baseRef: 'main', head })).toEqual({ kind: 'release', version: '1.3.0.0', fragments: 2 });
  });

  test.each([
    ['a product change rides along', (w: string) => fs.writeFileSync(path.join(w, 'feature.txt'), 'sneaked\n'), 'feature.txt'],
    ['a fragment stays unfolded', (w: string) => fs.writeFileSync(path.join(w, 'changelog.d', 'a.md'), '- a change\n'), 'changelog.d/a.md'],
    ['the CHANGELOG entry is edited', (w: string) => fs.writeFileSync(path.join(w, 'CHANGELOG.md'), fs.readFileSync(path.join(w, 'CHANGELOG.md'), 'utf8').replace('- a change', '- a rewritten change')), 'CHANGELOG.md'],
    ['the release output is hand-edited', (w: string) => fs.writeFileSync(path.join(w, 'generated', 'digest.md'), '# digest v1.3.0.0\nedited\n'), 'generated/digest.md'],
    ['package.json keeps the old version', (w: string) => fs.writeFileSync(path.join(w, 'package.json'), fs.readFileSync(path.join(w, 'package.json'), 'utf8').replace('"version": "1.3.0"', '"version": "1.2.3"')), 'package.json'],
    ['the CHANGELOG heading names another version', (w: string) => fs.writeFileSync(path.join(w, 'CHANGELOG.md'), fs.readFileSync(path.join(w, 'CHANGELOG.md'), 'utf8').replace('## [1.3.0.0]', '## [9.0.0.0]')), 'CHANGELOG.md'],
    ['two released sections swap their entries', (w: string) => fs.writeFileSync(path.join(w, 'CHANGELOG.md'), fs.readFileSync(path.join(w, 'CHANGELOG.md'), 'utf8').replace('- base release\n', '\0').replace('- older\n', '- base release\n').replace('\0', '- older\n')), 'rewrites the released section(s) 1.2.3.0'],
    ['the release output is deleted', (w: string) => fs.rmSync(path.join(w, 'generated', 'digest.md')), 'generated/digest.md'],
    ['the release output keeps the old version', (w: string) => fs.writeFileSync(path.join(w, 'generated', 'digest.md'), '# digest v1.2.3.0\nbody\n'), 'generated/digest.md'],
    ['the version is not base + the fragments\' bump', (w: string) => fs.writeFileSync(path.join(w, 'VERSION'), '1.4.0.0\n'), 'is 1.3.0.0'],
  ])('refuse a release head where %s', (_name, tamper, named) => {
    const repo = landed();
    const base = repo.git('rev-parse', 'origin/main');
    runBin(repo, 'gstack-restamp', ['--release', '--base', 'main', '--allow-repo-commands']);
    tamper(repo.work);
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'release');
    const head = repo.git('rev-parse', 'HEAD');
    const v = classifyRelease({ repoRoot: repo.work, policy: policyOf(repo), mergeBase: base, head });
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toContain(named);
    const gate = classifyTrainHead({ repoRoot: repo.work, baseRef: 'main', head });
    expect(gate.kind).toBe('invalid');
    expect((gate as { reason: string }).reason).toContain('RELEASE_STAMP_INVALID');
  });

});

describe('gstack-release-stamp open', () => {
  test('pushes release/<version> stamped from origin/main and opens its PR', () => {
    const repo = landed();
    repo.git('checkout', '-q', '-b', 'elsewhere');
    const calls: string[][] = [];
    const r = openRelease({ repoRoot: repo.work, base: 'main', gh: (args) => { calls.push(args); return { ok: true, out: args[1] === 'list' ? '' : 'https://github.com/o/r/pull/42\n', err: '' }; } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.branch).toBe('release/1.3.0.0');
    expect(r.pr).toBe('42');
    expect(repo.git('--git-dir', repo.origin, 'rev-parse', 'refs/heads/release/1.3.0.0')).toBe(r.head!);
    expect(repo.git('--git-dir', repo.origin, 'rev-parse', 'refs/heads/main')).toBe(repo.git('rev-parse', 'origin/main'));
    expect(calls.map(a => a[1])).toEqual(['list', 'create']);
    expect(calls[1]!.slice(0, 7)).toEqual(['pr', 'create', '--base', 'main', '--head', 'release/1.3.0.0', '--title']);
    expect(r.lines.join('\n')).toContain('NEXT: gstack-ship-queue land --pr 42 --pin ' + r.head);
    expect(classifyRelease({ repoRoot: repo.work, policy: policyOf(repo), mergeBase: repo.git('rev-parse', 'origin/main'), head: r.head! }).ok).toBe(true);
    expect(repo.git('branch', '--show-current')).toBe('elsewhere');
    expect(repo.git('worktree', 'list').split('\n')).toHaveLength(1);
  });

  test('a fork PR on release/<version> is never reused: open lists same-repo heads only and opens its own PR', () => {
    const repo = landed();
    const calls: string[][] = [];
    const fork = [{ url: 'https://github.com/fork/r/pull/9', isCrossRepository: true }];
    const r = openRelease({ repoRoot: repo.work, base: 'main', gh: (args) => {
      calls.push(args);
      if (args[1] !== 'list') return { ok: true, out: 'https://github.com/o/r/pull/43\n', err: '' };
      const jq = args[args.indexOf('--jq') + 1] ?? '';
      return { ok: true, out: jq.includes('select(.isCrossRepository | not)') ? '' : fork[0]!.url + '\n', err: '' };
    } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pr).toBe('43');
    expect(calls.map(a => a[1])).toEqual(['list', 'create']);
  });

  test('a checkout with node_modules commits only the stamp, and opening again at the same base replaces the release branch', () => {
    const repo = landed();
    fs.writeFileSync(path.join(repo.work, '.gitignore'), 'node_modules/\n');
    repo.git('add', '.gitignore');
    repo.git('commit', '-q', '-m', 'ignore node_modules');
    repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    fs.mkdirSync(path.join(repo.work, 'node_modules'));
    const gh = () => ({ ok: true, out: 'https://github.com/o/r/pull/43\n', err: '' });
    const first = openRelease({ repoRoot: repo.work, base: 'main', gh });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(repo.git('show', '--name-only', '--format=', first.head!).split('\n')).not.toContain('node_modules');
    expect(classifyRelease({ repoRoot: repo.work, policy: policyOf(repo), mergeBase: repo.git('rev-parse', 'origin/main'), head: first.head! }).ok).toBe(true);
    const again = openRelease({ repoRoot: repo.work, base: 'main', gh, now: new Date('2030-01-02T00:00:00Z') });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(repo.git('--git-dir', repo.origin, 'rev-parse', 'refs/heads/' + again.branch)).toBe(again.head!);
    expect(repo.git('branch', '--list', 'release/*')).toBe('');
  });

  test('--dry-run creates nothing; an empty base is refused', () => {
    const repo = landed();
    const dry = openRelease({ repoRoot: repo.work, base: 'main', dryRun: true, gh: () => { throw new Error('no gh in a dry run'); } });
    expect(dry.ok).toBe(true);
    expect(repo.git('--git-dir', repo.origin, 'branch', '--list', 'release/*')).toBe('');
    const empty = landed({});
    const none = openRelease({ repoRoot: empty.work, base: 'main', gh: () => { throw new Error('no gh when empty'); } });
    expect(none.ok).toBe(false);
    expect((none as { code: string }).code).toBe('RELEASE_STAMP_EMPTY');
  });
});
