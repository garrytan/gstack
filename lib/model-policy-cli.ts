import * as path from 'node:path';
import { MODEL_CATALOG, MODEL_CATALOG_VERSION, MODEL_PROVIDERS, MODEL_TIERS, modelCatalogSha256, type ModelProvider } from './model-catalog';
import {
  CUSTOM_PROVIDER_UNSCANNED,
  describeSelection,
  MODEL_OVERRIDE_KEYS,
  ModelPolicyError,
  modelPolicyCommands,
  readModelPolicyConfig,
  resolveImplementationModels,
  resolvePlanReviewModel,
  type ModelPolicyConfig,
  type ModelPolicyErrorJson,
  type ModelRole,
  type ModelSelection,
} from './model-policy';
import type { StateRootEnv } from './state-root';

export interface ModelsCliResult {
  code: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

type CliError = (ModelPolicyErrorJson | { reason: 'usage'; problem: string; cause: string; key: null; source: null; repair: string[]; docs: string }) & { role?: ModelRole; provider?: ModelProvider };

const OFFLINE_NOTE = 'offline: no network, no paid model call and no writes; this does not prove account entitlement, CLI availability or current vendor status';
const DOCS = 'https://github.com/garrytan/gstack/blob/main/docs/model-policy.md';
const CONFIG_BIN = path.join(import.meta.dir, '..', 'bin', 'gstack-config');

export const MODELS_HELP = `Usage:
  gstack-models [list] [--json]
  gstack-models resolve --role plan-review --provider anthropic|openai [--json]
  gstack-models resolve --role implementation [--provider anthropic|openai] [--json]
  gstack-models --help

Shows which model each gstack role uses and why. It reads config.yaml, the
GSTACK_CLAUDE_MODEL / GSTACK_CODEX_MODEL environment variables and native
provider settings, then exits. It is offline: no network, no paid model call,
no writes. A resolved model is not proof that your account can use it, that
the CLI is installed, or that the vendor still offers it.

Roles:
  plan-review     The opposing-provider reviewer for plan reviews. Default tier
                  frontier. Precedence: explicit request, then
                  GSTACK_CLAUDE_MODEL (anthropic) or GSTACK_CODEX_MODEL (openai),
                  then model_<tier>_<claude|openai>, then the shipped catalog.
                  plan_review_tier=host delegates to the host CLI's own settings:
                  the model is host-controlled and unknown until the review runs.
  implementation  The model gstack recommends for implementing an approved plan.
                  Default tier smart. Precedence: explicit request, then
                  model_<tier>_<claude|openai>, then the shipped catalog.
                  Environment overrides do not apply. Without --provider both
                  provider recommendations are shown. gstack never switches your
                  session's model.

Settings (gstack-config set|unset <key>):
  plan_review_tier       frontier | smart | host   (default frontier)
  implementation_tier    frontier | smart          (default smart)
  model_frontier_claude, model_frontier_openai,
  model_smart_claude, model_smart_openai           (default: shipped catalog ID)

A detected custom Anthropic or OpenAI endpoint (Bedrock, Vertex, Foundry, a base-URL
override or a Codex model_provider) never receives a shipped public ID: set a
per-tier model, an environment override (plan-review only) or host mode.
Detection reads the environment, the env block of Claude's user, project
(.claude/settings.json, .claude/settings.local.json in the working directory
and repository root) and managed settings files, and Codex's user and system
config.toml. Project-local Codex config is not inspected.
It cannot see server-managed or MDM policy, claude --settings, or
codex -c/--profile flags: if you route those to a custom endpoint, set a
per-tier model or host mode.

Output: --json prints one JSON document (schemaVersion 1) with a selections
array and structured errors. Human diagnostics go to stderr.
Exit: 0 valid resolution (including host delegation), 1 config or selection
failure, 2 invalid usage.
Docs: ${DOCS}
`;

function usage(problem: string, json: boolean): ModelsCliResult {
  const error: CliError = { reason: 'usage', problem, cause: 'see gstack-models --help', key: null, source: null, repair: ['gstack-models --help'], docs: DOCS };
  if (json) return { code: 2, stdout: `${JSON.stringify(document(null, null, [], [error]), null, 2)}\n`, stderr: '' };
  return { code: 2, stdout: '', stderr: `gstack-models: ${problem}\n${MODELS_HELP.split('\n\n')[0]}\n` };
}

function parseProvider(value: string | undefined): ModelProvider | null {
  return value === 'anthropic' || value === 'openai' ? value : null;
}

function document(command: 'list' | 'resolve' | null, config: ModelPolicyConfig | null, selections: ModelSelection[], errors: CliError[]) {
  return {
    schemaVersion: 1,
    command,
    ok: errors.length === 0,
    offline: true,
    note: OFFLINE_NOTE,
    configPath: config?.path ?? null,
    catalog: { version: MODEL_CATALOG_VERSION, sha256: modelCatalogSha256(), entries: MODEL_CATALOG },
    settings: config ? settingsOf(config) : null,
    tiers: config ? tiersOf(config) : null,
    providerDetection: { scope: 'declared local settings files and environment only', unscanned: CUSTOM_PROVIDER_UNSCANNED },
    selections,
    errors,
  };
}

function settingsOf(config: ModelPolicyConfig) {
  const settings: Record<string, { value: string | null; effective: string; origin: 'config' | 'default' }> = {
    plan_review_tier: { value: config.planReviewTier.origin === 'config' ? config.planReviewTier.value : null, effective: config.planReviewTier.value, origin: config.planReviewTier.origin },
    implementation_tier: { value: config.implementationTier.origin === 'config' ? config.implementationTier.value : null, effective: config.implementationTier.value, origin: config.implementationTier.origin },
  };
  for (const entry of MODEL_CATALOG) {
    const override = config.overrides[entry.provider][entry.tier];
    settings[MODEL_OVERRIDE_KEYS[entry.provider][entry.tier]] = { value: override, effective: override ?? entry.model, origin: override ? 'config' : 'default' };
  }
  return settings;
}

function tiersOf(config: ModelPolicyConfig) {
  return MODEL_CATALOG.map(entry => ({
    tier: entry.tier,
    provider: entry.provider,
    catalogModel: entry.model,
    verifiedAt: entry.verifiedAt,
    sourceUrl: entry.sourceUrl,
    overrideKey: MODEL_OVERRIDE_KEYS[entry.provider][entry.tier],
    override: config.overrides[entry.provider][entry.tier],
    configuredModel: config.overrides[entry.provider][entry.tier] ?? entry.model,
  }));
}

function attempt(role: ModelRole, provider: ModelProvider, run: () => ModelSelection[], selections: ModelSelection[], errors: CliError[]): void {
  try {
    selections.push(...run());
  } catch (error) {
    if (!(error instanceof ModelPolicyError)) throw error;
    errors.push({ ...error.toJSON(), role, provider });
  }
}

function renderError(error: CliError): string {
  const scope = error.role ? ` (${error.role}${error.provider ? ` via ${error.provider}` : ''})` : '';
  return [
    `gstack-models: ${error.problem}${scope}`,
    `  cause: ${error.cause}`,
    ...(error.key ? [`  source: ${error.key}`] : []),
    ...error.repair.map(step => `  fix: ${step}`),
    `  docs: ${error.docs}`,
  ].join('\n') + '\n';
}

function renderSelections(role: ModelRole, config: ModelPolicyConfig, selections: ModelSelection[]): string[] {
  const choice = role === 'plan-review' ? config.planReviewTier : config.implementationTier;
  const purpose = role === 'plan-review' ? 'opposing-provider plan evaluation' : 'recommendation only; gstack never switches your session';
  const lines = [`${role}: tier ${choice.value} (${choice.origin === 'config' ? `${choice.key} in ${choice.path}` : `default; set ${choice.key}`}) - ${purpose}`];
  for (const selection of selections.filter(s => s.role === role)) {
    lines.push(`  ${describeSelection(selection)}`);
  }
  return lines;
}

function renderList(config: ModelPolicyConfig, selections: ModelSelection[]): string {
  const commands = modelPolicyCommands();
  const configCommand = `'${CONFIG_BIN.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
  const lines = [
    `gstack model policy (${OFFLINE_NOTE})`,
    `config: ${config.path}${config.exists ? '' : ' (not created yet; defaults apply)'}`,
    '',
    ...renderSelections('plan-review', config, selections),
    ...renderSelections('implementation', config, selections),
    '',
    `catalog v${MODEL_CATALOG_VERSION} (sha256 ${modelCatalogSha256().slice(0, 12)})`,
  ];
  for (const tier of MODEL_TIERS) {
    for (const provider of MODEL_PROVIDERS) {
      const entry = MODEL_CATALOG.find(e => e.tier === tier && e.provider === provider)!;
      const override = config.overrides[provider][tier];
      lines.push(`  ${tier.padEnd(8)} ${provider.padEnd(9)} ${entry.model.padEnd(18)} verified ${entry.verifiedAt}  ${MODEL_OVERRIDE_KEYS[provider][tier]}: ${override ?? 'unset'}`);
      lines.push(`    ${configCommand} set ${MODEL_OVERRIDE_KEYS[provider][tier]} '${override ?? entry.model}'`);
      lines.push(`    ${configCommand} unset ${MODEL_OVERRIDE_KEYS[provider][tier]}`);
    }
  }
  lines.push(
    '',
    'change (gstack-config is ' + CONFIG_BIN + '):',
    `  ${commands.useSmart}`,
    `  ${commands.useHost}`,
    `  ${commands.restoreDefault}`,
    'environment overrides GSTACK_CLAUDE_MODEL / GSTACK_CODEX_MODEL outrank plan-review tier settings',
    'custom-endpoint detection reads local settings files only; server-managed/MDM policy and CLI flags are not visible (see --help)',
  );
  return lines.join('\n') + '\n';
}

function renderResolve(role: ModelRole, config: ModelPolicyConfig, selections: ModelSelection[]): string {
  const lines = renderSelections(role, config, selections);
  if (selections.some(s => s.status === 'delegated-host')) {
    lines.push('  host-controlled: gstack passes no model; the actual model is reported after the review runs');
  }
  lines.push(`(${OFFLINE_NOTE})`);
  return lines.join('\n') + '\n';
}

export function modelsMain(args: string[], env: StateRootEnv = process.env, platform: NodeJS.Platform = process.platform, cwd: string = process.cwd()): ModelsCliResult {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) return { code: 0, stdout: MODELS_HELP, stderr: '' };
  const rest = [...args];
  const command = rest[0] === undefined || rest[0].startsWith('--') ? 'list' : rest.shift()!;
  if (command !== 'list' && command !== 'resolve') return usage(`unknown command '${command}'`, json);
  const options: Record<string, string> = {};
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === '--json') continue;
    const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (command === 'list' || (name !== '--role' && name !== '--provider')) return usage(`unknown argument '${arg}' for ${command}`, json);
    if (options[name] !== undefined) return usage(`${name} given twice`, json);
    const value = inline ?? rest.shift();
    if (value === undefined || value === '' || value.startsWith('--')) return usage(`${name} needs a value`, json);
    options[name] = value;
  }
  const role = options['--role'];
  const providerArg = options['--provider'];
  const provider = parseProvider(providerArg);
  if (command === 'resolve') {
    if (role !== 'plan-review' && role !== 'implementation') return usage(role === undefined ? 'resolve needs --role plan-review|implementation' : `unknown role '${role}': use plan-review or implementation`, json);
    if (providerArg !== undefined && !provider) return usage(`unknown provider '${providerArg}': use anthropic or openai`, json);
    if (role === 'plan-review' && !provider) return usage('resolve --role plan-review needs --provider anthropic|openai (the opposing provider for your host)', json);
  }

  let config: ModelPolicyConfig;
  try {
    config = readModelPolicyConfig({ env, platform });
  } catch (error) {
    if (!(error instanceof ModelPolicyError)) throw error;
    const errors: CliError[] = [error.toJSON()];
    return json
      ? { code: 1, stdout: `${JSON.stringify(document(command, null, [], errors), null, 2)}\n`, stderr: '' }
      : { code: 1, stdout: '', stderr: errors.map(renderError).join('') };
  }

  const selections: ModelSelection[] = [];
  const errors: CliError[] = [];
  const roles: ModelRole[] = command === 'list' ? ['plan-review', 'implementation'] : [role as ModelRole];
  for (const r of roles) {
    for (const p of provider ? [provider] : MODEL_PROVIDERS) {
      attempt(r, p, () => r === 'plan-review'
        ? [resolvePlanReviewModel({ provider: p, env, platform, cwd, config })]
        : resolveImplementationModels({ provider: p, env, platform, cwd, config }), selections, errors);
    }
  }
  const code = errors.length ? 1 : 0;
  if (json) return { code, stdout: `${JSON.stringify(document(command, config, selections, errors), null, 2)}\n`, stderr: '' };
  const stdout = command === 'list' ? renderList(config, selections) : renderResolve(role as ModelRole, config, selections);
  return { code, stdout, stderr: errors.map(renderError).join('') };
}
