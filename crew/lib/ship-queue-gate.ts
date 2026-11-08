/**
 * ship-queue-gate — gate-ahead attempts for bin/gstack-ship-queue (field list
 * 2, W1), over gstack-restamp's --after primitive (lib/restamp.ts).
 *
 * Each preparation is an attempt with an immutable id and its own worktree
 * under .gstack/tmp/ship-queue/gate-ahead/<pr>/<attempt>/, so concurrent
 * preparations never share or delete each other's trees. The record binds
 * the predecessor and branch heads, the merge tree (recomputed with
 * `git merge-tree --write-tree` and refused unless it equals the worktree's
 * merge), the gated head and tree, the stamp patch between them and the gate
 * command. `--record` binds a gate result to that attempt only after its
 * worktree still holds the gated commit, retains the log beside the record,
 * then removes the attempt's own worktree. The current attempt for a PR is the
 * newest preparation; recording an older one never replaces it. The
 * coordinator's verify reproduces merge tree and gated tree from the record
 * alone (recomputeMergeTree, applyStampPatch), so the gated commit never has
 * to leave the lane's machine.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeChangelogs } from '../../lib/changelog-check';
import { ensureTmpExcluded, restamp, versionFiles } from '../../lib/restamp';
import type { ResultCodeName } from '../../lib/result-codes';
import type { ShipPolicy } from '../../lib/ship-policy';

export const QUEUE_DIR_REL = '.gstack/tmp/ship-queue';
export const GATE_AHEAD_DIR_REL = `${QUEUE_DIR_REL}/gate-ahead`;

export interface GateResult { exit: number; log: string; log_sha256: string; recorded_at: string }
export interface AttemptRecord {
  schema_version: 1; kind: 'gate-ahead'; attempt: string; pr: string; predecessor_pr: string; predecessor_head: string; branch_head: string;
  merge_tree: string; gated_head: string; gated_tree: string; version: string; base: { ref: string; sha: string }; policy: string;
  gate_command: string | null; command_sha256: string | null; worktree: string; prepared_at: string; stamp_patch: string;
  state: 'prepared' | 'recorded'; result?: GateResult;
}
export interface QueueFailure { code: ResultCodeName; message: string; fix?: string }

export function sha256(buf: Buffer | string): string { return createHash('sha256').update(buf).digest('hex'); }

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string | Buffer): { ok: boolean; out: string; err: string; status: number | null } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, env: env ?? process.env, input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim(), status: r.status };
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function prDir(repoRoot: string, pr: string): string { return path.join(repoRoot, GATE_AHEAD_DIR_REL, pr); }
export function attemptFile(repoRoot: string, pr: string, attempt: string): string { return path.join(prDir(repoRoot, pr), `${attempt}.json`); }

export function readAttempt(file: string): AttemptRecord | null {
  try { const r = JSON.parse(fs.readFileSync(file, 'utf8')); return r?.kind === 'gate-ahead' && r.schema_version === 1 ? r : null; } catch { return null; }
}

/** Every attempt recorded for a PR, oldest preparation first. */
export function listAttempts(repoRoot: string, pr: string): AttemptRecord[] {
  const dir = prDir(repoRoot, pr);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readAttempt(path.join(dir, f))).filter((r): r is AttemptRecord => !!r)
    .sort((a, b) => a.prepared_at.localeCompare(b.prepared_at) || a.attempt.localeCompare(b.attempt));
}

export function currentAttempt(repoRoot: string, pr: string): AttemptRecord | null {
  return listAttempts(repoRoot, pr).at(-1) ?? null;
}

/**
 * The gate-ahead merge as `git merge --no-ff` of the branch and the
 * predecessor would leave it after restamp's conflict rules: version files
 * take the predecessor's side, the CHANGELOG merges through mergeChangelogs,
 * any other conflict is unresolvable. Computed in object storage only.
 */
export function recomputeMergeTree(repoRoot: string, branchHead: string, predecessorHead: string, policy: ShipPolicy, versionRel: string): { tree: string } | { error: string } {
  const r = git(repoRoot, ['merge-tree', '--write-tree', branchHead, predecessorHead]);
  const lines = r.out.split('\n');
  const tree = lines[0]?.trim() ?? '';
  if (r.status === 0 && /^[0-9a-f]{40,64}$/.test(tree)) return { tree };
  if (r.status !== 1 || !/^[0-9a-f]{40,64}$/.test(tree)) return { error: `git merge-tree failed: ${r.err || r.out.slice(0, 200)}` };
  const stages = new Map<string, Map<number, string>>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) break;
    const m = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/.exec(line);
    if (!m) continue;
    const entry = stages.get(m[4]!) ?? new Map<number, string>();
    entry.set(Number(m[3]), m[2]!);
    stages.set(m[4]!, entry);
  }
  const stampFiles = versionFiles(repoRoot, versionRel);
  const resolved: Array<{ path: string; blob: string }> = [];
  for (const [file, entry] of stages) {
    const ours = entry.get(2);
    const theirs = entry.get(3);
    if (!ours || !theirs) return { error: `${file} conflicts beyond a content merge (added or deleted on one side)` };
    if (file === policy.changelog) {
      const text = (sha: string) => git(repoRoot, ['cat-file', 'blob', sha]).out + '\n';
      const base = entry.get(1);
      const merged = mergeChangelogs(text(ours), text(theirs), base ? text(base) : undefined);
      if (merged === null) return { error: `${file} conflicts beyond a heading move` };
      const blob = git(repoRoot, ['hash-object', '-w', '--stdin'], undefined, merged);
      if (!blob.ok) return { error: `cannot write the merged ${file}: ${blob.err}` };
      resolved.push({ path: file, blob: blob.out });
    } else if (stampFiles.includes(file)) resolved.push({ path: file, blob: theirs });
    else return { error: `${file} conflicts outside the version files and the CHANGELOG` };
  }
  return withIndex(repoRoot, tree, index => {
    for (const { path: p, blob } of resolved) {
      const mode = git(repoRoot, ['ls-tree', tree, '--', p], index).out.split(/\s/)[0] || '100644';
      const u = git(repoRoot, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${p}`], index);
      if (!u.ok) return { error: `cannot stage the resolved ${p}: ${u.err}` };
    }
    const w = git(repoRoot, ['write-tree'], index);
    return w.ok ? { tree: w.out } : { error: `write-tree failed: ${w.err}` };
  });
}

/** The gated tree from a merge tree and the recorded stamp patch, in a throwaway index. */
export function applyStampPatch(repoRoot: string, mergeTree: string, patch: string): { tree: string } | { error: string } {
  if (!patch.trim()) return { tree: mergeTree };
  return withIndex(repoRoot, mergeTree, index => {
    const a = git(repoRoot, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], index, patch);
    if (!a.ok) return { error: `the recorded stamp patch does not apply to the recomputed merge: ${a.err.slice(0, 200)}` };
    const w = git(repoRoot, ['write-tree'], index);
    return w.ok ? { tree: w.out } : { error: `write-tree failed: ${w.err}` };
  });
}

export function withIndex<T>(repoRoot: string, tree: string, fn: (env: NodeJS.ProcessEnv) => T): T | { error: string } {
  const gitDir = git(repoRoot, ['rev-parse', '--absolute-git-dir']).out;
  const indexFile = path.join(gitDir, `gstack-ship-queue-${process.pid}-${randomBytes(4).toString('hex')}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    const rt = git(repoRoot, ['read-tree', tree], env);
    if (!rt.ok) return { error: `read-tree ${tree} failed: ${rt.err}` };
    return fn(env);
  } finally { fs.rmSync(indexFile, { force: true }); }
}

/** A commit object for a bare tree (fixed identity and date), so tree-receipt can compare it. */
export function commitForTree(repoRoot: string, tree: string, message: string): string | null {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'gstack-ship-queue', GIT_AUTHOR_EMAIL: 'ship-queue@gstack.local', GIT_COMMITTER_NAME: 'gstack-ship-queue',
    GIT_COMMITTER_EMAIL: 'ship-queue@gstack.local', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  const c = git(repoRoot, ['commit-tree', tree, '-m', message], env);
  return c.ok ? c.out : null;
}

export interface PrepareOptions {
  repoRoot: string; base: string; pr: string; after: string; predecessorRef?: string; allowRepoCommands: boolean;
  policy: ShipPolicy; versionRel: string; now?: Date;
}

/** Prepare one attempt: restamp --after into the attempt's own worktree, then bind and verify its record. */
export function prepareGateAhead(o: PrepareOptions): { record: AttemptRecord; file: string } | QueueFailure {
  const now = o.now ?? new Date();
  const attempt = `${now.toISOString().replace(/[-:.]/g, '')}-${randomBytes(3).toString('hex')}`;
  const dir = path.join(prDir(o.repoRoot, o.pr), attempt);
  const worktree = path.join(dir, 'worktree');
  ensureTmpExcluded(o.repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const r = restamp({
    repoRoot: o.repoRoot, base: o.base, after: { pr: o.after, ref: o.predecessorRef }, pr: o.pr, policyFrom: 'base',
    allowRepoCommands: o.allowRepoCommands, dryRun: false, gateWorktree: worktree, now,
  });
  if (r.status !== 'gate-ahead' || !r.gateAhead) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: r.code ?? 'RESTAMP_CONFLICT', message: `${r.message ?? `gstack-restamp --after returned ${r.status}`}`, fix: r.fix };
  }
  const ga = r.gateAhead;
  const drop = (code: ResultCodeName, message: string): QueueFailure => {
    git(o.repoRoot, ['worktree', 'remove', '--force', worktree]);
    fs.rmSync(dir, { recursive: true, force: true });
    git(o.repoRoot, ['worktree', 'prune']);
    return { code, message };
  };
  const mergeTree = git(o.repoRoot, ['rev-parse', `${ga.gated_head}^^{tree}`]).out;
  const recomputed = recomputeMergeTree(o.repoRoot, ga.branch_head, ga.predecessor_head, o.policy, o.versionRel);
  if ('error' in recomputed) return drop('QUEUE_PROOF_MISSING', `the gate-ahead merge cannot be recomputed with git merge-tree (${recomputed.error}); nothing recorded`);
  if (recomputed.tree !== mergeTree) return drop('QUEUE_PROOF_MISSING', `git merge-tree gives ${recomputed.tree.slice(0, 12)} but the gate-ahead merge is ${mergeTree.slice(0, 12)}; a coordinator could not reproduce it, so nothing is recorded`);
  const patch = git(o.repoRoot, ['diff', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-renames', mergeTree, ga.gated_tree]).out;
  const replay = applyStampPatch(o.repoRoot, mergeTree, patch ? patch + '\n' : '');
  if ('error' in replay || replay.tree !== ga.gated_tree) return drop('QUEUE_PROOF_MISSING', `the stamp patch does not reproduce the gated tree ${ga.gated_tree.slice(0, 12)}; nothing recorded`);
  const record: AttemptRecord = {
    schema_version: 1, kind: 'gate-ahead', attempt, pr: o.pr, predecessor_pr: ga.predecessor_pr, predecessor_head: ga.predecessor_head,
    branch_head: ga.branch_head, merge_tree: mergeTree, gated_head: ga.gated_head, gated_tree: ga.gated_tree, version: ga.version,
    base: { ref: r.base?.ref ?? `origin/${o.base}`, sha: r.base?.sha ?? '' }, policy: r.policy ?? '', gate_command: o.policy.gate_command,
    command_sha256: o.policy.gate_command ? sha256(o.policy.gate_command) : null, worktree, prepared_at: now.toISOString(),
    stamp_patch: patch ? patch + '\n' : '', state: 'prepared',
  };
  const file = attemptFile(o.repoRoot, o.pr, attempt);
  writeJsonAtomic(file, record);
  return { record, file };
}

export interface RecordOptions { repoRoot: string; pr: string; attempt: string; exit: number; log: string; now?: Date }

/**
 * Bind a gate result to one attempt: its worktree must still hold the gated
 * commit with no tracked edit; the log is copied beside the record before the
 * attempt's own worktree is removed. An identical retry returns the stored
 * result; a different result for a recorded attempt is refused.
 */
export function recordGateAhead(o: RecordOptions): { record: AttemptRecord; file: string; current: AttemptRecord | null; repeated: boolean } | QueueFailure {
  const file = attemptFile(o.repoRoot, o.pr, o.attempt);
  const rec = readAttempt(file);
  if (!rec || rec.pr !== o.pr || rec.attempt !== o.attempt) return { code: 'GATE_AHEAD_ATTEMPT_INVALID', message: `no gate-ahead attempt ${o.attempt} for #${o.pr}` };
  if (!fs.existsSync(o.log)) return { code: 'GATE_AHEAD_ATTEMPT_INVALID', message: `log ${o.log} does not exist` };
  const logSha = sha256(fs.readFileSync(o.log));
  const current = currentAttempt(o.repoRoot, o.pr);
  if (rec.state === 'recorded') {
    if (rec.result?.exit === o.exit && rec.result.log_sha256 === logSha) return { record: rec, file, current, repeated: true };
    return { code: 'GATE_AHEAD_ATTEMPT_INVALID', message: `attempt ${o.attempt} already recorded exit ${rec.result?.exit} (log ${rec.result?.log_sha256.slice(0, 12)}); a different result is refused` };
  }
  if (!fs.existsSync(rec.worktree)) return { code: 'GATE_AHEAD_ATTEMPT_INVALID', message: `attempt ${o.attempt}'s worktree ${rec.worktree} is gone` };
  const head = git(rec.worktree, ['rev-parse', 'HEAD']).out;
  const dirty = git(rec.worktree, ['status', '--porcelain', '--untracked-files=no']).out;
  if (head !== rec.gated_head || dirty) {
    return { code: 'GATE_AHEAD_ATTEMPT_INVALID', message: `attempt ${o.attempt}'s worktree no longer holds the gated commit ${rec.gated_head.slice(0, 12)} (HEAD ${head.slice(0, 12)}${dirty ? ', tracked edits' : ''}); the gate result is not bound to the gated tree` };
  }
  const kept = path.join(prDir(o.repoRoot, o.pr), `${o.attempt}.log`);
  fs.copyFileSync(o.log, kept);
  rec.result = { exit: o.exit, log: path.relative(o.repoRoot, kept), log_sha256: logSha, recorded_at: (o.now ?? new Date()).toISOString() };
  rec.state = 'recorded';
  writeJsonAtomic(file, rec);
  git(o.repoRoot, ['worktree', 'remove', '--force', rec.worktree]);
  fs.rmSync(path.dirname(rec.worktree), { recursive: true, force: true });
  git(o.repoRoot, ['worktree', 'prune']);
  return { record: rec, file, current, repeated: false };
}
