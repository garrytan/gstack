import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>;
};
const BUILD_SCRIPT_PATH = path.join(ROOT, 'scripts', 'build.sh');
const WRITE_VERSION_PATH = path.join(ROOT, 'scripts', 'write-version-files.sh');
const BUILD_SCRIPT = fs.readFileSync(BUILD_SCRIPT_PATH, 'utf-8');

// Strip single-quoted strings so JS code emitted as `echo '{ ... }'` doesn't
// trip the shell-brace-group check. Conservative: only `'...'` segments.
function stripSingleQuoted(s: string): string {
  return s.replace(/'[^']*'/g, "''");
}

describe('package.json build scripts — POSIX shell compat (D-1460)', () => {
  // Bun's Windows shell parser doesn't grok bash brace groups `{ cmd; }`.
  // Bun 1.3.x on Windows also rejects subshells when the subshell or the
  // command inside it uses redirection, so redirected commands must be direct.
  test('no bash brace groups in any npm script', () => {
    const offending: { script: string; pattern: string }[] = [];
    for (const [name, body] of Object.entries(PKG.scripts)) {
      const stripped = stripSingleQuoted(body);
      const match = stripped.match(/\{\s+[^}]*;\s*\}/);
      if (match) {
        offending.push({ script: name, pattern: match[0] });
      }
    }
    expect(offending).toEqual([]);
  });

  test('build script has no subshells with redirections', () => {
    const offending: { script: string; pattern: string }[] = [];
    for (const [name, body] of Object.entries({ build: PKG.scripts.build ?? '' })) {
      const matches = [
        ...body.matchAll(/\([^)]*[<>][^)]*\)/g),
        ...body.matchAll(/\([^)]*\)\s*[<>]/g),
      ];
      for (const match of matches) {
        offending.push({ script: name, pattern: match[0] });
      }
    }
    expect(offending).toEqual([]);
  });

  test('build script delegates .version writes to a shell script', () => {
    // Bun rejects `( git ... ) > path/.version`.
    const build = PKG.scripts.build ?? '';
    expect(build).not.toMatch(/>\s*\S+\/\.version/);
    expect(build).toBe('bash scripts/build.sh');
    expect(BUILD_SCRIPT).toContain('bash scripts/write-version-files.sh');
  });
});

// ── Issue #1602: Windows build hardening ──────────────────────────────────
// Static string-matching catches the package.json regression. These tests
// also exercise the helper scripts so a hand-written bash bug (missing
// shebang, broken loop, syntax error) is caught at `bun test` time on every
// platform — no need to fully build the project to find a syntax error.

describe('Windows build hardening (issue #1602)', () => {
  test('scripts/build.sh is bash-syntax-clean (bash -n)', () => {
    const r = spawnSync('bash', ['-n', BUILD_SCRIPT_PATH], { timeout: 5000 });
    expect(r.status).toBe(0);
    expect((r.stderr ?? '').toString()).toBe('');
  });

  test('scripts/write-version-files.sh is bash-syntax-clean (bash -n)', () => {
    const r = spawnSync('bash', ['-n', WRITE_VERSION_PATH], { timeout: 5000 });
    expect(r.status).toBe(0);
    expect((r.stderr ?? '').toString()).toBe('');
  });

  test('scripts/write-version-files.sh writes one .version file per argument', () => {
    // The build chain calls this with three paths (browse/dist/.version,
    // design/dist/.version, make-pdf/dist/.version). Validate the loop body
    // by invoking with controlled targets in a tmpdir — catches a future
    // refactor that loses the `for/do/done` shape or drops `mkdir -p`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-version-files-'));
    try {
      const a = path.join(dir, 'a', 'dist', '.version');
      const b = path.join(dir, 'b', 'dist', '.version');
      const r = spawnSync('bash', [WRITE_VERSION_PATH, a, b], {
        timeout: 5000,
        env: { ...process.env, PATH: process.env.PATH ?? '' },
      });
      expect(r.status).toBe(0);
      expect(fs.existsSync(a)).toBe(true);
      expect(fs.existsSync(b)).toBe(true);
      // Both files share the same git_head value, derived once at the top
      // of the script.
      expect(fs.readFileSync(a, 'utf-8')).toBe(fs.readFileSync(b, 'utf-8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('scripts/write-version-files.sh tolerates being run outside a git repo', () => {
    // The script's git rev-parse is wrapped in `if … then : else git_head=""`.
    // Catches a regression where that fallback gets stripped and the script
    // dies under `set -e` when run from a tarball.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-version-no-git-'));
    try {
      const target = path.join(dir, 'dist', '.version');
      const r = spawnSync('bash', [WRITE_VERSION_PATH, target], {
        timeout: 5000,
        cwd: dir,                       // outside any git repo
        env: {
          ...process.env,
          PATH: process.env.PATH ?? '',
          GIT_DIR: '/nonexistent',      // force git rev-parse to fail
        },
      });
      expect(r.status).toBe(0);
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('package.json build entry contains no constructs the Bun Windows shell rejects', () => {
    // Comprehensive guard collecting every known bunsh-incompatible pattern
    // in one place. Catches a future package.json edit that re-introduces
    // any of them without needing a Windows runner.
    const build = PKG.scripts.build ?? '';
    // Subshells `( ... )` — bunsh rejects when paired with redirection.
    expect(build).not.toMatch(/\([^)]*\)\s*[<>]/);
    // Multiple redirections — `cmd >a 2>b` form. Bunsh rejects ">" "2>" pairs.
    expect(build).not.toMatch(/>\s*\S+\s+2>/);
    // Bash brace groups `{ cmd; }`.
    expect(stripSingleQuoted(build)).not.toMatch(/\{\s+[^}]*;\s*\}/);
    // Process substitution `<(cmd)` and `>(cmd)`.
    expect(build).not.toMatch(/[<>]\([^)]+\)/);
  });
});
