/**
 * Shared config for browse CLI + server.
 *
 * Resolution:
 *   1. BROWSE_STATE_FILE env → derive stateDir from parent
 *   2. git rev-parse --show-toplevel → projectDir/.gstack/
 *   3. process.cwd() fallback (non-git environments)
 *
 * The CLI computes the config and passes BROWSE_STATE_FILE to the
 * spawned server. The server derives all paths from that env var.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mkdirSecure } from './file-permissions';
import { safeUnlinkQuiet } from './error-handling';

export interface BrowseConfig {
  projectDir: string;
  stateDir: string;
  stateFile: string;
  consoleLog: string;
  networkLog: string;
  dialogLog: string;
  auditLog: string;
}

/**
 * Detect the git repository root, or null if not in a repo / git unavailable.
 */
export function getGitRoot(): string | null {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 2_000, // Don't hang if .git is broken
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve all browse config paths.
 *
 * If BROWSE_STATE_FILE is set (e.g. by CLI when spawning server, or by
 * tests for isolation), all paths are derived from it. Otherwise, the
 * project root is detected via git or cwd.
 */
export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): BrowseConfig {
  let stateFile: string;
  let stateDir: string;
  let projectDir: string;

  if (env.BROWSE_STATE_FILE) {
    stateFile = env.BROWSE_STATE_FILE;
    stateDir = path.dirname(stateFile);
    projectDir = path.dirname(stateDir); // parent of .gstack/
  } else {
    projectDir = getGitRoot() || process.cwd();
    stateDir = path.join(projectDir, '.gstack');
    stateFile = path.join(stateDir, 'browse.json');
  }

  return {
    projectDir,
    stateDir,
    stateFile,
    consoleLog: path.join(stateDir, 'browse-console.log'),
    networkLog: path.join(stateDir, 'browse-network.log'),
    dialogLog: path.join(stateDir, 'browse-dialog.log'),
    auditLog: path.join(stateDir, 'browse-audit.jsonl'),
  };
}

/**
 * Create the .gstack/ state directory if it doesn't exist.
 * Throws with a clear message on permission errors.
 */
export function ensureStateDir(config: BrowseConfig): void {
  try {
    mkdirSecure(config.stateDir);
  } catch (err: any) {
    if (err.code === 'EACCES') {
      throw new Error(`Cannot create state directory ${config.stateDir}: permission denied`);
    }
    if (err.code === 'ENOTDIR') {
      throw new Error(`Cannot create state directory ${config.stateDir}: a file exists at that path`);
    }
    throw err;
  }

  // Ensure .gstack/ is in the project's .gitignore
  const gitignorePath = path.join(config.projectDir, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.match(/^\.gstack\/?$/m)) {
      const separator = content.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(gitignorePath, `${separator}.gstack/\n`);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      // Write warning to server log (visible even in daemon mode)
      const logPath = path.join(config.stateDir, 'browse-server.log');
      try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Warning: could not update .gitignore at ${gitignorePath}: ${err.message}\n`);
      } catch {
        // stateDir write failed too — nothing more we can do
      }
    }
    // ENOENT (no .gitignore) — skip silently
  }
}

/**
 * Derive a slug from the git remote origin URL (owner-repo format).
 * Falls back to the directory basename if no remote is configured.
 */
export function getRemoteSlug(): string {
  try {
    const proc = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 2_000,
    });
    if (proc.exitCode !== 0) throw new Error('no remote');
    const url = proc.stdout.toString().trim();
    // SSH:   git@github.com:owner/repo.git → owner-repo
    // HTTPS: https://github.com/owner/repo.git → owner-repo
    const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) return `${match[1]}-${match[2]}`;
    throw new Error('unparseable');
  } catch {
    const root = getGitRoot();
    return path.basename(root || process.cwd());
  }
}

/**
 * Read the binary version (git SHA) from browse/dist/.version.
 * Returns null if the file doesn't exist or can't be read.
 */
export function readVersionHash(execPath: string = process.execPath): string | null {
  try {
    const versionFile = path.resolve(path.dirname(execPath), '.version');
    return fs.readFileSync(versionFile, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the gstack home directory.
 *
 * Honors the existing convention used by telemetry.ts and domain-skills.ts:
 *   1. GSTACK_HOME env (explicit override)
 *   2. $HOME/.gstack (default)
 */
export function resolveGstackHome(): string {
  return process.env.GSTACK_HOME || path.join(os.homedir(), '.gstack');
}

/**
 * Resolve the Chromium profile directory.
 *
 * Resolution order:
 *   1. `explicit` arg (passed via ServerConfig.chromiumProfile by embedders)
 *   2. CHROMIUM_PROFILE env (used by gbrowser's gbd per-workspace)
 *   3. <resolveGstackHome()>/chromium-profile (default)
 */
export function resolveChromiumProfile(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const env = process.env.CHROMIUM_PROFILE;
  if (env && env.length > 0) return env;
  return path.join(resolveGstackHome(), 'chromium-profile');
}

/**
 * Pre-launch / shutdown cleanup of stale Chromium singleton lockfiles
 * (SingletonLock, SingletonSocket, SingletonCookie). Chromium's
 * ProcessSingleton refuses to start when these exist from a prior crash
 * (SIGKILL, hard crash, etc.) since they point at a PID that no longer exists.
 *
 * Defensive guard: refuses to operate unless ALL of these hold:
 *   1. `userDataDir` is an absolute path (no CWD-relative footguns)
 *   2. basename is exactly 'chromium-profile' OR the absolute path matches
 *      the absolute form of $CHROMIUM_PROFILE env value
 *
 * Prevents accidentally deleting lock files from an unrelated directory if
 * profile resolution is misconfigured upstream (CWD drift, env injection).
 *
 * Caller MUST ensure external coordination has already guaranteed no live
 * peer is using this profile (gbd.lock for gbrowser; single-instance CLI
 * check for gstack).
 */
export function cleanSingletonLocks(userDataDir: string): void {
  if (!path.isAbsolute(userDataDir)) {
    console.warn(`[browse] cleanSingletonLocks: refusing relative path: ${userDataDir}`);
    return;
  }
  const resolved = path.resolve(userDataDir);
  const basename = path.basename(resolved);
  const explicitProfile = process.env.CHROMIUM_PROFILE;
  const explicitAbs = explicitProfile && path.isAbsolute(explicitProfile)
    ? path.resolve(explicitProfile)
    : null;
  const isSafe = basename === 'chromium-profile' || (explicitAbs !== null && resolved === explicitAbs);
  if (!isSafe) {
    console.warn(`[browse] cleanSingletonLocks: refusing to clean unrecognized profile dir: ${resolved}`);
    return;
  }
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    safeUnlinkQuiet(path.join(resolved, lockFile));
  }
}
