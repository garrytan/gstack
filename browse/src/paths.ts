/**
 * Cross-platform path utilities — centralizes all platform-dependent path logic.
 *
 * Every source file imports from here instead of hardcoding /tmp/ or path separators.
 */

import * as os from 'os';
import * as path from 'path';

export const TEMP_DIR = os.tmpdir();

export function tempPath(filename: string): string {
  return path.join(TEMP_DIR, filename);
}

export function safeDirs(): string[] {
  return [TEMP_DIR, process.cwd()];
}

export function isPathSafe(filePath: string, dirs: string[] = safeDirs()): boolean {
  const resolved = path.resolve(filePath);
  return dirs.some(dir => resolved === dir || resolved.startsWith(dir + path.sep));
}

export function homeDir(): string {
  return os.homedir();
}

export function openArgs(): string[] {
  if (process.platform === 'win32') return ['cmd', '/c', 'start', ''];
  if (process.platform === 'darwin') return ['open'];
  return ['xdg-open'];
}
