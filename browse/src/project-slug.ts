/**
 * Project slug resolution for the browse daemon.
 *
 * Used by domain-skills (per-project storage) and sidebar prompt-context
 * injection. Cached after first call — slug is derived from the daemon's
 * git remote (or env override) and doesn't change between commands.
 *
 * gstack-slug is read from the checkout this daemon runs from first, then
 * from the Claude Code install. Codex, repo-local and other host installs
 * have no ~/.claude copy; when no gstack-slug runs, the slug comes from the
 * same remote rule (getRemoteSlug) instead of one shared "unknown" bucket
 * that would mix every project's domain skills.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { getRemoteSlug } from './config';

let cachedSlug: string | null = null;

export function getCurrentProjectSlug(): string {
  if (cachedSlug) return cachedSlug;
  const explicit = process.env.GSTACK_PROJECT_SLUG;
  if (explicit) {
    cachedSlug = explicit;
    return explicit;
  }
  const candidates = [
    path.resolve(import.meta.dir, '../../bin/gstack-slug'),
    path.join(os.homedir(), '.claude/skills/gstack/bin/gstack-slug'),
  ];
  for (const slugBin of candidates) {
    if (!fs.existsSync(slugBin)) continue;
    try {
      const out = execFileSync(slugBin, [], { encoding: 'utf8', timeout: 2000, windowsHide: true }).trim();
      const m = out.match(/SLUG="?([^"\n]+)"?/);
      if (m) {
        cachedSlug = m[1]!;
        return cachedSlug;
      }
    } catch {
      // next candidate
    }
  }
  cachedSlug = getRemoteSlug() || 'unknown';
  return cachedSlug;
}

/** Reset cache; for tests only. */
export function _resetProjectSlugCache(): void {
  cachedSlug = null;
}
