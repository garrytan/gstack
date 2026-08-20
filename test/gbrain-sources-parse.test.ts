import { describe, test, expect } from "bun:test";
import { parseSourcesList } from "../lib/gbrain-sources";

// #1576 hardening: `gbrain sources list --json` has shipped two shapes — a
// wrapped `{ sources: [...] }` object (v0.20+) and a bare top-level array.
// parseSourcesList is the single place that normalizes both, so every reader
// (probeSource, sourcePageCount, sourceLocalPath, the #1734 remote_url audit)
// agrees on the shape. These tests pin both shapes plus the garbage paths.
describe("parseSourcesList", () => {
  const rows = [
    { id: "a", local_path: "/x", page_count: 3 },
    { id: "b", local_path: "/y", config: { remote_url: "https://example.com/r.git" } },
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

  test("preserves config.remote_url for the #1734 audit", () => {
    const parsed = parseSourcesList({ sources: rows });
    expect(parsed.find((r) => r.id === "b")?.config?.remote_url).toBe("https://example.com/r.git");
  });
});
