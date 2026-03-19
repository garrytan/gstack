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

type LocateBinaryOptions = {
  root?: string | null;
  home?: string;
  codexHome?: string;
  exists?: (path: string) => boolean;
};

export function locateBinary(options: LocateBinaryOptions = {}): string | null {
  const root = options.root === undefined ? getGitRoot() : options.root;
  const home = options.home ?? homedir();
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex');
  const exists = options.exists ?? existsSync;
  const agentsHome = join(home, '.agents');

  const candidates: string[] = [];

  // Workspace-local takes priority (for development)
  if (root) {
    candidates.push(join(root, '.agents', 'skills', 'gstack', 'browse', 'dist', 'browse'));
    candidates.push(join(root, '.codex', 'skills', 'gstack', 'browse', 'dist', 'browse'));
    candidates.push(join(root, '.claude', 'skills', 'gstack', 'browse', 'dist', 'browse'));
  }

  // Global fallback
  candidates.push(join(agentsHome, 'skills', 'gstack', 'browse', 'dist', 'browse'));
  candidates.push(join(codexHome, 'skills', 'gstack', 'browse', 'dist', 'browse'));
  candidates.push(join(home, '.claude', 'skills', 'gstack', 'browse', 'dist', 'browse'));

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
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

if (import.meta.main) {
  main();
}
