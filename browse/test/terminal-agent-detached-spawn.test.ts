/**
 * Regression pins for #2637: the terminal-agent must outlive the process that
 * spawned it, and must know which server owns it.
 *
 * Two defects sat behind one symptom. `browse connect` spawns the agent and
 * exits seconds later; on Windows the child went down with the CLI's
 * console/job object because the spawn never asked to be detached, so
 * `terminal-port` was never written and the sidebar 503'd with
 * "terminal-agent not ready" until the 60s watchdog respawned the agent under
 * the (detached) server. Underneath that, both CLI call sites omitted
 * `ownerPid`, which reached the child as the string "undefined" and left the
 * owner watchdog inert — the orphan class the owner-PID tie exists to close.
 *
 * Static tripwires here, process-boundary proof in the behavioral test below.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_DIR = path.join(import.meta.dir, '../src');
const SRC = (f: string) => fs.readFileSync(path.join(SRC_DIR, f), 'utf-8');

/** Same convention as windows-spawn-hide.test.ts: documented history must
 *  not trip a source assertion, and prose must not push a flag out of a
 *  fixed-size match window. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const spawned: any[] = [];
const tempDirs: string[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    try { proc.kill?.('SIGKILL'); } catch {}
  }
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe('terminal-agent spawn lifecycle (#2637)', () => {
  test('spawnTerminalAgent asks for a detached child', () => {
    // Comments stripped first: the flags carry long explanations, and a
    // window sized around prose is a window that breaks on the next edit.
    const src = stripComments(SRC('terminal-agent-control.ts'));
    const idx = src.indexOf('(Bun as any).spawn(');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(src.slice(idx, idx + 500)).toMatch(/detached:\s*true/);
  });

  test('the Node polyfill forwards detached instead of dropping it', () => {
    // dist/bun-polyfill.cjs is the Windows server-side runtime. A flag the
    // shim swallows is a flag the watchdog respawn path silently loses.
    const src = stripComments(SRC('bun-polyfill.cjs'));
    const idx = src.indexOf('spawn(cmd, options = {})');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(src.slice(idx, idx + 500)).toMatch(/detached:\s*options\.detached\s*===\s*true/);
  });

  test('SWEEP: every spawnTerminalAgent call site passes ownerPid', () => {
    // Census, not a fixed list: a new call site that forgets ownerPid fails
    // here rather than shipping an agent whose owner watchdog never arms.
    const offenders: string[] = [];
    for (const file of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'))) {
      const raw = fs.readFileSync(path.join(SRC_DIR, file), 'utf-8');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const re = /spawnTerminalAgent\(\{/g;
      for (const m of code.matchAll(re)) {
        const slice = code.slice(m.index!, m.index! + 500);
        const call = slice.slice(0, slice.indexOf('});') + 3);
        if (!/ownerPid:/.test(call)) {
          offenders.push(`${file}: ${call.split('\n').slice(0, 2).join(' ').trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the agent outlives the process that spawned it', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-term-detach-'));
    tempDirs.push(stateDir);
    const stateFile = path.join(stateDir, 'browse.json');
    fs.writeFileSync(stateFile, JSON.stringify({ token: 'test-token' }));

    // A spawner that starts the agent and exits immediately — the shape of
    // `browse connect`. The owner is THIS test process (a stand-in for the
    // long-lived daemon), not the spawner, so the owner watchdog stays armed
    // and the only thing that could take the agent down is losing its parent.
    const spawnerPath = path.join(stateDir, 'spawner.ts');
    const controlPath = path.join(SRC_DIR, 'terminal-agent-control.ts').split(path.sep).join('/');
    fs.writeFileSync(spawnerPath, [
      `import { spawnTerminalAgent } from ${JSON.stringify(controlPath)};`,
      `const pid = spawnTerminalAgent({`,
      `  stateFile: ${JSON.stringify(stateFile)},`,
      `  serverPort: 0,`,
      `  ownerPid: Number(process.env.OWNER_PID),`,
      `  cwd: ${JSON.stringify(stateDir)},`,
      `});`,
      `console.log(String(pid ?? ''));`,
    ].join('\n'));

    const spawner = Bun.spawn(['bun', 'run', spawnerPath], {
      env: { ...process.env, OWNER_PID: String(process.pid) },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    spawned.push(spawner);
    const out = (await new Response(spawner.stdout).text()).trim();
    await spawner.exited;

    const agentPid = Number(out);
    expect(Number.isFinite(agentPid)).toBe(true);
    expect(agentPid).toBeGreaterThan(0);
    spawned.push({ kill: () => { try { process.kill(agentPid, 'SIGKILL'); } catch {} } });

    // The spawner is gone. The agent must still be here and must have
    // published the port the sidebar's /pty-session gate reads.
    expect(isAlive(spawner.pid!)).toBe(false);
    const portFile = path.join(stateDir, 'terminal-port');
    expect(await waitFor(() => fs.existsSync(portFile))).toBe(true);
    expect(isAlive(agentPid)).toBe(true);

    const port = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);
    expect(Number.isFinite(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
  }, 30_000);
});
