/**
 * Extension auth bootstrap regression tests for #1324.
 *
 * /health is a public liveness endpoint, so it must never carry the root
 * auth token. The trusted bundled extension gets auth via chrome.storage
 * populated by BrowserManager after the extension service worker starts.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(new URL(import.meta.url).pathname, '..', '..');
const BACKGROUND_SRC = fs.readFileSync(path.join(ROOT, '..', 'extension', 'background.js'), 'utf-8');
const BROWSER_MANAGER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'browser-manager.ts'), 'utf-8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'server.ts'), 'utf-8');

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Marker not found: ${startMarker}`);
  const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`End marker not found: ${endMarker}`);
  return source.slice(startIdx, endIdx);
}

describe('extension auth bootstrap', () => {
  test('background loads auth token from chrome.storage instead of /health', () => {
    const loadAuthToken = sliceBetween(BACKGROUND_SRC, 'async function loadAuthToken()', '// ─── Health Polling');
    expect(loadAuthToken).toContain('chrome.storage.local.get');
    expect(loadAuthToken).toContain('gstackAuthToken');
    expect(loadAuthToken).not.toContain('/health');
  });

  test('background refreshes storage auth and port before health checks', () => {
    const loadAuthToken = sliceBetween(BACKGROUND_SRC, 'async function loadAuthToken()', '// ─── Health Polling');
    expect(loadAuthToken).not.toContain('if (authToken) return');
    expect(loadAuthToken).toContain('if (data.port) serverPort = data.port');
    expect(loadAuthToken).not.toContain('if (data.port && !serverPort)');

    const checkHealth = sliceBetween(BACKGROUND_SRC, 'async function checkHealth()', 'function setConnected');
    expect(checkHealth.indexOf('await loadAuthToken()')).toBeGreaterThan(-1);
    expect(checkHealth.indexOf('await loadAuthToken()')).toBeLessThan(checkHealth.indexOf('const base = getBaseUrl()'));
  });

  test('BrowserManager provisions root auth into extension storage after headed launch', () => {
    expect(BROWSER_MANAGER_SRC).toContain('provisionExtensionAuth');
    expect(BROWSER_MANAGER_SRC).toContain('chrome.storage.local.set');
    expect(BROWSER_MANAGER_SRC).toContain('gstackAuthToken');
    expect(BROWSER_MANAGER_SRC).toContain('waitForEvent(\'serviceworker\'');
    expect(BROWSER_MANAGER_SRC).toContain("this.context.on('serviceworker'");
    expect(BROWSER_MANAGER_SRC).toContain('await this.provisionExtensionAuth(authToken)');
  });

  test('BrowserManager only provisions auth to the bundled gstack extension worker', () => {
    expect(BROWSER_MANAGER_SRC).toContain('isGstackExtensionWorker');
    expect(BROWSER_MANAGER_SRC).toContain('chrome.runtime.getManifest');
    expect(BROWSER_MANAGER_SRC).toContain("manifest?.name === 'gstack browse'");
    expect(BROWSER_MANAGER_SRC).toContain("manifest?.background?.service_worker === 'background.js'");
    expect(BROWSER_MANAGER_SRC).not.toContain(".find((w) => w.url().startsWith('chrome-extension://'))");
  });

  test('server preserves auth for later handoff without using /health', () => {
    expect(BROWSER_MANAGER_SRC).toContain('setExtensionAuthToken');
    expect(SERVER_SRC).toContain('browserManager.setExtensionAuthToken(envCfg.authToken)');
    expect(BROWSER_MANAGER_SRC).toContain('await this.provisionExtensionAuth();');
    expect(BROWSER_MANAGER_SRC).not.toContain('Extension reads token from /health');
  });

  test('server port is known before extension auth is provisioned', () => {
    const startBody = sliceBetween(SERVER_SRC, 'export async function start()', 'const startTime = Date.now();');
    expect(startBody.indexOf('browserManager.serverPort = port')).toBeGreaterThan(-1);
    expect(startBody.indexOf('browserManager.serverPort = port')).toBeLessThan(startBody.indexOf('await browserManager.launchHeaded(envCfg.authToken)'));
  });

  test('terminal agent spawn is pinned to the bundled extension id', () => {
    const terminalSpawnEnv = sliceBetween(SERVER_SRC, 'const state: Record<string, unknown> = {', 'fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), { mode: 0o600 });');
    expect(BROWSER_MANAGER_SRC).toContain('getExtensionId()');
    expect(terminalSpawnEnv).toContain('extensionId');
    expect(terminalSpawnEnv).toContain('browserManager.getExtensionId()');

    const cliSpawn = sliceBetween(fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf-8'), 'const newPid = spawnTerminalAgent({', 'if (newPid) {');
    expect(cliSpawn).toContain('BROWSE_EXTENSION_ID: newState.extensionId');
  });
});
