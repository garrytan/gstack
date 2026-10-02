/**
 * gbrain-sync integration tests.
 *
 * Covers the core cross-machine memory sync feature end-to-end:
 *   - bin/gstack-config gbrain keys (validation, isolation)
 *   - bin/gstack-brain-enqueue (atomicity, skip list, no-op gates)
 *   - bin/gstack-jsonl-merge (3-way, ts-sort, hash-fallback)
 *   - bin/gstack-brain-sync --once (drain, commit, push, secret-scan, skip-file)
 *   - bin/gstack-artifacts-init + --restore round-trip
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
import { createHash } from 'crypto';
import { canRevokeWrites } from './helpers/fs-caps';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpHome: string;
let bareRemote: string;

function run(argv: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  const bin = argv[0];
  const full = bin.startsWith('/') ? bin : path.join(BIN, bin);
  const res = spawnSync(full, argv.slice(1), {
    // HOME is overridden too: gstack-artifacts-init writes
    // $HOME/.gstack-artifacts-remote.txt (plain $HOME, not GSTACK_HOME), so
    // without this every free-suite run clobbers the operator's real
    // artifacts-remote pointer. Keep it inside tmpHome, which afterEach removes.
    env: { ...process.env, HOME: tmpHome, GSTACK_HOME: tmpHome, ...(opts.env || {}) },
    encoding: 'utf-8',
    input: opts.input,
    cwd: ROOT,
    timeout: 30_000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

function git(args: string[], cwd?: string) {
  const res = spawnSync('git', args, { cwd: cwd || tmpHome, encoding: 'utf-8', timeout: 30_000 });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

// ---- spool helpers (maildir-style queue: one FILE per record) ----
// Writers create <epoch>-<pid>-<uniq>.json under .brain-queue.d/ via tmp +
// atomic rename; the drain deletes exactly the files it snapshotted. The
// legacy single-file .brain-queue.jsonl exists only as a migration source.
const spoolDir = () => path.join(tmpHome, '.brain-queue.d');
const spoolFiles = () =>
  fs.existsSync(spoolDir())
    ? fs.readdirSync(spoolDir()).filter((f) => f.endsWith('.json')).sort()
    : [];
const spoolText = () =>
  spoolFiles()
    .map((f) => fs.readFileSync(path.join(spoolDir(), f), 'utf-8'))
    .join('');
let spoolSeq = 0;
function seedSpool(record: string): string {
  fs.mkdirSync(spoolDir(), { recursive: true });
  spoolSeq += 1;
  const name = `${Math.floor(Date.now() / 1000)}-${process.pid}-t${spoolSeq}.json`;
  fs.writeFileSync(path.join(spoolDir(), name), record.endsWith('\n') ? record : record + '\n');
  return name;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sync-home-'));
  bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sync-remote-'));
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', bareRemote], { timeout: 30_000 });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(bareRemote, { recursive: true, force: true });
  // Clean up any remote-helper file init may have written. run() now pins
  // HOME to tmpHome so these land inside the removed temp dir, but scrub the
  // real home too as defense in depth — and cover BOTH the legacy brain-remote
  // name and the current artifacts-remote name (init writes the latter).
  for (const name of ['.gstack-brain-remote.txt', '.gstack-artifacts-remote.txt']) {
    const remoteFile = path.join(os.homedir(), name);
    // Only remove if it points at OUR bare remote (don't clobber a real user file).
    try {
      const contents = fs.readFileSync(remoteFile, 'utf-8').trim();
      if (contents === bareRemote) fs.unlinkSync(remoteFile);
    } catch {}
  }
});

// ---------------------------------------------------------------
// Config key validation + env isolation
// ---------------------------------------------------------------
describe('gstack-config gbrain keys', () => {
  test('default artifacts_sync_mode is off', () => {
    const r = run(['gstack-config', 'get', 'artifacts_sync_mode']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('off');
  });

  test('default artifacts_sync_mode_prompted is false', () => {
    const r = run(['gstack-config', 'get', 'artifacts_sync_mode_prompted']);
    expect(r.stdout.trim()).toBe('false');
  });

  test('accepts full / artifacts-only / off', () => {
    for (const val of ['full', 'artifacts-only', 'off']) {
      const set = run(['gstack-config', 'set', 'artifacts_sync_mode', val]);
      expect(set.status).toBe(0);
      const get = run(['gstack-config', 'get', 'artifacts_sync_mode']);
      expect(get.stdout.trim()).toBe(val);
    }
  });

  test('invalid artifacts_sync_mode value warns + defaults', () => {
    const r = run(['gstack-config', 'set', 'artifacts_sync_mode', 'bogus']);
    expect(r.stderr).toContain('not recognized');
    const get = run(['gstack-config', 'get', 'artifacts_sync_mode']);
    expect(get.stdout.trim()).toBe('off');
  });

  test('artifacts_sync_removals defaults to off and accepts only on/off', () => {
    expect(run(['gstack-config', 'get', 'artifacts_sync_removals']).stdout.trim()).toBe('off');
    expect(run(['gstack-config', 'set', 'artifacts_sync_removals', 'on']).status).toBe(0);
    expect(run(['gstack-config', 'get', 'artifacts_sync_removals']).stdout.trim()).toBe('on');
    const bad = run(['gstack-config', 'set', 'artifacts_sync_removals', 'yes']);
    expect(bad.stderr).toContain('not recognized');
    expect(run(['gstack-config', 'get', 'artifacts_sync_removals']).stdout.trim()).toBe('off');
  });

  test('artifacts_sync_removals_max defaults to 20 and a non-integer becomes 0', () => {
    expect(run(['gstack-config', 'get', 'artifacts_sync_removals_max']).stdout.trim()).toBe('20');
    expect(run(['gstack-config', 'set', 'artifacts_sync_removals_max', '7']).status).toBe(0);
    expect(run(['gstack-config', 'get', 'artifacts_sync_removals_max']).stdout.trim()).toBe('7');
    const bad = run(['gstack-config', 'set', 'artifacts_sync_removals_max', '-3']);
    expect(bad.stderr).toContain('not a non-negative integer');
    expect(run(['gstack-config', 'get', 'artifacts_sync_removals_max']).stdout.trim()).toBe('0');
  });

  test('GSTACK_HOME overrides real config dir', () => {
    // Real ~/.gstack/config.yaml must not change, regardless of what it
    // already contains on the developer's machine.
    const realConfig = path.join(os.homedir(), '.gstack', 'config.yaml');
    const before = fs.existsSync(realConfig) ? fs.readFileSync(realConfig, 'utf-8') : null;

    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);

    // The override actually took effect — temp config got the new value.
    const tempConfig = fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8');
    expect(tempConfig).toContain('artifacts_sync_mode: full');

    // Real ~/.gstack/config.yaml must not be touched.
    const after = fs.existsSync(realConfig) ? fs.readFileSync(realConfig, 'utf-8') : null;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------
// Enqueue behavior
// ---------------------------------------------------------------
describe('gstack-brain-enqueue', () => {
  test('no-op when feature not initialized', () => {
    const r = run(['gstack-brain-enqueue', 'projects/foo/learnings.jsonl']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(spoolDir())).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.brain-queue.jsonl'))).toBe(false);
  });

  test('no-op when mode is off (even if .git exists)', () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    const r = run(['gstack-brain-enqueue', 'projects/foo/learnings.jsonl']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(spoolDir())).toBe(false);
  });

  test('enqueues one spool file when mode is full and .git exists', () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    run(['gstack-brain-enqueue', 'projects/foo/learnings.jsonl']);
    const files = spoolFiles();
    expect(files.length).toBe(1);
    // Sortable maildir name: <epoch>-<pid>-<uniq>.json.
    expect(files[0]).toMatch(/^\d+-\d+-\d+\.json$/);
    const obj = JSON.parse(fs.readFileSync(path.join(spoolDir(), files[0]), 'utf-8').trim());
    expect(obj.file).toBe('projects/foo/learnings.jsonl');
    expect(obj.ts).toBeTruthy();
    // No tmp-file droppings left behind.
    expect(fs.readdirSync(spoolDir()).filter((f) => f.startsWith('.tmp-')).length).toBe(0);
  });

  test('skip list honored', () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.writeFileSync(path.join(tmpHome, '.brain-skip.txt'), 'projects/foo/secret.jsonl\n');
    run(['gstack-brain-enqueue', 'projects/foo/secret.jsonl']);
    run(['gstack-brain-enqueue', 'projects/foo/ok.jsonl']);
    expect(spoolText()).not.toContain('secret.jsonl');
    expect(spoolText()).toContain('ok.jsonl');
  });

  test('concurrent enqueues all land (one spool file per record)', async () => {
    fs.mkdirSync(path.join(tmpHome, '.git'), { recursive: true });
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    const procs = [];
    for (let i = 0; i < 10; i++) {
      procs.push(new Promise<void>((resolve) => {
        const r = spawnSync(path.join(BIN, 'gstack-brain-enqueue'), [`file-${i}.jsonl`], {
          env: { ...process.env, GSTACK_HOME: tmpHome },
          encoding: 'utf-8',
          timeout: 30_000,
        });
        resolve();
      }));
    }
    await Promise.all(procs);
    expect(spoolFiles().length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(spoolText()).toContain(`file-${i}.jsonl`);
    }
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
    const again = spawnSync(path.join(BIN, 'gstack-jsonl-merge'), [base, ours, theirs], { timeout: 30_000 });
    // (re-running doesn't change the order since same input → same output)
  });
});

// ---------------------------------------------------------------
// Init + sync + restore round-trip
// ---------------------------------------------------------------
describe('init + sync + restore round-trip', () => {
  test('init creates canonical files + registers drivers', () => {
    const r = run(['gstack-artifacts-init', '--remote', bareRemote]);
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
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    const otherRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-other-'));
    spawnSync('git', ['init', '--bare', '-q', '-b', 'main', otherRemote], { timeout: 30_000 });
    const r = run(['gstack-artifacts-init', '--remote', otherRemote]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('already a git repo pointing at');
    fs.rmSync(otherRemote, { recursive: true, force: true });
  });

  test('full sync: init → enqueue → --once → commit pushed', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'),
      '{"skill":"x","insight":"y","ts":"2026-04-22T10:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    // Check the remote got the commit.
    const log = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8', timeout: 30_000 });
    expect(log.stdout).toMatch(/sync: 1 file/);
  });

  test('restore round-trip: writes on machine A visible on machine B', () => {
    // Machine A.
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
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
    const cfg = spawnSync('git', ['-C', machineB, 'config', '--get', 'merge.jsonl-append.driver'], { encoding: 'utf-8', timeout: 30_000 });
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
      run(['gstack-artifacts-init', '--remote', bareRemote]);
      run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
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
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
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
// Egress receipt gate: receipt-before-commit, queue intact on refusal
// ---------------------------------------------------------------
describe('gstack-brain-sync egress receipt gate', () => {
  test('refused receipt leaves the queue intact, makes no commit, and next run retries', () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'),
      '{"skill":"x","insight":"y","ts":"2026-04-22T10:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const commitsBefore = git(['rev-list', '--count', 'HEAD']).stdout.trim();

    // Make the receipt unwritable: security dir exists but is read-only.
    // (artifacts-init may have created it already — mkdirSync's mode is a
    // no-op on an existing dir, so chmod explicitly.)
    fs.mkdirSync(path.join(tmpHome, 'security'), { recursive: true });
    fs.chmodSync(path.join(tmpHome, 'security'), 0o500);
    try {
      const refused = run(['gstack-brain-sync', '--once']);
      expect(refused.status).toBe(1);
      // DX contract: problem + cause + fix, plain language.
      expect(refused.stderr).toContain('NOT sent');
      expect(refused.stderr).toContain('EGRESS_RECEIPT_FAILED');
      expect(refused.stderr).toContain('Fix: chmod -R u+w');
      expect(refused.stderr).toContain('ATTEMPTS to send off-machine');
      // Spool intact (receipt is written BEFORE finalize consumes records).
      expect(spoolText()).toContain('projects/p/learnings.jsonl');
      // No local commit was created.
      expect(git(['rev-list', '--count', 'HEAD']).stdout.trim()).toBe(commitsBefore);
      // Nothing reached the remote.
      const remoteLog = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8', timeout: 30_000 });
      expect(remoteLog.stdout).not.toMatch(/sync: 1 file/);
      const status = JSON.parse(fs.readFileSync(path.join(tmpHome, '.brain-sync-status.json'), 'utf-8'));
      expect(status.status).toBe('push_failed');
      expect(status.message).toContain('EGRESS_RECEIPT_FAILED');
    } finally {
      fs.chmodSync(path.join(tmpHome, 'security'), 0o700);
    }

    // Next run (ledger writable again) drains the intact queue and pushes.
    const retry = run(['gstack-brain-sync', '--once']);
    expect(retry.status).toBe(0);
    const log = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8', timeout: 30_000 });
    expect(log.stdout).toMatch(/sync: 1 file/);
  });

  test('successful push writes a git-class receipt before the send', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'),
      '{"skill":"x","insight":"y","ts":"2026-04-22T10:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    const ledger = fs.readFileSync(path.join(tmpHome, 'security', 'egress.jsonl'), 'utf-8');
    const records = ledger.trim().split('\n').map((l) => JSON.parse(l));
    const pushReceipt = records.find((rec) => rec.sink === 'brain-sync' && rec.payload_class === 'curated-memory-git-push');
    expect(pushReceipt).toBeTruthy();
    expect(pushReceipt.sha256).toBeNull(); // git owns the bytes
  });
});

// ---------------------------------------------------------------
// Uninstall preserves user data
// ---------------------------------------------------------------
describe('gstack-brain-uninstall', () => {
  test('removes sync config but preserves learnings/project data', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
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
    const mode = run(['gstack-config', 'get', 'artifacts_sync_mode']);
    expect(mode.stdout.trim()).toBe('off');
  });
});

// ---------------------------------------------------------------
// --discover-new: cursor-based change detection
// ---------------------------------------------------------------
describe('gstack-brain-sync --discover-new', () => {
  test('enqueues new allowlisted files as spool records; idempotent on re-run', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'retros'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'retros/week-1.md'), '# retro\n');
    run(['gstack-brain-sync', '--discover-new']);
    expect(spoolText()).toContain('retros/week-1.md');
    // Clear the spool, run again — idempotent (no new records).
    for (const f of spoolFiles()) fs.unlinkSync(path.join(spoolDir(), f));
    run(['gstack-brain-sync', '--discover-new']);
    expect(spoolFiles().length).toBe(0);
  });
});

// ---------------------------------------------------------------
// Removals: a tracked allowlisted file gone from disk (deleted, or moved by
// a slug migration). Off by default: listed, never published unasked. On:
// published in a commit of its own, with valves that hold what looks like a
// loss. Merges keep an edit over a removal and abort anything else.
// ---------------------------------------------------------------
describe('gstack-brain-sync removals', () => {
  const HELD = () => path.join(tmpHome, '.brain-held-removals.json');
  function initFull(removals?: 'on' | 'off') {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    if (removals) run(['gstack-config', 'set', 'artifacts_sync_removals', removals]);
  }
  const realGit = () => spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).stdout.trim();
  // A git on PATH that runs `script` (sh) around the real one; the script sees
  // the arguments as "$@" and the real git as $REAL.
  function fakeGit(dir: string, before: string, after = '') {
    const bin = path.join(dir, 'fakebin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'git'),
      `#!/bin/sh\nREAL='${realGit()}'\n${before}\n"$REAL" "$@"\nrc=$?\n${after}\nexit $rc\n`, { mode: 0o755 });
    return `${bin}:${process.env.PATH}`;
  }
  const statusJson = (home = tmpHome) => JSON.parse(fs.readFileSync(path.join(home, '.brain-sync-status.json'), 'utf-8'));
  function removalStatus() {
    const lines = run(['gstack-brain-sync', '--status']).stdout.trim().split('\n');
    const { removals, removals_pending, removals_held } = JSON.parse(lines[lines.length - 1]);
    return { removals, removals_pending, removals_held };
  }
  const remoteFiles = () =>
    spawnSync('git', ['--git-dir=' + bareRemote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf-8', timeout: 30_000 })
      .stdout.split('\n').filter(Boolean);
  const remoteLog = () =>
    spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--format=%s', 'main'], { encoding: 'utf-8', timeout: 30_000 }).stdout;
  const remoteShow = (rel: string) =>
    spawnSync('git', ['--git-dir=' + bareRemote, 'show', `main:${rel}`], { encoding: 'utf-8', timeout: 30_000 }).stdout;
  const trackedFiles = (home = tmpHome) => git(['ls-files'], home).stdout.split('\n').filter(Boolean);
  function write(rel: string, body = `# ${rel}\n`, home = tmpHome) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), body);
  }
  function syncAll(env?: Record<string, string>) {
    const d = run(['gstack-brain-sync', '--discover-new'], { env });
    expect(d.status).toBe(0);
    const o = run(['gstack-brain-sync', '--once'], { env });
    expect(o.status).toBe(0);
    return o;
  }
  function commitDirectly(rel: string, message: string) {
    git(['add', '-f', rel]);
    // --no-verify: stands for a file published before the scanners existed.
    expect(git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-verify', '-m', message]).status).toBe(0);
    expect(git(['push', '-q', 'origin', 'HEAD']).status).toBe(0);
  }
  const spoolPaths = () => spoolFiles().map((f) => JSON.parse(fs.readFileSync(path.join(spoolDir(), f), 'utf-8')).file).sort();

  test('off by default: a deleted file stays published, and --status and --list-removals report it', () => {
    initFull();
    const settings = fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8').split('\n').filter((l) => !l.startsWith('#'));
    expect(settings).toContain('artifacts_sync_mode: full');
    expect(settings.filter((l) => l.startsWith('artifacts_sync_removals'))).toEqual([]);
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    expect(run(['gstack-brain-sync', '--discover-new']).status).toBe(0);
    expect(spoolPaths()).toEqual([]);
    syncAll();
    expect(statusJson().message).toBe('queue empty');
    expect(remoteFiles()).toContain('projects/p/designs/a.md');
    expect(trackedFiles()).toContain('projects/p/designs/a.md');
    expect(spoolPaths()).toEqual([]);
    expect(removalStatus()).toEqual({ removals: 'off', removals_pending: 1, removals_held: 0 });
    const list = run(['gstack-brain-sync', '--list-removals']);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('projects/p/designs/a.md  [not published (artifacts_sync_removals=off)]');
  });

  test('on: a deleted file is removed from the repo and the remote, in a commit of its own', () => {
    initFull('on');
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    write('projects/p/designs/b.md', '# b, edited\n');
    syncAll();
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
    expect(remoteShow('projects/p/designs/b.md')).toBe('# b, edited\n');
    const subjects = remoteLog().split('\n');
    expect(subjects[0]).toMatch(/^sync: 1 file\(s\) \|/);
    expect(subjects[1]).toMatch(/^sync: remove 1 file\(s\) \|/);
    expect(statusJson().message).toBe('pushed 1 file(s) and 1 removal(s)');
    expect(spoolPaths()).toEqual([]);
    expect(removalStatus()).toEqual({ removals: 'on', removals_pending: 0, removals_held: 0 });
    expect(run(['gstack-brain-sync', '--list-removals']).stdout.trim()).toBe('no removals pending');
  });

  test('on: a moved project publishes its new files and holds the old ones until --publish-removals', () => {
    initFull('on');
    write('projects/old/designs/x.md');
    write('projects/old/designs/y.md');
    syncAll();
    fs.renameSync(path.join(tmpHome, 'projects/old'), path.join(tmpHome, 'projects/new'));
    syncAll();
    const files = remoteFiles();
    expect(files).toContain('projects/new/designs/x.md');
    expect(files).toContain('projects/old/designs/x.md');
    expect(statusJson().message).toBe('pushed 2 file(s) (2 removal(s) held for review (gstack-brain-sync --list-removals))');
    expect(remoteLog()).not.toContain('sync: remove');
    const list = run(['gstack-brain-sync', '--list-removals']).stdout;
    expect(list).toContain('projects/old/designs/x.md  [held: would remove every synced file of projects/old]');
    expect(JSON.parse(fs.readFileSync(HELD(), 'utf-8')).held['projects/old/designs/y.md']).toBe('would remove every synced file of projects/old');
    if (process.platform !== 'win32') expect(fs.statSync(HELD()).mode & 0o777).toBe(0o600);
    // Held records stay queued once, however often discovery runs.
    expect(run(['gstack-brain-sync', '--discover-new']).status).toBe(0);
    expect(spoolPaths()).toEqual(['projects/old/designs/x.md', 'projects/old/designs/y.md']);
    expect(removalStatus()).toEqual({ removals: 'on', removals_pending: 2, removals_held: 2 });
    // Dry run first.
    const dry = run(['gstack-brain-sync', '--publish-removals']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('dry run');
    expect(remoteFiles()).toContain('projects/old/designs/x.md');
    const pub = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(pub.status).toBe(0);
    expect(pub.stdout).toContain('published 2 removal(s)');
    expect(pub.stderr).toBe('');
    expect(fs.existsSync(path.join(tmpHome, '.brain-sync.lock.d'))).toBe(false);
    expect(remoteFiles().filter((f) => f.startsWith('projects/old/'))).toEqual([]);
    expect(spoolPaths()).toEqual([]);
    expect(fs.existsSync(HELD())).toBe(false);
    expect(statusJson().message).toBe('published 2 removal(s)');
  });

  test('on: more removals than artifacts_sync_removals_max are held until the cap allows them', () => {
    initFull('on');
    for (const p of ['a', 'b', 'c']) { write(`projects/${p}/designs/1.md`); write(`projects/${p}/designs/2.md`); }
    run(['gstack-config', 'set', 'artifacts_sync_removals_max', '2']);
    syncAll();
    for (const p of ['a', 'b', 'c']) fs.unlinkSync(path.join(tmpHome, `projects/${p}/designs/1.md`));
    syncAll();
    expect(remoteFiles()).toContain('projects/a/designs/1.md');
    expect(statusJson().message).toBe('no stageable changes (3 removal(s) held for review (gstack-brain-sync --list-removals))');
    expect(run(['gstack-brain-sync', '--list-removals']).stdout).toContain('[held: more than 2 removals in one run]');
    run(['gstack-config', 'set', 'artifacts_sync_removals_max', '3']);
    syncAll();
    expect(remoteFiles().filter((f) => f.endsWith('/1.md'))).toEqual([]);
    expect(remoteFiles().filter((f) => f.endsWith('/2.md')).length).toBe(3);
    expect(fs.existsSync(HELD())).toBe(false);
  });

  function seedProjects(count: number, each: number) {
    for (let i = 0; i < count; i++) for (let j = 0; j < each; j++) write(`projects/p${i}/designs/${j}.md`);
  }

  test('on: removing a quarter of the synced files, once more than 5, is held even under the cap', () => {
    initFull('on');
    seedProjects(6, 4);
    syncAll();
    for (let i = 0; i < 6; i++) fs.unlinkSync(path.join(tmpHome, `projects/p${i}/designs/0.md`));
    syncAll();
    expect(remoteFiles().filter((f) => f.endsWith('/0.md')).length).toBe(6);
    // Exactly a quarter: 6 of 24.
    expect(run(['gstack-brain-sync', '--list-removals']).stdout).toContain('[held: 6 of 24 synced files at once]');
  });

  test('on: five removals are published even when they are a quarter of the synced files', () => {
    initFull('on');
    seedProjects(5, 4);
    syncAll();
    for (let i = 0; i < 5; i++) fs.unlinkSync(path.join(tmpHome, `projects/p${i}/designs/0.md`));
    syncAll();
    expect(remoteFiles().filter((f) => f.startsWith('projects/')).length).toBe(15);
    expect(remoteFiles().filter((f) => f.endsWith('/0.md'))).toEqual([]);
    expect(statusJson().message).toBe('pushed 5 removal(s)');
  });

  test('on: a removal is held, not dropped, while git cannot list the repo', () => {
    if (process.platform === 'win32') return;
    initFull('on');
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    expect(run(['gstack-brain-sync', '--discover-new']).status).toBe(0);
    expect(spoolPaths()).toEqual(['projects/p/designs/a.md']);
    // A git whose ls-files fails, every other command intact.
    const PATH = fakeGit(tmpHome, 'for a in "$@"; do [ "$a" = ls-files ] && exit 1; done');
    expect(run(['gstack-brain-sync', '--once'], { env: { PATH } }).status).toBe(0);
    expect(statusJson().message).toBe('no stageable changes (1 removal(s) held for review (gstack-brain-sync --list-removals))');
    expect(spoolPaths()).toEqual(['projects/p/designs/a.md']);
    expect(run(['gstack-brain-sync', '--list-removals']).stdout).toContain('projects/p/designs/a.md  [held: git state unreadable]');
    syncAll();
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
  });

  test('on: a file that comes back mid-sync is not published by the removal commit', () => {
    if (process.platform === 'win32') return;
    initFull('on');
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    const target = path.join(tmpHome, 'projects/p/designs/a.md');
    fs.unlinkSync(target);
    expect(run(['gstack-brain-sync', '--discover-new']).status).toBe(0);
    // A git that re-creates a.md, with a secret in it, right before it builds
    // or makes a commit.
    const PATH = fakeGit(tmpHome,
      `for a in "$@"; do case "$a" in update-index|commit) printf 'key AKIAABCDEFGHIJKLMNOP\\n' > '${target}';; esac; done`);
    expect(run(['gstack-brain-sync', '--once'], { env: { PATH } }).status).toBe(0);
    expect(fs.readFileSync(target, 'utf-8')).toBe('key AKIAABCDEFGHIJKLMNOP\n');
    expect(statusJson().message).toBe('pushed 1 removal(s)');
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
    const history = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '-p', 'main'], { encoding: 'utf-8' }).stdout;
    expect(history).toContain('sync: remove 1 file(s)');
    expect(history).not.toContain('AKIA');
  });

  test('on: a removal commit takes its paths literally', () => {
    if (process.platform === 'win32') return;
    initFull('on');
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    write('projects/p/designs/*.md', '# star\n');
    syncAll();
    expect(remoteFiles()).toContain('projects/p/designs/*.md');
    // An edit nobody queued (skip-listed): no commit may pick it up.
    run(['gstack-brain-sync', '--skip-file', 'projects/p/designs/a.md']);
    write('projects/p/designs/a.md', '# a, private edit\n');
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/*.md'));
    syncAll();
    expect(statusJson().message).toBe('pushed 1 removal(s)');
    expect(remoteFiles()).not.toContain('projects/p/designs/*.md');
    expect(remoteShow('projects/p/designs/a.md')).toBe('# projects/p/designs/a.md\n');
    expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
  });

  test('on: an unreadable artifacts_sync_removals_max holds every removal', () => {
    initFull('on');
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    fs.appendFileSync(path.join(tmpHome, 'config.yaml'), 'artifacts_sync_removals_max: lots\n');
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    syncAll();
    expect(remoteFiles()).toContain('projects/p/designs/a.md');
    expect(run(['gstack-brain-sync', '--list-removals']).stdout).toContain('[held: more than 0 removals in one run]');
  });

  test('on: removals are level-triggered, so a dropped queue is rebuilt', () => {
    initFull('on');
    run(['gstack-config', 'set', 'artifacts_sync_removals_max', '0']);
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    syncAll();
    expect(spoolPaths()).toEqual(['projects/p/designs/a.md']);
    expect(run(['gstack-brain-sync', '--drop-queue', '--yes']).status).toBe(0);
    expect(spoolPaths()).toEqual([]);
    expect(run(['gstack-brain-sync', '--discover-new']).status).toBe(0);
    expect(run(['gstack-brain-sync', '--discover-new']).status).toBe(0);
    expect(spoolPaths()).toEqual(['projects/p/designs/a.md']);
  });

  test('on: a file restored unchanged after its removal was published is published again', () => {
    initFull('on');
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    const full = path.join(tmpHome, 'projects/p/designs/a.md');
    const { mtime } = fs.statSync(full);
    fs.unlinkSync(full);
    syncAll();
    expect(statusJson().message).toBe('pushed 1 removal(s)');
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
    write('projects/p/designs/a.md');
    fs.utimesSync(full, mtime, mtime);  // same size and mtime as the cursor saw
    syncAll();
    expect(remoteFiles()).toContain('projects/p/designs/a.md');
  });

  test('on: an already-published file that matches a secret pattern is removed, even past an old-style hook', () => {
    initFull('on');
    write('projects/p/designs/keep.md');
    write('projects/p/designs/leak.md', 'token eyJ0eXAiOiJKV1QiLCJh.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF30oGTbU\n');
    commitDirectly('projects/p/designs/keep.md', 'keep');
    commitDirectly('projects/p/designs/leak.md', 'legacy publish');
    // A hook installed before removal support: it scans the whole staged diff.
    fs.writeFileSync(path.join(tmpHome, '.git/hooks/pre-commit'),
      "#!/bin/sh\nif git diff --cached | grep -q eyJ0eXAi; then echo 'old hook: jwt' >&2; exit 1; fi\nexit 0\n");
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/leak.md'));
    syncAll();
    expect(statusJson().status).toBe('ok');
    expect(remoteFiles()).not.toContain('projects/p/designs/leak.md');
  });

  test('--publish-removals removes an already-published secret-matching file past an old-style hook', () => {
    initFull();
    write('projects/p/designs/keep.md');
    write('projects/p/designs/leak.md', 'token eyJ0eXAiOiJKV1QiLCJh.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF30oGTbU\n');
    commitDirectly('projects/p/designs/keep.md', 'keep');
    commitDirectly('projects/p/designs/leak.md', 'legacy publish');
    fs.writeFileSync(path.join(tmpHome, '.git/hooks/pre-commit'),
      "#!/bin/sh\nif git diff --cached | grep -q eyJ0eXAi; then echo 'old hook: jwt' >&2; exit 1; fi\nexit 0\n");
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/leak.md'));
    const pub = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(pub.status).toBe(0);
    expect(remoteFiles()).not.toContain('projects/p/designs/leak.md');
  });

  test('off: a queued file deleted just before staging is not published as a removal', () => {
    if (process.platform === 'win32') return;
    initFull();
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    write('projects/p/designs/a.md', '# a, edited\n');
    write('projects/p/designs/b.md', '# b, edited\n');
    expect(run(['gstack-brain-sync', '--discover-new']).status).toBe(0);
    // A git that deletes a.md right before every `git add`.
    const target = path.join(tmpHome, 'projects/p/designs/a.md');
    const PATH = fakeGit(tmpHome, `for a in "$@"; do [ "$a" = add ] && rm -f '${target}'; done`);
    expect(run(['gstack-brain-sync', '--once'], { env: { PATH } }).status).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(remoteShow('projects/p/designs/b.md')).toBe('# b, edited\n');
    expect(remoteShow('projects/p/designs/a.md')).toBe('# projects/p/designs/a.md\n');
  });

  test('off: a removal staged by hand is committed with the next sync, as before', () => {
    initFull();
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    git(['rm', '-q', 'projects/p/designs/a.md']);
    write('projects/p/designs/b.md', '# b, edited\n');
    syncAll();
    expect(statusJson().status).toBe('ok');
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
  });

  test('on: a removal nobody approved stops the drain and commits nothing', () => {
    initFull('on');
    for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    git(['rm', '-q', '--cached', 'projects/p/designs/b.md']);  // staged by hand, file still on disk
    const before = remoteLog();
    const o = syncAll();
    expect(statusJson().status).toBe('blocked');
    expect(statusJson().message).toBe('staged removals differ from the approved set; nothing committed (queue preserved)');
    expect(o.stderr).toContain('BRAIN_SYNC: blocked: staged removals differ from the approved set');
    expect(remoteLog()).toBe(before);
    expect(spoolPaths()).toContain('projects/p/designs/a.md');
    expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('projects/p/designs/b.md');
  });

  test('a queued name that matches no file is dropped, never read as a pattern or a removal', () => {
    initFull('on');
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    write('projects/p/designs/a.md', '# a, edited\n');
    seedSpool('{"file":"projects/p/designs/*.md"}');
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    expect(statusJson().message).toBe('no stageable changes (1 missing dropped)');
    expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
    expect(remoteShow('projects/p/designs/a.md')).toBe('# projects/p/designs/a.md\n');
  });

  test('on: skip-listed, non-allowlisted, .brain-* and dangling-symlink paths are never removed', () => {
    initFull('on');
    fs.appendFileSync(path.join(tmpHome, '.brain-allowlist'), 'private/*.md\n.brain-*\n');
    for (const rel of ['projects/p/designs/a.md', 'projects/p/designs/b.md', 'projects/p/designs/skipped.md', 'private/notes.md']) write(rel);
    syncAll();
    fs.writeFileSync(path.join(tmpHome, '.brain-allowlist'),
      fs.readFileSync(path.join(tmpHome, '.brain-allowlist'), 'utf-8').replace('private/*.md\n', ''));
    run(['gstack-brain-sync', '--skip-file', 'projects/p/designs/skipped.md']);
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/skipped.md'));
    fs.unlinkSync(path.join(tmpHome, 'private/notes.md'));
    fs.unlinkSync(path.join(tmpHome, '.brain-privacy-map.json'));
    if (process.platform !== 'win32') {
      write('projects/p/target.txt', 'x\n');
      fs.symlinkSync('../target.txt', path.join(tmpHome, 'projects/p/designs/link.md'));
      commitDirectly('projects/p/designs/link.md', 'link');
      fs.unlinkSync(path.join(tmpHome, 'projects/p/target.txt'));
    }
    syncAll();
    expect(run(['gstack-brain-sync', '--list-removals']).stdout.trim()).toBe('no removals pending');
    const tracked = trackedFiles();
    for (const rel of ['projects/p/designs/skipped.md', 'private/notes.md', '.brain-privacy-map.json']) expect(tracked).toContain(rel);
    if (process.platform !== 'win32') expect(tracked).toContain('projects/p/designs/link.md');
  });

  test('on: removals are held while a merge is in progress', () => {
    initFull('on');
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    fs.writeFileSync(path.join(tmpHome, '.git/MERGE_HEAD'), git(['rev-parse', 'HEAD']).stdout);
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    syncAll();
    const busy = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(busy.status).toBe(1);
    expect(busy.stderr).toContain('a merge or rebase is in progress');
    fs.unlinkSync(path.join(tmpHome, '.git/MERGE_HEAD'));
    expect(remoteFiles()).toContain('projects/p/designs/a.md');
    expect(run(['gstack-brain-sync', '--list-removals']).stdout).toContain('[held: a merge or rebase is in progress]');
    expect(run(['gstack-brain-sync', '--publish-removals', '--yes']).status).toBe(0);
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
  });

  test('--publish-removals works on a subset, refuses unknown paths, and needs sync on', () => {
    initFull();
    for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/b.md'));
    write('projects/p/designs/c.md', '# c, staged by hand\n');
    git(['add', '-f', 'projects/p/designs/c.md']);
    const dirty = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain('the artifacts repo has staged changes');
    git(['reset', '-q', 'HEAD', '--', 'projects/p/designs/c.md']);
    const unknown = run(['gstack-brain-sync', '--publish-removals', '--yes', 'projects/p/designs/zzz.md']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('not a pending removal: projects/p/designs/zzz.md');
    const one = run(['gstack-brain-sync', '--publish-removals', '--yes', 'projects/p/designs/a.md']);
    expect(one.status).toBe(0);
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
    expect(remoteFiles()).toContain('projects/p/designs/b.md');
    expect(remoteLog().split('\n')[0]).toMatch(/^sync: remove 1 file\(s\) \|/);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'off']);
    const off = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(off.status).toBe(1);
    expect(off.stderr).toContain('artifacts sync is off');
  });

  test('a commit the pre-commit hook refuses keeps the queue, unstages, and says why', () => {
    initFull('on');
    write('projects/p/designs/a.md');
    syncAll();
    const hook = path.join(tmpHome, '.git/hooks/pre-commit');
    const original = fs.readFileSync(hook, 'utf-8');
    fs.writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
    write('projects/p/designs/a.md', '# a, edited\n');
    const o = syncAll();
    const s = statusJson();
    expect(s.status).toBe('blocked');
    expect(s.message).toBe('commit refused (hook says no); changes unstaged, queue preserved');
    expect(o.stderr).toContain('BRAIN_SYNC: blocked: commit refused: hook says no');
    expect(spoolPaths()).toEqual(['projects/p/designs/a.md']);
    expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
    fs.writeFileSync(hook, original);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(remoteShow('projects/p/designs/a.md')).toBe('# a, edited\n');
  });

  test('on: more removals than one argument list can carry still list, hold and publish', () => {
    initFull('on');
    // 900 paths of about 200 bytes: the scan's JSON is several times the
    // 131072 bytes Linux allows in one argv string.
    const long = 'x'.repeat(170);
    const dir = path.join(tmpHome, 'projects/big/designs');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 900; i++) fs.writeFileSync(path.join(dir, `${long}-${String(i).padStart(4, '0')}.md`), `# ${i}\n`);
    write('projects/keep/designs/k.md');
    git(['add', '-f', 'projects']);
    expect(git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-verify', '-m', 'bulk']).status).toBe(0);
    expect(git(['push', '-q', 'origin', 'HEAD']).status).toBe(0);
    const pendingBytes = fs.readdirSync(dir).reduce((n, f) => n + `projects/big/designs/${f}`.length + 4, 0);
    expect(pendingBytes).toBeGreaterThan(131072);
    fs.rmSync(dir, { recursive: true });
    write('projects/keep/designs/k.md', '# k, edited\n');
    syncAll();
    expect(remoteShow('projects/keep/designs/k.md')).toBe('# k, edited\n');
    expect(statusJson().message).toBe('pushed 1 file(s) (900 removal(s) held for review (gstack-brain-sync --list-removals))');
    expect(removalStatus()).toEqual({ removals: 'on', removals_pending: 900, removals_held: 900 });
    const list = run(['gstack-brain-sync', '--list-removals']);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('900 tracked file(s) gone from disk');
    const pub = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(pub.status).toBe(0);
    expect(pub.stdout).toContain('published 900 removal(s)');
    expect(remoteFiles().filter((f) => f.startsWith('projects/big/'))).toEqual([]);
    expect(spoolPaths()).toEqual([]);
  });

  test('on: a secret moved to a new path is scanned there, even without the hook', () => {
    initFull('on');
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    write('projects/p/designs/leak.md', 'token eyJ0eXAiOiJKV1QiLCJh.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF30oGTbU\n');
    commitDirectly('projects/p/designs/leak.md', 'legacy publish');
    fs.unlinkSync(path.join(tmpHome, '.git/hooks/pre-commit'));
    fs.renameSync(path.join(tmpHome, 'projects/p/designs/leak.md'), path.join(tmpHome, 'projects/p/designs/moved.md'));
    const before = remoteLog();
    const o = syncAll();
    expect(statusJson().status).toBe('blocked');
    expect(o.stderr).toContain('BRAIN_SYNC: blocked: jwt');
    expect(remoteLog()).toBe(before);
    expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
  });

  test('on: a top-level file, or the only file of a directory, is an ordinary removal', () => {
    initFull('on');
    write('builder-journey.md', '# journey\n');
    write('projects/solo/designs/only.md');
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    for (const rel of ['builder-journey.md', 'projects/solo/designs/only.md']) fs.unlinkSync(path.join(tmpHome, rel));
    syncAll();
    expect(statusJson().message).toBe('pushed 2 removal(s)');
    expect(remoteFiles()).not.toContain('builder-journey.md');
    expect(remoteFiles()).not.toContain('projects/solo/designs/only.md');
    // Two files that are all of their directory are still held.
    for (const rel of ['projects/p/designs/a.md', 'projects/p/designs/b.md']) fs.unlinkSync(path.join(tmpHome, rel));
    syncAll();
    expect(run(['gstack-brain-sync', '--list-removals']).stdout).toContain('[held: would remove every synced file of projects/p]');
  });

  test('on: under artifacts-only, a behavioral file and its removal both stay put', () => {
    initFull('on');
    write('developer-profile.json', '{"a":1}\n');
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    expect(remoteFiles()).toContain('developer-profile.json');
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'artifacts-only']);
    fs.unlinkSync(path.join(tmpHome, 'developer-profile.json'));
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    syncAll();
    expect(remoteFiles()).toContain('developer-profile.json');
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
    expect(removalStatus().removals_pending).toBe(0);
    expect(run(['gstack-brain-sync', '--list-removals']).stdout.trim()).toBe('no removals pending');
    const pub = run(['gstack-brain-sync', '--publish-removals', '--yes', 'developer-profile.json']);
    expect(pub.status).toBe(2);
    expect(pub.stderr).toContain('not a pending removal: developer-profile.json');
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    syncAll();
    expect(remoteFiles()).not.toContain('developer-profile.json');
  });

  test('on: a removal commit git refuses is reported with its reason, and nothing moves', () => {
    initFull('on');
    for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
    syncAll();
    // --no-verify skips hooks, not signing: a signer that fails refuses the commit.
    git(['config', 'commit.gpgsign', 'true']);
    git(['config', 'gpg.program', 'false']);
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    const o = syncAll();
    expect(statusJson().status).toBe('blocked');
    expect(statusJson().message).toMatch(/^removal commit failed \(.*gpg.*\); nothing committed \(queue preserved\)$/);
    expect(o.stderr).toMatch(/BRAIN_SYNC: blocked: removal commit failed: .*gpg/);
    expect(spoolPaths()).toEqual(['projects/p/designs/a.md']);
    expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/b.md'));
    const pub = run(['gstack-brain-sync', '--publish-removals', '--yes', 'projects/p/designs/b.md']);
    expect(pub.status).toBe(1);
    expect(pub.stderr).toMatch(/commit failed \(.*gpg.*\); nothing published/);
    expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
    expect(remoteFiles()).toContain('projects/p/designs/a.md');
    git(['config', '--unset', 'commit.gpgsign']);
    syncAll();
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
    expect(remoteFiles()).not.toContain('projects/p/designs/b.md');
  });

  test('on: held removals are forgotten once nothing holds them', () => {
    initFull('on');
    run(['gstack-config', 'set', 'artifacts_sync_removals_max', '0']);
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    syncAll();
    expect(removalStatus()).toEqual({ removals: 'on', removals_pending: 1, removals_held: 1 });
    // Dropping the queue drops what it held; the removal itself is still pending.
    expect(run(['gstack-brain-sync', '--drop-queue', '--yes']).status).toBe(0);
    expect(fs.existsSync(HELD())).toBe(false);
    expect(removalStatus()).toEqual({ removals: 'on', removals_pending: 1, removals_held: 0 });
    expect(run(['gstack-brain-sync', '--list-removals']).stdout).toContain('projects/p/designs/a.md  [queued at the next --discover-new]');
    // Records removed some other way: the next run's empty-queue path clears the file.
    syncAll();
    expect(removalStatus().removals_held).toBe(1);
    for (const f of spoolFiles()) fs.unlinkSync(path.join(spoolDir(), f));
    expect(run(['gstack-brain-sync', '--list-removals']).stdout).toContain('projects/p/designs/a.md  [queued at the next --discover-new]');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(fs.existsSync(HELD())).toBe(false);
    // An entry for a path that is no longer pending is never counted.
    fs.writeFileSync(HELD(), JSON.stringify({ held: { 'projects/p/designs/a.md': 'stale' } }));
    write('projects/p/designs/a.md');
    expect(removalStatus()).toEqual({ removals: 'on', removals_pending: 0, removals_held: 0 });
  });

  test('--publish-removals takes a stale lock, publishes a path given twice once, and waits for a live one', () => {
    initFull();
    for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
    syncAll();
    const none = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(none.status).toBe(0);
    expect(none.stdout.trim()).toBe('no removals pending');
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    const lock = path.join(tmpHome, '.brain-sync.lock.d');
    fs.mkdirSync(lock);
    const dead = spawnSync('true').pid;
    fs.writeFileSync(path.join(lock, 'pid'), `${dead}\n`);
    const pub = run(['gstack-brain-sync', '--publish-removals', '--yes', 'projects/p/designs/a.md', 'projects/p/designs/a.md']);
    expect(pub.status).toBe(0);
    expect(pub.stdout).toContain('published 1 removal(s)');
    expect(remoteLog().split('\n')[0]).toMatch(/^sync: remove 1 file\(s\) \|/);
    expect(fs.existsSync(lock)).toBe(false);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/b.md'));
    const busy = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(busy.status).toBe(1);
    expect(busy.stderr).toContain('another gstack-brain-sync run holds');
    expect(remoteFiles()).toContain('projects/p/designs/b.md');
    fs.rmSync(lock, { recursive: true });
  });

  test('--publish-removals stopped by a signal after staging leaves the index and the lock as it found them', () => {
    if (process.platform === 'win32') return;
    initFull();
    for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/b.md'));
    // A git that sends TERM to the script as it stages the removals.
    const PATH = fakeGit(tmpHome, 'for a in "$@"; do [ "$a" = update-index ] && kill -TERM "$PPID"; done');
    const pub = run(['gstack-brain-sync', '--publish-removals', '--yes'], { env: { PATH } });
    expect(pub.status).toBe(143);
    expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
    expect(fs.existsSync(path.join(tmpHome, '.brain-sync.lock.d'))).toBe(false);
    expect(remoteFiles()).toContain('projects/p/designs/a.md');
    const again = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('published 2 removal(s)');
  });

  test('on: a drain stopped by a signal after staging leaves the index and the queue for the next run', () => {
    if (process.platform === 'win32') return;
    initFull('on');
    for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    write('projects/p/designs/b.md', '# b, edited\n');
    expect(run(['gstack-brain-sync', '--discover-new']).status).toBe(0);
    const PATH = fakeGit(tmpHome, 'for a in "$@"; do [ "$a" = add ] && kill -TERM "$PPID"; done');
    const o = run(['gstack-brain-sync', '--once'], { env: { PATH } });
    expect(o.status).toBe(143);
    expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
    expect(fs.existsSync(path.join(tmpHome, '.brain-sync.lock.d'))).toBe(false);
    expect(spoolPaths()).toEqual(['projects/p/designs/a.md', 'projects/p/designs/b.md']);
    syncAll();
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
    expect(remoteShow('projects/p/designs/b.md')).toBe('# b, edited\n');
  });

  test('on: a second signal during the cleanup does not cut it short', () => {
    if (process.platform === 'win32') return;
    initFull('on');
    for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    write('projects/p/designs/b.md', '# b, edited\n');
    expect(run(['gstack-brain-sync', '--discover-new']).status).toBe(0);
    // A private removal index left by an earlier stopped run.
    const leftover = path.join(tmpHome, '.git', 'brain-sync-removals.index');
    fs.writeFileSync(leftover, 'stale');
    // TERM once the removal is staged, and TERM again as the cleanup unstages.
    const PATH = fakeGit(tmpHome,
      'case "$*" in *" add -f -- projects/p/designs/a.md"|*" reset -q HEAD -- "*) kill -TERM "$PPID";; esac');
    const o = run(['gstack-brain-sync', '--once'], { env: { PATH } });
    expect(o.status).toBe(143);
    expect(fs.existsSync(path.join(tmpHome, '.brain-sync.lock.d'))).toBe(false);
    expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
    expect(fs.existsSync(leftover)).toBe(false);
    syncAll();
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
  });

  test('--publish-removals writes its egress receipt before committing anything', () => {
    if (!canRevokeWrites()) return;
    initFull();
    for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    const head = git(['rev-parse', 'HEAD']).stdout;
    fs.mkdirSync(path.join(tmpHome, 'security'), { recursive: true });
    fs.chmodSync(path.join(tmpHome, 'security'), 0o500);
    // Record every git subcommand: the refused run must not have staged anything.
    const calls = path.join(tmpHome, 'git-calls.log');
    const PATH = fakeGit(tmpHome, `echo "$*" >> '${calls}'`);
    try {
      const pub = run(['gstack-brain-sync', '--publish-removals', '--yes'], { env: { PATH } });
      expect(pub.status).toBe(1);
      expect(pub.stderr).toContain('brain-sync publish-removals NOT sent');
      expect(git(['rev-parse', 'HEAD']).stdout).toBe(head);
      expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
      const log = fs.readFileSync(calls, 'utf-8');
      expect(log).toContain('ls-files');
      expect(log).not.toContain('update-index');
      expect(log).not.toMatch(/ commit /);
    } finally {
      fs.chmodSync(path.join(tmpHome, 'security'), 0o700);
    }
    expect(run(['gstack-brain-sync', '--publish-removals', '--yes']).status).toBe(0);
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
    // The receipt that let the push go out records how it ended (a receipt's
    // id is the sha256 of its ledger line).
    const lines = fs.readFileSync(path.join(tmpHome, 'security', 'egress.jsonl'), 'utf-8').split('\n').filter(Boolean);
    const pushLine = lines.filter((l) => JSON.parse(l).type === 'egress' && JSON.parse(l).payload_class === 'curated-memory-git-push').pop()!;
    const receiptId = createHash('sha256').update(pushLine).digest('hex');
    const outcomes = lines.map((l) => JSON.parse(l)).filter((r) => r.type === 'outcome' && r.receipt === receiptId);
    expect(outcomes.map((r) => r.status)).toEqual(['exit:0']);
  });

  test('--list-removals says so when artifacts sync is off', () => {
    initFull();
    write('projects/p/designs/a.md');
    write('projects/p/designs/b.md');
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'off']);
    const list = run(['gstack-brain-sync', '--list-removals']);
    expect(list.status).toBe(0);
    expect(list.stdout.trim()).toBe('artifacts sync is off (artifacts_sync_mode=off): nothing is listed or published');
    expect(removalStatus()).toEqual({ removals: 'off', removals_pending: null, removals_held: 0 });
  });

  test('--publish-removals names the reason when the remote refuses the push', () => {
    initFull();
    for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
    syncAll();
    fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
    const hook = path.join(bareRemote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "closed for maintenance" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const pub = run(['gstack-brain-sync', '--publish-removals', '--yes']);
    expect(pub.status).toBe(1);
    expect(statusJson().message).toMatch(/^committed 1 removal\(s\) locally; push failed \(! \[remote rejected\] .*\); a later sync retries it$/);
    expect(pub.stderr).toContain('push failed (! [remote rejected]');
    fs.rmSync(hook);
    // With nothing queued, the next run pushes the waiting commit.
    fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
    expect(statusJson().message).toBe('queue empty');
  });

  test('the pre-commit hook written by init lets a pure removal through and still refuses the text as an addition', () => {
    initFull();
    write('projects/p/designs/leak.md', '-----BEGIN PRIVATE KEY-----\n');
    commitDirectly('projects/p/designs/leak.md', 'legacy publish');
    git(['rm', '-q', 'projects/p/designs/leak.md']);
    expect(git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'remove']).status).toBe(0);
    write('projects/p/designs/again.md', '-----BEGIN PRIVATE KEY-----\n');
    git(['add', '-f', 'projects/p/designs/again.md']);
    const refused = git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('pem-block detected in staged diff');
    // A move is an addition at the new path, not a rename to wave through.
    git(['reset', '-q', 'HEAD', '--', 'projects/p/designs/again.md']);
    write('projects/p/designs/old.md', '-----BEGIN PRIVATE KEY-----\n');
    commitDirectly('projects/p/designs/old.md', 'legacy publish 2');
    git(['mv', 'projects/p/designs/old.md', 'projects/p/designs/new.md']);
    const moved = git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'move']);
    expect(moved.status).not.toBe(0);
    expect(moved.stderr).toContain('pem-block detected in staged diff');
  });

  describe('two machines', () => {
    let machineB: string;
    const envB = () => ({ GSTACK_HOME: machineB, HOME: machineB });
    beforeEach(() => { machineB = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-machineB-')); });
    afterEach(() => { fs.rmSync(machineB, { recursive: true, force: true }); });
    function restoreB() {
      fs.rmSync(machineB, { recursive: true, force: true });
      expect(run(['gstack-brain-restore', bareRemote], { env: envB() }).status).toBe(0);
      run(['gstack-config', 'set', 'artifacts_sync_mode', 'full'], { env: envB() });
    }

    test('a removal on one machine and an edit on the other: the edit wins', () => {
      initFull('on');
      for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
      syncAll();
      restoreB();
      fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
      fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/b.md'));
      syncAll();
      expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
      write('projects/p/designs/a.md', '# a, edited on B\n', machineB);
      write('projects/p/designs/b.md', '# b, edited on B\n', machineB);
      syncAll(envB());
      expect(statusJson(machineB).message).toMatch(/^pushed \d+ file\(s\) after merging the remote's changes; kept 2 file\(s\) that one side edited and the other removed$/);
      expect(remoteShow('projects/p/designs/b.md')).toBe('# b, edited on B\n');
      expect(spawnSync('git', ['--git-dir=' + bareRemote, 'log', '-1', '--format=%an %P', 'main'], { encoding: 'utf-8' }).stdout)
        .toMatch(/^gstack-brain-sync \w+ \w+\n$/);
      expect(remoteShow('projects/p/designs/a.md')).toBe('# a, edited on B\n');
      expect(fs.existsSync(path.join(machineB, '.git/MERGE_HEAD'))).toBe(false);
    });

    test('an edit on the other machine outlives a removal on this one', () => {
      initFull('on');
      write('projects/p/designs/a.md');
      write('projects/p/designs/b.md');
      syncAll();
      restoreB();
      run(['gstack-config', 'set', 'artifacts_sync_removals', 'on'], { env: envB() });
      write('projects/p/designs/a.md', '# a, edited on A\n');
      syncAll();
      fs.unlinkSync(path.join(machineB, 'projects/p/designs/a.md'));
      syncAll(envB());
      expect(statusJson(machineB).message).toMatch(/^pushed (\d+ file\(s\) and )?1 removal\(s\) after merging the remote's changes; kept 1 file\(s\) that one side edited and the other removed$/);
      expect(remoteShow('projects/p/designs/a.md')).toBe('# a, edited on A\n');
      expect(fs.readFileSync(path.join(machineB, 'projects/p/designs/a.md'), 'utf-8')).toBe('# a, edited on A\n');
      expect(git(['status', '--porcelain'], machineB).stdout).toBe('');
    });

    test('a merge publishes the committed edit, never what the file holds by then', () => {
      initFull('on');
      write('projects/p/designs/a.md');
      write('projects/p/designs/b.md');
      syncAll();
      restoreB();
      fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
      syncAll();
      write('projects/p/designs/a.md', '# a, edited on B\n', machineB);
      // Another writer appends to a.md once the merge is under way.
      const target = path.join(machineB, 'projects/p/designs/a.md');
      const PATH = fakeGit(machineB, '',
        `for a in "$@"; do [ "$a" = merge ] && printf 'appended later: AKIAABCDEFGHIJKLMNOP\\n' >> '${target}'; done`);
      syncAll({ ...envB(), PATH });
      expect(statusJson(machineB).message).toMatch(/kept 1 file\(s\) that one side edited and the other removed$/);
      expect(remoteShow('projects/p/designs/a.md')).toBe('# a, edited on B\n');
      const history = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '-p', 'main'], { encoding: 'utf-8' }).stdout;
      expect(history).not.toContain('AKIA');
      // The late write is still there, and the next sync scans it.
      expect(fs.readFileSync(target, 'utf-8')).toContain('appended later: AKIA');
      syncAll(envB());
      expect(statusJson(machineB).status).toBe('blocked');
      expect(remoteShow('projects/p/designs/a.md')).toBe('# a, edited on B\n');
    });

    test('--publish-removals merges when the other machine pushed first', () => {
      initFull();
      for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
      syncAll();
      restoreB();
      write('projects/p/designs/c.md', '# c, edited on B\n', machineB);
      syncAll(envB());
      fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
      const pub = run(['gstack-brain-sync', '--publish-removals', '--yes']);
      expect(pub.status).toBe(0);
      expect(pub.stdout).toContain("published 1 removal(s) after merging the remote's changes\n");
      expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
      expect(remoteShow('projects/p/designs/c.md')).toBe('# c, edited on B\n');
      expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');
    });

    test('--publish-removals says when a removal came back, edited on the other machine', () => {
      initFull();
      for (const n of ['a', 'b', 'c', 'd']) write(`projects/p/designs/${n}.md`);
      syncAll();
      restoreB();
      write('projects/p/designs/a.md', '# a, edited on B\n', machineB);
      syncAll(envB());
      fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
      fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/b.md'));
      const pub = run(['gstack-brain-sync', '--publish-removals', '--yes']);
      expect(pub.status).toBe(0);
      expect(pub.stdout).toContain("published 2 removal(s) after merging the remote's changes; 1 of them came back, edited on another machine\n");
      expect(remoteFiles()).not.toContain('projects/p/designs/b.md');
      expect(remoteShow('projects/p/designs/a.md')).toBe('# a, edited on B\n');
      expect(fs.readFileSync(path.join(tmpHome, 'projects/p/designs/a.md'), 'utf-8')).toBe('# a, edited on B\n');
    });

    test('a commit stranded by a failed merge is merged and pushed by a later run', () => {
      if (process.platform === 'win32') return;
      initFull('on');
      for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
      syncAll();
      restoreB();
      write('projects/p/designs/c.md', '# c, edited on B\n', machineB);
      syncAll(envB());
      fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
      expect(run(['gstack-brain-sync', '--discover-new']).status).toBe(0);
      // A's push is rejected, and the fetch for its merge fails.
      const PATH = fakeGit(tmpHome, 'for a in "$@"; do [ "$a" = fetch ] && exit 1; done');
      expect(run(['gstack-brain-sync', '--once'], { env: { PATH } }).status).toBe(0);
      expect(statusJson().message).toMatch(/^push failed: ! \[rejected\] .*; commit retained locally, will retry next run$/);
      expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('1');
      expect(spoolPaths()).toEqual([]);
      // Throttled runs report the waiting commit instead of a clean idle.
      fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), String(Math.floor(Date.now() / 1000)));
      expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
      expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
      expect(statusJson().message).toBe('queue empty; 1 local commit(s) not on the remote yet (retried every 10 minutes)');
      // Once the interval has passed, the retry merges and lands.
      fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
      expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
      expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');
      expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
      expect(remoteShow('projects/p/designs/c.md')).toBe('# c, edited on B\n');
      expect(statusJson().message).toBe('queue empty');
    });

    test('--publish-removals counts only its own removals among the files that came back', () => {
      if (process.platform === 'win32') return;
      initFull();
      for (const n of ['a', 'b', 'c', 'd']) write(`projects/p/designs/${n}.md`);
      syncAll();
      restoreB();
      write('projects/p/designs/d.md', '# d, edited on B\n', machineB);
      syncAll(envB());
      // An earlier publish of d.md stranded: its push was rejected and its fetch failed.
      fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/d.md'));
      const PATH = fakeGit(tmpHome, 'for a in "$@"; do [ "$a" = fetch ] && exit 1; done');
      expect(run(['gstack-brain-sync', '--publish-removals', '--yes', 'projects/p/designs/d.md'], { env: { PATH } }).status).toBe(1);
      // This publish settles d.md as well, but only b.md is its own.
      fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/b.md'));
      const pub = run(['gstack-brain-sync', '--publish-removals', '--yes', 'projects/p/designs/b.md']);
      expect(pub.status).toBe(0);
      expect(pub.stdout).toContain("published 1 removal(s) after merging the remote's changes\n");
      expect(remoteShow('projects/p/designs/d.md')).toBe('# d, edited on B\n');
      expect(remoteFiles()).not.toContain('projects/p/designs/b.md');
    });

    test('--publish-removals does not claim a merge when its retry merged nothing', () => {
      if (process.platform === 'win32') return;
      initFull();
      for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
      syncAll();
      fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
      // The first push fails once; nothing changed on the remote.
      const marker = path.join(tmpHome, 'push-failed-once');
      const PATH = fakeGit(tmpHome, `for a in "$@"; do [ "$a" = push ] && [ ! -e '${marker}' ] && { touch '${marker}'; exit 1; }; done`);
      const pub = run(['gstack-brain-sync', '--publish-removals', '--yes'], { env: { PATH } });
      expect(pub.status).toBe(0);
      expect(pub.stdout).toContain('published 1 removal(s)\n');
      expect(remoteFiles()).not.toContain('projects/p/designs/a.md');
    });

    test('an idle run says when a waiting commit is not the sync\'s own', () => {
      initFull();
      write('projects/p/designs/a.md');
      write('projects/p/designs/b.md');
      write('projects/p/designs/c.md');
      syncAll();
      // One waiting commit is the sync's own, the other was made by hand.
      write('projects/p/designs/c.md', '# c, by the sync\n');
      git(['add', '-f', 'projects/p/designs/c.md']);
      expect(git(['-c', 'user.email=gstack@localhost', '-c', 'user.name=gstack-brain-sync', 'commit', '-q', '--no-verify', '-m', 'sync: 1 file(s)']).status).toBe(0);
      write('projects/p/designs/a.md', '# a, by hand\n');
      git(['add', '-f', 'projects/p/designs/a.md']);
      expect(git(['-c', 'user.email=me@example.com', '-c', 'user.name=me', 'commit', '-q', '--no-verify', '-m', 'by hand']).status).toBe(0);
      fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
      expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
      expect(statusJson()).toMatchObject({
        status: 'idle',
        message: "queue empty; 2 local commit(s) not on the remote yet, not all gstack-brain-sync's own: they go out with the next synced change",
      });
      expect(remoteShow('projects/p/designs/a.md')).toBe('# projects/p/designs/a.md\n');
      write('projects/p/designs/b.md', '# b, edited\n');
      syncAll();
      expect(remoteShow('projects/p/designs/a.md')).toBe('# a, by hand\n');
      expect(statusJson().message).toMatch(/^pushed \d+ file\(s\)$/);
    });

    test('a waiting commit whose merge conflicts keeps saying so', () => {
      if (process.platform === 'win32') return;
      initFull('on');
      write('builder-journey.md', 'start\n');
      syncAll();
      restoreB();
      write('builder-journey.md', 'start\nfrom B\n', machineB);
      syncAll(envB());
      write('builder-journey.md', 'start\nfrom A\n');
      const PATH = fakeGit(tmpHome, 'for a in "$@"; do [ "$a" = fetch ] && exit 1; done');
      syncAll({ PATH });
      expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('1');
      fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
      const o = run(['gstack-brain-sync', '--once']);
      expect(o.status).toBe(0);
      expect(o.stderr).toContain('BRAIN_SYNC: push failed: diverged: conflict in builder-journey.md');
      expect(statusJson()).toMatchObject({
        status: 'push_failed',
        message: expect.stringContaining('diverged from the remote (conflict in builder-journey.md); merge aborted'),
      });
      expect(fs.existsSync(path.join(tmpHome, '.git/MERGE_HEAD'))).toBe(false);
      // Throttled runs keep the verdict instead of promising a retry.
      expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
      expect(statusJson().message).toContain('diverged from the remote (conflict in builder-journey.md); merge aborted, 1 commit(s) kept locally.');
      // Resolved by hand and pushed: the next run is idle again.
      git(['-c', 'user.email=me@example.com', '-c', 'user.name=me', 'merge', '-q', 'origin/main']);
      write('builder-journey.md', 'start\nfrom A\nfrom B\n');
      git(['add', '-f', 'builder-journey.md']);
      expect(git(['-c', 'user.email=me@example.com', '-c', 'user.name=me', 'commit', '-q', '--no-verify', '-m', 'merge']).status).toBe(0);
      expect(git(['push', '-q', 'origin', 'HEAD']).status).toBe(0);
      expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
      expect(statusJson()).toMatchObject({ status: 'idle', message: 'queue empty' });
      expect(fs.existsSync(path.join(tmpHome, '.brain-sync-diverged'))).toBe(false);
    });

    test('a later run that merges a stranded removal says which edit it kept', () => {
      if (process.platform === 'win32') return;
      initFull('on');
      for (const n of ['a', 'b', 'c']) write(`projects/p/designs/${n}.md`);
      syncAll();
      restoreB();
      write('projects/p/designs/a.md', '# a, edited on B\n', machineB);
      syncAll(envB());
      fs.unlinkSync(path.join(tmpHome, 'projects/p/designs/a.md'));
      const PATH = fakeGit(tmpHome, 'for a in "$@"; do [ "$a" = fetch ] && exit 1; done');
      syncAll({ PATH });
      expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('1');
      fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
      expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
      expect(statusJson()).toMatchObject({
        status: 'idle',
        message: 'queue empty; kept 1 file(s) that one side edited and the other removed',
      });
      expect(remoteShow('projects/p/designs/a.md')).toBe('# a, edited on B\n');
    });

    test('a drain whose retry merged nothing does not claim a merge', () => {
      if (process.platform === 'win32') return;
      initFull();
      write('projects/p/designs/a.md');
      syncAll();
      write('projects/p/designs/a.md', '# a, edited\n');
      const marker = path.join(tmpHome, 'push-failed-once');
      const PATH = fakeGit(tmpHome, `for a in "$@"; do [ "$a" = push ] && [ ! -e '${marker}' ] && { touch '${marker}'; exit 1; }; done`);
      syncAll({ PATH });
      expect(statusJson()).toMatchObject({ status: 'ok', message: 'pushed 1 file(s)' });
      expect(remoteShow('projects/p/designs/a.md')).toBe('# a, edited\n');
    });

    test('a retry that fails for another reason than a rejection does not fetch', () => {
      initFull();
      write('projects/p/designs/a.md');
      write('projects/p/designs/b.md');
      syncAll();
      write('projects/p/designs/a.md', '# a, stranded\n');
      git(['add', '-f', 'projects/p/designs/a.md']);
      expect(git(['-c', 'user.email=gstack@localhost', '-c', 'user.name=gstack-brain-sync', 'commit', '-q', '--no-verify', '-m', 'sync: 1 file(s)']).status).toBe(0);
      git(['remote', 'set-url', 'origin', path.join(tmpHome, 'no-such-remote.git')]);
      fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
      fs.writeFileSync(path.join(tmpHome, '.brain-last-push'), 'before\n');
      expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
      expect(fs.readFileSync(path.join(tmpHome, '.brain-last-push'), 'utf-8')).toBe('before\n');
      const ledger = fs.readFileSync(path.join(tmpHome, 'security', 'egress.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(ledger.filter((r) => r.payload_class === 'curated-memory-git-fetch')).toEqual([]);
      expect(statusJson().message).toBe('queue empty; 1 local commit(s) not on the remote yet (retried every 10 minutes)');
    });

    test('any other conflict aborts the merge and reports it', () => {
      initFull('on');
      write('builder-journey.md', 'start\n');
      syncAll();
      restoreB();
      write('builder-journey.md', 'start\nfrom A\n');
      syncAll();
      write('builder-journey.md', 'start\nfrom B\n', machineB);
      const o = syncAll(envB());
      const s = statusJson(machineB);
      expect(s.status).toBe('push_failed');
      expect(s.message).toContain('diverged from the remote (conflict in builder-journey.md); merge aborted');
      expect(o.stderr).toContain('BRAIN_SYNC: push failed: diverged: conflict in builder-journey.md\n');
      expect(fs.existsSync(path.join(machineB, '.git/MERGE_HEAD'))).toBe(false);
      expect(git(['status', '--porcelain'], machineB).stdout).not.toMatch(/^(UU|AA|DU|UD) /m);
    });

    test('a merge git refuses to start is reported with git\'s reason, and the queue moves on', () => {
      initFull('on');
      write('projects/p/designs/a.md');
      write('projects/p/designs/b.md');
      syncAll();
      restoreB();
      // B keeps a private local edit of b.md out of the sync.
      run(['gstack-brain-sync', '--skip-file', 'projects/p/designs/b.md'], { env: envB() });
      write('projects/p/designs/b.md', '# b, private on B\n', machineB);
      write('projects/p/designs/b.md', '# b, edited on A\n');
      syncAll();
      write('projects/p/designs/a.md', '# a, edited on B\n', machineB);
      const o = syncAll(envB());
      const s = statusJson(machineB);
      expect(s.status).toBe('push_failed');
      expect(s.message).toContain('diverged from the remote (merge failed: error: Your local changes to the following files would be overwritten by merge:)');
      expect(o.stderr).toContain('BRAIN_SYNC: push failed: diverged: merge failed: error: Your local changes');
      expect(fs.readFileSync(path.join(machineB, 'projects/p/designs/b.md'), 'utf-8')).toBe('# b, private on B\n');
      expect(fs.existsSync(path.join(machineB, '.git/MERGE_HEAD'))).toBe(false);
      expect(spawnSync('find', [path.join(machineB, '.brain-queue.d'), '-name', '*.json'], { encoding: 'utf-8' }).stdout.trim()).toBe('');
    });

    test('the pre-commit hook written by restore lets a pure removal through and still refuses the text as an addition', () => {
      initFull('on');
      write('projects/p/designs/leak.md', '-----BEGIN PRIVATE KEY-----\n');
      commitDirectly('projects/p/designs/leak.md', 'legacy publish');
      restoreB();
      git(['rm', '-q', 'projects/p/designs/leak.md'], machineB);
      expect(git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'remove'], machineB).status).toBe(0);
      write('projects/p/designs/again.md', '-----BEGIN PRIVATE KEY-----\n', machineB);
      git(['add', '-f', 'projects/p/designs/again.md'], machineB);
      const refused = git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add'], machineB);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('refusing commit — pem-block detected');
      git(['reset', '-q', 'HEAD', '--', 'projects/p/designs/again.md'], machineB);
      fs.unlinkSync(path.join(machineB, 'projects/p/designs/again.md'));
      write('projects/p/designs/old.md', '-----BEGIN PRIVATE KEY-----\n');
      commitDirectly('projects/p/designs/old.md', 'legacy publish 2');
      expect(git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'pull', '-q', '--no-rebase', 'origin', 'main'], machineB).status).toBe(0);
      git(['mv', 'projects/p/designs/old.md', 'projects/p/designs/new.md'], machineB);
      const moved = git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'move'], machineB);
      expect(moved.status).not.toBe(0);
      expect(moved.stderr).toContain('refusing commit — pem-block detected');
    });
  });
});

// ---------------------------------------------------------------
// Enqueue tmp janitor: a writer killed between its tmp write and the
// atomic rename orphans a .tmp-* file forever (it never becomes a
// record, nothing else touches it). The drain reaps ones older than
// 1 hour, inside its lock; fresh ones (in-flight enqueues) survive.
// ---------------------------------------------------------------
describe('enqueue tmp janitor', () => {
  test('an orphaned .tmp-* older than 1h is reaped on --once; a fresh one survives', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(spoolDir(), { recursive: true });

    const oldTmp = path.join(spoolDir(), '.tmp-99999-x1');
    fs.writeFileSync(oldTmp, '{"file":"projects/p/learnings.jsonl"}\n');
    const past = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(oldTmp, past, past);

    const freshTmp = path.join(spoolDir(), '.tmp-99999-x2');
    fs.writeFileSync(freshTmp, '{"file":"projects/p/learnings.jsonl"}\n');

    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(fs.existsSync(oldTmp)).toBe(false);  // orphan reaped
    expect(fs.existsSync(freshTmp)).toBe(true); // in-flight write untouched
  });
});

// ---------------------------------------------------------------
// #2549 queue integrity: classified drops, privacy retention,
// surgical rewrite, unpushed-commit detector
// ---------------------------------------------------------------
describe('#2549 queue integrity', () => {
  function initWithMode(mode: string) {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', mode]);
  }
  const statusJson = () => JSON.parse(fs.readFileSync(path.join(tmpHome, '.brain-sync-status.json'), 'utf-8'));

  test('privacy-held entries are RETAINED and classified, not wiped as "no allowlisted changes"', () => {
    // timeline.jsonl is class=behavioral; artifacts-only mode holds it.
    initWithMode('artifacts-only');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/timeline.jsonl'), '{"skill":"x","event":"started"}\n');
    run(['gstack-brain-enqueue', 'projects/p/timeline.jsonl']);
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    // The exact #2549 repro: the old code truncated the queue here and said
    // "no allowlisted changes in queue". The record must survive, and the
    // status must attribute the hold honestly.
    expect(spoolText()).toContain('projects/p/timeline.jsonl');
    const s = statusJson();
    expect(s.status).toBe('idle');
    expect(s.message).toContain('privacy-held retained');
    expect(s.message).not.toContain('no allowlisted changes');
  });

  test('unmatched and missing entries drop WITH counts and a 0600 drops sidecar', () => {
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    // Unmatched: no allowlist glob covers .txt scratch files.
    fs.writeFileSync(path.join(tmpHome, 'projects/p/scratch.txt'), 'x\n');
    seedSpool('{"file":"projects/p/scratch.txt"}');
    // Missing: allowlisted name that does not exist on disk.
    seedSpool('{"file":"projects/p/learnings.jsonl"}');
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    expect(spoolText()).not.toContain('scratch.txt');
    expect(spoolText()).not.toContain('learnings.jsonl');
    const s = statusJson();
    expect(s.message).toContain('1 unmatched dropped');
    expect(s.message).toContain('1 missing dropped');
    const drops = path.join(tmpHome, '.brain-sync-drops.json');
    expect(fs.existsSync(drops)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(drops).mode & 0o777).toBe(0o600);
    }
    const detail = JSON.parse(fs.readFileSync(drops, 'utf-8'));
    expect(detail.dropped.unmatched).toContain('projects/p/scratch.txt');
    expect(detail.dropped.missing).toContain('projects/p/learnings.jsonl');
  });

  test('an unparseable legacy queue line migrates as-is and is quarantined, never destroyed', () => {
    // The line lands in the legacy single-file queue (pre-spool writer);
    // migration converts it verbatim to a spool record, and the drain moves
    // what it cannot parse into quarantine (never deletes it, and never
    // leaves it re-warning at every boundary).
    initWithMode('full');
    fs.appendFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'not json at all\n');
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    const qDir = path.join(spoolDir(), 'quarantine');
    expect(fs.existsSync(qDir)).toBe(true);
    const qFiles = fs.readdirSync(qDir);
    expect(qFiles.length).toBe(1);
    expect(fs.readFileSync(path.join(qDir, qFiles[0]), 'utf-8')).toContain('not json at all');
  });

  test('finalize: a synced record leaves the spool while a held sibling survives the same drain', () => {
    // Proves finalize is a per-record delete, not a truncation: two records
    // drain in one --once, one stages+pushes, one is mode-held.
    initWithMode('artifacts-only');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"x","insight":"y","ts":"2026-01-01T00:00:00Z"}\n');
    fs.writeFileSync(path.join(tmpHome, 'projects/p/timeline.jsonl'), '{"skill":"x","event":"started"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    run(['gstack-brain-enqueue', 'projects/p/timeline.jsonl']);
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    expect(spoolText()).not.toContain('learnings.jsonl');   // synced, removed
    expect(spoolText()).toContain('timeline.jsonl');        // held, retained
    const log = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8', timeout: 30_000 });
    expect(log.stdout).toMatch(/sync: 1 file/);
  });

  test('push failure retains the commit locally and the run-start detector re-pushes it', () => {
    initWithMode('full');
    // Establish origin/main so the detector has a remote ref to compare.
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"a","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);

    // Reject the next push at the remote (pre-receive hook exits 1 with an
    // auth-shaped message so the auth branch is exercised too).
    const hook = path.join(bareRemote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "403 forbidden" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);

    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"b","ts":"2026-01-02T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const fail = run(['gstack-brain-sync', '--once']);
    expect(fail.status).toBe(0);
    const s = statusJson();
    expect(s.status).toBe('push_failed');
    expect(s.message).toContain('commit retained locally');
    // Drained record left the spool — it lives in the local commit now.
    expect(spoolText()).not.toContain('learnings.jsonl');
    // The commit exists locally, ahead of origin.
    const ahead = git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim();
    expect(Number(ahead)).toBeGreaterThan(0);

    // Remote healthy again: an EMPTY-queue run must still deliver the
    // stranded commit (the detector, not the drain, pushes it).
    fs.rmSync(hook);
    const retry = run(['gstack-brain-sync', '--once']);
    expect(retry.status).toBe(0);
    const log = spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8', timeout: 30_000 });
    expect(log.stdout).toMatch(/sync: 1 file/);
    expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');
  });

  test('receipt refusal at the detector skips the retry without wedging the drain', () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"a","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);

    // Strand a commit: reject pushes, drain once.
    const hook = path.join(bareRemote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"b","ts":"2026-01-02T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    fs.rmSync(hook);

    // Break receipts. The detector's retry must be SKIPPED (no wedge), and
    // the run must still exit 0 with nothing else to do.
    fs.mkdirSync(path.join(tmpHome, 'security'), { recursive: true });
    fs.chmodSync(path.join(tmpHome, 'security'), 0o500);
    try {
      const r = run(['gstack-brain-sync', '--once']);
      expect(r.status).toBe(0);
      // Commit still stranded (retry skipped, not attempted unreceipted).
      expect(Number(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim())).toBeGreaterThan(0);
    } finally {
      fs.chmodSync(path.join(tmpHome, 'security'), 0o700);
    }

    // Receipts healthy: detector delivers. The refused attempt above stamped
    // the 10-minute throttle (deliberately — refusals must not busy-loop the
    // network at every skill boundary), so model the interval passing.
    fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');
  });

  test('detector attempts are throttled to one per interval', () => {
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"a","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);

    // Strand a commit behind a rejecting remote.
    const hook = path.join(bareRemote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"b","ts":"2026-01-02T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    fs.rmSync(hook);

    // First empty-queue run: detector attempts (stamps the throttle), pushes.
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    const stamp1 = fs.readFileSync(path.join(tmpHome, '.brain-last-push-attempt'), 'utf-8');
    expect(Number(stamp1)).toBeGreaterThan(0);
    expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');

    // Strand another; an immediate second run must NOT attempt (stamp fresh).
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"c","ts":"2026-01-03T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    fs.rmSync(hook);
    const stampBefore = fs.readFileSync(path.join(tmpHome, '.brain-last-push-attempt'), 'utf-8');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    // Throttled: stamp unchanged, commit still stranded.
    expect(fs.readFileSync(path.join(tmpHome, '.brain-last-push-attempt'), 'utf-8')).toBe(stampBefore);
    expect(Number(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim())).toBeGreaterThan(0);

    // Interval passed: delivers.
    fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');
  });

  test('an interleaved user commit disables the detector push (exclusive author gate)', () => {
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"a","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);

    // Strand a bot commit behind a rejecting remote.
    const hook = path.join(bareRemote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"b","ts":"2026-01-02T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    fs.rmSync(hook);

    // A user manually commits in ~/.gstack on top of the stranded bot commit.
    expect(git(['-c', 'user.name=Garry', '-c', 'user.email=garry@example.com',
                '-c', 'commit.gpgsign=false',
                'commit', '--allow-empty', '-m', 'manual note']).status).toBe(0);

    // Interval passed, remote healthy, queue empty: the detector must STILL
    // refuse — `push origin HEAD` would publish the user's commit uninvited.
    fs.writeFileSync(path.join(tmpHome, '.brain-last-push-attempt'), '0');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(Number(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim())).toBe(2);

    // A REAL drain still rides the user commit along, as before — the gate
    // scopes only the detector's autonomous retry, not user-initiated syncs.
    fs.appendFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"c","ts":"2026-01-03T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(git(['rev-list', '--count', 'origin/main..HEAD']).stdout.trim()).toBe('0');
  });
});

// ---------------------------------------------------------------
// C12 spool queue: per-record files kill the enqueue/drain race.
// One FILE per record under .brain-queue.d/ — writer and drainer never
// share an inode, so the lockless append-vs-rewrite race is structurally
// gone. Crash semantics are at-least-once (unfinalized records re-drain).
// ---------------------------------------------------------------
describe('C12 spool queue', () => {
  function initWithMode(mode: string) {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', mode]);
  }
  const remoteLog = () =>
    spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8', timeout: 30_000 }).stdout;

  test('two rapid enqueues of different paths create two spool files; one drain syncs both', () => {
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, 'retros'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"x","ts":"2026-01-01T00:00:00Z"}\n');
    fs.writeFileSync(path.join(tmpHome, 'retros/week-1.md'), '# retro\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    run(['gstack-brain-enqueue', 'retros/week-1.md']);
    expect(spoolFiles().length).toBe(2);
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    expect(spoolFiles().length).toBe(0);
    expect(remoteLog()).toMatch(/sync: 2 file/);
  });

  test('a record created after a drain survives untouched and drains on the NEXT --once', () => {
    // Structural form of the concurrent-append test: finalize deletes only
    // snapshot-manifest files, so a record the drain never listed cannot be
    // touched — whether it lands mid-drain or after.
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, 'retros'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"a","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(spoolFiles().length).toBe(0);
    // New record arrives (a writer that raced the previous drain).
    fs.writeFileSync(path.join(tmpHome, 'retros/week-1.md'), '# retro\n');
    run(['gstack-brain-enqueue', 'retros/week-1.md']);
    const [pending] = spoolFiles();
    expect(pending).toBeTruthy();
    const pendingContent = fs.readFileSync(path.join(spoolDir(), pending), 'utf-8');
    expect(pendingContent).toContain('retros/week-1.md');
    // Untouched by the completed drain; the NEXT drain delivers it.
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(spoolFiles().length).toBe(0);
    expect(remoteLog()).toMatch(/sync: 1 file/);
  });

  test('at-least-once: a drain that fails before finalize leaves every spool file for the next run', () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, 'retros'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"a","ts":"2026-01-01T00:00:00Z"}\n');
    fs.writeFileSync(path.join(tmpHome, 'retros/week-1.md'), '# retro\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    run(['gstack-brain-enqueue', 'retros/week-1.md']);
    const seeded = spoolFiles();
    expect(seeded.length).toBe(2);

    // Break the egress-receipt ledger: the drain fails AFTER staging but
    // BEFORE any commit or finalize — simulating a crash mid-drain.
    fs.mkdirSync(path.join(tmpHome, 'security'), { recursive: true });
    fs.chmodSync(path.join(tmpHome, 'security'), 0o500);
    try {
      const refused = run(['gstack-brain-sync', '--once']);
      expect(refused.status).toBe(1);
      // The exact same spool files are still present — nothing consumed.
      expect(spoolFiles()).toEqual(seeded);
    } finally {
      fs.chmodSync(path.join(tmpHome, 'security'), 0o700);
    }

    // Next run re-drains the surviving records.
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(spoolFiles().length).toBe(0);
    expect(remoteLog()).toMatch(/sync: 2 file/);
  });

  test('legacy migration: .brain-queue.jsonl lines convert to spool records, nothing lost', () => {
    // Pre-spool writers appended to the single-file queue. Three lines: two
    // stageable artifacts, one behavioral (mode-held under artifacts-only).
    initWithMode('artifacts-only');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, 'retros'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"x","ts":"2026-01-01T00:00:00Z"}\n');
    fs.writeFileSync(path.join(tmpHome, 'retros/week-1.md'), '# retro\n');
    fs.writeFileSync(path.join(tmpHome, 'projects/p/timeline.jsonl'), '{"skill":"x","event":"started"}\n');
    fs.writeFileSync(path.join(tmpHome, '.brain-queue.jsonl'),
      '{"file":"projects/p/learnings.jsonl","ts":"2026-01-01T00:00:00Z"}\n' +
      '{"file":"retros/week-1.md","ts":"2026-01-01T00:00:01Z"}\n' +
      '{"file":"projects/p/timeline.jsonl","ts":"2026-01-01T00:00:02Z"}\n');
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    // Legacy file consumed; no .migrating remnant.
    expect(fs.existsSync(path.join(tmpHome, '.brain-queue.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.brain-queue.jsonl.migrating'))).toBe(false);
    // Both artifacts synced; the behavioral record survives as a spool file.
    expect(remoteLog()).toMatch(/sync: 2 file/);
    expect(spoolText()).toContain('projects/p/timeline.jsonl');
    expect(spoolText()).not.toContain('learnings.jsonl');
  });

  test('an unparseable spool record is quarantined with a warning; the drain continues', () => {
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"x","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const badFile = seedSpool('this is not json');
    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('unparseable');
    // The good sibling synced; the unreadable record was never destroyed —
    // it moved to quarantine so it stops re-warning at every boundary.
    expect(remoteLog()).toMatch(/sync: 1 file/);
    expect(spoolFiles()).toEqual([]);
    const qPath = path.join(spoolDir(), 'quarantine', badFile);
    expect(fs.existsSync(qPath)).toBe(true);
    expect(fs.readFileSync(qPath, 'utf-8')).toContain('this is not json');
  });

  test('--status queue_depth counts spool records plus unmigrated legacy lines', () => {
    initWithMode('full');
    seedSpool('{"file":"projects/p/a.jsonl","ts":"t"}');
    seedSpool('{"file":"projects/p/b.jsonl","ts":"t"}');
    fs.writeFileSync(path.join(tmpHome, '.brain-queue.jsonl'), '{"file":"projects/p/c.jsonl","ts":"t"}\n');
    const r = run(['gstack-brain-sync', '--status']);
    expect(r.status).toBe(0);
    const supplemental = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(supplemental.queue_depth).toBe(3);
  });

  test('G1: a malformed pulled privacy map (["bad"]) holds the queue — warns, deletes NOTHING, next run re-drains', () => {
    // Remotely triggerable kill vector: the privacy map arrives via the
    // artifacts-repo pull. A non-dict entry used to raise mid-classification
    // AFTER the snapshot manifest was written, and the old finalize polarity
    // ("delete unless retained") then unlinked EVERY snapshotted record.
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"x","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const seeded = spoolFiles();
    expect(seeded.length).toBe(1);
    fs.writeFileSync(path.join(tmpHome, '.brain-privacy-map.json'), '["bad"]');

    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('privacy map');
    // Zero records deleted; nothing pushed.
    expect(spoolFiles()).toEqual(seeded);
    expect(remoteLog()).not.toMatch(/sync:/);

    // Fix the map: the surviving queue re-drains and syncs.
    fs.writeFileSync(path.join(tmpHome, '.brain-privacy-map.json'), '[]');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(spoolFiles().length).toBe(0);
    expect(remoteLog()).toMatch(/sync: 1 file/);
  });

  test('G1: a classifier that dies AFTER the snapshot write consumes nothing (call-site exit check + explicit-delete finalize)', () => {
    // A dict entry with a non-string pattern passes the shape filter but
    // raises inside fnmatch DURING classification — the post-manifest crash
    // window (same shape as ENOSPC/OOM mid-run). The call site must see the
    // nonzero exit, warn, skip finalize, and leave everything queued.
    initWithMode('full');
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'), '{"skill":"x","ts":"2026-01-01T00:00:00Z"}\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    const seeded = spoolFiles();
    expect(seeded.length).toBe(1);
    fs.writeFileSync(path.join(tmpHome, '.brain-privacy-map.json'), '[{"pattern": 123}]');

    const r = run(['gstack-brain-sync', '--once']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('classification failed');
    expect(spoolFiles()).toEqual(seeded); // zero records deleted
    expect(remoteLog()).not.toMatch(/sync:/);
    const status = JSON.parse(fs.readFileSync(path.join(tmpHome, '.brain-sync-status.json'), 'utf-8'));
    expect(status.status).toBe('error');
    expect(status.message).toContain('queue preserved');

    // Fix the map: the surviving queue re-drains and syncs.
    fs.writeFileSync(path.join(tmpHome, '.brain-privacy-map.json'), '[]');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(spoolFiles().length).toBe(0);
    expect(remoteLog()).toMatch(/sync: 1 file/);
  });

  test('G1: finalize is explicit-delete-only and the fast path is .migrating-aware (static pins)', () => {
    const src = fs.readFileSync(path.join(BIN, 'gstack-brain-sync'), 'utf-8');
    // The compute call site checks the python exit status before finalizing.
    expect(src).toMatch(/if ! compute_paths_to_stage /);
    // finalize_queue takes the staged-paths file and deletes only staged ∪ dropped.
    expect(src).toContain('deletable = staged | dropped');
    expect(src).toContain('if p not in deletable:');
    // The empty fast path also treats a leftover .migrating file as non-idle.
    expect(src).toMatch(/spool_has_records && \[ ! -s "\$QUEUE" \] && \[ ! -s "\$QUEUE\.migrating" \]/);
  });

  test('--drop-queue keeps the --yes gate and counts spool + legacy entries', () => {
    initWithMode('full');
    seedSpool('{"file":"projects/p/a.jsonl","ts":"t"}');
    seedSpool('{"file":"projects/p/b.jsonl","ts":"t"}');
    fs.writeFileSync(path.join(tmpHome, '.brain-queue.jsonl'), '{"file":"projects/p/c.jsonl","ts":"t"}\n');
    const refused = run(['gstack-brain-sync', '--drop-queue']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--yes');
    expect(spoolFiles().length).toBe(2);
    const dropped = run(['gstack-brain-sync', '--drop-queue', '--yes']);
    expect(dropped.status).toBe(0);
    expect(dropped.stdout).toContain('dropped 3 queue entries');
    expect(spoolFiles().length).toBe(0);
    expect(fs.readFileSync(path.join(tmpHome, '.brain-queue.jsonl'), 'utf-8')).toBe('');
    const again = run(['gstack-brain-sync', '--drop-queue', '--yes']);
    expect(again.stdout).toContain('queue already empty');
  });
});
