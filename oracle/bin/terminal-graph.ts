#!/usr/bin/env bun
/**
 * terminal-graph.ts — ANSI terminal ASCII tree renderer for oracle scan
 *
 * Reads a scan manifest JSON and renders a colored ASCII tree in the terminal.
 *
 * Usage:
 *   bun run oracle/bin/terminal-graph.ts /path/to/manifest.json
 *   bun run oracle/bin/terminal-graph.ts --max-depth 2 /path/to/manifest.json
 *   cat manifest.json | bun run oracle/bin/terminal-graph.ts --no-color
 */

import * as fs from "fs";

// ─── Types ─────────────────────────────────────────────────────────────────

interface ManifestRoute {
  path: string;
  type: "page" | "api" | "worker";
  page_file: string;
  branch_lines: number;
  branch_files: number;
  classification: "easy" | "medium" | "hard" | "mega" | "unknown";
}

interface ManifestCircularDep {
  cycle: string[];
  severity: "high" | "medium" | "low";
}

interface ManifestDeadFile {
  file: string;
  confidence: "high" | "medium" | "low";
  lines: number;
}

interface ManifestFileNode {
  lines: number;
  imports: string[];
}

interface ScanManifest {
  project: string;
  total_files: number;
  total_lines: number;
  routes: ManifestRoute[];
  circular_deps: ManifestCircularDep[];
  dead_files: ManifestDeadFile[];
  import_graph: Record<string, ManifestFileNode>;
}

// ─── ANSI Colors ───────────────────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  orange: "\x1b[38;5;208m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  cyan: "\x1b[36m",
};

function classColor(classification: string, useColor: boolean): string {
  if (!useColor) return "";
  switch (classification) {
    case "easy": return ANSI.green;
    case "medium": return ANSI.yellow;
    case "hard": return ANSI.orange;
    case "mega": return ANSI.red;
    default: return ANSI.gray;
  }
}

function r(useColor: boolean): string {
  return useColor ? ANSI.reset : "";
}

// ─── Tree Rendering ────────────────────────────────────────────────────────

interface RenderOptions {
  useColor: boolean;
  maxDepth: number;
  compact: boolean;
}

function shortName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

function renderFileTree(
  filePath: string,
  graph: Record<string, ManifestFileNode>,
  circularFileSet: Set<string>,
  deadFileSet: Set<string>,
  opts: RenderOptions,
  prefix: string,
  isLast: boolean,
  depth: number,
  visited: Set<string>,
): string[] {
  const lines: string[] = [];
  const node = graph[filePath];
  const fileLines = node?.lines ?? 0;
  const name = shortName(filePath);
  const connector = depth === 0 ? "" : (isLast ? "└── " : "├── ");
  const childPrefix = depth === 0 ? "" : (isLast ? "    " : "│   ");

  let marker = "";
  if (circularFileSet.has(filePath)) marker += " 🔄";
  if (deadFileSet.has(filePath)) {
    const deadColor = opts.useColor ? ANSI.gray : "";
    lines.push(`${prefix}${connector}${deadColor}${name} (${fileLines}L) [dead]${r(opts.useColor)}${marker}`);
    return lines;
  }

  const color = depth === 0 ? (opts.useColor ? ANSI.bold : "") : "";
  const meta = `${opts.useColor ? ANSI.dim : ""}(${fileLines}L)${r(opts.useColor)}`;
  lines.push(`${prefix}${connector}${color}${name}${r(opts.useColor)} ${meta}${marker}`);

  if (visited.has(filePath) || !node || depth >= opts.maxDepth) return lines;
  visited.add(filePath);

  const children = node.imports.filter(imp => graph[imp]);

  // Compact mode: collapse single-child chains
  if (opts.compact && children.length === 1) {
    const child = children[0];
    const childNode = graph[child];
    if (childNode && childNode.imports.filter(i => graph[i]).length <= 1) {
      const childName = shortName(child);
      const childMeta = `${opts.useColor ? ANSI.dim : ""}(${childNode.lines}L)${r(opts.useColor)}`;
      lines[lines.length - 1] += ` → ${childName} ${childMeta}`;
      // Continue compacting recursively
      const grandchildren = childNode.imports.filter(i => graph[i]);
      visited.add(child);
      if (grandchildren.length === 1 && depth + 1 < opts.maxDepth) {
        const deeper = renderFileTree(grandchildren[0], graph, circularFileSet, deadFileSet, opts, prefix + childPrefix, true, depth + 2, visited);
        lines.push(...deeper);
      }
      return lines;
    }
  }

  for (let i = 0; i < children.length; i++) {
    const childIsLast = i === children.length - 1;
    const childLines = renderFileTree(
      children[i], graph, circularFileSet, deadFileSet, opts,
      prefix + childPrefix, childIsLast, depth + 1, visited,
    );
    lines.push(...childLines);
  }

  return lines;
}

// ─── Main Render ───────────────────────────────────────────────────────────

export function renderTerminalGraph(manifest: ScanManifest, opts: RenderOptions): string {
  const lines: string[] = [];
  const c = opts.useColor;

  const deadFileSet = new Set(manifest.dead_files.map(d => d.file));
  const circularFileSet = new Set<string>();
  for (const dep of manifest.circular_deps) {
    for (const f of dep.cycle) circularFileSet.add(f);
  }

  // Header
  lines.push(`${c ? ANSI.bold + ANSI.white : ""}ORACLE SCAN: ${manifest.project}${r(c)}`);
  lines.push(`${"═".repeat(50)}`);
  lines.push(`Files: ${manifest.total_files} | Lines: ${manifest.total_lines.toLocaleString()} | Routes: ${manifest.routes.length}`);
  lines.push("");

  // Routes
  for (const route of manifest.routes) {
    const color = classColor(route.classification, c);
    const label = `${color}${route.path} [${route.classification.toUpperCase()} ${route.branch_lines}L]${r(c)}`;
    lines.push(label);

    const visited = new Set<string>();
    const treeLines = renderFileTree(
      route.page_file, manifest.import_graph, circularFileSet, deadFileSet,
      opts, "", true, 0, visited,
    );
    lines.push(...treeLines);
    lines.push("");
  }

  // Circular deps
  if (manifest.circular_deps.length > 0) {
    lines.push(`${c ? ANSI.bold : ""}CIRCULAR DEPENDENCIES (${manifest.circular_deps.length})${r(c)}`);
    for (const dep of manifest.circular_deps) {
      const sevColor = dep.severity === "high" ? (c ? ANSI.red : "") :
                       dep.severity === "medium" ? (c ? ANSI.orange : "") :
                       (c ? ANSI.yellow : "");
      const cycleStr = dep.cycle.map(shortName).join(" → ") + " → " + shortName(dep.cycle[0]);
      lines.push(`${sevColor}🔄 ${dep.severity.toUpperCase()}: ${cycleStr}${r(c)}`);
    }
    lines.push("");
  }

  // Dead files
  if (manifest.dead_files.length > 0) {
    lines.push(`${c ? ANSI.bold : ""}DEAD FILES (${manifest.dead_files.length})${r(c)}`);
    for (const df of manifest.dead_files) {
      lines.push(`  ${c ? ANSI.gray : ""}░ ${df.file} (${df.lines}L) [${df.confidence} confidence]${r(c)}`);
    }
    lines.push("");
  }

  lines.push("═".repeat(50));
  return lines.join("\n");
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let maxDepth = Infinity;
  let useColor = process.stdout.isTTY !== false;
  let compact = false;
  let inputFile: string | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--max-depth": {
        const v = parseInt(args[++i], 10);
        if (!isNaN(v)) maxDepth = v;
        break;
      }
      case "--no-color": useColor = false; break;
      case "--compact": compact = true; break;
      default:
        if (!args[i].startsWith("-")) inputFile = args[i];
    }
  }

  let input: string;
  if (inputFile) {
    input = fs.readFileSync(inputFile, "utf-8");
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(Buffer.from(chunk));
    }
    input = Buffer.concat(chunks).toString("utf-8");
  }

  const manifest: ScanManifest = JSON.parse(input);
  const output = renderTerminalGraph(manifest, { useColor, maxDepth, compact });
  console.log(output);
}

if (import.meta.main) {
  main().catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
