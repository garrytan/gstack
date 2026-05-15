import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>;
};

// Strip single-quoted strings so JS code emitted as `echo '{ ... }'` doesn't
// trip the shell-brace-group check. Conservative: only `'...'` segments.
function stripSingleQuoted(s: string): string {
  return s.replace(/'[^']*'/g, "''");
}

describe('package.json build scripts — Bun shell compat (D-1460)', () => {
  // Bun's Windows shell parser rejects several patterns that are POSIX-valid:
  //   - bash brace groups: `{ cmd; }`
  //   - subshells with redirection: `( cmd ) > file`
  //   - multiple redirections on one command: `cmd 2>/dev/null > file`
  // The safe approach is to keep these out of npm scripts entirely and
  // delegate to bash scripts when needed. See scripts/write-versions.sh.

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

  test('no subshell-with-redirection patterns in any npm script', () => {
    // `( cmd ) > file` parses on POSIX shells but throws on Bun shell (Windows):
    //   error: Subshells with redirections are currently not supported.
    const offending: { script: string; pattern: string }[] = [];
    for (const [name, body] of Object.entries(PKG.scripts)) {
      const stripped = stripSingleQuoted(body);
      const match = stripped.match(/\([^)]*\)\s*[12]?>/);
      if (match) {
        offending.push({ script: name, pattern: match[0] });
      }
    }
    expect(offending).toEqual([]);
  });

  test('no command with both stderr-suppress and stdout-redirect on one line', () => {
    // `cmd 2>/dev/null > file` parses on POSIX shells but throws on Bun shell:
    //   error: expected a command or assignment but got: "Redirect"
    const offending: { script: string; pattern: string }[] = [];
    for (const [name, body] of Object.entries(PKG.scripts)) {
      const stripped = stripSingleQuoted(body);
      const dualRedirect = stripped.match(/\d>\S+\s+>\s*\S+|>\s*\S+\s+\d>\S+/);
      if (dualRedirect) {
        offending.push({ script: name, pattern: dualRedirect[0] });
      }
    }
    expect(offending).toEqual([]);
  });

  test('.version writes are delegated to a bash script (not inline)', () => {
    // .version writing must NOT be inlined into the build script — every
    // safe inline form requires a Bun-shell-hostile pattern. It must go
    // through scripts/write-versions.sh instead.
    const build = PKG.scripts.build ?? '';
    expect(build).not.toMatch(/>\s*\S*\/\.version/);
    expect(build).toContain('bash scripts/write-versions.sh');
    expect(fs.existsSync(path.join(ROOT, 'scripts/write-versions.sh'))).toBe(true);
  });
});
