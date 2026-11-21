/**
 * #3197: lib/script-invocation.ts is the one way TypeScript runs gstack's
 * shebang bins and `bash -c` strings. Windows is simulated with an injected
 * platform and filesystem; the fixture table is the shared contract for
 * Windows bash discovery.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import {
  bashCommandInvocation, resolveWindowsBash, resolveWindowsBashCached, runBashSync, runScriptSync, scriptInvocation, wtreeFingerprint,
  type BashProbe,
} from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/windows-bash-resolution.json'), 'utf8')) as {
  rows: Array<{ name: string; env?: Record<string, string>; exists: string[]; gitExecPath?: string; which?: Record<string, string>; uname?: string;
    expect: { bash: string; source: string } | { refused: true; mentions: string[] }; warning?: string | null }>;
};
const WIN_GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';
const noBash: BashProbe = { platform: 'win32', env: {}, exists: () => false, gitExecPath: () => null, which: () => null };

function probeFor(row: (typeof table.rows)[number]): BashProbe {
  return {
    platform: 'win32',
    env: row.env ?? {},
    exists: p => row.exists.includes(p),
    gitExecPath: () => row.gitExecPath ?? null,
    which: c => row.which?.[c] ?? null,
    uname: () => row.uname ?? null,
  };
}

describe('Windows bash resolution (fixture table)', () => {
  for (const row of table.rows) {
    test(row.name, () => {
      const res = resolveWindowsBash(probeFor(row));
      if ('bash' in row.expect) {
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect({ bash: res.bash, source: res.source }).toEqual(row.expect);
      } else {
        expect(res.ok).toBe(false);
        if (res.ok) return;
        for (const m of row.expect.mentions) expect(res.message).toContain(m);
        expect(res.message).toContain('GSTACK_GIT_BASH');
      }
      if (row.warning !== undefined) expect(res.warning ?? null).toBe(row.warning === null ? null : `gstack: ${row.warning}`);
    });
  }

  test('WSL launchers are rejected without being probed', () => {
    let probed = false;
    const res = resolveWindowsBash({ ...noBash, which: () => 'C:\\Windows\\System32\\bash.exe', uname: () => { probed = true; return 'MINGW64_NT'; } });
    expect(res.ok).toBe(false);
    expect(probed).toBe(false);
  });
});

describe('scriptInvocation', () => {
  const win: BashProbe = { platform: 'win32', env: {}, exists: p => p === WIN_GIT_BASH, gitExecPath: () => null, which: () => null };

  test('a bash-shebang bin on Windows runs through Git Bash with a forward-slashed script path', () => {
    const inv = scriptInvocation(path.join(BIN, 'gstack-wtree'), ['--x'], win);
    expect(inv).toEqual({ ok: true, cmd: WIN_GIT_BASH, argv: [path.join(BIN, 'gstack-wtree').replace(/\\/g, '/'), '--x'] });
  });

  test('a bash-shebang bin on POSIX execs directly', () => {
    expect(scriptInvocation(path.join(BIN, 'gstack-slug'), [], { platform: 'linux' })).toEqual({ ok: true, cmd: path.join(BIN, 'gstack-slug'), argv: [] });
  });

  test('a bun-shebang bin runs under Bun on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const inv = scriptInvocation(path.join(BIN, 'gstack-redact'), ['--json'], { ...win, platform });
      expect(inv).toEqual({ ok: true, cmd: process.execPath, argv: [...bunIsolationArgs(platform as NodeJS.Platform), path.join(BIN, 'gstack-redact'), '--json'] });
    }
  });

  test('no bash on Windows: an actionable refusal, not a spawn error', () => {
    const inv = scriptInvocation(path.join(BIN, 'gstack-wtree'), [], noBash);
    expect(inv.ok).toBe(false);
    if (inv.ok) return;
    expect(inv.error).toContain('(BASH_UNAVAILABLE)');
    expect(inv.error).toContain('GSTACK_GIT_BASH');
  });

  test('bash -c goes through the same resolver', () => {
    expect(bashCommandInvocation('echo hi', win)).toEqual({ ok: true, cmd: WIN_GIT_BASH, argv: ['-c', 'echo hi'] });
    expect(bashCommandInvocation('echo hi', { platform: 'linux' })).toEqual({ ok: true, cmd: 'bash', argv: ['-c', 'echo hi'] });
    expect(bashCommandInvocation('echo hi', noBash).ok).toBe(false);
  });

  test('runScriptSync and runBashSync return a spawnSync-shaped failure the callers already handle', () => {
    const r = runScriptSync(path.join(BIN, 'gstack-wtree'), [], { encoding: 'utf8', timeout: 5_000 }, noBash);
    expect(r.status).toBeNull();
    expect(r.stdout).toBe('');
    expect((r.error as NodeJS.ErrnoException).code).toBe('BASH_UNAVAILABLE');
    expect(r.error?.message).toContain('GSTACK_GIT_BASH');
    const b = runBashSync('true', { encoding: 'utf8', timeout: 5_000 }, noBash);
    expect((b.error as NodeJS.ErrnoException).code).toBe('BASH_UNAVAILABLE');
    expect(runBashSync('echo ok', { encoding: 'utf8', timeout: 5_000 }).stdout.trim()).toBe('ok');
  });
});

describe('resolveWindowsBashCached (the hooks hot path)', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bash-cache-'));
  const base = (calls: { n: number }, mtime = { v: 1 }, live = new Set([WIN_GIT_BASH])): Parameters<typeof resolveWindowsBashCached>[1] => ({
    platform: 'win32', env: {},
    exists: p => live.has(p),
    gitExecPath: () => { calls.n++; return 'C:/Program Files/Git/mingw64/libexec/git-core'; },
    which: c => (c === 'git' ? 'C:/Program Files/Git/cmd/git.exe' : null),
    stat: () => ({ mtimeMs: mtime.v }),
  });

  test('second resolution is served from the cache without asking git', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'windows-bash.json');
      const calls = { n: 0 };
      const first = resolveWindowsBashCached(file, base(calls));
      expect(first.ok && first.bash).toBe(WIN_GIT_BASH);
      expect(calls.n).toBe(1);
      const second = resolveWindowsBashCached(file, base(calls));
      expect(second.ok && second.bash).toBe(WIN_GIT_BASH);
      expect(second.ok && second.source).toBe('git --exec-path (cached)');
      expect(calls.n).toBe(1);
      expect(fs.readdirSync(dir)).toEqual(['windows-bash.json']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a new git.exe mtime or a vanished cached bash re-resolves', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'windows-bash.json');
      const calls = { n: 0 };
      const mtime = { v: 1 };
      resolveWindowsBashCached(file, base(calls, mtime));
      mtime.v = 2;
      resolveWindowsBashCached(file, base(calls, mtime));
      expect(calls.n).toBe(2);
      const live = new Set(['C:/Program Files/Git/usr/bin/bash.exe']);
      const moved = resolveWindowsBashCached(file, base(calls, mtime, live));
      expect(moved.ok && moved.bash).toBe('C:/Program Files/Git/usr/bin/bash.exe');
      expect(calls.n).toBe(3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('the override bypasses the cache and is never written to it', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'windows-bash.json');
      const calls = { n: 0 };
      const res = resolveWindowsBashCached(file, { ...base(calls), env: { GSTACK_GIT_BASH: 'D:/x/bash.exe' }, exists: p => p === 'D:/x/bash.exe' });
      expect(res.ok && res.source).toBe('GSTACK_GIT_BASH');
      expect(fs.existsSync(file)).toBe(false);
      expect(calls.n).toBe(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a refusal is not cached', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'windows-bash.json');
      const res = resolveWindowsBashCached(file, { ...base({ n: 0 }), exists: () => false });
      expect(res.ok).toBe(false);
      expect(fs.existsSync(file)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('wtreeFingerprint', () => {
  const repo = (extra: string[] = []) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-wtree-fp-'));
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    git('init', '-q', ...extra);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    return dir;
  };

  test('a SHA-1 repository yields a 40-hex tree', () => {
    const dir = repo();
    try {
      const r = wtreeFingerprint({ cwd: dir });
      expect('tree' in r && r.tree).toMatch(/^[0-9a-f]{40}$/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a SHA-256 repository yields a 64-hex tree', () => {
    const dir = repo(['--object-format=sha256']);
    try {
      const r = wtreeFingerprint({ cwd: dir });
      expect('tree' in r && r.tree).toMatch(/^[0-9a-f]{64}$/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a launch failure (no bash on Windows) is distinguished from a helper exit', () => {
    const dir = repo();
    try {
      const launch = wtreeFingerprint({ cwd: dir, invocation: noBash });
      expect(launch).toMatchObject({ kind: 'launch' });
      expect('error' in launch && launch.error).toContain('GSTACK_GIT_BASH');
      const exit = wtreeFingerprint({ cwd: dir, env: { ...process.env, TMPDIR: path.join(dir, 'no-such-dir') } });
      expect(exit).toMatchObject({ kind: 'exit' });
      expect('error' in exit && exit.error).toMatch(/^gstack-wtree exited 1: .*set TMPDIR to a writable directory/);
      expect(wtreeFingerprint({ cwd: os.tmpdir() })).toMatchObject({ kind: 'exit' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('always runs with GIT_OPTIONAL_LOCKS=0', () => {
    const dir = repo();
    const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-wtree-shim-'));
    try {
      const realGit = Bun.which('git')!;
      const log = path.join(shim, 'locks.log');
      fs.writeFileSync(path.join(shim, 'git'), `#!/bin/sh\necho "\${GIT_OPTIONAL_LOCKS:-unset}" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
      const r = wtreeFingerprint({ cwd: dir, env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}`, GIT_OPTIONAL_LOCKS: '1' } });
      expect('tree' in r).toBe(true);
      const seen = new Set(fs.readFileSync(log, 'utf8').trim().split('\n'));
      expect([...seen]).toEqual(['0']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(shim, { recursive: true, force: true }); }
  });
});

describe('runScriptSync and runBashSync with output past maxBuffer (GST-3104)', () => {
  // A child that ignores SIGTERM outlives Bun's overflow kill and exits 0, so raw spawnSync would
  // report status 0 with ENOBUFS and cut-off stdout (GST-3086); these runners must report status null.
  // The write fits the Unix socket send buffer, so the child really exits 0 (see test/spawn-sync.test.ts).
  const OVERFLOW = "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(32768)); setTimeout(() => {}, 300);";
  const expectIncomplete = (r: { status: number | null; error?: Error; stderr: string }) => {
    expect(r.status).toBeNull();
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOBUFS');
    expect(r.stderr.trimEnd().split('\n').pop() ?? '').toEndWith('(SPAWN_OUTPUT_INCOMPLETE)');
  };

  test('a bun-shebang script that overflows and exits 0 is not a finished read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-invocation-overflow-'));
    try {
      const script = path.join(dir, 'gstack-overflow');
      fs.writeFileSync(script, `#!/usr/bin/env bun\n${OVERFLOW}\n`, { mode: 0o755 });
      expectIncomplete(runScriptSync(script, [], { encoding: 'utf8', maxBuffer: 1024, timeout: 20_000 }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // POSIX only: the command needs a POSIX bash with trap and /dev/zero.
  test.skipIf(process.platform === 'win32')('a bash -c string that overflows and exits 0 is not a finished read', () => {
    expectIncomplete(runBashSync("trap '' TERM; head -c 200000 /dev/zero | tr '\\0' x; sleep 0.3; exit 0", { encoding: 'utf8', maxBuffer: 1024, timeout: 20_000 }));
  });
});

