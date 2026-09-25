import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function decodeNativeCommandLine(buffer: Buffer, address: number | bigint): string | null {
  if (buffer.length < 16) return null;
  const length = buffer.readUInt16LE(0);
  const offset = Number(buffer.readBigUInt64LE(8) - BigInt(address));
  if (!Number.isSafeInteger(offset) || offset < 16 || offset + length > buffer.length || length % 2 !== 0) return null;
  return buffer.subarray(offset, offset + length).toString('utf16le');
}

function knownFolders() {
  const shell = dlopen('shell32.dll', {
    SHGetFolderPathW: { args: [FFIType.u64, FFIType.i32, FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const normalized = (value: string) => path.win32.normalize(value).toLowerCase();
  try {
    return Object.fromEntries([['local', 0x1c, 'LOCALAPPDATA'], ['roaming', 0x1a, 'APPDATA']].map(([name, id, env]) => {
      const calls = Object.fromEntries([['verified', 0], ['dontVerify', 0x4000]].map(([kind, flag]) => {
        const output = Buffer.alloc(520);
        const status = shell.symbols.SHGetFolderPathW(0, Number(id) | Number(flag), 0, 0, ptr(output));
        let end = 0;
        while (end + 2 <= output.length && output.readUInt16LE(end) !== 0) end += 2;
        const folder = status >= 0 && end > 0 && end + 2 <= output.length ? output.subarray(0, end).toString('utf16le') : null;
        return [kind, {
          hresult: status,
          pathHash: folder ? hash(normalized(folder)) : null,
          exists: folder ? existsSync(folder) : null,
          matchesEnvironment: folder ? normalized(folder) === normalized(process.env[String(env)] || '') : null,
          underUserProfile: folder ? normalized(folder).startsWith(normalized(process.env.USERPROFILE || '') + '\\') : null,
        }];
      }));
      return [name, calls];
    }));
  } finally {
    shell.close();
  }
}

function observe() {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) return { available: false, reason: 'not_windows' };
  const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  if (input.mode === 'known-folders') return { available: true, knownFolders: knownFolders() };
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0 || input.pid > 0xffffffff || !Number.isSafeInteger(input.owner) || input.owner <= 0 || input.owner > 0xffffffff || typeof input.image !== 'string' || input.image.length > 32768) {
    return { available: false, reason: 'invalid_input' };
  }
  const kernel = dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    QueryFullProcessImageNameW: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    QueryInformationJobObject: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IsProcessInJob: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    LocalSize: { args: [FFIType.ptr], returns: FFIType.u64 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const nt = dlopen('ntdll.dll', {
    NtQueryInformationProcess: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const shell = dlopen('shell32.dll', {
    CommandLineToArgvW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  });
  let processHandle: number | bigint = 0;
  let argumentMemory: ReturnType<typeof shell.symbols.CommandLineToArgvW> = null;
  let stage = 'process_open';
  try {
    processHandle = kernel.symbols.OpenProcess(0x1000, 0, input.pid);
    if (!processHandle) return { available: false, reason: stage, win32Error: kernel.symbols.GetLastError() };
    stage = 'process_identity';
    const basic = Buffer.alloc(48);
    const returned = Buffer.alloc(4);
    let status = nt.symbols.NtQueryInformationProcess(processHandle, 0, ptr(basic), basic.length, ptr(returned));
    if (status !== 0) return { available: false, reason: stage, ntStatus: status };
    const parentMatched = basic.readBigUInt64LE(40) === BigInt(input.owner);
    const pidMatched = basic.readBigUInt64LE(32) === BigInt(input.pid);
    const imageBuffer = Buffer.alloc(65536);
    const imageLength = Buffer.alloc(4);
    imageLength.writeUInt32LE(32768);
    if (!kernel.symbols.QueryFullProcessImageNameW(processHandle, 0, ptr(imageBuffer), ptr(imageLength))) {
      return { available: false, reason: stage, win32Error: kernel.symbols.GetLastError() };
    }
    const imageChars = imageLength.readUInt32LE(0);
    const imageMatched = imageChars <= 32768 && imageBuffer.subarray(0, imageChars * 2).toString('utf16le').toLowerCase() === input.image.toLowerCase();
    if (!parentMatched || !pidMatched || !imageMatched) return { available: false, reason: 'owned_process_unavailable', parentMatched, imageMatched };
    stage = 'command_line';
    status = nt.symbols.NtQueryInformationProcess(processHandle, 60, null, 0, ptr(returned));
    const length = returned.readUInt32LE(0);
    if (length < 16 || length > 131072) return { available: false, reason: 'command_line_length', ntStatus: status };
    const commandBuffer = Buffer.alloc(length);
    const commandAddress = ptr(commandBuffer);
    status = nt.symbols.NtQueryInformationProcess(processHandle, 60, commandAddress, length, ptr(returned));
    if (status !== 0) return { available: false, reason: stage, ntStatus: status };
    const commandLine = decodeNativeCommandLine(commandBuffer, commandAddress);
    if (commandLine === null) return { available: false, reason: 'command_line_bounds' };
    stage = 'argument_parse';
    const wideCommand = Buffer.from(commandLine + '\0', 'utf16le');
    const count = Buffer.alloc(4);
    argumentMemory = shell.symbols.CommandLineToArgvW(ptr(wideCommand), ptr(count));
    const argumentCount = count.readInt32LE(0);
    if (!argumentMemory || argumentCount < 1 || argumentCount > 4096) return { available: false, reason: stage };
    const size = Number(kernel.symbols.LocalSize(argumentMemory));
    if (!Number.isSafeInteger(size) || size < argumentCount * 8 || size > 1048576) return { available: false, reason: 'argument_bounds' };
    const argumentsBuffer = Buffer.from(toArrayBuffer(argumentMemory, 0, size));
    const args: string[] = [];
    for (let index = 1; index < argumentCount; index++) {
      const start = Number(argumentsBuffer.readBigUInt64LE(index * 8) - BigInt(argumentMemory));
      if (!Number.isSafeInteger(start) || start < argumentCount * 8 || start % 2 !== 0 || start >= size) return { available: false, reason: 'argument_bounds' };
      let end = start;
      while (end + 2 <= size && argumentsBuffer.readUInt16LE(end) !== 0) end += 2;
      if (end + 2 > size) return { available: false, reason: 'argument_bounds' };
      args.push(argumentsBuffer.subarray(start, end).toString('utf16le'));
    }
    stage = 'job_query';
    const limits = Buffer.alloc(144);
    const jobKnown = kernel.symbols.QueryInformationJobObject(0, 9, ptr(limits), limits.length, ptr(returned));
    const jobError = jobKnown ? undefined : kernel.symbols.GetLastError();
    const inJob = Buffer.alloc(4);
    const membershipKnown = kernel.symbols.IsProcessInJob(processHandle, 0, ptr(inJob));
    const dataArgs = args.filter(arg => arg.startsWith('--user-data-dir='));
    return {
      available: true, parentMatched, imageMatched,
      commandLineHash: hash(commandLine), argumentHashes: args.map(hash),
      userDataDirCount: dataArgs.length,
      userDataDirHash: dataArgs.length === 1 ? hash(dataArgs[0].slice(16)) : null,
      pipePresent: args.includes('--remote-debugging-pipe'),
      browserInJob: membershipKnown ? inJob.readInt32LE(0) !== 0 : null,
      observerJobLimitFlags: jobKnown ? limits.readUInt32LE(16) : null,
      observerJobQueryError: jobError,
      knownFolders: knownFolders(),
    };
  } catch {
    return { available: false, reason: stage };
  } finally {
    if (argumentMemory) kernel.symbols.LocalFree(argumentMemory);
    if (processHandle) kernel.symbols.CloseHandle(processHandle);
    shell.close(); nt.close(); kernel.close();
  }
}

if (import.meta.main) {
  let result: object;
  let exitCode = 0;
  try { result = observe(); }
  catch { result = { available: false, reason: 'observer_initialize' }; exitCode = 1; }
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(exitCode));
}
