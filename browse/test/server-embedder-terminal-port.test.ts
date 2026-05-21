import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  buildFetchHandler,
  __resetShuttingDown,
  type ServerConfig,
} from '../src/server';
import { __resetRegistry } from '../src/token-registry';
import { BrowserManager } from '../src/browser-manager';
import { resolveConfig } from '../src/config';

// Tests for the v1.41+ ownsTerminalAgent flag.
//
// Embedders (gbrowser phoenix overlay) that run their own PTY server and write
// terminal-port / terminal-internal-token themselves were getting those files
// clobbered by gstack's shutdown(). The flag (default true) gates three side
// effects: pkill -f terminal-agent\.ts, unlink terminal-port, unlink
// terminal-internal-token. False = embedder owns them, gstack stays hands-off.
//
// CRITICAL: each test stubs BOTH process.exit (so shutdown's exit doesn't kill
// the test runner) AND child_process.spawnSync (so pkill doesn't run real
// `pkill -f terminal-agent\.ts` on the developer's machine — would kill any
// sibling gstack sessions).

const SENTINEL_PORT = 'sentinel-port-65432';
const SENTINEL_TOKEN = 'sentinel-token-abcdef1234567890';

// Per-test temp state dir. shutdown() now reads cfg.config (not module-level
// config), so each test points the factory at its own throwaway dir — no risk
// of clobbering a real gstack daemon's terminal-port / terminal-internal-token.
let tmpStateDir: string;
let tmpConfig: ReturnType<typeof resolveConfig>;
let PORT_FILE: string;
let TOKEN_FILE: string;

function makeMinimalConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const token = 'embedder-test-' + crypto.randomBytes(16).toString('hex');
  return {
    authToken: token,
    browsePort: 34568,
    idleTimeoutMs: 1_800_000,
    config: tmpConfig,
    browserManager: new BrowserManager(),
    startTime: Date.now(),
    ...overrides,
  };
}

function writeSentinels(): void {
  fs.mkdirSync(tmpStateDir, { recursive: true });
  fs.writeFileSync(PORT_FILE, SENTINEL_PORT);
  fs.writeFileSync(TOKEN_FILE, SENTINEL_TOKEN);
}

function readIfExists(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

/**
 * Stubs process.exit + child_process.spawnSync, runs the callback, and
 * restores both regardless of throw. Returns the captured spawnSync argv
 * list so callers can assert pkill was or wasn't invoked. The callback
 * is expected to swallow the __exit:N throw from shutdown().
 */
async function withStubs(
  cb: (spawnSyncCalls: any[][]) => Promise<void>
): Promise<any[][]> {
  const origExit = process.exit;
  const childProcess = require('child_process');
  const origSpawnSync = childProcess.spawnSync;
  const spawnSyncCalls: any[][] = [];
  (process as any).exit = ((code: number) => {
    throw new Error(`__exit:${code}`);
  }) as any;
  childProcess.spawnSync = ((...args: any[]) => {
    spawnSyncCalls.push(args);
    return { status: 0, stdout: '', stderr: '', signal: null, pid: 0, output: [] };
  }) as any;
  try {
    await cb(spawnSyncCalls);
  } finally {
    (process as any).exit = origExit;
    childProcess.spawnSync = origSpawnSync;
  }
  return spawnSyncCalls;
}

async function runShutdown(handle: { shutdown: (code?: number) => Promise<void> }): Promise<void> {
  try {
    await handle.shutdown(0);
  } catch (err: any) {
    if (typeof err?.message !== 'string' || !err.message.startsWith('__exit:')) throw err;
  }
}

function pkillCalls(calls: any[][]): any[][] {
  return calls.filter((call) => call[0] === 'pkill');
}

describe('buildFetchHandler ownsTerminalAgent gate', () => {
  beforeEach(() => {
    __resetRegistry();
    __resetShuttingDown();
    tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-embedder-'));
    tmpConfig = resolveConfig({ BROWSE_STATE_FILE: path.join(tmpStateDir, 'browse.json') });
    PORT_FILE = path.join(tmpStateDir, 'terminal-port');
    TOKEN_FILE = path.join(tmpStateDir, 'terminal-internal-token');
  });

  afterEach(() => {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  });

  test('1. ownsTerminalAgent:false preserves both files and skips pkill', async () => {
    writeSentinels();
    const handle = buildFetchHandler(makeMinimalConfig({ ownsTerminalAgent: false }));
    const calls = await withStubs(async () => {
      await runShutdown(handle);
    });
    expect(readIfExists(PORT_FILE)).toBe(SENTINEL_PORT);
    expect(readIfExists(TOKEN_FILE)).toBe(SENTINEL_TOKEN);
    expect(pkillCalls(calls).length).toBe(0);
  });

  test('2. ownsTerminalAgent:true (explicit) deletes both files and invokes pkill exactly once', async () => {
    writeSentinels();
    const handle = buildFetchHandler(makeMinimalConfig({ ownsTerminalAgent: true }));
    const calls = await withStubs(async () => {
      await runShutdown(handle);
    });
    expect(readIfExists(PORT_FILE)).toBeNull();
    expect(readIfExists(TOKEN_FILE)).toBeNull();
    const pkills = pkillCalls(calls);
    expect(pkills.length).toBe(1);
    // argv[1] is the args array passed to spawnSync.
    expect(pkills[0][1]).toEqual(['-f', 'terminal-agent\\.ts']);
  });

  test('3. ownsTerminalAgent unset defaults to true (deletes + pkill)', async () => {
    writeSentinels();
    // Note: no ownsTerminalAgent in the overrides — uses the `?? true` default.
    const handle = buildFetchHandler(makeMinimalConfig());
    const calls = await withStubs(async () => {
      await runShutdown(handle);
    });
    expect(readIfExists(PORT_FILE)).toBeNull();
    expect(readIfExists(TOKEN_FILE)).toBeNull();
    expect(pkillCalls(calls).length).toBe(1);
  });

  test('4. shutdown targets cfg.config stateDir, not a sibling session', async () => {
    // Regression guard for the composition gap: shutdown() must clean the
    // discovery files under the caller-passed cfg.config.stateDir, never a
    // different daemon's state dir resolved from module-level config.
    const siblingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sibling-'));
    const siblingPort = path.join(siblingDir, 'terminal-port');
    const siblingToken = path.join(siblingDir, 'terminal-internal-token');
    fs.writeFileSync(siblingPort, SENTINEL_PORT);
    fs.writeFileSync(siblingToken, SENTINEL_TOKEN);
    writeSentinels(); // sentinels in tmpStateDir (the cfg.config dir)
    try {
      const handle = buildFetchHandler(makeMinimalConfig({ ownsTerminalAgent: true }));
      await withStubs(async () => {
        await runShutdown(handle);
      });
      // cfg.config dir cleaned...
      expect(readIfExists(PORT_FILE)).toBeNull();
      expect(readIfExists(TOKEN_FILE)).toBeNull();
      // ...sibling session left untouched.
      expect(readIfExists(siblingPort)).toBe(SENTINEL_PORT);
      expect(readIfExists(siblingToken)).toBe(SENTINEL_TOKEN);
    } finally {
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });

  test('5. CLI start() call site passes ownsTerminalAgent: true literally (static grep)', () => {
    // Resolves browse/src/server.ts relative to this test file so the test
    // works regardless of cwd. import.meta.url is the test file's URL.
    const serverTsPath = path.resolve(
      new URL(import.meta.url).pathname,
      '..',
      '..',
      'src',
      'server.ts',
    );
    const source = fs.readFileSync(serverTsPath, 'utf-8');
    // Match the call site inside start()'s buildFetchHandler({...}) literal.
    // The pattern looks for the trailing comma and trailing context so the
    // match cannot be satisfied by the JSDoc reference earlier in the file.
    expect(source).toMatch(/ownsTerminalAgent:\s*true,\s*\/\/\s*CLI spawns terminal-agent\.ts/);
  });
});
