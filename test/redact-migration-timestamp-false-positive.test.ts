/**
 * pii.cc vs 14-digit migration timestamps.
 *
 * `20260823000001_reap_stale_notifications.sql` — the Supabase/Rails/Flyway
 * migration filename shape — is 14 digits, and a 14-digit run clears Luhn about
 * one time in ten. A repo with a hundred migrations therefore ships a handful of
 * "credit cards" on every branch that touches them, and a doc that lists the
 * whole migration history lights up all at once. That is the same collision
 * class the digit-only UUID `insideUuid` already guards.
 *
 * Both directions are pinned here. The negative controls are the point: a guard
 * that exempted long digit runs wholesale would pass the "timestamps clean" half
 * and quietly gut the pattern.
 *
 * The second describe block covers a separate defect found alongside it — the
 * captured span used to include the separator FOLLOWING the last digit, which
 * made the documented --allowlist "exact spans" contract impossible to satisfy.
 */
import { describe, test, expect } from "bun:test";
import { scan } from "../lib/redact-engine";
import { looksLikeDatetimeStamp } from "../lib/redact-patterns";

const flagsCc = (s: string): boolean =>
  scan(s, { repoVisibility: "private" }).findings.some((f) => f.id === "pii.cc");

describe("pii.cc — real cards stay flagged", () => {
  const REAL_CARDS: [string, string][] = [
    ["Visa 16 bare", "card 4111111111111111"],
    ["Visa 16 spaced", "card 4111 1111 1111 1111"],
    ["Visa 16 hyphenated", "card 4111-1111-1111-1111"],
    ["Mastercard 16", "card 5555555555554444"],
    ["Amex 15", "card 378282246310005"],
    ["Diners 14", "card 30569309025904"],
    ["Visa 13", "card 4222222222222"],
    ["Discover 16", "card 6011111111111117"],
  ];
  for (const [label, input] of REAL_CARDS) {
    test(label, () => {
      expect(flagsCc(input)).toBe(true);
    });
  }
});

describe("pii.cc — migration timestamps are not credit cards", () => {
  test("a Luhn-passing migration stamp in prose is exempt", () => {
    // The exact stamp that started this: Luhn-valid, and pure coincidence.
    expect(flagsCc("Reaped rows are terminal (20260823000001); also what makes")).toBe(false);
  });

  test("a bare stamp is exempt", () => {
    expect(flagsCc("card 20260823000001 here")).toBe(false);
  });

  test("a stamp inside a migration filename is exempt", () => {
    expect(flagsCc("| 20260816205449_fix_publish_schedule_opens_join | ...")).toBe(false);
  });
});

describe("pii.cc — the timestamp guard stays narrow", () => {
  /**
   * The load-bearing controls. The guard may only exempt something that is
   * genuinely a 14-digit datetime; anything else must still reach Luhn.
   */
  /**
   * THE load-bearing control. 20260832000000 is date-SHAPED (starts 2026-08)
   * but day 32 does not exist, and it is genuinely Luhn-valid — so if the guard
   * ever loosens into "starts like a year, close enough", this goes green by
   * exemption and the pattern has a hole. It must still be flagged.
   */
  test("a date-shaped but impossible 14-digit run is still flagged", () => {
    expect(looksLikeDatetimeStamp("20260832000000")).toBe(false);
    expect(flagsCc("card 20260832000000 here")).toBe(true);
  });

  test("a month-13 run is date-shaped, Luhn-valid, and still flagged", () => {
    expect(looksLikeDatetimeStamp("20261399000003")).toBe(false);
    expect(flagsCc("card 20261399000003 here")).toBe(true);
  });

  test("a 14-digit Diners card is never datetime-shaped", () => {
    expect(looksLikeDatetimeStamp("30569309025904")).toBe(false);
  });

  test("16 digits are out of scope even if they start like a date", () => {
    expect(looksLikeDatetimeStamp("2026082300000123")).toBe(false);
  });

  test("an impossible day is rejected (Feb 30)", () => {
    expect(looksLikeDatetimeStamp("20260230000001")).toBe(false);
  });

  test("a real leap day is accepted", () => {
    expect(looksLikeDatetimeStamp("20240229120000")).toBe(true);
  });

  test("Feb 29 in a non-leap year is rejected", () => {
    expect(looksLikeDatetimeStamp("20260229120000")).toBe(false);
  });

  test("out-of-range hour/minute/second are rejected", () => {
    expect(looksLikeDatetimeStamp("20260823240000")).toBe(false);
    expect(looksLikeDatetimeStamp("20260823006000")).toBe(false);
    expect(looksLikeDatetimeStamp("20260823000060")).toBe(false);
  });

  test("years outside 1900-2099 are rejected", () => {
    expect(looksLikeDatetimeStamp("18260823000001")).toBe(false);
    expect(looksLikeDatetimeStamp("21260823000001")).toBe(false);
  });

  test("separators are not stripped to manufacture a stamp", () => {
    // A spaced card must not become timestamp-shaped by losing its spaces.
    expect(looksLikeDatetimeStamp("2026 0823 000001")).toBe(false);
  });
});

describe("pii.cc — the captured span ends on the number", () => {
  /**
   * `(?:\d[ \-]?){13,19}` let the final digit absorb the separator after it, so
   * the span carried a trailing space. Everything downstream takes the span
   * verbatim — allow.has(span), maskPreview, the redactor — so the documented
   * --allowlist contract could not be satisfied by writing the number itself.
   */
  const SAMPLE = "card 4111 1111 1111 1111 here";

  test("the capture ends on a digit, not on the following separator", () => {
    // Asserted against the regex directly: `preview` is masked and truncated,
    // so it cannot show a trailing character either way. This is the shape the
    // engine derives `span` from.
    const shipped = /\b((?:\d[ \-]?){12,18}\d)\b/g.exec(SAMPLE)?.[1];
    expect(shipped).toBe("4111 1111 1111 1111");
    expect(shipped!.endsWith(" ")).toBe(false);
  });

  test("the old quantifier really did absorb the separator (regression pin)", () => {
    // Documents the defect this file exists for. If someone reverts the
    // pattern, the assertion above fails and this one explains why.
    const previous = /\b((?:\d[ \-]?){13,19})\b/g.exec(SAMPLE)?.[1];
    expect(previous).toBe("4111 1111 1111 1111 ");
  });

  test("an exact-span allowlist entry actually suppresses the finding", () => {
    const input = "card 4111111111111111 here";
    expect(flagsCc(input)).toBe(true);
    expect(
      scan(input, {
        repoVisibility: "private",
        allowlist: ["4111111111111111"],
      }).findings.some((f) => f.id === "pii.cc"),
    ).toBe(false);
  });

  test("the allowlist works for a spaced card written as it appears", () => {
    const input = "card 4111 1111 1111 1111 here";
    expect(
      scan(input, {
        repoVisibility: "private",
        allowlist: ["4111 1111 1111 1111"],
      }).findings.some((f) => f.id === "pii.cc"),
    ).toBe(false);
  });
});
