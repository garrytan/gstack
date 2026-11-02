import * as path from 'node:path';
import { CODEX_EFFORT_LEVELS, MODEL_CATALOG, MODEL_CATALOG_VERSION, MODEL_PROVIDERS, MODEL_TIERS, modelCatalogSha256, type ModelProvider } from './model-catalog';
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
import { readConfigKey, type StateRootEnv } from './state-root';
import { AgentModelError, renderAgentModel, resolveAgentModel, type AgentModelSelection } from './agent-model';

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
  gstack-models resolve --role eval-arms [--provider anthropic|openai] [--json]
  gstack-models resolve --role agent [--request <model>] [--json]
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
  eval-arms       The arms /eval-plan compares: the implementation-tier model of
                  each provider under the same precedence (plan E1). Pricing per
                  arm comes from lib/pricing.ts via gstack-eval-plan arms.
  agent           The model you want gstack's working agents (lanes, subagents,
                  reviewers) to run on: your preference, not a gstack policy.
                  Precedence: --request (one job, never saved), then agent_model
                  in config.yaml (this machine), then agent_model in the file
                  GSTACK_PREFERENCES_FILE names (on Capy, preferences.yaml in
                  the gstack skill folder), then host (keep the agent's own
                  model). Values: host, a family (opus, fable, sonnet, haiku,
                  astra, sol, luna, terra) or <provider>/<model>. A cross-family
                  outside voice and a model under test in an eval ignore it.

Settings (gstack-config set|unset <key>):
  plan_review_tier       frontier | smart | host   (default frontier)
  implementation_tier    frontier | smart          (default smart)
  model_frontier_claude, model_frontier_openai,
  model_smart_claude, model_smart_openai           (default: shipped catalog ID)
  codex_effort           ${CODEX_EFFORT_LEVELS.join(' | ')}
                         (default: each gate's own effort)

Codex reasoning effort: /codex --effort <level> (one request), then
GSTACK_CODEX_EFFORT (per run), then codex_effort, then the gate's default (high
for reviews, medium for /codex consult and design direction). /spec keeps medium
inside its 120 s budget.

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

/** The effective Codex effort override, same precedence as gstack-codex-probe check-effort; null = each gate's default. */
export function codexEffortSetting(env: StateRootEnv): { value: string | null; source: 'env' | 'config' | 'gate-default'; valid: boolean } {
  const pick = (value: string, source: 'env' | 'config') => ({ value, source, valid: (CODEX_EFFORT_LEVELS as readonly string[]).includes(value) });
  if (env.GSTACK_CODEX_EFFORT) return pick(env.GSTACK_CODEX_EFFORT, 'env');
  const stored = readConfigKey('codex_effort', env);
  return stored ? pick(stored, 'config') : { value: null, source: 'gate-default', valid: true };
}

function document(command: 'list' | 'resolve' | null, config: ModelPolicyConfig | null, selections: ModelSelection[], errors: CliError[], env: StateRootEnv = {}) {
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
    codexEffort: config ? codexEffortSetting(env) : null,
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

function renderList(config: ModelPolicyConfig, selections: ModelSelection[], env: StateRootEnv, platform: NodeJS.Platform): string {
  const effort = codexEffortSetting(env);
  const commands = modelPolicyCommands();
  const configCommand = `'${CONFIG_BIN.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
  const lines = [
    `gstack model policy (${OFFLINE_NOTE})`,
    `config: ${config.path}${config.exists ? '' : ' (not created yet; defaults apply)'}`,
    '',
    ...renderSelections('plan-review', config, selections),
    ...renderSelections('implementation', config, selections),
    '',
    `codex effort: ${effort.value ?? 'each gate\'s default'} (${effort.source === 'env' ? 'GSTACK_CODEX_EFFORT' : effort.source === 'config' ? `codex_effort in ${config.path}` : 'default; set codex_effort'})${effort.valid ? '' : ` - invalid; Codex calls stop before sending. Use ${CODEX_EFFORT_LEVELS.join(', ')}`}; /spec keeps medium`,
    '',
    ...agentLines(env, platform),
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

function renderEvalArms(config: ModelPolicyConfig, selections: ModelSelection[]): string {
  const choice = config.implementationTier;
  const lines = [`eval-arms: tier ${choice.value} (${choice.origin === 'config' ? `${choice.key} in ${choice.path}` : `default; set ${choice.key}`}) - one arm per provider; price them with gstack-eval-plan arms`];
  for (const s of selections) lines.push(`  ${s.provider}: ${s.requestedModel ?? 'host-controlled'}`);
  lines.push(`(${OFFLINE_NOTE})`);
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

function agentOrError(env: StateRootEnv, platform?: NodeJS.Platform, request?: string): AgentModelSelection | { error: ReturnType<AgentModelError['toJSON']> } {
  try {
    return resolveAgentModel({ env, platform, request });
  } catch (error) {
    if (!(error instanceof AgentModelError)) throw error;
    return { error: error.toJSON() };
  }
}

function renderAgentError(error: ReturnType<AgentModelError['toJSON']>): string[] {
  return [`agent: ${error.problem}`, `  cause: ${error.cause}`, ...error.repair.map(step => `  fix: ${step}`), `  docs: ${error.docs}`];
}

/** The agent block of `list`: a bad agent_model is reported here and never fails the other roles. */
function agentLines(env: StateRootEnv, platform: NodeJS.Platform): string[] {
  const agent = agentOrError(env, platform);
  return 'error' in agent ? renderAgentError(agent.error) : renderAgentModel(agent);
}

function agentResult(env: StateRootEnv, platform: NodeJS.Platform, request: string | undefined, json: boolean): ModelsCliResult {
  const agent = agentOrError(env, platform, request);
  if ('error' in agent) {
    return json
      ? { code: 1, stdout: `${JSON.stringify({ schemaVersion: 1, command: 'resolve', ok: false, offline: true, note: OFFLINE_NOTE, agent: null, errors: [agent.error] }, null, 2)}\n`, stderr: '' }
      : { code: 1, stdout: '', stderr: renderAgentError(agent.error).map(l => `gstack-models: ${l.trimStart()}`).join('\n') + '\n' };
  }
  return json
    ? { code: 0, stdout: `${JSON.stringify({ schemaVersion: 1, command: 'resolve', ok: true, offline: true, note: OFFLINE_NOTE, agent, errors: [] }, null, 2)}\n`, stderr: '' }
    : { code: 0, stdout: [...renderAgentModel(agent), `(${OFFLINE_NOTE})`].join('\n') + '\n', stderr: '' };
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
    if (command === 'list' || (name !== '--role' && name !== '--provider' && name !== '--request')) return usage(`unknown argument '${arg}' for ${command}`, json);
    if (options[name] !== undefined) return usage(`${name} given twice`, json);
    const value = inline ?? rest.shift();
    if (value === undefined || value === '' || value.startsWith('--')) return usage(`${name} needs a value`, json);
    options[name] = value;
  }
  const role = options['--role'];
  const providerArg = options['--provider'];
  const provider = parseProvider(providerArg);
  if (command === 'resolve') {
    if (role !== 'plan-review' && role !== 'implementation' && role !== 'eval-arms' && role !== 'agent') return usage(role === undefined ? 'resolve needs --role plan-review|implementation|eval-arms|agent' : `unknown role '${role}': use plan-review, implementation, eval-arms or agent`, json);
    if (role === 'agent') {
      if (providerArg !== undefined) return usage('resolve --role agent takes no --provider; the preference names its provider', json);
      return agentResult(env, platform, options['--request'], json);
    }
    if (options['--request'] !== undefined) return usage('--request applies only to --role agent', json);
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
  const roles: ModelRole[] = command === 'list' ? ['plan-review', 'implementation'] : [role === 'eval-arms' ? 'implementation' : role as ModelRole];
  for (const r of roles) {
    for (const p of provider ? [provider] : MODEL_PROVIDERS) {
      attempt(r, p, () => r === 'plan-review'
        ? [resolvePlanReviewModel({ provider: p, env, platform, cwd, config })]
        : resolveImplementationModels({ provider: p, env, platform, cwd, config }), selections, errors);
    }
  }
  // eval-arms (plan E1): the implementation-tier resolution of each provider, one arm each.
  if (role === 'eval-arms') for (const s of selections) (s as { role: string }).role = 'eval-arms';
  const code = errors.length ? 1 : 0;
  if (json) {
    const doc = document(command, config, selections, errors, env);
    return { code, stdout: `${JSON.stringify(command === 'list' ? { ...doc, agent: agentOrError(env, platform) } : doc, null, 2)}\n`, stderr: '' };
  }
  const stdout = command === 'list' ? renderList(config, selections, env, platform) : role === 'eval-arms' ? renderEvalArms(config, selections) : renderResolve(role as ModelRole, config, selections);
  return { code, stdout, stderr: errors.map(renderError).join('') };
}
