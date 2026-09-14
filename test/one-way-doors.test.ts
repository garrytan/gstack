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

  // revoke/reset/rotate must all share the same credential noun list. Previously
  // "secret" was only in rotate (missing from revoke and reset) and "access key"
  // was missing from reset, so "revoke my secret" / "reset my secret" /
  // "reset my access key" leaked through as two-way (auto-decidable).
  test("revoke/reset/rotate are all parallel for every credential noun", () => {
    for (const verb of ["revoke", "reset", "rotate"]) {
      for (const noun of ["api key", "token", "secret", "credential", "access key", "password"]) {
        const r = classifyQuestion({ summary: `${verb} my ${noun}` });
        expect(r.oneWay, `${verb} my ${noun} should be one-way`).toBe(true);
      }
    }
  });
});

describe("one-way-door credential keyword net (#2024)", () => {
  const VERBS = ["revoke", "reset", "rotate"];
  const NOUNS = ["api key", "token", "secret", "credential", "access key", "password"];

  // #2024 repro rows: these leaked as two-way pre-fix because the noun
  // alternations were mismatched across verbs (revoke lacked secret; reset
  // lacked secret AND access key). The password-parallel test above passes on
  // buggy code, so THESE rows are the fails-first proof.
  test('"reset my secret" / "reset my access key" / "revoke my secret" classify one-way', () => {
    for (const summary of ["reset my secret", "reset my access key", "revoke my secret"]) {
      const r = classifyQuestion({ summary });
      expect(r.oneWay).toBe(true);
      expect(r.reason).toBe("keyword");
    }
  });

  test("full verbs x nouns matrix classifies one-way (singular and plural)", () => {
    for (const verb of VERBS) {
      for (const noun of NOUNS) {
        for (const form of [noun, `${noun}s`]) {
          const r = classifyQuestion({ summary: `${verb} the production ${form}` });
          expect(r.oneWay).toBe(true);
          expect(r.reason).toBe("keyword");
        }
      }
    }
  });

  // Plural forms leaked before AND after the original #2024 report: \b(...)\b
  // cannot match "credentials" (no word boundary between the noun and its s).
  test('plurals: "rotate the credentials" / "revoke all tokens" / "reset the passwords" classify one-way', () => {
    for (const summary of ["rotate the credentials", "revoke all tokens", "reset the passwords"]) {
      expect(classifyQuestion({ summary }).oneWay).toBe(true);
    }
  });

  test("benign summaries stay two-way (no over-match)", () => {
    for (const summary of [
      "reset the flaky test runner",
      "rotate the log files nightly",
      "revoke the meeting invite",
    ]) {
      expect(classifyQuestion({ summary }).oneWay).toBe(false);
    }
  });
});
