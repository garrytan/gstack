import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { generateVariant } from "../src/variants";

// 1x1 transparent PNG, base64 — valid bytes that fs.writeFileSync can write.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      output: [{ type: "image_generation_call", result: TINY_PNG_BASE64 }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function rateLimited(retryAfter?: string): Response {
  const headers: Record<string, string> = {};
  if (retryAfter !== undefined) headers["Retry-After"] = retryAfter;
  return new Response("rate limited", { status: 429, headers });
}

interface CallRecord {
  ts: number;
}

function makeStubFetch(
  responses: Response[],
  calls: CallRecord[],
): typeof globalThis.fetch {
  let idx = 0;
  return (async (_input: any, _init?: any) => {
    calls.push({ ts: Date.now() });
    const response = responses[idx];
    if (!response) throw new Error(`stub fetch: no response for call ${idx + 1}`);
    idx++;
    return response;
  }) as typeof globalThis.fetch;
}

describe("generateVariant Retry-After handling", () => {
  let tmpDir: string;
  let outputPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "variants-retry-after-"));
    outputPath = path.join(tmpDir, "variant.png");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("delta-seconds: honors Retry-After: 1 with no extra leading exponential", async () => {
    const calls: CallRecord[] = [];
    const fetchFn = makeStubFetch([rateLimited("1"), successResponse()], calls);

    const result = await generateVariant(
      "fake-key", "prompt", outputPath, "1024x1024", "high", fetchFn,
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(2);
    const gap = calls[1].ts - calls[0].ts;
    // Honored ~1s; should NOT add the 2s leading exponential on top
    expect(gap).toBeGreaterThanOrEqual(900);
    expect(gap).toBeLessThan(1700);
  });

  test("HTTP-date: honors a future date with no extra leading exponential", async () => {
    const calls: CallRecord[] = [];
    const future = new Date(Date.now() + 3000).toUTCString();
    const fetchFn = makeStubFetch([rateLimited(future), successResponse()], calls);

    const result = await generateVariant(
      "fake-key", "prompt", outputPath, "1024x1024", "high", fetchFn,
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(2);
    const gap = calls[1].ts - calls[0].ts;
    expect(gap).toBeGreaterThanOrEqual(2500);
    expect(gap).toBeLessThan(4500);
  });

  test("invalid Retry-After (alphanumeric): falls through to exponential", async () => {
    const calls: CallRecord[] = [];
    const fetchFn = makeStubFetch([rateLimited("2abc"), successResponse()], calls);

    const result = await generateVariant(
      "fake-key", "prompt", outputPath, "1024x1024", "high", fetchFn,
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(2);
    const gap = calls[1].ts - calls[0].ts;
    // Falls through to existing 2s exponential leading delay
    expect(gap).toBeGreaterThanOrEqual(1800);
    expect(gap).toBeLessThan(3000);
  });

  test("no Retry-After header: falls through to exponential", async () => {
    const calls: CallRecord[] = [];
    const fetchFn = makeStubFetch([rateLimited(), successResponse()], calls);

    const result = await generateVariant(
      "fake-key", "prompt", outputPath, "1024x1024", "high", fetchFn,
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(2);
    const gap = calls[1].ts - calls[0].ts;
    expect(gap).toBeGreaterThanOrEqual(1800);
    expect(gap).toBeLessThan(3000);
  });

  test("Retry-After: 0 retries immediately, skips leading exponential", async () => {
    const calls: CallRecord[] = [];
    const fetchFn = makeStubFetch([rateLimited("0"), successResponse()], calls);

    const result = await generateVariant(
      "fake-key", "prompt", outputPath, "1024x1024", "high", fetchFn,
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(2);
    const gap = calls[1].ts - calls[0].ts;
    expect(gap).toBeLessThan(500);
  });
});
