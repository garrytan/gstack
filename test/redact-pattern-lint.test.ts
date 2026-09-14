/**
 * ReDoS guard (T10) — fails CI if any taxonomy pattern has a catastrophic-
 * backtracking shape, and asserts the engine's oversize-input path fails CLOSED.
 *
 * We do two things:
 *   1. Static lint: reject nested unbounded quantifiers like (a+)+ / (a*)* /
 *      (a+)* in any pattern source. These are the classic ReDoS forms.
 *   2. Runtime budget: run every pattern against a pathological input and assert
 *      no single pattern takes more than a generous wall-clock budget. This
 *      catches catastrophic forms the static check might miss.
 */
import { describe, test, expect } from "bun:test";
import { PATTERNS } from "../lib/redact-patterns";
import { scan } from "../lib/redact-engine";

// Nested-quantifier ReDoS shapes: a group ending in +/*/{n,} that is itself
// immediately quantified by +/*/{n,}. e.g. (x+)+  (x*)*  (x+)*  (?:x+){2,}
const NESTED_QUANTIFIER = /\([^)]*[+*]\)[+*]|\([^)]*[+*]\)\{\d+,?\}|\([^)]*\{\d+,\}\)[+*]/;

describe("pattern lint — no catastrophic backtracking", () => {
  for (const p of PATTERNS) {
    test(`${p.id} has no nested unbounded quantifier`, () => {
      expect(NESTED_QUANTIFIER.test(p.regex.source)).toBe(false);
    });
  }

  test("a planted catastrophic pattern WOULD be caught by the linter", () => {
    // meta-test: prove the linter actually detects the bad shape
    expect(NESTED_QUANTIFIER.test("(a+)+")).toBe(true);
    expect(NESTED_QUANTIFIER.test("(\\d*)*")).toBe(true);
  });
});

describe("runtime budget — pathological inputs do not hang", () => {
  // Inputs designed to stress backtracking on the real patterns.
  const adversarial = [
    "a".repeat(5000) + "!",
    "AKIA" + "A".repeat(5000),
    "eyJ" + "a".repeat(2000) + "." + "b".repeat(2000),
    "x@" + "a".repeat(3000),
    "/Users/" + "a".repeat(4000),
    ("1".repeat(19) + " ").repeat(200),
  ];

  for (const [i, input] of adversarial.entries()) {
    test(`adversarial input #${i} scans within budget`, () => {
      const start = performance.now();
      scan(input, { repoVisibility: "private", maxBytes: 1024 * 1024 });
      const elapsed = performance.now() - start;
      // Generous: full taxonomy over a 5KB pathological string should be well
      // under 1s on any CI box. A catastrophic pattern would blow past this.
      expect(elapsed).toBeLessThan(1000);
    });
  }
});

describe("oversize fails closed (the real ReDoS backstop)", () => {
  test("input over cap returns blocking HIGH, never runs the patterns", () => {
    const r = scan("a".repeat(50_000), { maxBytes: 10_000 });
    expect(r.oversize).toBe(true);
    expect(r.counts.HIGH).toBe(1);
    expect(r.findings[0].id).toBe("engine.input_too_large");
  });
});
