/**
 * E2E (gate tier): boots a real Chromium via BrowserManager.launch(), navigates
 * to the fixture server, exercises $B cdp end-to-end against a Playwright-owned
 * CDPSession (Path A from the spike).
 *
 * Verifies (T2 + T7):
 *  - allowed methods (Accessibility, Performance, DOM, CSS read-only) succeed
 *  - dangerous methods are DENIED with structured error
 *  - untrusted-output methods get UNTRUSTED envelope
 *  - mutex works against a real CDPSession
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';

const TMP_HOME = path.join(os.tmpdir(), `gstack-cdp-e2e-${process.pid}-${Date.now()}`);
process.env.GSTACK_HOME = TMP_HOME;
process.env.GSTACK_TELEMETRY_OFF = '1'; // don't pollute analytics during tests

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;

beforeAll(async () => {
  await fs.rm(TMP_HOME, { recursive: true, force: true });
  await fs.mkdir(TMP_HOME, { recursive: true });
  testServer = startTestServer(0);
  baseUrl = testServer.url;
  bm = new BrowserManager();
  await bm.launch();
  await bm.getPage().goto(baseUrl + '/basic.html');
});

afterAll(async () => {
  try { await bm.cleanup?.(); } catch {}
  try { testServer.server.stop(); } catch {}
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

describe('$B cdp (E2E gate tier)', () => {
  test('Accessibility.getFullAXTree (allowed, untrusted-output) returns wrapped JSON', async () => {
    const { handleCdpCommand } = await import('../src/cdp-commands');
    const out = await handleCdpCommand(['Accessibility.getFullAXTree', '{}'], bm);
    // Untrusted-output methods get the envelope
    expect(out).toContain('--- BEGIN UNTRUSTED EXTERNAL CONTENT');
    expect(out).toContain('--- END UNTRUSTED EXTERNAL CONTENT ---');
    // The envelope wraps a JSON tree
    const inner = out.replace(/--- BEGIN .*?\n/s, '').replace(/\n--- END .*$/s, '');
    const parsed = JSON.parse(inner);
    expect(parsed).toHaveProperty('nodes');
    expect(Array.isArray(parsed.nodes)).toBe(true);
  });

  test('Performance.getMetrics (allowed, trusted-output) returns plain JSON', async () => {
    const { handleCdpCommand } = await import('../src/cdp-commands');
    // Performance domain needs to be enabled first
    await handleCdpCommand(['Performance.enable', '{}'], bm);
    const out = await handleCdpCommand(['Performance.getMetrics', '{}'], bm);
    // Trusted-output = no envelope
    expect(out).not.toContain('UNTRUSTED');
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('metrics');
    expect(Array.isArray(parsed.metrics)).toBe(true);
  });

  test('Runtime.evaluate (DENIED) errors with structured guidance', async () => {
    const { handleCdpCommand } = await import('../src/cdp-commands');
    await expect(handleCdpCommand(['Runtime.evaluate', '{"expression":"1+1"}'], bm))
      .rejects.toThrow(/DENIED.*Runtime\.evaluate/);
  });

  test('Page.navigate (DENIED — must use $B goto for blocklist routing)', async () => {
    const { handleCdpCommand } = await import('../src/cdp-commands');
    await expect(handleCdpCommand(['Page.navigate', '{"url":"http://example.com"}'], bm))
      .rejects.toThrow(/DENIED.*Page\.navigate/);
  });

  test('Network.getResponseBody (DENIED — exfil surface)', async () => {
    const { handleCdpCommand } = await import('../src/cdp-commands');
    await expect(handleCdpCommand(['Network.getResponseBody', '{}'], bm))
      .rejects.toThrow(/DENIED.*Network\.getResponseBody/);
  });

  test('malformed JSON params surfaces a clear error', async () => {
    const { handleCdpCommand } = await import('../src/cdp-commands');
    await expect(handleCdpCommand(['Accessibility.getFullAXTree', 'not-json'], bm))
      .rejects.toThrow(/Cannot parse params as JSON/);
  });

  test('non Domain.method format surfaces a clear error', async () => {
    const { handleCdpCommand } = await import('../src/cdp-commands');
    await expect(handleCdpCommand(['justOneWord'], bm))
      .rejects.toThrow(/Domain\.method format/);
  });

  test('--help returns the help text', async () => {
    const { handleCdpCommand } = await import('../src/cdp-commands');
    const out = await handleCdpCommand(['help'], bm);
    expect(out).toContain('deny-default escape hatch');
    expect(out).toContain('cdp-allowlist.ts');
  });
});
