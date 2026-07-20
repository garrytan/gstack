import { describe, expect, test } from "bun:test";
import {
  EXECUTION_RESULT_ERROR_CODES,
  executionResult,
  renderExecutionResult,
  validateExecutionResult,
} from "../runtime/execution-result.js";

describe("GStack execution-result contract", () => {
  test("accepts evidenced success and preserves it in both renderings", () => {
    const result = executionResult({ status: "success", summary: "Probe completed", evidence: ["exit code 0"], data: { count: 1 } });
    expect(JSON.parse(renderExecutionResult(result, { json: true }))).toEqual(result);
    expect(renderExecutionResult(result)).toContain("SUCCESS: Probe completed");
  });

  test("rejects empty and malformed values instead of inferring success", () => {
    expect(() => validateExecutionResult(null)).toThrow();
    expect(() => executionResult({ status: "success", summary: "Done", evidence: [], data: null }))
      .toThrow("requires evidence");
    try {
      executionResult({ status: "success", summary: "Done", evidence: [], data: null });
    } catch (error: any) {
      expect(error.code).toBe(EXECUTION_RESULT_ERROR_CODES.EMPTY);
    }
  });

  test.each([
    ["degraded", "EXECUTION_DEGRADED"],
    ["unsupported", "EXECUTION_UNSUPPORTED"],
    ["failed", "EXECUTION_FAILED"],
  ])("keeps %s explicitly non-success", (status, code) => {
    const result = executionResult({ status, code, summary: `${status} result`, evidence: [], data: null });
    expect(renderExecutionResult(result)).toStartWith(`${status.toUpperCase()} [${code}]`);
  });
});
