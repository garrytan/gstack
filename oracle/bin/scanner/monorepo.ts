/**
 * scanner/monorepo.ts — Workspace detection
 *
 * Detects npm/yarn workspaces, pnpm workspaces, and lerna configurations.
 */

import * as fs from "fs";
import * as path from "path";

export interface MonorepoInfo {
  detected: boolean;
  type?: "npm" | "pnpm" | "lerna" | "nx" | "turbo";
  packages: string[];
}

function resolveWorkspaceGlobs(projectRoot: string, globs: string[]): string[] {
  const packages: string[] = [];
  for (const glob of globs) {
    // Handle "packages/*" style globs
    if (glob.endsWith("/*")) {
      const dir = path.join(projectRoot, glob.slice(0, -2));
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const pkgJson = path.join(dir, entry.name, "package.json");
            if (fs.existsSync(pkgJson)) {
              packages.push(path.join(glob.slice(0, -2), entry.name));
            }
          }
        }
      } catch {
        // Directory doesn't exist, skip
      }
    }
  }
  return packages;
}

export function detectMonorepo(projectRoot: string): MonorepoInfo {
  // Check npm/yarn workspaces in package.json
  const pkgPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (Array.isArray(pkg.workspaces)) {
        const packages = resolveWorkspaceGlobs(projectRoot, pkg.workspaces);
        if (packages.length > 0) {
          return { detected: true, type: "npm", packages };
        }
      }
      // Yarn-style workspaces object
      if (pkg.workspaces?.packages && Array.isArray(pkg.workspaces.packages)) {
        const packages = resolveWorkspaceGlobs(projectRoot, pkg.workspaces.packages);
        if (packages.length > 0) {
          return { detected: true, type: "npm", packages };
        }
      }
    } catch {
      // Malformed package.json
    }
  }

  // Check pnpm-workspace.yaml
  const pnpmPath = path.join(projectRoot, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmPath)) {
    try {
      const content = fs.readFileSync(pnpmPath, "utf-8");
      const globs: string[] = [];
      // Simple YAML parsing for packages list
      const lines = content.split("\n");
      let inPackages = false;
      for (const line of lines) {
        if (line.trim() === "packages:") {
          inPackages = true;
          continue;
        }
        if (inPackages && line.trim().startsWith("- ")) {
          globs.push(line.trim().slice(2).replace(/['"`]/g, ""));
        } else if (inPackages && !line.startsWith(" ") && line.trim()) {
          break;
        }
      }
      const packages = resolveWorkspaceGlobs(projectRoot, globs);
      if (packages.length > 0) {
        return { detected: true, type: "pnpm", packages };
      }
    } catch {
      // Malformed YAML
    }
  }

  // Check lerna.json
  const lernaPath = path.join(projectRoot, "lerna.json");
  if (fs.existsSync(lernaPath)) {
    try {
      const lerna = JSON.parse(fs.readFileSync(lernaPath, "utf-8"));
      const globs = lerna.packages ?? ["packages/*"];
      const packages = resolveWorkspaceGlobs(projectRoot, globs);
      if (packages.length > 0) {
        return { detected: true, type: "lerna", packages };
      }
    } catch {
      // Malformed lerna.json
    }
  }

  // Check nx.json
  const nxPath = path.join(projectRoot, "nx.json");
  if (fs.existsSync(nxPath)) {
    try {
      const nx = JSON.parse(fs.readFileSync(nxPath, "utf-8"));
      // Nx can define projects directly or use workspaceLayout
      const layout = nx.workspaceLayout ?? {};
      const appsDirs = layout.appsDir ? [layout.appsDir + "/*"] : [];
      const libsDirs = layout.libsDir ? [layout.libsDir + "/*"] : [];
      const globs = [...appsDirs, ...libsDirs];
      if (globs.length === 0) {
        // Fall back to checking package.json workspaces (nx often uses them)
        globs.push("packages/*", "apps/*", "libs/*");
      }
      const packages = resolveWorkspaceGlobs(projectRoot, globs);
      if (packages.length > 0) {
        return { detected: true, type: "nx", packages };
      }
      // Nx detected even without resolved packages
      return { detected: true, type: "nx", packages: [] };
    } catch {
      // Malformed nx.json
    }
  }

  // Check turbo.json
  const turboPath = path.join(projectRoot, "turbo.json");
  if (fs.existsSync(turboPath)) {
    // Turbo uses package.json workspaces for package discovery
    // If turbo.json exists but we already checked package.json workspaces above,
    // try common workspace patterns
    const fallbackGlobs = ["packages/*", "apps/*"];
    const packages = resolveWorkspaceGlobs(projectRoot, fallbackGlobs);
    return { detected: true, type: "turbo", packages };
  }

  return { detected: false, packages: [] };
}
