import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SCRIPT = path.join(ROOT, 'setup');
const SETUP_SRC = fs.readFileSync(SETUP_SCRIPT, 'utf-8');

// Slice out the _link_or_copy helper body via awk-style anchors so the test is
// resilient to line-number drift.
function extractHelper(): string {
  const start = SETUP_SRC.indexOf('_link_or_copy() {');
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('Could not locate _link_or_copy() in setup');
  return SETUP_SRC.slice(start, end + 2);
}

describe('setup: _link_or_copy invariant (D7)', () => {
  test('helper function is defined near the top of setup', () => {
    expect(SETUP_SRC).toContain('_link_or_copy() {');
    expect(SETUP_SRC).toContain('if [ "$IS_WINDOWS" -eq 1 ]; then');
  });

  test('zero raw `ln` calls outside the helper body and comments', () => {
    // Pull the helper body out of the source first so its internal `ln -snf`
    // (the Unix branch) is exempted from the invariant.
    const helper = extractHelper();
    const withoutHelper = SETUP_SRC.replace(helper, '');

    // Strip shell comments to allow prose mentions of `ln -snf` in docstrings.
    const lines = withoutHelper.split('\n');
    const offending: { lineNo: number; line: string }[] = [];
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) return;
      // Match standalone `ln ` invocations (allow `ln` as a substring in
      // variable names like `linked`, `_LINK`).
      if (/(^|[\s;&|`])ln\s+-/.test(line)) {
        offending.push({ lineNo: idx + 1, line: line.trim() });
      }
    });
    expect(offending).toEqual([]);
  });

  test('Windows-copy note message exists in setup', () => {
    expect(SETUP_SRC).toContain('Windows install uses file copies');
    expect(SETUP_SRC).toContain('_print_windows_copy_note_once');
  });

  test('link_claude_skill_dirs calls the Windows note printer', () => {
    const fnStart = SETUP_SRC.indexOf('link_claude_skill_dirs() {');
    const fnEnd = SETUP_SRC.indexOf('\n}\n', fnStart);
    const fnBody = SETUP_SRC.slice(fnStart, fnEnd);
    expect(fnBody).toContain('_print_windows_copy_note_once');
  });
});

// Behavior matrix uses Unix `ln -snf` semantics in the IS_WINDOWS=0 cells.
// On Windows-without-Developer-Mode (e.g. GitHub's free `windows-latest`
// runner), `ln -snf` silently produces a file copy rather than a symlink —
// that's literally the bug this helper exists to work around. Skip the whole
// matrix on Windows; the static-invariant tests above already pin the helper
// shape that the Windows install relies on.
describe.skipIf(process.platform === 'win32')('setup: _link_or_copy helper — behavior matrix', () => {
  // Source the helper into a temp shell with IS_WINDOWS set and exercise
  // each cell of the file/dir × Windows/Unix matrix.
  function runHelper(
    isWindows: '0' | '1',
    srcKind: 'file' | 'dir',
  ): { ok: boolean; targetIsSymlink: boolean; targetExists: boolean; stderr: string } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-helper-'));
    try {
      const src = path.join(tmp, 'source');
      const dst = path.join(tmp, 'dest');
      if (srcKind === 'file') {
        fs.writeFileSync(src, 'hello\n');
      } else {
        fs.mkdirSync(src);
        fs.writeFileSync(path.join(src, 'inner.txt'), 'hello\n');
      }
      const helper = extractHelper();
      // IS_WINDOWS must exist as a shell-readable var before sourcing.
      const script = `IS_WINDOWS=${isWindows}\n${helper}\n_link_or_copy "${src}" "${dst}"\n`;
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const lst = fs.lstatSync(dst, { throwIfNoEntry: false });
      return {
        ok: result.status === 0,
        targetIsSymlink: lst?.isSymbolicLink() ?? false,
        targetExists: lst !== undefined,
        stderr: result.stderr,
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  test('IS_WINDOWS=0 + file → symlink (existing Unix behavior)', () => {
    const r = runHelper('0', 'file');
    expect(r.ok).toBe(true);
    expect(r.targetExists).toBe(true);
    expect(r.targetIsSymlink).toBe(true);
  });

  test('IS_WINDOWS=0 + dir → symlink', () => {
    const r = runHelper('0', 'dir');
    expect(r.ok).toBe(true);
    expect(r.targetIsSymlink).toBe(true);
  });

  test('IS_WINDOWS=1 + file → regular file copy (no symlink)', () => {
    const r = runHelper('1', 'file');
    expect(r.ok).toBe(true);
    expect(r.targetExists).toBe(true);
    expect(r.targetIsSymlink).toBe(false);
  });

  test('IS_WINDOWS=1 + dir → real directory copy', () => {
    const r = runHelper('1', 'dir');
    expect(r.ok).toBe(true);
    expect(r.targetExists).toBe(true);
    expect(r.targetIsSymlink).toBe(false);
  });
});
