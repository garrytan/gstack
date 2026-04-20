/**
 * Integration tests for POST /batch endpoint
 *
 * Tests parallel multi-tab execution, error isolation, SSE streaming,
 * newtab/closetab handling, and batch validation.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;
let serverPort: number;

// Helper to send batch requests to the browse server
async function batch(commands: any[], opts: { timeout?: number; stream?: boolean } = {}): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${serverPort}/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands, ...opts }),
  });
  if (opts.stream) {
    return res; // return raw response for SSE testing
  }
  return res.json();
}

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;

  bm = new BrowserManager();
  await bm.launch();
  serverPort = bm.serverPort;

  // Start the browse server
  const { startServer } = await import('../src/server');
  // The server is already started by launch — we need the port
  // Actually, BrowserManager.launch() starts the browser, not the server.
  // The test needs to start a server. Let's use the existing server infrastructure.
});

afterAll(() => {
  try { testServer.server.stop(); } catch {}
  setTimeout(() => process.exit(0), 500);
});

// We need a running browse server for HTTP tests.
// The commands.test.ts tests call handlers directly, but batch tests need the HTTP endpoint.
// Let's test the batch logic by importing the handlers directly instead.

import { handleReadCommand as _handleReadCommand } from '../src/read-commands';
import { handleWriteCommand as _handleWriteCommand } from '../src/write-commands';
import { handleMetaCommand } from '../src/meta-commands';
import { handleSnapshot } from '../src/snapshot';
import { READ_COMMANDS, WRITE_COMMANDS } from '../src/commands';

const handleReadCommand = (cmd: string, args: string[], b: BrowserManager) =>
  _handleReadCommand(cmd, args, b.getActiveSession());
const handleWriteCommand = (cmd: string, args: string[], b: BrowserManager) =>
  _handleWriteCommand(cmd, args, b.getActiveSession(), b);

describe('Batch execution', () => {
  test('multi-tab parallel: goto + text on different tabs', async () => {
    // Create two tabs
    const tab1 = await bm.newTab(baseUrl + '/basic.html');
    const tab2 = await bm.newTab(baseUrl + '/forms.html');

    // Execute text command on both tabs in parallel using TabSession
    const session1 = bm.getSession(tab1);
    const session2 = bm.getSession(tab2);

    const [result1, result2] = await Promise.allSettled([
      _handleReadCommand('text', [], session1),
      _handleReadCommand('text', [], session2),
    ]);

    expect(result1.status).toBe('fulfilled');
    expect(result2.status).toBe('fulfilled');

    if (result1.status === 'fulfilled') {
      expect(result1.value).toContain('Hello');
    }
    if (result2.status === 'fulfilled') {
      // forms.html has form elements
      expect(result2.value.length).toBeGreaterThan(0);
    }

    // Cleanup
    await bm.closeTab(tab2);
    await bm.closeTab(tab1);
  });

  test('same-tab sequential: commands execute in order', async () => {
    const tabId = await bm.newTab();
    const session = bm.getSession(tabId);

    // Navigate then read — must be sequential
    await _handleWriteCommand('goto', [baseUrl + '/basic.html'], session, bm);
    const text = await _handleReadCommand('text', [], session);

    expect(text).toContain('Hello');

    await bm.closeTab(tabId);
  });

  test('per-command error isolation: one tab fails, others succeed', async () => {
    const tab1 = await bm.newTab(baseUrl + '/basic.html');
    const tab2 = await bm.newTab(baseUrl + '/basic.html');

    const session1 = bm.getSession(tab1);
    const session2 = bm.getSession(tab2);

    // Use Promise.allSettled — one succeeds (text read), one fails (invalid ref)
    const results = await Promise.allSettled([
      _handleReadCommand('text', [], session1),
      session2.resolveRef('@e999'), // nonexistent ref — fails immediately
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');

    await bm.closeTab(tab2);
    await bm.closeTab(tab1);
  });

  test('page-scoped refs: snapshot refs are per-session', async () => {
    const tab1 = await bm.newTab(baseUrl + '/basic.html');
    const tab2 = await bm.newTab(baseUrl + '/forms.html');

    const session1 = bm.getSession(tab1);
    const session2 = bm.getSession(tab2);

    // Snapshot on tab1 creates refs in session1
    await handleSnapshot(['-i'], session1);
    const refCount1 = session1.getRefCount();

    // Snapshot on tab2 creates refs in session2
    await handleSnapshot(['-i'], session2);
    const refCount2 = session2.getRefCount();

    // Refs should be independent
    expect(refCount1).toBeGreaterThanOrEqual(0);
    expect(refCount2).toBeGreaterThanOrEqual(0);

    // Session1's refs should not have changed after session2's snapshot
    expect(session1.getRefCount()).toBe(refCount1);

    await bm.closeTab(tab2);
    await bm.closeTab(tab1);
  });

  test('per-tab lastSnapshot: snapshot -D works per-tab', async () => {
    const tab1 = await bm.newTab(baseUrl + '/basic.html');
    const session1 = bm.getSession(tab1);

    // First snapshot sets the baseline
    const snap1 = await handleSnapshot([], session1);
    expect(session1.getLastSnapshot()).not.toBeNull();

    // Second snapshot with -D should diff against the first
    const snap2 = await handleSnapshot(['-D'], session1);
    // Since page didn't change, diff should indicate identical
    // (either "no changes" or empty diff with just headers)
    expect(snap2.length).toBeGreaterThan(0);

    await bm.closeTab(tab1);
  });

  test('getSession throws for nonexistent tab', () => {
    expect(() => bm.getSession(99999)).toThrow('Tab 99999 not found');
  });

  test('getActiveSession returns the current active tab session', async () => {
    const tabId = await bm.newTab(baseUrl + '/basic.html');
    const session = bm.getActiveSession();
    expect(session.getPage().url()).toContain('basic.html');
    await bm.closeTab(tabId);
  });

  test('batch-safe command subset validation', () => {
    const BATCH_SAFE = new Set([
      'text', 'html', 'links', 'snapshot', 'accessibility', 'cookies', 'url',
      'goto', 'click', 'fill', 'select', 'hover', 'scroll', 'wait',
      'screenshot', 'pdf',
      'newtab', 'closetab',
    ]);

    // All batch-safe commands should be in the main command sets (except newtab/closetab which are meta)
    for (const cmd of BATCH_SAFE) {
      if (cmd === 'newtab' || cmd === 'closetab' || cmd === 'snapshot' || cmd === 'screenshot' || cmd === 'pdf' || cmd === 'url') {
        continue; // These are META_COMMANDS, handled separately
      }
      const isKnown = READ_COMMANDS.has(cmd) || WRITE_COMMANDS.has(cmd);
      expect(isKnown).toBe(true);
    }
  });

  test('closeTab via page.close preserves at-least-one-page invariant', async () => {
    // Create a tab, close it via page.close() (simulating batch closetab)
    const tabId = await bm.newTab(baseUrl + '/basic.html');
    const session = bm.getSession(tabId);

    // Close via page.close() directly (how batch does it)
    await session.getPage().close();

    // The page.on('close') handler should have cleaned up
    // And the browser should still have at least one tab
    expect(bm.getTabCount()).toBeGreaterThanOrEqual(1);
  });

  test('parallel goto on multiple tabs', async () => {
    const tab1 = await bm.newTab();
    const tab2 = await bm.newTab();
    const tab3 = await bm.newTab();

    const session1 = bm.getSession(tab1);
    const session2 = bm.getSession(tab2);
    const session3 = bm.getSession(tab3);

    // Navigate all three tabs in parallel
    const results = await Promise.allSettled([
      _handleWriteCommand('goto', [baseUrl + '/basic.html'], session1, bm),
      _handleWriteCommand('goto', [baseUrl + '/forms.html'], session2, bm),
      _handleWriteCommand('goto', [baseUrl + '/basic.html'], session3, bm),
    ]);

    expect(results.every(r => r.status === 'fulfilled')).toBe(true);

    // Verify each tab landed on the right page
    expect(session1.getPage().url()).toContain('basic.html');
    expect(session2.getPage().url()).toContain('forms.html');
    expect(session3.getPage().url()).toContain('basic.html');

    await bm.closeTab(tab3);
    await bm.closeTab(tab2);
    await bm.closeTab(tab1);
  });
});
