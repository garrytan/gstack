import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { modelCatalogSha256 } from '../lib/model-catalog';
import { validatePolicyValue, type PolicyConfigKey } from '../lib/model-policy';
import { CLAUDE_CODE_RUNTIME_FILES } from '../lib/claude-code-migration';

const ROOT = path.resolve(import.meta.dir, '..');
const MODELS = path.join(ROOT, 'bin', 'gstack-models');
const CONFIG = path.join(ROOT, 'bin', 'gstack-config');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(config?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack models cli '));
  roots.push(root);
  const state = path.join(root, 'state');
  const home = path.join(root, 'home');
  fs.mkdirSync(state);
  fs.mkdirSync(home);
  if (config !== undefined) fs.writeFileSync(path.join(state, 'config.yaml'), config);
  return { root, state, home, env: { PATH: process.env.PATH ?? '', HOME: home, GSTACK_STATE_ROOT: state, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } as Record<string, string> };
}

function models(args: string[], env: Record<string, string>, cwd = path.dirname(env.HOME)) {
  const result = spawnSync(process.execPath, [MODELS, ...args], { encoding: 'utf-8', env, cwd, timeout: 30_000 });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function config(args: string[], env: Record<string, string>) {
  const result = spawnSync('bash', [CONFIG, ...args], { encoding: 'utf-8', env, timeout: 30_000 });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function json(args: string[], env: Record<string, string>, cwd?: string) {
  const result = models([...args, '--json'], env, cwd);
  expect(result.stderr).toBe('');
  return { code: result.code, doc: JSON.parse(result.stdout) };
}

function tree(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

describe('gstack-models inspector', () => {
  test('--help explains roles, values, offline behavior, delegation and exits', () => {
    const result = models(['--help'], fixture().env);
    expect(result.code).toBe(0);
    for (const text of ['plan-review', 'implementation', 'frontier | smart | host', 'frontier | smart ', 'offline', 'no paid model call', 'host-controlled', 'Exit: 0', '2 invalid usage', 'schemaVersion 1']) {
      expect(result.stdout).toContain(text);
    }
  });

  test('list is the default and emits one JSON document with both roles and tier entries', () => {
    const { env, state } = fixture();
    const human = models([], env);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('plan-review via openai: gpt-6-astra');
    expect(human.stdout).toContain('implementation via anthropic: claude-opus-5-5');
    expect(human.stdout).toContain('gstack-config set plan_review_tier smart');
    expect(human.stderr).toBe('');
    expect(models(['list'], env).stdout).toBe(human.stdout);

    const { code, doc } = json([], env);
    expect(code).toBe(0);
    expect(doc).toMatchObject({ schemaVersion: 1, command: 'list', ok: true, offline: true, configPath: path.join(state, 'config.yaml'), errors: [] });
    expect(doc.catalog).toMatchObject({ version: 1, sha256: modelCatalogSha256() });
    expect(doc.selections.map((s: { role: string; provider: string }) => `${s.role}/${s.provider}`)).toEqual(['plan-review/anthropic', 'plan-review/openai', 'implementation/anthropic', 'implementation/openai']);
    expect(doc.tiers).toHaveLength(4);
    expect(doc.settings.plan_review_tier).toEqual({ value: null, effective: 'frontier', origin: 'default' });
    expect(doc.settings.model_smart_openai).toEqual({ value: null, effective: 'gpt-6.1-sol', origin: 'default' });
  });

  test('resolve plan-review returns one tagged selection with its source', () => {
    const { env } = fixture('model_frontier_openai: gpt-pinned\n');
    const { code, doc } = json(['resolve', '--role', 'plan-review', '--provider', 'openai'], { ...env, GSTACK_CLAUDE_MODEL: 'claude-ignored' });
    expect(code).toBe(0);
    expect(doc.selections).toHaveLength(1);
    expect(doc.selections[0]).toMatchObject({ status: 'selected', role: 'plan-review', provider: 'openai', tier: 'frontier', requestedModel: 'gpt-pinned', source: { kind: 'config', key: 'model_frontier_openai' } });
    const envWins = json(['resolve', '--role=plan-review', '--provider=openai'], { ...env, GSTACK_CODEX_MODEL: 'gpt-env' });
    expect(envWins.doc.selections[0]).toMatchObject({ requestedModel: 'gpt-env', source: { kind: 'env', name: 'GSTACK_CODEX_MODEL' } });
  });

  test('every tier entry includes executable pin and reset commands', () => {
    const { env, root } = fixture();
    const install = path.join(root, "installed gstack's runtime");
    for (const file of CLAUDE_CODE_RUNTIME_FILES) {
      const target = path.join(install, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), target);
    }
    const listed = spawnSync(process.execPath, [path.join(install, 'bin/gstack-models'), 'list'], { cwd: root, env, encoding: 'utf-8', timeout: 30_000 });
    expect(listed.status).toBe(0);
    const lines = listed.stdout.split('\n').map(line => line.trim());
    const { doc } = json([], env);
    for (const entry of doc.tiers) {
      const pin = lines.find(line => line.includes(` set ${entry.overrideKey} `));
      const reset = lines.find(line => line.endsWith(` unset ${entry.overrideKey}`));
      expect(pin).toBeDefined();
      expect(reset).toBeDefined();
      for (const command of [pin!, reset!]) {
        const result = spawnSync('bash', ['-c', command], { cwd: root, env, encoding: 'utf-8', timeout: 30_000 });
        expect(result.status).toBe(0);
        const setting = json([], env).doc.settings[entry.overrideKey];
        expect(setting.origin).toBe(command === pin ? 'config' : 'default');
        expect(setting.effective).toBe(entry.catalogModel);
      }
    }
  });

  test('resolve implementation returns both providers unless one is named', () => {
    const { env } = fixture('implementation_tier: frontier\n');
    const both = json(['resolve', '--role', 'implementation'], env);
    expect(both.code).toBe(0);
    expect(both.doc.selections.map((s: { provider: string; requestedModel: string }) => [s.provider, s.requestedModel])).toEqual([['anthropic', 'claude-fable-5-1'], ['openai', 'gpt-6-astra']]);
    const one = json(['resolve', '--role', 'implementation', '--provider', 'openai'], env);
    expect(one.doc.selections).toHaveLength(1);
    expect(one.doc.selections[0].provider).toBe('openai');
  });

  test('host mode is a valid delegated resolution with a null model', () => {
    const { env } = fixture('plan_review_tier: host\n');
    const { code, doc } = json(['resolve', '--role', 'plan-review', '--provider', 'anthropic'], env);
    expect(code).toBe(0);
    expect(doc.selections[0]).toMatchObject({ status: 'delegated-host', requestedModel: null, source: { kind: 'host', reason: 'host-mode' } });
    const human = models(['resolve', '--role', 'plan-review', '--provider', 'anthropic'], env);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('host-controlled');
  });

  test.each([
    [['bogus'], "unknown command 'bogus'"],
    [['resolve'], 'resolve needs --role'],
    [['resolve', '--role', 'coding'], "unknown role 'coding'"],
    [['resolve', '--role', 'plan-review'], 'needs --provider'],
    [['resolve', '--role', 'plan-review', '--provider', 'claude'], "unknown provider 'claude'"],
    [['resolve', '--role', 'implementation', '--provider', 'OpenAI'], "unknown provider 'OpenAI'"],
    [['resolve', '--role', 'plan-review', '--role', 'implementation', '--provider', 'openai'], '--role given twice'],
    [['resolve', '--role'], '--role needs a value'],
    [['list', '--provider', 'openai'], 'unknown argument'],
  ])('usage error %p exits 2', (args, message) => {
    const { env } = fixture();
    const human = models(args, env);
    expect(human.code).toBe(2);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain(message);
    const { code, doc } = json(args, env);
    expect(code).toBe(2);
    expect(doc).toMatchObject({ schemaVersion: 1, ok: false, selections: [] });
    expect(doc.errors[0]).toMatchObject({ reason: 'usage' });
    expect(doc.errors[0].problem).toContain(message);
  });

  test('invalid config exits 1 with structured, source-aware repair', () => {
    const { env } = fixture('plan_review_tier: fronteir\n');
    const { code, doc } = json([], env);
    expect(code).toBe(1);
    expect(doc).toMatchObject({ ok: false, selections: [], settings: null });
    expect(doc.errors[0]).toMatchObject({ reason: 'invalid_plan_review_tier', key: 'plan_review_tier' });
    expect(doc.errors[0].repair).toContain('gstack-config unset plan_review_tier');
    expect(doc.errors[0].docs).toContain('#model-policy-config');
    const human = models(['resolve', '--role', 'implementation'], env);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('fix: gstack-config unset plan_review_tier');
  });

  test('an unusable environment override points at the env var', () => {
    const { env } = fixture();
    const { code, doc } = json(['resolve', '--role', 'plan-review', '--provider', 'openai'], { ...env, GSTACK_CODEX_MODEL: 'gpt 6' });
    expect(code).toBe(1);
    expect(doc.errors[0]).toMatchObject({ reason: 'invalid_model_id', key: 'GSTACK_CODEX_MODEL', role: 'plan-review', provider: 'openai' });
    expect(doc.errors[0].repair[0]).toBe('unset GSTACK_CODEX_MODEL');
  });

  test('custom routing fails only the affected selections', () => {
    const { env } = fixture();
    const { code, doc } = json([], { ...env, CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(code).toBe(1);
    expect(doc.selections.map((s: { role: string; provider: string }) => `${s.role}/${s.provider}`)).toEqual(['plan-review/openai', 'implementation/openai']);
    expect(doc.errors.map((e: { reason: string; role: string }) => `${e.reason}/${e.role}`)).toEqual(['custom_provider_requires_model/plan-review', 'custom_provider_requires_model/implementation']);
  });

  test('project settings in the working directory are custom routing; detection limits are published', () => {
    const { env, root } = fixture();
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example.test' } }));
    const { code, doc } = json(['resolve', '--role', 'plan-review', '--provider', 'anthropic'], env, project);
    expect(code).toBe(1);
    expect(doc.errors[0]).toMatchObject({ reason: 'custom_provider_requires_model', provider: 'anthropic' });
    expect(doc.providerDetection.unscanned.anthropic.join(' ')).toContain('server-managed');
    expect(json(['resolve', '--role', 'plan-review', '--provider', 'anthropic'], env).code).toBe(0);
    expect(models(['--help'], env).stdout).toContain('cannot see server-managed or MDM policy');
  });

  test.each(['[]', 'null', '"unsupported"', 'true', '42'])('unsupported native settings root %s fails closed without writes', (contents) => {
    const { root, home, env } = fixture();
    const directory = path.join(home, '.claude');
    fs.mkdirSync(directory);
    const settings = path.join(directory, 'settings.json');
    fs.writeFileSync(settings, '{}');
    const args = ['resolve', '--role', 'plan-review', '--provider', 'anthropic'];
    expect(json(args, env).code).toBe(0);
    fs.writeFileSync(settings, contents);
    const before = tree(root);
    const result = json(args, env);
    expect(result.code).toBe(1);
    expect(result.doc.selections).toEqual([]);
    expect(result.doc.errors[0]).toMatchObject({ reason: 'native_provider_unresolved', key: settings });
    expect(result.doc.errors[0].repair).toContain(`fix the settings object in ${settings}`);
    expect(tree(root)).toEqual(before);
    expect(json(args, { ...env, GSTACK_CLAUDE_MODEL: 'claude-explicit' }).doc.selections[0].requestedModel).toBe('claude-explicit');
  });

  test('inspection never writes to the state root or home', () => {
    const { root, env } = fixture('plan_review_tier: smart\n');
    const before = tree(root);
    models([], env);
    models(['--json'], env);
    models(['resolve', '--role', 'plan-review', '--provider', 'anthropic', '--json'], env);
    models(['resolve', '--role', 'implementation'], env);
    expect(tree(root)).toEqual(before);
  });
});

describe('gstack-config model policy keys', () => {
  test('defaults, set, resolve again and unset restore', () => {
    const { env } = fixture();
    expect(config(['get', 'plan_review_tier'], env)).toMatchObject({ code: 0, stdout: 'frontier' });
    expect(config(['get', 'implementation_tier'], env)).toMatchObject({ code: 0, stdout: 'smart' });
    expect(config(['get', 'model_frontier_claude'], env)).toMatchObject({ code: 0, stdout: '' });
    expect(config(['defaults'], env).stdout).toContain('plan_review_tier:');

    expect(config(['set', 'plan_review_tier', 'smart'], env).code).toBe(0);
    expect(config(['set', 'model_smart_openai', '  gpt-custom  '], env).code).toBe(0);
    expect(config(['get', 'model_smart_openai'], env).stdout).toBe('gpt-custom');
    expect(json(['resolve', '--role', 'plan-review', '--provider', 'openai'], env).doc.selections[0]).toMatchObject({ tier: 'smart', requestedModel: 'gpt-custom', source: { kind: 'config' } });
    expect(config(['list'], env).stdout).toContain('model_smart_openai:      gpt-custom (set)');

    expect(config(['unset', 'plan_review_tier'], env).code).toBe(0);
    expect(config(['unset', 'model_smart_openai'], env).code).toBe(0);
    expect(json(['resolve', '--role', 'plan-review', '--provider', 'openai'], env).doc.selections[0]).toMatchObject({ tier: 'frontier', requestedModel: 'gpt-6-astra', source: { kind: 'catalog' } });
  });

  test.each([
    ['plan_review_tier', 'fronteir'],
    ['plan_review_tier', '   '],
    ['implementation_tier', 'host'],
    ['model_frontier_openai', 'gpt 6'],
    ['model_frontier_claude', 'a'.repeat(513)],
  ])('invalid %s %p is rejected and the old value kept', (key, value) => {
    const { env, state } = fixture();
    const good = key.startsWith('model_') ? 'model-1' : 'frontier';
    expect(config(['set', key, good], env).code).toBe(0);
    const before = fs.readFileSync(path.join(state, 'config.yaml'), 'utf-8');
    const result = config(['set', key, value], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Existing value left unchanged');
    expect(result.stderr).toContain(`gstack-config unset ${key}`);
    expect(result.stderr).toContain('#model-policy-config');
    expect(fs.readFileSync(path.join(state, 'config.yaml'), 'utf-8')).toBe(before);
  });

  test('set and resolve share one validation rule', () => {
    const samples: Array<[PolicyConfigKey, string]> = [
      ['plan_review_tier', 'frontier'], ['plan_review_tier', 'smart'], ['plan_review_tier', 'host'], ['plan_review_tier', 'Smart'],
      ['implementation_tier', 'frontier'], ['implementation_tier', 'smart'], ['implementation_tier', 'host'],
      ['model_frontier_claude', 'claude-opus-4-6[1m]'], ['model_frontier_claude', 'vendor+claude@2026'], ['model_frontier_claude', 'a'.repeat(512)],
      ['model_frontier_claude', 'a'.repeat(513)], ['model_smart_claude', 'claude;x'], ['model_smart_claude', 'claude x'], ['model_smart_claude', '$(id)'],
      ['model_frontier_openai', 'gpt-6.1-sol'], ['model_frontier_openai', 'org/model:v1'], ['model_frontier_openai', 'a'.repeat(100)],
      ['model_frontier_openai', 'a'.repeat(101)], ['model_smart_openai', 'gpt+6'], ['model_smart_openai', 'gpt@6'],
    ];
    const { env } = fixture();
    for (const [key, value] of samples) {
      const accepted = config(['set', key, value], env).code === 0;
      expect({ key, value: value.slice(0, 20), accepted }).toEqual({ key, value: value.slice(0, 20), accepted: validatePolicyValue(key, value) === null });
    }
  });
});
