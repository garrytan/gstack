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
import { wtreeFingerprint, isRegistryUnavailable, loadRegistryFromBase, loadRegistryFromHead, type Registry } from '../regen';
import { isConfigUnavailable, loadConfigFromBase, loadConfigFromHead, type ConfigError, type PregateConfig } from './config';
import type { CheckResult, PregateContext, TouchedFile } from './types';
import { discoverLanes } from './workflows';
import type { RegistryError } from '../regen';

export interface BuildContextOptions {
  repoRoot: string; base: string; policyFrom: 'base' | 'head'; allowRepoCommands: boolean;
  timeoutMs?: number; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; knownChecks?: readonly string[];
}
export type ContextLoad = { ctx: PregateContext } | { refused: { code: 'POLICY_SOURCE_UNAVAILABLE' | 'PREGATE_CONFIG_INVALID' | 'REGEN_REGISTRY_INVALID'; message: string; errors?: Array<ConfigError | RegistryError> } };

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

export function buildContext(o: BuildContextOptions): ContextLoad {
  const base = o.base.replace(/^origin\//, '');
  const baseRef = `origin/${base}`;
  const baseSha = git(o.repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (!baseSha.ok || !baseSha.out) return { refused: { code: 'POLICY_SOURCE_UNAVAILABLE', message: `${baseRef} is not a resolvable commit` } };
  const head = git(o.repoRoot, ['rev-parse', 'HEAD']).out;
  const mergeBase = git(o.repoRoot, ['merge-base', baseSha.out, 'HEAD']).out || baseSha.out;
  const configLoad = o.policyFrom === 'head' ? loadConfigFromHead(o.repoRoot, o.knownChecks) : loadConfigFromBase(o.repoRoot, base, o.knownChecks);
  if (isConfigUnavailable(configLoad)) return { refused: { code: 'POLICY_SOURCE_UNAVAILABLE', message: configLoad.detail } };
  if (configLoad.errors.length) return { refused: { code: 'PREGATE_CONFIG_INVALID', message: `${configLoad.label}: ${configLoad.errors.map(e => `${e.message} at ${e.path}`).join('; ')}`, errors: configLoad.errors } };
  const registryLoad = o.policyFrom === 'head' ? loadRegistryFromHead(o.repoRoot) : loadRegistryFromBase(o.repoRoot, base);
  if (isRegistryUnavailable(registryLoad)) return { refused: { code: 'POLICY_SOURCE_UNAVAILABLE', message: registryLoad.detail } };
  if (registryLoad.errors.length) return { refused: { code: 'REGEN_REGISTRY_INVALID', message: `${registryLoad.source.label}: ${registryLoad.errors.map(e => `${e.message} at ${e.path}`).join('; ')}`, errors: registryLoad.errors } };
  const wtree = wtreeFingerprint(o.repoRoot);
  if (!wtree) return { refused: { code: 'POLICY_SOURCE_UNAVAILABLE', message: 'cannot fingerprint the working tree (gstack-wtree failed)' } };
  const platform = o.platform ?? process.platform;
  return {
    ctx: {
      repoRoot: o.repoRoot, base, baseRef, baseSha: baseSha.out, mergeBase, head, wtree, touched: touchedFiles(o.repoRoot, mergeBase),
      config: configLoad.config as PregateConfig, configLabel: configLoad.label, registry: registryLoad.registry as Registry, registryLabel: registryLoad.source.label,
      lanes: discoverLanes(o.repoRoot, platform), platform, allowRepoCommands: o.allowRepoCommands, timeoutMs: o.timeoutMs ?? 600_000, env: o.env ?? process.env, explain: [],
    },
  };
}

export function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }

/** The common input identity every check records; checks add their own keys. */
export function baseInputs(ctx: PregateContext, extra: Record<string, string> = {}): Record<string, string> {
  return { tree: ctx.wtree, head: ctx.head, base: `${ctx.baseRef}@${ctx.baseSha.slice(0, 12)}`, touched: sha256(ctx.touched.map(t => `${t.status} ${t.path}`).join('\n')), ...extra };
}

/**
 * Run one check under the before/after fingerprint (bin/gstack-evidence:394):
 * a tree that changed while the check ran, a thrown error or a timeout is
 * `incomplete`. Wall time is measured here so every row carries `ms`.
 */
export function withFingerprint(ctx: PregateContext, id: string, stage: CheckResult['stage'], fn: () => CheckResult): CheckResult {
  const started = Date.now();
  let result: CheckResult;
  try { result = fn(); }
  catch (e: any) {
    result = { id, stage, status: 'incomplete', detail: `threw: ${e?.message ?? e}`, code: 'PREGATE_INCOMPLETE', fix: 'read the error and rerun the check', inputs: baseInputs(ctx) };
  }
  const after = wtreeFingerprint(ctx.repoRoot);
  if (after !== ctx.wtree) {
    result = { ...result, status: 'incomplete', detail: `working tree changed during the check (${ctx.wtree.slice(0, 12)} → ${(after ?? 'unknown').slice(0, 12)}); result not certified`, code: 'PREGATE_INCOMPLETE', fix: 'keep the tree still during the run, then rerun gstack-pregate' };
  }
  return { ...result, ms: Date.now() - started };
}
