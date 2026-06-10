/**
 * Unit tests for scripts/one-way-doors.ts keyword safety net.
 *
 * The keyword layer is the SECONDARY safety net for ad-hoc AskUserQuestion ids
 * with no registry entry. A false negative auto-approves a destructive op, so the
 * credential-rotation patterns must be parallel across revoke/reset/rotate.
 */
import { describe, test, expect } from "bun:test";
import { classifyQuestion } from "../scripts/one-way-doors";

describe("one-way-door credential keyword net (#1839)", () => {
  // rotate ... password was missing from the rotate alternation while revoke and
  // reset both had it — the most common phrasing slipped through as two-way.
  test('"rotate the database password" classifies one-way', () => {
    const r = classifyQuestion({ summary: "rotate the database password" });
    expect(r.oneWay).toBe(true);
    expect(r.reason).toBe("keyword");
  });

  test("revoke/reset/rotate are all parallel for password", () => {
    for (const verb of ["revoke", "reset", "rotate"]) {
      const r = classifyQuestion({ summary: `${verb} the production password` });
      expect(r.oneWay).toBe(true);
    }
  });

  test("rotate still catches the other credential nouns", () => {
    for (const noun of ["api key", "token", "secret", "credential", "access key"]) {
      expect(classifyQuestion({ summary: `rotate my ${noun}` }).oneWay).toBe(true);
    }
  });
});
