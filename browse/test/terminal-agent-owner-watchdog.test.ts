import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const AGENT_SCRIPT = path.join(import.meta.dir, '../src/terminal-agent.ts');
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

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
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

describe('terminal-agent owner lifecycle', () => {
  test('exits after its owning browse server process exits', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-term-owner-'));
    tempDirs.push(stateDir);
    const stateFile = path.join(stateDir, 'browse.json');
    fs.writeFileSync(stateFile, JSON.stringify({ token: 'test-token' }));

    // process.execPath (the running bun) instead of `sleep`: coreutils are
    // not guaranteed on a bare windows-latest runner, and this test is on the
    // Windows CI curated list — the owner-orphan leak it pins is a Windows bug.
    // The owner's lifetime is tied to this test process instead of a fixed
    // 30s sleep: it blocks until its stdin (a pipe we hold open) hits EOF, so
    // it is guaranteed alive until the SIGTERM below no matter how slow the
    // runner is, and it reaps itself if the test process dies without running
    // afterEach. Node-compatible stdin APIs, not Bun.stdin — Windows-portable.
    const owner = Bun.spawn(
      [process.execPath, '-e',
        "process.stdin.resume(); const bye = () => process.exit(0); "
        + "process.stdin.on('end', bye); process.stdin.on('error', bye); process.stdin.on('close', bye);"],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    spawned.push(owner);
    const agent = Bun.spawn(['bun', 'run', AGENT_SCRIPT], {
      env: {
        ...process.env,
        BROWSE_STATE_FILE: stateFile,
        BROWSE_SERVER_PORT: '0',
        BROWSE_OWNER_PID: String(owner.pid),
        GSTACK_TERMINAL_OWNER_WATCHDOG_MS: '25',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    spawned.push(agent);

    expect(await waitFor(() => fs.existsSync(path.join(stateDir, 'terminal-agent-pid')))).toBe(true);
    expect(isAlive(agent.pid)).toBe(true);

    owner.kill('SIGTERM');
    await owner.exited;

    expect(await waitFor(() => !isAlive(agent.pid))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'terminal-agent-pid'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'terminal-port'))).toBe(false);
  });
});
