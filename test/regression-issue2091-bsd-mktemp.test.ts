/**
 * Regression tests for issue #2091 / #2370 — mktemp templates fail on macOS
 * (BSD mktemp) and Alpine (busybox mktemp) when the X placeholder run is not
 * the LAST thing in the template.
 *
 * Two compounding bugs, both in gstack:
 *
 *   1. Suffix after the placeholder. Skills used templates like
 *      `mktemp "$TMP_ROOT/codex-err-XXXXXX.txt"`. GNU mktemp tolerates a suffix
 *      after the X run; BSD mktemp (macOS) does NOT — it does not substitute the
 *      X's at all, so call #1 creates a LITERAL `codex-err-XXXXXX.txt` (exit 0)
 *      and a later call (a second /codex run, a stale leftover, or a concurrent
 *      worktree) fails with `mkstemp failed: File exists` and aborts the review.
 *      busybox mktemp (Alpine) rejects the template outright on the FIRST run.
 *      Fixed by moving the placeholder to the END of every mktemp template.
 *
 *   2. Trailing slash in TMP_ROOT. `bin/gstack-paths` emitted TMP_ROOT straight
 *      from $TMPDIR, which on macOS ends in `/` (e.g. /var/folders/.../T/),
 *      producing a double-slash path (`…/T//codex-err-…`). Fixed by stripping
 *      the trailing slash at the source so every consumer benefits, not just
 *      /codex.
 *
 * Bug 1's tripwire is repo-wide: it sweeps EVERY .tmpl, every SKILL.md, and
 * every scripts/resolvers/*.ts (the sources that feed generated skills), so a
 * new skill can't re-introduce the suffix shape anywhere.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const PATHS_BIN = path.join(ROOT, 'bin', 'gstack-paths');

// ── Bug 1: BSD mktemp requires the X placeholder at the END of the template ──
// Swept across all skills (templates AND generated output) plus the resolver
// modules that feed generated sections, so neither a hand-edit nor a regen
// drift can reopen the bug.

/** Directories that are not gstack-authored skill/template sources. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.claude',
  '.agents',
  '.factory',
  'fixtures', // test/fixtures — goldens snapshot generated output separately
]);

function collectScannedFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    // Symlinks (e.g. connect-chrome → open-gstack-browser) would double-count
    // or escape the tree; the link target is scanned via its real path.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      collectScannedFiles(full, out);
    } else if (
      entry.name === 'SKILL.md' ||
      entry.name.endsWith('.tmpl') ||
      (full.includes(path.join('scripts', 'resolvers')) && entry.name.endsWith('.ts'))
    ) {
      out.push(full);
    }
  }
}

/**
 * Extract every mktemp template token on a line and return the ones whose
 * X-run (4+ X's) is NOT the final character run. Tokens are whitespace-split
 * words after `mktemp`, stripped of shell/TS quoting and closers, so
 * `$(mktemp "$TMP_ROOT/codex-err-XXXXXX.txt")` yields the offending
 * `$TMP_ROOT/codex-err-XXXXXX.txt`.
 */
function offendingTemplatesOnLine(line: string): string[] {
  const idx = line.indexOf('mktemp');
  if (idx === -1) return [];
  const offenders: string[] = [];
  for (const raw of line.slice(idx).split(/\s+/)) {
    const token = raw.replace(/^["'(`]+|[)"'`;,\\}]+$/g, '');
    if (!/X{4,}/.test(token)) continue;
    if (!/X{4,}$/.test(token)) offenders.push(token);
  }
  return offenders;
}

describe('#2091/#2370 bug 1: every mktemp template is BSD-safe (X placeholder at end)', () => {
  const files: string[] = [];
  collectScannedFiles(ROOT, files);

  test('scan sweep finds the known mktemp call sites (not vacuous)', () => {
    // Guards against the walker silently matching nothing after a refactor.
    // codex's mktemp calls live in the carved mode sections (T9), not the
    // skeleton — the walker scans their .tmpl sources.
    const withMktemp = files.filter((f) => fs.readFileSync(f, 'utf-8').includes('mktemp'));
    expect(withMktemp.length).toBeGreaterThanOrEqual(5);
    expect(withMktemp).toContain(path.join(ROOT, 'codex', 'sections', 'review-mode.md.tmpl'));
    expect(withMktemp).toContain(path.join(ROOT, 'codex', 'sections', 'consult-mode.md.tmpl'));
    expect(withMktemp).toContain(path.join(ROOT, 'scripts', 'resolvers', 'review.ts'));
  });

  test('no .tmpl, SKILL.md, or resolver carries a suffix after the X-run', () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        for (const token of offendingTemplatesOnLine(line)) {
          violations.push(`${path.relative(ROOT, file)}:${i + 1} — ${token}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  test('the offender-detector itself still detects the original bug shapes', () => {
    // Self-test so a regex tweak can't quietly blind the tripwire.
    expect(offendingTemplatesOnLine('TMPERR=$(mktemp "$TMP_ROOT/codex-err-XXXXXX.txt")')).toEqual([
      '$TMP_ROOT/codex-err-XXXXXX.txt',
    ]);
    expect(
      offendingTemplatesOnLine('TMPOUT=$(mktemp "$GSTACK_HOME/developer-profile.json.XXXXXX.tmp")'),
    ).toEqual(['$GSTACK_HOME/developer-profile.json.XXXXXX.tmp']);
    expect(offendingTemplatesOnLine('RESP_FILE=$(mktemp /tmp/gstack-claude-response-XXXXXX.json)')).toEqual([
      '/tmp/gstack-claude-response-XXXXXX.json',
    ]);
    // Fixed shapes pass.
    expect(offendingTemplatesOnLine('TMPERR=$(mktemp "$TMP_ROOT/codex-err-XXXXXX")')).toEqual([]);
    expect(offendingTemplatesOnLine('ALL_JSONL=$(mktemp -t autoplan-tasks.XXXXXXXX)')).toEqual([]);
  });
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
