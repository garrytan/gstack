/**
 * find-security-sidecar — resolve the Node entry that runs the L4 ML
 * classifier sidecar.
 *
 * The sidecar can't be bundled into the compiled browse binary because
 * onnxruntime-node fails to dlopen from Bun's compile extract dir. It runs
 * as a separate Node subprocess instead. This module resolves the right
 * path + interpreter on each platform:
 *
 *   1. Prefer node on PATH + a bundled JS entry at
 *      browse/dist/security-sidecar.js (built by package.json's
 *      build:security-sidecar script).
 *   2. If Node is missing or no compiled entry resolves, return null. The
 *      /pty-inject-scan
 *      endpoint then responds with l4 { available: false } and the extension
 *      degrades to WARN+confirm (D7).
 *
 * A plain-Node TypeScript fallback is intentionally not offered. It was not
 * executable on the supported Node 18 floor and, if partially executed by a
 * newer Node, could begin downloading local model weights before failing.
 * GStack 2 does not bundle that model runtime or its weights.
 */

import { existsSync } from "fs";
import { join, dirname } from "path";
import { execFileSync } from "child_process";

export interface SidecarLocation {
  node: string;
  entry: string;
  /** "compiled" if running from browse/dist/, "dev" if running from src */
  mode: "compiled" | "dev";
}

function nodeOnPath(): string | null {
  try {
    execFileSync("node", ["--version"], { stdio: "ignore", timeout: 2000 });
    return "node";
  } catch {
    return null;
  }
}

function browseRoot(): string {
  // When running compiled, __dirname (via import.meta.dir) points at the
  // Bun extract temp. Walk up until we find a directory containing
  // browse/dist/ or browse/src/.
  let candidate = dirname(import.meta.path || "");
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(candidate, "browse", "dist", "security-sidecar.js"))) {
      return candidate;
    }
    const next = dirname(candidate);
    if (next === candidate) break;
    candidate = next;
  }
  return process.cwd();
}

export function findSecuritySidecar(): SidecarLocation | null {
  const node = nodeOnPath();
  if (!node) return null;

  const root = browseRoot();

  const compiled = join(root, "browse", "dist", "security-sidecar.js");
  if (existsSync(compiled)) {
    return { node, entry: compiled, mode: "compiled" };
  }

  return null;
}
