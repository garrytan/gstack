import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildHeadedServerEnv,
  runHeadedSupervisor,
  SUPERVISOR_GUARD_WINDOW_MS,
  type HeadedSupervisorDeps,
} from '../src/cli';

// v1.44 outer supervisor — static-grep invariants.
//
// Pre-v1.44 `$B connect` was fire-and-forget: spawn server detached, CLI
// exits, server runs unsupervised. If the server crashed, the user had to
// re-run `$B connect`. The opt-in supervisor (--supervise or
// BROWSE_SUPERVISE=1) keeps the CLI attached and respawns the server on
// unexpected exit, with the same crash-loop guard shape as the v1.44
// terminal-agent watchdog.
//
// The static tripwires below defend the wiring in main(): opt-in by default,
// signal handlers, env knobs. The behavioral block drives the extracted
// runHeadedSupervisor loop with injected clock, sleep, and process probes —
// the respawn path shipped broken (a block-scoped env) because only source
// text was checked.

const CLI_TS = path.resolve(import.meta.path, '..', '..', 'src', 'cli.ts');

describe('CLI outer supervisor (v1.44+)', () => {
  test('1. supervisor is opt-in via --supervise flag or BROWSE_SUPERVISE env', () => {
    const src = fs.readFileSync(CLI_TS, 'utf-8');
    expect(src).toContain("commandArgs.includes('--supervise')");
    expect(src).toContain("process.env.BROWSE_SUPERVISE === '1'");
    // Default path MUST still exit 0 promptly. The legacy contract is
    // that every caller of `$B connect` (Claude Code Bash tool, scripts,
    // CI) gets a prompt return.
    expect(src).toMatch(/if \(!superviseRequested\) \{\s*process\.exit\(0\);\s*\}/);
  });

  test('2. SIGINT and SIGTERM trigger clean teardown', () => {
    const src = fs.readFileSync(CLI_TS, 'utf-8');
    // Both signals must hit the teardown path or the user's Ctrl-C leaves
    // an orphaned server (worse than no supervisor).
    expect(src).toMatch(/process\.on\('SIGINT'.*teardownAndExit/);
    expect(src).toMatch(/process\.on\('SIGTERM'.*teardownAndExit/);
    // Teardown must signal the supervised server before exiting itself.
    expect(src).toContain("safeKill(state.pid, 'SIGTERM')");
  });

  test('3. crash-loop guard with 5-in-5min rolling window', () => {
    const src = fs.readFileSync(CLI_TS, 'utf-8');
    expect(src).toContain('SUPERVISOR_GUARD_WINDOW_MS = 5 * 60_000');
    expect(src).toContain('SUPERVISOR_GUARD_MAX = 5');
    // Window pruning: a long-lived daemon with sporadic crashes must NOT
    // hit the guard (otherwise we punish the user for the supervisor doing
    // its job).
    expect(src).toMatch(/respawns\.shift\(\)/);
  });

  test('4. exponential backoff schedule, env-overridable', () => {
    const src = fs.readFileSync(CLI_TS, 'utf-8');
    expect(src).toContain('GSTACK_SUPERVISOR_BACKOFF');
    // Default schedule must include short waits at first (rapid recovery
    // from transient crashes) and cap at a sensible long wait.
    expect(src).toContain('1000,2000,4000,8000,30000');
  });

  test('5. tick interval is env-overridable for tests', () => {
    const src = fs.readFileSync(CLI_TS, 'utf-8');
    expect(src).toContain('GSTACK_SUPERVISOR_TICK_MS');
  });

  test('6. respawned server gets a fresh terminal-agent too', () => {
    const src = fs.readFileSync(CLI_TS, 'utf-8');
    // After server respawn, the terminal-agent state is stale (old PID
    // record points to a dead agent that exited with its parent). The
    // supervisor must re-call spawnTerminalAgent or the PTY path stays
    // broken even though the server is back up.
    const block = sliceBetween(src, 'Supervisor mode:', '// ─── Headed Disconnect');
    expect(block).toContain('spawnTerminalAgent({');
  });
});

// A scripted world for runHeadedSupervisor: `alive` decides the PID probe per
// tick, sleep advances the injected clock, and every side effect is recorded.
function harness(opts: {
  alive: (tick: number) => boolean;
  startServer?: (call: number) => Promise<{ pid: number; port: number }>;
  spawnTerminalAgent?: () => void;
  tickMs?: number;
  exitAfterSleeps?: number;
}) {
  let clock = 1_000_000, sleeps = 0, tick = 0, exiting = false, starts = 0;
  const calls = { startEnv: [] as Record<string, string>[], agents: [] as number[], log: [] as string[], warn: [] as string[], error: [] as string[] };
  const deps: HeadedSupervisorDeps = {
    env: buildHeadedServerEnv({ proxyUrl: 'socks5://127.0.0.1:9050', configHash: 'abc123', explicitDirect: false }),
    tickMs: opts.tickMs ?? 30_000,
    backoffMs: [1000, 2000, 4000, 8000, 30000],
    daemonLog: '/state/browse-daemon.log',
    readState: () => ({ pid: 4242 }),
    isProcessAlive: () => opts.alive(tick++),
    startServer: async (env) => {
      calls.startEnv.push(env);
      const call = starts++;
      return opts.startServer ? opts.startServer(call) : { pid: 5000 + call, port: 34567 };
    },
    spawnTerminalAgent: (server) => { calls.agents.push(server.pid); opts.spawnTerminalAgent?.(); },
    sleep: async (ms) => {
      clock += ms; sleeps++;
      if (opts.exitAfterSleeps !== undefined && sleeps >= opts.exitAfterSleeps) exiting = true;
    },
    now: () => clock,
    isExiting: () => exiting,
    log: (line) => calls.log.push(line),
    warn: (line) => calls.warn.push(line),
    error: (line) => calls.error.push(line),
  };
  return { deps, calls, stop: () => { exiting = true; } };
}

describe('runHeadedSupervisor (behavior)', () => {
  test('a dead server is respawned with exactly the initial connect env, and its terminal agent too', async () => {
    const h = harness({ alive: (t) => t !== 0, exitAfterSleeps: 4 });
    expect(await runHeadedSupervisor(h.deps)).toBe('stopped');
    expect(h.calls.startEnv).toHaveLength(1);
    expect(h.calls.startEnv[0]).toEqual({
      BROWSE_HEADED: '1', BROWSE_PORT: '34567', BROWSE_PARENT_PID: '0',
      BROWSE_PROXY_URL: 'socks5://127.0.0.1:9050', BROWSE_PROXY_USER: '', BROWSE_PROXY_PASS: '', BROWSE_CONFIG_HASH: 'abc123',
    });
    expect(h.calls.startEnv[0]).toBe(h.deps.env);
    expect(h.calls.agents).toEqual([5000]);
    expect(h.calls.error).toEqual([]);
    expect(h.calls.log.join('\n')).toContain('server respawned (PID 5000, port 34567)');
  });

  test('a failed respawn is logged with the daemon log path and counted toward the guard', async () => {
    const h = harness({ alive: () => false, startServer: async () => { throw new Error('port 34567 busy'); } });
    expect(await runHeadedSupervisor(h.deps)).toBe('gave_up');
    const failures = h.calls.error.filter(line => line.includes('server respawn failed'));
    expect(failures).toHaveLength(5);
    expect(failures[0]).toBe('[browse] Supervisor: server respawn failed: port 34567 busy. Daemon log: /state/browse-daemon.log');
  });

  test('five crashes inside the window give up with the cause and the relaunch command', async () => {
    const h = harness({ alive: () => false });
    expect(await runHeadedSupervisor(h.deps)).toBe('gave_up');
    expect(h.calls.startEnv).toHaveLength(5);
    expect(h.calls.error.at(-1)).toBe(
      '[browse] Supervisor: 5 server crashes in 300s, giving up. Crash reasons: /state/browse-daemon.log. Relaunch: $B connect --supervise',
    );
  });

  test('crashes spread wider than the rolling window never trip the guard', async () => {
    // One crash per tick with a tick longer than the window: every earlier
    // respawn is pruned before the guard is checked.
    const h = harness({ alive: (t) => t >= 12, tickMs: SUPERVISOR_GUARD_WINDOW_MS + 1, exitAfterSleeps: 30 });
    expect(await runHeadedSupervisor(h.deps)).toBe('stopped');
    expect(h.calls.startEnv).toHaveLength(12);
    expect(h.calls.error).toEqual([]);
  });

  test('a terminal-agent failure after a successful respawn warns and keeps supervising', async () => {
    const h = harness({ alive: (t) => t !== 0, spawnTerminalAgent: () => { throw new Error('no pty'); }, exitAfterSleeps: 4 });
    expect(await runHeadedSupervisor(h.deps)).toBe('stopped');
    expect(h.calls.warn.some(line => line === '[browse] Supervisor: terminal-agent respawn failed: no pty')).toBe(true);
    expect(h.calls.error).toEqual([]);
  });

  test('an exit requested during backoff stops without starting a server', async () => {
    // Sleep 1 is the tick, sleep 2 the backoff; exiting flips during backoff.
    const h = harness({ alive: () => false, exitAfterSleeps: 2 });
    expect(await runHeadedSupervisor(h.deps)).toBe('stopped');
    expect(h.calls.startEnv).toEqual([]);
  });

  test('a live server is left alone', async () => {
    const h = harness({ alive: () => true, exitAfterSleeps: 5 });
    expect(await runHeadedSupervisor(h.deps)).toBe('stopped');
    expect(h.calls.startEnv).toEqual([]);
  });
});

describe('buildHeadedServerEnv', () => {
  test('omits proxy and config hash when this invocation has none', () => {
    expect(buildHeadedServerEnv({ proxyUrl: null, configHash: '', explicitDirect: false })).toEqual({ BROWSE_HEADED: '1', BROWSE_PORT: '34567', BROWSE_PARENT_PID: '0' });
  });
});

function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i === -1) throw new Error(`marker not found: ${start}`);
  const j = source.indexOf(end, i + start.length);
  if (j === -1) throw new Error(`end marker not found: ${end}`);
  return source.slice(i, j);
}
