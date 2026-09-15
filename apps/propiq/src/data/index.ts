/**
 * Adapter selection.
 *
 * `PROPIQ_DATA_ADAPTER` chooses the backing source. `getServerEnv()` already
 * refuses `fixture` under `NODE_ENV=production`, so this module cannot be the
 * path by which demo data reaches a production deployment.
 */

import 'server-only';
import { getServerEnv } from '@/lib/env';
import type { PropertyRepository } from './ports';
import { FixturePropertyRepository } from './fixtures/adapter';
import { SupabasePropertyRepository } from './supabase/property-repository';

let cached: PropertyRepository | undefined;

export const getPropertyRepository = (): PropertyRepository => {
  if (cached) return cached;
  const env = getServerEnv();
  const repository: PropertyRepository =
    env.PROPIQ_DATA_ADAPTER === 'supabase'
      ? new SupabasePropertyRepository()
      : new FixturePropertyRepository();
  cached = repository;
  return repository;
};

/** Test-only: clears the memoised repository. */
export const __resetRepositoryCache = (): void => {
  cached = undefined;
};

export type { PropertyRepository } from './ports';
