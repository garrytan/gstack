/**
 * v2.0.0.0 migration — reap the retired browser-surface skills
 * (open-gstack-browser, connect-chrome, pair-agent, setup-browser-cookies,
 * skillify) from every installed skills tree.
 *
 * Runs the migration against a hermetic temp HOME — nothing touches the real
 * install. Covers:
 *   - whole-dir symlink into a gstack install → removed
 *   - real dir whose SKILL.md symlinks into a gstack install → removed
 *   - real dir with a gstack-generated alias COPY (rewritten name + banner) → removed
 *   - prefixed (gstack-*) variants → removed
 *   - runner contract: only GSTACK_INSTALL_DIR set → sweeps the install's parent
 *   - gbrain install: SKILL.md → ~/.gstack/render/claude/<skill>/ → removed, render dir too
 *   - per-host trees (codex/factory/opencode/cursor): links into the generated
 *     trees → removed, stale generated dirs under the install removed
 *   - kiro: real dir + sed-copied SKILL.md with banner → removed
 *   - unrelated user skill with a retired name (no gstack provenance) → kept
 *   - idempotent second run: exit 0, silent
 *   - missing skills dir → exit 0
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const MIGRATION = path.join(ROOT, 'gstack-upgrade', 'migrations', 'v2.0.0.0.sh');

let tmpHome: string;
let skillsDir: string;
let installRoot: string; // <skillsDir>/gstack — the fake gstack install

const BANNER = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->';

function generatedSkillMd(name: string): string {
  return `---\nname: ${name}\npreamble-tier: 1\nversion: 0.2.0\ndescription: |\n  x\n---\n\n${BANNER}\n\n# /${name}\n`;
}

/** A source skill inside a gstack install (default: the fake ~/.claude one). */
function sourceSkill(name: string, root: string = installRoot): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), generatedSkillMd(name));
  return dir;
}

/** Shape 1: whole-dir symlink (oldest Claude installs; every codex/factory/opencode/cursor entry). */
function linkedEntry(name: string, target: string, dir: string = skillsDir): string {
  const entry = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.relative(dir, target), entry);
  return entry;
}

/** Shape 2: real dir + SKILL.md symlink (standard Unix Claude install). */
function dirWithLinkedSkillMd(name: string, targetDir: string): string {
  const entry = path.join(skillsDir, name);
  fs.mkdirSync(entry);
  fs.symlinkSync(path.join(targetDir, 'SKILL.md'), path.join(entry, 'SKILL.md'));
  return entry;
}

/** Shape 3: real dir + real-file SKILL.md (alias copy, Windows copy, kiro sed copy). */
function dirWithRealSkillMd(name: string, content: string, dir: string = skillsDir): string {
  const entry = path.join(dir, name);
  fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'SKILL.md'), content);
  return entry;
}

/** Run with the runner's env shape. Default mirrors the old explicit contract;
 *  pass `{}` plus GSTACK_INSTALL_DIR to mirror gstack-upgrade Step 4.75 exactly. */
function run(env: Record<string, string> = { GSTACK_SKILLS_DIR: skillsDir }) {
  const r = spawnSync(MIGRATION, [], {
    env: { PATH: '/usr/bin:/bin', HOME: tmpHome, ...env },
    encoding: 'utf-8',
    cwd: tmpHome,
    timeout: 30_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-v2.0-'));
  skillsDir = path.join(tmpHome, '.claude', 'skills');
  installRoot = path.join(skillsDir, 'gstack');
  fs.mkdirSync(installRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('v2.0.0.0 migration — retired browser-surface skills', () => {
  test('symlinked retired skill (whole-dir link into gstack) → removed; live skill untouched', () => {
    const ogb = sourceSkill('open-gstack-browser');
    const qa = sourceSkill('qa');
    const retired = linkedEntry('open-gstack-browser', ogb);
    const live = linkedEntry('qa', qa);

    const r = run();
    expect(r.code).toBe(0);
    expect(fs.existsSync(retired)).toBe(false);
    expect(fs.lstatSync(live).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(ogb)).toBe(true); // only the entry goes, never the install
    expect(r.stdout).toContain('removed retired skill link');
    expect(r.stdout).toContain(retired);
  });

  test('real dir whose SKILL.md symlinks into gstack → removed (flat and prefixed)', () => {
    const pa = sourceSkill('pair-agent');
    const flat = dirWithLinkedSkillMd('pair-agent', pa);
    const prefixed = dirWithLinkedSkillMd('gstack-setup-browser-cookies', sourceSkill('setup-browser-cookies'));

    const r = run();
    expect(r.code).toBe(0);
    expect(fs.existsSync(flat)).toBe(false);
    expect(fs.existsSync(prefixed)).toBe(false);
    expect(r.stdout).toContain('removed retired skill dir');
  });

  test('alias copy (rewritten name + generated banner) → removed', () => {
    // Exactly what setup's _install_alias_skill_md produced for connect-chrome:
    // the open-gstack-browser SKILL.md with name: rewritten to the alias.
    const alias = dirWithRealSkillMd('connect-chrome', generatedSkillMd('connect-chrome'));
    const prefixedAlias = dirWithRealSkillMd('gstack-connect-chrome', generatedSkillMd('gstack-connect-chrome'));
    // Windows-style real-file copy of a retired skill carries the banner too.
    const winCopy = dirWithRealSkillMd('skillify', generatedSkillMd('skillify'));

    const r = run();
    expect(r.code).toBe(0);
    expect(fs.existsSync(alias)).toBe(false);
    expect(fs.existsSync(prefixedAlias)).toBe(false);
    expect(fs.existsSync(winCopy)).toBe(false);
    expect(r.stdout).toContain('removed retired skill copy');
  });

  test('runner contract: only GSTACK_INSTALL_DIR set (project-local install) → sweeps its parent', () => {
    // gstack-upgrade Step 4.75 passes GSTACK_INSTALL_DIR and nothing else; a
    // migration defaulting to ~/.claude/skills would silently no-op here.
    const projSkills = path.join(tmpHome, 'proj', '.claude', 'skills');
    const projInstall = path.join(projSkills, 'gstack');
    const src = sourceSkill('skillify', projInstall);
    const retired = linkedEntry('skillify', src, projSkills);
    // The default-HOME tree is NOT the target this run — its entry must survive.
    const homeEntry = linkedEntry('skillify', sourceSkill('skillify'));

    const r = run({ GSTACK_INSTALL_DIR: projInstall });
    expect(r.code).toBe(0);
    expect(fs.existsSync(retired)).toBe(false);
    expect(fs.lstatSync(homeEntry).isSymbolicLink()).toBe(true);
  });

  test('gbrain install: SKILL.md → ~/.gstack/render/claude/<retired>/ → removed, render dir too', () => {
    // setup:959-962 / bin/gstack-relink serve the rendered tree — no /gstack/ segment.
    const render = path.join(tmpHome, '.gstack', 'render', 'claude');
    const paRender = sourceSkill('pair-agent', render);
    const qaRender = sourceSkill('qa', render);
    const retired = dirWithLinkedSkillMd('pair-agent', paRender);
    const live = dirWithLinkedSkillMd('qa', qaRender);

    const r = run();
    expect(r.code).toBe(0);
    expect(fs.existsSync(retired)).toBe(false);
    expect(fs.existsSync(paRender)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(qaRender)).toBe(true);
    expect(r.stdout).toContain('removed stale render');
  });

  test('per-host trees: codex/factory/opencode/cursor links into generated trees → removed, stale renders pruned', () => {
    // Install cloned somewhere with NO /gstack/ path segment, so only the
    // generated-tree patterns can prove provenance.
    const install = path.join(tmpHome, 'code', 'gs');
    const hosts: Array<[string, string]> = [
      [path.join(tmpHome, '.codex', 'skills'), '.agents'],
      [path.join(tmpHome, '.factory', 'skills'), '.factory'],
      [path.join(tmpHome, '.config', 'opencode', 'skills'), '.opencode'],
      [path.join(tmpHome, '.cursor', 'skills'), '.cursor'],
    ];
    const retiredEntries: string[] = [];
    const liveEntries: string[] = [];
    const staleGen: string[] = [];
    const liveGen: string[] = [];
    for (const [hostDir, genRoot] of hosts) {
      const gen = path.join(install, genRoot, 'skills');
      const stale = sourceSkill('gstack-skillify', gen);
      const live = sourceSkill('gstack-qa', gen);
      staleGen.push(stale);
      liveGen.push(live);
      retiredEntries.push(linkedEntry('gstack-skillify', stale, hostDir));
      liveEntries.push(linkedEntry('gstack-qa', live, hostDir));
    }

    const r = run({ GSTACK_INSTALL_DIR: install });
    expect(r.code).toBe(0);
    for (const e of retiredEntries) expect(fs.existsSync(e)).toBe(false);
    for (const e of liveEntries) expect(fs.lstatSync(e).isSymbolicLink()).toBe(true);
    for (const g of staleGen) expect(fs.existsSync(g)).toBe(false);
    for (const g of liveGen) expect(fs.existsSync(g)).toBe(true);
  });

  test('kiro: real dir + sed-copied SKILL.md (flat name, banner) → removed; user dir kept', () => {
    const kiro = path.join(tmpHome, '.kiro', 'skills');
    const retired = dirWithRealSkillMd('gstack-pair-agent', generatedSkillMd('pair-agent'), kiro);
    const live = dirWithRealSkillMd('gstack-qa', generatedSkillMd('qa'), kiro);
    const users = dirWithRealSkillMd('gstack-skillify', '---\nname: skillify\n---\n\nMy own.\n', kiro);

    const r = run();
    expect(r.code).toBe(0);
    expect(fs.existsSync(retired)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(users)).toBe(true);
  });

  test("unrelated user skill with a retired name → kept (no gstack provenance)", () => {
    // Real dir, real SKILL.md, no generated banner: the user's own /skillify.
    const users = dirWithRealSkillMd('skillify', '---\nname: skillify\n---\n\nMy own notes skill.\n');
    // Retired name whose SKILL.md links somewhere that is NOT a gstack install.
    const elsewhere = path.join(tmpHome, 'tools', 'gstack-fork', 'pair-agent');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), generatedSkillMd('pair-agent'));
    const forkLinked = dirWithLinkedSkillMd('pair-agent', elsewhere);
    // Whole-dir symlink to a non-gstack target.
    const forkLink = linkedEntry('open-gstack-browser', elsewhere);
    // Banner present but name is not a retired one — never in scope.
    const other = dirWithRealSkillMd('my-browser', generatedSkillMd('my-browser'));

    const r = run();
    expect(r.code).toBe(0);
    expect(fs.existsSync(users)).toBe(true);
    expect(fs.existsSync(forkLinked)).toBe(true);
    expect(fs.lstatSync(forkLink).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(r.stdout).toBe('');
  });

  test('idempotent: second run is a silent exit 0', () => {
    linkedEntry('open-gstack-browser', sourceSkill('open-gstack-browser'));
    dirWithRealSkillMd('connect-chrome', generatedSkillMd('connect-chrome'));

    const r1 = run();
    expect(r1.code).toBe(0);
    expect(r1.stdout).not.toBe('');

    const r2 = run();
    expect(r2.code).toBe(0);
    expect(r2.stdout).toBe('');
    expect(r2.stderr).toBe('');
  });

  test('missing skills dir → exit 0, no output', () => {
    const r = run({ GSTACK_SKILLS_DIR: path.join(tmpHome, 'nope') });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });
});
