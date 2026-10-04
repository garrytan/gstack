/**
 * C8 wiring (#3018): Claude reads the router straight from the install root,
 * so `gstack-config set disabled_skills` must leave disabled skills out of
 * that file in the same command (gstack-config → gstack-relink → render), and
 * clearing the list must restore the committed router byte for byte. setup's
 * own renders pass the same list (--disabled-skills) on every host.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BINS = ['gstack-config', 'gstack-relink', 'gstack-patch-names', 'gstack-state-root.sh', 'gstack-install-registry.sh'];

let tmp: string;
let install: string;

function config(...args: string[]) {
  return spawnSync('bash', [path.join(install, 'bin', 'gstack-config'), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      GSTACK_HOME: path.join(tmp, 'state'),
      GSTACK_STATE_ROOT: '',
      GSTACK_STATE_DIR: '',
      GSTACK_INSTALL_DIR: install,
      GSTACK_SKILLS_DIR: path.join(tmp, 'skills'),
      GSTACK_SETUP_RUNNING: '',
    },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-c8-relink-'));
  install = path.join(tmp, 'gstack');
  fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
  for (const b of BINS) fs.copyFileSync(path.join(ROOT, 'bin', b), path.join(install, 'bin', b));
  for (const b of BINS) fs.chmodSync(path.join(install, 'bin', b), 0o755);
  // The generator reads templates from the real checkout and writes only to its out-dir.
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(install, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'SKILL.md'), path.join(install, 'SKILL.md'));
  for (const skill of ['make-pdf', 'retro', 'ship']) {
    fs.mkdirSync(path.join(install, skill));
    fs.writeFileSync(path.join(install, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: test\n---\n# ${skill}\n`);
  }
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('C8: disabled_skills reaches the served Claude router', () => {
  test('gstack-config set renders the router without the disabled skills, and "" restores the committed bytes', () => {
    const committed = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
    expect(committed).toMatch(/→ invoke `\/make-pdf`/);

    const set = config('set', 'disabled_skills', 'make-pdf,retro');
    expect(set.status, set.stderr).toBe(0);
    const router = fs.readFileSync(path.join(install, 'SKILL.md'), 'utf8');
    expect(router).toContain('Disabled on this install (never invoke or suggest them): `/make-pdf`, `/retro`.');
    expect(router).not.toMatch(/→ invoke `\/make-pdf`/);
    expect(router).not.toMatch(/→ invoke `\/retro`/);
    expect(router).toContain('→ invoke `/ship`');

    const clear = config('set', 'disabled_skills', '');
    expect(clear.status, clear.stderr).toBe(0);
    expect(fs.readFileSync(path.join(install, 'SKILL.md'), 'utf8')).toBe(committed);
  });

  test('a router that is not gstack-generated is never rewritten', () => {
    const own = '# my own router\n';
    fs.writeFileSync(path.join(install, 'SKILL.md'), own);
    const set = config('set', 'disabled_skills', 'retro');
    expect(set.status, set.stderr).toBe(0);
    expect(fs.readFileSync(path.join(install, 'SKILL.md'), 'utf8')).toBe(own);
  });

  test('every setup render of the router passes the disabled list', () => {
    const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
    const renders = setup.split('\n').filter(l => /bun_cmd run gen:skill-docs(?::user)? --host/.test(l) && !/^\s*(echo|log)\b/.test(l));
    expect(renders.length).toBeGreaterThanOrEqual(10);
    for (const line of renders) expect(line).toContain('${_DISABLED_CSV:+"--disabled-skills=$_DISABLED_CSV"}');
  });
});
