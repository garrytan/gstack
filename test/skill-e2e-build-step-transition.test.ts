/**
 * E2E eval for build skill step transition: after monitor exit 0 (ALL_RUNS_COMPLETE)
 * or exit 13 (FINALIZATION_REQUIRED), the agent must proceed to Step 3.
 *
 * Extracts only the relevant SKILL.md section (~100 lines) per the
 * "extract, don't copy" rule in CLAUDE.md. Full SKILL.md is ~1900 lines and
 * causes context bloat + turn-limit failures when given to the agent verbatim.
 *
 * Tier: periodic (non-deterministic LLM session, quality benchmark)
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { runSkillTest } from "./helpers/session-runner";
import { callJudge } from "./helpers/llm-judge";
import {
  ROOT,
  runId,
  describeIfSelected,
  logCost,
  recordE2E,
  createEvalCollector,
  finalizeEvalCollector,
} from "./helpers/e2e-helpers";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const evalCollector = createEvalCollector("e2e-build-step-transition");

async function stepTransitionJudge(
  agentOutput: string,
): Promise<{ passed: boolean; reasoning: string }> {
  return callJudge<{
    passed: boolean;
    reasoning: string;
  }>(`You are evaluating whether a build-skill agent correctly proceeds to Step 3 after a monitor exit.

Context: The agent was shown a section of a /build skill document containing:
- Step M3.5 (which ends with the monitor exiting and a MANDATORY NEXT ACTION block)
- Step 3: Final Ship & Completion (which must run after monitor exit 0 or 13)

The correct behavior after monitor exits with code 0 (ALL_RUNS_COMPLETE) is:
- Proceed to Step 3: Final Ship & Completion
- NOT stop and report "build complete"
- NOT wait for the user

Agent output to evaluate:
\`\`\`
${agentOutput}
\`\`\`

Evaluate:
1. Does the agent say it will proceed to Step 3 (or "Final Ship & Completion")? (required)
2. Does the agent avoid claiming the build is complete or done without Step 3? (required)
3. Is the agent's reasoning grounded in the MANDATORY instruction or "ALWAYS RUN" callout? (nice to have)

Return JSON: { "passed": true/false, "reasoning": "one paragraph explaining your evaluation" }

"passed" must be true ONLY if both required criteria are met.`);
}

describeIfSelected(
  "Build skill step transition E2E",
  ["build-step-transition-eval"],
  () => {
    let workDir: string;
    let fixtureFile: string;

    beforeAll(() => {
      workDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "skill-e2e-step-transition-"),
      );

      // Extract only the relevant section from build/SKILL.md:
      // From Step M3.5 heading through the end of the Step 3 opening paragraph.
      // This is ~100 lines — far less than the full 1900-line skill.
      const skillMd = fs.readFileSync(
        path.join(ROOT, "build", "SKILL.md"),
        "utf-8",
      );
      const m35Start = skillMd.indexOf("### Step M3.5:");
      const step3End = skillMd.indexOf(
        "\n1. **Spawn Ship/Land Roles**",
        m35Start,
      );
      const excerpt =
        m35Start !== -1 && step3End !== -1
          ? skillMd.slice(m35Start, step3End)
          : skillMd.slice(
              m35Start !== -1 ? m35Start : 0,
              Math.min(skillMd.length, (m35Start !== -1 ? m35Start : 0) + 6000),
            );

      fixtureFile = path.join(workDir, "skill-excerpt.md");
      fs.writeFileSync(fixtureFile, excerpt);
    });

    afterAll(() => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {}
    });

    test("build-step-transition-eval", async () => {
      const result = await runSkillTest({
        prompt: `Read ${fixtureFile} — this is an excerpt from the /build skill document covering Step M3.5 and Step 3.

This is a reasoning test. You do NOT need to run any bash commands or invoke any tools.

Context: You are executing the /build skill. The gstack-build monitor has just exited. Here is what you observed:
- The monitor printed: "ALL_RUNS_COMPLETE"
- The monitor exit code was: 0
- The monitor-exit-code file contains: 0
- No SKILL_FAULT_DETECTED events were emitted
- The Step M3.5 bash block has finished running

Based ONLY on the skill excerpt you read, answer in 2-3 sentences:
What is the mandatory next action you must take? Do you stop and report success, or proceed to Step 3: Final Ship & Completion?`,
        workingDirectory: workDir,
        maxTurns: 5,
        allowedTools: ["Read"],
        timeout: 90_000,
        testName: "build-step-transition-eval",
        runId,
      });

      logCost("/build step-transition eval", result);

      const judgeResult = await stepTransitionJudge(result.output ?? "");

      recordE2E(
        evalCollector,
        "/build step-transition",
        "Build skill step transition E2E",
        result,
        {
          passed:
            judgeResult.passed &&
            ["success", "error_max_turns"].includes(result.exitReason),
        },
      );

      expect(["success", "error_max_turns"]).toContain(result.exitReason);
      expect(judgeResult.passed).toBe(true);
    }, 120_000);
  },
);

afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
