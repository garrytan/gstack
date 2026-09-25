/**
 * Alias name uniqueness (#2511 / #2201).
 *
 * setup installs two back-compat alias dirs — `_gstack-command` (root router)
 * and `connect-chrome` (→ open-gstack-browser). Both used to symlink the
 * canonical SKILL.md verbatim, so the alias carried the canonical frontmatter
 * `name:`. Claude Code keys skills on that name and requires global
 * uniqueness: the `connect-chrome` duplicate silently shadowed
 * /open-gstack-browser (readdir-order roulette), and the `_gstack-command`
 * duplicate could drop the ENTIRE personal-skills set.
 *
 * The fix is copy-then-rewrite: sed reads the SOURCE and writes a fresh copy
 * with `name:` set to the alias dir's own name. Eng review E2 pinned the
 * hazard this suite guards hardest: on Unix the old install path was a
 * SYMLINK to the repo source, so an in-place sed through it would have
 * corrupted the generated SKILL.md — the source files must stay byte-intact.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runBashScript } from './helpers/bash-script';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-alias-'));
const sourceDir = path.join(fixtureRoot, 'gstack');
const installDir = path.join(fixtureRoot, 'skills');
const skillSources = fs.readdirSync(ROOT)
  .filter((name) => !name.startsWith('.') && name !== 'node_modules')
  .filter((name) => fs.existsSync(path.join(ROOT, name, 'SKILL.md')))
  .map((name) => ({ name, content: fs.readFileSync(path.join(ROOT, name, 'SKILL.md'), 'utf-8') }));

const sourceRootSkill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
const sourceOgbSkill = fs.readFileSync(
  path.join(ROOT, 'open-gstack-browser', 'SKILL.md'),
  'utf-8',
);

beforeAll(() => {
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(installDir);
  fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), sourceRootSkill);
  for (const { name, content } of skillSources) {
    fs.mkdirSync(path.join(sourceDir, name));
    fs.writeFileSync(path.join(sourceDir, name, 'SKILL.md'), content);
  }
  const installOnce = [
    `link_claude_skill_dirs "${sourceDir}" "${installDir}"`,
    `link_claude_root_skill_alias "${sourceDir}" "${installDir}"`,
    // The connect-chrome back-compat alias, exactly as the install section does it.
    `_install_alias_skill_md "${sourceDir}/open-gstack-browser/SKILL.md" "${installDir}/connect-chrome" "connect-chrome"`,
  ].join('\n');
  const script = [
    'set -e',
    'IS_WINDOWS=0',
    'SKILL_PREFIX=0',
    'QUIET=1',
    '_WINDOWS_COPY_NOTE_PRINTED=1',
    '_FOREIGN_SKIPPED_ENTRIES=()',
    `SOURCE_GSTACK_DIR="${sourceDir}"`,
    `GSTACK_USER_RENDER_DIR="${fixtureRoot}/render"`,
    extractFn('_link_or_copy'),
    extractFn('_gstack_link_target_abs'),
    extractFn('_gstack_target_is_ours'),
    extractFn('_gstack_generated_header'),
    extractFn('_claude_entry_is_ours'),
    extractFn('_claude_entry_owned_strongly'),
    extractFn('_backup_skill_md'),
    '_BACKED_UP_SKILL_MDS=()',
    `_SKILL_BACKUP_ROOT="${fixtureRoot}/backups"`,
    extractFn('_write_owned_marker'),
    extractFn('_print_windows_copy_note_once'),
    extractFn('_link_skill_runtime_assets'),
    extractFn('link_claude_skill_dirs'),
    extractFn('_install_alias_skill_md'),
    extractFn('link_claude_root_skill_alias'),
    // Run TWICE: the second pass proves re-runs refresh instead of corrupting
    // (the historical failure mode was sed'ing through a symlink on re-run).
    installOnce,
    installOnce,
  ].join('\n');
  const result = runBashScript(script, { timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(`alias install failed: ${result.stderr}\n${result.stdout}`);
  }
}, 30_000);

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function frontmatterName(skillMdPath: string): string | null {
  const m = fs.readFileSync(skillMdPath, 'utf-8').match(/^name:\s*(\S+)/m);
  return m ? m[1] : null;
}

describe('alias installs are rewritten copies (#2511, #2201)', () => {
  test('_gstack-command alias is NOT a symlink and carries its own name', () => {
    const aliasDir = path.join(installDir, '_gstack-command');
    const aliasSkill = path.join(aliasDir, 'SKILL.md');
    expect(fs.lstatSync(aliasDir).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(aliasSkill).isSymbolicLink()).toBe(false);
    expect(frontmatterName(aliasSkill)).toBe('_gstack-command');
  });

  test('connect-chrome alias is NOT a symlink and carries its own name', () => {
    const aliasDir = path.join(installDir, 'connect-chrome');
    const aliasSkill = path.join(aliasDir, 'SKILL.md');
    expect(fs.lstatSync(aliasDir).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(aliasSkill).isSymbolicLink()).toBe(false);
    expect(frontmatterName(aliasSkill)).toBe('connect-chrome');
  });

  test('alias body is the canonical content — only the name: line differs', () => {
    const alias = fs.readFileSync(
      path.join(installDir, '_gstack-command', 'SKILL.md'),
      'utf-8',
    );
    expect(alias.replace(/^name:.*$/m, 'name: gstack')).toBe(sourceRootSkill);

    const ogbAlias = fs.readFileSync(
      path.join(installDir, 'connect-chrome', 'SKILL.md'),
      'utf-8',
    );
    expect(ogbAlias.replace(/^name:.*$/m, 'name: open-gstack-browser')).toBe(sourceOgbSkill);
  });

  test('the SOURCE files are byte-intact (E2: sed never wrote through a symlink)', () => {
    expect(fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf-8')).toBe(sourceRootSkill);
    expect(fs.readFileSync(path.join(sourceDir, 'open-gstack-browser', 'SKILL.md'), 'utf-8')).toBe(sourceOgbSkill);
    expect(fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8')).toBe(sourceRootSkill);
    expect(
      fs.readFileSync(path.join(ROOT, 'open-gstack-browser', 'SKILL.md'), 'utf-8'),
    ).toBe(sourceOgbSkill);
    expect(frontmatterName(path.join(ROOT, 'SKILL.md'))).toBe('gstack');
    expect(frontmatterName(path.join(ROOT, 'open-gstack-browser', 'SKILL.md'))).toBe(
      'open-gstack-browser',
    );
  });

  test('the isolated source retains every canonical skill without runtime-asset copies', () => {
    expect(fs.readdirSync(sourceDir).sort()).toEqual(['SKILL.md', ...skillSources.map(({ name }) => name)].sort());
    for (const { name, content } of skillSources) {
      expect(fs.readdirSync(path.join(sourceDir, name))).toEqual(['SKILL.md']);
      expect(fs.readFileSync(path.join(sourceDir, name, 'SKILL.md'), 'utf-8')).toBe(content);
      expect(fs.readFileSync(path.join(ROOT, name, 'SKILL.md'), 'utf-8')).toBe(content);
    }
  });

  test('every installed skill name is globally unique', () => {
    const names: string[] = [];
    for (const entry of fs.readdirSync(installDir)) {
      const skillMd = path.join(installDir, entry, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const name = frontmatterName(skillMd);
      if (name) names.push(name);
    }
    expect(names.length).toBeGreaterThan(10);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
    const canonicalNames = skillSources.map(({ name, content }) => content.match(/^name:\s*(\S+)/m)?.[1] ?? name);
    expect(names.sort()).toEqual([...new Set([...canonicalNames, '_gstack-command', 'connect-chrome'])].sort());
  });

  test('a legacy symlinked alias is replaced, not written through', () => {
    // Simulate a pre-fix install: alias SKILL.md is a symlink to the source.
    const legacyDir = fs.mkdtempSync(path.join(fixtureRoot, 'legacy-'));
    try {
      const aliasDir = path.join(legacyDir, '_gstack-command');
      fs.mkdirSync(aliasDir);
      fs.symlinkSync(path.join(sourceDir, 'SKILL.md'), path.join(aliasDir, 'SKILL.md'));
      expect(fs.realpathSync(path.join(aliasDir, 'SKILL.md'))).toBe(fs.realpathSync(path.join(sourceDir, 'SKILL.md')));
      expect(path.relative(fs.realpathSync(fixtureRoot), fs.realpathSync(path.join(aliasDir, 'SKILL.md')))).toBe(path.join('gstack', 'SKILL.md'));

      const script = [
        'set -e',
        'IS_WINDOWS=0',
        '_FOREIGN_SKIPPED_ENTRIES=()',
        `SOURCE_GSTACK_DIR="${sourceDir}"`,
        extractFn('_link_or_copy'),
        extractFn('_gstack_link_target_abs'),
        extractFn('_gstack_target_is_ours'),
        extractFn('_gstack_generated_header'),
        extractFn('_claude_entry_is_ours'),
        extractFn('_claude_entry_owned_strongly'),
        extractFn('_write_owned_marker'),
        extractFn('_install_alias_skill_md'),
        extractFn('link_claude_root_skill_alias'),
        `link_claude_root_skill_alias "${sourceDir}" "${legacyDir}"`,
      ].join('\n');
      const result = runBashScript(script, { timeout: 30_000 });
      expect(result.status).toBe(0);

      const aliasSkill = path.join(aliasDir, 'SKILL.md');
      expect(fs.lstatSync(aliasSkill).isSymbolicLink()).toBe(false);
      expect(frontmatterName(aliasSkill)).toBe('_gstack-command');
      // The source the legacy symlink pointed at is untouched.
      expect(fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf-8')).toBe(sourceRootSkill);
      expect(fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8')).toBe(sourceRootSkill);
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
