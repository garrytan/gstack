/** Containment of a repository-relative write path (moved from lib/ship-policy.ts, which re-exports it, to keep that module under its size ratchet). */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A working-tree path a stamp may write: inside `root` after realpath (a
 * symlink out of the repository is refused even when the glob matched).
 */
export function assertInsideRoot(root: string, rel: string): string | null {
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, rel);
  if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) return `${rel} resolves outside ${root}`;
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real: string;
  try { real = fs.realpathSync(probe); } catch { return null; }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return `${rel} resolves through a symlink to outside ${root}`;
  return null;
}
