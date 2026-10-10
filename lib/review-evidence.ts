import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveReviewStatus, readJsonl } from './headless-artifacts';
import { resultLine, type ResultCodeName } from './result-codes';

const DIFF_REVIEWS = new Set(['review', 'adversarial-review', 'codex-review', 'design-review-lite', 'ship']);
const SHARED_LIBS_COVERAGE_VERSION = 1;

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

export function sharedLibsSnapshotCoverage(repo: string, wtree: string, paths: unknown, env = process.env): string[] {
  if (!repo || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(wtree) || !Array.isArray(paths) ||
      !Array.from(paths).every(relativeSourcePath)) return [];
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false', ...args], {
      cwd: repo, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1' },
      timeout: 10_000, maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error) throw new Error('Git snapshot inspection failed');
    return result.stdout;
  };
  try {
    const config = new Map(git('config', '--list', '-z').toString().split('\0').filter(Boolean).map(item => {
      const split = item.indexOf('\n');
      return split < 0 ? [item.toLowerCase(), 'true'] as const
        : [item.slice(0, split).toLowerCase(), item.slice(split + 1)] as const;
    }));
    if (config.has('core.autocrlf') && config.get('core.autocrlf')?.toLowerCase() !== 'false') return [];
    if ([...config.keys()].some(key => key === 'extensions.partialclone' || /^remote\..*\.promisor$/.test(key))) return [];
    if (git('cat-file', '-t', wtree).toString().trim() !== 'tree') return [];
  } catch { return []; }

  return [...new Set(paths as string[])].filter(path => {
    let fd: number | undefined;
    try {
      let absolute = repo;
      for (const component of path.split('/')) {
        absolute = join(absolute, component);
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && absolute !== join(repo, path))) return false;
      }
      const before = lstatSync(absolute);
      if (!before.isFile()) return false;
      const ignored = spawnSync('git', ['-c', 'core.fsmonitor=false', 'check-ignore', '--no-index', '-q', '--', path], {
        cwd: repo, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '0' }, timeout: 10_000,
      });
      if (ignored.status !== 1 || ignored.error) return false;
      const tracked = git('ls-files', '-v', '-z', '--', path).toString();
      if (tracked ? tracked !== `H ${path}\0`
        : git('ls-files', '--others', '--exclude-standard', '-z', '--', path).toString() !== `${path}\0`) return false;
      if (tracked) {
        const stage = git('ls-files', '--stage', '--sparse', '-z', '--', path).toString();
        if (!/^(?:100644|100755) [0-9a-f]+ 0\t/.test(stage) || stage.split('\0').filter(Boolean).length !== 1) return false;
      }
      const names = ['filter', 'working-tree-encoding', 'ident', 'text', 'eol', 'crlf'];
      const attrs = git('check-attr', '-z', ...names, '--', path).toString().split('\0');
      if (attrs.length !== names.length * 3 + 1) return false;
      for (let i = 0; i < names.length; i++) {
        if (attrs[i * 3] !== path || attrs[i * 3 + 1] !== names[i] ||
            !['unspecified', 'unset'].includes(attrs[i * 3 + 2])) return false;
      }
      const entry = git('ls-tree', '-z', wtree, '--', path).toString();
      const match = /^(100644|100755) blob ([0-9a-f]+)\t([^\0]+)\0$/.exec(entry);
      if (!match || match[3] !== path) return false;
      if (process.platform !== 'win32' && (Boolean(before.mode & 0o111) !== (match[1] === '100755'))) return false;
      fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if ((['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'] as const).some(key => before[key] !== after[key])) return false;
      return bytes.equals(git('cat-file', 'blob', match[2]));
    } catch { return false; }
    finally { if (fd !== undefined) closeSync(fd); }
  });
}

export function checkSharedLibsReuse(finding: unknown, token: string, env = process.env): Record<string, any> {
  const fingerprint = sharedLibsFingerprint(finding);
  const result: Record<string, any> = { reusable: false, fingerprint };
  if (!fingerprint || !record(finding) || !/^[0-9a-f-]{36}$/.test(token) ||
      !env.GSTACK_REVIEW_REPO || !env.GSTACK_REVIEW_BRANCH || !env.GSTACK_STAMP_WTREE ||
      !env.GSTACK_REVIEW_DIR || !env.GSTACK_REVIEW_LOG) return result;
  try {
    const start = JSON.parse(readFileSync(join(env.GSTACK_REVIEW_DIR, '.review-starts', `${token}.json`), 'utf8'));
    result.review_start = start;
    if (start.skill !== 'review' || start.repo !== env.GSTACK_REVIEW_REPO ||
        start.branch !== env.GSTACK_REVIEW_BRANCH || start.wtree !== env.GSTACK_STAMP_WTREE) return result;
    const snapshot = {
      wtree: start.wtree, branch_id: sha256(start.branch),
      covered_paths: sharedLibsSnapshotCoverage(start.repo, start.wtree, finding.evidence_paths, env),
    };
    result.snapshot = snapshot;
    const rows = readFileSync(env.GSTACK_REVIEW_LOG, 'utf8').split('\n').filter(Boolean);
    for (const row of rows.reverse()) {
      let prior;
      try { prior = JSON.parse(row); } catch { continue; }
      if (!record(prior) || prior.shared_libs_coverage_version !== SHARED_LIBS_COVERAGE_VERSION ||
          !Array.isArray(prior.findings)) continue;
      if (prior.findings.some(value => canReuseSharedLibsAdvisory(value, finding, prior, snapshot))) {
        result.reusable = true;
        return result;
      }
    }
  } catch { return result; }
  return result;
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

/** A rejected row: `code` is the result code the wrapper prints; nothing was written. */
export class ReviewLogError extends Error {
  constructor(public code: ResultCodeName, message: string) { super(message); }
}

const DERIVED_KEYS = ['status', 'unresolved', 'issues_found', 'critical_gaps'] as const;

/**
 * B7: derive status/unresolved/issues_found/critical_gaps from a findings file
 * (lib/headless-artifacts.ts `findings` rows or review findings with
 * severity + disposition/action). A claimed value that disagrees rejects the
 * row with REVIEW_STATUS_MISMATCH; the file is the record, never the claim.
 */
export function deriveFromFindings(rec: Record<string, any>, findingsPath: string): Record<string, any> {
  let read;
  try { read = readJsonl(findingsPath); }
  catch (e: any) { throw new ReviewLogError('ARTIFACT_MISSING', resultLine('review-log', 'ARTIFACT_MISSING', `${findingsPath}: ${e.message}`)); }
  if (read.errors.length) throw new ReviewLogError('ARTIFACT_MALFORMED_JSONL', resultLine('review-log', 'ARTIFACT_MALFORMED_JSONL', `${read.errors[0]!.path}: ${read.errors[0]!.message}`));
  const derived = deriveReviewStatus(read.rows);
  const mismatches = DERIVED_KEYS.filter(key => rec[key] !== undefined && rec[key] !== derived[key])
    .map(key => `claimed ${key} ${JSON.stringify(rec[key])}, findings file has ${JSON.stringify(derived[key])}`);
  if (mismatches.length) {
    throw new ReviewLogError('REVIEW_STATUS_MISMATCH', `review-log: status mismatch: ${mismatches.join('; ')} (${derived.findings_open} open of ${derived.findings_total}) (REVIEW_STATUS_MISMATCH)`);
  }
  return { ...rec, ...derived, status_source: 'derived', findings_file: findingsPath };
}

export function bindReview(rec: Record<string, any>, token: string, env = process.env, findingsPath?: string): Record<string, any> {
  for (const key of ['commit_full', 'tree', 'wtree', 'dirty', 'review_binding', 'review_freshness', 'shared_libs_coverage_version', 'status_source', 'findings_total', 'findings_open', 'findings_resolved', 'findings_file']) delete rec[key];
  // The findings file is validated BEFORE the start token is consumed below:
  // a rejected row must leave the token for the retry.
  rec = findingsPath ? deriveFromFindings(rec, findingsPath) : { ...rec, status_source: 'claimed' };
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
  if (rec.skill === 'review' && Array.isArray(rec.findings)) {
    rec.shared_libs_coverage_version = SHARED_LIBS_COVERAGE_VERSION;
    for (const finding of rec.findings) {
      if (!record(finding)) continue;
      delete finding.snapshot_covered_paths;
      if (finding.advisory !== true || finding.severity !== 'INFORMATIONAL') continue;
      const fingerprint = sharedLibsFingerprint(finding);
      if (!fingerprint) continue;
      finding.fingerprint = fingerprint;
      finding.snapshot_covered_paths = state === 'verified' && finding.action === 'skipped'
        ? sharedLibsSnapshotCoverage(env.GSTACK_REVIEW_REPO!, end!, finding.evidence_paths, env) : [];
    }
  }
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
  // B7: a derived row carries findings_open; a resolved critical finding no
  // longer counts against it. Claimed rows keep the conservative reading of
  // issues_found, and the legacy `critical` and Codex counters stay as they were.
  const open = typeof rec.findings_open === 'number' ? rec.findings_open : rec.issues_found;
  if (rec.status !== 'clean' || open > 0 || rec.critical > 0 ||
      (rec.skill === 'codex-review' && rec.findings > (rec.findings_fixed ?? 0))) {
    return { status: 'UNVERIFIED', reason: 'review has unresolved findings or did not finish clean' };
  }
  return { status: 'CURRENT', reason: 'completed clean pass on unchanged content' };
}
