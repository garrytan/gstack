/** Regression guards for the #1324 auth bootstrap redesign. */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GSTACK_EXTENSION_ID, isTrustedGstackExtensionWorkerUrl } from '../src/extension-identity';

const ROOT = path.resolve(import.meta.dir, '../..');
const BACKGROUND_SRC = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf-8');
const BROWSER_MANAGER_SRC = fs.readFileSync(path.join(ROOT, 'browse/src/browser-manager.ts'), 'utf-8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf-8'));

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Could not find ${start} through ${end}`);
  return source.slice(startIndex, endIndex);
}

describe('extension auth bootstrap', () => {
  test('reads root auth from trusted session storage, never /health or local storage', () => {
    const loadAuth = sliceBetween(BACKGROUND_SRC, 'async function loadAuthToken()', '// ─── Health Polling');
    expect(loadAuth).toContain('chrome.storage.session.get');
    expect(loadAuth).toContain("accessLevel: 'TRUSTED_CONTEXTS'");
    expect(loadAuth).toContain('gstackAuthToken');
    expect(loadAuth).not.toContain('/health');
  });

  test('pins auth provisioning to the manifest-derived extension ID', () => {
    const manifestId = [...createHash('sha256')
      .update(Buffer.from(MANIFEST.key, 'base64'))
      .digest('hex')
      .slice(0, 32)]
      .map(char => String.fromCharCode('a'.charCodeAt(0) + parseInt(char, 16)))
      .join('');
    expect(manifestId).toBe(GSTACK_EXTENSION_ID);
    expect(isTrustedGstackExtensionWorkerUrl(`chrome-extension://${GSTACK_EXTENSION_ID}/background.js`)).toBe(true);
    expect(isTrustedGstackExtensionWorkerUrl('chrome-extension://attacker/background.js')).toBe(false);

    expect(BROWSER_MANAGER_SRC).toContain('provisionExtensionAuth');
    expect(BROWSER_MANAGER_SRC).toContain('chromeApi.storage.session.set');
    expect(BROWSER_MANAGER_SRC).toContain("accessLevel: 'TRUSTED_CONTEXTS'");
    expect(BROWSER_MANAGER_SRC).toContain("chromeApi.storage.local.remove('gstackAuthToken')");
    expect(BROWSER_MANAGER_SRC).toContain('isGstackExtensionWorker');
    expect(BROWSER_MANAGER_SRC).toContain('isTrustedGstackExtensionWorkerUrl(worker.url())');
    expect(BROWSER_MANAGER_SRC).toContain('if (extensionsDir) await this.provisionExtensionAuth()');
  });

  test('does not return root auth through the content-script port channel', () => {
    const getPort = sliceBetween(BACKGROUND_SRC, "if (msg.type === 'getPort')", "if (msg.type === 'getTabState')");
    expect(getPort).not.toContain('authToken');
    const getToken = sliceBetween(BACKGROUND_SRC, "if (msg.type === 'getToken')", "if (msg.type === 'fetchRefs')");
    expect(getToken).toContain('if (sender.tab)');
  });
});
