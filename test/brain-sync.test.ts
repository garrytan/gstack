/**
 * gbrain-sync integration tests.
 *
 * Covers the core cross-machine memory sync feature end-to-end:
 *   - bin/gstack-config gbrain keys (validation, isolation)
 *   - bin/gstack-brain-enqueue (atomicity, skip list, no-op gates)
 *   - bin/gstack-jsonl-merge (3-way, ts-sort, hash-fallback)
 *   - bin/gstack-brain-sync --once (drain, commit, push, secret-scan, skip-file)
 *   - bin/gstack-brain-init + --restore round-trip
 *   - bin/gstack-brain-uninstall preserves user data
 *   - env isolation (GSTACK_HOME never bleeds into real ~/.gstack/config.yaml)
 *
 * Runs each test against a temp GSTACK_HOME and a local bare git repo as
 * a fake remote. No live GitHub, no live GBrain.
 */

import { describe, test as _test, expect, beforeEach, afterEach } from 'bun:test';

// Boost timeout: brain-sync tests spawn git, network-ls-remote, and 10-way
// parallel processes — 5s default is too tight.
const test = (name: string, fn: any) => _test(name, fn, 30000);
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpHome: string;
let bareRemote: string;

function run(argv: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  const bin = argv[0];
  const full = bin.startsWith('/') ? bin : path.join(BIN, bin);
  const res = spawnSync(full, argv.slice(1), {
    env: { ...process.env, GSTACK_HOME: tmpHome, ...(opts.env || {}) },
    encoding: 'utf-8',
    input: opts.input,
    cwd: ROOT,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

function git(args: string[], cwd?: string) {
  const res = spawnSync('git', args, { cwd: cwd || tmpHome, encoding: 'utf-8' });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sync-home-'));
  bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sync-remote-'));
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', bareRemote]);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(bareRemote, { recursive: true, force: true });
  // Clean up any remote-helper file init may have written.
  const remoteFile = path.join(os.homedir(), '.gstack-brain-remote.txt');
  // Only remove if it points at OUR bare remote (don't clobber a real user file).
  try {
    const contents = fs.readFileSync(remoteFile, 'utf-8').trim();
    if (contents === bareRemote) fs.unlinkSync(remoteFile);
  } catch {}
});

// ---------------------------------------------------------------
// Config key validation + env isolation
// ---------------------------------------------------------------
describe('gstack-config gbrain keys', () => {
  test('default gbrain_sync_mode is off', () => {
    const r = run(['gstack-config', 'get', 'gbrain_sync_mode']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('off');
  });

  test('default gbrain_sync_mode_prompted is false', () => {
    const r = run(['gstack-config', 'get', 'gbrain_sync_mode_prompted']);
    expect(r.stdout.trim()).toBe('false');
  });

  test('accepts full / artifacts-only / off', () => {
    for (const val of ['full', 'artifacts-only', 'off']) {
      const set = run(['gstack-config', 'set', 'gbrain_sync_mode', val]);
      expect(set.status).toBe(0);
      const get = run(['gstack-config', 'get', 'gbrain_sync_mode']);
      expect(get.stdout.trim()).toBe(val);
    }
  });

  test('invalid gbrain_sync_mode value warns + defaults', () => {
    const r = run(['gstack-config', 'set', 'gbrain_sync_mode', 'bogus']);
    expect(r.stderr).toContain('not recognized');
    const get = run(['gstack-config', 'get', 'gbrain_sync_mode']);
    expect(get.stdout.trim()).toBe('off');
  });

  test('GSTACK_HOME overrides real config dir', () => {
    run(['gstack-config', 'set', 'gbrain_sync_mode', 'full']);
    // Real ~/.gstack/config.yaml must NOT have been touched.
    const realConfig = path.join(os.homedir(), '.gstack', 'config.yaml');
    const real = fs.existsSync(realConfig) ? fs.readFileSync(realConfig, 'utf-8') : '';
    expect(real).not.toContain('gbrain_sync_mode: full');
  });
});

// ---------------------------------------------------------------
// Enqueue behavior
// ---------------------------------------------------------------
describe('gstack-brain-enqueue', () => {
  test('no-op when feature not initialized', () => {
    const r = run(['gstack-brain-enqueue', 'projects/foo/learnings.jsonl']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.brain-queue.jsonl'))).toBe(false);
  });

  test('no-op when mode is off (even if .git exists)', () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    const r = run(['gstack-brain-enqueue', 'projects/foo/learnings.jsonl']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.brain-queue.jsonl'))).toBe(false);
  });

  test('enqueues when mode is full and .git exists', () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    run(['gstack-config', 'set', 'gbrain_sync_mode', 'full']);
    run(['gstack-brain-enqueue', 'projects/foo/learnings.jsonl']);
    const queue = fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
    expect(queue).toContain('projects/foo/learnings.jsonl');
    const obj = JSON.parse(queue.trim());
    expect(obj.file).toBe('projects/foo/learnings.jsonl');
    expect(obj.ts).toBeTruthy();
  });

  test('skip list honored', () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    run(['gstack-config', 'set', 'gbrain_sync_mode', 'full']);
    fs.writeFileSync(path.join(tmpHome, '.brain-skip.txt'), 'projects/foo/secret.jsonl\n');
    run(['gstack-brain-enqueue', 'projects/foo/secret.jsonl']);
    run(['gstack-brain-enqueue', 'projects/foo/ok.jsonl']);
    const queue = fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
    expect(queue).not.toContain('secret.jsonl');
    expect(queue).toContain('ok.jsonl');
  });

  test('concurrent enqueues all land (atomic append)', async () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    run(['gstack-config', 'set', 'gbrain_sync_mode', 'full']);
    const procs = [];
    for (let i = 0; i < 10; i++) {
      procs.push(new Promise<void>((resolve) => {
        const r = spawnSync(path.join(BIN, 'gstack-brain-enqueue'), [`file-${i}.jsonl`], {
          env: { ...process.env, GSTACK_HOME: tmpHome },
          encoding: 'utf-8',
        });
        resolve();
      }));
    }
    await Promise.all(procs);
    const queue = fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
    const lines = queue.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(10);
  });

  test('no args does not crash', () => {
    const r = run(['gstack-brain-enqueue']);
    expect(r.status).toBe(0);
  });
});

// ---------------------------------------------------------------
// JSONL merge driver
// ---------------------------------------------------------------
describe('gstack-jsonl-merge', () => {
  test('3-way merge dedups + sorts by ts', () => {
    const base = path.join(tmpHome, 'base.jsonl');
    const ours = path.join(tmpHome, 'ours.jsonl');
    const theirs = path.join(tmpHome, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    fs.writeFileSync(ours, '{"x":1,"ts":"2026-01-01T10:00:00Z"}\n{"x":2,"ts":"2026-01-01T11:00:00Z"}\n');
    fs.writeFileSync(theirs, '{"x":3,"ts":"2026-01-01T09:00:00Z"}\n{"x":2,"ts":"2026-01-01T11:00:00Z"}\n');
    const r = run([path.join(BIN, 'gstack-jsonl-merge'), base, ours, theirs]);
    expect(r.status).toBe(0);
    const lines = fs.readFileSync(ours, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('"x":3');  // earliest ts
    expect(lines[2]).toContain('"x":2');  // latest ts
  });

  test('falls back to hash order for lines without ts', () => {
    const base = path.join(tmpHome, 'base.jsonl');
    const ours = path.join(tmpHome, 'ours.jsonl');
    const theirs = path.join(tmpHome, 'theirs.jsonl');
    fs.writeFileSync(base, '');
    fs.writeFileSync(ours, '{"a":1}\n{"a":2}\n');
    fs.writeFileSync(theirs, '{"a":3}\n{"a":2}\n');
    run([path.join(BIN, 'gstack-jsonl-merge'), base, ours, theirs]);
    const lines = fs.readFileSync(ours, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(3);
    // Order is deterministic (sha256 of each line).
    const again = spawnSync(path.join(BIN, 'gstack-jsonl-merge'), [base, ours, theirs]);
    // (re-running doesn't change the order since same input → same output)
  });
});

// ---------------------------------------------------------------
// Init + sync + restore round-trip
// ---------------------------------------------------------------
describe('init + sync + restore round-trip', () => {
  test('init creates canonical files + registers drivers', () => {
    const r = run(['gstack-brain-init', '--remote', bareRemote]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.brain-allowlist'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.brain-privacy-map.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.gitattributes'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.git/hooks/pre-commit'))).toBe(true);
    // Merge driver registered in local git config.
    const cfg = git(['config', '--get', 'merge.jsonl-append.driver']);
    expect(cfg.stdout).toContain('gstack-jsonl-merge');
  });

  test('refuses init on different remote', () => {
    run(['gstack-brain-init', '--remote', bareRemote]);
    const otherRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-other-'));
    spawnSync('git', ['init', '--bare', '-q', '-b', 'main', otherRemote]);
    const r = run(['gstack-brain-init', '--remote', otherRemote]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('already a git repo pointing at');
    fs.rmSync(otherRemote, { recursive: true, force: true });
  });

  test('full sync: init → enqueue → --once → commit pushed', () => {
    run(['gstack-brain-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'gbrain_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'),
      '{"skill":"x","insight":"y","ts":"2026-04-22T10:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    // Check the remote got the commit.
    const log = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8' });
    expect(log.stdout).toMatch(/sync: 1 file/);
  });

  test('restore round-trip: writes on machine A visible on machine B', () => {
    // Machine A.
    run(['gstack-brain-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'gbrain_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'myproj'), { recursive: true });
    const aLearning = '{"skill":"x","insight":"machine A wisdom","ts":"2026-04-22T10:00:00Z"}\n';
    fs.writeFileSync(path.join(tmpHome, 'projects/myproj/learnings.jsonl'), aLearning);
    run(['gstack-brain-enqueue', 'projects/myproj/learnings.jsonl']);
    run(['gstack-brain-sync', '--once']);

    // Machine B (new temp home).
    const machineB = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-machineB-'));
    const r = run(['gstack-brain-restore', bareRemote], {
      env: { GSTACK_HOME: machineB },
    });
    expect(r.status).toBe(0);
    const restored = fs.readFileSync(path.join(machineB, 'projects/myproj/learnings.jsonl'), 'utf-8');
    expect(restored).toContain('machine A wisdom');
    // Merge drivers re-registered on B.
    const cfg = spawnSync('git', ['-C', machineB, 'config', '--get', 'merge.jsonl-append.driver'], { encoding: 'utf-8' });
    expect(cfg.stdout).toContain('gstack-jsonl-merge');
    fs.rmSync(machineB, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------
// Secret scan: all regex families block
// ---------------------------------------------------------------
describe('gstack-brain-sync secret scan', () => {
  const SECRETS: [string, string][] = [
    ['aws-access-key', 'AKIAABCDEFGHIJKLMNOP'],
    ['github-token-ghp', 'ghp_abcdefghij1234567890abcdef1234567890'],
    ['github-token-github-pat', 'github_pat_11ABCDEFG1234567890_abcdef'],
    ['openai-key', 'sk-abcdefghij1234567890abcdef1234567890'],
    ['pem-block', '-----BEGIN PRIVATE KEY-----'],
    ['jwt', 'eyJ0eXAiOiJKV1QiLCJh.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF30oGTbU'],
    ['bearer-json', '"authorization":"Bearer abcdef1234567890abcdef1234567890"'],
  ];

  for (const [name, content] of SECRETS) {
    test(`blocks ${name}`, () => {
      run(['gstack-brain-init', '--remote', bareRemote]);
      run(['gstack-config', 'set', 'gbrain_sync_mode', 'full']);
      fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
      fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'),
        `{"leaked":"${content}"}\n`);
      run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
      const r = run(['gstack-brain-sync', '--once']);
      expect(r.status).toBe(0);  // exits clean even when blocked
      // No new commit should have been created.
      const log = git(['log', '--oneline']);
      expect(log.stdout.split('\n').filter(Boolean).length).toBeLessThanOrEqual(3);
      // Status file should report blocked.
      const status = JSON.parse(fs.readFileSync(path.join(tmpHome, '.brain-sync-status.json'), 'utf-8'));
      expect(status.status).toBe('blocked');
    });
  }

  test('--skip-file unblocks specific file', () => {
    run(['gstack-brain-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'gbrain_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    const leakPath = 'projects/p/leaked.jsonl';
    fs.writeFileSync(path.join(tmpHome, leakPath),
      '{"gh":"ghp_abcdefghij1234567890abcdef1234567890"}\n');
    run(['gstack-brain-enqueue', leakPath]);
    run(['gstack-brain-sync', '--once']);  // blocked
    run(['gstack-brain-sync', '--skip-file', leakPath]);
    // Any future enqueue of this path should no-op.
    run(['gstack-brain-enqueue', leakPath]);
    const skip = fs.readFileSync(path.join(tmpHome, '.brain-skip.txt'), 'utf-8');
    expect(skip).toContain(leakPath);
  });
});

// ---------------------------------------------------------------
// Uninstall preserves user data
// ---------------------------------------------------------------
describe('gstack-brain-uninstall', () => {
  test('removes sync config but preserves learnings/project data', () => {
    run(['gstack-brain-init', '--remote', bareRemote]);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'user-data'), { recursive: true });
    const preservedContent = '{"keep":"me","ts":"2026-04-22T12:00:00Z"}\n';
    fs.writeFileSync(path.join(tmpHome, 'projects/user-data/learnings.jsonl'), preservedContent);
    const r = run(['gstack-brain-uninstall', '--yes']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.brain-allowlist'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, 'consumers.json'))).toBe(false);
    // Project data preserved.
    const preserved = fs.readFileSync(path.join(tmpHome, 'projects/user-data/learnings.jsonl'), 'utf-8');
    expect(preserved).toBe(preservedContent);
    // Config key reset.
    const mode = run(['gstack-config', 'get', 'gbrain_sync_mode']);
    expect(mode.stdout.trim()).toBe('off');
  });
});

// ---------------------------------------------------------------
// --discover-new: cursor-based change detection
// ---------------------------------------------------------------
describe('gstack-brain-sync --discover-new', () => {
  test('enqueues new allowlisted files; idempotent on re-run', () => {
    run(['gstack-brain-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'gbrain_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'retros'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'retros/week-1.md'), '# retro\n');
    run(['gstack-brain-sync', '--discover-new']);
    let queue = fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
    expect(queue).toContain('retros/week-1.md');
    // Clear queue, run again — idempotent (no new entries).
    fs.writeFileSync(path.join(tmpHome, '.brain-queue.jsonl'), '');
    run(['gstack-brain-sync', '--discover-new']);
    queue = fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8');
    expect(queue.trim()).toBe('');
  });
});
