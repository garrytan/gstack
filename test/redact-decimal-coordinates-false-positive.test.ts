/**
 * pii.phone.e164 vs decimal coordinates.
 *
 * `37.6188 101.694` parses as 37 · 6188 · 101 · 694 and `100 64.5326 100` as
 * 100 · 64 · 5326 · 100 — four phone groups with legal separators — so the
 * e164 pattern flags them. They are SVG path coordinates, and a hand-drawn
 * icon carries dozens per path. Mesh vertices and lat/long pairs have the same
 * shape. Same collision class as the parcel ID (see
 * redact-parcel-id-false-positive.test.ts).
 *
 * The guard is a shape test, so this file pins BOTH directions: coordinate
 * runs stay clean, and every real phone shape — dotted, spaced, dashed,
 * E.164 — stays flagged. A guard that exempted "anything with a dot in it"
 * would pass the first half and gut the pattern.
 */
import { describe, test, expect } from "bun:test";
import { scan } from "../lib/redact-engine";
import { looksLikeDecimalCoordinates } from "../lib/redact-patterns";

const flagsPhone = (s: string): boolean =>
  scan(s, { repoVisibility: "private" }).findings.some((f) => f.id === "pii.phone.e164");

describe("pii.phone.e164 — real phone numbers stay flagged", () => {
  const REAL_PHONES: [string, string][] = [
    ["US dashed", "call 415-555-0123 now"],
    ["US parens", "phone: (415) 555-0123"],
    ["US dotted", "p 415.555.0123"],
    ["US dotted, spaced country code", "tel +1 415.555.0123"],
    ["E.164 US", "tel: +14155550123"],
    ["E.164 US spaced", "contact +1 415 555 0123"],
    ["E.164 UK", "ring +44 20 7946 0958"],
    ["E.164 DE", "fon +49 30 901820"],
    ["bare 11-digit", "operator 14155550123 ext"],
  ];
  for (const [label, input] of REAL_PHONES) {
    test(label, () => {
      expect(flagsPhone(input)).toBe(true);
    });
  }
});

describe("pii.phone.e164 — decimal coordinates are not phone numbers", () => {
  test("an SVG path segment", () => {
    expect(flagsPhone("M50 1C1 2 37.6188 101.694 51.6863 99.4363Z")).toBe(false);
  });

  test("an integer beside a decimal: the frame icon's corner", () => {
    expect(flagsPhone("L99.4867 64.3031ZM99.4867 64.3031C99.7705 64.3031 100 64.5326 100 64.8164V93")).toBe(false);
  });

  test("a whole Figma-exported path in a TS string", () => {
    const d =
      "d: 'C23.3186 97.0881 37.6188 101.694 51.6863 99.4363C65.7538 97.1774 " +
      "77.8756 88.3251 84.275 75.6431C90.6743 62.961 90.5669 47.9929 83.9926 35.3991Z',";
    expect(flagsPhone(d)).toBe(false);
  });

  test("mesh vertex triples", () => {
    expect(flagsPhone("v 12.3456 100.125 7.5\nv 45.6789 200.500 8.25")).toBe(false);
  });

  test("a lat/long pair", () => {
    expect(flagsPhone("51.5074 100.1278")).toBe(false);
  });
});

describe("pii.phone.e164 — the guard stays narrow", () => {
  test("a dotted phone is one token with two dots, not a decimal", () => {
    expect(looksLikeDecimalCoordinates("415.555.0123")).toBe(false);
    expect(looksLikeDecimalCoordinates("+1 415.555.0123")).toBe(false);
  });

  test("a spaced phone has no decimal token", () => {
    expect(looksLikeDecimalCoordinates("+1 415 555 0123")).toBe(false);
    expect(looksLikeDecimalCoordinates("44 20 7946 0958")).toBe(false);
  });

  test("a lone decimal is not a run", () => {
    expect(looksLikeDecimalCoordinates("4155550123.5")).toBe(false);
  });

  test("the shapes it exempts", () => {
    expect(looksLikeDecimalCoordinates("37.6188 101.694")).toBe(true);
    expect(looksLikeDecimalCoordinates("100 64.5326 100")).toBe(true);
  });

  /**
   * The accepted cost, written down: a single dotted group beside a spaced
   * one is not a convention anywhere, and it is the price of exempting the
   * integer-beside-decimal run above. If a real format turns up that writes
   * this, the guard needs evidence from context rather than shape.
   */
  test("conceded: one dotted group beside a spaced group", () => {
    expect(looksLikeDecimalCoordinates("415 555.0123")).toBe(true);
  });
});
