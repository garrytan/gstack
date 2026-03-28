/**
 * scanner/utils.ts — Shared utilities for scanner modules
 *
 * Extracted from routes.ts to DRY up framework detection across modules.
 * Used by routes.ts (framework detection), monorepo.ts (workspace detection),
 * and future scanner expansions.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Read and parse the project's package.json. Returns null if missing or malformed.
 */
export function readPackageJson(projectRoot: string): Record<string, unknown> | null {
  const pkgPath = path.join(projectRoot, "package.json");
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Check if a package appears in dependencies or devDependencies.
 */
export function hasDependency(pkg: Record<string, unknown>, name: string): boolean {
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  return name in deps || name in devDeps;
}

/**
 * Resolve a path relative to the project root. Returns the resolved absolute path.
 */
export function resolveRelative(projectRoot: string, ...segments: string[]): string {
  return path.resolve(projectRoot, ...segments);
}

/**
 * Check if a directory exists at the given path.
 */
export function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a file exists at the given path.
 */
export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
