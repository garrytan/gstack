import { describe, test, expect } from "bun:test";
import { resolveImportTimeoutMs } from "../bin/gstack-memory-ingest";

// #1611: the gbrain import timeout is configurable via GSTACK_INGEST_TIMEOUT_MS
// (default 30 min) so big-brain --full ingests aren't SIGTERM'd mid-import.
const DEFAULT = 30 * 60 * 1000;

describe("resolveImportTimeoutMs", () => {
  test("unset → 30 min default", () => {
    expect(resolveImportTimeoutMs(undefined)).toBe(DEFAULT);
    expect(resolveImportTimeoutMs("")).toBe(DEFAULT);
  });

  test("valid override is honored", () => {
    expect(resolveImportTimeoutMs("3600000")).toBe(3_600_000); // 1h
    expect(resolveImportTimeoutMs("60000")).toBe(60_000); // floor
    expect(resolveImportTimeoutMs("86400000")).toBe(86_400_000); // ceiling
  });

  test("invalid / out-of-range → default (no SIGTERM-too-soon footgun)", () => {
    expect(resolveImportTimeoutMs("nope")).toBe(DEFAULT);
    expect(resolveImportTimeoutMs("0")).toBe(DEFAULT);
    expect(resolveImportTimeoutMs("59999")).toBe(DEFAULT); // below 1min floor
    expect(resolveImportTimeoutMs("86400001")).toBe(DEFAULT); // above 24h ceiling
    expect(resolveImportTimeoutMs("-5")).toBe(DEFAULT);
  });
});
