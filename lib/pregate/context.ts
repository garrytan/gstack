/**
 * pregate/context — what every check reads (plan C8): the base, the touched
 * files (committed since the merge-base plus the working tree, renames and
 * deletions kept), the reviewed `.gstack/pregate.json` and
 * `.gstack/generated.json`, the workflow lanes and the starting fingerprint.
 * Fingerprinting follows bin/gstack-evidence: the working-tree content hash
 * (bin/gstack-wtree) before a check runs and again after; a tree that moved
 * during a check makes its result `incomplete`, never `pass`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { slugFromEnvironment } from '../bin-context';
import { isRegistryUnavailable, loadRegistryFromBase, loadRegistryFromHead, type Registry } from '../regen';
import { resolveStateRoot } from '../state-root';
import { RESULT_CODES, TROUBLESHOOTING_DOC, resultLine } from '../result-codes';
import { runScriptSync, wtreeFingerprint, type InvocationOptions, type WtreeResult } from '../script-invocation';
import { policyUnavailableLine, resolveBaseBranch } from '../ship-policy';
import { PREGATE_CONFIG_PATH, isConfigUnavailable, loadConfigFromBase, loadConfigFromHead, loadConfigFromUser, type ConfigError, type ConfigLoad, type PregateConfig } from './config';
import type { CheckResult, PregateContext, TouchedFile } from './types';
import { discoverLanes } from './workflows';
import type { RegistryError } from '../regen';

export interface BuildContextOptions {
  repoRoot: string; base: string; policyFrom: 'base' | 'head'; allowRepoCommands: boolean;
  timeoutMs?: number; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; knownChecks?: readonly string[];
  /** `--stall-timeout`; default the config's `stall_timeout_s`, else 300 s. */
  stallTimeoutMs?: number; progress?: (line: string) => void; cores?: number; testBackend?: string; remote?: { spendCapUsd: number } | null;
  /** How gstack's own bash bins launch (gstack-wtree, gstack-config); tests inject a Windows probe. */
  invocation?: InvocationOptions;
  /** `<state root>/projects/<slug>/pregate.json`: read only when the base carries no pregate.json, and never from a relative path or one inside the repository. */
  userConfigPath?: string;
}

export const DEFAULT_STALL_TIMEOUT_S = 300;
const GSTACK_CONFIG = path.resolve(import.meta.dir, '..', '..', 'bin', 'gstack-config');

/** `gstack-config get test_backend` (local | ubicloud); `local` when unreadable. */
export function readTestBackend(env: NodeJS.ProcessEnv, invocation?: InvocationOptions): string {
  const r = runScriptSync(GSTACK_CONFIG, ['get', 'test_backend'], { encoding: 'utf8', timeout: 15_000, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }, invocation);
  return (r.status === 0 && (r.stdout ?? '').trim()) || 'local';
}
export interface ContextRefusal {
  code: 'POLICY_SOURCE_UNAVAILABLE' | 'PREGATE_CONFIG_INVALID' | 'REGEN_REGISTRY_INVALID' | 'WTREE_UNAVAILABLE';
  message: string;
  /** A cause-specific fix that replaces the code's own (a gstack-wtree exit names its repair; so does a `--base` that is no origin branch). */
  fix?: string;
  errors?: Array<ConfigError | RegistryError>;
}
export type ContextLoad = { ctx: PregateContext } | { refused: ContextRefusal };

/**
 * A failed fingerprint as a refusal. A launch failure lists each Windows bash
 * candidate tried with its rejection reason and keeps WTREE_UNAVAILABLE's fix
 * (GSTACK_GIT_BASH); a helper exit keeps the repair gstack-wtree printed after
 * its last `; ` (for example `set TMPDIR to a writable directory`).
 */
export function wtreeRefusal(fp: Extract<WtreeResult, { error: string }>): ContextRefusal {
  if (fp.kind === 'launch') {
    const message = fp.tried?.length ? `gstack-wtree could not start: no Git Bash found; tried ${fp.tried.map(c => `${c.source} ${c.path}: ${c.rejected}`).join('; ')}` : fp.error;
    return { code: 'WTREE_UNAVAILABLE', message, fix: RESULT_CODES.WTREE_UNAVAILABLE.fix };
  }
  const cut = fp.error.lastIndexOf('; ');
  if (cut > 0) return { code: 'WTREE_UNAVAILABLE', message: fp.error.slice(0, cut), fix: fp.error.slice(cut + 2) };
  return { code: 'WTREE_UNAVAILABLE', message: fp.error, fix: 'run bin/gstack-wtree in the repository to see why it fails (it exits 1 outside a git repository, in one with no commits, or when a write fails), repair that, then rerun gstack-pregate' };
}

/**
 * `origin/<base>` does not resolve, yet `<base>` names a commit here and no local
 * branch: a SHA, a tag or another remote's ref (`upstream/main` in a fork clone).
 * `git fetch origin <base>` never creates `origin/<base>` for those (#3269), so the
 * fix names an origin branch instead. A local branch, or a name that resolves
 * nowhere, keeps the code's fetch fix: that is the shallow or never-fetched
 * checkout it repairs.
 */
function notAnOriginBranch(repoRoot: string, base: string): ContextRefusal | null {
  if (git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]).ok) return null;
  if (!git(repoRoot, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).ok) return null;
  const fallback = resolveBaseBranch(repoRoot);
  const example = git(repoRoot, ['rev-parse', '--verify', '--quiet', `origin/${fallback}^{commit}`]).ok ? `, such as --base ${fallback}` : '';
  return { code: 'POLICY_SOURCE_UNAVAILABLE', message: `origin/${base} is not a resolvable commit; ${base} names a commit here, but --base takes a branch name on origin`, fix: `pass a branch that exists on origin${example} (git branch -r --list 'origin/*' lists them)` };
}

export interface RefusalReport { code: ContextRefusal['code']; detail: string; fix: string; docs: string; line: string }

/**
 * One context refusal as its stderr line and as the fields of the `--json` envelope.
 * A cause-specific `fix` replaces the code's own. The shared POLICY_SOURCE_UNAVAILABLE
 * summary names the ship policy; pregate's line says "pin files".
 */
export function describeRefusal(refused: ContextRefusal, base: string, context = 'gstack-pregate'): RefusalReport {
  const { code, message } = refused;
  const row = RESULT_CODES[code];
  const docs = `${TROUBLESHOOTING_DOC}#${row.anchor}`;
  if (code === 'POLICY_SOURCE_UNAVAILABLE' && !refused.fix) return { code, detail: message, fix: row.fix.replace('<base>', base), docs, line: policyUnavailableLine(context, base, message).replace('.gstack/ship-policy.json', 'pin files') };
  if (!refused.fix) return { code, detail: message, fix: row.fix, docs, line: resultLine(context, code, message) };
  return { code, detail: message, fix: refused.fix, docs, line: `${context}: ${row.summary.replace('.gstack/ship-policy.json', 'pin files')} (${message}); fix: ${refused.fix} (${code})` };
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim() };
}

/** Committed changes since the merge-base (renames detected) plus every working-tree change, untracked files included. */
export function touchedFiles(repoRoot: string, mergeBase: string): TouchedFile[] {
  const out = new Map<string, TouchedFile>();
  const committed = git(repoRoot, ['diff', '--name-status', '-M', '-z', mergeBase, 'HEAD']).out.split('\0').filter(Boolean);
  for (let i = 0; i < committed.length; i++) {
    const status = committed[i]![0] as string;
    if (status === 'R' || status === 'C') { const from = committed[++i]!; const to = committed[++i]!; out.set(to, { path: to, status: 'R', renamedFrom: from, uncommitted: false }); continue; }
    const file = committed[++i]!;
    out.set(file, { path: file, status: status === 'D' ? 'D' : status === 'A' ? 'A' : 'M', uncommitted: false });
  }
  const porcelain = git(repoRoot, ['status', '--porcelain', '-z', '--untracked-files=all']).out.split('\0').filter(Boolean);
  for (let i = 0; i < porcelain.length; i++) {
    const entry = porcelain[i]!;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    if (xy.includes('R')) { const from = porcelain[++i]!; out.set(file, { path: file, status: 'R', renamedFrom: from, uncommitted: true }); continue; }
    if (xy === '!!') continue;
    const prior = out.get(file);
    const status: TouchedFile['status'] = xy.includes('D') ? 'D' : xy === '??' || xy.includes('A') ? (prior?.status === 'M' ? 'M' : 'A') : (prior?.status ?? 'M');
    out.set(file, { path: file, status, renamedFrom: prior?.renamedFrom, uncommitted: true });
  }
  return [...out.values()].filter(t => t.path !== 'node_modules' && !t.path.startsWith('node_modules/')).sort((a, b) => a.path.localeCompare(b.path));
}

/** The deepest existing ancestor realpathed (on-disk casing), the rest re-joined: a symlinked state root inside the checkout still counts as inside. */
function realish(p: string): string {
  let head = path.resolve(p); const tail: string[] = [];
  while (!fs.existsSync(head) && path.dirname(head) !== head) { tail.unshift(path.basename(head)); head = path.dirname(head); }
  try { return path.join(fs.realpathSync.native(head), ...tail); } catch { return path.resolve(p); }
}
const within = (root: string, p: string) => { const rel = path.relative(root, p); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

/** Dotenv files Bun loads from the launch directory unless started with --no-env-file. */
const DOTENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test', '.env.test.local'];

/**
 * The dotenv files in `cwd` that Bun loaded (no --no-env-file in `execArgv`). Any of them could set the slug or state
 * root that picks the user policy, and Bun's dotenv syntax is looser than a key scan can follow, so any one refuses.
 */
export function loadedDotenvFiles(cwd: string, execArgv: readonly string[]): string[] {
  if (execArgv.includes('--no-env-file')) return [];
  return DOTENV_FILES.filter(f => fs.existsSync(path.join(cwd, f)));
}

/** `<state root>/projects/<slug>/pregate.json` for the repository at `root`, from the caller's environment. */
export function defaultUserConfigPath(root: string): string {
  return path.join(resolveStateRoot(), 'projects', slugFromEnvironment(undefined, root), 'pregate.json');
}

/** Why a user policy path must not be read, or null: a relative path (no HOME) or one a PR could commit is never trusted. */
export function userConfigRejection(repoRoot: string, file: string): string | null {
  if (!path.isAbsolute(file)) return 'not an absolute path';
  if (within(path.resolve(repoRoot), path.resolve(file)) || within(realish(repoRoot), realish(file))) return 'inside the repository; a PR could supply it';
  return null;
}

export function buildContext(o: BuildContextOptions): ContextLoad {
  const base = o.base.replace(/^origin\//, '');
  const baseRef = `origin/${base}`;
  const baseSha = git(o.repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (!baseSha.ok || !baseSha.out) return { refused: notAnOriginBranch(o.repoRoot, base) ?? { code: 'POLICY_SOURCE_UNAVAILABLE', message: `${baseRef} is not a resolvable commit` } };
  const head = git(o.repoRoot, ['rev-parse', 'HEAD']).out;
  const mergeBase = git(o.repoRoot, ['merge-base', baseSha.out, 'HEAD']).out || baseSha.out;
  let configLoad: ConfigLoad = o.policyFrom === 'head' ? loadConfigFromHead(o.repoRoot, o.knownChecks) : loadConfigFromBase(o.repoRoot, base, o.knownChecks);
  const explain: string[] = [];
  let absentUserPolicy: string | undefined;
  if (o.policyFrom === 'base' && o.userConfigPath && !isConfigUnavailable(configLoad) && configLoad.kind === 'none') {
    const rejected = userConfigRejection(o.repoRoot, o.userConfigPath);
    const user = rejected ? null : loadConfigFromUser(o.userConfigPath, o.knownChecks);
    if (user) configLoad = user;
    else explain.push(`user policy: ${o.userConfigPath} ${rejected ? `ignored (${rejected})` : '(absent)'}`);
    if (!user && !rejected) absentUserPolicy = o.userConfigPath;
  }
  if (isConfigUnavailable(configLoad)) return { refused: { code: 'POLICY_SOURCE_UNAVAILABLE', message: configLoad.detail } };
  if (configLoad.errors.length) return { refused: { code: 'PREGATE_CONFIG_INVALID', message: `${configLoad.label}: ${configLoad.errors.map(e => `${e.message} at ${e.path}`).join('; ')}`, errors: configLoad.errors, ...(configLoad.kind === 'user' ? { fix: `edit ${o.userConfigPath} directly at each path the message names, then rerun gstack-pregate; it lives outside the repository, so a base-branch change does not reach it` } : {}) } };
  const registryLoad = o.policyFrom === 'head' ? loadRegistryFromHead(o.repoRoot) : loadRegistryFromBase(o.repoRoot, base);
  if (isRegistryUnavailable(registryLoad)) return { refused: { code: 'POLICY_SOURCE_UNAVAILABLE', message: registryLoad.detail } };
  if (registryLoad.errors.length) return { refused: { code: 'REGEN_REGISTRY_INVALID', message: `${registryLoad.source.label}: ${registryLoad.errors.map(e => `${e.message} at ${e.path}`).join('; ')}`, errors: registryLoad.errors } };
  const env = o.env ?? process.env;
  const fp = wtreeFingerprint({ cwd: o.repoRoot, env, invocation: o.invocation });
  if ('error' in fp) return { refused: wtreeRefusal(fp) };
  const wtree = fp.tree;
  const platform = o.platform ?? process.platform;
  const config = configLoad.config as PregateConfig;
  const lanes = discoverLanes(o.repoRoot, platform);
  // A lane that exists but is not platform-tier on this host already runs here, so only an unknown id is worth a line.
  for (const id of config.local) if (!lanes.some(l => l.id === id)) explain.push(`local: ${id} matches no workflow lane; ignored`);
  return {
    ctx: {
      repoRoot: o.repoRoot, base, baseRef, baseSha: baseSha.out, mergeBase, head, wtree, touched: touchedFiles(o.repoRoot, mergeBase),
      config, configLabel: configLoad.label, configFile: configLoad.kind === 'user' && o.userConfigPath ? o.userConfigPath : PREGATE_CONFIG_PATH, ...(configLoad.kind === 'user' && configLoad.digest ? { configDigest: configLoad.digest } : {}), ...(absentUserPolicy ? { absentUserPolicy } : {}), registry: registryLoad.registry as Registry, registryLabel: registryLoad.source.label,
      lanes, platform, allowRepoCommands: o.allowRepoCommands, timeoutMs: o.timeoutMs ?? 600_000,
      stallTimeoutMs: o.stallTimeoutMs ?? (config.stall_timeout_s ?? DEFAULT_STALL_TIMEOUT_S) * 1000,
      progress: o.progress ?? (line => process.stderr.write(`${line}\n`)),
      cores: o.cores ?? os.availableParallelism(), testBackend: o.testBackend ?? readTestBackend(env, o.invocation), policyFrom: o.policyFrom, remote: o.remote ?? null,
      env, explain,
    },
  };
}

export function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }

/** The common input identity every check records; checks add their own keys. */
export function baseInputs(ctx: PregateContext, extra: Record<string, string> = {}): Record<string, string> {
  return { tree: ctx.wtree, head: ctx.head, base: `${ctx.baseRef}@${ctx.baseSha.slice(0, 12)}`, touched: sha256(ctx.touched.map(t => `${t.status} ${t.path}`).join('\n')), ...(ctx.configDigest ? { policy: ctx.configDigest } : {}), ...extra };
}

/**
 * Run one check under the before/after fingerprint (bin/gstack-evidence:394):
 * a tree that changed while the check ran, a thrown error or rejected promise
 * or a timeout is `incomplete`. Wall time is measured here so every row
 * carries `ms`.
 */
export async function withFingerprint(ctx: PregateContext, id: string, stage: CheckResult['stage'], fn: () => CheckResult | Promise<CheckResult>): Promise<CheckResult> {
  const started = Date.now();
  let result: CheckResult;
  try { result = await fn(); }
  catch (e: any) {
    result = { id, stage, status: 'incomplete', detail: `threw: ${e?.message ?? e}`, code: 'PREGATE_INCOMPLETE', fix: 'read the error and rerun the check', inputs: baseInputs(ctx) };
  }
  const after = wtreeFingerprint({ cwd: ctx.repoRoot, env: ctx.env });
  if ('error' in after) {
    result = { ...result, status: 'incomplete', detail: `cannot fingerprint the working tree after the check (${after.error}); result not certified`, code: 'PREGATE_INCOMPLETE', fix: wtreeRefusal(after).fix! };
  } else if (after.tree !== ctx.wtree) {
    result = { ...result, status: 'incomplete', detail: `working tree changed during the check (${ctx.wtree.slice(0, 12)} → ${after.tree.slice(0, 12)}); result not certified`, code: 'PREGATE_INCOMPLETE', fix: 'keep the tree still during the run, then rerun gstack-pregate' };
  }
  return { ...result, ms: Date.now() - started };
}
