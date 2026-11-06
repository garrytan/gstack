/**
 * pregate check `policy-floor` (tier 1, preflight; GST-1637): on a branch that changes .gstack/ship-policy.json, the
 * policy's min_gstack_version may not be above the newest stable gstack release, which would break every
 * stable-channel lane (lib/stable-release.ts). When that release cannot be resolved the check warns and says so.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SHIP_POLICY_PATH } from '../../ship-policy';
import { floorAgainstStable, newestStableRelease } from '../../stable-release';
import { baseInputs } from '../context';
import type { CheckDef, CheckResult, PregateContext } from '../types';

function run(ctx: PregateContext): CheckResult {
  const inputs = baseInputs(ctx);
  const base = { id: 'policy-floor', stage: 'preflight' as const, inputs };
  if (!ctx.touched.some(t => t.path === SHIP_POLICY_PATH && t.status !== 'D')) return { ...base, status: 'pass', detail: `${SHIP_POLICY_PATH} unchanged` };
  let floor: unknown;
  try { floor = (JSON.parse(fs.readFileSync(path.join(ctx.repoRoot, SHIP_POLICY_PATH), 'utf8')) as Record<string, unknown> | null)?.min_gstack_version; }
  catch { return { ...base, status: 'pass', detail: `${SHIP_POLICY_PATH} does not parse; gstack-ship-policy validate names why` }; }
  const verdict = floorAgainstStable(floor, newestStableRelease(ctx.env));
  if (verdict.error) return { ...base, status: 'fail', code: 'POLICY_FLOOR_ABOVE_STABLE', detail: verdict.error.message, fix: `set min_gstack_version in ${SHIP_POLICY_PATH} to ${verdict.stable} or lower, then gstack-ship-policy validate` };
  if (verdict.warning) return { ...base, status: 'warn', code: 'STABLE_RELEASE_UNKNOWN', detail: verdict.warning, fix: 'git fetch origin --tags in the gstack checkout, or set GSTACK_STABLE_REPO to one that has the release tags, then rerun' };
  return { ...base, status: 'pass', detail: verdict.stable ? `min_gstack_version ${floor as string} is at or below the newest stable gstack release ${verdict.stable}` : `${SHIP_POLICY_PATH} sets no min_gstack_version` };
}

export const policyFloorCheck: CheckDef = { id: 'policy-floor', stage: 'preflight', tier: 1, downgradable: true, needsRepoCommands: false, run };
