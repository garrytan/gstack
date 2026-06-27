import { describe, expect, test } from "bun:test";
import { flagValue } from "../lib/bin-context";

describe("flagValue", () => {
  test("returns the value after a flag", () => {
    expect(flagValue(["--scope", "branch"], "--scope")).toBe("branch");
  });

  test("returns undefined when the flag is absent or missing a value", () => {
    expect(flagValue(["--json"], "--scope")).toBeUndefined();
    expect(flagValue(["--scope"], "--scope")).toBeUndefined();
  });

  test("does not treat the next flag as a value", () => {
    expect(flagValue(["--redact", "--compact"], "--redact")).toBeUndefined();
  });
});
