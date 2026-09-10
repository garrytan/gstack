/** OV11: the host-neutral eval-model resolver's contract. */
import { describe, test, expect } from "bun:test";
import { CLAUDE_FRONTIER_EVAL_MODEL, resolveEvalModel } from "../lib/eval-model";

describe("resolveEvalModel", () => {
  test("explicit argument wins over everything", () => {
    expect(resolveEvalModel("capture", "my-model", { GSTACK_EVAL_MODEL: "x" } as never)).toBe("my-model");
  });
  test("per-kind env beats the global env", () => {
    expect(resolveEvalModel("warmup", null, { GSTACK_EVAL_MODEL_WARMUP: "w", GSTACK_EVAL_MODEL: "g" } as never)).toBe("w");
  });
  test("global env beats the default", () => {
    expect(resolveEvalModel("distill", null, { GSTACK_EVAL_MODEL: "g" } as never)).toBe("g");
  });
  test("defaults per kind", () => {
    expect(resolveEvalModel("capture", null, {} as never)).toBe(CLAUDE_FRONTIER_EVAL_MODEL);
    expect(resolveEvalModel("warmup", null, {} as never)).toBe("claude-haiku-4-5");
    expect(resolveEvalModel("distill", null, {} as never)).toBe("claude-haiku-4-5-20251001");
    expect(resolveEvalModel("judge", null, {} as never)).toBe(CLAUDE_FRONTIER_EVAL_MODEL);
  });
  test("unknown kind throws instead of silently defaulting", () => {
    expect(() => resolveEvalModel("banana" as never, null, {} as never)).toThrow();
  });
});
