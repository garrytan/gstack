/**
 * FROZEN: trialRecordProblems exactly as EVAL_POLICY v1 readers ship it
 * (origin/main 2db0b3adc, test/helpers/eval-store.ts). Never edit: it stands in
 * for older checkouts reading trial records written by this one, so new
 * optional fields must stay invisible to it (test/helpers/eval-store.test.ts).
 */
const TRIAL_OUTCOME_SCHEMA = 'gstack-trial-outcome/v1';
const TRIAL_ERROR_MAX = 300;
const EVAL_KINDS: readonly string[] = ['rule', 'behavior', 'judge'];
const FAILURE_CLASSES: readonly string[] = ['assertion', 'contract', 'timeout', 'infra'];

export function trialRecordProblems(r: any): string[] {
  const problems: string[] = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['not an object'];
  if (r.schema !== TRIAL_OUTCOME_SCHEMA) problems.push(`schema ${String(r.schema)}`);
  for (const key of ['case', 'file', 'tier'] as const) if (typeof r[key] !== 'string' || r[key].length === 0) problems.push(`${key} missing`);
  if (!EVAL_KINDS.includes(r.kind)) problems.push(`kind ${String(r.kind)}`);
  const n = r.panel?.n, k = r.panel?.k;
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 1 || k < 1 || k > n) problems.push('panel invalid');
  if (!Number.isInteger(r.trial) || r.trial < 1 || (Number.isInteger(n) && r.trial > n)) problems.push('trial invalid');
  if (!Number.isInteger(r.attempt) || r.attempt < 1) problems.push('attempt invalid');
  if (!['passed', 'failed', 'skipped'].includes(r.outcome)) problems.push(`outcome ${String(r.outcome)}`);
  if (r.outcome === 'failed' && !FAILURE_CLASSES.includes(r.failure_class)) problems.push('failed without failure_class');
  if (r.outcome !== 'failed' && r.failure_class !== undefined) problems.push('failure_class on a non-failed trial');
  if (typeof r.duration_ms !== 'number' || !Number.isFinite(r.duration_ms) || r.duration_ms < 0) problems.push('duration_ms invalid');
  if (typeof r.cost_usd !== 'number' || !Number.isFinite(r.cost_usd) || r.cost_usd < 0) problems.push('cost_usd invalid');
  if (!Number.isInteger(r.policy_version) || r.policy_version < 0) problems.push('policy_version invalid');
  if (typeof r.quarantined !== 'boolean') problems.push('quarantined invalid');
  if (r.execution !== 'executed' && r.execution !== 'reused') problems.push('execution invalid');
  if (!['shard', 'junit', 'backfill'].includes(r.source)) problems.push('source invalid');
  if (r.error !== undefined && (typeof r.error !== 'string' || r.error.length > TRIAL_ERROR_MAX)) problems.push('error invalid');
  if (r.series_identity !== undefined && (typeof r.series_identity !== 'string' || !/^[\w.-]{1,64}$/.test(r.series_identity))) problems.push('series_identity invalid');
  return problems;
}
