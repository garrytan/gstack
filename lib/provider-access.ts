import * as path from 'node:path';
import * as os from 'node:os';
import { resolveInstalledTool } from './toolchain-policy';
import { projectAccountEnvironment, type AccountTool } from './account-environment';
import { assertBaseContained, inspectLandingIntentForDescriptor, inspectLandingIntentForPr, landingIntentIdForDescriptor, prepareLandingIntent, reconcileLandingIntent, type LandingIntentDescriptor } from './landing-safety';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from './durable-owner-lock';

export interface ProviderRemote {
  host: string;
  owner: string;
  repository: string;
  comparisonKey: string;
  repositorySelector: string;
}

export interface ProviderAccess {
  repositoryNameWithOwner: string;
  repositoryNodeId: string;
  viewerPermission: string;
  prNumber: number;
  prState: string;
}

export type ProviderOperation = 'read' | 'comment' | 'merge' | 'deploy';

export interface ProviderAutomationState {
  id: string;
  state: string;
}

export interface ProviderQueueState extends ProviderAutomationState {
  headOid: string;
  baseOid: string;
  groupOid: string | null;
}

export interface ProviderHeadSnapshot extends ProviderAccess {
  repositorySelector: string;
  headRepositoryNameWithOwner: string;
  headRepositoryNodeId: string;
  targetRef: string;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  mergeable: string;
  mergeStateStatus: string;
  autoMergeRequest: ProviderAutomationState | null;
  mergeQueueEntry: ProviderQueueState | null;
}

export interface RequiredCheck {
  name: string;
  state: string;
  bucket: string;
  link: string;
  workflow: string;
}

const CHECK_FIELDS = new Set(['name', 'state', 'bucket', 'link', 'workflow']);
const READ_PERMISSIONS = new Set(['READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']);
const PERMISSION_RANK: Record<string, number> = { READ: 1, TRIAGE: 2, WRITE: 3, MAINTAIN: 4, ADMIN: 5 };
const OPERATION_FLOOR: Record<ProviderOperation, number> = { read: 1, comment: 2, merge: 3, deploy: 3 };
const FULL_OID = /^[0-9a-f]{40}$/i;

export function permissionSatisfies(permission: string, operation: ProviderOperation): boolean {
  return (PERMISSION_RANK[permission] ?? 0) >= OPERATION_FLOOR[operation];
}

export function canonicalProviderRemote(raw: string): ProviderRemote {
  let host = '';
  let pathname = '';
  const scp = raw.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    host = scp[1];
    pathname = scp[2];
  } else {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new Error('provider_remote_invalid'); }
    if (!['https:', 'ssh:'].includes(parsed.protocol)) throw new Error('provider_remote_invalid');
    host = parsed.hostname;
    pathname = parsed.pathname.replace(/^\//, '');
  }
  const parts = pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  const normalizedHost = host.toLowerCase();
  if (!/^[A-Za-z0-9.-]+$/.test(host) || parts.length < 2
    || (normalizedHost === 'github.com' && parts.length !== 2)
    || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p))) {
    throw new Error('provider_remote_invalid');
  }
  const repository = parts.at(-1)!;
  const owner = parts.slice(0, -1).join('/');
  const comparisonKey = `${normalizedHost}/${owner}/${repository}`;
  return {
    host: normalizedHost,
    owner,
    repository,
    comparisonKey: normalizedHost === 'github.com' ? comparisonKey.toLowerCase() : comparisonKey,
    repositorySelector: normalizedHost === 'github.com' ? `${owner}/${repository}` : `${normalizedHost}/${owner}/${repository}`,
  };
}

export function validateProviderAccessSnapshot(
  remote: ProviderRemote,
  prNumber: number,
  snapshot: {
    repository?: { id?: unknown; nameWithOwner?: unknown; viewerPermission?: unknown };
    pullRequest?: { number?: unknown; state?: unknown } | null;
  },
): ProviderAccess {
  const repo = snapshot.repository;
  const pr = snapshot.pullRequest;
  if (!repo || typeof repo.id !== 'string' || !repo.id) throw new Error('provider_auth_mismatch');
  const returnedKey = typeof repo.nameWithOwner === 'string' ? `${remote.host}/${repo.nameWithOwner}` : '';
  const accessKey = remote.host === 'github.com' ? returnedKey.toLowerCase() : returnedKey;
  if (typeof repo.nameWithOwner !== 'string' || accessKey !== remote.comparisonKey) {
    throw new Error('provider_auth_mismatch');
  }
  if (typeof repo.viewerPermission !== 'string' || !READ_PERMISSIONS.has(repo.viewerPermission)) {
    throw new Error('provider_permission_missing');
  }
  if (!pr || pr.number !== prNumber) throw new Error('provider_pr_mismatch');
  if (pr.state !== 'OPEN') throw new Error('provider_pr_state_invalid');
  return {
    repositoryNameWithOwner: repo.nameWithOwner,
    repositoryNodeId: repo.id,
    viewerPermission: repo.viewerPermission,
    prNumber,
    prState: pr.state,
  };
}

function automationState(value: unknown): ProviderAutomationState | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') throw new Error('provider_automation_invalid');
  const row = value as Record<string, unknown>;
  const id = typeof row.id === 'string' && row.id ? row.id : typeof row.enabledAt === 'string' && row.enabledAt ? row.enabledAt : '';
  const state = typeof row.state === 'string' && row.state ? row.state : 'ENABLED';
  if (!id) throw new Error('provider_automation_invalid');
  return { id, state };
}

function queueState(value: unknown): ProviderQueueState | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') throw new Error('provider_queue_invalid');
  const row = value as Record<string, unknown>;
  const entry = automationState(row);
  if (!entry || typeof row.headOid !== 'string' || typeof row.baseOid !== 'string' || !FULL_OID.test(row.headOid) || !FULL_OID.test(row.baseOid)) {
    throw new Error('provider_queue_invalid');
  }
  if (row.groupOid !== null && row.groupOid !== undefined && (typeof row.groupOid !== 'string' || !FULL_OID.test(row.groupOid))) {
    throw new Error('provider_queue_invalid');
  }
  return { ...entry, headOid: row.headOid, baseOid: row.baseOid, groupOid: (row.groupOid as string | null | undefined) ?? null };
}

export function validateProviderHeadSnapshot(input: {
  repositoryNameWithOwner: string;
  repositoryNodeId: string;
  viewerPermission: string;
  repositorySelector: string;
  targetRef: string;
  pullRequest: Record<string, unknown>;
}): ProviderHeadSnapshot {
  const pr = input.pullRequest;
  if (!Number.isSafeInteger(pr.number) || (pr.number as number) <= 0) throw new Error('provider_pr_mismatch');
  if (pr.state !== 'OPEN') throw new Error('provider_pr_state_invalid');
  if (!permissionSatisfies(input.viewerPermission, 'read')) throw new Error('provider_permission_missing');
  for (const field of ['baseRefOid', 'headRefOid'] as const) {
    if (typeof pr[field] !== 'string' || !FULL_OID.test(pr[field] as string)) throw new Error('provider_oid_invalid');
  }
  for (const field of ['baseRefName', 'headRefName', 'mergeable', 'mergeStateStatus'] as const) {
    if (typeof pr[field] !== 'string' || !pr[field]) throw new Error('provider_snapshot_invalid');
  }
  const headRepository = pr.headRepository as Record<string, unknown> | null | undefined;
  if (!headRepository || typeof headRepository.id !== 'string' || !headRepository.id || typeof headRepository.nameWithOwner !== 'string' || !headRepository.nameWithOwner) throw new Error('provider_head_repository_invalid');
  if (input.targetRef !== `origin/${pr.baseRefName}` || !/^origin\/[A-Za-z0-9._/-]+$/.test(input.targetRef)) {
    throw new Error('provider_target_ref_invalid');
  }
  return {
    repositoryNameWithOwner: input.repositoryNameWithOwner,
    repositoryNodeId: input.repositoryNodeId,
    viewerPermission: input.viewerPermission,
    prNumber: pr.number as number,
    prState: pr.state as string,
    repositorySelector: input.repositorySelector,
    headRepositoryNameWithOwner: headRepository.nameWithOwner,
    headRepositoryNodeId: headRepository.id,
    targetRef: input.targetRef,
    baseRefName: pr.baseRefName as string,
    baseRefOid: (pr.baseRefOid as string).toLowerCase(),
    headRefName: pr.headRefName as string,
    headRefOid: (pr.headRefOid as string).toLowerCase(),
    mergeable: pr.mergeable as string,
    mergeStateStatus: pr.mergeStateStatus as string,
    autoMergeRequest: automationState(pr.autoMergeRequest),
    mergeQueueEntry: queueState(pr.mergeQueueEntry),
  };
}

export function assertProviderHeadSnapshot(snapshot: ProviderHeadSnapshot, expected: {
  prNumber: number;
  expectedHeadOid: string;
  expectedBaseOid: string;
  expectedTargetRef: string;
  expectedRepositoryNodeId?: string;
  expectedHeadRepositoryNodeId?: string;
  expectedHeadRefName?: string;
  requireAutomationNull?: boolean;
}): ProviderHeadSnapshot {
  if (!FULL_OID.test(expected.expectedHeadOid) || !FULL_OID.test(expected.expectedBaseOid)) throw new Error('provider_oid_invalid');
  if (snapshot.prNumber !== expected.prNumber) throw new Error('provider_pr_mismatch');
  if (snapshot.headRefOid !== expected.expectedHeadOid.toLowerCase()) throw new Error('provider_head_moved');
  if (snapshot.baseRefOid !== expected.expectedBaseOid.toLowerCase()) throw new Error('provider_base_moved');
  if (snapshot.targetRef !== expected.expectedTargetRef) throw new Error('provider_target_ref_mismatch');
  if (expected.expectedRepositoryNodeId && snapshot.repositoryNodeId !== expected.expectedRepositoryNodeId) throw new Error('provider_auth_mismatch');
  if (expected.expectedHeadRepositoryNodeId && snapshot.headRepositoryNodeId !== expected.expectedHeadRepositoryNodeId) throw new Error('provider_head_repository_moved');
  if (expected.expectedHeadRefName && snapshot.headRefName !== expected.expectedHeadRefName) throw new Error('provider_head_ref_moved');
  if (expected.requireAutomationNull && (snapshot.autoMergeRequest || snapshot.mergeQueueEntry)) throw new Error('provider_automation_active');
  return snapshot;
}

export function parseRequiredChecks(raw: string): RequiredCheck[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('checks_json_invalid'); }
  if (!Array.isArray(value)) throw new Error('checks_json_invalid');
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('checks_row_invalid');
    const row = candidate as Record<string, unknown>;
    if (Object.keys(row).some((key) => !CHECK_FIELDS.has(key)) || Object.keys(row).length !== CHECK_FIELDS.size) {
      throw new Error('checks_field_invalid');
    }
    for (const key of CHECK_FIELDS) if (typeof row[key] !== 'string') throw new Error('checks_field_invalid');
    if (!row.name) throw new Error('checks_row_invalid');
    return row as unknown as RequiredCheck;
  });
}

export function classifyRequiredChecks(rows: RequiredCheck[], options: { timedOut?: boolean } = {}) {
  const passed: string[] = [];
  const pending: string[] = [];
  const blockers: string[] = [];
  for (const row of rows) {
    const state = row.state.toUpperCase();
    const bucket = row.bucket.toLowerCase();
    if (state === 'SUCCESS' || bucket === 'pass' || bucket === 'skipping') passed.push(row.name);
    else if (state === 'PENDING' || ['pending', 'queued'].includes(bucket)) pending.push(row.name);
    else blockers.push(row.name);
  }
  if (options.timedOut && pending.length) blockers.push('required_checks_timeout');
  blockers.sort();
  pending.sort();
  return {
    status: blockers.length ? 'blocked' : pending.length ? 'pending' : 'ready',
    blockerCount: blockers.length,
    pendingCount: pending.length,
    passedCount: passed.length,
    blockerIds: blockers,
    pendingIds: pending,
  };
}

async function run(tool: AccountTool, argv: string[], cwd: string, env: Record<string, string> = {}, input?: string): Promise<string> {
  const command = tool === 'git' ? [argv[0], '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...argv.slice(1)] : argv;
  const child = Bun.spawn(command, { cwd, stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe', env: { ...projectAccountEnvironment(tool), ...env } });
  const [stdout, , status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  // Provider diagnostics may contain credentials loaded from user config.
  if (status !== 0) throw new Error(`provider_child_failed:${status}`);
  return stdout;
}

const ACCESS_QUERY = `query($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){id nameWithOwner viewerPermission pullRequest(number:$number){number state baseRefName baseRefOid headRefName headRefOid headRepository{id nameWithOwner} mergeable mergeStateStatus mergeCommit{oid} autoMergeRequest{enabledAt enabledBy{login}} mergeQueueEntry{id state headOid baseOid groupOid}}}}`;
const SAFETY_PREFLIGHT_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id nameWithOwner viewerPermission defaultBranchRef{name target{... on Commit{oid}}} labels(first:100,query:"ecpe:"){nodes{id name} pageInfo{hasNextPage endCursor}}}}`;

export interface SafetyProviderPreflightSnapshot {
  repoId:string; repositoryNodeId:string; viewerPermission:string; defaultRef:string;
  defaultHeadSha:string; labelNodeIds:Record<string,string>; paginationPermission:boolean;
  cursorHash:string;
}

export async function snapshotSafetyProviderPreflight(cwd:string):Promise<SafetyProviderPreflightSnapshot>{
  const [git,gh]=await Promise.all([resolveInstalledTool('git'),resolveInstalledTool('gh')]);
  const remote=canonicalProviderRemote((await run('git', [git.realpath,'remote','get-url','origin'],cwd)).trim());
  const raw=JSON.parse(await run('github', [gh.realpath,'api','graphql','--hostname',remote.host,'-f',`query=${SAFETY_PREFLIGHT_QUERY}`,'-F',`owner=${remote.owner}`,'-F',`name=${remote.repository}`],cwd))as any;
  const repo=raw?.data?.repository;if(!repo||typeof repo.id!=='string'||typeof repo.nameWithOwner!=='string'||`${remote.host}/${repo.nameWithOwner}`.toLowerCase()!==remote.comparisonKey.toLowerCase()||!permissionSatisfies(String(repo.viewerPermission),'read'))throw new Error('safety_preflight_provider_identity_invalid');
  const defaultRef=repo.defaultBranchRef;if(!defaultRef||typeof defaultRef.name!=='string'||!defaultRef.name||typeof defaultRef.target?.oid!=='string'||!FULL_OID.test(defaultRef.target.oid))throw new Error('safety_preflight_default_ref_invalid');
  const labels=repo.labels;if(!Array.isArray(labels?.nodes)||typeof labels?.pageInfo?.hasNextPage!=='boolean'||(labels.pageInfo.endCursor!==null&&typeof labels.pageInfo.endCursor!=='string'))throw new Error('safety_preflight_pagination_invalid');
  const labelNodeIds:Record<string,string>={};for(const item of labels.nodes){if(!item||typeof item.name!=='string'||typeof item.id!=='string'||!item.id)continue;if(labelNodeIds[item.name]&&labelNodeIds[item.name]!==item.id)throw new Error('safety_preflight_label_ambiguous');labelNodeIds[item.name]=item.id}
  const cursorBody=JSON.stringify({repository_node_id:repo.id,default_ref:defaultRef.name,default_head_sha:defaultRef.target.oid.toLowerCase(),labels_end_cursor:labels.pageInfo.endCursor,labels_has_next_page:labels.pageInfo.hasNextPage,label_node_ids:Object.entries(labelNodeIds).sort()});
  return{repoId:remote.comparisonKey,repositoryNodeId:repo.id,viewerPermission:repo.viewerPermission,defaultRef:defaultRef.name,defaultHeadSha:defaultRef.target.oid.toLowerCase(),labelNodeIds,paginationPermission:labels.pageInfo.hasNextPage===false,cursorHash:new Bun.CryptoHasher('sha256').update(cursorBody).digest('hex')};
}

async function queryProviderRepository(cwd: string, prNumber: number) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error('provider_pr_invalid');
  const [git, gh] = await Promise.all([resolveInstalledTool('git'), resolveInstalledTool('gh')]);
  const remote = canonicalProviderRemote((await run('git', [git.realpath, 'remote', 'get-url', 'origin'], cwd)).trim());
  const response = JSON.parse(await run('github', [
    gh.realpath, 'api', 'graphql', '--hostname', remote.host,
    '-f', `query=${ACCESS_QUERY}`, '-F', `owner=${remote.owner}`, '-F', `name=${remote.repository}`, '-F', `number=${prNumber}`,
  ], cwd)) as { data?: { repository?: Record<string, unknown> } };
  return { git: git.realpath, gh: gh.realpath, remote, repository: response.data?.repository };
}

export async function queryProviderAccess(cwd: string, prNumber: number): Promise<{ remote: ProviderRemote; access: ProviderAccess; gh: string }> {
  const { gh, remote, repository: rawRepository } = await queryProviderRepository(cwd, prNumber);
  const repository = rawRepository as {
    id?: unknown; nameWithOwner?: unknown; viewerPermission?: unknown;
    pullRequest?: { number?: unknown; state?: unknown } | null;
  } | undefined;
  const access = validateProviderAccessSnapshot(remote, prNumber, {
    repository,
    pullRequest: repository?.pullRequest,
  });
  return { remote, access, gh };
}

export async function snapshotProviderHead(cwd: string, prNumber: number, options: { requireLocalHead?: boolean } = {}): Promise<ProviderHeadSnapshot> {
  const resolved = await queryProviderRepository(path.resolve(cwd), prNumber);
  const repository = resolved.repository as Record<string, unknown> | undefined;
  const remote = resolved.remote;
  const access = validateProviderAccessSnapshot(remote, prNumber, {
    repository,
    pullRequest: repository?.pullRequest as { number?: unknown; state?: unknown } | null | undefined,
  });
  const snapshot = validateProviderHeadSnapshot({
    ...access,
    repositorySelector: remote.repositorySelector,
    targetRef: `origin/${(repository?.pullRequest as Record<string, unknown> | undefined)?.baseRefName ?? ''}`,
    pullRequest: (repository?.pullRequest as Record<string, unknown> | undefined) ?? {},
  });
  if (options.requireLocalHead) {
    const localHead = (await run('git', [resolved.git, 'rev-parse', 'HEAD'], cwd)).trim().toLowerCase();
    if (localHead !== snapshot.headRefOid) throw new Error('provider_local_head_mismatch');
  }
  return snapshot;
}

export async function verifyProviderMergeCommit(cwd: string, expected: {
  gitPath: string;
  ghPath: string;
  host: string;
  repositorySelector: string;
  expectedBaseOid: string;
  expectedHeadOid: string;
  mergeSha: string;
}): Promise<{ mergeSha: string; mergeTree: string; mergeParents: [string]; mergeTreeMatches: true }> {
  if (![expected.expectedBaseOid, expected.expectedHeadOid, expected.mergeSha].every((oid) => FULL_OID.test(oid))) {
    throw new Error('provider_oid_invalid');
  }
  if (!path.isAbsolute(expected.gitPath) || !path.isAbsolute(expected.ghPath)) throw new Error('provider_tool_path_invalid');
  const expectedTree = (await run('git', [
    expected.gitPath, 'rev-parse', '--verify', `${expected.expectedHeadOid}^{tree}`,
  ], cwd)).trim().toLowerCase();
  if (!FULL_OID.test(expectedTree)) throw new Error('provider_head_tree_invalid');
  const raw = await run('github', [
    expected.ghPath, 'api', '--hostname', expected.host,
    `repos/${expected.repositorySelector}/git/commits/${expected.mergeSha}`,
  ], cwd);
  let commit: { sha?: unknown; tree?: { sha?: unknown }; parents?: Array<{ sha?: unknown }> };
  try { commit = JSON.parse(raw); } catch { throw new Error('provider_merge_commit_invalid'); }
  if (commit.sha !== expected.mergeSha || !Array.isArray(commit.parents) || commit.parents.length !== 1) {
    throw new Error('provider_merge_commit_invalid');
  }
  if (commit.parents[0]?.sha?.toString().toLowerCase() !== expected.expectedBaseOid.toLowerCase()) {
    throw new Error('base_race_detected');
  }
  if (commit.tree?.sha?.toString().toLowerCase() !== expectedTree) throw new Error('provider_merge_tree_mismatch');
  return { mergeSha: expected.mergeSha.toLowerCase(), mergeTree: expectedTree, mergeParents: [expected.expectedBaseOid.toLowerCase()], mergeTreeMatches: true };
}

export interface DirectMergeProviderResult {
  status: 'merged'; mergeSha: string; expectedHeadOid: string; expectedBaseOid: string;
  intentId: string; baseAtomicity: 'verified'; recovered?: true;
}

export type DirectMergeReconciliation = DirectMergeProviderResult
  | { status: 'absent' }
  | { status: 'unresolved_open'; intentId: string }
  | { status: 'terminal'; intentId: string; providerState: string };

export function resolveProviderLandingIntentRoot(): string {
  return path.resolve(process.env.GSTACK_AUTHORITY_ROOT
    ?? path.join(process.env.HOME || os.homedir(), '.gstack', 'authority', 'landing-intents'));
}

async function reconcileExistingDirectMerge(cwd: string, expected: {
  prNumber: number;
  expectedHeadOid: string;
  expectedBaseOid: string;
  expectedTargetRef: string;
  expectedRepositoryNodeId: string;
}, remote: ProviderRemote, existing: ReturnType<typeof inspectLandingIntentForDescriptor>): Promise<DirectMergeReconciliation> {
  if (!existing) return { status: 'absent' };
  if (existing.phase === 'checkpointed') {
    const mergeSha = existing.result?.mergeSha;
    if (existing.result?.status !== 'checkpointed' || typeof mergeSha !== 'string' || !FULL_OID.test(mergeSha)) throw new Error('provider_landing_checkpoint_invalid');
    return { status: 'merged', mergeSha, expectedHeadOid: existing.expectedHeadOid, expectedBaseOid: existing.expectedBaseOid, intentId: existing.intentId, baseAtomicity: 'verified', recovered: true };
  }
  if (existing.phase !== 'prepared') return { status: 'terminal', intentId: existing.intentId, providerState: existing.phase };

  const queried = await queryProviderRepository(path.resolve(cwd), expected.prNumber);
  const repository = queried.repository as Record<string, unknown> | undefined;
  const pr = repository?.pullRequest as Record<string, unknown> | undefined;
  const returnedKey = typeof repository?.nameWithOwner === 'string' ? `${remote.host}/${repository.nameWithOwner}` : '';
  const canonicalReturnedKey = remote.host === 'github.com' ? returnedKey.toLowerCase() : returnedKey;
  if (repository?.id !== expected.expectedRepositoryNodeId || canonicalReturnedKey !== remote.comparisonKey || !permissionSatisfies(String(repository?.viewerPermission), 'read') || pr?.number !== expected.prNumber || String(pr?.headRefOid).toLowerCase() !== expected.expectedHeadOid.toLowerCase() || `origin/${pr?.baseRefName}` !== expected.expectedTargetRef) throw new Error('provider_landing_recovery_mismatch');
  if (pr.state === 'OPEN') return { status: 'unresolved_open', intentId: existing.intentId };
  if (pr.state !== 'MERGED') return { status: 'terminal', intentId: existing.intentId, providerState: String(pr.state) };
  const mergeSha = (pr.mergeCommit as Record<string, unknown> | undefined)?.oid;
  if (typeof mergeSha !== 'string' || !FULL_OID.test(mergeSha)) throw new Error('provider_merge_commit_invalid');
  const verified = await verifyProviderMergeCommit(cwd, { gitPath: queried.git, ghPath: queried.gh, host: remote.host, repositorySelector: remote.repositorySelector, expectedBaseOid: expected.expectedBaseOid, expectedHeadOid: expected.expectedHeadOid, mergeSha: mergeSha.toLowerCase() });
  const checkpoint = reconcileLandingIntent(resolveProviderLandingIntentRoot(), existing.intentId, { terminal: false, providerState: 'merged', headOid: expected.expectedHeadOid, baseOid: expected.expectedBaseOid, mergeSha: verified.mergeSha, mergeTree: verified.mergeTree, mergeParents: verified.mergeParents, mergeTreeMatches: true });
  if (checkpoint.status !== 'checkpointed') throw new Error('provider_landing_checkpoint_failed');
  return { status: 'merged', mergeSha: verified.mergeSha, expectedHeadOid: expected.expectedHeadOid, expectedBaseOid: expected.expectedBaseOid, intentId: existing.intentId, baseAtomicity: 'verified', recovered: true };
}

async function directMergeContext(cwd: string, expected: {
  prNumber: number;
  expectedHeadOid: string;
  expectedBaseOid: string;
  expectedTargetRef: string;
  expectedRepositoryNodeId: string;
}) {
  const resolved=await resolveDirectMergeLandingIntent(cwd,expected);
  return { authorityRoot: resolveProviderLandingIntentRoot(), remote:resolved.remote, descriptor:resolved.descriptor };
}

export async function resolveDirectMergeLandingIntent(cwd:string,expected:{prNumber:number;expectedHeadOid:string;expectedBaseOid:string;expectedTargetRef:string;expectedRepositoryNodeId:string}){if(!expected.expectedRepositoryNodeId)throw new Error('provider_repository_node_required');const gitTool=await resolveInstalledTool('git');const remote=canonicalProviderRemote((await run('git', [gitTool.realpath,'remote','get-url','origin'],cwd)).trim());const descriptor:LandingIntentDescriptor={repoId:remote.comparisonKey,repositoryNodeId:expected.expectedRepositoryNodeId,prNumber:expected.prNumber,expectedHeadOid:expected.expectedHeadOid,expectedBaseOid:expected.expectedBaseOid,targetRef:expected.expectedTargetRef,mode:'direct_observed',providerOperationId:`${remote.host}:direct-pr:${expected.prNumber}`};return{remote,descriptor,intentId:landingIntentIdForDescriptor(descriptor)}}

export async function discoverDirectMergeProviderHead(cwd:string,prNumber:number){
  if(!Number.isSafeInteger(prNumber)||prNumber<=0)throw new Error('provider_pr_invalid');
  const gitTool=await resolveInstalledTool('git');
  const remote=canonicalProviderRemote((await run('git', [gitTool.realpath,'remote','get-url','origin'],cwd)).trim());
  const record=inspectLandingIntentForPr(resolveProviderLandingIntentRoot(),{prNumber,repoId:remote.comparisonKey,providerOperationId:`${remote.host}:direct-pr:${prNumber}`});
  if(!record)return{status:'absent' as const,prNumber};
  if(record.repoId!==remote.comparisonKey||record.providerOperationId!==`${remote.host}:direct-pr:${prNumber}`)throw new Error('provider_remote_moved');
  const expected={prNumber,expectedHeadOid:record.expectedHeadOid,expectedBaseOid:record.expectedBaseOid,expectedTargetRef:record.targetRef,expectedRepositoryNodeId:record.repositoryNodeId};
  const reconciliation=await reconcileDirectMergeProviderHead(cwd,expected);
  return{...reconciliation,prNumber,expectedHeadOid:record.expectedHeadOid,expectedBaseOid:record.expectedBaseOid,expectedTargetRef:record.targetRef,expectedRepositoryNodeId:record.repositoryNodeId,intentId:record.intentId};
}

export async function reconcileDirectMergeProviderHead(cwd: string, expected: {
  prNumber: number;
  expectedHeadOid: string;
  expectedBaseOid: string;
  expectedTargetRef: string;
  expectedRepositoryNodeId: string;
}): Promise<DirectMergeReconciliation> {
  const context = await directMergeContext(cwd, expected);
  const ownerTarget = path.join(context.authorityRoot, '.owners', landingIntentIdForDescriptor(context.descriptor));
  const owned = acquireDurableOwnerLock(ownerTarget, 'provider_landing_owner_busy');
  try {
    return await reconcileExistingDirectMerge(cwd, expected, context.remote, inspectLandingIntentForDescriptor(context.authorityRoot, context.descriptor));
  } finally {
    releaseDurableOwnerLock(owned);
  }
}

export async function directMergeProviderHead(cwd: string, expected: {
  prNumber: number;
  expectedHeadOid: string;
  expectedBaseOid: string;
  expectedTargetRef: string;
  expectedRepositoryNodeId: string;
  requireLocalHead?: boolean;
}): Promise<DirectMergeProviderResult> {
  const { authorityRoot, remote, descriptor } = await directMergeContext(cwd, expected);
  const ownerTarget = path.join(authorityRoot, '.owners', landingIntentIdForDescriptor(descriptor));
  const owned = acquireDurableOwnerLock(ownerTarget, 'provider_landing_owner_busy');
  try {
    const existing = inspectLandingIntentForDescriptor(authorityRoot, descriptor);
    if (existing) {
      const recovery = await reconcileExistingDirectMerge(cwd, expected, remote, existing);
      if (recovery.status === 'merged') return recovery;
      if (recovery.status === 'unresolved_open') throw new Error('provider_landing_recovery_open');
      throw new Error('provider_landing_terminal');
    }
  const snapshot = assertProviderHeadSnapshot(await snapshotProviderHead(cwd, expected.prNumber, {
    requireLocalHead: expected.requireLocalHead,
  }), { ...expected, requireAutomationNull: true });
  if (!permissionSatisfies(snapshot.viewerPermission, 'merge')) throw new Error('provider_permission_missing');
  if (snapshot.mergeable !== 'MERGEABLE' || snapshot.mergeStateStatus !== 'CLEAN') throw new Error('provider_merge_not_ready');
  const finalQuery = await queryProviderRepository(path.resolve(cwd), expected.prNumber);
  const { git, gh } = finalQuery;
  const finalRepository = finalQuery.repository as Record<string, unknown> | undefined;
  if (finalQuery.remote.comparisonKey !== remote.comparisonKey || finalQuery.remote.repositorySelector !== remote.repositorySelector) throw new Error('provider_remote_moved');
  const finalAccess = validateProviderAccessSnapshot(finalQuery.remote, expected.prNumber, {
    repository: finalRepository,
    pullRequest: finalRepository?.pullRequest as { number?: unknown; state?: unknown } | null | undefined,
  });
  const finalSnapshot = assertProviderHeadSnapshot(validateProviderHeadSnapshot({
    ...finalAccess,
    repositorySelector: finalQuery.remote.repositorySelector,
    targetRef: `origin/${(finalRepository?.pullRequest as Record<string, unknown> | undefined)?.baseRefName ?? ''}`,
    pullRequest: (finalRepository?.pullRequest as Record<string, unknown> | undefined) ?? {},
  }), {
    ...expected,
    expectedHeadRepositoryNodeId: snapshot.headRepositoryNodeId,
    expectedHeadRefName: snapshot.headRefName,
    requireAutomationNull: true,
  });
  if (!permissionSatisfies(finalSnapshot.viewerPermission, 'merge')) throw new Error('provider_permission_missing');
  if (finalSnapshot.mergeable !== 'MERGEABLE' || finalSnapshot.mergeStateStatus !== 'CLEAN') throw new Error('provider_merge_not_ready');
  await assertBaseContained(cwd, snapshot.baseRefOid, snapshot.headRefOid, git);
  const intent = prepareLandingIntent(authorityRoot, descriptor);
  if(intent.intentId!==landingIntentIdForDescriptor(descriptor))throw new Error('provider_landing_intent_mismatch');
  const body = JSON.stringify({ sha: snapshot.headRefOid, merge_method: 'squash', merge_action: 'direct_merge' });
  const raw = await run('github', [
    gh, 'api', '--hostname', finalQuery.remote.host, '--method', 'PUT',
    '-H', 'X-GitHub-Api-Version: 2026-03-10',
    `repos/${snapshot.repositorySelector}/pulls/${expected.prNumber}/merge`, '--input', '-',
  ], cwd, {}, body);
  const result = JSON.parse(raw) as { merged?: unknown; sha?: unknown; message?: unknown };
  if (result.merged !== true || typeof result.sha !== 'string' || !FULL_OID.test(result.sha)) throw new Error('provider_direct_merge_failed');
  const verified = await verifyProviderMergeCommit(cwd, {
    gitPath: git,
    ghPath: gh,
    host: finalQuery.remote.host,
    repositorySelector: snapshot.repositorySelector,
    expectedBaseOid: snapshot.baseRefOid,
    expectedHeadOid: snapshot.headRefOid,
    mergeSha: result.sha.toLowerCase(),
  });
  const checkpoint = reconcileLandingIntent(authorityRoot, intent.intentId, {
    terminal: false,
    providerState: 'merged',
    headOid: snapshot.headRefOid,
    baseOid: snapshot.baseRefOid,
    mergeSha: verified.mergeSha,
    mergeTree: verified.mergeTree,
    mergeParents: verified.mergeParents,
    mergeTreeMatches: verified.mergeTreeMatches,
  });
  if (checkpoint.status !== 'checkpointed') throw new Error('provider_landing_checkpoint_failed');
  return {
    status: 'merged',
    mergeSha: verified.mergeSha,
    expectedHeadOid: snapshot.headRefOid,
    expectedBaseOid: snapshot.baseRefOid,
    intentId: intent.intentId,
    baseAtomicity: 'verified',
  };
  } finally {
    releaseDurableOwnerLock(owned);
  }
}

export interface ProviderMergedSnapshot {
  providerState: 'MERGED'; repositoryNameWithOwner: string; repositoryNodeId: string;
  headRepositoryNameWithOwner: string; headRepositoryNodeId: string; headRefName: string;
  targetRef: string; expectedHeadOid: string; expectedBaseOid: string; mergeSha: string;
  mergeTree: string; liveTargetOid: string; baseParentVerified: true; headTreeVerified: true;
  liveTargetVerified: true;
}

export async function snapshotMergedProviderLanding(cwd: string, expected: {
  prNumber: number; expectedHeadOid: string; expectedBaseOid: string; expectedTargetRef: string;
  expectedRepositoryNodeId: string; expectedHeadRepositoryNodeId: string; expectedHeadRefName: string;
  expectedHeadTree: string; mergeSha: string;
}): Promise<ProviderMergedSnapshot> {
  if (!Number.isSafeInteger(expected.prNumber) || expected.prNumber <= 0 ||
    ![expected.expectedHeadOid, expected.expectedBaseOid, expected.expectedHeadTree, expected.mergeSha].every(value => FULL_OID.test(value)) ||
    !/^origin\/[A-Za-z0-9._/-]+$/.test(expected.expectedTargetRef) || expected.expectedTargetRef.includes('..')) throw new Error('provider_merged_expectation_invalid');
  const queried = await queryProviderRepository(path.resolve(cwd), expected.prNumber);
  const repository = queried.repository as Record<string, unknown> | undefined;
  const pr = repository?.pullRequest as Record<string, unknown> | undefined;
  const returnedKey = typeof repository?.nameWithOwner === 'string' ? `${queried.remote.host}/${repository.nameWithOwner}` : '';
  const canonicalReturnedKey = queried.remote.host === 'github.com' ? returnedKey.toLowerCase() : returnedKey;
  const headRepository = pr?.headRepository as Record<string, unknown> | undefined;
  const mergeSha = (pr?.mergeCommit as Record<string, unknown> | undefined)?.oid;
  if (repository?.id !== expected.expectedRepositoryNodeId || canonicalReturnedKey !== queried.remote.comparisonKey ||
    !permissionSatisfies(String(repository?.viewerPermission), 'read') || pr?.number !== expected.prNumber || pr.state !== 'MERGED' ||
    typeof pr.headRefOid !== 'string' || pr.headRefOid.toLowerCase() !== expected.expectedHeadOid.toLowerCase() ||
    pr.headRefName !== expected.expectedHeadRefName || `origin/${String(pr.baseRefName)}` !== expected.expectedTargetRef ||
    headRepository?.id !== expected.expectedHeadRepositoryNodeId || typeof headRepository.nameWithOwner !== 'string' ||
    typeof mergeSha !== 'string' || mergeSha.toLowerCase() !== expected.mergeSha.toLowerCase()) throw new Error('provider_merged_snapshot_mismatch');
  const verified = await verifyProviderMergeCommit(cwd, { gitPath: queried.git, ghPath: queried.gh, host: queried.remote.host,
    repositorySelector: queried.remote.repositorySelector, expectedBaseOid: expected.expectedBaseOid,
    expectedHeadOid: expected.expectedHeadOid, mergeSha: expected.mergeSha.toLowerCase() });
  if (verified.mergeTree !== expected.expectedHeadTree.toLowerCase()) throw new Error('provider_merge_tree_mismatch');
  const targetName = expected.expectedTargetRef.replace(/^origin\//, '').split('/').map(encodeURIComponent).join('/');
  const rawTarget = await run('github', [queried.gh, 'api', '--hostname', queried.remote.host,
    `repos/${queried.remote.repositorySelector}/git/ref/heads/${targetName}`], cwd);
  let target: { ref?: unknown; object?: { type?: unknown; sha?: unknown } };
  try { target = JSON.parse(rawTarget); } catch { throw new Error('provider_merged_target_invalid'); }
  const liveTargetOid = target.object?.sha;
  if (target.ref !== `refs/heads/${expected.expectedTargetRef.replace(/^origin\//, '')}` || target.object?.type !== 'commit' ||
    typeof liveTargetOid !== 'string' || !FULL_OID.test(liveTargetOid)) throw new Error('provider_merged_target_invalid');
  if (liveTargetOid.toLowerCase() !== expected.mergeSha.toLowerCase()) throw new Error('provider_merged_target_moved');
  return {
    providerState: 'MERGED', repositoryNameWithOwner: repository.nameWithOwner as string,
    repositoryNodeId: expected.expectedRepositoryNodeId, headRepositoryNameWithOwner: headRepository.nameWithOwner as string,
    headRepositoryNodeId: expected.expectedHeadRepositoryNodeId, headRefName: expected.expectedHeadRefName,
    targetRef: expected.expectedTargetRef, expectedHeadOid: expected.expectedHeadOid.toLowerCase(),
    expectedBaseOid: expected.expectedBaseOid.toLowerCase(), mergeSha: expected.mergeSha.toLowerCase(),
    mergeTree: verified.mergeTree, liveTargetOid: liveTargetOid.toLowerCase(), baseParentVerified: true,
    headTreeVerified: true, liveTargetVerified: true,
  };
}

export async function snapshotRequiredChecks(cwd: string, prNumber: number) {
  const { remote, access, gh } = await queryProviderAccess(path.resolve(cwd), prNumber);
  const raw = await run('github', [
    gh, 'pr', 'checks', String(prNumber), '--repo', remote.repositorySelector,
    '--required', '--json', 'name,state,bucket,link,workflow',
  ], cwd);
  const checks = parseRequiredChecks(raw);
  return { ...access, repositorySelector: remote.repositorySelector, checks, summary: classifyRequiredChecks(checks) };
}
