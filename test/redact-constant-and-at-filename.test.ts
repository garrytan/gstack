/**
 * Two MEDIUM false positives from the gstack-evals runs (gstack 1.91.299-301):
 * pii.phone.e164 on `4294967296` (2^32, a PRNG constant) and pii.email on
 * `terminal-bench@2.0.json` (a package@version filename). Each guard is
 * pinned in both directions: the false positive is clean, and the real shape
 * next to it still reports.
 */
import { describe, test, expect } from "bun:test";
import { scan } from "../lib/redact-engine";
import { isNumericConstant, looksLikeAtFilename } from "../lib/redact-patterns";

const flags = (id: string, s: string): boolean =>
  scan(s, { repoVisibility: "private" }).findings.some((f) => f.id === id);

describe("pii.phone.e164 and bare numeric constants", () => {
  // Value: protects=a bare power of two (or one less) and the common 32-bit hash/PRNG constants raise no phone finding; fails_when=the guard is
  // removed and `4294967296` reports pii.phone.e164 again; why_new=no constant guard existed; seam=none (scan); no_claim=other constants not listed
  test("powers of two, their max values and hash/PRNG constants are not phone numbers", () => {
    for (const s of [
      "const RANGE = 4294967296;",
      "mask = 4294967295",
      "INT32_MAX 2147483647",
      "x % 2147483648",
      "1073741824 bytes",
      "2^49 is 562949953421312",
      "h *= 2654435761",
      "seed ^= 2654435769",
      "a = 1103515245",
      "basis 2166136261",
      "mt init 1812433253",
      "p = 4294967291",
    ]) {
      expect([s, flags("pii.phone.e164", s)]).toEqual([s, false]);
    }
    expect(isNumericConstant("4294967296")).toBe(true);
    expect(isNumericConstant("4294967297")).toBe(false);
  });

  // Value: protects=the same digits written as a phone number (a +, spaces, dashes, parens) and ordinary bare numbers still report; fails_when=the
  // guard exempts by digits alone or by length, so +14294967296 or 429-496-7296 goes quiet; why_new=pins the narrowness of the new guard;
  // seam=none (scan); no_claim=international formats beyond the ones listed
  test("real phone numbers still report, including the constant's digits in phone form", () => {
    for (const s of [
      "tel: +14294967296",
      "call 429-496-7296",
      "reach +1 429 496 7296",
      "phone (429) 496-7296",
      "p 429.496.7296",
      "call 4294967297 now",
      "ring +44 20 7946 0958",
      "office 4155550123",
    ]) {
      expect([s, flags("pii.phone.e164", s)]).toEqual([s, true]);
    }
  });
});

describe("pii.email and package@version filenames", () => {
  // Value: protects=a filename with an @ (package@version, or a name ending in a file extension that is not a TLD) raises no email finding;
  // fails_when=the guard is removed and terminal-bench@2.0.json reports pii.email again; why_new=no filename guard existed; seam=none (scan);
  // no_claim=extensions outside the closed list
  test("package@version and @-named files are not email addresses", () => {
    for (const s of [
      "results in terminal-bench@2.0.json",
      "npm pack wrote lodash@4.17.21.tgz",
      "config eslint-config@next.yaml",
      "cache react-dom@18.2.0.tar.gz",
      "pin left-pad@1.3.0.lock",
      "notes a@1.2.md",
    ]) {
      expect([s, flags("pii.email", s)]).toEqual([s, false]);
    }
    expect(looksLikeAtFilename("terminal-bench@2.0.json")).toBe(true);
  });

  // Value: protects=real addresses still report, including numeric domain labels (163.com, 1.2.com), TLDs that double as file extensions (.sh, .md,
  // .py, .zip) and a file named after an address; fails_when=the guard treats any digit label, any extension-like TLD or any trailing extension as a
  // filename; why_new=pins the narrowness of the new guard; seam=none (scan); no_claim=every IANA TLD
  test("real addresses still report, numeric domains and extension-shaped TLDs included", () => {
    for (const s of [
      "mail alex@acme-corp.com",
      "reach li.wei@163.com",
      "ops dev@acme.sh",
      "docs ops@acme.md",
      "py team@acme.py",
      "files sales@acme.zip",
      "contact jo@mail.acme.io",
      "reach alice@1.2.com",
      "export jane.doe@acme-corp.com.json",
      "log at ops-team@acme.io.log",
      "uploaded jdoe@acme-corp.com.PDF",
      "archive li.wei@163.com.tar.gz",
    ]) {
      expect([s, flags("pii.email", s)]).toEqual([s, true]);
    }
  });
});
