/**
 * find-browse — locate the gstack browse binary.
 *
 * Compiled to browse/dist/find-browse (standalone binary, no bun runtime needed).
 * Outputs the absolute path to the browse binary on stdout, or exits 1 if not found.
 */

import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Binary Discovery ───────────────────────────────────────────

function getGitRoot(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
}

export function getBrowseCandidatePaths(root = getGitRoot(), home = homedir()): string[] {
  const candidates: string[] = [];

  if (root) {
    candidates.push(
      join(root, ".codex", "skills", "gstack", "browse", "dist", "browse"),
      join(root, ".agents", "skills", "gstack", "browse", "dist", "browse"),
      join(root, ".claude", "skills", "gstack", "browse", "dist", "browse"),
    );
  }

  candidates.push(
    join(home, ".codex", "skills", "gstack", "browse", "dist", "browse"),
    join(home, ".agents", "skills", "gstack", "browse", "dist", "browse"),
    join(home, ".claude", "skills", "gstack", "browse", "dist", "browse"),
  );

  return candidates;
}

export function locateBinary(root = getGitRoot(), home = homedir()): string | null {
  for (const candidate of getBrowseCandidatePaths(root, home)) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const bin = locateBinary();
  if (!bin) {
    process.stderr.write("ERROR: browse binary not found. Run: cd <skill-dir> && ./setup\n");
    process.exit(1);
  }

  console.log(bin);
}

main();
