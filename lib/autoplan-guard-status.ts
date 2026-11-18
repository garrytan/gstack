/**
 * What gstack-skill-start and the gstack-autoplan run record say about the
 * /autoplan publication guard. The guard is the PreToolUse hook that the
 * Claude render of autoplan/SKILL.md declares in its frontmatter
 * (scripts/resolvers/composition.ts). Claude Code runs it whenever /autoplan
 * was started as a skill, whatever GSTACK_SESSION_KIND says, so the line
 * follows the host and the installed skill, never the session kind (GST-3062).
 * bin/gstack-skill-start carries the same rule in bash; test/autoplan-guard-status.test.ts holds them equal.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const GUARD_NOT_INSTALLED_LINE = 'autoplan guard: not enforced by this host; publication order is unverified (GUARD_NOT_INSTALLED)';
export const GUARD_ENFORCED_LINE = "autoplan guard: enforced by Claude Code's /autoplan hook at phase Reads and reviewer dispatch; " +
  'publish each phase report as visible message text, not reasoning, before the next phase (GUARD_ENFORCED)';

/** True when the installed autoplan/SKILL.md declares the publication hook in its frontmatter. */
export function publicationHookDeclared(root: string): boolean {
  let text: string;
  try { text = fs.readFileSync(path.join(root, 'autoplan', 'SKILL.md'), 'utf8'); } catch { return false; }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? '';
  return frontmatter.includes('autoplan/bin/phase-publication-hook');
}

/** The one guard line for this process: enforced only on Claude Code with the hook declared. */
export function autoplanGuardLine(env: Record<string, string | undefined>, root: string): string {
  const claude = !!env.CLAUDECODE && (!env.GSTACK_ACTIVE_HOST || env.GSTACK_ACTIVE_HOST === 'claude');
  return claude && publicationHookDeclared(root) ? GUARD_ENFORCED_LINE : GUARD_NOT_INSTALLED_LINE;
}
