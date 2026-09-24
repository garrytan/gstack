import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { dlopen, FFIType, ptr } from 'bun:ffi';

let stage = 'platform';

class FileOwnerProbeError extends Error {
  errorCode?: string;
  constructor(public stage: string, error: unknown) {
    super('owner_query_failed');
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (['EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'EINVAL', 'ENOTDIR', 'ENAMETOOLONG', 'ETIMEDOUT'].includes(code || '')) this.errorCode = code;
  }
}

function inspect() {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) return { available: false, reason: 'not_windows' };
  stage = 'input_decode';
  const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  if (typeof input.root !== 'string' || typeof input.file !== 'string' || !Number.isSafeInteger(input.testPid)) return { available: false, reason: 'invalid_input' };
  stage = 'resolve_root';
  const root = realpathSync(input.root);
  stage = 'resolve_file';
  const file = realpathSync(input.file);
  const relative = path.relative(root, file);
  stage = 'file_stat';
  const initial = lstatSync(input.file, { bigint: true });
  if (relative.startsWith('..') || path.isAbsolute(relative) || !initial.isFile() || initial.isSymbolicLink()
    || relative !== path.relative(root, path.resolve(input.file))) return { available: false, reason: 'outside_owned_fixture' };
  if (input.expectedIdentity !== undefined && (input.expectedIdentity?.dev !== initial.dev.toString()
    || input.expectedIdentity?.ino !== initial.ino.toString())) return { available: false, reason: 'failed_object_identity_changed' };
  const unchanged = () => {
    stage = 'file_recheck';
    const current = lstatSync(input.file, { bigint: true });
    return current.isFile() && !current.isSymbolicLink() && current.dev === initial.dev && current.ino === initial.ino
      && realpathSync(input.file) === file;
  };
  stage = 'load_restart_manager';
  const restart = dlopen(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rstrtmgr.dll'), {
    RmStartSession: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    RmRegisterResources: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    RmGetList: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RmEndSession: { args: [FFIType.u32], returns: FFIType.u32 },
  });
  stage = 'load_kernel';
  const kernel = dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    QueryFullProcessImageNameW: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  });
  let session: number | undefined;
  try {
    const sessionBuffer = Buffer.alloc(4);
    const key = Buffer.alloc(66);
    stage = 'session_start';
    let status = restart.symbols.RmStartSession(ptr(sessionBuffer), 0, ptr(key));
    if (status !== 0) return { available: false, reason: 'session_start', status };
    session = sessionBuffer.readUInt32LE(0);
    const wideFile = Buffer.from(file + '\0', 'utf16le');
    const names = Buffer.alloc(8);
    names.writeBigUInt64LE(BigInt(ptr(wideFile)));
    stage = 'register_file';
    status = restart.symbols.RmRegisterResources(session, 1, ptr(names), 0, null, 0, null);
    if (status !== 0) return { available: false, reason: 'register_file', status };
    const needed = Buffer.alloc(4);
    const count = Buffer.alloc(4);
    const rebootReasons = Buffer.alloc(4);
    stage = 'owner_count';
    status = restart.symbols.RmGetList(session, ptr(needed), ptr(count), null, ptr(rebootReasons));
    if (status === 0 && needed.readUInt32LE(0) === 0) return unchanged()
      ? { available: true, owners: [], rebootReasons: rebootReasons.readUInt32LE(0) }
      : { available: false, reason: 'failed_object_identity_changed' };
    const entries = needed.readUInt32LE(0);
    if (status !== 234 || entries < 1 || entries > 64) return { available: false, reason: 'owner_count', status, entries };
    const information = Buffer.alloc(entries * 668);
    count.writeUInt32LE(entries);
    stage = 'owner_list';
    status = restart.symbols.RmGetList(session, ptr(needed), ptr(count), ptr(information), ptr(rebootReasons));
    const returned = count.readUInt32LE(0);
    if (status !== 0 || returned > entries) return { available: false, reason: 'owner_list', status };
    const owners = [];
    stage = 'owner_identity';
    for (let index = 0; index < returned; index++) {
      const offset = index * 668;
      const pid = information.readUInt32LE(offset);
      const recordedStart = information.readBigUInt64LE(offset + 4);
      let image = 'unavailable';
      let creationMatched = false;
      const handle = kernel.symbols.OpenProcess(0x1000, 0, pid);
      if (handle) {
        try {
          const times = Buffer.alloc(32);
          const timeAddress = ptr(times);
          if (kernel.symbols.GetProcessTimes(handle, timeAddress, timeAddress + 8, timeAddress + 16, timeAddress + 24)) {
            creationMatched = times.readBigUInt64LE(0) === recordedStart;
          }
          if (creationMatched) {
            const imageBuffer = Buffer.alloc(65536);
            const imageLength = Buffer.alloc(4);
            imageLength.writeUInt32LE(32768);
            if (kernel.symbols.QueryFullProcessImageNameW(handle, 0, ptr(imageBuffer), ptr(imageLength))) {
              const chars = imageLength.readUInt32LE(0);
              const name = chars <= 32768 ? path.basename(imageBuffer.subarray(0, chars * 2).toString('utf16le')).toLowerCase() : '';
              image = ['bun.exe', 'node.exe', 'msedge.exe', 'msmpeng.exe', 'mssense.exe', 'dllhost.exe', 'explorer.exe', 'powershell.exe', 'pwsh.exe', 'svchost.exe', 'conhost.exe'].includes(name) ? name : 'other';
            }
          }
        } finally {
          kernel.symbols.CloseHandle(handle);
        }
      }
      owners.push({ pid, image, creationMatched, isTestHost: creationMatched && pid === input.testPid, applicationType: information.readUInt32LE(offset + 652) });
    }
    return unchanged() ? { available: true, owners, rebootReasons: rebootReasons.readUInt32LE(0) }
      : { available: false, reason: 'failed_object_identity_changed' };
  } catch (error) {
    throw new FileOwnerProbeError(stage, error);
  } finally {
    stage = 'session_end';
    if (session !== undefined) restart.symbols.RmEndSession(session);
    stage = 'library_close';
    kernel.close(); restart.close();
  }
}

let result: object;
try { result = inspect(); }
catch (error) {
  const failure = error instanceof FileOwnerProbeError ? error : new FileOwnerProbeError(stage, error);
  result = { available: false, reason: 'owner_query_failed', stage: failure.stage, errorCode: failure.errorCode };
}
process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
