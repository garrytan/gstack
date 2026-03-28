#!/usr/bin/env bun
/**
 * visualize-graph.ts — Self-contained HTML import graph visualizer
 *
 * Reads a scan manifest JSON and generates an interactive HTML file
 * showing the import graph as a collapsible tree with color-coded nodes.
 *
 * Usage:
 *   bun run oracle/bin/visualize-graph.ts /path/to/manifest.json
 *   cat manifest.json | bun run oracle/bin/visualize-graph.ts
 *
 * Output: /tmp/oracle-scan-{project}.html
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types (subset of ScanManifest) ────────────────────────────────────────

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

// ─── Color Scheme ──────────────────────────────────────────────────────────

const COLORS: Record<string, string> = {
  easy: "#4CAF50",
  medium: "#FFC107",
  hard: "#FF9800",
  mega: "#F44336",
  unknown: "#9E9E9E",
  dead: "#9E9E9E",
};

// ─── Tree Builder ──────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  fullPath: string;
  lines: number;
  classification?: string;
  isDead?: boolean;
  isCircular?: boolean;
  children: TreeNode[];
}

function buildRouteTree(
  route: ManifestRoute,
  graph: Record<string, ManifestFileNode>,
  deadFileSet: Set<string>,
  circularFileSet: Set<string>,
  maxDepth: number,
): TreeNode {
  const visited = new Set<string>();

  function buildNode(filePath: string, depth: number): TreeNode {
    const shortName = filePath.split("/").pop() ?? filePath;
    const node = graph[filePath];
    const lines = node?.lines ?? 0;
    const isDead = deadFileSet.has(filePath);
    const isCircular = circularFileSet.has(filePath);

    const treeNode: TreeNode = {
      name: shortName,
      fullPath: filePath,
      lines,
      isDead,
      isCircular,
      children: [],
    };

    if (visited.has(filePath) || depth >= maxDepth || !node) return treeNode;
    visited.add(filePath);

    for (const imp of node.imports) {
      if (graph[imp]) {
        treeNode.children.push(buildNode(imp, depth + 1));
      }
    }

    return treeNode;
  }

  const root = buildNode(route.page_file, 0);
  root.classification = route.classification;
  return root;
}

// ─── HTML Generator ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderTreeNode(node: TreeNode, depth: number, autoCollapse: boolean): string {
  const color = node.isDead ? COLORS.dead : COLORS[node.classification ?? "unknown"] ?? "#666";
  const circularMarker = node.isCircular ? ' <span style="color:#F44336">🔄</span>' : "";
  const deadMarker = node.isDead ? ' <span style="color:#9E9E9E;text-decoration:line-through">[dead]</span>' : "";
  const collapsed = autoCollapse && depth > 0 && node.children.length > 0;

  let html = `<div class="node" style="margin-left:${depth * 20}px">`;
  if (node.children.length > 0) {
    html += `<span class="toggle" onclick="this.parentElement.classList.toggle('collapsed')">${collapsed ? "▸" : "▾"}</span> `;
  } else {
    html += `<span class="leaf">·</span> `;
  }
  html += `<span style="color:${color};font-weight:${depth === 0 ? 'bold' : 'normal'}">${escapeHtml(node.name)}</span>`;
  html += ` <span class="meta">(${node.lines}L)</span>`;
  html += circularMarker + deadMarker;
  html += `</div>`;

  if (node.children.length > 0) {
    html += `<div class="children${collapsed ? " hidden" : ""}">`;
    for (const child of node.children) {
      html += renderTreeNode(child, depth + 1, autoCollapse);
    }
    html += `</div>`;
  }

  return html;
}

function renderRouteSummary(route: ManifestRoute): string {
  const color = COLORS[route.classification] ?? "#666";
  return `<div class="route-summary" style="border-left: 3px solid ${color}; padding: 4px 8px; margin: 4px 0">
    <strong>${escapeHtml(route.path)}</strong>
    <span class="meta">[${route.classification.toUpperCase()} ${route.branch_lines}L, ${route.branch_files} files]</span>
  </div>`;
}

export function generateHtml(manifest: ScanManifest): string {
  const deadFileSet = new Set(manifest.dead_files.map(d => d.file));
  const circularFileSet = new Set<string>();
  for (const dep of manifest.circular_deps) {
    for (const f of dep.cycle) circularFileSet.add(f);
  }

  const totalNodes = Object.keys(manifest.import_graph).length;
  const useSummaryMode = totalNodes > 1000;
  const autoCollapse = totalNodes > 200;

  let routesHtml = "";
  if (useSummaryMode) {
    routesHtml = `<h2>Route Summary (${manifest.routes.length} routes, ${totalNodes} files — summary mode)</h2>`;
    for (const route of manifest.routes) {
      routesHtml += renderRouteSummary(route);
    }
  } else {
    for (const route of manifest.routes) {
      const tree = buildRouteTree(route, manifest.import_graph, deadFileSet, circularFileSet, 6);
      const color = COLORS[route.classification] ?? "#666";
      routesHtml += `<div class="route">
        <h3 style="color:${color}">${escapeHtml(route.path)}
          <span class="badge" style="background:${color}">${route.classification.toUpperCase()}</span>
          <span class="meta">${route.branch_lines}L, ${route.branch_files} files</span>
        </h3>
        ${renderTreeNode(tree, 0, autoCollapse)}
      </div>`;
    }
  }

  // Circular deps section
  let circularHtml = "";
  if (manifest.circular_deps.length > 0) {
    circularHtml = `<h2>Circular Dependencies (${manifest.circular_deps.length})</h2>`;
    for (const dep of manifest.circular_deps) {
      const severityColor = dep.severity === "high" ? "#F44336" : dep.severity === "medium" ? "#FF9800" : "#FFC107";
      circularHtml += `<div class="circular" style="border-left: 3px solid ${severityColor}; padding: 4px 8px; margin: 4px 0">
        <span style="color:${severityColor};font-weight:bold">${dep.severity.toUpperCase()}</span>:
        ${dep.cycle.map(f => escapeHtml(f.split("/").pop() ?? f)).join(" → ")} → ${escapeHtml((dep.cycle[0] ?? "").split("/").pop() ?? "")}
      </div>`;
    }
  }

  // Dead files section
  let deadHtml = "";
  if (manifest.dead_files.length > 0) {
    deadHtml = `<h2>Dead Files (${manifest.dead_files.length})</h2>`;
    for (const df of manifest.dead_files) {
      deadHtml += `<div class="dead-file">
        <span style="color:#9E9E9E;text-decoration:line-through">${escapeHtml(df.file)}</span>
        <span class="meta">(${df.lines}L, ${df.confidence} confidence)</span>
      </div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Oracle Scan: ${escapeHtml(manifest.project)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px; max-width: 1200px; margin: 0 auto; }
  h1 { color: #fff; margin-bottom: 8px; }
  h2 { color: #ccc; margin: 20px 0 8px; border-bottom: 1px solid #333; padding-bottom: 4px; }
  h3 { margin: 12px 0 4px; font-size: 14px; }
  .stats { display: flex; gap: 20px; margin: 12px 0; padding: 12px; background: #16213e; border-radius: 8px; flex-wrap: wrap; }
  .stat { text-align: center; }
  .stat-value { font-size: 24px; font-weight: bold; color: #fff; }
  .stat-label { font-size: 11px; color: #888; text-transform: uppercase; }
  .route { margin: 8px 0; padding: 8px; background: #16213e; border-radius: 6px; }
  .node { padding: 2px 0; font-size: 13px; white-space: nowrap; }
  .toggle { cursor: pointer; user-select: none; color: #888; }
  .leaf { color: #555; }
  .meta { color: #666; font-size: 11px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; color: #000; font-weight: bold; margin-left: 6px; }
  .children { }
  .hidden { display: none; }
  .collapsed > .children { display: none; }
  .collapsed > .node .toggle::after { content: ""; }
  .circular, .dead-file, .route-summary { font-size: 13px; }
  .legend { display: flex; gap: 12px; margin: 8px 0; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: 12px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
</style>
</head>
<body>
<h1>🔮 Oracle Scan: ${escapeHtml(manifest.project)}</h1>

<div class="stats">
  <div class="stat"><div class="stat-value">${manifest.total_files}</div><div class="stat-label">Files</div></div>
  <div class="stat"><div class="stat-value">${manifest.total_lines.toLocaleString()}</div><div class="stat-label">Lines</div></div>
  <div class="stat"><div class="stat-value">${manifest.routes.length}</div><div class="stat-label">Routes</div></div>
  <div class="stat"><div class="stat-value">${manifest.circular_deps.length}</div><div class="stat-label">Circular Deps</div></div>
  <div class="stat"><div class="stat-value">${manifest.dead_files.length}</div><div class="stat-label">Dead Files</div></div>
</div>

<div class="legend">
  <div class="legend-item"><span class="legend-dot" style="background:${COLORS.easy}"></span> EASY (&lt;800L)</div>
  <div class="legend-item"><span class="legend-dot" style="background:${COLORS.medium}"></span> MEDIUM (800-2500L)</div>
  <div class="legend-item"><span class="legend-dot" style="background:${COLORS.hard}"></span> HARD (2500-3000L)</div>
  <div class="legend-item"><span class="legend-dot" style="background:${COLORS.mega}"></span> MEGA (&gt;3000L)</div>
  <div class="legend-item"><span class="legend-dot" style="background:${COLORS.dead}"></span> Dead</div>
</div>

<h2>Routes (${manifest.routes.length})</h2>
${routesHtml}

${circularHtml}

${deadHtml}

<script>
// Expand/collapse all
document.addEventListener('keydown', function(e) {
  if (e.key === 'e') {
    document.querySelectorAll('.hidden').forEach(el => el.classList.remove('hidden'));
    document.querySelectorAll('.collapsed').forEach(el => el.classList.remove('collapsed'));
  }
  if (e.key === 'c') {
    document.querySelectorAll('.children').forEach(el => {
      if (el.parentElement && el.parentElement.querySelector('.toggle')) {
        el.classList.add('hidden');
      }
    });
  }
});
</script>
</body>
</html>`;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let input: string;
  const args = process.argv.slice(2);

  if (args.length > 0 && !args[0].startsWith("-")) {
    input = fs.readFileSync(args[0], "utf-8");
  } else {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(Buffer.from(chunk));
    }
    input = Buffer.concat(chunks).toString("utf-8");
  }

  const manifest: ScanManifest = JSON.parse(input);
  const html = generateHtml(manifest);

  const slug = manifest.project.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  const outPath = `/tmp/oracle-scan-${slug}.html`;
  fs.writeFileSync(outPath, html);
  console.error(`Visualization written to: ${outPath}`);
}

// Only run when executed directly, not when imported
if (import.meta.main) {
  main().catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
