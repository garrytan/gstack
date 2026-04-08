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
import * as path from 'path';

export interface BrowseConfig {
  projectDir: string;
  stateDir: string;
  stateFile: string;
  consoleLog: string;
  networkLog: string;
  dialogLog: string;
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
  };
}

/**
 * Create the .gstack/ state directory if it doesn't exist.
 * Throws with a clear message on permission errors.
 */
export function ensureStateDir(config: BrowseConfig): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  } catch (err: any) {
    if (err.code === 'EACCES') {
      throw new Error(`Cannot create state directory ${config.stateDir}: permission denied`);
    }
    if (err.code === 'ENOTDIR') {
      throw new Error(`Cannot create state directory ${config.stateDir}: a file exists at that path`);
    }
    throw err;
  }
}

/**
 * Ensure .gstack/ is ignored by git.
 *
 * Call this from a serialized startup path. It mutates repo-local git
 * ignore metadata, so it should not run from both the CLI and server process.
 */
function resolveGitExcludePath(projectDir: string): string | null {
  const dotGitPath = path.join(projectDir, '.git');

  try {
    const stat = fs.statSync(dotGitPath);
    if (stat.isDirectory()) {
      return path.join(dotGitPath, 'info', 'exclude');
    }
    if (!stat.isFile()) {
      return null;
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const dotGitFile = fs.readFileSync(dotGitPath, 'utf-8');
  const prefix = 'gitdir: ';
  const gitDirLine = dotGitFile
    .split(/\r?\n/)
    .find(line => line.toLowerCase().startsWith(prefix));

  if (!gitDirLine) {
    return null;
  }

  const gitDir = gitDirLine.slice(prefix.length).trim();
  if (!gitDir) {
    return null;
  }

  const resolvedGitDir = path.isAbsolute(gitDir)
    ? gitDir
    : path.resolve(projectDir, gitDir);
  return path.join(resolvedGitDir, 'info', 'exclude');
}

export function ensureProjectIgnoreEntry(config: BrowseConfig): void {
  // Keep .gstack/ out of git status without mutating the tracked .gitignore file.
  const excludePath = resolveGitExcludePath(config.projectDir);
  if (!excludePath) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const content = fs.existsSync(excludePath)
      ? fs.readFileSync(excludePath, 'utf-8')
      : '';
    if (!content.match(/^\.gstack\/?$/m)) {
      const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(excludePath, `${separator}.gstack/\n`);
    }
  } catch (err: any) {
    // Write warning to server log (visible even in daemon mode)
    const logPath = path.join(config.stateDir, 'browse-server.log');
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] Warning: could not update git exclude at ${excludePath}: ${err.message}\n`);
    } catch {
      // stateDir write failed too — nothing more we can do
    }
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
