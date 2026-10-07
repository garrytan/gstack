/**
 * Role-bearing outside invocations: exact plan-review membership, one bound
 * selection through probe and dispatch, the invocation-boundary notice, and
 * no-role negative controls. Fake CLIs only; no paid calls.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { outsideVoiceCommand, outsideVoicePreflight } from '../scripts/resolvers/outside-voice';
import { RESOLVERS } from '../scripts/resolvers/index';
import { generateAdversarialStep, generateCodexDocReview, generateCodexPlanReview, generateCodexSecondOpinion } from '../scripts/resolvers/outside-voice-steps';
import { generateDesignOutsideVoices } from '../scripts/resolvers/design';
import { generateImplementationModelHandoff } from '../scripts/resolvers/plan-review';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { claudeCodeArgs } from '../lib/claude-code';
import { resolvePlanReviewModel } from '../lib/model-policy';

const ROOT = path.resolve(import.meta.dir, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'role-invocation-'));
const REPO = path.join(TMP, 'repo');
const BIN = path.join(TMP, 'bin');
const CALLS = path.join(TMP, 'calls.jsonl');
const PROMPT = path.join(TMP, 'prompt.txt');
const FAKE = path.join(TMP, 'fake.ts');
for (const dir of [REPO, BIN]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(PROMPT, 'Review this plan.\n');
fs.writeFileSync(FAKE, `
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'sandbox') process.exit(0);
if (args[0] === '--version') { console.log('codex-cli ' + (process.env.FAKE_CODEX_VERSION ?? '0.160.0')); process.exit(0); }
const claude = process.env.FAKE_AS === 'claude';
const probe = !claude && args.includes('reply OK');
appendFileSync(process.env.CALLS!, JSON.stringify({ args, probe }) + '\\n');
if (probe) {
  if (process.env.REPLACE_CONFIG) writeFileSync(process.env.GSTACK_HOME + '/config.yaml', process.env.REPLACE_CONFIG);
  if (process.env.FAKE_PROBE === 'model400') { console.error('ERROR: {"status":400,"error":{"message":"The model is not supported."}}'); process.exit(1); }
  if (process.env.FAKE_PROBE === 'broken') { console.error('Error: spawn codex-vendor ENOENT'); process.exit(1); }
  console.log('OK');
  process.exit(0);
}
if (!claude || args.includes('-')) await Bun.stdin.text();
const response = 'Recommendation: split the migration because the plan couples two rollouts.';
if (claude) console.log(JSON.stringify({ result: response, session_id: 's', modelUsage: { 'model-actual': { inputTokens: 1 } } }));
else writeFileSync(args[args.indexOf('-o') + 1], response);
`);
fs.writeFileSync(path.join(BIN, 'codex'), `#!/usr/bin/env bash\nexec bun "${FAKE}" "$@"\n`, { mode: 0o755 });

const git = (args: string[]) => {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', timeout: 5000, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
  if (r.status !== 0) throw new Error(r.stderr);
};
git(['init', '-q', '-b', 'main']);
fs.writeFileSync(path.join(REPO, 'plan.md'), 'plan\n');
git(['add', 'plan.md']);
git(['commit', '-qm', 'init']);
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Host = 'claude' | 'codex';
const ctxFor = (skillName: string, host: Host, paths = HOST_PATHS.codex): TemplateContext =>
  ({ skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, host, paths });

let counter = 0;
interface Run { stdout: string; stderr: string; status: number | null; calls: Array<{ args: string[]; probe: boolean }>; state: string }

function home(config = '', codexToml = 'model = "gpt-5.6-terra"\n') {
  const dir = path.join(TMP, `h${++counter}`);
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), codexToml);
  if (config) fs.writeFileSync(path.join(state, 'config.yaml'), config);
  return { dir, state };
}

function env(h: { dir: string; state: string }, host: Host, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ''}`, HOME: h.dir, CODEX_HOME: path.join(h.dir, '.codex'),
    GSTACK_HOME: h.state, GSTACK_ROOT: ROOT, GSTACK_BIN: path.join(ROOT, 'bin'), CALLS, CODEX_API_KEY: 'test-key',
    GSTACK_CLAUDE_BIN: process.execPath, GSTACK_CLAUDE_BIN_ARGS: JSON.stringify([FAKE]), FAKE_AS: host === 'codex' ? 'claude' : 'codex',
    ...(host === 'codex' ? { CODEX_THREAD_ID: 'fixture', GSTACK_ACTIVE_HOST: 'codex' } : { CLAUDECODE: '1', GSTACK_ACTIVE_HOST: 'claude' }),
    ...extra,
  };
}

function run(host: Host, h: { dir: string; state: string }, extra: Record<string, string> = {}, role: 'plan-review' | null = 'plan-review'): Run {
  fs.rmSync(CALLS, { force: true });
  const command = outsideVoiceCommand(ctxFor('plan-eng-review', host), { promptFile: PROMPT, timeoutMs: 8000, ...(role ? { role } : {}) });
  const r = spawnSync('bash', ['-c', command], { cwd: REPO, env: env(h, host, extra), encoding: 'utf8', timeout: 30000 });
  const calls = fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status, calls, state: h.state };
}

const codexModel = (call: { args: string[] }) => call.args.find(arg => arg.startsWith('model='));
const claudeModels = (call: { args: string[] }) => call.args.flatMap((arg, i) => (arg === '--model' ? [call.args[i + 1]] : arg.startsWith('--model=') ? [arg.slice(8)] : []));
const NOTICE = 'NOTICE: gstack plan reviews now use an independent plan-review model';
const marker = (state: string) => path.join(state, '.model-policy-notice-v1');

describe('plan-review role membership in shared generators', () => {
  const roleBearing: Array<[string, (ctx: TemplateContext) => string]> = [
    ['autoplan', ctx => RESOLVERS.OUTSIDE_INVOCATION(ctx, ['autoplan'])],
    ['spec', ctx => RESOLVERS.OUTSIDE_INVOCATION(ctx, ['spec'])],
    ['plan-ceo-review', generateCodexPlanReview],
    ['plan-eng-review', generateCodexPlanReview],
    ['plan-devex-review', generateCodexPlanReview],
    ['plan-design-review', generateDesignOutsideVoices],
  ];
  const noRole: Array<[string, (ctx: TemplateContext) => string]> = [
    ['design-review', generateDesignOutsideVoices],
    ['design-consultation', generateDesignOutsideVoices],
    ['office-hours', generateCodexSecondOpinion],
    ['office-hours', ctx => RESOLVERS.DESIGN_SKETCH(ctx)],
    ['review', generateAdversarialStep],
    ['ship', generateAdversarialStep],
    ['ship', ctx => RESOLVERS.DESIGN_REVIEW_LITE(ctx)],
    ['document-release', generateCodexDocReview],
  ];
  for (const host of ['claude', 'codex'] as const) {
    const roleMarker = host === 'claude' ? '_gstack_codex_role_ready exec "$_REPO_ROOT" || exit $?' : '--role plan-review';
    for (const [skill, render] of roleBearing) {
      test(`${host}: ${skill} invokes with the plan-review role only`, () => {
        const text = render(ctxFor(skill, host, HOST_PATHS.claude));
        expect(text).toContain(roleMarker);
        expect(text).not.toMatch(/_gstack_codex_select_model (exec|review) \|\| exit 1/);
        expect(text).not.toContain('_gstack_codex_model_probe');
        expect(text).not.toContain('_CODEX_MP');
        expect(text).not.toContain('without overriding either');
      });
    }
    for (const [skill, render] of noRole) {
      test(`${host}: ${skill} stays no-role`, () => {
        const text = render(ctxFor(skill, host, HOST_PATHS.claude));
        expect(text).not.toContain('plan-review');
        expect(text).not.toContain('--role');
      });
    }
  }

  test('spec keeps medium effort, its 120s deadline and spec gate on both providers', () => {
    const codex = RESOLVERS.OUTSIDE_INVOCATION(ctxFor('spec', 'claude'), ['spec']);
    expect(codex).toContain(`model_reasoning_effort="medium"`);
    expect(codex).toContain('_gstack_codex_timeout_wrapper 120 codex exec');
    expect(codex).toMatch(/ spec "\$_OUTSIDE_TMP\/text"/);
    const claude = RESOLVERS.OUTSIDE_INVOCATION(ctxFor('spec', 'codex'), ['spec']);
    expect(claude).toContain('--timeout-ms 120000 --role plan-review');
  });

  test('role-bearing availability checks pay for no model probe; no-role checks keep theirs', () => {
    for (const host of ['claude', 'codex'] as const) {
      for (const text of [
        RESOLVERS.OUTSIDE_PREFLIGHT(ctxFor('autoplan', host, HOST_PATHS.claude), ['autoplan']),
        RESOLVERS.OUTSIDE_PREFLIGHT(ctxFor('spec', host, HOST_PATHS.claude), ['opt-in', 'plan-review']),
        outsideVoicePreflight(ctxFor('plan-eng-review', host, HOST_PATHS.claude), { disabledBehavior: 'skip-all', role: 'plan-review' }),
      ]) {
        expect(text).not.toMatch(/_gstack_codex_(model|auth)_probe|_CODEX_MP|without overriding either/);
        expect(text).toContain('the plan-review model (policy-selected, printed with its source) are checked by the actual invocation');
      }
    }
    expect(RESOLVERS.OUTSIDE_PREFLIGHT(ctxFor('spec', 'claude', HOST_PATHS.claude), ['opt-in'])).toContain('without overriding either');
    expect(generateCodexDocReview(ctxFor('document-release', 'claude', HOST_PATHS.claude))).toContain('{ _gstack_codex_model_probe; _CODEX_MP=$?; }');
    expect(generateAdversarialStep(ctxFor('review', 'claude', HOST_PATHS.claude))).toContain('_gstack_codex_model_probe review');
    expect(RESOLVERS.OUTSIDE_PREFLIGHT(ctxFor('spec', 'claude', HOST_PATHS.claude), ['opt-in'])).not.toContain('_gstack_codex_model_probe');
  });
});

describe('Codex plan-review invocation binds one selection', () => {
  test('a known-bad CLI version still warns without changing its advisory policy', () => {
    const result = run('claude', home(), { FAKE_CODEX_VERSION: '0.120.2' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/WARN:.*0\.120\.2.*known stdin deadlock/);
    expect(result.calls.filter(call => call.probe)).toHaveLength(1);
    expect(result.calls.filter(call => !call.probe)).toHaveLength(1);
    expect(result.calls.every(call => codexModel(call) === 'model="gpt-6-astra"')).toBe(true);
  });

  test('frontier catalog model wins over a native pin; probe and dispatch use it; notice once', () => {
    const h = home();
    const first = run('claude', h);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('OUTSIDE_STATUS: completed provider=codex');
    expect(first.calls.map(c => c.probe)).toEqual([true, false]);
    expect(first.calls.map(codexModel)).toEqual(['model="gpt-6-astra"', 'model="gpt-6-astra"']);
    expect(first.stderr).toContain('CODEX_MODEL: gpt-6-astra (exec; role: plan-review, tier: frontier; source: gstack catalog frontier/openai');
    expect(first.stderr).toContain(NOTICE);
    expect(first.stderr).toContain('gstack-config set plan_review_tier smart');
    expect(first.stderr.indexOf(NOTICE)).toBeLessThan(first.stderr.indexOf('CODEX_MODEL:'));
    expect(fs.existsSync(marker(h.state))).toBe(true);
    const second = run('claude', h);
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain('NOTICE: gstack plan reviews');
    expect(second.stdout).toContain('MODEL_OK (cached)');
    expect(second.calls.map(c => c.probe)).toEqual([false]);
  });

  test('negative control: the same call without a role keeps native selection, no probe, no notice', () => {
    const h = home();
    const r = run('claude', h, {}, null);
    expect(r.status).toBe(0);
    expect(r.calls.map(c => c.probe)).toEqual([false]);
    expect(r.calls.map(codexModel)).toEqual(['model="gpt-5.6-terra"']);
    expect(r.stderr).not.toContain('NOTICE: gstack plan reviews');
    expect(fs.existsSync(marker(h.state))).toBe(false);
  });

  test('a config replaced between probe and dispatch affects only the next invocation', () => {
    const h = home();
    const r = run('claude', h, { REPLACE_CONFIG: 'model_frontier_openai: gpt-replaced\n' });
    expect(r.status).toBe(0);
    expect(r.calls.map(codexModel)).toEqual(['model="gpt-6-astra"', 'model="gpt-6-astra"']);
    const next = run('claude', h);
    expect(next.calls.map(codexModel)).toEqual(['model="gpt-replaced"', 'model="gpt-replaced"']);
    expect(next.stderr).toContain('source: model_frontier_openai in');
  });

  for (const [label, config, extra, model, fragment] of [
    ['smart tier', 'plan_review_tier: smart\n', {}, 'gpt-6.1-sol', 'tier: smart'],
    ['env override', '', { GSTACK_CODEX_MODEL: 'gpt-env-pick' }, 'gpt-env-pick', 'source: GSTACK_CODEX_MODEL'],
    ['host mode', 'plan_review_tier: host\n', {}, 'gpt-5.6-terra', 'source: plan_review_tier=host'],
  ] as const) {
    test(`${label} reaches both probe and dispatch with its real source`, () => {
      const r = run('claude', home(config), extra);
      expect(r.status).toBe(0);
      expect(r.calls.map(codexModel)).toEqual([`model="${model}"`, `model="${model}"`]);
      expect(r.stderr).toContain(fragment);
    });
  }

  test('invalid policy config and unrouted custom providers stop before any Codex process', () => {
    const invalid = run('claude', home('plan_review_tier: turbo\n'));
    expect(invalid.status).toBe(1);
    expect(invalid.calls).toEqual([]);
    expect(invalid.stderr).toContain('gstack-config unset plan_review_tier');
    expect(invalid.stderr).toContain('outside review unavailable; missing coverage');
    const custom = run('claude', home('', 'model_provider = "azure"\n'));
    expect(custom.status).toBe(1);
    expect(custom.calls).toEqual([]);
    expect(custom.stderr).toContain('model_frontier_openai');
    expect(custom.stderr).not.toContain('NOTICE: gstack plan reviews');
  });

  test('a rejected role model is unusable with a source-aware repair and never dispatches', () => {
    const r = run('claude', home(), { FAKE_PROBE: 'model400' });
    expect(r.status).toBe(1);
    expect(r.calls.map(c => c.probe)).toEqual([true]);
    expect(r.stdout).toContain('MODEL_UNUSABLE');
    expect(r.stdout).toContain('source: gstack catalog frontier/openai');
    expect(r.stdout).toContain('gstack-config set model_frontier_openai <model-id>');
    expect(r.stdout).not.toContain('set model in');
  });

  test('a broken CLI found by the role probe exits 2 and never dispatches', () => {
    const r = run('claude', home(), { FAKE_PROBE: 'broken' });
    expect(r.status).toBe(2);
    expect(r.calls.map(c => c.probe)).toEqual([true]);
    expect(r.stdout).toContain('MODEL_UNUSABLE_INSTALL');
    expect(r.stdout).toContain('npm install -g @openai/codex');
    expect(r.stdout).not.toContain('OUTSIDE_STATUS: completed');
  });

  test('missing authentication makes no Codex call', () => {
    const r = run('claude', home(), { CODEX_API_KEY: '' });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toContain('AUTH_FAILED');
  });

  test('an explicit request outranks GSTACK_CODEX_MODEL in the probe helper', () => {
    const h = home();
    const r = spawnSync('bash', ['-c', `source "${ROOT}/bin/gstack-codex-probe" && _gstack_codex_select_model exec gpt-request plan-review && echo "SEL=$_GSTACK_CODEX_SEL"`],
      { env: env(h, 'claude', { GSTACK_CODEX_MODEL: 'gpt-env' }), encoding: 'utf8', timeout: 15000 });
    expect(r.stdout).toContain('SEL=gpt-request');
    expect(r.stderr).toContain('source: explicit request');
  });
});

describe('Claude plan-review invocation emits one selected model or none', () => {
  const result = (r: Run) => JSON.parse(r.stdout.split('\n').find(line => line.startsWith('{"status"'))!);

  test('catalog frontier model: exactly one --model, selection reported apart from modelUsage, notice once', () => {
    const h = home();
    const r = run('codex', h, { GSTACK_CLAUDE_MODEL: '' });
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(claudeModels(r.calls[0])).toEqual(['claude-fable-5-1']);
    expect(result(r).selection).toMatchObject({ role: 'plan-review', tier: 'frontier', status: 'selected', requested_model: 'claude-fable-5-1' });
    expect(result(r).modelUsage).toHaveProperty('model-actual');
    expect(r.stderr).toContain('CLAUDE_MODEL: plan-review via anthropic: claude-fable-5-1');
    expect(r.stderr).toContain(NOTICE);
    expect(run('codex', h).stderr).not.toContain('NOTICE: gstack plan reviews');
  });

  test('GSTACK_CLAUDE_MODEL ranks inside the record and appears once', () => {
    const r = run('codex', home(), { GSTACK_CLAUDE_MODEL: 'claude-env-pick' });
    expect(claudeModels(r.calls[0])).toEqual(['claude-env-pick']);
    expect(result(r).selection.source).toContain('GSTACK_CLAUDE_MODEL');
  });

  test('host mode delegates: zero --model flags and an unknown requested model', () => {
    const r = run('codex', home('plan_review_tier: host\n'));
    expect(r.status).toBe(0);
    expect(claudeModels(r.calls[0])).toEqual([]);
    expect(result(r).selection).toMatchObject({ status: 'delegated-host', requested_model: null });
  });

  test('custom Anthropic routing without an explicit model never spawns Claude', () => {
    const r = run('codex', home(), { ANTHROPIC_BASE_URL: 'https://proxy.example.invalid' });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.stdout).toContain('custom_provider_requires_model');
    expect(r.stdout).not.toContain('OUTSIDE_STATUS: completed');
  });

  test('target-repo project settings with a custom endpoint stop a catalog default, whatever the parent cwd', () => {
    const target = path.join(TMP, 'custom-target');
    fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid' } }));
    const sub = path.join(target, 'pkg');
    fs.mkdirSync(sub, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: target, timeout: 5000 });
    const h = home();
    fs.rmSync(CALLS, { force: true });
    const direct = spawnSync(path.join(ROOT, 'bin', 'gstack-claude-code'), ['--cwd', target, '--access', 'none', '--timeout-ms', '5000', '--role', 'plan-review'],
      { cwd: TMP, input: 'Review this plan.', env: env(h, 'codex'), encoding: 'utf8', timeout: 20000 });
    expect(direct.status).toBe(1);
    expect(JSON.parse(direct.stdout).error.code).toBe('custom_provider_requires_model');
    expect(fs.existsSync(CALLS)).toBe(false);
    const command = outsideVoiceCommand(ctxFor('plan-eng-review', 'codex'), { promptFile: PROMPT, timeoutMs: 5000, role: 'plan-review' });
    const generated = spawnSync('bash', ['-c', command], { cwd: sub, env: env(h, 'codex'), encoding: 'utf8', timeout: 20000 });
    expect(generated.status).not.toBe(0);
    expect(generated.stdout).toContain('custom_provider_requires_model');
    expect(fs.existsSync(CALLS)).toBe(false);
    const explicit = spawnSync(path.join(ROOT, 'bin', 'gstack-claude-code'), ['--cwd', target, '--access', 'none', '--timeout-ms', '5000', '--role', 'plan-review'],
      { cwd: TMP, input: 'Review this plan.', env: env(h, 'codex', { GSTACK_CLAUDE_MODEL: 'gateway-model' }), encoding: 'utf8', timeout: 20000 });
    expect(explicit.status).toBe(0);
    expect(JSON.parse(explicit.stdout).selection.requested_model).toBe('gateway-model');
  });

  test('negative control: no role keeps zero --model without an override and shows no notice', () => {
    const h = home();
    const r = run('codex', h, {}, null);
    expect(r.status).toBe(0);
    expect(claudeModels(r.calls[0])).toEqual([]);
    expect(r.stderr).not.toContain('NOTICE: gstack plan reviews');
    expect(fs.existsSync(marker(h.state))).toBe(false);
  });

  test('a selected record is never re-resolved from the environment', () => {
    const cmd = { command: 'claude', argsPrefix: [] };
    const h = home();
    const selected = resolvePlanReviewModel({ provider: 'anthropic', env: { GSTACK_HOME: h.state, HOME: h.dir } });
    if (selected.status !== 'selected') throw new Error('expected a selected record');
    const args = claudeCodeArgs({ access: 'none', selection: selected }, cmd, { GSTACK_CLAUDE_MODEL: 'claude-late-change' });
    expect(claudeModels({ args })).toEqual(['claude-fable-5-1']);
    const dashed = claudeCodeArgs({ access: 'none', selection: { ...selected, requestedModel: '-p' } }, cmd, {});
    expect(dashed.filter(arg => arg === '-p')).toHaveLength(1);
    expect(dashed).toContain('--model=-p');
    fs.writeFileSync(path.join(h.state, 'config.yaml'), 'plan_review_tier: host\n');
    const delegated = resolvePlanReviewModel({ provider: 'anthropic', env: { GSTACK_HOME: h.state, HOME: h.dir } });
    expect(claudeModels({ args: claudeCodeArgs({ access: 'none', selection: delegated }, cmd, { GSTACK_CLAUDE_MODEL: 'claude-late-change' }) })).toEqual([]);
    expect(claudeCodeArgs({ access: 'none' }, cmd, { GSTACK_CLAUDE_MODEL: 'legacy pick' }).slice(-2)).toEqual(['--model', 'legacy pick']);
  });
});

describe('manual /codex entry: explicit role only, paid probe only for the dispatched model', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md.tmpl'), 'utf8');
  const preflight = skill.match(/```bash\n(_TEL=[^\n]*\n_CODEX_ROLE=''[\s\S]*?)\n```/)![1]!
    .replace('{{OUTSIDE_SELF_GUARD:codex}}', RESOLVERS.OUTSIDE_SELF_GUARD(ctxFor('codex', 'claude', HOST_PATHS.claude), ['codex']));
  const withRole = (text: string, role: string) => text.replaceAll("_CODEX_ROLE=''", `_CODEX_ROLE='${role}'`);
  const shell = (h: { dir: string; state: string }, script: string) => {
    fs.mkdirSync(path.join(h.dir, '.claude', 'skills'), { recursive: true });
    if (!fs.existsSync(path.join(h.dir, '.claude', 'skills', 'gstack'))) fs.symlinkSync(ROOT, path.join(h.dir, '.claude', 'skills', 'gstack'));
    fs.rmSync(CALLS, { force: true });
    const r = spawnSync('bash', ['-c', script], { cwd: REPO, env: env(h, 'claude', { CLAUDECODE: '', GSTACK_ACTIVE_HOST: '' }), encoding: 'utf8', timeout: 30000 });
    const calls = fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    return { ...r, calls: calls.filter((c: { args: string[] }) => c.args[0] === 'exec') };
  };

  test('Step 0.5 probes the native model without a role and makes no model call with it', () => {
    const plain = shell(home(), preflight);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('MODEL_OK');
    expect(plain.calls.map(codexModel)).toEqual(['model="gpt-5.6-terra"']);
    const role = shell(home(), withRole(preflight, 'plan-review'));
    expect(role.status).toBe(0);
    expect(role.stdout).not.toMatch(/MODEL_OK|MODEL_UNUSABLE|AUTH_FAILED/);
    expect(role.calls).toEqual([]);
    expect(role.stderr).not.toContain('NOTICE: gstack plan reviews');
  });

  for (const file of ['challenge-mode', 'consult-mode', 'review-mode']) {
    const template = fs.readFileSync(path.join(ROOT, 'codex', 'sections', `${file}.md.tmpl`), 'utf8');
    const selections = [...template.matchAll(/_CODEX_ROLE=''\n(_gstack_codex_select_model (exec|review) '' "\$_CODEX_ROLE" "\$_REPO_ROOT" \|\| exit 1\n\[ -z "\$_CODEX_ROLE" \] \|\| _gstack_codex_model_probe \2 \|\| exit \$\?)\n/g)];
    test(`${file}: every dispatch block selects then, with the role only, probes that same model`, () => {
      expect(selections.length).toBe(file === 'review-mode' ? 2 : 1);
      expect(template.match(/_gstack_codex_select_model/g)!.length).toBe(selections.length + (file === 'review-mode' ? 1 : 0));
      for (const [block, , kind] of selections) {
        const script = (role: string) => `_REPO_ROOT='${REPO}'\nsource "${ROOT}/bin/gstack-codex-probe" || exit 1\n${withRole(block, role)}\necho "DISPATCH=$_GSTACK_CODEX_SEL"`;
        const plain = shell(home(), script(''));
        expect(plain.status).toBe(0);
        expect(plain.stdout).toContain('DISPATCH=gpt-5.6-terra');
        expect(plain.calls).toEqual([]);
        const h = home();
        const role = shell(h, script('plan-review'));
        expect(role.status).toBe(0);
        expect(role.stdout).toContain('DISPATCH=gpt-6-astra');
        expect(role.calls.map(codexModel)).toEqual(['model="gpt-6-astra"']);
        expect(role.stderr).toContain(`CODEX_MODEL: gpt-6-astra (${kind}; role: plan-review, tier: frontier`);
        expect(role.stderr).toContain(NOTICE);
        const rejected = shell(home(), `export FAKE_PROBE=model400\n${script('plan-review')}`);
        expect(rejected.status).toBe(1);
        expect(rejected.stdout).not.toContain('DISPATCH=');
        expect(rejected.stdout).toContain('gstack-config set model_frontier_openai <model-id>');
      }
    });
  }
});

describe('invocation-boundary migration notice', () => {
  test('pure inspection writes nothing and does not suppress the first real notice', () => {
    const h = home();
    const inspect = spawnSync(path.join(ROOT, 'bin', 'gstack-models'), ['resolve', '--role', 'plan-review', '--provider', 'openai', '--json'],
      { env: env(h, 'claude'), encoding: 'utf8', timeout: 15000 });
    expect(inspect.status).toBe(0);
    expect(fs.readdirSync(h.state)).toEqual([]);
    expect(run('claude', h).stderr).toContain(NOTICE);
  });

  for (const host of ['codex', 'claude'] as const) {
    test(`${host === 'codex' ? 'Claude' : 'Codex'}: an unwritable marker repeats the notice instead of hiding it`, () => {
      const h = home();
      fs.chmodSync(h.state, 0o500);
      try {
        for (let i = 0; i < 2; i++) {
          const r = run(host, h);
          expect(r.status).toBe(0);
          expect(r.stderr).toContain(NOTICE);
        }
        expect(fs.existsSync(marker(h.state))).toBe(false);
      } finally { fs.chmodSync(h.state, 0o700); }
    });
  }

  test('disabled reviews stay disabled: no probe, no notice, no Codex call', () => {
    const block = outsideVoicePreflight(ctxFor('plan-eng-review', 'claude', HOST_PATHS.claude), { disabledBehavior: 'skip-all', role: 'plan-review' })
      .match(/```bash\n([\s\S]*?)\n```/)![1]!;
    for (const [config, mode] of [['codex_reviews: disabled\n', 'CODEX_MODE: disabled'], ['', 'CODEX_MODE: ready']] as const) {
      const h = home(config);
      fs.mkdirSync(path.join(h.dir, '.claude', 'skills'), { recursive: true });
      fs.symlinkSync(ROOT, path.join(h.dir, '.claude', 'skills', 'gstack'));
      fs.rmSync(CALLS, { force: true });
      const r = spawnSync('bash', ['-c', block], { cwd: REPO, env: env(h, 'claude', { CLAUDECODE: '', GSTACK_ACTIVE_HOST: '' }), encoding: 'utf8', timeout: 20000 });
      expect(r.stdout).toContain(mode);
      const calls = fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8') : '';
      expect(calls).not.toContain('"exec"');
      if (config) expect(calls).toBe('');
      expect(r.stderr).not.toContain('NOTICE: gstack plan reviews');
      expect(fs.existsSync(marker(h.state))).toBe(false);
    }
  });
});

describe('implementation handoff recommendation', () => {
  test('known harnesses pass their native provider; other hosts get both; nothing switches the session', () => {
    expect(generateImplementationModelHandoff(ctxFor('autoplan', 'claude', HOST_PATHS.claude))).toContain('gstack-models" resolve --role implementation --provider anthropic`');
    expect(generateImplementationModelHandoff(ctxFor('spec', 'codex'))).toContain('resolve --role implementation --provider openai`');
    const other = generateImplementationModelHandoff(ctxFor('plan-eng-review', 'kiro' as Host));
    expect(other).toContain('resolve --role implementation`');
    expect(other).toContain('one per provider');
    for (const text of [other]) {
      expect(text).toContain('cannot change this session');
      expect(text).not.toMatch(/claude-|gpt-/);
    }
  });

  test('the recommended command resolves offline from current settings without writes', () => {
    const h = home('implementation_tier: frontier\n');
    const r = spawnSync(path.join(ROOT, 'bin', 'gstack-models'), ['resolve', '--role', 'implementation', '--provider', 'anthropic', '--json'],
      { env: env(h, 'claude'), encoding: 'utf8', timeout: 15000 });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).selections[0]).toMatchObject({ role: 'implementation', requestedModel: 'claude-fable-5-1' });
    expect(fs.readdirSync(h.state)).toEqual(['config.yaml']);
  });
});
