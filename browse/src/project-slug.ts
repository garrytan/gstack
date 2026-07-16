/**
 * Project slug resolution for the browse daemon.
 *
 * Used by domain-skills (per-project storage) and sidebar prompt-context
 * injection. Cached after first call — slug is derived from the daemon's
 * git remote (or env override) and doesn't change between commands.
 */

import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

let cachedSlug: string | null = null;

export function getCurrentProjectSlug(): string {
  if (cachedSlug) return cachedSlug;
  const explicit = process.env.GSTACK_PROJECT_SLUG;
  if (explicit) {
    cachedSlug = explicit;
    return explicit;
  }
  try {
    const slugBin = path.join(os.homedir(), '.claude/skills/gstack/bin/gstack-slug');
    const out = execSync(slugBin, { encoding: 'utf8', timeout: 2000 }).trim();
    const m = out.match(/SLUG="?([^"\n]+)"?/);
    cachedSlug = m ? m[1]! : (out || 'unknown');
  } catch {
    cachedSlug = 'unknown';
  }
  return cachedSlug;
}

/** Reset cache; for tests only. */
export function _resetProjectSlugCache(): void {
  cachedSlug = null;
}
