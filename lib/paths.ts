/**
 * Cross-platform path utilities for gstack
 * 
 * Provides platform-aware directory resolution for:
 * - Configuration directories (~/.gstack, etc)
 * - Home directory
 * - Temporary directory
 * - Binary locations
 * 
 * Usage:
 *   import { getConfigDir, getHomeDir, getTempDir } from '../lib/paths';
 *   const configFile = path.join(getConfigDir(), 'config.json');
 */

import * as os from 'os';
import * as path from 'path';

// Platform detection
export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

/**
 * Get the user's home directory
 * Uses os.homedir() for cross-platform compatibility
 */
export function getHomeDir(): string {
  return os.homedir();
}

/**
 * Get the gstack configuration directory
 * - macOS/Linux: ~/.gstack
 * - Windows: %USERPROFILE%\.gstack
 */
export function getConfigDir(): string {
  return path.join(getHomeDir(), '.gstack');
}

/**
 * Get the Claude Code configuration directory
 * - macOS: ~/.claude
 * - Windows: %USERPROFILE%\.claude
 * - Linux: ~/.claude
 */
export function getClaudeConfigDir(): string {
  return path.join(getHomeDir(), '.claude');
}

/**
 * Get Claude Code skills directory
 * - macOS/Linux: ~/.claude/skills
 * - Windows: %USERPROFILE%\.claude\skills
 */
export function getClaudeSkillsDir(): string {
  return path.join(getClaudeConfigDir(), 'skills');
}

/**
 * Get Codex configuration directory
 * - All platforms: ~/.codex
 */
export function getCodexConfigDir(): string {
  return path.join(getHomeDir(), '.codex');
}

/**
 * Get Factory configuration directory
 * - All platforms: ~/.factory
 */
export function getFactoryConfigDir(): string {
  return path.join(getHomeDir(), '.factory');
}

/**
 * Get OpenCode configuration directory
 * - macOS/Linux: ~/.config/opencode
 * - Windows: %USERPROFILE%\.config\opencode
 */
export function getOpenCodeConfigDir(): string {
  if (IS_WINDOWS) {
    return path.join(getHomeDir(), '.config', 'opencode');
  }
  return path.join(getHomeDir(), '.config', 'opencode');
}

/**
 * Get system temporary directory
 * - macOS/Linux: /tmp (hardcoded for consistency with shell scripts)
 * - Windows: uses os.tmpdir() (e.g., C:\Users\...\AppData\Local\Temp)
 */
export function getTempDir(): string {
  if (IS_WINDOWS) {
    return os.tmpdir();
  }
  return '/tmp';
}

/**
 * Get gstack analytics directory
 * - All platforms: ~/.gstack/analytics
 */
export function getAnalyticsDir(): string {
  return path.join(getConfigDir(), 'analytics');
}

/**
 * Get gstack projects directory (for plans, designs, etc)
 * - All platforms: ~/.gstack/projects
 */
export function getProjectsDir(): string {
  return path.join(getConfigDir(), 'projects');
}

/**
 * Get gstack sessions directory (for tracking active sessions)
 * - All platforms: ~/.gstack/sessions
 */
export function getSessionsDir(): string {
  return path.join(getConfigDir(), 'sessions');
}

/**
 * Get gstack development directory (for evals, harvests, etc)
 * - All platforms: ~/.gstack-dev
 */
export function getDevDir(): string {
  return path.join(getHomeDir(), '.gstack-dev');
}

/**
 * Check if a resolved path is within a directory
 * Handles platform-specific path separators
 * 
 * @param resolvedPath - Absolute path to check
 * @param dir - Directory to check against
 * @returns true if resolvedPath is within dir or equals dir
 */
export function isPathWithin(resolvedPath: string, dir: string): boolean {
  return resolvedPath === dir || resolvedPath.startsWith(dir + path.sep);
}

/**
 * Normalize a path for the current platform
 * - Converts forward slashes to backslashes on Windows
 * - Resolves .. and . components
 * 
 * @param filePath - Path to normalize
 * @returns Normalized path
 */
export function normalizePath(filePath: string): string {
  return path.normalize(filePath);
}

/**
 * Convert a Unix-style path to platform-specific path
 * Used when reading from config files that always use forward slashes
 * 
 * @param unixPath - Path using forward slashes (e.g., "src/folder/file.ts")
 * @returns Platform-specific path
 */
export function fromUnixPath(unixPath: string): string {
  if (IS_WINDOWS) {
    return unixPath.split('/').join(path.sep);
  }
  return unixPath;
}

/**
 * Convert a platform-specific path to Unix-style path
 * Used when writing to config files that should always use forward slashes
 * 
 * @param platformPath - Platform-specific path
 * @returns Unix-style path with forward slashes
 */
export function toUnixPath(platformPath: string): string {
  return platformPath.split(path.sep).join('/');
}

/**
 * Get the path separator for the current platform
 * - Windows: \
 * - Unix: /
 */
export function getPathSeparator(): string {
  return path.sep;
}

/**
 * Expand ~ in a path to the home directory
 * Works on all platforms
 * 
 * @param filePath - Path that may start with ~
 * @returns Expanded absolute path
 */
export function expandHome(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(getHomeDir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Create a URL-safe slug from a path or string
 * Removes special characters that could break file paths
 * 
 * @param input - String to slugify
 * @returns Safe filename/slug
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
