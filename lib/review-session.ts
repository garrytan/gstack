import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildChangeManifest } from './change-manifest';
import { appendJsonl } from './jsonl-store';
import { resolveProjectIdentity } from './project-identity';
import { resolveTrustedWorkProfile } from './trusted-base';

interface ReviewInflight { schema: 'ecpe.review-inflight.v1'; run_id: string; skill: string; repo_id: string; branch_ref: string; wtree: string; tree: string; head: string; manifest_hash: string; trusted_base_source: string; target_ref: string | null; target_sha: string; merge_base_sha: string; started_at: string }
function git(cwd: string, args: string[]): string { const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C' } }); if (result.status !== 0) throw new Error('review_git_failure'); return result.stdout.trim(); }
function wtree(cwd: string): string { const result = spawnSync(path.join(import.meta.dir, '..', 'bin/gstack-wtree'), [], { cwd, encoding: 'utf8', timeout: 30_000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C' } }); if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout.trim())) throw new Error('review_wtree_unavailable'); return result.stdout.trim(); }
function locations(stateRoot: string, cwd: string) { const identity = resolveProjectIdentity(cwd, { mode: 'profile' }); const dir = path.join(path.resolve(stateRoot), 'projects', identity.write_slug); return { identity, dir, inflight: path.join(dir, 'review-inflight'), ledger: path.join(dir, `${identity.write_branch}-reviews.jsonl`) }; }
function atomic(target: string, value: unknown) { fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); const temporary = `${target}.${process.pid}.tmp`; const fd = fs.openSync(temporary, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temporary, target); }
function snapshot(cwd: string, lane: 'single_repo_code' = 'single_repo_code', assertions: { assertTargetRef?: string; assertTargetSha?: string } = {}) {
  const profile = resolveTrustedWorkProfile({ cwd, lane, ...assertions }); if (!profile.effective) throw new Error('trusted_profile_required');
  const manifest = buildChangeManifest({ cwd, profile: profile.effective, targetBaseRef: profile.trusted_base.target_ref ?? undefined, targetBaseSha: profile.trusted_base.target_sha, mergeBaseSha: profile.trusted_base.merge_base_sha });
  return { profile, manifest, head: git(cwd, ['rev-parse', 'HEAD']), tree: git(cwd, ['rev-parse', 'HEAD^{tree}']), wtree: wtree(cwd) };
}
export function beginReview(input: { cwd: string; stateRoot: string; skill: string; assertTargetRef?: string; assertTargetSha?: string; onFetch?: () => void }) {
  if (input.skill !== 'review') throw new Error('review_skill_invalid'); const place = locations(input.stateRoot, input.cwd); const snap = snapshot(input.cwd, 'single_repo_code', { assertTargetRef: input.assertTargetRef, assertTargetSha: input.assertTargetSha });
  const runId = `review-${new Bun.CryptoHasher('sha256').update(JSON.stringify([place.identity.repo_id, snap.wtree, snap.manifest.manifest_hash, crypto.randomUUID()])).digest('hex').slice(0, 24)}`;
  const record: ReviewInflight = { schema: 'ecpe.review-inflight.v1', run_id: runId, skill: input.skill, repo_id: place.identity.repo_id, branch_ref: place.identity.raw_branch, wtree: snap.wtree, tree: snap.tree, head: snap.head, manifest_hash: snap.manifest.manifest_hash, trusted_base_source: snap.profile.trusted_base.source, target_ref: snap.profile.trusted_base.target_ref, target_sha: snap.profile.trusted_base.target_sha, merge_base_sha: snap.profile.trusted_base.merge_base_sha, started_at: new Date().toISOString() };
  atomic(path.join(place.inflight, `${runId}.json`), record); return record;
}
export function finishReview(input: { cwd: string; stateRoot: string; runId: string; payload: Record<string, unknown> }): Record<string, unknown> {
  if (!/^review-[0-9a-f]{24}$/.test(input.runId)) throw new Error('review_run_id_invalid'); const place = locations(input.stateRoot, input.cwd); const file = path.join(place.inflight, `${input.runId}.json`); let prior: ReviewInflight; try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('review_inflight_missing'); }
  if (prior.schema !== 'ecpe.review-inflight.v1' || prior.repo_id !== place.identity.repo_id) throw new Error('review_inflight_invalid'); const current = snapshot(input.cwd);
  const stale = [...new Set([prior.wtree !== current.wtree || prior.tree !== current.tree || prior.head !== current.head ? 'subject_changed' : '', prior.manifest_hash !== current.manifest.manifest_hash ? 'manifest_changed' : '', prior.target_sha !== current.profile.trusted_base.target_sha || prior.merge_base_sha !== current.profile.trusted_base.merge_base_sha ? 'trusted_base_changed' : ''].filter(Boolean))];
  const protectedKeys = new Set(['run_id', 'repo_id', 'branch_ref', 'commit_full', 'head', 'tree', 'wtree', 'dirty', 'manifest_hash', 'target_ref', 'target_sha', 'merge_base_sha', 'trusted_base_source', 'started_at', 'completed_at', 'stale_reasons']); const payload = Object.fromEntries(Object.entries(input.payload).filter(([key]) => !protectedKeys.has(key)));
  const row = { ...payload, run_id: prior.run_id, repo_id: prior.repo_id, branch_ref: prior.branch_ref, commit_full: current.head, tree: current.tree, wtree: current.wtree, dirty: current.tree !== current.wtree, manifest_hash: current.manifest.manifest_hash, trusted_base_source: current.profile.trusted_base.source, target_ref: current.profile.trusted_base.target_ref, target_sha: current.profile.trusted_base.target_sha, merge_base_sha: current.profile.trusted_base.merge_base_sha, started_at: prior.started_at, completed_at: new Date().toISOString(), status: stale.length ? 'stale' : input.payload.status, ...(stale.length ? { stale_reasons: stale } : {}) };
  appendJsonl(place.ledger, row, { mode: 0o600 }); fs.rmSync(file); return row;
}
