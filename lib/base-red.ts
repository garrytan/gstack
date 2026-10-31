/**
 * gstack-base-red — /ship Step 5's proof that a failure belongs to the base
 * branch, not to the PR (docs/ship-policy.md#base-red). A failure is base-red
 * only when the base branch's own ship policy declares how to reproduce one
 * (`base_red: { setup, select, timeout_sec }`), every failure Step 5 counted is
 * named, no failing test file or path its signature names is in the PR's diff,
 * and the restricted command fails with the same test id and signature both at
 * the base head and at the PR head, each in a scratch worktree under the state
 * root. Any other outcome is in-branch, so /ship stops exactly as before.
 *
 * A base-red /ship finishes its other steps, writes a pause record here and
 * ends with a conditional receipt; `wait` re-runs the cases on each new base
 * head and returns once they pass there, and `/ship --resume` re-runs Step 5.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ShipReceipt } from './headless-artifacts';
import { type BaseRedPolicy } from './ship-policy';
import { git, sha256, writeJsonAtomic } from './ship-queue-gate';
import { runBashSync } from './script-invocation';
import { resolveStateRoot } from './state-root';

export const PAUSE_HOURS = 24;

export interface FailureCase { id: string; file: string; signature: string }
export interface FailureEvidence { lane: string; total: number; failures: FailureCase[] }
export interface CaseVerdict { id: string; file: string; verdict: 'BASE_RED' | 'IN_BRANCH'; reason: string }
export type ClassifyCode = 'BASE_RED' | 'IN_BRANCH' | 'BASE_RED_UNCONFIGURED' | 'BASE_RED_UNNAMED' | 'BASE_RED_REPRO_ERROR';
export interface ClassifyResult { code: ClassifyCode; base: string; base_sha: string; head: string; lane: string; cases: CaseVerdict[]; detail: string }
export interface RunOutput { status: number | null; out: string; error?: string }
export type Runner = (cwd: string, command: string, timeoutSec: number) => RunOutput;

export interface PauseRecord {
  schema_version: 1; kind: 'base-red-pause'; branch: string; head: string; base: string; base_sha: string; lane: string;
  cases: FailureCase[]; created_at: string; expires_at: string;
}

export const shellRunner: Runner = (cwd, command, timeoutSec) => {
  const r = runBashSync(command, { cwd, encoding: 'utf8', timeout: timeoutSec * 1000, env: { ...process.env, CI: process.env.CI ?? '1' }, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, error: r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : undefined };
};

/** Step 5's failure evidence file: `{ lane, total, failures: [{ id, file, signature }] }`. */
export function parseEvidence(raw: unknown): FailureEvidence | string {
  const e = raw as Record<string, unknown> | null;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'must be { lane, total, failures: [{ id, file, signature }] }';
  if (typeof e.lane !== 'string' || !e.lane) return 'lane must be the Step 5 lane label';
  if (!Number.isInteger(e.total) || (e.total as number) < 1) return 'total must be the failure count the lane reported (an integer >= 1)';
  if (!Array.isArray(e.failures)) return 'failures must be an array';
  for (const [i, f] of e.failures.entries()) {
    const c = f as Record<string, unknown> | null;
    if (!c || typeof c !== 'object') return `failures[${i}] must be { id, file, signature }`;
    for (const k of ['id', 'file', 'signature'] as const) if (typeof c[k] !== 'string' || !(c[k] as string).trim()) return `failures[${i}].${k} must be a non-empty string`;
    if (path.isAbsolute(c.file as string) || (c.file as string).split(/[\\/]/).includes('..')) return `failures[${i}].file must be repo-relative`;
  }
  return e as unknown as FailureEvidence;
}

const normalize = (s: string) => s.replace(/\d+/g, '0').replace(/\s+/g, ' ').trim();
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Whether a restricted run reproduces a case: non-zero exit, the test id and the normalized signature in its output. */
function reproduces(run: RunOutput, c: FailureCase): string | null {
  if (run.status === 0) return 'passes';
  const out = normalize(run.out);
  if (!out.includes(normalize(c.id))) return 'fails without naming this test';
  if (!out.includes(normalize(c.signature).slice(0, 160))) return 'fails with a different signature';
  return null;
}

function scratchRoot(): string {
  return path.join(resolveStateRoot(), 'ship', 'base-red', 'worktrees');
}

/** Check out `sha` in a scratch worktree, run setup then select on `files`, remove the worktree. */
export function runAt(repoRoot: string, sha: string, policy: BaseRedPolicy, files: string[], runner: Runner): RunOutput & { setupFailed?: boolean } {
  fs.mkdirSync(scratchRoot(), { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratchRoot(), `${sha.slice(0, 12)}-`));
  try {
    const add = git(repoRoot, ['worktree', 'add', '--detach', '-q', dir, sha]);
    if (!add.ok) return { status: null, out: '', error: `cannot check out ${sha.slice(0, 12)}: ${add.err.slice(0, 160)}`, setupFailed: true };
    if (policy.setup) {
      const s = runner(dir, policy.setup, policy.timeout_sec);
      if (s.status !== 0) return { status: s.status, out: s.out, error: `setup exited ${s.status ?? s.error ?? 'unknown'}`, setupFailed: true };
    }
    return runner(dir, policy.select.split('{files}').join(files.map(quote).join(' ')), policy.timeout_sec);
  } finally {
    git(repoRoot, ['worktree', 'remove', '--force', dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function classifyBaseRed(o: { repoRoot: string; base: string; head: string; evidence: FailureEvidence; policy: BaseRedPolicy | null; runner?: Runner }): ClassifyResult {
  const runner = o.runner ?? shellRunner;
  const baseSha = git(o.repoRoot, ['rev-parse', '--verify', '-q', `origin/${o.base}^{commit}`]).out;
  const headSha = git(o.repoRoot, ['rev-parse', '--verify', '-q', `${o.head}^{commit}`]).out;
  const all = (verdict: CaseVerdict['verdict'], reason: string) => o.evidence.failures.map(c => ({ id: c.id, file: c.file, verdict, reason }));
  const out = (code: ClassifyCode, cases: CaseVerdict[], detail: string): ClassifyResult => ({ code, base: o.base, base_sha: baseSha, head: headSha, lane: o.evidence.lane, cases, detail });
  if (!o.policy) return out('BASE_RED_UNCONFIGURED', all('IN_BRANCH', 'the base branch declares no base_red'), `origin/${o.base}'s ship policy has no base_red block`);
  if (!baseSha || !headSha) return out('BASE_RED_REPRO_ERROR', all('IN_BRANCH', 'unresolved commit'), `cannot resolve origin/${o.base} or ${o.head}`);
  if (o.evidence.failures.length !== o.evidence.total) return out('BASE_RED_UNNAMED', all('IN_BRANCH', 'not every failure is named'), `the lane reported ${o.evidence.total} failures and the evidence names ${o.evidence.failures.length}`);
  const mergeBase = git(o.repoRoot, ['merge-base', baseSha, headSha]).out;
  const diff = git(o.repoRoot, ['diff', '--name-only', `${mergeBase || baseSha}..${headSha}`]);
  if (!mergeBase || !diff.ok) return out('BASE_RED_REPRO_ERROR', all('IN_BRANCH', 'diff unreadable'), `cannot read the PR's diff against origin/${o.base}`);
  const changed = diff.out.split('\n').filter(Boolean);
  const touched = o.evidence.failures.map(c => ({ c, path: changed.find(p => p === c.file || c.signature.includes(p)) }));
  if (touched.some(t => t.path)) {
    return out('IN_BRANCH', touched.map(({ c, path: p }) => ({ id: c.id, file: c.file, verdict: 'IN_BRANCH', reason: p ? `the PR changes ${p}` : 'another failure is in-branch' })), 'the PR touches a failing test or a path its failure names');
  }
  const files = [...new Set(o.evidence.failures.map(c => c.file))];
  const atBase = runAt(o.repoRoot, baseSha, o.policy, files, runner);
  if (atBase.setupFailed) return out('BASE_RED_REPRO_ERROR', all('IN_BRANCH', 'reproduction failed at base'), atBase.error ?? 'setup failed at base');
  const atHead = runAt(o.repoRoot, headSha, o.policy, files, runner);
  if (atHead.setupFailed) return out('BASE_RED_REPRO_ERROR', all('IN_BRANCH', 'reproduction failed at head'), atHead.error ?? 'setup failed at head');
  const cases = o.evidence.failures.map((c): CaseVerdict => {
    const base = reproduces(atBase, c);
    if (base) return { id: c.id, file: c.file, verdict: 'IN_BRANCH', reason: `${base} at base ${baseSha.slice(0, 12)}` };
    const head = reproduces(atHead, c);
    if (head) return { id: c.id, file: c.file, verdict: 'IN_BRANCH', reason: `the restricted command ${head} at head` };
    return { id: c.id, file: c.file, verdict: 'BASE_RED', reason: `fails the same way at base ${baseSha.slice(0, 12)}` };
  });
  const red = cases.every(c => c.verdict === 'BASE_RED');
  return out(red ? 'BASE_RED' : 'IN_BRANCH', cases, red ? `every failure reproduces at origin/${o.base} ${baseSha.slice(0, 12)}` : 'at least one failure is not reproduced on the base');
}

export function classifyLines(r: ClassifyResult): string[] {
  return [
    ...r.cases.map(c => c.verdict === 'BASE_RED' ? `BASE_RED: ${c.id} (${c.file}) base=${r.base_sha.slice(0, 12)}` : `IN_BRANCH: ${c.id} (${c.file}): ${c.reason}`),
    `BASE_RED_VERDICT: ${r.code === 'BASE_RED' ? 'base-red' : 'in-branch'} lane=${r.lane} base=origin/${r.base}@${r.base_sha.slice(0, 12) || '-'} (${r.code}: ${r.detail})`,
  ];
}

/** `<state root>/ship/base-red/<repo>/<branch>.json`, both hashed so a branch name never becomes a path. */
export function pausePath(repoRoot: string, branch: string): string {
  return path.join(resolveStateRoot(), 'ship', 'base-red', sha256(fs.realpathSync(repoRoot)).slice(0, 16), `${sha256(branch).slice(0, 16)}.json`);
}

export function writePause(repoRoot: string, branch: string, r: ClassifyResult, evidence: FailureEvidence, now = new Date()): { file: string; record: PauseRecord } {
  const record: PauseRecord = {
    schema_version: 1, kind: 'base-red-pause', branch, head: r.head, base: r.base, base_sha: r.base_sha, lane: r.lane, cases: evidence.failures,
    created_at: now.toISOString(), expires_at: new Date(now.getTime() + PAUSE_HOURS * 3600_000).toISOString(),
  };
  const file = pausePath(repoRoot, branch);
  writeJsonAtomic(file, record);
  return { file, record };
}

export function readPause(file: string): PauseRecord | string {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { return `cannot read ${file}: ${e.message}`; }
  const p = raw as PauseRecord;
  if (p?.kind !== 'base-red-pause' || p.schema_version !== 1 || !Array.isArray(p.cases) || !p.cases.length || typeof p.base_sha !== 'string' || typeof p.expires_at !== 'string') return `${file} is not a base-red pause record`;
  return p;
}

/** The receipt's `base_red` block: what makes a receipt conditional (lib/ship-receipt.ts bindReceipt refuses it by default). */
export function receiptBaseRed(p: PauseRecord): NonNullable<ShipReceipt['base_red']> {
  return { cases: p.cases.map(c => c.id), files: [...new Set(p.cases.map(c => c.file))], base: p.base_sha, lane: p.lane, expires_at: p.expires_at };
}

export type WaitResult = { code: 'BASE_GREEN'; sha: string; checked: number } | { code: 'BASE_RED_PAUSE_EXPIRED' | 'BASE_RED_WAIT_TIMEOUT'; sha: string; checked: number; detail: string };

/**
 * Wait for the base to stop failing the paused cases: on each new base head
 * (read with `git ls-remote`), fetch it and re-run setup and select there;
 * return when that run passes. A base that moved but still fails keeps waiting.
 */
export function waitBaseGreen(o: {
  repoRoot: string; pause: PauseRecord; policy: BaseRedPolicy; timeoutSec: number; pollSec: number; remote?: string;
  runner?: Runner; now?: () => number; sleep?: (ms: number) => void; lsRemote?: () => string | null;
}): WaitResult {
  const remote = o.remote ?? 'origin';
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const lsRemote = o.lsRemote ?? (() => {
    const r = git(o.repoRoot, ['ls-remote', remote, `refs/heads/${o.pause.base}`]);
    return r.ok ? r.out.split(/\s/)[0] || null : null;
  });
  const files = [...new Set(o.pause.cases.map(c => c.file))];
  const deadline = now() + o.timeoutSec * 1000;
  const expires = Date.parse(o.pause.expires_at);
  let last = o.pause.base_sha;
  let checked = 0;
  for (;;) {
    if (now() >= expires) return { code: 'BASE_RED_PAUSE_EXPIRED', sha: last, checked, detail: `the pause expired at ${o.pause.expires_at}` };
    const sha = lsRemote();
    if (sha && sha !== last) {
      git(o.repoRoot, ['fetch', '--no-tags', '-q', remote, `+refs/heads/${o.pause.base}:refs/remotes/${remote}/${o.pause.base}`]);
      checked++;
      const run = runAt(o.repoRoot, sha, o.policy, files, o.runner ?? shellRunner);
      if (!run.setupFailed && run.status === 0) return { code: 'BASE_GREEN', sha, checked };
      last = sha;
    }
    if (now() >= deadline) return { code: 'BASE_RED_WAIT_TIMEOUT', sha: last, checked, detail: `no base head passed the paused cases within ${o.timeoutSec}s` };
    sleep(Math.min(o.pollSec * 1000, Math.max(0, deadline - now())));
  }
}
