import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { durableAtomicWrite } from './durable-atomic-write';

const FULL_OID = /^[0-9a-f]{40}$/i;
const SAFE_REPO = /^[A-Za-z0-9._/-]+$/;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

export interface LandingIntentDescriptor {
  repoId: string;
  repositoryNodeId: string;
  prNumber: number;
  expectedHeadOid: string;
  expectedBaseOid: string;
  targetRef: string;
  mode: 'direct_observed';
  providerOperationId: string;
}

export interface LandingIntentRecord extends LandingIntentDescriptor {
  schemaVersion: 1;
  intentId: string;
  phase: 'prepared' | 'abandoned_terminal' | 'cancel_required' | 'checkpointed' | 'safety_stop';
  createdAt: string;
  updatedAt: string;
  result?: Record<string, unknown>;
}

export interface LandingObservation {
  terminal: boolean;
  providerState: 'not_submitted' | 'queued' | 'merged' | 'open';
  headOid: string;
  baseOid: string;
  queueId?: string;
  mergeSha?: string;
  mergeTreeMatches?: boolean;
  mergeTree?: string;
  mergeParents?: string[];
}

export interface ExactMergedLandingCheckpoint {
  schema: 'ecpe.merged-landing-checkpoint.v1'; checkpoint_id: string; binding_sha256: string;
  raw_intent_id: string; repo_id: string; repository_node_id: string; pr_number: number;
  expected_head_oid: string; expected_base_oid: string; target_ref: string; provider_operation_id: string;
  merge_sha: string; merge_tree: string; merge_parents: [string];
  base_parent_verified: true; head_tree_verified: true;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function validateDescriptor(input: LandingIntentDescriptor): LandingIntentDescriptor {
  const keys = Object.keys(input).sort();
  const expected = ['expectedBaseOid', 'expectedHeadOid', 'mode', 'prNumber', 'providerOperationId', 'repoId', 'repositoryNodeId', 'targetRef'].sort();
  if (canonical(keys) !== canonical(expected)) throw new Error('landing_intent_fields_invalid');
  if (!SAFE_REPO.test(input.repoId) || input.repoId.includes('..')) throw new Error('landing_repo_invalid');
  if (!SAFE_ID.test(input.repositoryNodeId) || !SAFE_ID.test(input.providerOperationId)) throw new Error('landing_provider_identity_invalid');
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) throw new Error('landing_pr_invalid');
  if (!FULL_OID.test(input.expectedHeadOid) || !FULL_OID.test(input.expectedBaseOid)) throw new Error('landing_oid_invalid');
  if (!/^origin\/[A-Za-z0-9._/-]+$/.test(input.targetRef) || input.targetRef.includes('..')) throw new Error('landing_target_ref_invalid');
  if (input.mode !== 'direct_observed') throw new Error('landing_mode_invalid');
  return {
    ...input,
    expectedHeadOid: input.expectedHeadOid.toLowerCase(),
    expectedBaseOid: input.expectedBaseOid.toLowerCase(),
  };
}

function intentPath(root: string, intentId: string): string {
  if (!/^[0-9a-f]{64}$/.test(intentId)) throw new Error('landing_intent_id_invalid');
  return path.join(root, `${intentId}.json`);
}

export function landingIntentIdForDescriptor(rawDescriptor: LandingIntentDescriptor): string {
  return digest(validateDescriptor(rawDescriptor));
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWrite(file: string, value: LandingIntentRecord): void {
  durableAtomicWrite(file, `${canonical(value)}\n`);
}

function readRecord(root: string, intentId: string): LandingIntentRecord {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.geteuid?.() || (rootStat.mode & 0o077) !== 0) throw new Error('landing_intent_permissions_invalid');
  const file = intentPath(root, intentId);
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch { throw new Error('landing_intent_permissions_invalid'); }
  let raw: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error('landing_intent_permissions_invalid');
    raw = fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
  const value = JSON.parse(raw) as LandingIntentRecord;
  if (value.schemaVersion !== 1 || value.intentId !== intentId || digest({
    repoId: value.repoId,
    repositoryNodeId: value.repositoryNodeId,
    prNumber: value.prNumber,
    expectedHeadOid: value.expectedHeadOid,
    expectedBaseOid: value.expectedBaseOid,
    targetRef: value.targetRef,
    mode: value.mode,
    providerOperationId: value.providerOperationId,
  }) !== intentId) throw new Error('landing_intent_corrupt');
  return value;
}

function withLock<T>(root: string, intentId: string, action: () => T): T {
  const lock = path.join(root, `.${intentId}.lock`);
  let fd: number;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('landing_intent_lock_failed');
    const info = fs.lstatSync(lock);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('landing_intent_lock_invalid');
    const ownerPid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error('landing_intent_lock_invalid');
    try {
      process.kill(ownerPid, 0);
      throw new Error('landing_intent_locked');
    } catch (probe) {
      if (probe instanceof Error && probe.message === 'landing_intent_locked') throw probe;
      if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('landing_intent_locked');
    }
    fs.unlinkSync(lock);
    syncDirectory(root);
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw new Error('landing_intent_locked'); }
  }
  try {
    fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
    fs.fsyncSync(fd);
    return action();
  } finally {
    fs.closeSync(fd!);
    fs.unlinkSync(lock);
    syncDirectory(root);
  }
}

export async function assertBaseContained(cwd: string, baseOid: string, headOid: string, gitPath: string): Promise<void> {
  if (!path.isAbsolute(gitPath) || !FULL_OID.test(baseOid) || !FULL_OID.test(headOid)) throw new Error('landing_containment_input_invalid');
  const process = Bun.spawn([gitPath, 'merge-base', '--is-ancestor', baseOid, headOid], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
  });
  const stderr = await new Response(process.stderr).text();
  const status = await process.exited;
  if (status === 1) throw new Error('base_not_contained');
  if (status !== 0) throw new Error(`landing_git_failed:${stderr.trim() || status}`);
}

export function prepareLandingIntent(root: string, rawDescriptor: LandingIntentDescriptor): LandingIntentRecord {
  const descriptor = validateDescriptor(rawDescriptor);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const intentId = digest(descriptor);
  const file = intentPath(root, intentId);
  if (fs.existsSync(file)) return readRecord(root, intentId);
  return withLock(root, intentId, () => {
    if (fs.existsSync(file)) return readRecord(root, intentId);
    const now = new Date().toISOString();
    const record: LandingIntentRecord = { schemaVersion: 1, intentId, phase: 'prepared', createdAt: now, updatedAt: now, ...descriptor };
    atomicWrite(file, record);
    return record;
  });
}

export function inspectLandingIntent(root: string, intentId: string): LandingIntentRecord {
  return readRecord(root, intentId);
}

export function inspectLandingIntentForDescriptor(root: string, rawDescriptor: LandingIntentDescriptor): LandingIntentRecord | null {
  const descriptor = validateDescriptor(rawDescriptor);
  const intentId = digest(descriptor);
  const file = intentPath(root, intentId);
  if (!fs.existsSync(file)) return null;
  return readRecord(root, intentId);
}

export function inspectExactMergedLandingCheckpoint(root: string, input: {
  descriptor: LandingIntentDescriptor; mergeSha: string; mergeTree: string; mergeParents: [string] | string[];
}): ExactMergedLandingCheckpoint {
  const descriptor = validateDescriptor(input.descriptor);
  if (!FULL_OID.test(input.mergeSha) || !FULL_OID.test(input.mergeTree) || input.mergeParents.length !== 1 ||
    !FULL_OID.test(input.mergeParents[0] ?? '') || input.mergeParents[0].toLowerCase() !== descriptor.expectedBaseOid) {
    throw new Error('landing_checkpoint_invalid');
  }
  const record = readRecord(root, landingIntentIdForDescriptor(descriptor));
  const result = record.result;
  const resultKeys = result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result).sort() : [];
  const expectedResultKeys = ['baseParentVerified', 'headTreeVerified', 'mergeParents', 'mergeSha', 'mergeTree', 'status'].sort();
  if (record.phase !== 'checkpointed' || canonical(resultKeys) !== canonical(expectedResultKeys) ||
    result?.status !== 'checkpointed' || result.mergeSha !== input.mergeSha.toLowerCase() || result.mergeTree !== input.mergeTree.toLowerCase() ||
    canonical(result.mergeParents) !== canonical(input.mergeParents.map(value => value.toLowerCase())) ||
    result.baseParentVerified !== true || result.headTreeVerified !== true) throw new Error('landing_checkpoint_invalid');
  const core = {
    raw_intent_id: record.intentId, repo_id: descriptor.repoId, repository_node_id: descriptor.repositoryNodeId,
    pr_number: descriptor.prNumber, expected_head_oid: descriptor.expectedHeadOid, expected_base_oid: descriptor.expectedBaseOid,
    target_ref: descriptor.targetRef, provider_operation_id: descriptor.providerOperationId,
    merge_sha: input.mergeSha.toLowerCase(), merge_tree: input.mergeTree.toLowerCase(),
    merge_parents: input.mergeParents.map(value => value.toLowerCase()) as [string],
    base_parent_verified: true as const, head_tree_verified: true as const,
  };
  const binding = digest(core);
  return { schema: 'ecpe.merged-landing-checkpoint.v1', checkpoint_id: digest({ schema: 'ecpe.merged-landing-checkpoint.v1', binding }), binding_sha256: binding, ...core };
}

export function inspectLandingIntentForPr(root:string,input:{prNumber:number;repoId:string;providerOperationId:string}):LandingIntentRecord|null{
  const {prNumber,repoId,providerOperationId}=input;
  if(!Number.isSafeInteger(prNumber)||prNumber<=0)throw new Error('landing_pr_invalid');
  if(!SAFE_REPO.test(repoId)||repoId.includes('..')||!SAFE_ID.test(providerOperationId))throw new Error('landing_provider_identity_invalid');
  if(!fs.existsSync(root))return null;
  const info=fs.lstatSync(root);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error('landing_intent_permissions_invalid');
  const matches=fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isFile()&&!entry.isSymbolicLink()&&/^[0-9a-f]{64}\.json$/.test(entry.name)).map(entry=>readRecord(root,entry.name.slice(0,-5))).filter(record=>record.prNumber===prNumber);
  const exact=matches.filter(record=>record.repoId===repoId&&record.providerOperationId===providerOperationId);
  if(exact.length>1)throw new Error('landing_intent_ambiguous');
  if(exact.length===1)return exact[0];
  return null;
}

export function reconcileLandingIntent(root: string, intentId: string, observation: LandingObservation): Record<string, unknown> {
  return withLock(root, intentId, () => {
    const current = readRecord(root, intentId);
    if (!FULL_OID.test(observation.headOid) || !FULL_OID.test(observation.baseOid)) throw new Error('landing_observation_invalid');
    let result: Record<string, unknown>;
    if (observation.headOid.toLowerCase() !== current.expectedHeadOid) {
      result = { status: 'safety_stop', reason: 'provider_head_moved' };
    } else if (observation.baseOid.toLowerCase() !== current.expectedBaseOid) {
      result = { status: 'safety_stop', reason: 'base_race_detected' };
    } else if (observation.providerState === 'not_submitted' && observation.terminal) {
      result = { status: 'abandoned_terminal' };
    } else if (observation.providerState === 'queued' && observation.terminal) {
      if (!observation.queueId || !SAFE_ID.test(observation.queueId)) throw new Error('landing_queue_invalid');
      result = {
        status: 'cancel_required',
        queueId: observation.queueId,
        proposalHash: digest({ action: 'cancel-terminal-landing', intentId, queueId: observation.queueId }),
      };
    } else if (observation.providerState === 'merged') {
      if (!observation.mergeSha || !FULL_OID.test(observation.mergeSha)) throw new Error('landing_merge_sha_invalid');
      const complete = observation.mergeTreeMatches && observation.mergeTree && FULL_OID.test(observation.mergeTree) && observation.mergeParents?.length === 1 &&
        FULL_OID.test(observation.mergeParents[0]) && observation.mergeParents[0].toLowerCase() === current.expectedBaseOid;
      result = observation.mergeTreeMatches
        ? complete ? { status: 'checkpointed', mergeSha: observation.mergeSha.toLowerCase(), mergeTree: observation.mergeTree!.toLowerCase(),
          mergeParents: observation.mergeParents!.map(value => value.toLowerCase()), baseParentVerified: true, headTreeVerified: true }
          : { status: 'checkpointed', mergeSha: observation.mergeSha.toLowerCase() }
        : { status: 'safety_stop', reason: 'provider_merge_tree_mismatch' };
    } else {
      result = { status: 'fresh_readiness' };
    }
    const terminal = new Set(['abandoned_terminal', 'cancel_required', 'checkpointed', 'safety_stop']);
    if (terminal.has(current.phase)) {
      if (canonical(current.result) !== canonical(result)) throw new Error('landing_reconcile_conflict');
      return current.result!;
    }
    if (terminal.has(result.status as string)) {
      const next: LandingIntentRecord = {
        ...current,
        phase: result.status as LandingIntentRecord['phase'],
        updatedAt: new Date().toISOString(),
        result,
      };
      atomicWrite(intentPath(root, intentId), next);
    }
    return result;
  });
}
