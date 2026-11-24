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
//   fails_when=relink leaves the old ship entry, links ship under its old name, strips gstack- from its name, or deletes a user's own ship skill;
//   why_new=#4775; seam=the real gstack-relink and gstack-patch-names on a fixture install; no_claim=Claude Code's own lookup
describe.skipIf(process.platform === 'win32')('gstack-relink after /ship became /gstack-ship (#4775)', () => {
  let tmp: string;
  let install: string;
  let skills: string;
  const relink = (config = '') => {
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'state', 'config.yaml'), config);
    return spawnSync('bash', [path.join(install, 'bin', 'gstack-relink')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env, GSTACK_HOME: path.join(tmp, 'state'), GSTACK_STATE_ROOT: '', GSTACK_STATE_DIR: '',
        GSTACK_INSTALL_DIR: install, GSTACK_SKILLS_DIR: skills, GSTACK_SETUP_RUNNING: '',
      },
    });
  };
  const gone = (name: string) => fs.lstatSync(path.join(skills, name), { throwIfNoEntry: false }) === undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ship-renamed-'));
    install = path.join(tmp, 'gstack');
    skills = path.join(tmp, 'skills');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
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

  test("a user's own ship skill is left alone", () => {
    fs.mkdirSync(path.join(skills, 'ship'));
    const own = '---\nname: ship\ndescription: mine\n---\nmy own release script\n';
    fs.writeFileSync(path.join(skills, 'ship', 'SKILL.md'), own);
    const r = relink('skill_prefix: false\n');
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(skills, 'ship', 'SKILL.md'), 'utf8')).toBe(own);
    expect(gone('gstack-ship')).toBe(false);
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
