import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ROLE_CONFIGS,
  ROLE_DEFINITIONS,
  applyEnvRoleConfig,
  cloneRoleConfigs,
  migrateLegacyModels,
  parseProvider,
} from "../role-config";
import {
  BUILD_DEFAULTS,
  DEFAULT_BUILD_CONFIG_FILE,
  loadBuildDefaults,
} from "../build-config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("role config defaults", () => {
  it("loads defaults from the tracked build config file", () => {
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    expect(path.basename(DEFAULT_BUILD_CONFIG_FILE)).toBe("configure.cm");
    expect(loaded.roles.primaryImpl.model).toBeTruthy();
    expect(loaded.limits.codexMaxIterations).toBe(5);
    expect(loaded.timeoutsMs.gemini).toBe(1200000);
    expect(loaded.timeoutsMs.kimi).toBe(1200000);
    expect(BUILD_DEFAULTS.roles.primaryImpl.model).toBe(
      loaded.roles.primaryImpl.model,
    );
  });

  it("uses the tracked build config as the default routing source of truth", () => {
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    expect(DEFAULT_ROLE_CONFIGS).toEqual(BUILD_DEFAULTS.roles);
    expect(DEFAULT_ROLE_CONFIGS).toEqual(loaded.roles);
    for (const role of Object.values(DEFAULT_ROLE_CONFIGS)) {
      expect(role.model.trim()).not.toBe("");
    }
  });

  it("loads template-only plan location from configure.cm", () => {
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    const planLocator = (loaded.roles as any).planLocator;
    expect(planLocator).toBeDefined();
    expect(parseProvider(planLocator.provider, "planLocator.provider")).toBe(
      planLocator.provider,
    );
    expect(planLocator.model.trim()).not.toBe("");
  });

  it("includes the configured featureReview role", () => {
    // The configurable post-implementation reviewer is surfaced via
    // --feature-review-{provider,model,reasoning} CLI flags and
    // GSTACK_BUILD_FEATURE_REVIEW_{PROVIDER,MODEL,REASONING} env vars.
    expect(DEFAULT_ROLE_CONFIGS.featureReview).toBeDefined();
    expect(DEFAULT_ROLE_CONFIGS.featureReview.model.trim()).not.toBe("");
    // No `command` field — featureReview is a direct sub-agent invocation,
    // not a slash-command gate (review/qa/ship/land all carry .command).
    expect(DEFAULT_ROLE_CONFIGS.featureReview.command).toBeUndefined();
  });

  it("does not expose contextSave as a configured build role", () => {
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    expect((loaded.roles as any).contextSave).toBeUndefined();
    expect((DEFAULT_ROLE_CONFIGS as any).contextSave).toBeUndefined();
    expect(
      ROLE_DEFINITIONS.some(([key]) => key === ("contextSave" as any)),
    ).toBe(false);
  });

  it("exposes featureReviewMaxIterations and featureReview timeout in BUILD_DEFAULTS", () => {
    // The default cap on per-feature meta-review cycles. After this count,
    // the orchestrator pauses and prompts the user via stdin readline.
    expect(BUILD_DEFAULTS.limits.featureReviewMaxIterations).toBe(3);
    // 1200000ms = 20min — larger than codex's 900000ms because the feature
    // review reads ALL phase artifacts (not just one phase's diff).
    expect(BUILD_DEFAULTS.timeoutsMs.featureReview).toBe(1200000);
  });
});

describe("role config precedence helpers", () => {
  it("can load an alternate config file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-build-config-"));
    try {
      const file = path.join(dir, "configure.cm");
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      defaults.roles.primaryImpl.model = "primary-model-under-test";
      defaults.limits.codexMaxIterations = 7;
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));

      const loaded = loadBuildDefaults(file);
      expect(loaded.roles.primaryImpl.model).toBe("primary-model-under-test");
      expect(loaded.limits.codexMaxIterations).toBe(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills featureReview role + new limits/timeouts for pre-feature-review user configs", () => {
    // Real-world scenario: a user installed gstack before the feature-level
    // review existed and edited their configure.cm. On upgrade, they hit
    // `must be a positive number` on featureReviewMaxIterations because
    // their file predates the field. Backfill from the in-tree default.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-build-config-"));
    try {
      const file = path.join(dir, "configure.cm");
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      delete (defaults.roles as any).featureReview;
      delete (defaults.limits as any).featureReviewMaxIterations;
      delete (defaults.timeoutsMs as any).kimi;
      delete (defaults.timeoutsMs as any).featureReview;
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));
      const loaded = loadBuildDefaults(file);
      expect(loaded.roles.featureReview).toEqual(
        DEFAULT_ROLE_CONFIGS.featureReview,
      );
      expect(loaded.limits.featureReviewMaxIterations).toBe(3);
      expect(loaded.timeoutsMs.kimi).toBe(1200000);
      expect(loaded.timeoutsMs.featureReview).toBe(1200000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops legacy contextSave role entries when loading older alternate config files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-build-config-"));
    try {
      const file = path.join(dir, "configure.cm");
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      (defaults.roles as any).contextSave = {
        provider: "codex",
        model: "legacy-context-save-model",
        reasoning: "medium",
        command: "/context-save",
      };
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));

      const loaded = loadBuildDefaults(file);
      expect((loaded.roles as any).contextSave).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors GSTACK_BUILD_FEATURE_REVIEW_* env overrides", () => {
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_FEATURE_REVIEW_PROVIDER: "claude",
      GSTACK_BUILD_FEATURE_REVIEW_MODEL: "feature-review-model-under-test",
      GSTACK_BUILD_FEATURE_REVIEW_REASONING: "high",
    });
    expect(roles.featureReview.provider).toBe("claude");
    expect(roles.featureReview.model).toBe("feature-review-model-under-test");
    expect(roles.featureReview.reasoning).toBe("high");
  });

  it("accepts kimi as a role provider", () => {
    expect(parseProvider("kimi", "provider")).toBe("kimi");
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_PRIMARY_IMPL_PROVIDER: "kimi",
      GSTACK_BUILD_PRIMARY_IMPL_MODEL: "primary-model-under-test",
    });
    expect(roles.primaryImpl.provider).toBe("kimi");
    expect(roles.primaryImpl.model).toBe("primary-model-under-test");
  });

  it("rejects invalid config files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-build-config-"));
    try {
      const file = path.join(dir, "bad.configure.cm");
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      (defaults.roles.primaryImpl as any).provider = "bad-provider";
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));

      expect(() => loadBuildDefaults(file)).toThrow(
        "roles.primaryImpl.provider",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies env overrides over defaults", () => {
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_SHIP_MODEL: "ship-model-under-test",
      GSTACK_BUILD_SHIP_REASONING: "medium",
      GSTACK_BUILD_SHIP_COMMAND: "/custom-ship",
    });
    expect(roles.ship.model).toBe("ship-model-under-test");
    expect(roles.ship.reasoning).toBe("medium");
    expect(roles.ship.command).toBe("/custom-ship");
  });

  it("fills new roles when migrating an older persisted role config", () => {
    const roles = cloneRoleConfigs({
      primaryImpl: {
        ...DEFAULT_ROLE_CONFIGS.primaryImpl,
        model: "old-primary-model",
      },
    });
    expect(roles.primaryImpl.model).toBe("old-primary-model");
    expect((roles as any).contextSave).toBeUndefined();
  });

  it("migrates old model fields into roleConfigs", () => {
    const roles = migrateLegacyModels({
      geminiModel: "legacy-primary-model",
      codexModel: "legacy-secondary-model",
      codexReviewModel: "legacy-review-model",
    });
    expect(roles.primaryImpl.model).toBe("legacy-primary-model");
    expect(roles.secondaryImpl.model).toBe("legacy-secondary-model");
    expect(roles.reviewSecondary.model).toBe("legacy-review-model");
  });
});
