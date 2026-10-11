/**
 * evidence-bundle — the portable form of the machine-local evidence ledger
 * (plan C3). `gstack-evidence bundle` exports, for a committed head, the
 * comparison material the tree receipt needs (tree id, version source,
 * stamp-file normalization inputs), the execution identity the gate ran under
 * (runtime versions, lockfile identities with the root version normalized
 * away, CI workflow and runtime-pin hashes, runner image), the required-lane
 * manifest, each lane's executed selection, run URL, outcome, command hash and
 * log hash, and producer-bound metadata. Lanes the ledger produced on a clean
 * committed tree are `verified`; `--import` rows are `imported` and never
 * count toward reuse. Also home of `gstack-evidence ancestor` (plan C7).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ResultCodeName } from './result-codes';

export const BUNDLE_KIND = 'gstack-evidence-bundle';
export const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'uv.lock', 'poetry.lock', 'Gemfile.lock', 'go.sum'];
export const PIN_FILES = ['.tool-versions', '.nvmrc', '.node-version', '.bun-version', '.python-version', 'rust-toolchain.toml', '.ruby-version'];

export interface ExecutionIdentity {
  runtime: { bun: string | null; node: string | null; os: string; arch: string };
  /** lockfile → identity hash with the root package version normalized away; absent files are omitted. */
  lockfiles: Record<string, string>;
  /** `.github/workflows` tree id at the committed head, or null. */
  ci_workflows: string | null;
  /** Runtime pin files and package.json engines/packageManager, hashed. */
  runtime_pins: Record<string, string>;
  runner_image: string | null;
}
export interface LaneRecord {
  label: string; command: string; cmd_sha256: string; exit: number; ts: string; duration_s?: number;
  commit?: string; tree?: string; wtree?: string; dirty?: boolean; log_path?: string; log_sha256?: string | null;
  selection?: string | null; run_url?: string | null; verified: boolean; reason?: string;
}
export interface EvidenceBundle {
  schema_version: 1; kind: typeof BUNDLE_KIND; produced_at: string;
  producer: { host: string; user: string | null; pid: number; machine_id: string | null; gstack: string | null };
  repo: { branch: string | null; commit: string; tree: string; dirty: boolean };
  identity: ExecutionIdentity;
  comparison: { version_rel: string; version: string | null; changelog: string | null; stamp_paths: string[]; release_outputs: string[] };
  required_lanes: string[];
  lanes: LaneRecord[];
  imported: LaneRecord[];
}
export interface BundleError { code: ResultCodeName; message: string }

export function sha256Text(text: string | Buffer): string { return createHash('sha256').update(text).digest('hex'); }
function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? (r.stdout ?? '').replace(/\n$/, '') : null;
}
function versionOf(bin: string): string | null {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? (r.stdout ?? '').trim().replace(/^v/, '') || null : null;
}

/** Lockfile text with the root package's own version removed, so a stamp never changes the identity but a dependency does. */
export function normalizeLockfile(name: string, text: string): string {
  if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') {
    try {
      const parsed = JSON.parse(text) as Record<string, any>;
      delete parsed.version;
      if (parsed.packages && typeof parsed.packages[''] === 'object' && parsed.packages['']) delete parsed.packages[''].version;
      return JSON.stringify(parsed);
    } catch { return text; }
  }
  if (name === 'bun.lock') {
    // The root workspace entry carries `"version": "X"`; dependency versions live inside `"pkg@X"` keys and arrays.
    return text.replace(/^\s*"version":\s*"[^"]*",?\s*$/m, '');
  }
  return text;
}

function blobAt(repoRoot: string, treeish: string, rel: string): string | null {
  const r = spawnSync('git', ['show', `${treeish}:${rel}`], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** The identity a gate ran (or would run) under for a committed tree, on this machine. */
export function executionIdentity(repoRoot: string, treeish: string, env: NodeJS.ProcessEnv = process.env): ExecutionIdentity {
  const lockfiles: Record<string, string> = {};
  for (const name of LOCKFILES) {
    const text = blobAt(repoRoot, treeish, name);
    if (text !== null) lockfiles[name] = sha256Text(normalizeLockfile(name, text));
  }
  const pins: Record<string, string> = {};
  for (const name of PIN_FILES) {
    const text = blobAt(repoRoot, treeish, name);
    if (text !== null) pins[name] = sha256Text(text);
  }
  const pkg = blobAt(repoRoot, treeish, 'package.json');
  if (pkg !== null) {
    try {
      const parsed = JSON.parse(pkg) as Record<string, unknown>;
      pins['package.json#engines'] = sha256Text(JSON.stringify({ engines: parsed.engines ?? null, packageManager: parsed.packageManager ?? null }));
    } catch { pins['package.json#engines'] = 'unparsable'; }
  }
  const workflows = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${treeish}:.github/workflows`]);
  return {
    runtime: { bun: versionOf('bun'), node: versionOf('node'), os: process.platform, arch: process.arch },
    lockfiles, ci_workflows: workflows || null, runtime_pins: pins,
    runner_image: env.GSTACK_RUNNER_IMAGE || (env.ImageOS && env.ImageVersion ? `${env.ImageOS}/${env.ImageVersion}` : null),
  };
}

/** Field-by-field comparison; each difference names what changed. */
export function compareIdentity(gated: ExecutionIdentity, current: ExecutionIdentity): string[] {
  const diffs: string[] = [];
  for (const k of ['bun', 'node', 'os', 'arch'] as const) if (gated.runtime[k] !== current.runtime[k]) diffs.push(`runtime.${k} ${gated.runtime[k] ?? 'unknown'} -> ${current.runtime[k] ?? 'unknown'}`);
  const keys = new Set([...Object.keys(gated.lockfiles), ...Object.keys(current.lockfiles)]);
  for (const k of keys) if (gated.lockfiles[k] !== current.lockfiles[k]) diffs.push(`lockfile ${k}${gated.lockfiles[k] && current.lockfiles[k] ? ' dependencies changed' : gated.lockfiles[k] ? ' removed' : ' added'}`);
  if (gated.ci_workflows !== current.ci_workflows) diffs.push('ci workflows changed');
  const pinKeys = new Set([...Object.keys(gated.runtime_pins), ...Object.keys(current.runtime_pins)]);
  for (const k of pinKeys) if (gated.runtime_pins[k] !== current.runtime_pins[k]) diffs.push(`runtime pin ${k} changed`);
  if ((gated.runner_image || current.runner_image) && gated.runner_image !== current.runner_image) diffs.push(`runner image ${gated.runner_image ?? 'unknown'} -> ${current.runner_image ?? 'unknown'}`);
  return diffs;
}

export interface BuildBundleOptions {
  repoRoot: string; ledgerRecords: Array<Record<string, unknown>>; labels?: string[]; required?: string[];
  selections?: Record<string, string>; runUrls?: Record<string, string>; imported?: Array<Record<string, unknown>>;
  comparison: EvidenceBundle['comparison']; env?: NodeJS.ProcessEnv; now?: Date; gstackVersion?: string | null;
}

/** Build a bundle for HEAD from the ledger's latest record per label. */
export function buildBundle(o: BuildBundleOptions): { bundle: EvidenceBundle; errors: BundleError[] } {
  const errors: BundleError[] = [];
  const commit = git(o.repoRoot, ['rev-parse', 'HEAD']);
  const tree = git(o.repoRoot, ['rev-parse', 'HEAD^{tree}']);
  if (!commit || !tree) return { bundle: null as unknown as EvidenceBundle, errors: [{ code: 'EVIDENCE_IDENTITY_UNKNOWN', message: 'not a git repository with a commit; a bundle binds to a committed head' }] };
  const dirty = (git(o.repoRoot, ['status', '--porcelain', '-uno']) ?? '') !== '';
  const labels = o.labels?.length ? o.labels : [...new Set(o.ledgerRecords.map(r => String(r.label)))];
  const lanes: LaneRecord[] = [];
  for (const label of labels) {
    const latest = [...o.ledgerRecords].reverse().find(r => r.label === label);
    if (!latest) { errors.push({ code: 'EVIDENCE_IDENTITY_UNKNOWN', message: `no ledger record for label ${label}` }); continue; }
    const lane: LaneRecord = {
      label, command: String(latest.command ?? ''), cmd_sha256: String(latest.cmd_sha256 ?? ''), exit: Number(latest.exit ?? -1), ts: String(latest.ts ?? ''),
      duration_s: typeof latest.duration_s === 'number' ? latest.duration_s : undefined, commit: latest.commit as string | undefined, tree: latest.tree as string | undefined,
      wtree: latest.wtree as string | undefined, dirty: latest.dirty as boolean | undefined, log_path: latest.log_path as string | undefined,
      log_sha256: typeof latest.log_path === 'string' && fs.existsSync(latest.log_path) ? sha256Text(fs.readFileSync(latest.log_path)) : null,
      selection: o.selections?.[label] ?? null, run_url: o.runUrls?.[label] ?? null, verified: true,
    };
    if (!lane.cmd_sha256 || !lane.tree || !lane.commit) { lane.verified = false; lane.reason = 'record lacks commit, tree or command hash'; }
    else if (lane.dirty || !lane.wtree) { lane.verified = false; lane.reason = 'ran on a dirty or unfingerprinted tree (committed heads only)'; }
    else if (lane.commit !== commit) { lane.verified = false; lane.reason = `ran on ${lane.commit.slice(0, 12)}, HEAD is ${commit.slice(0, 12)}`; }
    lanes.push(lane);
  }
  const imported: LaneRecord[] = (o.imported ?? []).map(r => ({
    label: String(r.label ?? 'imported'), command: String(r.command ?? ''), cmd_sha256: String(r.cmd_sha256 ?? ''), exit: Number(r.exit ?? -1), ts: String(r.ts ?? ''),
    selection: (r.selection as string | undefined) ?? null, run_url: (r.run_url as string | undefined) ?? null, verified: false, reason: `imported assertion from ${r.source ?? 'unknown source'}; not independently verified`,
  }));
  const bundle: EvidenceBundle = {
    schema_version: 1, kind: BUNDLE_KIND, produced_at: (o.now ?? new Date()).toISOString(),
    producer: { host: os.hostname(), user: os.userInfo().username ?? null, pid: process.pid, machine_id: (o.env ?? process.env).GSTACK_MACHINE_ID ?? null, gstack: o.gstackVersion ?? null },
    repo: { branch: git(o.repoRoot, ['branch', '--show-current']) || null, commit, tree, dirty },
    identity: executionIdentity(o.repoRoot, commit, o.env), comparison: o.comparison,
    required_lanes: o.required ?? labels, lanes, imported,
  };
  return { bundle, errors };
}

export function readBundle(file: string): { bundle: EvidenceBundle | null; error?: BundleError } {
  let parsed: any;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e: any) { return { bundle: null, error: { code: 'EVIDENCE_BUNDLE_INVALID', message: `${file}: ${e.message}` } }; }
  if (!parsed || parsed.kind !== BUNDLE_KIND || parsed.schema_version !== 1 || !parsed.repo?.tree || !parsed.identity || !Array.isArray(parsed.lanes)) {
    return { bundle: null, error: { code: 'EVIDENCE_BUNDLE_INVALID', message: `${file} is not a ${BUNDLE_KIND} v1` } };
  }
  return { bundle: parsed as EvidenceBundle };
}

/** `gstack-evidence ancestor`: each sha must be an ancestor of HEAD (or `of`). */
export function checkAncestors(repoRoot: string, shas: string[], of = 'HEAD'): Array<{ sha: string; ok: boolean; detail: string }> {
  return shas.map(sha => {
    if (!/^[0-9a-f]{7,64}$/.test(sha)) return { sha, ok: false, detail: 'not a hex commit id' };
    const full = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    if (!full) return { sha, ok: false, detail: 'unknown commit (fetch it first)' };
    const r = spawnSync('git', ['merge-base', '--is-ancestor', full, of], { cwd: repoRoot, timeout: 30_000 });
    return { sha, ok: r.status === 0, detail: r.status === 0 ? `ancestor of ${of}` : `not an ancestor of ${of}` };
  });
}

// ---------------------------------------------------------------------------
// verify (plan E2): rerun the probes, or mark each claim verified/unverified
// ---------------------------------------------------------------------------
export type ClaimVerdict = 'verified' | 'unverified';
export interface ClaimVerification { label: string; verdict: ClaimVerdict; reason: string; rerun_exit?: number; imported: boolean; required: boolean }
export interface BundleVerification {
  schema_version: 1; bundle: string; at: string; host: string; mode: 'rerun' | 'ledger';
  tree: { bundle: string; current: string | null; same: boolean };
  claims: ClaimVerification[]; verified: number; unverified: number; required_unverified: string[];
}
export interface VerifyOptions {
  repoRoot: string; bundle: EvidenceBundle; bundlePath: string; rerun?: boolean; ledgerRecords?: Array<Record<string, unknown>>;
  now?: Date; timeoutMs?: number; env?: NodeJS.ProcessEnv;
  /** Test seam: runs one lane command and returns its exit code. */
  runCommand?: (command: string, cwd: string) => number;
}

function defaultRun(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): number {
  const r = spawnSync('bash', ['-lc', command], { cwd, stdio: ['ignore', 'inherit', 'inherit'], timeout: timeoutMs, env });
  return r.status ?? (r.signal ? 128 : 1);
}

/** Each lane claim is `verified` only by a rerun on the bundle's tree, or by this machine's own ledger record and log. */
export function verifyBundle(o: VerifyOptions): BundleVerification {
  const current = git(o.repoRoot, ['rev-parse', 'HEAD^{tree}']);
  const same = current === o.bundle.repo.tree;
  const run = o.runCommand ?? ((c: string, cwd: string) => defaultRun(c, cwd, o.timeoutMs ?? 3_600_000, o.env ?? process.env));
  const required = new Set(o.bundle.required_lanes);
  const claims: ClaimVerification[] = [];
  const all = [...o.bundle.lanes.map(l => ({ l, imported: false })), ...o.bundle.imported.map(l => ({ l, imported: true }))];
  for (const { l, imported } of all) {
    const base = { label: l.label, imported, required: required.has(l.label) };
    if (!l.command) { claims.push({ ...base, verdict: 'unverified', reason: 'no command recorded' }); continue; }
    if (o.rerun) {
      if (!same) { claims.push({ ...base, verdict: 'unverified', reason: `HEAD tree ${current?.slice(0, 12) ?? 'unknown'} differs from bundle tree ${o.bundle.repo.tree.slice(0, 12)}; check out ${o.bundle.repo.commit.slice(0, 12)} first` }); continue; }
      const exit = run(l.command, o.repoRoot);
      const ok = exit === l.exit;
      claims.push({ ...base, verdict: ok ? 'verified' : 'unverified', rerun_exit: exit, reason: ok ? `rerun exited ${exit} as recorded` : `rerun exited ${exit}, bundle recorded ${l.exit}` });
      continue;
    }
    if (imported) { claims.push({ ...base, verdict: 'unverified', reason: l.reason ?? 'imported assertion; rerun to verify' }); continue; }
    const record = (o.ledgerRecords ?? []).find(r => r.label === l.label && r.cmd_sha256 === l.cmd_sha256 && r.commit === l.commit);
    if (!record) { claims.push({ ...base, verdict: 'unverified', reason: 'no matching record in this machine’s evidence ledger (produced elsewhere); rerun to verify' }); continue; }
    const logPath = typeof record.log_path === 'string' ? record.log_path : null;
    if (!logPath || !fs.existsSync(logPath)) { claims.push({ ...base, verdict: 'unverified', reason: 'ledger record found but its log is gone' }); continue; }
    const logSha = sha256Text(fs.readFileSync(logPath));
    if (l.log_sha256 && logSha !== l.log_sha256) { claims.push({ ...base, verdict: 'unverified', reason: 'log bytes differ from the bundle’s log hash' }); continue; }
    if (!l.verified) { claims.push({ ...base, verdict: 'unverified', reason: l.reason ?? 'bundle marked the lane unverified' }); continue; }
    claims.push({ ...base, verdict: 'verified', reason: 'this machine’s ledger record and log match the bundle' });
  }
  const unverified = claims.filter(c => c.verdict === 'unverified');
  return {
    schema_version: 1, bundle: o.bundlePath, at: (o.now ?? new Date()).toISOString(), host: os.hostname(), mode: o.rerun ? 'rerun' : 'ledger',
    tree: { bundle: o.bundle.repo.tree, current, same }, claims, verified: claims.length - unverified.length, unverified: unverified.length,
    required_unverified: unverified.filter(c => c.required).map(c => c.label),
  };
}

export function renderVerification(v: BundleVerification): string {
  const lines = v.claims.map(c => `VERIFY: ${c.label} ${c.verdict}${c.imported ? ' (imported)' : ''}${c.required ? '' : ' (optional)'} — ${c.reason}`);
  lines.push(`EVIDENCE_VERIFY: ${v.bundle} mode=${v.mode} tree=${v.tree.same ? 'same' : 'differs'} verified=${v.verified} unverified=${v.unverified}${v.required_unverified.length ? ` required_unverified=${v.required_unverified.join(',')}` : ''}`);
  return lines.join('\n') + '\n';
}
