/** Restricted, supervised Claude Code invocation for outside reviews. */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveClaudeCommand, type ClaudeCommand } from './claude-bin';
import { initializeWindowsReviewJob, WindowsReviewSupervisionError } from './claude-code-windows-job';

export const CLAUDE_CODE_OUTPUT_LIMIT = 32 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 500;

export interface ClaudeCodeOptions {
  cwd: string;
  access: 'none' | 'read-only';
  timeoutMs: number;
  prompt: string;
  resume?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeCodeResult {
  status: 'completed' | 'unavailable' | 'error';
  provider: 'claude-code';
  result: string;
  error?: { code: string; message: string };
  session_id?: string;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  model?: string;
  exit_code?: number | null;
  stderr?: string;
}

function failure(code: string, message: string, unavailable = false): ClaudeCodeResult {
  return { status: unavailable ? 'unavailable' : 'error', provider: 'claude-code', result: '', error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keep argument construction separate so wrappers never interpolate a prompt. */
export function claudeCodeArgs(options: Pick<ClaudeCodeOptions, 'access' | 'resume'>, command: ClaudeCommand): string[] {
  const args = [
    ...command.argsPrefix, '-p', '--output-format', 'json',
    '--disable-slash-commands',
    '--tools', options.access === 'none' ? '' : 'Read,Grep,Glob',
    '--disallowedTools', 'mcp__*',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--settings', '{"disableAllHooks":true}',
    '--permission-mode', 'default',
  ];
  if (options.access === 'read-only') args.push('--allowedTools', 'Read,Grep,Glob');
  if (options.resume) args.push('--resume', options.resume);
  return args;
}

/** Kill only the process tree owned by this invocation, never other sessions. */
function killTree(child: ChildProcess): void {
  if (typeof child.pid !== 'number') return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { killer.kill(); child.kill(); }, DRAIN_TIMEOUT_MS);
    timer.unref();
    killer.once('error', () => { clearTimeout(timer); child.kill(); });
    killer.once('close', () => { clearTimeout(timer); child.kill(); });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try { child.kill('SIGKILL'); } catch { /* Already reaped. */ }
    }
  }
}

/** Parse only a completed invocation; a valid JSON error must never pass a gate. */
export function parseClaudeCodeResult(stdout: string, stderr: string, exitCode: number | null): ClaudeCodeResult {
  const diagnostic = stderr.trim().slice(0, 16 * 1024);
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { /* Classified below, after CLI failure. */ }
  const obj = isObject(raw) ? raw : undefined;
  const response = typeof obj?.result === 'string' ? obj.result : typeof obj?.response === 'string' ? obj.response : '';
  const actualFailure = exitCode !== 0 || !obj || Boolean(obj.is_error) || !response.trim();
  let result: ClaudeCodeResult;
  if (actualFailure && /\b(?:authentication(?:[_ ](?:failed|error))?|unauthorized|not authenticated|invalid (?:x-)?api[- ]key|login required|please (?:run .*login|log in)|not logged in)\b/i.test(`${diagnostic}\n${response}\n${stdout.slice(0, 4096)}`)) {
    result = failure('authentication', 'Claude Code authentication failed. Run claude interactively in this execution context to authenticate.', true);
  } else if (exitCode !== 0) {
    result = failure('exit', `Claude Code exited with ${exitCode === null ? 'a signal' : `code ${exitCode}`}.${response ? ` ${response.slice(0, 4096)}` : ''}`);
  } else if (raw === undefined) {
    result = failure('invalid-json', 'Claude Code returned invalid JSON. Check the CLI installation and diagnostic output.');
  } else if (!obj) {
    result = failure('invalid-response', 'Claude Code returned JSON that is not an object.');
  } else if (obj.is_error || (typeof obj.subtype === 'string' && obj.subtype.startsWith('error'))) {
    result = failure('provider-error', `Claude Code reported an error.${response ? ` ${response.slice(0, 4096)}` : ''}`);
  } else if (!response.trim()) {
    result = failure('empty-response', 'Claude Code returned no response text.');
  } else {
    result = { status: 'completed', provider: 'claude-code', result: response };
  }
  if (obj) {
    if (typeof obj.session_id === 'string' && obj.session_id) result.session_id = obj.session_id;
    if (isObject(obj.usage)) result.usage = obj.usage;
    if (isObject(obj.modelUsage)) result.modelUsage = obj.modelUsage;
    // Do not choose one model from modelUsage: fallback/multi-model sessions
    // must retain all their attribution, and absent identity stays unknown.
    if (typeof obj.model === 'string' && obj.model) result.model = obj.model;
  }
  result.exit_code = exitCode;
  if (diagnostic) result.stderr = diagnostic;
  return result;
}

/** Prompt stdin, direct argv, bounded output and process-group supervision. */
export async function runClaudeCode(options: ClaudeCodeOptions): Promise<ClaudeCodeResult> {
  if (!options.cwd || !['none', 'read-only'].includes(options.access) ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647 ||
      !options.prompt.trim() || (options.resume !== undefined && !options.resume.trim())) {
    return failure('arguments', 'Provide --cwd, --access none|read-only, a positive --timeout-ms, and a nonempty prompt on stdin.');
  }
  const env = options.env ?? process.env;
  const command = resolveClaudeCommand(env);
  if (!command) return failure('not-found', 'Claude Code CLI not found. Install Claude Code or set GSTACK_CLAUDE_BIN, then retry.', true);

  let child: ChildProcess;
  try {
    child = spawn(command.command, claudeCodeArgs(options, command), {
      cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true,
    });
  } catch (error) {
    return failure('spawn', `Claude Code could not start: ${(error as Error).message}`, true);
  }

  return await new Promise<ClaudeCodeResult>((resolve) => {
    let settled = false;
    let stopped: ClaudeCodeResult | undefined;
    let exitCode: number | null = null;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(drainTimer);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      process.off('exit', onParentExit);
      killTree(child);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      const err = Buffer.concat(stderr).toString('utf8');
      if (stopped) {
        stopped.exit_code = exitCode;
        if (err.trim()) stopped.stderr = err.trim().slice(0, 16 * 1024);
        resolve(stopped);
      } else {
        resolve(parseClaudeCodeResult(Buffer.concat(stdout).toString('utf8'), err, exitCode));
      }
    };
    const boundDrain = () => {
      drainTimer ??= setTimeout(() => {
        stopped ??= failure('output-drain', 'Claude Code output pipes did not close after execution. Outside coverage is unavailable.', true);
        finish();
      }, DRAIN_TIMEOUT_MS);
    };
    const stop = (result: ClaudeCodeResult) => {
      stopped ??= result;
      killTree(child);
      boundDrain();
    };
    const collect = (chunks: Buffer[], chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = CLAUDE_CODE_OUTPUT_LIMIT - bytes;
      bytes += data.byteLength;
      if (remaining > 0) chunks.push(data.subarray(0, remaining));
      if (bytes > CLAUDE_CODE_OUTPUT_LIMIT) stop(failure('output-limit', 'Claude Code output exceeded the 32 MiB limit.'));
    };
    const onInterrupt = () => stop(failure('interrupted', 'Claude Code outside review was interrupted (SIGINT).', true));
    const onTerminate = () => stop(failure('interrupted', 'Claude Code outside review was interrupted (SIGTERM).', true));
    const onParentExit = () => killTree(child);
    const timeoutTimer = setTimeout(() => stop(failure('timeout', `Claude Code timed out after ${options.timeoutMs}ms.`, true)), options.timeoutMs);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    process.on('exit', onParentExit);
    child.stdout?.on('data', (chunk) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', (error) => {
      stopped = failure('spawn', `Claude Code could not start: ${error.message}`, true);
      finish();
    });
    child.once('exit', (code) => {
      exitCode = code;
      // Allow already-written output to drain naturally. A descendant holding
      // the pipes past this bound is unavailable coverage, even if killing it
      // would make an otherwise valid response look like a clean completion.
      boundDrain();
    });
    child.once('close', (code) => { exitCode = code; finish(); });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      // A rejected/auth-failed CLI may exit before reading its whole prompt;
      // retain that actual provider error instead of replacing it with EPIPE.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        stop(failure('stdin', `Claude Code could not read its prompt: ${error.message}`, true));
      }
    });
    child.stdin?.end(options.prompt);
  });
}

export async function claudeCodeMain(argv: string[]): Promise<number> {
  let result: ClaudeCodeResult;
  try {
    const values = new Map<string, string>();
    for (let i = 0; i < argv.length; i += 2) {
      if (!['--cwd', '--access', '--timeout-ms', '--resume'].includes(argv[i]) || values.has(argv[i]) || argv[i + 1] === undefined) {
        throw new Error('Usage: gstack-claude-code --cwd <repo> --access none|read-only --timeout-ms <n> [--resume <session-id>] (prompt on stdin)');
      }
      values.set(argv[i], argv[i + 1]);
    }
    const cwd = values.get('--cwd') ?? '';
    const access = values.get('--access') as ClaudeCodeOptions['access'];
    const timeoutMs = Number(values.get('--timeout-ms'));
    if (!cwd || !['none', 'read-only'].includes(access) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new Error('Provide --cwd, --access none|read-only, and a positive --timeout-ms.');
    }
    // This entry runs in a dedicated process. Its Windows job owns the CLI and
    // descendants even after the immediate provider process exits; the final
    // process.exit happens only after the result below has flushed to stdout.
    await initializeWindowsReviewJob();
    result = await runClaudeCode({ cwd, access, timeoutMs, resume: values.get('--resume'), prompt: await Bun.stdin.text() });
  } catch (error) {
    result = error instanceof WindowsReviewSupervisionError
      ? failure('supervision', error.message, true)
      : failure('arguments', (error as Error).message);
  }
  // The CLI shim exits immediately after this promise. Wait for backpressure:
  // otherwise a valid multi-megabyte review is truncated in a pipe at exit.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, (error) => error ? reject(error) : resolve());
  });
  return result.status === 'completed' ? 0 : 1;
}
