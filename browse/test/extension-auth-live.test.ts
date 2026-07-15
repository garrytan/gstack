/**
 * Opt-in real-Chromium receipt for the extension auth trust boundary.
 * Run with: GSTACK_LIVE_BROWSER_TESTS=1 bun test browse/test/extension-auth-live.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrowserManager } from '../src/browser-manager';
import { GSTACK_EXTENSION_ID } from '../src/extension-identity';

const RUN = process.env.GSTACK_LIVE_BROWSER_TESTS === '1' && process.platform === 'darwin';
const originalProfile = process.env.CHROMIUM_PROFILE;
const originalExtensionsDir = process.env.BROWSE_EXTENSIONS_DIR;
let temp = '';
let manager: BrowserManager | null = null;
let probeServer: ReturnType<typeof Bun.serve> | null = null;

describe.skipIf(!RUN)('extension auth live Chromium', () => {
  beforeAll(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-extension-auth-live-'));
    process.env.CHROMIUM_PROFILE = path.join(temp, 'chromium-profile');
    probeServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/page') return new Response('<!doctype html><title>probe</title>', { headers: { 'Content-Type': 'text/html' } });
        if (url.pathname === '/health') return Response.json({ status: 'healthy', mode: 'headed', tabs: 1 });
        if (url.pathname === '/probe') {
          return Response.json({ authorization: req.headers.get('authorization') });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      },
    });
  });

  afterAll(async () => {
    await manager?.close();
    probeServer?.stop(true);
    if (originalProfile === undefined) delete process.env.CHROMIUM_PROFILE;
    else process.env.CHROMIUM_PROFILE = originalProfile;
    if (originalExtensionsDir === undefined) delete process.env.BROWSE_EXTENSIONS_DIR;
    else process.env.BROWSE_EXTENSIONS_DIR = originalExtensionsDir;
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  });

  test('provisions and rotates auth for trusted pages while content scripts cannot read it', async () => {
    const token = `live-${crypto.randomUUID()}`;
    manager = new BrowserManager();
    manager.serverPort = probeServer!.port;
    await manager.launchHeaded(token);

    const context = (manager as any).context;
    const worker = context.serviceWorkers().find((candidate: any) => candidate.url() === `chrome-extension://${GSTACK_EXTENSION_ID}/background.js`)
      ?? await context.waitForEvent('serviceworker', { timeout: 10_000 });
    expect(worker.url()).toBe(`chrome-extension://${GSTACK_EXTENSION_ID}/background.js`);

    const stored = await worker.evaluate(async () => {
      const api = (globalThis as any).chrome.storage;
      return {
        session: await api.session.get('gstackAuthToken'),
        local: await api.local.get('gstackAuthToken'),
      };
    });
    expect(stored.session.gstackAuthToken).toBe(token);
    expect(stored.local.gstackAuthToken).toBeUndefined();

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`http://127.0.0.1:${probeServer!.port}/page`);
    const contentRead = await worker.evaluate(async (pageUrl: string) => {
      const chromeApi = (globalThis as any).chrome;
      const [tab] = await chromeApi.tabs.query({ url: pageUrl });
      const [injection] = await chromeApi.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          try {
            const data = await (globalThis as any).chrome.storage.session.get('gstackAuthToken');
            return { token: data.gstackAuthToken ?? null, error: null };
          } catch (err: any) {
            return { token: null, error: String(err?.message || err) };
          }
        },
      });
      return injection.result;
    }, page.url());
    expect(contentRead.token).toBeNull();

    const authenticated = await worker.evaluate(async (port: number) => {
      const chromeApi = (globalThis as any).chrome;
      const { gstackAuthToken } = await chromeApi.storage.session.get('gstackAuthToken');
      const resp = await fetch(`http://127.0.0.1:${port}/probe`, {
        headers: { Authorization: `Bearer ${gstackAuthToken}` },
      });
      return resp.json();
    }, probeServer!.port);
    expect(authenticated.authorization).toBe(`Bearer ${token}`);

    const rotated = `rotated-${crypto.randomUUID()}`;
    await (manager as any).provisionExtensionAuth(rotated);
    const rotatedStore = await worker.evaluate(async () => (
      (globalThis as any).chrome.storage.session.get('gstackAuthToken')
    ));
    expect(rotatedStore.gstackAuthToken).toBe(rotated);

    // The off-screen extension mode is a separate supported launch path. It
    // must use a persistent context too; browser.newContext() has no extension
    // service worker and previously made this mode silently unauthenticated.
    await manager.close();
    process.env.BROWSE_EXTENSIONS_DIR = path.resolve(import.meta.dir, '../../extension');
    const offscreenToken = `offscreen-${crypto.randomUUID()}`;
    manager = new BrowserManager();
    manager.serverPort = probeServer!.port;
    manager.setExtensionAuthToken(offscreenToken);
    await manager.launch();
    const offscreenContext = (manager as any).context;
    const offscreenWorker = offscreenContext.serviceWorkers().find((candidate: any) => candidate.url() === `chrome-extension://${GSTACK_EXTENSION_ID}/background.js`)
      ?? await offscreenContext.waitForEvent('serviceworker', { timeout: 10_000 });
    const offscreenStore = await offscreenWorker.evaluate(async () => (
      (globalThis as any).chrome.storage.session.get('gstackAuthToken')
    ));
    expect(offscreenStore.gstackAuthToken).toBe(offscreenToken);
  }, 60_000);
});
