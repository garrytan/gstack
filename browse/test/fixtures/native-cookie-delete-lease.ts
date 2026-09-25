import { lstatSync, unlinkSync } from 'node:fs';
import { toNamespacedPath } from 'node:path';
import { dlopen, FFIType, ptr } from 'bun:ffi';

type Identity = { dev: bigint; ino: bigint; mode: bigint };
type Handle = number | bigint;
type Stage = 'admission' | 'identity' | 'disposition' | 'close' | 'absence';

export class FixtureDeleteError extends Error {
  readonly code: string;
  readonly syscall: string;
  constructor(public stage: Stage, public path: string, public win32Error?: number, public deadlineExceeded = false) {
    super(`Owned fixture deletion failed at ${stage}${deadlineExceeded ? ' (deadline)' : win32Error === undefined ? '' : ` (Windows ${win32Error})`}`);
    this.name = 'FixtureDeleteError';
    this.code = deadlineExceeded ? 'ETIMEDOUT' : win32Error === 32 ? 'EBUSY' : win32Error === 2 || win32Error === 3 ? 'ENOENT' : win32Error === 5 ? 'EACCES' : 'EIO';
    this.syscall = { admission: 'open', identity: 'fstat', disposition: 'unlink', close: 'close', absence: 'lstat' }[stage];
  }
}

export interface FixtureDeleteBackend {
  open(file: string): Handle;
  identity(handle: Handle, file: string): { dev: bigint; ino: bigint; attributes: number; filesystem: string };
  dispose(handle: Handle, file: string): void;
  close(handle: Handle, file: string): void;
  absent(file: string): boolean;
}

type LeaseClock = { now(): number; wait(ms: number): void; onSharing?(): void };
const leaseClock: LeaseClock = { now: () => performance.now(), wait: ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } };

export function deleteWithFixtureLease(file: string, expected: Identity, deadline: number, verify: () => void,
  backend: FixtureDeleteBackend, clock: LeaseClock = leaseClock): { admissionProbes: number; waitedMs: number } {
  if (!Number.isFinite(deadline)) throw new Error('Invalid fixture deletion deadline');
  let handle: Handle | undefined;
  let firstSharing: FixtureDeleteError | undefined;
  let admissionProbes = 0;
  let waitedMs = 0;
  while (handle === undefined) {
    if (clock.now() >= deadline) throw firstSharing ?? new FixtureDeleteError('admission', file, undefined, true);
    verify();
    if (clock.now() >= deadline) throw firstSharing ?? new FixtureDeleteError('admission', file, undefined, true);
    try { admissionProbes++; handle = backend.open(file); }
    catch (error) {
      if (!(error instanceof FixtureDeleteError) || error.stage !== 'admission' || error.win32Error !== 32) throw error;
      if (!firstSharing) { firstSharing = error; clock.onSharing?.(); }
      const remaining = deadline - clock.now();
      if (remaining <= 0) throw firstSharing;
      const before = clock.now();
      clock.wait(Math.min(20, remaining));
      waitedMs += Math.max(0, clock.now() - before);
    }
  }
  let failed = false;
  let failure: unknown;
  try {
    const current = backend.identity(handle, file);
    if (current.filesystem !== 'NTFS' || current.dev !== expected.dev || current.ino !== expected.ino
      || (current.attributes & (0x1 | 0x10 | 0x400)) !== 0) throw new FixtureDeleteError('identity', file);
    verify();
    if (clock.now() >= deadline) throw firstSharing ?? new FixtureDeleteError('admission', file, undefined, true);
    backend.dispose(handle, file);
  } catch (error) { failed = true; failure = error; }
  try { backend.close(handle, file); }
  catch (error) {
    if (failed) console.error(JSON.stringify({ nativeFixtureDeleteCloseFailure: {
      stage: error instanceof FixtureDeleteError ? error.stage : 'close',
      win32Error: error instanceof FixtureDeleteError ? error.win32Error : undefined,
    } }));
    else { failed = true; failure = error; }
  }
  if (failed) throw failure;
  if (!backend.absent(file)) throw new FixtureDeleteError('absence', file);
  return { admissionProbes, waitedMs };
}

export function createFixtureDeleteLease(deadline: number, onSharing?: () => void) {
  if (process.platform !== 'win32') return { unlink: (file: string, _identity: Identity, _verify: () => void) => unlinkSync(file), close: () => {} };
  const kernel = dlopen('kernel32.dll', {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
    GetFileInformationByHandle: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    GetVolumeInformationByHandleW: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    SetFileInformationByHandle: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const backend: FixtureDeleteBackend = {
    open(file) {
      const name = Buffer.from(toNamespacedPath(file) + '\0', 'utf16le');
      const handle = kernel.symbols.CreateFileW(ptr(name), 0x10080, 3, null, 3, 0x00200000, 0);
      const error = kernel.symbols.GetLastError();
      if (BigInt(handle) === 0xffffffffffffffffn || BigInt(handle) === 0n) throw new FixtureDeleteError('admission', file, error);
      return handle;
    },
    identity(handle, file) {
      const info = Buffer.alloc(52);
      if (!kernel.symbols.GetFileInformationByHandle(handle, ptr(info))) throw new FixtureDeleteError('identity', file, kernel.symbols.GetLastError());
      const filesystem = Buffer.alloc(128);
      if (!kernel.symbols.GetVolumeInformationByHandleW(handle, null, 0, null, null, null, ptr(filesystem), 64)) throw new FixtureDeleteError('identity', file, kernel.symbols.GetLastError());
      return { dev: BigInt(info.readUInt32LE(28)), ino: (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48)),
        attributes: info.readUInt32LE(0), filesystem: filesystem.toString('utf16le').split('\0')[0] };
    },
    dispose(handle, file) {
      const flags = Buffer.alloc(4);
      flags.writeUInt32LE(3);
      if (!kernel.symbols.SetFileInformationByHandle(handle, 21, ptr(flags), 4)) throw new FixtureDeleteError('disposition', file, kernel.symbols.GetLastError());
    },
    close(handle, file) {
      if (!kernel.symbols.CloseHandle(handle)) throw new FixtureDeleteError('close', file, kernel.symbols.GetLastError());
    },
    absent(file) {
      try { lstatSync(file); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    },
  };
  return {
    unlink(file: string, identity: Identity, verify: () => void) {
      if ((identity.mode & 0o170000n) !== 0o100000n) { verify(); unlinkSync(file); return; }
      const receipt = deleteWithFixtureLease(file, identity, deadline, verify, backend, { ...leaseClock, onSharing });
      if (receipt.admissionProbes > 1) console.log(JSON.stringify({ nativeFixtureSharingAdmission: {
        objectDev: identity.dev.toString(), objectIno: identity.ino.toString(), ...receipt, dispositionCalls: 1,
      } }));
    },
    close() { kernel.close(); },
  };
}
