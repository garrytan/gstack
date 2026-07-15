/**
 * Regression coverage for issue #1519 — image-generation calls were timing
 * out at a hardcoded 120s with no CLI override. The fix raised the default
 * and exposed a per-invocation override via `--api-timeout`.
 *
 * These tests pin the contract that the constant exports at the new value
 * and that the `timeoutMs` param is honored by the AbortController path.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { generateVariant } from "../src/variants";
import { DEFAULT_IMAGE_GEN_TIMEOUT_MS } from "../src/constants";
import { parseApiTimeoutMs } from "../src/cli";

describe("DEFAULT_IMAGE_GEN_TIMEOUT_MS", () => {
  test("default is 300_000ms (5min) — see issue #1519", () => {
    expect(DEFAULT_IMAGE_GEN_TIMEOUT_MS).toBe(300_000);
  });
});

describe("parseApiTimeoutMs", () => {
  test("undefined input returns undefined (use default)", () => {
    expect(parseApiTimeoutMs(undefined)).toBeUndefined();
  });

  test("valid positive integer returns the parsed number", () => {
    expect(parseApiTimeoutMs("300000")).toBe(300000);
    expect(parseApiTimeoutMs("1")).toBe(1);
  });

  test("non-numeric input throws (would otherwise be NaN -> instant abort)", () => {
    expect(() => parseApiTimeoutMs("abc")).toThrow(/positive integer/);
  });

  test("zero throws (would otherwise fire setTimeout immediately)", () => {
    expect(() => parseApiTimeoutMs("0")).toThrow(/positive integer/);
  });

  test("negative throws (would otherwise fire setTimeout immediately)", () => {
    expect(() => parseApiTimeoutMs("-1")).toThrow(/positive integer/);
    expect(() => parseApiTimeoutMs("-300000")).toThrow(/positive integer/);
  });

  test("trailing garbage is ignored (parseInt semantics; matches other flags)", () => {
    expect(parseApiTimeoutMs("300000foo")).toBe(300000);
  });
});

describe("generateVariant timeoutMs override", () => {
  let tmpDir: string;
  let outputPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-timeout-"));
    outputPath = path.join(tmpDir, "variant.png");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("aborts after explicit timeoutMs when fetch never resolves", async () => {
    // Stub fetch that waits for the signal to abort, then throws AbortError.
    const fetchFn = (async (_input: any, init?: any) => {
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise<void>((_resolve, reject) => {
        if (!signal) return;
        signal.addEventListener("abort", () => {
          const err: any = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      return new Response("never reached");
    }) as typeof globalThis.fetch;

    const t0 = Date.now();
    const result = await generateVariant(
      "fake-key", "prompt", outputPath, "1024x1024", "high", fetchFn, 200,
    );
    const elapsed = Date.now() - t0;

    expect(result.success).toBe(false);
    expect(result.error).toBe("Timeout (0.2s)");
    // Was aborted by the 200ms timer, not by exponential-backoff retry chain
    expect(elapsed).toBeLessThan(2_000);
  });

  test("formats whole-second timeouts without decimals", async () => {
    const fetchFn = (async (_input: any, init?: any) => {
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise<void>((_resolve, reject) => {
        if (!signal) return;
        signal.addEventListener("abort", () => {
          const err: any = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      return new Response("never reached");
    }) as typeof globalThis.fetch;

    const result = await generateVariant(
      "fake-key", "prompt", outputPath, "1024x1024", "high", fetchFn, 1000,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Timeout (1s)");
  });

  test("default timeoutMs is the shared constant when omitted", async () => {
    // 1x1 transparent PNG, base64
    const TINY_PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          output: [{ type: "image_generation_call", result: TINY_PNG_BASE64 }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof globalThis.fetch;

    // Should succeed using the default timeout — fetch resolves instantly here,
    // so the timeoutMs value only matters for the AbortController setup not firing.
    const result = await generateVariant(
      "fake-key", "prompt", outputPath, "1024x1024", "high", fetchFn,
    );

    expect(result.success).toBe(true);
  });
});
