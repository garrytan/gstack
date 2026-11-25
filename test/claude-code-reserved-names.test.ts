/**
 * Claude Code reserves some command names for its own built-ins and drops any
 * user skill with the same name at startup (checked live on Claude Code
 * 2.1.331, 2026-11-24: "Not loaded: a custom /ship. Rename it, then restart").
 * gstack's /ship was hidden that way (#4775), so it installs as /gstack-ship on
 * every host and in both prefix modes, while its folder and internal id stay
 * ship. This file pins the reserved names and the upgrade from the old entry.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PREFIXED_SKILLS } from '../scripts/discover-skills';

const ROOT = path.resolve(import.meta.dir, '..');
const REGISTRY = path.join(ROOT, 'bin', 'gstack-install-registry.sh');
const BINS = ['gstack-config', 'gstack-lock.sh', 'gstack-relink', 'gstack-patch-names', 'gstack-skill-name.sh', 'gstack-state-root.sh', 'gstack-install-registry.sh'];

/** Names Claude Code 2.1.331 keeps from user skills: its /ship, /ship-local and /steward. */
const CLAUDE_CODE_RESERVED = ['ship', 'ship-local', 'steward'];
/**
 * Known at risk, not reserved yet: Claude Code's /code-review carries the alias
 * review, and its reservation code already checks aliases for /ship. A custom
 * /review still loads on 2.1.331, so gstack's /review is listed here, not failed.
 */
const KNOWN_AT_RISK = ['review'];

const frontmatterName = (file: string) => fs.readFileSync(file, 'utf8').match(/^---\n[\s\S]*?^name:\s*(\S+)/m)?.[1];
const installedNames = () => fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(e => e.isDirectory() && !e.isSymbolicLink() && fs.existsSync(path.join(ROOT, e.name, 'SKILL.md.tmpl')))
  .map(e => frontmatterName(path.join(ROOT, e.name, 'SKILL.md.tmpl'))!)
  .concat(['connect-chrome']);

// Value: protects=every gstack skill loads in Claude Code; fails_when=a skill's installed short name is one Claude Code keeps for a built-in;
//   why_new=/ship was hidden by Claude Code's built-in /ship (#4775); seam=committed templates; no_claim=names Anthropic adds after 2.1.331
test('no installed gstack name is one Claude Code reserves for a built-in', () => {
  const names = installedNames();
  expect(names.length).toBeGreaterThan(40);
  expect(names.filter(n => CLAUDE_CODE_RESERVED.includes(n))).toEqual([]);
  expect(names.filter(n => KNOWN_AT_RISK.includes(n))).toEqual(KNOWN_AT_RISK);
});

test('/ship installs as /gstack-ship: template, generated skill and the always-prefixed list agree', () => {
  expect(frontmatterName(path.join(ROOT, 'ship', 'SKILL.md.tmpl'))).toBe('gstack-ship');
  expect(frontmatterName(path.join(ROOT, 'ship', 'SKILL.md'))).toBe('gstack-ship');
  expect(PREFIXED_SKILLS).toEqual(['ship']);
  const r = spawnSync('bash', ['-c', '. "$1" && printf %s "$GSTACK_PREFIXED_SKILLS"', '_', REGISTRY], { encoding: 'utf8', timeout: 10_000 });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout.split(/\s+/).filter(Boolean)).toEqual(PREFIXED_SKILLS);
});

test('the /ship budget child is started with /gstack-ship, never the reserved /ship', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'ship-handoff.ts'), 'utf8');
  expect(src).toContain('`/gstack-ship --continue ');
  expect(src).not.toMatch(/['"`]\/ship['"` ]/);
});

// Value: protects=an upgrade replaces gstack's hidden /ship with /gstack-ship in both prefix modes and keeps ship opt-outs working;
//   fails_when=relink leaves the old ship entry, links ship under its old name, strips gstack- from its name, serves a render older than the checkout, or deletes a user's own ship skill;
//   why_new=#4775; seam=the real gstack-relink and gstack-patch-names on a fixture install; no_claim=Claude Code's own lookup
describe.skipIf(process.platform === 'win32')('gstack-relink after /ship became /gstack-ship (#4775)', () => {
  let tmp: string;
  let install: string;
  let skills: string;
  let render: string;
  const relink = (config = '') => {
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'state', 'config.yaml'), config);
    return spawnSync('bash', [path.join(install, 'bin', 'gstack-relink')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env, GSTACK_HOME: path.join(tmp, 'state'), GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '',
        GSTACK_INSTALL_DIR: install, GSTACK_SKILLS_DIR: skills, GSTACK_SETUP_RUNNING: '', GSTACK_USER_RENDER_DIR: render,
      },
    });
  };
  const gone = (name: string) => fs.lstatSync(path.join(skills, name), { throwIfNoEntry: false }) === undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ship-renamed-'));
    install = path.join(tmp, 'gstack');
    skills = path.join(tmp, 'skills');
    render = path.join(tmp, 'render');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(install, 'VERSION'), '2.0.0.0\n');
    for (const b of BINS) {
      fs.copyFileSync(path.join(ROOT, 'bin', b), path.join(install, 'bin', b));
      fs.chmodSync(path.join(install, 'bin', b), 0o755);
    }
    for (const [dir, name] of [['ship', 'gstack-ship'], ['qa', 'qa']]) {
      fs.mkdirSync(path.join(install, dir));
      fs.writeFileSync(path.join(install, dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n# ${dir}\n`);
    }
    fs.mkdirSync(skills, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  for (const prefix of ['false', 'true']) {
    test(`skill_prefix ${prefix}: gstack's old ship entry goes and /gstack-ship is linked under its own name`, () => {
      fs.mkdirSync(path.join(skills, 'ship'));
      fs.symlinkSync(path.join(install, 'ship', 'SKILL.md'), path.join(skills, 'ship', 'SKILL.md'));
      fs.writeFileSync(path.join(skills, 'ship', '.gstack-owned'), install + '\n');
      const r = relink(`skill_prefix: ${prefix}\n`);
      expect(r.status, r.stderr).toBe(0);
      expect(gone('ship')).toBe(true);
      expect(fs.readFileSync(path.join(skills, 'gstack-ship', 'SKILL.md'), 'utf8')).toContain('name: gstack-ship');
      expect(fs.readFileSync(path.join(install, 'ship', 'SKILL.md'), 'utf8')).toContain('name: gstack-ship');
      expect(gone(prefix === 'true' ? 'gstack-qa' : 'qa')).toBe(false);
    });
  }

  test("a file the user added to gstack's old ship entry survives the short-name upgrade", () => {
    fs.mkdirSync(path.join(skills, 'ship'));
    fs.symlinkSync(path.join(install, 'ship', 'SKILL.md'), path.join(skills, 'ship', 'SKILL.md'));
    fs.writeFileSync(path.join(skills, 'ship', '.gstack-owned'), install + '\n');
    fs.writeFileSync(path.join(skills, 'ship', 'notes.md'), 'mine\n');
    const r = relink('skill_prefix: false\n');
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(skills, 'ship', 'notes.md'), 'utf8')).toBe('mine\n');
    expect(fs.lstatSync(path.join(skills, 'ship', 'SKILL.md'), { throwIfNoEntry: false })).toBeUndefined();
    expect(gone('gstack-ship')).toBe(false);
  });

  test('an older render still named ship is served as gstack-ship in short-name mode', () => {
    fs.writeFileSync(path.join(install, 'ship', 'SKILL.md'), '---\nname: ship\ndescription: test\n---\n# ship\n');
    const r = relink('skill_prefix: false\n');
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(skills, 'gstack-ship', 'SKILL.md'), 'utf8')).toContain('name: gstack-ship');
  });

  test("a user's own ship skill is left alone", () => {
    fs.mkdirSync(path.join(skills, 'ship'));
    const own = '---\nname: ship\ndescription: mine\n---\nmy own release script\n';
    fs.writeFileSync(path.join(skills, 'ship', 'SKILL.md'), own);
    const r = relink('skill_prefix: false\n');
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(skills, 'ship', 'SKILL.md'), 'utf8')).toBe(own);
    expect(gone('gstack-ship')).toBe(false);
    expect(r.stdout + r.stderr, 'nothing of ours was skipped').not.toContain('skipped ship');
    expect(r.stdout).not.toContain('foreign entr');
  });

  const renderShip = (names: string) => {
    fs.mkdirSync(path.join(render, 'ship', 'sections'), { recursive: true });
    fs.writeFileSync(path.join(render, 'ship', 'SKILL.md'), '---\nname: ship\ndescription: test\n---\nrun /ship --resume\n');
    fs.writeFileSync(path.join(render, 'ship', 'sections', 'tests.md'), 'run /ship --continue\n');
    fs.writeFileSync(render + '.overlay', `overlay=claude\nversion=2.0.0.0\nrender=user\n${names}`);
    fs.mkdirSync(path.join(install, 'ship', 'sections'), { recursive: true });
    fs.writeFileSync(path.join(install, 'ship', 'sections', 'tests.md'), 'run /gstack-ship --continue\n');
  };
  for (const prefix of ['false', 'true']) {
    test(`skill_prefix ${prefix}: a render left by a gstack from before the rename is not served for /gstack-ship, even at the same VERSION`, () => {
      renderShip('');
      fs.mkdirSync(path.join(skills, 'gstack-ship'));
      fs.symlinkSync(path.join(render, 'ship', 'SKILL.md'), path.join(skills, 'gstack-ship', 'SKILL.md'));
      fs.symlinkSync(path.join(render, 'ship', 'sections'), path.join(skills, 'gstack-ship', 'sections'));
      fs.writeFileSync(path.join(skills, 'gstack-ship', '.gstack-owned'), install + '\n');
      const r = relink(`skill_prefix: ${prefix}\n`);
      expect(r.status, r.stderr).toBe(0);
      expect(fs.realpathSync(path.join(skills, 'gstack-ship', 'SKILL.md'))).toBe(fs.realpathSync(path.join(install, 'ship', 'SKILL.md')));
      expect(fs.readFileSync(path.join(skills, 'gstack-ship', 'SKILL.md'), 'utf8')).not.toContain('/ship');
      expect(fs.readFileSync(path.join(skills, 'gstack-ship', 'sections', 'tests.md'), 'utf8')).toBe('run /gstack-ship --continue\n');
      const again = relink(`skill_prefix: ${prefix}\n`);
      expect(again.status, again.stderr).toBe(0);
      expect(fs.realpathSync(path.join(skills, 'gstack-ship', 'SKILL.md')), 'a rerun after patch-names renamed the old render').toBe(fs.realpathSync(path.join(install, 'ship', 'SKILL.md')));
    });
  }

  test("a render whose record carries the current names marker is served for /gstack-ship", () => {
    renderShip('names=2\n');
    const r = relink('skill_prefix: false\n');
    expect(r.status, r.stderr).toBe(0);
    expect(fs.realpathSync(path.join(skills, 'gstack-ship', 'SKILL.md'))).toBe(fs.realpathSync(path.join(render, 'ship', 'SKILL.md')));
    expect(fs.readFileSync(path.join(skills, 'gstack-ship', 'SKILL.md'), 'utf8')).toContain('name: gstack-ship');
  });

  test("a copy of gstack's older ship SKILL.md is reported as moved from an old entry", () => {
    fs.mkdirSync(path.join(skills, 'ship'));
    fs.writeFileSync(path.join(skills, 'ship', 'SKILL.md'), '---\nname: ship\ndescription: older\n---\n# ship\n');
    fs.writeFileSync(path.join(skills, 'ship', '.gstack-owned'), install + '\n');
    const r = relink('skill_prefix: false\n');
    expect(r.status, r.stderr).toBe(0);
    expect(gone('ship')).toBe(true);
    expect(r.stdout).toContain("SKILL.md file(s) from gstack's old entries to ");
    expect(r.stdout).not.toContain('pre-existing');
  });

  test('a missing install registry is reported, not silently linked as /ship', () => {
    fs.rmSync(path.join(install, 'bin', 'gstack-install-registry.sh'));
    const r = relink('skill_prefix: false\n');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('gstack-install-registry.sh is missing');
    expect(r.stderr).toContain('Fix: reinstall with ./setup');
  });

  for (const entry of ['ship', 'gstack-ship']) {
    test(`disabled_skills: ${entry} still turns /gstack-ship off`, () => {
      const r = relink(`skill_prefix: false\ndisabled_skills: ${entry}\n`);
      expect(r.status, r.stderr).toBe(0);
      expect(gone('gstack-ship')).toBe(true);
      expect(gone('ship')).toBe(true);
      expect(gone('qa')).toBe(false);
    });
  }
});
