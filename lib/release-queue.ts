import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import * as path from 'node:path';
import { userInfo } from 'node:os';
import { canonicalProviderRemote, permissionSatisfies } from "./provider-access";
import { resolveInstalledTool } from "./toolchain-policy";
import { extractReleaseProjection, type ReleaseProjection } from "./release-policy";
import { parseVersion } from "./version-source";
export type ClaimedPR = { pr: number; branch: string; version: string; url?: string };
function runCommand(cmd: string, args: string[], timeout = 15000) {
  const child = spawnSync(cmd, args, { encoding: "utf8", timeout, env: { PATH: "/usr/bin:/bin", HOME: userInfo().homedir, LC_ALL: "C", ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(GH_|GITHUB_)/.test(key))) } });
  return { ok: child.status === 0 && !child.error, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}
export function canonicalGithubRemote(cwd = process.cwd()): { hostname: string; slug: string; selector: string; owner: string; repository: string } {
  const remote = spawnSync('/usr/bin/git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  if (remote.status !== 0) throw new Error('release_queue_unknown');
  let parsed;
  try { parsed = canonicalProviderRemote(remote.stdout.trim()); } catch { throw new Error('release_queue_unknown'); }
  if (parsed.host !== 'github.com') throw new Error('release_queue_unknown');
  return {
    hostname: parsed.host,
    slug: `${parsed.owner}/${parsed.repository}`,
    selector: `${parsed.host}/${parsed.owner}/${parsed.repository}`,
    owner: parsed.owner,
    repository: parsed.repository,
  };
}

export async function trustedGithubTool(allowTestExecutable = false): Promise<string> {
  if (allowTestExecutable && process.env.ECPE_TESTING === '1' && process.env.ECPE_TEST_GH_PATH) {
    const requested = process.env.ECPE_TEST_GH_PATH;
    if (!requested.startsWith('/')) throw new Error('release_queue_unknown');
    const canonical = realpathSync(requested);
    const info = lstatSync(canonical);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) throw new Error('release_queue_unknown');
    return canonical;
  }
  const moduleRoot = path.basename(import.meta.dir) === 'authority' && path.basename(path.dirname(import.meta.dir)) === 'dist'
    ? path.resolve(import.meta.dir, '..', '..') : path.resolve(import.meta.dir, '..');
  try { return (await resolveInstalledTool('gh', allowTestExecutable ? {} : { manifestPath: path.join(moduleRoot, '.ecpe-installed-runtime.json') })).realpath; }
  catch { throw new Error('release_queue_unknown'); }
}

const TRUSTED_QUEUE_QUERY = `query($owner:String!,$name:String!,$qualifiedBase:String!,$after:String){repository(owner:$owner,name:$name){id nameWithOwner viewerPermission ref(qualifiedName:$qualifiedBase){target{... on Commit{oid}}} pullRequests(first:100,after:$after,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number baseRefName headRefName headRefOid headRepository{id nameWithOwner} url isDraft} pageInfo{hasNextPage endCursor}}}}`;
const TRUSTED_REFS_QUERY = `query($owner:String!,$name:String!,$qualifiedBase:String!,$after:String){repository(owner:$owner,name:$name){id nameWithOwner viewerPermission ref(qualifiedName:$qualifiedBase){target{... on Commit{oid}}} refs(refPrefix:"refs/heads/",first:100,after:$after,orderBy:{field:ALPHABETICAL,direction:ASC}){nodes{name target{... on Commit{oid}}} pageInfo{hasNextPage endCursor}}}}`;
export type CurrentPrIdentity = { number: number; base_oid: string; head_oid: string; head_repository_node_id: string; head_ref: string };
export type ExactSelfClaim = {
  identity: CurrentPrIdentity;
  repository_node_id: string;
  version: string;
  claimed: ClaimedPR[];
  snapshot: string;
};
export type TrustedReleaseQueue = {
  claimed: ClaimedPR[];
  snapshot: string;
  currentPrIdentity: CurrentPrIdentity | null;
  possibleSelfClaim: boolean;
  exactSelfClaim: ExactSelfClaim | null;
  unresolvedSelfClaim: boolean;
};

export function fetchTrustedGithubClaimed(
  ghPath: string,
  base: string,
  projection: ReleaseProjection,
  expectedTargetSha: string,
  subjectSha: string,
  subjectRef: string,
  expected: { hostname: string; slug: string; selector: string; owner: string; repository: string },
): TrustedReleaseQueue {
  const rows: Array<{ number?: unknown; baseRefName?: unknown; headRefName?: unknown; headRefOid?: unknown; headRepository?: { id?: unknown; nameWithOwner?: unknown } | null; url?: unknown; isDraft?: unknown }> = [];
  let repositoryId = '';
  let cursor: string | null = null;
  let page = 0;
  const seenPrNumbers = new Set<number>();
  do {
    page += 1;
    if (page > 20) throw new Error('release_queue_unknown');
    const args = ['api', 'graphql', '--hostname', expected.hostname, '-f', `query=${TRUSTED_QUEUE_QUERY}`, '-F', `owner=${expected.owner}`, '-F', `name=${expected.repository}`, '-F', `qualifiedBase=refs/heads/${base}`];
    if (cursor !== null) args.push('-F', `after=${cursor}`);
    const queried = runCommand(ghPath, args, 30_000);
    if (!queried.ok) throw new Error('release_queue_unknown');
    let response: any;
    try { response = JSON.parse(queried.stdout); } catch { throw new Error('release_queue_unknown'); }
    if (response?.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0)) throw new Error('release_queue_unknown');
    const repository = response?.data?.repository;
    const connection = repository?.pullRequests;
    const pageInfo = connection?.pageInfo;
    const liveTargetSha = repository?.ref?.target?.oid;
    const comparisonKey = `${expected.hostname}/${String(repository?.nameWithOwner ?? '')}`;
    if (typeof repository?.id !== 'string' || !repository.id || comparisonKey.toLowerCase() !== `${expected.hostname}/${expected.slug}`.toLowerCase() || !permissionSatisfies(String(repository.viewerPermission), 'read')) throw new Error('release_queue_unknown');
    if (!/^[0-9a-f]{40}$/i.test(String(liveTargetSha)) || String(liveTargetSha).toLowerCase() !== expectedTargetSha.toLowerCase()) throw new Error('release_queue_drift');
    if (repositoryId && repositoryId !== repository.id) throw new Error('release_queue_unknown');
    repositoryId = repository.id;
    if (!Array.isArray(connection?.nodes) || typeof pageInfo?.hasNextPage !== 'boolean' || (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== 'string')) throw new Error('release_queue_unknown');
    for (const node of connection.nodes) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || !Number.isSafeInteger(node.number) || seenPrNumbers.has(node.number)) throw new Error('release_queue_unknown');
      seenPrNumbers.add(node.number);
      rows.push(node);
    }
    if (rows.length > 2000) throw new Error('release_queue_unknown');
    if (!pageInfo.hasNextPage) { cursor = null; break; }
    if (!pageInfo.endCursor || pageInfo.endCursor === cursor) throw new Error('release_queue_unknown');
    cursor = pageInfo.endCursor;
  } while (cursor !== null);

  const referenceRows: Array<{ name: string; oid: string }> = [];
  const seenReferenceNames = new Set<string>();
  cursor = null;
  page = 0;
  do {
    page += 1;
    if (page > 20) throw new Error('release_queue_unknown');
    const args = ['api', 'graphql', '--hostname', expected.hostname, '-f', `query=${TRUSTED_REFS_QUERY}`, '-F', `owner=${expected.owner}`, '-F', `name=${expected.repository}`, '-F', `qualifiedBase=refs/heads/${base}`];
    if (cursor !== null) args.push('-F', `after=${cursor}`);
    const queried = runCommand(ghPath, args, 30_000);
    if (!queried.ok) throw new Error('release_queue_unknown');
    let response: any;
    try { response = JSON.parse(queried.stdout); } catch { throw new Error('release_queue_unknown'); }
    if (response?.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0)) throw new Error('release_queue_unknown');
    const repository = response?.data?.repository;
    const connection = repository?.refs;
    const pageInfo = connection?.pageInfo;
    const liveTargetSha = repository?.ref?.target?.oid;
    const comparisonKey = `${expected.hostname}/${String(repository?.nameWithOwner ?? '')}`;
    if (repository?.id !== repositoryId || comparisonKey.toLowerCase() !== `${expected.hostname}/${expected.slug}`.toLowerCase() || !permissionSatisfies(String(repository?.viewerPermission), 'read')) throw new Error('release_queue_unknown');
    if (!/^[0-9a-f]{40}$/i.test(String(liveTargetSha)) || String(liveTargetSha).toLowerCase() !== expectedTargetSha.toLowerCase()) throw new Error('release_queue_drift');
    if (!Array.isArray(connection?.nodes) || typeof pageInfo?.hasNextPage !== 'boolean' || (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== 'string')) throw new Error('release_queue_unknown');
    for (const node of connection.nodes) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.name !== 'string' || !node.name || typeof node.target?.oid !== 'string' || !/^[0-9a-f]{40}$/i.test(node.target.oid) || seenReferenceNames.has(node.name)) throw new Error('release_queue_unknown');
      seenReferenceNames.add(node.name);
      referenceRows.push({ name: node.name, oid: node.target.oid.toLowerCase() });
    }
    if (referenceRows.length > 2000) throw new Error('release_queue_unknown');
    if (!pageInfo.hasNextPage) { cursor = null; break; }
    if (!pageInfo.endCursor || pageInfo.endCursor === cursor) throw new Error('release_queue_unknown');
    cursor = pageInfo.endCursor;
  } while (cursor !== null);

  const claims: ClaimedPR[] = [];
  const snapshotRows: unknown[] = [];
  const snapshotRefs: unknown[] = [];
  let currentPrIdentity: CurrentPrIdentity | null = null;
  let possibleSelfClaim = false;
  for (const row of rows) {
    const head = row.headRepository;
    if (!Number.isSafeInteger(row.number) || typeof row.baseRefName !== 'string' || typeof row.headRefName !== 'string' || typeof row.headRefOid !== 'string' || !/^[0-9a-f]{40}$/i.test(row.headRefOid) || !head || typeof head.id !== 'string' || typeof head.nameWithOwner !== 'string' || typeof row.url !== 'string' || typeof row.isDraft !== 'boolean') throw new Error('release_queue_unknown');
    const overlapsSubject = row.headRefOid.toLowerCase() === subjectSha.toLowerCase()
      || (head.id === repositoryId && row.headRefName === subjectRef);
    const exactCurrentPr = head.id === repositoryId
      && row.baseRefName === base
      && row.headRefName === subjectRef
      && row.headRefOid.toLowerCase() === subjectSha.toLowerCase();
    if (overlapsSubject) possibleSelfClaim = true;
    if (row.baseRefName !== base) {
      snapshotRows.push({ number: row.number, baseRefName: row.baseRefName, headRefName: row.headRefName, headRefOid: row.headRefOid.toLowerCase(), headRepositoryId: head.id, headRepository: head.nameWithOwner, version: null, isDraft: row.isDraft });
      continue;
    }
    const content = runCommand(ghPath, [
      'api', '--hostname', expected.hostname, '--method', 'GET',
      `repos/${head.nameWithOwner}/contents/${projection.path.split('/').map(encodeURIComponent).join('/')}`,
      '-f', `ref=${row.headRefOid}`,
    ]);
    if (!content.ok) throw new Error('release_queue_unknown');
    let payload: { content?: unknown; encoding?: unknown };
    try { payload = JSON.parse(content.stdout); } catch { throw new Error('release_queue_unknown'); }
    if (payload.encoding !== 'base64' || typeof payload.content !== 'string') throw new Error('release_queue_unknown');
    let version: string;
    try { version = extractReleaseProjection(Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8'), projection); } catch { throw new Error('release_queue_unknown'); }
    if (!parseVersion(version)) throw new Error('release_queue_unknown');
    claims.push({ pr: row.number as number, branch: row.headRefName, version, url: row.url });
    snapshotRows.push({ number: row.number, baseRefName: row.baseRefName, headRefName: row.headRefName, headRefOid: row.headRefOid.toLowerCase(), headRepositoryId: head.id, headRepository: head.nameWithOwner, version, isDraft: row.isDraft });
    if (exactCurrentPr) {
      if (currentPrIdentity) throw new Error('release_queue_unknown');
      currentPrIdentity = { number: row.number as number, base_oid: expectedTargetSha.toLowerCase(), head_oid: row.headRefOid.toLowerCase(), head_repository_node_id: head.id, head_ref: row.headRefName };
    }
  }
  for (const reference of referenceRows) {
    if (reference.name === base) continue;
    if (reference.name === subjectRef || reference.oid === subjectSha.toLowerCase()) {
      possibleSelfClaim = true;
    }
    const content = runCommand(ghPath, [
      'api', '--hostname', expected.hostname, '--method', 'GET',
      `repos/${expected.slug}/contents/${projection.path.split('/').map(encodeURIComponent).join('/')}`,
      '-f', `ref=${reference.oid}`,
    ]);
    if (!content.ok) throw new Error('release_queue_unknown');
    let payload: { content?: unknown; encoding?: unknown };
    try { payload = JSON.parse(content.stdout); } catch { throw new Error('release_queue_unknown'); }
    if (payload.encoding !== 'base64' || typeof payload.content !== 'string') throw new Error('release_queue_unknown');
    let version: string;
    try { version = extractReleaseProjection(Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8'), projection); } catch { throw new Error('release_queue_unknown'); }
    if (!parseVersion(version)) throw new Error('release_queue_unknown');
    claims.push({ pr: 0, branch: `origin/${reference.name}`, version });
    snapshotRefs.push({ name: reference.name, oid: reference.oid, version });
  }
  snapshotRows.sort((left: any, right: any) => left.number - right.number);
  claims.sort((left, right) => left.pr - right.pr);
  snapshotRefs.sort((left: any, right: any) => left.name.localeCompare(right.name));
  const snapshot = JSON.stringify({ repositoryId, repository: expected.slug.toLowerCase(), base, targetSha: expectedTargetSha.toLowerCase(), rows: snapshotRows, refs: snapshotRefs });
  let exactSelfClaim: ExactSelfClaim | null = null;
  let unresolvedSelfClaim = possibleSelfClaim;
  if (currentPrIdentity) {
    const exactRows = snapshotRows.filter((row: any) => row.number === currentPrIdentity!.number && row.baseRefName === base && row.headRefName === currentPrIdentity!.head_ref && row.headRefOid === currentPrIdentity!.head_oid && row.headRepositoryId === repositoryId);
    const exactRefs = snapshotRefs.filter((row: any) => row.name === currentPrIdentity!.head_ref && row.oid === currentPrIdentity!.head_oid);
    const exactClaims = claims.filter(row => (row.pr === currentPrIdentity!.number && row.branch === currentPrIdentity!.head_ref) || (row.pr === 0 && row.branch === `origin/${currentPrIdentity!.head_ref}`));
    const version = exactRows.length === 1 && typeof (exactRows[0] as any).version === 'string' ? (exactRows[0] as any).version as string : null;
    const residualOverlap = snapshotRows.some((row: any) => !exactRows.includes(row) && (row.headRefOid === currentPrIdentity!.head_oid || (row.headRepositoryId === repositoryId && row.headRefName === currentPrIdentity!.head_ref)))
      || snapshotRefs.some((row: any) => !exactRefs.includes(row) && (row.name === currentPrIdentity!.head_ref || row.oid === currentPrIdentity!.head_oid));
    const exactClaimVersions = new Set(exactClaims.map(row => row.version));
    if (exactRows.length === 1 && exactRefs.length === 1 && exactClaims.length === 2 && version && exactClaimVersions.size === 1 && exactClaimVersions.has(version) && !residualOverlap) {
      const keptRows = snapshotRows.filter(row => !exactRows.includes(row));
      const keptRefs = snapshotRefs.filter(row => !exactRefs.includes(row));
      const keptClaims = claims.filter(row => !exactClaims.includes(row));
      exactSelfClaim = {
        identity: currentPrIdentity,
        repository_node_id: repositoryId,
        version,
        claimed: keptClaims,
        snapshot: JSON.stringify({ repositoryId, repository: expected.slug.toLowerCase(), base, targetSha: expectedTargetSha.toLowerCase(), rows: keptRows, refs: keptRefs }),
      };
      unresolvedSelfClaim = false;
    }
  }
  return { claimed: claims, currentPrIdentity, possibleSelfClaim, exactSelfClaim, unresolvedSelfClaim, snapshot };
}
