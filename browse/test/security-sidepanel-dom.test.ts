/**
 * Real-Chromium regression coverage for the sidepanel's current security UI.
 *
 * The classifier-backed chat queue was removed when the primary surface
 * became a terminal PTY. Until classifier status is wired to that surface,
 * the honest contract is deliberately negative:
 *
 *   - /health.security.status must not light the hidden SEC shield.
 *   - retired /sidebar-chat security_event data must not render a banner or
 *     leak attacker-controlled text into the terminal surface.
 *
 * Every HTTP, SSE, WebSocket, and beacon primitive is replaced before the
 * sidepanel scripts load, so this test never reaches a real browse server.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Browser, type Page } from 'playwright';

const EXTENSION_DIR = path.resolve(import.meta.dir, '..', '..', 'extension');
const SIDEPANEL_URL = `file://${EXTENSION_DIR}/sidepanel.html`;

const CHROMIUM_AVAILABLE = (() => {
  try {
    const executable = chromium.executablePath();
    return Boolean(executable && fs.existsSync(executable));
  } catch {
    return false;
  }
})();

type Scenario = {
  healthSecurity: {
    status: 'protected' | 'degraded' | 'inactive';
    layers?: Record<string, string>;
  };
  securityEntries?: unknown[];
};

async function installStubsBeforeLoad(page: Page, scenario: Scenario): Promise<void> {
  await page.addInitScript((params: Scenario) => {
    const requests: Array<{ url: string; method: string }> = [];
    (window as any).__gstackTestRequests = requests;

    (window as any).chrome = {
      runtime: {
        sendMessage: (_request: unknown, callback?: (value: unknown) => void) => {
          // Omit a token so sidepanel.js exercises the direct /health
          // bootstrap path whose security payload is under test.
          const payload = { connected: true, port: 34567 };
          if (typeof callback === 'function') {
            setTimeout(() => callback(payload), 0);
            return undefined;
          }
          return Promise.resolve(payload);
        },
        lastError: null,
        onMessage: { addListener: () => {} },
      },
      tabs: {
        query: (_query: unknown, callback: (tabs: unknown[]) => void) =>
          setTimeout(() => callback([{ id: 1, url: 'https://example.com' }]), 0),
        onActivated: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
      },
    };

    (window as any).EventSource = class StubEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = 1;

      constructor(url: string) {
        requests.push({ url: String(url), method: 'EVENTSOURCE' });
      }

      addEventListener() {}
      close() { this.readyState = 2; }
    };

    (window as any).WebSocket = class StubWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;

      constructor(url: string) {
        requests.push({ url: String(url), method: 'WEBSOCKET' });
      }

      addEventListener() {}
      send() {}
      close() { this.readyState = 3; }
    };

    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: (url: string) => {
        requests.push({ url: String(url), method: 'BEACON' });
        return true;
      },
    });

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });

      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({
          status: 'healthy',
          token: 'test-token',
          AUTH_TOKEN: 'test-token',
          mode: 'headed',
          agent: { status: 'idle', runningFor: null, queueLength: 0 },
          session: null,
          security: params.healthSecurity,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/sse-session')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/memory')) {
        return new Response(JSON.stringify({ bunServer: { rss: 0 }, tabs: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/pty-session')) {
        // Keep the terminal bootstrap deterministic and prevent a WebSocket
        // attempt; this test concerns the pre-session terminal surface.
        return new Response('terminal disabled in DOM test', { status: 503 });
      }
      if (url.includes('/sidebar-chat')) {
        return new Response(JSON.stringify({
          entries: params.securityEntries ?? [],
          total: (params.securityEntries ?? []).length,
          agentStatus: 'idle',
          security: params.healthSecurity,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/refs')) {
        return new Response(JSON.stringify({ refs: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Fail closed inside the stub rather than falling through to the real
      // network. Recording the URL above keeps unexpected bootstrap calls
      // diagnosable in assertion output.
      return new Response(JSON.stringify({ error: 'unstubbed test endpoint' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  }, scenario);
}

async function openStubbedSidepanel(
  scenario: Scenario,
  assertion: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser!.newContext();
  try {
    const page = await context.newPage();
    await installStubsBeforeLoad(page, scenario);
    await page.goto(SIDEPANEL_URL);
    await page.waitForFunction(() =>
      (window as any).gstackAuthToken === 'test-token' &&
      document.getElementById('footer-dot')?.classList.contains('connected'),
    );
    await assertion(page);
  } finally {
    await context.close();
  }
}

let browser: Browser | null = null;

beforeAll(async () => {
  if (!CHROMIUM_AVAILABLE) return;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  if (!browser) return;
  try {
    await browser.close();
  } catch {}
  browser = null;
});

describe('sidepanel security DOM', () => {
  test.skipIf(!CHROMIUM_AVAILABLE)(
    'protected health metadata does not expose an unwired SEC claim',
    async () => {
      await openStubbedSidepanel({
        healthSecurity: {
          status: 'protected',
          layers: { testsavant: 'ok', transcript: 'ok', canary: 'ok' },
        },
      }, async (page) => {
        const shield = page.locator('#security-shield');
        expect(await shield.count()).toBe(1);
        expect(await shield.isVisible()).toBe(false);
        expect(await shield.getAttribute('data-status')).toBeNull();
        expect(await shield.getAttribute('aria-label')).toBe('Security status: unknown');

        const visibleText = await page.locator('body').innerText();
        expect(visibleText).not.toContain('SEC');
        expect(visibleText.toLowerCase()).not.toContain('protected');

        const requests = await page.evaluate(() => (window as any).__gstackTestRequests);
        expect(requests.some((request: { url: string }) => request.url.endsWith('/health'))).toBe(true);
        expect(requests.some((request: { url: string }) => request.url.endsWith('/sse-session'))).toBe(true);
      });
    },
    15_000,
  );

  test.skipIf(!CHROMIUM_AVAILABLE)(
    'retired security_event data is neither polled nor rendered into the terminal',
    async () => {
      const attackerMarker = 'ATTACKER-CONTROLLED-TERMINAL-MARKER';
      const attackerDomain = 'retired-chat.attacker.example';
      await openStubbedSidepanel({
        healthSecurity: {
          status: 'protected',
          layers: { testsavant: 'ok', transcript: 'ok', canary: 'ok' },
        },
        securityEntries: [{
          id: 1,
          ts: '2026-04-20T00:00:00Z',
          role: 'agent',
          type: 'security_event',
          verdict: 'block',
          reason: attackerMarker,
          layer: 'canary',
          confidence: 1,
          domain: attackerDomain,
        }],
      }, async (page) => {
        // Let immediate connection work and the first memory poll settle;
        // neither may reintroduce the retired chat polling path.
        await page.waitForTimeout(650);

        const requests = await page.evaluate(() => (window as any).__gstackTestRequests);
        expect(requests.some((request: { url: string }) => request.url.includes('/sidebar-chat'))).toBe(false);
        expect(requests.some((request: { url: string }) => request.url.endsWith('/memory'))).toBe(true);
        expect(requests.some((request: { url: string }) => request.url.startsWith('https://'))).toBe(false);

        expect(await page.locator('#security-banner').count()).toBe(0);
        expect(await page.locator('.security-banner').count()).toBe(0);
        const terminalText = await page.locator('#tab-terminal').innerText();
        expect(terminalText).not.toContain(attackerMarker);
        expect(terminalText).not.toContain(attackerDomain);
        expect(await page.locator('#security-shield').isVisible()).toBe(false);
      });
    },
    15_000,
  );
});
