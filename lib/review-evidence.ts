import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIFF_REVIEWS = new Set(['review', 'adversarial-review', 'codex-review', 'design-review-lite', 'ship']);

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function relativeSourcePath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 &&
    !/^[A-Za-z]:|[\\\x00-\x1f\x7f]/.test(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== '.git');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Structural identity only; the reviewer must establish authored-source provenance. */
export function sharedLibsFingerprint(input: unknown): string | undefined {
  if (!record(input) || !Array.isArray(input.evidence_paths) || input.evidence_paths.length === 0 ||
      !Array.from(input.evidence_paths).every(relativeSourcePath) || !record(input.helper_target)) return;
  const target = input.helper_target;
  if (!relativeSourcePath(target.path) || typeof target.symbol !== 'string' ||
      target.symbol.trim().length === 0 || /[\x00-\x1f\x7f]/.test(target.symbol)) return;
  // Default Array.sort compares UTF-16 code units; localeCompare would change the identity by locale.
  const paths = [...new Set(input.evidence_paths)].sort();
  return `shared-libs:${sha256(JSON.stringify(['shared-libs', 1, paths, target.path, target.symbol]))}`;
}

/**
 * Both prior snapshot_covered_paths and current covered_paths must be verified
 * ordinary source files whose raw bytes equal their blobs in the bound snapshot.
 * Exclude symlinks, submodules, ignored/outside files, index flags/sparse paths,
 * and Git filter/encoding transformations. This pure check does not inspect a repo.
 */
export function canReuseSharedLibsAdvisory(
  priorFinding: unknown, currentFinding: unknown, priorReview: unknown, currentSnapshot: unknown,
): boolean {
  if (!record(priorFinding) || !record(currentFinding) || !record(priorReview) || !record(currentSnapshot) ||
      priorFinding.advisory !== true || currentFinding.advisory !== true ||
      priorFinding.severity !== 'INFORMATIONAL' || currentFinding.severity !== 'INFORMATIONAL' ||
      priorFinding.action !== 'skipped') return false;
  const identity = sharedLibsFingerprint(currentFinding);
  if (!identity || sharedLibsFingerprint(priorFinding) !== identity || priorFinding.fingerprint !== identity ||
      (currentFinding.fingerprint !== undefined && currentFinding.fingerprint !== identity)) return false;

  const binding = priorReview.review_binding;
  if (priorReview.skill !== 'review' || priorReview.completed !== true || priorReview.converged !== true ||
      !record(binding) || binding.state !== 'verified' || typeof currentSnapshot.wtree !== 'string' ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(currentSnapshot.wtree) ||
      priorReview.wtree !== currentSnapshot.wtree || binding.start_wtree !== currentSnapshot.wtree ||
      binding.end_wtree !== currentSnapshot.wtree || typeof currentSnapshot.branch_id !== 'string' ||
      !/^[0-9a-f]{64}$/.test(currentSnapshot.branch_id) || binding.branch_id !== currentSnapshot.branch_id ||
      !Array.isArray(priorFinding.snapshot_covered_paths) ||
      !Array.from(priorFinding.snapshot_covered_paths).every(relativeSourcePath) ||
      !Array.isArray(currentSnapshot.covered_paths) || !Array.from(currentSnapshot.covered_paths).every(relativeSourcePath)) return false;
  const priorCovered = new Set(priorFinding.snapshot_covered_paths);
  const covered = new Set(currentSnapshot.covered_paths);
  return currentFinding.evidence_paths.every((path: string) => priorCovered.has(path) && covered.has(path));
}

export function captureReviewStart(skill: string, env = process.env): string {
  if (!DIFF_REVIEWS.has(skill) || !env.GSTACK_STAMP_WTREE || !env.GSTACK_REVIEW_REPO) {
    throw new Error('cannot capture a diff review without a working-tree fingerprint');
  }
  const dir = join(env.GSTACK_REVIEW_DIR!, '.review-starts');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  writeFileSync(join(dir, `${token}.json`), JSON.stringify({
    skill, repo: env.GSTACK_REVIEW_REPO, branch: env.GSTACK_REVIEW_BRANCH,
    wtree: env.GSTACK_STAMP_WTREE, started_at: new Date().toISOString(),
  }), { mode: 0o600, flag: 'wx' });
  return token;
}

export function bindReview(rec: Record<string, any>, token: string, env = process.env): Record<string, any> {
  for (const key of ['commit_full', 'tree', 'wtree', 'dirty', 'review_binding', 'review_freshness']) delete rec[key];
  if (env.GSTACK_STAMP_COMMIT_FULL) rec.commit_full = env.GSTACK_STAMP_COMMIT_FULL;
  if (env.GSTACK_STAMP_TREE) rec.tree = env.GSTACK_STAMP_TREE;
  if (env.GSTACK_STAMP_DIRTY) rec.dirty = env.GSTACK_STAMP_DIRTY === 'true';
  if (!DIFF_REVIEWS.has(rec.skill)) {
    if (env.GSTACK_STAMP_WTREE) rec.wtree = env.GSTACK_STAMP_WTREE;
    return rec;
  }

  let start;
  if (/^[0-9a-f-]{36}$/.test(token)) {
    const file = join(env.GSTACK_REVIEW_DIR!, '.review-starts', `${token}.json`);
    try {
      const saved = readFileSync(file, 'utf8');
      unlinkSync(file);
      const parsed = JSON.parse(saved);
      if (parsed.skill === rec.skill && parsed.repo === env.GSTACK_REVIEW_REPO &&
          parsed.branch === env.GSTACK_REVIEW_BRANCH && parsed.wtree) start = parsed;
    } catch (error: any) {
      if (error.code !== 'ENOENT') console.error(`gstack-review-log: cannot consume review start: ${error.message}`);
    }
  }
  const end = env.GSTACK_STAMP_WTREE;
  const state = !start || !end ? 'uncaptured'
    : start.wtree !== end ? 'changed'
    : rec.completed !== true || rec.converged !== true ? 'incomplete' : 'verified';
  rec.review_binding = {
    state, start_wtree: start?.wtree, end_wtree: end, started_at: start?.started_at,
    ...(typeof start?.branch === 'string' && start.branch.length > 0 ? { branch_id: sha256(start.branch) } : {}),
  };
  if (state === 'verified') rec.wtree = end;
  return rec;
}

export function reviewFreshness(rec: Record<string, any>, currentWtree: string): { status: string; reason: string } | undefined {
  if (!DIFF_REVIEWS.has(rec.skill)) return;
  if (rec.skill === 'ship') return { status: 'UNVERIFIED', reason: 'ship telemetry is not a review pass' };
  const binding = rec.review_binding;
  if (binding?.state === 'changed') return { status: 'STALE', reason: 'content changed during review' };
  if (binding?.state !== 'verified' || rec.completed !== true || rec.converged !== true ||
      !rec.wtree || binding.start_wtree !== rec.wtree || binding.end_wtree !== rec.wtree) {
    return { status: 'UNVERIFIED', reason: 'missing start capture or incomplete/nonconverged pass' };
  }
  if (!currentWtree || currentWtree === 'unknown' || rec.wtree !== currentWtree) {
    return { status: 'STALE', reason: 'working-tree content differs from reviewed content' };
  }
  if (rec.status !== 'clean' || rec.issues_found > 0 || rec.critical > 0 ||
      (rec.skill === 'codex-review' && rec.findings > (rec.findings_fixed ?? 0))) {
    return { status: 'UNVERIFIED', reason: 'review has unresolved findings or did not finish clean' };
  }
  return { status: 'CURRENT', reason: 'completed clean pass on unchanged content' };
}
