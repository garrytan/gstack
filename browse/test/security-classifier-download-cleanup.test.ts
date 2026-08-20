/**
 * Regression test for PR #1169 bug #6 — downloadFile opened a WriteStream to
 * `<dest>.tmp.<pid>` but never closed it on error paths. If the reader or
 * writer threw mid-download, the FD leaked and the half-written tmp could
 * be promoted by a retry's renameSync.
 *
 * The fix wraps the read loop in try/catch and runs `writer.destroy()` +
 * `fs.unlinkSync(tmp)` before rethrowing.
 *
 * Per codex's pushback, this test must exercise BOTH the reader-throws path
 * and the non-2xx-response path, and it must NOT assume the specific tmp
 * filename — only that no `<dest>.tmp.*` sibling remains.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { downloadFile } from "../src/security-classifier";

function tmpSiblings(destDir: string, destBase: string): string[] {
  if (!fs.existsSync(destDir)) return [];
  return fs.readdirSync(destDir).filter((f) =>
    f.startsWith(destBase + ".tmp.")
  );
}

let FIXTURE_DIR = "";
let originalFetch: typeof fetch;

beforeAll(() => {
  FIXTURE_DIR = fs.mkdtempSync(path.join(process.cwd(), "pr1169-dl-"));
});

afterAll(() => {
  if (FIXTURE_DIR) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("downloadFile error-path cleanup (PR #1169 bug #6)", () => {
  test("reader rejects mid-stream: throws, no dest, no tmp sibling left", async () => {
    const dest = path.join(FIXTURE_DIR, "reader-fail-model.bin");
    const destDir = path.dirname(dest);
    const destBase = path.basename(dest);

    // Build a ReadableStream that emits one chunk then errors on second pull.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      pull(controller) {
        // Second pull triggers the failure path the fix protects against.
        controller.error(new Error("simulated mid-stream read failure"));
      },
    });

    // @ts-expect-error — overwrite global fetch for the test
    globalThis.fetch = async () =>
      new Response(body, { status: 200, statusText: "OK" });

    await expect(downloadFile("https://example.com/model.bin", dest)).rejects.toThrow(
      /simulated mid-stream read failure/
    );

    expect(fs.existsSync(dest)).toBe(false);
    expect(tmpSiblings(destDir, destBase)).toEqual([]);
  });

  test("non-2xx response: throws with status, no tmp file created", async () => {
    const dest = path.join(FIXTURE_DIR, "http500-model.bin");
    const destDir = path.dirname(dest);
    const destBase = path.basename(dest);

    // @ts-expect-error — overwrite global fetch for the test
    globalThis.fetch = async () =>
      new Response("server boom", { status: 500, statusText: "Server Error" });

    await expect(downloadFile("https://example.com/model.bin", dest)).rejects.toThrow(
      /Failed to fetch.*500/
    );

    expect(fs.existsSync(dest)).toBe(false);
    expect(tmpSiblings(destDir, destBase)).toEqual([]);
  });

  test("missing body: throws, no tmp file created", async () => {
    const dest = path.join(FIXTURE_DIR, "nobody-model.bin");
    const destDir = path.dirname(dest);
    const destBase = path.basename(dest);

    // Response with null body (some upstreams send this on edge errors).
    // @ts-expect-error — overwrite global fetch for the test
    globalThis.fetch = async () =>
      new Response(null, { status: 200, statusText: "OK" });

    await expect(downloadFile("https://example.com/model.bin", dest)).rejects.toThrow(
      /Failed to fetch/
    );

    expect(fs.existsSync(dest)).toBe(false);
    expect(tmpSiblings(destDir, destBase)).toEqual([]);
  });

  test("happy path: 2xx body completes, dest exists, no tmp sibling remains", async () => {
    const dest = path.join(FIXTURE_DIR, "ok-model.bin");
    const destDir = path.dirname(dest);
    const destBase = path.basename(dest);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([9, 9, 9, 9]));
        controller.close();
      },
    });

    // @ts-expect-error — overwrite global fetch for the test
    globalThis.fetch = async () =>
      new Response(body, { status: 200, statusText: "OK" });

    await downloadFile("https://example.com/model.bin", dest);

    expect(fs.existsSync(dest)).toBe(true);
    expect(tmpSiblings(destDir, destBase)).toEqual([]);
    const written = fs.readFileSync(dest);
    expect(Array.from(written)).toEqual([9, 9, 9, 9]);

    fs.unlinkSync(dest);
  });
});

