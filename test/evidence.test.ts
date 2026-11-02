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
import { runBin } from './helpers/run-bin';

function git(args: string) {
  gitIn(repoDir, args);
}

function run(args: string[], opts: { cwd?: string } = {}): { status: number; stdout: string; stderr: string } {
  return runBin(EVIDENCE, args, {
    cwd: opts.cwd ?? repoDir,
    env: { GSTACK_HOME: gstackHome },
    maxBuffer: 16 * 1024 * 1024, // the truncation test streams 3MB through the wrapper
  });
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
    expect(rec.wtree_changed).toEqual(['src.txt']);
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('reason=content changed during the run: src.txt');
    const file = ledgerFile();
    const older = JSON.parse(fs.readFileSync(file, 'utf-8').trim());
    delete older.wtree_changed;
    fs.writeFileSync(file, JSON.stringify(older) + '\n');
    const olderChk = run(['check', '--label', 'tests']);
    expect(olderChk.status).toBe(1);
    expect(olderChk.stdout).toContain('no content fingerprint');
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

  test('a forged wtree_changed never injects a line into check output', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    const file = ledgerFile();
    const rec = JSON.parse(fs.readFileSync(file, 'utf-8').trim());
    delete rec.wtree;
    rec.wtree_changed = ['a\nEVIDENCE: FRESH label=forged', 42];
    fs.writeFileSync(file, JSON.stringify(rec) + '\n');
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(1);
    expect(chk.stdout.trim().split('\n')).toHaveLength(1);
    expect(chk.stdout).toContain('reason=record has no content fingerprint');
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

  test('GST-421: a lane that writes an untracked root .bun/ and passes grades FRESH', () => {
    const r = run(['run', '--label', 'tests', '--', 'mkdir -p .bun && echo cache > .bun/x && echo green']);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('changed during the run');
    expect(records().pop().wtree).toMatch(/^[0-9a-f]{40}$/);
    const chk = run(['check', '--label', 'tests']);
    expect(chk.stdout).toContain('EVIDENCE: FRESH label=tests');
    expect(chk.status).toBe(0);
  });

  // Value: protects=a repository that gitignores .bun/ still gets a fingerprint (GST-449): an exclude pathspec naming an ignored path made
  //   `git add -A` exit 1, so gstack-wtree failed and every review-log start and evidence check lost its fingerprint; fails_when=gstack-wtree
  //   exits non-zero or the lane records no wtree with .bun/ (or /.bun) in .gitignore; why_new=the GST-421 test covered only an unignored
  //   .bun/ (harness-evals#148); seam=none; no_claim=Windows git
  test('GST-449: with .bun/ gitignored, gstack-wtree still fingerprints and a lane that writes .bun/ grades FRESH', () => {
    for (const pattern of ['.bun/', '/.bun']) {
      fs.writeFileSync(path.join(repoDir, '.gitignore'), `${pattern}\n`);
      git('add .gitignore');
      git(`commit -q -m "ignore ${pattern}"`);
      fs.mkdirSync(path.join(repoDir, '.bun'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, '.bun', 'x'), 'cache\n');
      const wt = runBin(path.join(ROOT, 'bin', 'gstack-wtree'), [], { cwd: repoDir });
      expect(wt.stderr).toBe('');
      expect(wt.status).toBe(0);
      expect(wt.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
      const r = run(['run', '--label', 'tests', '--', 'echo cache2 > .bun/y && echo green']);
      expect(r.status).toBe(0);
      expect(records().pop().wtree).toMatch(/^[0-9a-f]{40}$/);
      expect(run(['check', '--label', 'tests']).stdout).toContain('EVIDENCE: FRESH label=tests');
      fs.rmSync(path.join(repoDir, '.bun'), { recursive: true, force: true });
    }
  });

  // Value: protects=a repository that ignores .bun/ while still tracking a file under it gets a fingerprint (GST-449 review): the
  //   index-aware check-ignore called .bun not ignored, so the exclude pathspec came back and `git add -A` exited 1; fails_when=gstack-wtree
  //   exits non-zero, or its tree differs from a plain `git add -A`, or an edit or delete of the tracked file leaves it unchanged;
  //   why_new=the pattern loop above starts from an untracked .bun/ only; seam=none; no_claim=Windows git
  test('GST-449: an ignored .bun/ that still tracks a file fingerprints like a plain git add -A, and edits to the tracked file count', () => {
    fs.mkdirSync(path.join(repoDir, '.bun'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.bun', 'tracked'), 'v1\n');
    git('add -f .bun/tracked');
    git('commit -q -m "track .bun/tracked"');
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '.bun/\n');
    git('add .gitignore');
    git('commit -q -m "ignore .bun/"');
    fs.writeFileSync(path.join(repoDir, '.bun', 'cache'), 'cache\n');
    const wtree = () => {
      const wt = runBin(path.join(ROOT, 'bin', 'gstack-wtree'), [], { cwd: repoDir });
      expect(wt.stderr).toBe('');
      expect(wt.status).toBe(0);
      return wt.stdout.trim();
    };
    const plain = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-wtree-idx-'));
      try {
        const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
        spawnSync('git', ['read-tree', 'HEAD'], { cwd: repoDir, env, timeout: 10_000 });
        spawnSync('git', ['add', '-A'], { cwd: repoDir, env, timeout: 10_000 });
        return spawnSync('git', ['write-tree'], { cwd: repoDir, env, encoding: 'utf-8', timeout: 10_000 }).stdout.trim();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const clean = wtree();
    expect(clean).toBe(plain());
    fs.writeFileSync(path.join(repoDir, '.bun', 'tracked'), 'v2\n');
    const edited = wtree();
    expect(edited).not.toBe(clean);
    expect(edited).toBe(plain());
    fs.rmSync(path.join(repoDir, '.bun', 'tracked'));
    const deleted = wtree();
    expect(deleted).not.toBe(clean);
    expect(deleted).toBe(plain());
  });

  test('GST-421: a lane that writes untracked source grades STALE and the reason names the path', () => {
    const r = run(['run', '--label', 'tests', '--', 'mkdir -p src && echo "export {}" > src/new.ts && echo green']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('changed during the run: src/new.ts');
    const rec = records().pop();
    expect(rec.wtree).toBeUndefined();
    expect(rec.wtree_changed).toEqual(['src/new.ts']);
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('EVIDENCE: STALE label=tests');
    expect(chk.stdout).toContain('reason=content changed during the run: src/new.ts');
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

describe('gstack-evidence run — the repo .env never reaches the child through gstack (GSTA-56)', () => {
  // gstack-evidence starts with --no-env-file --config=/dev/null
  // (lib/bun-isolation.ts), so Bun never loads the repo's .env files into the
  // wrapper and the command under test sees the shell's environment, exactly
  // as when run by hand. The command may still read .env files itself, as it
  // would without the wrapper. NODE_ENV is cleared because bun skips
  // .env.local under NODE_ENV=test, which would make that fixture prove nothing.

  function runWith(env: Record<string, string | undefined>, cmd: string) {
    return spawnSync(EVIDENCE, ['run', '--label', 'envprobe', '--', cmd], {
      cwd: repoDir,
      env: { ...process.env, GSTACK_HOME: gstackHome, ...env },
      encoding: 'utf-8',
      timeout: 60000,
    });
  }

  test('.env and .env.local values do not reach the child', () => {
    fs.writeFileSync(path.join(repoDir, '.env'), 'ZZ_TOKEN_PROBE="s3cret-value"\n');
    fs.writeFileSync(path.join(repoDir, '.env.local'), 'ZZ_LOCAL_PROBE=leaked\n');
    const r = runWith({ NODE_ENV: undefined }, 'echo "saw=[${ZZ_TOKEN_PROBE:-absent}][${ZZ_LOCAL_PROBE:-absent}]"');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('saw=[absent][absent]');
    expect(r.stdout + r.stderr).not.toContain('s3cret-value');
    expect(r.stdout + r.stderr).not.toContain('leaked');
  });

  test('CONTROL — shell-exported variables survive, including one equal to the .env value', () => {
    fs.writeFileSync(path.join(repoDir, '.env'), 'ZZ_KEEP_PROBE=from_file\nZZ_SAME_PROBE=same\n');
    const r = runWith({ NODE_ENV: undefined, ZZ_KEEP_PROBE: 'from_shell', ZZ_SAME_PROBE: 'same' },
      'echo "saw=[${ZZ_KEEP_PROBE:-absent}][${ZZ_SAME_PROBE:-absent}]"');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('saw=[from_shell][same]');
  });
});

describe('gstack-evidence tests_ran — zero-run green is a third state, never merged with pass or unknown', () => {
  // The receipt carries the runner's own executed-test count parsed from a
  // bounded tail of the streamed output. `run` never changes its exit on it
  // (TRANSPARENCY INVARIANT); `check` grades 0 as ZERO-RUN (STALE-equivalent,
  // its own label) and unknown as non-blocking.
  const bunOutput = (pass: number, skip: number, fail: number) =>
    `printf 'bun test v1\\n\\n ${pass} pass\\n ${skip} skip\\n ${fail} fail\\nRan ${pass + skip + fail} tests across 1 file. [10.00ms]\\n' >&2`;

  test('bun: executed = pass + fail; the count lands in the receipt and check stays FRESH', () => {
    const r = run(['run', '--label', 'tests', '--', bunOutput(7, 2, 1) + ' && exit 0']);
    expect(r.status).toBe(0);
    expect(records().pop().tests_ran).toBe(8);
    expect(r.stderr).toContain('recorded label=tests exit=0 tests_ran=8');
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(0);
    expect(chk.stdout).toContain('EVIDENCE: FRESH label=tests exit=0 tests_ran=8');
  });

  test('bun all-skip is ZERO-RUN: run still exits 0, check fails under its own label', () => {
    const r = run(['run', '--label', 'tests', '--', bunOutput(0, 5, 0)]);
    expect(r.status).toBe(0);
    expect(records().pop().tests_ran).toBe(0);
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(1);
    expect(chk.stdout).toContain('EVIDENCE: ZERO-RUN label=tests exit=0 tests_ran=0');
    expect(chk.stdout).toContain('reason=runner reported 0 executed tests');
    expect(chk.stdout).not.toContain('STALE');
  });

  test('an unrecognised runner is unknown: non-blocking, labelled in the detail', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    expect(records().pop().tests_ran).toBe('unknown');
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(0);
    expect(chk.stdout).toContain('EVIDENCE: FRESH label=tests exit=0 tests_ran=unknown');
  });

  test('jest, vitest, pytest, rspec and go zero-only summaries', () => {
    const cases: [string, number | 'unknown'][] = [
      ["printf 'Tests:       1 failed, 2 passed, 1 skipped, 4 total\\nTime: 1s\\n'", 3],
      ["printf 'No tests found, exiting with code 0\\n'", 0],
      ["printf '      Tests  3 passed | 1 skipped (4)\\n   Start at  10:00\\n'", 3],
      ["printf 'No test files found, exiting with code 1\\n'", 0],
      ["printf '===== 3 passed, 1 skipped, 2 xfailed in 0.12s =====\\n'", 5],
      ["printf '============ no tests ran in 0.01s ============\\n'", 0],
      ["printf 'Finished in 0.2 seconds\\n12 examples, 0 failures, 2 pending\\n'", 10],
      ["printf '?   \\texample.com/pkg\\t[no test files]\\n?   \\texample.com/other\\t[no test files]\\n'", 0],
      ["printf 'ok  \\texample.com/pkg\\t0.1s\\n?   \\texample.com/other\\t[no test files]\\n'", 'unknown'],
    ];
    for (const [cmd, want] of cases) {
      expect(run(['run', '--label', 'lane', '--', cmd]).status).toBe(0);
      expect([cmd, records().pop().tests_ran]).toEqual([cmd, want]);
    }
  });

  test('a gstack-pregate --remote lane: the remote gate\'s tests= count (ran, skips included) lands in the receipt (captured output)', () => {
    // test/fixtures/evidence/pregate-remote-failed.out is the stdout of
    // `gstack-pregate --stage tests --remote` captured under gstack-evidence
    // on 2026-10-26 (GSTA-102): the Ubicloud gate ran 9658 tests with 1
    // failure, and the lane came back incomplete. Before, the receipt said
    // tests_ran=unknown for every remote lane, so the ship receipt and the
    // Review Readiness Dashboard never carried the real number.
    const fixture = path.join(ROOT, 'test', 'fixtures', 'evidence', 'pregate-remote-failed.out');
    expect(fs.readFileSync(fixture, 'utf-8')).toContain('PREGATE_REMOTE: tree=279e658e29bec511739dd00510828dc433fb94fa tests=9658 failed=1 spent=0.04');
    const r = run(['run', '--label', 'tests', '--', `cat '${fixture}'; exit 1`]);
    expect(r.status).toBe(1);
    expect(records().pop()).toMatchObject({ exit: 1, tests_ran: 9658 });
    expect(r.stderr).toContain('recorded label=tests exit=1 tests_ran=9658');
    expect(run(['check', '--label', 'tests']).stdout).toContain('EVIDENCE: STALE label=tests exit=1 tests_ran=9658');
  });

  test('a cleared remote lane (captured output): the gate line and the receipt line carry the same count, and the lane is FRESH', () => {
    // pregate-remote-cleared.out is the same lane's stdout+stderr on the next
    // tree, after the fix: 9660 tests, 0 failed, the obligation cleared. It
    // carries both the gate's PREGATE_REMOTE line and the "cleared by
    // remote-gate" receipt, plus bun's own "Ran 23 tests" line indented under
    // "lanes:", which must not be mistaken for a bun summary.
    const fixture = path.join(ROOT, 'test', 'fixtures', 'evidence', 'pregate-remote-cleared.out');
    const text = fs.readFileSync(fixture, 'utf-8');
    expect(text).toContain('PREGATE_REMOTE: tree=46b75c23704fb4ae1f22677258c16b880ecd20c5 tests=9660 failed=0 spent=0.04');
    expect(text).toContain('cleared by remote-gate tree=46b75c23704f tests=9660');
    expect(text).toContain('lanes:   Ran 23 tests across 1 file.');
    expect(run(['run', '--label', 'tests', '--', `cat '${fixture}'`]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(9660);
    expect(run(['check', '--label', 'tests']).stdout).toContain('EVIDENCE: FRESH label=tests exit=0 tests_ran=9660');
    // A paid-only selection reports tests=0: that is ZERO-RUN, not a pass.
    expect(run(['run', '--label', 'tests', '--', "printf '    lanes:   PREGATE_REMOTE: tree=279e658e29bec511739dd00510828dc433fb94fa tests=0 failed=0 spent=0\\n'"]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(0);
    expect(run(['check', '--label', 'tests']).stdout).toContain('EVIDENCE: ZERO-RUN label=tests exit=0 tests_ran=0');
  });

  test('the cleared receipt line alone is parsed, the later of the two lines wins, and an echoed occurrence does not count', () => {
    // renderTable prints the obligation's receipt line beside the lane row; it is
    // parsed on its own (here in the `clear --receipt` form lib/pregate/index.ts
    // builds, with receipt= and sha256=) so a table that carries the receipt
    // without the row still records the count.
    const receipt = 'requires-remote: pregate.json/remote_gate (remote) 362 test(s) — cleared by remote-gate tree=46b75c23704f tests=9660 receipt=/x/gate.out sha256=0123456789ab';
    const gate = '    lanes:   PREGATE_REMOTE: tree=46b75c23704fb4ae1f22677258c16b880ecd20c5 tests=9658 failed=0 spent=0.04';
    const print = (...ls: string[]) => `printf '%s\\n' ${ls.map((l) => `'${l}'`).join(' ')}`;
    expect(run(['run', '--label', 'tests', '--', print(receipt)]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(9660);
    expect(run(['run', '--label', 'tests', '--', print(gate, receipt)]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(9660);
    expect(run(['run', '--label', 'tests', '--', print(receipt, gate)]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(9658);
    // Only a line that is the lane row or the receipt counts: a log line that
    // prefixes or quotes one is not a run (indentation is accepted: the row
    // itself is indented under "lanes:").
    expect(run(['run', '--label', 'tests', '--', print('expected PREGATE_REMOTE: tree=x tests=9999 failed=0', 'note: saw cleared by remote-gate tree=x tests=9999 in a log')]).status).toBe(0);
    expect(records().pop().tests_ran).toBe('unknown');
  });

  test("gstack's shard runner (captured output): the FILES-FROM RESULT total, the per-shard PASS sum without it, and a forwarded bun line on stderr", () => {
    // test/fixtures/evidence/shard-runner-files-from.out is the stream of the
    // remote gate's `scripts/test-free-shards.ts --files-from` run on the
    // Ubicloud VM for GSTA-102's tree d47be9b6 (275 files, 16 shards, 10138
    // tests): 16 "[test:free] PASS — N tests" epilogues whose sum is the
    // "FILES-FROM RESULT: … tests=10138" total, nested bun children's own
    // "Ran N tests" lines among them. Before, every full-suite run through the
    // shard runner (`bun run test:ubicloud`, GSTA-94 on #3424) recorded
    // tests_ran=0: the quiet shards forward bun's "Ran N tests" line without
    // its " N pass" counts, and the bun branch read that as zero.
    const fixture = path.join(ROOT, 'test', 'fixtures', 'evidence', 'shard-runner-files-from.out');
    const text = fs.readFileSync(fixture, 'utf-8');
    expect(text).toContain('[test:free] FILES-FROM RESULT: files=275 tests=10138 failed=0 exit=0');
    expect(text.match(/\[test:free\] PASS — (\d+) tests/g)).toHaveLength(16);
    expect(run(['run', '--label', 'tests', '--', `cat '${fixture}'`]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(10138);
    // A full-suite run has no FILES-FROM RESULT line: the per-shard epilogues sum to the same total.
    expect(run(['run', '--label', 'tests', '--', `grep -v 'FILES-FROM RESULT' '${fixture}'`]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(10138);
    // The live shape: epilogues on stdout, the forwarded "Ran N tests" line on stderr (which the
    // tail appends after stdout). A bun terminal line with no counts block is not a bun summary.
    expect(run(['run', '--label', 'tests', '--', "printf '[test:free] full suite: 1 files across 1 shard processes (duration-packed)\\n[test:free] PASS — 37 tests, 1 files, 38s. Full log: /x\\n'; printf 'Ran 37 tests across 1 file. [38.05s]\\n' >&2"]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(37);
    // A real bun all-skip run still grades ZERO-RUN: its counts block is present.
    expect(run(['run', '--label', 'tests', '--', "printf ' 0 pass\\n 2 skip\\n 0 fail\\nRan 2 tests across 1 file. [4.00ms]\\n'"]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(0);
  });

  test('shard runner shapes: a forwarded count-less line never beats the epilogue sum, no bun block does once the runner spoke, a flaky-pass run is unknown, only the last run counts, and a count-less "Ran 0 tests" is ZERO-RUN', () => {
    const start = '[test:free] full suite: 3 files across 2 shard processes (duration-packed)';
    const pass = (n: number) => `[test:free] PASS — ${n} tests, 1 files, 1s. Full log: /x`;
    const out = (...ls: string[]) => `printf '%s\\n' ${ls.map((l) => `'${l}'`).join(' ')}`;
    const err = (...ls: string[]) => `${out(...ls)} >&2`;
    // The quiet runner forwards " N fail" (never " N pass") and the terminal line on stderr.
    expect(run(['run', '--label', 'tests', '--', `${out(start, pass(100), pass(37))}; ${err(' 1 fail', 'Ran 600 tests across 18 files. [1s]')}`]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(137);
    // Once the runner spoke its sum stands over any bun counts block, wherever that block sits: the tail
    // is stdout then stderr, so a bun block on stderr always sorts after the runner's stdout epilogues
    // whether it ran before the suite (a focused file first) or after it (a trailing all-skip run).
    // Value: protects=a 10k-test shard-runner run is never recorded as a focused file's count or ZERO-RUN
    // because bun's stderr block out-positions it; fails_when=parseTestsRan lets a counted bun block win
    // on position once the runner spoke; why_new=every earlier row put the counted block after the runner;
    // seam=none; no_claim=a bun run that genuinely followed the suite is not counted separately.
    expect(run(['run', '--label', 'tests', '--', `${out(start, pass(100), pass(37))}; ${err(' 0 pass', ' 2 skip', ' 0 fail', 'Ran 2 tests across 1 file. [4.00ms]')}`]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(137);
    expect(run(['run', '--label', 'tests', '--', out(start, pass(100), pass(37), ' 0 pass', ' 2 skip', ' 0 fail', 'Ran 2 tests across 1 file. [4.00ms]')]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(137);
    expect(run(['run', '--label', 'tests', '--', `${err(' 5 pass', ' 0 fail', 'Ran 5 tests across 1 file. [9.00ms]')}; ${out(start, pass(100), pass(37))}`]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(137);
    expect(run(['run', '--label', 'tests', '--', out(' 5 pass', ' 0 fail', 'Ran 5 tests across 1 file. [9.00ms]', start, pass(100), pass(37))]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(137);
    // A verdict line whose start line fell out of the tail: the runner spoke but the sum is incomplete, so
    // unknown, never a forwarded shard block's count and never bun's ZERO-RUN for a run that was not bun's.
    expect(run(['run', '--label', 'tests', '--', `${out(pass(100), pass(37))}; ${err(' 0 pass', ' 2 skip', ' 0 fail', 'Ran 2 tests across 1 file. [4.00ms]')}`]).status).toBe(0);
    expect(records().pop().tests_ran).toBe('unknown');
    expect(run(['run', '--label', 'tests', '--', out('[test:free] FILES-FROM RESULT: files=1 tests=9 failed=0 exit=0')]).status).toBe(0);
    expect(records().pop().tests_ran).toBe('unknown');
    // A full-suite start line names its shard count: fewer PASS epilogues than that is a killed run, not a total.
    const planned = '[test:free] full suite: 300 files across 3 shard processes (duration-packed), then 2 exclusive host-state file(s) serially';
    expect(run(['run', '--label', 'tests', '--', out(planned, pass(100), pass(37), pass(5), pass(2))]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(144);
    expect(run(['run', '--label', 'tests', '--', out(planned, pass(100), pass(37), pass(5))]).status).toBe(0);
    expect(records().pop().tests_ran).toBe('unknown');
    expect(run(['run', '--label', 'tests', '--', out('[test:free] full suite: 300 files across 3 shard processes', pass(100), pass(37), pass(5))]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(142);
    // An empty shard prints no PASS epilogue, only its "0 files" line: it counts as a zero shard, not a missing one.
    expect(run(['run', '--label', 'tests', '--', out('[test:free] full suite: 2 files across 3 shard processes', pass(100), '[test:free] shard 2/3: 0 files, 0s, pass', pass(37))]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(137);
    // A FAIL epilogue plus a FLAKY-PASS retry exits 0 but has lost the failed shard's count.
    expect(run(['run', '--label', 'tests', '--', out(start, pass(100), '[test:free] FAIL — 1 failing test(s) in 1 file(s), 0 crashed worker(s). Full log: /y', '[test:free] FLAKY-PASS — 1 file(s) failed once and passed on serial retry: a.test.ts', pass(5))]).status).toBe(0);
    expect(records().pop().tests_ran).toBe('unknown');
    // Two runs in one command: the last run's sum, not both.
    expect(run(['run', '--label', 'tests', '--', out(start, pass(100), start, pass(7), pass(8))]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(15);
    // A forwarded "Ran 0 tests" line with no counts block is still ZERO-RUN.
    expect(run(['run', '--label', 'tests', '--', err('Ran 0 tests across 0 files. [1ms]')]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(0);
    // A files-from run's total stands even when a shard failed; a shard with no count is unknown.
    expect(run(['run', '--label', 'tests', '--', out(start, pass(100), '[test:free] FAIL — 1 failing test(s) in 1 file(s), 0 crashed worker(s). Full log: /y', '[test:free] FILES-FROM RESULT: files=3 tests=137 failed=1 exit=1')]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(137);
    expect(run(['run', '--label', 'tests', '--', out(start, pass(100), '[test:free] PASS — ? tests, ? files, 1s. Full log: /z')]).status).toBe(0);
    expect(records().pop().tests_ran).toBe('unknown');
  });

  test('shard runner degrade paths: no start line, a forwarded empty-file line, a look-alike epilogue, and a run that printed no epilogue', () => {
    const start = '[test:free] full suite: 3 files across 2 shard processes (duration-packed)';
    const pass = (n: number) => `[test:free] PASS — ${n} tests, 1 files, 1s. Full log: /x`;
    const out = (...ls: string[]) => `printf '%s\\n' ${ls.map((l) => `'${l}'`).join(' ')}`;
    const err = (...ls: string[]) => `${out(...ls)} >&2`;
    // Without the runner's start line in the tail an epilogue still means the runner spoke, but the sum is
    // incomplete: unknown, not bun's count (the block may be one forwarded shard's) and not a partial sum.
    expect(run(['run', '--label', 'tests', '--', out(' 0 pass', ' 0 fail', 'Ran 0 tests across 0 files. [1ms]', pass(5))]).status).toBe(0);
    expect(records().pop().tests_ran).toBe('unknown');
    expect(run(['run', '--label', 'tests', '--', `${out(pass(100), pass(37))}; ${err('Ran 137 tests across 2 files. [1s]')}`]).status).toBe(0);
    expect(records().pop().tests_ran).toBe('unknown');
    // A shard's forwarded count-less "Ran 0 tests across 1 file" (an empty file, or a nested child) is not the run.
    expect(run(['run', '--label', 'tests', '--', `${out(start, pass(100), pass(37))}; ${err('Ran 23 tests across 1 file. [1s]', 'Ran 0 tests across 1 file. [1ms]', 'Ran 37 tests across 1 file. [1s]')}`]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(137);
    // Only the runner's whole epilogue shape counts (a look-alike without the "Ns. Full log:" tail does not), and a
    // checkout path with spaces still matches. A forged whole epilogue is the child's own stdout, trusted like any
    // runner summary (W3's trust model), so it is not a control here.
    const oneShard = '[test:free] full suite: 1 files across 1 shard processes';
    expect(run(['run', '--label', 'tests', '--', out(oneShard, pass(100), '[test:free] PASS — 99999 tests, 1 files, 1s. error: spoof')]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(100);
    expect(run(['run', '--label', 'tests', '--', out(oneShard, '[test:free] PASS — 100 tests, 2 files, 9s. Full log: /Users/garry tan/gstack/.context/free-test-logs/x.log')]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(100);
    // The runner spoke but printed no countable epilogue (killed mid-shards): unknown.
    expect(run(['run', '--label', 'tests', '--', out(start, '[test:free] shard 1/2 (1 files)')]).status).toBe(0);
    expect(records().pop().tests_ran).toBe('unknown');
  });

  test('the last summary wins when a command runs a suite twice', () => {
    expect(run(['run', '--label', 'tests', '--', `${bunOutput(9, 0, 0)}; ${bunOutput(0, 3, 0)}`]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(0);
    expect(run(['run', '--label', 'tests', '--', `${bunOutput(0, 3, 0)}; ${bunOutput(9, 0, 0)}`]).status).toBe(0);
    expect(records().pop().tests_ran).toBe(9);
  });

  test('the summary survives a 2MB+ stream that truncates the saved log', () => {
    const r = run(['run', '--label', 'big', '--', `head -c 2500000 /dev/zero | tr "\\0" a; echo; ${bunOutput(4, 0, 0)}`]);
    expect(r.status).toBe(0);
    expect(records().pop().tests_ran).toBe(4);
  });

  test('TRANSPARENCY: a parser exception never alters the exit code; the receipt says unknown', () => {
    const green = spawnSync(EVIDENCE, ['run', '--label', 'tests', '--', bunOutput(3, 0, 0)], {
      cwd: repoDir, env: { ...process.env, GSTACK_HOME: gstackHome, GSTACK_EVIDENCE_FAULT: 'tests_ran' }, encoding: 'utf-8', timeout: 60000,
    });
    expect(green.status).toBe(0);
    expect(green.stderr).toContain('tests_ran parse failed');
    expect(records().pop().tests_ran).toBe('unknown');
    const red = spawnSync(EVIDENCE, ['run', '--label', 'tests', '--', `${bunOutput(3, 0, 0)}; exit 3`], {
      cwd: repoDir, env: { ...process.env, GSTACK_HOME: gstackHome, GSTACK_EVIDENCE_FAULT: 'tests_ran' }, encoding: 'utf-8', timeout: 60000,
    });
    expect(red.status).toBe(3);
    expect(records().pop()).toMatchObject({ exit: 3, tests_ran: 'unknown' });
  });

  test('a record without tests_ran (older ledger) grades as unknown, not ZERO-RUN', () => {
    expect(run(['run', '--label', 'tests', '--', 'echo green']).status).toBe(0);
    const file = ledgerFile();
    const rec = JSON.parse(fs.readFileSync(file, 'utf-8').trim());
    delete rec.tests_ran;
    fs.writeFileSync(file, JSON.stringify(rec) + '\n');
    const chk = run(['check', '--label', 'tests']);
    expect(chk.status).toBe(0);
    expect(chk.stdout).toContain('tests_ran=unknown');
  });
});

describe('gstack-wtree and the root .bun/ folder (GST-421)', () => {
  const WTREE = path.join(ROOT, 'bin', 'gstack-wtree');
  const fingerprint = () => {
    const r = runBin(WTREE, [], { cwd: repoDir });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };

  test('an untracked root .bun/ leaves the fingerprint unchanged; a nested .bun/ still counts', () => {
    const before = fingerprint();
    fs.mkdirSync(path.join(repoDir, '.bun'));
    fs.writeFileSync(path.join(repoDir, '.bun', 'x'), 'cache\n');
    expect(fingerprint()).toBe(before);
    fs.mkdirSync(path.join(repoDir, 'pkg', '.bun'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'pkg', '.bun', 'x'), 'not the root\n');
    expect(fingerprint()).not.toBe(before);
  });

  test('a tracked file under .bun/ still changes the fingerprint when modified or deleted', () => {
    fs.mkdirSync(path.join(repoDir, '.bun'));
    fs.writeFileSync(path.join(repoDir, '.bun', 'tracked.txt'), 'v1\n');
    git('add .bun/tracked.txt');
    git('commit -q -m tracked-bun');
    const committed = fingerprint();
    fs.writeFileSync(path.join(repoDir, '.bun', 'tracked.txt'), 'v2 longer\n');
    const modified = fingerprint();
    expect(modified).not.toBe(committed);
    fs.rmSync(path.join(repoDir, '.bun', 'tracked.txt'));
    const deleted = fingerprint();
    expect(deleted).not.toBe(committed);
    expect(deleted).not.toBe(modified);
  });

  test('a tree without .bun/ hashes to the same tree as a plain git add -A', () => {
    fs.writeFileSync(path.join(repoDir, 'untracked.ts'), 'export {}\n');
    fs.writeFileSync(path.join(repoDir, 'src.txt'), 'edited\n');
    fs.rmSync(path.join(repoDir, '.gitignore'));
    const idx = path.join(gstackHome, 'plain-index');
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    const plain = execSync('git read-tree HEAD && git add -A && git write-tree', { cwd: repoDir, env, encoding: 'utf-8', timeout: 10000 }).trim();
    expect(fingerprint()).toBe(plain);
  });
});
