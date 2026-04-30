import { BUILD_DEFAULTS } from './build-config';

export type RoleProvider = 'claude' | 'codex' | 'gemini';
export type RoleReasoning = 'low' | 'medium' | 'high' | 'xhigh';

export interface RoleConfig {
  provider: RoleProvider;
  model: string;
  reasoning: RoleReasoning;
  command?: string;
}

export interface RoleConfigs {
  testWriter: RoleConfig;
  primaryImpl: RoleConfig;
  testFixer: RoleConfig;
  secondaryImpl: RoleConfig;
  review: RoleConfig;
  reviewSecondary: RoleConfig;
  qa: RoleConfig;
  ship: RoleConfig;
  land: RoleConfig;
  judge: RoleConfig;
  contextSave: RoleConfig;
}

export const ROLE_DEFINITIONS = [
  ['testWriter', 'test-writer', 'GSTACK_BUILD_TEST_WRITER'],
  ['primaryImpl', 'primary-impl', 'GSTACK_BUILD_PRIMARY_IMPL'],
  ['testFixer', 'test-fixer', 'GSTACK_BUILD_TEST_FIXER'],
  ['secondaryImpl', 'secondary-impl', 'GSTACK_BUILD_SECONDARY_IMPL'],
  ['review', 'review', 'GSTACK_BUILD_REVIEW'],
  ['reviewSecondary', 'review-secondary', 'GSTACK_BUILD_REVIEW_SECONDARY'],
  ['qa', 'qa', 'GSTACK_BUILD_QA'],
  ['ship', 'ship', 'GSTACK_BUILD_SHIP'],
  ['land', 'land', 'GSTACK_BUILD_LAND'],
  ['judge', 'judge', 'GSTACK_BUILD_JUDGE'],
  ['contextSave', 'context-save', 'GSTACK_BUILD_CONTEXT_SAVE'],
] as const satisfies readonly [keyof RoleConfigs, string, string][];

export type RoleKey = (typeof ROLE_DEFINITIONS)[number][0];
export type RoleField = 'provider' | 'model' | 'reasoning' | 'command';

export const DEFAULT_ROLE_CONFIGS: RoleConfigs = BUILD_DEFAULTS.roles;

export function cloneRoleConfigs(base: Partial<RoleConfigs> = DEFAULT_ROLE_CONFIGS): RoleConfigs {
  const next = JSON.parse(JSON.stringify(DEFAULT_ROLE_CONFIGS)) as RoleConfigs;
  for (const [key] of ROLE_DEFINITIONS) {
    const role = base[key];
    if (role) next[key] = { ...next[key], ...role };
  }
  return next;
}

export function applyEnvRoleConfig(
  roles: RoleConfigs,
  env: Record<string, string | undefined> = process.env,
): RoleConfigs {
  const next = cloneRoleConfigs(roles);
  for (const [key, , prefix] of ROLE_DEFINITIONS) {
    const provider = env[`${prefix}_PROVIDER`];
    const model = env[`${prefix}_MODEL`];
    const reasoning = env[`${prefix}_REASONING`];
    const command = env[`${prefix}_COMMAND`];
    if (provider) next[key].provider = parseProvider(provider, `${prefix}_PROVIDER`);
    if (model) next[key].model = model;
    if (reasoning) next[key].reasoning = parseReasoning(reasoning, `${prefix}_REASONING`);
    if (command) next[key].command = command;
  }
  return next;
}

export function applyRoleOverride(
  roles: RoleConfigs,
  role: RoleKey,
  field: RoleField,
  value: string,
): void {
  if (field === 'provider') roles[role].provider = parseProvider(value, `${role}.provider`);
  else if (field === 'reasoning') roles[role].reasoning = parseReasoning(value, `${role}.reasoning`);
  else if (field === 'model') roles[role].model = value;
  else roles[role].command = value;
}

export function parseProvider(value: string, label: string): RoleProvider {
  if (value === 'claude' || value === 'codex' || value === 'gemini') return value;
  throw new Error(`${label} must be one of: claude, codex, gemini`);
}

export function parseReasoning(value: string, label: string): RoleReasoning {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value;
  throw new Error(`${label} must be one of: low, medium, high, xhigh`);
}

export function roleLabel(role: RoleConfig): string {
  const command = role.command ? ` ${role.command}` : '';
  return `${role.provider}:${role.model}:${role.reasoning}${command}`;
}

export function migrateLegacyModels(
  state: { roleConfigs?: RoleConfigs; geminiModel?: string; codexModel?: string; codexReviewModel?: string },
): RoleConfigs {
  const roles = cloneRoleConfigs(state.roleConfigs ?? DEFAULT_ROLE_CONFIGS);
  if (!state.roleConfigs) {
    if (state.geminiModel) roles.primaryImpl.model = state.geminiModel;
    if (state.codexModel) roles.secondaryImpl.model = state.codexModel;
    if (state.codexReviewModel) roles.reviewSecondary.model = state.codexReviewModel;
  }
  return roles;
}
