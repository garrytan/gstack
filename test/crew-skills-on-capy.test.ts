/**
 * gstack on Capy (crew/README.md): the crew skills (/captain) are registered
 * only on a Capy machine (CAPY_MACHINE_CONFIG set, or any ~/.capy entry, which
 * a paired device such as a Mac running Capy has). Everywhere else setup
 * and gstack-relink treat them like a retired skill: no entry on any host, and
 * an existing gstack-owned entry is removed on the next setup or upgrade.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { CREW_SKILLS, RETIRED_SKILLS, onCapyMachine, unregisteredSkills } from '../scripts/discover-skills';

const ROOT = path.resolve(import.meta.dir, '..');
const REGISTRY = path.join(ROOT, 'bin', 'gstack-install-registry.sh');
const BINS = ['gstack-config', 'gstack-relink', 'gstack-patch-names', 'gstack-skill-name.sh', 'gstack-state-root.sh', 'gstack-install-registry.sh'];

let tmp: string;
let home: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-crew-skills-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const onCapy = () => fs.mkdirSync(path.join(home, '.capy', 'system'), { recursive: true });
const registryVar = (name: string, env: Record<string, string> = {}) => {
  const r = spawnSync('bash', ['-c', `. "$1" && printf %s "$${name}"`, '_', REGISTRY], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home, CAPY_MACHINE_CONFIG: '', ...env },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split(/\s+/).filter(Boolean);
};

test('setup, gstack-relink and the harness registrar name the same crew skills', () => {
  expect(registryVar('GSTACK_CREW_SKILLS')).toEqual(CREW_SKILLS);
  expect(CREW_SKILLS).toEqual(['captain']);
});

describe('which skills stay unregistered', () => {
  test('off Capy: the retired skills and the crew skills', () => {
    expect(registryVar('GSTACK_UNREGISTERED_SKILLS')).toEqual([...RETIRED_SKILLS, ...CREW_SKILLS]);
    expect(onCapyMachine({}, home)).toBe(false);
    expect(unregisteredSkills({}, home)).toEqual([...RETIRED_SKILLS, ...CREW_SKILLS]);
  });

  test('on a Capy machine (~/.capy/system): only the retired skills', () => {
    onCapy();
    expect(registryVar('GSTACK_UNREGISTERED_SKILLS')).toEqual(RETIRED_SKILLS);
    expect(onCapyMachine({}, home)).toBe(true);
    expect(unregisteredSkills({}, home)).toEqual(RETIRED_SKILLS);
  });

  // A paired device (a Mac running Capy) has no CAPY_MACHINE_CONFIG; Garry's two Macs
  // both have ~/.capy/system and ~/.capy/device. Anything under ~/.capy fails toward
  // installing the crew skills.
  for (const [label, make] of [
    ['a paired device (~/.capy/device, ~/.capy/system)', () => { fs.mkdirSync(path.join(home, '.capy', 'device'), { recursive: true }); onCapy(); }],
    ['only ~/.capy/device', () => fs.mkdirSync(path.join(home, '.capy', 'device'), { recursive: true })],
    ['an empty ~/.capy', () => fs.mkdirSync(path.join(home, '.capy'))],
    ['~/.capy as a file', () => fs.writeFileSync(path.join(home, '.capy'), '')],
  ] as const) {
    test(`on ${label} with no CAPY_MACHINE_CONFIG: only the retired skills`, () => {
      make();
      expect(registryVar('GSTACK_UNREGISTERED_SKILLS')).toEqual(RETIRED_SKILLS);
      expect(onCapyMachine({}, home)).toBe(true);
      expect(unregisteredSkills({}, home)).toEqual(RETIRED_SKILLS);
    });
  }

  test('on a Capy machine (CAPY_MACHINE_CONFIG): only the retired skills', () => {
    expect(registryVar('GSTACK_UNREGISTERED_SKILLS', { CAPY_MACHINE_CONFIG: '/etc/capy/machine.json' })).toEqual(RETIRED_SKILLS);
    expect(unregisteredSkills({ CAPY_MACHINE_CONFIG: '/etc/capy/machine.json' }, home)).toEqual(RETIRED_SKILLS);
  });
});

describe('gstack-relink registers /captain only on Capy', () => {
  let install: string;
  let skills: string;
  const relink = () => spawnSync('bash', [path.join(install, 'bin', 'gstack-relink')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env, HOME: home, CAPY_MACHINE_CONFIG: '', GSTACK_HOME: path.join(tmp, 'state'), GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '',
      GSTACK_INSTALL_DIR: install, GSTACK_SKILLS_DIR: skills, GSTACK_SETUP_RUNNING: '',
    },
  });

  beforeEach(() => {
    install = path.join(tmp, 'gstack');
    skills = path.join(tmp, 'skills');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    for (const b of BINS) {
      fs.copyFileSync(path.join(ROOT, 'bin', b), path.join(install, 'bin', b));
      fs.chmodSync(path.join(install, 'bin', b), 0o755);
    }
    for (const skill of ['captain', 'ship']) {
      fs.mkdirSync(path.join(install, skill));
      fs.writeFileSync(path.join(install, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: test\n---\n# ${skill}\n`);
    }
    fs.mkdirSync(skills, { recursive: true });
  });

  test('off Capy there is no captain entry, and the other skills link as before', () => {
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.lstatSync(path.join(skills, 'captain'), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.existsSync(path.join(skills, 'ship', 'SKILL.md'))).toBe(true);
    expect(r.stdout).not.toContain('Disabled (gstack-config disabled_skills');
  });

  test('on Capy captain links like any skill', () => {
    onCapy();
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(skills, 'captain', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skills, 'ship', 'SKILL.md'))).toBe(true);
  });

  test('an install that leaves Capy loses the gstack-owned captain entry and keeps a user\'s own', () => {
    onCapy();
    expect(relink().status).toBe(0);
    expect(fs.existsSync(path.join(skills, 'captain', 'SKILL.md'))).toBe(true);
    fs.rmSync(path.join(home, '.capy'), { recursive: true });
    const r = relink();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.lstatSync(path.join(skills, 'captain'), { throwIfNoEntry: false })).toBeUndefined();

    fs.mkdirSync(path.join(skills, 'captain'));
    const own = '---\nname: captain\ndescription: mine\n---\nmy own captain\n';
    fs.writeFileSync(path.join(skills, 'captain', 'SKILL.md'), own);
    expect(relink().status).toBe(0);
    expect(fs.readFileSync(path.join(skills, 'captain', 'SKILL.md'), 'utf8')).toBe(own);
  });
});

describe('the harness registrar registers /captain only on Capy', () => {
  const lib = path.join(ROOT, 'lib', 'harness-register.ts');
  const sourceNames = (env: Record<string, string> = {}) => {
    const probe = `const { sourceSkills, TARGETS } = await import(${JSON.stringify(lib)}); for (const t of ['dots', 'hermes']) console.log(t + ':' + sourceSkills(TARGETS[t], ${JSON.stringify(ROOT)}, process.env.SCRATCH).map(s => s.name).join(' '));`;
    const r = spawnSync(process.execPath, [...bunIsolationArgs(), '-e', probe], {
      encoding: 'utf8', timeout: 120_000, env: { ...process.env, HOME: home, CAPY_MACHINE_CONFIG: '', SCRATCH: path.join(tmp, 'scratch'), ...env },
    });
    expect(r.status, r.stderr).toBe(0);
    return Object.fromEntries(r.stdout.trim().split('\n').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).split(' ')]));
  };

  test('off Capy neither the Claude render nor a host render carries captain', () => {
    const { dots, hermes } = sourceNames();
    expect(dots).toContain('ship');
    expect(dots).not.toContain('captain');
    expect(hermes).toContain('gstack-ship');
    expect(hermes).not.toContain('gstack-captain');
  }, 120_000);

  test('on Capy both renders carry captain', () => {
    const { dots, hermes } = sourceNames({ CAPY_MACHINE_CONFIG: '/etc/capy/machine.json' });
    expect(dots).toContain('captain');
    expect(hermes).toContain('gstack-captain');
  }, 120_000);
});
