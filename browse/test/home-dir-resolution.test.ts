/**
 * Regression test for PR #1120 — home-directory fallback.
 *
 * Background: before #1120, gstack source code constructed paths to
 * `~/.gstack/` state using `path.join(process.env.HOME || '/tmp', ...)`.
 * On Windows, `HOME` is unset by default (Windows uses `USERPROFILE`),
 * so the fallback `'/tmp'` triggered — producing literal `\tmp\.gstack\...`
 * paths that don't exist on disk. Any Windows user running gstack from
 * cmd.exe, PowerShell, or an IDE subprocess without Git Bash's env
 * inheritance hit this. #1120 replaced every occurrence with
 * `os.homedir()`, which on Node reads `USERPROFILE` on Windows and
 * `HOME` on POSIX.
 *
 * This test enforces the replacement is permanent. If a future change
 * reintroduces the `process.env.HOME || '/tmp'` pattern (or its close
 * variants) anywhere under `browse/src/` or `design/`, the test fails
 * and surfaces the exact file and line.
 *
 * Also: tests that `os.homedir()` itself returns a real path with
 * `HOME` unset — the contract the fix relies on.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── os.homedir() contract ──────────────────────────────────

describe('os.homedir() — the fix relies on this', () => {
  test('returns a real path even when HOME is unset', () => {
    const savedHome = process.env.HOME;
    delete process.env.HOME;
    try {
      const h = os.homedir();
      expect(h).toBeTruthy();
      expect(h.length).toBeGreaterThan(0);
      // Sanity-check: on Windows the path should start with a drive letter;
      // on POSIX it should start with '/'.
      if (process.platform === 'win32') {
        expect(/^[A-Z]:\\/.test(h)).toBe(true);
      } else {
        expect(h.startsWith('/')).toBe(true);
      }
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
    }
  });
});

// ─── Static regression scan ─────────────────────────────────

/**
 * Recursively collect every `.ts` file under a given directory.
 * Skips node_modules, dist, .git, and anything under a `.claude/` subdir.
 */
function tsFilesUnder(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' ||
            entry.name === '.git' || entry.name === '.claude') continue;
        stack.push(p);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        out.push(p);
      }
    }
  }
  return out;
}

describe('home-directory resolution pattern (regression for #1120)', () => {
  // Pattern we banned in #1120:
  //    process.env.HOME || '/tmp'
  //    process.env.HOME || ''
  //    process.env.HOME || "~"
  //    process.env.HOME!            (non-null assertion)
  //    process.env.HOME || process.env.USERPROFILE || '/tmp'
  // All of these evaluate wrong on Windows when HOME is unset.
  const bannedPatterns: RegExp[] = [
    /process\.env\.HOME\s*\|\|\s*['"]\/tmp['"]/,
    /process\.env\.HOME\s*\|\|\s*['"]['"]/,
    /process\.env\.HOME\s*\|\|\s*['"]~['"]/,
    /process\.env\.HOME!/,
    /process\.env\.HOME\s*\|\|\s*process\.env\.USERPROFILE/,
  ];

  test('no source file in browse/src or design/ reintroduces the banned fallback', () => {
    // Resolve from the repo root. bun test runs from the repo root by default,
    // but guard against the worktree layout just in case.
    const cwd = process.cwd();
    const roots = [
      path.join(cwd, 'browse', 'src'),
      path.join(cwd, 'design'),
    ];

    const offenders: { file: string; line: number; text: string; pattern: string }[] = [];
    for (const root of roots) {
      for (const file of tsFilesUnder(root)) {
        // Skip this very test file — it embeds the banned patterns as regex literals.
        if (file.endsWith('home-dir-resolution.test.ts')) continue;
        const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          for (const pat of bannedPatterns) {
            if (pat.test(lines[i])) {
              offenders.push({
                file: path.relative(cwd, file),
                line: i + 1,
                text: lines[i].trim(),
                pattern: pat.source,
              });
            }
          }
        }
      }
    }

    if (offenders.length > 0) {
      const report = offenders
        .map(o => `  ${o.file}:${o.line}  matches /${o.pattern}/  →  ${o.text}`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} reintroduction(s) of the #1120 banned fallback ` +
        `pattern. Use os.homedir() instead. Matches:\n${report}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
