/**
 * {{COORDINATOR_CONTRACT}} — the coordinator block every lane prompt inherits
 * word for word (plan E2). Source: lib/coordinator-contract.ts, shared with
 * bin/gstack-autoplan's prompt writer so the rendered skill text and the
 * printed lane prompts never drift.
 */
import type { ResolverFn } from './types';
import { COORDINATOR_CONTRACT } from '../../lib/coordinator-contract';

export const generateCoordinatorContract: ResolverFn = () => COORDINATOR_CONTRACT;
