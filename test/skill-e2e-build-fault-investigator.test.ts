/**
 * E2E test for the build skill fault investigator dispatch (Step M3.5).
 *
 * RED phase of TDD for Phase 4.1 — test structure is written before the full
 * working E2E flow is validated. The test will fail without Feature 3 (Step M3.5
 * in SKILL.md) and a working GSTACK_FAULT_INVESTIGATOR_COMMAND integration.
 *
 * Setup:
 *   - Creates a temp dir used as HOME (so ~/.gstack/skill-faults/ resolves there)
 *   - Pre-writes BUILD_TMP_DIR/monitor-output.log with a SKILL_FAULT_DETECTED
 *     JSON event for PLAN_SYNTHESIS_INVALID
 *   - Provides a mock gstack-build script (GSTACK_BUILD_CLI) that also outputs
 *     the SKILL_FAULT_DETECTED event to stdout and exits 0
 *   - Provides a mock investigator script (GSTACK_FAULT_INVESTIGATOR_COMMAND)
 *     that writes a fixed report containing PLAN_SYNTHESIS_INVALID to stdout
 *     (stdout is redirected to $FAULT_PRIMARY by Step M3.5's subshell)
 *
 * Assertions:
 *   - A .md report file exists in $fakeHome/.gstack/skill-faults/
 *   - The report contains "PLAN_SYNTHESIS_INVALID"
 *   - No gstack source files were edited by the agent
 *
 * Tier: periodic (non-deterministic LLM session, requires external agent)
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { runSkillTest } from "./helpers/session-runner";
import {
  ROOT,
  runId,
  describeIfSelected,
  logCost,
  recordE2E,
  createEvalCollector,
  finalizeEvalCollector,
} from "./helpers/e2e-helpers";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const evalCollector = createEvalCollector("e2e-build-fault-investigator");

describeIfSelected(
  "Build skill fault investigator E2E",
  ["build-fault-investigator-e2e"],
  () => {
    let tempDir: string;
    let fakeHome: string;
    let buildTmpDir: string;
    let monitorOutputLog: string;
    let mockGstackBuild: string;
    let mockInvestigator: string;

    const testRunId = "fault-e2e-run-abc123";

    beforeAll(() => {
      tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "skill-e2e-fault-investigator-"),
      );
      fakeHome = path.join(tempDir, "fake-home");
      buildTmpDir = path.join(tempDir, "build-tmp");

      // Create directories
      fs.mkdirSync(fakeHome, { recursive: true });
      fs.mkdirSync(buildTmpDir, { recursive: true });
      fs.mkdirSync(path.join(fakeHome, ".gstack", "skill-faults"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(fakeHome, ".claude", "skills", "gstack", "build"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(
          fakeHome,
          ".claude",
          "skills",
          "gstack",
          "build",
          "configure.cm",
        ),
        "{}",
      );

      // The SKILL_FAULT_DETECTED event that represents a PLAN_SYNTHESIS_INVALID fault
      const faultEvent = JSON.stringify({
        event: "SKILL_FAULT_DETECTED",
        timestamp: "2026-05-11T00:00:00.000Z",
        runId: testRunId,
        stateSlug: `build-${testRunId}`,
        stateFile: path.join(tempDir, "state.json"),
        manifestPath: path.join(tempDir, "manifest.json"),
        faults: [
          {
            category: "PLAN_SYNTHESIS_INVALID",
            severity: "HIGH",
            description:
              "Phase block missing Origin trace: and Acceptance: markers",
            sourceFiles: [path.join(tempDir, "living-plan.md")],
            evidence: { phaseIndex: 0 },
          },
        ],
      });

      // Pre-write monitor-output.log (simulates what Step M3 would capture from gstack-build monitor)
      monitorOutputLog = path.join(buildTmpDir, "monitor-output.log");
      fs.writeFileSync(monitorOutputLog, faultEvent + "\n");

      // Also write monitor-exit-code so Step M3.5 picks up the correct exit code
      fs.writeFileSync(path.join(buildTmpDir, "monitor-exit-code"), "0\n");

      // Mock gstack-build: outputs the SKILL_FAULT_DETECTED JSON event to stdout and exits 0.
      // This stands in for `$GSTACK_BUILD_CLI monitor ...` in Step M3 — its stdout would
      // be captured via tee to monitor-output.log. We pre-write the log directly but also
      // provide this shim so the env var contract is complete.
      mockGstackBuild = path.join(tempDir, "mock-gstack-build");
      const eventEscaped = faultEvent.replace(/'/g, "'\\''");
      fs.writeFileSync(
        mockGstackBuild,
        `#!/usr/bin/env bash
set -euo pipefail
# Mock gstack-build: outputs SKILL_FAULT_DETECTED event and exits 0
printf '%s\\n' '${eventEscaped}'
exit 0
`,
        { mode: 0o755 },
      );

      // Mock investigator: prints to stdout (Step M3.5 redirects stdout to $FAULT_PRIMARY).
      // The report must contain PLAN_SYNTHESIS_INVALID so assertions pass.
      mockInvestigator = path.join(tempDir, "mock-investigator");
      fs.writeFileSync(
        mockInvestigator,
        `#!/usr/bin/env bash
# Mock fault investigator for E2E testing.
# Step M3.5 invokes: bash -lc "$GSTACK_FAULT_INVESTIGATOR_COMMAND"
# with stdout redirected to $FAULT_PRIMARY, so we print the report to stdout.
printf '# Fault Investigation Report\\n\\n'
printf '## Category: %s\\n\\n' "$FAULT_CATEGORY"
printf 'Run ID: %s\\n\\n' "$FAULT_RUN_ID"
printf 'Root cause: PLAN_SYNTHESIS_INVALID\\n\\n'
printf 'The phase block at index 0 is missing required Origin trace: and Acceptance: markers.\\n\\n'
printf '## Recommendation\\n\\nAdd Origin trace: and Acceptance: fields to all phase blocks.\\n'
`,
        { mode: 0o755 },
      );
    });

    afterAll(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* non-fatal */
      }
    });

    test("build-fault-investigator-e2e", async () => {
      const buildSkillMd = path.join(ROOT, "build", "SKILL.md");

      const result = await runSkillTest({
        prompt: `Read ${buildSkillMd} for the /build workflow.

This is an E2E test for Step M3.5 (Skill Fault Investigator) dispatch. All prerequisite steps have already run — the monitor has exited and its output is on disk.

State for this test run:
- BUILD_TMP_DIR is: ${buildTmpDir}
- The monitor output log is at: ${monitorOutputLog}
  (it contains one SKILL_FAULT_DETECTED event with category PLAN_SYNTHESIS_INVALID)
- The monitor exit code file is at: ${path.join(buildTmpDir, "monitor-exit-code")}
- Use HOME=${fakeHome} when you run the Step M3.5 bash block
  (so ~/.gstack/skill-faults/ resolves to ${fakeHome}/.gstack/skill-faults/)
- GSTACK_FAULT_INVESTIGATOR_COMMAND is set in the environment

Your task:
1. In the same shell command that runs the block, set BUILD_TMP_DIR=${buildTmpDir}, HOME=${fakeHome}, and GSTACK_HOME=${path.join(fakeHome, ".gstack")}.
2. Execute ONLY the Step M3.5 bash block from the build SKILL.md (copy and run it verbatim after those environment assignments).
3. Do NOT run any other steps (no Step M1, M2, M3, M4, or any ship/review steps).
4. Do NOT invoke any real gstack-build commands or spawn any LLM agents.
5. Do NOT edit any source files in the repository at ${ROOT}.
6. After the Step M3.5 bash block exits, report:
   - The value of $_MONITOR_EXIT
   - Whether any report files appeared in ${fakeHome}/.gstack/skill-faults/
   - The path of any report file written`,
        workingDirectory: tempDir,
        maxTurns: 15,
        allowedTools: ["Bash", "Read"],
        timeout: 180_000,
        testName: "build-fault-investigator-e2e",
        runId,
        env: {
          GSTACK_BUILD_CLI: mockGstackBuild,
          GSTACK_FAULT_INVESTIGATOR_COMMAND: mockInvestigator,
        },
      });

      logCost("/build fault investigator E2E", result);

      // Give background subshell (the mock investigator) a moment to finish writing.
      // In practice it finishes in <100ms, but being explicit avoids any race.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Assertion 1: a .md report file exists in the fault inbox
      const faultInboxDir = path.join(fakeHome, ".gstack", "skill-faults");
      const reportFiles = fs.existsSync(faultInboxDir)
        ? fs.readdirSync(faultInboxDir).filter((f) => f.endsWith(".md"))
        : [];

      const reportExists = reportFiles.length > 0;
      const reportContent = reportExists
        ? fs.readFileSync(path.join(faultInboxDir, reportFiles[0]), "utf-8")
        : "";

      // Assertion 2: report contains the expected fault category
      const hasExpectedCategory = reportContent.includes(
        "PLAN_SYNTHESIS_INVALID",
      );

      // Assertion 3: no gstack source files were edited by the agent session
      const gitResult = spawnSync("git", ["status", "--porcelain"], {
        cwd: ROOT,
        stdio: "pipe",
        timeout: 5_000,
      });
      const modifiedLines = (gitResult.stdout?.toString() ?? "")
        .trim()
        .split("\n")
        .filter(Boolean);
      // Only flag files in build/, test/, or scripts/ — env/tmp files are acceptable
      const modifiedSourceFiles = modifiedLines
        .map((line) => line.slice(3)) // strip git status prefix (e.g., " M ")
        .filter(
          (f) =>
            f.startsWith("build/") ||
            f.startsWith("test/") ||
            f.startsWith("scripts/"),
        );
      const noSourceFilesEdited = modifiedSourceFiles.length === 0;

      const passed = reportExists && hasExpectedCategory && noSourceFilesEdited;

      recordE2E(
        evalCollector,
        "/build fault investigator",
        "Build skill fault investigator E2E",
        result,
        { passed },
      );

      expect(
        reportExists,
        `Expected a .md report in ${faultInboxDir} but found: ${JSON.stringify(reportFiles)}`,
      ).toBe(true);

      expect(
        hasExpectedCategory,
        `Report should contain "PLAN_SYNTHESIS_INVALID". Got first 300 chars: ${reportContent.slice(0, 300)}`,
      ).toBe(true);

      expect(
        noSourceFilesEdited,
        `These source files were unexpectedly modified: ${modifiedSourceFiles.join(", ")}`,
      ).toBe(true);
    }, 200_000);
  },
);

afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
