import { describe, test, expect } from "bun:test";
import { parseCodexJSONL, sanitizeCodexTestName } from "./codex-session-runner";

const FIXTURE_LINES = [
  '{"type":"thread.started","thread_id":"abc"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will run pwd."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"/repo\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Done."}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10}}',
];

describe("sanitizeCodexTestName", () => {
  test("strips leading slashes and replaces path separators", () => {
    expect(sanitizeCodexTestName("/qa/smoke")).toBe("qa-smoke");
    expect(sanitizeCodexTestName("plain-name")).toBe("plain-name");
  });
});

describe("parseCodexJSONL", () => {
  test("parses agent messages, command executions, turns, and usage", () => {
    const parsed = parseCodexJSONL(FIXTURE_LINES);
    expect(parsed.transcript).toHaveLength(7);
    expect(parsed.agentMessages).toEqual(["I will run pwd.", "Done."]);
    expect(parsed.toolCalls).toEqual([
      {
        tool: "command_execution",
        input: { command: "/bin/zsh -lc pwd" },
        output: "/repo\n",
      },
    ]);
    expect(parsed.turnCount).toBe(1);
    expect(parsed.usageTokens).toBe(130);
  });

  test("skips malformed lines without throwing", () => {
    const parsed = parseCodexJSONL([
      '{"type":"turn.started"}',
      "not json",
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":2}}',
    ]);
    expect(parsed.transcript).toHaveLength(2);
    expect(parsed.turnCount).toBe(1);
    expect(parsed.usageTokens).toBe(3);
  });
});
