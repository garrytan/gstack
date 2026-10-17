/**
 * What the CLI prints when a command's reply never arrives (#1781, #3247).
 *
 * Bun rejects an AbortSignal.timeout() fetch with TimeoutError, so the old
 * AbortError-only check skipped the busy report and printed "The operation
 * timed out." instead. When the daemon's /health names its active tab as not
 * responding, the report names that tab and the commands that leave it
 * without a restart; a dead daemon gets the plain line.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { commandTimeoutReport, isFetchTimeout } from '../src/cli';

let servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const s of servers) s.stop(true); servers = []; });

/** A fake daemon whose /health answers `body`. */
function fakeHealth(body: unknown): number {
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json(body) });
  servers.push(srv);
  if (!srv.port) throw new Error('fake /health: no port');
  return srv.port;
}

/** A pid that no longer runs: a child that has already exited. */
function deadPid(): number {
  return Bun.spawnSync([process.execPath, '-e', '']).pid;
}

describe('isFetchTimeout', () => {
  test('a real fetch whose AbortSignal.timeout fires counts as a timeout', async () => {
    const silent = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) });
    servers.push(silent);
    const err = await fetch(`http://127.0.0.1:${silent.port}/`, { signal: AbortSignal.timeout(50) })
      .then(() => null, (e: unknown) => e);
    expect(isFetchTimeout(err)).toBe(true);
    expect(isFetchTimeout(new TypeError('fetch failed'))).toBe(false);
  });
});

describe('commandTimeoutReport', () => {
  test('names the busy tab and the way out, never a restart', async () => {
    const port = fakeHealth({ status: 'healthy', activeTab: { id: 7, responsive: false } });
    const out = (await commandTimeoutReport({ pid: process.pid, port }, 30_000)).join('\n');
    expect(out).toContain('tab 7');
    expect(out).toContain('closetab 7');
    expect(out).not.toContain('--force-restart');
  });

  test('a live daemon with a responsive or unreported tab gets the busy-not-restarting line', async () => {
    for (const body of [
      { status: 'healthy', activeTab: { id: 1, responsive: true } },
      { status: 'healthy' }, // daemon from before activeTab existed
    ]) {
      const out = (await commandTimeoutReport({ pid: process.pid, port: fakeHealth(body) }, 30_000)).join('\n');
      expect(out).toContain('still alive');
      expect(out).not.toContain('closetab');
    }
  });

  test('a dead daemon gets only the timeout line', async () => {
    const port = fakeHealth({ status: 'healthy', activeTab: { id: 7, responsive: false } });
    const out = await commandTimeoutReport({ pid: deadPid(), port }, 30_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('timed out after 30s');
  });
});
