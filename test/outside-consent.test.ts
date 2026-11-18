/**
 * #3102 / D5: codex_reviews is enforced where the send happens. The stored
 * read (`gstack-config get --stored`) tells enabled, disabled, unset and
 * unreadable apart; gstack-codex-probe run-with-timeout, gstack-claude-code,
 * gstack-outside-voice and the unattended runner (gstack-autoplan) refuse with
 * `not_run consent_missing` when it is disabled or unreadable, and stub
 * launchers prove zero CLI launches and zero API requests then, and one launch
 * when it is allowed. The bash and TS readers agree on every fixture.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GATE_OUTCOMES, gateOutcomeLine } from '../lib/gate-outcomes';
import { CONSENT_MARKER, outsideConsent, readStoredCodexReviews } from '../lib/outside-consent';
import { SMALL_PLAN } from './helpers/autoplan-run-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-consent-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Consent = 'unset' | 'enabled' | 'disabled' | 'unreadable' | 'garbage' | 'legacy-disabled';
let n = 0;

/** A private state root (and legacy root) holding one consent fixture, plus a stub bin dir that logs launches. */
function fixture(consent: Consent) {
  const dir = path.join(TMP, `f${++n}`);
  const state = path.join(dir, 'state');
  const legacy = path.join(dir, 'legacy');
  const stubs = path.join(dir, 'stubs');
  const launches = path.join(dir, 'launches.log');
  for (const d of [state, legacy, stubs]) fs.mkdirSync(d, { recursive: true });
  if (consent === 'enabled' || consent === 'disabled') fs.writeFileSync(path.join(state, 'config.yaml'), `codex_reviews: ${consent}\n`);
  if (consent === 'garbage') fs.writeFileSync(path.join(state, 'config.yaml'), 'codex_reviews: maybe\n');
  if (consent === 'unreadable') fs.mkdirSync(path.join(state, 'config.yaml'));
  if (consent === 'legacy-disabled') {
    fs.writeFileSync(path.join(state, 'config.yaml'), 'codex_reviews: enabled\n');
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'codex_reviews: disabled\n');
  }
  const log = `printf '%s\\n' "$(basename "$0") $*" >> '${launches}'`;
  fs.writeFileSync(path.join(stubs, 'codex'), `#!/usr/bin/env bash\n${log}\ncat >/dev/null\necho 'stub codex review'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'claude'), `#!/usr/bin/env bash\n${log}\ncat >/dev/null\necho '{"type":"result","subtype":"success","is_error":false,"result":"stub"}'\n`, { mode: 0o755 });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(OPENAI|ANTHROPIC|CODEX)_|^GSTACK_(STATE_ROOT|HOME|STATE_DIR|OUTSIDE_RUNNER)$/.test(k)) env[k] = v;
  Object.assign(env, {
    PATH: `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: dir, GSTACK_HOME: state, GSTACK_TEST_LEGACY_ROOT: legacy, CODEX_HOME: path.join(dir, '.codex'),
    GSTACK_CLAUDE_BIN: path.join(stubs, 'claude'),
  });
  fs.mkdirSync(env.CODEX_HOME!, { recursive: true });
  const count = () => (fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').split('\n').filter(Boolean).length : 0);
  return { dir, state, env, count };
}

const sh = (args: string[], env: Record<string, string>, input = '') =>
  spawnSync(args[0]!, args.slice(1), { cwd: ROOT, env, input, encoding: 'utf8', timeout: 60_000 });

describe('stored consent read: gstack-config get --stored and its TS twin agree', () => {
  const expected: Record<Consent, { stdout: string; code: number; ts: string }> = {
    unset: { stdout: 'unset', code: 0, ts: 'unset' },
    enabled: { stdout: 'enabled', code: 0, ts: 'enabled' },
    disabled: { stdout: 'disabled', code: 0, ts: 'disabled' },
    unreadable: { stdout: 'unreadable', code: 2, ts: 'unreadable' },
    garbage: { stdout: 'unreadable', code: 2, ts: 'unreadable' },
    'legacy-disabled': { stdout: 'disabled', code: 0, ts: 'disabled' },
  };
  for (const [consent, want] of Object.entries(expected) as Array<[Consent, typeof expected[Consent]]>) {
    test(consent, () => {
      const f = fixture(consent);
      const r = sh([path.join(BIN, 'gstack-config'), 'get', '--stored', 'codex_reviews'], f.env);
      expect([r.stdout, r.status]).toEqual([want.stdout, want.code]);
      if (want.code === 2) expect(r.stderr).toContain('troubleshooting.md#outside-review-consent-missing');
      expect(readStoredCodexReviews(f.env).value).toBe(want.ts as never);
      const plain = sh([path.join(BIN, 'gstack-config'), 'get', 'codex_reviews'], f.env);
      if (consent === 'unset' || consent === 'unreadable') expect(plain.stdout).toBe('enabled');
    });
  }

  test('the TS decision allows enabled and unset, refuses the rest, and a user-invoked review always runs', () => {
    for (const consent of ['unset', 'enabled'] as const) expect(outsideConsent({ userInvoked: false, env: fixture(consent).env }).allowed).toBe(true);
    for (const consent of ['disabled', 'unreadable', 'garbage', 'legacy-disabled'] as const) {
      const decision = outsideConsent({ userInvoked: false, env: fixture(consent).env });
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.lines[1]).toBe(CONSENT_MARKER);
      expect(outsideConsent({ userInvoked: true, env: fixture(consent).env })).toEqual({ allowed: true, source: 'user-invoked' });
    }
  });

  test('consent_missing is a not_run gate outcome whose fix names the enable command', () => {
    expect(GATE_OUTCOMES.consent_missing.state).toBe('not_run');
    expect(GATE_OUTCOMES.consent_missing.fix).toContain('gstack-config set codex_reviews enabled');
  });
});

describe('gstack-codex-probe run-with-timeout', () => {
  const probe = path.join(BIN, 'gstack-codex-probe');
  for (const consent of ['disabled', 'unreadable', 'garbage', 'legacy-disabled'] as const) {
    test(`${consent}: exit 3, the gate line and marker, zero codex launches`, () => {
      const f = fixture(consent);
      const r = sh(['bash', probe, 'run-with-timeout', '30', 'codex', 'exec', '-'], f.env, 'repository content');
      expect(r.status).toBe(3);
      expect(f.count()).toBe(0);
      expect(r.stderr).toContain(CONSENT_MARKER);
      if (consent === 'disabled') expect(r.stderr.split('\n')[0]).toBe(gateOutcomeLine('outside review', 'consent_missing', 'codex_reviews=disabled'));
      else expect(r.stderr.split('\n')[0]).toMatch(/^outside review: not run \(.+\)\. Fix: gstack-config set codex_reviews enabled/);
    });
  }

  for (const consent of ['enabled', 'unset'] as const) {
    test(`${consent}: exactly one codex launch`, () => {
      const f = fixture(consent);
      const r = sh(['bash', probe, 'run-with-timeout', '30', 'codex', 'exec', '-'], f.env, 'repository content');
      expect([r.status, r.stdout, f.count()]).toEqual([0, 'stub codex review\n', 1]);
      if (consent === 'unset') expect(r.stderr).toContain('NOTICE: gstack outside reviews send the review prompt and code to Codex');
    });
  }

  test('--user-invoked (/codex) runs with codex_reviews disabled', () => {
    const f = fixture('disabled');
    const r = sh(['bash', probe, 'run-with-timeout', '--user-invoked', '30', 'codex', 'review'], f.env);
    expect([r.status, f.count()]).toEqual([0, 1]);
  });
});

describe('gstack-claude-code', () => {
  const runner = path.join(BIN, 'gstack-claude-code');
  const args = (dir: string) => [process.execPath, runner, '--cwd', dir, '--access', 'none', '--timeout-ms', '30000'];
  for (const consent of ['disabled', 'unreadable'] as const) {
    test(`${consent}: exit 3, a not_run JSON result, zero claude launches`, () => {
      const f = fixture(consent);
      const r = sh(args(f.dir), f.env, 'repository content');
      expect(r.status).toBe(3);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: 'not_run', reason: 'consent_missing' });
      expect(r.stderr).toContain(CONSENT_MARKER);
      expect(f.count()).toBe(0);
    });
  }
  test('enabled: one claude launch; --user-invoked: one launch even when disabled', () => {
    const allowed = fixture('enabled');
    sh(args(allowed.dir), allowed.env, 'repository content');
    expect(allowed.count()).toBe(1);
    const asked = fixture('disabled');
    sh([...args(asked.dir), '--user-invoked'], asked.env, 'repository content');
    expect(asked.count()).toBe(1);
  });
});

describe('API sends: gstack-outside-voice and the unattended runner', () => {
  let server: ReturnType<typeof Bun.serve>;
  let requests = 0;
  const REVIEW = `INPUT: ceo ${'a'.repeat(64)}\n\n[P2] A finding.\n\nRecommendation: revise because the premise is unmeasured.\n\n\`\`\`gstack-findings\n\`\`\`\n`;
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch() { requests++; return Response.json({ model: 'gpt-6-astra', choices: [{ message: { content: REVIEW } }], usage: {} }); } });
  });
  afterAll(() => server.stop(true));

  async function outsideVoice(f: ReturnType<typeof fixture>, prompt: string, out: string) {
    const env = { ...f.env, OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` };
    const proc = Bun.spawn([process.execPath, path.join(BIN, 'gstack-outside-voice'), 'run', '--runner', 'api', '--prompt', prompt, '--out', out, '--model', 'openai/gpt-6-astra'], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
    const [status, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(timer);
    return { status, stdout, stderr };
  }

  test('gstack-outside-voice: disabled or unreadable makes zero API requests (exit 3); enabled makes one', async () => {
    for (const consent of ['disabled', 'unreadable'] as const) {
      const f = fixture(consent);
      fs.writeFileSync(path.join(f.dir, 'prompt.md'), 'repository content');
      const before = requests;
      const r = await outsideVoice(f, path.join(f.dir, 'prompt.md'), path.join(f.dir, 'out.md'));
      expect([r.status, requests - before]).toEqual([3, 0]);
      expect(r.stdout).toContain('OUTSIDE_STATUS: not_run reason=consent_missing provider=api');
      expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'out.md.meta.json'), 'utf8'))).toMatchObject({ status: 'not_run', reason: 'consent_missing' });
    }
    const f = fixture('enabled');
    fs.writeFileSync(path.join(f.dir, 'prompt.md'), 'repository content');
    const before = requests;
    const r = await outsideVoice(f, path.join(f.dir, 'prompt.md'), path.join(f.dir, 'out.md'));
    expect([r.status, requests - before], r.stderr).toEqual([0, 1]);
  });

  const SESSION_KIND = ['GSTACK', 'SESSION', 'KIND'].join('_');
  function initRun(f: ReturnType<typeof fixture>) {
    const plan = path.join(f.dir, 'plan.md');
    fs.writeFileSync(plan, SMALL_PLAN);
    const out = path.join(f.dir, 'run');
    const r = spawnSync(process.execPath, [path.join(BIN, 'gstack-autoplan'), 'next', '--out', out, '--plan', plan, '--no-ui'],
      { cwd: ROOT, env: { ...f.env, [SESSION_KIND]: 'un' + 'attended', GSTACK_EPHEMERAL: '1' }, encoding: 'utf8', timeout: 120_000 });
    return { r, out, run: () => JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8')) };
  }

  test('unattended runner: disabled records a terminal not_run consent_missing outcome per phase and dispatches no outside voice', async () => {
    for (const consent of ['disabled', 'unreadable'] as const) {
      const f = fixture(consent);
      const before = requests;
      const { r, run } = initRun(f);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain('voice=outside');
      expect(r.stdout).toContain('OUTSIDE: ceo not_run reason=consent_missing');
      const state = run();
      expect(state.outside_enabled).toBe(false);
      expect(state.phases.ceo.outside).toMatchObject({ status: 'disabled', outcome: 'not_run', reason: 'consent_missing' });
      expect(state.phases.ceo.native.status).toBe('running');
      expect([f.count(), requests - before]).toEqual([0, 0]);
    }
  });

  test('unattended runner: allowed dispatches the outside voice, and its send makes one API request', async () => {
    const f = fixture('unset');
    const { r, out, run } = initRun(f);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('voice=outside');
    expect(run().phases.ceo.outside.status).toBe('running');
    const before = requests;
    const sent = await outsideVoice(f, path.join(out, 'ceo-outside-prompt.md'), path.join(f.dir, 'ceo-outside.md'));
    expect([sent.status, requests - before], sent.stderr).toEqual([0, 1]);
  });

  test('unattended runner (GST-3015): an explicit codex_reviews: enabled is printed as the owner\'s standing consent beside the outside attempt; unset is not', () => {
    const enabled = initRun(fixture('enabled')).r;
    expect(enabled.status, enabled.stderr).toBe(0);
    expect(enabled.stdout).toContain('voice=outside');
    expect(enabled.stdout).toMatch(/^OUTSIDE_CONSENT: given by codex_reviews=enabled \(the owner's standing consent .*\)$/m);
    const unset = initRun(fixture('unset')).r;
    expect(unset.status, unset.stderr).toBe(0);
    expect(unset.stdout).toContain('voice=outside');
    expect(unset.stdout).not.toContain('OUTSIDE_CONSENT:');
  });
});
