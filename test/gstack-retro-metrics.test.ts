/**
 * Contract + behavior tests for bin/gstack-retro-metrics (retro
 * token-reduction wave — the inline git/awk pipelines from retro/SKILL.md
 * Steps 0.5-9 and 11, consolidated into one script).
 *
 * Three layers:
 *  1. CONTRACT — every labeled `KEY:` line the rendered retro prose
 *     interprets must be emitted (hermetic temp HOME + GSTACK_HOME, synthetic
 *     git repo fixture with pinned author AND committer dates).
 *  2. BEHAVIOR — deterministic values on the fixture: commit/type/session
 *     counts, streak anchoring, window --until, local-branch fallback,
 *     AI-trailer vs human co-author split, VERSION range, aux-file presence.
 *  3. EDGES — a 1-commit repo and a non-repo dir both survive (exit 0, no
 *     dropped lines); the skill fence shape stays pinned in the template.
 *
 * All hermetic: HOME + GSTACK_HOME point at throwaway temp dirs; the script
 * runs from the live worktree bin/ (the subject under test).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'bin', 'gstack-retro-metrics');

let tmpHome: string;
let tmpGstackHome: string;
let repoDir: string;

function hermeticEnv(): Record<string, string> {
  return { PATH: process.env.PATH!, HOME: tmpHome, GSTACK_HOME: tmpGstackHome };
}

function runMetrics(args: string[], cwd: string = repoDir): string {
  return execFileSync(SCRIPT, args, { encoding: 'utf-8', cwd, env: hermeticEnv() });
}

/** Commit with pinned author AND committer dates (guard + --until read %ci). */
function commit(dir: string, msg: string, date: string, author?: { name: string; email: string }): void {
  const env: Record<string, string> = {
    ...hermeticEnv(),
    GIT_COMMITTER_DATE: date,
    ...(author ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email } : {}),
  };
  const r = spawnSync('git', ['commit', '-m', msg, '--date', date], {
    cwd: dir, stdio: 'pipe', timeout: 10_000, env,
  });
  if (r.status !== 0) throw new Error(`fixture commit failed: ${r.stderr}`);
}

function git(dir: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd: dir, stdio: 'pipe', timeout: 10_000, env: hermeticEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function write(dir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', file]);
}

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rm-home-'));
  tmpGstackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rm-gh-'));
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rm-repo-'));

  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'dev@example.com']);
  git(repoDir, ['config', 'user.name', 'Dev']);

  // Day 1 — one 20-minute session (2 commits) + one solo commit later.
  write(repoDir, 'app.ts', 'console.log("hello");\n');
  commit(repoDir, 'feat: initial app', '2026-03-10T09:00:00');
  write(repoDir, 'auth.ts', 'export function login() {}\n');
  commit(repoDir, 'feat: add auth (#12)', '2026-03-10T09:20:00');
  write(repoDir, 'foo.test.ts', 'test("login", () => {});\n');
  commit(repoDir, 'test(qa): add regression test', '2026-03-10T11:00:00');

  // Day 2 — 5-minute session; first commit carries an AI trailer AND a human
  // co-author trailer.
  write(repoDir, 'app.ts', '// wire auth\nimport "./auth";\nconsole.log("hello");\n');
  commit(
    repoDir,
    'fix: wire auth\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\nCo-Authored-By: Alice Smith <alice@example.com>',
    '2026-03-11T10:00:00',
  );
  write(repoDir, 'VERSION', '1.0.0.0\n');
  commit(repoDir, 'chore: add VERSION', '2026-03-11T10:05:00');

  // Day 3 — a second author bumps VERSION (contributors=2, team streak=3).
  write(repoDir, 'VERSION', '1.1.0.0\n');
  commit(repoDir, 'chore: bump VERSION', '2026-03-12T09:30:00', { name: 'Bob', email: 'bob@example.com' });
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpGstackHome, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

/** Labeled keys the rendered retro prose interprets (Steps 1-11). */
const REQUIRED_KEYS = [
  'RETRO_METRICS_PROTO',
  'GUARD_REMOTE',
  'GUARD_HEAD',
  'RETRO_REF',
  'GUARD_LATEST_COMMIT',
  'WINDOW_SINCE',
  'WINDOW_UNTIL',
  'USER_NAME',
  'USER_EMAIL',
  'COMMIT',
  'COMMITS',
  'MERGE_COMMITS',
  'CONTRIBUTORS',
  'INSERTIONS',
  'DELETIONS',
  'NET_LOC',
  'TEST_INSERTIONS',
  'TEST_RATIO',
  'WEIGHTED_COMMITS',
  'ACTIVE_DAYS',
  'TEST_FILES_CHANGED',
  'SESSIONS',
  'DEEP_SESSIONS',
  'MEDIUM_SESSIONS',
  'MICRO_SESSIONS',
  'TOTAL_ACTIVE_MINUTES',
  'AVG_SESSION_MINUTES',
  'LOC_PER_SESSION_HOUR',
  'COMMIT_TYPES',
  'FIX_RATIO',
  'COMMIT_SIZE_BUCKETS',
  'HOURS',
  'PEAK_HOUR',
  'FOCUS_SCORE',
  'BIGGEST_COMMIT',
  'HOTSPOT',
  'AUTHOR',
  'AUTHOR_BIGGEST',
  'WEEK',
  'COAUTHOR',
  'AI_ASSISTED_COMMITS',
  'LOGICAL_SLOC_ADDED',
  'PRS_REFERENCED',
  'PR_REFS',
  'TEST_FILES_TOTAL',
  'REGRESSION_TEST_COMMITS',
  'REGRESSION_COMMIT',
  'VERSION_RANGE',
  'TEAM_STREAK',
  'USER_STREAK',
  'RETRO_CONTEXT',
  'GREPTILE_HISTORY',
  'TODOS_FILE',
  'SKILL_USAGE_LOG',
  'EUREKA_LOG',
  'RETRO_METRICS_END',
] as const;

describe('gstack-retro-metrics contract', () => {
  test('emits every labeled key the retro prose interprets', () => {
    const out = runMetrics(['--base', 'main', '--since', '2026-03-09T00:00:00']);
    const missing = REQUIRED_KEYS.filter((k) => !new RegExp(`^${k}: `, 'm').test(out));
    expect(missing, `Script stopped emitting: ${missing.join(', ')} — the prose contract broke`).toEqual([]);
  });

  test('proto handshake is the FIRST line', () => {
    const out = runMetrics(['--base', 'main', '--since', '2026-03-09T00:00:00']);
    expect(out.split('\n')[0]).toBe('RETRO_METRICS_PROTO: 1');
  });

  test('the skill fence invokes the script with primary path + degraded fallback', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md.tmpl'), 'utf-8');
    expect(tmpl).toContain('$HOME/.claude/skills/gstack/bin/gstack-retro-metrics');
    expect(tmpl).toContain('".claude/skills/gstack/bin/gstack-retro-metrics"');
    expect(tmpl).toContain('--base "<default>" --since "<since>"');
    expect(tmpl).toContain(
      'RETRO_METRICS: unavailable — stale install (compute metrics manually from the steps below)',
    );
    // Degraded-mode prose keys off the proto handshake.
    expect(tmpl).toContain('RETRO_METRICS_PROTO: 1');
  });

  test('script is executable', () => {
    expect(fs.statSync(SCRIPT).mode & 0o111).toBeTruthy();
  });
});

describe('gstack-retro-metrics behavior', () => {
  test('deterministic aggregates on the fixture', () => {
    const out = runMetrics(['--base', 'main', '--since', '2026-03-09T00:00:00']);
    expect(out).toMatch(/^COMMITS: 6$/m);
    expect(out).toMatch(/^CONTRIBUTORS: 2$/m);
    expect(out).toMatch(/^ACTIVE_DAYS: 3$/m);
    // No origin remote: guard discloses, ref falls back to the local branch.
    expect(out).toMatch(/^GUARD_REMOTE: none$/m);
    expect(out).toMatch(/^GUARD_HEAD: main$/m);
    expect(out).toMatch(/^RETRO_REF: main$/m);
    expect(out).toMatch(/^GUARD_LATEST_COMMIT: 2026-03-12$/m);
    // Conventional-commit mix (feat 2, fix 1, test 1, chore 2).
    const types = out.match(/^COMMIT_TYPES: (.*)$/m)![1];
    expect(types).toContain('feat=2');
    expect(types).toContain('fix=1');
    expect(types).toContain('test=1');
    expect(types).toContain('chore=2');
    // Session detection: [09:00,09:20]=medium, [11:00]=micro, [10:00,10:05]=micro, [09:30]=micro.
    expect(out).toMatch(/^SESSIONS: 4$/m);
    expect(out).toMatch(/^MEDIUM_SESSIONS: 1$/m);
    expect(out).toMatch(/^MICRO_SESSIONS: 3$/m);
    expect(out).toMatch(/^DEEP_SESSIONS: 0$/m);
    expect(out).toMatch(/^TOTAL_ACTIVE_MINUTES: 25$/m);
    // Test health.
    expect(out).toMatch(/^TEST_FILES_TOTAL: 1$/m);
    expect(out).toMatch(/^TEST_FILES_CHANGED: 1$/m);
    expect(out).toMatch(/^REGRESSION_TEST_COMMITS: 1$/m);
    expect(out).toMatch(/^REGRESSION_COMMIT: \w+ test\(qa\): add regression test$/m);
    // PR refs from subjects.
    expect(out).toMatch(/^PRS_REFERENCED: 1$/m);
    expect(out).toMatch(/^PR_REFS: #12$/m);
    // AI trailer counted separately from the human co-author credit.
    expect(out).toMatch(/^AI_ASSISTED_COMMITS: 1$/m);
    expect(out).toMatch(/^COAUTHOR: \w+\|Alice Smith <alice@example\.com>$/m);
    expect(out).not.toMatch(/^COAUTHOR: .*anthropic\.com/m);
    // VERSION range across the window.
    expect(out).toMatch(/^VERSION_RANGE: v1\.0\.0\.0 → v1\.1\.0\.0$/m);
    // Streaks anchored at the newest commit date, never the wall clock.
    expect(out).toMatch(/^TEAM_STREAK: 3 days \(anchor 2026-03-12\)$/m);
    expect(out).toMatch(/^USER_STREAK: 2 days \(anchor 2026-03-11\)$/m);
    // Hour histogram carries the fixture's commit hours.
    const hours = out.match(/^HOURS: (.*)$/m)![1];
    expect(hours).toContain('09=');
    expect(hours).toContain('10=');
  });

  test('--until bounds the window (compare mode prior window)', () => {
    const out = runMetrics([
      '--base', 'main',
      '--since', '2026-03-09T00:00:00',
      '--until', '2026-03-11T00:00:00',
    ]);
    expect(out).toMatch(/^COMMITS: 3$/m);
    expect(out).toMatch(/^ACTIVE_DAYS: 1$/m);
    expect(out).toMatch(/^WINDOW_UNTIL: 2026-03-11T00:00:00$/m);
  });

  test('aux inputs report present when the files exist under GSTACK_HOME', () => {
    fs.writeFileSync(path.join(tmpGstackHome, 'greptile-history.md'), '# history\n');
    fs.mkdirSync(path.join(tmpGstackHome, 'analytics'), { recursive: true });
    fs.writeFileSync(path.join(tmpGstackHome, 'analytics', 'skill-usage.jsonl'), '{}\n');
    try {
      const out = runMetrics(['--base', 'main', '--since', '2026-03-09T00:00:00']);
      expect(out).toMatch(/^GREPTILE_HISTORY: present /m);
      expect(out).toMatch(/^SKILL_USAGE_LOG: present /m);
      expect(out).toMatch(/^RETRO_CONTEXT: absent$/m);
      expect(out).toMatch(/^EUREKA_LOG: absent$/m);
    } finally {
      fs.rmSync(path.join(tmpGstackHome, 'greptile-history.md'), { force: true });
      fs.rmSync(path.join(tmpGstackHome, 'analytics'), { recursive: true, force: true });
    }
  });

  test('zero-commit window still emits the full labeled surface', () => {
    const out = runMetrics([
      '--base', 'main',
      '--since', '2020-01-01T00:00:00',
      '--until', '2020-01-08T00:00:00',
    ]);
    expect(out).toMatch(/^COMMITS: 0$/m);
    expect(out).toMatch(/^SESSIONS: 0$/m);
    expect(out).toMatch(/^RETRO_METRICS_END: ok$/m);
  });
});

describe('gstack-retro-metrics edges', () => {
  test('survives a repo with exactly 1 commit', () => {
    const oneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rm-one-'));
    try {
      git(oneDir, ['init', '-b', 'main']);
      git(oneDir, ['config', 'user.email', 'solo@example.com']);
      git(oneDir, ['config', 'user.name', 'Solo']);
      write(oneDir, 'a.txt', 'hi\n');
      commit(oneDir, 'feat: first', '2026-03-10T09:00:00');
      const out = runMetrics(['--base', 'main', '--since', '2026-03-09T00:00:00'], oneDir);
      expect(out).toMatch(/^COMMITS: 1$/m);
      expect(out).toMatch(/^CONTRIBUTORS: 1$/m);
      expect(out).toMatch(/^SESSIONS: 1$/m);
      expect(out).toMatch(/^MICRO_SESSIONS: 1$/m);
      expect(out).toMatch(/^TEAM_STREAK: 1 days \(anchor 2026-03-10\)$/m);
      expect(out).toMatch(/^BIGGEST_COMMIT: \w+\|1\|Solo\|feat: first$/m);
      expect(out).toMatch(/^RETRO_METRICS_END: ok$/m);
    } finally {
      fs.rmSync(oneDir, { recursive: true, force: true });
    }
  });

  test('non-repo dir reports RETRO_METRICS_ERROR and exits 0', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rm-empty-'));
    try {
      const out = runMetrics(['--since', '7 days ago'], emptyDir);
      expect(out).toContain('RETRO_METRICS_PROTO: 1');
      expect(out).toContain('RETRO_METRICS_ERROR: not inside a git repository');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('local reads only: no network git ops or curl anywhere in the script', () => {
    const script = fs.readFileSync(SCRIPT, 'utf-8');
    expect(script).not.toMatch(/(^|[;|&`($!]|\s)git(\s+-C\s+\S+)?\s+(push|pull|fetch|clone|ls-remote)\b/m);
    expect(script).not.toMatch(/(^|[|&;(`]|\s|\$\()curl\s/);
  });
});
