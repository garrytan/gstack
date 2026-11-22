#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Gate census arms for evals-periodic.yml (GSTA-49 TM2). Each arm is one host
 * and model running the weekly gate census plan:
 *   - Monday cron (0 6 * * 1): claude-opus (the capture model, lib/eval-model.ts)
 *     and codex-sol (gpt-6.1-sol on the Codex host, adapter cases only);
 *   - monthly cron (0 6 1 * *): claude-fable and codex-astra, census jobs only;
 *   - dispatch: `census_arms` runs only the census with the named arms; without
 *     it a dispatch keeps the periodic lane plus the Monday arms when the census
 *     runs (main, or include_gate_census).
 * Judges stay in the Claude lanes: every census plan skips them.
 *
 * CLI (GitHub step outputs and env lines):
 *   --select                 env SCHEDULE, CENSUS_ARMS, INCLUDE_GATE_CENSUS -> arms=<json>, periodic_lane=<bool>
 *   --env <arm>              KEY=VALUE lines selecting the arm's host and model
 *   --matrix <dir> <arms>    gate_matrix=<json> from <dir>/<arm>/manifest.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvalHost } from '../../test/helpers/e2e-hosts';

export interface CensusArm { host: EvalHost; model?: string }

export const CENSUS_ARMS: Readonly<Record<string, CensusArm>> = Object.freeze({
  // No model: the Claude runners' capture default (claude-opus-5-5 since TM1).
  'claude-opus': { host: 'claude' },
  'codex-sol': { host: 'codex', model: 'gpt-6.1-sol' },
  'claude-fable': { host: 'claude', model: 'claude-fable-5-1' },
  'codex-astra': { host: 'codex', model: 'gpt-6-astra' },
});

export const WEEKLY_CENSUS_SCHEDULE = '0 6 * * 1';
export const MONTHLY_CENSUS_SCHEDULE = '0 6 1 * *';
export const WEEKLY_CENSUS_ARMS: readonly string[] = ['claude-opus', 'codex-sol'];
export const MONTHLY_CENSUS_ARMS: readonly string[] = ['claude-fable', 'codex-astra'];

/** Which census arms run, and whether the periodic lane runs beside them. */
export function selectCensus(opts: { schedule?: string; censusArms?: string; includeGateCensus: boolean }): { arms: string[]; periodicLane: boolean } {
  if (opts.schedule === MONTHLY_CENSUS_SCHEDULE) return { arms: [...MONTHLY_CENSUS_ARMS], periodicLane: false };
  const named = (opts.censusArms ?? '').split(/[\s,]+/).filter(Boolean);
  const unknown = named.filter(arm => !Object.hasOwn(CENSUS_ARMS, arm));
  if (unknown.length) throw new Error(`unknown census arm(s): ${unknown.join(', ')}; known: ${Object.keys(CENSUS_ARMS).join(', ')}`);
  if (named.length) return { arms: [...new Set(named)], periodicLane: false };
  return { arms: opts.includeGateCensus ? [...WEEKLY_CENSUS_ARMS] : [], periodicLane: true };
}

/** The env one arm's planner and executor run with. */
export function censusArmEnv(arm: string): Record<string, string> {
  const spec = CENSUS_ARMS[arm];
  if (!spec) throw new Error(`unknown census arm: ${arm}`);
  if (!spec.model) return { EVALS_HOST: spec.host };
  return { EVALS_HOST: spec.host, [spec.host === 'codex' ? 'GSTACK_CODEX_MODEL' : 'EVALS_MODEL']: spec.model };
}

/** One executor per arm and planned slice, with that slice's planned CI ceiling. */
export function censusMatrix(arms: readonly string[], planDir: string): Array<{ arm: string; slice: number; timeout: number }> {
  return arms.flatMap(arm => {
    const manifest = JSON.parse(fs.readFileSync(path.join(planDir, arm, 'manifest.json'), 'utf8')) as
      { sliceCount: number; plan?: { ciTimeoutMinutes: number; sliceCiTimeoutMinutes?: number[] } };
    if (!manifest.plan) throw new Error(`${arm}: census manifest has no budget plan`);
    return Array.from({ length: manifest.sliceCount }, (_, i) => ({
      arm, slice: i + 1, timeout: manifest.plan!.sliceCiTimeoutMinutes?.[i] ?? manifest.plan!.ciTimeoutMinutes,
    }));
  });
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--select') {
    const { arms, periodicLane } = selectCensus({ schedule: process.env.SCHEDULE, censusArms: process.env.CENSUS_ARMS,
      includeGateCensus: process.env.INCLUDE_GATE_CENSUS === 'true' });
    console.log(`arms=${JSON.stringify(arms)}\nperiodic_lane=${periodicLane}`);
  } else if (mode === '--env' && args.length === 1) {
    for (const [key, value] of Object.entries(censusArmEnv(args[0]!))) console.log(`${key}=${value}`);
  } else if (mode === '--matrix' && args.length === 2) {
    console.log(`gate_matrix=${JSON.stringify(censusMatrix(JSON.parse(args[1]!) as string[], args[0]!))}`);
  } else {
    console.error('usage: census-arms.ts --select | --env <arm> | --matrix <plan dir> <arms json>');
    process.exit(2);
  }
}
