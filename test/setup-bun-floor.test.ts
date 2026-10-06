import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// E1: setup refuses Bun below the security floor (1.3.3) before writing
// anything, warns from the floor up to the tested version (1.4.2), warns and
// continues on a version it cannot parse, and keeps --help/--status working
// without Bun. The auto-updater half lives in session-update-stages.test.ts.

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = path.join(ROOT, 'setup');
const VERSIONS = path.join(ROOT, 'bin', 'gstack-bun-version.sh');
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

function tempBase(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bun-floor-'));
  bases.push(base);
  return base;
}

/** PATH without any bun: directories holding bun are replaced by shims of everything else. */
function pathWithoutBun(base: string): string {
  return (process.env.PATH ?? '/usr/bin:/bin').split(':').filter(Boolean).map((dir, i) => {
    if (!fs.existsSync(path.join(dir, 'bun'))) return dir;
    const shim = path.join(base, `nobun-${i}`);
    if (fs.existsSync(shim)) return shim;
    fs.mkdirSync(shim, { recursive: true });
    for (const name of fs.readdirSync(dir)) if (name !== 'bun') fs.symlinkSync(path.join(dir, name), path.join(shim, name));
    return shim;
  }).join(':');
}

/** A `bun` that reports `version`; any other call is recorded and fails, so setup stops right after the gate. */
function runSetupWithBun(version: string) {
  const base = tempBase();
  const stub = path.join(base, 'stub');
  const home = path.join(base, 'home');
  const state = path.join(base, 'state');
  const calls = path.join(base, 'bun-calls');
  fs.mkdirSync(stub, { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(stub, 'bun'), [
    '#!/usr/bin/env bash',
    `if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi`,
    `echo "$*" >> '${calls}'`,
    'echo stubbed-bun-stop >&2',
    'exit 1',
  ].join('\n') + '\n', { mode: 0o755 });
  const r = spawnSync('bash', [SETUP, '--claude-model', 'claude-opus-4-8'], {
    encoding: 'utf8',
    env: { PATH: `${stub}:${pathWithoutBun(base)}`, HOME: home, GSTACK_STATE_ROOT: state, TMPDIR: base },
    timeout: 30_000,
  });
  const bunCalls = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  const written = [...fs.readdirSync(home), ...fs.readdirSync(state)];
  return { ...r, stub: path.join(stub, 'bun'), bunCalls, written };
}

function status(version: string, floor?: string): string {
  const r = spawnSync('bash', ['-c', `. "$1"; gstack_bun_status "$2" ${floor ? '"$3"' : ''}`, '_', VERSIONS, version, floor ?? ''], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return r.stdout.trim();
}

describe.skipIf(process.platform === 'win32')('Bun floor (E1)', () => {
  test('comparison rule: numeric fields, build metadata ignored, a prerelease sorts below its release', () => {
    const table: Record<string, string> = {
      '1.3.2': 'too-old',
      '1.3.3-canary.1': 'too-old',
      '1.3.3': 'untested',
      '1.3.14': 'untested',
      '1.4.0-canary.20261001+abc123': 'untested',
      '1.4.0': 'untested',
      'v1.4.1': 'untested',
      '1.4.2': 'ok',
      '1.10.0': 'ok',
      '2.0.0': 'ok',
      '': 'malformed',
      '1.4': 'malformed',
      '1.4.0.1': 'malformed',
      '1.4.0-': 'malformed',
      'bun-dev (local build)': 'malformed',
    };
    const got = Object.fromEntries(Object.keys(table).map((v) => [v, status(v)]));
    expect(got).toEqual(table);
    // The updater passes the incoming release's floor explicitly.
    expect(status('1.3.5', '1.3.6')).toBe('too-old');
    expect(status('1.3.6', '1.3.6')).toBe('untested');
  });

  test('below the floor: refused with cause and fix, before anything is written', () => {
    for (const version of ['1.3.2', '1.3.3-canary.1']) {
      const r = runSetupWithBun(version);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`gstack needs Bun 1.3.3 or newer (1.4.2 recommended); found ${version} at ${r.stub}. Nothing was installed or changed.`);
      expect(r.stderr).toContain('older Bun ignores --no-compile-autoload-dotenv');
      expect(r.stderr).toContain('Fix: bun upgrade, then re-run ./setup (docs/troubleshooting.md#bun-too-old)');
      expect(r.bunCalls).toBe('');
      expect(r.written).toEqual([]);
    }
  });

  test('between the floor and the tested version: one warning, then setup continues', () => {
    const r = runSetupWithBun('1.3.14');
    expect(r.stderr).toContain('warning: gstack is tested on Bun 1.4.2 (CI pin); found 1.3.14. Upgrade with: bun upgrade');
    expect(r.stderr).not.toContain('gstack needs Bun');
    expect(r.bunCalls).toContain('run scripts/models.ts claude-overlay claude-opus-4-8');
  });

  test('the tested version passes silently', () => {
    const r = runSetupWithBun('1.4.2');
    expect(r.stderr).not.toMatch(/warning: gstack is tested on Bun|gstack needs Bun|could not read the Bun version/);
    expect(r.bunCalls).toContain('run scripts/models.ts claude-overlay claude-opus-4-8');
  });

  test('a malformed version warns and continues', () => {
    const r = runSetupWithBun('bun-dev (local build)');
    expect(r.stderr).toContain("warning: could not read the Bun version (bun --version printed 'bun-dev (local build)'); continuing. gstack is tested on Bun 1.4.2");
    expect(r.stderr).not.toContain('gstack needs Bun');
    expect(r.bunCalls).toContain('run scripts/models.ts claude-overlay claude-opus-4-8');
  });

  test('--help and --status keep working without Bun', () => {
    const base = tempBase();
    const env = { PATH: pathWithoutBun(base), HOME: base, GSTACK_STATE_ROOT: path.join(base, 'state') };
    expect(spawnSync('bash', ['-c', 'command -v bun'], { env, timeout: 10_000 }).status).not.toBe(0);
    const help = spawnSync('bash', [SETUP, '--help'], { encoding: 'utf8', env, timeout: 30_000 });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage:');
    const st = spawnSync('bash', [SETUP, '--status'], { encoding: 'utf8', env, timeout: 30_000 });
    expect(st.status).toBe(0);
    expect(st.stderr).not.toContain('bun is required');
  });
});
