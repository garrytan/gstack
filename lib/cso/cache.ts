import * as fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { atomicWriteSync } from '../fs-atomic';
import { CsoError } from './contracts';
import { discardAtomicNoReplaceTemp, privateRoot, recoverAtomicNoReplaceJson, secureDirectory, withLock as withStateLock } from './state';

export const DEFAULT_PUBLIC_ARCHIVE_CACHE_BYTES = 10 * 1024 * 1024 * 1024;
const METADATA_VERSION = 1;
const METADATA_LIMIT = 4096;
const COPY_BUFFER_BYTES = 64 * 1024;
const CACHE_LOCK_PROTOCOL = 'immutable-cache-lease-set-v3';
const SHA256 = /^[a-f0-9]{64}$/;
const RELATIVE_STAGE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[^\0-\x1f\x7f]+$/;

export interface PublicArchiveCacheOptions {
  /** Defaults to the private CSO state namespace. */
  root?: string;
  /** Existing directory populated by the constrained acquisition step. */
  stagingRoot: string;
  /** Persistent archive-byte ceiling. Defaults to 10 GiB. */
  maxBytes?: number;
  /** Per-archive ceiling. Defaults to maxBytes. */
  maxEntryBytes?: number;
  /** Deterministic clock for tests. */
  now?: () => number;
}

export interface PublicArchiveCacheEntry {
  sha256: string;
  path: string;
  bytes: number;
  createdAt: number;
  lastAccessedAt: number;
}

export interface PublicArchiveCacheStats {
  entries: number;
  bytes: number;
  maxBytes: number;
}

export interface MaterializedArchive {
  sha256: string;
  path: string;
  bytes: number;
}

interface Metadata {
  version: 1;
  sha256: string;
  bytes: number;
  createdAt: number;
  lastAccessedAt: number;
}

interface StableStat {
  dev: number;
  ino: number;
  size: number;
  mode: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
}

function fail(code: ConstructorParameters<typeof CsoError>[0], message: string): never {
  throw new CsoError(code, message);
}

function boundedPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_ARGUMENT', `${name} must be a positive safe integer`);
  return value;
}

function expectedDigest(value: string): string {
  if (!SHA256.test(value)) fail('INVALID_ARGUMENT', 'Archive SHA-256 must be 64 lowercase hexadecimal characters');
  return value;
}

function stagedRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length > 4096 || !RELATIVE_STAGE_PATH.test(value))
    fail('UNSAFE_PATH', 'Staged archive path must be a contained relative path');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) fail('UNSAFE_PATH', 'Staged archive path must be a contained relative path');
  return value;
}

function stableStat(stat: fs.Stats): StableStat {
  return {
    dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode, nlink: stat.nlink,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, uid: stat.uid,
  };
}

function sameStat(left: StableStat, right: StableStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.uid === right.uid;
}

function sameRenamedInode(left: StableStat, right: StableStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs && left.uid === right.uid;
}


function assertOwnedRegular(stat: fs.Stats, label: string, maxBytes: number, immutable = false): void {
  if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_PATH', `${label} must be a regular file`);
  if (stat.nlink !== 1) fail('UNSAFE_PATH', `${label} must not be hard-linked`);
  if (process.getuid && stat.uid !== process.getuid()) fail('UNSAFE_PATH', `${label} must be owned by the current user`);
  if (stat.size > maxBytes) fail('INSUFFICIENT_CAPACITY', `${label} exceeds its byte limit`);
  if (immutable && (stat.mode & 0o222) !== 0) fail('INCOMPATIBLE_INPUT', `${label} is unexpectedly writable`);
}

function assertExistingDirectory(path: string, label: string): string {
  const requested = resolve(path);
  let requestedStat: fs.Stats;
  try { requestedStat = fs.lstatSync(requested); }
  catch { fail('MISSING_INPUT', `${label} does not exist`); }
  if (requestedStat!.isSymbolicLink()) fail('UNSAFE_PATH', `${label} must not be a symlink`);
  let canonical: string;
  try { canonical = fs.realpathSync(requested); }
  catch { fail('MISSING_INPUT', `${label} does not exist`); }
  const stat = fs.lstatSync(canonical!);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', `${label} must be a directory`);
  if (process.getuid && stat.uid !== process.getuid()) fail('UNSAFE_PATH', `${label} must be owned by the current user`);
  if ((stat.mode & 0o022) !== 0) fail('UNSAFE_PATH', `${label} must not be writable by another user`);
  return canonical!;
}

function assertContainedAncestors(root: string, relativePath: string): string {
  const parts = relativePath.split('/');
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(cursor); }
    catch { fail('MISSING_INPUT', `Staged archive directory is missing: ${part}`); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Staged archive has a symlink or non-directory ancestor');
    if (process.getuid && stat.uid !== process.getuid()) fail('UNSAFE_PATH', 'Staged archive ancestor has an unexpected owner');
    if ((stat.mode & 0o022) !== 0) fail('UNSAFE_PATH', 'Staged archive ancestor is writable by another user');
  }
  const path = resolve(root, ...parts);
  if (path !== root && !path.startsWith(`${root}${sep}`)) fail('UNSAFE_PATH', 'Staged archive escaped its staging directory');
  return path;
}

function openNoFollow(path: string, flags: number, mode?: number): number {
  const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
  const closeOnExec = (fs.constants as Record<string, number>).O_CLOEXEC ?? 0;
  try { return fs.openSync(path, flags | noFollow | closeOnExec, mode); }
  catch { fail('UNSAFE_PATH', 'Archive file could not be opened without following links'); }
}

function readMetadata(path: string, digest: string): Metadata {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(path); }
  catch { fail('INCOMPATIBLE_INPUT', `Cache metadata is missing for ${digest}`); }
  assertOwnedRegular(stat!, 'Cache metadata', METADATA_LIMIT);
  if ((stat!.mode & 0o077) !== 0) fail('INCOMPATIBLE_INPUT', 'Cache metadata permissions are not private');
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { fail('INCOMPATIBLE_INPUT', `Cache metadata is invalid for ${digest}`); }
  const record = value as Partial<Metadata>;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'bytes,createdAt,lastAccessedAt,sha256,version' ||
    record.version !== METADATA_VERSION || record.sha256 !== digest || !Number.isSafeInteger(record.bytes) || Number(record.bytes) < 0 ||
    !Number.isSafeInteger(record.createdAt) || Number(record.createdAt) < 0 || !Number.isSafeInteger(record.lastAccessedAt) ||
    Number(record.lastAccessedAt) < Number(record.createdAt)) fail('INCOMPATIBLE_INPUT', `Cache metadata is invalid for ${digest}`);
  return record as Metadata;
}

function writeMetadata(path: string, metadata: Metadata, noReplace = false): void {
  try { atomicWriteSync(path, `${JSON.stringify(metadata)}\n`, { mode: 0o600, noReplace }); }
  catch { fail('PERSISTENCE_FAILED', 'Cache metadata could not be written atomically'); }
}

function removeRegular(path: string, label: string): void {
  const stat = fs.lstatSync(path);
  assertOwnedRegular(stat, label, Number.MAX_SAFE_INTEGER);
  try { fs.unlinkSync(path); }
  catch { fail('PERSISTENCE_FAILED', `${label} could not be removed`); }
}

function existsNoFollow(path: string): boolean {
  try { fs.lstatSync(path); return true; }
  catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    fail('INCOMPATIBLE_INPUT', 'Cache object could not be inspected safely');
  }
}

/**
 * A content-addressed cache for already-acquired public archives. It never
 * performs downloads, runs package managers, or executes archive content.
 */
export class PublicArchiveCache {
  readonly root: string;
  readonly stagingRoot: string;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  private readonly entriesDir: string;
  private readonly metadataDir: string;
  private readonly incomingDir: string;
  private readonly recoveryDir: string;
  private readonly lockDir: string;
  private readonly clock: () => number;

  constructor(options: PublicArchiveCacheOptions) {
    if (!options || typeof options !== 'object') fail('INVALID_ARGUMENT', 'Cache options are required');
    this.maxBytes = boundedPositiveInteger(options.maxBytes ?? DEFAULT_PUBLIC_ARCHIVE_CACHE_BYTES, 'maxBytes');
    this.maxEntryBytes = boundedPositiveInteger(options.maxEntryBytes ?? this.maxBytes, 'maxEntryBytes');
    if (this.maxEntryBytes > this.maxBytes) fail('INVALID_ARGUMENT', 'maxEntryBytes cannot exceed maxBytes');
    this.clock = options.now ?? Date.now;
    const base = options.root ? resolve(options.root) : join(privateRoot(), 'public-cache');
    this.root = secureDirectory(base);
    this.entriesDir = secureDirectory(join(this.root, 'entries'));
    this.metadataDir = secureDirectory(join(this.root, 'metadata'));
    this.incomingDir = secureDirectory(join(this.root, 'incoming'));
    this.recoveryDir = secureDirectory(join(this.root, 'recovery'));
    this.lockDir = join(this.root, '.lock');
    this.stagingRoot = assertExistingDirectory(options.stagingRoot, 'Archive staging directory');
    if (this.root === this.stagingRoot || this.root.startsWith(`${this.stagingRoot}${sep}`) || this.stagingRoot.startsWith(`${this.root}${sep}`))
      fail('UNSAFE_PATH', 'Archive staging and cache directories must be separate');
  }

  /** Promote a verified staging file. The staging file is never deleted. */
  promote(stagedPath: string, sha256: string): PublicArchiveCacheEntry {
    const digest = expectedDigest(sha256), relativePath = stagedRelativePath(stagedPath);
    const source = assertContainedAncestors(this.stagingRoot, relativePath);
    return this.withLock(() => {
      this.cleanIncoming();
      this.recoverInterruptedOperations();
      let initial: fs.Stats;
      try { initial = fs.lstatSync(source); }
      catch { fail('MISSING_INPUT', 'Staged archive is missing'); }
      assertOwnedRegular(initial!, 'Staged archive', this.maxEntryBytes);
      if ((initial!.mode & 0o022) !== 0) fail('UNSAFE_PATH', 'Staged archive must not be writable by another user');

      const target = this.entryPath(digest), metadataPath = this.metadataPath(digest);
      const targetExists = existsNoFollow(target), metadataExists = existsNoFollow(metadataPath);
      if (targetExists !== metadataExists) fail('INCOMPATIBLE_INPUT', `Cache entry is incomplete for ${digest}`);

      if (targetExists) {
        const staged = this.hashFile(source, this.maxEntryBytes, false, stableStat(initial!));
        if (staged.digest !== digest) fail('INCOMPATIBLE_INPUT', 'Staged archive does not match its caller-provided SHA-256');
        const metadata = this.verifiedEntry(digest);
        return this.touch(metadata);
      }

      // Authenticate the complete staged object before it is allowed to
      // displace any already-verified cache entry. Copying below hashes it a
      // second time so a staging race still fails closed.
      const authenticated = this.hashFile(source, this.maxEntryBytes, false, stableStat(initial!));
      if (authenticated.digest !== digest) fail('INCOMPATIBLE_INPUT', 'Staged archive does not match its caller-provided SHA-256');
      this.evictToFit(initial!.size);
      const incoming = join(this.incomingDir, `.incoming-${process.pid}-${randomBytes(12).toString('hex')}`);
      let promoted = false;
      try {
        const staged = this.copyAndHash(source, incoming, this.maxEntryBytes, stableStat(initial!));
        if (staged.digest !== digest) fail('INCOMPATIBLE_INPUT', 'Staged archive does not match its caller-provided SHA-256');
        if (staged.bytes !== initial!.size) fail('SNAPSHOT_RACE', 'Staged archive changed during promotion');
        fs.chmodSync(incoming, 0o400);
        // A hard-link followed by unlink is an atomic no-replace publication on
        // the cache filesystem. rename(2) would silently replace a raced target.
        try { fs.linkSync(incoming, target); fs.unlinkSync(incoming); }
        catch { fail('PERSISTENCE_FAILED', 'Verified archive could not be promoted atomically'); }
        promoted = true;
        const now = this.timestamp();
        const metadata: Metadata = { version: 1, sha256: digest, bytes: staged.bytes, createdAt: now, lastAccessedAt: now };
        try { writeMetadata(metadataPath, metadata, true); }
        catch (error) {
          try { this.discardObject(target, 'entry', digest); } catch {}
          throw error;
        }
        return this.entry(metadata);
      } finally {
        if (!promoted && existsNoFollow(incoming)) {
          const stat = fs.lstatSync(incoming);
          if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(incoming);
        }
      }
    });
  }

  /** Return a cache hit only after hashing every byte and validating metadata. */
  get(sha256: string): PublicArchiveCacheEntry | undefined {
    const digest = expectedDigest(sha256);
    return this.withLock(() => {
      this.cleanIncoming();
      this.recoverInterruptedOperations();
      const targetExists = existsNoFollow(this.entryPath(digest)), metadataExists = existsNoFollow(this.metadataPath(digest));
      if (!targetExists && !metadataExists) return undefined;
      if (targetExists !== metadataExists) fail('INCOMPATIBLE_INPUT', `Cache entry is incomplete for ${digest}`);
      return this.touch(this.verifiedEntry(digest));
    });
  }

  /** Inspect capacity without treating entries as execution-ready cache hits. */
  stats(): PublicArchiveCacheStats {
    return this.withLock(() => {
      this.cleanIncoming();
      this.recoverInterruptedOperations();
      const entries = this.inventory();
      return { entries: entries.length, bytes: entries.reduce((sum, item) => sum + item.bytes, 0), maxBytes: this.maxBytes };
    });
  }

  /**
   * Copy a complete digest set into one run-owned directory while holding the
   * cache lock.  Callers mount these immutable copies, never eviction-prone
   * cache paths.  Every source and every copy is fully hashed in the same
   * critical section.
   */
  materialize(digests: string[], destinationRoot: string): MaterializedArchive[] {
    if (!Array.isArray(digests) || !digests.length || digests.some(value => typeof value !== 'string'))
      fail('INVALID_ARGUMENT', 'Archive materialization requires at least one SHA-256 digest');
    const selected = [...new Set(digests.map(expectedDigest))].sort(), destination = assertExistingDirectory(destinationRoot, 'Archive materialization directory');
    if (fs.readdirSync(destination).length) fail('UNSAFE_PATH', 'Archive materialization directory must be empty');
    if (destination === this.root || destination.startsWith(`${this.root}${sep}`) || this.root.startsWith(`${destination}${sep}`) ||
      destination === this.stagingRoot || destination.startsWith(`${this.stagingRoot}${sep}`) || this.stagingRoot.startsWith(`${destination}${sep}`))
      fail('UNSAFE_PATH', 'Archive materialization directory must be separate from cache and staging roots');
    return this.withLock(() => {
      this.cleanIncoming();
      this.recoverInterruptedOperations();
      const created: string[] = [], result: MaterializedArchive[] = [];
      try {
        for (const digest of selected) {
          const metadata = this.verifiedEntry(digest), source = this.entryPath(digest), initial = fs.lstatSync(source);
          assertOwnedRegular(initial, 'Cached archive', this.maxEntryBytes, true);
          const target = join(destination, digest), copied = this.copyAndHash(source, target, this.maxEntryBytes, stableStat(initial));
          if (copied.digest !== digest || copied.bytes !== metadata.bytes) fail('SNAPSHOT_RACE', 'Cached archive changed while its run-owned copy was materialized');
          fs.chmodSync(target, 0o400);
          const verified = this.hashFile(target, this.maxEntryBytes, true);
          if (verified.digest !== digest || verified.bytes !== metadata.bytes) fail('SNAPSHOT_RACE', 'Run-owned archive copy failed verification');
          created.push(target); result.push(Object.freeze({ sha256: digest, path: target, bytes: verified.bytes }));
        }
        return result;
      } catch (error) {
        for (const path of created.reverse()) { try { removeRegular(path, 'Incomplete run-owned archive copy'); } catch {} }
        throw error;
      }
    });
  }

  private timestamp(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) fail('PERSISTENCE_FAILED', 'Cache clock returned an invalid timestamp');
    return value;
  }

  private entryPath(digest: string): string { return join(this.entriesDir, digest); }
  private metadataPath(digest: string): string { return join(this.metadataDir, `${digest}.json`); }

  private entry(metadata: Metadata): PublicArchiveCacheEntry {
    return Object.freeze({ sha256: metadata.sha256, path: this.entryPath(metadata.sha256), bytes: metadata.bytes,
      createdAt: metadata.createdAt, lastAccessedAt: metadata.lastAccessedAt });
  }

  private touch(metadata: Metadata): PublicArchiveCacheEntry {
    const updated: Metadata = { ...metadata, lastAccessedAt: Math.max(metadata.lastAccessedAt, this.timestamp()) };
    writeMetadata(this.metadataPath(metadata.sha256), updated);
    return this.entry(updated);
  }

  private verifiedEntry(digest: string): Metadata {
    const metadata = readMetadata(this.metadataPath(digest), digest);
    const result = this.hashFile(this.entryPath(digest), this.maxEntryBytes, true);
    if (result.digest !== digest || result.bytes !== metadata.bytes) fail('INCOMPATIBLE_INPUT', `Cached archive failed SHA-256 verification: ${digest}`);
    return metadata;
  }

  private hashFile(path: string, maxBytes: number, immutable: boolean, expected?: StableStat): { digest: string; bytes: number } {
    const fd = openNoFollow(path, fs.constants.O_RDONLY);
    try {
      const beforeStat = fs.fstatSync(fd);
      assertOwnedRegular(beforeStat, immutable ? 'Cached archive' : 'Staged archive', maxBytes, immutable);
      const before = stableStat(beforeStat), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      if (expected && !sameStat(expected, before)) fail('SNAPSHOT_RACE', 'Archive changed before it could be verified');
      let bytes = 0;
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!read) break;
        bytes += read;
        if (bytes > maxBytes) fail('INSUFFICIENT_CAPACITY', 'Archive exceeded its byte limit while being read');
        hash.update(buffer.subarray(0, read));
      }
      const after = stableStat(fs.fstatSync(fd));
      if (!sameStat(before, after) || bytes !== before.size) fail('SNAPSHOT_RACE', 'Archive changed while it was being verified');
      return { digest: hash.digest('hex'), bytes };
    } finally { fs.closeSync(fd); }
  }

  private copyAndHash(source: string, destination: string, maxBytes: number, expected: StableStat): { digest: string; bytes: number } {
    const sourceFd = openNoFollow(source, fs.constants.O_RDONLY);
    let destinationFd: number | undefined;
    try {
      const beforeStat = fs.fstatSync(sourceFd);
      assertOwnedRegular(beforeStat, 'Staged archive', maxBytes);
      const before = stableStat(beforeStat), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      if (!sameStat(expected, before)) fail('SNAPSHOT_RACE', 'Staged archive changed before promotion');
      destinationFd = openNoFollow(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      let bytes = 0;
      for (;;) {
        const read = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
        if (!read) break;
        bytes += read;
        if (bytes > expected.size) fail('SNAPSHOT_RACE', 'Staged archive grew during promotion');
        if (bytes > maxBytes) fail('INSUFFICIENT_CAPACITY', 'Archive exceeded its byte limit during promotion');
        hash.update(buffer.subarray(0, read));
        let offset = 0;
        while (offset < read) offset += fs.writeSync(destinationFd, buffer, offset, read - offset);
      }
      fs.fsyncSync(destinationFd);
      const after = stableStat(fs.fstatSync(sourceFd));
      if (!sameStat(before, after) || bytes !== before.size) fail('SNAPSHOT_RACE', 'Staged archive changed during promotion');
      return { digest: hash.digest('hex'), bytes };
    } finally {
      if (destinationFd !== undefined) fs.closeSync(destinationFd);
      fs.closeSync(sourceFd);
    }
  }

  private inventory(): Metadata[] {
    const entryNames = fs.readdirSync(this.entriesDir), metadataNames = fs.readdirSync(this.metadataDir);
    for (const name of entryNames) if (!SHA256.test(name)) fail('INCOMPATIBLE_INPUT', 'Cache entries directory contains an unexpected object');
    for (const name of metadataNames) if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('INCOMPATIBLE_INPUT', 'Cache metadata directory contains an unexpected object');
    const entrySet = new Set(entryNames), metadataSet = new Set(metadataNames.map(name => name.slice(0, -5)));
    if (entrySet.size !== metadataSet.size || [...entrySet].some(name => !metadataSet.has(name)))
      fail('INCOMPATIBLE_INPUT', 'Cache entries and metadata are inconsistent');
    return entryNames.map(digest => {
      const stat = fs.lstatSync(this.entryPath(digest));
      assertOwnedRegular(stat, 'Cached archive', this.maxEntryBytes, true);
      const metadata = readMetadata(this.metadataPath(digest), digest);
      if (metadata.bytes !== stat.size) fail('INCOMPATIBLE_INPUT', `Cache size metadata is inconsistent for ${digest}`);
      return metadata;
    });
  }

  private evictToFit(incomingBytes: number): void {
    if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0 || incomingBytes > this.maxBytes)
      fail('INSUFFICIENT_CAPACITY', 'Archive cannot fit within the public-cache limit');
    const entries = this.inventory().sort((a, b) => a.lastAccessedAt - b.lastAccessedAt || a.createdAt - b.createdAt || a.sha256.localeCompare(b.sha256));
    let total = entries.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of entries) {
      if (total + incomingBytes <= this.maxBytes) break;
      const archive = this.moveToRecovery(this.entryPath(item.sha256), 'entry', item.sha256);
      const metadata = this.moveToRecovery(this.metadataPath(item.sha256), 'metadata', item.sha256);
      removeRegular(archive, 'Evicted cache archive');
      removeRegular(metadata, 'Evicted cache metadata');
      total -= item.bytes;
    }
    if (total + incomingBytes > this.maxBytes) fail('INSUFFICIENT_CAPACITY', 'Archive cache could not free enough verified capacity');
  }

  private cleanIncoming(): void {
    for (const name of fs.readdirSync(this.incomingDir)) {
      if (!/^\.incoming-\d+-[a-f0-9]{24}$/.test(name)) fail('INCOMPATIBLE_INPUT', 'Cache incoming directory contains an unexpected object');
      const incoming = join(this.incomingDir, name), stat = fs.lstatSync(incoming);
      if (!stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink) || stat.size > this.maxEntryBytes ||
        (process.getuid && stat.uid !== process.getuid())) fail('UNSAFE_PATH', 'Incomplete cache archive is not a bounded regular file');
      if (stat.nlink === 2) {
        const matches = fs.readdirSync(this.entriesDir).filter(entry => {
          if (!SHA256.test(entry)) fail('INCOMPATIBLE_INPUT', 'Cache entries directory contains an unexpected object');
          const candidate = fs.lstatSync(this.entryPath(entry));
          return candidate.dev === stat.dev && candidate.ino === stat.ino;
        });
        if (matches.length !== 1) fail('UNSAFE_PATH', 'Incoming archive hard link does not match one published cache entry');
        const target = fs.lstatSync(this.entryPath(matches[0]));
        if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 2 || target.size > this.maxEntryBytes ||
          (process.getuid && target.uid !== process.getuid()) || (target.mode & 0o222) !== 0)
          fail('SNAPSHOT_RACE', 'Incoming archive link count or identity changed during recovery');
      }
      try { fs.unlinkSync(incoming); } catch { fail('PERSISTENCE_FAILED', 'Incomplete cache archive could not be removed'); }
    }
  }

  /**
   * Recover only artifacts whose names and inode types prove they belong to an
   * interrupted cache transaction. Unknown objects remain a hard failure.
   */
  private recoverInterruptedOperations(): void {
    for (const name of fs.readdirSync(this.recoveryDir)) {
      if (!/^\.recovery-(?:entry|metadata)-[a-f0-9]{64}-\d+-[a-f0-9]{24}$/.test(name))
        fail('INCOMPATIBLE_INPUT', 'Cache recovery directory contains an unexpected object');
      removeRegular(join(this.recoveryDir, name), 'Interrupted cache transaction');
    }

    const entries = fs.readdirSync(this.entriesDir), metadataObjects = fs.readdirSync(this.metadataDir);
    for (const name of metadataObjects) {
      if (/^[a-f0-9]{64}\.json\.tmp\.\d+\.[a-f0-9]{8}$/.test(name)) this.recoverMetadataTemp(name);
      else if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('INCOMPATIBLE_INPUT', 'Cache metadata directory contains an unexpected object');
    }
    const metadata = fs.readdirSync(this.metadataDir);
    for (const name of entries) if (!SHA256.test(name)) fail('INCOMPATIBLE_INPUT', 'Cache entries directory contains an unexpected object');
    for (const name of metadata) if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('INCOMPATIBLE_INPUT', 'Cache metadata directory contains an unexpected object');
    const entrySet = new Set(entries), metadataSet = new Set(metadata.map(name => name.slice(0, -5)));
    for (const digest of new Set([...entrySet, ...metadataSet])) {
      if (entrySet.has(digest) === metadataSet.has(digest)) continue;
      if (entrySet.has(digest)) this.discardObject(this.entryPath(digest), 'entry', digest);
      else this.discardObject(this.metadataPath(digest), 'metadata', digest);
    }
  }

  private recoveryPath(kind: 'entry' | 'metadata', digest: string): string {
    return join(this.recoveryDir, `.recovery-${kind}-${digest}-${process.pid}-${randomBytes(12).toString('hex')}`);
  }

  private moveToRecovery(path: string, kind: 'entry' | 'metadata', digest: string): string {
    const before = fs.lstatSync(path);
    assertOwnedRegular(before, kind === 'entry' ? 'Cached archive' : 'Cache metadata', kind === 'entry' ? this.maxEntryBytes : METADATA_LIMIT, kind === 'entry');
    if (kind === 'metadata' && (before.mode & 0o077) !== 0) fail('UNSAFE_PATH', 'Cache metadata permissions are not private');
    const destination = this.recoveryPath(kind, digest);
    try { fs.renameSync(path, destination); }
    catch { fail('PERSISTENCE_FAILED', 'Interrupted cache object could not be quarantined atomically'); }
    const after = fs.lstatSync(destination);
    // rename(2) can update ctime; stable inode identity, content size, mode,
    // link count, mtime, and ownership prove the moved object is the one read.
    if (!sameRenamedInode(stableStat(before), stableStat(after))) fail('SNAPSHOT_RACE', 'Cache object changed while it was quarantined');
    return destination;
  }

  private discardObject(path: string, kind: 'entry' | 'metadata', digest: string): void {
    const quarantined = this.moveToRecovery(path, kind, digest);
    removeRegular(quarantined, 'Interrupted cache transaction');
  }

  private recoverMetadataTemp(name: string): void {
    const path = join(this.metadataDir, name), stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink) || stat.size > METADATA_LIMIT ||
      (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0)
      fail('UNSAFE_PATH', 'Interrupted cache metadata write is not a private regular file');
    if (stat.nlink === 2) {
      const target = this.metadataPath(name.slice(0, 64));
      let targetStat: fs.Stats;
      try { targetStat = fs.lstatSync(target); } catch { fail('INCOMPATIBLE_INPUT', 'Hard-linked metadata temp has no published target'); }
      if (!targetStat!.isFile() || targetStat!.isSymbolicLink() || targetStat!.dev !== stat.dev || targetStat!.ino !== stat.ino || targetStat!.nlink !== 2)
        fail('UNSAFE_PATH', 'Interrupted metadata hard link does not match its published target');
    }
    try { fs.unlinkSync(path); } catch { fail('PERSISTENCE_FAILED', 'Interrupted cache metadata write could not be removed'); }
  }

  private withLock<T>(callback: () => T): T {
    const marker = `${JSON.stringify({ protocol: CACHE_LOCK_PROTOCOL })}\n`;
    const options={label:'Cache lock protocol',maxBytes:METADATA_LIMIT,validate:(value:unknown)=>{
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='protocol'||(value as any).protocol!==CACHE_LOCK_PROTOCOL)
        fail('INCOMPATIBLE_INPUT','Archive-cache lock protocol is invalid');
    }};
    const tempPattern=/^\.lock\.tmp\.(\d{1,10})\.[a-f0-9]{8}$/;
    for(const name of fs.readdirSync(this.root)){
      const match=name.match(tempPattern);if(!match)continue;
      const temporary=join(this.root,name),publisherPid=Number(match[1]);
      if(existsNoFollow(this.lockDir))recoverAtomicNoReplaceJson(this.lockDir,options);
      if(existsNoFollow(temporary))discardAtomicNoReplaceTemp(temporary,publisherPid,options);
    }
    try { atomicWriteSync(this.lockDir, marker, { mode: 0o600, noReplace: true }); }
    catch (error: any) {
      if (error?.code !== 'EEXIST') fail('PERSISTENCE_FAILED', 'Archive-cache lock protocol could not be initialized');
      recoverAtomicNoReplaceJson(this.lockDir,options);
      const stat = fs.lstatSync(this.lockDir);
      if (stat.isDirectory() && !stat.isSymbolicLink())
        fail('INSUFFICIENT_CAPACITY', 'A legacy archive-cache helper may still own or initialize this cache; its lock was left intact');
      assertOwnedRegular(stat, 'Cache lock protocol', METADATA_LIMIT);
      if ((stat.mode & 0o077) !== 0) fail('UNSAFE_PATH', 'Cache lock protocol permissions are not private');
      let protocol:unknown;try{protocol=JSON.parse(fs.readFileSync(this.lockDir,'utf8')).protocol;}catch{}
      if(protocol!==CACHE_LOCK_PROTOCOL)fail('INCOMPATIBLE_INPUT','Archive-cache lock protocol is invalid');
    }
    const result=withStateLock(this.root,callback);
    if(result&&typeof (result as any).then==='function')fail('PERSISTENCE_FAILED','Archive-cache operation unexpectedly became asynchronous');
    return result as T;
  }
}

export function publicArchiveCacheRoot(): string {
  return join(privateRoot(), 'public-cache');
}
