/**
 * The `bookkeeping` policy key (GST-1311): tables a verify or ratchet step rewrites after review (size baselines, serial
 * lists, limits). Their small edits take /ship finish's scoped reader instead of another review round
 * (docs/ship-policy.md#bookkeeping). Split out of ship-policy.ts, with the shared glob check, to keep that module under the
 * module-size ratchet. The two files import only functions from each other, so either may load first.
 */
import { containedRelative, globToRegExp } from './ship-policy';
const TABLE = /\.(tsv|csv|txt)$/i;

/** Why a policy glob is refused: it escapes the repository or does not compile (every glob-list key, bookkeeping included). */
export function globError(g: string): string | null {
  const why = containedRelative(g);
  if (why) return why;
  try { globToRegExp(g); } catch (e: any) { return e.message; }
  return null;
}

/** Why a bookkeeping glob is refused: it could match code or gstack's own policy files. */
export function bookkeepingGlobError(g: string): string | null {
  if (!TABLE.test(g)) return 'must end in .tsv, .csv or .txt (a bookkeeping table, never code)';
  if (/^\.(gstack|github)\//.test(g)) return 'must not name a path under .gstack/ or .github/';
  return null;
}
