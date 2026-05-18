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

describe('package.json build scripts — Bun shell compat (D-1460, #11124)', () => {
  // Bun's shell parser (used by `bun run <script>`) does not grok bash brace
  // groups `{ cmd; }`. This test prevents regression.
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

  // The original D-1460 fix assumed `( cmd ) > file` subshell redirects were
  // the Bun-Windows-safe form and replaced brace groups with them. They are
  // NOT: Bun's shell rejects redirections on subshells too — "Subshells with
  // redirections are currently not supported" (oven-sh/bun#11124, still open
  // on every Bun version). `bun run build` aborted at parse time on Windows
  // because setup.sh runs the build through Bun's shell. The correct fix is
  // to keep ALL command-output-to-.version redirects out of the build script
  // and stamp the files from scripts/gen-version-files.ts (no shell at all).
  test('build script has no shell redirect into a .version file', () => {
    const build = PKG.scripts.build ?? '';
    const redirects = [...build.matchAll(/(\([^)]*\)|\{[^}]*\})\s*>\s*\S+\/\.version/g)];
    expect(redirects.map((m) => m[0])).toEqual([]);
    // A bare `cmd > path/.version` (no subshell/brace) would also be fragile
    // once chained with `2>/dev/null`; nothing should redirect into .version.
    expect(/>\s*\S*\/\.version/.test(build)).toBe(false);
  });

  test('build delegates .version stamping to the gen-version-files script', () => {
    const build = PKG.scripts.build ?? '';
    expect(build).toContain('bun run scripts/gen-version-files.ts');
    expect(fs.existsSync(path.join(ROOT, 'scripts/gen-version-files.ts'))).toBe(true);
    const script = fs.readFileSync(path.join(ROOT, 'scripts/gen-version-files.ts'), 'utf-8');
    for (const t of ['browse/dist/.version', 'design/dist/.version', 'make-pdf/dist/.version']) {
      expect(script).toContain(t);
    }
  });
});
