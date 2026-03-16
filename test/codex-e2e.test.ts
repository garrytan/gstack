import { describe, test, expect } from "bun:test";
import { runCodexSkillTest } from "./helpers/codex-session-runner";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const codexEvalsEnabled = !!process.env.CODEX_EVALS;
const describeCodex = codexEvalsEnabled ? describe : describe.skip;
const runId = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);

describeCodex("Codex skill E2E tests", () => {
  test("Codex loads repo-local skills without frontmatter/runtime errors", async () => {
    const result = await runCodexSkillTest({
      prompt: [
        "Use the `gstack-browse` skill from this repository.",
        "Do not run any browser commands.",
        "Summarize the first two setup steps in one short paragraph.",
      ].join(" "),
      workingDirectory: ROOT,
      timeout: 90_000,
      testName: "codex-skill-load",
      runId,
    });

    expect(result.exitReason).toBe("success");
    expect(result.stderr).not.toContain("failed to load skill");
    expect(result.output.toLowerCase()).toContain("setup");
  }, 120_000);

  test("Codex can execute a simple shell-backed workflow prompt", async () => {
    const result = await runCodexSkillTest({
      prompt: [
        "Run `pwd` in the current workspace and report the result using the required four-part output contract.",
        "Keep it concise.",
      ].join(" "),
      workingDirectory: ROOT,
      timeout: 90_000,
      testName: "codex-basic-shell",
      runId,
    });

    expect(result.exitReason).toBe("success");
    expect(result.toolCalls.some((call) => String(call.input.command || "").includes("pwd"))).toBe(
      true,
    );
    expect(result.output).toContain("/Users/mneves/dev/gstack");
  }, 120_000);
});
