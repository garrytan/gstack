/**
 * gstack-clean (#2627, GSTA-226 D8/D9): dry run changes nothing, apply removes
 * exactly the allowlist, every refusal touches nothing, links never lead it
 * outside the folder, liveness and unknown liveness skip a group, the in-place
 * cut keeps the inode and a line boundary, audit rotation keeps newer and
 * unreadable lines byte for byte, exit codes 0/1/2/3, and the --json shape.
 * Fixtures live under os.tmpdir(), outside any checkout, with GSTACK_HOME at
 * a temp state root; every fixture path is resolved and checked to stay there.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-clean');
const DAY = 24 * 60 * 60 * 1000;
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    spawnSync('chmod', ['-R', 'u+rwx', root], { timeout: 10_000 });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture { root: string; home: string; state: string; repo: string; gs: string }

/** Bun's install cache and the machine's git shim write under HOME; neither is gstack-clean's doing. */
const HOME_NOISE = new Set(['home/.bun', 'home/.capy']);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}

function inRoot(root: string, p: string): string {
  const real = fs.realpathSync(p);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(p + ' resolves outside the fixture root ' + root);
  return real;
}

function fixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-clean-')));
  roots.push(root);
  if (root.startsWith(ROOT + path.sep)) throw new Error('fixture root is inside the checkout');
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(state);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  expect(git(repo, 'rev-parse', '--show-toplevel')).toBe(repo);
  const gs = path.join(repo, '.gstack');
  fs.mkdirSync(path.join(gs, 'tmp'), { recursive: true });
  inRoot(root, gs);
  fs.mkdirSync(path.join(root, 'quiet-ps'));
  fs.writeFileSync(path.join(root, 'quiet-ps', 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { root, home, state, repo, gs };
}

function put(file: string, content: string | Buffer, ageMs = 30 * DAY): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
}

/** Log text of whole numbered lines, about the given size. */
function logText(bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = 'line ' + String(i).padStart(7, '0') + ' ' + 'x'.repeat(i % 90) + '\n';
    lines.push(line);
    size += line.length;
  }
  return lines.join('');
}

function deadPid(): number {
  const r = spawnSync('true', [], { timeout: 10_000 });
  return r.pid!;
}

/** A ps that lists no process, so an unrelated codex elsewhere on the host cannot skip tmp/; realPs keeps the host's. */
function quietPsPath(f: Fixture): string {
  return path.join(f.root, 'quiet-ps') + path.delimiter + (process.env.PATH ?? '');
}

function run(f: Fixture, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; realPs?: boolean } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: f.home, GSTACK_HOME: f.state, ...(opts.realPs ? {} : { PATH: quietPsPath(f) }), ...opts.env };
  for (const name of ['GSTACK_STATE_ROOT', 'GSTACK_STATE_DIR', 'CLAUDE_PLUGIN_DATA', 'BROWSE_STATE_FILE']) if (!(opts.env && name in opts.env)) delete env[name];
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const r = spawnSync(process.execPath, [...bunIsolationArgs(), BIN, ...args], { cwd: opts.cwd ?? f.repo, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Every entry under the fixture root (links not followed): type, inode, mtime and content hash. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      const rel = path.relative(root, p);
      if (HOME_NOISE.has(rel)) continue;
      if (st.isSymbolicLink()) out[rel] = 'link ' + fs.readlinkSync(p);
      else if (st.isDirectory()) { out[rel] = 'dir'; walk(p); }
      else out[rel] = 'file ' + st.ino + ' ' + st.mtimeMs + ' ' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

function changedKeys(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]).sort();
}

/** A .gstack with one of everything: targets, near misses and protected files. */
function populate(f: Fixture): void {
  const t = path.join(f.gs, 'tmp');
  put(path.join(t, 'codex-err-old1'), 'old stderr', 8 * DAY);
  put(path.join(t, 'codex-resp-old2'), 'old response', 400 * DAY);
  put(path.join(t, 'codex-resp-new'), 'two days old', 2 * DAY);
  for (const name of ['restamp-journal.json', 'gate-ahead.json', 'gate-ahead-2.json', 'pregate.json', 'ship-receipt.md', 'brief.AbC123', 'page.Xy12'])
    put(path.join(t, name), '{"keep":true}', 400 * DAY);
  for (const dir of ['autoplan', 'ship-queue', 'eval-bisect', 'price-gate']) put(path.join(t, dir, 'codex-nested-old'), 'nested', 400 * DAY);
  put(path.join(t, 'codex-dir', 'inside'), 'a directory named like scratch', 400 * DAY);
  put(path.join(f.gs, 'browse-console.log'), logText(1.5 * 1024 * 1024), 2 * 60 * 60 * 1000);
  put(path.join(f.gs, 'browse-network.log'), logText(500 * 1024), 400 * DAY);
  put(path.join(f.gs, 'browse-daemon.log.1'), logText(2 * 1024 * 1024), 400 * DAY);
  put(path.join(f.gs, 'browse-audit.jsonl'), '{"ts":"2020-01-01T00:00:00.000Z","cmd":"goto"}\n', 400 * DAY);
  put(path.join(f.gs, 'browse.json'), JSON.stringify({ pid: deadPid(), port: 1 }), 400 * DAY);
  put(path.join(f.gs, 'session-state.json'), '{"cookies":[]}', 400 * DAY);
  put(path.join(f.gs, 'chromium-profile', 'Default', 'Cookies'), 'cookies', 400 * DAY);
  put(path.join(f.gs, 'browser-skills', 'mine', 'script.ts'), 'export {}', 400 * DAY);
  put(path.join(f.gs, 'browse-states', 'saved.json'), '{}', 400 * DAY);
}

describe('gstack-clean', () => {
  test('dry run changes no byte or mtime and names the target first', () => {
    const f = fixture();
    populate(f);
    const before = snapshot(f.root);
    const r = run(f, []);
    expect(r.code).toBe(0);
    expect(changedKeys(before, snapshot(f.root))).toEqual([]);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('gstack-clean: target ' + f.gs + ' (the .gstack folder at the git toplevel ' + f.repo + ')');
    expect(r.out).toMatch(/would remove +tmp\/codex-err-old1 \(10 bytes\)/);
    expect(r.out).toMatch(/would cut +browse-console\.log \(freeing \d+ bytes\)/);
    expect(r.out).toMatch(/skip +tmp\/codex-dir: is not a regular file/);
    expect(r.out).toMatch(/^total: 3 actions would free \d+ bytes; 1 skipped$/m);
    expect(lines.at(-1)).toBe('nothing changed; to do this: gstack-clean --apply');
  });

  test('apply removes exactly the allowlist; protected files survive at any age', () => {
    const f = fixture();
    populate(f);
    const before = snapshot(f.root);
    const r = run(f, ['--apply']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const after = snapshot(f.root);
    expect(changedKeys(before, after)).toEqual([
      'repo/.gstack/browse-console.log',
      'repo/.gstack/tmp/codex-err-old1',
      'repo/.gstack/tmp/codex-resp-old2',
    ]);
    expect(after['repo/.gstack/tmp/codex-err-old1']).toBeUndefined();
    expect(after['repo/.gstack/browse-console.log']).toBeDefined();
    expect(r.out).toMatch(/^removed +tmp\/codex-resp-old2 \(12 bytes\)/m);
    expect(r.out).toMatch(/^total: 3 actions freed \d+ bytes; 1 skipped$/m);
    expect(r.out).not.toContain('nothing changed');
  });

  test('a missing .gstack is nothing to clean', () => {
    const f = fixture();
    fs.rmSync(f.gs, { recursive: true });
    const r = run(f, ['--apply']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('nothing to clean: ' + f.gs + ' does not exist');
  });

  describe('refusals touch nothing (exit 3)', () => {
    const refused = (f: Fixture, r: ReturnType<typeof run>, before: Record<string, string>, why: RegExp) => {
      expect(r.code).toBe(3);
      expect(r.out).toBe('');
      expect(r.err.trim()).toMatch(why);
      expect(r.err.trim()).toEndWith('(GSTACK_CLEAN_TARGET_REFUSED)');
      expect(changedKeys(before, snapshot(f.root))).toEqual([]);
    };

    test('outside git', () => {
      const f = fixture();
      const plain = path.join(f.root, 'plain');
      put(path.join(plain, '.gstack', 'tmp', 'codex-err-old'), 'x', 30 * DAY);
      const before = snapshot(f.root);
      refused(f, run(f, ['--apply'], { cwd: plain }), before, /is not inside a git work tree/);
    });

    test('a symlinked .gstack', () => {
      const f = fixture();
      fs.rmSync(f.gs, { recursive: true });
      const elsewhere = path.join(f.root, 'elsewhere');
      put(path.join(elsewhere, 'tmp', 'codex-err-old'), 'x', 30 * DAY);
      fs.symlinkSync(elsewhere, f.gs);
      const before = snapshot(f.root);
      refused(f, run(f, ['--apply']), before, /\.gstack is a symlink/);
    });

    test('BROWSE_STATE_FILE naming another folder; its own browse.json is accepted', () => {
      const f = fixture();
      put(path.join(f.gs, 'tmp', 'codex-err-old'), 'x', 30 * DAY);
      const before = snapshot(f.root);
      const foreign = path.join(f.root, 'other', '.gstack', 'browse.json');
      refused(f, run(f, ['--apply'], { env: { BROWSE_STATE_FILE: foreign } }), before, /BROWSE_STATE_FILE is .*other\/\.gstack\/browse\.json/);
      const own = run(f, [], { env: { BROWSE_STATE_FILE: path.join(f.gs, 'browse.json') } });
      expect(own.code).toBe(0);
      expect(own.out).toContain('would remove');
    });

    test('the target is the state root (HOME/.gstack with GSTACK_HOME=HOME/.gstack)', () => {
      const f = fixture();
      git(f.home, 'init', '-q');
      const home = path.join(f.home, '.gstack');
      put(path.join(home, 'tmp', 'codex-err-old'), 'x', 30 * DAY);
      put(path.join(home, 'projects', 'p', 'learnings.jsonl'), '{}\n', 30 * DAY);
      const before = snapshot(f.root);
      refused(f, run(f, ['--apply'], { cwd: f.home, env: { HOME: f.home, GSTACK_HOME: home } }), before, /sits inside the gstack state root/);
    });

    test('the target holds the state root', () => {
      const f = fixture();
      put(path.join(f.gs, 'tmp', 'codex-err-old'), 'x', 30 * DAY);
      const inner = path.join(f.gs, 'state');
      fs.mkdirSync(inner);
      const before = snapshot(f.root);
      refused(f, run(f, ['--apply'], { env: { GSTACK_HOME: inner } }), before, /holds or sits inside the gstack state root/);
    });
  });

  test('a link in tmp/ pointing outside leaves the outside file intact', () => {
    const f = fixture();
    const outside = put(path.join(f.root, 'outside', 'codex-precious'), 'precious', 30 * DAY);
    fs.symlinkSync(outside, path.join(f.gs, 'tmp', 'codex-link'));
    const before = snapshot(f.root);
    const r = run(f, ['--apply']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/skip +tmp\/codex-link: is a symlink/);
    expect(changedKeys(before, snapshot(f.root))).toEqual([]);
    expect(fs.readFileSync(outside, 'utf8')).toBe('precious');
  });

  test('a symlinked tmp/ refuses the tmp group', () => {
    const f = fixture();
    fs.rmSync(path.join(f.gs, 'tmp'), { recursive: true });
    const outsideTmp = path.join(f.root, 'outside-tmp');
    put(path.join(outsideTmp, 'codex-err-old'), 'x', 30 * DAY);
    fs.symlinkSync(outsideTmp, path.join(f.gs, 'tmp'));
    const before = snapshot(f.root);
    const r = run(f, ['--apply']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/skip +tmp: tmp\/ is a symlink; the tmp group is refused/);
    expect(changedKeys(before, snapshot(f.root))).toEqual([]);
  });

  describe('liveness', () => {
    const bigLog = (f: Fixture, ageMs = 2 * 60 * 60 * 1000) => put(path.join(f.gs, 'browse-console.log'), logText(1.2 * 1024 * 1024), ageMs);

    test('a live browse daemon (browse.json names a running pid) skips browse files', () => {
      const f = fixture();
      bigLog(f);
      put(path.join(f.gs, 'browse.json'), JSON.stringify({ pid: process.pid, port: 1 }));
      const before = snapshot(f.root);
      const r = run(f, ['--apply']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('skip         browse-console.log: the browse daemon (pid ' + process.pid + ', browse.json) is running');
      expect(changedKeys(before, snapshot(f.root))).toEqual([]);
    });

    test('a starting daemon (browse.json.lock with a live pid) skips browse files', () => {
      const f = fixture();
      bigLog(f);
      put(path.join(f.gs, 'browse.json.lock'), process.pid + '\n');
      const r = run(f, ['--apply']);
      expect(r.out).toContain('browse.json.lock) is running');
      expect(fs.statSync(path.join(f.gs, 'browse-console.log')).size).toBeGreaterThan(1024 * 1024);
    });

    test('an unreadable browse.json is unknown liveness and skips browse files', () => {
      const f = fixture();
      bigLog(f);
      put(path.join(f.gs, 'browse.json'), 'not json');
      const before = snapshot(f.root);
      const r = run(f, ['--apply']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('browse.json names no pid, so the browse daemon may be running');
      expect(changedKeys(before, snapshot(f.root))).toEqual([]);
    });

    test('no process listing is unknown liveness and skips tmp/', () => {
      const f = fixture();
      put(path.join(f.gs, 'tmp', 'codex-err-old'), 'x', 30 * DAY);
      const failingPs = path.join(f.root, 'failing-ps');
      fs.mkdirSync(failingPs);
      fs.writeFileSync(path.join(failingPs, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const before = snapshot(path.join(f.repo));
      const r = run(f, ['--apply'], { env: { PATH: failingPs + path.delimiter + (process.env.PATH ?? '') } });
      expect(r.code).toBe(0);
      expect(r.out).toContain('skip         tmp/codex-err-old: cannot list processes to tell whether codex is running');
      expect(changedKeys(before, snapshot(f.repo))).toEqual([]);
    });

    test('a running codex skips tmp/', async () => {
      const f = fixture();
      put(path.join(f.gs, 'tmp', 'codex-err-old'), 'x', 30 * DAY);
      const fake = path.join(f.root, 'fakebin', 'codex');
      put(fake, '#!/bin/sh\nsleep 30\n', 0);
      fs.chmodSync(fake, 0o755);
      const child = spawn(fake, [], { stdio: 'ignore' });
      try {
        await Bun.sleep(300);
        const r = run(f, ['--apply'], { realPs: true });
        expect(r.code).toBe(0);
        expect(r.out).toMatch(/skip +tmp\/codex-err-old: codex is running/);
        expect(fs.existsSync(path.join(f.gs, 'tmp', 'codex-err-old'))).toBe(true);
      } finally {
        child.kill('SIGKILL');
      }
    });

    test('a file modified within the last hour is skipped', () => {
      const f = fixture();
      bigLog(f, 0);
      const before = snapshot(f.root);
      const r = run(f, ['--apply']);
      expect(r.out).toContain('skip         browse-console.log: modified within the last hour');
      expect(changedKeys(before, snapshot(f.root))).toEqual([]);
    });
  });

  test('the in-place cut keeps the inode and starts on a line boundary', () => {
    const f = fixture();
    const text = logText(1.5 * 1024 * 1024);
    const log = put(path.join(f.gs, 'browse-daemon.log'), text, 2 * 60 * 60 * 1000);
    const ino = fs.statSync(log).ino;
    const r = run(f, ['--apply']);
    expect(r.code).toBe(0);
    const kept = fs.readFileSync(log, 'utf8');
    expect(fs.statSync(log).ino).toBe(ino);
    expect(kept.length).toBeLessThanOrEqual(256 * 1024);
    expect(kept.length).toBeGreaterThan(255 * 1024 - 200);
    expect(text.endsWith(kept)).toBe(true);
    expect(text[text.length - kept.length - 1]).toBe('\n');
    expect(kept.startsWith('line ')).toBe(true);
    expect(r.out).toMatch(new RegExp('^cut +browse-daemon\\.log \\(freed ' + (text.length - kept.length) + ' bytes\\)', 'm'));
  });

  test('--audit-days keeps newer and unparseable lines byte for byte; a malformed file is left alone', () => {
    const f = fixture();
    const iso = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();
    const oldLine = '{"ts":"' + iso(40 * DAY) + '","cmd":"goto"}\n';
    const keepLines = [
      '{"ts":"' + iso(DAY) + '","cmd":"text","args":"caf\u00e9"}\n',
      '{"cmd":"no-ts"}\n',
      '{"ts":"not a date","cmd":"bad-ts"}\n',
      '\n',
      '{"ts":"' + iso(2 * DAY) + '",  "cmd":"spaced"}',
    ];
    const audit = put(path.join(f.gs, 'browse-audit.jsonl'), oldLine + keepLines[0] + oldLine + keepLines.slice(1).join(''), 2 * 60 * 60 * 1000);
    const ino = fs.statSync(audit).ino;
    const untouched = run(f, ['--apply']);
    expect(untouched.out).not.toContain('browse-audit.jsonl');
    const r = run(f, ['--apply', '--audit-days', '30']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^trimmed +browse-audit\.jsonl \(freed \d+ bytes\): audit entries older than 30 days/m);
    expect(fs.readFileSync(audit, 'utf8')).toBe(keepLines.join(''));
    expect(fs.statSync(audit).ino).toBe(ino);

    const g = fixture();
    put(path.join(g.gs, 'browse-audit.jsonl'), oldLine + '{"ts": truncated\n', 2 * 60 * 60 * 1000);
    const before = snapshot(g.root);
    const bad = run(g, ['--apply', '--audit-days=30']);
    expect(bad.code).toBe(0);
    expect(bad.out).toContain('skip         browse-audit.jsonl: line 2 is not JSON, so the file was left as it is');
    expect(changedKeys(before, snapshot(g.root))).toEqual([]);
  });

  test('a hard-linked log is left alone, and the other inode keeps every byte', () => {
    const f = fixture();
    const outside = put(path.join(f.root, 'outside.txt'), logText(1.2 * 1024 * 1024), 2 * 60 * 60 * 1000);
    fs.linkSync(outside, path.join(f.gs, 'browse-console.log'));
    const before = fs.readFileSync(outside);
    const r = run(f, ['--apply']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/skip +browse-console\.log: .*hard link/);
    expect(fs.readFileSync(outside).equals(before)).toBe(true);
  });

  test.skipIf(process.getuid?.() === 0)('an unlistable tmp/ skips the tmp group and the browse logs are still cut', () => {
    const f = fixture();
    const log = put(path.join(f.gs, 'browse-console.log'), logText(1.2 * 1024 * 1024), 2 * 60 * 60 * 1000);
    fs.chmodSync(path.join(f.gs, 'tmp'), 0o000);
    try {
      const r = run(f, ['--apply']);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/skip +tmp: cannot list/);
      expect(fs.statSync(log).size).toBeLessThanOrEqual(256 * 1024);
    } finally {
      fs.chmodSync(path.join(f.gs, 'tmp'), 0o755);
    }
  });

  test('a log with no line break in its last 256 KB is left alone', () => {
    const f = fixture();
    put(path.join(f.gs, 'browse-network.log'), 'x'.repeat(1.2 * 1024 * 1024), 2 * 60 * 60 * 1000);
    const before = snapshot(f.root);
    const r = run(f, ['--apply']);
    expect(r.out).toMatch(/skip +browse-network\.log: no line break/);
    expect(changedKeys(before, snapshot(f.root))).toEqual([]);
  });

  test('an audit line that is not a JSON object leaves the audit file alone', () => {
    const f = fixture();
    put(path.join(f.gs, 'browse-audit.jsonl'), '{"ts":"2020-01-01T00:00:00Z"}\n[1]\n', 2 * 60 * 60 * 1000);
    const before = snapshot(f.root);
    const r = run(f, ['--apply', '--audit-days', '7']);
    expect(r.out).toMatch(/skip +browse-audit\.jsonl: line 2 is not a JSON object/);
    expect(changedKeys(before, snapshot(f.root))).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)('an unreadable log is skipped and the rest still runs', () => {
    const f = fixture();
    put(path.join(f.gs, 'tmp', 'codex-err-old'), 'x', 30 * DAY);
    const log = put(path.join(f.gs, 'browse-console.log'), logText(1.2 * 1024 * 1024), 2 * 60 * 60 * 1000);
    fs.chmodSync(log, 0o000);
    try {
      const r = run(f, ['--apply']);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/skip +browse-console\.log: cannot read/);
      expect(fs.existsSync(path.join(f.gs, 'tmp', 'codex-err-old'))).toBe(false);
    } finally {
      fs.chmodSync(log, 0o644);
    }
  });

  test('--json reaches a pipe whole with hundreds of actions', () => {
    const f = fixture();
    for (let i = 0; i < 300; i++) put(path.join(f.gs, 'tmp', 'codex-err-' + String(i).padStart(6, '0')), 'x', 30 * DAY);
    const env: Record<string, string> = { PATH: quietPsPath(f), HOME: f.home, GSTACK_HOME: f.state };
    const cmd = [process.execPath, ...bunIsolationArgs(), BIN, '--json'].map(a => "'" + a.replace(/'/g, "'\''") + "'").join(' ') + ' | (sleep 1; cat)';
    const r = spawnSync('sh', ['-c', cmd], { cwd: f.repo, env, encoding: 'utf8', timeout: 30_000 });
    expect(JSON.parse(r.stdout).actions.length).toBe(300);
  });

  describe('exit codes', () => {
    test('2: an unknown flag or a bad --audit-days quotes the value; the last line is usage', () => {
      const f = fixture();
      for (const [args, quoted] of [[['--force'], '"--force"'], [['--audit-days', 'abc'], '"abc"'], [['--audit-days=0'], '"0"'], [['--audit-days'], '""']] as const) {
        const r = run(f, [...args]);
        expect(r.code).toBe(2);
        expect(r.out).toBe('');
        const lines = r.err.trimEnd().split('\n');
        expect(lines[0]).toContain(quoted);
        expect(lines[0]).toEndWith('(GSTACK_CLEAN_USAGE)');
        expect(lines.at(-1)).toBe('usage: gstack-clean [--apply] [--audit-days N] [--json]');
      }
    });

    test.skipIf(process.getuid?.() === 0)('1: a read-only folder and a read-only file give FAILED lines; rerunning is safe', () => {
      const f = fixture();
      put(path.join(f.gs, 'tmp', 'codex-err-old'), 'x', 30 * DAY);
      const log = put(path.join(f.gs, 'browse-dialog.log'), logText(1.1 * 1024 * 1024), 2 * 60 * 60 * 1000);
      fs.chmodSync(log, 0o444);
      fs.chmodSync(path.join(f.gs, 'tmp'), 0o555);
      try {
        const r = run(f, ['--apply']);
        expect(r.code).toBe(1);
        expect(r.out).toContain('FAILED ' + path.join(f.gs, 'tmp', 'codex-err-old') + ' EACCES');
        expect(r.out).toContain('FAILED ' + log + ' EACCES');
        expect(r.err).toContain('rerunning is safe');
        expect(r.err.trim()).toEndWith('(GSTACK_CLEAN_PARTIAL)');
      } finally {
        fs.chmodSync(path.join(f.gs, 'tmp'), 0o755);
      }
      expect(fs.existsSync(path.join(f.gs, 'tmp', 'codex-err-old'))).toBe(true);
    });

    test('--help lists the fixed thresholds and exits 0', () => {
      const f = fixture();
      const r = run(f, ['--help']);
      expect(r.code).toBe(0);
      for (const needle of ['older than 7 days', 'over 1 MB', 'last 256 KB', '--audit-days N', 'in the last hour']) expect(r.out).toContain(needle);
    });
  });

  test('--json prints one versioned object with the same content', () => {
    const f = fixture();
    populate(f);
    const dry = run(f, ['--json']);
    expect(dry.code).toBe(0);
    const plan = JSON.parse(dry.out);
    expect(Object.keys(plan)).toEqual(['schema_version', 'tool', 'mode', 'status', 'target', 'chosen_by', 'audit_days', 'actions', 'skips', 'total', 'error', 'exit_code']);
    expect(plan).toMatchObject({ schema_version: 1, tool: 'gstack-clean', mode: 'dry-run', status: 'planned', target: f.gs, audit_days: null, error: null, exit_code: 0 });
    expect(plan.actions.map((a: any) => [a.rel, a.group, a.action, a.status])).toEqual([
      ['tmp/codex-err-old1', 'tmp', 'remove', 'planned'],
      ['tmp/codex-resp-old2', 'tmp', 'remove', 'planned'],
      ['browse-console.log', 'browse', 'cut', 'planned'],
    ]);
    expect(plan.skips).toEqual([{ path: path.join(f.gs, 'tmp', 'codex-dir'), rel: 'tmp/codex-dir', group: 'tmp', reason: 'is not a regular file; left alone' }]);
    expect(plan.total).toEqual({ actions: 3, bytes: plan.actions.reduce((n: number, a: any) => n + a.bytes, 0), failed: 0, skipped: 1 });
    const applied = JSON.parse(run(f, ['--json', '--apply']).out);
    expect(applied).toMatchObject({ mode: 'apply', status: 'done', exit_code: 0 });
    expect(applied.actions.map((a: any) => a.status)).toEqual(['done', 'done', 'done']);
    expect(JSON.parse(run(f, ['--json']).out)).toMatchObject({ status: 'nothing_to_do', actions: [] });
    const refused = run(f, ['--json'], { cwd: f.root });
    expect(refused.code).toBe(3);
    expect(JSON.parse(refused.out)).toMatchObject({ schema_version: 1, status: 'refused', error: { code: 'GSTACK_CLEAN_TARGET_REFUSED' }, exit_code: 3 });
  });
});
