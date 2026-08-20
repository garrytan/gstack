import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const EVIDENCE = path.join(ROOT, 'bin', 'gstack-evidence');

let gstackHome: string;
let repoDir: string;

import { gitIn, findFilesBySuffix } from './helpers/scratch-repo';

function git(args: string) {
  gitIn(repoDir, args);
}

function run(args: string[], opts: { cwd?: string } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(EVIDENCE, args, {
    cwd: opts.cwd ?? repoDir,
    env: { ...process.env, GSTACK_HOME: gstackHome },
    encoding: 'utf-8',
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024, // the truncation test streams 3MB through the wrapper
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function ledgerFile(): string {
  const found = findFilesBySuffix(path.join(gstackHome, 'projects'), '-evidence.jsonl');
  expect(found.length).toBeGreaterThan(0);
  return found[0];
}

function records(): any[] {
  return fs
    .readFileSync(ledgerFile(), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  gstackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-evidence-home-'));
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-evidence-repo-'));
  git('init -q -b main');
  fs.writeFileSync(path.join(repoDir, 'src.txt'), 'v1\n');
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'scratch.txt\n');
  git('add src.txt .gitignore');
  git('commit -q -m init');
});

afterEach(() => {
  fs.rmSync(gstackHome, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('gstack-evidence run', () => {
  test('records a complete evidence record and propagates exit 0', () => {
    const r = run(['run', '--label', 'tests', '--', 'echo ok']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ok');
    expect(r.stderr).toContain('recorded label=tests exit=0');
    const rec = records().pop();
    expect(rec.label).toBe('tests');
    expect(rec.command).toBe('echo ok');
    expect(rec.cmd_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.exit).toBe(0);
    expect(typeof rec.duration_s).toBe('number');
    expect(rec.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.wtree).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof rec.dirty).toBe('boolean');
    expect(fs.existsSync(rec.log_path)).toBe(true);
    expect(fs.readFileSync(rec.log_path, 'utf-8')).toContain('ok');
  });

  test('propagates a failing exit code and records it', () => {
    const r = run(['run', '--label', 'tests', '--', 'exit 3']);
    expect(r.status).toBe(3);
    expect(records().pop().exit).toBe(3);
  });

  test('spawn failure (ENOENT, argv-direct form) records and propagates 127', () => {
    const r = run(['run', '--label', 'tests', '--', '/nonexistent-gstack-binary', 'arg']);
    expect(r.status).toBe(127);
    expect(records().pop().exit).toBe(127);
  });

  test('TRANSPARENCY: ledger failure never breaks the command (append-failure injection)', () => {
    // Point GSTACK_HOME somewhere mkdir cannot succeed.
    const r = spawnSync(EVIDENCE, ['run', '--label', 'tests', '--', 'echo still-ran'], {
      cwd: repoDir,
      env: { ...process.env, GSTACK_HOME: '/dev/null/nope' },
      encoding: 'utf-8',
      timeout: 60000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('still-ran');
    expect(r.stderr).toContain('warning');
  });

  test('ledger and log files are 0600', () => {
    run(['run', '--label', 'tests', '--', 'echo ok']);
    const rec = records().pop();
    expect(fs.statSync(ledgerFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(rec.log_path).mode & 0o777).toBe(0o600);
  });

  test('two rapid runs get distinct per-run log files', () => {
    run(['run', '--label', 'tests', '--', 'echo one']);
    run(['run', '--label', 'tests', '--', 'echo two']);
    const [a, b] = records().slice(-2);
    expect(a.log_path).not.toBe(b.log_path);
  });

  test('log truncates at 2MB with a marker; exit code unaffected', () => {
    const r = run(['run', '--label', 'big', '--', 'head -c 3000000 /dev/zero | tr "\\0" a']);
    expect(r.status).toBe(0);
    const rec = records().pop();
    const size = fs.statSync(rec.log_path).size;
    expect(size).toBeLessThanOrEqual(2 * 1024 * 1024 + 200);
    expect(fs.readFileSync(rec.log_path, 'utf-8')).toContain('log truncated at 2MB');
  });

  test('logs older than 30 days are pruned opportunistically', () => {
    run(['run', '--label', 'tests', '--', 'echo ok']);
    const logsDir = path.dirname(records().pop().log_path);
    const oldLog = path.join(logsDir, 'ancient.log');
    fs.writeFileSync(oldLog, 'old');
    const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    fs.utimesSync(oldLog, past, past);
    run(['run', '--label', 'tests', '--', 'echo again']);
    expect(fs.existsSync(oldLog)).toBe(false);
  });

  test('works as a backgrounded job (ship Step 5 lanes run with & wait)', () => {
    execSync(`bash -c '"${EVIDENCE}" run --label bg -- "echo backgrounded" & wait'`, {
      cwd: repoDir,
      env: { ...process.env, GSTACK_HOME: gstackHome },
      encoding: 'utf-8',
      timeout: 60000,
    });
    const rec = records().pop();
    expect(rec.label).toBe('bg');
    expect(rec.exit).toBe(0);
  });

  test('TOCTOU guard: a mid-run working-tree edit omits the fingerprint (never certifies unseen content)', () => {
    // The command itself mutates the tree — wtreeBefore != wtreeAfter.
    const r = run(['run', '--label', 'tests', '--', 'echo mutated >> src.txt && echo green']);
    expect(r.status).toBe(0);
    const rec = records().pop();
    expect(rec.wtree).toBeUndefined();
    expect(r.stderr).toContain('changed during the run');
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('no content fingerprint');
  });

  test('a HIGH credential in the command is stored redacted', () => {
    // Fabricated, never-issued token. Assembled by concatenation so the SOURCE
    // diff carries no live-format literal (the repo's own pre-push credential
    // guard would block it) while the runtime string still exercises the
    // redact engine with a live-format value.
    const fakePat = 'ghp_' + 'A8bC2dE4fG6hI8jK0lM2nO4pQ6rS8tU0vW2x';
    const r = run(['run', '--label', 'sec', '--', `echo ${fakePat} deploy`]);
    expect(r.status).toBe(0);
    const rec = records().pop();
    expect(rec.command).not.toContain(fakePat);
    expect(rec.redacted).toBe(true);
    // The hash still binds to the ORIGINAL exact string (freshness key).
    expect(rec.cmd_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('gstack-evidence check', () => {
  test('KEYSTONE: evidence recorded on a dirty tree stays FRESH after committing the exact tested content', () => {
    // Dirty the tree (this is /ship Step 5: tests run on uncommitted code).
    fs.writeFileSync(path.join(repoDir, 'src.txt'), 'v2-tested\n');
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    expect(records().pop().dirty).toBe(true);

    // Step 15: commit the exact same content. HEAD tree changes; working-tree
    // content does not.
    git('commit -q -am ship');

    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(0);
    expect(chk.stdout).toContain('EVIDENCE: FRESH');
  });

  test('a content change after the run grades STALE', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    fs.writeFileSync(path.join(repoDir, 'src.txt'), 'changed-after-tests\n');
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('EVIDENCE: STALE');
  });

  test('an untracked NEW source file grades STALE; gitignored scratch stays FRESH', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);

    fs.writeFileSync(path.join(repoDir, 'scratch.txt'), 'conductor noise\n');
    expect(run(['check', '--label', 'tests']).status).toBe(0);

    fs.writeFileSync(path.join(repoDir, 'brand-new.ts'), 'export {}\n');
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('STALE');
  });

  test('allow-paths carve-out: a CHANGELOG-only change stays FRESH with --allow-paths', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    fs.writeFileSync(path.join(repoDir, 'CHANGELOG.md'), '## v1\n');
    git('add CHANGELOG.md');
    git('commit -q -m changelog');

    const without = run(['check', '--label', 'tests']);
    expect(without.status).toBe(1);

    const withAllow = run(['check', '--label', 'tests', '--allow-paths', 'CHANGELOG.md,VERSION,package.json']);
    expect(withAllow.status).toBe(0);
    expect(withAllow.stdout).toContain('FRESH');

    // A source change is NOT rescued by the allow-list.
    fs.writeFileSync(path.join(repoDir, 'src.txt'), 'v3\n');
    expect(run(['check', '--label', 'tests', '--allow-paths', 'CHANGELOG.md']).status).toBe(1);
  });

  test('--expect-cmd binds the label to the exact command string', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    expect(run(['check', '--label', 'tests', '--expect-cmd', 'echo green']).status).toBe(0);
    const mismatch = run(['check', '--label', 'tests', '--expect-cmd', 'echo cheaper-command']);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toContain('cmd_sha256 mismatch');
  });

  test('a recorded FAILING run is never FRESH', () => {
    run(['run', '--label', 'tests', '--', 'exit 1']);
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('recorded run failed');
  });

  test('--max-age expires old records', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    const file = ledgerFile();
    const rec = JSON.parse(fs.readFileSync(file, 'utf-8').trim());
    rec.ts = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(rec) + '\n');
    const chk = run(['check', '--label', 'tests', '--max-age', '24']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('older than 24h');
  });

  test('a gc-d / fabricated stored fingerprint degrades to STALE, never a crash', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    const file = ledgerFile();
    const rec = JSON.parse(fs.readFileSync(file, 'utf-8').trim());
    rec.wtree = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    fs.writeFileSync(file, JSON.stringify(rec) + '\n');
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('STALE');
  });

  test('a green lane never masks a red sibling: every named label must be FRESH', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    run(['run', '--label', 'vitest', '--', 'exit 1']);
    const chk = run(['check', '--label', 'tests', '--label', 'vitest']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('EVIDENCE: FRESH label=tests');
    expect(chk.stdout).toContain('EVIDENCE: STALE label=vitest');
  });

  test('MISSING for a label that never ran (explicit labels prove expected lanes)', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    const chk = run(['check', '--label', 'tests', '--label', 'never-ran']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('MISSING label=never-ran');
  });

  test('check --all grades every recorded label; empty ledger is MISSING', () => {
    const empty = run(['check', '--all']);
    expect(empty.status).toBe(1);
    expect(empty.stdout).toContain('ledger empty');

    expect(run(['run', '--label', 'a', '--', 'echo ok']).status).toBe(0);
    run(['run', '--label', 'b', '--', 'exit 1']);
    const chk = run(['check', '--all']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('label=a');
    expect(chk.stdout).toContain('label=b');
  });

  test('non-numeric --max-age is a usage error, never a silent fail-open', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    const chk = run(['check', '--label', 'tests', '--max-age', '24h']);
    expect(chk.status).toBe(2);
    expect(chk.stderr).toContain('positive number');
  });

  test('check never errors outside a git repo — degrades to STALE', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-evidence-nongit-'));
    try {
      const chk = run(['check', '--label', 'tests'], { cwd: nonGit });
      expect([0, 1]).toContain(chk.status); // different slug → MISSING; the point is: no crash
      expect(chk.status).toBe(1);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
