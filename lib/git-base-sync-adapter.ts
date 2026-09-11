import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { issueGrant, ProcessLocalGrant, validateFullOid, type GovernedSkill } from './effect-scope';
import { canonicalProviderRemote } from './provider-access';
import { resolveInstalledTool } from './toolchain-policy';
import { projectAccountEnvironment } from './account-environment';
import { resolveTrustedWorkProfile } from './trusted-base';
import type { Lane } from './work-profile';

interface BaseSyncInput { skill: GovernedSkill; lane: Lane; assertTargetRef: string }
interface BaseSyncAssertions extends BaseSyncInput {
  expectedHead: string; expectedBase: string; assertIndexPreimage: string; assertRepository: string;
}
const sha = (value: Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
const CONFIG = ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', '-c', `core.attributesFile=${os.devNull}`,
  '-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false', '-c', 'merge.autoStash=false', '-c', 'merge.renames=false',
  '-c', 'merge.renormalize=false', '-c', 'merge.default=text', '-c', 'merge.verifySignatures=false', '-c', 'rerere.enabled=false',
  '-c', 'core.fileMode=true', '-c', 'submodule.recurse=false'];

function git(executable: string, cwd: string, args: string[], allowed = [0]): string {
  const child = Bun.spawnSync([executable, '--no-optional-locks', ...CONFIG, ...args], {
    cwd, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    env: { ...projectAccountEnvironment('git'), GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (!allowed.includes(child.exitCode)) throw new Error('git_base_sync_git_failed');
  return child.stdout.toString();
}

function indexHash(executable: string, root: string): string {
  const file = path.resolve(root, git(executable, root, ['rev-parse', '--git-path', 'index']).trim());
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error('git_base_sync_index_unsafe');
    return sha(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
}

function assertClean(executable: string, root: string) {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock']) {
    if (fs.existsSync(path.resolve(root, git(executable, root, ['rev-parse', '--git-path', name]).trim()))) throw new Error('git_base_sync_in_progress');
  }
  if (git(executable, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) throw new Error('git_base_sync_dirty');
  if (git(executable, root, ['ls-files', '-v', '-z']).split('\0').filter(Boolean).some(line => !line.startsWith('H '))) {
    throw new Error('git_base_sync_index_flags_unsupported');
  }
}

function readState(executable: string, cwd: string, input: BaseSyncInput) {
  if (input.skill !== 'ship') throw new Error('effect_skill_invalid');
  const root = fs.realpathSync(git(executable, cwd, ['rev-parse', '--show-toplevel']).trim());
  const resolved = resolveTrustedWorkProfile({ cwd: root, lane: input.lane, assertTargetRef: input.assertTargetRef });
  const trusted = resolved.trusted_base;
  if (trusted.source !== 'remote_default' || !trusted.target_ref?.startsWith('origin/')) throw new Error('git_base_sync_base_unsupported');
  const headRef = git(executable, root, ['symbolic-ref', '-q', 'HEAD'], [0, 1]).trim();
  if (!headRef.startsWith('refs/heads/') || headRef === `refs/heads/${trusted.target_ref.slice(7)}`) throw new Error('git_base_sync_branch_invalid');
  const head = validateFullOid(git(executable, root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim());
  if (head !== trusted.candidate_sha) throw new Error('git_base_sync_head_changed');
  const repository = canonicalProviderRemote(git(executable, root, ['remote', 'get-url', 'origin']).trim()).comparisonKey;
  const base = validateFullOid(trusted.target_sha);
  const mergeBase = git(executable, root, ['merge-base', head, base]).trim();
  assertSupported(executable, { root, head_oid: head, base_oid: base, merge_base_oid: mergeBase });
  assertClean(executable, root);
  return { root, repository, head_ref: headRef, target_ref: trusted.target_ref, head_oid: head, base_oid: base,
    index_sha256: indexHash(executable, root), merge_base_oid: mergeBase,
    status: mergeBase === base ? 'already_contained' as const : 'sync_required' as const };
}

/** This operation consumes an already fetched trusted snapshot. It grants no
 * fetch, remote-ref update, push, PR mutation, history rewrite, or rollback. */
export async function inspectGitBaseSync(cwd: string, input: BaseSyncInput) {
  return readState((await resolveInstalledTool('git')).realpath, cwd, input);
}

function assertSupported(executable: string, state: { root: string; head_oid: string; base_oid: string; merge_base_oid: string }) {
  const { root } = state;
  // Reject repository-controlled execution paths before even the merge-tree
  // preflight. The v1 contract intentionally excludes attributes and gitlinks.
  const config = git(executable, root, ['config', '--includes', '--name-only', '--get-regexp', String.raw`^(filter\..*|merge\..*\.driver|branch\..*\.mergeoptions|include\..*|includeif\..*|core\.sparsecheckout|extensions\..*)$`], [0, 1]);
  if (config) throw new Error('git_base_sync_driver_unsupported');
  const infoAttributes = path.resolve(root, git(executable, root, ['rev-parse', '--git-path', 'info/attributes']).trim());
  if (fs.existsSync(infoAttributes) && fs.readFileSync(infoAttributes).length) throw new Error('git_base_sync_driver_unsupported');
  for (const oid of [state.head_oid, state.base_oid, state.merge_base_oid]) {
    const entries = git(executable, root, ['ls-tree', '-r', '-z', oid]).split('\0').filter(Boolean);
    if (entries.some(entry => entry.startsWith('160000 ') || /\t(?:.*\/)?\.gitattributes$/.test(entry))) throw new Error('git_base_sync_driver_unsupported');
  }
}

export async function executeGitBaseSync(cwd: string, input: BaseSyncAssertions) {
  for (const name of ['ECPE_BASE_SYNC_AUTHORIZED', 'ECPE_TRACKED_WRITE_AUTHORIZED', 'ECPE_GIT_STAGE_AUTHORIZED', 'ECPE_GIT_COMMIT_AUTHORIZED']) {
    if (process.env[name] !== '1') throw new Error('grant_required');
  }
  validateFullOid(input.expectedHead); validateFullOid(input.expectedBase);
  if (!/^[0-9a-f]{64}$/.test(input.assertIndexPreimage)) throw new Error('git_base_sync_index_assertion_invalid');
  const executable = (await resolveInstalledTool('git')).realpath;
  const before = readState(executable, cwd, input);
  if (before.head_oid !== input.expectedHead || before.base_oid !== input.expectedBase
    || before.index_sha256 !== input.assertIndexPreimage || before.repository !== input.assertRepository) throw new Error('git_base_sync_assertion_mismatch');
  assertSupported(executable, before);
  const proof = (status: 'already_contained' | 'synchronized', head: string, tree: string) => ({
    status, operation: 'ship.base_sync' as const, repository: before.repository, target_ref: before.target_ref,
    previous_head_oid: before.head_oid, head_oid: head, base_oid: before.base_oid, tree_oid: tree,
    postcondition: { base_contained: true, index_matches_head: true, worktree_clean: true },
  });
  if (before.status === 'already_contained') return proof('already_contained', before.head_oid, git(executable, before.root, ['rev-parse', 'HEAD^{tree}']).trim());
  const fastForward = before.merge_base_oid === before.head_oid;
  let tree: string;
  if (fastForward) tree = git(executable, before.root, ['rev-parse', `${before.base_oid}^{tree}`]).trim();
  else {
    const preflight = git(executable, before.root, ['merge-tree', '--write-tree', '--no-messages', before.head_oid, before.base_oid], [0, 1]);
    const lines = preflight.trim().split('\n');
    // A conflict emits staged entries following the tree OID; never touch the
    // real index/worktree to discover or recover from a conflict.
    if (lines.length !== 1 || !/^[0-9a-f]{40}$/.test(lines[0])) throw new Error('git_base_sync_conflict');
    tree = lines[0];
  }
  const paths = git(executable, before.root, ['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', before.head_oid, tree]).split('\0').filter(Boolean).sort();
  const assertions = { operation: 'ship.base_sync', repository_root: before.root, repository: before.repository,
    head_ref: before.head_ref, head_oid: before.head_oid, base_ref: before.target_ref, base_oid: before.base_oid,
    index_preimage: before.index_sha256, tree_oid: tree, paths };
  const grants = (['tracked_write', 'git_stage', 'git_commit'] as const).map(capability => new ProcessLocalGrant(issueGrant('ship', capability, assertions)));
  // Bind authorization to a second observation immediately before mutation.
  if (JSON.stringify(readState(executable, cwd, input)) !== JSON.stringify(before)) throw new Error('git_base_sync_preimage_changed');
  assertSupported(executable, before);
  grants[0].consume('tracked_write'); grants[1].consume('git_stage'); grants[2].consume('git_commit');
  git(executable, before.root, ['merge', fastForward ? '--ff-only' : '--no-ff', '--no-edit', '--no-autostash', '--no-verify', '--no-gpg-sign', '--no-overwrite-ignore', before.base_oid]);
  const head = git(executable, before.root, ['rev-parse', 'HEAD']).trim();
  const actualTree = git(executable, before.root, ['rev-parse', 'HEAD^{tree}']).trim();
  const parents = git(executable, before.root, ['show', '-s', '--format=%P', 'HEAD']).trim();
  if (actualTree !== tree || (fastForward ? head !== before.base_oid : parents !== `${before.head_oid} ${before.base_oid}`)
    || git(executable, before.root, ['symbolic-ref', 'HEAD']).trim() !== before.head_ref
    || git(executable, before.root, ['merge-base', head, before.base_oid]).trim() !== before.base_oid
    || git(executable, before.root, ['write-tree']).trim() !== tree) throw new Error('git_base_sync_postcondition_failed');
  assertClean(executable, before.root);
  return proof('synchronized', head, tree);
}
