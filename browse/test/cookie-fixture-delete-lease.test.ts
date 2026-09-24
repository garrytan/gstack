import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { createFixtureDeleteLease, deleteWithFixtureLease, FixtureDeleteError, type FixtureDeleteBackend } from './fixtures/native-cookie-delete-lease';
import { nativeCookieEnvironment } from '../src/cookie-import-native-worker';

const root = mkdtempSync(path.join(tmpdir(), 'delete-lease-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const identity = { dev: 7n, ino: 9007199254740993n, mode: 0o100666n };

function model() {
  let time = 0;
  const calls: string[] = [];
  const backend: FixtureDeleteBackend = {
    open: () => { calls.push('open'); return 42; },
    identity: () => { calls.push('identity'); return { ...identity, attributes: 0x80, filesystem: 'NTFS' }; },
    dispose: () => { calls.push('dispose'); },
    close: () => { calls.push('close'); },
    absent: () => { calls.push('absent'); return true; },
  };
  const verify = () => { calls.push('verify'); };
  const clock = { now: () => time, wait: (ms: number) => { calls.push(`wait:${ms}`); time += ms; } };
  return { backend, calls, verify, clock, advance: (ms: number) => { time += ms; } };
}

test('an admitted identity is deleted once, closed, and checked for absence in that order', () => {
  const f = model();
  expect(deleteWithFixtureLease('owned', identity, 100, f.verify, f.backend, f.clock)).toEqual({ admissionProbes: 1, waitedMs: 0 });
  expect(f.calls).toEqual(['verify', 'open', 'identity', 'verify', 'dispose', 'close', 'absent']);
});

test('sharing admission can settle inside the same deadline without retrying deletion', () => {
  const f = model(); let attempts = 0;
  f.backend.open = () => { f.calls.push('open'); if (++attempts < 3) throw new FixtureDeleteError('admission', 'owned', 32); return 42; };
  expect(deleteWithFixtureLease('owned', identity, 100, f.verify, f.backend, f.clock)).toEqual({ admissionProbes: 3, waitedMs: 40 });
  expect(f.calls.filter(call => call === 'dispose')).toHaveLength(1);
  expect(f.calls.filter(call => call === 'close')).toHaveLength(1);
});

test('persistent sharing keeps its first error and performs zero deletes', () => {
  const f = model(); const first = new FixtureDeleteError('admission', 'owned', 32); let attempts = 0;
  f.backend.open = () => { attempts++; throw attempts === 1 ? first : new FixtureDeleteError('admission', 'owned', 32); };
  let failure: unknown;
  try { deleteWithFixtureLease('owned', identity, 40, f.verify, f.backend, f.clock); } catch (error) { failure = error; }
  expect(failure).toBe(first);
  expect(attempts).toBe(2);
  expect(f.calls).not.toContain('dispose');
  expect(f.calls).not.toContain('close');
});

test.each([2, 3, 5, 33, 50, 87])('admission error %s is never polled or deleted', code => {
  const f = model(); const original = new FixtureDeleteError('admission', 'owned', code);
  f.backend.open = () => { f.calls.push('open'); throw original; };
  let failure: unknown;
  try { deleteWithFixtureLease('owned', identity, 100, f.verify, f.backend, f.clock); } catch (error) { failure = error; }
  expect(failure).toBe(original);
  expect(f.calls).toEqual(['verify', 'open']);
});

test.each(['volume', 'inode', 'ReFS', 'readonly', 'directory', 'reparse', 'ancestor'])(
  'a rejected %s identity closes its handle without deleting', defect => {
    const f = model();
    f.backend.identity = () => ({ ...identity, dev: defect === 'volume' ? 8n : identity.dev,
      ino: defect === 'inode' ? 9007199254740992n : identity.ino, filesystem: defect === 'ReFS' ? 'ReFS' : 'NTFS',
      attributes: { readonly: 1, directory: 16, reparse: 1024 }[defect] ?? 0x80 });
    let checks = 0;
    const verify = () => { if (++checks === 2 && defect === 'ancestor') throw new Error('Owned ancestor changed'); };
    expect(() => deleteWithFixtureLease('owned', identity, 100, verify, f.backend, f.clock)).toThrow();
    expect(f.calls.filter(call => call === 'close')).toHaveLength(1);
    expect(f.calls).not.toContain('dispose');
  });

test.each(['before_open', 'after_verify', 'after_identity', 'after_revalidation'])(
  'expiration %s never grants late deletion', stage => {
    const f = model(); let checks = 0;
    if (stage === 'before_open') f.advance(100);
    const verify = () => { checks++; if (stage === 'after_verify' && checks === 1 || stage === 'after_revalidation' && checks === 2) f.advance(100); };
    const identify = f.backend.identity;
    f.backend.identity = (handle, file) => { const result = identify(handle, file); if (stage === 'after_identity') f.advance(100); return result; };
    expect(() => deleteWithFixtureLease('owned', identity, 100, verify, f.backend, f.clock)).toThrow('deadline');
    expect(f.calls).not.toContain('dispose');
    expect(f.calls.filter(call => call === 'close')).toHaveLength(stage.startsWith('before') || stage === 'after_verify' ? 0 : 1);
  });

test('a disposition failure is not retried and survives close', () => {
  const f = model(); const original = new FixtureDeleteError('disposition', 'owned', 32);
  f.backend.dispose = () => { f.calls.push('dispose'); throw original; };
  let failure: unknown;
  try { deleteWithFixtureLease('owned', identity, 100, f.verify, f.backend, f.clock); } catch (error) { failure = error; }
  expect(failure).toBe(original);
  expect(f.calls.filter(call => call === 'dispose')).toHaveLength(1);
  expect(f.calls.at(-1)).toBe('close');
  expect(f.calls.some(call => call.startsWith('wait'))).toBe(false);
});

test.each(['close', 'absence'])('%s failure never reports completed removal', stage => {
  const f = model();
  if (stage === 'close') f.backend.close = () => { throw new FixtureDeleteError('close', 'owned', 6); };
  else f.backend.absent = () => false;
  expect(() => deleteWithFixtureLease('owned', identity, 100, f.verify, f.backend, f.clock)).toThrow(stage);
});

test('the actual Windows binding uses the checked handle, NTFS identity, and Ex flags without a fallback', () => {
  const source = readFileSync(path.join(import.meta.dir, 'fixtures/native-cookie-delete-lease.ts'), 'utf8');
  const start = source.indexOf('export function createFixtureDeleteLease(');
  expect(start).toBeGreaterThan(0);
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start).replace('export function', 'function'));
  const calls: string[] = [];
  const api = {
    CreateFileW(name: Buffer, access: number, share: number, security: unknown, creation: number, flags: number, template: number) {
      calls.push('open');
      expect(name.toString('utf16le')).toBe('namespaced-owned\0');
      expect([access, share, security, creation, flags, template]).toEqual([0x10080, 3, null, 3, 0x00200000, 0]);
      return 42;
    },
    GetLastError() { calls.push('last-error'); return 0; },
    GetFileInformationByHandle(handle: number, info: Buffer) {
      calls.push('identity'); expect(handle).toBe(42); expect(info.length).toBe(52);
      info.writeUInt32LE(0x80, 0); info.writeUInt32LE(Number(identity.dev), 28);
      info.writeUInt32LE(Number(identity.ino >> 32n), 44); info.writeUInt32LE(Number(identity.ino & 0xffffffffn), 48);
      return 1;
    },
    GetVolumeInformationByHandleW(handle: number, name: unknown, length: number, serial: unknown, component: unknown, flags: unknown, filesystem: Buffer, size: number) {
      calls.push('filesystem'); expect([handle, name, length, serial, component, flags, size]).toEqual([42, null, 0, null, null, null, 64]);
      expect(filesystem.length).toBe(128); filesystem.write('NTFS\0', 'utf16le'); return 1;
    },
    SetFileInformationByHandle(handle: number, kind: number, flags: Buffer, size: number) {
      calls.push('dispose'); expect([handle, kind, flags.length, flags.readUInt32LE(0), size]).toEqual([42, 21, 4, 3, 4]); return 1;
    },
    CloseHandle(handle: number) { calls.push('close'); expect(handle).toBe(42); return 1; },
  };
  const factory = new Function('process', 'dlopen', 'FFIType', 'ptr', 'unlinkSync', 'lstatSync', 'toNamespacedPath',
    'FixtureDeleteError', 'deleteWithFixtureLease', 'leaseClock', `${body}\nreturn createFixtureDeleteLease;`)(
    { platform: 'win32' }, (name: string) => { expect(name).toBe('kernel32.dll'); return { symbols: api, close() { calls.push('unload'); } }; },
    { ptr: 'ptr', u32: 'u32', u64: 'u64', i32: 'i32' }, (value: Buffer) => value,
    () => { throw new Error('Regular files must not use a path-based fallback'); },
    () => { calls.push('absence'); throw Object.assign(new Error('Absent'), { code: 'ENOENT' }); },
    (file: string) => { expect(file).toBe('owned'); return 'namespaced-owned'; },
    FixtureDeleteError, deleteWithFixtureLease, { now: () => 0, wait: () => { throw new Error('Unexpected wait'); } });
  const lease = factory(100);
  lease.unlink('owned', identity, () => { calls.push('verify'); });
  lease.close();
  expect(calls).toEqual(['verify', 'open', 'last-error', 'identity', 'filesystem', 'verify', 'dispose', 'close', 'absence', 'unload']);
});

test.skipIf(process.platform !== 'win32')('the native lease refuses a persistent no-delete-sharing holder', () => {
  const file = path.join(root, 'persistent'); writeFileSync(file, 'fixture-only');
  const expected = lstatSync(file, { bigint: true });
  const kernel = dlopen('kernel32.dll', {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  });
  const name = Buffer.from(file + '\0', 'utf16le');
  const handle = kernel.symbols.CreateFileW(ptr(name), 0x80000000, 3, null, 3, 0x80, 0);
  const lease = createFixtureDeleteLease(performance.now() + 1_000);
  try {
    expect(BigInt(handle)).not.toBe(0xffffffffffffffffn);
    expect(BigInt(handle)).not.toBe(0n);
    let failure: unknown;
    try { lease.unlink(file, expected, () => {}); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(FixtureDeleteError);
    expect(failure).toMatchObject({ stage: 'admission', win32Error: 32, code: 'EBUSY' });
    expect(readFileSync(file, 'utf8')).toBe('fixture-only');
    expect(lstatSync(file, { bigint: true }).ino).toBe(expected.ino);
  } finally { lease.close(); if (BigInt(handle) !== 0xffffffffffffffffn && BigInt(handle) !== 0n) kernel.symbols.CloseHandle(handle); kernel.close(); }
});

test.skipIf(process.platform !== 'win32')('a compatible reader retains its data while the admitted delete removes the namespace', () => {
  const directory = mkdtempSync(path.join(root, 'reader-'));
  const file = path.join(directory, 'data'); writeFileSync(file, 'fixture-only');
  const expected = lstatSync(file, { bigint: true });
  const kernel = dlopen('kernel32.dll', {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
    ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  });
  const name = Buffer.from(file + '\0', 'utf16le');
  const handle = kernel.symbols.CreateFileW(ptr(name), 0x80000000, 7, null, 3, 0x80, 0);
  const lease = createFixtureDeleteLease(performance.now() + 2_000);
  try {
    expect(BigInt(handle)).not.toBe(0xffffffffffffffffn);
    expect(BigInt(handle)).not.toBe(0n);
    let checks = 0;
    lease.unlink(file, expected, () => { if (++checks === 2) expect(() => renameSync(file, path.join(directory, 'moved'))).toThrow(); });
    expect(checks).toBe(2);
    expect(existsSync(file)).toBe(false);
    rmdirSync(directory);
    const buffer = Buffer.alloc(32), bytes = Buffer.alloc(4);
    expect(kernel.symbols.ReadFile(handle, ptr(buffer), buffer.length, ptr(bytes), null)).toBe(1);
    expect(buffer.subarray(0, bytes.readUInt32LE()).toString()).toBe('fixture-only');
  } finally { lease.close(); if (BigInt(handle) !== 0xffffffffffffffffn && BigInt(handle) !== 0n) kernel.symbols.CloseHandle(handle); kernel.close(); }
});

test.skipIf(process.platform !== 'win32')('an independently released holder admits one identity-bound deletion', async () => {
  const directory = mkdtempSync(path.join(root, 'released-'));
  const file = path.join(directory, 'held'), ready = path.join(directory, 'ready'), release = path.join(directory, 'release');
  writeFileSync(file, 'fixture-only'); const expected = lstatSync(file, { bigint: true });
  const script = `
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    const { existsSync, writeFileSync } = await import('node:fs');
    const api = dlopen('kernel32.dll', {
      CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    });
    const name = Buffer.from(${JSON.stringify(file)} + '\\0', 'utf16le');
    const handle = api.symbols.CreateFileW(ptr(name), 0x80000000, 3, null, 3, 0x80, 0);
    if (BigInt(handle) === 0xffffffffffffffffn || BigInt(handle) === 0n) throw new Error('Holder open failed');
    try {
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
    } finally { if (!api.symbols.CloseHandle(handle)) throw new Error('Holder close failed'); api.close(); }
  `;
  const child: ChildProcess = spawn(process.execPath, ['--no-env-file', '--no-install', '--config=NUL', '-e', script],
    { env: nativeCookieEnvironment(process.env), stdio: 'ignore', windowsHide: true });
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const timer = setTimeout(() => child.kill(), 5_000);
  let lease: ReturnType<typeof createFixtureDeleteLease> | undefined;
  try {
    const deadline = performance.now() + 3_000;
    while (!existsSync(ready) && child.exitCode === null && !spawnError && performance.now() < deadline) await Bun.sleep(10);
    expect(spawnError).toBeUndefined();
    expect(existsSync(ready)).toBe(true);
    let blocked = 0;
    lease = createFixtureDeleteLease(performance.now() + 2_000, () => { blocked++; writeFileSync(release, 'release'); });
    lease.unlink(file, expected, () => {});
    expect(blocked).toBe(1);
    expect(existsSync(file)).toBe(false);
    await closed;
    expect(child.exitCode).toBe(0);
  } finally { clearTimeout(timer); lease?.close(); child.kill(); await closed; }
}, 10_000);

test.skipIf(process.platform !== 'win32').each(['identity', 'readonly', 'reparse'])(
  'the native lease refuses %s without removing the file or target', defect => {
    const directory = mkdtempSync(path.join(root, 'refused-'));
    const file = path.join(directory, 'data'); writeFileSync(file, 'fixture-only');
    const expected = lstatSync(file, { bigint: true });
    const destination = path.join(directory, 'destination');
    if (defect === 'readonly') chmodSync(file, 0o444);
    if (defect === 'reparse') {
      unlinkSync(file); mkdirSync(destination); writeFileSync(path.join(destination, 'preserved'), 'fixture-only');
      symlinkSync(destination, file, 'junction');
    }
    const lease = createFixtureDeleteLease(performance.now() + 2_000);
    try {
      expect(() => lease.unlink(file, defect === 'identity' ? { ...expected, ino: expected.ino + 1n } : expected, () => {})).toThrow();
      expect(existsSync(file)).toBe(true);
      if (defect === 'reparse') expect(readFileSync(path.join(destination, 'preserved'), 'utf8')).toBe('fixture-only');
      else expect(readFileSync(file, 'utf8')).toBe('fixture-only');
    } finally { lease.close(); if (defect === 'readonly') chmodSync(file, 0o666); }
  });
