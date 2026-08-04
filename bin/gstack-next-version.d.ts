/**
 * Ambient types for bin/gstack-next-version (a shebang script, no .ts
 * extension by design — it's invoked directly as a CLI binary). TypeScript's
 * module resolution can't locate an extensionless file, so
 * test/gstack-next-version.test.ts's static import needs this sibling
 * declaration. Covers only the exports the test suite actually imports —
 * keep in sync with bin/gstack-next-version if those call sites change.
 */
export type Bump = 'major' | 'minor' | 'patch' | 'micro';
export type Version = [number, number, number, number];

export interface Sibling {
  path: string;
  branch: string;
  version: string;
  last_commit_ts: number;
  has_open_pr: boolean;
  is_active: boolean;
}

export function parseVersion(s: string): Version | null;
export function fmtVersion(v: Version): string;
export function bumpVersion(v: Version, level: Bump): Version;
export function cmpVersion(a: Version, b: Version): number;
export function pickNextSlot(base: Version, claimed: Version[], level: Bump): { version: Version; reason: string };
export function markActiveSiblings(siblings: Sibling[], baseVersion: Version): Sibling[];
export function resolveVersionPath(override: string | undefined, repoRoot: string): string;
