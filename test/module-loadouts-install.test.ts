/**
 * gstack-modules install (GSTA-161, PR 1b): an Opus 5.5 session gets a
 * complete, immutable lite tree beside the full install; every other model
 * gets the full root. Covers the round-2 review findings: the folder identity
 * covers model, full root, selection and source tree; runtime assets resolve
 * from the printed SKILL_ROOT; concurrent publishers of one identity agree;
 * the committed checkout stays byte-identical.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { selectModules } from '../scripts/modules';
import { installLoadout, sourceTree } from '../scripts/modules-install';
import { LOCK_FILE } from '../scripts/modules-render';

const ROOT = path.resolve(import.meta.dir, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-install-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const FULL_ROOT = '/opt/claude/skills';
const lite = selectModules({ loadout: 'lite' })!;
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [...bunIsolationArgs(), path.join(ROOT, 'bin/gstack-modules'), ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const committed = ['qa/SKILL.md', 'land-and-deploy/SKILL.md', 'SKILL.md'];

describe('gstack-modules install', () => {
  test('two models on one machine: Opus 5.5 gets the published lite tree, Sonnet the full root; the checkout is untouched', () => {
    const store = path.join(tmp, 'two-models');
    const before = committed.map(rel => digest(path.join(ROOT, rel)));
    const opus = run('install', '--model', 'anthropic/claude-opus-5-5', '--full-root', FULL_ROOT, '--store', store);
    expect(opus.code).toBe(0);
    const [line, rootLine] = opus.stdout.trim().split('\n');
    expect(line).toMatch(/^LOADOUT: lite model=claude-opus-5-5 source=model-flag digest=[0-9a-f]{12} reused=no$/);
    const root = rootLine.replace('SKILL_ROOT: ', '');
    expect(path.dirname(root)).toBe(store);
    const sonnet = run('install', '--model', 'claude-sonnet-5-5', '--full-root', FULL_ROOT, '--store', store);
    expect(sonnet).toMatchObject({ code: 0, stdout: `LOADOUT: full model=none source=model-flag reason=unmapped\nSKILL_ROOT: ${FULL_ROOT}\n` });
    expect(run('install', '--model', 'claude-opus-5-5', '--full-root', FULL_ROOT, '--store', store).stdout).toContain(`reused=yes\nSKILL_ROOT: ${root}\n`);
    expect(fs.readdirSync(store)).toEqual([path.basename(root)]);
    expect(committed.map(rel => digest(path.join(ROOT, rel)))).toEqual(before);
    expect(fs.readFileSync(path.join(ROOT, 'qa/SKILL.md'), 'utf-8')).not.toContain('--loadout');
  }, 240_000);

  test('the lite tree is a complete skill tree: lite sections, baked start lines, runtime assets and the router', async () => {
    const { root, lock } = await installLoadout({ selection: lite, boundModel: 'claude-opus-5-5', fullRoot: FULL_ROOT, store: path.join(tmp, 'tree') });
    const qa = fs.readFileSync(path.join(root, 'qa/SKILL.md'), 'utf-8');
    expect(qa).toContain(`gstack-skill-start --skill "qa" --model "claude" --loadout 'lite' --loadout-model 'claude-opus-5-5' --full-root '${FULL_ROOT}'`);
    expect(qa).toContain(`${root}/qa/sections/`);
    for (const rel of ['qa/templates/qa-report-template.md', 'qa/templates/functional-report-template.md', 'qa/references/issue-taxonomy.md', 'qa/sections/manifest.json', 'gstack/SKILL.md']) {
      expect(fs.existsSync(path.join(root, rel))).toBe(true);
    }
    expect(fs.readFileSync(path.join(root, 'qa/templates/qa-report-template.md'))).toEqual(fs.readFileSync(path.join(ROOT, 'qa/templates/qa-report-template.md')));
    expect(fs.existsSync(path.join(root, 'qa/SKILL.md.tmpl'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'gstack/SKILL.md'))).toEqual(fs.readFileSync(path.join(root, 'SKILL.md')));
    const landing = fs.readFileSync(path.join(root, 'land-and-deploy/SKILL.md'), 'utf-8');
    const full = fs.readFileSync(path.join(ROOT, 'land-and-deploy/SKILL.md'), 'utf-8');
    expect(landing.length).toBeLessThan(full.length);
    expect(landing).toContain(`${FULL_ROOT}/gstack/bin/`);
    expect(landing).not.toContain('~/.claude/skills/gstack/bin/');
    expect(lock).toMatchObject({ kind: 'install', loadout: 'lite', loadout_model: 'claude-opus-5-5', full_root: FULL_ROOT });
    expect(lock.excluded).toHaveLength(11);
    expect(lock.excluded).not.toContain('preamble:upgrade-check');
    expect(lock.excluded).not.toContain('preamble:brain-sync');
    expect(JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), 'utf-8')).identity.source_tree).toBe(sourceTree(ROOT));
  }, 240_000);

  test('the identity covers the bound model and full root; an explicit lite is unbound', async () => {
    const store = path.join(tmp, 'identity');
    const a = await installLoadout({ selection: lite, boundModel: 'claude-opus-5-5', fullRoot: FULL_ROOT, store });
    const b = await installLoadout({ selection: lite, boundModel: 'claude-opus-5-5', fullRoot: '/other/skills', store });
    const c = await installLoadout({ selection: lite, boundModel: null, fullRoot: FULL_ROOT, store });
    expect(new Set([a.root, b.root, c.root]).size).toBe(3);
    const explicit = fs.readFileSync(path.join(c.root, 'qa/SKILL.md'), 'utf-8');
    expect(explicit).toContain('--skill "qa" --model "claude"\n');
    expect(explicit).not.toContain('--loadout');
  }, 240_000);

  test('concurrent publishers of one identity agree on one folder; a tampered folder is refused, not reused', async () => {
    const store = path.join(tmp, 'race');
    const [x, y] = await Promise.all([1, 2].map(() => installLoadout({ selection: lite, boundModel: 'claude-opus-5-5', fullRoot: FULL_ROOT, store })));
    expect(x.root).toBe(y.root);
    expect(fs.readdirSync(store)).toEqual([path.basename(x.root)]);
    fs.appendFileSync(path.join(x.root, 'qa/SKILL.md'), 'tampered\n');
    await expect(installLoadout({ selection: lite, boundModel: 'claude-opus-5-5', fullRoot: FULL_ROOT, store })).rejects.toThrow(/RENDER_DEST_NOT_OWNED/);
  }, 240_000);

  test('pruning removes only its own folders past the three most recently used, and none used in the last day', async () => {
    const store = path.join(tmp, 'prune');
    const install = (fullRoot: string) => installLoadout({ selection: lite, boundModel: 'claude-opus-5-5', fullRoot, store });
    const age = (dir: string, days: number) => { const t = new Date(Date.now() - days * 86_400_000); fs.utimesSync(dir, t, t); };
    const published = () => fs.readdirSync(store).filter(n => /^lite-[0-9a-f]{12}$/.test(n));
    const inUse = await install('/r/0');
    const oldest = await install('/r/1');
    const old = await install('/r/2');
    age(inUse.root, 3);
    age(oldest.root, 3);
    age(old.root, 2);
    const foreign = path.join(store, 'lite-project');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'notes.txt'), 'not gstack\n');
    age(foreign, 9);
    expect((await install('/r/0')).reused).toBe(true);
    const newest = await install('/r/3');
    expect([inUse.root, old.root, newest.root].every(dir => fs.existsSync(dir))).toBe(true);
    expect(fs.existsSync(oldest.root)).toBe(false);
    expect(fs.readFileSync(path.join(foreign, 'notes.txt'), 'utf8')).toBe('not gstack\n');
    await install('/r/4');
    await install('/r/5');
    expect(fs.existsSync(old.root)).toBe(false);
    expect(fs.existsSync(inUse.root)).toBe(true);
    expect(published()).toHaveLength(4);
  }, 300_000);

  test('the source tree identity changes with a commit and with uncommitted edits', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'a.md'), 'one\n');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
    const clean = sourceTree(repo);
    expect(clean).toMatch(/^[0-9a-f]{40}$/);
    expect(sourceTree(repo)).toBe(clean);
    fs.writeFileSync(path.join(repo, 'a.md'), 'two\n');
    const dirty = sourceTree(repo);
    expect(dirty.startsWith(`${clean}+`)).toBe(true);
    fs.writeFileSync(path.join(repo, 'b.md'), 'new\n');
    expect(sourceTree(repo)).not.toBe(dirty);
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'two');
    expect(sourceTree(repo)).toMatch(/^[0-9a-f]{40}$/);
    expect(sourceTree(repo)).not.toBe(clean);
    expect(sourceTree(path.join(tmp, 'not-a-repo-at-all'))).toMatch(/^unpinned-/);
  });

  test('a lite render that fails serves full with LOADOUT_FALLBACK, exit 0', () => {
    const store = path.join(tmp, 'blocked');
    fs.writeFileSync(store, 'a file, not a directory\n');
    const r = run('install', '--model', 'claude-opus-5-5', '--full-root', FULL_ROOT, '--store', store);
    expect(r).toMatchObject({ code: 0, stdout: `LOADOUT: full model=none source=model-flag reason=render-failed\nSKILL_ROOT: ${FULL_ROOT}\n` });
    expect(r.stderr).toContain('LOADOUT_FALLBACK: ');
    expect(run('install', '--model', 'claude-opus-5-5', '--full-root', 'relative/path')).toMatchObject({ code: 2, stderr: expect.stringContaining('MODULE_SPEC_INVALID') });
  });
});
