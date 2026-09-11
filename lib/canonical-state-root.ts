import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertEcpeAuthorityPlatform } from './ecpe-platform';

export interface CanonicalStateRoot {
  root: string;
  stateRootId: string;
  effectiveUid: number;
}

interface ResolveOptions {
  effectiveUid?: number;
  accountHome?: string;
  environment?: Record<string, string | undefined>;
  lstat?: typeof fs.lstatSync;
  realpath?: typeof fs.realpathSync;
  mkdir?: typeof fs.mkdirSync;
}

export class CanonicalStateRootError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CanonicalStateRootError';
    this.code = code;
  }
}

function requireDirectory(
  candidate: string,
  expectedUid: number,
  options: Pick<ResolveOptions, 'lstat' | 'realpath'>,
  kind: 'account_home' | 'state_root',
): string {
  const lstat = options.lstat ?? fs.lstatSync;
  const realpath = options.realpath ?? fs.realpathSync;
  const info = lstat(candidate);
  if (info.isSymbolicLink()) throw new CanonicalStateRootError(`${kind}_symlink`);
  if (!info.isDirectory()) throw new CanonicalStateRootError(`${kind}_not_directory`);
  if (info.uid !== expectedUid) throw new CanonicalStateRootError(`${kind}_owner`);
  if ((info.mode & 0o022) !== 0) throw new CanonicalStateRootError(`${kind}_mode`);
  const resolved = realpath(candidate);
  const resolvedInfo = lstat(resolved);
  if (resolvedInfo.isSymbolicLink() || resolvedInfo.uid !== expectedUid) {
    throw new CanonicalStateRootError(`${kind}_owner`);
  }
  return resolved;
}

export function canonicalStateRootId(uid: number, root: string): string {
  return `state_${createHash('sha256').update(`ecpe-state-root-v1\0${uid}\0${root}`).digest('hex').slice(0, 32)}`;
}

/**
 * Resolve the one production authority-state root. Environment variables are
 * deliberately accepted only as an ignored test fixture input: they never
 * participate in selection.
 */
export function resolveCanonicalStateRoot(options: ResolveOptions = {}): CanonicalStateRoot {
  const effectiveUid = options.effectiveUid ?? process.geteuid?.() ?? process.getuid?.();
  if (!Number.isSafeInteger(effectiveUid) || (effectiveUid as number) < 0) {
    throw new CanonicalStateRootError('effective_uid_invalid');
  }
  const accountHome = options.accountHome ?? os.userInfo().homedir;
  if (!path.isAbsolute(accountHome)) throw new CanonicalStateRootError('account_home_not_absolute');
  const verifiedHome = requireDirectory(accountHome, effectiveUid as number, options, 'account_home');
  const child = path.join(verifiedHome, '.gstack');
  const mkdir = options.mkdir ?? fs.mkdirSync;
  try {
    const info = (options.lstat ?? fs.lstatSync)(child);
    if (info.isSymbolicLink()) throw new CanonicalStateRootError('state_root_symlink');
  } catch (error) {
    if (error instanceof CanonicalStateRootError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdir(child, { mode: 0o700 });
  }
  const root = requireDirectory(child, effectiveUid as number, options, 'state_root');
  const rootInfo = (options.lstat ?? fs.lstatSync)(root);
  if ((rootInfo.mode & 0o777) !== 0o700) throw new CanonicalStateRootError('state_root_mode');
  if (path.dirname(root) !== verifiedHome) throw new CanonicalStateRootError('state_root_escape');
  return { root, stateRootId: canonicalStateRootId(effectiveUid as number, root), effectiveUid: effectiveUid as number };
}

/** Test dependency injection only; production CLIs expose no root argument. */
export function resolveRuntimeStateRoot(): CanonicalStateRoot {
  assertEcpeAuthorityPlatform();
  if (process.env.ECPE_TESTING === '1' && process.env.ECPE_TEST_STATE_ROOT) {
    const root = fs.realpathSync(process.env.ECPE_TEST_STATE_ROOT);
    const uid = process.geteuid?.() ?? process.getuid?.() ?? 0;
    const info = fs.lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) {
      throw new CanonicalStateRootError('test_state_root_invalid');
    }
    return { root, stateRootId: canonicalStateRootId(uid, root), effectiveUid: uid };
  }
  return resolveCanonicalStateRoot();
}

export function stampStateRoot<T extends Record<string, unknown>>(
  value: T,
  state: CanonicalStateRoot,
): T & { state_root_id: string } {
  return { ...value, state_root_id: state.stateRootId };
}

export function assertStateRootId(
  value: { state_root_id?: unknown },
  state: CanonicalStateRoot,
): void {
  if (value.state_root_id !== state.stateRootId) {
    throw new CanonicalStateRootError('state_root_id_mismatch');
  }
}
