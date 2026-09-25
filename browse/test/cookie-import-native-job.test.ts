import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { nativeBrowserPaths } from '../src/cookie-import-native';
import { NATIVE_BROWSER_VERSION_COMMAND } from '../src/cookie-import-native-integrity';
import { createNativeCookieJob, joinNativeCookieJob, NativeCookieJobError, nativeCookieDiagnostic, parseNativeCookieDiagnostic, type NativeCookieJob } from '../src/cookie-import-native-job';
import { nativeCookieEnvironment, NATIVE_COOKIE_NODE_SCRIPT, superviseNativeCookieImport, type NativeCookieMember, type NativeCookieReply, type NativeCookieRequest } from '../src/cookie-import-native-worker';
import { decodeNativeCommandLine } from './fixtures/native-cookie-process-observer';
import { createFixtureDeleteLease, FixtureDeleteError } from './fixtures/native-cookie-delete-lease';

const root = mkdtempSync(path.join(tmpdir(), 'cookie-job-'));
const resolvedRoot = realpathSync(root);
const initialRootState = lstatSync(root, { bigint: true });
const fixtureChildren = new Set<ChildProcess>();
const fixturePrimitiveFailures = new WeakMap<object, object>();

function removeOwnedFixtureDirectory(directory: string, identity: { dev: bigint; ino: bigint }, operations = {
  lstat: (file: string) => lstatSync(file, { bigint: true }),
  enumerate: (file: string) => readdirSync(file),
  unlink: (file: string, _identity: { dev: bigint; ino: bigint; mode: bigint }, _verify: () => void) => unlinkSync(file),
  rmdir: (file: string) => rmdirSync(file),
}): void {
  let primitive = 'identity';
  let object = directory;
  let objectIdentityMatched = false;
  let rootIdentityMatched = false;
  let objectIdentity: { dev: bigint; ino: bigint; mode: bigint } | undefined;
  const ancestors: { file: string; dev: bigint; ino: bigint }[] = [{ file: root, dev: initialRootState.dev, ino: initialRootState.ino }];
  const inspect = (file: string) => {
    primitive = 'lstat'; object = file; objectIdentityMatched = false;
    objectIdentity = undefined;
    const state = operations.lstat(file);
    objectIdentity = { dev: state.dev, ino: state.ino, mode: state.mode };
    return state;
  };
  const verifyAncestors = (stopBefore?: string) => {
    for (const ancestor of ancestors) {
      if (ancestor.file === stopBefore) break;
      if (ancestor.file === root) rootIdentityMatched = false;
      const state = inspect(ancestor.file);
      const matches = state.isDirectory() && !state.isSymbolicLink() && state.dev === ancestor.dev && state.ino === ancestor.ino;
      if (ancestor.file === root) rootIdentityMatched = matches;
      if (!matches) { primitive = 'identity'; throw new Error('Native fixture ancestor identity changed'); }
      objectIdentityMatched = true;
    }
  };
  const remove = (file: string, expected?: { dev: bigint; ino: bigint }) => {
    const ancestorCount = ancestors.length;
    try {
      verifyAncestors();
      const state = inspect(file);
      if (expected && (state.dev !== expected.dev || state.ino !== expected.ino || !state.isDirectory() || state.isSymbolicLink())) {
        primitive = 'identity'; throw new Error('Native fixture directory identity changed');
      }
      if (state.isDirectory() && !state.isSymbolicLink()) {
        ancestors.push({ file, dev: state.dev, ino: state.ino });
        verifyAncestors();
        primitive = 'enumerate'; object = file; objectIdentityMatched = true;
        const entries = operations.enumerate(file);
        for (const entry of entries) {
          if (!entry || entry === '.' || entry === '..' || path.basename(entry) !== entry) {
            primitive = 'identity'; object = file; throw new Error('Native fixture enumeration escaped its directory');
          }
          remove(path.join(file, entry));
        }
        verifyAncestors();
        primitive = 'rmdir'; object = file; objectIdentityMatched = true;
        operations.rmdir(file);
      } else {
        const verify = () => {
          verifyAncestors();
          if (realpathSync(root) !== resolvedRoot) { primitive = 'identity'; throw new Error('Native fixture root path changed'); }
          const current = inspect(file);
          if (current.dev !== state.dev || current.ino !== state.ino || current.mode !== state.mode) {
            primitive = 'identity'; throw new Error('Native fixture entry identity changed');
          }
          primitive = 'unlink'; object = file; objectIdentityMatched = true;
        };
        verify();
        operations.unlink(file, state, verify);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || object !== file) throw error;
      const failedPrimitive = primitive;
      const matchedBeforeFailure = objectIdentityMatched;
      verifyAncestors(file);
      try { inspect(file); }
      catch (absenceError) {
        if ((absenceError as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw absenceError;
      }
      primitive = failedPrimitive; object = file; objectIdentityMatched = matchedBeforeFailure;
      throw error;
    } finally {
      ancestors.length = ancestorCount;
    }
  };
  try {
    const relative = path.relative(path.resolve(root), path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Native fixture removal must stay below its owned root');
    verifyAncestors();
    if (realpathSync(root) !== resolvedRoot) { primitive = 'identity'; rootIdentityMatched = false; throw new Error('Native fixture root path changed'); }
    let parent = root;
    for (const part of relative.split(path.sep).slice(0, -1)) {
      verifyAncestors();
      parent = path.join(parent, part);
      const state = inspect(parent);
      if (!state.isDirectory() || state.isSymbolicLink()) { primitive = 'identity'; throw new Error('Native fixture ancestor is not an owned directory'); }
      ancestors.push({ file: parent, dev: state.dev, ino: state.ino });
    }
    remove(directory, identity);
    verifyAncestors();
    primitive = 'postcondition'; object = directory; objectIdentityMatched = false;
    try { operations.lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw new Error('Native fixture directory remains after removal');
  } catch (error) {
    const relative = path.relative(path.resolve(directory), path.resolve(object));
    if (error && typeof error === 'object') fixturePrimitiveFailures.set(error, {
      primitive, rootIdentityMatched, objectIdentityMatched,
      ...(objectIdentity ? { objectDev: objectIdentity.dev.toString(), objectIno: objectIdentity.ino.toString(), objectMode: Number(objectIdentity.mode) } : {}),
      relativeObjectHash: !relative.startsWith('..') && !path.isAbsolute(relative) ? createHash('sha256').update(relative).digest('hex') : undefined,
      objectScope: object === directory ? 'target' : relative.startsWith('..') || path.isAbsolute(relative) ? 'ancestor' : 'child',
    });
    throw error;
  }
}

function resetOwnedProfileDirectory(directory: string, identity: { dev: bigint; ino: bigint }, supervisionDeadline: number): void {
  const lease = createFixtureDeleteLease(Math.min(supervisionDeadline, performance.now() + 5_000));
  try {
    removeOwnedFixtureDirectory(directory, identity, {
      lstat: file => lstatSync(file, { bigint: true }), enumerate: file => readdirSync(file),
      unlink: lease.unlink, rmdir: file => rmdirSync(file),
    });
  } finally { lease.close(); }
}

function ownFixtureChild<T extends ChildProcess>(child: T): T {
  fixtureChildren.add(child);
  child.once('close', () => fixtureChildren.delete(child));
  return child;
}

function nativeFixtureEnvironment(fixture: string, node: string): Record<string, string> {
  const relative = path.relative(resolvedRoot, realpathSync(fixture));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Native environment fixture is outside its owned root');
  const local = path.join(fixture, 'AppData', 'Local');
  const roaming = path.join(fixture, 'AppData', 'Roaming');
  const temporary = path.join(local, 'Temp');
  for (const directory of [local, roaming, temporary]) mkdirSync(directory, { recursive: true });
  return nativeCookieEnvironment({
    SystemRoot: process.env.SystemRoot, USERPROFILE: fixture,
    LOCALAPPDATA: local, APPDATA: roaming, TEMP: temporary, TMP: temporary,
    PATH: path.dirname(node),
  });
}

function fixtureFileOwners(file: string, timeout = 5_000, expectedIdentity?: { dev: string; ino: string }): object {
  if (process.platform !== 'win32') return { available: false, reason: 'not_windows' };
  const result = spawnSync(process.execPath, [
    '--no-env-file', '--no-install', '--no-macros', '--config=NUL', path.resolve(import.meta.dir, 'fixtures/native-cookie-file-owners.ts'),
    Buffer.from(JSON.stringify({ root: resolvedRoot, file, testPid: process.pid, expectedIdentity })).toString('base64'),
  ], { env: nativeCookieEnvironment(process.env), encoding: 'utf8', timeout, maxBuffer: 65536, windowsHide: true });
  try { return { ...JSON.parse(result.stdout), exitCode: result.status, stderrBytes: Buffer.byteLength(result.stderr || '') }; }
  catch { return { available: false, reason: 'owner_probe_no_receipt', exitCode: result.status }; }
}

function fixtureRemovalEvidence(error: unknown, directory: string, identity: { dev: bigint; ino: bigint }, probeOwners = fixtureFileOwners): object {
  const failure = error as NodeJS.ErrnoException;
  const primitive = error && typeof error === 'object' ? fixturePrimitiveFailures.get(error) as {
    primitive: string; relativeObjectHash?: string; objectDev?: string; objectIno?: string;
  } | undefined : undefined;
  const evidence = {
    code: ['EBUSY', 'EPERM', 'EACCES', 'ENOENT', 'ENOTEMPTY', 'ENOTDIR'].includes(failure?.code || '') ? failure.code : 'filesystem_error',
    syscall: ['rm', 'rmdir', 'unlink', 'scandir', 'lstat', 'open', 'fstat', 'close'].includes(failure?.syscall || '') ? failure.syscall : 'unavailable',
    errno: Number.isSafeInteger(failure?.errno) ? failure.errno : undefined,
    pendingChildCloses: fixtureChildren.size,
    ...(error instanceof FixtureDeleteError ? { deletionStage: error.stage, win32Error: error.win32Error, deadlineExceeded: error.deadlineExceeded } : {}),
    ...(error && typeof error === 'object' ? fixturePrimitiveFailures.get(error) : undefined),
  };
  try {
    const rootState = lstatSync(root, { bigint: true });
    if (rootState.isSymbolicLink() || rootState.dev !== initialRootState.dev || rootState.ino !== initialRootState.ino || realpathSync(root) !== resolvedRoot) {
      return { ...evidence, inspected: false, reason: 'root_identity_changed' };
    }
    const relative = path.relative(resolvedRoot, path.resolve(directory));
    const parts = relative ? relative.split(path.sep) : [];
    if (relative.startsWith('..') || path.isAbsolute(relative) || parts.length > 16) return { ...evidence, inspected: false, reason: 'outside_owned_fixture' };
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      if (lstatSync(current).isSymbolicLink()) return { ...evidence, inspected: false, reason: 'linked_object' };
    }
    const state = lstatSync(directory, { bigint: true });
    if (!state.isDirectory() || state.dev !== identity.dev || state.ino !== identity.ino) return { ...evidence, inspected: false, reason: 'object_identity_changed' };
    const reported = typeof failure.path === 'string' ? path.relative(directory, path.resolve(failure.path)) : null;
    let fileOwners: object | undefined;
    if (failure.code === 'EBUSY' && primitive?.primitive === 'unlink' && reported && !reported.startsWith('..') && !path.isAbsolute(reported)
      && createHash('sha256').update(reported).digest('hex') === primitive.relativeObjectHash) {
      try {
        const file = path.join(directory, reported);
        const current = lstatSync(file, { bigint: true });
        const resolved = realpathSync(file);
        if (!current.isFile() || current.isSymbolicLink() || current.dev.toString() !== primitive.objectDev
          || current.ino.toString() !== primitive.objectIno || path.relative(realpathSync(directory), resolved) !== reported) {
          fileOwners = { available: false, reason: 'failed_object_identity_changed' };
        } else {
          fileOwners = probeOwners(file, 5_000, { dev: primitive.objectDev!, ino: primitive.objectIno! });
        }
      } catch (probeError) {
        const code = (probeError as NodeJS.ErrnoException).code;
        fileOwners = { available: false, reason: 'failed_object_unavailable', errorCode: ['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(code || '') ? code : 'filesystem_error' };
      }
    }
    const entries: { nameHash: string; type: string }[] = [];
    const listing = opendirSync(directory);
    let entriesTruncated = false;
    try {
      while (entries.length < 16) {
        const entry = listing.readSync();
        if (!entry) break;
        entries.push({ nameHash: createHash('sha256').update(entry.name).digest('hex'), type: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
      }
      entriesTruncated = entries.length === 16 && listing.readSync() !== null;
    } finally { listing.closeSync(); }
    return {
      ...evidence, inspected: true, directoryIdentityMatched: true, directoryMode: Number(state.mode),
      reportedPath: reported === null ? 'unavailable' : reported === '' ? 'target' : reported.startsWith('..') || path.isAbsolute(reported) ? 'outside_target' : 'child',
      reportedPathHash: reported !== null && !reported.startsWith('..') && !path.isAbsolute(reported) ? createHash('sha256').update(reported).digest('hex') : undefined,
      entries, entriesTruncated, ...(fileOwners ? { fileOwners } : {}),
    };
  } catch (inspectionError) {
    const code = (inspectionError as NodeJS.ErrnoException).code;
    return { ...evidence, inspected: false, reason: 'inspection_failed', inspectionCode: ['ENOENT', 'EBUSY', 'EPERM', 'EACCES', 'ENOTDIR'].includes(code || '') ? code : 'filesystem_error' };
  }
}

function clearOwnedFixtureContents(fixture: string, identity: { path: string; dev: bigint; ino: bigint }, listEntries: (directory: string) => string[] = readdirSync): void {
  const before = lstatSync(fixture, { bigint: true });
  if (before.isSymbolicLink() || realpathSync(fixture) !== identity.path || before.dev !== identity.dev || before.ino !== identity.ino) {
    throw new Error('Native fixture root identity changed');
  }
  const ownerProbeDeadline = Date.now() + 5_000;
  for (const entry of listEntries(fixture)) {
    const child = path.join(fixture, entry);
    try {
      const state = lstatSync(child);
      if (state.isSymbolicLink()) {
        unlinkSync(child);
        continue;
      }
      const relative = path.relative(identity.path, realpathSync(child));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Native fixture entry is outside its owned root');
      const ownersBeforeDelete = state.isFile() && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/i.test(entry)
        ? Date.now() < ownerProbeDeadline ? fixtureFileOwners(child, Math.max(1, ownerProbeDeadline - Date.now())) : { available: false, reason: 'owner_probe_budget_exhausted' }
        : undefined;
      if (ownersBeforeDelete) console.log(JSON.stringify({ nativeFixtureBeforeDelete: { file: path.relative(resolvedRoot, child), owners: ownersBeforeDelete } }));
      try { rmSync(child, { recursive: true, force: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        console.error(JSON.stringify({ nativeFixtureFileLock: {
          file: path.relative(resolvedRoot, child), code: (error as NodeJS.ErrnoException).code, ownersBeforeDelete,
          ownersAfterFailure: state.isFile() ? fixtureFileOwners(child) : undefined,
        } }));
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  const after = lstatSync(fixture, { bigint: true });
  if (readdirSync(fixture).length !== 0 || realpathSync(fixture) !== identity.path || after.dev !== identity.dev || after.ino !== identity.ino) {
    throw new Error('Native fixture contents reset did not preserve its empty root');
  }
}

afterAll(() => {
  try {
    if (existsSync(root) && realpathSync(root) !== resolvedRoot) throw new Error('Native fixture root ownership changed');
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    console.error(JSON.stringify({ nativeFixtureRemovalFailure: { stage: 'after_all', ...fixtureRemovalEvidence(error, root, initialRootState) } }));
    const entries: { path: string; type: string; mode?: number; code?: string }[] = [];
    let rootVerified = false;
    let rootMode: number | null = null;
    try { rootVerified = realpathSync(root) === resolvedRoot; rootMode = lstatSync(root).mode; } catch {}
    const pending = rootVerified ? [root] : [];
    while (pending.length && entries.length < 128) {
      const directory = pending.shift()!;
      try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entries.length >= 128) break;
          const child = path.join(directory, entry.name);
          const state = lstatSync(child);
          entries.push({ path: path.relative(root, child), type: state.isSymbolicLink() ? 'link' : state.isDirectory() ? 'directory' : 'file', mode: state.mode });
          if (state.isDirectory() && !state.isSymbolicLink() && realpathSync(child).startsWith(resolvedRoot + path.sep)) pending.push(child);
        }
      } catch (inspectionError) {
        entries.push({ path: path.relative(root, directory), type: 'unreadable', code: (inspectionError as NodeJS.ErrnoException).code });
      }
    }
    const lockedFile = entries.find(entry => entry.type === 'file' && /^[0-9a-f-]{36}\.tmp$/i.test(path.basename(entry.path)));
    console.error(JSON.stringify({ nativeFixtureCleanup: { code: (error as NodeJS.ErrnoException).code, pendingChildCloses: fixtureChildren.size, rootVerified, rootMode, remaining: entries,
      fileOwners: lockedFile ? { file: lockedFile.path, owners: fixtureFileOwners(path.join(root, lockedFile.path)) } : undefined,
    } }));
    const node = Bun.which('node');
    if (rootVerified && node) {
      const comparison = spawnSync(node, [path.resolve(import.meta.dir, 'fixtures/native-cookie-remove-fixture.cjs'), Buffer.from(JSON.stringify({
        root, realpath: resolvedRoot, dev: initialRootState.dev.toString(), ino: initialRootState.ino.toString(),
      })).toString('base64')], { env: nativeCookieEnvironment(process.env), encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 65536 });
      let evidence: object;
      try { evidence = JSON.parse(comparison.stdout); }
      catch { evidence = { removed: false, reason: 'node_cleanup_no_receipt', exitCode: comparison.status }; }
      console.error(JSON.stringify({ nativeFixtureNodeCleanupComparison: evidence }));
    }
    throw error;
  }
}, 15_000);

const request: NativeCookieRequest = {
  nodeExecutable: 'C:\\fixture\\node.exe',
  nodeArchitecture: process.arch,
  playwrightEntry: 'C:\\fixture\\playwright.cjs',
  executablePath: 'C:\\fixture\\msedge.exe',
  userDataDir: 'C:\\fixture\\User Data',
  profile: 'Default',
  domains: ['example.test'],
  deadline: 25_000,
  qualifiedBunVersions: ['1.4.0'],
};

function kernelContract(mode: string) {
  const script = `
    const calls = [];
    globalThis.__nativeCookieFfi = {
      FFIType: { ptr: 'ptr', u64: 'u64', u32: 'u32', i32: 'i32' },
      ptr: buffer => buffer,
      dlopen: (name, signatures) => {
        calls.push(['library', name, Object.keys(signatures)]);
        return { close() { calls.push(['unload']); }, symbols: {
          CreateJobObjectW: (security, name) => { calls.push(['create', security, name.toString('utf16le')]); return 42; },
          OpenJobObjectW: (access, inherit, name) => { calls.push(['open', access, inherit, name.toString('utf16le')]); return 42; },
          SetInformationJobObject: (handle, kind, buffer, length) => { calls.push(['limits', handle, kind, length, buffer.readUInt32LE(16)]); return 1; },
          QueryInformationJobObject: (handle, kind, buffer, length) => { calls.push(['query', handle, kind, length]); buffer.writeUInt32LE(3, 40); return 1; },
          OpenProcess: (access, inherit, pid) => { calls.push(['open-process', access, inherit, pid === process.pid]); return 999; },
          AssignProcessToJobObject: (job, process) => { calls.push(['assign', job, process]); return ${mode === 'join-fail' ? 0 : 1}; },
          TerminateJobObject: (job, code) => { calls.push(['terminate', job, code]); return 1; },
          CloseHandle: handle => { calls.push(['close', handle]); return 1; },
          GetLastError: () => ${mode === 'join-fail' ? 5 : 0},
        } };
      },
    };
    const source = await Bun.file(${JSON.stringify(path.resolve(import.meta.dir, '../src/cookie-import-native-job.ts'))}).text();
    const boundary = "await import('bun:ffi')";
    if (source.split(boundary).length !== 2) throw new Error('FFI adapter boundary changed');
    const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.replace(boundary, 'globalThis.__nativeCookieFfi'));
    const { createNativeCookieJob, joinNativeCookieJob } = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
    Object.defineProperty(process, 'platform', { value: 'win32' });
    if (${JSON.stringify(mode)} === 'create') {
      const job = await createNativeCookieJob();
      const active = job.activeProcesses();
      job.terminate(); job.close(); job.close();
      console.log(JSON.stringify({ name: job.name, active, calls }));
    } else {
      let error, diagnostic;
      try { await joinNativeCookieJob('Local\\\\gstack-cookie-12345678-1234-1234-1234-123456789abc'); } catch (caught) { error = caught.message; diagnostic = caught.diagnostic; }
      console.log(JSON.stringify({ calls, error, diagnostic }));
    }
  `;
  const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-e', script], {
    env: { TEMP: root, TMP: root, HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

describe('production Windows Job Object API contract', () => {
  test('diagnostics expose only known native stages and numeric Windows errors', () => {
    expect(nativeCookieDiagnostic(new NativeCookieJobError('job_assign', 5), 'job_create')).toEqual({ stage: 'job_assign', win32Error: 5 });
    expect(nativeCookieDiagnostic(new Error('sensitive-sentinel'), 'ffi_open')).toEqual({ stage: 'ffi_open' });
    expect(parseNativeCookieDiagnostic({ stage: 'job_assign', win32Error: 87, message: 'sensitive-sentinel' })).toEqual({ stage: 'job_assign', win32Error: 87 });
    expect(parseNativeCookieDiagnostic({ stage: 'sensitive-sentinel', win32Error: 5 })).toBeUndefined();
    expect(parseNativeCookieDiagnostic({ stage: 'job_assign', win32Error: 'sensitive-sentinel' })).toEqual({ stage: 'job_assign' });
    expect(parseNativeCookieDiagnostic({ stage: 'member_exit', lastStage: 'node_spawned', exitCode: 1, nodeExitCode: 1, signal: 'SIGTERM', memberMode: true, stderrBytes: 50 })).toEqual({ stage: 'member_exit', lastStage: 'node_spawned', exitCode: 1, nodeExitCode: 1, signal: 'SIGTERM', memberMode: true, stderrBytes: 50 });
    expect(parseNativeCookieDiagnostic({ stage: 'member_exit', lastStage: 'sensitive-sentinel', signal: 'sensitive-sentinel', exitCode: 'sensitive-sentinel', memberMode: 'sensitive-sentinel', stderrBytes: -1 })).toEqual({ stage: 'member_exit' });
  });

  test('owner creates a non-inheritable kill-on-close job and queries active members', () => {
    const result = kernelContract('create');
    expect(result.name).toMatch(/^Local\\gstack-cookie-[0-9a-f-]{36}$/);
    expect(result.active).toBe(3);
    expect(result.calls).toContainEqual(['create', null, `${result.name}\0`]);
    expect(result.calls).toContainEqual(['limits', 42, 9, 144, 0x2000]);
    expect(result.calls).toContainEqual(['query', 42, 1, 48]);
    expect(result.calls).toContainEqual(['terminate', 42, 1]);
    expect(result.calls.filter((call: unknown[]) => call[0] === 'close')).toEqual([['close', 42]]);
  });

  test('member assigns its own handle, never a discovered PID', () => {
    const result = kernelContract('join');
    expect(result.error).toBeUndefined();
    expect(result.calls).toContainEqual(['open', 1, 0, 'Local\\gstack-cookie-12345678-1234-1234-1234-123456789abc\0']);
    expect(result.calls).toContainEqual(['open-process', 0x0101, 0, true]);
    expect(result.calls).toContainEqual(['assign', 42, 999]);
    expect(result.calls).toContainEqual(['close', 999]);
    expect(result.calls).toContainEqual(['close', 42]);
  });

  test('failed self-assignment closes its handle and fails without a child launch', () => {
    const result = kernelContract('join-fail');
    expect(result.error).toBe('native_supervision_failed');
    expect(result.diagnostic).toEqual({ stage: 'job_assign', win32Error: 5 });
    expect(result.calls).toContainEqual(['close', 999]);
    expect(result.calls).toContainEqual(['close', 42]);
  });
});

function simulation(options: { reply?: NativeCookieReply; replyAt?: number; exitAt?: number; retainAfterTerminate?: boolean; signal?: AbortSignal; cancelAt?: () => void } = {}) {
  let time = 0;
  let active = 1;
  let terminated = 0;
  let stopped = 0;
  let jobClosed = 0;
  let started = 0;
  let settleReply!: (reply: NativeCookieReply) => void;
  let settleClose!: () => void;
  const member: NativeCookieMember = {
    result: new Promise(resolve => { settleReply = resolve; }),
    closed: new Promise(resolve => { settleClose = resolve; }),
    stop: () => { stopped++; },
  };
  const job: NativeCookieJob = {
    name: 'synthetic-owned-job',
    terminate: () => {
      terminated++;
      if (!options.retainAfterTerminate) { active = 0; settleClose(); }
    },
    activeProcesses: () => active,
    close: () => { jobClosed++; },
  };
  const run = superviseNativeCookieImport(request, {
    createJob: async () => job,
    startMember: actual => { expect(actual.deadline).toBe(25_000); started++; return member; },
    now: () => time,
    sleep: async milliseconds => {
      time += milliseconds;
      if (options.reply && time >= (options.replyAt ?? 20)) settleReply(options.reply);
      if (options.exitAt !== undefined && time >= options.exitAt) { active = 0; settleClose(); }
      options.cancelAt?.();
    },
    signal: options.signal,
  });
  return { run, state: () => ({ time, active, terminated, stopped, jobClosed, started }) };
}

describe('owned native-cookie lifecycle', () => {
  test('single-pass removal visits directories before removing them and never follows a leaf link', () => {
    const fixture = mkdtempSync(path.join(root, 'single-pass-'));
    const target = path.join(fixture, 'target');
    const outside = path.join(fixture, 'outside');
    mkdirSync(path.join(target, 'nested'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(target, 'nested', 'file'), 'fixture-only');
    writeFileSync(path.join(outside, 'preserved'), 'fixture-only');
    symlinkSync(outside, path.join(target, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const identity = lstatSync(target, { bigint: true });
    const actions: string[] = [];
    removeOwnedFixtureDirectory(target, identity, {
      lstat: file => lstatSync(file, { bigint: true }),
      enumerate: file => { actions.push(`enumerate:${path.relative(target, file)}`); return readdirSync(file); },
      unlink: file => { actions.push(`unlink:${path.relative(target, file)}`); unlinkSync(file); },
      rmdir: file => { actions.push(`rmdir:${path.relative(target, file)}`); rmdirSync(file); },
    });
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(path.join(outside, 'preserved'), 'utf8')).toBe('fixture-only');
    expect(actions.filter(action => action.startsWith('enumerate:'))).toHaveLength(2);
    expect(actions.filter(action => action.startsWith('unlink:'))).toHaveLength(2);
    expect(actions.filter(action => action.startsWith('rmdir:'))).toHaveLength(2);
    expect(actions.indexOf(`unlink:${path.join('nested', 'file')}`)).toBeLessThan(actions.indexOf('rmdir:nested'));
    expect(actions.at(-1)).toBe('rmdir:');
  });

  test('single-pass removal preserves the first original primitive error and stops', () => {
    for (const failedPrimitive of ['lstat', 'enumerate', 'unlink', 'rmdir']) {
      const target = mkdtempSync(path.join(root, 'first-removal-error-'));
      const identity = lstatSync(target, { bigint: true });
      if (failedPrimitive !== 'rmdir') {
        writeFileSync(path.join(target, 'first'), 'fixture-only');
        writeFileSync(path.join(target, 'second'), 'fixture-only');
      }
      const original = Object.freeze(Object.assign(new Error('sensitive-sentinel'), { code: 'EBUSY', errno: -4082, syscall: failedPrimitive }));
      const calls: string[] = [];
      let caught: unknown;
      try {
        removeOwnedFixtureDirectory(target, identity, {
          lstat: file => {
            if (failedPrimitive === 'lstat' && file === path.join(target, 'first')) { calls.push('lstat'); throw original; }
            return lstatSync(file, { bigint: true });
          },
          enumerate: file => { calls.push('enumerate'); if (failedPrimitive === 'enumerate') throw original; return failedPrimitive === 'rmdir' ? [] : ['first', 'second']; },
          unlink: file => { calls.push('unlink'); throw original; },
          rmdir: file => { calls.push('rmdir'); throw original; },
        });
      } catch (error) { caught = error; }
      expect(caught).toBe(original);
      expect(calls).toEqual(failedPrimitive === 'enumerate' ? ['enumerate'] : ['enumerate', failedPrimitive]);
      const receipt = fixtureRemovalEvidence(caught, target, identity);
      expect(receipt).toMatchObject({ primitive: failedPrimitive, rootIdentityMatched: true, objectIdentityMatched: failedPrimitive !== 'lstat', directoryIdentityMatched: true, relativeObjectHash: createHash('sha256').update(['lstat', 'unlink'].includes(failedPrimitive) ? 'first' : '').digest('hex') });
      expect(JSON.stringify(receipt)).not.toContain('sensitive-sentinel');
      if (failedPrimitive !== 'rmdir') {
        expect(readFileSync(path.join(target, 'first'), 'utf8')).toBe('fixture-only');
        expect(readFileSync(path.join(target, 'second'), 'utf8')).toBe('fixture-only');
      }
    }
  });

  test('single-pass removal accepts disappeared entries without repeating a removal', () => {
    for (const stage of ['before_lstat', 'during_unlink', 'during_rmdir']) {
      const fixture = mkdtempSync(path.join(root, 'removal-disappearing-'));
      const target = path.join(fixture, 'target');
      const vanished = path.join(target, 'first');
      const moved = path.join(fixture, 'moved');
      mkdirSync(target);
      if (stage === 'during_rmdir') mkdirSync(vanished);
      else writeFileSync(vanished, 'fixture-only');
      writeFileSync(path.join(target, 'second'), 'fixture-only');
      const identity = lstatSync(target, { bigint: true });
      const vanishedIdentity = lstatSync(vanished, { bigint: true });
      const removals: string[] = [];
      const enumerated: string[] = [];
      removeOwnedFixtureDirectory(target, identity, {
        lstat: file => lstatSync(file, { bigint: true }),
        enumerate: file => {
          enumerated.push(file);
          const entries = readdirSync(file).sort();
          if (stage === 'before_lstat' && file === target) renameSync(vanished, moved);
          return entries;
        },
        unlink: file => {
          removals.push(file);
          if (stage === 'during_unlink' && file === vanished) renameSync(vanished, moved);
          unlinkSync(file);
        },
        rmdir: file => {
          removals.push(file);
          if (stage === 'during_rmdir' && file === vanished) renameSync(vanished, moved);
          rmdirSync(file);
        },
      });
      expect(existsSync(target)).toBe(false);
      expect(new Set(removals).size).toBe(removals.length);
      expect(new Set(enumerated).size).toBe(enumerated.length);
      expect(removals.filter(file => file === vanished)).toHaveLength(stage === 'before_lstat' ? 0 : 1);
      expect(lstatSync(moved, { bigint: true }).ino).toBe(vanishedIdentity.ino);
      if (stage === 'during_rmdir') expect(readdirSync(moved)).toEqual([]);
      else expect(readFileSync(moved, 'utf8')).toBe('fixture-only');
    }
  });

  test('single-pass removal never treats replacement, ancestor changes, or other errors as absence', () => {
    for (const code of ['ENOENT', 'EBUSY', 'EPERM', 'EACCES', 'ancestor_replacement']) {
      const fixture = mkdtempSync(path.join(root, 'removal-not-absent-'));
      const target = path.join(fixture, 'target');
      const first = path.join(target, 'first');
      const moved = path.join(fixture, 'moved');
      mkdirSync(target);
      writeFileSync(first, 'fixture-only');
      writeFileSync(path.join(target, 'second'), 'untouched-only');
      const identity = lstatSync(target, { bigint: true });
      const original = Object.freeze(Object.assign(new Error('synthetic-removal-error'), { code: code === 'ancestor_replacement' ? 'ENOENT' : code, syscall: 'unlink' }));
      let calls = 0;
      let caught: unknown;
      try {
        removeOwnedFixtureDirectory(target, identity, {
          lstat: file => lstatSync(file, { bigint: true }),
          enumerate: file => readdirSync(file).sort(),
          unlink: file => {
            calls++;
            if (code === 'ENOENT') {
              renameSync(file, moved);
              writeFileSync(file, 'replacement-only');
            } else if (code === 'ancestor_replacement') {
              renameSync(target, moved);
              mkdirSync(target);
              writeFileSync(first, 'replacement-only');
            }
            throw original;
          },
          rmdir: file => rmdirSync(file),
        });
      } catch (error) { caught = error; }
      expect(calls).toBe(1);
      if (code === 'ancestor_replacement') {
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain('ancestor identity changed');
        expect(fixturePrimitiveFailures.get(caught as object)).toMatchObject({ primitive: 'identity', objectIdentityMatched: false });
        expect(readFileSync(path.join(moved, 'second'), 'utf8')).toBe('untouched-only');
      } else {
        expect(caught).toBe(original);
        expect(fixturePrimitiveFailures.get(caught as object)).toMatchObject({ primitive: 'unlink', relativeObjectHash: createHash('sha256').update('first').digest('hex') });
        expect(readFileSync(path.join(target, 'second'), 'utf8')).toBe('untouched-only');
      }
      expect(readFileSync(first, 'utf8')).toBe(code === 'ENOENT' || code === 'ancestor_replacement' ? 'replacement-only' : 'fixture-only');
    }
  });

  test('single-pass removal rejects changed identities and linked ancestors before touching their contents', () => {
    const fixture = mkdtempSync(path.join(root, 'removal-identity-'));
    const target = path.join(fixture, 'target');
    mkdirSync(target);
    writeFileSync(path.join(target, 'preserved'), 'fixture-only');
    const identity = lstatSync(target, { bigint: true });
    expect(() => removeOwnedFixtureDirectory(target, { dev: identity.dev, ino: identity.ino + 1n })).toThrow('directory identity changed');
    expect(() => removeOwnedFixtureDirectory(path.dirname(root), identity)).toThrow('stay below its owned root');
    const link = path.join(fixture, 'link');
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => removeOwnedFixtureDirectory(path.join(link, 'preserved'), identity)).toThrow('ancestor is not an owned directory');
    unlinkSync(link);
    const moved = path.join(fixture, 'moved');
    let caught: unknown;
    try {
      removeOwnedFixtureDirectory(target, identity, {
        lstat: file => lstatSync(file, { bigint: true }),
        enumerate: file => {
          const entries = readdirSync(file);
          renameSync(target, moved);
          mkdirSync(target);
          writeFileSync(path.join(target, 'preserved'), 'replacement-only');
          return entries;
        },
        unlink: file => unlinkSync(file),
        rmdir: file => rmdirSync(file),
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(fixturePrimitiveFailures.get(caught as object)).toMatchObject({ primitive: 'identity', objectScope: 'target', objectIdentityMatched: false });
    expect(readFileSync(path.join(moved, 'preserved'), 'utf8')).toBe('fixture-only');
    expect(readFileSync(path.join(target, 'preserved'), 'utf8')).toBe('replacement-only');
  });

  test('removal diagnostics preserve errors and inspect only the unchanged synthetic directory', () => {
    const fixture = mkdtempSync(path.join(root, 'removal-evidence-'));
    const identity = lstatSync(fixture, { bigint: true });
    writeFileSync(path.join(fixture, 'sensitive-sentinel'), 'fixture-only');
    const error = Object.assign(new Error('sensitive-sentinel'), { code: 'EBUSY', syscall: 'rm', errno: -4082, path: fixture });
    const evidence = fixtureRemovalEvidence(error, fixture, identity);
    expect(evidence).toMatchObject({ code: 'EBUSY', syscall: 'rm', errno: -4082, inspected: true, directoryIdentityMatched: true, reportedPath: 'target', entries: [{ type: 'file' }] });
    expect(JSON.stringify(evidence)).not.toContain('sensitive-sentinel');
    expect(JSON.stringify(evidence)).not.toContain(fixture);
    expect(readFileSync(path.join(fixture, 'sensitive-sentinel'), 'utf8')).toBe('fixture-only');
    expect(error.path).toBe(fixture);
    expect(fixtureRemovalEvidence(error, fixture, { dev: identity.dev, ino: identity.ino + 1n })).toMatchObject({ inspected: false, reason: 'object_identity_changed' });
    expect(fixtureRemovalEvidence(error, path.dirname(root), identity)).toMatchObject({ inspected: false, reason: 'outside_owned_fixture' });
    const missing = path.join(fixture, 'missing');
    expect(fixtureRemovalEvidence(error, missing, identity)).toMatchObject({ inspected: false, inspectionCode: 'ENOENT' });
    const link = path.join(root, 'removal-evidence-link');
    symlinkSync(fixture, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(fixtureRemovalEvidence(error, link, identity)).toMatchObject({ inspected: false, reason: 'linked_object' });
    unlinkSync(link);
    for (let index = 0; index < 20; index++) writeFileSync(path.join(fixture, String(index)), 'fixture-only');
    const bounded = fixtureRemovalEvidence(error, fixture, identity) as { entries: unknown[]; entriesTruncated: boolean };
    expect(bounded.entries).toHaveLength(16);
    expect(bounded.entriesTruncated).toBe(true);
  });

  test.each(['unchanged', 'replaced', 'linked', 'missing', 'wrong_path'])('a leaf lock probe is bound to the exact failed object: %s', state => {
    const fixture = mkdtempSync(path.join(root, 'leaf-owner-'));
    const target = path.join(fixture, 'target');
    const nested = path.join(target, 'nested');
    mkdirSync(nested, { recursive: true });
    const file = path.join(nested, 'sensitive-sentinel.sqlite');
    writeFileSync(file, 'fixture-only');
    const identity = lstatSync(target, { bigint: true });
    const fileIdentity = lstatSync(file, { bigint: true });
    const original = Object.assign(new Error('sensitive-sentinel'), { code: 'EBUSY', syscall: 'unlink', errno: -4082, path: file });
    let removals = 0;
    let caught: unknown;
    try {
      removeOwnedFixtureDirectory(target, identity, {
        lstat: candidate => lstatSync(candidate, { bigint: true }), enumerate: candidate => readdirSync(candidate),
        unlink: candidate => { expect(candidate).toBe(file); removals++; throw original; },
        rmdir: () => { throw new Error('Must stop at the first failure'); },
      });
    } catch (error) { caught = error; }
    expect(caught).toBe(original);
    if (state === 'replaced') {
      renameSync(file, path.join(fixture, 'original'));
      writeFileSync(file, 'replacement-only');
    } else if (state === 'linked') {
      const moved = path.join(fixture, 'moved');
      renameSync(nested, moved);
      symlinkSync(moved, nested, process.platform === 'win32' ? 'junction' : 'dir');
    } else if (state === 'missing') unlinkSync(file);
    else if (state === 'wrong_path') original.path = path.join(fixture, 'elsewhere');
    const queried: string[] = [];
    const owners = { available: true, owners: [{ pid: 123, image: 'bun.exe', creationMatched: true, isTestHost: true }] };
    const receipt = fixtureRemovalEvidence(caught, target, identity, (candidate, timeout, expectedIdentity) => {
      queried.push(candidate);
      expect(timeout).toBe(5_000);
      expect(expectedIdentity).toEqual({ dev: fileIdentity.dev.toString(), ino: fileIdentity.ino.toString() });
      return owners;
    });
    expect(receipt).toMatchObject({ code: 'EBUSY', primitive: 'unlink', objectDev: fileIdentity.dev.toString(), objectIno: fileIdentity.ino.toString() });
    expect(queried).toEqual(state === 'unchanged' ? [file] : []);
    if (state === 'unchanged') {
      expect(receipt).toMatchObject({ fileOwners: owners });
      expect(readFileSync(file, 'utf8')).toBe('fixture-only');
    } else if (state !== 'wrong_path') expect(receipt).toMatchObject({ fileOwners: { available: false } });
    else expect(receipt).not.toHaveProperty('fileOwners');
    expect(removals).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain('sensitive-sentinel');
    expect(JSON.stringify(receipt)).not.toContain(fixture);
    expect(caught).toBe(original);
  });

  test('positive fixture environments create matching Windows known-folder directories', () => {
    const fixture = mkdtempSync(path.join(root, 'environment-'));
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required for fixture setup');
    const environment = nativeFixtureEnvironment(fixture, node);
    expect(environment.USERPROFILE).toBe(fixture);
    expect(environment.LOCALAPPDATA).toBe(path.join(fixture, 'AppData', 'Local'));
    expect(environment.APPDATA).toBe(path.join(fixture, 'AppData', 'Roaming'));
    for (const name of ['LOCALAPPDATA', 'APPDATA', 'TEMP']) expect(lstatSync(environment[name]).isDirectory()).toBe(true);
    expect(environment.TMP).toBe(environment.TEMP);
  });

  test('a contents reset preserves an existing root even while an owned process holds it', async () => {
    const fixture = mkdtempSync(path.join(root, 'held-root-'));
    const state = lstatSync(fixture, { bigint: true });
    const identity = { path: realpathSync(fixture), dev: state.dev, ino: state.ino };
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required for root ownership verification');
    const child = ownFixtureChild(spawn(node, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
      cwd: fixture,
      env: { PATH: path.dirname(node), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }));
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await once(child.stdout, 'data', { signal: AbortSignal.timeout(5_000) });
      if (process.platform === 'win32') expect(() => rmdirSync(fixture)).toThrow();
      mkdirSync(path.join(fixture, 'AppData', 'Local'), { recursive: true });
      writeFileSync(path.join(fixture, 'AppData', 'Local', 'synthetic'), 'fixture-only');
      writeFileSync(path.join(fixture, 'wrapper.cjs'), 'fixture-only');
      clearOwnedFixtureContents(fixture, identity);
      expect(readdirSync(fixture)).toEqual([]);
      const after = lstatSync(fixture, { bigint: true });
      expect(after.dev).toBe(identity.dev);
      expect(after.ino).toBe(identity.ino);
      expect(alive(child.pid!)).toBe(true);
    } finally {
      child.kill();
      await closed;
    }
  }, 10_000);

  test('a contents reset rejects a different root identity without removing entries', () => {
    const fixture = mkdtempSync(path.join(root, 'identity-'));
    const state = lstatSync(fixture, { bigint: true });
    const marker = path.join(fixture, 'preserved');
    writeFileSync(marker, 'fixture-only');
    expect(() => clearOwnedFixtureContents(fixture, { path: realpathSync(fixture), dev: state.dev, ino: state.ino + 1n })).toThrow('identity changed');
    expect(readFileSync(marker, 'utf8')).toBe('fixture-only');
  });

  test('a contents reset accepts an entry that disappears after enumeration without retrying it', () => {
    const fixture = mkdtempSync(path.join(root, 'disappearing-entry-'));
    const state = lstatSync(fixture, { bigint: true });
    const identity = { path: realpathSync(fixture), dev: state.dev, ino: state.ino };
    const disappearing = path.join(fixture, '00000000-0000-0000-0000-000000000000.tmp');
    writeFileSync(disappearing, 'fixture-only');
    writeFileSync(path.join(fixture, 'remaining'), 'fixture-only');
    let listings = 0;
    clearOwnedFixtureContents(fixture, identity, directory => {
      listings++;
      const entries = readdirSync(directory);
      unlinkSync(disappearing);
      return entries;
    });
    expect(listings).toBe(1);
    expect(readdirSync(fixture)).toEqual([]);
    const after = lstatSync(fixture, { bigint: true });
    expect(after.dev).toBe(identity.dev);
    expect(after.ino).toBe(identity.ino);
  });

  test('a contents reset still rejects a nonempty postcondition', () => {
    const fixture = mkdtempSync(path.join(root, 'nonempty-reset-'));
    const state = lstatSync(fixture, { bigint: true });
    writeFileSync(path.join(fixture, 'preserved'), 'fixture-only');
    expect(() => clearOwnedFixtureContents(fixture, { path: realpathSync(fixture), dev: state.dev, ino: state.ino }, () => [])).toThrow('empty root');
    expect(readFileSync(path.join(fixture, 'preserved'), 'utf8')).toBe('fixture-only');
  });

  test('the Node cleanup comparison refuses changed identity and removes only its owned fixture', () => {
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required for cleanup comparison');
    const fixture = mkdtempSync(path.join(root, 'node-cleanup-'));
    const state = lstatSync(fixture, { bigint: true });
    const marker = path.join(fixture, 'preserved');
    writeFileSync(marker, 'fixture-only');
    const invoke = (ino: bigint) => spawnSync(node, [path.resolve(import.meta.dir, 'fixtures/native-cookie-remove-fixture.cjs'), Buffer.from(JSON.stringify({
      root: fixture, realpath: realpathSync(fixture), dev: state.dev.toString(), ino: ino.toString(),
    })).toString('base64')], { env: nativeCookieEnvironment(process.env), encoding: 'utf8', timeout: 5_000, windowsHide: true });
    const refused = invoke(state.ino + 1n);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout).reason).toBe('identity_mismatch');
    expect(readFileSync(marker, 'utf8')).toBe('fixture-only');
    const removed = invoke(state.ino);
    expect(removed.status).toBe(0);
    expect(JSON.parse(removed.stdout).removed).toBe(true);
    expect(existsSync(fixture)).toBe(false);
    expect(existsSync(root)).toBe(true);
  }, 15_000);

  test('success is withheld until the entire job is empty and member exits', async () => {
    const run = simulation({ reply: { cookies: [] }, exitAt: 200 });
    expect(await run.run).toEqual({ cookies: [] });
    expect(run.state()).toMatchObject({ time: 200, active: 0, terminated: 0, stopped: 1, jobClosed: 1, started: 1 });
  });

  test('a stuck graceful close is forcibly cleaned after two seconds', async () => {
    const run = simulation({ reply: { cookies: [] } });
    expect(await run.run).toEqual({ cookies: [] });
    expect(run.state()).toMatchObject({ active: 0, terminated: 1, jobClosed: 1, started: 1 });
    expect(run.state().time).toBeLessThan(5_000);
  });

  test('launch/read timeout gets one 25s operation budget and owned cleanup', async () => {
    const run = simulation();
    expect(await run.run).toEqual({ error: 'native_timeout' });
    expect(run.state()).toMatchObject({ active: 0, terminated: 1, jobClosed: 1, started: 1 });
    expect(run.state().time).toBeGreaterThanOrEqual(25_000);
    expect(run.state().time).toBeLessThan(30_000);
  });

  test.each(['failure', 'success', 'rejection'])('a late member %s cannot overwrite the timeout selected before cleanup', async mode => {
    let now = 0;
    let active = 1;
    let resolveReply!: (reply: NativeCookieReply) => void;
    let rejectReply!: (error: Error) => void;
    let resolveClosed!: () => void;
    const reply = new Promise<NativeCookieReply>((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const result = await superviseNativeCookieImport(request, {
      now: () => now,
      sleep: async milliseconds => { now += milliseconds; },
      createJob: async () => ({
        name: 'synthetic-owned-job', activeProcesses: () => active, close() {},
        terminate() {
          expect(now).toBe(25_000);
          active = 0;
          if (mode === 'rejection') rejectReply(new Error('synthetic late rejection'));
          else resolveReply(mode === 'success' ? { cookies: [] } : { error: 'native_failed', diagnostic: { stage: 'member_exit' } });
          resolveClosed();
        },
      }),
      startMember: () => ({ result: reply, closed, stop() {} }),
    });
    expect(result).toEqual({ error: 'native_timeout' });
    expect(active).toBe(0);
    expect(now).toBeLessThan(30_000);
  });

  test('unconfirmed termination is reported as cleanup failure, never success', async () => {
    const run = simulation({ retainAfterTerminate: true });
    expect(await run.run).toEqual({ error: 'native_cleanup_failed' });
    expect(run.state()).toMatchObject({ time: 30_000, terminated: 1, stopped: 1, jobClosed: 1 });
  });

  test('a process crash cannot strand remaining members', async () => {
    let terminated = 0;
    let active = 1;
    const result = await superviseNativeCookieImport(request, {
      now: () => 0,
      sleep: async () => {},
      createJob: async () => ({ name: 'synthetic', activeProcesses: () => active, terminate: () => { active = 0; terminated++; }, close() {} }),
      startMember: () => ({ result: new Promise(() => {}), closed: Promise.resolve(), stop() {} }),
    });
    expect(result).toEqual({ error: 'native_failed' });
    expect(terminated).toBe(1);
  });

  test('a failed job close still stops its owned member and cannot report success', async () => {
    let stopped = false;
    const result = await superviseNativeCookieImport(request, {
      now: () => 0,
      sleep: async () => {},
      createJob: async () => ({ name: 'synthetic', activeProcesses: () => 0, terminate() {}, close() { throw new Error('sensitive-close-detail'); } }),
      startMember: () => ({ result: Promise.resolve({ cookies: [] }), closed: Promise.resolve(), stop() { stopped = true; } }),
    });
    expect(result).toEqual({ error: 'native_cleanup_failed', diagnostic: { stage: 'job_close' } });
    expect(stopped).toBe(true);
  });

  test('locked-profile errors are classified and never retried', async () => {
    const run = simulation({ reply: { error: 'browser_running' } });
    expect(await run.run).toEqual({ error: 'browser_running' });
    expect(run.state()).toMatchObject({ active: 0, terminated: 1, started: 1 });
  });

  test('loss of the parent channel cancels the operation and cleans the job', async () => {
    const cancellation = new AbortController();
    const run = simulation({ signal: cancellation.signal, cancelAt: () => cancellation.abort() });
    expect(await run.run).toEqual({ error: 'native_failed' });
    expect(run.state()).toMatchObject({ active: 0, terminated: 1, started: 1 });
    expect(run.state().time).toBeLessThan(5_000);
  });

  test('job initialization failure dispatches no child and hides native errors', async () => {
    let started = false;
    const result = await superviseNativeCookieImport(request, {
      createJob: async () => { throw new Error('sensitive-sentinel'); },
      startMember: () => { started = true; throw new Error('unexpected'); },
    });
    expect(result).toEqual({ error: 'native_supervision_failed', diagnostic: { stage: 'job_create' } });
    expect(started).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('non-Windows job API fails before any process is launched', async () => {
    await expect(createNativeCookieJob()).rejects.toThrow('native_supervision_unavailable');
    await expect(joinNativeCookieJob('invalid')).rejects.toThrow('native_supervision_failed');
  });
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function safeNativeEnvelope(output: string): object {
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed.cookies)) return { cookiesRead: parsed.cookies.length };
    const errors = ['native_timeout', 'native_failed', 'native_cleanup_failed', 'native_supervision_failed', 'browser_running', 'native_profile_unsupported'];
    return { error: errors.includes(parsed.error) ? parsed.error : 'unexpected_reply', diagnostic: parseNativeCookieDiagnostic(parsed.diagnostic) };
  } catch {
    return { error: 'no_complete_reply' };
  }
}

function assertOwnerReceipt(receipt: { available: boolean; owners: { pid: number; creationMatched: boolean; isTestHost: boolean }[] }, pid: number) {
  const before = JSON.stringify(receipt);
  expect(receipt.available).toBe(true);
  expect(Array.isArray(receipt.owners)).toBe(true);
  expect(receipt.owners.some(owner => owner.pid === pid && owner.creationMatched && owner.isTestHost)).toBe(true);
  expect(JSON.stringify(receipt)).toBe(before);
}

function assertCookieReceipt(receipt: NativeCookieReply, evidence: object = {}) {
  if (!('cookies' in receipt) || !Array.isArray(receipt.cookies)) {
    throw new Error(JSON.stringify({ nativeCookieReceipt: safeNativeEnvelope(JSON.stringify(receipt)), ...evidence }));
  }
  return receipt.cookies;
}

function safeLaunchEvidence(file: string): object {
  try {
    const observed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      spawned: Number.isInteger(observed.pid), pipe: observed.args?.includes('--remote-debugging-pipe'),
      argsHash: observed.argsHash, envHash: observed.envHash,
      reasons: observed.reasons, stderrBytes: observed.stderrBytes,
      exitCode: observed.exitCode, signal: observed.signal, spawnError: observed.spawnError,
      runtime: observed.runtime, observedCommandLine: observed.observedCommandLine,
      folderEvidence: observed.folderEvidence,
    };
  } catch {
    return { spawned: false };
  }
}

function nativeSupervisor(input: NativeCookieRequest, env: NodeJS.ProcessEnv) {
  const cleanupDeadline = performance.now() + 30_000;
  const child = ownFixtureChild(spawn(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=NUL', path.resolve(import.meta.dir, '../src/cookie-import-native-worker.ts')], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 30_000);
  const done = new Promise<NativeCookieReply>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Native supervisor did not return a complete receipt')); }
    });
  });
  void done.catch(() => {});
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ ...input, deadline: Date.now() + 25_000, qualifiedBunVersions: [Bun.version] }) + '\n');
  return { child, done, cleanupDeadline, envelope: () => safeNativeEnvelope(output) };
}

describe('native Windows process qualification', () => {
  test.skipIf(process.platform !== 'win32' || process.env.GSTACK_COOKIE_NATIVE_DEFAULT_FIXTURE !== '1')('an exclusively created default Edge profile persists v20 and reimports it through the owned Node worker', async () => {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') throw new Error('Default-profile qualification requires a disposable GitHub Actions Windows runner');
    const node = Bun.which('node');
    const mapping = nativeBrowserPaths('Edge', process.env);
    const edge = mapping.executables.find(existsSync);
    if (!node || !edge) throw new Error('Native qualification requires Node and installed Microsoft Edge');
    const fixture = mkdtempSync(path.join(root, 'default-edge-'));
    const observation = path.join(fixture, 'default-launch.json');
    const playwrightEntry = path.join(fixture, 'seed-playwright.cjs');
    const require = createRequire(import.meta.url);
    const marker = path.join(mapping.userDataDir, '.gstack-owned-fixture');
    const nonce = randomUUID();
    let owned = false;
    const createdParents: string[] = [];
    let supervisor: ReturnType<typeof nativeSupervisor> | undefined;
    try {
      if (existsSync(mapping.userDataDir)) throw new Error('Refusing an existing Edge default data directory; qualification needs a fresh disposable runner');
      let parent = process.env.LOCALAPPDATA!;
      if (realpathSync(parent).toLowerCase() !== path.resolve(parent).toLowerCase()) throw new Error('Refusing a redirected local-data root');
      for (const segment of ['Microsoft', 'Edge']) {
        parent = path.join(parent, segment);
        if (!existsSync(parent)) { mkdirSync(parent); createdParents.push(parent); }
        if (realpathSync(parent).toLowerCase() !== path.resolve(parent).toLowerCase()) throw new Error('Refusing a redirected default-profile parent');
      }
      mkdirSync(mapping.userDataDir);
      owned = true;
      writeFileSync(marker, nonce, { flag: 'wx', mode: 0o600 });
      writeFileSync(playwrightEntry, `module.exports = require(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-launch.cjs'))})(${JSON.stringify({
        observation, playwrightEntry: require.resolve('playwright'),
        seedCookie: { name: 'synthetic-native-qualification', value: 'synthetic-only', domain: 'example.test', path: '/', secure: true, httpOnly: true, expires: Math.floor(Date.now() / 1000) + 3600 },
      })});`);
      const input = { ...request, nodeExecutable: node, executablePath: edge, userDataDir: mapping.userDataDir, playwrightEntry };
      const env = nativeCookieEnvironment(process.env);
      supervisor = nativeSupervisor(input, env);
      const seeded = await supervisor.done;
      const seededCookies = assertCookieReceipt(seeded, { realDefaultProfile: true, launch: safeLaunchEvidence(observation) });
      expect(seededCookies).toHaveLength(1);
      const database = new Database(path.join(mapping.userDataDir, 'Default', 'Network', 'Cookies'), { readonly: true });
      try {
        const row = database.query("SELECT hex(substr(encrypted_value, 1, 3)) AS prefix FROM cookies WHERE name = 'synthetic-native-qualification' AND host_key = 'example.test'").get() as { prefix: string } | null;
        expect(row?.prefix).toBe('763230');
      } finally {
        database.close();
      }
      supervisor = nativeSupervisor({ ...input, playwrightEntry: require.resolve('playwright') }, env);
      const imported = await supervisor.done;
      const importedCookies = assertCookieReceipt(imported);
      expect(importedCookies).toHaveLength(1);
      expect(importedCookies[0].name).toBe('synthetic-native-qualification');
      expect(importedCookies[0].value).toBe('synthetic-only');
      expect(importedCookies[0].domain).toBe('example.test');
    } finally {
      supervisor?.child.kill();
      await supervisor?.done.catch(() => {});
      if (owned) {
        if (realpathSync(mapping.userDataDir).toLowerCase() !== path.resolve(mapping.userDataDir).toLowerCase() || readFileSync(marker, 'utf8') !== nonce) throw new Error('Default fixture ownership changed; refusing cleanup');
        rmSync(mapping.userDataDir, { recursive: true, force: true });
      }
      for (const parent of createdParents.reverse()) rmdirSync(parent);
    }
  }, 65_000);

  test.skipIf(process.platform !== 'win32')('a locked real Edge profile leaves its existing owner alive', async () => {
    const node = Bun.which('node');
    const edge = nativeBrowserPaths('Edge', process.env).executables.find(existsSync);
    if (!node || !edge) throw new Error('Native qualification requires Node and installed Microsoft Edge');
    const fixture = mkdtempSync(path.join(root, 'locked-edge-'));
    const marker = path.join(fixture, 'owner-ready.json');
    const contenderObservation = path.join(fixture, 'contender-launch.json');
    const contenderEntry = path.join(fixture, 'contender-playwright.cjs');
    const playwrightEntry = path.join(fixture, 'held-playwright.cjs');
    const require = createRequire(import.meta.url);
    writeFileSync(contenderEntry, `module.exports = require(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-launch.cjs'))})(${JSON.stringify({ observation: contenderObservation, playwrightEntry: require.resolve('playwright') })});`);
    writeFileSync(playwrightEntry, `
      const cp = require('node:child_process');
      const spawn = cp.spawn;
      let pid;
      cp.spawn = function(command, args, options) {
        if (args.some(arg => /^--(?:no-sandbox|disable-setuid-sandbox)(?:=|$)/.test(arg))) throw new Error('Native owner fixture refuses a sandbox-disabled browser');
        const child = spawn.call(this, command, args, options); pid = child.pid; return child;
      };
      const { chromium } = require(${JSON.stringify(require.resolve('playwright'))});
      exports.chromium = { async launchPersistentContext(root, options) {
        const context = await chromium.launchPersistentContext(root, options);
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid }));
        context.cookies = () => new Promise(() => {});
        return context;
      } };
    `);
    const env = nativeFixtureEnvironment(fixture, node);
    const input = { ...request, nodeExecutable: node, executablePath: edge, userDataDir: path.join(fixture, 'User Data'), playwrightEntry };
    const owner = nativeSupervisor(input, env);
    let contender: ReturnType<typeof nativeSupervisor> | undefined;
    try {
      const readyBy = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < readyBy) await Bun.sleep(20);
      expect({ ready: existsSync(marker), reply: owner.envelope() }).toMatchObject({ ready: true });
      const { pid } = JSON.parse(readFileSync(marker, 'utf8'));
      contender = nativeSupervisor({ ...input, playwrightEntry: contenderEntry }, env);
      expect({ result: await contender.done, launch: safeLaunchEvidence(contenderObservation) }).toMatchObject({ result: { error: 'browser_running' } });
      expect(alive(pid)).toBe(true);
    } finally {
      contender?.child.kill();
      owner.child.kill();
      await contender?.done.catch(() => {});
      await owner.done.catch(() => {});
    }
  }, 35_000);

  for (const mode of ['normal-close', 'stalled-close']) {
    test.skipIf(process.platform !== 'win32')(`real Edge synthetic profile: ${mode} returns only after the owned browser exits`, async () => {
      const node = Bun.which('node');
      const edge = nativeBrowserPaths('Edge', process.env).executables.find(existsSync);
      if (!node || !edge) throw new Error('Native qualification requires Node and installed Microsoft Edge');
      const fixture = mkdtempSync(path.join(root, 'edge-'));
      const observation = path.join(fixture, 'browser.json');
      const playwrightEntry = path.join(fixture, 'observed-playwright.cjs');
      const require = createRequire(import.meta.url);
      writeFileSync(playwrightEntry, `module.exports = require(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-launch.cjs'))})(${JSON.stringify({ observation, playwrightEntry: require.resolve('playwright'), mode })});`);
      const environment = nativeFixtureEnvironment(fixture, node);
      const supervisor = ownFixtureChild(spawn(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=NUL', path.resolve(import.meta.dir, '../src/cookie-import-native-worker.ts')], { env: environment, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
      const closed = new Promise<void>(resolve => supervisor.once('close', () => resolve()));
      let output = '';
      supervisor.stdout.on('data', chunk => { output += chunk; });
      const started = Date.now();
      const deadline = setTimeout(() => supervisor.kill(), 30_000);
      supervisor.stdin.write(JSON.stringify({ ...request, nodeExecutable: node, playwrightEntry, executablePath: edge, userDataDir: path.join(fixture, 'User Data'), deadline: started + 25_000, qualifiedBunVersions: [Bun.version] }) + '\n');
      try {
        await closed;
        const result = JSON.parse(output);
        const cookies = assertCookieReceipt(result, { launch: safeLaunchEvidence(observation) });
        expect(cookies).toHaveLength(1);
        expect(cookies[0].domain).toBe('example.test');
        const browser = JSON.parse(readFileSync(observation, 'utf8'));
        expect(browser.command).toBe(edge);
        expect(browser.args).toContain('--remote-debugging-pipe');
        expect(browser.args.some((arg: string) => arg.startsWith('--remote-debugging-port'))).toBe(false);
        expect(browser.args.some((arg: string) => /^--(?:no-sandbox|disable-setuid-sandbox)(?:=|$)/.test(arg))).toBe(false);
        expect(alive(browser.pid)).toBe(false);
        expect(Date.now() - started).toBeLessThan(30_000);
      } finally {
        clearTimeout(deadline);
        supervisor.kill();
        await closed;
      }
    }, 35_000);
  }

  for (const mode of ['timeout', 'owner-exit', 'worker-crash']) {
    test.skipIf(process.platform !== 'win32')(`${mode} kills owned descendants and preserves an unrelated process`, async () => {
      const node = Bun.which('node');
      if (!node) throw new Error('Node is required for Windows qualification');
      const fixture = mkdtempSync(path.join(root, 'native-'));
      const pids = path.join(fixture, 'owned.json');
      const playwrightEntry = path.join(fixture, 'playwright.cjs');
      writeFileSync(playwrightEntry, `module.exports = require(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-process.cjs'))})(${JSON.stringify({ pidsFile: pids, mode })});`);
      const environment = nativeFixtureEnvironment(fixture, node);
      const sibling = ownFixtureChild(spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { env: environment, stdio: 'ignore', windowsHide: true }));
      const siblingClosed = new Promise<void>(resolve => sibling.once('close', () => resolve()));
      const supervisor = ownFixtureChild(spawn(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=NUL', path.resolve(import.meta.dir, '../src/cookie-import-native-worker.ts')], { env: environment, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
      const closed = new Promise<void>(resolve => supervisor.once('close', () => resolve()));
      let output = '';
      supervisor.stdout.on('data', chunk => { output += chunk; });
      const started = Date.now();
      supervisor.stdin.write(JSON.stringify({ ...request, nodeExecutable: node, playwrightEntry, userDataDir: fixture, deadline: started + (mode === 'timeout' ? 3_000 : 25_000), qualifiedBunVersions: [Bun.version] }) + '\n');
      try {
        while (!existsSync(pids) && Date.now() - started < 2_500) await Bun.sleep(20);
        expect({ ready: existsSync(pids), reply: safeNativeEnvelope(output) }).toMatchObject({ ready: true });
        const owned = JSON.parse(readFileSync(pids, 'utf8')) as number[];
        if (mode === 'owner-exit') supervisor.kill();
        await closed;
        const cleanupDeadline = Date.now() + 5_000;
        while (owned.some(alive) && Date.now() < cleanupDeadline) await Bun.sleep(20);
        expect(owned.some(alive)).toBe(false);
        expect(alive(sibling.pid!)).toBe(true);
        if (mode === 'timeout') {
          expect(JSON.parse(output)).toEqual({ error: 'native_timeout' });
          expect(Date.now() - started).toBeLessThan(8_000);
        }
        if (mode === 'worker-crash') expect(JSON.parse(output)).toMatchObject({ error: 'native_failed' });
      } finally {
        supervisor.kill();
        sibling.kill();
        await Promise.all([closed, siblingClosed]);
      }
    }, 15_000);
  }
});

describe('native Windows launch diagnostics', () => {
  for (const kind of ['file', 'directory'] as const) {
    test.skipIf(process.platform !== 'win32')(`single-pass removal preserves a real ${kind} delete-sharing conflict`, () => {
      const fixture = mkdtempSync(path.join(root, 'removal-lock-'));
      const target = path.join(fixture, 'target');
      const sibling = path.join(fixture, 'preserved');
      mkdirSync(target);
      writeFileSync(sibling, 'unrelated-fixture-only');
      const locked = kind === 'file' ? path.join(target, 'held') : target;
      if (kind === 'file') writeFileSync(locked, 'held-fixture-only');
      const identity = lstatSync(target, { bigint: true });
      const lockedIdentity = lstatSync(locked, { bigint: true });
      expect(realpathSync(target)).toBe(path.join(realpathSync(fixture), 'target'));
      expect(lockedIdentity.isSymbolicLink()).toBe(false);
      const kernel = dlopen('kernel32.dll', {
        CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
        CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
      });
      const name = Buffer.from(locked + '\0', 'utf16le');
      const handle = kernel.symbols.CreateFileW(ptr(name), 0x80000000, 3, null, 3, kind === 'directory' ? 0x02000000 : 0x80, 0);
      try {
        expect(BigInt(handle)).not.toBe(0xffffffffffffffffn);
        expect(BigInt(handle)).not.toBe(0n);
        let caught: unknown;
        try { removeOwnedFixtureDirectory(target, identity); }
        catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as NodeJS.ErrnoException).code).toBe('EBUSY');
        const primitive = kind === 'file' ? 'unlink' : 'rmdir';
        expect((caught as NodeJS.ErrnoException).syscall).toBe(primitive);
        const receipt = fixtureRemovalEvidence(caught, target, identity);
        expect(receipt).toMatchObject({ primitive, rootIdentityMatched: true, objectIdentityMatched: true, directoryIdentityMatched: true, relativeObjectHash: createHash('sha256').update(kind === 'file' ? 'held' : '').digest('hex') });
        if (kind === 'file') {
          const owners = (receipt as { fileOwners: { available: boolean; owners: { pid: number; creationMatched: boolean; isTestHost: boolean }[] } }).fileOwners;
          assertOwnerReceipt(owners, process.pid);
        }
        console.log(JSON.stringify({ nativeFixtureOwnedLockControl: { kind, ...receipt } }));
        expect(lstatSync(locked, { bigint: true }).ino).toBe(lockedIdentity.ino);
        expect(lstatSync(locked, { bigint: true }).dev).toBe(lockedIdentity.dev);
        if (kind === 'file') expect(readFileSync(locked, 'utf8')).toBe('held-fixture-only');
        else expect(readdirSync(locked)).toEqual([]);
        expect(readFileSync(sibling, 'utf8')).toBe('unrelated-fixture-only');
      } finally {
        try {
          if (BigInt(handle) !== 0xffffffffffffffffn && BigInt(handle) !== 0n) expect(kernel.symbols.CloseHandle(handle)).toBe(1);
        } finally { kernel.close(); }
      }
      removeOwnedFixtureDirectory(target, identity);
      expect(existsSync(target)).toBe(false);
      expect(readFileSync(sibling, 'utf8')).toBe('unrelated-fixture-only');
    }, 10_000);
  }

  test.each(['resolve_root', 'resolve_file'])('file-owner diagnostics preserve the %s filesystem failure without exposing its path', stage => {
    const fixture = mkdtempSync(path.join(root, 'owner-stage-'));
    const missing = path.join(fixture, 'sensitive-sentinel');
    const input = { root: stage === 'resolve_root' ? missing : fixture, file: missing, testPid: process.pid };
    const script = `
      await import('node:fs');
      await import('node:path');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.argv = [process.execPath, 'fixture', ${JSON.stringify(Buffer.from(JSON.stringify(input)).toString('base64'))}];
      await import(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-file-owners.ts'))});
    `;
    const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-e', script], {
      env: { TEMP: fixture, TMP: fixture, HOME: fixture, USERPROFILE: fixture, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ available: false, reason: 'owner_query_failed', stage, errorCode: 'ENOENT' });
    expect(result.stdout).not.toContain('sensitive-sentinel');
  });

  test.skipIf(process.platform !== 'win32')('Restart Manager identifies the exact fixture file holder without stopping it', () => {
    const fixture = mkdtempSync(path.join(root, 'file-owner-'));
    const file = path.join(fixture, 'held.tmp');
    writeFileSync(file, 'fixture-only');
    const kernel = dlopen('kernel32.dll', {
      CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    });
    const name = Buffer.from(file + '\0', 'utf16le');
    const handle = kernel.symbols.CreateFileW(ptr(name), 0x80000000, 1, null, 3, 0x80, 0);
    try {
      expect(BigInt(handle)).not.toBe(0xffffffffffffffffn);
      expect(() => unlinkSync(file)).toThrow();
      const evidence = fixtureFileOwners(file) as { available: boolean; owners: { pid: number; image: string; creationMatched: boolean; isTestHost: boolean }[] };
      expect(evidence.available).toBe(true);
      expect(Array.isArray(evidence.owners)).toBe(true);
      expect(evidence.owners.some(owner => owner.pid === process.pid && owner.image === 'bun.exe' && owner.creationMatched && owner.isTestHost)).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('fixture-only');
    } finally {
      if (BigInt(handle) !== 0xffffffffffffffffn) kernel.symbols.CloseHandle(handle);
      kernel.close();
    }
  }, 10_000);

  test('the owner-probe child rejects a changed file identity before loading native APIs', () => {
    const fixture = mkdtempSync(path.join(root, 'owner-identity-'));
    const file = path.join(fixture, 'sensitive-sentinel');
    writeFileSync(file, 'fixture-only');
    const identity = lstatSync(file, { bigint: true });
    const input = { root: fixture, file, testPid: process.pid,
      expectedIdentity: { dev: identity.dev.toString(), ino: (identity.ino + 1n).toString() } };
    const script = `
      await import('node:fs');
      await import('node:path');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.argv = [process.execPath, 'fixture', ${JSON.stringify(Buffer.from(JSON.stringify(input)).toString('base64'))}];
      await import(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-file-owners.ts'))});
    `;
    const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-e', script], {
      env: { TEMP: fixture, TMP: fixture, HOME: fixture, USERPROFILE: fixture, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ available: false, reason: 'failed_object_identity_changed' });
    expect(result.stdout).not.toContain('sensitive-sentinel');
    expect(readFileSync(file, 'utf8')).toBe('fixture-only');
  });

  test('receipt assertions preserve the cookie array and all cookie fields', () => {
    const receipt: NativeCookieReply = { cookies: [{ name: 'synthetic', value: 'synthetic', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }] };
    const before = JSON.stringify(receipt);
    const cookies = receipt.cookies;
    Object.freeze(receipt);
    Object.freeze(cookies);
    Object.freeze(cookies[0]);
    expect(assertCookieReceipt(receipt)).toBe(cookies);
    expect(Array.isArray(receipt.cookies)).toBe(true);
    expect(JSON.stringify(receipt)).toBe(before);
    expect(() => assertCookieReceipt({ error: 'native_timeout' })).toThrow('native_timeout');
  });

  test('holder assertions preserve the real owner array and reject nonmatching identities', () => {
    const receipt = { available: true, owners: [{ pid: 123, image: 'bun.exe', creationMatched: true, isTestHost: true }] };
    const before = JSON.stringify(receipt);
    const owners = receipt.owners;
    Object.freeze(receipt);
    Object.freeze(owners);
    Object.freeze(owners[0]);
    assertOwnerReceipt(receipt, 123);
    expect(receipt.owners).toBe(owners);
    expect(Array.isArray(receipt.owners)).toBe(true);
    expect(JSON.stringify(receipt)).toBe(before);
    expect(() => assertOwnerReceipt(receipt, 124)).toThrow();
    expect(() => assertOwnerReceipt({ available: true, owners: [{ pid: 123, creationMatched: false, isTestHost: true }] }, 123)).toThrow();
  });

  test('native Unicode output retains the exact allocation address for short and long buffers', () => {
    const library = dlopen(process.platform === 'win32' ? 'msvcrt.dll' : process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      memcpy: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
    });
    try {
      for (const length of [32, 128, 512, 1024, 4096]) {
        const target = Buffer.alloc(length);
        const address = ptr(target);
        const source = Buffer.alloc(length);
        source.writeUInt16LE(4, 0);
        source.writeBigUInt64LE(BigInt(address) + 16n, 8);
        source.write('ab', 16, 'utf16le');
        library.symbols.memcpy(address, ptr(source), length);
        expect(decodeNativeCommandLine(target, address)).toBe('ab');
        target.writeBigUInt64LE(BigInt(address) + BigInt(length), 8);
        expect(decodeNativeCommandLine(target, address)).toBeNull();
      }
    } finally {
      library.close();
    }
  });

  test.skipIf(process.platform !== 'win32')('the native observer reads only the owned process and preserves Windows argument boundaries', async () => {
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required for process metadata verification');
    const environment = nativeCookieEnvironment(process.env);
    const args = ['-e', 'setInterval(() => {}, 1000)', '--', 'argument with spaces', '--user-data-dir=C:\\synthetic sensitive-sentinel'];
    const child = ownFixtureChild(spawn(node, args, { env: environment, stdio: 'ignore', windowsHide: true }));
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const observe = (owner: number) => spawnSync(process.execPath, [
      '--no-env-file', '--no-install', '--no-macros', '--config=NUL', path.resolve(import.meta.dir, 'fixtures/native-cookie-process-observer.ts'),
      Buffer.from(JSON.stringify({ pid: child.pid, owner, image: node })).toString('base64'),
    ], { env: environment, encoding: 'utf8', timeout: 5_000, windowsHide: true });
    try {
      const denied = observe(process.pid + 1);
      expect(denied.status).toBe(0);
      expect(JSON.parse(denied.stdout)).toMatchObject({ available: false, reason: 'owned_process_unavailable', parentMatched: false });
      const observed = observe(process.pid);
      expect(observed.status).toBe(0);
      expect(observed.stderr).toBe('');
      expect(observed.stdout).not.toContain('sensitive-sentinel');
      expect(JSON.parse(observed.stdout)).toMatchObject({
        available: true, parentMatched: true, imageMatched: true,
        argumentHashes: args.map(arg => createHash('sha256').update(arg).digest('hex')),
        userDataDirCount: 1,
      });
    } finally {
      child.kill();
      await closed;
    }
  }, 15_000);

  test.skipIf(process.platform !== 'win32')('the known-folder observer reports hashes and statuses without exposing profile paths', () => {
    const result = spawnSync(process.execPath, [
      '--no-env-file', '--no-install', '--no-macros', '--config=NUL', path.resolve(import.meta.dir, 'fixtures/native-cookie-process-observer.ts'),
      Buffer.from(JSON.stringify({ mode: 'known-folders' })).toString('base64'),
    ], { env: nativeCookieEnvironment(process.env), encoding: 'utf8', timeout: 5_000, windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const resultObject = JSON.parse(result.stdout);
    expect(resultObject).toMatchObject({ available: true });
    for (const name of ['local', 'roaming']) {
      expect(Number.isInteger(resultObject.knownFolders[name].verified.hresult)).toBe(true);
      expect(resultObject.knownFolders[name].dontVerify.pathHash).toMatch(/^[a-f0-9]{64}$/);
    }
    if (process.env.USERPROFILE) expect(result.stdout).not.toContain(process.env.USERPROFILE);
  });

  test.skipIf(process.platform !== 'win32')('the qualification version command reads the explicit executable environment variable', () => {
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required for version metadata verification');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = { ...nativeCookieEnvironment(process.env), GSTACK_QUALIFY_BROWSER_EXE: node };
    const old = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', NATIVE_BROWSER_VERSION_COMMAND.replace('$env:GSTACK_QUALIFY_BROWSER_EXE', '$env.GSTACK_QUALIFY_BROWSER_EXE')], {
      env, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    expect(old.status).not.toBe(0);
    expect(old.stdout.trim()).toBe('');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', NATIVE_BROWSER_VERSION_COMMAND], {
      env, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toMatch(/^\d+(?:\.\d+){2,3}$/);
  }, 25_000);

  test('the synthetic launch observer records safe reasons without raw stderr or environment values', () => {
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required for launch diagnostics');
    const fixture = mkdtempSync(path.join(root, 'launch-observer-'));
    const observation = path.join(fixture, 'launch.json');
    const playwrightEntry = path.join(fixture, 'fake-playwright.cjs');
    writeFileSync(playwrightEntry, `
      exports.chromium = { async launchPersistentContext() {
        const child = require('node:child_process').spawn('synthetic-browser.exe', ['--remote-debugging-pipe'], { env: { SYNTHETIC: 'sensitive-sentinel' } });
        child.stderr.write('AssignProcessToJobObject ERROR_ACCESS_DENIED sensitive-sentinel');
        child.emit('exit', 5, null);
        return { addCookies: async () => {} };
      } };
    `);
    const script = `
      const cp = require('node:child_process');
      const child = new (require('node:events').EventEmitter)();
      child.pid = 12345;
      child.stderr = new (require('node:stream').PassThrough)();
      cp.spawn = () => child;
      const api = require(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-launch.cjs'))})(${JSON.stringify({ observation, playwrightEntry })});
      api.chromium.launchPersistentContext('synthetic-profile', { chromiumSandbox: true }).then(() => console.log('observed'));
    `;
    const result = spawnSync(node, ['-e', script], {
      env: { PATH: path.dirname(node), TEMP: fixture, TMP: fixture, HOME: fixture, USERPROFILE: fixture, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('observed');
    expect(result.stderr).toBe('');
    const observed = JSON.parse(readFileSync(observation, 'utf8'));
    expect(observed).toMatchObject({ exitCode: 5, reasons: ['job_assignment_failed', 'permission_denied'] });
    expect(observed.argsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.envHash).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.runtime.node).toMatch(/^v\d+\.\d+\.\d+/);
    expect(observed.runtime.bun).toBeNull();
    expect(JSON.stringify(observed)).not.toContain('sensitive-sentinel');
  });

  for (const layout of ['flat', 'folders-ready']) {
    test.skipIf(process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true')(`compares contained and direct Node Edge launch with identical argv and environment (${layout} profile layout)`, async () => {
      const node = Bun.which('node');
      const edge = nativeBrowserPaths('Edge', process.env).executables.find(existsSync);
      if (!node || !edge) throw new Error('Native launch comparison requires Node and installed Microsoft Edge');
      const fixture = mkdtempSync(path.join(root, 'edge-comparison-'));
      const userDataDir = path.join(fixture, 'User Data');
      const observation = path.join(fixture, 'launch.json');
      const playwrightEntry = path.join(fixture, 'observed-playwright.cjs');
      const require = createRequire(import.meta.url);
      writeFileSync(playwrightEntry, `module.exports = require(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-launch.cjs'))})(${JSON.stringify({ observation, playwrightEntry: require.resolve('playwright'), inspectCommandLine: true, observerExecutable: process.execPath })});`);
      if (layout !== 'flat') {
        mkdirSync(path.join(fixture, 'AppData', 'Local'), { recursive: true });
        mkdirSync(path.join(fixture, 'AppData', 'Roaming'), { recursive: true });
      }
      const environment = nativeCookieEnvironment({ SystemRoot: process.env.SystemRoot!, TEMP: fixture, TMP: fixture, USERPROFILE: fixture, LOCALAPPDATA: fixture, APPDATA: fixture, PATH: path.dirname(node) });
      const input = { ...request, nodeExecutable: node, executablePath: edge, userDataDir, playwrightEntry };
      const supervisor = nativeSupervisor(input, environment);
      const contained = await supervisor.done;
      const containedLaunch = safeLaunchEvidence(observation);
      console.log(JSON.stringify({ nativeEdgeBeforeReset: { comparison: 'launch', layout, contained: 'error' in contained ? contained : { cookiesRead: contained.cookies.length }, containedLaunch, pendingChildCloses: fixtureChildren.size } }));
      if ('error' in contained && contained.error === 'native_cleanup_failed') throw new Error('Contained cleanup was not confirmed; direct comparison refused');
      if (existsSync(userDataDir)) {
        if (realpathSync(userDataDir).toLowerCase() !== path.resolve(userDataDir).toLowerCase()) throw new Error('Synthetic profile ownership changed; comparison refused');
        const identity = lstatSync(userDataDir, { bigint: true });
        try { resetOwnedProfileDirectory(userDataDir, identity, supervisor.cleanupDeadline); }
        catch (error) {
          console.error(JSON.stringify({ nativeFixtureRemovalFailure: { stage: 'launch_reset', layout, ...fixtureRemovalEvidence(error, userDataDir, identity) } }));
          throw error;
        }
      }
      const containedObservation = existsSync(observation) ? JSON.parse(readFileSync(observation, 'utf8')) : null;
      rmSync(observation, { force: true });
      const direct = spawnSync(node, ['--input-type=commonjs', '-e', NATIVE_COOKIE_NODE_SCRIPT], {
        env: environment, input: JSON.stringify({ ...input, deadline: Date.now() + 25_000 }),
        encoding: 'utf8', timeout: 30_000, windowsHide: true,
      });
      const directObservation = existsSync(observation) ? JSON.parse(readFileSync(observation, 'utf8')) : null;
      console.log(JSON.stringify({
        nativeEdgeLaunchComparison: {
          layout,
          contained: 'error' in contained ? contained : { cookiesRead: contained.cookies.length },
          containedLaunch, direct: safeNativeEnvelope(direct.stdout || ''), directStatus: direct.status,
          directLaunch: safeLaunchEvidence(observation),
          argvEqual: containedObservation?.argsHash === directObservation?.argsHash,
          environmentEqual: containedObservation?.envHash === directObservation?.envHash,
          observedCommandLinesEqual: containedObservation?.observedCommandLine?.available === true && directObservation?.observedCommandLine?.available === true
            ? containedObservation.observedCommandLine.commandLineHash === directObservation.observedCommandLine.commandLineHash : null,
        },
      }));
      expect(direct.error).toBeUndefined();
      expect(direct.status).toBe(0);
      assertCookieReceipt(JSON.parse(direct.stdout));
      expect(directObservation).not.toBeNull();
      expect(alive(directObservation.pid)).toBe(false);
      expect(containedObservation?.argsHash).toBe(directObservation.argsHash);
      expect(containedObservation?.envHash).toBe(directObservation.envHash);
      expect(containedObservation?.observedCommandLine).toMatchObject({ available: true });
      expect(directObservation.observedCommandLine).toMatchObject({ available: true });
      expect(containedObservation.folderEvidence.directoriesAfterProbe).toEqual(containedObservation.folderEvidence.directoriesBefore);
      expect(directObservation.folderEvidence.directoriesAfterProbe).toEqual(directObservation.folderEvidence.directoriesBefore);
    }, 65_000);
  }

  for (const state of ['preserved', 'fresh']) {
    test.skipIf(process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true')(`separates contained launch initialization from Job membership (${state} filesystem)`, async () => {
      const node = Bun.which('node');
      const edge = nativeBrowserPaths('Edge', process.env).executables.find(existsSync);
      if (!node || !edge) throw new Error('Native initialization comparison requires Node and installed Microsoft Edge');
      const fixture = mkdtempSync(path.join(root, 'edge-initialization-'));
      const ownedRoot = realpathSync(fixture);
      const rootState = lstatSync(fixture, { bigint: true });
      const rootIdentity = { path: ownedRoot, dev: rootState.dev, ino: rootState.ino };
      const userDataDir = path.join(fixture, 'User Data');
      const observation = path.join(fixture, 'launch.json');
      const playwrightEntry = path.join(fixture, 'observed-playwright.cjs');
      const require = createRequire(import.meta.url);
      const wrapper = `module.exports = require(${JSON.stringify(path.resolve(import.meta.dir, 'fixtures/native-cookie-launch.cjs'))})(${JSON.stringify({ observation, playwrightEntry: require.resolve('playwright'), inspectCommandLine: true, observerExecutable: process.execPath })});`;
      const environment = nativeCookieEnvironment({ SystemRoot: process.env.SystemRoot!, TEMP: fixture, TMP: fixture, USERPROFILE: fixture, LOCALAPPDATA: fixture, APPDATA: fixture, PATH: path.dirname(node) });
      const input = { ...request, nodeExecutable: node, executablePath: edge, userDataDir, playwrightEntry };
      writeFileSync(playwrightEntry, wrapper);
      const firstSupervisor = nativeSupervisor(input, environment);
      const first = await firstSupervisor.done;
      const firstLaunch = safeLaunchEvidence(observation);
      const firstObservation = JSON.parse(readFileSync(observation, 'utf8'));
      console.log(JSON.stringify({ nativeEdgeBeforeReset: { comparison: 'initialization', state, first: 'error' in first ? first : { cookiesRead: first.cookies.length }, firstLaunch, pendingChildCloses: fixtureChildren.size } }));
      if ('error' in first && first.error === 'native_cleanup_failed') throw new Error('Initial containment cleanup was not confirmed');
      if (realpathSync(fixture) !== ownedRoot) throw new Error('Initialization fixture ownership changed');
      if (state === 'fresh') {
        clearOwnedFixtureContents(fixture, rootIdentity);
      } else {
        if (existsSync(userDataDir) && realpathSync(userDataDir) !== path.join(ownedRoot, 'User Data')) throw new Error('Synthetic profile ownership changed');
        const identity = existsSync(userDataDir) ? lstatSync(userDataDir, { bigint: true }) : undefined;
        try { if (identity) resetOwnedProfileDirectory(userDataDir, identity, firstSupervisor.cleanupDeadline); }
        catch (error) {
          console.error(JSON.stringify({ nativeFixtureRemovalFailure: { stage: 'initialization_reset', state, ...(identity ? fixtureRemovalEvidence(error, userDataDir, identity) : { inspected: false, reason: 'no_pre_reset_identity' }) } }));
          throw error;
        }
        rmSync(observation, { force: true });
      }
      writeFileSync(playwrightEntry, wrapper);
      const second = await nativeSupervisor(input, environment).done;
      const secondObservation = JSON.parse(readFileSync(observation, 'utf8'));
      console.log(JSON.stringify({ nativeEdgeInitializationComparison: {
        state,
        first: 'error' in first ? first : { cookiesRead: first.cookies.length }, firstLaunch,
        second: 'error' in second ? second : { cookiesRead: second.cookies.length }, secondLaunch: safeLaunchEvidence(observation),
        argvEqual: firstObservation.argsHash === secondObservation.argsHash,
        environmentEqual: firstObservation.envHash === secondObservation.envHash,
      } }));
      expect(firstObservation.argsHash).toBe(secondObservation.argsHash);
      expect(firstObservation.envHash).toBe(secondObservation.envHash);
      expect(firstObservation.observedCommandLine).toMatchObject({ available: true });
      expect(secondObservation.observedCommandLine).toMatchObject({ available: true });
      expect('error' in second ? second.error : null).not.toBe('native_cleanup_failed');
      if (state === 'fresh') expect(firstObservation.folderEvidence.directoriesBefore).toEqual(secondObservation.folderEvidence.directoriesBefore);
    }, 65_000);
  }
});
