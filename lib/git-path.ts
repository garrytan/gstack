/**
 * Where a gstack file under this checkout's git directory lives: `git rev-parse --git-path <name>` (HARN-108). In a linked
 * worktree `.git` is a file (`gitdir: …`), so the literal `.git/<name>` every caller fell back to when git failed, timed out
 * or printed nothing wrote through a file and failed with ENOTDIR. A failed or empty answer is now an error the caller names.
 */
import * as path from 'node:path';
import { spawnSync } from './spawn-sync';

export type GitPath = { ok: true; path: string } | { ok: false; error: string };

export function gitPath(cwd: string, name: string, timeoutMs = 30_000): GitPath {
  const r = spawnSync('git', ['rev-parse', '--git-path', name], { cwd, encoding: 'utf8', timeout: Math.max(1, timeoutMs) });
  const out = r.status === 0 ? String(r.stdout ?? '').trim() : '';
  if (out) return { ok: true, path: path.resolve(cwd, out) };
  const why = String(r.stderr ?? '').trim().split('\n')[0] || (r.error as NodeJS.ErrnoException | undefined)?.code || (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
  return { ok: false, error: `git rev-parse --git-path ${name} gave no path (${why.slice(0, 200)}), and gstack does not guess .git/${name}: in a linked worktree .git is a file` };
}
