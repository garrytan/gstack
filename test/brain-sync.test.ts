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

  test('the pre-commit hook init and restore write catches a JSON auth header with a Bearer prefix', () => {
    for (const bin of ['gstack-artifacts-init', 'gstack-brain-restore']) {
      const src = fs.readFileSync(path.join(BIN, bin), 'utf-8');
      expect(src).toContain('(Bearer |Basic |Token )?[A-Za-z0-9_./+=-]{16,}');
    }
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    const token = ['Bearer ', 'abcd', 'efgh', 'ijkl', 'mnop', 'qrst'].join('');
    fs.writeFileSync(path.join(tmpHome, 'projects/p/headers.json'), `{"authorization": "${token}"}\n`);
    git(['add', '-f', 'projects/p/headers.json']);
    const r = git(['commit', '-q', '-m', 'manual commit']);
    expect(r.status).not.toBe(0);
    expect(git(['log', '--oneline']).stdout).not.toContain('manual commit');
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

  test('staged transcript pages stay queued without transcript consent; other classes still push', () => {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
    fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'),
      '{"skill":"x","insight":"y","ts":"2026-04-22T10:00:00Z"}\n');
    const page = 'transcripts/run-1-1/session.md';
    fs.mkdirSync(path.join(tmpHome, 'transcripts', 'run-1-1'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, page), '# Session\n\nhello\n');
    run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
    run(['gstack-brain-enqueue', page]);
    const remoteFiles = () =>
      spawnSync('git', ['--git-dir=' + bareRemote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf-8', timeout: 30_000 }).stdout;

    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(remoteFiles()).toContain('projects/p/learnings.jsonl');
    expect(remoteFiles()).not.toContain(page);
    expect(spoolText()).toContain(page);
    expect(fs.existsSync(path.join(tmpHome, page))).toBe(true);

    // A stored off or legacy value is not consent either.
    for (const value of ['off', 'A']) {
      fs.appendFileSync(path.join(tmpHome, 'config.yaml'), `transcript_ingest_mode: ${value}\n`);
      expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
      expect(remoteFiles()).not.toContain(page);
    }

    expect(run(['gstack-config', 'set', 'transcript_ingest_mode', 'recent']).status).toBe(0);
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(remoteFiles()).toContain(page);
    expect(spoolText()).not.toContain(page);
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
      // The flagged file is held back on its own (status held, not blocked):
      // named with its scanner rule, never the matched text, and still queued.
      const raw = fs.readFileSync(path.join(tmpHome, '.brain-sync-status.json'), 'utf-8');
      const status = JSON.parse(raw);
      expect(status.status).toBe('held');
      expect(status.held_count).toBe(1);
      expect(status.held.map((h: any) => h.path)).toEqual(['projects/p/learnings.jsonl']);
      expect(raw).not.toContain(content.slice(0, 12));
      expect(spoolText()).toContain('projects/p/learnings.jsonl');
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
// Per-file hold: a flagged file is held back on its own (with its coupled
// group) and stays queued, the rest syncs, and every failure that used to be
// silent lands in the status file. Contributor regression tests from
// PR #3055 (@v639dragoon) are adapted here to the rewritten drain.
// ---------------------------------------------------------------
describe('gstack-brain-sync per-file hold', () => {
  const FLAGGED = 'projects/p/learnings.jsonl';
  const CLEAN = 'projects/p/ceo-plans/clean.md';
  const LOG = 'projects/p/decisions.jsonl';
  const SNAP = 'projects/p/decisions.active.json';
  const TOKEN = 'ghp_abcdefghij1234567890abcdef1234567890';
  const SELF = path.join(BIN, 'gstack-brain-sync');
  const statusRaw = () => fs.readFileSync(path.join(tmpHome, '.brain-sync-status.json'), 'utf-8');
  const statusJson = () => JSON.parse(statusRaw());
  const remoteFiles = () =>
    spawnSync('git', ['--git-dir=' + bareRemote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf-8', timeout: 30_000 }).stdout;
  const remoteLog = () =>
    spawnSync('git', ['--git-dir=' + bareRemote, 'log', '--oneline'], { encoding: 'utf-8', timeout: 30_000 }).stdout;
  const remoteShow = (p: string) =>
    spawnSync('git', ['--git-dir=' + bareRemote, 'show', `main:${p}`], { encoding: 'utf-8', timeout: 30_000 });
  const staged = () => git(['diff', '--cached', '--name-only']).stdout.trim();
  const drain = (env: Record<string, string> = {}) => run(['gstack-brain-sync', '--once'], { env });

  function init(mode = 'full') {
    run(['gstack-artifacts-init', '--remote', bareRemote]);
    run(['gstack-config', 'set', 'artifacts_sync_mode', mode]);
    fs.mkdirSync(path.join(tmpHome, 'projects/p/ceo-plans'), { recursive: true });
  }
  function write(p: string, body: string, enqueue = true) {
    fs.mkdirSync(path.dirname(path.join(tmpHome, p)), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, p), body);
    if (enqueue) run(['gstack-brain-enqueue', p]);
  }
  const decide = (id: string) => JSON.stringify({ id, kind: 'decide', decision: `d ${id}`, scope: 'repo', date: `2026-10-0${id.length}`, source: 'user' });
  function writeDecisions(ids: string[], snapIds = ids, snapExtra = '') {
    write(SNAP, JSON.stringify(snapIds.map((id) => ({ id, kind: 'decide', note: snapExtra }))), false);
    write(LOG, ids.map(decide).join('\n') + '\n');
  }
  /** A PATH shim in front of the real git: logs every call, optionally
   *  injects one fault. Fault injection reaches the drain's fail-closed paths,
   *  which a correct git never takes. */
  function gitShim(fault = ''): { env: Record<string, string>; calls: () => string[] } {
    const dir = fs.mkdtempSync(path.join(tmpHome, 'shim-'));
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8', timeout: 30_000 }).stdout.trim();
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${fault}\nexec '${real}' "$@"\n`, { mode: 0o755 });
    return {
      env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` },
      calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean) : []),
    };
  }

  test('one flagged file is held back; the clean file still syncs and status is held', () => {
    init();
    write(FLAGGED, `{"gh":"${TOKEN}"}\n`);
    write(CLEAN, '# a plan\n');
    expect(drain().status).toBe(0);
    expect(remoteFiles()).toContain(CLEAN);
    expect(remoteFiles()).not.toContain(FLAGGED);
    expect(remoteLog()).toMatch(/sync: 1 file/);
    expect(staged()).toBe('');
    expect(spoolText()).toContain(FLAGGED);
    expect(spoolText()).not.toContain(CLEAN);
    const s = statusJson();
    expect(s.status).toBe('held');
    expect(s.held_count).toBe(1);
    expect(s.drainable).toBe(0);
    expect(s.last_push_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(s.last_drain_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(s.held).toHaveLength(1);
    expect(s.held[0].path).toBe(FLAGGED);
    expect(s.held[0].rule).toBe('github-token');
    expect(s.held[0].dependents).toEqual([]);
    // Both fixes, with the absolute helper path; skip is permanent and reversible.
    expect(s.held[0].fixes[0]).toContain(`edit ${FLAGGED}`);
    expect(s.held[0].fixes[1]).toContain(`${SELF} --skip-file ${FLAGGED}`);
    expect(s.held[0].fixes[1]).toContain('permanently');
    expect(s.held[0].fixes[1]).toContain(`${SELF} --unskip-file ${FLAGGED}`);
    // The matched text appears nowhere in the status.
    expect(statusRaw()).not.toContain('ghp_');
    // --status prints the held array.
    expect(run(['gstack-brain-sync', '--status']).stdout).toContain(`"path": "${FLAGGED}"`);
  });

  test('a held file is re-scanned every drain and clears once its content is edited', () => {
    init();
    write(FLAGGED, `{"gh":"${TOKEN}"}\n`);
    drain();
    drain();
    expect(statusJson().status).toBe('held');
    expect(spoolFiles()).toHaveLength(1);
    write(FLAGGED, '{"gh":"rotated and removed"}\n');
    drain();
    const s = statusJson();
    expect(s.status).toBe('ok');
    expect(s.held).toEqual([]);
    expect(s.held_count).toBe(0);
    expect(remoteFiles()).toContain(FLAGGED);
    expect(spoolFiles()).toEqual([]);
  });

  test('--skip-file clears a hold permanently and --unskip-file resumes syncing', () => {
    init();
    write(FLAGGED, `{"gh":"${TOKEN}"}\n`);
    drain();
    expect(run(['gstack-brain-sync', '--skip-file', FLAGGED]).stdout).toContain(`--unskip-file ${FLAGGED}`);
    drain();
    expect(statusJson().status).toBe('idle');
    expect(statusJson().held_count).toBe(0);
    expect(spoolFiles()).toEqual([]);
    expect(remoteFiles()).not.toContain(FLAGGED);

    write(FLAGGED, '{"gh":"clean now"}\n', false);
    const r = run(['gstack-brain-sync', '--unskip-file', FLAGGED]);
    expect(r.stdout).toContain(`removed from skip list: ${FLAGGED}`);
    expect(fs.readFileSync(path.join(tmpHome, '.brain-skip.txt'), 'utf-8')).not.toContain(FLAGGED);
    expect(spoolText()).toContain(FLAGGED);
    drain();
    expect(statusJson().status).toBe('ok');
    expect(remoteFiles()).toContain(FLAGGED);
    expect(run(['gstack-brain-sync', '--unskip-file', FLAGGED]).stdout).toContain('not in skip list');
  });

  test('undecodable bytes next to a secret cannot pass the scan as clean', () => {
    init();
    fs.writeFileSync(path.join(tmpHome, FLAGGED), Buffer.concat([Buffer.from('{"bin":"'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from(`","gh":"${TOKEN}"}\n`)]));
    run(['gstack-brain-enqueue', FLAGGED]);
    write(CLEAN, '# a plan\n');
    drain();
    expect(remoteFiles()).not.toContain(FLAGGED);
    expect(remoteFiles()).toContain(CLEAN);
    expect(statusJson().status).toBe('held');
  });

  test('a re-scan that still flags after the hold falls back to blocked: nothing committed, queue kept', () => {
    init();
    write(FLAGGED, `{"gh":"${TOKEN}"}\n`);
    write(CLEAN, '# a plan\n');
    const before = git(['rev-list', '--count', 'HEAD']).stdout.trim();
    // git "succeeds" at unstaging the held file without doing it.
    const shim = gitShim(`case "$*" in *"reset -q HEAD --pathspec-from-file=-"*) cat >/dev/null; exit 0 ;; esac`);
    expect(drain(shim.env).status).toBe(0);
    const s = statusJson();
    expect(s.status).toBe('blocked');
    expect(s.message).toContain('re-scan');
    expect(statusRaw()).not.toContain('ghp_');
    expect(git(['rev-list', '--count', 'HEAD']).stdout.trim()).toBe(before);
    expect(staged()).toBe('');
    expect(spoolText()).toContain(FLAGGED);
    expect(spoolText()).toContain(CLEAN);
    expect(remoteFiles()).not.toContain(CLEAN);
  });

  test('findings the scanner cannot attribute to files block the drain (fail closed)', () => {
    init();
    write(CLEAN, '# a plan\n');
    const shim = gitShim(`case "$*" in *"--name-only"*) '${spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8', timeout: 30_000 }).stdout.trim()}' "$@"; printf 'extra\\0'; exit 0 ;; esac`);
    drain(shim.env);
    expect(statusJson().status).toBe('blocked');
    expect(staged()).toBe('');
    expect(remoteFiles()).not.toContain(CLEAN);
    expect(spoolText()).toContain(CLEAN);
  });

  _test('1,000 queued paths are attributed in one scanner pass and staged in one add', () => {
    init();
    for (let i = 0; i < 1000; i++) {
      const flagged = i % 400 === 7;
      fs.writeFileSync(path.join(tmpHome, `projects/p/ceo-plans/plan-${i}.md`), flagged ? `token ${TOKEN}\n` : `# plan ${i}\n`);
      seedSpool(`{"file":"projects/p/ceo-plans/plan-${i}.md","ts":"t"}`);
    }
    const shim = gitShim();
    expect(drain(shim.env).status).toBe(0);
    const s = statusJson();
    expect(s.status).toBe('held');
    expect(s.held.map((h: any) => h.path).sort()).toEqual(
      ['projects/p/ceo-plans/plan-407.md', 'projects/p/ceo-plans/plan-7.md', 'projects/p/ceo-plans/plan-807.md'],
    );
    expect(remoteLog()).toMatch(/sync: 997 file/);
    const calls = shim.calls();
    expect(calls.filter((c) => / add /.test(` ${c} `)).length).toBe(1);
    // attribution diff + name list + post-hold re-scan diff + empty-diff check
    expect(calls.filter((c) => c.includes('diff --cached')).length).toBeLessThanOrEqual(4);
    expect(spoolFiles()).toHaveLength(3);
  }, 120_000);

  test('a git add failure is reported, never swallowed', () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root)
    init();
    write(CLEAN, '# a plan\n');
    const unreadable = 'projects/p/ceo-plans/unreadable.md';
    write(unreadable, '# cannot be read\n');
    fs.chmodSync(path.join(tmpHome, unreadable), 0o000);
    try {
      expect(drain().status).toBe(0);
      const s = statusJson();
      expect(s.status).toBe('ok');
      expect(s.message).toContain('git add failed for 1 path(s)');
      expect(s.drainable).toBe(1);
      expect(remoteLog()).toMatch(/sync: 1 file/);
      expect(remoteFiles()).toContain(CLEAN);
      expect(spoolText()).toContain(unreadable);
      drain();
      const s2 = statusJson();
      expect(s2.status).toBe('error');
      expect(s2.message).toContain('git add failed for all 1 path(s)');
      expect(spoolText()).toContain(unreadable);
    } finally {
      fs.chmodSync(path.join(tmpHome, unreadable), 0o600);
    }
  });

  test('duplicate records for a privacy-held path collapse to the newest one', () => {
    init('artifacts-only');
    write('projects/p/timeline.jsonl', '{"skill":"x","event":"started"}\n', false);
    seedSpool('{"file":"projects/p/timeline.jsonl","ts":"a"}');
    seedSpool('{"file":"projects/p/timeline.jsonl","ts":"b"}');
    const newest = seedSpool('{"file":"projects/p/timeline.jsonl","ts":"c"}');
    expect(drain().status).toBe(0);
    expect(spoolFiles()).toEqual([newest]);
    expect(statusJson().message).toContain('privacy-held retained');
    expect(statusJson().drainable).toBe(0);
  });

  _test('--status counts a spool too deep for a shell glob', () => {
    init();
    fs.mkdirSync(spoolDir(), { recursive: true });
    // 12,000 names of ~200 bytes overflow ARG_MAX on Linux (2 MiB) and macOS alike.
    const N = 12_000;
    const pad = 'd'.repeat(180);
    for (let i = 0; i < N; i++) {
      fs.writeFileSync(path.join(spoolDir(), `1700000000-1-${pad}${String(i).padStart(6, '0')}.json`), '{"file":"x"}\n');
    }
    expect(run(['gstack-brain-sync', '--status']).stdout).toContain(`"queue_depth":${N}`);
  }, 60_000);

  describe('git index lock and the shared drain lock', () => {
    const indexLock = () => path.join(tmpHome, '.git', 'index.lock');
    const age = (p: string, ms: number) => { const t = new Date(Date.now() - ms); fs.utimesSync(p, t, t); };

    test('a fresh index lock is left alone: status error, queue kept', () => {
      init();
      write(CLEAN, '# a plan\n');
      fs.writeFileSync(indexLock(), '');
      expect(drain().status).toBe(0);
      const s = statusJson();
      expect(s.status).toBe('error');
      expect(s.message).toContain('index lock');
      expect(s.drainable).toBe(1);
      expect(fs.existsSync(indexLock())).toBe(true);
      expect(spoolText()).toContain(CLEAN);
      expect(remoteFiles()).not.toContain(CLEAN);
    });

    test('an index lock older than 10 minutes is cleared under the drain lock and the queue syncs', () => {
      init();
      write(CLEAN, '# a plan\n');
      fs.writeFileSync(indexLock(), '');
      age(indexLock(), 11 * 60_000);
      expect(drain().status).toBe(0);
      expect(fs.existsSync(indexLock())).toBe(false);
      expect(statusJson().status).toBe('ok');
      expect(statusJson().message).toContain('stale git index lock');
      expect(remoteFiles()).toContain(CLEAN);
    });

    test('an old index lock while another writer holds the drain lock is left alone', () => {
      init();
      write(CLEAN, '# a plan\n');
      const lockDir = path.join(tmpHome, '.brain-sync.lock.d');
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`);
      fs.writeFileSync(indexLock(), '');
      age(indexLock(), 60 * 60_000);
      const statusBefore = fs.existsSync(path.join(tmpHome, '.brain-sync-status.json')) ? statusRaw() : null;
      expect(drain().status).toBe(0);
      expect(fs.existsSync(indexLock())).toBe(true);
      expect(fs.existsSync(path.join(tmpHome, '.brain-sync-status.json')) ? statusRaw() : null).toBe(statusBefore);
      expect(spoolText()).toContain(CLEAN);
      expect(fs.readFileSync(path.join(lockDir, 'pid'), 'utf-8').trim()).toBe(String(process.pid));
    });

    _test('a concurrent writer: init waits for the drain lock, and gives up after the wait', async () => {
      init();
      const holder = Bun.spawn(['bash', '-c', `. '${path.join(BIN, 'gstack-brain-lock.sh')}'; gstack_brain_lock_acquire "$1" try || exit 9; echo held; sleep 3; gstack_brain_lock_release`, '_', tmpHome], { stdout: 'pipe' });
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('held');
      // A drain skips while the lock is held; init with no wait budget refuses.
      write(CLEAN, '# a plan\n');
      expect(drain().status).toBe(0);
      expect(spoolText()).toContain(CLEAN);
      const refused = run(['gstack-artifacts-init', '--remote', bareRemote], { env: { GSTACK_BRAIN_LOCK_WAIT: '0' } });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('another gstack sync');
      // With a wait budget, init runs once the holder releases.
      const waited = Bun.spawn([path.join(BIN, 'gstack-artifacts-init'), '--remote', bareRemote], {
        env: { ...process.env, HOME: tmpHome, GSTACK_HOME: tmpHome, GSTACK_BRAIN_LOCK_WAIT: '20' }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(await waited.exited).toBe(0);
      expect(await holder.exited).toBe(0);
      expect(fs.existsSync(path.join(tmpHome, '.brain-sync.lock.d'))).toBe(false);
      expect(drain().status).toBe(0);
      expect(remoteFiles()).toContain(CLEAN);
    }, 60_000);
  });

  describe('commit failures keep the queue', () => {
    for (const [name, hook] of [['a rejecting pre-commit hook', 'pre-commit'], ['a commit failure after staging (commit-msg)', 'commit-msg']]) {
      test(name, () => {
        init();
        write(CLEAN, '# a plan\n');
        const hookPath = path.join(tmpHome, '.git', 'hooks', hook);
        const original = fs.existsSync(hookPath) ? fs.readFileSync(hookPath) : null;
        fs.writeFileSync(hookPath, '#!/bin/sh\necho "refusing this commit" >&2\nexit 1\n', { mode: 0o755 });
        const before = git(['rev-list', '--count', 'HEAD']).stdout.trim();
        expect(drain().status).toBe(0);
        const s = statusJson();
        expect(s.status).toBe('error');
        expect(s.message).toContain('git commit failed');
        expect(s.drainable).toBe(1);
        expect(git(['rev-list', '--count', 'HEAD']).stdout.trim()).toBe(before);
        expect(staged()).toBe('');
        expect(spoolText()).toContain(CLEAN);
        if (original) fs.writeFileSync(hookPath, original); else fs.rmSync(hookPath);
        drain();
        expect(statusJson().status).toBe('ok');
        expect(remoteFiles()).toContain(CLEAN);
      });
    }
  });

  test('a push that keeps failing stays push_failed on the empty-queue runs after it', () => {
    init();
    write(CLEAN, '# a plan\n');
    drain();
    const hook = path.join(bareRemote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "403 forbidden" >&2\nexit 1\n', { mode: 0o755 });
    write(CLEAN, '# a plan, revised\n');
    drain();
    expect(statusJson().status).toBe('push_failed');
    // The queue is empty now and the detector retry is throttled: still failed.
    drain();
    expect(spoolFiles()).toEqual([]);
    expect(statusJson().status).toBe('push_failed');
    expect(statusJson().message).toContain('not pushed yet');
  });

  describe('coupled groups (decision log and its active snapshot)', () => {
    test('a clean update publishes the group in one commit', () => {
      init();
      writeDecisions(['a']);
      drain();
      writeDecisions(['a', 'bb']);
      drain();
      expect(statusJson().status).toBe('ok');
      const last = spawnSync('git', ['--git-dir=' + bareRemote, 'show', '--name-only', '--format=', 'main'], { encoding: 'utf-8', timeout: 30_000 }).stdout;
      expect(last).toContain(LOG);
      expect(last).toContain(SNAP);
      expect(remoteShow(SNAP).stdout).toContain('"bb"');
    });

    test('a generation whose snapshot does not match its log waits, then publishes whole', () => {
      init();
      writeDecisions(['a']);
      drain();
      // The log gained a decision; the snapshot is not rebuilt yet.
      writeDecisions(['a', 'bb'], ['a']);
      drain();
      const s = statusJson();
      expect(s.status).toBe('idle');
      expect(s.drainable).toBe(2);
      expect(s.message).toContain('consistent generation');
      expect(remoteShow(LOG).stdout).not.toContain('"bb"');
      expect(spoolText()).toContain(LOG);
      writeDecisions(['a', 'bb']);
      drain();
      expect(statusJson().status).toBe('ok');
      expect(remoteShow(LOG).stdout).toContain('"bb"');
      expect(remoteShow(SNAP).stdout).toContain('"bb"');
    });

    test('a held snapshot holds its log; a second machine restores a consistent generation', async () => {
      init();
      writeDecisions(['a']);
      drain();
      writeDecisions(['a', 'bb'], ['a', 'bb'], TOKEN);
      drain();
      const s = statusJson();
      expect(s.status).toBe('held');
      expect(s.held).toHaveLength(1);
      expect(s.held[0].path).toBe(SNAP);
      expect(s.held[0].dependents).toEqual([LOG]);
      expect(s.held_count).toBe(2);
      expect(s.held[0].fixes[1]).toContain('the files coupled with it');
      expect(remoteShow(LOG).stdout).not.toContain('"bb"');
      expect(spoolText()).toContain(LOG);

      const machineB = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-machineB-'));
      try {
        expect(run(['gstack-brain-restore', bareRemote], { env: { GSTACK_HOME: machineB } }).status).toBe(0);
        const { decisionPaths, readSnapshot, readEvents, computeActive } = await import('../lib/gstack-decision');
        const paths = decisionPaths('p', machineB);
        const fromSnapshot = readSnapshot(paths).map((d) => d.id).sort();
        const fromLog = computeActive(readEvents(paths)).map((d) => d.id).sort();
        expect(fromSnapshot).toEqual(['a']);
        expect(fromLog).toEqual(fromSnapshot);
      } finally {
        fs.rmSync(machineB, { recursive: true, force: true });
      }
    });

    test('skipping the blocking path stops the whole group; unskipping publishes it whole', () => {
      init();
      writeDecisions(['a']);
      drain();
      writeDecisions(['a', 'bb'], ['a', 'bb'], TOKEN);
      drain();
      expect(statusJson().status).toBe('held');
      run(['gstack-brain-sync', '--skip-file', SNAP]);
      drain();
      expect(statusJson().held_count).toBe(0);
      expect(spoolFiles()).toEqual([]);
      expect(remoteShow(LOG).stdout).not.toContain('"bb"');
      // Another decision while the group is skipped still never publishes the log alone.
      writeDecisions(['a', 'bb', 'ccc'], ['a', 'bb', 'ccc'], TOKEN);
      drain();
      expect(remoteShow(LOG).stdout).not.toContain('"ccc"');

      writeDecisions(['a', 'bb', 'ccc'], ['a', 'bb', 'ccc'], 'clean');
      run(['gstack-brain-sync', '--unskip-file', SNAP]);
      drain();
      expect(statusJson().status).toBe('ok');
      const last = spawnSync('git', ['--git-dir=' + bareRemote, 'show', '--name-only', '--format=', 'main'], { encoding: 'utf-8', timeout: 30_000 }).stdout;
      expect(last).toContain(LOG);
      expect(last).toContain(SNAP);
      expect(remoteShow(LOG).stdout).toContain('"ccc"');
      expect(remoteShow(SNAP).stdout).toContain('"ccc"');
    });
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
