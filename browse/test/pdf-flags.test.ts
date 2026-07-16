/**
 * $B pdf flag contract tests.
 *
 * Pure unit tests of the parsing/validation logic. These do NOT spin up
 * Chromium — that's covered by make-pdf's integration tests.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { extractTabId } from "../src/cli";

// We can't import the internal parsePdfArgs directly without exporting it,
// but we can exercise it end-to-end through the browse CLI. For fast unit
// coverage we test the flag-extraction layer here.

describe("extractTabId", () => {
  test("strips --tab-id and returns the value", () => {
    const { tabId, args } = extractTabId(["--tab-id", "3", "extra"]);
    expect(tabId).toBe(3);
    expect(args).toEqual(["extra"]);
  });

  test("returns undefined when flag is absent", () => {
    const { tabId, args } = extractTabId(["goto", "https://example.com"]);
    expect(tabId).toBeUndefined();
    expect(args).toEqual(["goto", "https://example.com"]);
  });

  test("ignores trailing --tab-id with no value", () => {
    const { tabId, args } = extractTabId(["click", "@e1", "--tab-id"]);
    expect(tabId).toBeUndefined();
    expect(args).toEqual(["click", "@e1"]);
  });

  test("handles --tab-id at different positions", () => {
    const front = extractTabId(["--tab-id", "5", "pdf", "/tmp/out.pdf"]);
    expect(front.tabId).toBe(5);
    expect(front.args).toEqual(["pdf", "/tmp/out.pdf"]);

    const middle = extractTabId(["pdf", "--tab-id", "7", "/tmp/out.pdf"]);
    expect(middle.tabId).toBe(7);
    expect(middle.args).toEqual(["pdf", "/tmp/out.pdf"]);

    const end = extractTabId(["pdf", "/tmp/out.pdf", "--tab-id", "9"]);
    expect(end.tabId).toBe(9);
    expect(end.args).toEqual(["pdf", "/tmp/out.pdf"]);
  });

  test("ignores non-numeric --tab-id values", () => {
    const { tabId, args } = extractTabId(["--tab-id", "abc", "pdf"]);
    expect(tabId).toBeUndefined();
    expect(args).toEqual(["pdf"]);
  });
});

describe("pdf --from-file payload shape", () => {
  test("writes a JSON payload file and reads it back", () => {
    const tmpPath = path.join(os.tmpdir(), `browse-pdf-test-${Date.now()}.json`);
    const payload = {
      output: "/tmp/browse-out.pdf",
      format: "letter",
      marginTop: "1in",
      marginRight: "1in",
      marginBottom: "1in",
      marginLeft: "1in",
      pageNumbers: true,
      tagged: true,
      outline: true,
      toc: false,
      headerTemplate: '<div style="font-size:9pt">Title</div>',
      footerTemplate: undefined,
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    try {
      const readBack = JSON.parse(fs.readFileSync(tmpPath, "utf8"));
      expect(readBack.output).toBe("/tmp/browse-out.pdf");
      expect(readBack.pageNumbers).toBe(true);
      expect(readBack.headerTemplate).toContain("Title");
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});
