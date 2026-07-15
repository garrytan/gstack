import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regression coverage for issue #1882: every generated SKILL.md preamble
// hard-references ~/.claude/skills/gstack/bin/... When gstack is installed at
// ~/.claude/skills/<name> with <name> != gstack, those references break
// silently at skill-invocation time. `setup` reconciles this with a
// compatibility alias (<skills_dir>/gstack -> <install_dir>) planted by
// link_gstack_compat_alias.

const SETUP_SRC = fs.readFileSync(path.join(import.meta.dir, '..', 'setup'), 'utf-8');

// Pull the bodies of the helpers we need to exercise in isolation. Anchors are
// the function-definition lines; each body ends at the first line that is a
// lone `}` at column 0.
function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`Could not locate ${name}() in setup`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`Could not locate end of ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 3);
}

describe('setup: link_gstack_compat_alias — static invariants (#1882)', () => {
  test('helper is defined', () => {
    expect(SETUP_SRC).toContain('link_gstack_compat_alias() {');
  });

  test('helper is called in the Claude install path with install + skills dirs', () => {
    expect(SETUP_SRC).toContain(
      'link_gstack_compat_alias "$INSTALL_GSTACK_DIR" "$INSTALL_SKILLS_DIR"',
    );
  });

  test('helper no-ops when the install dir is already named gstack', () => {
    const body = extractFn('link_gstack_compat_alias');
    expect(body).toContain('= "gstack" ] && return 0');
  });

  test('helper never clobbers a real (non-symlink) gstack install', () => {
    const body = extractFn('link_gstack_compat_alias');
    // Must bail before writing when a real dir already occupies the alias slot.
    expect(body).toMatch(/\[ ! -L "\$alias" \][\s\S]*return 0/);
  });

  test('helper routes through _link_or_copy (no raw ln, Windows-safe)', () => {
    const body = extractFn('link_gstack_compat_alias');
    expect(body).toContain('_link_or_copy "$install_dir" "$alias"');
  });
});

// Behavioral matrix: source the three helpers into a Unix shell and drive each
// case. Symlink semantics only make sense off Windows.
describe.skipIf(process.platform === 'win32')(
  'setup: link_gstack_compat_alias — behavior',
  () => {
    function run(
      installBasename: string,
      preexisting?: 'real-dir' | 'symlink',
    ): {
      ok: boolean;
      aliasExists: boolean;
      aliasIsSymlink: boolean;
      aliasTarget: string | null;
      aliasRealContent: string | null;
      stdout: string;
    } {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-1882-'));
      try {
        const skillsDir = path.join(tmp, 'skills');
        const installDir = path.join(skillsDir, installBasename);
        // A minimal install dir with a recognisable bin/ marker.
        fs.mkdirSync(path.join(installDir, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(installDir, 'bin', 'gstack-config'), 'echo real-install\n');

        const alias = path.join(skillsDir, 'gstack');
        if (preexisting === 'real-dir') {
          fs.mkdirSync(path.join(alias, 'bin'), { recursive: true });
          fs.writeFileSync(path.join(alias, 'bin', 'gstack-config'), 'echo pre-existing\n');
        } else if (preexisting === 'symlink') {
          // stale self-link pointing somewhere else; helper should refresh it
          const stale = path.join(tmp, 'stale');
          fs.mkdirSync(stale, { recursive: true });
          fs.symlinkSync(stale, alias);
        }

        const helpers = [
          extractFn('_link_or_copy'),
          extractFn('_print_windows_copy_note_once'),
          extractFn('link_gstack_compat_alias'),
        ].join('\n');
        const script = `IS_WINDOWS=0\n_WINDOWS_COPY_NOTE_PRINTED=0\n${helpers}\nlink_gstack_compat_alias "${installDir}" "${skillsDir}"\n`;
        const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 5000 });

        const lst = fs.lstatSync(alias, { throwIfNoEntry: false });
        let target: string | null = null;
        let realContent: string | null = null;
        if (lst?.isSymbolicLink()) target = fs.readlinkSync(alias);
        const cfg = path.join(alias, 'bin', 'gstack-config');
        if (fs.existsSync(cfg)) realContent = fs.readFileSync(cfg, 'utf-8').trim();
        return {
          ok: result.status === 0,
          aliasExists: lst !== undefined,
          aliasIsSymlink: lst?.isSymbolicLink() ?? false,
          aliasTarget: target,
          aliasRealContent: realContent,
          stdout: result.stdout,
        };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    test('non-gstack install dir → alias symlink planted at skills/gstack', () => {
      const r = run('i-gstack');
      expect(r.ok).toBe(true);
      expect(r.aliasIsSymlink).toBe(true);
      expect(r.aliasTarget).toMatch(/i-gstack$/);
      // The alias resolves the hardcoded ~/.claude/skills/gstack/bin path.
      expect(r.aliasRealContent).toBe('echo real-install');
      expect(r.stdout).toContain('compatibility alias: gstack -> i-gstack');
    });

    test('install dir already named gstack → no alias planted (no-op)', () => {
      const r = run('gstack');
      expect(r.ok).toBe(true);
      // The alias slot IS the install dir here, so it exists — but the helper
      // must NOT plant a symlink or announce a compatibility alias.
      expect(r.aliasIsSymlink).toBe(false);
      expect(r.aliasRealContent).toBe('echo real-install');
      expect(r.stdout).not.toContain('compatibility alias');
    });

    test('pre-existing REAL gstack dir → not clobbered', () => {
      const r = run('i-gstack', 'real-dir');
      expect(r.ok).toBe(true);
      expect(r.aliasIsSymlink).toBe(false);
      expect(r.aliasRealContent).toBe('echo pre-existing');
    });

    test('stale gstack symlink → refreshed to this install (idempotent)', () => {
      const r = run('i-gstack', 'symlink');
      expect(r.ok).toBe(true);
      expect(r.aliasIsSymlink).toBe(true);
      expect(r.aliasTarget).toMatch(/i-gstack$/);
    });
  },
);
