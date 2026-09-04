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
import { spawnSync } from 'child_process';
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

const CLAUDE_OWNERSHIP_HELPERS = [
  extractFn('_gstack_upgrade_base_sha'),
  extractFn('_skill_file_matches_source'),
  extractFn('_legacy_claude_consumer_copy'),
  extractFn('_claude_skill_entry_owned'),
  extractFn('_legacy_claude_alias_copy'),
  extractFn('_claude_alias_entry_owned'),
];

const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-alias-install-'));

const sourceRootSkill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
const sourceOgbSkill = fs.readFileSync(
  path.join(ROOT, 'open-gstack-browser', 'SKILL.md'),
  'utf-8',
);

beforeAll(() => {
  const installOnce = [
    `link_claude_skill_dirs "${ROOT}" "${installDir}"`,
    `link_claude_root_skill_alias "${ROOT}" "${installDir}"`,
    // The connect-chrome back-compat alias, exactly as the install section does it.
    `_install_alias_skill_md "${ROOT}/open-gstack-browser/SKILL.md" "${installDir}/connect-chrome" "connect-chrome"`,
  ].join('\n');
  const script = [
    'set -e',
    'IS_WINDOWS=0',
    'SKILL_PREFIX=0',
    'QUIET=1',
    '_WINDOWS_COPY_NOTE_PRINTED=1',
    extractFn('_link_or_copy'),
    ...CLAUDE_OWNERSHIP_HELPERS,
    extractFn('_install_managed_skill_md'),
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
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(`alias install failed: ${result.stderr}\n${result.stdout}`);
  }
}, 30_000);

afterAll(() => {
  fs.rmSync(installDir, { recursive: true, force: true });
});

function frontmatterName(skillMdPath: string): string | null {
  const m = fs.readFileSync(skillMdPath, 'utf-8').match(/^name:\s*(\S+)/m);
  return m ? m[1] : null;
}

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function initHistoryRepo(repo: string): void {
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'GStack Test']);
  git(repo, ['config', 'user.email', 'gstack-test@example.invalid']);
}

function runSetupDestinationPreflight(prefix: 0 | 1, skillsDir: string) {
  const script = [
    'set -e',
    `SKILL_PREFIX=${prefix}`,
    `GSTACK_HOME="${skillsDir}/state"`,
    ...CLAUDE_OWNERSHIP_HELPERS,
    extractFn('preflight_claude_skill_dirs'),
    extractFn('preflight_claude_install'),
    `preflight_claude_install "${ROOT}" "${skillsDir}"`,
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
}

describe('alias installs are rewritten copies (#2511, #2201)', () => {
  test('repeated prefixed setup writes only installed copies and leaves every canonical skill byte-clean', () => {
    const prefixedInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-prefixed-install-'));
    const sourceSkills = fs.readdirSync(ROOT)
      .map((entry) => path.join(ROOT, entry, 'SKILL.md'))
      .filter((skill) => fs.existsSync(skill));
    const before = new Map(sourceSkills.map((skill) => [skill, fs.readFileSync(skill)]));
    try {
      const script = [
        'set -e',
        'IS_WINDOWS=0',
        'SKILL_PREFIX=1',
        'QUIET=1',
        '_WINDOWS_COPY_NOTE_PRINTED=1',
        `GSTACK_HOME="${prefixedInstall}/state"`,
        extractFn('_link_or_copy'),
        ...CLAUDE_OWNERSHIP_HELPERS,
        extractFn('_install_managed_skill_md'),
        extractFn('_print_windows_copy_note_once'),
        extractFn('_link_skill_runtime_assets'),
        extractFn('_install_alias_skill_md'),
        extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${ROOT}" "${prefixedInstall}"`,
        // A normal re-run must refresh consumer copies idempotently without
        // ever rewriting canonical generated sources.
        `link_claude_skill_dirs "${ROOT}" "${prefixedInstall}"`,
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 });
      expect(result.status).toBe(0);

      for (const [skill, bytes] of before) expect(fs.readFileSync(skill)).toEqual(bytes);
      for (const entry of fs.readdirSync(prefixedInstall).filter((name) => name.startsWith('gstack-'))) {
        const installedSkill = path.join(prefixedInstall, entry, 'SKILL.md');
        if (!fs.existsSync(installedSkill)) continue;
        const sourceName = fs.existsSync(path.join(ROOT, entry, 'SKILL.md'))
          ? entry
          : entry.replace(/^gstack-/, '');
        expect(fs.lstatSync(installedSkill).isSymbolicLink()).toBe(false);
        expect(frontmatterName(installedSkill)).toBe(entry);
        expect(fs.readFileSync(installedSkill, 'utf8')).toContain(
          `<!-- AUTO-GENERATED from gstack consumer; source=${sourceName}; served=${entry} -->`,
        );
      }

      const cleanup = spawnSync('bash', ['-c', [
        'set -e',
        'IS_WINDOWS=0',
        extractFn('cleanup_prefixed_claude_symlinks'),
        `cleanup_prefixed_claude_symlinks "${ROOT}" "${prefixedInstall}"`,
      ].join('\n')], { encoding: 'utf8', timeout: 60_000 });
      expect(cleanup.status).toBe(0);
      expect(fs.existsSync(path.join(prefixedInstall, 'gstack-qa'))).toBe(false);
    } finally {
      fs.rmSync(prefixedInstall, { recursive: true, force: true });
    }
  });

  test('first rerun migrates an exact legacy prefixed copy to explicit ownership', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-legacy-prefix-'));
    const legacy = path.join(target, 'gstack-qa');
    fs.mkdirSync(legacy);
    const source = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf8');
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), source.replace(/^name:.*$/m, 'name: gstack-qa'));
    try {
      const result = spawnSync('bash', ['-c', [
        'set -e',
        'IS_WINDOWS=0',
        'SKILL_PREFIX=1',
        'QUIET=1',
        '_WINDOWS_COPY_NOTE_PRINTED=1',
        `GSTACK_HOME="${target}/state"`,
        extractFn('_link_or_copy'),
        ...CLAUDE_OWNERSHIP_HELPERS,
        extractFn('_install_managed_skill_md'),
        extractFn('_print_windows_copy_note_once'),
        extractFn('_link_skill_runtime_assets'),
        extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${ROOT}" "${target}"`,
      ].join('\n')], { encoding: 'utf8', timeout: 60_000 });

      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(legacy, 'SKILL.md'), 'utf8')).toContain(
        '<!-- AUTO-GENERATED from gstack consumer; source=qa; served=gstack-qa -->',
      );
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('first Windows rerun migrates an exact legacy flat copy to explicit ownership', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-legacy-windows-flat-'));
    const legacy = path.join(target, 'qa');
    fs.mkdirSync(legacy);
    fs.copyFileSync(path.join(ROOT, 'qa', 'SKILL.md'), path.join(legacy, 'SKILL.md'));
    try {
      const result = spawnSync('bash', ['-c', [
        'set -e',
        'IS_WINDOWS=1',
        'SKILL_PREFIX=0',
        'QUIET=1',
        '_WINDOWS_COPY_NOTE_PRINTED=1',
        `GSTACK_HOME="${target}/state"`,
        extractFn('_link_or_copy'),
        ...CLAUDE_OWNERSHIP_HELPERS,
        extractFn('_install_managed_skill_md'),
        extractFn('_print_windows_copy_note_once'),
        extractFn('_link_skill_runtime_assets'),
        extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${ROOT}" "${target}"`,
      ].join('\n')], { encoding: 'utf8', timeout: 60_000 });

      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(legacy, 'SKILL.md'), 'utf8')).toContain(
        '<!-- AUTO-GENERATED from gstack consumer; source=qa; served=qa -->',
      );
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('first upgrade adopts a byte-exact prefixed copy from OLD_HEAD after the source changed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-legacy-old-head-'));
    try {
      const source = path.join(tmp, 'source');
      const target = path.join(tmp, 'skills');
      const qa = path.join(source, 'qa');
      fs.mkdirSync(qa, { recursive: true });
      fs.mkdirSync(target);
      initHistoryRepo(source);
      const oldSource = '---\nname: qa\n---\n# old generated body\n';
      const newSource = '---\nname: qa\n---\n# new generated body\n';
      fs.writeFileSync(path.join(qa, 'SKILL.md'), oldSource);
      git(source, ['add', 'qa/SKILL.md']);
      git(source, ['commit', '-qm', 'old source']);
      const oldHead = git(source, ['rev-parse', 'HEAD']);

      const installed = path.join(target, 'gstack-qa');
      fs.mkdirSync(installed);
      fs.writeFileSync(
        path.join(installed, 'SKILL.md'),
        oldSource.replace(/^name:.*$/m, 'name: gstack-qa'),
      );
      fs.writeFileSync(path.join(qa, 'SKILL.md'), newSource);
      git(source, ['add', 'qa/SKILL.md']);
      git(source, ['commit', '-qm', 'new source']);

      const result = spawnSync('bash', ['-c', [
        'set -e',
        'IS_WINDOWS=0',
        'SKILL_PREFIX=1',
        'QUIET=1',
        '_WINDOWS_COPY_NOTE_PRINTED=1',
        `GSTACK_UPGRADE_FROM_HEAD="${oldHead}"`,
        `GSTACK_HOME="${tmp}/state"`,
        extractFn('_link_or_copy'),
        ...CLAUDE_OWNERSHIP_HELPERS,
        extractFn('_install_managed_skill_md'),
        extractFn('_print_windows_copy_note_once'),
        extractFn('_link_skill_runtime_assets'),
        extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${source}" "${target}"`,
      ].join('\n')], { encoding: 'utf8', timeout: 30_000 });

      expect(result.status).toBe(0);
      const installedBytes = fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8');
      expect(installedBytes).toContain('# new generated body');
      expect(installedBytes).toContain(
        '<!-- AUTO-GENERATED from gstack consumer; source=qa; served=gstack-qa -->',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('first upgrade adopts a byte-exact alias from OLD_HEAD after its source changed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-alias-old-head-'));
    try {
      const source = path.join(tmp, 'source');
      const skillDir = path.join(source, 'open-gstack-browser');
      const alias = path.join(tmp, 'skills', 'gstack-connect-chrome');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.mkdirSync(alias, { recursive: true });
      initHistoryRepo(source);
      const oldSource = '---\nname: open-gstack-browser\n---\n# old alias source\n';
      const newSource = '---\nname: open-gstack-browser\n---\n# new alias source\n';
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), oldSource);
      git(source, ['add', 'open-gstack-browser/SKILL.md']);
      git(source, ['commit', '-qm', 'old alias source']);
      const oldHead = git(source, ['rev-parse', 'HEAD']);
      fs.writeFileSync(
        path.join(alias, 'SKILL.md'),
        oldSource.replace(/^name:.*$/m, 'name: gstack-connect-chrome'),
      );
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), newSource);
      git(source, ['add', 'open-gstack-browser/SKILL.md']);
      git(source, ['commit', '-qm', 'new alias source']);

      const result = spawnSync('bash', ['-c', [
        'set -e',
        `GSTACK_UPGRADE_FROM_HEAD="${oldHead}"`,
        ...CLAUDE_OWNERSHIP_HELPERS,
        extractFn('_install_alias_skill_md'),
        `_install_alias_skill_md "${skillDir}/SKILL.md" "${alias}" "gstack-connect-chrome" "${source}"`,
      ].join('\n')], { encoding: 'utf8', timeout: 30_000 });

      expect(result.status).toBe(0);
      const installedBytes = fs.readFileSync(path.join(alias, 'SKILL.md'), 'utf8');
      expect(installedBytes).toContain('# new alias source');
      expect(installedBytes).toContain(
        '<!-- AUTO-GENERATED from gstack alias; served=gstack-connect-chrome -->',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  for (const scenario of [
    { label: 'prefix to flat', prefix: 0 as const, oldName: 'gstack-qa', targetName: 'qa' },
    { label: 'flat to prefix', prefix: 1 as const, oldName: 'qa', targetName: 'gstack-qa' },
  ]) {
    test(`${scenario.label} destination collision leaves both old and user entries untouched`, () => {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-preflight-'));
      const oldDir = path.join(target, scenario.oldName);
      const userDir = path.join(target, scenario.targetName);
      const oldBytes = `---\nname: ${scenario.oldName}\n---\nmanaged old\n<!-- AUTO-GENERATED from gstack consumer; source=qa; served=${scenario.oldName} -->\n`;
      const userBytes = `---\nname: ${scenario.targetName}\n---\nprivate destination\n`;
      fs.mkdirSync(oldDir);
      fs.writeFileSync(path.join(oldDir, 'SKILL.md'), oldBytes);
      fs.mkdirSync(userDir);
      fs.writeFileSync(path.join(userDir, 'SKILL.md'), userBytes);
      try {
        const result = runSetupDestinationPreflight(scenario.prefix, target);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('refusing to replace non-gstack skill entry');
        expect(fs.readFileSync(path.join(oldDir, 'SKILL.md'), 'utf8')).toBe(oldBytes);
        expect(fs.readFileSync(path.join(userDir, 'SKILL.md'), 'utf8')).toBe(userBytes);
      } finally {
        fs.rmSync(target, { recursive: true, force: true });
      }
    });
  }

  test('both Claude install paths run destination preflight before cleanup', () => {
    const installSection = SETUP_SRC.slice(SETUP_SRC.indexOf('# 4. Install for Claude'));
    const preflights = [...installSection.matchAll(/preflight_claude_install/g)].map((match) => match.index ?? -1);
    const cleanups = [...installSection.matchAll(/# Clean up stale symlinks from the opposite prefix mode/g)].map(
      (match) => match.index ?? -1,
    );
    expect(preflights.length).toBe(2);
    expect(cleanups.length).toBe(2);
    expect(preflights[0]).toBeLessThan(cleanups[0]);
    expect(preflights[1]).toBeLessThan(cleanups[1]);
  });

  test('normal setup never points the legacy patch helper at SOURCE_GSTACK_DIR', () => {
    expect(SETUP_SRC).not.toContain('gstack-patch-names" "$SOURCE_GSTACK_DIR"');
  });

  test('prefixed setup fails closed on a user-owned gstack-* collision', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-prefixed-collision-'));
    const collision = path.join(target, 'gstack-qa');
    fs.mkdirSync(collision, { recursive: true });
    const userSkill = '---\nname: gstack-qa\n---\n# private QA workflow\n';
    fs.writeFileSync(path.join(collision, 'SKILL.md'), userSkill);
    fs.writeFileSync(path.join(collision, 'keep.txt'), 'keep\n');
    try {
      const script = [
        'set -e',
        'IS_WINDOWS=0',
        'SKILL_PREFIX=1',
        'QUIET=1',
        '_WINDOWS_COPY_NOTE_PRINTED=1',
        `GSTACK_HOME="${target}/state"`,
        extractFn('_link_or_copy'),
        ...CLAUDE_OWNERSHIP_HELPERS,
        extractFn('_install_managed_skill_md'),
        extractFn('_print_windows_copy_note_once'),
        extractFn('_link_skill_runtime_assets'),
        extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${ROOT}" "${target}"`,
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('refusing to replace non-gstack skill entry');
      expect(fs.readFileSync(path.join(collision, 'SKILL.md'), 'utf8')).toBe(userSkill);
      expect(fs.readFileSync(path.join(collision, 'keep.txt'), 'utf8')).toBe('keep\n');
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

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
    expect(fs.readFileSync(aliasSkill, 'utf8')).toContain(
      '<!-- AUTO-GENERATED from gstack alias; served=connect-chrome -->',
    );
  });

  test('a user-owned gstack-connect-chrome alias collision survives unchanged', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-alias-collision-'));
    const collision = path.join(target, 'gstack-connect-chrome');
    fs.mkdirSync(collision, { recursive: true });
    const userSkill = '---\nname: gstack-connect-chrome\n---\n# user alias\n';
    fs.writeFileSync(path.join(collision, 'SKILL.md'), userSkill);
    fs.writeFileSync(path.join(collision, 'keep.txt'), 'keep\n');
    try {
      const result = spawnSync('bash', ['-c', [
        'set -e',
        ...CLAUDE_OWNERSHIP_HELPERS,
        extractFn('_install_alias_skill_md'),
        `_install_alias_skill_md "${ROOT}/open-gstack-browser/SKILL.md" "${collision}" "gstack-connect-chrome"`,
      ].join('\n')], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('refusing to replace non-gstack skill entry');
      expect(fs.readFileSync(path.join(collision, 'SKILL.md'), 'utf8')).toBe(userSkill);
      expect(fs.readFileSync(path.join(collision, 'keep.txt'), 'utf8')).toBe('keep\n');
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('prefix-to-flat cleanup removes only the exact managed connect-chrome alias', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-alias-prefix-cleanup-'));
    const aliasDir = path.join(target, 'gstack-connect-chrome');
    fs.mkdirSync(aliasDir);
    fs.writeFileSync(
      path.join(aliasDir, 'SKILL.md'),
      '---\nname: gstack-connect-chrome\n---\n<!-- AUTO-GENERATED from gstack alias; served=gstack-connect-chrome -->\n',
    );
    try {
      const result = spawnSync('bash', ['-c', [
        'set -e',
        'IS_WINDOWS=0',
        extractFn('cleanup_prefixed_claude_symlinks'),
        `cleanup_prefixed_claude_symlinks "${ROOT}" "${target}"`,
      ].join('\n')], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).toBe(0);
      expect(fs.existsSync(aliasDir)).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('flat-to-prefix cleanup removes only the exact managed connect-chrome alias', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-alias-flat-cleanup-'));
    const aliasDir = path.join(target, 'connect-chrome');
    fs.mkdirSync(aliasDir);
    fs.writeFileSync(
      path.join(aliasDir, 'SKILL.md'),
      '---\nname: connect-chrome\n---\n<!-- AUTO-GENERATED from gstack alias; served=connect-chrome -->\n',
    );
    try {
      const result = spawnSync('bash', ['-c', [
        'set -e',
        'IS_WINDOWS=0',
        extractFn('cleanup_old_claude_symlinks'),
        `cleanup_old_claude_symlinks "${ROOT}" "${target}"`,
      ].join('\n')], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).toBe(0);
      expect(fs.existsSync(aliasDir)).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('alias body is the canonical content — only the name: line differs', () => {
    const alias = fs.readFileSync(
      path.join(installDir, '_gstack-command', 'SKILL.md'),
      'utf-8',
    );
    expect(
      alias
        .replace(/^name:.*$/m, 'name: gstack')
        .replace(/\n<!-- AUTO-GENERATED from gstack alias; served=_gstack-command -->\n$/, ''),
    ).toBe(sourceRootSkill);

    const ogbAlias = fs.readFileSync(
      path.join(installDir, 'connect-chrome', 'SKILL.md'),
      'utf-8',
    );
    expect(
      ogbAlias
        .replace(/^name:.*$/m, 'name: open-gstack-browser')
        .replace(/\n<!-- AUTO-GENERATED from gstack alias; served=connect-chrome -->\n$/, ''),
    ).toBe(sourceOgbSkill);
  });

  test('the SOURCE files are byte-intact (E2: sed never wrote through a symlink)', () => {
    expect(fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8')).toBe(sourceRootSkill);
    expect(
      fs.readFileSync(path.join(ROOT, 'open-gstack-browser', 'SKILL.md'), 'utf-8'),
    ).toBe(sourceOgbSkill);
    expect(frontmatterName(path.join(ROOT, 'SKILL.md'))).toBe('gstack');
    expect(frontmatterName(path.join(ROOT, 'open-gstack-browser', 'SKILL.md'))).toBe(
      'open-gstack-browser',
    );
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
  });

  test('a legacy symlinked alias is replaced, not written through', () => {
    // Simulate a pre-fix install: alias SKILL.md is a symlink to the source.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-alias-legacy-'));
    try {
      const aliasDir = path.join(legacyDir, '_gstack-command');
      fs.mkdirSync(aliasDir);
      fs.symlinkSync(path.join(ROOT, 'SKILL.md'), path.join(aliasDir, 'SKILL.md'));

      const script = [
        'set -e',
        'IS_WINDOWS=0',
        extractFn('_link_or_copy'),
        ...CLAUDE_OWNERSHIP_HELPERS,
        extractFn('_install_alias_skill_md'),
        extractFn('link_claude_root_skill_alias'),
        `link_claude_root_skill_alias "${ROOT}" "${legacyDir}"`,
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 30_000 });
      expect(result.status).toBe(0);

      const aliasSkill = path.join(aliasDir, 'SKILL.md');
      expect(fs.lstatSync(aliasSkill).isSymbolicLink()).toBe(false);
      expect(frontmatterName(aliasSkill)).toBe('_gstack-command');
      // The source the legacy symlink pointed at is untouched.
      expect(fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8')).toBe(sourceRootSkill);
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
