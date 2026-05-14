import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * Guard the core refactor invariant: importing browse/src/server.ts must NOT
 * auto-start. Before this PR, the module called `start().catch(...)` at module
 * load time, which made the file impossible for embedders (gbrowser phoenix
 * overlay) to import without spawning a daemon. The fix wraps that kickoff in
 * `if (import.meta.main)` so the side effects only run when the module is the
 * process entry point.
 *
 * Approach: spawn a fresh Bun subprocess that imports the module and emits a
 * structured snapshot (initial vs post-import process state). Parent asserts
 * that no listeners were bound, no Bun.serve started, and no SIGINT handlers
 * were registered. The subprocess uses HOME=tmp + GSTACK_HOME=tmp so any
 * accidental state-dir write lands in a place we can verify is empty.
 */
describe('server.ts module import has no auto-start side effects', () => {
  test('importing server.ts does not bind Bun.serve, register signal handlers, or write state', async () => {
    const tmpHome = path.join(os.tmpdir(), `browse-no-sfx-${Date.now()}-${process.pid}`);
    fs.mkdirSync(tmpHome, { recursive: true });
    const tmpGstack = path.join(tmpHome, '.gstack');

    const childScript = `
const sigintBefore = process.listenerCount('SIGINT');
const sigtermBefore = process.listenerCount('SIGTERM');
const uncaughtBefore = process.listenerCount('uncaughtException');

// Snapshot any keys that look like our state path.
const fs = require('fs');
const path = require('path');

await import(${JSON.stringify(path.resolve(import.meta.dir, '../src/server.ts'))});

// After import, sleep a tick so any setTimeout(0)-style init can run.
await new Promise(r => setTimeout(r, 50));

const sigintAfter = process.listenerCount('SIGINT');
const sigtermAfter = process.listenerCount('SIGTERM');
const uncaughtAfter = process.listenerCount('uncaughtException');

// Check that the gstack home directory wasn't populated as a side effect.
let gstackPopulated = false;
try {
  const entries = fs.readdirSync(${JSON.stringify(tmpGstack)});
  gstackPopulated = entries.length > 0;
} catch {
  // Doesn't exist — that's the win we want.
}

console.log(JSON.stringify({
  sigintBefore, sigintAfter,
  sigtermBefore, sigtermAfter,
  uncaughtBefore, uncaughtAfter,
  gstackPopulated,
}));
// Force exit so any background intervals don't keep this child alive
// (the test framework would see a hang otherwise — which itself is a
// signal that side effects DID run).
process.exit(0);
`;

    const proc = Bun.spawn(['bun', '-e', childScript], {
      env: {
        ...process.env,
        HOME: tmpHome,
        GSTACK_HOME: tmpGstack,
        // Empty so the AUTH_TOKEN env path doesn't deterministically set a token.
        AUTH_TOKEN: '',
        // Force a stub state file so resolveConfig() at module load (if it
        // happens) won't crawl the host's real .gstack/.
        BROWSE_STATE_FILE: path.join(tmpGstack, 'browse.json'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    // The last JSON line in stdout is our snapshot.
    const jsonLine = stdout.trim().split('\n').filter(l => l.startsWith('{')).pop();
    expect(jsonLine, `child stderr: ${stderr}`).toBeDefined();

    const snapshot = JSON.parse(jsonLine!);

    // No new signal handlers registered (gated on import.meta.main, which
    // is false in the subprocess because `bun -e` is the entry point).
    expect(snapshot.sigintAfter).toBe(snapshot.sigintBefore);
    expect(snapshot.sigtermAfter).toBe(snapshot.sigtermBefore);
    expect(snapshot.uncaughtAfter).toBe(snapshot.uncaughtBefore);

    // gstack home should remain empty — initRegistry/initAuditLog/etc. side
    // effects from module load are acceptable (they happen at module level),
    // but only insofar as they don't bind listeners or write project state.
    // The presence/absence test here proves we didn't bind Bun.serve (which
    // would also try to write the state file).
    expect(snapshot.gstackPopulated).toBe(false);

    // Cleanup
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }, 30_000);
});
