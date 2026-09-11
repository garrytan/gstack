import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildChangeManifest } from '../../lib/change-manifest';
import { resolveExecutionPlan, resolveManifestLane } from '../../lib/execution-plan';
import { recordFusedAuthorityCall, startFusedExecutionLifecycle } from '../../lib/execution-lifecycle';
import { evaluateValidatorBinding } from '../../lib/validator-runner';
import { resolveProfileValidatorBinding } from '../../lib/profile-validator-binding';
import { commitSectionBatch, prepareSectionBatch, type PreparedSectionBatch } from '../../lib/section-delivery';
import { resolveTrustedWorkProfile } from '../../lib/trusted-base';
import { resolveRuntimeStateRoot } from '../../lib/canonical-state-root';
import { FINISH_LINES, LANES, type FinishLine, type Lane } from '../../lib/work-profile';
import { resolveProjectIdentity } from '../../lib/project-identity';
import { findActiveMilestoneBlockForParticipant, withActiveMilestoneOwner } from '../../lib/milestone-block';
import { claimCanaryFocusedRun } from '../../lib/lane-canary';
import { localCanaryHostFingerprint } from '../../lib/lane-canary-runner';

function fail(error: unknown): never { process.stderr.write(JSON.stringify({ result: null, error: { code: error instanceof Error ? error.message : 'execution_plan_failed' } }) + '\n'); process.exit(2); }
function runtimeRoot(): string { return path.resolve(import.meta.dir, '..', '..'); }
function bundleBytes(root: string): number {
  try { const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'authority', 'manifest.json'), 'utf8')); return Object.values(manifest.commands as Record<string, any>).reduce((sum, item) => sum + Number(item.size ?? 0), 0); } catch { return 0; }
}
function git(args: string[]): string { const child=spawnSync('/usr/bin/git',args,{cwd:process.cwd(),encoding:'utf8',shell:false,env:{PATH:'/usr/bin:/bin',HOME:os.homedir(),LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1'}});if(child.status!==0)throw new Error('canary_subject_invalid');return child.stdout.trim(); }
function sessionKind(): 'spawned' | 'headless' | 'interactive' {
  if (process.env.OPENCLAW_SESSION) return 'spawned';
  if (process.env.GSTACK_HEADLESS) return 'headless';
  if (process.env.CONDUCTOR_WORKSPACE_PATH || process.env.CONDUCTOR_PORT ||
      process.env.CLAUDE_CODE_ENTRYPOINT === 'cli') return 'interactive';
  if (process.env.CI || process.env.GITHUB_ACTIONS) return 'headless';
  return 'interactive';
}

try {
  const startedAt = performance.now();
  const args = process.argv.slice(2);
  if (args.shift() !== 'resolve') throw new Error('execution_plan_command_invalid');
  const values = new Map<string, string>(); let json = false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === '--json') { if (json) throw new Error('execution_plan_arguments_invalid'); json = true; continue; }
    const value = args.shift();
    if (!flag.startsWith('--') || !value || value.startsWith('--') || values.has(flag)) throw new Error('execution_plan_arguments_invalid');
    values.set(flag, value);
  }
  const allowed = new Set(['--skill', '--work-kind', '--finish-line', '--lane', '--assert-target-ref', '--assert-target-sha']);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error('execution_plan_arguments_invalid');
  if (!json) throw new Error('execution_plan_json_required');
  if (values.has('--assert-target-ref') && values.has('--assert-target-sha')) throw new Error('execution_plan_arguments_invalid');
  const requested = values.get('--lane') ?? 'auto';
  let lane: Lane = requested === 'auto' ? 'single_repo_code' : requested as Lane;
  if (!LANES.includes(lane)) throw new Error('lane_invalid');
  const finishLine = values.get('--finish-line') as FinishLine;
  if (!FINISH_LINES.includes(finishLine)) throw new Error('finish_line_invalid');
  const skill = values.get('--skill') ?? '';
  const workKind = values.get('--work-kind') ?? '';
  let resolved = resolveTrustedWorkProfile({ cwd: process.cwd(), lane, assertTargetRef: values.get('--assert-target-ref'), assertTargetSha: values.get('--assert-target-sha') });
  const legacyProfile = { semantic_paths: [{ glob: '**', roles: ['runtime'] }], prose_only_surfaces: [] } as any;
  let manifest = buildChangeManifest({ cwd: process.cwd(), profile: resolved.effective ?? legacyProfile, targetBaseRef: resolved.trusted_base.target_ref ?? undefined, targetBaseSha: resolved.trusted_base.target_sha, mergeBaseSha: resolved.trusted_base.merge_base_sha });
  if (requested === 'auto' && resolved.effective) {
    lane = resolveManifestLane(resolved.effective,manifest);
    if (lane !== resolved.lane) {
      resolved = resolveTrustedWorkProfile({ cwd: process.cwd(), lane, assertTargetRef: values.get('--assert-target-ref'), assertTargetSha: values.get('--assert-target-sha') });
      manifest = buildChangeManifest({ cwd: process.cwd(), profile: resolved.effective ?? legacyProfile, targetBaseRef: resolved.trusted_base.target_ref ?? undefined, targetBaseSha: resolved.trusted_base.target_sha, mergeBaseSha: resolved.trusted_base.merge_base_sha });
      if(resolveManifestLane(resolved.effective!,manifest)!==lane)throw new Error('execution_plan_lane_unstable');
    }
  }
  const stateHome = resolveRuntimeStateRoot().root;
  let canaryFocus: ReturnType<typeof claimCanaryFocusedRun> | null = null;
  let canaryLifecycle: ReturnType<typeof startFusedExecutionLifecycle> | null = null;
  if (resolved.lane_activation === 'enforce' && resolved.execution === 'legacy' && resolved.profile_hash && resolved.effective && resolved.warnings.includes('canary_pending')) {
    const identity = resolveProjectIdentity(process.cwd(), { mode: 'profile' });
    if (identity.repo_id === 'portfolioops') {
      const block = findActiveMilestoneBlockForParticipant({ stateRoot: stateHome, participant: 'portfolioops', lane });
      if (block) {
        const head = git(['rev-parse', 'HEAD^{commit}']); const tree = git(['rev-parse', 'HEAD^{tree}']);
        await withActiveMilestoneOwner({ stateRoot: stateHome, blockId: block.block_id, participant: 'portfolioops', lane, policyHash: block.policy_hash }, async () => {
          canaryFocus = claimCanaryFocusedRun({ stateRoot: stateHome, repoId: identity.repo_id, lane, profileHash: resolved.effective!.semantic_policy_hash, blockId: block.block_id, participant: 'portfolioops', subjectHead: head, subjectTree: tree, hostFingerprint: localCanaryHostFingerprint(), policyHash: block.policy_hash });
          if (canaryFocus.execution === 'profile_canary') {
            resolved = { ...resolved, execution: 'profile', warnings: resolved.warnings.filter((warning) => warning !== 'canary_pending') };
            canaryLifecycle = startFusedExecutionLifecycle({ runtimeRoot: runtimeRoot(), repositoryRoot: process.cwd(), skill, workKind, finishLine, identityMode: 'profile', runId: canaryFocus.focused_run_id! });
          }
        });
      }
    }
  }
  const preliminary = resolveExecutionPlan({ skill, workKind, finishLine, lane, resolvedProfile: resolved, manifest, canaryFocus });
  const currentEvidence = preliminary.evidence_requirements.map((requirement: any) => {
    if (resolved.execution !== 'profile') return { validator_id: requirement.validator_id, current: false, reasons: ['execution_legacy'], primary_reason: 'execution_legacy' };
    const binding = resolveProfileValidatorBinding({ cwd: process.cwd(), lane, validatorId: requirement.validator_id, assertTargetRef: values.get('--assert-target-ref'), assertTargetSha: values.get('--assert-target-sha'), stateHome, resolvedProfile: resolved });
    return { validator_id: requirement.validator_id, ...evaluateValidatorBinding(binding.binding) };
  });
  const lifecycle = canaryLifecycle ?? startFusedExecutionLifecycle({ runtimeRoot: runtimeRoot(), repositoryRoot: process.cwd(), skill, workKind, finishLine, identityMode: resolved.execution === 'profile' ? 'profile' : 'legacy', ...(canaryFocus?.focused_run_id ? { runId: canaryFocus.focused_run_id } : {}) });
  const prepared: PreparedSectionBatch[] = preliminary.initial_sections.map((stage: string) => prepareSectionBatch({ runtimeRoot: runtimeRoot(), stateRoot: lifecycle.state_root, repositoryRoot: process.cwd(), skill, stage, runId: lifecycle.run_id }));
  const publicLifecycle = { run_id: lifecycle.run_id, tel_start: lifecycle.tel_start, branch: lifecycle.branch, slug: lifecycle.slug, status: { session_kind: sessionKind(), proactive: false, activated: true, first_loop_shown: true, telemetry: 'off', model_overlay: 'none', checkpoint_mode: 'explicit', checkpoint_push: false, plan_mode: 'inactive', artifacts_sync: 'off' } };
  const result = resolveExecutionPlan({ skill, workKind, finishLine, lane, resolvedProfile: resolved, manifest, currentEvidence, initialSectionBatches: prepared.map((item) => item.output), lifecycle: publicLifecycle, canaryFocus });
  fs.writeSync(1, JSON.stringify(result) + '\n');
  for (const batch of prepared) commitSectionBatch(batch, { fused: true });
  recordFusedAuthorityCall({ lifecycle, skill, workKind, finishLine, startedAt, bundleHashBytes: bundleBytes(runtimeRoot()) });
} catch (error) { fail(error); }
