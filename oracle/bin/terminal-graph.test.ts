/**
 * terminal-graph.test.ts — Tests for the ANSI terminal ASCII tree renderer
 */

import { describe, test, expect } from "bun:test";
import { renderTerminalGraph } from "./terminal-graph";

function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    project: "test-project",
    total_files: 5,
    total_lines: 500,
    routes: [
      {
        path: "/dashboard",
        type: "page" as const,
        page_file: "src/pages/Dashboard.tsx",
        branch_lines: 300,
        branch_files: 3,
        classification: "easy" as const,
      },
    ],
    circular_deps: [],
    dead_files: [],
    import_graph: {
      "src/pages/Dashboard.tsx": { lines: 150, imports: ["src/components/Header.tsx", "src/hooks/useData.ts"] },
      "src/components/Header.tsx": { lines: 80, imports: [] },
      "src/hooks/useData.ts": { lines: 70, imports: [] },
    },
    ...overrides,
  };
}

const NO_COLOR = { useColor: false, maxDepth: Infinity, compact: false };
const WITH_COLOR = { useColor: true, maxDepth: Infinity, compact: false };

describe("renderTerminalGraph", () => {
  test("renders header with project name", () => {
    const output = renderTerminalGraph(makeManifest(), NO_COLOR);
    expect(output).toContain("ORACLE SCAN: test-project");
  });

  test("renders stats line", () => {
    const output = renderTerminalGraph(makeManifest(), NO_COLOR);
    expect(output).toContain("Files: 5");
    expect(output).toContain("Routes: 1");
  });

  test("renders route with classification", () => {
    const output = renderTerminalGraph(makeManifest(), NO_COLOR);
    expect(output).toContain("/dashboard [EASY 300L]");
  });

  test("renders tree with box-drawing characters", () => {
    const output = renderTerminalGraph(makeManifest(), NO_COLOR);
    expect(output).toContain("├──");
    expect(output).toContain("└──");
  });

  test("renders file names with line counts", () => {
    const output = renderTerminalGraph(makeManifest(), NO_COLOR);
    expect(output).toContain("Header.tsx");
    expect(output).toContain("(80L)");
    expect(output).toContain("useData.ts");
    expect(output).toContain("(70L)");
  });

  test("--no-color strips ANSI codes", () => {
    const output = renderTerminalGraph(makeManifest(), NO_COLOR);
    expect(output).not.toContain("\x1b[");
  });

  test("with color includes ANSI codes", () => {
    const output = renderTerminalGraph(makeManifest(), WITH_COLOR);
    expect(output).toContain("\x1b[");
  });

  test("color matches classification", () => {
    // EASY = green (\x1b[32m)
    const output = renderTerminalGraph(makeManifest(), WITH_COLOR);
    expect(output).toContain("\x1b[32m");
  });

  test("MEGA routes use red color", () => {
    const manifest = makeManifest({
      routes: [{ path: "/big", type: "page", page_file: "a.tsx", branch_lines: 5000, branch_files: 20, classification: "mega" }],
      import_graph: { "a.tsx": { lines: 5000, imports: [] } },
    });
    const output = renderTerminalGraph(manifest, WITH_COLOR);
    expect(output).toContain("\x1b[31m"); // red
  });

  test("--max-depth limits tree depth", () => {
    const manifest = makeManifest({
      import_graph: {
        "src/pages/Dashboard.tsx": { lines: 150, imports: ["src/A.tsx"] },
        "src/A.tsx": { lines: 50, imports: ["src/B.tsx"] },
        "src/B.tsx": { lines: 30, imports: ["src/C.tsx"] },
        "src/C.tsx": { lines: 10, imports: [] },
      },
    });
    const output = renderTerminalGraph(manifest, { ...NO_COLOR, maxDepth: 2 });
    expect(output).toContain("A.tsx");
    expect(output).toContain("B.tsx");
    expect(output).not.toContain("C.tsx");
  });

  test("compact mode collapses single-child chains", () => {
    const manifest = makeManifest({
      import_graph: {
        "src/pages/Dashboard.tsx": { lines: 150, imports: ["src/A.tsx"] },
        "src/A.tsx": { lines: 50, imports: [] },
      },
    });
    const output = renderTerminalGraph(manifest, { ...NO_COLOR, compact: true });
    // In compact mode, single-child chain should be on one line with →
    expect(output).toContain("→");
  });

  test("renders circular deps section", () => {
    const manifest = makeManifest({
      circular_deps: [{ cycle: ["src/A.tsx", "src/B.tsx"], severity: "high" }],
    });
    const output = renderTerminalGraph(manifest, NO_COLOR);
    expect(output).toContain("CIRCULAR DEPENDENCIES (1)");
    expect(output).toContain("HIGH");
    expect(output).toContain("🔄");
    expect(output).toContain("A.tsx");
  });

  test("renders dead files section", () => {
    const manifest = makeManifest({
      dead_files: [{ file: "src/unused.ts", confidence: "high", lines: 45 }],
    });
    const output = renderTerminalGraph(manifest, NO_COLOR);
    expect(output).toContain("DEAD FILES (1)");
    expect(output).toContain("unused.ts");
    expect(output).toContain("45L");
  });

  test("handles empty manifest", () => {
    const manifest = makeManifest({
      routes: [],
      circular_deps: [],
      dead_files: [],
      import_graph: {},
      total_files: 0,
      total_lines: 0,
    });
    const output = renderTerminalGraph(manifest, NO_COLOR);
    expect(output).toContain("ORACLE SCAN");
    expect(output).toContain("Routes: 0");
  });

  test("renders separator lines", () => {
    const output = renderTerminalGraph(makeManifest(), NO_COLOR);
    expect(output).toContain("═".repeat(50));
  });
});
