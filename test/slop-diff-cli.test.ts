/**
 * scripts/slop-diff.ts — new-findings-only slop report, run on every /review
 * and quality gate.
 *
 * Isolation: every git call in the script inherits the child's cwd (no
 * explicit cwd is passed to spawnSync), so pointing the CLI at a tiny fixture
 * repo is just `cwd: fixtureRepo`. The `npx slop-scan` dependency is stubbed
 * with a PATH-prepended fake so no test ever downloads or runs the real
 * scanner — the stub also makes the "scanner missing", "invalid JSON", and
 * "real findings" paths deterministic.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBin } from './helpers/run-bin';

const ROOT = path.resolve(import.meta.dir, '..');
const SLOP_DIFF = path.join(ROOT, 'scripts', 'slop-diff.ts');

let repo: string;
let stubDir: string;

function git(...args: string[]): void {
  const result = runBin('git', args, { cwd: repo });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

// POSIX-only on purpose: the npx stub is a shebang script, and Windows
// CreateProcess cannot exec shebangs (a PATH `npx` without .cmd would fall
// through to the REAL npx and try to download slop-scan). The quoted
// '/bin/bash' below is what the Windows-fragile content scanner in
// scripts/test-free-shards.ts keys on to exclude this file from the
// windows-safe subset.
const BASH = '/bin/bash';

/** Install a fake `npx` first on PATH. Body is a bash script fragment. */
function stubNpx(body: string): void {
  fs.writeFileSync(path.join(stubDir, 'npx'), `#!${BASH}\n${body}\n`, { mode: 0o755 });
}

function runSlopDiff(...args: string[]) {
  return runBin('bun', [SLOP_DIFF, ...args], {
    cwd: repo,
    env: { PATH: `${stubDir}:${process.env.PATH}` },
    // Two scans + a worktree add/remove; generous but bounded.
    timeoutMs: 90_000,
  });
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-diff-repo-'));
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-diff-npx-'));
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'initial');
  // A default stub so no test path can ever reach a real npx/network.
  stubNpx('exit 1');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(stubDir, { recursive: true, force: true });
});

/** Commit a changed file on a feature branch so `main...HEAD` is non-empty. */
function commitFeatureChange(): void {
  git('checkout', '-q', '-b', 'feature');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const x = 1;\n');
  git('add', 'src/app.ts');
  git('commit', '-q', '-m', 'feature change');
}

describe('slop:diff CLI (scripts/slop-diff.ts)', () => {
  test('no changes vs the base branch: exits 0 without ever invoking the scanner', () => {
    // HEAD == main → empty diff → early exit before any npx call. The stub
    // exits 1, so if the scanner were invoked the output would differ.
    const result = runSlopDiff();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No files changed vs main');
    expect(result.stdout).toContain('nothing to check');
  });

  test('missing slop-scan (npx produces no output): graceful message, exit 0', () => {
    commitFeatureChange();
    // Default stub: exit 1, no stdout → the script's fallback path.
    const result = runSlopDiff();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('slop-scan not available');
    expect(result.stdout).toContain('npm i -g slop-scan');
  });

  test('scanner emitting invalid JSON: graceful message, exit 0', () => {
    commitFeatureChange();
    stubNpx('echo "this is not json"');
    const result = runSlopDiff();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('slop-scan returned invalid JSON');
  });

  test('reports only NEW findings in changed files, diffed against the merge-base scan', () => {
    commitFeatureChange();
    // The stub is invoked twice: `npx slop-scan scan . --json` for HEAD and
    // `npx slop-scan scan <tmp-worktree> --json` for the merge-base. Branch on
    // the scan target ($3): HEAD gets one finding in the changed file plus one
    // in an UNCHANGED file (which must be filtered out); the base gets none.
    stubNpx([
      'if [ "$3" = "." ]; then',
      `  echo '{"findings":[`
        + `{"ruleId":"empty-catch","path":"src/app.ts","evidence":["line 3: empty catch, boundary=none"]},`
        + `{"ruleId":"empty-catch","path":"README.md","evidence":["line 1: empty catch, boundary=none"]}`
        + `]}'`,
      'else',
      '  echo \'{"findings":[]}\'',
      'fi',
    ].join('\n'));

    const result = runSlopDiff();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 new findings');
    expect(result.stdout).toContain('src/app.ts');
    expect(result.stdout).toContain('empty-catch');
    expect(result.stdout).toContain('line 3: empty catch, boundary=none');
    // README.md was not part of the branch diff — its finding is not "new".
    expect(result.stdout).not.toContain('README.md');
    expect(result.stdout).toContain('Net: +1 new, -0 removed');
  });

  test('a finding present at the merge-base is not new, even when line numbers shift', () => {
    commitFeatureChange();
    // Same (rule, file, evidence-modulo-line-number) on both sides: HEAD says
    // line 42, base says line 3 — the line-number-insensitive fingerprint must
    // treat them as the same finding.
    stubNpx([
      'if [ "$3" = "." ]; then',
      '  echo \'{"findings":[{"ruleId":"empty-catch","path":"src/app.ts","evidence":["line 42: empty catch, boundary=none"]}]}\'',
      'else',
      // The base scan sees worktree-absolute paths; the script remaps them by
      // stripping the worktree prefix, so emit the path under the scan target.
      '  echo "{\\"findings\\":[{\\"ruleId\\":\\"empty-catch\\",\\"path\\":\\"$3/src/app.ts\\",\\"evidence\\":[\\"line 3: empty catch, boundary=none\\"]}]}"',
      'fi',
    ].join('\n'));

    const result = runSlopDiff();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no new findings');
  });

  test('an explicit base argument overrides main', () => {
    // Diff feature...feature is empty even though feature differs from main.
    commitFeatureChange();
    const result = runSlopDiff('feature');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No files changed vs feature');
  });
});
