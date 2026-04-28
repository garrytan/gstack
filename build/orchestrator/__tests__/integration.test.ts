/**
 * Integration test: dry-run a synthetic 2-phase TDD plan through the CLI.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const TDD_PLAN = `# Test Integration Plan

## Phases

### Phase 1: Foundation
- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests for foundation.
- [ ] **Implementation (Gemini Sub-agent)**: Implement foundation.
- [ ] **Review & QA (Codex Sub-agent)**: Review foundation.

### Phase 2: Integration
- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests for integration.
- [ ] **Implementation (Gemini Sub-agent)**: Implement integration.
- [ ] **Review & QA (Codex Sub-agent)**: Review integration.
`;

let tmpDir: string;
let planFile: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-integration-"));
  planFile = path.join(tmpDir, "test-plan.md");
  fs.writeFileSync(planFile, TDD_PLAN);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("dry-run TDD plan announces Test Specification and Verify Red for each phase", () => {
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const result = spawnSync(
    "bun",
    ["run", cliPath, planFile, "--dry-run", "--test-cmd", "bun test", "--no-gbrain"],
    {
      env: {
        ...process.env,
        HOME: tmpDir,
        GSTACK_HOME: path.join(tmpDir, ".gstack"),
      },
      encoding: "utf8",
      timeout: 30_000,
    }
  );

  const out = result.stdout + result.stderr;

  // Phase 5 impl must update the log from "writing test spec" -> "Test Specification"
  expect(out).toContain("Test Specification");
  // Verify Red step must be announced
  expect(out).toContain("Verify Red");
  // Both phases must appear in output
  expect((out.match(/Phase 1/g) ?? []).length).toBeGreaterThan(0);
  expect((out.match(/Phase 2/g) ?? []).length).toBeGreaterThan(0);
  // Dry-run must complete successfully
  expect(result.status).toBe(0);
});
