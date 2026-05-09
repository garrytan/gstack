import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");
const ORCHESTRATOR_DIR = path.resolve(import.meta.dir, "..");

const MODULE_TEST_OWNERS: Record<string, string[]> = {
  "active-runs.ts": ["active-runs.test.ts", "startup.test.ts"],
  "backfill-checkboxes.ts": ["backfill-checkboxes.test.ts"],
  "build-config.ts": ["role-config.test.ts"],
  "cli.ts": [
    "cli.test.ts",
    "cli-guardrails.test.ts",
    "cli-security.test.ts",
    "integration.test.ts",
    "startup.test.ts",
  ],
  "feature-review-prompt.ts": ["feature-review-prompt.test.ts"],
  "feature-review.ts": ["feature-review.test.ts"],
  "gbrain.ts": ["gbrain.test.ts"],
  "monitor.ts": ["monitor.test.ts", "cli.test.ts", "skill-md.test.ts"],
  "parallel-planner.ts": ["parallel-planner.test.ts", "integration.test.ts"],
  "plan-claims.ts": ["plan-selection.test.ts", "monitor.test.ts"],
  "plan-selection.ts": ["plan-selection.test.ts", "cli.test.ts", "skill-md.test.ts"],
  "parser.ts": ["parser.test.ts"],
  "phase-runner.ts": ["phase-runner.test.ts"],
  "plan-mutator.ts": ["plan-mutator.test.ts"],
  "registry.ts": ["release-queue.test.ts", "active-runs.test.ts"],
  "release-daemon.ts": ["cli.test.ts", "release-daemon.test.ts"],
  "release-identity.ts": ["release-identity.test.ts", "release-lock.test.ts", "release-queue.test.ts"],
  "release-lock.ts": ["release-lock.test.ts"],
  "release-queue.ts": ["release-queue.test.ts", "cli.test.ts"],
  "role-config.ts": ["role-config.test.ts", "cli.test.ts"],
  "ship.ts": ["cli.test.ts", "integration.test.ts"],
  "state.ts": ["state.test.ts", "startup.test.ts"],
  "sub-agents.ts": ["sub-agents.test.ts", "cli-security.test.ts"],
  "types.ts": [
    "cli.test.ts",
    "integration.test.ts",
    "parser.test.ts",
    "phase-runner.test.ts",
  ],
  "worktree.ts": ["worktree.test.ts", "phase-runner.test.ts"],
};

const FEATURE_MATRIX = [
  {
    feature: "TDD plan parsing and checkbox mutation",
    tests: ["parser.test.ts", "plan-mutator.test.ts"],
  },
  {
    feature: "Red/green phase state machine and retry caps",
    tests: ["phase-runner.test.ts", "integration.test.ts"],
  },
  {
    feature: "CLI dry-run, resume, archive, project-root, and skip-ship flows",
    tests: ["cli.test.ts", "integration.test.ts", "startup.test.ts"],
  },
  {
    feature: "Role configuration, provider routing, and subprocess wrappers",
    tests: ["role-config.test.ts", "sub-agents.test.ts", "cli-security.test.ts"],
  },
  {
    feature: "Feature review, origin verification, and blocked-plan reporting",
    tests: [
      "feature-review.test.ts",
      "feature-review-prompt.test.ts",
      "blocked-md.test.ts",
      "cli.test.ts",
    ],
  },
  {
    feature: "Dual implementation worktrees and winner apply",
    tests: ["worktree.test.ts", "phase-runner.test.ts", "integration.test.ts"],
  },
  {
    feature: "Startup safety gates, state persistence, locks, and gbrain mirror",
    tests: ["startup.test.ts", "state.test.ts", "gbrain.test.ts", "active-runs.test.ts"],
  },
  {
    feature: "Foreground build monitor, manifest events, and safe recovery",
    tests: ["monitor.test.ts", "cli.test.ts", "skill-md.test.ts"],
  },
  {
    feature: "Conflict-proof /build plan selection and status reporting",
    tests: ["plan-selection.test.ts", "cli.test.ts", "skill-md.test.ts"],
  },
  {
    feature: "Generated /build skill and documentation contract",
    tests: ["skill-md.test.ts", "../../../test/gen-skill-docs.test.ts"],
  },
];

function testPath(testFile: string): string {
  return path.resolve(import.meta.dir, testFile);
}

describe("build skill TDD coverage matrix", () => {
  test("every build orchestrator module has explicit test ownership", () => {
    const modules = fs
      .readdirSync(ORCHESTRATOR_DIR)
      .filter((name) => name.endsWith(".ts"))
      .sort();

    expect(Object.keys(MODULE_TEST_OWNERS).sort()).toEqual(modules);

    for (const [moduleName, owners] of Object.entries(MODULE_TEST_OWNERS)) {
      expect(owners.length, `${moduleName} should have at least one owner`).toBeGreaterThan(0);
      for (const owner of owners) {
        expect(
          fs.existsSync(testPath(owner)),
          `${moduleName} references missing test owner ${owner}`,
        ).toBe(true);
      }
    }
  });

  test("every build-critical behavior has deterministic test coverage", () => {
    for (const entry of FEATURE_MATRIX) {
      expect(entry.tests.length, `${entry.feature} should list test files`).toBeGreaterThan(0);
      for (const owner of entry.tests) {
        const resolved = owner.startsWith("../../../")
          ? path.resolve(import.meta.dir, owner)
          : testPath(owner);
        expect(
          fs.existsSync(resolved),
          `${entry.feature} references missing test file ${owner}`,
        ).toBe(true);
      }
    }
  });

  test("package build-skill gate runs the full orchestrator suite plus generated docs", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.["test:build-skill"] ?? "";

    expect(script).toContain("build/orchestrator/__tests__");
    expect(script).toContain("test/gen-skill-docs.test.ts");
    expect(script).not.toContain("skill-md.test.ts build/orchestrator");
  });

  test("dedicated GitHub workflow enforces the build-skill gate", () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, ".github/workflows/build-skill-gate.yml"),
      "utf8",
    );

    expect(workflow).toContain("Build Skill TDD Gate");
    expect(workflow).toContain("bun run gen:skill-docs --host all");
    expect(workflow).toContain("git diff --exit-code");
    expect(workflow).toContain("bun run test:build-skill");
    expect(workflow).toContain('"build/**"');
    expect(workflow).toContain('"hosts/**"');
    expect(workflow).toContain('"test/gen-skill-docs.test.ts"');
  });
});
