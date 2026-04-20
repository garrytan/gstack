/**
 * Cross-platform binary/executable locator
 * 
 * Provides utilities to find executables on:
 * - Windows (checks PATH, common install locations)
 * - macOS (checks /usr/local/bin, /opt, etc)
 * - Linux (checks /usr/bin, /usr/local/bin, ~/.local/bin, etc)
 * 
 * Usage:
 *   import { findBinary, findBinaryOrThrow } from '../lib/binary-locator';
 *   const pdftotext = await findBinaryOrThrow('pdftotext');
 *   const git = await findBinary('git') || 'git'; // fallback to PATH
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { IS_WINDOWS, getHomeDir } from './paths';

export interface BinaryLocation {
  path: string;
  version?: string;
}

export interface BinaryNotFoundError extends Error {
  name: 'BinaryNotFoundError';
  command: string;
  searchPaths: string[];
}

/**
 * Create a BinaryNotFoundError
 */
export function createBinaryNotFoundError(
  command: string,
  searchPaths: string[]
): BinaryNotFoundError {
  const error = new Error(
    `Binary '${command}' not found in any location.\n` +
    `Searched: ${searchPaths.join(', ')}\n` +
    `Try: npm install -g ${command} or check installation`
  ) as BinaryNotFoundError;
  error.name = 'BinaryNotFoundError';
  error.command = command;
  error.searchPaths = searchPaths;
  return error;
}

/**
 * Get common binary search paths for the current platform
 */
export function getSearchPaths(command: string): string[] {
  const homeDir = getHomeDir();
  const paths: string[] = [];

  if (IS_WINDOWS) {
    // Windows search order:
    // 1. Current directory
    paths.push(process.cwd());
    // 2. User local bin
    paths.push(path.join(homeDir, '.local', 'bin'));
    paths.push(path.join(homeDir, 'AppData', 'Local', 'bin'));
    // 3. Program Files
    paths.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', command));
    paths.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', command));
    // 4. Scoop / Chocolatey / WinGet common locations
    paths.push(path.join(homeDir, 'scoop', 'shims'));
    paths.push('C:\\ProgramData\\chocolatey\\bin');
    // 5. System PATH will be checked last via fallback
  } else {
    // Unix (macOS, Linux) search order:
    // 1. Current directory
    paths.push(process.cwd());
    // 2. User local bin
    paths.push(path.join(homeDir, '.local', 'bin'));
    paths.push(path.join(homeDir, 'bin'));
    // 3. Homebrew (macOS)
    if (process.platform === 'darwin') {
      paths.push('/usr/local/bin');
      paths.push('/opt/homebrew/bin'); // Apple Silicon Macs
      paths.push('/usr/local/opt/*/bin'); // Homebrew versioned packages
    }
    // 4. Standard locations
    paths.push('/usr/local/bin');
    paths.push('/usr/bin');
    // 5. Snap (Linux)
    if (process.platform === 'linux') {
      paths.push('/snap/bin');
    }
  }

  return paths;
}

/**
 * Get the executable filename for the platform
 * - Windows: adds .exe, .bat, .cmd extensions
 * - Unix: returns as-is (no extension)
 */
export function getExecutableNames(command: string): string[] {
  if (IS_WINDOWS) {
    // Try with common Windows extensions
    return [
      command,
      `${command}.exe`,
      `${command}.bat`,
      `${command}.cmd`,
      `${command}.com`,
    ];
  }
  return [command];
}

/**
 * Check if a file is executable (readable and not a directory)
 */
async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) return false;
    
    if (IS_WINDOWS) {
      // On Windows, just check if file exists and is readable
      return stat.isFile();
    } else {
      // On Unix, check if user has execute permission
      // eslint-disable-next-line no-bitwise
      return (stat.mode & parseInt('0111', 8)) !== 0;
    }
  } catch {
    return false;
  }
}

/**
 * Find a binary in common system locations
 * Falls back to PATH environment variable if not found in standard locations
 * 
 * @param command - Name of command to find (e.g., 'pdftotext', 'git')
 * @returns Path to executable if found, null otherwise
 */
export async function findBinary(command: string): Promise<string | null> {
  const names = getExecutableNames(command);
  const searchPaths = getSearchPaths(command);

  // Search in predefined paths
  for (const dir of searchPaths) {
    for (const name of names) {
      const fullPath = path.join(dir, name);
      if (await isExecutable(fullPath)) {
        return fullPath;
      }
    }
  }

  // Fallback: try using 'which' or 'where' to search PATH
  try {
    const whichCmd = IS_WINDOWS ? 'where' : 'which';
    const result = spawnSync(whichCmd, [command], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status === 0 && result.stdout) {
      const foundPath = result.stdout.trim().split('\n')[0]; // Use first result
      if (foundPath && (await isExecutable(foundPath))) {
        return foundPath;
      }
    }
  } catch {
    // which/where not available, continue
  }

  return null;
}

/**
 * Find a binary or throw an error if not found
 * 
 * @param command - Name of command to find
 * @param errorMessage - Optional custom error message
 * @returns Path to executable
 * @throws BinaryNotFoundError if not found
 */
export async function findBinaryOrThrow(
  command: string,
  errorMessage?: string
): Promise<string> {
  const found = await findBinary(command);
  if (found) {
    return found;
  }

  const searchPaths = getSearchPaths(command);
  throw createBinaryNotFoundError(command, searchPaths);
}

/**
 * Get version of a command (for informational purposes)
 * Tries common version flags: --version, -v, -version
 * 
 * @param command - Path to command or command name
 * @returns Version string if found, undefined otherwise
 */
export function getVersion(command: string): string | undefined {
  const flags = ['--version', '-v', '-version', 'version'];

  for (const flag of flags) {
    try {
      const result = spawnSync(command, [flag], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });

      if (result.status === 0 && result.stdout) {
        // Extract version number (usually first line)
        const versionLine = result.stdout.split('\n')[0].trim();
        if (versionLine && versionLine.length < 200) {
          return versionLine;
        }
      }
    } catch {
      // Try next flag
    }
  }

  return undefined;
}

/**
 * Locate multiple binaries at once
 * 
 * @param commands - Array of command names
 * @returns Object with command name as key, path (or null) as value
 */
export async function findBinaries(commands: string[]): Promise<Record<string, string | null>> {
  const results: Record<string, string | null> = {};

  for (const command of commands) {
    results[command] = await findBinary(command);
  }

  return results;
}

/**
 * Get a description of search paths for a command
 * Useful for error messages and debugging
 */
export function describeSearchPaths(command: string): string {
  const paths = getSearchPaths(command);
  const platform = IS_WINDOWS ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  
  return `Searched in ${platform}:\n  - ${paths.join('\n  - ')}\n  - System PATH (via ${IS_WINDOWS ? 'where' : 'which'})`;
}
