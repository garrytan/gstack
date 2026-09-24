import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';
import { createNativeCookieJob, joinNativeCookieJob, nativeCookieDiagnostic, parseNativeCookieDiagnostic, type NativeCookieDiagnostic, type NativeCookieJob } from './cookie-import-native-job';
import type { PlaywrightCookie } from './cookie-import-browser';

export interface NativeCookieRequest {
  nodeExecutable: string;
  nodeArchitecture: string;
  playwrightEntry: string;
  executablePath: string;
  userDataDir: string;
  profile: string;
  domains: string[];
  deadline: number;
  qualifiedBunVersions: string[];
}

export type NativeCookieReply =
  | { cookies: PlaywrightCookie[] }
  | { error: 'native_timeout' | 'native_failed' | 'native_cleanup_failed' | 'native_supervision_failed' | 'browser_running' | 'native_profile_unsupported'; diagnostic?: NativeCookieDiagnostic };

export interface NativeCookieMember {
  result: Promise<NativeCookieReply>;
  closed: Promise<void>;
  stop(): void;
}

const MAX_REPLY_BYTES = 8 * 1024 * 1024;
export const NATIVE_PROGRESS_PREFIX = 'GSTACK_NATIVE_PROGRESS ';

function nativeProgress(diagnostic: NativeCookieDiagnostic): void {
  try { writeSync(2, NATIVE_PROGRESS_PREFIX + JSON.stringify(diagnostic) + '\n'); } catch {}
}

export function nativeCookieEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = new Set(['systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'localappdata', 'appdata', 'programfiles', 'programfiles(x86)', 'programdata', 'path', 'pathext']);
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string')) as Record<string, string>;
}

export const NATIVE_COOKIE_NODE_SCRIPT = String.raw`
const fs = require('node:fs');
let stage = 'node_input';
const progress = () => { try { fs.writeSync(2, 'GSTACK_NATIVE_PROGRESS ' + JSON.stringify({ stage }) + '\n'); } catch {} };
progress();
(async () => {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  stage = 'node_load';
  progress();
  const { chromium } = require(request.playwrightEntry);
  let context;
  try {
    const remaining = request.deadline - Date.now();
    if (remaining <= 0) throw new Error('native_timeout');
    stage = 'browser_launch';
    progress();
    context = await chromium.launchPersistentContext(request.userDataDir, {
      executablePath: request.executablePath,
      args: ['--profile-directory=' + request.profile],
      headless: true,
      chromiumSandbox: true,
      timeout: remaining,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      env: process.env,
    });
    stage = 'cookie_read';
    progress();
    const selected = new Set(request.domains.map(domain => domain.toLowerCase().replace(/^\./, '').replace(/\.$/, '')));
    const cookies = (await context.cookies()).filter(cookie => selected.has(cookie.domain.toLowerCase().replace(/^\./, '').replace(/\.$/, '')));
    await new Promise(resolve => process.stdout.write(JSON.stringify({ cookies }) + '\n', resolve));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const exited = message.match(/<process did exit: exitCode=(-?\d+), signal=(?:null|SIG[A-Z]+)>/);
    const exitCode = exited ? Number(exited[1]) : undefined;
    const code = (stage === 'browser_launch' && exitCode === 21) || /ProcessSingleton|profile.*in use|user data directory is already in use|opening in existing browser session/i.test(message)
      ? 'browser_running'
      : /remote debugging requires a non-default data directory/i.test(message)
        ? 'native_profile_unsupported'
        : /Timeout|native_timeout/.test(message) ? 'native_timeout' : 'native_failed';
    await new Promise(resolve => process.stdout.write(JSON.stringify({ error: code, diagnostic: { stage, ...(Number.isInteger(exitCode) ? { exitCode } : {}) } }) + '\n', resolve));
  } finally {
    stage = 'browser_close';
    progress();
    await context?.close().catch(() => {});
  }
})().catch(() => { process.stdout.write(JSON.stringify({ error: 'native_failed', diagnostic: { stage } }) + '\n'); process.exitCode = 1; });
`;

export async function superviseNativeCookieImport(
  request: NativeCookieRequest,
  dependencies: {
    createJob?: () => Promise<NativeCookieJob>;
    startMember?: (request: NativeCookieRequest, jobName: string) => NativeCookieMember;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<NativeCookieReply> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = Math.min(request.deadline, now() + 25_000);
  let job: NativeCookieJob | undefined;
  let member: NativeCookieMember | undefined;
  let reply: NativeCookieReply | undefined;
  let closed = false;
  try {
    job = await (dependencies.createJob ?? createNativeCookieJob)();
    if (now() >= deadline || dependencies.signal?.aborted) return { error: 'native_timeout' };
    member = (dependencies.startMember ?? startMember)({ ...request, deadline }, job.name);
    void member.result.then(value => { reply ??= value; }, () => { reply ??= { error: 'native_failed' }; });
    void member.closed.then(() => { closed = true; }, () => { closed = true; });
    while (!reply && !closed && now() < deadline && !dependencies.signal?.aborted) await sleep(Math.min(20, deadline - now()));
    reply ??= { error: now() >= deadline ? 'native_timeout' : 'native_failed' };
    const cleanupDeadline = now() + 5_000;
    const graceDeadline = now() + ('cookies' in reply ? 2_000 : 0);
    while ((!closed || job.activeProcesses() !== 0) && now() < graceDeadline) await sleep(20);
    if (job.activeProcesses() !== 0) job.terminate();
    while ((!closed || job.activeProcesses() !== 0) && now() < cleanupDeadline) await sleep(20);
    if (!closed || job.activeProcesses() !== 0) return { error: 'native_cleanup_failed' };
    return reply;
  } catch (error) {
    return { error: job ? 'native_cleanup_failed' : 'native_supervision_failed', diagnostic: nativeCookieDiagnostic(error, job ? 'job_query' : 'job_create') };
  } finally {
    let diagnostic: NativeCookieDiagnostic | undefined;
    try { job?.close(); } catch (error) { diagnostic = nativeCookieDiagnostic(error, 'job_close'); }
    try { member?.stop(); } catch (error) { diagnostic ??= nativeCookieDiagnostic(error, 'member_exit'); }
    if (diagnostic) return { error: 'native_cleanup_failed', diagnostic };
  }
}

function startMember(request: NativeCookieRequest, jobName: string, mode = '--member'): NativeCookieMember {
  const child = spawn(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=NUL', import.meta.path, mode], {
    env: nativeCookieEnvironment(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let progressInput = '';
  let lastStage: NativeCookieDiagnostic['stage'] | undefined;
  let memberMode: boolean | undefined;
  let nodeExitCode: number | undefined;
  let stderrBytes = 0;
  child.stderr.on('data', chunk => {
    stderrBytes = Math.min(0xffffffff, stderrBytes + chunk.length);
    progressInput += chunk.toString('utf8');
    for (let end = progressInput.indexOf('\n'); end >= 0; end = progressInput.indexOf('\n')) {
      const line = progressInput.slice(0, end);
      progressInput = progressInput.slice(end + 1);
      if (!line.startsWith(NATIVE_PROGRESS_PREFIX)) continue;
      try {
        const diagnostic = parseNativeCookieDiagnostic(JSON.parse(line.slice(NATIVE_PROGRESS_PREFIX.length)));
        if (!diagnostic) continue;
        lastStage = diagnostic.stage;
        memberMode ??= diagnostic.memberMode;
        if (diagnostic.stage === 'node_exit') nodeExitCode = diagnostic.exitCode;
      } catch {}
    }
    if (progressInput.length > 4096) progressInput = '';
  });
  const result = new Promise<NativeCookieReply>(resolve => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_REPLY_BYTES) {
        resolve({ error: 'native_failed' });
        child.stdout.destroy();
      } else if (output.includes('\n')) {
        try {
          const parsed = JSON.parse(output.slice(0, output.indexOf('\n')));
          const errors = ['native_timeout', 'native_failed', 'native_cleanup_failed', 'native_supervision_failed', 'browser_running', 'native_profile_unsupported'];
          const diagnostic = parseNativeCookieDiagnostic(parsed.diagnostic);
          resolve(Array.isArray(parsed.cookies) ? { cookies: parsed.cookies } : { error: errors.includes(parsed.error) ? parsed.error : 'native_failed', ...(diagnostic ? { diagnostic } : {}) });
        } catch {
          resolve({ error: 'native_failed' });
        }
      }
    });
    child.once('error', () => resolve({ error: 'native_failed', diagnostic: { stage: 'member_start' } }));
    child.once('close', (code, signal) => resolve({ error: 'native_failed', diagnostic: parseNativeCookieDiagnostic({ stage: 'member_exit', exitCode: code, signal, lastStage, memberMode, nodeExitCode, stderrBytes }) }));
    child.stdin.on('error', () => resolve({ error: 'native_failed', diagnostic: { stage: 'member_input' } }));
    child.stdin.end(JSON.stringify({ request, jobName }));
  });
  return { result, closed, stop: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); } };
}

export async function probeNativeCookieMember(): Promise<NativeCookieReply> {
  return superviseNativeCookieImport({
    nodeExecutable: '', nodeArchitecture: process.arch, playwrightEntry: '', executablePath: '',
    userDataDir: '', profile: '', domains: [], deadline: Date.now() + 5_000, qualifiedBunVersions: [Bun.version],
  }, { startMember: (request, jobName) => startMember(request, jobName, '--member-smoke') });
}

let mainStage: NativeCookieDiagnostic['stage'] = 'supervisor_input';

async function main(): Promise<void> {
  if (process.argv[2] === '--member' || process.argv[2] === '--member-smoke') {
    mainStage = 'member_input';
    nativeProgress({ stage: mainStage });
    const serialized = await new Promise<string>((resolve, reject) => {
      let payload = '';
      let bytes = 0;
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) {
          reject(new Error('native_supervision_failed'));
          process.stdin.destroy();
          return;
        }
        payload += chunk;
      });
      process.stdin.once('end', () => resolve(payload));
      process.stdin.once('error', () => reject(new Error('native_supervision_failed')));
      process.stdin.once('close', () => reject(new Error('native_supervision_failed')));
      process.stdin.resume();
    });
    const input = JSON.parse(serialized);
    nativeProgress({ stage: 'member_decoded' });
    await joinNativeCookieJob(input.jobName, stage => nativeProgress({ stage }));
    nativeProgress({ stage: 'job_joined' });
    if (process.argv[2] === '--member-smoke') {
      process.stdout.write(JSON.stringify({ cookies: [] }) + '\n', () => process.exit(0));
      return;
    }
    mainStage = 'node_start';
    nativeProgress({ stage: mainStage });
    const child = spawn(input.request.nodeExecutable, ['--input-type=commonjs', '-e', NATIVE_COOKIE_NODE_SCRIPT], {
      env: nativeCookieEnvironment(process.env),
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    });
    nativeProgress({ stage: 'node_spawned' });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input.request));
    child.once('error', () => process.stdout.write(JSON.stringify({ error: 'native_failed', diagnostic: { stage: 'node_start' } }) + '\n', () => process.exit(1)));
    child.once('close', (code, signal) => {
      nativeProgress(parseNativeCookieDiagnostic({ stage: 'node_exit', exitCode: code, signal })!);
      process.exit(code ?? 1);
    });
    return;
  }
  const cancellation = new AbortController();
  const lines = createInterface({ input: process.stdin });
  lines.once('close', () => cancellation.abort());
  const input = await new Promise<NativeCookieRequest>((resolve, reject) => {
    lines.once('line', line => {
      try { resolve(JSON.parse(line)); } catch { reject(new Error('native_supervision_failed')); }
    });
    lines.once('close', () => reject(new Error('native_supervision_failed')));
  });
  mainStage = 'runtime_check';
  if (input.nodeArchitecture !== process.arch || !Array.isArray(input.qualifiedBunVersions) || !input.qualifiedBunVersions.includes(Bun.version)) {
    throw new Error('native_supervision_failed');
  }
  const result = await superviseNativeCookieImport(input, { signal: cancellation.signal });
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
}

if (import.meta.main) {
  nativeProgress({ stage: 'worker_boot', memberMode: process.argv[2] === '--member' || process.argv[2] === '--member-smoke' });
  void main().catch(error => {
    process.stdout.write(JSON.stringify({ error: 'native_supervision_failed', diagnostic: nativeCookieDiagnostic(error, mainStage) }) + '\n', () => process.exit(1));
  });
}
