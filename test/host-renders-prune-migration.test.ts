/**
 * #1694 host-render prune: a host linked into the render is kept, and the gstack-upgrade migration prunes existing installs.
 * Split from test/host-renders-prune.test.ts so the free-suite packer can balance it (60 s seed ceiling).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, put, type Fixture } from './helpers/install-fixture';
import { ROOT, backups, legacyRender, setupOk, skillFiles } from './helpers/host-renders-prune-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('setup prunes unrecorded host renders without losing a file (#1694)', () => {
  test('a host whose skills link into the render is kept even with no registry row', async () => {
    const f = makeFixture();
    const src = makeSource(f, path.join(f.home, '.claude/skills/gstack'));
    await legacyRender(src);
    fs.mkdirSync(path.join(f.home, '.factory/skills'), { recursive: true });
    fs.symlinkSync(path.join(src, '.factory/skills/gstack-qa'), path.join(f.home, '.factory/skills/gstack-qa'));
    setupOk(f, src);
    expect(fs.readFileSync(path.join(src, '.gstack-installed-hosts'), 'utf8')).toEndWith('\nclaude\nfactory\n');
    expect(skillFiles(path.join(src, '.factory')).length).toBeGreaterThan(40);
    expect(fs.existsSync(path.join(f.home, '.factory/skills/gstack-qa/SKILL.md'))).toBe(true);
  }, 240_000);
});

describe.skipIf(process.platform === 'win32')('gstack-upgrade migration prunes existing installs (#1694)', () => {
  const migrations = fs.readdirSync(path.join(ROOT, 'gstack-upgrade/migrations'))
    .filter(n => fs.readFileSync(path.join(ROOT, 'gstack-upgrade/migrations', n), 'utf8').includes('gstack-host-renders.sh'));

  test('exactly one migration owns the prune, and setup runs it (not newer than VERSION)', () => {
    expect(migrations).toEqual([expect.stringMatching(/^v\d+\.\d+\.\d+\.\d+\.sh$/)]);
    const parts = (v: string) => v.split('.').map(Number);
    const mine = parts(migrations[0]!.slice(1, -3));
    const version = parts(fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim());
    const cmp = mine.map((n, i) => n - version[i]!).find(d => d !== 0) ?? 0;
    expect(cmp).toBeLessThanOrEqual(0);
  });

  function migrate(f: Fixture, install: string) {
    return spawnSync('bash', [path.join(install, 'gstack-upgrade/migrations', migrations[0]!)], {
      cwd: f.home, encoding: 'utf8', timeout: 60_000, env: { ...f.env, GSTACK_INSTALL_DIR: install },
    });
  }

  test('a pre-record Claude install: renders of other hosts are backed up and removed, a look-alike survives, rerun is a no-op', async () => {
    const f = makeFixture();
    const src = makeSource(f, path.join(f.home, '.claude/skills/gstack'));
    await legacyRender(src);
    put(path.join(src, '.opencode/skills/mine/SKILL.md'), 'no banner\n');
    const r = migrate(f, src);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(src, '.gstack-installed-hosts'), 'utf8')).toEndWith('\nclaude\n');
    expect(skillFiles(src).filter(rel => rel.startsWith('.'))).toEqual(['.opencode/skills/mine/SKILL.md']);
    expect(r.stdout).toContain('kept .opencode/skills/mine/SKILL.md: not proven generated');
    expect(backups(f)).toHaveLength(1);
    const again = migrate(f, src);
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain('pruned ');
    expect(backups(f)).toHaveLength(1);
  }, 240_000);

  test('a checkout no install points at is left alone', async () => {
    const f = makeFixture();
    const src = makeSource(f, path.join(f.home, 'elsewhere/gstack'));
    await legacyRender(src);
    const before = skillFiles(src).length;
    const r = migrate(f, src);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`host renders: no install from ${src} was found, so its renders were left alone`);
    expect(skillFiles(src).length).toBe(before);
    expect(fs.existsSync(path.join(src, '.gstack-installed-hosts'))).toBe(false);
  }, 240_000);
});
