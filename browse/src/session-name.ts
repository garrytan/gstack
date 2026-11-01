/**
 * Which session a CLI call belongs to (#1961), so parallel agents on one
 * daemon each get their own tab. Precedence: an explicit tab (--tab-id,
 * BROWSE_TAB) wins and sends no session; then --session <name>; then
 * BROWSE_SESSION (empty or "off" turns sessions off); then the agent harness
 * the call runs under. The harness is the first ancestor that is not a shell,
 * the same rule as bin/gstack-harness-pid.sh: every tool call an agent makes
 * starts a fresh shell under the same agent process, so its pid names the
 * agent across calls without any exported variable surviving between them.
 * Only known agent harnesses get an automatic session; a human terminal and a
 * harness shared by every session on the machine (capy-server) keep today's
 * shared active tab.
 */
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface ProcInfo { ppid: number; comm: string }
export type ProcLookup = (pid: number) => ProcInfo | null;
export interface SessionChoice { session?: string; auto?: boolean }

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);
const AGENT_HARNESSES = new Set(['claude', 'codex', 'cursor-agent', 'gemini', 'opencode', 'amp', 'droid']);
const SHARED_HARNESSES = new Set(['capy-server']);

/** Strip `--session <name>` from args, the way extractTabId strips --tab-id. */
export function extractSession(args: string[]): { session: string | undefined; args: string[] } {
  const stripped: string[] = [];
  let session: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session') session = args[++i] ?? session;
    else stripped.push(args[i]!);
  }
  return { session, args: stripped };
}

/** The first non-shell ancestor of `pid` (at most 8 hops), or null when the walk fails. */
export function harnessOf(pid: number, lookup: ProcLookup): { pid: number; comm: string } | null {
  let current = pid;
  for (let hops = 0; hops < 8; hops++) {
    const info = lookup(current);
    if (!info) return null;
    if (!SHELLS.has(info.comm)) return { pid: current, comm: info.comm };
    if (info.ppid <= 1) return null;
    current = info.ppid;
  }
  return null;
}

export function autoSessionName(env: NodeJS.ProcessEnv, parentPid: number, lookup: ProcLookup): string | undefined {
  const harness = harnessOf(parentPid, lookup);
  if (!harness || SHARED_HARNESSES.has(harness.comm)) return undefined;
  if (!AGENT_HARNESSES.has(harness.comm) && env.CLAUDECODE !== '1') return undefined;
  return `agent-${harness.pid}`;
}

export function chooseSession(opts: {
  hasTab: boolean; flag: string | undefined; env: NodeJS.ProcessEnv; parentPid: number; lookup: ProcLookup;
}): SessionChoice {
  if (opts.hasTab) return {};
  if (opts.flag !== undefined) return opts.flag === '' || opts.flag === 'off' ? {} : { session: opts.flag };
  const fromEnv = opts.env.BROWSE_SESSION;
  if (fromEnv !== undefined) return fromEnv === '' || fromEnv === 'off' ? {} : { session: fromEnv };
  const auto = autoSessionName(opts.env, opts.parentPid, opts.lookup);
  return auto ? { session: auto, auto: true } : {};
}

function basename(comm: string): string {
  const name = comm.trim().split('/').pop() ?? '';
  return name.startsWith('-') ? name.slice(1) : name;
}

/** Linux reads /proc; macOS takes one `ps` table; anything else has no automatic session. */
export function systemProcLookup(): ProcLookup {
  if (process.platform === 'linux') {
    return (pid) => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const open = stat.indexOf('(');
        const close = stat.lastIndexOf(')');
        const ppid = Number(stat.slice(close + 2).split(' ')[1]);
        return Number.isFinite(ppid) ? { ppid, comm: basename(stat.slice(open + 1, close)) } : null;
      } catch { return null; }
    };
  }
  if (process.platform !== 'darwin') return () => null;
  let table: Map<number, ProcInfo> | null = null;
  return (pid) => {
    if (!table) {
      table = new Map();
      const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 2000, windowsHide: true });
      for (const line of (ps.stdout ?? '').split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: basename(m[3]!) });
      }
    }
    return table.get(pid) ?? null;
  };
}
