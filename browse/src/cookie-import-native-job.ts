import { randomUUID } from 'node:crypto';

const NATIVE_COOKIE_STAGES = [
  'platform', 'ffi_import', 'ffi_open', 'job_create', 'job_limits', 'job_open',
  'process_open', 'job_assign', 'job_assigned', 'job_joined', 'process_close', 'job_query', 'job_terminate', 'job_close',
  'worker_boot', 'supervisor_input', 'runtime_check', 'member_start', 'member_input', 'member_decoded', 'member_exit',
  'node_start', 'node_spawned', 'node_exit', 'node_input', 'node_load', 'browser_launch', 'cookie_read', 'browser_close',
] as const;

export interface NativeCookieDiagnostic {
  stage: typeof NATIVE_COOKIE_STAGES[number];
  win32Error?: number;
  lastStage?: typeof NATIVE_COOKIE_STAGES[number];
  exitCode?: number;
  nodeExitCode?: number;
  signal?: string;
  memberMode?: boolean;
  stderrBytes?: number;
}

export class NativeCookieJobError extends Error {
  readonly diagnostic: NativeCookieDiagnostic;

  constructor(stage: NativeCookieDiagnostic['stage'], win32Error?: number) {
    super(stage === 'platform' ? 'native_supervision_unavailable' : 'native_supervision_failed');
    this.name = 'NativeCookieJobError';
    this.diagnostic = { stage, ...(Number.isInteger(win32Error) && win32Error! >= 0 && win32Error! <= 0xffffffff ? { win32Error } : {}) };
  }
}

export function nativeCookieDiagnostic(error: unknown, fallback: NativeCookieDiagnostic['stage']): NativeCookieDiagnostic {
  return error instanceof NativeCookieJobError ? error.diagnostic : { stage: fallback };
}

export function parseNativeCookieDiagnostic(value: unknown): NativeCookieDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as NativeCookieDiagnostic;
  if (!NATIVE_COOKIE_STAGES.includes(candidate.stage)) return undefined;
  const diagnostic = new NativeCookieJobError(candidate.stage, candidate.win32Error).diagnostic;
  if (NATIVE_COOKIE_STAGES.includes(candidate.lastStage!)) diagnostic.lastStage = candidate.lastStage;
  for (const field of ['exitCode', 'nodeExitCode', 'stderrBytes'] as const) {
    const value = candidate[field];
    if (typeof value === 'number' && Number.isInteger(value) && value >= (field === 'stderrBytes' ? 0 : -0x80000000) && value <= 0xffffffff) diagnostic[field] = value;
  }
  if (['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGSEGV', 'SIGABRT', 'SIGBREAK', 'SIGHUP'].includes(candidate.signal!)) diagnostic.signal = candidate.signal;
  if (typeof candidate.memberMode === 'boolean') diagnostic.memberMode = candidate.memberMode;
  return diagnostic;
}

export interface NativeCookieJob {
  name: string;
  terminate(): void;
  activeProcesses(): number;
  close(): void;
}

export async function createNativeCookieJob(): Promise<NativeCookieJob> {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
    throw new NativeCookieJobError('platform');
  }
  const { api, ptr, closeLibrary } = await openKernel();
  const name = `Local\\gstack-cookie-${randomUUID()}`;
  const wideName = Buffer.from(`${name}\0`, 'utf16le');
  let stage: NativeCookieDiagnostic['stage'] = 'job_create';
  let handle: number | bigint = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      if (handle && !api.CloseHandle(handle)) throw new NativeCookieJobError('job_close', api.GetLastError());
    } finally {
      closeLibrary();
    }
  };
  try {
    handle = api.CreateJobObjectW(null, ptr(wideName));
    const createError = api.GetLastError();
    if (!handle || createError === 183) throw new NativeCookieJobError('job_create', createError);
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16);
    stage = 'job_limits';
    if (!api.SetInformationJobObject(handle, 9, ptr(limits), limits.byteLength)) {
      throw new NativeCookieJobError(stage, api.GetLastError());
    }
    return {
      name,
      terminate() {
        if (closed) throw new NativeCookieJobError('job_terminate');
        if (!api.TerminateJobObject(handle, 1)) throw new NativeCookieJobError('job_terminate', api.GetLastError());
      },
      activeProcesses() {
        const accounting = Buffer.alloc(48);
        if (closed) throw new NativeCookieJobError('job_query');
        if (!api.QueryInformationJobObject(handle, 1, ptr(accounting), accounting.byteLength, null)) throw new NativeCookieJobError('job_query', api.GetLastError());
        return accounting.readUInt32LE(40);
      },
      close,
    };
  } catch (error) {
    try { close(); } catch {}
    throw error instanceof NativeCookieJobError ? error : new NativeCookieJobError(stage);
  }
}

export async function joinNativeCookieJob(name: string, observe?: (stage: NativeCookieDiagnostic['stage']) => void): Promise<void> {
  if (process.platform !== 'win32' || !/^Local\\gstack-cookie-[0-9a-f-]{36}$/.test(name)) {
    throw new NativeCookieJobError('job_open');
  }
  observe?.('ffi_import');
  const { api, ptr, closeLibrary } = await openKernel();
  const wideName = Buffer.from(`${name}\0`, 'utf16le');
  let stage: NativeCookieDiagnostic['stage'] = 'job_open';
  let handle: number | bigint = 0;
  let currentProcess: number | bigint = 0;
  try {
    observe?.(stage);
    handle = api.OpenJobObjectW(1, 0, ptr(wideName));
    if (!handle) throw new NativeCookieJobError(stage, api.GetLastError());
    stage = 'process_open';
    observe?.(stage);
    currentProcess = api.OpenProcess(0x0101, 0, process.pid);
    if (!currentProcess) throw new NativeCookieJobError(stage, api.GetLastError());
    stage = 'job_assign';
    observe?.(stage);
    if (!api.AssignProcessToJobObject(handle, currentProcess)) throw new NativeCookieJobError(stage, api.GetLastError());
    observe?.('job_assigned');
  } catch (error) {
    throw error instanceof NativeCookieJobError ? error : new NativeCookieJobError(stage);
  } finally {
    let closeError: NativeCookieJobError | undefined;
    observe?.('process_close');
    if (currentProcess && !api.CloseHandle(currentProcess)) closeError = new NativeCookieJobError('process_close', api.GetLastError());
    observe?.('job_close');
    if (handle && !api.CloseHandle(handle)) closeError ??= new NativeCookieJobError('job_close', api.GetLastError());
    closeLibrary();
    if (closeError) throw closeError;
  }
}

async function openKernel() {
  let stage: NativeCookieDiagnostic['stage'] = 'ffi_import';
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    stage = 'ffi_open';
    const library = dlopen('kernel32.dll', {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
      OpenJobObjectW: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.u64 },
      SetInformationJobObject: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      QueryInformationJobObject: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
      TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    });
    return { api: library.symbols, ptr, closeLibrary: () => library.close() };
  } catch {
    throw new NativeCookieJobError(stage);
  }
}
