/**
 * Windows-safe resolution + spawn for gstack's bash bins. Two Windows-only
 * bugs made every hook subprocess a silent no-op; both are fixed here so all
 * call sites are covered at once.
 *
 * 1. `new URL(import.meta.url).pathname` yields `/C:/Users/...`; path.resolve
 *    then rebases it onto the drive root as `C:\C:\Users\...`. fileURLToPath
 *    is the correct conversion. (ENOENT before the bin ever ran.)
 * 2. `bin/gstack-*` are extensionless bash scripts. Windows has no shebang
 *    support, so they must be handed to bash explicitly.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, type SpawnSyncOptions } from 'child_process';

// Forward slashes on purpose: Bun's spawnSync on Windows returns ENOENT for a
// backslash exe path containing spaces.
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';

/** bash Windows itself can execute — env override, Git Bash, then PATH. */
function bashExe(): string {
  return process.env.GSTACK_BASH || (fs.existsSync(GIT_BASH) ? GIT_BASH : 'bash');
}

/** gstack install root. This file lives at hosts/claude/hooks/. */
export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

/** Absolute path to a `bin/` script. */
export function binPath(name: string): string {
  return path.join(repoRoot(), 'bin', name);
}

/** Resolve `name` under bin/ and run it, via bash on Windows. */
export function runBin(name: string, args: string[], opts: SpawnSyncOptions) {
  const bin = binPath(name);
  return process.platform === 'win32'
    ? spawnSync(bashExe(), [bin, ...args], opts)
    : spawnSync(bin, args, opts);
}
