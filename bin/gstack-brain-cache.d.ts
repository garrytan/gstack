/**
 * Ambient types for bin/gstack-brain-cache (a shebang script, no .ts
 * extension by design — it's invoked directly as a CLI binary). TypeScript's
 * module resolution can't locate an extensionless file, so tests that
 * dynamically `import('../bin/gstack-brain-cache')` need this sibling
 * declaration. Covers only the exports the test suite actually imports —
 * keep in sync with bin/gstack-brain-cache if those call sites change.
 */
import type { BrainCacheEntity } from '../scripts/brain-cache-spec';

export interface GetResult {
  path: string;
  state: 'warm' | 'cold-refreshed' | 'stale-fallback' | 'missing';
  message?: string;
}

export interface CacheMeta {
  schema_version: string;
  endpoint_hash: string;
  last_refresh: Record<string, number>;
  last_attempt?: Record<string, number>;
}

export function entityPath(entityName: string, projectSlug: string | null): string;
export function detectEndpointHash(): string;
export function cmdGet(entityName: string, projectSlug: string | null): GetResult;
export function withRefreshLock<T>(projectSlug: string | null, fn: () => T): T | 'dedup';
export function cmdInvalidate(entityName: string, projectSlug: string | null): void;
export function cmdMeta(projectSlug: string | null): CacheMeta;
export function getSalienceAllowlist(): ReadonlyArray<string>;
export function isSalienceSlugAllowed(slug: string, allowlist: ReadonlyArray<string>): boolean;
export type { BrainCacheEntity };
