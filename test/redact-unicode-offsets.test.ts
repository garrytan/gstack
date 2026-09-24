import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { applyRedactions, normalizeWithMap, redactFindingSpans, scan } from "../lib/redact-engine";
import { redact, sanitizeForJson } from "../lib/cso/process";

const secret = ["8Fk2pQ9vXz4wL7mN", "3rT6yB1cD5eG0hJq"].join("");

describe("normalized redaction offsets use UTF-16 units", () => {
  test("every BMP input maps every emitted UTF-16 unit and the end sentinel", () => {
    const mismatches: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const { normalized, map } = normalizeWithMap(String.fromCharCode(code));
      if (map.length !== normalized.length + 1
        || map[normalized.length] !== 1
        || map.slice(0, -1).some((offset) => offset !== 0)) {
        mismatches.push(code);
      }
    }
    expect(mismatches).toEqual([]);
  });

  for (const count of [0, 1, 64]) {
    test(`${count} supplementary NFKC expansions preserve the exact credential span`, () => {
      const prefix = "\uFA6C".repeat(count) + "\n";
      const suffix = "\n" + "z".repeat(256);
      const input = `${prefix}DB_PASSWORD=${secret}${suffix}`;
      const expected = `${prefix}DB_PASSWORD=<REDACTED-env.kv>${suffix}`;
      expect(redactFindingSpans(input)).toBe(expected);
      expect(scan(input).findings.map(({ id, line, col }) => ({ id, line, col })))
        .toEqual([{ id: "env.kv", line: 2, col: 13 }]);
      expect(redact(input)).toBe(expected);
      expect(sanitizeForJson({ output: input })).toEqual({ output: expected });
    });
  }

  test("supplementary source text, entities, and zero-width input retain their original bytes", () => {
    const prefix = "\u{242EE} &amp; \u200b\n";
    const value = `${secret.slice(0, 9)}\u200b${secret.slice(9)}`;
    const input = `${prefix}DB_PASSWORD=${value}\r\nend`;
    const { normalized, map } = normalizeWithMap(input);
    expect(map).toHaveLength(normalized.length + 1);
    expect(map[normalized.length]).toBe(input.length);
    expect(redactFindingSpans(input)).toBe(`${prefix}DB_PASSWORD=<REDACTED-env.kv>\r\nend`);
  });

  for (const suffix of ["", " after"]) {
    test(`both masking APIs preserve exact email boundaries with suffix ${JSON.stringify(suffix)}`, () => {
      const prefix = "\uFA6C contact: ";
      const input = prefix + "reviewer@audit.invalid" + suffix;
      expect(redactFindingSpans(input)).toBe(prefix + "<REDACTED-pii.email>" + suffix);
      const result = applyRedactions(input, ["pii.email"]);
      expect(result.body).toBe(prefix + "<REDACTED-EMAIL>" + suffix);
      expect(result.skipped).toEqual([]);
    });
  }

  test("the actual auto-redact CLI masks a detected email at EOF after supplementary expansion", () => {
    const prefix = "\uFA6C contact: ";
    const input = prefix + "reviewer@audit.invalid";
    const result = Bun.spawnSync([
      process.execPath, path.resolve(import.meta.dir, "../bin/gstack-redact"), "--auto-redact", "pii.email",
    ], { stdin: Buffer.from(input), timeout: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(prefix + "<REDACTED-EMAIL>");
    expect(result.stderr.toString()).not.toContain("could not be auto-redacted");
  });
});
