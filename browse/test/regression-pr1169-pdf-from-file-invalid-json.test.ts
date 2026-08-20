/**
 * Regression test for PR #1169 bug #7 — `pdf --from-file` ran JSON.parse on
 * user-supplied file contents with no try/catch. A malformed payload crashed
 * the pdf handler with a raw SyntaxError. Codex flagged that JSON.parse
 * accepts primitives too (numbers, strings, null) and Array.isArray must be
 * checked separately, so the fix added an explicit object-shape gate.
 *
 * Test surface: parsePdfFromFile, exported for tests at meta-commands.ts:139.
 * All fixtures land in process.cwd() (SAFE_DIRECTORIES allows TEMP_DIR or cwd;
 * cwd is universally safe on every platform our CI runs on).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { parsePdfFromFile } from "../src/meta-commands";

const FIXTURE_DIR = fs.mkdtempSync(path.join(process.cwd(), "pr1169-pdf-"));

beforeAll(() => {
  // mkdtempSync already created the dir
});

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function writeFixture(name: string, body: string): string {
  const p = path.join(FIXTURE_DIR, name);
  fs.writeFileSync(p, body);
  return p;
}

describe("parsePdfFromFile — invalid JSON regression (PR #1169 bug #7)", () => {
  test("invalid JSON: throws with file path AND parser detail", () => {
    const p = writeFixture("invalid.json", "{ not-json");
    expect(() => parsePdfFromFile(p)).toThrow(/not valid JSON/);
    expect(() => parsePdfFromFile(p)).toThrow(p);
  });

  test("empty file: throws JSON-parse style error", () => {
    const p = writeFixture("empty.json", "");
    // Empty string is invalid JSON per ECMA-404.
    expect(() => parsePdfFromFile(p)).toThrow(/not valid JSON/);
  });

  test("top-level array: throws 'must be a JSON object' with type", () => {
    const p = writeFixture("array.json", JSON.stringify(["a", "b"]));
    expect(() => parsePdfFromFile(p)).toThrow(/must be a JSON object/);
    expect(() => parsePdfFromFile(p)).toThrow(/array/);
  });

  test("top-level number: throws with 'number' type label", () => {
    const p = writeFixture("number.json", "42");
    expect(() => parsePdfFromFile(p)).toThrow(/must be a JSON object/);
    expect(() => parsePdfFromFile(p)).toThrow(/number/);
  });

  test("top-level string: throws with 'string' type label", () => {
    const p = writeFixture("string.json", JSON.stringify("hello"));
    expect(() => parsePdfFromFile(p)).toThrow(/must be a JSON object/);
    expect(() => parsePdfFromFile(p)).toThrow(/string/);
  });

  test("top-level null: throws with 'object' type label (JS null typeof === object)", () => {
    const p = writeFixture("null.json", "null");
    // null passes typeof === 'object' but the fix's `=== null` branch catches it.
    expect(() => parsePdfFromFile(p)).toThrow(/must be a JSON object/);
  });

  test("top-level boolean: throws with 'boolean' type label", () => {
    const p = writeFixture("bool.json", "true");
    expect(() => parsePdfFromFile(p)).toThrow(/must be a JSON object/);
    expect(() => parsePdfFromFile(p)).toThrow(/boolean/);
  });

  test("valid object: parses successfully (happy-path regression)", () => {
    const p = writeFixture("valid.json", JSON.stringify({ format: "A4", pageNumbers: true }));
    const result = parsePdfFromFile(p);
    expect(result.format).toBe("A4");
    expect(result.pageNumbers).toBe(true);
  });
});
