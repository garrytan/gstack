/**
 * visualize-graph.test.ts — Tests for the HTML import graph visualizer
 */

import { describe, test, expect } from "bun:test";
import { generateHtml } from "./visualize-graph";

function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    project: "test-project",
    total_files: 10,
    total_lines: 1000,
    routes: [
      {
        path: "/dashboard",
        type: "page" as const,
        page_file: "src/pages/Dashboard.tsx",
        branch_lines: 500,
        branch_files: 5,
        classification: "medium" as const,
      },
      {
        path: "/login",
        type: "page" as const,
        page_file: "src/pages/Login.tsx",
        branch_lines: 100,
        branch_files: 1,
        classification: "easy" as const,
      },
    ],
    circular_deps: [],
    dead_files: [],
    import_graph: {
      "src/pages/Dashboard.tsx": { lines: 200, imports: ["src/components/Header.tsx"] },
      "src/components/Header.tsx": { lines: 80, imports: [] },
      "src/pages/Login.tsx": { lines: 100, imports: [] },
    },
    ...overrides,
  };
}

describe("generateHtml", () => {
  test("produces valid HTML structure", () => {
    const html = generateHtml(makeManifest());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<body>");
    expect(html).toContain("</body>");
  });

  test("contains project name", () => {
    const html = generateHtml(makeManifest());
    expect(html).toContain("test-project");
  });

  test("contains route paths", () => {
    const html = generateHtml(makeManifest());
    expect(html).toContain("/dashboard");
    expect(html).toContain("/login");
  });

  test("color codes EASY routes green", () => {
    const html = generateHtml(makeManifest());
    expect(html).toContain("#4CAF50"); // green for EASY
  });

  test("color codes MEDIUM routes yellow", () => {
    const html = generateHtml(makeManifest());
    expect(html).toContain("#FFC107"); // yellow for MEDIUM
  });

  test("color codes HARD routes orange", () => {
    const manifest = makeManifest({
      routes: [{ path: "/hard", type: "page", page_file: "a.tsx", branch_lines: 2800, branch_files: 10, classification: "hard" }],
    });
    const html = generateHtml(manifest);
    expect(html).toContain("#FF9800"); // orange for HARD
  });

  test("color codes MEGA routes red", () => {
    const manifest = makeManifest({
      routes: [{ path: "/mega", type: "page", page_file: "a.tsx", branch_lines: 5000, branch_files: 20, classification: "mega" }],
    });
    const html = generateHtml(manifest);
    expect(html).toContain("#F44336"); // red for MEGA
  });

  test("shows circular dependency markers", () => {
    const manifest = makeManifest({
      circular_deps: [{ cycle: ["a.tsx", "b.tsx"], severity: "high" }],
    });
    const html = generateHtml(manifest);
    expect(html).toContain("Circular Dependencies");
    expect(html).toContain("HIGH");
    expect(html).toContain("a.tsx");
    expect(html).toContain("b.tsx");
  });

  test("shows dead files section", () => {
    const manifest = makeManifest({
      dead_files: [{ file: "src/unused.ts", confidence: "high", lines: 50 }],
    });
    const html = generateHtml(manifest);
    expect(html).toContain("Dead Files");
    expect(html).toContain("unused.ts");
  });

  test("shows stats summary", () => {
    const html = generateHtml(makeManifest());
    expect(html).toContain("10"); // total_files
    expect(html).toContain("1,000"); // total_lines formatted
  });

  test("is self-contained (no external URLs)", () => {
    const html = generateHtml(makeManifest());
    // Should not contain any http:// or https:// URLs (CDN, fonts, etc.)
    const externalUrls = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    expect(externalUrls).toEqual([]);
  });

  test("handles empty manifest gracefully", () => {
    const manifest = makeManifest({
      routes: [],
      circular_deps: [],
      dead_files: [],
      import_graph: {},
      total_files: 0,
      total_lines: 0,
    });
    const html = generateHtml(manifest);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Routes (0)");
  });

  test("uses summary mode for >1000 nodes", () => {
    // Create a large import graph
    const graph: Record<string, { lines: number; imports: string[] }> = {};
    for (let i = 0; i < 1001; i++) {
      graph[`src/file${i}.ts`] = { lines: 10, imports: [] };
    }
    const manifest = makeManifest({
      import_graph: graph,
      total_files: 1001,
      routes: [{ path: "/big", type: "page", page_file: "src/file0.ts", branch_lines: 10000, branch_files: 1001, classification: "mega" }],
    });
    const html = generateHtml(manifest);
    expect(html).toContain("summary mode");
  });

  test("contains legend with classification colors", () => {
    const html = generateHtml(makeManifest());
    expect(html).toContain("EASY");
    expect(html).toContain("MEDIUM");
    expect(html).toContain("HARD");
    expect(html).toContain("MEGA");
  });

  test("includes keyboard shortcut script", () => {
    const html = generateHtml(makeManifest());
    expect(html).toContain("<script>");
    expect(html).toContain("keydown");
  });
});
