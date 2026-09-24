import { describe, expect, test } from "bun:test";
import { redactFindingSpans, scan } from "../lib/redact-engine";
import { redact, sanitizeForJson } from "../lib/cso/process";

const secret = ["8Fk2pQ9vXz4wL7mN", "3rT6yB1cD5eG0hJq"].join("");
const marker = "<REDACTED-env.kv>";

describe("redaction binds each finding to its original span", () => {
  test("never masks a later unflagged assignment instead of the flagged value", () => {
    const input = `DB_PASSWORD=${secret}\nOTHER_API_KEY="your-api-key-here"`;
    expect(scan(input).findings.map((f) => f.id)).toEqual(["env.kv"]);
    expect(redactFindingSpans(input)).toBe(`DB_PASSWORD=${marker}\nOTHER_API_KEY="your-api-key-here"`);
  });

  test("literal example values are suppressed before redaction", () => {
    const input = `DB_PASSWORD=synthetic-example-secret\nOTHER_API_KEY="your-api-key-here"`;
    expect(scan(input).findings).toEqual([]);
    expect(redactFindingSpans(input)).toBe(input);
  });

  for (const [name, prefix, suffix] of [
    ["first line", "", ""],
    ["later line", "unrelated line\n", "\nend"],
    ["indented", "header\n    ", ""],
    ["CRLF", "header\r\n", "\r\nend"],
  ]) {
    test(`${name}: masks the captured value and keeps surrounding text`, () => {
      const input = `${prefix}DB_PASSWORD=${secret}${suffix}`;
      expect(scan(input).findings.map((f) => f.id)).toEqual(["env.kv"]);
      expect(redactFindingSpans(input)).toBe(`${prefix}DB_PASSWORD=${marker}${suffix}`);
    });
  }

  test("repeated identical values map independently, preserving unflagged neighbors", () => {
    const input = `DB_PASSWORD=${secret}\nOTHER_API_KEY="your-api-key-here"\nAPI_KEY=${secret}`;
    expect(scan(input).findings.map((f) => f.id)).toEqual(["env.kv", "env.kv"]);
    expect(redactFindingSpans(input)).toBe(`DB_PASSWORD=${marker}\nOTHER_API_KEY="your-api-key-here"\nAPI_KEY=${marker}`);
  });

  test("many findings retain exact order without per-finding raw rescans", () => {
    const input = Array.from({ length: 300 }, (_, i) => `API_KEY=${secret}${i.toString(36)}`).join("\n");
    const output = redactFindingSpans(input);
    expect(scan(input).findings).toHaveLength(300);
    expect(output).toBe(Array.from({ length: 300 }, () => `API_KEY=${marker}`).join("\n"));
  });

  test("normalization maps fullwidth Unicode, entity text, and zero-width bytes back to original span", () => {
    const encoded = `${secret.slice(0, 9)}＆${secret.slice(9)}`;
    const entity = `${secret.slice(0, 9)}&amp;${secret.slice(9)}`;
    const invisible = `${secret.slice(0, 9)}\u200b${secret.slice(9)}`;
    for (const value of [encoded, entity, invisible]) {
      const input = `DB_PASSWORD=${value}\nOTHER_API_KEY="your-api-key-here"`;
      expect(scan(input).findings.map((f) => f.id)).toEqual(["env.kv"]);
      expect(redactFindingSpans(input)).toBe(`DB_PASSWORD=${marker}\nOTHER_API_KEY="your-api-key-here"`);
    }
  });

  test("overlapping JWT and Bearer findings coalesce; marker-only and unlocated oversize finding still withhold", () => {
    const part = "Ab3dE6fGh8Ij9Kl0Mn1O";
    const jwt = `eyJ${part}.eyJ${part}.${part}`;
    expect(scan(`Authorization: Bearer ${jwt}`).findings.map((f) => f.id)).toEqual(["auth.bearer", "jwt"]);
    expect(redactFindingSpans(`Authorization: Bearer ${jwt}`)).toMatch(/^Authorization: Bearer <REDACTED-[a-z.+]+>$/);
    expect(redactFindingSpans("-----BEGIN " + "PRIVATE KEY-----\nbody")).toBeNull();
    expect(redactFindingSpans(`DB_PASSWORD=${secret}`, { maxBytes: 10 })).toBeNull();
  });

  test("CSO process and JSON output use the exact span, without dropping safe context", () => {
    const input = `DB_PASSWORD=${secret}\nOTHER_API_KEY="your-api-key-here"`;
    expect(redact(input)).toBe(`DB_PASSWORD=${marker}\nOTHER_API_KEY="your-api-key-here"`);
    expect(sanitizeForJson({ output: input })).toEqual({ output: `DB_PASSWORD=${marker}\nOTHER_API_KEY="your-api-key-here"` });
  });
});
