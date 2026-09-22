import { describe, expect, test } from "bun:test";
import { redactFindingSpans, scan } from "../lib/redact-engine";

const OPTS = { repoVisibility: "private" as const };

// #2912: `/cso` withheld 283 of 397 source files, leaving the audit
// unassessable. locateSpan resumed the scan at the finding's span, but a
// finding's col points at the capture group, which sits after the start of
// the match. `env.kv` is `^`-anchored, so the only position its `^` can match
// is the line start — already behind the resume point. exec found nothing,
// locateSpan returned -1, and redactFindingSpans returned null, which the
// caller reads as "cannot mask, drop the whole file".
describe("locateSpan relocates ^-anchored patterns (#2912)", () => {
  const cases: Array<[string, string]> = [
    ["assignment below the first line", 'import os\n\nAPI_KEY = os.environ["OPENAI_API_KEY"]\n'],
    ["assignment on the first line", 'API_KEY = os.environ["OPENAI_API_KEY"]\nprint(API_KEY)'],
    ["indented assignment", 'def load():\n    API_TOKEN = os.environ.get("SVC_API_TOKEN")\n'],
  ];

  for (const [name, src] of cases) {
    test(`${name}: the file is masked, not dropped`, () => {
      // Precondition: env.kv fires here, so the egress path must mask it.
      expect(scan(src, OPTS).findings.some((f) => f.id === "env.kv")).toBe(true);

      const out = redactFindingSpans(src, OPTS);
      expect(out).not.toBeNull();
      expect(out).toContain("<REDACTED-env.kv>");
    });
  }

  test("an ^-anchored match is masked at its own offset, not an adjacent one", () => {
    const src = ['FIRST_API_KEY = os.environ["A_KEY"]', 'SECOND_API_KEY = os.environ["B_KEY"]'].join("\n");
    const out = redactFindingSpans(src, OPTS);
    expect(out).not.toBeNull();
    // Both lines carry their own finding, so both get their own marker.
    expect(out!.match(/<REDACTED-env\.kv>/g)?.length).toBe(2);
    expect(out).toContain("FIRST_API_KEY = ");
    expect(out).toContain("SECOND_API_KEY = ");
  });

  test("a genuine inline secret is still masked (no regression)", () => {
    const src = 'DB_PASSWORD = "s3cr3t-Kx9mQ2vLp7Wn"';
    const out = redactFindingSpans(src, OPTS);
    expect(out).not.toBeNull();
    expect(out).not.toContain("s3cr3t-Kx9mQ2vLp7Wn");
  });
});
