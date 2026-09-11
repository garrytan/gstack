import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalAssertionPath, issueGrant, ProcessLocalGrant, type EffectGrant } from './effect-scope';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from './durable-owner-lock';
import { durableAtomicWrite, readDurableAtomic } from './durable-atomic-write';
import { resolveRuntimeStateRoot } from './canonical-state-root';
import { resolveInstalledTool } from './toolchain-policy';

type FileState = { kind: 'file' | 'link' | 'directory'; mode: number; sha256: string };
type Snapshot = { head_oid: string; head_ref: string; index_sha256: string; files: Record<string, FileState> };
interface Lease {
  schema: 'ecpe.document-release-lease.v1';
  repository_root: string;
  task_id: string;
  paths: string[];
  grant: EffectGrant;
  preimage: Snapshot;
  preimage_sha256: string;
  expires_at: string;
  status: 'pending' | 'consumed';
}
const sha = (value: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
const digest = (value: unknown) => sha(JSON.stringify(value));
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function git(executable: string, cwd: string, args: string[], allowMissing = false): string {
  const child = Bun.spawnSync([executable, '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (child.exitCode !== 0 && !(allowMissing && child.exitCode === 1)) throw new Error('document_release_git_read_failed');
  return child.stdout.toString();
}

function safePath(root: string, relative: string, document = false): FileState | null {
  const parts = relative.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let info: fs.Stats;
    try { info = fs.lstatSync(current); }
    catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
    const last = i === parts.length - 1;
    if (!last) {
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('document_release_path_unsafe');
      continue;
    }
    if (document && (!info.isFile() || info.nlink !== 1)) throw new Error('document_release_path_unsafe');
    if (info.isSymbolicLink()) return { kind: 'link', mode: info.mode & 0o777, sha256: sha(fs.readlinkSync(current)) };
    if (info.isDirectory()) return { kind: 'directory', mode: info.mode & 0o777, sha256: sha('directory') };
    if (!info.isFile()) throw new Error('document_release_path_unsafe');
    const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const actual = fs.fstatSync(fd);
      if (!actual.isFile() || actual.ino !== info.ino || actual.dev !== info.dev) throw new Error('document_release_path_unsafe');
      return { kind: 'file', mode: info.mode & 0o777, sha256: sha(fs.readFileSync(fd)) };
    } finally { fs.closeSync(fd); }
  }
  throw new Error('document_release_path_unsafe');
}

function documentPaths(root: string, values: string[]): string[] {
  const paths = values.map(canonicalAssertionPath).sort();
  if (!paths.length || paths.length !== new Set(paths).size) throw new Error('effect_path_missing_or_duplicate');
  for (const item of paths) {
    const extension = '(?:md|mdx|rst|txt|adoc)';
    if (/[\x00-\x1f\x7f]/.test(item) || /(^|\/)CHANGELOG(?:\.|$)/i.test(item)
      || !(new RegExp(`(^|/)docs/.+\\.${extension}$`, 'i').test(item)
        || new RegExp(`(^|/)(README|CONTRIBUTING)(?:\\.${extension})?$`, 'i').test(item))) {
      throw new Error('effect_path_not_documentation');
    }
    safePath(root, item, true);
  }
  return paths;
}

function snapshot(executable: string, root: string): Snapshot {
  const names = [...new Set(git(executable, root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  const files = Object.fromEntries(names.flatMap(name => {
    canonicalAssertionPath(name);
    const state = safePath(root, name);
    return state === null ? [] : [[name, state]];
  }));
  const index = path.resolve(root, git(executable, root, ['rev-parse', '--git-path', 'index']).trim());
  const fd = fs.openSync(index, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let indexHash: string;
  try { if (!fs.fstatSync(fd).isFile()) throw new Error('document_release_index_unsafe'); indexHash = sha(fs.readFileSync(fd).toString('base64')); }
  finally { fs.closeSync(fd); }
  return {
    head_oid: git(executable, root, ['rev-parse', '--verify', 'HEAD']).trim(),
    head_ref: git(executable, root, ['symbolic-ref', '-q', 'HEAD'], true).trim(),
    index_sha256: indexHash, files,
  };
}

function leasePath(stateRoot: string, root: string, taskId: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(taskId)) throw new Error('document_release_task_invalid');
  const directory = path.join(stateRoot, 'document-release');
  const uid = process.geteuid?.();
  for (const item of [stateRoot, directory]) {
    if (item === directory) { try { fs.mkdirSync(item, { mode: 0o700 }); } catch (error: any) { if (error?.code !== 'EEXIST') throw error; } }
    const info = fs.lstatSync(item);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) throw new Error('document_release_state_unsafe');
  }
  return path.join(directory, `${digest([root, taskId])}.json`);
}

function readLease(file: string): Lease | null {
  return readDurableAtomic(file, { decode: bytes => {
    const value = JSON.parse(bytes.toString()) as Lease;
    if (value.schema !== 'ecpe.document-release-lease.v1' || !['pending', 'consumed'].includes(value.status)
      || !value.grant || value.grant.skill !== 'ship' || value.grant.capability !== 'document_release'
      || !Array.isArray(value.paths) || !value.preimage || !Number.isFinite(Date.parse(value.expires_at))
      || digest(value.preimage) !== value.preimage_sha256
      || value.grant.assertions.repository_root !== value.repository_root || value.grant.assertions.task_id !== value.task_id
      || !same(value.grant.assertions.paths, value.paths) || value.grant.assertions.preimage_sha256 !== value.preimage_sha256
      || value.grant.assertions.expires_at !== value.expires_at || !/^[0-9a-f]{64}$/.test(String(value.grant.assertions.nonce))
      || issueGrant('ship', 'document_release', { ...value.grant.assertions }).grantId !== value.grant.grantId) {
      throw new Error('document_release_lease_invalid');
    }
    return value;
  } });
}

/** A private issued record owns cross-process replay protection. ProcessLocalGrant
 * alone cannot do that. Same-account processes and an unrestricted helper remain
 * outside this boundary; completion checks cannot undo external/transient effects. */
export async function prepareDocumentRelease(cwd: string, input: { taskId: string; paths: string[] }, stateRoot = resolveRuntimeStateRoot().root) {
  if (process.env.ECPE_DOCUMENT_RELEASE_AUTHORIZED !== '1') throw new Error('grant_required');
  const executable = (await resolveInstalledTool('git')).realpath;
  const root = fs.realpathSync(git(executable, cwd, ['rev-parse', '--show-toplevel']).trim());
  const paths = documentPaths(root, input.paths);
  if (git(executable, root, ['check-ignore', '--', ...paths], true)) throw new Error('document_release_ignored_path');
  const file = leasePath(stateRoot, root, input.taskId);
  const owned = acquireDurableOwnerLock(file, 'document_release_owner_busy');
  try {
    if (readLease(file)) throw new Error('document_release_task_already_issued');
    const preimage = snapshot(executable, root);
    const preimageHash = digest(preimage);
    const expires = new Date(Date.now() + 30 * 60_000).toISOString();
    const grant = issueGrant('ship', 'document_release', {
      repository_root: root, task_id: input.taskId, paths, preimage_sha256: preimageHash,
      expires_at: expires, nonce: randomBytes(32).toString('hex'),
    });
    const lease: Lease = { schema: 'ecpe.document-release-lease.v1', repository_root: root, task_id: input.taskId,
      paths, grant, preimage, preimage_sha256: preimageHash, expires_at: expires, status: 'pending' };
    durableAtomicWrite(file, JSON.stringify(lease) + '\n');
    return { schema: 'ecpe.document-release-dispatch.v1', grant_id: grant.grantId, task_id: input.taskId, paths,
      preimage_sha256: preimageHash, expires_at: expires,
      preimage: { head_oid: preimage.head_oid, index_sha256: preimage.index_sha256,
        files: Object.fromEntries(paths.map(name => [name, preimage.files[name]?.sha256 ?? null])) } };
  } finally { releaseDurableOwnerLock(owned); }
}

export async function finishDocumentRelease(cwd: string, input: { taskId: string; grantId: string; result: unknown }, stateRoot = resolveRuntimeStateRoot().root) {
  const executable = (await resolveInstalledTool('git')).realpath;
  const root = fs.realpathSync(git(executable, cwd, ['rev-parse', '--show-toplevel']).trim());
  const file = leasePath(stateRoot, root, input.taskId);
  const owned = acquireDurableOwnerLock(file, 'document_release_owner_busy');
  try {
    const lease = readLease(file);
    if (!lease) throw new Error('document_release_grant_missing');
    if (lease.status !== 'pending') throw new Error('effect_grant_replayed');
    const result = input.result as Record<string, any> | null;
    if (lease.repository_root !== root || lease.task_id !== input.taskId
      || input.grantId !== lease.grant.grantId) throw new Error('effect_grant_mismatch');
    // Burn the issued lease BEFORE validation: crash, failure, and retry cannot
    // reconstruct a fresh ProcessLocalGrant from the helper's serialized output.
    durableAtomicWrite(file, JSON.stringify({ ...lease, status: 'consumed' }) + '\n');
    new ProcessLocalGrant(lease.grant).consume('document_release');
    if (Date.now() >= Date.parse(lease.expires_at)) throw new Error('document_release_grant_expired');
    const allowed = new Set(['grant_id', 'task_id', 'preimage_sha256', 'files_updated', 'content_sha256', 'commit_sha', 'pushed', 'documentation_section', 'decisions', 'error']);
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || result.grant_id !== lease.grant.grantId || result.task_id !== lease.task_id
      || Object.keys(result).some(key => !allowed.has(key)) || result.preimage_sha256 !== lease.preimage_sha256
      || result.commit_sha !== null || result.pushed !== false || !Array.isArray(result.decisions)
      || !(result.documentation_section === null || typeof result.documentation_section === 'string')
      || !Array.isArray(result.files_updated) || !result.files_updated.every((item: unknown) => typeof item === 'string')
      || !result.content_sha256 || Array.isArray(result.content_sha256) || typeof result.content_sha256 !== 'object'
      || Object.hasOwn(result, 'error')) throw new Error('document_release_result_invalid');
    documentPaths(root, lease.paths);
    const after = snapshot(executable, root);
    if (after.head_oid !== lease.preimage.head_oid || after.head_ref !== lease.preimage.head_ref) throw new Error('document_release_head_changed');
    if (after.index_sha256 !== lease.preimage.index_sha256) throw new Error('document_release_index_changed');
    const changed = [...new Set([...Object.keys(lease.preimage.files), ...Object.keys(after.files)])]
      .filter(name => !same(lease.preimage.files[name], after.files[name])).sort();
    if (changed.some(name => !lease.paths.includes(name))) throw new Error('document_release_scope_changed');
    if (changed.some(name => {
      const before = lease.preimage.files[name], current = after.files[name];
      return current && (current.kind !== 'file' || (before ? current.mode !== before.mode : (current.mode & 0o133) !== 0));
    })) throw new Error('document_release_metadata_changed');
    if (!same([...result.files_updated].sort(), changed) || !same(Object.keys(result.content_sha256).sort(), changed)
      || changed.some(name => result.content_sha256[name] !== (after.files[name]?.sha256 ?? null))) throw new Error('document_release_content_mismatch');
    return { status: 'verified' as const, grant_id: lease.grant.grantId, files_updated: changed,
      documentation_section: result.documentation_section as string | null, decisions: result.decisions as unknown[] };
  } finally { releaseDurableOwnerLock(owned); }
}
