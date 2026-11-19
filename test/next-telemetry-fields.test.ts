/** The next telemetry fields (docs/privacy.md, migration 009) as the client
 * writes them: fixed lists, a random per-agent-session id, and a source label
 * an explicit setting always wins. Network is stubbed; nothing leaves the box. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
let tmp: string;

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    HOME: path.join(tmp, 'home'), GSTACK_HOME: tmp, GSTACK_STATE_ROOT: tmp, GSTACK_STATE_DIR: tmp,
    GSTACK_DIR: ROOT, GSTACK_SUPABASE_URL: 'https://telemetry.fixture.invalid', GSTACK_SUPABASE_ANON_KEY: 'fixture',
    GSTACK_TEST_BLOCK_LIVE_TELEMETRY: '1', GSTACK_SESSION_KIND: 'interactive',
    CI: '', GSTACK_TELEMETRY_SOURCE: '', EVALS_RUN_ID: '', GSTACK_EVAL_DIR: '',
    GSTACK_ACTIVE_HOST: '', CLAUDECODE: '', CODEX_THREAD_ID: '',
    PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`,
    ...extra,
  };
}
function run(bin: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(path.join(BIN, bin), args, { cwd: tmp, env: env(extra), encoding: 'utf-8', timeout: 20_000 });
  expect(r.status).toBe(0);
  return r.stdout;
}
function events(): any[] {
  const f = path.join(tmp, 'analytics', 'skill-usage.jsonl');
  const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return lines.filter(e => e.v === 1);
}
async function eventually(n: number): Promise<any[]> {
  for (let i = 0; i < 50 && events().length < n; i++) await Bun.sleep(100);
  return events();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-nexttel-'));
  fs.mkdirSync(path.join(tmp, 'home'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'curl'), '#!/bin/sh\nprintf 200\n', { mode: 0o755 });
  run('gstack-config', ['set', 'telemetry', 'anonymous']);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('gstack-telemetry-log next fields', () => {
  test('fixed-list fields pass through, off-list values become unknown, absent ones null', () => {
    run('gstack-telemetry-log', ['--skill', 'qa', '--outcome', 'success', '--host', 'codex', '--model-family', 'gpt',
      '--invoked', 'model', '--exit-reason', 'rm -rf /', '--checks', 'passed', '--routing', 'block']);
    const [e] = events();
    expect([e.host, e.model_family, e.invoked, e.exit_reason, e.checks, e.routing]).toEqual(['codex', 'gpt', 'model', 'unknown', 'passed', 'block']);
    expect([e.harness_session_id, e.from_version, e.upgrade_error]).toEqual([null, null, null]);
  });

  test('the session id must be 16 hex and from_version a version, or they are dropped', () => {
    run('gstack-telemetry-log', ['--event-type', 'upgrade_completed', '--outcome', 'error', '--harness-session', '0123456789abcdef',
      '--from-version', '1.2.3.4', '--upgrade-error', 'busy']);
    run('gstack-telemetry-log', ['--outcome', 'success', '--harness-session', 'not-a-session-id', '--from-version', '1.2; DROP']);
    const [a, b] = events();
    expect([a.harness_session_id, a.from_version, a.upgrade_error]).toEqual(['0123456789abcdef', '1.2.3.4', 'busy']);
    expect([b.harness_session_id, b.from_version]).toEqual([null, null]);
  });

  test('source: flag > GSTACK_TELEMETRY_SOURCE > eval run > CI > live, so CI never relabels a test row', () => {
    run('gstack-telemetry-log', ['--outcome', 'success', '--source', 'test'], { CI: 'true', EVALS_RUN_ID: 'r1' });
    run('gstack-telemetry-log', ['--outcome', 'success'], { CI: 'true', GSTACK_TELEMETRY_SOURCE: 'test' });
    run('gstack-telemetry-log', ['--outcome', 'success'], { CI: 'true', EVALS_RUN_ID: 'r1' });
    run('gstack-telemetry-log', ['--outcome', 'success'], { CI: 'true' });
    run('gstack-telemetry-log', ['--outcome', 'success']);
    expect(events().map(e => e.source)).toEqual(['test', 'test', 'eval', 'ci', 'live']);
  });
});

describe.skipIf(process.platform === 'win32')('gstack-skill-end next fields', () => {
  test('one random id per harness process, kept in its sessions marker without adding a session', async () => {
    fs.mkdirSync(path.join(tmp, 'sessions'));
    const marker = path.join(tmp, 'sessions', '4242');
    fs.writeFileSync(marker, '');
    const args = ['--skill', 'qa', '--outcome', 'success', '--session-id', '4242-1700000000-1', '--tel-start', '1700000000',
      '--exit-reason', 'completed', '--invoked', 'user', '--model-family', 'claude_opus', '--checks', 'none'];
    run('gstack-skill-end', args, { CLAUDECODE: '1' });
    run('gstack-skill-end', args, { CLAUDECODE: '1' });
    const [a, b] = await eventually(2);
    expect(a.harness_session_id).toMatch(/^[0-9a-f]{16}$/);
    expect(b.harness_session_id).toBe(a.harness_session_id);
    expect(fs.readFileSync(marker, 'utf-8')).toBe(a.harness_session_id);
    expect(fs.readdirSync(path.join(tmp, 'sessions'))).toEqual(['4242']);
    expect([a.host, a.exit_reason, a.invoked, a.model_family, a.checks, a.routing]).toEqual(['claude_code', 'completed', 'user', 'claude_opus', 'none', 'none']);
  });

  test('an unknown start time sends a null duration, not 0', async () => {
    const out = run('gstack-skill-end', ['--skill', 'qa', '--outcome', 'success', '--session-id', '99-1']);
    expect(out).toContain('duration_s=unknown');
    const [e] = await eventually(1);
    expect(e.duration_s).toBeNull();
  });
});
