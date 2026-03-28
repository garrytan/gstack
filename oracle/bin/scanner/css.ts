/**
 * scanner/css.ts — CSS/SCSS import tracking
 *
 * Discovers .css and .scss files, parses @import and @use directives,
 * and returns FileNode entries for the unified graph.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { findFiles } from "./core";
import type { FileNode } from "./core";

const IMPORT_REGEX = /@import\s+(?:url\()?\s*['"]([^'"]+)['"]\s*\)?/g;
const USE_REGEX = /@use\s+['"]([^'"]+)['"]/g;

function resolveImportPath(importStr: string, fromFile: string, projectRoot: string): string {
  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, importStr);
  // Return relative to project root
  return path.relative(projectRoot, resolved);
}

export function buildCssGraph(
  projectRoot: string,
  _existingGraph: Record<string, FileNode>,
): Record<string, FileNode> {
  const cssFiles = findFiles(projectRoot, /\.(css|scss|sass|less)$/);
  const graph: Record<string, FileNode> = {};

  for (const fullPath of cssFiles) {
    const relPath = path.relative(projectRoot, fullPath);

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n").length;
      const contentHash = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex")
        .substring(0, 12);

      const imports: string[] = [];

      // Parse @import directives
      let match: RegExpExecArray | null;
      IMPORT_REGEX.lastIndex = 0;
      while ((match = IMPORT_REGEX.exec(content)) !== null) {
        imports.push(resolveImportPath(match[1], fullPath, projectRoot));
      }

      // Parse @use directives (SCSS)
      USE_REGEX.lastIndex = 0;
      while ((match = USE_REGEX.exec(content)) !== null) {
        imports.push(resolveImportPath(match[1], fullPath, projectRoot));
      }

      graph[relPath] = {
        lines,
        content_hash: contentHash,
        imports,
        unresolved_imports: [],
        is_css: true,
      };
    } catch {
      // Skip unreadable files
    }
  }

  return graph;
}

/**
 * Parse CSS url() directives and resolve referenced files.
 */
const URL_REGEX = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g;

export function extractCssUrls(content: string, fromFile: string, projectRoot: string): string[] {
  const urls: string[] = [];
  URL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_REGEX.exec(content)) !== null) {
    const ref = match[1];
    // Skip data URIs, external URLs, and CSS variables
    if (ref.startsWith("data:") || ref.startsWith("http") || ref.startsWith("#") || ref.startsWith("var(")) continue;
    urls.push(resolveImportPath(ref, fromFile, projectRoot));
  }
  return urls;
}

/**
 * Merge CSS import graph into the TypeScript import graph.
 * CSS files that import TS/JS files (via url()) get cross-graph edges.
 */
export function mergeCssGraph(
  tsGraph: Record<string, FileNode>,
  cssGraph: Record<string, FileNode>,
): Record<string, FileNode> {
  const merged = { ...tsGraph };
  for (const [file, node] of Object.entries(cssGraph)) {
    if (merged[file]) {
      // File exists in both — merge imports
      const existing = merged[file];
      merged[file] = {
        ...existing,
        imports: [...new Set([...existing.imports, ...node.imports])],
        is_css: true,
      };
    } else {
      merged[file] = node;
    }
  }
  return merged;
}

/**
 * Detect if the project uses Tailwind CSS.
 */
export function detectTailwind(projectRoot: string): { detected: boolean; configFile?: string } {
  const configNames = [
    "tailwind.config.js",
    "tailwind.config.ts",
    "tailwind.config.mjs",
    "tailwind.config.cjs",
  ];
  for (const name of configNames) {
    const p = path.join(projectRoot, name);
    if (fs.existsSync(p)) return { detected: true, configFile: name };
  }
  return { detected: false };
}
