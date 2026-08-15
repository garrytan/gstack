/**
 * pii.phone.e164 vs county tax-map parcel IDs (APNs).
 *
 * A parcel ID reads as a national-format phone number to the e164 pattern —
 * the same collision class as the digit-only UUID `insideUuid` already guards.
 * Land, title and property-tax repos carry these by the hundred, so the noise
 * is not incidental; it arrives on every branch that touches the domain.
 *
 * The guard has to be narrow, so this file pins BOTH directions: parcels stay
 * clean, and every real phone shape stays flagged. The negative controls are
 * the point — a guard that exempted long digit runs wholesale would pass the
 * "parcels clean" half and quietly gut the pattern.
 */
import { describe, test, expect } from "bun:test";
import { scan } from "../lib/redact-engine";
import { looksLikeParcelId } from "../lib/redact-patterns";

const flagsPhone = (s: string): boolean =>
  scan(s, { repoVisibility: "private" }).findings.some((f) => f.id === "pii.phone.e164");

describe("pii.phone.e164 — real phone numbers stay flagged", () => {
  const REAL_PHONES: [string, string][] = [
    ["US dashed", "call 415-555-0123 now"],
    ["US parens", "phone: (415) 555-0123"],
    ["US dotted", "p 415.555.0123"],
    ["E.164 US", "tel: +14155550123"],
    ["E.164 US spaced", "contact +1 415 555 0123"],
    ["E.164 UK", "ring +44 20 7946 0958"],
    ["E.164 DE", "fon +49 30 901820"],
    ["E.164 PT 12-digit", "reach +351912345678"],
    ["bare 11-digit", "operator 14155550123 ext"],
  ];
  for (const [label, input] of REAL_PHONES) {
    test(label, () => {
      expect(flagsPhone(input)).toBe(true);
    });
  }
});

describe("pii.phone.e164 — parcel IDs are not phone numbers", () => {
  test("dotted APN is exempt on shape alone", () => {
    expect(flagsPhone('  parcel_id: "12-3456789.000",')).toBe(false);
  });

  test("a normalized APN is exempt when paired with its punctuated form", () => {
    expect(
      flagsPhone('  parcel_id: "12-3456789.000",\n  norm: "123456789000",'),
    ).toBe(false);
  });

  test("8-digit middle is still an APN", () => {
    expect(flagsPhone('apn "30-00414123.0001"')).toBe(false);
  });
});

describe("pii.phone.e164 — the guard stays narrow", () => {
  /**
   * The load-bearing control. A bare digit run is phone-shaped in isolation, so
   * it may only be exempted by EVIDENCE — a punctuated APN in the surrounding
   * window. With no such twin, the finding must survive. If this ever goes
   * green-by-exemption, the guard has become a blanket hole in the pattern.
   */
  test("a bare digit run with no punctuated APN nearby is still flagged", () => {
    expect(flagsPhone('norm: "123456789000",')).toBe(true);
  });

  test("hyphen-only APN variants are NOT exempted by shape", () => {
    // 22-0001-000 is genuinely phone-shaped; only the dotted form earns a
    // shape-based pass. This one may only be cleared by the evidence tier.
    expect(looksLikeParcelId("22-0001-000", /(.*)/.exec("22-0001-000")!)).toBe(false);
  });

  test("evidence pairing requires an exact digit match, not a prefix", () => {
    // A near-miss APN in the window must not clear a different digit run.
    expect(flagsPhone('  parcel_id: "12-3456789.000",\n  other: "999888777666",')).toBe(true);
  });
});
