/** Windows lifetime containment for the dedicated gstack-claude-code process. */

export class WindowsReviewSupervisionError extends Error {
  constructor(message: string) {
    super(`Claude Code Windows process supervision could not initialize: ${message}. No reviewer was started. Update Bun or check the host's process policy, then retry.`);
    this.name = 'WindowsReviewSupervisionError';
  }
}

// This handle is intentionally never closed in JavaScript: closing it would
// terminate this runner too. The OS closes it when the dedicated CLI exits,
// after its JSON has flushed, and kills every remaining descendant with it.
// Keep the native library alive for the same lifetime.
let lifetime: { handle: number | bigint; library: unknown } | undefined;

/**
 * Join an unnamed, non-inheritable job BEFORE spawning the provider. Children
 * inherit membership, not the handle. Unlike taskkill /T, job membership still
 * contains a descendant after its immediate parent has exited.
 *
 * Call only from claudeCodeMain in its dedicated CLI process, never from the
 * reusable runClaudeCode API or a host/test process that owns other work.
 * https://learn.microsoft.com/windows/win32/procthread/job-objects
 */
export async function initializeWindowsReviewJob(): Promise<void> {
  if (process.platform !== 'win32' || lifetime) return;
  let library: Awaited<ReturnType<typeof openKernel>> | undefined;
  let job: number | bigint = 0n;
  let currentProcess: number | bigint = 0n;
  try {
    library = await openKernel();
    const api = library.symbols;
    // NULL security attributes make this handle non-inheritable; NULL name
    // makes the job private to this invocation.
    job = api.CreateJobObjectW(null, null);
    if (!job) throw new Error(`CreateJobObjectW failed (${api.GetLastError()})`);

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on Windows' 64-bit ABI:
    // basic limits (64), IO_COUNTERS (48), then four SIZE_T fields (32).
    // LimitFlags is the DWORD at byte 16 in the basic-limit structure.
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x00002000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    const { ptr } = await import('bun:ffi');
    if (!api.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength)) {
      throw new Error(`SetInformationJobObject failed (${api.GetLastError()})`);
    }
    // AssignProcessToJobObject requires PROCESS_SET_QUOTA | PROCESS_TERMINATE.
    currentProcess = api.OpenProcess(0x0101, 0, process.pid);
    if (!currentProcess) throw new Error(`OpenProcess failed (${api.GetLastError()})`);
    if (!api.AssignProcessToJobObject(job, currentProcess)) {
      throw new Error(`AssignProcessToJobObject failed (${api.GetLastError()})`);
    }
    lifetime = { handle: job, library };
    api.CloseHandle(currentProcess);
  } catch (error) {
    // These failures occur before assignment. Never close a job that already
    // contains this process: preserve its handle until the CLI reports failure.
    if (library && !lifetime) {
      if (currentProcess) library.symbols.CloseHandle(currentProcess);
      if (job) library.symbols.CloseHandle(job);
      library.close();
    }
    throw new WindowsReviewSupervisionError(error instanceof Error ? error.message : String(error));
  }
}

async function openKernel() {
  const { dlopen, FFIType } = await import('bun:ffi');
  // HANDLE is an integer token, not an address. Bun explicitly requires an
  // integer FFI type here; ptr is reserved for the actual buffer parameters.
  return dlopen('kernel32.dll', {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    SetInformationJobObject: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
}
