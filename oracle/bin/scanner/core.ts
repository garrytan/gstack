/**
 * scanner/core.ts — Core interfaces, graph construction, and unified traversal
 *
 * This module provides:
 * - All shared interfaces (FileNode, RouteEntry, etc.)
 * - Import graph construction using TypeScript compiler API
 * - Unified graph traversal (replaces buildBranch + findDeadFiles BFS)
 * - Classification and session estimation
 */

import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

// ─── Constants ──────────────────────────────────────────────────────────────
export const BASE_BUDGET = 3000;
export const TOKEN_RATIO_MAP_TO_SOURCE = 3;
export const EASY_THRESHOLD = 800;
export const MEDIUM_THRESHOLD = 2500;
export const MEGA_TRACE_DEPTH_CAP = 4;
export const MAX_FILE_DISCOVERY_DEPTH = 8;

// ─── Interfaces ─────────────────────────────────────────────────────────────
export interface FileNode {
  lines: number;
  content_hash: string;
  imports: string[];
  unresolved_imports: UnresolvedImport[];
  dynamic_imports?: DynamicImport[];
  is_css?: boolean;
}

export interface UnresolvedImport {
  specifier: string;
  reason: string;
}

export interface DynamicImport {
  expression: string;
  resolvable: boolean;
  resolved_files?: string[];
}

export interface DiscoveredRoute {
  routePath: string;
  type: "page" | "api" | "worker";
  pageFile: string;
}

export interface RouteEntry {
  path: string;
  type: "page" | "api" | "worker";
  page_file: string;
  branch_lines: number;
  branch_files: number;
  classification: "easy" | "medium" | "hard" | "mega" | "unknown";
  session_slots: number;
  status: "not_started" | "partial" | "complete";
  born_date?: number;
  co_changed_files?: string[];
}

export interface CircularDep {
  files: string[];
  severity: "high" | "medium" | "low";
  cycle_length: number;
}

export interface DeadFile {
  file: string;
  confidence: "high" | "medium" | "low";
  lines: number;
}

export interface NonTsFile {
  file: string;
  language: string;
  lines: number;
}

export interface ScanManifest {
  schema_version: number;
  scanned_at: string;
  head_sha?: string;
  project: string;
  total_files: number;
  total_lines: number;
  routes: RouteEntry[];
  circular_deps: CircularDep[];
  dead_files: DeadFile[];
  unresolved_imports: { file: string; import: string; reason: string }[];
  skipped_files: { file: string; reason: string }[];
  non_ts_files: NonTsFile[];
  import_graph: Record<string, FileNode>;
  estimated_sessions: {
    easy: number;
    medium: number;
    hard: number;
    mega: number;
    total_min: number;
    total_max: number;
  };
  content_hash: string;
  monorepo?: {
    detected: boolean;
    type?: string;
    packages?: string[];
  };
}

export interface BranchResult {
  totalLines: number;
  fileCount: number;
  maxDepth: number;
  files: Set<string>;
}

export interface TraversalResult {
  branches: Map<string, BranchResult>;
  reachable: Set<string>;
  routeMembership: Map<string, Set<string>>;
}

// ─── CLI Options ────────────────────────────────────────────────────────────
export interface ScanOptions {
  tsconfigPath: string;
  projectRoot: string;
  maxDepth: number;
  megaDepthCap: number;
  noCss: boolean;
  noMonorepo: boolean;
  noEval: boolean;
  noNonTs: boolean;
  diff?: boolean;
  dryRun?: boolean;
  gitFrequency?: boolean;
  visualize?: boolean;
}

// ─── Import Graph Construction ──────────────────────────────────────────────
export function buildImportGraph(
  root: string,
  configPath: string,
  viteAliases: Record<string, string>
): {
  graph: Record<string, FileNode>;
  skippedFiles: { file: string; reason: string }[];
} {
  const graph: Record<string, FileNode> = {};
  const skippedFiles: { file: string; reason: string }[] = [];

  // Parse tsconfig
  let compilerOptions: ts.CompilerOptions = {};
  let fileNames: string[] = [];

  if (fs.existsSync(configPath)) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!configFile.error) {
      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        root
      );
      compilerOptions = parsed.options;
      fileNames = parsed.fileNames;
    }
  }

  if (fileNames.length === 0) {
    fileNames = findTsFiles(root, 0, MAX_FILE_DISCOVERY_DEPTH);
  }

  // Merge Vite aliases into compiler options paths
  if (Object.keys(viteAliases).length > 0) {
    const existingPaths = compilerOptions.paths || {};
    for (const [alias, target] of Object.entries(viteAliases)) {
      const relTarget = path.relative(compilerOptions.baseUrl || root, target);
      const key = `${alias}/*`;
      if (!existingPaths[key]) {
        existingPaths[key] = [`${relTarget}/*`];
      }
      const exactKey = alias;
      if (!existingPaths[exactKey]) {
        existingPaths[exactKey] = [`${relTarget}/index`];
      }
    }
    compilerOptions.paths = existingPaths;
    if (!compilerOptions.baseUrl) {
      compilerOptions.baseUrl = root;
    }
  }

  // Create program and trigger binding (sets parent pointers needed by isDeferredImport)
  const program = ts.createProgram(fileNames, compilerOptions);
  program.getTypeChecker();

  for (const sourceFile of program.getSourceFiles()) {
    const filePath = sourceFile.fileName;
    if (filePath.includes("node_modules") || filePath.endsWith(".d.ts"))
      continue;

    const relPath = path.relative(root, filePath);
    if (relPath.startsWith("..")) continue;

    const content = sourceFile.getFullText();
    const lines = content.split("\n").length;
    const contentHash = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex")
      .substring(0, 12);

    const imports: string[] = [];
    const unresolvedImports: UnresolvedImport[] = [];
    const dynamicImports: DynamicImport[] = [];

    // Walk the AST for import declarations
    ts.forEachChild(sourceFile, function visit(node) {
      // import ... from "..."
      if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
        const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
        resolveAndAddImport(
          specifier, sourceFile, root, program, imports, unresolvedImports
        );
      }

      // export ... from "..."
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
        resolveAndAddImport(
          specifier, sourceFile, root, program, imports, unresolvedImports
        );
      }

      // Dynamic import: import("...")
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1
      ) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg)) {
          // Resolve the import path for ALL dynamic imports (eager and deferred).
          // Only eager imports get added to node.imports (static graph edges).
          // All dynamic imports get resolved_files for reachability analysis.
          const resolvedPath = resolveImportSpecifier(arg.text, sourceFile, root, program);
          if (!isDeferredImport(node)) {
            if (resolvedPath) {
              imports.push(resolvedPath);
            } else if (isLocalSpecifier(arg.text)) {
              unresolvedImports.push({ specifier: arg.text, reason: "unresolved" });
            }
          }
          dynamicImports.push({
            expression: arg.text,
            resolvable: !!resolvedPath,
            resolved_files: resolvedPath ? [resolvedPath] : undefined,
          });
        } else {
          const text = arg.getText(sourceFile);
          unresolvedImports.push({
            specifier: `import(${text})`,
            reason: "dynamic_variable_path",
          });
          dynamicImports.push({ expression: text, resolvable: false });
        }
      }

      // require("...")
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1
      ) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg)) {
          resolveAndAddImport(
            arg.text, sourceFile, root, program, imports, unresolvedImports
          );
        } else {
          unresolvedImports.push({
            specifier: `require(${arg.getText(sourceFile)})`,
            reason: "dynamic_variable_path",
          });
        }
      }

      // import.meta.glob("...") — Vite glob imports (#4)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "glob" &&
        ts.isMetaProperty(node.expression.expression) &&
        node.arguments.length >= 1
      ) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg)) {
          const globPattern = arg.text;
          const resolvedFiles = resolveGlobPattern(globPattern, root, relPath);
          dynamicImports.push({
            expression: `import.meta.glob("${globPattern}")`,
            resolvable: true,
            resolved_files: resolvedFiles,
          });
          // Add resolved files as imports
          for (const f of resolvedFiles) {
            if (!imports.includes(f)) imports.push(f);
          }
        }
      }

      ts.forEachChild(node, visit);
    });

    graph[relPath] = {
      lines,
      content_hash: contentHash,
      imports: [...new Set(imports)],
      unresolved_imports: unresolvedImports,
      dynamic_imports: dynamicImports.length > 0 ? dynamicImports : undefined,
    };
  }

  return { graph, skippedFiles };
}

/** Check if an import specifier is local (relative, aliased, or absolute path) */
function isLocalSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~/")
  );
}

/**
 * Resolve an import specifier to a relative file path within the project.
 * Returns null if the specifier resolves to an external library, node_modules,
 * a path outside the project root, or cannot be resolved at all.
 */
function resolveImportSpecifier(
  specifier: string,
  sourceFile: ts.SourceFile,
  root: string,
  program: ts.Program
): string | null {
  const resolved = ts.resolveModuleName(
    specifier,
    sourceFile.fileName,
    program.getCompilerOptions(),
    ts.sys
  );
  if (!resolved.resolvedModule) return null;
  if (resolved.resolvedModule.isExternalLibraryImport) return null;
  const relPath = path.relative(root, resolved.resolvedModule.resolvedFileName);
  if (relPath.startsWith("..") || relPath.includes("node_modules")) return null;
  return relPath;
}

function resolveAndAddImport(
  specifier: string,
  sourceFile: ts.SourceFile,
  root: string,
  program: ts.Program,
  imports: string[],
  unresolvedImports: UnresolvedImport[]
): void {
  const resolved = resolveImportSpecifier(specifier, sourceFile, root, program);
  if (resolved) {
    imports.push(resolved);
  } else if (isLocalSpecifier(specifier)) {
    unresolvedImports.push({ specifier, reason: "unresolved" });
  }
}

/**
 * Check if an import() call is inside a deferred context (arrow function,
 * function expression, method) — meaning it's lazy-loaded at runtime, not
 * eagerly loaded at module init.
 *
 * Handles the IIFE exception: (async () => { await import('...') })() is eager
 * because the wrapping function is immediately invoked.
 */
export function isDeferredImport(node: ts.Node): boolean {
  let current = node.parent;
  while (current) {
    if (ts.isSourceFile(current)) break;

    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current)
    ) {
      // IIFE check: if this function is immediately called, it's eager
      const parent = current.parent;
      if (
        parent &&
        ts.isCallExpression(parent) &&
        parent.expression === current
      ) {
        // The function itself is the callee — it's an IIFE, keep walking up
        current = parent.parent;
        continue;
      }
      // Also handle parenthesized IIFEs: (async () => { ... })()
      if (
        parent &&
        ts.isParenthesizedExpression(parent) &&
        parent.parent &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
      ) {
        current = parent.parent.parent;
        continue;
      }
      return true; // genuinely deferred
    }

    current = current.parent;
  }
  return false; // top-level — eager
}

/** Resolve a glob pattern to matching files relative to project root */
function resolveGlobPattern(
  pattern: string,
  root: string,
  sourceRelPath: string
): string[] {
  const files: string[] = [];
  // Convert glob to a directory + extension filter
  // e.g., "./*.ts" → scan current dir for .ts files
  // e.g., "./pages/**/*.tsx" → scan pages dir recursively for .tsx files
  const sourceDir = path.dirname(path.join(root, sourceRelPath));

  // Simple glob resolution: handle ./dir/*.ext and ./dir/**/*.ext patterns
  const globMatch = pattern.match(/^(\.\/[^*]*?)(?:\*\*\/)?(\*\.(\w+))$/);
  if (!globMatch) return files;

  const baseDir = path.resolve(sourceDir, globMatch[1]);
  const ext = globMatch[3];
  const recursive = pattern.includes("**");

  try {
    collectFiles(baseDir, ext, recursive, root, files);
  } catch {
    // glob pattern didn't match any directory
  }

  return files;
}

function collectFiles(
  dir: string,
  ext: string,
  recursive: boolean,
  root: string,
  files: string[]
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      collectFiles(full, ext, recursive, root, files);
    } else if (entry.isFile() && entry.name.endsWith(`.${ext}`)) {
      files.push(path.relative(root, full));
    }
  }
}

// ─── File Discovery (fallback when no tsconfig) ────────────────────────────
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo",
]);

export function findFiles(
  dir: string,
  extensionPattern: RegExp,
  depth = 0,
  maxDepth = MAX_FILE_DISCOVERY_DEPTH,
): string[] {
  if (depth > maxDepth) return [];
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findFiles(full, extensionPattern, depth + 1, maxDepth));
    } else if (extensionPattern.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

export function findTsFiles(dir: string, depth = 0, maxDepth = MAX_FILE_DISCOVERY_DEPTH): string[] {
  return findFiles(dir, /\.(tsx?|jsx?)$/, depth, maxDepth)
    .filter(f => !f.endsWith(".d.ts"));
}

// ─── Unified Graph Traversal ────────────────────────────────────────────────
/**
 * Single-pass traversal that computes:
 * 1. Per-route branch membership (files, lines, depth)
 * 2. Global reachability (for dead code detection)
 * 3. Per-file route membership (which routes include each file)
 *
 * Replaces: buildBranch() + findDeadFiles() BFS + getGitFrequency() branch calls
 * Complexity: O(N + E) where N=nodes, E=edges
 */
export function unifiedTraversal(
  graph: Record<string, FileNode>,
  routeRoots: Map<string, string>, // routePath → pageFile
  entryPoints: string[],
  megaDepthCap: number = MEGA_TRACE_DEPTH_CAP
): TraversalResult {
  const branches = new Map<string, BranchResult>();
  const reachable = new Set<string>();
  const routeMembership = new Map<string, Set<string>>();

  // Initialize branches for each route
  for (const [routePath, pageFile] of routeRoots) {
    branches.set(routePath, {
      totalLines: 0,
      fileCount: 0,
      maxDepth: 0,
      files: new Set<string>(),
    });
  }

  // DFS per route to compute branch membership and depth (uncapped)
  for (const [routePath, pageFile] of routeRoots) {
    const branch = branches.get(routePath)!;
    const visited = new Set<string>();
    const fileDepths = new Map<string, number>();

    function dfs(file: string, depth: number): void {
      if (visited.has(file)) return;
      visited.add(file);
      reachable.add(file);
      fileDepths.set(file, depth);

      // Track route membership
      if (!routeMembership.has(file)) {
        routeMembership.set(file, new Set());
      }
      routeMembership.get(file)!.add(routePath);

      // Add to branch
      branch.files.add(file);
      if (depth > branch.maxDepth) branch.maxDepth = depth;

      const node = graph[file];
      if (!node) return;

      for (const imp of node.imports) {
        dfs(imp, depth + 1);
      }
    }

    if (graph[pageFile]) {
      dfs(pageFile, 0);
    }

    // Compute total lines for the branch
    let totalLines = 0;
    for (const f of branch.files) {
      totalLines += graph[f]?.lines || 0;
    }

    // Post-hoc MEGA depth pruning: classify the route from its true total,
    // then remove files beyond the depth cap. This is deterministic — unlike
    // a running-total approach which depends on DFS traversal order.
    const classification = classify(totalLines);
    if (classification === "mega") {
      for (const f of [...branch.files]) {
        if ((fileDepths.get(f) || 0) > megaDepthCap) {
          branch.files.delete(f);
        }
      }
      // Recompute after pruning
      totalLines = 0;
      for (const f of branch.files) {
        totalLines += graph[f]?.lines || 0;
      }
      branch.maxDepth = Math.min(branch.maxDepth, megaDepthCap);
    }

    branch.totalLines = totalLines;
    branch.fileCount = branch.files.size;
  }

  // BFS from entry points for reachability (doesn't add to any route branch)
  bfsReachability(graph, reachable, entryPoints, false);

  // Dynamic import reachability: lazy-loaded files (React.lazy, () => import())
  // should be reachable (not flagged as dead) even though they aren't static
  // graph edges. Seeds = resolved_files from all reachable files' dynamic_imports.
  const dynamicSeeds: string[] = [];
  for (const file of reachable) {
    const node = graph[file];
    if (!node?.dynamic_imports) continue;
    for (const di of node.dynamic_imports) {
      if (di.resolved_files) {
        for (const rf of di.resolved_files) {
          if (!reachable.has(rf)) dynamicSeeds.push(rf);
        }
      }
    }
  }
  bfsReachability(graph, reachable, dynamicSeeds, true);

  return { branches, reachable, routeMembership };
}

/**
 * BFS reachability expansion from seed files.
 * When followDynamic is true, also follows dynamic_imports.resolved_files
 * (for marking lazy-loaded files as reachable).
 */
function bfsReachability(
  graph: Record<string, FileNode>,
  reachable: Set<string>,
  seeds: string[],
  followDynamic: boolean
): void {
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    const node = graph[file];
    if (!node) continue;
    for (const imp of node.imports) {
      if (!reachable.has(imp)) queue.push(imp);
    }
    if (followDynamic && node.dynamic_imports) {
      for (const di of node.dynamic_imports) {
        if (di.resolved_files) {
          for (const rf of di.resolved_files) {
            if (!reachable.has(rf)) queue.push(rf);
          }
        }
      }
    }
  }
}

// ─── Tarjan's SCC (Circular Dependency Detection) ───────────────────────────
export function findCircularDeps(graph: Record<string, FileNode>): CircularDep[] {
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let index = 0;

  function strongconnect(v: string): void {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const node = graph[v];
    if (node) {
      for (const w of node.imports) {
        if (!graph[w]) continue;
        if (!indices.has(w)) {
          strongconnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) {
        sccs.push(scc);
      }
    }
  }

  for (const v of Object.keys(graph)) {
    if (!indices.has(v)) {
      strongconnect(v);
    }
  }

  return sccs.map((scc) => {
    const len = scc.length;
    let severity: "high" | "medium" | "low";
    if (len <= 2) severity = "high";
    else if (len <= 4) severity = "medium";
    else severity = "low";
    return { files: scc, severity, cycle_length: len };
  });
}

// ─── Classification ─────────────────────────────────────────────────────────
export function classify(branchLines: number): "easy" | "medium" | "hard" | "mega" {
  if (branchLines < EASY_THRESHOLD) return "easy";
  if (branchLines < MEDIUM_THRESHOLD) return "medium";
  if (branchLines <= BASE_BUDGET) return "hard";
  return "mega";
}

// ─── Session Estimation ─────────────────────────────────────────────────────
export function estimateSessions(routes: RouteEntry[]): ScanManifest["estimated_sessions"] {
  const tiers = { easy: 0, medium: 0, hard: 0, mega: 0 };

  for (const r of routes) {
    if (r.classification === "unknown") continue;
    tiers[r.classification] += r.session_slots;
  }

  const easy = Math.ceil(tiers.easy);
  const medium = Math.ceil(tiers.medium);
  const hard = Math.ceil(tiers.hard);
  const mega = Math.ceil(tiers.mega);
  const totalMax = easy + medium + hard + mega;
  const totalMin = Math.floor(totalMax * 0.7);

  return { easy, medium, hard, mega, total_min: totalMin, total_max: totalMax };
}

// ─── Git Co-Change Complexity ───────────────────────────────────────────────
const SOURCE_RE = /\.(tsx?|jsx?|vue|svelte|py|rb|go|rs|php|ex|exs)$/;

/**
 * For each page file, find files that co-change with it in git history.
 * Excludes shared infrastructure (files that co-change with many pages).
 * Language-agnostic — works on any git repo.
 */
export function getGitCoChangeComplexity(
  root: string,
  pageFiles: string[],
  opts?: { sharedThresholdPct?: number; minSharedThreshold?: number }
): Map<string, { lines: number; files: number; coChangedFiles: string[] }> {
  const sharedPct = opts?.sharedThresholdPct ?? 0.25;
  const minThreshold = opts?.minSharedThreshold ?? 3;
  const totalPages = pageFiles.length;
  const sharedThreshold = Math.max(minThreshold, Math.floor(totalPages * sharedPct));

  // Step 1: Get commit hashes per page, deduplicate across pages
  const pageCommits = new Map<string, string[]>(); // pageFile → [hash, ...]
  const allHashes = new Set<string>();

  for (const pageFile of pageFiles) {
    try {
      const result = Bun.spawnSync(
        ["git", "log", "--format=%H", "--", pageFile],
        { cwd: root }
      );
      const hashes = result.stdout.toString().trim().split("\n").filter(Boolean);
      pageCommits.set(pageFile, hashes);
      for (const h of hashes) allHashes.add(h);
    } catch {
      pageCommits.set(pageFile, []);
    }
  }

  // Step 2: For each unique commit, get all changed files via diff-tree
  const commitFiles = new Map<string, string[]>();
  for (const hash of allHashes) {
    try {
      const result = Bun.spawnSync(
        ["git", "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", hash],
        { cwd: root }
      );
      const files = result.stdout.toString().trim().split("\n").filter(Boolean);
      commitFiles.set(hash, files);
    } catch {
      commitFiles.set(hash, []);
    }
  }

  // Step 3: Build co-change map per page
  const pageCoChanges = new Map<string, Set<string>>();
  const fileBreadth = new Map<string, Set<string>>();

  for (const pageFile of pageFiles) {
    const coChanged = new Set<string>();
    const hashes = pageCommits.get(pageFile) ?? [];
    for (const hash of hashes) {
      const files = commitFiles.get(hash) ?? [];
      for (const f of files) {
        if (f === pageFile) continue;
        if (!SOURCE_RE.test(f)) continue;
        coChanged.add(f);
        if (!fileBreadth.has(f)) fileBreadth.set(f, new Set());
        fileBreadth.get(f)!.add(pageFile);
      }
    }
    pageCoChanges.set(pageFile, coChanged);
  }

  // Cache file line counts — each file read once, reused across routes
  const lineCountCache = new Map<string, number>();
  function getLineCount(filePath: string): number {
    if (lineCountCache.has(filePath)) return lineCountCache.get(filePath)!;
    try {
      const content = fs.readFileSync(path.resolve(root, filePath), "utf-8");
      const count = content.split("\n").length;
      lineCountCache.set(filePath, count);
      return count;
    } catch {
      lineCountCache.set(filePath, 0);
      return 0;
    }
  }

  // Filter out shared files and sum lines
  const complexity = new Map<string, { lines: number; files: number; coChangedFiles: string[] }>();

  for (const pageFile of pageFiles) {
    const coChanged = pageCoChanges.get(pageFile) ?? new Set();
    let totalLines = 0;
    let totalFiles = 0;
    const featureFiles: string[] = [];

    // Always count the page file itself
    const pageLines = getLineCount(pageFile);
    if (pageLines > 0) {
      totalLines += pageLines;
      totalFiles++;
      featureFiles.push(pageFile);
    }

    for (const f of coChanged) {
      const breadth = fileBreadth.get(f)?.size ?? 0;
      if (breadth >= sharedThreshold) continue;
      const lines = getLineCount(f);
      if (lines > 0) {
        totalLines += lines;
        totalFiles++;
        featureFiles.push(f);
      }
    }

    complexity.set(pageFile, { lines: totalLines, files: totalFiles, coChangedFiles: featureFiles });
  }

  return complexity;
}

// ─── Git Born Date ──────────────────────────────────────────────────────────
/**
 * For each file, find the Unix timestamp of its first git commit.
 * Used for chronological route ordering (foundation first, newest last).
 */
export function getGitBornDate(
  root: string,
  files: string[]
): Map<string, number> {
  const bornDates = new Map<string, number>();
  try {
    for (const file of files) {
      const result = Bun.spawnSync(
        ["git", "log", "--follow", "--diff-filter=A", "--format=%at", "--", file],
        { cwd: root }
      );
      const output = result.stdout.toString().trim();
      const timestamps = output.split("\n").filter(Boolean);
      const earliest = timestamps.length > 0 ? parseInt(timestamps[timestamps.length - 1], 10) : 0;
      bornDates.set(file, earliest);
    }
  } catch {
    // Non-git project — all files get epoch 0
  }
  return bornDates;
}

// ─── Content Hash ───────────────────────────────────────────────────────────
export function computeContentHash(graph: Record<string, FileNode>): string {
  const hashInput = Object.entries(graph)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([f, n]) => `${f}:${n.content_hash}`)
    .join("\n");
  return crypto
    .createHash("sha256")
    .update(hashInput)
    .digest("hex")
    .substring(0, 16);
}

// ─── Entry Points ───────────────────────────────────────────────────────────
export function findEntryPoints(graph: Record<string, FileNode>): string[] {
  const entryPatterns = [
    "src/main.ts", "src/main.tsx", "src/index.ts", "src/index.tsx",
    "src/App.ts", "src/App.tsx", "src/app.ts", "src/app.tsx",
  ];
  const entries: string[] = [];
  for (const p of entryPatterns) {
    if (graph[p]) entries.push(p);
  }
  // Also add config files
  for (const f of Object.keys(graph)) {
    if (
      f.includes("vite.config") ||
      f.includes("tailwind.config") ||
      f.includes("postcss.config") ||
      f.includes("vitest.config")
    ) {
      entries.push(f);
    }
  }
  return entries;
}
