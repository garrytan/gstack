import * as path from 'node:path';
import { buildChangeManifest } from './change-manifest';
import { ledgerCandidates, readJsonlUnion, resolveProjectIdentity } from './project-identity';
import { resolveTrustedWorkProfile } from './trusted-base';

export const REVIEW_STALE_REASON_PRIORITY = ['missing', 'not_clean', 'subject_changed', 'manifest_changed', 'trusted_base_changed', 'capability_changed'] as const;
export type ReviewStaleReason = typeof REVIEW_STALE_REASON_PRIORITY[number];

type ReviewRow = Record<string, unknown> & {
  run_id?: string; skill?: string; status?: string; capability_id?: string;
  repo_id?: string; branch_ref?: string; wtree?: string; manifest_hash?: string;
  target_ref?: string | null; target_sha?: string; merge_base_sha?: string;
  completed_at?: string; timestamp?: string; ts?: string;
};

export function readReviewUnion(input: { cwd: string; stateHome: string }): { identity: ReturnType<typeof resolveProjectIdentity>; reviews: ReviewRow[] } {
  const identity = resolveProjectIdentity(input.cwd);
  const reviews = readJsonlUnion<ReviewRow>(ledgerCandidates(identity, 'reviews', path.resolve(input.stateHome)))
    .filter((row) => !row.repo_id || row.repo_id === identity.repo_id);
  return { identity, reviews };
}

export function readCurrentReview(input: {
  cwd: string;
  stateHome: string;
  capability: string;
  assertTargetRef?: string;
  assertTargetSha?: string;
}) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.capability)) throw new Error('review_capability_invalid');
  const identity = resolveProjectIdentity(input.cwd, { mode: 'profile' });
  const profile = resolveTrustedWorkProfile({ cwd: input.cwd, lane: 'single_repo_code', assertTargetRef: input.assertTargetRef, assertTargetSha: input.assertTargetSha });
  if (!profile.effective) throw new Error('trusted_profile_required');
  const manifest = buildChangeManifest({ cwd: input.cwd, profile: profile.effective, targetBaseRef: profile.trusted_base.target_ref ?? undefined, targetBaseSha: profile.trusted_base.target_sha, mergeBaseSha: profile.trusted_base.merge_base_sha });
  const rows = readJsonlUnion<ReviewRow>(ledgerCandidates(identity, 'reviews', path.resolve(input.stateHome)))
    .filter((row) => !row.repo_id || row.repo_id === identity.repo_id)
    .filter((row) => (row.capability_id ?? (row.skill === 'review' ? 'review.code' : undefined)) === input.capability)
    .sort((a, b) => String(a.completed_at ?? a.timestamp ?? a.ts ?? '').localeCompare(String(b.completed_at ?? b.timestamp ?? b.ts ?? '')));
  const row = rows.at(-1);
  const found = new Set<ReviewStaleReason>();
  if (!row) found.add('missing');
  else {
    if (row.status !== 'clean' && row.status !== 'pass') found.add('not_clean');
    if (row.repo_id !== identity.repo_id || row.branch_ref !== identity.raw_branch || row.wtree !== manifest.wtree) found.add('subject_changed');
    if (row.manifest_hash !== manifest.manifest_hash) found.add('manifest_changed');
    if (row.target_sha !== profile.trusted_base.target_sha || row.merge_base_sha !== profile.trusted_base.merge_base_sha || row.target_ref !== profile.trusted_base.target_ref) found.add('trusted_base_changed');
    if ((row.capability_id ?? (row.skill === 'review' ? 'review.code' : undefined)) !== input.capability) found.add('capability_changed');
  }
  const reasons = REVIEW_STALE_REASON_PRIORITY.filter((reason) => found.has(reason));
  return {
    schema: 'ecpe.review-current.v1' as const,
    capability: input.capability,
    current: reasons.length === 0,
    reasons,
    primary_reason: reasons[0] ?? null,
    ...(reasons.length === 0 && row ? { review: row } : {}),
  };
}
