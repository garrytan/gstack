import { buildEvidenceRecord, evaluateFreshness, type EvidenceBuildInput, type EvidenceRecordV2 } from './evidence-envelope';
import { ProcessLocalGrant } from './effect-scope';

export interface TrustedValidatorBinding {
  validatorId: string;
  effect: 'read' | 'paid_model';
  argv: string[];
  cwd: string;
  evidenceContext: Omit<EvidenceBuildInput, 'caller'>;
  currentRecord: EvidenceRecordV2 | null;
  paidGrantAssertions?: Readonly<Record<string, string>>;
}
export interface EnsureResult {
  disposition: 'receipt_current' | 'live_pass' | 'live_fail' | 'grant_required' | 'configuration_error';
  validator_id: string; spawned: boolean; required_effect?: 'read' | 'paid_model'; receipt_run_id?: string; child_exit?: number;
}
export interface ValidatorRunnerAdapters {
  grant?: ProcessLocalGrant;
  spawn: (argv: string[], options: { cwd: string; shell: false }) => { exitCode: number };
  append: (record: EvidenceRecordV2) => void;
  now?: () => string;
}

export function evaluateValidatorBinding(binding: TrustedValidatorBinding) {
  const context = binding.evidenceContext;
  return evaluateFreshness(binding.currentRecord, {
    now: new Date().toISOString(),
    subject: { repo_id: context.repo_id, branch_ref: context.branch_ref, base_sha: context.base_sha, merge_base_sha: context.merge_base_sha, local_head_sha: context.local_head_sha, remote_pr_head_sha: context.remote_pr_head_sha, tree: context.tree, wtree: context.wtree, dirty: context.dirty },
    command_argv: binding.argv,
    capability: context.capability,
    validator: context.validator,
    policy_version: context.policy_version ?? 'evidence-policy.v2',
    semantic_policy_hash: context.semantic_policy_hash,
    lockfile_hashes: context.lockfile_hashes,
    dependency_fingerprints: context.dependency_fingerprints,
    toolchain_fingerprint: context.toolchain_fingerprint,
    environment_class: context.environment_class,
    eval_binding: context.eval_binding,
    semantic_intersection: true,
    projection_matches: true,
  });
}

export function ensureValidator(binding: TrustedValidatorBinding, adapters: ValidatorRunnerAdapters): EnsureResult {
  if (!binding.validatorId || !binding.argv.length || binding.evidenceContext.validator.id !== binding.validatorId) return { disposition: 'configuration_error', validator_id: binding.validatorId, spawned: false };
  const current = evaluateValidatorBinding(binding);
  if (current.current) return { disposition: 'receipt_current', validator_id: binding.validatorId, spawned: false, receipt_run_id: current.receipt_run_id };
  if (binding.effect === 'paid_model') {
    if (!adapters.grant) return { disposition: 'grant_required', validator_id: binding.validatorId, spawned: false, required_effect: 'paid_model' };
    const consumed = adapters.grant.consume('paid_model');
    const expected = binding.paidGrantAssertions ?? { validatorId: binding.validatorId };
    for (const [key, value] of Object.entries(expected)) {
      if (consumed.assertions[key] !== value) throw new Error('effect_grant_mismatch');
    }
    if (Object.keys(consumed.assertions).length !== Object.keys(expected).length) throw new Error('effect_grant_mismatch');
  }
  const started = adapters.now?.() ?? new Date().toISOString();
  const child = adapters.spawn([...binding.argv], { cwd: binding.cwd, shell: false });
  const completed = adapters.now?.() ?? new Date().toISOString();
  const record = buildEvidenceRecord({ ...binding.evidenceContext, started_at: started, completed_at: completed, caller: { command_argv: binding.argv, result: child.exitCode === 0 ? 'pass' : 'fail', exit: child.exitCode, artifacts: [], side_effects: [] } });
  adapters.append(record);
  return { disposition: child.exitCode === 0 ? 'live_pass' : 'live_fail', validator_id: binding.validatorId, spawned: true, required_effect: binding.effect, receipt_run_id: record.run_id, child_exit: child.exitCode };
}
