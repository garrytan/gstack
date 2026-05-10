import { BUILD_DEFAULTS } from "./build-config";

export type RoleProvider = "claude" | "codex" | "gemini" | "kimi";
export type RoleReasoning = "low" | "medium" | "high" | "xhigh";

export interface RoleConfig {
  provider: RoleProvider;
  model: string;
  reasoning: RoleReasoning;
  command?: string;
  backupProvider?: RoleProvider;
  backupModel?: string;
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
  /**
   * Configurable post-implementation reviewer that fires once all phases
   * of a feature commit. Default comes from build/configure.cm — see /build skill
   * docs for the FEATURE_PASS / FEATURE_NEEDS_PHASES / FEATURE_REDO
   * verdict contract.
   */
  featureReview: RoleConfig;
  /**
   * Advisory supervisor for `gstack-build monitor --supervise`. The
   * deterministic monitor still owns run identity/recovery; this role only
   * diagnoses blocking monitor events and returns structured escalation JSON.
   */
  monitorAgent: RoleConfig;
  /**
   * Second-opinion reviewer that runs at gstack-build startup, before Phase 1
   * of Feature 1. Returns APPROVE/REVISE verdict; CRITICAL objections trigger
   * exit 3 and SKILL.md re-synthesis loop.
   */
  planReviewer: RoleConfig;
}

export const ROLE_DEFINITIONS = [
  ["testWriter", "test-writer", "GSTACK_BUILD_TEST_WRITER"],
  ["primaryImpl", "primary-impl", "GSTACK_BUILD_PRIMARY_IMPL"],
  ["testFixer", "test-fixer", "GSTACK_BUILD_TEST_FIXER"],
  ["secondaryImpl", "secondary-impl", "GSTACK_BUILD_SECONDARY_IMPL"],
  ["review", "review", "GSTACK_BUILD_REVIEW"],
  ["reviewSecondary", "review-secondary", "GSTACK_BUILD_REVIEW_SECONDARY"],
  ["qa", "qa", "GSTACK_BUILD_QA"],
  ["ship", "ship", "GSTACK_BUILD_SHIP"],
  ["land", "land", "GSTACK_BUILD_LAND"],
  ["judge", "judge", "GSTACK_BUILD_JUDGE"],
  ["featureReview", "feature-review", "GSTACK_BUILD_FEATURE_REVIEW"],
  ["monitorAgent", "monitor-agent", "GSTACK_BUILD_MONITOR_AGENT"],
  ["planReviewer", "plan-reviewer", "GSTACK_BUILD_PLANREVIEWER"],
] as const satisfies readonly [keyof RoleConfigs, string, string][];

export type RoleKey = (typeof ROLE_DEFINITIONS)[number][0];
export type RoleField =
  | "provider"
  | "model"
  | "reasoning"
  | "command"
  | "backupProvider"
  | "backupModel";

export const DEFAULT_ROLE_CONFIGS: RoleConfigs = BUILD_DEFAULTS.roles;

export function cloneRoleConfigs(
  base: Partial<RoleConfigs> = DEFAULT_ROLE_CONFIGS,
): RoleConfigs {
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
    const backupProvider = env[`${prefix}_BACKUP_PROVIDER`];
    const backupModel = env[`${prefix}_BACKUP_MODEL`];
    if (provider)
      next[key].provider = parseProvider(provider, `${prefix}_PROVIDER`);
    if (model) next[key].model = model;
    if (reasoning)
      next[key].reasoning = parseReasoning(reasoning, `${prefix}_REASONING`);
    if (command) next[key].command = command;
    if (backupProvider)
      next[key].backupProvider = parseProvider(
        backupProvider,
        `${prefix}_BACKUP_PROVIDER`,
      );
    if (backupModel) next[key].backupModel = backupModel;
  }
  return next;
}

export function applyRoleOverride(
  roles: RoleConfigs,
  role: RoleKey,
  field: RoleField,
  value: string,
): void {
  if (field === "provider")
    roles[role].provider = parseProvider(value, `${role}.provider`);
  else if (field === "reasoning")
    roles[role].reasoning = parseReasoning(value, `${role}.reasoning`);
  else if (field === "model") roles[role].model = value;
  else if (field === "backupProvider")
    roles[role].backupProvider = parseProvider(value, `${role}.backupProvider`);
  else if (field === "backupModel") roles[role].backupModel = value;
  else if (field === "command") roles[role].command = value;
  else {
    // TypeScript narrows field to never here — adding a new RoleField without
    // a handler above produces a compile error, preventing silent catch-all corruption.
    const _: never = field;
    throw new Error(`Unknown role field: ${_}`);
  }
}

export function parseProvider(value: string, label: string): RoleProvider {
  if (
    value === "claude" ||
    value === "codex" ||
    value === "gemini" ||
    value === "kimi"
  )
    return value;
  throw new Error(`${label} must be one of: claude, codex, gemini, kimi`);
}

export function parseReasoning(value: string, label: string): RoleReasoning {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  )
    return value;
  throw new Error(`${label} must be one of: low, medium, high, xhigh`);
}

export function roleLabel(role: RoleConfig): string {
  const command = role.command ? ` ${role.command}` : "";
  return `${role.provider}:${role.model}:${role.reasoning}${command}`;
}

export function migrateLegacyModels(state: {
  roleConfigs?: RoleConfigs;
  geminiModel?: string;
  codexModel?: string;
  codexReviewModel?: string;
}): RoleConfigs {
  const roles = cloneRoleConfigs(state.roleConfigs ?? DEFAULT_ROLE_CONFIGS);
  if (!state.roleConfigs) {
    if (state.geminiModel) roles.primaryImpl.model = state.geminiModel;
    if (state.codexModel) roles.secondaryImpl.model = state.codexModel;
    if (state.codexReviewModel)
      roles.reviewSecondary.model = state.codexReviewModel;
  }
  return roles;
}
