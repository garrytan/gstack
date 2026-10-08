import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { catalogEntry, MODEL_CATALOG_VERSION, MODEL_PROVIDERS, type ModelCatalogEntry, type ModelProvider, type ModelTier } from './model-catalog';
import { resolveStateRoot, type StateRootEnv } from './state-root';

export const MODEL_POLICY_VERSION = 1 as const;

export type ModelRole = 'plan-review' | 'implementation';
export type PlanReviewTier = ModelTier | 'host';
export type ModelHost = 'claude-code' | 'codex' | 'unknown';

export const MODEL_ROLES: readonly ModelRole[] = Object.freeze(['plan-review', 'implementation'] as const);
export const PLAN_REVIEW_TIERS: readonly PlanReviewTier[] = Object.freeze(['frontier', 'smart', 'host'] as const);
export const IMPLEMENTATION_TIERS: readonly ModelTier[] = Object.freeze(['frontier', 'smart'] as const);

export type PolicyConfigKey =
  | 'plan_review_tier'
  | 'implementation_tier'
  | 'model_frontier_claude'
  | 'model_frontier_openai'
  | 'model_smart_claude'
  | 'model_smart_openai';

export const POLICY_CONFIG_KEYS: readonly PolicyConfigKey[] = Object.freeze([
  'plan_review_tier',
  'implementation_tier',
  'model_frontier_claude',
  'model_frontier_openai',
  'model_smart_claude',
  'model_smart_openai',
] as const);

export const MODEL_OVERRIDE_KEYS: Readonly<Record<ModelProvider, Readonly<Record<ModelTier, PolicyConfigKey>>>> = Object.freeze({
  anthropic: Object.freeze({ frontier: 'model_frontier_claude', smart: 'model_smart_claude' } as const),
  openai: Object.freeze({ frontier: 'model_frontier_openai', smart: 'model_smart_openai' } as const),
});

export const PROVIDER_ENV_OVERRIDES = Object.freeze({ anthropic: 'GSTACK_CLAUDE_MODEL', openai: 'GSTACK_CODEX_MODEL' } as const);

export const OPENAI_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,100}$/;
export const ANTHROPIC_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+[\]-]{1,512}$/;

const DOCS = 'https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md';
const DOCS_CONFIG = `${DOCS}#model-policy-config`;
const DOCS_PROVIDER = `${DOCS}#model-policy-provider`;
const DOCS_SELECTION = `${DOCS}#model-policy-selection`;

const PROVIDER_LABEL: Record<ModelProvider, string> = { anthropic: 'Anthropic (Claude Code)', openai: 'OpenAI (Codex)' };

export type ModelPolicyReason =
  | 'config_unreadable'
  | 'config_malformed'
  | 'empty_value'
  | 'invalid_plan_review_tier'
  | 'invalid_implementation_tier'
  | 'invalid_model_id'
  | 'custom_provider_requires_model'
  | 'native_provider_unresolved'
  | 'provider_required';

export type SelectionSource =
  | { kind: 'request'; label: string }
  | { kind: 'env'; name: (typeof PROVIDER_ENV_OVERRIDES)[ModelProvider]; label: string }
  | { kind: 'config'; key: PolicyConfigKey; path: string; label: string }
  | { kind: 'catalog'; catalogVersion: typeof MODEL_CATALOG_VERSION; verifiedAt: string; sourceUrl: string; label: string }
  | { kind: 'host'; reason: 'host-mode'; key: 'plan_review_tier'; label: string };

export interface ModelPolicyErrorJson {
  reason: ModelPolicyReason;
  problem: string;
  cause: string;
  key: string | null;
  source: SelectionSource['kind'] | 'native' | null;
  repair: string[];
  docs: string;
}

export class ModelPolicyError extends Error {
  readonly reason: ModelPolicyReason;
  readonly problem: string;
  readonly cause: string;
  readonly key: string | null;
  readonly source: ModelPolicyErrorJson['source'];
  readonly repair: string[];
  readonly docs: string;

  constructor(detail: ModelPolicyErrorJson) {
    super(`${detail.problem}: ${detail.cause}`);
    this.name = 'ModelPolicyError';
    this.reason = detail.reason;
    this.problem = detail.problem;
    this.cause = detail.cause;
    this.key = detail.key;
    this.source = detail.source;
    this.repair = detail.repair;
    this.docs = detail.docs;
  }

  toJSON(): ModelPolicyErrorJson {
    return { reason: this.reason, problem: this.problem, cause: this.cause, key: this.key, source: this.source, repair: this.repair, docs: this.docs };
  }
}

export interface TierChoice<T extends PlanReviewTier> {
  value: T;
  key: 'plan_review_tier' | 'implementation_tier';
  origin: 'config' | 'default';
  path: string;
}

export interface ModelPolicyConfig {
  path: string;
  exists: boolean;
  planReviewTier: TierChoice<PlanReviewTier>;
  implementationTier: TierChoice<ModelTier>;
  overrides: Record<ModelProvider, Record<ModelTier, string | null>>;
}

interface SelectionBase {
  role: ModelRole;
  provider: ModelProvider;
  tier: PlanReviewTier;
  tierFrom: TierChoice<PlanReviewTier>;
  catalog: ModelCatalogEntry | null;
}

export interface SelectedModel extends SelectionBase {
  status: 'selected';
  requestedModel: string;
  source: Exclude<SelectionSource, { kind: 'host' }>;
}

export interface DelegatedHostModel extends SelectionBase {
  status: 'delegated-host';
  requestedModel: null;
  source: Extract<SelectionSource, { kind: 'host' }>;
}

export type ModelSelection = SelectedModel | DelegatedHostModel;

function sanitize(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
}

function providerOfKey(key: PolicyConfigKey): ModelProvider | null {
  for (const provider of MODEL_PROVIDERS) {
    if (Object.values(MODEL_OVERRIDE_KEYS[provider]).includes(key)) return provider;
  }
  return null;
}

export function isValidModelId(provider: ModelProvider, value: string): boolean {
  return (provider === 'openai' ? OPENAI_MODEL_ID_PATTERN : ANTHROPIC_MODEL_ID_PATTERN).test(value);
}

function modelIdRule(provider: ModelProvider): string {
  return provider === 'openai'
    ? '1-100 characters from A-Z a-z 0-9 . _ : / -'
    : '1-512 characters from A-Z a-z 0-9 . _ : / @ + [ ] -';
}

export function validatePolicyValue(key: PolicyConfigKey, rawValue: string, configPath = 'config.yaml'): ModelPolicyError | null {
  const value = rawValue.trim();
  if (value === '') {
    return new ModelPolicyError({
      reason: 'empty_value',
      problem: `${key} is empty in ${configPath}`,
      cause: 'an empty policy value is not a choice; unset the key to use the default',
      key,
      source: 'config',
      repair: [`gstack-config unset ${key}`],
      docs: DOCS_CONFIG,
    });
  }
  if (key === 'plan_review_tier' && !(PLAN_REVIEW_TIERS as readonly string[]).includes(value)) {
    return new ModelPolicyError({
      reason: 'invalid_plan_review_tier',
      problem: `plan_review_tier '${sanitize(value)}' in ${configPath} is not recognized`,
      cause: 'valid values are frontier, smart and host',
      key,
      source: 'config',
      repair: ['gstack-config unset plan_review_tier'],
      docs: DOCS_CONFIG,
    });
  }
  if (key === 'implementation_tier' && !(IMPLEMENTATION_TIERS as readonly string[]).includes(value)) {
    return new ModelPolicyError({
      reason: 'invalid_implementation_tier',
      problem: `implementation_tier '${sanitize(value)}' in ${configPath} is not recognized`,
      cause: 'valid values are frontier and smart',
      key,
      source: 'config',
      repair: ['gstack-config unset implementation_tier'],
      docs: DOCS_CONFIG,
    });
  }
  const provider = providerOfKey(key);
  if (provider && !isValidModelId(provider, value)) {
    return new ModelPolicyError({
      reason: 'invalid_model_id',
      problem: `${key} '${sanitize(value)}' in ${configPath} is not a valid ${provider} model ID`,
      cause: `use ${modelIdRule(provider)}`,
      key,
      source: 'config',
      repair: [`gstack-config set ${key} <model-id>`, `gstack-config unset ${key}`],
      docs: DOCS_CONFIG,
    });
  }
  return null;
}

export function parseModelPolicyConfig(text: string, configPath: string): ModelPolicyConfig {
  const records = new Map<PolicyConfigKey, string>();
  for (const line of text.split('\n')) {
    for (const key of POLICY_CONFIG_KEYS) {
      if (line.startsWith(`${key}:`)) {
        records.set(key, line.slice(key.length + 1).trim());
      } else if (new RegExp(`^\\s*(?:-\\s+)?["']?${key}(?=[^A-Za-z0-9_@]|$)`).test(line)) {
        throw new ModelPolicyError({
          reason: 'config_malformed',
          problem: `${configPath} has a malformed ${key} record`,
          cause: `write it as '${key}: <value>' at the start of the line, with no indentation or space before the colon`,
          key,
          source: 'config',
          repair: [`edit ${configPath} and remove or correct the malformed ${key} line`, `then use gstack-config set ${key} <value>`],
          docs: DOCS_CONFIG,
        });
      }
    }
  }
  const configValue = (key: PolicyConfigKey): string | null => {
    const value = records.get(key);
    if (value === undefined) return null;
    const problem = validatePolicyValue(key, value, configPath);
    if (problem) throw problem;
    return value;
  };
  const planReviewTier = configValue('plan_review_tier') as PlanReviewTier | null;
  const implementationTier = configValue('implementation_tier') as ModelTier | null;
  return {
    path: configPath,
    exists: true,
    planReviewTier: { value: planReviewTier ?? 'frontier', key: 'plan_review_tier', origin: planReviewTier ? 'config' : 'default', path: configPath },
    implementationTier: { value: implementationTier ?? 'smart', key: 'implementation_tier', origin: implementationTier ? 'config' : 'default', path: configPath },
    overrides: {
      anthropic: { frontier: configValue('model_frontier_claude'), smart: configValue('model_smart_claude') },
      openai: { frontier: configValue('model_frontier_openai'), smart: configValue('model_smart_openai') },
    },
  };
}

export function readModelPolicyConfig(opts: { env?: StateRootEnv; platform?: NodeJS.Platform } = {}): ModelPolicyConfig {
  const configPath = `${resolveStateRoot(opts.env ?? process.env, opts.platform ?? process.platform)}/config.yaml`;
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    if (code === 'ENOENT') return { ...parseModelPolicyConfig('', configPath), exists: false };
    const cause = code === 'EISDIR' ? 'config.yaml is a directory'
      : code === 'EACCES' || code === 'EPERM' ? 'permission denied'
      : code === 'ENOTDIR' ? 'the state root is not a directory'
      : `the read failed (${code})`;
    throw new ModelPolicyError({
      reason: 'config_unreadable',
      problem: `gstack cannot read ${configPath}, so the model policy is unknown and no outside model call will start`,
      cause,
      key: null,
      source: 'config',
      repair: [`fix the permissions or type of ${configPath}`, 'or point GSTACK_HOME at a readable state root'],
      docs: DOCS_CONFIG,
    });
  }
  return parseModelPolicyConfig(text, configPath);
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function truthy(value: unknown): boolean {
  return typeof value === 'string' && TRUTHY.has(value.trim().toLowerCase());
}

function nonDefaultUrl(value: unknown, defaultUrl: string): boolean {
  return typeof value === 'string' && value.trim() !== '' && value.trim().replace(/\/+$/, '') !== defaultUrl;
}

function homeDir(env: StateRootEnv, platform: NodeJS.Platform): string {
  return env.HOME || (platform === 'win32' ? env.USERPROFILE || '' : '') || os.homedir();
}

function unresolved(provider: ModelProvider, key: string, cause: string, repair: string): ModelPolicyError {
  return new ModelPolicyError({
    reason: 'native_provider_unresolved',
    problem: `gstack cannot tell which ${PROVIDER_LABEL[provider]} endpoint your native settings use`,
    cause,
    key,
    source: 'native',
    repair: [repair, 'or name the model explicitly for this request'],
    docs: DOCS_PROVIDER,
  });
}

const CLAUDE_FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const;

export interface NativeSettingsOptions {
  env?: StateRootEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  claudeManagedDir?: string;
  codexSystemConfig?: string | null;
}

export interface CustomProviderDetection {
  custom: boolean;
  signals: string[];
  scanned: string[];
  unscanned: string[];
}

export const CUSTOM_PROVIDER_UNSCANNED: Readonly<Record<ModelProvider, readonly string[]>> = Object.freeze({
  anthropic: Object.freeze(['server-managed settings from the claude.ai console', 'MDM or OS policy (macOS profile, Windows registry)', 'a --settings flag passed to claude']),
  openai: Object.freeze(['project-local Codex config.toml', 'cloud-managed Codex config', '-c, --config or --profile flags passed to codex']),
});

function claudeManagedDir(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

function gitRoots(cwd: string): string[] {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) return [dir];
    if (stat?.isFile()) {
      try {
        const gitDir = path.resolve(dir, fs.readFileSync(dotGit, 'utf-8').replace(/^gitdir:\s*/, '').trim());
        const commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim());
        return path.basename(commonDir) === '.git' ? [dir, path.dirname(commonDir)] : [dir];
      } catch {
        return [dir];
      }
    }
    if (path.dirname(dir) === dir) return [];
  }
}

function claudeSettingsFiles(env: StateRootEnv, platform: NodeJS.Platform, cwd: string, managedDir: string): string[] {
  const files = [
    path.join(env.CLAUDE_CONFIG_DIR || path.join(homeDir(env, platform), '.claude'), 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
    ...gitRoots(cwd).map(root => path.join(root, '.claude', 'settings.local.json')),
    path.join(managedDir, 'managed-settings.json'),
  ];
  const dropIns = path.join(managedDir, 'managed-settings.d');
  try {
    files.push(...fs.readdirSync(dropIns).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort().map(name => path.join(dropIns, name)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw unresolved('anthropic', dropIns, `${dropIns} could not be read`, `fix the permissions of ${dropIns}`);
    }
  }
  return [...new Set(files)];
}

function claudeSettingsEnv(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw unresolved('anthropic', file, `${file} could not be read`, `fix the permissions of ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unresolved('anthropic', file, `${file} is not valid JSON`, `fix the JSON in ${file}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw unresolved('anthropic', file, `${file} does not contain a settings object`, `fix the settings object in ${file}`);
  }
  const block = (parsed as { env?: unknown }).env;
  if (block === undefined) return {};
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    throw unresolved('anthropic', file, `the env block in ${file} is not an object`, `fix the env block in ${file}`);
  }
  for (const name of [...CLAUDE_FLAGS, 'ANTHROPIC_BASE_URL']) {
    const value = (block as Record<string, unknown>)[name];
    if (value !== undefined && typeof value !== 'string') {
      throw unresolved('anthropic', `${file} env.${name}`, `env.${name} in ${file} is not a string`, `fix env.${name} in ${file}`);
    }
  }
  return block as Record<string, unknown>;
}

function claudeSignals(env: StateRootEnv, platform: NodeJS.Platform, cwd: string, managedDir: string): { signals: string[]; scanned: string[] } {
  const sources: Array<[string, Record<string, unknown>]> = [['environment', env]];
  const scanned = ['environment'];
  for (const file of claudeSettingsFiles(env, platform, cwd, managedDir)) {
    scanned.push(file);
    const block = claudeSettingsEnv(file);
    if (block) sources.push([file, block]);
  }
  const signals: string[] = [];
  for (const [origin, values] of sources) {
    for (const flag of CLAUDE_FLAGS) {
      if (truthy(values[flag])) signals.push(`${flag} (${origin})`);
    }
    if (nonDefaultUrl(values.ANTHROPIC_BASE_URL, 'https://api.anthropic.com')) signals.push(`ANTHROPIC_BASE_URL (${origin})`);
  }
  return { signals, scanned };
}

function readToml(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw unresolved('openai', file, `${file} could not be read`, `fix the permissions of ${file}`);
  }
  try {
    return Bun.TOML.parse(raw) as Record<string, unknown>;
  } catch {
    throw unresolved('openai', file, `${file} is not valid TOML`, `fix the TOML in ${file}`);
  }
}

function codexSignals(env: StateRootEnv, platform: NodeJS.Platform, systemConfig: string | null): { signals: string[]; scanned: string[] } {
  const codexHome = env.CODEX_HOME || path.join(homeDir(env, platform), '.codex');
  const signals: string[] = [];
  if (nonDefaultUrl(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')) signals.push('OPENAI_BASE_URL (environment)');
  if (!path.isAbsolute(codexHome)) {
    throw unresolved('openai', 'CODEX_HOME', `CODEX_HOME '${sanitize(codexHome)}' is not an absolute path`, 'set CODEX_HOME to an absolute path');
  }
  const configPath = path.join(codexHome, 'config.toml');
  const scanned = ['environment', configPath, ...(systemConfig ? [systemConfig] : [])];
  const user = readToml(configPath) ?? {};
  const layers: Array<[string, Record<string, unknown>]> = [];
  if (user.profile !== undefined) {
    const profiles = user.profiles as Record<string, unknown> | undefined;
    const selected = typeof user.profile === 'string' && typeof profiles === 'object' && profiles !== null ? profiles[user.profile] : undefined;
    if (typeof selected !== 'object' || selected === null || Array.isArray(selected)) {
      throw unresolved('openai', `${configPath} profile`, `the active profile in ${configPath} is not a defined [profiles.<name>] table`, `define the profile or remove profile from ${configPath}`);
    }
    layers.push([`${configPath} [profiles.${sanitize(user.profile as string)}]`, selected as Record<string, unknown>]);
  }
  layers.push([configPath, user]);
  if (systemConfig) layers.push([systemConfig, readToml(systemConfig) ?? {}]);
  for (const key of ['model_provider', 'openai_base_url']) {
    const winner = layers.find(([, layer]) => layer[key] !== undefined);
    if (!winner) continue;
    const [origin, layer] = winner;
    const value = layer[key];
    if (typeof value !== 'string') {
      throw unresolved('openai', `${origin} ${key}`, `${key} in ${origin} is not a string`, `fix ${key} in ${origin}`);
    }
    if (key === 'model_provider' && value !== 'openai') signals.push(`model_provider "${sanitize(value)}" (${origin})`);
    if (key === 'openai_base_url' && nonDefaultUrl(value, 'https://api.openai.com/v1')) signals.push(`openai_base_url (${origin})`);
  }
  return { signals, scanned };
}

export function detectCustomProvider(provider: ModelProvider, opts: NativeSettingsOptions = {}): CustomProviderDetection {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const { signals, scanned } = provider === 'anthropic'
    ? claudeSignals(env, platform, path.resolve(opts.cwd ?? process.cwd()), opts.claudeManagedDir ?? claudeManagedDir(platform))
    : codexSignals(env, platform, opts.codexSystemConfig !== undefined ? opts.codexSystemConfig : platform === 'win32' ? null : '/etc/codex/config.toml');
  return { custom: signals.length > 0, signals, scanned, unscanned: [...CUSTOM_PROVIDER_UNSCANNED[provider]] };
}

function sourceLabel(provider: ModelProvider, tier: ModelTier, entry: ModelCatalogEntry): string {
  return `gstack catalog ${tier}/${provider} (verified ${entry.verifiedAt})`;
}

function checkedSource(provider: ModelProvider, raw: string, source: SelectedModel['source']): { model: string; source: SelectedModel['source'] } {
  const model = raw.trim();
  if (isValidModelId(provider, model)) return { model, source };
  const repair = source.kind === 'env'
    ? [`unset ${source.name}`, `export ${source.name}=<model-id>`]
    : ['name a valid model ID for this request, or omit it to use the configured policy'];
  throw new ModelPolicyError({
    reason: 'invalid_model_id',
    problem: `the ${provider} model '${sanitize(raw)}' from ${source.label} is not a valid model ID`,
    cause: `use ${modelIdRule(provider)}; ${source.label} outranks gstack's tier settings, so changing a tier will not help`,
    key: source.kind === 'env' ? source.name : 'request',
    source: source.kind,
    repair,
    docs: DOCS_SELECTION,
  });
}

function hostTool(provider: ModelProvider): string {
  return provider === 'anthropic' ? 'Claude Code' : 'Codex';
}

export function resolvePlanReviewModel(opts: {
  provider: ModelProvider;
  requestedModel?: string;
  env?: StateRootEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  claudeManagedDir?: string;
  codexSystemConfig?: string | null;
  config?: ModelPolicyConfig;
}): ModelSelection {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const config = opts.config ?? readModelPolicyConfig({ env, platform });
  const { provider } = opts;
  const tierFrom = config.planReviewTier;
  const tier = tierFrom.value;
  const base = { role: 'plan-review' as const, provider, tier, tierFrom, catalog: tier === 'host' ? null : catalogEntry(provider, tier) };
  if (opts.requestedModel !== undefined) {
    const { model, source } = checkedSource(provider, opts.requestedModel, { kind: 'request', label: 'explicit request' });
    return { ...base, status: 'selected', requestedModel: model, source };
  }
  const envName = PROVIDER_ENV_OVERRIDES[provider];
  const envValue = env[envName];
  if (envValue) {
    const { model, source } = checkedSource(provider, envValue, { kind: 'env', name: envName, label: `${envName} environment variable` });
    return { ...base, status: 'selected', requestedModel: model, source };
  }
  if (tier === 'host') {
    return {
      ...base,
      status: 'delegated-host',
      requestedModel: null,
      source: { kind: 'host', reason: 'host-mode', key: 'plan_review_tier', label: `plan_review_tier=host: ${hostTool(provider)}'s own settings choose the model` },
    };
  }
  const overrideKey = MODEL_OVERRIDE_KEYS[provider][tier];
  const override = config.overrides[provider][tier];
  if (override) {
    return { ...base, status: 'selected', requestedModel: override, source: { kind: 'config', key: overrideKey, path: config.path, label: `${overrideKey} in ${config.path}` } };
  }
  const entry = catalogEntry(provider, tier);
  const custom = detectCustomProvider(provider, { ...opts, env, platform });
  if (custom.custom) {
    throw new ModelPolicyError({
      reason: 'custom_provider_requires_model',
      problem: `no ${tier} plan-review model is set for your custom ${PROVIDER_LABEL[provider]} endpoint`,
      cause: `custom routing is active (${custom.signals.join(', ')}), so gstack will not send the public catalog ID ${entry.model} to it`,
      key: custom.signals[0] ?? null,
      source: 'native',
      repair: [`gstack-config set ${overrideKey} <model-id-your-endpoint-serves>`, `export ${envName}=<model-id-your-endpoint-serves>`, 'gstack-config set plan_review_tier host'],
      docs: DOCS_PROVIDER,
    });
  }
  return {
    ...base,
    status: 'selected',
    requestedModel: entry.model,
    source: { kind: 'catalog', catalogVersion: MODEL_CATALOG_VERSION, verifiedAt: entry.verifiedAt, sourceUrl: entry.sourceUrl, label: sourceLabel(provider, tier, entry) },
  };
}

export function resolveImplementationModels(opts: {
  provider?: ModelProvider;
  host?: ModelHost;
  requestedModel?: string;
  env?: StateRootEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  claudeManagedDir?: string;
  codexSystemConfig?: string | null;
  config?: ModelPolicyConfig;
} = {}): ModelSelection[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const providers: ModelProvider[] = opts.provider ? [opts.provider]
    : opts.host === 'claude-code' ? ['anthropic']
    : opts.host === 'codex' ? ['openai']
    : [...MODEL_PROVIDERS];
  if (opts.requestedModel !== undefined && providers.length !== 1) {
    throw new ModelPolicyError({
      reason: 'provider_required',
      problem: 'an explicit implementation model needs a provider',
      cause: 'the host does not identify one provider, and gstack does not infer a provider from a model name',
      key: 'request',
      source: 'request',
      repair: ['pass the provider (anthropic or openai) with the requested model'],
      docs: DOCS_SELECTION,
    });
  }
  const config = opts.config ?? readModelPolicyConfig({ env, platform });
  const tierFrom = config.implementationTier;
  const tier = tierFrom.value;
  return providers.map((provider): ModelSelection => {
    const entry = catalogEntry(provider, tier);
    const base = { role: 'implementation' as const, provider, tier, tierFrom, catalog: entry };
    if (opts.requestedModel !== undefined) {
      const { model, source } = checkedSource(provider, opts.requestedModel, { kind: 'request', label: 'explicit request' });
      return { ...base, status: 'selected', requestedModel: model, source };
    }
    const overrideKey = MODEL_OVERRIDE_KEYS[provider][tier];
    const override = config.overrides[provider][tier];
    if (override) {
      return { ...base, status: 'selected', requestedModel: override, source: { kind: 'config', key: overrideKey, path: config.path, label: `${overrideKey} in ${config.path}` } };
    }
    const custom = detectCustomProvider(provider, { ...opts, env, platform });
    if (custom.custom) {
      throw new ModelPolicyError({
        reason: 'custom_provider_requires_model',
        problem: `no ${tier} implementation model is set for your custom ${PROVIDER_LABEL[provider]} endpoint`,
        cause: `custom routing is active (${custom.signals.join(', ')}), so gstack will not recommend the public catalog ID ${entry.model} for it`,
        key: custom.signals[0] ?? null,
        source: 'native',
        repair: [`gstack-config set ${overrideKey} <model-id-your-endpoint-serves>`, 'or name the implementation model explicitly for this request'],
        docs: DOCS_PROVIDER,
      });
    }
    return {
      ...base,
      status: 'selected',
      requestedModel: entry.model,
      source: { kind: 'catalog', catalogVersion: MODEL_CATALOG_VERSION, verifiedAt: entry.verifiedAt, sourceUrl: entry.sourceUrl, label: sourceLabel(provider, tier, entry) },
    };
  });
}

export function describeSelection(selection: ModelSelection): string {
  const model = selection.status === 'selected' ? selection.requestedModel : 'host-controlled (unknown until it runs)';
  return `${selection.role} via ${selection.provider}: ${model} [tier ${selection.tier}; from ${selection.source.label}]`;
}

export function selectionRepair(selection: ModelSelection): string[] {
  const { source, provider } = selection;
  if (source.kind === 'request') return ['name a different model for this request, or omit it to use the configured policy'];
  if (source.kind === 'env') return [`unset ${source.name}`, `export ${source.name}=<model-id>`];
  if (source.kind === 'config') return [`gstack-config set ${source.key} <model-id>`, `gstack-config unset ${source.key}`];
  const tierKey = selection.role === 'plan-review' ? 'plan_review_tier' : 'implementation_tier';
  if (source.kind === 'host') {
    const native = provider === 'anthropic' ? 'choose the model in Claude Code settings' : 'set model in ${CODEX_HOME:-~/.codex}/config.toml';
    return [native, `export ${PROVIDER_ENV_OVERRIDES[provider]}=<model-id>`, 'gstack-config unset plan_review_tier'];
  }
  const tier = selection.tier as ModelTier;
  const other = tier === 'frontier' ? 'smart' : 'frontier';
  return [
    `gstack-config set ${MODEL_OVERRIDE_KEYS[provider][tier]} <model-id>`,
    `gstack-config set ${tierKey} ${other}`,
    ...(selection.role === 'plan-review' ? ['gstack-config set plan_review_tier host'] : []),
  ];
}

export function modelPolicyCommands() {
  return {
    useSmart: 'gstack-config set plan_review_tier smart',
    useHost: 'gstack-config set plan_review_tier host',
    restoreDefault: 'gstack-config unset plan_review_tier',
  };
}
