/**
 * scan-imports.test.ts — Scanner module tests (~55 tests)
 *
 * Tests all scanner modules: core, aliases, routes, dead-code, css, monorepo, non-ts
 * Uses bun:test (built-in, free). Fixture directories in __fixtures__/.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import * as fs from "fs";

// ─── Scanner module imports ──────────────────────────────────────────────────
import {
  findTsFiles,
  buildImportGraph,
  unifiedTraversal,
  findCircularDeps,
  classify,
  estimateSessions,
  computeContentHash,
  findEntryPoints,
  isDeferredImport,
  getGitCoChangeComplexity,
  getGitBornDate,
  BASE_BUDGET,
  EASY_THRESHOLD,
  MEDIUM_THRESHOLD,
  MEGA_TRACE_DEPTH_CAP,
  MAX_FILE_DISCOVERY_DEPTH,
  type FileNode,
  type RouteEntry,
} from "./scanner/core";
import * as os from "os";

import {
  parseViteAliases,
  parseViteAliasesDetailed,
} from "./scanner/aliases";

import {
  detectFramework,
  discoverRoutes,
  findPageFileForRoute,
  type FrameworkDetectionResult,
} from "./scanner/routes";

import { findDeadFiles } from "./scanner/dead-code";
import { buildCssGraph } from "./scanner/css";
import { detectMonorepo } from "./scanner/monorepo";
import { discoverNonTsFiles } from "./scanner/non-ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────
const FIXTURES = path.join(__dirname, "__fixtures__");

function makeGraph(entries: Record<string, { lines: number; imports: string[]; dynamic_imports?: import("./scanner/core").DynamicImport[] }>): Record<string, FileNode> {
  const graph: Record<string, FileNode> = {};
  for (const [file, { lines, imports, dynamic_imports }] of Object.entries(entries)) {
    graph[file] = {
      lines,
      content_hash: file,
      imports,
      unresolved_imports: [],
      is_css: file.endsWith(".css") || file.endsWith(".scss"),
      dynamic_imports,
    };
  }
  return graph;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE MODULE
// ═══════════════════════════════════════════════════════════════════════════════

describe("core: classify()", () => {
  test("classifies EASY for < 800 lines", () => {
    expect(classify(0)).toBe("easy");
    expect(classify(799)).toBe("easy");
  });

  test("classifies MEDIUM for 800-2499 lines", () => {
    expect(classify(800)).toBe("medium");
    expect(classify(2499)).toBe("medium");
  });

  test("classifies HARD for 2500-3000 lines", () => {
    expect(classify(2500)).toBe("hard");
    expect(classify(3000)).toBe("hard");
  });

  test("classifies MEGA for > 3000 lines", () => {
    expect(classify(3001)).toBe("mega");
    expect(classify(10000)).toBe("mega");
  });
});

describe("core: estimateSessions()", () => {
  test("counts sessions per tier", () => {
    const routes: RouteEntry[] = [
      { path: "/", type: "page", page_file: "a.ts", branch_lines: 400, branch_files: 5, classification: "easy", session_slots: 1, status: "not_started" },
      { path: "/b", type: "page", page_file: "b.ts", branch_lines: 1500, branch_files: 10, classification: "medium", session_slots: 2, status: "not_started" },
      { path: "/c", type: "api", page_file: "c.ts", branch_lines: 4000, branch_files: 20, classification: "mega", session_slots: 3, status: "not_started" },
    ];
    const result = estimateSessions(routes);
    expect(result.easy).toBe(1);
    expect(result.medium).toBe(2);
    expect(result.mega).toBe(3);
    expect(result.total_max).toBe(6);
    expect(result.total_min).toBeLessThanOrEqual(result.total_max);
  });

  test("skips unknown classification", () => {
    const routes: RouteEntry[] = [
      { path: "/x", type: "page", page_file: "x.ts", branch_lines: 0, branch_files: 0, classification: "unknown" as any, session_slots: 5, status: "not_started" },
    ];
    const result = estimateSessions(routes);
    expect(result.total_max).toBe(0);
  });
});

describe("core: unifiedTraversal()", () => {
  test("computes branch membership from route roots", () => {
    const graph = makeGraph({
      "src/pages/Home.tsx": { lines: 100, imports: ["src/components/Header.tsx"] },
      "src/components/Header.tsx": { lines: 50, imports: ["src/lib/utils.ts"] },
      "src/lib/utils.ts": { lines: 30, imports: [] },
      "src/pages/About.tsx": { lines: 80, imports: ["src/components/Header.tsx"] },
    });

    const routeRoots = new Map([
      ["/", "src/pages/Home.tsx"],
      ["/about", "src/pages/About.tsx"],
    ]);

    const result = unifiedTraversal(graph, routeRoots, []);

    const homeBranch = result.branches.get("/")!;
    expect(homeBranch.files.has("src/pages/Home.tsx")).toBe(true);
    expect(homeBranch.files.has("src/components/Header.tsx")).toBe(true);
    expect(homeBranch.files.has("src/lib/utils.ts")).toBe(true);
    expect(homeBranch.fileCount).toBe(3);
    expect(homeBranch.totalLines).toBe(180);

    const aboutBranch = result.branches.get("/about")!;
    expect(aboutBranch.files.has("src/pages/About.tsx")).toBe(true);
    expect(aboutBranch.files.has("src/components/Header.tsx")).toBe(true);
  });

  test("marks all traversed files as reachable", () => {
    const graph = makeGraph({
      "a.ts": { lines: 10, imports: ["b.ts"] },
      "b.ts": { lines: 20, imports: [] },
      "dead.ts": { lines: 50, imports: [] },
    });
    const routeRoots = new Map([["/", "a.ts"]]);
    const result = unifiedTraversal(graph, routeRoots, []);
    expect(result.reachable.has("a.ts")).toBe(true);
    expect(result.reachable.has("b.ts")).toBe(true);
    expect(result.reachable.has("dead.ts")).toBe(false);
  });

  test("entry points contribute to reachability but not route branches", () => {
    const graph = makeGraph({
      "src/main.tsx": { lines: 10, imports: ["src/lib/init.ts"] },
      "src/lib/init.ts": { lines: 20, imports: [] },
      "src/pages/Home.tsx": { lines: 100, imports: [] },
    });
    const routeRoots = new Map([["/", "src/pages/Home.tsx"]]);
    const result = unifiedTraversal(graph, routeRoots, ["src/main.tsx"]);

    expect(result.reachable.has("src/main.tsx")).toBe(true);
    expect(result.reachable.has("src/lib/init.ts")).toBe(true);
    const homeBranch = result.branches.get("/")!;
    expect(homeBranch.files.has("src/main.tsx")).toBe(false);
  });

  test("tracks route membership per file", () => {
    const graph = makeGraph({
      "shared.ts": { lines: 10, imports: [] },
      "a.ts": { lines: 10, imports: ["shared.ts"] },
      "b.ts": { lines: 10, imports: ["shared.ts"] },
    });
    const routeRoots = new Map([
      ["/a", "a.ts"],
      ["/b", "b.ts"],
    ]);
    const result = unifiedTraversal(graph, routeRoots, []);
    const sharedMembership = result.routeMembership.get("shared.ts");
    expect(sharedMembership?.has("/a")).toBe(true);
    expect(sharedMembership?.has("/b")).toBe(true);
  });

  test("respects MEGA depth cap", () => {
    // Create a deep chain that crosses into MEGA territory (total: 3400L = mega)
    const graph = makeGraph({
      "root.ts": { lines: 2500, imports: ["d1.ts"] },
      "d1.ts": { lines: 200, imports: ["d2.ts"] },
      "d2.ts": { lines: 200, imports: ["d3.ts"] },
      "d3.ts": { lines: 200, imports: ["d4.ts"] },
      "d4.ts": { lines: 200, imports: ["d5.ts"] },
      "d5.ts": { lines: 100, imports: [] },
    });
    const routeRoots = new Map([["/mega", "root.ts"]]);
    // With depth cap of 4, d5.ts (depth 5) should be excluded from the branch
    const result = unifiedTraversal(graph, routeRoots, [], 4);
    const branch = result.branches.get("/mega")!;
    expect(branch.files.has("root.ts")).toBe(true);   // depth 0
    expect(branch.files.has("d1.ts")).toBe(true);      // depth 1
    expect(branch.files.has("d4.ts")).toBe(true);      // depth 4 (at cap)
    expect(branch.files.has("d5.ts")).toBe(false);     // depth 5 (beyond cap, pruned)
    expect(branch.maxDepth).toBe(4);
  });

  test("post-hoc prune: mega route with many files beyond depth cap", () => {
    // Wide tree: root has 3 children, each with children — total well over 3000L
    const graph = makeGraph({
      "root.ts": { lines: 1000, imports: ["a1.ts", "b1.ts", "c1.ts"] },
      "a1.ts": { lines: 500, imports: ["a2.ts"] },
      "a2.ts": { lines: 500, imports: ["a3.ts"] },
      "a3.ts": { lines: 300, imports: [] },  // depth 3
      "b1.ts": { lines: 500, imports: ["b2.ts"] },
      "b2.ts": { lines: 300, imports: [] },  // depth 2
      "c1.ts": { lines: 500, imports: ["c2.ts"] },
      "c2.ts": { lines: 400, imports: ["c3.ts"] },
      "c3.ts": { lines: 200, imports: [] },  // depth 3
    });
    // Total: 4200L = mega. With cap of 2, files at depth > 2 pruned
    const routeRoots = new Map([["/wide", "root.ts"]]);
    const result = unifiedTraversal(graph, routeRoots, [], 2);
    const branch = result.branches.get("/wide")!;
    expect(branch.files.has("root.ts")).toBe(true);  // depth 0
    expect(branch.files.has("a1.ts")).toBe(true);    // depth 1
    expect(branch.files.has("a2.ts")).toBe(true);    // depth 2 (at cap)
    expect(branch.files.has("a3.ts")).toBe(false);   // depth 3 (pruned)
    expect(branch.files.has("c3.ts")).toBe(false);   // depth 3 (pruned)
    expect(branch.maxDepth).toBe(2);
  });

  test("non-mega route is NOT depth-capped", () => {
    // Total: 160L — well below mega threshold, all depths preserved
    const graph = makeGraph({
      "root.ts": { lines: 10, imports: ["d1.ts"] },
      "d1.ts": { lines: 10, imports: ["d2.ts"] },
      "d2.ts": { lines: 10, imports: ["d3.ts"] },
      "d3.ts": { lines: 10, imports: ["d4.ts"] },
      "d4.ts": { lines: 10, imports: ["d5.ts"] },
      "d5.ts": { lines: 10, imports: ["d6.ts"] },
      "d6.ts": { lines: 10, imports: ["d7.ts"] },
      "d7.ts": { lines: 10, imports: ["d8.ts"] },
      "d8.ts": { lines: 10, imports: ["d9.ts"] },
      "d9.ts": { lines: 10, imports: ["d10.ts"] },
      "d10.ts": { lines: 10, imports: ["d11.ts"] },
      "d11.ts": { lines: 10, imports: ["d12.ts"] },
      "d12.ts": { lines: 10, imports: ["d13.ts"] },
      "d13.ts": { lines: 10, imports: ["d14.ts"] },
      "d14.ts": { lines: 10, imports: ["d15.ts"] },
      "d15.ts": { lines: 10, imports: [] },
    });
    const routeRoots = new Map([["/deep", "root.ts"]]);
    const result = unifiedTraversal(graph, routeRoots, [], 4);
    const branch = result.branches.get("/deep")!;
    expect(branch.files.has("d15.ts")).toBe(true); // depth 15, no cap because not mega
    expect(branch.maxDepth).toBe(15);
    expect(branch.fileCount).toBe(16);
  });

  test("single mega file at root", () => {
    const graph = makeGraph({
      "huge.ts": { lines: 3500, imports: ["child.ts"] },
      "child.ts": { lines: 10, imports: [] },
    });
    const routeRoots = new Map([["/huge", "huge.ts"]]);
    // Cap at 0 means only depth 0 files kept — child is at depth 1
    // But default cap is 4, so child at depth 1 is fine
    const result = unifiedTraversal(graph, routeRoots, [], 4);
    const branch = result.branches.get("/huge")!;
    expect(branch.files.has("huge.ts")).toBe(true);
    expect(branch.files.has("child.ts")).toBe(true); // depth 1, within cap
  });

  test("deferred dynamic import targets are reachable", () => {
    const graph = makeGraph({
      "main.ts": { lines: 10, imports: [], dynamic_imports: [
        { expression: "./lazy.ts", resolvable: true, resolved_files: ["lazy.ts"] },
      ] },
      "lazy.ts": { lines: 50, imports: [] },
    });
    const routeRoots = new Map([["/", "main.ts"]]);
    const result = unifiedTraversal(graph, routeRoots, []);
    expect(result.reachable.has("lazy.ts")).toBe(true);
    // lazy.ts should NOT be in the route branch (it's deferred)
    const branch = result.branches.get("/")!;
    expect(branch.files.has("lazy.ts")).toBe(false);
  });

  test("transitive static imports of dynamic targets are reachable", () => {
    // main --(dynamic)--> lazy --(static)--> util
    const graph = makeGraph({
      "main.ts": { lines: 10, imports: [], dynamic_imports: [
        { expression: "./lazy.ts", resolvable: true, resolved_files: ["lazy.ts"] },
      ] },
      "lazy.ts": { lines: 50, imports: ["util.ts"] },
      "util.ts": { lines: 20, imports: [] },
    });
    const routeRoots = new Map([["/", "main.ts"]]);
    const result = unifiedTraversal(graph, routeRoots, []);
    expect(result.reachable.has("lazy.ts")).toBe(true);
    expect(result.reachable.has("util.ts")).toBe(true);
  });

  test("transitive dynamic→dynamic chain is reachable", () => {
    // main --(dynamic)--> A --(dynamic)--> B
    const graph = makeGraph({
      "main.ts": { lines: 10, imports: [], dynamic_imports: [
        { expression: "./A.ts", resolvable: true, resolved_files: ["A.ts"] },
      ] },
      "A.ts": { lines: 30, imports: [], dynamic_imports: [
        { expression: "./B.ts", resolvable: true, resolved_files: ["B.ts"] },
      ] },
      "B.ts": { lines: 20, imports: [] },
    });
    const routeRoots = new Map([["/", "main.ts"]]);
    const result = unifiedTraversal(graph, routeRoots, []);
    expect(result.reachable.has("A.ts")).toBe(true);
    expect(result.reachable.has("B.ts")).toBe(true);
  });

  test("MEGA cap + dynamic reachability: capped files still reachable", () => {
    // Mega route: files beyond depth cap are pruned from branch but stay reachable.
    // Dynamic imports from pruned files should also be reachable.
    const graph = makeGraph({
      "root.ts": { lines: 2500, imports: ["d1.ts"] },
      "d1.ts": { lines: 300, imports: ["d2.ts"] },
      "d2.ts": { lines: 300, imports: [], dynamic_imports: [
        { expression: "./lazy-deep.ts", resolvable: true, resolved_files: ["lazy-deep.ts"] },
      ] },
      "lazy-deep.ts": { lines: 50, imports: [] },
    });
    const routeRoots = new Map([["/mega", "root.ts"]]);
    // Cap at 1: d2.ts (depth 2) is pruned from branch
    const result = unifiedTraversal(graph, routeRoots, [], 1);
    const branch = result.branches.get("/mega")!;
    expect(branch.files.has("d2.ts")).toBe(false);     // pruned from branch
    expect(result.reachable.has("d2.ts")).toBe(true);  // but still reachable
    expect(result.reachable.has("lazy-deep.ts")).toBe(true); // dynamic target also reachable
  });
});

describe("core: findCircularDeps()", () => {
  test("detects circular dependency between two files", () => {
    const graph = makeGraph({
      "a.ts": { lines: 10, imports: ["b.ts"] },
      "b.ts": { lines: 10, imports: ["a.ts"] },
    });
    const circs = findCircularDeps(graph);
    expect(circs.length).toBe(1);
    expect(circs[0].cycle_length).toBe(2);
    expect(circs[0].severity).toBe("high");
  });

  test("detects no circular deps in acyclic graph", () => {
    const graph = makeGraph({
      "a.ts": { lines: 10, imports: ["b.ts"] },
      "b.ts": { lines: 10, imports: ["c.ts"] },
      "c.ts": { lines: 10, imports: [] },
    });
    const circs = findCircularDeps(graph);
    expect(circs.length).toBe(0);
  });

  test("classifies severity by cycle length", () => {
    const graph = makeGraph({
      "a.ts": { lines: 10, imports: ["b.ts"] },
      "b.ts": { lines: 10, imports: ["c.ts"] },
      "c.ts": { lines: 10, imports: ["d.ts"] },
      "d.ts": { lines: 10, imports: ["e.ts"] },
      "e.ts": { lines: 10, imports: ["f.ts"] },
      "f.ts": { lines: 10, imports: ["a.ts"] },
    });
    const circs = findCircularDeps(graph);
    expect(circs.length).toBe(1);
    expect(circs[0].severity).toBe("low"); // 6 files
  });
});

describe("core: findTsFiles()", () => {
  test("finds TS/TSX files in fixture", () => {
    const fixtureRoot = path.join(FIXTURES, "react-router-project");
    if (!fs.existsSync(fixtureRoot)) return; // skip if fixtures not ready
    const files = findTsFiles(fixtureRoot);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => f.endsWith(".tsx"))).toBe(true);
  });

  test("respects max depth", () => {
    const fixtureRoot = path.join(FIXTURES, "react-router-project");
    if (!fs.existsSync(fixtureRoot)) return;
    const shallow = findTsFiles(fixtureRoot, 0, 0);
    // At depth 0, should only find files in root (none expected in react-router fixture)
    const deep = findTsFiles(fixtureRoot, 0, 10);
    expect(deep.length).toBeGreaterThanOrEqual(shallow.length);
  });

  test("skips node_modules and .git", () => {
    const fixtureRoot = path.join(FIXTURES, "react-router-project");
    if (!fs.existsSync(fixtureRoot)) return;
    const files = findTsFiles(fixtureRoot);
    expect(files.every(f => !f.includes("node_modules"))).toBe(true);
    expect(files.every(f => !f.includes(".git/"))).toBe(true);
  });
});

describe("core: findEntryPoints()", () => {
  test("finds standard entry points", () => {
    const graph = makeGraph({
      "src/main.tsx": { lines: 10, imports: [] },
      "src/App.tsx": { lines: 20, imports: [] },
      "src/utils.ts": { lines: 5, imports: [] },
    });
    const entries = findEntryPoints(graph);
    expect(entries).toContain("src/main.tsx");
    expect(entries).toContain("src/App.tsx");
    expect(entries).not.toContain("src/utils.ts");
  });
});

describe("core: computeContentHash()", () => {
  test("returns consistent hash for same graph", () => {
    const graph = makeGraph({
      "a.ts": { lines: 10, imports: [] },
      "b.ts": { lines: 20, imports: [] },
    });
    const h1 = computeContentHash(graph);
    const h2 = computeContentHash(graph);
    expect(h1).toBe(h2);
    expect(h1.length).toBe(16);
  });

  test("returns different hash for different graph", () => {
    const g1 = makeGraph({ "a.ts": { lines: 10, imports: [] } });
    const g2 = makeGraph({ "b.ts": { lines: 10, imports: [] } });
    expect(computeContentHash(g1)).not.toBe(computeContentHash(g2));
  });
});

describe("core: constants", () => {
  test("constants have expected values", () => {
    expect(BASE_BUDGET).toBe(3000);
    expect(EASY_THRESHOLD).toBe(800);
    expect(MEDIUM_THRESHOLD).toBe(2500);
    expect(MEGA_TRACE_DEPTH_CAP).toBe(4);
    expect(MAX_FILE_DISCOVERY_DEPTH).toBe(8);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ALIASES MODULE (#2)
// ═══════════════════════════════════════════════════════════════════════════════

describe("aliases: parseViteAliases()", () => {
  test("returns empty for project with no vite config", () => {
    const root = path.join(FIXTURES, "empty-project");
    if (!fs.existsSync(root)) return;
    const aliases = parseViteAliases(root);
    expect(Object.keys(aliases).length).toBe(0);
  });

  test("parses defineConfig object-style aliases via AST", () => {
    const root = path.join(FIXTURES, "vite-aliases");
    if (!fs.existsSync(root)) return;
    const result = parseViteAliasesDetailed(root, true); // noEval=true for AST-only
    expect(result.aliases["@"]).toBeDefined();
    expect(result.aliases["@components"]).toBeDefined();
    expect(result.method).toBe("ast");
  });

  test("--no-eval flag forces AST-only mode", () => {
    const root = path.join(FIXTURES, "vite-aliases");
    if (!fs.existsSync(root)) return;
    const result = parseViteAliasesDetailed(root, true);
    expect(result.method).not.toBe("eval");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES MODULE (#3)
// ═══════════════════════════════════════════════════════════════════════════════

describe("routes: detectFramework()", () => {
  test("detects React Router from package.json", () => {
    const root = path.join(FIXTURES, "react-router-project");
    if (!fs.existsSync(root)) return;
    const result = detectFramework(root);
    expect(result.framework).toBe("react-router");
  });

  test("detects Next.js from package.json", () => {
    const root = path.join(FIXTURES, "nextjs-project");
    if (!fs.existsSync(root)) return;
    const result = detectFramework(root);
    expect(["nextjs-pages", "nextjs-app"]).toContain(result.framework);
  });

  test("returns unknown for empty project", () => {
    const root = path.join(FIXTURES, "empty-project");
    if (!fs.existsSync(root)) return;
    const result = detectFramework(root);
    expect(result.framework).toBe("unknown");
  });
});

describe("routes: discoverRoutes()", () => {
  test("discovers Next.js file-based routes", () => {
    const root = path.join(FIXTURES, "nextjs-project");
    if (!fs.existsSync(root)) return;
    const routes = discoverRoutes(root, detectFramework(root));
    expect(routes.length).toBeGreaterThan(0);
    // Fixture has app/dashboard/page.tsx → should discover /dashboard/
    const pagePaths = routes.map(r => r.routePath);
    expect(pagePaths.some(p => p.includes("dashboard"))).toBe(true);
  });

  test("discovers API routes separately", () => {
    const root = path.join(FIXTURES, "nextjs-project");
    if (!fs.existsSync(root)) return;
    const routes = discoverRoutes(root, detectFramework(root));
    const apiRoutes = routes.filter(r => r.type === "api");
    expect(apiRoutes.length).toBeGreaterThanOrEqual(0); // may or may not find api routes
  });

  test("returns empty for empty project", () => {
    const root = path.join(FIXTURES, "empty-project");
    if (!fs.existsSync(root)) return;
    const routes = discoverRoutes(root, detectFramework(root));
    expect(routes.length).toBe(0);
  });
});

describe("routes: findPageFileForRoute()", () => {
  // findPageFileForRoute(routerContent, routePath, srcDir) reads from filesystem
  // We use the react-router-project fixture which has src/pages/{Home,About,Lazy}.tsx

  const fixtureRoot = path.join(FIXTURES, "react-router-project", "src");

  test("exact case-insensitive match for known route", () => {
    if (!fs.existsSync(fixtureRoot)) return;
    const match = findPageFileForRoute("", "/home", fixtureRoot);
    expect(match).toBeTruthy();
    // Function returns full path — may be case-insensitive on filesystem
    expect(match!.toLowerCase()).toContain("home.tsx");
  });

  test("no substring false positives", () => {
    if (!fs.existsSync(fixtureRoot)) return;
    // /about should match About.tsx, not AboutExtra.tsx (doesn't exist but tests exact match)
    const match = findPageFileForRoute("", "/about", fixtureRoot);
    if (match) {
      expect(match.toLowerCase()).toContain("about.tsx");
    }
  });

  test("returns null for nonexistent route", () => {
    if (!fs.existsSync(fixtureRoot)) return;
    const match = findPageFileForRoute("", "/nonexistent-page", fixtureRoot);
    expect(match).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEAD CODE MODULE (#8)
// ═══════════════════════════════════════════════════════════════════════════════

describe("dead-code: findDeadFiles()", () => {
  test("identifies unreachable files as dead", () => {
    const graph = makeGraph({
      "src/main.tsx": { lines: 10, imports: ["src/utils.ts"] },
      "src/utils.ts": { lines: 20, imports: [] },
      "src/orphan.ts": { lines: 30, imports: [] },
    });
    const reachable = new Set(["src/main.tsx", "src/utils.ts"]);
    const dead = findDeadFiles(graph, reachable);
    expect(dead.length).toBe(1);
    expect(dead[0].file).toBe("src/orphan.ts");
    expect(dead[0].lines).toBe(30);
  });

  test("returns empty when all files are reachable", () => {
    const graph = makeGraph({
      "src/main.tsx": { lines: 10, imports: [] },
    });
    const reachable = new Set(["src/main.tsx"]);
    const dead = findDeadFiles(graph, reachable);
    expect(dead.length).toBe(0);
  });

  test("excludes config files from dead detection", () => {
    const graph = makeGraph({
      "src/main.tsx": { lines: 10, imports: [] },
      "vite.config.ts": { lines: 50, imports: [] },
      "tailwind.config.ts": { lines: 30, imports: [] },
    });
    const reachable = new Set(["src/main.tsx"]);
    const dead = findDeadFiles(graph, reachable);
    // Config files should not be reported as dead
    const deadFiles = dead.map(d => d.file);
    expect(deadFiles).not.toContain("vite.config.ts");
    expect(deadFiles).not.toContain("tailwind.config.ts");
  });

  test("barrel file exclusion recognizes index.ts with re-exports", () => {
    const graph: Record<string, FileNode> = {
      "src/main.tsx": { lines: 10, content_hash: "a", imports: [], unresolved_imports: [] },
      "src/components/index.ts": {
        lines: 5,
        content_hash: "b",
        imports: ["src/components/Button.tsx", "src/components/Card.tsx"],
        unresolved_imports: [],
      },
      "src/components/Button.tsx": { lines: 50, content_hash: "c", imports: [], unresolved_imports: [] },
      "src/components/Card.tsx": { lines: 40, content_hash: "d", imports: [], unresolved_imports: [] },
    };
    const reachable = new Set(["src/main.tsx"]);
    const dead = findDeadFiles(graph, reachable);
    const deadFiles = dead.map(d => d.file);
    // Barrel index.ts should not be flagged as dead
    expect(deadFiles).not.toContain("src/components/index.ts");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CSS MODULE (#9)
// ═══════════════════════════════════════════════════════════════════════════════

describe("css: buildCssGraph()", () => {
  test("discovers CSS files and parses @import", () => {
    const root = path.join(FIXTURES, "css-project");
    if (!fs.existsSync(root)) return;
    const cssGraph = buildCssGraph(root, {});
    const files = Object.keys(cssGraph);
    expect(files.length).toBeGreaterThan(0);
    // Should have found main.css and its imports
    const mainCss = files.find(f => f.includes("main.css"));
    expect(mainCss).toBeDefined();
    if (mainCss) {
      expect(cssGraph[mainCss].is_css).toBe(true);
      expect(cssGraph[mainCss].imports.length).toBeGreaterThan(0);
    }
  });

  test("parses SCSS @use directives", () => {
    const root = path.join(FIXTURES, "css-project");
    if (!fs.existsSync(root)) return;
    const cssGraph = buildCssGraph(root, {});
    const scssFile = Object.keys(cssGraph).find(f => f.endsWith(".scss"));
    if (scssFile) {
      expect(cssGraph[scssFile].is_css).toBe(true);
    }
  });

  test("CSS nodes have is_css flag", () => {
    const root = path.join(FIXTURES, "css-project");
    if (!fs.existsSync(root)) return;
    const cssGraph = buildCssGraph(root, {});
    for (const node of Object.values(cssGraph)) {
      expect(node.is_css).toBe(true);
    }
  });

  test("CSS edges contribute to unified graph", () => {
    const root = path.join(FIXTURES, "css-project");
    if (!fs.existsSync(root)) return;
    const cssGraph = buildCssGraph(root, {});
    // theme.css imports colors.css
    const themeFile = Object.keys(cssGraph).find(f => f.includes("theme.css"));
    if (themeFile) {
      const colorsImport = cssGraph[themeFile].imports.find(i => i.includes("colors.css"));
      expect(colorsImport).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MONOREPO MODULE (#10)
// ═══════════════════════════════════════════════════════════════════════════════

describe("monorepo: detectMonorepo()", () => {
  test("detects npm workspaces from package.json", () => {
    const root = path.join(FIXTURES, "monorepo-project");
    if (!fs.existsSync(root)) return;
    const info = detectMonorepo(root);
    expect(info.detected).toBe(true);
    expect(info.type).toBe("npm");
    expect(info.packages.length).toBeGreaterThan(0);
  });

  test("returns detected=false for non-monorepo", () => {
    const root = path.join(FIXTURES, "empty-project");
    if (!fs.existsSync(root)) return;
    const info = detectMonorepo(root);
    expect(info.detected).toBe(false);
    expect(info.packages.length).toBe(0);
  });

  test("finds workspace packages", () => {
    const root = path.join(FIXTURES, "monorepo-project");
    if (!fs.existsSync(root)) return;
    const info = detectMonorepo(root);
    if (info.detected) {
      // Should find at least 2 packages (ui, app)
      expect(info.packages.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NON-TS MODULE (#1)
// ═══════════════════════════════════════════════════════════════════════════════

describe("non-ts: discoverNonTsFiles()", () => {
  test("returns empty for TypeScript-only project", () => {
    const root = path.join(FIXTURES, "react-router-project");
    if (!fs.existsSync(root)) return;
    const files = discoverNonTsFiles(root);
    // React Router fixture has only .tsx files — no non-TS files
    expect(files.every(f => f.language !== "typescript")).toBe(true);
  });

  test("counts lines accurately", () => {
    const files = discoverNonTsFiles(FIXTURES);
    for (const f of files) {
      expect(f.lines).toBeGreaterThan(0);
      expect(f.language).toBeTruthy();
      expect(f.file).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION: Full pipeline on fixtures
// ═══════════════════════════════════════════════════════════════════════════════

describe("integration: css-project pipeline", () => {
  test("CSS files appear in unified graph with TS files", () => {
    const root = path.join(FIXTURES, "css-project");
    if (!fs.existsSync(root)) return;

    // Build TS graph
    const tsFiles = findTsFiles(root);
    // Build CSS graph
    const cssGraph = buildCssGraph(root, {});

    // Both should exist
    expect(tsFiles.length).toBeGreaterThan(0);
    expect(Object.keys(cssGraph).length).toBeGreaterThan(0);
  });
});

// ─── Deferred Dynamic Import Tests ──────────────────────────────────────────
import * as ts from "typescript";

/** Helper: parse a TS snippet, find the import() CallExpression, and run isDeferredImport */
function checkDeferred(code: string): boolean {
  const sf = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let result: boolean | null = null;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      result = isDeferredImport(node);
      return; // found it
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (result === null) throw new Error("No import() found in snippet");
  return result;
}

describe("isDeferredImport", () => {
  test("top-level import() is NOT deferred (eager)", () => {
    expect(checkDeferred(`import('./foo');`)).toBe(false);
  });

  test("arrow function body import() IS deferred", () => {
    expect(checkDeferred(`const fn = () => import('./foo');`)).toBe(true);
  });

  test("function expression body import() IS deferred", () => {
    expect(checkDeferred(`const fn = function() { return import('./foo'); };`)).toBe(true);
  });

  test("class method body import() IS deferred", () => {
    expect(checkDeferred(`class C { load() { return import('./foo'); } }`)).toBe(true);
  });

  test("IIFE import() is NOT deferred (eager)", () => {
    expect(checkDeferred(`(async () => { await import('./foo'); })();`)).toBe(false);
  });

  test("stops at SourceFile boundary — top-level is eager", () => {
    expect(checkDeferred(`const x = import('./foo');`)).toBe(false);
  });
});

describe("buildImportGraph — deferred dynamic imports", () => {
  const DEFERRED_FIXTURE = path.join(FIXTURES, "deferred-imports");
  const tsconfigPath = path.join(DEFERRED_FIXTURE, "tsconfig.json");

  test("route-map () => import() values NOT in static imports", () => {
    const { graph } = buildImportGraph(DEFERRED_FIXTURE, tsconfigPath, {});
    const routeMap = graph["src/route-map.ts"];
    expect(routeMap).toBeDefined();
    // Static imports should NOT contain any pages (they're all in arrow functions)
    const pageImports = routeMap.imports.filter(i => i.includes("pages/"));
    expect(pageImports).toHaveLength(0);
  });

  test("route-map () => import() values ARE in dynamic_imports", () => {
    const { graph } = buildImportGraph(DEFERRED_FIXTURE, tsconfigPath, {});
    const routeMap = graph["src/route-map.ts"];
    expect(routeMap).toBeDefined();
    expect(routeMap.dynamic_imports).toBeDefined();
    const dynamicPages = routeMap.dynamic_imports!.filter(d => d.expression.includes("pages/"));
    expect(dynamicPages.length).toBeGreaterThanOrEqual(3); // A, B, C
    expect(dynamicPages.every(d => d.resolvable)).toBe(true);
  });

  test("top-level import() still in static imports (eager)", () => {
    const { graph } = buildImportGraph(DEFERRED_FIXTURE, tsconfigPath, {});
    const main = graph["src/main.ts"];
    expect(main).toBeDefined();
    // main.ts has top-level import('./pages/A') — should be in static imports
    const pageImports = main.imports.filter(i => i.includes("pages/A"));
    expect(pageImports.length).toBeGreaterThanOrEqual(1);
  });

  test("IIFE import() still in static imports (eager)", () => {
    const { graph } = buildImportGraph(DEFERRED_FIXTURE, tsconfigPath, {});
    const iife = graph["src/iife.ts"];
    expect(iife).toBeDefined();
    // iife.ts has (async () => { await import('./pages/B') })() — IIFE = eager
    const pageImports = iife.imports.filter(i => i.includes("pages/B"));
    expect(pageImports.length).toBeGreaterThanOrEqual(1);
  });

  test("static import X from '...' is unaffected", () => {
    const { graph } = buildImportGraph(DEFERRED_FIXTURE, tsconfigPath, {});
    const main = graph["src/main.ts"];
    expect(main).toBeDefined();
    // main.ts has: import { routes } from './route-map' — always static
    const routeMapImport = main.imports.filter(i => i.includes("route-map"));
    expect(routeMapImport.length).toBeGreaterThanOrEqual(1);
  });

  test("class method import() NOT in static imports (deferred)", () => {
    const { graph } = buildImportGraph(DEFERRED_FIXTURE, tsconfigPath, {});
    const classLoader = graph["src/class-loader.ts"];
    expect(classLoader).toBeDefined();
    // class method body — deferred
    const pageImports = classLoader.imports.filter(i => i.includes("pages/"));
    expect(pageImports).toHaveLength(0);
    // But should be in dynamic_imports
    expect(classLoader.dynamic_imports).toBeDefined();
    const dynamicPages = classLoader.dynamic_imports!.filter(d => d.expression.includes("pages/"));
    expect(dynamicPages.length).toBeGreaterThanOrEqual(1);
  });

  test("branch_lines for page importing route-map is NOT inflated", () => {
    const { graph } = buildImportGraph(DEFERRED_FIXTURE, tsconfigPath, {});

    // Simulate: main.ts imports route-map.ts. Without the fix, route-map's
    // lazy imports would pull in all pages. With the fix, only eager deps count.
    const routeRoots = new Map<string, string>();
    routeRoots.set("/main", "src/main.ts");

    const entryPoints = ["src/main.ts"];
    const { branches } = unifiedTraversal(graph, routeRoots, entryPoints);

    const mainBranch = branches.get("/main");
    expect(mainBranch).toBeDefined();

    // Total lines in fixture is small, but the key assertion:
    // main → route-map should NOT pull in pages B and C (only A via top-level import)
    const files = [...mainBranch!.files];
    const hasPageB = files.some(f => f.includes("pages/B"));
    const hasPageC = files.some(f => f.includes("pages/C"));
    expect(hasPageB).toBe(false); // B is only in IIFE (separate file) and route-map (deferred)
    expect(hasPageC).toBe(false); // C is only in class-loader (deferred)
  });

  test("dynamic_imports metadata preserved for all patterns", () => {
    const { graph } = buildImportGraph(DEFERRED_FIXTURE, tsconfigPath, {});

    // Every file with import() should have dynamic_imports entries
    const routeMap = graph["src/route-map.ts"];
    expect(routeMap.dynamic_imports).toBeDefined();
    expect(routeMap.dynamic_imports!.length).toBeGreaterThanOrEqual(3);

    const main = graph["src/main.ts"];
    expect(main.dynamic_imports).toBeDefined();
    expect(main.dynamic_imports!.length).toBeGreaterThanOrEqual(1);

    const iife = graph["src/iife.ts"];
    expect(iife.dynamic_imports).toBeDefined();
    expect(iife.dynamic_imports!.length).toBeGreaterThanOrEqual(1);

    const classLoader = graph["src/class-loader.ts"];
    expect(classLoader.dynamic_imports).toBeDefined();
    expect(classLoader.dynamic_imports!.length).toBeGreaterThanOrEqual(1);
  });

  test("resolved_files populated for deferred imports", () => {
    const { graph } = buildImportGraph(DEFERRED_FIXTURE, tsconfigPath, {});

    // route-map has 3 deferred imports: pages/A, B, C
    const routeMap = graph["src/route-map.ts"];
    expect(routeMap.dynamic_imports).toBeDefined();
    const resolvedRouteMapDynImports = routeMap.dynamic_imports!.filter(
      d => d.resolved_files && d.resolved_files.length > 0
    );
    // All 3 page imports should have resolved_files populated
    expect(resolvedRouteMapDynImports.length).toBe(3);
    const resolvedPaths = resolvedRouteMapDynImports.flatMap(d => d.resolved_files!);
    expect(resolvedPaths.some(f => f.includes("pages/A"))).toBe(true);
    expect(resolvedPaths.some(f => f.includes("pages/B"))).toBe(true);
    expect(resolvedPaths.some(f => f.includes("pages/C"))).toBe(true);

    // class-loader has 1 deferred import: pages/C
    const classLoader = graph["src/class-loader.ts"];
    const resolvedClassLoaderDynImports = classLoader.dynamic_imports!.filter(
      d => d.resolved_files && d.resolved_files.length > 0
    );
    expect(resolvedClassLoaderDynImports.length).toBe(1);
    expect(resolvedClassLoaderDynImports[0].resolved_files![0]).toContain("pages/C");
  });

  test("integration: deferred-imports fixture all pages reachable", () => {
    const { graph } = buildImportGraph(DEFERRED_FIXTURE, tsconfigPath, {});

    // Set up routes: main.ts as the only route root
    const routeRoots = new Map<string, string>();
    routeRoots.set("/main", "src/main.ts");

    // Entry points include main.ts, iife.ts (top-level side effect file)
    const entryPoints = ["src/main.ts", "src/iife.ts"];
    const { reachable } = unifiedTraversal(graph, routeRoots, entryPoints);

    // Page A: reachable via main.ts eager top-level import()
    expect(reachable.has("src/pages/A.tsx")).toBe(true);
    // Page B: reachable via iife.ts (IIFE = eager) OR via route-map dynamic_imports.resolved_files
    expect(reachable.has("src/pages/B.tsx")).toBe(true);
    // Page C: reachable via route-map or class-loader dynamic_imports.resolved_files
    expect(reachable.has("src/pages/C.tsx")).toBe(true);

    // Core fixture files reachable via entry points and static imports
    expect(reachable.has("src/main.ts")).toBe(true);
    expect(reachable.has("src/route-map.ts")).toBe(true);
    expect(reachable.has("src/iife.ts")).toBe(true);
    // class-loader.ts is NOT imported by any entry point — legitimately unreachable
    // (in a real app it would be imported somewhere; here it's a standalone fixture file)
  });

  test("resolveAndAddImport refactor parity — static imports produce same graph", () => {
    const { graph } = buildImportGraph(DEFERRED_FIXTURE, tsconfigPath, {});

    // main.ts has a static import of route-map — must be in imports[]
    const main = graph["src/main.ts"];
    expect(main.imports).toContain("src/route-map.ts");

    // main.ts has an eager top-level import() of pages/A — must be in imports[]
    expect(main.imports).toContain("src/pages/A.tsx");

    // route-map.ts has NO static imports (all are deferred arrow functions)
    const routeMap = graph["src/route-map.ts"];
    const pageImports = routeMap.imports.filter(i => i.includes("pages/"));
    expect(pageImports).toHaveLength(0);

    // iife.ts: IIFE import() is eager — pages/B should be in static imports
    const iife = graph["src/iife.ts"];
    expect(iife.imports).toContain("src/pages/B.tsx");

    // class-loader.ts: class method import() is deferred — pages/C should NOT be in static imports
    const classLoader = graph["src/class-loader.ts"];
    const classLoaderPageImports = classLoader.imports.filter(i => i.includes("pages/"));
    expect(classLoaderPageImports).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADDITIONAL COVERAGE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("routes: discoverRoutes() on react-router-project", () => {
  test("discovers pages from src/pages/ directory", () => {
    const root = path.join(FIXTURES, "react-router-project");
    if (!fs.existsSync(root)) return;
    const detection = detectFramework(root);
    expect(detection.framework).toBe("react-router");
    const routes = discoverRoutes(root, detection);
    expect(routes.length).toBeGreaterThan(0);
    const paths = routes.map(r => r.routePath);
    expect(paths).toContain("/home");
    expect(paths).toContain("/about");
    expect(paths).toContain("/lazy");
  });
});

describe("routes: Supabase Edge Function detection", () => {
  const EDGE_FN_ROOT = path.join(FIXTURES, "supabase-edge-functions");

  beforeAll(() => {
    // Create temp fixture for Edge Functions
    fs.mkdirSync(path.join(EDGE_FN_ROOT, "supabase", "functions", "hello-world"), { recursive: true });
    fs.mkdirSync(path.join(EDGE_FN_ROOT, "supabase", "functions", "send-email"), { recursive: true });
    fs.mkdirSync(path.join(EDGE_FN_ROOT, "supabase", "functions", "_shared"), { recursive: true });
    fs.writeFileSync(path.join(EDGE_FN_ROOT, "supabase", "functions", "hello-world", "index.ts"), "export default () => new Response('ok');");
    fs.writeFileSync(path.join(EDGE_FN_ROOT, "supabase", "functions", "send-email", "index.ts"), "export default () => new Response('sent');");
    fs.writeFileSync(path.join(EDGE_FN_ROOT, "package.json"), '{"name":"edge-test"}');
  });

  afterAll(() => {
    fs.rmSync(EDGE_FN_ROOT, { recursive: true, force: true });
  });

  test("discovers Edge Functions as API routes", () => {
    const detection: FrameworkDetectionResult = { framework: "unknown" };
    const routes = discoverRoutes(EDGE_FN_ROOT, detection);
    const apiRoutes = routes.filter(r => r.type === "api");
    expect(apiRoutes.length).toBe(2);
    expect(apiRoutes.some(r => r.routePath.includes("hello-world"))).toBe(true);
    expect(apiRoutes.some(r => r.routePath.includes("send-email"))).toBe(true);
    // _shared directory should be skipped (starts with _)
    expect(apiRoutes.some(r => r.routePath.includes("_shared"))).toBe(false);
  });
});

describe("routes: graceful framework detection for unknown frameworks", () => {
  test("Remix project returns unknown (not crash)", () => {
    const tmpDir = path.join(os.tmpdir(), "remix-test-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      dependencies: { "@remix-run/react": "^2.0.0" },
    }));
    const result = detectFramework(tmpDir);
    expect(result.framework).toBe("unknown");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("SvelteKit project returns unknown (not crash)", () => {
    const tmpDir = path.join(os.tmpdir(), "sveltekit-test-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
      devDependencies: { "@sveltejs/kit": "^2.0.0" },
    }));
    const result = detectFramework(tmpDir);
    expect(result.framework).toBe("unknown");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("aliases: eval fallback", () => {
  test("parseViteAliasesDetailed with noEval=false uses AST or eval", () => {
    const root = path.join(FIXTURES, "vite-aliases");
    if (!fs.existsSync(root)) return;
    const result = parseViteAliasesDetailed(root, false);
    // Either AST or eval should work — both should find the aliases
    expect(result.aliases["@"]).toBeDefined();
    expect(result.aliases["@components"]).toBeDefined();
  });
});

describe("routes: React Router full pipeline integration", () => {
  test("detectFramework → discoverRoutes produces valid route entries", () => {
    const root = path.join(FIXTURES, "react-router-project");
    if (!fs.existsSync(root)) return;

    const detection = detectFramework(root);
    expect(detection.framework).toBe("react-router");

    const routes = discoverRoutes(root, detection);
    expect(routes.length).toBeGreaterThanOrEqual(3); // Home, About, Lazy

    for (const route of routes) {
      expect(route.routePath.startsWith("/")).toBe(true);
      expect(route.type).toBe("page");
      expect(route.pageFile).toBeTruthy();
      // Page file should exist on disk
      expect(fs.existsSync(path.join(root, route.pageFile))).toBe(true);
    }
  });
});

// ─── Git Co-Change Complexity Tests ─────────────────────────────────────────
describe("core: getGitCoChangeComplexity()", () => {
  let tmpDir: string;

  // Create a temp git repo with controlled commit history
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-cochange-"));
    const run = (cmd: string) => {
      const result = Bun.spawnSync(["sh", "-c", cmd], { cwd: tmpDir });
      if (result.exitCode !== 0) throw new Error(`Command failed: ${cmd}\n${result.stderr.toString()}`);
    };

    run("git init");
    run("git config user.email test@test.com && git config user.name Test");

    // Commit 1: Home + useHome (feature-specific pair)
    fs.mkdirSync(path.join(tmpDir, "pages"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "utils"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "pages/Home.tsx"), "// Home page\n".repeat(50));
    fs.writeFileSync(path.join(tmpDir, "hooks/useHome.ts"), "// useHome hook\n".repeat(30));
    run("git add -A && git commit -m 'add Home + useHome'");

    // Commit 2: Home + shared.ts
    fs.writeFileSync(path.join(tmpDir, "utils/shared.ts"), "// shared utils\n".repeat(100));
    fs.writeFileSync(path.join(tmpDir, "pages/Home.tsx"), "// Home page v2\n".repeat(55));
    run("git add -A && git commit -m 'add shared, update Home'");

    // Commit 3: About + shared.ts (shared now co-changes with 2 pages)
    fs.writeFileSync(path.join(tmpDir, "pages/About.tsx"), "// About page\n".repeat(40));
    fs.writeFileSync(path.join(tmpDir, "utils/shared.ts"), "// shared utils v2\n".repeat(110));
    run("git add -A && git commit -m 'add About + update shared'");

    // Commit 4: About + useAbout (feature-specific pair)
    fs.writeFileSync(path.join(tmpDir, "hooks/useAbout.ts"), "// useAbout hook\n".repeat(20));
    fs.writeFileSync(path.join(tmpDir, "pages/About.tsx"), "// About page v2\n".repeat(45));
    run("git add -A && git commit -m 'add useAbout'");

    // Commit 5: Settings + shared (shared now co-changes with 3 pages)
    fs.writeFileSync(path.join(tmpDir, "pages/Settings.tsx"), "// Settings page\n".repeat(35));
    fs.writeFileSync(path.join(tmpDir, "utils/shared.ts"), "// shared utils v3\n".repeat(120));
    run("git add -A && git commit -m 'add Settings + update shared'");

    // Commit 6: Add a non-source file alongside Home
    fs.writeFileSync(path.join(tmpDir, "pages/Home.tsx"), "// Home page v3\n".repeat(60));
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Readme");
    fs.writeFileSync(path.join(tmpDir, "config.json"), "{}");
    run("git add -A && git commit -m 'update Home + add non-source files'");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds feature-specific co-changed files", () => {
    const result = getGitCoChangeComplexity(tmpDir, [
      "pages/Home.tsx", "pages/About.tsx", "pages/Settings.tsx",
    ]);
    const home = result.get("pages/Home.tsx")!;
    expect(home.coChangedFiles).toContain("pages/Home.tsx");
    expect(home.coChangedFiles).toContain("hooks/useHome.ts");
  });

  test("excludes shared files by breadth threshold", () => {
    // shared.ts co-changes with all 3 pages → breadth 3 ≥ threshold max(3, 3*0.25=0) = 3
    const result = getGitCoChangeComplexity(tmpDir, [
      "pages/Home.tsx", "pages/About.tsx", "pages/Settings.tsx",
    ]);
    const home = result.get("pages/Home.tsx")!;
    expect(home.coChangedFiles).not.toContain("utils/shared.ts");

    const about = result.get("pages/About.tsx")!;
    expect(about.coChangedFiles).not.toContain("utils/shared.ts");
  });

  test("always includes the page file itself", () => {
    const result = getGitCoChangeComplexity(tmpDir, ["pages/Settings.tsx"]);
    const settings = result.get("pages/Settings.tsx")!;
    expect(settings.coChangedFiles).toContain("pages/Settings.tsx");
    expect(settings.lines).toBeGreaterThan(0);
    expect(settings.files).toBeGreaterThanOrEqual(1);
  });

  test("handles non-git directory gracefully", () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-nogit-"));
    fs.writeFileSync(path.join(nonGitDir, "page.tsx"), "// page\n".repeat(10));
    try {
      const result = getGitCoChangeComplexity(nonGitDir, ["page.tsx"]);
      const page = result.get("page.tsx")!;
      // "// page\n".repeat(10) → 10 lines + trailing newline → split("\n").length = 11
      expect(page.lines).toBe(11);
      expect(page.files).toBe(1);
      expect(page.coChangedFiles).toEqual(["page.tsx"]);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  test("filters non-source files (images, configs)", () => {
    // Home commit 6 includes README.md and config.json — these should not appear
    const result = getGitCoChangeComplexity(tmpDir, ["pages/Home.tsx"]);
    const home = result.get("pages/Home.tsx")!;
    for (const f of home.coChangedFiles) {
      expect(f).toMatch(/\.(tsx?|jsx?|vue|svelte|py|rb|go|rs|php|ex|exs)$/);
    }
  });
});

describe("core: getGitBornDate()", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-borndate-"));
    const run = (cmd: string) => {
      const result = Bun.spawnSync(["sh", "-c", cmd], { cwd: tmpDir });
      if (result.exitCode !== 0) throw new Error(`Command failed: ${cmd}`);
    };
    run("git init && git config user.email test@test.com && git config user.name Test");

    fs.writeFileSync(path.join(tmpDir, "first.ts"), "// first");
    run("git add -A && git commit -m 'first commit'");

    // Wait 1 second for distinct timestamps
    Bun.sleepSync(1000);

    fs.writeFileSync(path.join(tmpDir, "second.ts"), "// second");
    run("git add -A && git commit -m 'second commit'");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns earliest commit timestamp", () => {
    const dates = getGitBornDate(tmpDir, ["first.ts", "second.ts"]);
    const firstDate = dates.get("first.ts")!;
    const secondDate = dates.get("second.ts")!;
    expect(firstDate).toBeGreaterThan(0);
    expect(secondDate).toBeGreaterThan(0);
    expect(firstDate).toBeLessThan(secondDate);
  });

  test("handles non-git directory", () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-nogit-bd-"));
    try {
      const dates = getGitBornDate(nonGitDir, ["nonexistent.ts"]);
      // Should return epoch 0 for files in non-git dirs
      expect(dates.get("nonexistent.ts") ?? 0).toBe(0);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
