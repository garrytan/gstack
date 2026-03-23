/**
 * find-browse — locate the gstack browse binary.
 *
 * Compiled to browse/dist/find-browse (standalone binary, no bun runtime needed).
 * Outputs the absolute path to the browse binary on stdout, or exits 1 if not found.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Binary Discovery ───────────────────────────────────────────

function getGitRoot(): string | null {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
}

export function locateBinary(): string | null {
  const root = getGitRoot();
  const home = homedir();
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  // Local vendored copies always live under a relative marker inside the git root.
  const localMarkers = ['.codex', '.agents', '.claude'];
  // Global dirs are absolute; claudeDir is pre-resolved from CLAUDE_CONFIG_DIR or home.
  const globalDirs = [join(home, '.codex'), join(home, '.agents'), claudeDir];

  // Workspace-local takes priority (for development)
  if (root) {
    for (const m of localMarkers) {
      const local = join(root, m, 'skills', 'gstack', 'browse', 'dist', 'browse');
      if (existsSync(local)) return local;
    }
  }

  // Global fallback
  for (const d of globalDirs) {
    const global = join(d, 'skills', 'gstack', 'browse', 'dist', 'browse');
    if (existsSync(global)) return global;
  }

  return null;
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const bin = locateBinary();
  if (!bin) {
    process.stderr.write('ERROR: browse binary not found. Run: cd <skill-dir> && ./setup\n');
    process.exit(1);
  }

  console.log(bin);
}

main();
