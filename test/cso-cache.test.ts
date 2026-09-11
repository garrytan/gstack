import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PublicArchiveCache } from '../lib/cso/cache';
import { CsoError } from '../lib/cso/contracts';

const roots: string[] = [];
function fixture(maxBytes = 1024, now: () => number = Date.now) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cso-cache-'));
  roots.push(root);
  const staging = path.join(root, 'staging'), cacheRoot = path.join(root, 'cache');
  fs.mkdirSync(staging, { mode: 0o700 });
  return { root, staging, cacheRoot, cache: new PublicArchiveCache({ root: cacheRoot, stagingRoot: staging, maxBytes, now }) };
}
function stage(staging: string, name: string, value: string | Buffer): { path: string; digest: string } {
  const file = path.join(staging, name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
  return { path: name, digest: createHash('sha256').update(value).digest('hex') };
}
function code(fn: () => unknown): string | undefined {
  try { fn(); return undefined; }
  catch (error) { return error instanceof CsoError ? error.code : undefined; }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('CSO immutable public archive cache', () => {
  test('promotes only matching bytes and verifies the full hash on every hit', () => {
    let tick = 100;
    const { staging, cacheRoot, cache } = fixture(1024, () => tick++);
    const archive = stage(staging, 'pkg.tgz', 'verified-public-archive');
    const entry = cache.promote(archive.path, archive.digest);
    expect(fs.readFileSync(entry.path, 'utf8')).toBe('verified-public-archive');
    expect(fs.statSync(cacheRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(entry.path).mode & 0o777).toBe(0o400);
    expect(fs.statSync(path.join(cacheRoot, 'metadata', `${archive.digest}.json`)).mode & 0o777).toBe(0o600);
    expect(cache.get(archive.digest)?.lastAccessedAt).toBeGreaterThan(entry.lastAccessedAt);

    fs.chmodSync(entry.path, 0o600);
    fs.writeFileSync(entry.path, 'poisoned-public-archive');
    fs.chmodSync(entry.path, 0o400);
    expect(code(() => cache.get(archive.digest))).toBe('INCOMPATIBLE_INPUT');
  });

  test('rejects traversal, symlinks, hard links, directories, oversized files, and hash mismatches', () => {
    const { root, staging, cache } = fixture(16);
    const good = stage(staging, 'good', 'good');
    expect(code(() => cache.promote('../good', good.digest))).toBe('UNSAFE_PATH');

    fs.symlinkSync(path.join(staging, 'good'), path.join(staging, 'link'));
    expect(code(() => cache.promote('link', good.digest))).toBe('UNSAFE_PATH');
    fs.linkSync(path.join(staging, 'good'), path.join(staging, 'hard'));
    expect(code(() => cache.promote('hard', good.digest))).toBe('UNSAFE_PATH');
    fs.unlinkSync(path.join(staging, 'hard'));
    fs.mkdirSync(path.join(staging, 'directory'));
    expect(code(() => cache.promote('directory', good.digest))).toBe('UNSAFE_PATH');

    const large = stage(staging, 'large', Buffer.alloc(17, 1));
    expect(code(() => cache.promote(large.path, large.digest))).toBe('INSUFFICIENT_CAPACITY');
    expect(code(() => cache.promote(good.path, '0'.repeat(64)))).toBe('INCOMPATIBLE_INPUT');
    expect(code(() => cache.promote('/absolute', good.digest))).toBe('UNSAFE_PATH');
    expect(code(() => cache.promote(good.path, 'SHA256:bad'))).toBe('INVALID_ARGUMENT');
    expect(fs.readdirSync(path.join(root, 'cache', 'entries'))).toEqual([]);
  });

  test('evicts least-recently-used entries within a configurable byte ceiling', () => {
    let now = 0;
    const { staging, cache } = fixture(8, () => ++now);
    const first = stage(staging, 'first', '1111');
    const second = stage(staging, 'second', '2222');
    const third = stage(staging, 'third', '3333');
    cache.promote(first.path, first.digest);
    cache.promote(second.path, second.digest);
    cache.get(first.digest);
    cache.promote(third.path, third.digest);
    expect(cache.get(first.digest)).toBeDefined();
    expect(cache.get(second.digest)).toBeUndefined();
    expect(cache.get(third.digest)).toBeDefined();
    expect(cache.stats()).toEqual({ entries: 2, bytes: 8, maxBytes: 8 });
  });

  test('a hash-mismatched staging object cannot evict verified LRU entries', () => {
    const { staging, cache } = fixture(8);
    const first = stage(staging, 'first-kept', '1111');
    const second = stage(staging, 'second-kept', '2222');
    cache.promote(first.path, first.digest);
    cache.promote(second.path, second.digest);
    const invalid = stage(staging, 'invalid', '3333');
    expect(code(() => cache.promote(invalid.path, '0'.repeat(64)))).toBe('INCOMPATIBLE_INPUT');
    expect(cache.get(first.digest)).toBeDefined();
    expect(cache.get(second.digest)).toBeDefined();
    expect(cache.stats()).toEqual({ entries: 2, bytes: 8, maxBytes: 8 });
  });

  test('materializes one immutable run-owned set atomically before later eviction', () => {
    const { root, staging, cache } = fixture(8);
    const first = stage(staging, 'first-pin', '1111'), second = stage(staging, 'second-pin', '2222');
    cache.promote(first.path, first.digest); cache.promote(second.path, second.digest);
    const destination = path.join(root, 'run-owned'); fs.mkdirSync(destination, { mode: 0o700 });
    const copies = cache.materialize([first.digest, second.digest], destination);
    expect(copies.map(item => item.sha256)).toEqual([first.digest, second.digest].sort());
    const third = stage(staging, 'third-pin', '3333'); cache.promote(third.path, third.digest);
    expect(copies.every(item => fs.existsSync(item.path) && (fs.statSync(item.path).mode & 0o777) === 0o400)).toBe(true);
    expect(copies.map(item => createHash('sha256').update(fs.readFileSync(item.path)).digest('hex')).sort()).toEqual([first.digest, second.digest].sort());
  });

  test('bounds every public operation by an optional absolute deadline', () => {
    const { root, staging, cache } = fixture(1024);
    const archive = stage(staging, 'deadline', 'bounded');
    const expired = Date.now() - 1;
    expect(code(() => cache.promote(archive.path, archive.digest, expired))).toBe('DEADLINE');
    const entry = cache.promote(archive.path, archive.digest);
    expect(code(() => cache.get(entry.sha256, { deadline: expired }))).toBe('DEADLINE');
    expect(code(() => cache.stats({ deadline: expired }))).toBe('DEADLINE');
    const destination = path.join(root, 'deadline-materialization'); fs.mkdirSync(destination, { mode: 0o700 });
    expect(code(() => cache.materialize([entry.sha256], destination, { deadline: expired }))).toBe('DEADLINE');
    expect(fs.readdirSync(destination)).toEqual([]);
  });

  test('cancels between archive-copy chunks and removes the partial incoming object', () => {
    const { staging, cacheRoot, cache } = fixture(512 * 1024);
    const archive = stage(staging, 'cancel-copy', Buffer.alloc(192 * 1024, 0x61));
    const controller = new AbortController(), original = fs.writeSync.bind(fs); let archiveWrites = 0;
    const writer = spyOn(fs, 'writeSync').mockImplementation(((fd: number, buffer: string | NodeJS.ArrayBufferView,
      offsetOrPosition?: number | null, lengthOrEncoding?: number | BufferEncoding, position?: number | null) => {
      const written = (original as any)(fd, buffer, offsetOrPosition, lengthOrEncoding, position);
      if (Buffer.isBuffer(buffer) && lengthOrEncoding === 64 * 1024 && written > 0) { archiveWrites++; controller.abort(); }
      return written;
    }) as typeof fs.writeSync);
    try {
      expect(code(() => cache.promote(archive.path, archive.digest, { deadline: Date.now() + 60_000, signal: controller.signal }))).toBe('CANCELLED');
    } finally { writer.mockRestore(); }
    expect(archiveWrites).toBe(1);
    expect(fs.readdirSync(path.join(cacheRoot, 'incoming'))).toEqual([]);
    expect(fs.readdirSync(path.join(cacheRoot, 'entries'))).toEqual([]);
    expect(fs.readdirSync(path.join(cacheRoot, 'metadata'))).toEqual([]);
  });

  test('cancels between cache-hit read chunks without damaging the immutable entry', () => {
    const { staging, cacheRoot, cache } = fixture(512 * 1024);
    const archive = stage(staging, 'cancel-read', Buffer.alloc(192 * 1024, 0x62)), entry = cache.promote(archive.path, archive.digest);
    const controller = new AbortController(), original = fs.readSync.bind(fs); let archiveReads = 0;
    const reader = spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView,
      offset: number, length: number, position: number | null) => {
      const read = original(fd, buffer, offset, length, position);
      if (length === 64 * 1024 && read > 0) { archiveReads++; controller.abort(); }
      return read;
    }) as typeof fs.readSync);
    try {
      expect(code(() => cache.get(entry.sha256, { signal: controller.signal }))).toBe('CANCELLED');
    } finally { reader.mockRestore(); }
    expect(archiveReads).toBe(1);
    expect(fs.existsSync(entry.path)).toBe(true);
    expect(fs.readdirSync(path.join(cacheRoot, 'metadata'))).toEqual([`${entry.sha256}.json`]);
  });

  test('never overwrites an immutable entry and recovers interrupted entry publication', () => {
    const { staging, cacheRoot, cache } = fixture();
    const archive = stage(staging, 'one', 'same bytes');
    const first = cache.promote(archive.path, archive.digest);
    const inode = fs.statSync(first.path).ino;
    stage(staging, 'two', 'same bytes');
    const again = cache.promote('two', archive.digest);
    expect(fs.statSync(again.path).ino).toBe(inode);

    fs.unlinkSync(path.join(cacheRoot, 'metadata', `${archive.digest}.json`));
    expect(cache.get(archive.digest)).toBeUndefined();
    expect(fs.existsSync(first.path)).toBe(false);
    expect(cache.promote(archive.path, archive.digest).sha256).toBe(archive.digest);
  });

  test('recovers dead immutable leases, never expires a live owner by age, and fences legacy directories', () => {
    const stale = fixture();
    stale.cache.stats();const staleLeases=path.join(stale.cacheRoot,'.mutation-lock-leases'),staleToken='a'.repeat(32),staleLease=path.join(staleLeases,`${staleToken}.json`);
    fs.writeFileSync(staleLease,JSON.stringify({pid:2147483647,processIdentity:'linux:1',token:staleToken,createdAt:1})+'\n',{mode:0o600});
    expect(stale.cache.stats()).toEqual({ entries: 0, bytes: 0, maxBytes: 1024 });
    expect(fs.existsSync(staleLease)).toBe(false);expect(fs.lstatSync(path.join(stale.cacheRoot,'.lock')).isFile()).toBe(true);

    const ownerless = fixture();
    fs.mkdirSync(path.join(ownerless.cacheRoot, '.lock'), { mode: 0o700 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(ownerless.cacheRoot, '.lock'), old, old);
    expect(code(()=>ownerless.cache.stats())).toBe('INSUFFICIENT_CAPACITY');expect(fs.lstatSync(path.join(ownerless.cacheRoot,'.lock')).isDirectory()).toBe(true);

    const live = fixture();
    live.cache.stats();const liveLeases=path.join(live.cacheRoot,'.mutation-lock-leases'),liveToken='b'.repeat(32),liveLease=path.join(liveLeases,`${liveToken}.json`);
    fs.writeFileSync(liveLease,JSON.stringify({pid:process.pid,token:liveToken,createdAt:1})+'\n',{mode:0o600});fs.utimesSync(liveLease,old,old);
    expect(code(() => live.cache.stats())).toBe('INSUFFICIENT_CAPACITY');
  });

  test('recovers an exact cache-protocol publication link and rejects an unrecognized one',()=>{
    const recovered=fixture(),lock=path.join(recovered.cacheRoot,'.lock'),temporary=`${lock}.tmp.2147483647.deadbeef`;
    fs.writeFileSync(lock,JSON.stringify({protocol:'immutable-cache-lease-set-v3'})+'\n',{mode:0o600,flag:'wx'});fs.linkSync(lock,temporary);
    expect(recovered.cache.stats()).toEqual({entries:0,bytes:0,maxBytes:1024});expect(fs.statSync(lock).nlink).toBe(1);expect(fs.existsSync(temporary)).toBe(false);
    const poisoned=fixture(),poisonedLock=path.join(poisoned.cacheRoot,'.lock'),unrecognized=`${poisonedLock}.tmp.dead.bad`;
    fs.writeFileSync(poisonedLock,JSON.stringify({protocol:'immutable-cache-lease-set-v3'})+'\n',{mode:0o600,flag:'wx'});fs.linkSync(poisonedLock,unrecognized);
    expect(code(()=>poisoned.cache.stats())).toBe('UNSAFE_PATH');expect(fs.statSync(poisonedLock).nlink).toBe(2);
  });

  test('recovers orphan metadata and transaction tombs but refuses poisoned recovery objects', () => {
    const { root, cacheRoot, cache } = fixture();
    const digest = 'c'.repeat(64);
    fs.writeFileSync(path.join(cacheRoot, 'metadata', `${digest}.json`), JSON.stringify({
      version: 1, sha256: digest, bytes: 1, createdAt: 1, lastAccessedAt: 1,
    }), { mode: 0o600 });
    const tomb = `.recovery-entry-${digest}-${process.pid}-${'d'.repeat(24)}`;
    fs.writeFileSync(path.join(cacheRoot, 'recovery', tomb), 'interrupted', { mode: 0o400 });
    expect(cache.stats().entries).toBe(0);
    expect(fs.readdirSync(path.join(cacheRoot, 'metadata'))).toEqual([]);
    expect(fs.readdirSync(path.join(cacheRoot, 'recovery'))).toEqual([]);

    const outside = path.join(root, 'outside-recovery');
    fs.writeFileSync(outside, 'untouched');
    fs.symlinkSync(outside, path.join(cacheRoot, 'entries', digest));
    expect(code(() => cache.get(digest))).toBe('UNSAFE_PATH');
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
  });

  test('recovers atomic-write and publication hard links left by process death', () => {
    const { staging, cacheRoot, cache } = fixture();
    const archive = stage(staging, 'archive', 'crash-safe');
    const entry = cache.promote(archive.path, archive.digest);
    const metadata = path.join(cacheRoot, 'metadata', `${archive.digest}.json`);
    fs.linkSync(metadata, `${metadata}.tmp.999.${'e'.repeat(8)}`);
    expect(fs.statSync(metadata).nlink).toBe(2);
    expect(cache.get(archive.digest)?.sha256).toBe(archive.digest);
    expect(fs.statSync(metadata).nlink).toBe(1);

    const incoming = path.join(cacheRoot, 'incoming', `.incoming-999-${'f'.repeat(24)}`);
    fs.linkSync(entry.path, incoming);
    fs.unlinkSync(metadata);
    expect(fs.statSync(entry.path).nlink).toBe(2);
    expect(cache.get(archive.digest)).toBeUndefined();
    expect(fs.existsSync(incoming)).toBe(false);
    expect(fs.existsSync(entry.path)).toBe(false);
  });

  test('a paused immutable lease publisher cannot be age-reclaimed or overlap a contender', () => {
    const { cacheRoot, cache } = fixture(),lock=path.join(cacheRoot,'.lock'),leases=path.join(cacheRoot,'.mutation-lock-leases'),originalMkdir=fs.mkdirSync,originalUnlink=fs.unlinkSync;
    let paused=false,contenderResult:string|undefined;
    const contend=(published:string)=>{paused=true;const old=new Date(Date.now()-60_000);fs.utimesSync(published,old,old);contenderResult=code(()=>cache.stats());};
    // The mkdir hook deterministically reproduces the former empty-directory
    // publication. The unlink hook pauses the immutable replacement after its
    // complete inode is visible and its temporary hard link is gone.
    const mkdir=spyOn(fs,'mkdirSync').mockImplementation(((target:fs.PathLike,options?:fs.MakeDirectoryOptions & {recursive?:false})=>{const result=originalMkdir(target,options as any);if(!paused&&String(target)===lock)contend(lock);return result;}) as typeof fs.mkdirSync);
    const unlink=spyOn(fs,'unlinkSync').mockImplementation(((target:fs.PathLike)=>{const value=String(target),result=originalUnlink(target);if(!paused&&value.startsWith(`${leases}${path.sep}`)&&/^[a-f0-9]{32}\.json\.tmp\.\d+\.[a-f0-9]{8}$/.test(path.basename(value)))contend(value.replace(/\.tmp\.\d+\.[a-f0-9]{8}$/,''));return result;}) as typeof fs.unlinkSync);
    let result;try{result=cache.stats();}finally{unlink.mockRestore();mkdir.mockRestore();}
    expect(paused).toBe(true);expect(contenderResult).toBe('INSUFFICIENT_CAPACITY');expect(result).toEqual({entries:0,bytes:0,maxBytes:1024});expect(fs.readdirSync(leases)).toEqual([]);expect(fs.lstatSync(lock).isFile()).toBe(true);
  });

  test('LRU eviction refuses poisoned links without following or deleting their targets', () => {
    const { root, staging, cacheRoot, cache } = fixture(4);
    const outside = path.join(root, 'outside');
    fs.writeFileSync(outside, 'do-not-touch', { mode: 0o600 });
    const digest = 'a'.repeat(64);
    fs.symlinkSync(outside, path.join(cacheRoot, 'entries', digest));
    fs.writeFileSync(path.join(cacheRoot, 'metadata', `${digest}.json`), JSON.stringify({ version: 1, sha256: digest, bytes: 12, createdAt: 1, lastAccessedAt: 1 }), { mode: 0o600 });
    const fresh = stage(staging, 'fresh', '1234');
    expect(code(() => cache.promote(fresh.path, fresh.digest))).toBe('UNSAFE_PATH');
    expect(fs.readFileSync(outside, 'utf8')).toBe('do-not-touch');
  });

  test('fails closed on cache locks and poisoned incoming paths', () => {
    const { staging, cacheRoot, cache } = fixture();
    const archive = stage(staging, 'one', 'archive');
    const lockTarget = path.join(cacheRoot, 'outside-lock');
    fs.writeFileSync(lockTarget, 'lock-target');
    fs.symlinkSync(lockTarget, path.join(cacheRoot, '.lock'));
    expect(code(() => cache.promote(archive.path, archive.digest))).toBe('UNSAFE_PATH');
    fs.unlinkSync(path.join(cacheRoot, '.lock'));

    const outside = path.join(cacheRoot, 'outside-incoming');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(cacheRoot, 'incoming', `.incoming-${process.pid}-${'b'.repeat(24)}`));
    expect(code(() => cache.promote(archive.path, archive.digest))).toBe('UNSAFE_PATH');
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
  });
});
