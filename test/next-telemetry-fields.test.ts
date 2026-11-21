/** The next telemetry fields (docs/privacy.md, migration 009) as the client
 * writes them: fixed lists, a random per-agent-session id, and a source label
 * an explicit setting always wins. Network is stubbed; nothing leaves the box. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
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

  test('source: flag > GSTACK_TELEMETRY_SOURCE > eval run > CI > Capy > live, so CI never relabels a test row', () => {
    run('gstack-telemetry-log', ['--outcome', 'success', '--source', 'test'], { CI: 'true', EVALS_RUN_ID: 'r1' });
    run('gstack-telemetry-log', ['--outcome', 'success'], { CI: 'true', GSTACK_TELEMETRY_SOURCE: 'test' });
    run('gstack-telemetry-log', ['--outcome', 'success'], { CI: 'true', EVALS_RUN_ID: 'r1', GSTACK_CAPY: '1' });
    run('gstack-telemetry-log', ['--outcome', 'success'], { CI: 'true', GSTACK_CAPY: '1' });
    run('gstack-telemetry-log', ['--outcome', 'success'], { GSTACK_CAPY: '1' });
    run('gstack-telemetry-log', ['--outcome', 'success']);
    expect(events().map(e => e.source)).toEqual(['test', 'test', 'eval', 'ci', 'capy', 'live']);
  });
});

describe.skipIf(process.platform === 'win32')('gstack-skill-end next fields', () => {
  test('one random id per harness process, kept in its sessions marker without adding a session', async () => {
    fs.mkdirSync(path.join(tmp, 'sessions'));
    const marker = path.join(tmp, 'sessions', '4242');
    fs.writeFileSync(marker, '');
    const args = ['--skill', 'qa', '--outcome', 'success', '--session-id', '4242-1700000000-1', '--tel-start', '1700000000',
      '--exit-reason', 'completed', '--invoked', 'user', '--model-family', 'claude_opus', '--checks', 'not_run'];
    run('gstack-skill-end', args, { CLAUDECODE: '1' });
    run('gstack-skill-end', args, { CLAUDECODE: '1' });
    const [a, b] = await eventually(2);
    expect(a.harness_session_id).toMatch(/^[0-9a-f]{16}$/);
    expect(b.harness_session_id).toBe(a.harness_session_id);
    expect(fs.readFileSync(marker, 'utf-8')).toBe(a.harness_session_id);
    expect(fs.readdirSync(path.join(tmp, 'sessions'))).toEqual(['4242']);
    expect([a.host, a.exit_reason, a.invoked, a.model_family, a.checks, a.routing]).toEqual(['claude_code', 'completed', 'user', 'claude_opus', 'not_run', 'none']);
  });

  test('under a shared harness (capy-server) every session has one pid, so no session id is sent', async () => {
    fs.copyFileSync('/bin/sleep', path.join(tmp, 'capy-server'));
    fs.chmodSync(path.join(tmp, 'capy-server'), 0o755);
    const harness = spawn(path.join(tmp, 'capy-server'), ['30'], { stdio: 'ignore' });
    try {
      fs.mkdirSync(path.join(tmp, 'sessions'));
      fs.writeFileSync(path.join(tmp, 'sessions', String(harness.pid)), '');
      run('gstack-skill-end', ['--skill', 'qa', '--outcome', 'success', '--session-id', `${harness.pid}-1700000000-1`, '--tel-start', '1700000000']);
      const [e] = await eventually(1);
      expect(e.harness_session_id).toBeNull();
      expect(fs.readFileSync(path.join(tmp, 'sessions', String(harness.pid)), 'utf-8')).toBe('');
    } finally { harness.kill('SIGKILL'); }
  });

  test('a recycled pid with a stale marker gets a new session id, never the old one', async () => {
    fs.appendFileSync(path.join(tmp, 'config.yaml'), 'update_check: false\n');
    fs.mkdirSync(path.join(tmp, 'sessions'));
    const marker = path.join(tmp, 'sessions', '4343');
    fs.writeFileSync(marker, 'aaaaaaaaaaaaaaaa');
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(marker, threeHoursAgo, threeHoursAgo);
    run('gstack-skill-start', ['--skill', 'qa', '--parent-pid', '4343']);
    expect(fs.readFileSync(marker, 'utf-8')).toBe('');
    run('gstack-skill-end', ['--skill', 'qa', '--outcome', 'success', '--session-id', '4343-1700000000-1', '--tel-start', '1700000000'], { CLAUDECODE: '1' });
    const [e] = await eventually(1);
    expect(e.harness_session_id).toMatch(/^[0-9a-f]{16}$/);
    expect(e.harness_session_id).not.toBe('aaaaaaaaaaaaaaaa');
  }, 30_000);

  test('an error run sends its exit reason as error_class, from the same fixed list; other runs and reasons send none', async () => {
    const end = (outcome: string, reason: string) => run('gstack-skill-end', ['--skill', 'qa', '--outcome', outcome, '--session-id', '99-1', '--exit-reason', reason]);
    end('error', 'test_failed'); end('error', 'made_up'); end('error', 'completed'); end('success', 'tool_error');
    const rows = await eventually(4);
    expect(rows.map(e => e.error_class)).toEqual(['test_failed', null, null, null]);
  });

  test('an unknown start time sends a null duration, not 0', async () => {
    const out = run('gstack-skill-end', ['--skill', 'qa', '--outcome', 'success', '--session-id', '99-1']);
    expect(out).toContain('duration_s=unknown');
    const [e] = await eventually(1);
    expect(e.duration_s).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('gstack-telemetry-sync batch size', () => {
  test('a backlog of full-size events is sent in bodies under ingest\'s 50,000-byte limit', () => {
    fs.writeFileSync(path.join(tmp, 'bin', 'curl'),
      '#!/bin/sh\nfor a in "$@"; do case "$a" in @*) wc -c < "${a#@}" >> "$SIZES" ;; esac; done\nprintf 500\n', { mode: 0o755 });
    const event = JSON.stringify({ v: 1, ts: '2026-11-19T21:00:00Z', event_type: 'skill_run', skill: 'plan-design-review', session_id: '12345-1763600000-abc',
      gstack_version: '1.102.0.0', os: 'darwin', arch: 'arm64', duration_s: 1234, outcome: 'success', error_class: null, error_message: null, failed_step: null,
      used_browse: false, sessions: 1, installation_id: null, source: 'live', security_url_domain: null, security_payload_hash: null, security_confidence: null,
      security_layer: null, security_verdict: null, host: 'claude_code', model_family: 'claude_opus', invoked: 'user', exit_reason: 'completed', checks: 'passed',
      routing: 'both', harness_session_id: '0123456789abcdef', from_version: null, upgrade_error: null, _repo_slug: 'owner/repo', _branch: 'main' });
    fs.mkdirSync(path.join(tmp, 'analytics'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'analytics', 'skill-usage.jsonl'), `${event}\n`.repeat(120));
    const sizes = path.join(tmp, 'sizes');
    run('gstack-telemetry-sync', [], { SIZES: sizes });
    const sent = fs.readFileSync(sizes, 'utf-8').trim().split('\n').map(Number);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeGreaterThan(40_000);
    expect(sent[0]).toBeLessThanOrEqual(45_000);
  });

  test('multi-byte events are measured in bytes, so the body stays under the limit', () => {
    fs.writeFileSync(path.join(tmp, 'bin', 'curl'),
      '#!/bin/sh\nfor a in "$@"; do case "$a" in @*) wc -c < "${a#@}" >> "$SIZES" ;; esac; done\nprintf 500\n', { mode: 0o755 });
    const event = JSON.stringify({ v: 1, ts: '2026-11-19T21:00:00Z', event_type: 'skill_run', skill: 'qa', session_id: '12345-1763600000-abc',
      outcome: 'error', error_message: '\u20ac'.repeat(300), source: 'live', host: 'claude_code' });
    fs.mkdirSync(path.join(tmp, 'analytics'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'analytics', 'skill-usage.jsonl'), `${event}\n`.repeat(100));
    const sizes = path.join(tmp, 'sizes');
    run('gstack-telemetry-sync', [], { SIZES: sizes, LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' });
    const sent = fs.readFileSync(sizes, 'utf-8').trim().split('\n').map(Number);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeGreaterThan(40_000);
    expect(sent[0]).toBeLessThanOrEqual(45_000);
  });
});
