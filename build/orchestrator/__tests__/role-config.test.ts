import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ROLE_CONFIGS,
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
    expect(loaded.timeoutsMs.gemini).toBe(600000);
    expect(loaded.timeoutsMs.kimi).toBe(600000);
    expect(BUILD_DEFAULTS.roles.primaryImpl.model).toBe(
      loaded.roles.primaryImpl.model,
    );
  });

  it("matches the default build routing", () => {
    expect(DEFAULT_ROLE_CONFIGS.testWriter).toEqual(
      BUILD_DEFAULTS.roles.testWriter,
    );
    expect(DEFAULT_ROLE_CONFIGS.primaryImpl).toEqual(
      BUILD_DEFAULTS.roles.primaryImpl,
    );
    expect(DEFAULT_ROLE_CONFIGS.testFixer).toEqual(
      BUILD_DEFAULTS.roles.testFixer,
    );
    expect(DEFAULT_ROLE_CONFIGS.reviewSecondary).toEqual(
      BUILD_DEFAULTS.roles.reviewSecondary,
    );
    expect(DEFAULT_ROLE_CONFIGS.reviewSecondary.command).toBeUndefined();
    expect(DEFAULT_ROLE_CONFIGS.qa.command).toBe("/qa");
    expect(DEFAULT_ROLE_CONFIGS.primaryImpl.provider).toBe("kimi");
    expect(DEFAULT_ROLE_CONFIGS.primaryImpl.model).toBe(
      "kimi-code/kimi-for-coding",
    );
    expect(DEFAULT_ROLE_CONFIGS.ship.provider).toBe("codex");
    expect(DEFAULT_ROLE_CONFIGS.ship.model).toBe("gpt-5.5");
    expect(DEFAULT_ROLE_CONFIGS.ship.command).toBe("/ship");
    expect(DEFAULT_ROLE_CONFIGS.land.provider).toBe("codex");
    expect(DEFAULT_ROLE_CONFIGS.land.model).toBe("gpt-5.5");
    expect(DEFAULT_ROLE_CONFIGS.land.command).toBe("/land-and-deploy");
    expect(DEFAULT_ROLE_CONFIGS.contextSave.command).toBe("/context-save");
  });

  it("routes template-only plan location through kimi in configure.cm", () => {
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    expect((loaded.roles as any).planLocator.provider).toBe("kimi");
    expect((loaded.roles as any).planLocator.model).toBe(
      "kimi-code/kimi-for-coding",
    );
  });

  it("includes the featureReview role with codex/gpt-5.5 defaults", () => {
    // The configurable post-implementation reviewer. Default codex/gpt-5.5/xhigh
    // — surfaced via --feature-review-{provider,model,reasoning} CLI flags
    // and GSTACK_BUILD_FEATURE_REVIEW_{PROVIDER,MODEL,REASONING} env vars.
    expect(DEFAULT_ROLE_CONFIGS.featureReview).toBeDefined();
    expect(DEFAULT_ROLE_CONFIGS.featureReview.provider).toBe("codex");
    expect(DEFAULT_ROLE_CONFIGS.featureReview.model).toBe("gpt-5.5");
    expect(DEFAULT_ROLE_CONFIGS.featureReview.reasoning).toBe("xhigh");
    // No `command` field — featureReview is a direct sub-agent invocation,
    // not a slash-command gate (review/qa/ship/land all carry .command).
    expect(DEFAULT_ROLE_CONFIGS.featureReview.command).toBeUndefined();
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
      defaults.roles.primaryImpl.model = "gemini-custom-preview";
      defaults.limits.codexMaxIterations = 7;
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));

      const loaded = loadBuildDefaults(file);
      expect(loaded.roles.primaryImpl.model).toBe("gemini-custom-preview");
      expect(loaded.limits.codexMaxIterations).toBe(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fills new roles when loading an older alternate config file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-build-config-"));
    try {
      const file = path.join(dir, "configure.cm");
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      delete (defaults.roles as any).contextSave;
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));
      const loaded = loadBuildDefaults(file);
      expect(loaded.roles.contextSave).toEqual(
        DEFAULT_ROLE_CONFIGS.contextSave,
      );
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
      expect(loaded.timeoutsMs.kimi).toBe(600000);
      expect(loaded.timeoutsMs.featureReview).toBe(1200000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors GSTACK_BUILD_FEATURE_REVIEW_* env overrides", () => {
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_FEATURE_REVIEW_PROVIDER: "claude",
      GSTACK_BUILD_FEATURE_REVIEW_MODEL: "claude-opus-4-7",
      GSTACK_BUILD_FEATURE_REVIEW_REASONING: "high",
    });
    expect(roles.featureReview.provider).toBe("claude");
    expect(roles.featureReview.model).toBe("claude-opus-4-7");
    expect(roles.featureReview.reasoning).toBe("high");
  });

  it("accepts kimi as a role provider", () => {
    expect(parseProvider("kimi", "provider")).toBe("kimi");
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_PRIMARY_IMPL_PROVIDER: "kimi",
      GSTACK_BUILD_PRIMARY_IMPL_MODEL: "kimi-code/kimi-for-coding",
    });
    expect(roles.primaryImpl.provider).toBe("kimi");
    expect(roles.primaryImpl.model).toBe("kimi-code/kimi-for-coding");
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
      GSTACK_BUILD_SHIP_MODEL: "gpt-5.4",
      GSTACK_BUILD_SHIP_REASONING: "medium",
      GSTACK_BUILD_SHIP_COMMAND: "/custom-ship",
    });
    expect(roles.ship.model).toBe("gpt-5.4");
    expect(roles.ship.reasoning).toBe("medium");
    expect(roles.ship.command).toBe("/custom-ship");
  });

  it("fills new roles when migrating an older persisted role config", () => {
    const roles = cloneRoleConfigs({
      primaryImpl: {
        ...DEFAULT_ROLE_CONFIGS.primaryImpl,
        model: "gemini-old-state",
      },
    });
    expect(roles.primaryImpl.model).toBe("gemini-old-state");
    expect(roles.contextSave).toEqual(DEFAULT_ROLE_CONFIGS.contextSave);
  });

  it("migrates old model fields into roleConfigs", () => {
    const roles = migrateLegacyModels({
      geminiModel: "gemini-legacy",
      codexModel: "codex-legacy",
      codexReviewModel: "review-legacy",
    });
    expect(roles.primaryImpl.model).toBe("gemini-legacy");
    expect(roles.secondaryImpl.model).toBe("codex-legacy");
    expect(roles.reviewSecondary.model).toBe("review-legacy");
  });
});
