/**
 * GST-3089: `gstack-codex-probe role-ready` and `gstack-outside-voice run
 * --runner codex-cli` resolve a custom Codex provider's plan-review model
 * through one resolver, so a session that trusts the probe never drops a
 * review the runner would have run, and the runner never runs a model the
 * probe refused. Synthetic CODEX_HOME/config.toml, fake codex CLI, no paid calls.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RESULT_FORMAT_HEADER } from '../lib/autoplan-reconcile';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin', 'gstack-codex-probe');
const OUTSIDE = path.join(ROOT, 'bin', 'gstack-outside-voice');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-custom-agree-'));
const FAKE_BIN = path.join(TMP, 'bin');
const FAKE = path.join(TMP, 'fake-codex.ts');
const PROMPT = path.join(TMP, 'prompt.md');
fs.mkdirSync(FAKE_BIN, { recursive: true });
fs.writeFileSync(PROMPT, `You are the outside CEO reviewer.\n${RESULT_FORMAT_HEADER}\n`);
fs.writeFileSync(FAKE, `
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'sandbox') process.exit(0);
if (args[0] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
const probe = args.includes('reply OK');
appendFileSync(process.env.CALLS!, JSON.stringify({ probe, model: args.find(a => a.startsWith('model=')) ?? null }) + '\\n');
if (probe) { console.log('OK'); process.exit(0); }
await Bun.stdin.text();
writeFileSync(args[args.indexOf('-o') + 1], 'Recommendation: proceed because the plan is sound.\\nVERDICT: CLEAN\\n');
`);
fs.writeFileSync(path.join(FAKE_BIN, 'codex'), `#!/usr/bin/env bash\nexec bun "${FAKE}" "$@"\n`, { mode: 0o755 });
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const CUSTOM = (model: string | null) => [
  ...(model ? [`model = "${model}"`] : []),
  'model_provider = "proxy"',
  '',
  '[model_providers.proxy]\nname = "Team proxy"\nbase_url = "https://proxy.example.invalid/v1"\nenv_key = "PROXY_API_KEY"\n',
].join('\n');

let counter = 0;
function fixture(configToml: string) {
  const dir = path.join(TMP, `h${++counter}`);
  for (const sub of ['.codex', 'state', 'repo']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), configToml);
  const calls = path.join(dir, 'calls.jsonl');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(OPENAI|CODEX|GSTACK)_/.test(k)) env[k] = v;
  }
  Object.assign(env, {
    PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ''}`, HOME: dir, CODEX_HOME: path.join(dir, '.codex'),
    GSTACK_STATE_ROOT: path.join(dir, 'state'), PROXY_API_KEY: 'test-key', CODEX_API_KEY: 'test-key', CALLS: calls, _TEL: 'off',
  });
  const readCalls = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { probe: boolean; model: string | null }) : [];
  return { dir, env, repo: path.join(dir, 'repo'), calls, readCalls };
}

const POLICY = /^CODEX_MODEL_POLICY: (\S+)$/m;

function both(configToml: string) {
  const f = fixture(configToml);
  const ready = spawnSync(PROBE, ['role-ready', 'exec', '--cwd', f.repo], { env: f.env, encoding: 'utf8', timeout: 30_000 });
  const readyCalls = f.readCalls();
  fs.rmSync(f.calls, { force: true });
  const out = path.join(f.dir, 'out', 'outside.md');
  const voice = spawnSync('bun', [OUTSIDE, 'run', '--runner', 'codex-cli', '--prompt', PROMPT, '--out', out, '--cwd', f.repo, '--timeout-ms', '20000'],
    { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 60_000 });
  const meta = fs.existsSync(`${out}.meta.json`) ? JSON.parse(fs.readFileSync(`${out}.meta.json`, 'utf8')) : null;
  return {
    ready: { status: ready.status, model: /^CODEX_SEL: (.+)$/m.exec(ready.stdout)?.[1] ?? null, policy: POLICY.exec(ready.stderr)?.[1] ?? null, stderr: ready.stderr, calls: readyCalls },
    voice: { status: voice.status, meta, policy: POLICY.exec(meta?.detail ?? '')?.[1] ?? null, stderr: voice.stderr, calls: f.readCalls() },
  };
}

describe('role-ready and the codex-cli runner agree on a custom provider (GST-3089)', () => {
  test('config.toml names the frontier catalog model: both accept it and run it', () => {
    const r = both(CUSTOM('gpt-6-astra'));
    expect({ status: r.ready.status, model: r.ready.model }).toEqual({ status: 0, model: 'gpt-6-astra' });
    expect(r.ready.calls.filter(c => c.probe).map(c => c.model)).toEqual(['model="gpt-6-astra"']);
    expect(r.voice.meta).toMatchObject({ runner: 'codex-cli', model: 'gpt-6-astra' });
    expect(r.voice.meta.reason).not.toBe('model_unselected');
    expect(r.voice.calls.filter(c => !c.probe).map(c => c.model)).toEqual(['model="gpt-6-astra"']);
  });

  test('config.toml names a non-frontier model: both refuse with the same reason code and send nothing', () => {
    const r = both(CUSTOM('gpt-6.1-sol'));
    expect(r.ready.status).toBe(1);
    expect(r.ready.model).toBeNull();
    expect(r.ready.policy).toBe('custom_provider_model_not_tier');
    expect(r.ready.stderr).toContain("'gpt-6.1-sol'");
    expect(r.ready.calls).toEqual([]);
    expect(r.voice.meta).toMatchObject({ status: 'unavailable', reason: 'model_unselected' });
    expect(r.voice.policy).toBe(r.ready.policy);
    expect(r.voice.calls).toEqual([]);
  });

  test('config.toml names no model: both refuse with the same reason code and send nothing', () => {
    const r = both(CUSTOM(null));
    expect(r.ready.status).toBe(1);
    expect(r.ready.policy).toBe('custom_provider_requires_model');
    expect(r.ready.calls).toEqual([]);
    expect(r.voice.meta).toMatchObject({ status: 'unavailable', reason: 'model_unselected' });
    expect(r.voice.policy).toBe(r.ready.policy);
    expect(r.voice.calls).toEqual([]);
  });

  test('the tier decides which catalog ID counts: plan_review_tier smart accepts the smart ID from config.toml', () => {
    const f = fixture(CUSTOM('gpt-6.1-sol'));
    fs.writeFileSync(path.join(f.dir, 'state', 'config.yaml'), 'plan_review_tier: smart\n');
    const r = spawnSync(PROBE, ['select-model', 'exec', '--role', 'plan-review'], { env: f.env, encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('CODEX_SEL: gpt-6.1-sol');
    expect(r.stderr).toContain('tier: smart; source: ');
    for (const bad of [['select-model', 'exec', '--role'], ['select-model', 'exec', '--role', 'implementation'], ['select-model', 'exec', '--cwd', f.repo]]) {
      const u = spawnSync(PROBE, bad, { env: f.env, encoding: 'utf8', timeout: 30_000 });
      expect({ bad, status: u.status, stdout: u.stdout }).toEqual({ bad, status: 64, stdout: '' });
    }
  });

  test('negative control: the stock OpenAI provider keeps the catalog frontier model in both, whatever config.toml names', () => {
    const r = both('model = "gpt-6.1-sol"\n');
    expect({ status: r.ready.status, model: r.ready.model }).toEqual({ status: 0, model: 'gpt-6-astra' });
    expect(r.voice.meta).toMatchObject({ model: 'gpt-6-astra' });
    expect(r.voice.calls.filter(c => !c.probe).map(c => c.model)).toEqual(['model="gpt-6-astra"']);
  });
});
