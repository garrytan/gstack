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

describe('package.json build scripts — POSIX shell compat (D-1460)', () => {
  // Bun's Windows shell parser doesn't grok bash brace groups `{ cmd; }`.
  // Subshells `( cmd )` are POSIX-universal. This test prevents regression.
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

  test('build script does version stamping (inline subshells or via bash helper)', () => {
    // PR #1460 added inline `( ... ) > .version` subshells. Later, those
    // were extracted to `scripts/stamp-versions.sh` because Bun Shell on
    // Windows didn't handle `( ... ) > file` reliably (oven-sh/bun#11066).
    // Either form is acceptable; what matters is (a) version stamping
    // happens, and (b) any inline form still uses subshell, not brace group.
    // We intentionally do a loose substring match on the helper path rather
    // than pin the exact invocation form (`bash xxx`, `bash ./xxx`,
    // `bash -e xxx`, etc.) -- pinning the form turns this into a formatting
    // contract that blocks legitimate refactors. The file-existence guard
    // catches rename/move regressions.
    const build = PKG.scripts.build ?? '';
    const inlineRedirects = [...build.matchAll(/(\([^)]*\)|\{[^}]*\})\s*>\s*\S+\/\.version/g)];
    const referencesHelper = build.includes('scripts/stamp-versions.sh');
    expect(inlineRedirects.length > 0 || referencesHelper).toBe(true);
    for (const m of inlineRedirects) {
      expect(m[1].startsWith('(')).toBe(true);
    }
    if (referencesHelper) {
      expect(fs.existsSync(path.join(ROOT, 'scripts/stamp-versions.sh'))).toBe(true);
    }
  });
});
