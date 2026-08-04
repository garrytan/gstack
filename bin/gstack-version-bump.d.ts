/**
 * Ambient types for bin/gstack-version-bump (a shebang script, no .ts
 * extension by design — it's invoked directly as a CLI binary). TypeScript's
 * module resolution can't locate an extensionless file, so
 * test/gstack-version-bump.test.ts's static import needs this sibling
 * declaration. Covers only the exports the test suite actually imports —
 * keep in sync with bin/gstack-version-bump if those call sites change.
 */
export type State = 'FRESH' | 'ALREADY_BUMPED' | 'DRIFT_STALE_PKG' | 'DRIFT_UNEXPECTED';

export const VERSION_RE: RegExp;
export function classifyState(current: string, base: string, pkgExists: boolean, pkgVersion: string): State;
