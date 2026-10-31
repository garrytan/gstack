import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isProcessAlive } from '../../browse/src/error-handling';
import { readPidCmdline, readPidStartTime } from '../../browse/src/xvfb';
import { isAgentRecordGone, isOurAgent, readAgentRecord } from '../../browse/src/terminal-agent-control';

export async function stopQaOnlyBrowser(directory: string, timeoutMs: number): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 100) throw new Error('QA-only browser cleanup: no settlement budget remains; retaining fixture');
  // An absolute deadline keeps worker startup inside its own budget, so it reports its reason before the kill.
  const worker = Bun.spawn([process.execPath, import.meta.path, directory, String(Date.now() + timeoutMs - 100)], {
    stdout: 'ignore', stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, timeoutMs);
  const stderr = new Response(worker.stderr).text();
  try {
    const code = await worker.exited;
    const error = await stderr;
    if (timedOut) throw new Error('QA-only browser cleanup: owned worker settlement deadline exceeded; retaining fixture');
    if (code !== 0) throw new Error(error.trim() || `QA-only browser cleanup: worker exited ${code}; retaining fixture`);
  } finally { clearTimeout(timer); }
}

async function settleOwnedBrowser(directory: string, deadlineEpochMs: number): Promise<void> {
  const started = performance.now();
  const timeoutMs = deadlineEpochMs - Date.now();
  const deadline = started + timeoutMs;
  let pending = ['identity verification'];
  const fail = (message: string): never => { throw new Error(`QA-only browser cleanup: ${message}`); };
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now());
    if (ms <= 0) fail(`owned process settlement deadline exceeded (${pending.join(', ')}); retaining fixture`);
    return ms;
  };
  if (fs.lstatSync(directory).isSymbolicLink()) fail('fixture directory is a link');
  const root = fs.realpathSync(directory);
  const stateDir = path.join(root, '.gstack');
  if (!fs.existsSync(stateDir)) return;
  if (fs.lstatSync(stateDir).isSymbolicLink()) fail('state directory is a link');
  const stateFile = path.join(stateDir, 'browse.json');
  const agentFile = path.join(stateDir, 'terminal-agent-pid');
  for (const file of [stateFile, agentFile]) {
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) fail('state record is not a regular file');
  }
  if (!fs.existsSync(stateFile)) {
    if (fs.existsSync(agentFile)) fail('terminal record has no daemon state');
    return;
  }
  const raw = fs.readFileSync(stateFile, 'utf8');
  const state = JSON.parse(raw);
  if (!Number.isSafeInteger(state.pid) || state.pid <= 1
    || typeof state.instanceId !== 'string' || !state.instanceId) fail('invalid daemon identity');
  const agentRaw = fs.existsSync(agentFile) ? fs.readFileSync(agentFile, 'utf8') : undefined;
  const agent = readAgentRecord(stateDir);
  if (!agentRaw || !agent) fail('terminal identity is unavailable');
  if (!isProcessAlive(state.pid)) fail('daemon exited before its owned processes could be identified');
  const daemonStart = readPidStartTime(state.pid);
  const command = readPidCmdline(state.pid);
  if (!daemonStart || !(typeof state.serverPath === 'string' && command.includes(state.serverPath)
    || command.includes('--server') && /browse/.test(command))) fail('daemon identity is unavailable');
  let cwd: string;
  if (process.platform === 'linux') cwd = fs.realpathSync(`/proc/${state.pid}/cwd`);
  else {
    const result = spawnSync('lsof', ['-a', '-p', String(state.pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8', timeout: Math.min(1000, remaining()),
    });
    if (result.error || result.status !== 0) fail('daemon working directory is unavailable');
    cwd = result.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) ?? '';
  }
  if (cwd !== root) fail('daemon belongs to another fixture');
  if (agent && (agent.ownerPid !== state.pid || agent.ownerStartTime !== daemonStart
    || !isAgentRecordGone(agent) && !isOurAgent(agent, state.pid))) fail('terminal ownership is unconfirmed');
  const processes = spawnSync('ps', ['-eo', 'pid=,ppid='], {
    encoding: 'utf8', timeout: Math.min(1000, remaining()),
  });
  if (processes.error || processes.status !== 0) fail('owned child identities are unavailable');
  const rows = processes.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const descendants = new Set<number>([state.pid]);
  for (let previous = 0; previous !== descendants.size;) {
    previous = descendants.size;
    for (const [pid, parent] of rows) if (descendants.has(parent)) descendants.add(pid);
  }
  const chromium = [...descendants].filter(pid => pid !== state.pid && /chrom|headless_shell/i.test(readPidCmdline(pid)))
    .map(pid => ({ pid, start: readPidStartTime(pid) }));
  if (!chromium.length || chromium.some(child => !child.start)) fail('Chromium identity is unavailable');
  if (state.chromiumPid !== undefined && !chromium.some(child => child.pid === state.chromiumPid
    && child.start === state.chromiumStartTime)) fail('Chromium ownership is unconfirmed');
  const current = (file: string) => {
    try { return fs.readFileSync(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  const unchanged = () => {
    const state = current(stateFile);
    if (state !== undefined && state !== raw) fail('daemon state was replaced');
    const terminal = current(agentFile);
    if (terminal !== undefined && terminal !== agentRaw) fail('terminal state was replaced');
  };
  unchanged();
  if (readPidStartTime(state.pid) !== daemonStart || readPidCmdline(state.pid) !== command) fail('daemon identity changed before stop');
  unchanged();
  remaining();
  try { process.kill(state.pid, 'SIGINT'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  const settled = (pid: number, start: string) => {
    if (!isProcessAlive(pid)) return true;
    const actual = readPidStartTime(pid);
    if (actual && actual !== start) return true;
    if (process.platform === 'linux') {
      try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').match(/^\d+ \(.*\) ([A-Z])/u)?.[1] === 'Z'; }
      catch { return !isProcessAlive(pid); }
    }
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8', timeout: Math.min(1000, remaining()),
    });
    return result.status === 0 && result.stdout.trim().startsWith('Z');
  };
  for (;;) {
    unchanged();
    remaining();
    pending = [
      ...(!settled(state.pid, daemonStart) ? [`daemon ${state.pid}`] : []),
      ...chromium.filter(child => !settled(child.pid, child.start)).map(child => `Chromium ${child.pid}`),
      ...(agent && !isAgentRecordGone(agent) ? [`terminal ${agent.pid}`] : []),
    ];
    if (!pending.length) {
      unchanged();
      remaining();
      return;
    }
    if (pending.length === 1 && pending[0] === `daemon ${state.pid}`
      && performance.now() - started >= Math.min(1000, timeoutMs / 2)) {
      if (readPidStartTime(state.pid) !== daemonStart || readPidCmdline(state.pid) !== command) fail('daemon identity changed before final termination');
      unchanged();
      try { process.kill(state.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await Bun.sleep(Math.min(25, remaining()));
  }
}

if (import.meta.main) {
  try { await settleOwnedBrowser(process.argv[2], Number(process.argv[3])); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
