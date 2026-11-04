/**
 * The `release_gate` block of .gstack/ship-policy.json
 * (docs/ship-policy.md#release-gate): the full paid gate on the base branch
 * every few hours, run by bin/gstack-release-gate from
 * .github/workflows/release-gate.yml, instead of a gate per train or
 * per push. The gate never writes the stable branch: scripts/release-cut.ts
 * stays its only writer, reads a green gate as "gated" and holds every cut
 * while the newest gate is red. Validated here so lib/ship-policy.ts stays
 * one schema file.
 */
import type { PolicyError } from './ship-policy';

export interface ReleaseGatePolicy {
  /** Least hours between two gate dispatches; at least RELEASE_GATE_SCHEDULE_HOURS, the workflow's schedule. */
  cadence_hours: number;
  /** Workflow file dispatched for the full paid gate and the bisect; it accepts the eval-bg dispatch inputs. */
  gate_workflow: string;
  /** The branch the gate tests (its head at each run). */
  branch: string;
  /** The branch scripts/release-cut.ts moves; the gate only reads it to count pending commits. */
  stable_ref: string;
  /** The check run published on a gated commit, read by release-cut as gated. */
  check_name: string;
  /** What a red gate does. hold-release: the red record keeps release-cut from cutting until a later gate is green. */
  on_red: 'hold-release';
  /** Cap over one red gate's bisect, at RELEASE_TRIAL_RESERVATION_USD per case trial; 0 skips the bisect. */
  bisect_spend_cap_usd: number;
}

/** The cron step of release-gate.yml's schedule (test/release-gate-workflow.test.ts pins it): no cadence gates more often. */
export const RELEASE_GATE_SCHEDULE_HOURS = 8;
const REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/;
const FIELDS: Record<keyof ReleaseGatePolicy, (v: unknown) => string | null> = {
  cadence_hours: v => (Number.isInteger(v) && (v as number) >= RELEASE_GATE_SCHEDULE_HOURS && (v as number) <= 168 ? null : `must be a whole number of hours from ${RELEASE_GATE_SCHEDULE_HOURS} (the workflow's schedule) to 168`),
  gate_workflow: v => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}\.ya?ml$/.test(v) ? null : 'must be a workflow file name such as evals.yml'),
  branch: v => (typeof v === 'string' && REF.test(v) ? null : 'must be a branch name'),
  stable_ref: v => (typeof v === 'string' && REF.test(v) ? null : 'must be a branch name'),
  check_name: v => (typeof v === 'string' && /^[A-Za-z0-9_./-]{1,64}$/.test(v) ? null : 'must be a check-run name ([A-Za-z0-9_./-]{1,64})'),
  on_red: v => (v === 'hold-release' ? null : 'must be hold-release'),
  bisect_spend_cap_usd: v => (typeof v === 'number' && v >= 0 && v <= 500 ? null : 'must be dollars from 0 to 500'),
};

export const RELEASE_GATE_EXPLANATION = '{ cadence_hours, gate_workflow, branch, stable_ref, check_name, on_red, bisect_spend_cap_usd } or null: the release gate (docs/ship-policy.md#release-gate). bin/gstack-release-gate dispatches the full paid gate (gate_workflow) on the head of branch at most once per cadence_hours, only when branch moved since the last gate, records the verdict as a release note in refs/notes/gstack-trains and publishes check_name on the gated commit; a red gate bisects its red cases (bisect_spend_cap_usd, 0 skips) and, with on_red hold-release, keeps scripts/release-cut.ts from moving stable_ref until a later gate is green. It never writes stable_ref. While the block is set, the per-push main backstop stands down. null keeps the per-push backstop.';

export function releaseGateErrors(raw: unknown): PolicyError[] {
  const g = raw as Record<string, unknown> | null;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return [{ code: 'POLICY_INVALID', path: 'release_gate', message: `must be { ${Object.keys(FIELDS).join(', ')} } or null` }];
  const out: PolicyError[] = [];
  for (const k of Object.keys(g)) if (!(k in FIELDS)) out.push({ code: 'POLICY_INVALID', path: `release_gate.${k}`, message: 'unknown key' });
  for (const [k, check] of Object.entries(FIELDS)) {
    if (!(k in g)) { out.push({ code: 'POLICY_INVALID', path: `release_gate.${k}`, message: 'missing (every release_gate field is required)' }); continue; }
    const why = check(g[k]);
    if (why) out.push({ code: 'POLICY_INVALID', path: `release_gate.${k}`, message: `${JSON.stringify(g[k])} ${why}` });
  }
  if (typeof g.branch === 'string' && g.branch === g.stable_ref) out.push({ code: 'POLICY_INVALID', path: 'release_gate.stable_ref', message: 'must differ from branch' });
  return out;
}
