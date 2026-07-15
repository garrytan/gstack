/**
 * Regression tests for issue #2091 — `/codex` temp-file creation fails on macOS
 * (BSD mktemp). Diagnosed by Scott Hardin.
 *
 * Two compounding bugs, both in gstack:
 *
 *   1. Suffix after the placeholder. The codex skill used templates like
 *      `mktemp "$TMP_ROOT/codex-err-XXXXXX.txt"`. GNU mktemp tolerates a suffix
 *      after the X run; BSD mktemp (macOS) does NOT — it does not substitute the
 *      X's at all, so call #1 creates a LITERAL `codex-err-XXXXXX.txt` (exit 0)
 *      and a later call (a second /codex run, a stale leftover, or a concurrent
 *      worktree) fails with `mkstemp failed: File exists` and aborts the review.
 *      Fixed by moving the placeholder to the END of every codex mktemp template.
 *
 *   2. Trailing slash in TMP_ROOT. `bin/gstack-paths` emitted TMP_ROOT straight
 *      from $TMPDIR, which on macOS ends in `/` (e.g. /var/folders/.../T/),
 *      producing a double-slash path (`…/T//codex-err-…`). Fixed by stripping
 *      the trailing slash at the source so every consumer benefits, not just
 *      /codex.
 *
 * Both bugs are independent; these static + runtime checks pin each one so
 * template drift can't silently re-introduce them.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const PATHS_BIN = path.join(ROOT, 'bin', 'gstack-paths');

// ── Bug 1: BSD mktemp requires the X placeholder at the END of the template ──
// Asserted across both the .tmpl source and the generated SKILL.md so a regen
// drift (or a hand-edit of one but not the other) can't reopen the bug.
describe('#2091 bug 1: codex mktemp templates are BSD-safe (X placeholder at end)', () => {
  for (const relPath of ['codex/SKILL.md.tmpl', 'codex/SKILL.md']) {
    test(`${relPath}: no codex mktemp template has a suffix after XXXXXX`, () => {
      const content = fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
      // Every quoted mktemp template that targets a codex temp file.
      const templates = [...content.matchAll(/mktemp\s+"([^"]*codex-[^"]*)"/g)].map(m => m[1]);
      // Sanity: the templates still exist (guards against the regex silently
      // matching nothing after a future refactor, which would pass vacuously).
      expect(templates.length).toBeGreaterThan(0);
      // BSD mktemp only substitutes a run of X's that is the LAST thing in the
      // template. Anything after the final X (e.g. `.txt`) is the bug.
      const offenders = templates.filter(t => !/X{6,}$/.test(t));
      expect(offenders).toEqual([]);
    });
  }
});

// ── Bug 2: gstack-paths normalizes TMP_ROOT (no trailing slash) ──────────────
// Mirrors the invocation contract used by test/gstack-paths.test.ts: the helper
// is always sourced from a bash block, so we run it via `bash`.
function tmpRoot(env: Record<string, string | undefined>): string {
  const result = spawnSync('bash', [PATHS_BIN], {
    env: { PATH: process.env.PATH, USERPROFILE: '', ...env } as Record<string, string>,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`gstack-paths failed (status ${result.status}): ${result.stderr}`);
  }
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('TMP_ROOT=')) return line.slice('TMP_ROOT='.length);
  }
  throw new Error('gstack-paths did not emit TMP_ROOT');
}

describe('#2091 bug 2: gstack-paths strips the trailing slash from TMP_ROOT', () => {
  test('macOS-style TMPDIR with trailing slash → trailing slash stripped', () => {
    expect(tmpRoot({ TMPDIR: '/var/folders/ab/T/', HOME: '/tmp/h' })).toBe('/var/folders/ab/T');
  });

  test('TMP (Windows/container fallback) with trailing slash is also normalized', () => {
    expect(tmpRoot({ TMP: '/tmp/y/', HOME: '/tmp/h' })).toBe('/tmp/y');
  });

  test('a path without a trailing slash is left unchanged', () => {
    expect(tmpRoot({ TMPDIR: '/tmp/x', HOME: '/tmp/h' })).toBe('/tmp/x');
  });

  test('a bare "/" does not collapse to empty', () => {
    expect(tmpRoot({ TMPDIR: '/', HOME: '/tmp/h' })).toBe('/');
  });
});
