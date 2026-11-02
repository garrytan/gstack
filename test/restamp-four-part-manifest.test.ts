/**
 * A four-part package.json version survives gstack-restamp in a repo whose
 * convention is a four-part manifest (gbrain: VERSION 0.60.483.0 and
 * package.json "0.60.483.0", cross-checked by its CI version gate). The
 * writer used to store the npm-valid three-part form there ("0.60.483").
 * gstack's own shape (a three-part manifest outside the policy's stamp files)
 * and the decision-11 migration of an unlisted four-part manifest are unchanged.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { cleanup, makeFixtureRepo, makePr, readFile, restamp, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const GBRAIN_POLICY = {
  $schema: 'https://github.com/garrytan/gstack/docs/ship-policy.md#schema-v1',
  bump: 'patch',
  queue_mode: 'stamp-at-merge',
  changelog: 'CHANGELOG.md',
  stamp_files: ['VERSION', 'package.json', 'CHANGELOG.md'],
  stamp_patterns: ['"version": "{version}"'],
};

const pkgVersion = (repo: FixtureRepo) => JSON.parse(readFile(repo, 'package.json')).version;
const setPkgVersion = (repo: FixtureRepo, version: string) => {
  const pkg = JSON.parse(readFile(repo, 'package.json'));
  fs.writeFileSync(path.join(repo.work, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2) + '\n');
};

/** Rewrite the fixture's base as gbrain ships it: a four-part manifest mirroring VERSION, and bun, so no npm lockfile. */
function fourPartManifest(repo: FixtureRepo, version: string): void {
  setPkgVersion(repo, version);
  fs.rmSync(path.join(repo.work, 'package-lock.json'));
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'four-part manifest');
  repo.git('push', '-q', 'origin', 'main');
}

describe('gstack-restamp keeps the repo\'s manifest width', () => {
  test('gbrain-shaped repo: package.json keeps four parts and agrees with VERSION', () => {
    const repo = fixture({ policy: GBRAIN_POLICY, version: '0.60.482.0' });
    fourPartManifest(repo, '0.60.482.0');
    makePr(repo, 'feat-a');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('STAMP_VERSION: 0.60.483.0');
    expect(r.out).toContain('stage version: done (wrote 0.60.483.0 (package.json keeps four parts');
    expect(readFile(repo, 'VERSION').trim()).toBe('0.60.483.0');
    expect(pkgVersion(repo)).toBe('0.60.483.0');
  });

  test('gbrain-shaped branch that already carries its stamp: the restamp leaves the four-part manifest as is', () => {
    const repo = fixture({ policy: GBRAIN_POLICY, version: '0.60.482.0' });
    fourPartManifest(repo, '0.60.482.0');
    makePr(repo, 'feat-a');
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '0.60.483.0\n');
    setPkgVersion(repo, '0.60.483.0');
    repo.git('commit', '-q', '-am', 'stamp 0.60.483.0');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('STAMP_VERSION: 0.60.483.0');
    expect(r.out).not.toContain('diff --git a/package.json');
    expect(pkgVersion(repo)).toBe('0.60.483.0');
  });

  test('a branch an older restamp cut to three parts heals: the base\'s four-part manifest sets the form', () => {
    const repo = fixture({ policy: GBRAIN_POLICY, version: '0.60.482.0' });
    fourPartManifest(repo, '0.60.482.0');
    makePr(repo, 'feat-a');
    setPkgVersion(repo, '0.60.482');
    repo.git('commit', '-q', '-am', 'old restamp cut the manifest');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(pkgVersion(repo)).toBe('0.60.483.0');
  });

  test('a manifest listed through stamp_paths keeps four parts too', () => {
    const repo = fixture({ policy: { ...GBRAIN_POLICY, stamp_files: [], stamp_paths: ['package.json'] }, version: '0.60.482.0' });
    fourPartManifest(repo, '0.60.482.0');
    makePr(repo, 'feat-a');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(pkgVersion(repo)).toBe('0.60.483.0');
  });

  test('gstack-shaped repo: the three-part manifest and its lockfile still get the npm-valid form', () => {
    const repo = fixture();
    makePr(repo, 'feat-a');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('stage version: done (wrote 1.2.4.0)');
    expect(readFile(repo, 'VERSION').trim()).toBe('1.2.4.0');
    expect(pkgVersion(repo)).toBe('1.2.4');
    const lock = JSON.parse(readFile(repo, 'package-lock.json'));
    expect([lock.version, lock.packages[''].version]).toEqual(['1.2.4', '1.2.4']);
  });

  test('a four-part manifest the policy does not list as a stamp file still migrates to the npm-valid form (decision 11)', () => {
    const repo = fixture({ policy: { ...GBRAIN_POLICY, stamp_files: ['VERSION', 'CHANGELOG.md'] }, version: '0.60.482.0' });
    fourPartManifest(repo, '0.60.482.0');
    makePr(repo, 'feat-a');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('stage version: done (wrote 0.60.483.0)');
    expect(pkgVersion(repo)).toBe('0.60.483');
  });
});
