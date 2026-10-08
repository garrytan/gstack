/**
 * #1694: renders of hosts an install does not serve are pruned safely.
 *
 * Every ./setup (and the gstack-upgrade migration) removes the render dirs of
 * hosts missing from the installed-hosts record with bin/gstack-relink's proof
 * rules: a symlink into the checkout (STRONG) goes; a file proven generated
 * (WEAK: gen-skill-docs' banner, the generator's openai.yaml shape, byte
 * identity) is moved to $GSTACK_STATE_ROOT/backups/host-renders/; anything
 * else stays; only emptied directories are removed. The legacy layout here is
 * a real `--host all` render.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGeneration } from '../scripts/gen-skill-docs';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, put, runSetup, type Fixture } from './helpers/install-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const OTHER_DIRS = ['.agents', '.factory', '.kiro', '.opencode', '.cursor', '.copilot', '.slate', '.openclaw', '.hermes', '.gbrain'];

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

const skillFiles = (dir: string): string[] => !fs.existsSync(dir) ? []
  : (fs.readdirSync(dir, { recursive: true }) as string[]).filter(rel => path.basename(rel) === 'SKILL.md' && fs.statSync(path.join(dir, rel)).isFile());

async function legacyRender(src: string): Promise<void> {
  const result = await runGeneration({ host: 'all', outputRoot: src });
  if (result.exitCode !== 0) throw new Error('legacy render failed');
}

function backups(f: Fixture): string[] {
  const dir = path.join(f.home, '.gstack/backups/host-renders');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(d => path.join(dir, d)) : [];
}

function setupOk(f: Fixture, src: string, args: string[] = []) {
  const r = runSetup(f, path.join(src, 'setup'), args);
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return r;
}

describe.skipIf(process.platform === 'win32')('setup prunes unrecorded host renders without losing a file (#1694)', () => {
  test('a legacy all-host render inside a Claude install: generated files backed up, user files kept, links handled', async () => {
    const f = makeFixture();
    const src = makeSource(f, path.join(f.home, '.claude/skills/gstack'));
    await legacyRender(src);
    const before = skillFiles(src).length;
    expect(before).toBeGreaterThan(600);
    const customized = path.join(src, '.factory/skills/gstack-qa/SKILL.md');
    fs.appendFileSync(customized, '\nMy own QA note.\n');
    put(path.join(src, '.factory/notes.md'), 'my notes, no banner\n');
    put(path.join(src, '.kiro/skills/my-skill/SKILL.md'), '---\nname: my-skill\n---\nHand-written.\n');
    fs.mkdirSync(path.join(src, '.cursor/skills/gstack'), { recursive: true });
    fs.symlinkSync(path.join(src, 'bin'), path.join(src, '.cursor/skills/gstack/bin'));
    fs.mkdirSync(path.join(f.dir, 'outside'));
    fs.symlinkSync(path.join(f.dir, 'outside'), path.join(src, '.cursor/skills/gstack/elsewhere'));

    const r = setupOk(f, src);
    expect(fs.readFileSync(path.join(src, '.gstack-installed-hosts'), 'utf8')).toEndWith('\nclaude\n');
    // Only the Claude skills and the hand-written look-alike remain.
    const left = skillFiles(src).filter(rel => rel.startsWith('.'));
    expect(left).toEqual(['.kiro/skills/my-skill/SKILL.md']);
    expect(before - skillFiles(src).length).toBeGreaterThan(550);
    expect(fs.readdirSync(path.join(src, '.factory'), { recursive: true })).toEqual(['notes.md']);
    expect(fs.lstatSync(path.join(src, '.cursor/skills/gstack/elsewhere')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(f.dir, 'outside'))).toBe(true);
    expect(fs.existsSync(path.join(src, '.cursor/skills/gstack/bin'))).toBe(false);
    expect(fs.existsSync(path.join(src, 'bin/gstack-config'))).toBe(true);
    for (const dir of ['.agents', '.opencode', '.copilot', '.slate', '.openclaw', '.hermes', '.gbrain']) expect(fs.existsSync(path.join(src, dir)), dir).toBe(false);

    expect(r.stdout).toContain('kept .factory/notes.md: not proven generated (no gstack banner or byte match)');
    expect(r.stdout).toContain('kept .kiro/skills/my-skill/SKILL.md: not proven generated');
    expect(r.stdout).toContain('kept .cursor/skills/gstack/elsewhere: links outside this checkout');
    expect(r.stdout).toMatch(/pruned \.factory \(factory is not installed from this checkout\): \d+ generated files backed up, 0 links removed, \d+ empty dirs removed, 1 kept/);
    const [backup] = backups(f);
    expect(backups(f)).toHaveLength(1);
    expect(r.stdout).toContain(`host-render backup: ${backup} (every path: ${backup}/prune.log; restore a file with mv)`);
    expect(fs.readFileSync(path.join(backup!, '.factory/skills/gstack-qa/SKILL.md'), 'utf8')).toEndWith('\nMy own QA note.\n');
    const log = fs.readFileSync(path.join(backup!, 'prune.log'), 'utf8');
    expect(log).toContain('backed up\t.agents/skills/gstack-qa/agents/openai.yaml\tgenerated');
    expect(log).toContain('backed up\t.hermes/skills/gstack-qa/SKILL.md\tgenerated');
    expect(log).toContain(`removed link\t.cursor/skills/gstack/bin\t-> ${src}/bin`);
    expect(log).toContain('kept\t.factory/notes.md\tnot proven generated');
    expect(log).toContain('removed dir\t.agents\tempty');

    const again = setupOk(f, src);
    expect(again.stdout).not.toContain('pruned ');
    expect(again.stdout).not.toContain('host-render backup');
    expect(backups(f)).toHaveLength(1);
  }, 240_000);

  test('two installs sharing one state root each end with only their own hosts', async () => {
    const f = makeFixture();
    const a = makeSource(f, path.join(f.home, '.claude/skills/gstack'));
    const b = makeSource(f, path.join(f.home, 'src-b/gstack'));
    await legacyRender(a);
    await legacyRender(b);
    setupOk(f, a);
    setupOk(f, b, ['--host', 'codex']);
    for (const dir of OTHER_DIRS) expect(fs.existsSync(path.join(a, dir)), `a ${dir}`).toBe(false);
    expect(skillFiles(path.join(b, '.agents')).length).toBeGreaterThan(40);
    for (const dir of OTHER_DIRS.filter(d => d !== '.agents')) expect(fs.existsSync(path.join(b, dir)), `b ${dir}`).toBe(false);
    expect(backups(f)).toHaveLength(2);
  }, 240_000);

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
