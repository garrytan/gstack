/**
 * {{DAY_ONE_STEPS}} — the day-one pass the plan reviews run before anything
 * else (GST-2947). Source: lib/day-one-steps.ts, shared with the lean
 * /autoplan reviewer's brief so the skill text and the prompt never drift.
 */
import type { ResolverFn } from './types';
import { DAY_ONE_BLOCK } from '../../lib/day-one-steps';

export const generateDayOneSteps: ResolverFn = () => DAY_ONE_BLOCK;
