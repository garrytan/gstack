/**
 * scanner/non-ts.ts — Non-TypeScript file discovery
 *
 * Walks the project and discovers non-TS source files with language and line count.
 */

import * as fs from "fs";
import { findFiles } from "./core";

import type { NonTsFile } from "./core";

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".mdx": "markdown",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".dockerfile": "dockerfile",
  ".proto": "protobuf",
};

// Match any file with a known non-TS extension
const NON_TS_PATTERN = new RegExp(
  "(" + Object.keys(EXTENSION_LANGUAGE_MAP).map(e => e.replace(".", "\\.")).join("|") + ")$"
);

function getLanguage(filePath: string): string | null {
  for (const [ext, lang] of Object.entries(EXTENSION_LANGUAGE_MAP)) {
    if (filePath.endsWith(ext)) return lang;
  }
  // Handle Dockerfile without extension
  const basename = filePath.split("/").pop() ?? "";
  if (basename === "Dockerfile" || basename.startsWith("Dockerfile.")) return "dockerfile";
  return null;
}

export function discoverNonTsFiles(projectRoot: string): NonTsFile[] {
  const allFiles = findFiles(projectRoot, NON_TS_PATTERN);
  const results: NonTsFile[] = [];

  for (const fullPath of allFiles) {
    // Skip TypeScript files (they're handled by core.ts)
    if (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")) continue;

    const language = getLanguage(fullPath);
    if (!language) continue;

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n").length;
      const relPath = fullPath.startsWith(projectRoot)
        ? fullPath.slice(projectRoot.length + 1)
        : fullPath;

      results.push({ file: relPath, language, lines });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}
