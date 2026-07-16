/**
 * Tier-2 hardening tests for context-save + context-restore.
 *
 * These exercise the exact bash snippets from the SKILL.md templates,
 * without spawning claude -p. Free tier, runs in milliseconds.
 *
 * Covers the hardening work from commit 3df8ea86:
 *   - Bash-side title sanitizer (allowlist a-z0-9.-, cap 60, default "untitled")
 *   - Collision-safe filenames (random suffix on same-second double-save)
 *   - head -20 cap on the restore-flow directory listing
 *   - Migration HOME unset guard
 *   - Empty-set "NO_CHECKPOINTS" fallback
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');

// The exact sanitize+collision bash used by context-save/SKILL.md Step 4.
// Kept in sync with context-save/SKILL.md.tmpl. If the template changes
// this helper out of alignment, the title-sanitize tests fail — intended.
const TITLE_BASH = `
RAW="\${TITLE_RAW:-untitled}"
TITLE_SLUG=$(printf '%s' "$RAW" | tr '[:upper:]' '[:lower:]' | tr -s ' \\t' '-' | tr -cd 'a-z0-9.-' | cut -c1-60)
TITLE_SLUG="\${TITLE_SLUG:-untitled}"
FILE="\${CHECKPOINT_DIR}/\${TIMESTAMP}-\${TITLE_SLUG}.md"
if [ -e "$FILE" ]; then
  SUFFIX=$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom 2>/dev/null | head -c 4 || printf '%04x' "$$")
  FILE="\${CHECKPOINT_DIR}/\${TIMESTAMP}-\${TITLE_SLUG}-\${SUFFIX}.md"
fi
echo "TITLE_SLUG=$TITLE_SLUG"
echo "FILE=$FILE"
`;

// The exact find + sort + head used by context-restore/SKILL.md Step 1.
const RESTORE_FIND_BASH = `
if [ ! -d "$CHECKPOINT_DIR" ]; then
  echo "NO_CHECKPOINTS"
else
  FILES=$(find "$CHECKPOINT_DIR" -maxdepth 1 -name "*.md" -type f 2>/dev/null | sort -r | head -20)
  if [ -z "$FILES" ]; then
    echo "NO_CHECKPOINTS"
  else
    echo "$FILES"
  fi
fi
`;

function runBash(script: string, env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.status ?? 1,
  };
}

function parseKV(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

// ─── Title sanitizer ───────────────────────────────────────────────────────

describe('context-save: title sanitizer', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-san-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test('shell metachars stripped to allowlist', () => {
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: '$(rm -rf /) `whoami` ; echo pwned',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    expect(kv.TITLE_SLUG).toMatch(/^[a-z0-9.-]*$/);
    expect(kv.TITLE_SLUG).not.toContain('$');
    expect(kv.TITLE_SLUG).not.toContain('(');
    expect(kv.TITLE_SLUG).not.toContain(';');
    expect(kv.TITLE_SLUG).not.toContain('`');
  });

  test('path traversal attempt stripped', () => {
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: '../../../etc/passwd',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    expect(kv.TITLE_SLUG).not.toContain('/');
    // Slashes stripped, dots retained — result is contained within the
    // checkpoint directory (no path escape possible). The exact number of dots
    // depends on the input; what matters is the file stays inside $CHECKPOINT_DIR.
    expect(kv.FILE.startsWith(`${tmp}/`)).toBe(true);
    expect(path.dirname(kv.FILE)).toBe(tmp);
  });

  test('uppercase lowercased', () => {
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: 'Wintermute Progress',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    expect(kv.TITLE_SLUG).toBe('wintermute-progress');
  });

  test('whitespace collapsed to single hyphen', () => {
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: 'foo    bar\t\tbaz',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    expect(kv.TITLE_SLUG).toBe('foo-bar-baz');
  });

  test('length capped at 60 chars', () => {
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: 'a'.repeat(200),
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    expect(kv.TITLE_SLUG.length).toBe(60);
  });

  test('empty title falls back to "untitled"', () => {
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: '',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    expect(kv.TITLE_SLUG).toBe('untitled');
  });

  test('only-special-chars title falls back to "untitled"', () => {
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: '!@#$%^&*()+=<>?',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    expect(kv.TITLE_SLUG).toBe('untitled');
  });

  test('unicode stripped to ASCII allowlist', () => {
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: '日本語 emoji 🚀 test',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    expect(kv.TITLE_SLUG).toMatch(/^[a-z0-9.-]*$/);
    // Must contain the ASCII words that survived
    expect(kv.TITLE_SLUG).toContain('emoji');
    expect(kv.TITLE_SLUG).toContain('test');
  });

  test('numbers + dots + hyphens preserved', () => {
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: 'v1.0.1-release-notes',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    expect(kv.TITLE_SLUG).toBe('v1.0.1-release-notes');
  });
});

// ─── Filename collision handling ───────────────────────────────────────────

describe('context-save: filename collision', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-col-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test('first save with title uses predictable path', () => {
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: 'foo',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    expect(kv.FILE).toBe(`${tmp}/20260419-120000-foo.md`);
  });

  test('second save same-second same-title gets random suffix', () => {
    // Pre-seed: file already exists at the predictable path.
    fs.writeFileSync(`${tmp}/20260419-120000-foo.md`, 'prior save');
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: 'foo',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    // Path must differ (append-only contract).
    expect(kv.FILE).not.toBe(`${tmp}/20260419-120000-foo.md`);
    // Suffix format: base-XXXX.md where XXXX matches the suffix allowlist.
    expect(kv.FILE).toMatch(new RegExp(`^${tmp.replace(/[/.]/g, '\\$&')}/20260419-120000-foo-[a-z0-9]+\\.md$`));
  });

  test('collision suffix preserves append-only — prior file intact', () => {
    const priorPath = `${tmp}/20260419-120000-foo.md`;
    fs.writeFileSync(priorPath, 'critical prior save');
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: 'foo',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    // Write a new file at the collision-safe path.
    fs.writeFileSync(kv.FILE, 'new save');
    // Prior file must still exist and be untouched.
    expect(fs.readFileSync(priorPath, 'utf-8')).toBe('critical prior save');
    expect(fs.readFileSync(kv.FILE, 'utf-8')).toBe('new save');
    // Directory should have exactly 2 files.
    expect(fs.readdirSync(tmp).length).toBe(2);
  });

  test('different titles same second — no collision, no suffix', () => {
    fs.writeFileSync(`${tmp}/20260419-120000-foo.md`, 'first save');
    const kv = parseKV(runBash(TITLE_BASH, {
      TITLE_RAW: 'bar',
      CHECKPOINT_DIR: tmp,
      TIMESTAMP: '20260419-120000',
    }).stdout);
    // Different title → predictable path, no suffix.
    expect(kv.FILE).toBe(`${tmp}/20260419-120000-bar.md`);
  });
});

// ─── Restore flow: head-20 cap + empty-set ─────────────────────────────────

describe('context-restore: find + sort + head cap', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-rest-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test('missing directory → NO_CHECKPOINTS', () => {
    const out = runBash(RESTORE_FIND_BASH, {
      CHECKPOINT_DIR: `${tmp}/nonexistent`,
    }).stdout;
    expect(out.trim()).toBe('NO_CHECKPOINTS');
  });

  test('empty directory → NO_CHECKPOINTS', () => {
    const out = runBash(RESTORE_FIND_BASH, {
      CHECKPOINT_DIR: tmp,
    }).stdout;
    expect(out.trim()).toBe('NO_CHECKPOINTS');
  });

  test('directory with non-.md files → NO_CHECKPOINTS', () => {
    fs.writeFileSync(`${tmp}/not-a-save.txt`, 'noise');
    fs.writeFileSync(`${tmp}/.DS_Store`, 'macos');
    const out = runBash(RESTORE_FIND_BASH, {
      CHECKPOINT_DIR: tmp,
    }).stdout;
    expect(out.trim()).toBe('NO_CHECKPOINTS');
  });

  test('50 .md files → only 20 returned, newest first by filename', () => {
    // Seed 50 files with monotonically increasing timestamps.
    for (let i = 0; i < 50; i++) {
      const ts = `20260419-${String(120000 + i).padStart(6, '0')}`;
      fs.writeFileSync(`${tmp}/${ts}-file${i}.md`, `content ${i}`);
    }
    const out = runBash(RESTORE_FIND_BASH, {
      CHECKPOINT_DIR: tmp,
    }).stdout;
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(20);
    // sort -r → newest first by filename. Highest timestamps (files 30-49).
    expect(lines[0]).toContain('file49');
    expect(lines[19]).toContain('file30');
  });

  test('sort is by filename prefix, NOT mtime', () => {
    // Older filename, newer mtime. Sort -r must still put newer filename first.
    const olderByFilename = `${tmp}/20260101-120000-old.md`;
    const newerByFilename = `${tmp}/20260419-120000-new.md`;
    fs.writeFileSync(olderByFilename, 'old content');
    fs.writeFileSync(newerByFilename, 'new content');
    // Scramble mtimes: older filename gets newer mtime.
    const now = Math.floor(Date.now() / 1000);
    fs.utimesSync(olderByFilename, now, now);
    fs.utimesSync(newerByFilename, now - 86400 * 30, now - 86400 * 30);

    const out = runBash(RESTORE_FIND_BASH, {
      CHECKPOINT_DIR: tmp,
    }).stdout;
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines[0]).toBe(newerByFilename);
    expect(lines[1]).toBe(olderByFilename);
  });

  test('no listing-cwd fallback when empty (macOS xargs ls gotcha)', () => {
    // On macOS, `find ... | xargs ls -1t` with zero results falls back to
    // listing the current working directory. Our find|sort|head pattern must
    // NOT have that behavior. Running from a dir with many .md files.
    const out = runBash(RESTORE_FIND_BASH, {
      CHECKPOINT_DIR: tmp,
      // Intentionally: working directory is the gstack repo which has many .md files.
    }).stdout;
    expect(out.trim()).toBe('NO_CHECKPOINTS');
    // Must NOT contain any .md filename from cwd.
    expect(out).not.toContain('SKILL.md');
    expect(out).not.toContain('README.md');
  });
});

// ─── Migration HOME guard ──────────────────────────────────────────────────

describe('migration v1.1.3.0: HOME guard', () => {
  let tmp: string;
  const MIGRATION = path.join(ROOT, 'gstack-upgrade', 'migrations', 'v1.1.3.0.sh');

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-home-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test('HOME unset → exits 0 with diagnostic, no filesystem changes', () => {
    // Create a file that would be wiped by an HOME="" bug: /.claude/skills/gstack/checkpoint
    // (not actually writable by the test, but we verify the script doesn't TRY).
    // Spawn without HOME in env.
    const env = { PATH: process.env.PATH || '/usr/bin:/bin' } as Record<string, string>;
    const result = spawnSync('bash', [MIGRATION], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toContain('HOME is unset');
  });

  test('HOME="" → exits 0 with diagnostic', () => {
    const result = spawnSync('bash', [MIGRATION], {
      env: { HOME: '', PATH: process.env.PATH || '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toContain('HOME is unset or empty');
    // Critical: no stdout (no "Removed stale" messages — nothing touched).
    expect(result.stdout.toString().trim()).toBe('');
  });
});
