/**
 * Auto-redact tests (T15) — applyRedactions() substitutes redact tokens for the
 * cleanly-substitutable PII patterns, right-to-left so offsets stay valid,
 * refuses to mangle structural tokens, and is idempotent (re-scan after = clean).
 */
import { describe, test, expect } from "bun:test";
import { applyRedactions, scan } from "../lib/redact-engine";

describe("applyRedactions", () => {
  test("substitutes email + phone tokens", () => {
    const input = "contact me at alice@corp.io or +14155550123 today";
    const { body } = applyRedactions(input, ["pii.email", "pii.phone.e164"], {
      repoVisibility: "private",
    });
    expect(body).toContain("<REDACTED-EMAIL>");
    expect(body).toContain("<REDACTED-PHONE>");
    expect(body).not.toContain("alice@corp.io");
    expect(body).not.toContain("4155550123");
  });

  test("multiple findings on one line redact correctly (right-to-left)", () => {
    const input = "a@x.io and b@y.io and c@z.io";
    const { body } = applyRedactions(input, ["pii.email"], { repoVisibility: "private" });
    expect(body).toBe("<REDACTED-EMAIL> and <REDACTED-EMAIL> and <REDACTED-EMAIL>");
  });

  test("idempotent: re-scanning the redacted body finds no PII", () => {
    const input = "ssn 123-45-6789 card 4111111111111111 mail x@corp.io";
    const { body } = applyRedactions(
      input,
      ["pii.ssn", "pii.cc", "pii.email"],
      { repoVisibility: "private" },
    );
    const after = scan(body, { repoVisibility: "private" });
    const piiLeft = after.findings.filter((f) => f.category === "pii");
    expect(piiLeft).toHaveLength(0);
  });

  test("produces an ASCII unified diff preview", () => {
    const input = "reach alice@corp.io";
    const { diff } = applyRedactions(input, ["pii.email"], { repoVisibility: "private" });
    expect(diff).toContain("- reach alice@corp.io");
    expect(diff).toContain("+ reach <REDACTED-EMAIL>");
  });

  test("refuses to redact a span inside a markdown link target (structural guard)", () => {
    const input = "see [profile](https://x.io/u/alice@corp.io)";
    const { body, skipped } = applyRedactions(input, ["pii.email"], {
      repoVisibility: "private",
    });
    // structural guard: not auto-redacted, surfaced as skipped
    expect(skipped.some((f) => f.id === "pii.email")).toBe(true);
    expect(body).toContain("alice@corp.io");
  });

  test("non-autoRedactable ids are ignored", () => {
    const input = "host db1.corp internal";
    const { body } = applyRedactions(input, ["internal.hostname"], {
      repoVisibility: "private",
    });
    expect(body).toBe(input); // hostname is not autoRedactable
  });
});
