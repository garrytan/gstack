/**
 * find-browse — locate the gstack browse binary.
 *
 * Compiled to browse/dist/find-browse (standalone binary, no bun runtime needed).
 * Outputs the absolute path to the browse binary on stdout, or exits 1 if not found.
 */

import { accessSync, constants } from 'fs';
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

// Probe a path for executability. accessSync(X_OK) checks the executable
// bit on Linux/macOS and degrades to an existence check on Windows (no
// true execute bit). Mirrors make-pdf/src/browseClient.ts:159 /
// make-pdf/src/pdftotext.ts:117.
function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Resolve a bare binary path to the actual file on disk. On Windows, `bun
// build --compile` appends `.exe` to the output filename, so `browse` on
// disk is actually `browse.exe`. After a bare-path probe, try the Windows
// extensions. Linux/macOS behavior is unchanged. Mirrors the helper in
// make-pdf/src/browseClient.ts:89 and make-pdf/src/pdftotext.ts:52.
function findExecutable(base: string): string | null {
  if (isExecutable(base)) return base;
  if (process.platform === 'win32') {
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const withExt = base + ext;
      if (isExecutable(withExt)) return withExt;
    }
  }
  return null;
}

export function locateBinary(): string | null {
  const root = getGitRoot();
  const home = homedir();
  const markers = ['.codex', '.agents', '.claude'];

  // Workspace-local takes priority (for development)
  if (root) {
    for (const m of markers) {
      const local = join(root, m, 'skills', 'gstack', 'browse', 'dist', 'browse');
      const found = findExecutable(local);
      if (found) return found;
    }

    // Source-checkout fallback (no installed skill layout — the binary
    // lives directly at <repo>/browse/dist/browse[.exe]). Hit by:
    // - gstack repo dev workflow before `./setup` runs
    // - the windows-setup-e2e.yml CI workflow which builds binaries
    //   in place but never installs them under a marker dir
    // - make-pdf consumers running from a sibling source checkout
    const sourceCheckout = join(root, 'browse', 'dist', 'browse');
    const sourceFound = findExecutable(sourceCheckout);
    if (sourceFound) return sourceFound;
  }

  // Global fallback
  for (const m of markers) {
    const global = join(home, m, 'skills', 'gstack', 'browse', 'dist', 'browse');
    const found = findExecutable(global);
    if (found) return found;
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

// Only run main() when this module is the entry point. Without this guard,
// any test that imports `locateBinary` from this file would have main() fire
// at module-load time, calling process.exit(1) when no compiled binary
// exists — killing the test process before any test runs. Surfaced on the
// windows-free-tests CI lane where the runner has no compiled browse
// binary (intentional — that lane only builds server-node.mjs).
if (import.meta.main) {
  main();
}
