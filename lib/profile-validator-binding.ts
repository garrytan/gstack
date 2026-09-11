import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildChangeManifest } from './change-manifest';
import { EVIDENCE_POLICY_VERSION, type EvidenceBuildInput, type EvidenceRecordV2 } from './evidence-envelope';
import { ledgerCandidates, readJsonlUnion, resolveProjectIdentity } from './project-identity';
import { resolveTrustedWorkProfile, type ResolvedWorkProfile } from './trusted-base';
import type { TrustedValidatorBinding } from './validator-runner';
import type { Lane } from './work-profile';
import { inspectCanaryShipCandidate } from './lane-canary';

function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function git(cwd: string, args: string[], optional = false): string | null {
  const result = spawnSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (result.status !== 0) {
    if (optional) return null;
    throw new Error('validator_binding_git_failure');
  }
  return result.stdout.trim();
}

function ttlExpiry(ttl: string | undefined, now: string): string | null {
  if (!ttl) return null;
  const match = ttl.match(/^(\d+)(s|m|h|d)$/);
  if (!match) throw new Error('validator_ttl_invalid');
  const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[match[2]];
  return new Date(Date.parse(now) + seconds * 1000).toISOString();
}

export interface ValidatorSubjectOverride {
  cwd: string;
  localHeadSha: string;
  remotePrHeadSha: string | null;
  baseSha: string;
  mergeBaseSha: string;
  branchRef?: string;
}

export interface ResolvedValidatorBinding {
  binding: TrustedValidatorBinding;
  resolvedProfile: ResolvedWorkProfile;
  ledgerFile: string;
  ledgerDirectory: string;
}

export interface CanaryValidatorAssertion {
  blockId: string;
  focusedRunId: string;
  subjectHead: string;
  subjectTree: string;
  policyHash: string;
}

export function resolveProfileValidatorBinding(input: {
  cwd: string;
  lane: Lane;
  validatorId: string;
  assertTargetRef?: string;
  assertTargetSha?: string;
  stateHome: string;
  resolvedProfile?: ResolvedWorkProfile;
  subject?: ValidatorSubjectOverride;
  canary?: CanaryValidatorAssertion;
}): ResolvedValidatorBinding {
  const sourceCwd = fs.realpathSync(path.resolve(input.cwd));
  const resolved = input.resolvedProfile ?? resolveTrustedWorkProfile({
    cwd: sourceCwd,
    lane: input.lane,
    assertTargetRef: input.assertTargetRef,
    assertTargetSha: input.assertTargetSha,
    safetyStateRoot: input.stateHome,
  });
  const authorizedPromotion = resolved.candidate_state === 'authorized_promotion' && resolved.promotion_lineage !== null;
  const identity = resolveProjectIdentity(sourceCwd, { mode: 'profile' });
  let authorizedCanary = false;
  if (resolved.effective && resolved.profile_hash && input.canary && identity.repo_id === 'portfolioops') {
    const inspected = inspectCanaryShipCandidate({
      stateRoot: input.stateHome,
      repoId: identity.repo_id,
      lane: input.lane,
      profileHash: resolved.profile_hash,
      blockId: input.canary.blockId,
      subjectHead: input.canary.subjectHead,
      subjectTree: input.canary.subjectTree,
    });
    authorizedCanary = inspected.focused_run_id === input.canary.focusedRunId
      && inspected.policy_hash === input.canary.policyHash;
  }
  if (!resolved.effective || (resolved.execution !== 'profile' && !authorizedPromotion && !authorizedCanary)) throw new Error('trusted_profile_required');
  const validator = resolved.effective.validators[input.validatorId];
  if (!validator?.argv?.length) throw new Error('validator_unavailable');

  const executionCwd = fs.realpathSync(path.resolve(input.subject?.cwd ?? sourceCwd));
  const head = input.subject?.localHeadSha ?? git(executionCwd, ['rev-parse', 'HEAD^{commit}'])!;
  const tree = git(executionCwd, ['rev-parse', 'HEAD^{tree}'])!;
  const manifest = buildChangeManifest({
    cwd: executionCwd,
    profile: resolved.effective,
    targetBaseRef: input.subject ? undefined : resolved.trusted_base.target_ref ?? undefined,
    targetBaseSha: input.subject?.baseSha ?? resolved.trusted_base.target_sha,
    mergeBaseSha: input.subject?.mergeBaseSha ?? resolved.trusted_base.merge_base_sha,
  });
  const dirty = (git(executionCwd, ['status', '--porcelain=v1', '--untracked-files=all'], true) ?? '') !== '';
  const now = new Date().toISOString();
  const locks: Record<string, string> = Object.create(null);
  for (const relative of validator.lockfiles ?? []) {
    const file = path.join(executionCwd, relative);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('validator_lockfile_invalid');
    locks[relative] = sha256(fs.readFileSync(file));
  }
  const context: Omit<EvidenceBuildInput, 'caller'> = {
    repo_id: identity.repo_id,
    branch_ref: input.subject?.branchRef ?? identity.raw_branch,
    base_sha: input.subject?.baseSha ?? resolved.trusted_base.target_sha,
    merge_base_sha: input.subject?.mergeBaseSha ?? resolved.trusted_base.merge_base_sha,
    local_head_sha: head,
    remote_pr_head_sha: input.subject?.remotePrHeadSha ?? null,
    tree,
    wtree: manifest.wtree,
    dirty,
    capability: { id: validator.capability, version: resolved.effective.capabilities[validator.capability].version },
    validator: { id: input.validatorId, version: resolved.validator_version_hashes[input.validatorId] },
    policy_version: EVIDENCE_POLICY_VERSION,
    profile_hash: resolved.promotion_lineage?.after_profile_hash ?? resolved.profile_hash,
    semantic_policy_hash: resolved.semantic_policy_hashes[input.validatorId],
    lockfile_hashes: locks,
    dependency_fingerprints: {},
    toolchain_fingerprint: validator.argv[0] === 'bun' ? { bun: Bun.version } : {},
    environment_class: validator.environment_class ?? 'local',
    coverage: {
      semantic_roles: validator.depends_on,
      files: manifest.changed.filter((entry) => entry.roles.some((role) => validator.depends_on.includes(role))).map((entry) => entry.path),
    },
    ...(validator.suite_id && validator.evaluator_id && validator.model_id ? { eval_binding: { suite_id: validator.suite_id, evaluator_id: validator.evaluator_id, model_id: validator.model_id } } : {}),
    started_at: now,
    completed_at: now,
    expires_at: ttlExpiry(validator.ttl, now),
  };
  const ledgerDirectory = path.join(input.stateHome, 'projects', identity.write_slug);
  const ledgerFile = path.join(ledgerDirectory, `${identity.write_branch}-evidence.jsonl`);
  const records = readJsonlUnion<EvidenceRecordV2>(ledgerCandidates(identity, 'evidence', input.stateHome))
    .filter((record) => record.schema_version === 'ecpe.receipt.v2' && record.subject?.repo_id === identity.repo_id && record.validator?.id === input.validatorId);
  return {
    binding: {
      validatorId: input.validatorId,
      effect: validator.execution_effect,
      argv: [...validator.argv],
      cwd: executionCwd,
      evidenceContext: context,
      currentRecord: records.at(-1) ?? null,
      paidGrantAssertions: {
        repo_id: identity.repo_id,
        target_ref: resolved.trusted_base.target_ref ?? '',
        target_sha: input.subject?.baseSha ?? resolved.trusted_base.target_sha,
        lane: input.lane,
        validator_id: input.validatorId,
        validator_version: context.validator.version,
        capability_id: context.capability.id,
        capability_version: context.capability.version,
        semantic_policy_hash: context.semantic_policy_hash,
      },
    },
    resolvedProfile: resolved,
    ledgerFile,
    ledgerDirectory,
  };
}
