import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { catalogEntry, MODEL_CATALOG, modelCatalogCanonicalJson, modelCatalogSha256 } from '../lib/model-catalog';
import {
  ANTHROPIC_MODEL_ID_PATTERN,
  CUSTOM_PROVIDER_UNSCANNED,
  describeSelection,
  detectCustomProvider as detectWith,
  isValidModelId,
  ModelPolicyError,
  OPENAI_MODEL_ID_PATTERN,
  parseModelPolicyConfig,
  readModelPolicyConfig,
  resolveImplementationModels as implementationWith,
  resolvePlanReviewModel as planReviewWith,
  selectionRepair,
  validatePolicyValue,
  type ModelSelection,
} from '../lib/model-policy';
import { CLAUDE_FRONTIER_EVAL_MODEL } from '../lib/eval-model';
import { CODEX_RUNTIME_MODEL_PATTERN } from '../scripts/resolve-codex-generation-model';
import { CODEX_FRONTIER_MODEL } from '../scripts/resolvers/constants';

const ROOT = path.resolve(import.meta.dir, '..');
const roots: string[] = [];
const ISOLATED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-model-policy-native-'));
const ISOLATED = { cwd: ISOLATED_DIR, claudeManagedDir: path.join(ISOLATED_DIR, 'managed'), codexSystemConfig: null };
const resolvePlanReviewModel = (opts: Parameters<typeof planReviewWith>[0]) => planReviewWith({ ...ISOLATED, ...opts });
const resolveImplementationModels = (opts: Parameters<typeof implementationWith>[0]) => implementationWith({ ...ISOLATED, ...opts });
const detectCustomProvider = (provider: Parameters<typeof detectWith>[0], opts: Parameters<typeof detectWith>[1] = {}) => detectWith(provider, { ...ISOLATED, ...opts });

afterAll(() => fs.rmSync(ISOLATED_DIR, { recursive: true, force: true }));

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(config?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-model-policy-'));
  roots.push(root);
  const state = path.join(root, 'state');
  const home = path.join(root, 'home');
  fs.mkdirSync(state);
  fs.mkdirSync(home);
  if (config !== undefined) fs.writeFileSync(path.join(state, 'config.yaml'), config);
  const env: Record<string, string | undefined> = { HOME: home, GSTACK_STATE_ROOT: state };
  return { root, state, home, env };
}

function policyError(run: () => unknown): ModelPolicyError {
  try {
    run();
  } catch (error) {
    if (error instanceof ModelPolicyError) return error;
    throw error;
  }
  throw new Error('expected a ModelPolicyError');
}

function selected(selection: ModelSelection): string {
  if (selection.status !== 'selected') throw new Error(`expected selected, got ${selection.status}`);
  return selection.requestedModel;
}

function tree(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

describe('model catalog', () => {
  test('ships exactly the four approved tier IDs with provenance', () => {
    expect(MODEL_CATALOG.map(e => [e.tier, e.provider, e.model])).toEqual([
      ['frontier', 'anthropic', 'claude-fable-5-1'],
      ['frontier', 'openai', 'gpt-6-astra'],
      ['smart', 'anthropic', 'claude-opus-5-5'],
      ['smart', 'openai', 'gpt-6.1-sol'],
    ]);
    for (const entry of MODEL_CATALOG) {
      expect(entry.sourceUrl).toMatch(/^https:\/\/(platform\.claude\.com|developers\.openai\.com)\//);
      expect(entry.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(Object.isFrozen(MODEL_CATALOG)).toBe(true);
    expect(catalogEntry('openai', 'smart').model).toBe('gpt-6.1-sol');
  });

  test('identity is deterministic and independent of user config', () => {
    const json = modelCatalogCanonicalJson();
    expect(JSON.parse(json)).toEqual({ version: 1, entries: MODEL_CATALOG.map(e => ({ ...e })) });
    expect(modelCatalogSha256()).toBe(createHash('sha256').update(json).digest('hex'));
    expect(modelCatalogCanonicalJson()).toBe(json);
    const source = fs.readFileSync(path.join(ROOT, 'lib/model-catalog.ts'), 'utf-8');
    expect(source).not.toMatch(/process\.env|state-root|readFileSync|config\.yaml/);
  });

  test('eval rulers and the no-role Codex pattern stay independent of the catalog', () => {
    expect(CLAUDE_FRONTIER_EVAL_MODEL).toBe('claude-fable-5-1');
    expect(CODEX_FRONTIER_MODEL).toBe('gpt-6-astra');
    for (const file of ['lib/eval-model.ts', 'scripts/resolvers/constants.ts']) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf-8')).not.toMatch(/from\s+['"][^'"]*model-(catalog|policy)/);
    }
    expect(OPENAI_MODEL_ID_PATTERN.source).toBe(CODEX_RUNTIME_MODEL_PATTERN.source);
  });
});

describe('model ID validation', () => {
  test.each([
    ['claude-opus-5-5', true],
    ['us.anthropic.claude-opus-5-5-v1:0', true],
    ['arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude', true],
    ['claude-opus-4@20250514', true],
    ['claude-opus-4-6[1m]', true],
    ['vendor+claude', true],
    ['a'.repeat(512), true],
    ['a'.repeat(513), false],
    ['claude opus', false],
    ['claude\topus', false],
    ['claude\u0007', false],
    ['$(touch x)', false],
    ['claude;rm', false],
    ['', false],
  ])('anthropic %p => %p', (value, ok) => {
    expect(isValidModelId('anthropic', value)).toBe(ok);
    expect(ANTHROPIC_MODEL_ID_PATTERN.test(value)).toBe(ok);
  });

  test.each([
    ['gpt-6.1-sol', true],
    ['org/model:v1', true],
    ['a'.repeat(100), true],
    ['a'.repeat(101), false],
    ['gpt+6', false],
    ['gpt 6', false],
    ['gpt"6', false],
  ])('openai %p => %p', (value, ok) => {
    expect(isValidModelId('openai', value)).toBe(ok);
  });

  test('policy values are trimmed and empty values fail', () => {
    expect(validatePolicyValue('model_smart_claude', '  claude-x  ')).toBeNull();
    expect(validatePolicyValue('plan_review_tier', ' host ')).toBeNull();
    expect(validatePolicyValue('model_smart_claude', '   ')?.reason).toBe('empty_value');
    expect(validatePolicyValue('implementation_tier', 'host')?.reason).toBe('invalid_implementation_tier');
    expect(validatePolicyValue('plan_review_tier', 'fronteir')?.reason).toBe('invalid_plan_review_tier');
    expect(validatePolicyValue('model_frontier_openai', 'gpt+6')?.reason).toBe('invalid_model_id');
  });
});

describe('strict policy config snapshot', () => {
  test('a missing file or absent keys give the documented defaults', () => {
    const { env } = fixture();
    const config = readModelPolicyConfig({ env });
    expect(config.exists).toBe(false);
    expect(config.planReviewTier).toMatchObject({ value: 'frontier', origin: 'default' });
    expect(config.implementationTier).toMatchObject({ value: 'smart', origin: 'default' });
    expect(config.overrides).toEqual({ anthropic: { frontier: null, smart: null }, openai: { frontier: null, smart: null } });
    expect(readModelPolicyConfig({ env: fixture('telemetry: off\n').env }).exists).toBe(true);
  });

  test('last value wins, CRLF and comments are tolerated, values are trimmed', () => {
    const config = parseModelPolicyConfig('# plan_review_tier: host\r\nplan_review_tier: host\r\nplan_review_tier:  smart \r\nmodel_smart_openai: gpt-x\r\n', '/c.yaml');
    expect(config.planReviewTier).toMatchObject({ value: 'smart', origin: 'config', path: '/c.yaml' });
    expect(config.overrides.openai.smart).toBe('gpt-x');
  });

  test.each([
    ['plan_review_tier:\n', 'empty_value', 'plan_review_tier'],
    ['plan_review_tier: fronteir\n', 'invalid_plan_review_tier', 'plan_review_tier'],
    ['implementation_tier: host\n', 'invalid_implementation_tier', 'implementation_tier'],
    ['model_frontier_openai: gpt 6\n', 'invalid_model_id', 'model_frontier_openai'],
    ['  plan_review_tier: smart\n', 'config_malformed', 'plan_review_tier'],
    ['model_smart_claude : claude-x\n', 'config_malformed', 'model_smart_claude'],
  ])('%p fails with %p', (text, reason, key) => {
    const error = policyError(() => parseModelPolicyConfig(text, '/c.yaml'));
    expect(error.reason).toBe(reason as ModelPolicyError['reason']);
    expect(error.key).toBe(key);
    if (reason === 'config_malformed') {
      expect(error.repair.join('\n')).toContain(`edit /c.yaml and remove or correct the malformed ${key} line`);
      expect(error.repair.join('\n')).not.toContain('gstack-config unset');
    } else {
      expect(error.repair.join('\n')).toContain(`gstack-config unset ${key}`);
    }
    expect(error.docs).toContain('troubleshooting.md#model-policy-config');
    for (const step of error.repair) expect(step).not.toMatch(/[|]/);
  });

  test('an invalid unused override still fails closed', () => {
    const { env } = fixture('plan_review_tier: smart\nmodel_frontier_claude: bad value\n');
    expect(policyError(() => resolvePlanReviewModel({ provider: 'openai', env })).reason).toBe('invalid_model_id');
  });

  test('recognizable policy records never become absent keys because of malformed delimiters', () => {
    const keys = ['plan_review_tier', 'implementation_tier', 'model_frontier_claude', 'model_frontier_openai', 'model_smart_claude', 'model_smart_openai'];
    for (const key of keys) {
      const value = key.startsWith('model_') ? 'custom-model' : 'smart';
      for (const line of [`${key} = ${value}`, `${key} ${value}`, `${key}; ${value}`, key, `"${key}": ${value}`, `- ${key}: ${value}`]) {
        const error = policyError(() => parseModelPolicyConfig(`${line}\n`, '/owned/config.yaml'));
        expect(error).toMatchObject({ reason: 'config_malformed', source: 'config', key });
        expect(error.repair).toContain(`edit /owned/config.yaml and remove or correct the malformed ${key} line`);
      }
    }
    const absent = parseModelPolicyConfig('# plan_review_tier = smart\nlegacy_key = value\nplan_review_tier_notes: unrelated\nbrain_trust_policy@local: shared\n', '/owned/config.yaml');
    expect(absent.planReviewTier).toMatchObject({ value: 'frontier', origin: 'default' });
    expect(parseModelPolicyConfig('plan_review_tier: host\nplan_review_tier: smart\n', '/owned/config.yaml').planReviewTier).toMatchObject({ value: 'smart', origin: 'config' });
  });

  test('a directory, an unreadable file or a file state root is an error, never the default', () => {
    const dir = fixture();
    fs.mkdirSync(path.join(dir.state, 'config.yaml'));
    const isDir = policyError(() => readModelPolicyConfig({ env: dir.env }));
    expect(isDir).toMatchObject({ reason: 'config_unreadable', cause: 'config.yaml is a directory' });

    const notDir = fixture();
    const fileRoot = path.join(notDir.root, 'file-root');
    fs.writeFileSync(fileRoot, '');
    expect(policyError(() => readModelPolicyConfig({ env: { ...notDir.env, GSTACK_STATE_ROOT: fileRoot } })).reason).toBe('config_unreadable');

    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const denied = fixture('plan_review_tier: smart\n');
      fs.chmodSync(path.join(denied.state, 'config.yaml'), 0o000);
      expect(policyError(() => resolvePlanReviewModel({ provider: 'openai', env: denied.env }))).toMatchObject({ reason: 'config_unreadable', cause: 'permission denied' });
    }
  });

  test('a bound snapshot is used for the whole resolution even if the file is replaced', () => {
    const { state, env } = fixture('model_frontier_openai: gpt-old\n');
    const config = readModelPolicyConfig({ env });
    const next = path.join(state, 'config.yaml.next');
    fs.writeFileSync(next, 'plan_review_tier: smart\nmodel_frontier_openai: gpt-new\n');
    fs.renameSync(next, path.join(state, 'config.yaml'));
    expect(selected(resolvePlanReviewModel({ provider: 'openai', env, config }))).toBe('gpt-old');
    const fresh = resolvePlanReviewModel({ provider: 'openai', env });
    expect(fresh.tier).toBe('smart');
    expect(selected(fresh)).toBe('gpt-6.1-sol');
  });
});

describe('plan-review precedence', () => {
  test.each(['anthropic', 'openai'] as const)('%s: request > env > per-tier config > catalog', provider => {
    const envName = provider === 'anthropic' ? 'GSTACK_CLAUDE_MODEL' : 'GSTACK_CODEX_MODEL';
    const key = provider === 'anthropic' ? 'model_frontier_claude' : 'model_frontier_openai';
    const { env, state } = fixture(`${key}: tier-model\n`);
    const withEnv = { ...env, [envName]: ' env-model ' };

    const request = resolvePlanReviewModel({ provider, requestedModel: 'request-model', env: withEnv });
    expect(request).toMatchObject({ status: 'selected', role: 'plan-review', provider, tier: 'frontier', requestedModel: 'request-model', source: { kind: 'request' } });

    const fromEnv = resolvePlanReviewModel({ provider, env: withEnv });
    expect(fromEnv).toMatchObject({ requestedModel: 'env-model', source: { kind: 'env', name: envName } });

    const fromConfig = resolvePlanReviewModel({ provider, env });
    expect(fromConfig).toMatchObject({ requestedModel: 'tier-model', source: { kind: 'config', key, path: path.join(state, 'config.yaml') } });

    const fromCatalog = resolvePlanReviewModel({ provider, env: fixture().env });
    expect(fromCatalog).toMatchObject({ requestedModel: catalogEntry(provider, 'frontier').model, source: { kind: 'catalog', catalogVersion: 1, verifiedAt: '2026-10-07' } });
    expect(fromCatalog.tierFrom).toMatchObject({ key: 'plan_review_tier', origin: 'default' });
  });

  test('smart tier reads the smart override, not the frontier one', () => {
    const { env } = fixture('plan_review_tier: smart\nmodel_frontier_openai: gpt-frontier-pin\n');
    const selection = resolvePlanReviewModel({ provider: 'openai', env });
    expect(selection).toMatchObject({ tier: 'smart', requestedModel: 'gpt-6.1-sol', tierFrom: { origin: 'config' } });
  });

  test('host mode delegates with a null model; request and env still win; tier overrides do not apply', () => {
    const { env } = fixture('plan_review_tier: host\nmodel_frontier_claude: claude-pin\nmodel_smart_claude: claude-pin\n');
    const delegated = resolvePlanReviewModel({ provider: 'anthropic', env });
    expect(delegated).toMatchObject({ status: 'delegated-host', requestedModel: null, tier: 'host', catalog: null, source: { kind: 'host', reason: 'host-mode', key: 'plan_review_tier' } });
    expect(describeSelection(delegated)).toContain('host-controlled');
    expect(selected(resolvePlanReviewModel({ provider: 'anthropic', env: { ...env, GSTACK_CLAUDE_MODEL: 'claude-env' } }))).toBe('claude-env');
    expect(selected(resolvePlanReviewModel({ provider: 'openai', requestedModel: 'gpt-req', env }))).toBe('gpt-req');
  });

  test('an invalid environment override names the env var and its repair, not a tier', () => {
    const { env } = fixture();
    const error = policyError(() => resolvePlanReviewModel({ provider: 'openai', env: { ...env, GSTACK_CODEX_MODEL: 'gpt"; rm -rf /' } }));
    expect(error).toMatchObject({ reason: 'invalid_model_id', key: 'GSTACK_CODEX_MODEL', source: 'env' });
    expect(error.repair[0]).toBe('unset GSTACK_CODEX_MODEL');
    expect(error.docs).toContain('#model-policy-selection');
    expect(policyError(() => resolvePlanReviewModel({ provider: 'anthropic', requestedModel: 'two words', env })).key).toBe('request');
  });

  test('an empty env override is unset, matching the legacy readers', () => {
    const { env } = fixture();
    expect(resolvePlanReviewModel({ provider: 'openai', env: { ...env, GSTACK_CODEX_MODEL: '' } }).source.kind).toBe('catalog');
  });

  test('selectionRepair follows the winning source', () => {
    const { env } = fixture();
    expect(selectionRepair(resolvePlanReviewModel({ provider: 'openai', env: { ...env, GSTACK_CODEX_MODEL: 'gpt-x' } }))).toEqual(['unset GSTACK_CODEX_MODEL', 'export GSTACK_CODEX_MODEL=<model-id>']);
    const catalogRepair = selectionRepair(resolvePlanReviewModel({ provider: 'anthropic', env }));
    expect(catalogRepair).toContain('gstack-config set model_frontier_claude <model-id>');
    expect(catalogRepair).toContain('gstack-config set plan_review_tier host');
  });
});

describe('custom-provider guard', () => {
  test.each(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'])('%s blocks the public default but not explicit choices', flag => {
    const { env } = fixture();
    for (const value of ['1', 'true', 'YES', 'on']) {
      const error = policyError(() => resolvePlanReviewModel({ provider: 'anthropic', env: { ...env, [flag]: value } }));
      expect(error).toMatchObject({ reason: 'custom_provider_requires_model', source: 'native' });
      expect(error.cause).toContain(flag);
      expect(error.repair).toEqual(['gstack-config set model_frontier_claude <model-id-your-endpoint-serves>', 'export GSTACK_CLAUDE_MODEL=<model-id-your-endpoint-serves>', 'gstack-config set plan_review_tier host']);
      expect(error.docs).toContain('#model-policy-provider');
    }
    for (const value of ['0', 'false', '', 'no']) {
      expect(resolvePlanReviewModel({ provider: 'anthropic', env: { ...env, [flag]: value } }).source.kind).toBe('catalog');
    }
    const custom = { ...env, [flag]: '1' };
    expect(selected(resolvePlanReviewModel({ provider: 'anthropic', env: { ...custom, GSTACK_CLAUDE_MODEL: 'us.anthropic.claude-x-v1:0' } }))).toBe('us.anthropic.claude-x-v1:0');
    expect(resolvePlanReviewModel({ provider: 'anthropic', env: { ...fixture('plan_review_tier: host\n').env, [flag]: '1' } }).status).toBe('delegated-host');
    expect(selected(resolvePlanReviewModel({ provider: 'anthropic', env: { ...fixture('model_frontier_claude: vertex-claude@1\n').env, [flag]: '1' } }))).toBe('vertex-claude@1');
    expect(resolvePlanReviewModel({ provider: 'openai', env: custom }).source.kind).toBe('catalog');
  });

  test('ANTHROPIC_BASE_URL counts only when non-default and is never printed', () => {
    const { env } = fixture();
    expect(detectCustomProvider('anthropic', { env: { ...env, ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' } }).custom).toBe(false);
    const endpoint = new URL('https://proxy.example/v1');
    endpoint.username = 'fixture-user';
    endpoint.password = 'fixture-password';
    const error = policyError(() => resolvePlanReviewModel({ provider: 'anthropic', env: { ...env, ANTHROPIC_BASE_URL: endpoint.href } }));
    expect(error.reason).toBe('custom_provider_requires_model');
    expect(JSON.stringify(error.toJSON())).not.toContain(endpoint.password);
    expect(JSON.stringify(error.toJSON())).not.toContain(endpoint.username);
  });

  test('Claude settings.json env signals count; malformed settings are unresolved', () => {
    const { env, home } = fixture();
    fs.mkdirSync(path.join(home, '.claude'));
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
    expect(detectCustomProvider('anthropic', { env }).signals).toEqual([`CLAUDE_CODE_USE_BEDROCK (${settings})`]);
    fs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '0' }, model: 'opus' }));
    expect(detectCustomProvider('anthropic', { env }).custom).toBe(false);
    fs.writeFileSync(settings, '{not json');
    expect(policyError(() => resolvePlanReviewModel({ provider: 'anthropic', env }))).toMatchObject({ reason: 'native_provider_unresolved', key: settings });
    expect(selected(resolvePlanReviewModel({ provider: 'anthropic', env: { ...env, GSTACK_CLAUDE_MODEL: 'claude-x' } }))).toBe('claude-x');
    const other = path.join(home, 'alt');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: 'true' } }));
    expect(detectCustomProvider('anthropic', { env: { ...env, CLAUDE_CONFIG_DIR: other } }).custom).toBe(true);
  });

  test('Codex model_provider, profile inheritance and base URLs', () => {
    const { env, home } = fixture();
    const codex = path.join(home, '.codex');
    fs.mkdirSync(codex);
    const write = (toml: string) => fs.writeFileSync(path.join(codex, 'config.toml'), toml);
    const custom = () => detectCustomProvider('openai', { env }).custom;

    expect(custom()).toBe(false);
    write('model = "gpt-5.5"\nmodel_provider = "openai"\n');
    expect(custom()).toBe(false);
    write('model_provider = "azure"\n');
    expect(policyError(() => resolvePlanReviewModel({ provider: 'openai', env })).reason).toBe('custom_provider_requires_model');
    write('model_provider = "azure"\nprofile = "work"\n[profiles.work]\nmodel_provider = "openai"\n');
    expect(custom()).toBe(false);
    write('profile = "work"\n[profiles.work]\nmodel_provider = "ollama"\n');
    expect(custom()).toBe(true);
    write('profile = "missing"\n');
    expect(policyError(() => detectCustomProvider('openai', { env })).reason).toBe('native_provider_unresolved');
    write('model_provider = 7\n');
    expect(policyError(() => detectCustomProvider('openai', { env })).reason).toBe('native_provider_unresolved');
    write('model_provider = [\n');
    expect(policyError(() => resolvePlanReviewModel({ provider: 'openai', env })).reason).toBe('native_provider_unresolved');
    expect(selected(resolvePlanReviewModel({ provider: 'openai', env: { ...env, GSTACK_CODEX_MODEL: 'gpt-x' } }))).toBe('gpt-x');
    write('openai_base_url = "https://gateway.example/v1"\n');
    expect(custom()).toBe(true);
    write('openai_base_url = "https://api.openai.com/v1/"\n');
    expect(custom()).toBe(false);
    expect(detectCustomProvider('openai', { env: { ...env, OPENAI_BASE_URL: 'https://gateway.example/v1' } }).custom).toBe(true);
    expect(policyError(() => detectCustomProvider('openai', { env: { ...env, CODEX_HOME: 'relative/codex' } })).reason).toBe('native_provider_unresolved');
    const alt = path.join(home, 'codex home with spaces');
    fs.mkdirSync(alt);
    fs.writeFileSync(path.join(alt, 'config.toml'), 'model_provider = "azure"\n');
    expect(detectCustomProvider('openai', { env: { ...env, CODEX_HOME: alt } }).custom).toBe(true);
  });
});

describe('custom-provider settings scopes', () => {
  function project(settings: Record<string, string>) {
    const fx = fixture();
    for (const [rel, body] of Object.entries(settings)) {
      fs.mkdirSync(path.dirname(path.join(fx.root, rel)), { recursive: true });
      fs.writeFileSync(path.join(fx.root, rel), body);
    }
    return fx;
  }
  const proxy = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example.test' } });
  const bedrock = JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } });

  test.each([
    ['shared project settings', 'app/.claude/settings.json', 'app'],
    ['project local settings', 'app/.claude/settings.local.json', 'app'],
    ['repository-root local settings from a subdirectory', 'repo/.claude/settings.local.json', 'repo/pkg'],
  ])('%s block the public default', (_name, file, cwd) => {
    const fx = project({ [file]: proxy, 'repo/.git/HEAD': 'ref: refs/heads/main\n' });
    fs.mkdirSync(path.join(fx.root, cwd), { recursive: true });
    const scope = { env: fx.env, cwd: path.join(fx.root, cwd) };
    const error = policyError(() => resolvePlanReviewModel({ provider: 'anthropic', ...scope }));
    expect(error.reason).toBe('custom_provider_requires_model');
    expect(error.cause).toContain(path.join(fx.root, file));
    expect(error.cause).not.toContain('proxy.example.test');
    expect(policyError(() => resolveImplementationModels({ host: 'claude-code', ...scope })).reason).toBe('custom_provider_requires_model');
    expect(selected(resolvePlanReviewModel({ provider: 'anthropic', ...scope, env: { ...fx.env, GSTACK_CLAUDE_MODEL: 'proxy-claude' } }))).toBe('proxy-claude');
    expect(resolvePlanReviewModel({ provider: 'anthropic', ...scope, env: { ...fx.env, GSTACK_STATE_ROOT: project({ 'state/config.yaml': 'plan_review_tier: host\n' }).state } }).status).toBe('delegated-host');
    expect(resolvePlanReviewModel({ provider: 'openai', ...scope }).source.kind).toBe('catalog');
  });

  test('a worktree also reads the main checkout local settings', () => {
    const fx = project({
      'main/.git/worktrees/wt/commondir': '../..\n',
      'main/.claude/settings.local.json': bedrock,
    });
    fs.mkdirSync(path.join(fx.root, 'wt'));
    fs.writeFileSync(path.join(fx.root, 'wt', '.git'), `gitdir: ${path.join(fx.root, 'main/.git/worktrees/wt')}\n`);
    const detection = detectCustomProvider('anthropic', { env: fx.env, cwd: path.join(fx.root, 'wt') });
    expect(detection.signals).toEqual([`CLAUDE_CODE_USE_BEDROCK (${path.join(fx.root, 'main/.claude/settings.local.json')})`]);
  });

  test('shared settings are read from the working directory, as Claude does, not the repository root', () => {
    const fx = project({ 'repo/.git/HEAD': '', 'repo/.claude/settings.json': proxy });
    fs.mkdirSync(path.join(fx.root, 'repo/pkg'));
    expect(detectCustomProvider('anthropic', { env: fx.env, cwd: path.join(fx.root, 'repo/pkg') }).custom).toBe(false);
    expect(detectCustomProvider('anthropic', { env: fx.env, cwd: path.join(fx.root, 'repo') }).custom).toBe(true);
  });

  test('managed settings file and drop-ins count; a malformed one is unresolved', () => {
    const fx = project({ 'managed/managed-settings.d/20-route.json': bedrock, 'managed/managed-settings.d/.hidden.json': '{', 'managed/managed-settings.d/notes.txt': '{' });
    const managed = path.join(fx.root, 'managed');
    expect(detectCustomProvider('anthropic', { env: fx.env, claudeManagedDir: managed }).signals).toEqual([`CLAUDE_CODE_USE_BEDROCK (${path.join(managed, 'managed-settings.d/20-route.json')})`]);
    fs.writeFileSync(path.join(managed, 'managed-settings.json'), '{broken');
    expect(policyError(() => resolvePlanReviewModel({ provider: 'anthropic', env: fx.env, claudeManagedDir: managed }))).toMatchObject({ reason: 'native_provider_unresolved', key: path.join(managed, 'managed-settings.json') });
  });

  test('a requested cwd is honored instead of process.cwd()', () => {
    const fx = project({ 'elsewhere/.claude/settings.local.json': proxy });
    const cwd = path.join(fx.root, 'elsewhere');
    expect(process.cwd()).not.toBe(cwd);
    const managed = { claudeManagedDir: path.join(fx.root, 'none') };
    expect(policyError(() => planReviewWith({ provider: 'anthropic', env: fx.env, cwd, ...managed })).reason).toBe('custom_provider_requires_model');
    expect(policyError(() => planReviewWith({ provider: 'anthropic', env: fx.env, cwd: path.relative(process.cwd(), cwd), ...managed })).reason).toBe('custom_provider_requires_model');
    const original = process.cwd();
    process.chdir(fx.home);
    try {
      expect(planReviewWith({ provider: 'anthropic', env: fx.env, ...managed }).source.kind).toBe('catalog');
      process.chdir(cwd);
      expect(policyError(() => planReviewWith({ provider: 'anthropic', env: fx.env, ...managed })).reason).toBe('custom_provider_requires_model');
    } finally {
      process.chdir(original);
    }
  });

  test('Codex system config is a lower layer than user config', () => {
    const fx = project({ 'etc/codex.toml': 'model_provider = "azure"\n' });
    const scope = { env: fx.env, codexSystemConfig: path.join(fx.root, 'etc/codex.toml') };
    expect(detectCustomProvider('openai', scope).signals).toEqual([`model_provider "azure" (${scope.codexSystemConfig})`]);
    fs.mkdirSync(path.join(fx.home, '.codex'));
    fs.writeFileSync(path.join(fx.home, '.codex', 'config.toml'), 'model_provider = "openai"\n');
    expect(detectCustomProvider('openai', scope).custom).toBe(false);
  });

  test('a malformed native config reached from smart plan-review or implementation names no tier override', () => {
    const fx = project({ 'state/config.yaml': 'plan_review_tier: smart\n', 'home/.codex/config.toml': 'model_provider = [\n' });
    for (const run of [
      () => resolvePlanReviewModel({ provider: 'openai', env: fx.env }),
      () => resolveImplementationModels({ provider: 'openai', env: fx.env }),
    ]) {
      const error = policyError(run);
      expect(error.reason).toBe('native_provider_unresolved');
      expect(error.repair).toEqual([`fix the TOML in ${path.join(fx.home, '.codex', 'config.toml')}`, 'or name the model explicitly for this request']);
    }
  });

  test('detection reports what it scanned and what it cannot see', () => {
    const fx = fixture();
    const detection = detectCustomProvider('anthropic', { env: fx.env });
    expect(detection.scanned).toContain(path.join(ISOLATED_DIR, '.claude', 'settings.local.json'));
    expect(detection.scanned).toContain(path.join(ISOLATED.claudeManagedDir, 'managed-settings.json'));
    expect(detection.unscanned).toEqual([...CUSTOM_PROVIDER_UNSCANNED.anthropic]);
    expect(detectCustomProvider('openai', { env: fx.env }).unscanned.join(' ')).toContain('--profile');
  });
});

describe('implementation recommendation', () => {
  test('known hosts recommend their own provider; unknown hosts get both', () => {
    const { env } = fixture();
    expect(resolveImplementationModels({ host: 'claude-code', env }).map(s => [s.provider, selected(s)])).toEqual([['anthropic', 'claude-opus-5-5']]);
    expect(resolveImplementationModels({ host: 'codex', env }).map(s => [s.provider, selected(s)])).toEqual([['openai', 'gpt-6.1-sol']]);
    for (const host of ['unknown', undefined] as const) {
      expect(resolveImplementationModels({ host, env }).map(s => s.provider)).toEqual(['anthropic', 'openai']);
    }
    expect(resolveImplementationModels({ host: 'codex', provider: 'anthropic', env }).map(s => s.provider)).toEqual(['anthropic']);
  });

  test('frontier is honored, overrides apply, env overrides do not', () => {
    const { env } = fixture('implementation_tier: frontier\nmodel_frontier_openai: gpt-pin\n');
    const envWithOverrides = { ...env, GSTACK_CLAUDE_MODEL: 'claude-env', GSTACK_CODEX_MODEL: 'gpt-env' };
    const [anthropic, openai] = resolveImplementationModels({ env: envWithOverrides });
    expect(anthropic).toMatchObject({ role: 'implementation', tier: 'frontier', requestedModel: 'claude-fable-5-1', source: { kind: 'catalog' }, tierFrom: { key: 'implementation_tier', origin: 'config' } });
    expect(openai).toMatchObject({ requestedModel: 'gpt-pin', source: { kind: 'config', key: 'model_frontier_openai' } });
    expect(resolveImplementationModels({ provider: 'openai', requestedModel: 'gpt-req', env })[0]).toMatchObject({ requestedModel: 'gpt-req', source: { kind: 'request' } });
  });

  test('an explicit model without a single provider is rejected', () => {
    const { env } = fixture();
    expect(policyError(() => resolveImplementationModels({ requestedModel: 'gpt-x', env })).reason).toBe('provider_required');
  });

  test('custom routing needs an explicit implementation model; it is never delegated', () => {
    const { env } = fixture();
    const custom = { ...env, CLAUDE_CODE_USE_BEDROCK: '1' };
    const error = policyError(() => resolveImplementationModels({ host: 'claude-code', env: custom }));
    expect(error).toMatchObject({ reason: 'custom_provider_requires_model' });
    expect(error.repair[0]).toBe('gstack-config set model_smart_claude <model-id-your-endpoint-serves>');
    expect(error.repair.join(' ')).not.toContain('GSTACK_CLAUDE_MODEL');
    expect(error.repair.join(' ')).not.toContain('host');
    expect(selected(resolveImplementationModels({ host: 'claude-code', env: { ...fixture('model_smart_claude: us.anthropic.claude-x\n').env, CLAUDE_CODE_USE_BEDROCK: '1' } })[0])).toBe('us.anthropic.claude-x');
  });
});

describe('purity', () => {
  test('resolution and inspection never write state', () => {
    const { root, env } = fixture('plan_review_tier: smart\n');
    const before = tree(root);
    resolvePlanReviewModel({ provider: 'openai', env });
    resolvePlanReviewModel({ provider: 'anthropic', env });
    resolveImplementationModels({ env });
    expect(tree(root)).toEqual(before);
  });

  test('errors carry every structured field', () => {
    const error = policyError(() => parseModelPolicyConfig('plan_review_tier: nope\n', '/c.yaml'));
    expect(Object.keys(error.toJSON()).sort()).toEqual(['cause', 'docs', 'key', 'problem', 'reason', 'repair', 'source']);
    expect(error.repair.length).toBeGreaterThan(0);
  });
});
