/**
 * Regression tests for #2922 — runMemoryIngest() never passes --sources, so
 * every sync re-duplicates curated pages already owned by a registered
 * federated source.
 *
 * Tests cover:
 *   - resolveMemoryIngestSources (gstack-gbrain-sync.ts) — env parsing
 *   - static invariant: runMemoryIngest() threads the result through as the
 *     --sources flag on the gstack-memory-ingest child argv
 *
 * Branches under test (7 total):
 *   1. env unset → null (full walk, current behavior)
 *   2. env empty / whitespace-only → null
 *   3. single valid type → [type]
 *   4. comma-separated valid types with whitespace → trimmed subset
 *   5. duplicate valid types → deduplicated
 *   6. mix of valid and unknown → valid kept, unknown dropped
 *   7. all unknown → null (full walk, warning) instead of failing the stage
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  resolveMemoryIngestSources,
  MEMORY_INGEST_TYPES,
} from "../bin/gstack-gbrain-sync";

const ENV = "GSTACK_MEMORY_INGEST_SOURCES";

describe("resolveMemoryIngestSources (#2922)", () => {
  test("env unset → null (full walk)", () => {
    expect(resolveMemoryIngestSources(undefined, ENV)).toBeNull();
  });

  test("env empty or whitespace-only → null", () => {
    expect(resolveMemoryIngestSources("", ENV)).toBeNull();
    expect(resolveMemoryIngestSources("   ", ENV)).toBeNull();
  });

  test("single valid type passes through", () => {
    expect(resolveMemoryIngestSources("transcript", ENV)).toEqual(["transcript"]);
  });

  test("comma-separated valid types are trimmed", () => {
    expect(resolveMemoryIngestSources("transcript, design-doc ,eureka", ENV)).toEqual([
      "transcript",
      "design-doc",
      "eureka",
    ]);
  });

  test("duplicate valid types are deduplicated", () => {
    expect(resolveMemoryIngestSources("eureka,eureka,learning", ENV)).toEqual([
      "eureka",
      "learning",
    ]);
  });

  test("unknown tokens are dropped, valid ones kept", () => {
    expect(resolveMemoryIngestSources("transcript,bogus,learning", ENV)).toEqual([
      "transcript",
      "learning",
    ]);
  });

  test("all unknown → null (full walk instead of failing the stage)", () => {
    expect(resolveMemoryIngestSources("bogus,nope", ENV)).toBeNull();
  });

  test("every ingest ALL_TYPES member is accepted", () => {
    const all = MEMORY_INGEST_TYPES.join(",");
    expect(resolveMemoryIngestSources(all, ENV)).toEqual([...MEMORY_INGEST_TYPES]);
  });
});

describe("runMemoryIngest --sources wiring (#2922)", () => {
  test("runMemoryIngest() appends --sources from GSTACK_MEMORY_INGEST_SOURCES", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dir, "..", "bin", "gstack-gbrain-sync.ts"),
      "utf-8",
    );
    const fn = src.slice(src.indexOf("function runMemoryIngest"));
    expect(fn).toContain("resolveMemoryIngestSources(");
    expect(fn).toContain('ingestArgs.push("--sources", memorySources.join(","))');
  });

  test("MEMORY_INGEST_TYPES stays in sync with memory-ingest ALL_TYPES", () => {
    const ingestSrc = fs.readFileSync(
      path.join(import.meta.dir, "..", "bin", "gstack-memory-ingest.ts"),
      "utf-8",
    );
    const m = ingestSrc.match(/const ALL_TYPES: MemoryType\[\] = \[([\s\S]*?)\];/);
    expect(m).not.toBeNull();
    const allTypes = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    expect([...MEMORY_INGEST_TYPES].sort()).toEqual(allTypes);
  });
});
