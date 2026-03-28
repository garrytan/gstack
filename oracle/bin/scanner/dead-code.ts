/**
 * scanner/dead-code.ts — Dead file detection
 *
 * Identifies files in the import graph that are unreachable from any entry point.
 * Supports .oracleignore exclusions, expanded barrel file detection, HTML entry
 * points, and multi-level confidence scoring.
 */

import * as fs from "fs";
import * as path from "path";
import type { FileNode, DeadFile } from "./core";

const CONFIG_PATTERNS = [
  /^vite\.config/,
  /^vitest\.config/,
  /^tailwind\.config/,
  /^postcss\.config/,
  /^tsconfig/,
  /^jest\.config/,
  /^eslint/,
  /^prettier/,
  /^next\.config/,
  /^\.eslintrc/,
  /^babel\.config/,
  /^webpack\.config/,
];

const BARREL_NAMES = new Set([
  "index.ts", "index.tsx", "index.js", "index.jsx",
  "mod.ts", "mod.js",
]);

function isConfigFile(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? "";
  return CONFIG_PATTERNS.some(p => p.test(basename));
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes(".test.") ||
    filePath.includes(".spec.") ||
    filePath.includes("__tests__/") ||
    filePath.includes(".stories.")
  );
}

function isBarrelFile(filePath: string, node: FileNode): boolean {
  const basename = filePath.split("/").pop() ?? "";
  return BARREL_NAMES.has(basename) && node.imports.length > 0;
}

/**
 * Parse .oracleignore file (gitignore-style patterns).
 * Returns a function that checks if a file path should be excluded.
 */
function loadOracleIgnore(projectRoot: string): (file: string) => boolean {
  const ignorePath = path.join(projectRoot, ".oracleignore");
  try {
    const content = fs.readFileSync(ignorePath, "utf-8");
    const patterns = content
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));

    if (patterns.length === 0) return () => false;

    // Convert simple glob patterns to regex
    const regexes = patterns.map(p => {
      const escaped = p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp(escaped);
    });

    return (file: string) => regexes.some(r => r.test(file));
  } catch {
    return () => false;
  }
}

/**
 * Parse index.html for <script src="..."> references.
 * Returns a set of referenced file paths (resolved relative to project root).
 */
function findHtmlEntryPoints(projectRoot: string): Set<string> {
  const entries = new Set<string>();
  const htmlPath = path.join(projectRoot, "index.html");
  try {
    const content = fs.readFileSync(htmlPath, "utf-8");
    const scriptRegex = /<script[^>]+src=["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = scriptRegex.exec(content)) !== null) {
      const src = match[1];
      if (src.startsWith("http://") || src.startsWith("https://")) continue;
      // Strip leading / or ./
      const clean = src.replace(/^\.?\//, "");
      entries.add(clean);
    }
  } catch {
    // No index.html or can't read it
  }
  return entries;
}

/**
 * Scan config files for string references to source files.
 * Files mentioned in configs (env vars, build configs) aren't dead.
 */
function findConfigReferencedFiles(projectRoot: string, graphFiles: string[]): Set<string> {
  const referenced = new Set<string>();
  const configPatterns = [".env", ".env.local", ".env.production"];
  const configGlobs = ["*.config.ts", "*.config.js", "*.config.mjs"];

  for (const name of configPatterns) {
    const p = path.join(projectRoot, name);
    try {
      const content = fs.readFileSync(p, "utf-8");
      for (const file of graphFiles) {
        const basename = file.split("/").pop() ?? "";
        const stem = basename.replace(/\.(tsx?|jsx?)$/, "");
        if (stem && content.includes(stem)) {
          referenced.add(file);
        }
      }
    } catch { /* skip */ }
  }

  // Check config files at project root
  try {
    const entries = fs.readdirSync(projectRoot);
    for (const entry of entries) {
      if (!configGlobs.some(g => {
        const pattern = g.replace("*", ".*");
        return new RegExp(`^${pattern}$`).test(entry);
      })) continue;
      try {
        const content = fs.readFileSync(path.join(projectRoot, entry), "utf-8");
        for (const file of graphFiles) {
          if (content.includes(file)) referenced.add(file);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return referenced;
}

export function findDeadFiles(
  graph: Record<string, FileNode>,
  reachable: Set<string>,
  projectRoot?: string,
): DeadFile[] {
  const dead: DeadFile[] = [];
  const isIgnored = projectRoot ? loadOracleIgnore(projectRoot) : () => false;
  const htmlEntries = projectRoot ? findHtmlEntryPoints(projectRoot) : new Set<string>();
  const configRefs = projectRoot ? findConfigReferencedFiles(projectRoot, Object.keys(graph)) : new Set<string>();

  // Build reverse import map: who imports each file?
  const importedBy = new Map<string, string[]>();
  for (const [file, node] of Object.entries(graph)) {
    for (const imp of node.imports) {
      if (!importedBy.has(imp)) importedBy.set(imp, []);
      importedBy.get(imp)!.push(file);
    }
  }

  for (const [file, node] of Object.entries(graph)) {
    if (reachable.has(file)) continue;

    // Exclude known non-dead patterns
    if (isConfigFile(file)) continue;
    if (isTestFile(file)) continue;
    if (isBarrelFile(file, node)) continue;
    if (isIgnored(file)) continue;
    if (htmlEntries.has(file)) continue;
    if (configRefs.has(file)) continue;

    // Determine confidence level
    const importers = importedBy.get(file) ?? [];
    let confidence: "high" | "medium" | "low";

    if (importers.length === 0) {
      // No imports at all — definitely dead
      confidence = "high";
    } else if (importers.every(imp => isTestFile(imp))) {
      // Only imported by test files — likely still useful, just not in prod
      confidence = "low";
    } else if (importers.every(imp => !reachable.has(imp))) {
      // Only imported by other dead files
      confidence = "medium";
    } else {
      confidence = "high";
    }

    dead.push({
      file,
      confidence,
      lines: node.lines,
    });
  }

  return dead;
}
