import { describe, test, expect } from "bun:test";
import {
  parseSourcesList,
  parseSourcesListStrict,
} from "../lib/gbrain-sources";

// #1576 hardening: `gbrain sources list --json` has shipped two shapes — a
// wrapped `{ sources: [...] }` object (v0.20+) and a bare top-level array.
// parseSourcesList is the single place that normalizes both, so every reader
// (probeSource, sourcePageCount, sourceLocalPath)
// agrees on the shape. These tests pin both shapes plus the garbage paths.
describe("parseSourcesList", () => {
  const rows = [
    { id: "a", local_path: "/x", page_count: 3 },
    { id: "b", local_path: "/y", remote_url: "https://example.com/r.git" },
  ];

  test("wrapped { sources: [...] } shape", () => {
    expect(parseSourcesList({ sources: rows })).toEqual(rows);
  });

  test("bare top-level array shape", () => {
    expect(parseSourcesList(rows)).toEqual(rows);
  });

  test("both shapes yield identical rows (shape-independent)", () => {
    expect(parseSourcesList({ sources: rows })).toEqual(parseSourcesList(rows));
  });

  test("null / undefined → empty array (no throw)", () => {
    expect(parseSourcesList(null)).toEqual([]);
    expect(parseSourcesList(undefined)).toEqual([]);
  });

  test("object without sources key → empty array", () => {
    expect(parseSourcesList({ pages: [] })).toEqual([]);
  });

  test("sources key present but not an array → empty array", () => {
    expect(parseSourcesList({ sources: "oops" })).toEqual([]);
  });

  test("scalar garbage → empty array", () => {
    expect(parseSourcesList("nope")).toEqual([]);
    expect(parseSourcesList(42)).toEqual([]);
  });

  test("preserves top-level remote_url from the richer sources_list operation", () => {
    const parsed = parseSourcesList({ sources: rows });
    expect(parsed.find((r) => r.id === "b")?.remote_url).toBe(
      "https://example.com/r.git",
    );
  });
});

describe("parseSourcesListStrict", () => {
  test("accepts the documented wrapped and legacy array shapes", () => {
    const rows = [
      { id: "default", local_path: null },
      { id: "source-a", local_path: "/repo" },
    ];
    expect(parseSourcesListStrict({ sources: rows })).toEqual(rows);
    expect(parseSourcesListStrict(rows)).toEqual(rows);
  });

  test("rejects unknown shapes instead of treating them as an absent source", () => {
    for (const raw of [null, { pages: [] }, { sources: "oops" }, "nope", 42]) {
      expect(() => parseSourcesListStrict(raw)).toThrow(/unknown JSON shape/);
    }
  });

  test("rejects malformed rows before a destructive decision can use them", () => {
    for (const raw of [
      { sources: ["oops"] },
      { sources: [{}] },
      { sources: [{ id: "source-a", local_path: 42 }] },
      { sources: [{ id: "source-a", remote_url: 42 }] },
      { sources: [{ id: "source-a", config: [] }] },
      { sources: [{ id: "source-a", config: { remote_url: 42 } }] },
    ]) {
      expect(() => parseSourcesListStrict(raw)).toThrow(/source row/);
    }
  });
});
