/**
 * free-receipts — main receipts for free test files and the pull request shadow report (GST-167 PR 3;
 * docs/test-impact.md#receipts-and-shadow-mode). Nothing here changes what CI runs.
 *
 * Writing (scripts/test-free-shards.ts --ci-run … --receipts <dir>): a shard of a free-tests.yml main push run
 * that passed on its first attempt, with no flaky retry, crashed worker, unattributed failure or short summary,
 * writes one record per passing file whose key lib/test-impact/key.ts computes at the run's tree with that tree's
 * own key code. Any doubt writes nothing for the whole shard; a write failure never changes the shard's verdict.
 *
 * Reading (--shadow-select --receipts <dir> --base <ref>): each source run is checked once through
 * lib/run-evidence.ts verifyRun under the base branch's run_profiles["free-receipts"], push events only. A record is
 * refused, with a named reason, when its run is another workflow (other_workflow), not a push (not_push), retried
 * (retried: run_attempt above 1 on the receipt or the API, or the run moved meanwhile), older than the profile's
 * max_age_hours (stale), disagrees with the API or git on sha, tree or the files the run executed (forged_run),
 * ran on a head that is not on the base (off_base), or fails any other verifyRun check (run_refused). An API or
 * artifact outage makes every receipt unavailable. A file is reported would-reuse only when an accepted receipt's
 * key equals its key at the PR tree computed by the base's key code; every other file reports execute (<reason>).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs } from '../../lib/bun-isolation';
import { PREGATE_CONFIG_PATH } from '../../lib/pregate/config';
import { DEFAULT_MAX_AGE_HOURS, ghRunDeps, runProfileErrors, verifyRun, type RunDeps, type RunEvidence, type RunProfile, type RunRefusal, type RunVerdict } from '../../lib/run-evidence';
import type { KeyReport } from '../../lib/test-impact/key';
import type { FreeShardOutcome } from '../test-free-shards';

export const RECEIPTS_PROFILE = 'free-receipts';
export const RECEIPT_VERSION = 1;
const RECEIPT_FILE = /^free-receipts-shard-(\d+)\.json$/;
const SHA = /^[0-9a-f]{40}$/;
const TREE = /^[0-9a-f]{40,64}$/;
const KEY = /^[0-9a-f]{64}$/;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface FreeReceipt { file: string; key: string; run_id: number; run_attempt: number; head_sha: string; tree: string; shard: number; written_at: string }
export type ReceiptRefusal = 'forged_run' | 'not_push' | 'retried' | 'stale' | 'other_workflow' | 'off_base' | 'run_refused';
export interface ReceiptCheck { repo: string; profileName: string; profile: RunProfile; now: Date; deps: RunDeps; onBase: (sha: string) => boolean }
export type ReceiptVerdict = { receipt: FreeReceipt; ok: true; evidence: RunEvidence } | { receipt: FreeReceipt; ok: false; reason: ReceiptRefusal; detail: string };
export type ReceiptVerdicts = { verdicts: ReceiptVerdict[] } | { unavailable: string };
/** Keys for `tests` at `tree`, computed by `base`'s own key code. */
export type KeysAt = (tree: string, base: string, tests: string[]) => Promise<KeyReport>;
type Env = Record<string, string | undefined>;

const short = (s: string) => s.slice(0, 12);
const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/**
 * scripts/test-impact.ts's trusted route, `key --base`: the key code is loaded from `base`, never from this checkout.
 * It runs as a subprocess so the runner neither imports the CLI (which imports the runner) nor its computed import.
 */
function trustedKeysAt(root: string, traceDir?: string): KeysAt {
  return async (tree, base, tests) => {
    const args = [...bunIsolationArgs(), path.join(root, 'scripts', 'test-impact.ts'), 'key', '--tree', tree, '--base', base, '--json', ...(traceDir ? ['--traces', traceDir] : []), ...tests];
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 1024 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`test-impact key exited ${r.status ?? r.signal ?? r.error?.message}: ${(r.stderr ?? '').trim().slice(-300)}`);
    return JSON.parse(r.stdout) as KeyReport;
  };
}

function git(root: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
}

function shardVeto(outcome: FreeShardOutcome, retry: FreeShardOutcome | null): string | null {
  if (retry) return 'the flaky retry re-ran files in this shard';
  if (outcome.status !== 'passed' || outcome.exitCode !== 0) return `the shard ${outcome.status} (exit ${outcome.exitCode})`;
  if (outcome.failingFiles.length || outcome.unattributedFailures) return 'the shard recorded failures';
  if (outcome.crashedFiles?.length) return `a worker crashed on ${outcome.crashedFiles.join(', ')}`;
  const s = outcome.summary;
  if (!outcome.files.length || !s?.sawTerminalSummary || s.filesRan !== outcome.files.length) return 'the shard has no complete execution summary';
  return null;
}

function runVeto(env: Env, revision: string): string | null {
  if (env.GITHUB_EVENT_NAME !== 'push') return `a ${env.GITHUB_EVENT_NAME || 'local'} run writes no receipts; only main push runs do`;
  if (!/^\d{1,15}$/.test(env.GITHUB_RUN_ID ?? '')) return 'GITHUB_RUN_ID is not a run id';
  if (env.GITHUB_RUN_ATTEMPT !== '1') return `run attempt ${env.GITHUB_RUN_ATTEMPT ?? 'unknown'} writes no receipts; first attempts only`;
  if (env.GITHUB_SHA !== revision) return `the checkout ${short(revision)} is not the run's commit ${short(env.GITHUB_SHA ?? 'unknown')}`;
  return null;
}

/** Write shard `shard`'s receipts into `dir` and return the line to print. Never throws: a failure writes nothing. */
export async function recordShardReceipts(o: {
  root: string; dir: string; shard: number; outcome: FreeShardOutcome; retry: FreeShardOutcome | null; revision: string;
  traceDir?: string; env?: Env; now?: Date; treeOf?: (sha: string) => string; keysAt?: KeysAt;
}): Promise<string> {
  const label = `[test:free] receipts for shard ${o.shard}:`;
  try {
    const env = o.env ?? process.env;
    const veto = shardVeto(o.outcome, o.retry) ?? runVeto(env, o.revision);
    if (veto) return `${label} none written (${veto})`;
    const tree = (o.treeOf ?? (sha => git(o.root, ['rev-parse', '--verify', `${sha}^{tree}`]).stdout.trim()))(o.revision);
    if (!TREE.test(tree)) throw new Error(`git cannot read the tree of ${o.revision}`);
    const report = await (o.keysAt ?? trustedKeysAt(o.root, o.traceDir))(o.revision, o.revision, o.outcome.files);
    const keyed = new Map(report.results.filter(r => r.eligible && r.key && KEY.test(r.key)).map(r => [r.test, r.key!]));
    const written_at = (o.now ?? new Date()).toISOString();
    const receipts: FreeReceipt[] = o.outcome.files.filter(file => keyed.has(file)).map(file => ({
      file, key: keyed.get(file)!, run_id: Number(env.GITHUB_RUN_ID), run_attempt: 1, head_sha: o.revision, tree, shard: o.shard, written_at,
    }));
    const unkeyed = o.outcome.files.length - receipts.length;
    if (!receipts.length) return `${label} none written (no file has a key: ${unkeyed} ineligible)`;
    const file = path.join(o.dir, `free-receipts-shard-${o.shard}.json`);
    fs.mkdirSync(o.dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp-${process.pid}`, JSON.stringify({ version: RECEIPT_VERSION, receipts }, null, 2) + '\n');
    fs.renameSync(`${file}.tmp-${process.pid}`, file);
    return `${label} ${receipts.length} written, ${unkeyed} without a key (ineligible) → ${file}`;
  } catch (e) {
    return `${label} none written (${message(e)})`;
  }
}

function asReceipt(r: unknown): FreeReceipt | null {
  const x = r as Record<string, unknown>;
  if (!x || typeof x !== 'object') return null;
  const posInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
  const ok = typeof x.file === 'string' && /^[\w@.\/-]+$/.test(x.file) && !x.file.split('/').includes('..') && !x.file.startsWith('/')
    && typeof x.key === 'string' && KEY.test(x.key) && posInt(x.run_id) && posInt(x.run_attempt) && posInt(x.shard)
    && typeof x.head_sha === 'string' && SHA.test(x.head_sha) && typeof x.tree === 'string' && TREE.test(x.tree)
    && typeof x.written_at === 'string' && Number.isFinite(Date.parse(x.written_at));
  if (!ok) return null;
  const { file, key, run_id, run_attempt, head_sha, tree, shard, written_at } = x as unknown as FreeReceipt;
  return { file, key, run_id, run_attempt, head_sha, tree, shard, written_at };
}

/** Every receipt file under `dir` (artifact downloads may nest one directory per shard), in shard order. */
export function readReceipts(dir: string): { receipts: FreeReceipt[] } | { unavailable: string } {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { unavailable: `no receipts directory at ${dir}` };
  const shardOf = (f: string) => Number(RECEIPT_FILE.exec(path.basename(f))?.[1]);
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter(f => RECEIPT_FILE.test(path.basename(f)))
    .sort((a, b) => shardOf(a) - shardOf(b) || a.localeCompare(b));
  if (!files.length) return { unavailable: `no receipt files in ${dir}` };
  const receipts: FreeReceipt[] = [];
  for (const f of files) {
    let body: { version?: unknown; receipts?: unknown };
    try { body = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return { unavailable: `malformed ${f}: ${message(e)}` }; }
    if (body?.version !== RECEIPT_VERSION || !Array.isArray(body.receipts)) return { unavailable: `malformed ${f}: not a version ${RECEIPT_VERSION} receipts file` };
    for (const [i, r] of body.receipts.entries()) {
      const receipt = asReceipt(r);
      if (!receipt) return { unavailable: `malformed ${f}: record ${i} is not a receipt` };
      receipts.push(receipt);
    }
  }
  return { receipts };
}

const RUN_REFUSALS: Partial<Record<RunRefusal, ReceiptRefusal>> = {
  workflow_mismatch: 'other_workflow', event_mismatch: 'not_push', run_stale: 'stale', tree_mismatch: 'forged_run', artifact_mismatch: 'forged_run', run_changed: 'retried',
};
const RUN_UNAVAILABLE: RunRefusal[] = ['api_error', 'artifact_missing'];

/** Each receipt's verdict, its run verified once; an API or artifact outage makes them all unavailable. */
export function verifyReceipts(receipts: FreeReceipt[], c: ReceiptCheck): ReceiptVerdicts {
  const profile: RunProfile = { ...c.profile, events: ['push'] };
  const maxAgeHours = profile.max_age_hours ?? DEFAULT_MAX_AGE_HOURS;
  const runs = new Map<number, RunVerdict>();
  for (const id of new Set(receipts.map(r => r.run_id))) {
    const v = verifyRun(c.deps, { repo: c.repo, runRef: String(id), profileName: c.profileName, profile, now: c.now });
    if (!v.ok && RUN_UNAVAILABLE.includes(v.reason)) return { unavailable: `run ${id} ${v.reason}: ${v.detail}` };
    runs.set(id, v);
  }
  const onBase = new Map<string, boolean>();
  return {
    verdicts: receipts.map((receipt): ReceiptVerdict => {
      const refuse = (reason: ReceiptRefusal, detail: string): ReceiptVerdict => ({ receipt, ok: false, reason, detail });
      const v = runs.get(receipt.run_id)!;
      if (!v.ok) return refuse(RUN_REFUSALS[v.reason] ?? 'run_refused', `${v.reason}: ${v.detail}`);
      const e = v.evidence;
      if (e.run_attempt !== 1 || receipt.run_attempt !== 1) return refuse('retried', `run ${e.run_id} is on attempt ${e.run_attempt} and the receipt names attempt ${receipt.run_attempt}; only first attempts count`);
      if (receipt.head_sha !== e.head_sha || receipt.tree !== e.tree) return refuse('forged_run', `the receipt names ${short(receipt.head_sha)} tree ${short(receipt.tree)}, but run ${e.run_id} tested ${short(e.head_sha)} tree ${short(e.tree)}`);
      if (!e.files.includes(receipt.file)) return refuse('forged_run', `run ${e.run_id}'s tree.json does not list ${receipt.file}`);
      const age = c.now.getTime() - Date.parse(receipt.written_at);
      if (!(age >= -CLOCK_SKEW_MS && age <= maxAgeHours * 3600_000)) return refuse('stale', `written ${receipt.written_at}, limit ${maxAgeHours} h`);
      if (!onBase.has(e.head_sha)) onBase.set(e.head_sha, c.onBase(e.head_sha));
      if (!onBase.get(e.head_sha)) return refuse('off_base', `run ${e.run_id}'s head ${short(e.head_sha)} is not on the base branch`);
      return { receipt, ok: true, evidence: e };
    }),
  };
}

/** One line per free file and the reusable share. Throws unless the lines cover `files` exactly once. */
export function shadowReport(o: { files: string[]; receipts: ReceiptVerdicts; keys: KeyReport | { unavailable: string }; durations: Record<string, number> }): { lines: string[]; summary: string; reusable: string[] } {
  const keys = 'unavailable' in o.keys ? null : new Map(o.keys.results.map(r => [r.test, r]));
  const byFile = new Map<string, ReceiptVerdict[]>();
  if ('verdicts' in o.receipts) {
    for (const v of [...o.receipts.verdicts].sort((a, b) => b.receipt.written_at.localeCompare(a.receipt.written_at))) byFile.set(v.receipt.file, [...(byFile.get(v.receipt.file) ?? []), v]);
  }
  const entries = o.files.map(file => {
    const execute = (reason: string) => ({ file, reuse: false, line: `${file} execute (${reason})` });
    if ('unavailable' in o.receipts) return execute(`receipts unavailable: ${o.receipts.unavailable}`);
    if (!keys) return execute(`keys unavailable: ${(o.keys as { unavailable: string }).unavailable}`);
    const k = keys.get(file);
    if (!k) return execute('no key computed');
    if (!k.eligible || !k.key) return execute(`ineligible: ${k.reasons[0] ?? 'no key'}${k.reasons.length > 1 ? ` (+${k.reasons.length - 1} more)` : ''}`);
    const candidates = byFile.get(file) ?? [];
    if (!candidates.length) return execute('no receipt');
    const match = candidates.find(v => v.ok && v.receipt.key === k.key);
    if (match) return { file, reuse: true, line: `${file} would-reuse ${match.receipt.run_id} key=${short(k.key)}` };
    const accepted = candidates.find(v => v.ok);
    if (accepted) return execute(`key mismatch: receipt ${short(accepted.receipt.key)}, tree ${short(k.key)}`);
    const refused = candidates[0] as Extract<ReceiptVerdict, { ok: false }>;
    return execute(`${refused.reason}: ${refused.detail}`);
  });
  const covered = new Set(entries.map(e => e.file));
  if (entries.length !== covered.size || covered.size !== new Set(o.files).size || o.files.some(f => !covered.has(f))) {
    throw new Error(`shadow report must cover every free file exactly once: ${entries.length} lines for ${covered.size} distinct files`);
  }
  const reusable = entries.filter(e => e.reuse).map(e => e.file);
  const ms = (files: string[]) => files.reduce((sum, f) => sum + (o.durations[f] ?? 0), 0);
  const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(1) : '0.0'}%`;
  const secs = (n: number) => `${(n / 1000).toFixed(1)} s`;
  const unseeded = o.files.filter(f => o.durations[f] === undefined).length;
  const summary = `shadow: would reuse ${reusable.length} of ${o.files.length} free files (${pct(reusable.length, o.files.length)}) and ${secs(ms(reusable))} of ${secs(ms(o.files))} seed time (${pct(ms(reusable), ms(o.files))}); ${unseeded} files have no seed duration. Nothing was skipped: every file ran.`;
  return { lines: entries.map(e => e.line), summary, reusable };
}

/** The base branch's run_profiles["free-receipts"], so a pull request can't relax the rules its receipts are read under. */
function receiptProfile(root: string, base: string): RunProfile | { unavailable: string } {
  if (base.startsWith('-')) return { unavailable: `${base} is not a ref` };
  const r = git(root, ['show', `${base}:${PREGATE_CONFIG_PATH}`]);
  if (r.status !== 0) return { unavailable: `cannot read ${base}:${PREGATE_CONFIG_PATH}` };
  let profile: unknown;
  try { profile = JSON.parse(r.stdout)?.run_profiles?.[RECEIPTS_PROFILE]; } catch (e) { return { unavailable: `${base}:${PREGATE_CONFIG_PATH} is not JSON: ${message(e)}` }; }
  if (!profile) return { unavailable: `${base}:${PREGATE_CONFIG_PATH} declares no run_profiles.${RECEIPTS_PROFILE}` };
  const errors = runProfileErrors({ [RECEIPTS_PROFILE]: profile }, undefined);
  return errors.length ? { unavailable: `${base}'s run_profiles.${RECEIPTS_PROFILE} is invalid: ${errors[0]!.message}` } : profile as RunProfile;
}

function repoName(root: string, env: Env): string | null {
  if (/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) return env.GITHUB_REPOSITORY!;
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(git(root, ['remote', 'get-url', 'origin']).stdout.trim())?.[1] ?? null;
}

/** --shadow-select: verify the receipts in `receiptsDir`, key `files` at HEAD with `base`'s key code, and report. */
export async function runShadowSelect(o: {
  root: string; files: string[]; receiptsDir: string; base: string; durations: Record<string, number>;
  traceDir?: string; now?: Date; env?: Env; keysAt?: KeysAt; deps?: RunDeps; onBase?: (sha: string) => boolean;
}): Promise<{ lines: string[]; summary: string; reusable: string[] }> {
  const env = o.env ?? process.env;
  const read = readReceipts(o.receiptsDir);
  let receipts: ReceiptVerdicts = read as { unavailable: string };
  if ('receipts' in read) {
    const profile = receiptProfile(o.root, o.base);
    const repo = repoName(o.root, env);
    if ('unavailable' in profile) receipts = profile;
    else if (!repo) receipts = { unavailable: 'cannot tell which GitHub repository this is (no GITHUB_REPOSITORY, no github.com origin)' };
    else {
      const onBase = o.onBase ?? (sha => git(o.root, ['merge-base', '--is-ancestor', sha, o.base]).status === 0);
      try { receipts = verifyReceipts(read.receipts, { repo, profileName: RECEIPTS_PROFILE, profile, now: o.now ?? new Date(), deps: o.deps ?? ghRunDeps(repo, o.root), onBase }); }
      catch (e) { receipts = { unavailable: message(e) }; }
    }
  }
  const keys = 'unavailable' in receipts ? { unavailable: 'not computed' }
    : await (o.keysAt ?? trustedKeysAt(o.root, o.traceDir))('HEAD', o.base, o.files).catch(e => ({ unavailable: message(e) }));
  return shadowReport({ files: o.files, receipts, keys, durations: o.durations });
}
