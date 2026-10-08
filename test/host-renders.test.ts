/**
 * #1694: an install renders skills only for the hosts installed from it.
 *
 * `./setup` used to run `gen:skill-docs --host all` inside the install, so a
 * global Claude install at ~/.claude/skills/gstack carried 632 SKILL.md files
 * (34.7 MB): every other host's render, all scanned by Claude Code and
 * Cursor-agent. setup now keeps an additive record of the hosts it installed
 * ($ROOT/.gstack-installed-hosts, owned by bin/gstack-host-renders.sh) and
 * scripts/build.sh renders claude plus those hosts. A checkout with no record
 * (development) or GSTACK_RENDER_HOSTS=all still renders every host.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ALL_HOST_CONFIGS } from '../hosts';
import { cleanupFixtures, cleanupSeed, makeFixture, makeSource, owned, registryRows, runSetup } from './helpers/install-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const HELPER = path.join(ROOT, 'bin/gstack-host-renders.sh');
const BUILD = fs.readFileSync(path.join(ROOT, 'scripts/build.sh'), 'utf8');
const RENDER_BLOCK = BUILD.slice(BUILD.indexOf('. "$ROOT/bin/gstack-host-renders.sh"'), BUILD.indexOf('\n"$BUN_CMD" build --compile'));
const RENDER_DIRS = ALL_HOST_CONFIGS.filter(h => h.name !== 'claude').map(h => h.hostSubdir);

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

function tmpRoot(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-host-renders-')));
  owned.push(dir);
  return dir;
}

function sh(script: string, env: Record<string, string> = {}, cwd?: string) {
  return spawnSync('bash', ['-c', `set -e\n. "${HELPER}"\n${script}`], {
    cwd, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.tmpdir(), ...env },
  });
}

const skillCount = (dir: string): number => !fs.existsSync(dir) ? 0
  : fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter(e => e.isFile() && e.name === 'SKILL.md').length;

describe.skipIf(process.platform === 'win32')('installed-hosts record (bin/gstack-host-renders.sh)', () => {
  test('its host -> render dir table matches hostSubdir in hosts/*.ts', () => {
    const table = sh('printf "%s\\n" $GSTACK_HOST_RENDER_DIRS').stdout.trim().split('\n').sort();
    expect(table).toEqual(ALL_HOST_CONFIGS.filter(h => h.name !== 'claude').map(h => `${h.name}:${h.hostSubdir}`).sort());
  });

  test('adding is additive, sorted and ignores unknown names; an unchanged set is not rewritten', () => {
    const root = tmpRoot();
    const file = path.join(root, '.gstack-installed-hosts');
    expect(sh(`gstack_render_hosts_add "${root}" codex claude`).status).toBe(0);
    expect(sh(`gstack_render_hosts_add "${root}" factory nonsense`).status).toBe(0);
    expect(sh(`gstack_render_hosts_read "${root}"`).stdout).toBe('claude\ncodex\nfactory\n');
    expect(fs.readFileSync(file, 'utf8')).toContain('# Hosts installed from this gstack checkout');
    const stamp = new Date('2001-01-01');
    fs.utimesSync(file, stamp, stamp);
    expect(sh(`gstack_render_hosts_add "${root}" codex`).status).toBe(0);
    expect(fs.statSync(file).mtime.getTime()).toBe(stamp.getTime());
    fs.appendFileSync(file, 'hermes  # rendered by hand\n\nbogus\n');
    expect(sh(`gstack_render_hosts_read "${root}"`).stdout).toBe('claude\ncodex\nfactory\nhermes\n');
  });

  test('selection: no record renders every host; a record renders claude plus its hosts; GSTACK_RENDER_HOSTS=all overrides', () => {
    const root = tmpRoot();
    const select = (env: Record<string, string> = {}) => sh(`gstack_render_hosts_select "${root}"; echo "$GSTACK_RENDER_HOST_LIST|$GSTACK_RENDER_HOST_REASON"`, env);
    expect(select().stdout).toBe('all|no installed-hosts record, so this is a development checkout\n');
    sh(`gstack_render_hosts_add "${root}" codex`);
    expect(select().stdout).toStartWith('claude codex|recorded in ');
    expect(select({ GSTACK_RENDER_HOSTS: 'all' }).stdout).toBe('all|GSTACK_RENDER_HOSTS=all\n');
    const odd = select({ GSTACK_RENDER_HOSTS: 'codex' });
    expect(odd.stdout).toStartWith('claude codex|');
    expect(odd.stderr).toContain("GSTACK_RENDER_HOSTS accepts only 'all' (got 'codex'); ignoring it");
  });
});

describe.skipIf(process.platform === 'win32')('scripts/build.sh renders the recorded hosts (#1694)', () => {
  // build.sh's render step with a bun that only records its arguments.
  function renderCalls(root: string, env: Record<string, string> = {}) {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.copyFileSync(HELPER, path.join(root, 'bin/gstack-host-renders.sh'));
    const bun = path.join(root, 'fake-bun');
    fs.writeFileSync(bun, `#!/bin/sh\necho "$*" >> "${root}/bun.log"\n`, { mode: 0o755 });
    const r = spawnSync('bash', ['-c', `set -e\nROOT="${root}"\nBUN_CMD="${bun}"\n${RENDER_BLOCK}`], {
      cwd: root, encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    });
    const log = fs.existsSync(path.join(root, 'bun.log')) ? fs.readFileSync(path.join(root, 'bun.log'), 'utf8') : '';
    return { ...r, calls: log.trim().split('\n') };
  }

  test('a development checkout (no record) renders every host and says why', () => {
    const r = renderCalls(tmpRoot());
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual(['run gen:skill-docs --host all']);
    expect(r.stdout).toContain('Rendering skills for every host: no installed-hosts record, so this is a development checkout');
  });

  test('an install renders claude, then each recorded host, and prints them', () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, '.gstack-installed-hosts'), 'codex\nfactory\n');
    const r = renderCalls(root);
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual(['run gen:skill-docs --host claude', 'run gen:skill-docs --host codex', 'run gen:skill-docs --host factory']);
    expect(r.stdout).toContain(`Rendering skills for: claude codex factory (recorded in ${root}/.gstack-installed-hosts; GSTACK_RENDER_HOSTS=all renders every host)`);
  });

  test('GSTACK_RENDER_HOSTS=all renders every host inside an install', () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, '.gstack-installed-hosts'), 'claude\n');
    const r = renderCalls(root, { GSTACK_RENDER_HOSTS: 'all' });
    expect(r.calls).toEqual(['run gen:skill-docs --host all']);
    expect(r.stdout).toContain('Rendering skills for every host: GSTACK_RENDER_HOSTS=all');
  });

  test('a real render inside a Claude install leaves no other host SKILL.md; a development checkout still renders all', () => {
    const f = makeFixture();
    const install = makeSource(f, path.join(f.home, '.claude/skills/gstack'));
    const dev = makeSource(f, path.join(f.home, 'dev/gstack'));
    fs.writeFileSync(path.join(install, '.gstack-installed-hosts'), 'claude\n');
    for (const root of [install, dev]) {
      const r = spawnSync('bash', ['-c', `set -e\nROOT="${root}"\nBUN_CMD=bun\n${RENDER_BLOCK}`], {
        cwd: root, encoding: 'utf8', timeout: 120_000, env: f.env,
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
    for (const dir of RENDER_DIRS) {
      expect(skillCount(path.join(install, dir)), dir).toBe(0);
      expect(skillCount(path.join(dev, dir)), dir).toBeGreaterThan(40);
    }
    expect(skillCount(install)).toBeLessThan(100);
    expect(skillCount(dev)).toBeGreaterThan(500);
  }, 180_000);
});

describe.skipIf(process.platform === 'win32')('setup records each host it installs and never forgets one', () => {
  test('claude, then codex, then factory: the record grows and each recorded host keeps its render', () => {
    const f = makeFixture();
    const src = makeSource(f, path.join(f.home, '.claude/skills/gstack'));
    const setup = (args: string[]) => {
      const r = runSetup(f, path.join(src, 'setup'), args);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      return fs.readFileSync(path.join(src, '.gstack-installed-hosts'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
    };
    expect(setup([])).toEqual(['claude']);
    expect(fs.existsSync(path.join(src, '.agents'))).toBe(false);
    expect(setup(['--host', 'codex'])).toEqual(['claude', 'codex']);
    expect(skillCount(path.join(src, '.agents'))).toBeGreaterThan(40);
    expect(setup(['--host', 'factory'])).toEqual(['claude', 'codex', 'factory']);
    expect(skillCount(path.join(src, '.agents'))).toBeGreaterThan(40);
    expect(skillCount(path.join(src, '.factory'))).toBeGreaterThan(40);
    // The updater path (/gstack-upgrade and gstack-session-update) refreshes
    // every registered install; the record and both renders survive it.
    const r = runSetup(f, path.join(src, 'setup'), ['--refresh-registered']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(registryRows(f).map(row => row[0]).sort()).toEqual(['claude', 'codex', 'factory']);
    expect(setup([])).toEqual(['claude', 'codex', 'factory']);
    expect(skillCount(path.join(src, '.agents'))).toBeGreaterThan(40);
    expect(skillCount(path.join(src, '.factory'))).toBeGreaterThan(40);
    for (const dir of RENDER_DIRS.filter(d => d !== '.agents' && d !== '.factory')) expect(fs.existsSync(path.join(src, dir)), dir).toBe(false);
  }, 240_000);

  test('an install made before the record keeps the hosts the registry says it serves', () => {
    const f = makeFixture();
    const src = makeSource(f, path.join(f.home, '.claude/skills/gstack'));
    expect(runSetup(f, path.join(src, 'setup'), ['--host', 'factory']).status).toBe(0);
    fs.rmSync(path.join(src, '.gstack-installed-hosts'));
    const r = runSetup(f, path.join(src, 'setup'), []);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(src, '.gstack-installed-hosts'), 'utf8')).toContain('\nclaude\nfactory\n');
  }, 120_000);
});
