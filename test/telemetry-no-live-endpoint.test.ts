/**
 * Tests never reach the live telemetry project. Before v1.86.0.0 every run of
 * test/telemetry.test.ts posted fixture events to it, and
 * test/state-root-one-variable.test.ts still did until this file landed:
 * about 554,000 of the 1.34M skill_run rows there are test fixtures.
 *
 * The guard: test-setup.ts sets GSTACK_TEST_BLOCK_LIVE_TELEMETRY, and
 * supabase/config.sh (the fallback every telemetry client sources when
 * GSTACK_SUPABASE_URL is unset) then yields no endpoint.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const CONFIG = path.join(ROOT, 'supabase', 'config.sh');
const LIVE_HOST = (fs.readFileSync(CONFIG, 'utf-8').match(/GSTACK_SUPABASE_URL="https:\/\/([^"/]+)"/) ?? [])[1];
const CONFIG_CLIENTS = ['gstack-community-dashboard', 'gstack-security-dashboard', 'gstack-telemetry-sync', 'gstack-update-check'];

let tmp: string;
let curlLog: string;

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) merged[k] = v;
  return spawnSync('bash', args, { cwd: ROOT, env: merged, encoding: 'utf-8', timeout: 20_000 });
}

function curlCalls(): string[] {
  return fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf-8').split('\n').filter(Boolean) : [];
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-no-live-'));
  curlLog = path.join(tmp, 'curl.log');
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.mkdirSync(path.join(tmp, 'state', 'analytics'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'bin', 'curl'), `#!/bin/sh\nprintf '%s ' "$@" >> "$GSTACK_TEST_CURL_LOG"\necho >> "$GSTACK_TEST_CURL_LOG"\nprintf '200'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'state', 'config.yaml'), 'telemetry: anonymous\n');
  fs.writeFileSync(
    path.join(tmp, 'state', 'analytics', 'skill-usage.jsonl'),
    '{"v":1,"ts":"2026-11-19T00:00:00Z","event_type":"skill_run","skill":"qa","session_id":"1-2","gstack_version":"1.0.0.0","os":"linux","outcome":"success"}\n',
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function clientEnv(extra: Record<string, string | undefined> = {}) {
  return {
    GSTACK_HOME: path.join(tmp, 'state'), GSTACK_STATE_ROOT: undefined, GSTACK_STATE_DIR: undefined,
    HOME: path.join(tmp, 'home'), GSTACK_DIR: ROOT, GSTACK_TEST_CURL_LOG: curlLog,
    PATH: `${path.join(tmp, 'bin')}:${process.env.PATH ?? ''}`,
    GSTACK_SUPABASE_URL: undefined, GSTACK_SUPABASE_ANON_KEY: undefined,
    ...extra,
  };
}

describe('telemetry never reaches the live project from tests', () => {
  test('the test preload sets the guard', () => {
    expect(process.env.GSTACK_TEST_BLOCK_LIVE_TELEMETRY).toBe('1');
    expect(LIVE_HOST).toBeTruthy();
  });

  test('config.sh yields no endpoint under the guard, and the live one without it', () => {
    const show = '. "$1"; printf "[%s][%s]" "$GSTACK_SUPABASE_URL" "${GSTACK_SUPABASE_ANON_KEY:+key}"';
    const guarded = run(['-c', show, 'x', CONFIG]);
    expect(guarded.status).toBe(0);
    expect(guarded.stdout).toBe('[][]');
    const unguarded = run(['-c', show, 'x', CONFIG], { GSTACK_TEST_BLOCK_LIVE_TELEMETRY: '' });
    expect(unguarded.stdout).toBe(`[https://${LIVE_HOST}][key]`);
  });

  test('every client that reads config.sh reads it only as the fallback for an unset GSTACK_SUPABASE_URL', () => {
    for (const name of CONFIG_CLIENTS) {
      const src = fs.readFileSync(path.join(BIN, name), 'utf-8');
      expect(src, name).toContain('if [ -z "${GSTACK_SUPABASE_URL:-}" ] && [ -f "$GSTACK_DIR/supabase/config.sh" ]; then');
    }
    const sourcing = fs.readdirSync(BIN).filter(f => {
      const p = path.join(BIN, f);
      return fs.statSync(p).isFile() && fs.readFileSync(p, 'utf-8').includes('. "$GSTACK_DIR/supabase/config.sh"');
    });
    expect(sourcing.sort()).toEqual([...CONFIG_CLIENTS].sort());
  });

  test('telemetry sync with telemetry on and no endpoint set sends nothing', () => {
    const r = run([path.join(BIN, 'gstack-telemetry-sync')], clientEnv());
    expect(r.status).toBe(0);
    expect(curlCalls()).toEqual([]);
  });

  test('the community dashboard with no endpoint set sends nothing', () => {
    const r = run([path.join(BIN, 'gstack-community-dashboard')], clientEnv());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Supabase not configured');
    expect(curlCalls()).toEqual([]);
  });

  test('control: the curl stub does record a send to an explicit fixture endpoint', () => {
    const r = run([path.join(BIN, 'gstack-telemetry-sync')], clientEnv({
      GSTACK_SUPABASE_URL: 'https://telemetry.fixture.invalid', GSTACK_SUPABASE_ANON_KEY: 'fixture-anon-key',
    }));
    expect(r.status).toBe(0);
    const calls = curlCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('https://telemetry.fixture.invalid/functions/v1/telemetry-ingest');
  });

  test('no test file names the live project', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(p); continue; }
        if (!/\.(ts|js|sh|json|jsonl)$/.test(entry.name)) continue;
        if (fs.readFileSync(p, 'utf-8').includes(LIVE_HOST!)) offenders.push(path.relative(ROOT, p));
      }
    };
    walk(path.join(ROOT, 'test'));
    expect(offenders).toEqual([]);
  });
});
