/**
 * Bounded multi-signature Codex probe cache (stubbed codex, no API spend):
 * 16 entries, atomic publication, same-signature serialization with a
 * bounded lock, abandoned-owner recovery, and unverified (never a duplicate
 * paid probe) on lock timeout or unreadable cache.
 */
import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin', 'gstack-codex-probe');
const STUB = `#!/usr/bin/env bash
[ "$1" = sandbox ] && exit 0
printf '%s\\n' "$*" >> "$STUB_LOG"
[ -n "\${STUB_SLEEP:-}" ] && sleep "$STUB_SLEEP"
case "\${STUB_MODE:-ok}" in
  ok) echo OK; exit 0 ;;
  model400) echo 'ERROR: {"type":"error","status":400,"error":{"message":"The model is not supported when using Codex with a ChatGPT account."}}' >&2; exit 1 ;;
  quota) echo "ERROR: You've hit your usage limit. Try again at 3 AM." >&2; exit 1 ;;
esac
`;

interface Fixture { home: string; codexHome: string; state: string; log: string; cache: string; locks: string; env: Record<string, string> }

function fixture(): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-probe-cache-'));
  const bin = path.join(home, 'bin');
  const codexHome = path.join(home, '.codex');
  const state = path.join(home, 'state');
  for (const dir of [bin, codexHome, state]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\n');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
  const log = path.join(home, 'stub.log');
  return {
    home, codexHome, state, log,
    cache: path.join(state, '.codex-model-probe'),
    locks: path.join(state, '.codex-model-probe.locks'),
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, CODEX_HOME: codexHome, GSTACK_HOME: state, STUB_LOG: log, _TEL: 'off' },
  };
}

function probe(f: Fixture, env: Record<string, string> = {}, call = '_gstack_codex_model_probe; echo "rc=$? state=${_GSTACK_CODEX_PROBE_STATE:-}"') {
  const r = spawnSync('bash', ['-c', `source "${PROBE}"\n${call}`], { env: { ...f.env, ...env }, encoding: 'utf8', timeout: 20000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function probeAsync(f: Fixture, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', `source "${PROBE}"\n_gstack_codex_model_probe; echo "rc=$?"`], { env: { ...f.env, ...env } });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('probe hung')); }, 30000);
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

const calls = (f: Fixture) => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').split('\n').filter(Boolean).length : 0);
const entries = (f: Fixture) => fs.readFileSync(f.cache, 'utf8').split('\n').filter(line => /^MODEL_\S+ \d+ \d+$/.test(line));
const model = (name: string) => ({ GSTACK_CODEX_MODEL: name });
const withFixture = (body: (f: Fixture) => void | Promise<void>) => async () => {
  const f = fixture();
  try { await body(f); } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
};

describe('bounded multi-signature probe cache', () => {
  test('A -> B -> A makes exactly two paid probes', withFixture((f) => {
    expect(probe(f, model('gpt-a')).stdout).toContain('MODEL_OK');
    expect(probe(f, model('gpt-b')).stdout).toContain('MODEL_OK');
    const again = probe(f, model('gpt-a'));
    expect(again.stdout).toContain('MODEL_OK (cached)');
    expect(calls(f)).toBe(2);
    expect(entries(f)).toHaveLength(2);
    expect(fs.existsSync(f.locks) ? fs.readdirSync(f.locks) : []).toEqual([]);
  }));

  test('concurrent same-signature misses share one probe', withFixture(async (f) => {
    const outputs = await Promise.all([0, 1, 2, 3].map(() => probeAsync(f, { ...model('gpt-same'), STUB_SLEEP: '1' })));
    expect(calls(f)).toBe(1);
    for (const out of outputs) expect(out).toMatch(/MODEL_OK(?: \(cached\))?\nrc=0/);
    expect(outputs.filter(out => out.includes('(cached)'))).toHaveLength(3);
    expect(entries(f)).toHaveLength(1);
  }));

  test('a slow writer keeps another signature published while its round trip ran; same-signature still replaces', withFixture(async (f) => {
    const slow = probeAsync(f, { ...model('gpt-slow'), STUB_SLEEP: '3' });
    await Bun.sleep(1500);
    expect(probe(f, { ...model('gpt-fast'), STUB_MODE: 'quota' }).stdout).toContain('rc=4');
    expect(await slow).toMatch(/MODEL_OK\nrc=0/);
    expect(entries(f)).toHaveLength(2);
    expect(probe(f, model('gpt-fast')).stdout).toContain('MODEL_QUOTA_EXHAUSTED (cached)');
    expect(probe(f, model('gpt-slow')).stdout).toContain('MODEL_OK (cached)');
    expect(calls(f)).toBe(2);
    expect(probe(f, { ...model('gpt-fast'), GSTACK_CODEX_PROBE_RETRY: '1' }).stdout).toContain('MODEL_OK\n');
    expect(entries(f).map(line => line.split(' ')[0]).sort()).toEqual(['MODEL_OK', 'MODEL_OK']);
    expect(probe(f, model('gpt-fast')).stdout).toContain('MODEL_OK (cached)');
    expect(calls(f)).toBe(3);
  }));

  test('the 17th signature evicts the oldest entry; the file never exceeds 16', withFixture((f) => {
    for (let i = 1; i <= 17; i++) expect(probe(f, model(`gpt-m${i}`)).stdout).toContain('MODEL_OK');
    expect(entries(f)).toHaveLength(16);
    expect(probe(f, model('gpt-m17')).stdout).toContain('MODEL_OK (cached)');
    expect(probe(f, model('gpt-m2')).stdout).toContain('MODEL_OK (cached)');
    expect(calls(f)).toBe(17);
    expect(probe(f, model('gpt-m1')).stdout).not.toContain('(cached)');
    expect(calls(f)).toBe(18);
    expect(entries(f)).toHaveLength(16);
  }));

  test('expired entries are pruned and never hit; TTLs and negative classifications are unchanged', withFixture((f) => {
    probe(f, { ...model('gpt-bad'), STUB_MODE: 'model400' });
    probe(f, model('gpt-good'));
    const now = Math.floor(Date.now() / 1000);
    const lines = fs.readFileSync(f.cache, 'utf8').split('\n').filter(Boolean)
      .map(line => line.replace(/^(MODEL_UNUSABLE) (\d+)/, (_, s) => `${s} ${now - 901}`));
    fs.writeFileSync(f.cache, `${lines.join('\n')}\n`);
    expect(probe(f, { ...model('gpt-good') }).stdout).toContain('MODEL_OK (cached)');
    const bad = probe(f, { ...model('gpt-bad'), STUB_MODE: 'model400' });
    expect(bad.stdout).toContain('MODEL_UNUSABLE\n');
    expect(bad.stdout).toContain('rc=1');
    expect(calls(f)).toBe(3);
    expect(probe(f, { ...model('gpt-bad'), STUB_MODE: 'ok' }).stdout).toContain('MODEL_UNUSABLE (cached)');
    expect(calls(f)).toBe(3);
    const future = fs.readFileSync(f.cache, 'utf8').replace(/^MODEL_OK \d+/m, `MODEL_OK ${now + 999}`);
    fs.writeFileSync(f.cache, future);
    expect(probe(f, model('gpt-good')).stdout).not.toContain('(cached)');
  }));

  test('quota detail lines survive among other entries and are relayed on a hit', withFixture((f) => {
    probe(f, model('gpt-x'));
    expect(probe(f, { ...model('gpt-q'), STUB_MODE: 'quota' }).stdout).toContain('rc=4');
    probe(f, model('gpt-y'));
    const hit = probe(f, model('gpt-q'));
    expect(hit.stdout).toContain('MODEL_QUOTA_EXHAUSTED (cached)');
    expect(hit.stdout).toContain("ERROR: You've hit your usage limit. Try again at 3 AM.");
    expect(hit.stdout).toContain('rc=4');
    expect(probe(f, { ...model('gpt-q'), GSTACK_CODEX_PROBE_RETRY: '1' }).stdout).toContain('MODEL_OK\n');
    expect(calls(f)).toBe(4);
    expect(entries(f)).toHaveLength(3);
  }));

  test('a pre-v2 one-entry cache migrates by TTL: fresh honored, expired re-probed, stray lines ignored', withFixture((f) => {
    probe(f);
    const [status, ts, sig] = entries(f)[0].split(' ');
    expect(status).toBe('MODEL_OK');
    fs.writeFileSync(f.cache, `MODEL_OK ${ts} ${sig}\nan unprefixed legacy line\n`);
    expect(probe(f).stdout).toContain('MODEL_OK (cached)');
    fs.writeFileSync(f.cache, `MODEL_OK ${Number(ts) - 3700} ${sig}\n`);
    expect(probe(f).stdout).not.toContain('(cached)');
    expect(calls(f)).toBe(2);
  }));

  test('an interrupted writer leaves a truncated line and temp file that never count as a hit', withFixture((f) => {
    probe(f, model('gpt-a'));
    fs.appendFileSync(f.cache, 'MODEL_OK 17');
    fs.writeFileSync(`${f.cache}.tmp.99999`, 'MODEL_OK 1 1\n');
    expect(probe(f, model('gpt-a')).stdout).toContain('MODEL_OK (cached)');
    expect(probe(f, model('gpt-b')).stdout).toContain('MODEL_OK\n');
    expect(fs.readFileSync(f.cache, 'utf8')).not.toContain('MODEL_OK 17\n');
    expect(entries(f)).toHaveLength(2);
  }));

  test('config, auth and binary changes still invalidate a cached entry', withFixture((f) => {
    probe(f);
    const future = Date.now() / 1000 + 10;
    fs.utimesSync(path.join(f.codexHome, 'config.toml'), future, future);
    expect(probe(f).stdout).not.toContain('(cached)');
    fs.utimesSync(path.join(f.codexHome, 'auth.json'), future + 5, future + 5);
    expect(probe(f).stdout).not.toContain('(cached)');
    expect(probe(f, { CODEX_API_KEY: 'k-test' }).stdout).not.toContain('(cached)');
    expect(calls(f)).toBe(4);
  }));
});

describe('probe lock recovery and failure', () => {
  const sigOf = (f: Fixture) => {
    probe(f);
    const sig = entries(f)[0].split(' ')[2];
    fs.rmSync(f.cache);
    fs.rmSync(f.log);
    return sig;
  };

  test('a dead owner on this host is recovered at once, without a duplicate probe', withFixture((f) => {
    const sig = sigOf(f);
    const lock = path.join(f.locks, sig);
    fs.mkdirSync(lock, { recursive: true });
    const dead = spawnSync('bash', ['-c', 'echo $$'], { timeout: 5000 }).stdout.toString().trim();
    fs.writeFileSync(path.join(lock, 'owner'), `${dead} ${os.hostname()} ${Math.floor(Date.now() / 1000)}\n`);
    const r = probe(f, { _GSTACK_CODEX_LOCK_WAIT: '3' });
    expect(r.stdout).toContain('MODEL_OK\n');
    expect(calls(f)).toBe(1);
    expect(fs.existsSync(lock)).toBe(false);
  }));

  test('a live owner past the stale bound is abandoned; within it the waiter is unverified without probing', withFixture((f) => {
    const sig = sigOf(f);
    const lock = path.join(f.locks, sig);
    fs.mkdirSync(lock, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} ${os.hostname()} ${now}\n`);
    const busy = probe(f, { _GSTACK_CODEX_LOCK_WAIT: '1' });
    expect(busy.stdout).toContain('MODEL_PROBE_INCONCLUSIVE (another probe of this model still holds its lock)');
    expect(busy.stdout).toContain('rc=0 state=inconclusive');
    expect(calls(f)).toBe(0);
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} ${os.hostname()} ${now - 120}\n`);
    expect(probe(f, { _GSTACK_CODEX_LOCK_WAIT: '2' }).stdout).toContain('MODEL_OK\n');
    expect(calls(f)).toBe(1);
  }));

  test('a lock without its owner file is the creation window until it is 5 seconds old', withFixture((f) => {
    const sig = sigOf(f);
    const lock = path.join(f.locks, sig);
    fs.mkdirSync(lock, { recursive: true });
    expect(probe(f, { _GSTACK_CODEX_LOCK_WAIT: '1' }).stdout).toContain('MODEL_PROBE_INCONCLUSIVE');
    const old = Date.now() / 1000 - 30;
    fs.utimesSync(lock, old, old);
    expect(probe(f, { _GSTACK_CODEX_LOCK_WAIT: '2' }).stdout).toContain('MODEL_OK\n');
    expect(calls(f)).toBe(1);
  }));

  test('an unreadable cache or uncreatable lock is unverified and launches no paid probe', withFixture((f) => {
    fs.mkdirSync(f.cache);
    const dir = probe(f);
    expect(dir.stdout).toContain('MODEL_PROBE_INCONCLUSIVE (probe cache');
    expect(dir.stdout).toContain('rc=0 state=inconclusive');
    fs.rmdirSync(f.cache);
    fs.writeFileSync(f.cache, '');
    fs.chmodSync(f.cache, 0o000);
    expect(probe(f).stdout).toContain('MODEL_PROBE_INCONCLUSIVE (probe cache');
    fs.chmodSync(f.cache, 0o644);
    fs.rmSync(f.cache);
    fs.writeFileSync(f.locks, 'not a directory');
    expect(probe(f).stdout).toContain('MODEL_PROBE_INCONCLUSIVE (cannot create the probe lock');
    expect(calls(f)).toBe(0);
  }));

  test('an owner record that cannot be written is lock I/O failure: unverified, no paid probe, no stray lock', withFixture((f) => {
    fs.mkdirSync(f.locks, { recursive: true });
    const r = probe(f, {}, '_gstack_codex_select_model exec 2>/dev/null; umask 0777; _gstack_codex_model_probe; echo "rc=$? state=${_GSTACK_CODEX_PROBE_STATE:-}"');
    expect(r.stdout).toContain('MODEL_PROBE_INCONCLUSIVE (cannot record ownership of the probe lock');
    expect(r.stdout).toContain('rc=0 state=inconclusive');
    expect(calls(f)).toBe(0);
    expect(fs.readdirSync(f.locks)).toEqual([]);
    expect(fs.existsSync(f.cache)).toBe(false);
    expect(probe(f).stdout).toContain('MODEL_OK\n');
    expect(calls(f)).toBe(1);
  }));

  test('a cache write failure keeps the real probe result', withFixture((f) => {
    fs.chmodSync(f.state, 0o500);
    try {
      const r = probe(f, { STUB_MODE: 'model400' });
      expect(r.stdout).toContain('MODEL_PROBE_INCONCLUSIVE (cannot create the probe lock');
      fs.chmodSync(f.state, 0o700);
      fs.mkdirSync(f.locks);
      fs.writeFileSync(path.join(f.locks, 'write'), 'blocks the write lock');
      const real = probe(f, { STUB_MODE: 'model400' });
      expect(real.stdout).toContain('MODEL_UNUSABLE\n');
      expect(real.stdout).toContain('rc=1');
      expect(fs.existsSync(f.cache)).toBe(false);
    } finally { fs.chmodSync(f.state, 0o700); }
  }));

  test('sourcing the probe still leaves the caller shell untouched', () => {
    const r = spawnSync('bash', ['-c', `B=$(set -o; trap -p; echo "$IFS"); source "${PROBE}"; A=$(set -o; trap -p; echo "$IFS"); [ "$A" = "$B" ] && echo CLEAN`], { encoding: 'utf8', timeout: 5000 });
    expect(r.stdout.trim()).toBe('CLEAN');
  });
});
