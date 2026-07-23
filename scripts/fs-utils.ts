import * as fs from 'fs';

/**
 * Drop-in replacement for fs.mkdirSync(dir, { recursive: true }).
 *
 * Bun on Windows (still present in 1.3.11) throws EEXIST from recursive
 * mkdirSync when the target directory already exists AND carries the
 * FILE_ATTRIBUTE_READONLY attribute (harmless on directories - Explorer
 * repurposes it as a "customized folder" marker). Node treats the same
 * call as a no-op success. See oven-sh/bun#16466 (the plain-dir variant,
 * fixed) - the ReadOnly variant still reproduces.
 *
 * Guard: swallow EEXIST only after confirming the path is an existing
 * directory; a collision with a regular file still throws.
 */
export function mkdirpSync(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      try {
        if (fs.statSync(dir).isDirectory()) return;
      } catch {
        // fall through and rethrow the original mkdir error
      }
    }
    throw error;
  }
}
