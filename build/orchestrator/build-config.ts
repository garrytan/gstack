import * as fs from "fs";
import * as path from "path";
import type {
  RoleConfigs,
  RoleKey,
  RoleProvider,
  RoleReasoning,
} from "./role-config";

export interface BuildLimits {
  codexMaxIterations: number;
  redSpecMaxIterations: number;
  testMaxIterations: number;
  originVerificationMaxIterations: number;
  /**
   * Default cap on per-feature meta-review cycles (FEATURE_REDO loops).
   * Hitting the cap prompts the user via stdin readline; non-TTY runs
   * fail the feature and write BLOCKED-feature-N.md.
   */
  featureReviewMaxIterations: number;
}

export interface BuildTimeoutsMs {
  gemini: number;
  kimi: number;
  codex: number;
  ship: number;
  test: number;
  judge: number;
  /** Per-invocation timeout for the configurable feature-level reviewer. */
  featureReview: number;
}

export interface BuildDefaults {
  roles: RoleConfigs;
  limits: BuildLimits;
  timeoutsMs: BuildTimeoutsMs;
}

export const DEFAULT_BUILD_CONFIG_FILE = path.join(
  import.meta.dir,
  "..",
  "configure.cm",
);

const ROLE_KEYS: RoleKey[] = [
  "testWriter",
  "primaryImpl",
  "testFixer",
  "secondaryImpl",
  "review",
  "reviewSecondary",
  "qa",
  "ship",
  "land",
  "judge",
  "featureReview",
];

const PROVIDERS: RoleProvider[] = ["claude", "codex", "gemini", "kimi"];
const REASONING: RoleReasoning[] = ["low", "medium", "high", "xhigh"];

export function loadBuildDefaults(
  filePath: string = process.env.GSTACK_BUILD_CONFIG_FILE ||
    process.env.GSTACK_BUILD_DEFAULTS_FILE ||
    DEFAULT_BUILD_CONFIG_FILE,
): BuildDefaults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(
      `failed to load build config from ${filePath}: ${(err as Error).message}`,
    );
  }

  const config = parsed as Partial<BuildDefaults>;
  const roles = validateRoles(
    withMigratedRoles(config.roles, filePath),
    filePath,
  );
  const limits = validateNumberSection(
    withMigratedNumberSection(
      config.limits,
      "limits",
      ["featureReviewMaxIterations"],
      filePath,
    ),
    [
      "codexMaxIterations",
      "redSpecMaxIterations",
      "testMaxIterations",
      "originVerificationMaxIterations",
      "featureReviewMaxIterations",
    ],
    `${filePath}:limits`,
  ) as unknown as BuildLimits;
  const timeoutsMs = validateNumberSection(
    withMigratedNumberSection(
      config.timeoutsMs,
      "timeoutsMs",
      ["kimi", "featureReview"],
      filePath,
    ),
    ["gemini", "kimi", "codex", "ship", "test", "judge", "featureReview"],
    `${filePath}:timeoutsMs`,
  ) as unknown as BuildTimeoutsMs;

  return { roles, limits, timeoutsMs };
}

function withMigratedRoles(value: unknown, filePath: string): unknown {
  if (!value || typeof value !== "object") return value;
  const roles = { ...(value as Record<string, unknown>) };
  // Backfill roles added after a config file was first written so older
  // user-edited configure.cm files do not throw on load. Each new role
  // pulls its definition from the in-tree default config file. Skip when
  // already loading the default file (would recurse) and when the field
  // is already present (user explicitly set it).
  const isLoadingDefault =
    path.resolve(filePath) === path.resolve(DEFAULT_BUILD_CONFIG_FILE);
  delete roles.contextSave;
  if (!roles.featureReview && !isLoadingDefault) {
    roles.featureReview = readDefaultRole("featureReview");
  }
  return roles;
}

function readDefaultRole(key: RoleKey): unknown {
  const parsed = JSON.parse(
    fs.readFileSync(DEFAULT_BUILD_CONFIG_FILE, "utf8"),
  ) as Partial<BuildDefaults>;
  return (parsed.roles as Record<string, unknown> | undefined)?.[key];
}

/**
 * Backfill numeric config keys added after a user's configure.cm was first
 * written. Without this, adding `featureReviewMaxIterations` would throw
 * `must be a positive number` on every existing install. Pulls each missing
 * key's value from the in-tree default config so user files don't need
 * regeneration.
 */
function withMigratedNumberSection(
  value: unknown,
  section: "limits" | "timeoutsMs",
  newKeys: string[],
  filePath: string,
): unknown {
  if (!value || typeof value !== "object") return value;
  const isLoadingDefault =
    path.resolve(filePath) === path.resolve(DEFAULT_BUILD_CONFIG_FILE);
  if (isLoadingDefault) return value;
  const out = { ...(value as Record<string, unknown>) };
  let defaults: Record<string, unknown> | undefined;
  for (const key of newKeys) {
    if (out[key] === undefined) {
      if (!defaults) {
        const parsed = JSON.parse(
          fs.readFileSync(DEFAULT_BUILD_CONFIG_FILE, "utf8"),
        ) as Partial<BuildDefaults>;
        defaults =
          ((parsed as unknown as Record<string, unknown>)[section] as Record<
            string,
            unknown
          >) ?? {};
      }
      const fallback = defaults[key];
      if (fallback !== undefined) out[key] = fallback;
    }
  }
  return out;
}

function validateRoles(value: unknown, filePath: string): RoleConfigs {
  if (!value || typeof value !== "object") {
    throw new Error(`${filePath}:roles must be an object`);
  }
  const roles = value as Record<string, any>;
  for (const key of ROLE_KEYS) {
    const role = roles[key];
    if (!role || typeof role !== "object") {
      throw new Error(`${filePath}:roles.${key} must be an object`);
    }
    if (!PROVIDERS.includes(role.provider)) {
      throw new Error(
        `${filePath}:roles.${key}.provider must be one of: ${PROVIDERS.join(", ")}`,
      );
    }
    if (typeof role.model !== "string" || role.model.trim() === "") {
      throw new Error(
        `${filePath}:roles.${key}.model must be a non-empty string`,
      );
    }
    if (!REASONING.includes(role.reasoning)) {
      throw new Error(
        `${filePath}:roles.${key}.reasoning must be one of: ${REASONING.join(", ")}`,
      );
    }
    if (role.command != null && typeof role.command !== "string") {
      throw new Error(
        `${filePath}:roles.${key}.command must be a string when present`,
      );
    }
  }
  return roles as RoleConfigs;
}

function validateNumberSection(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, number> {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const section = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of keys) {
    const n = section[key];
    if (!Number.isFinite(n) || (n as number) <= 0) {
      throw new Error(`${label}.${key} must be a positive number`);
    }
    out[key] = n as number;
  }
  return out;
}

export const BUILD_DEFAULTS = loadBuildDefaults();

export function envNumberOrDefault(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
