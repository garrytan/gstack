/**
 * Regression test for `browse fill` on change-only validators.
 *
 * Playwright's Locator.fill() dispatches an `input` event but not `change`.
 * Frameworks that validate on `change` (AngularJS ng-change, debounced
 * strength/match checks — e.g. cPanel's Jupiter theme "Add FTP Account"
 * password-match check) never see the update: the DOM value is correct but
 * the framework's own validator still reports a mismatch.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand as _handleWriteCommand } from '../src/write-commands';

const handleWriteCommand = (cmd: string, args: string[], b: BrowserManager) =>
  _handleWriteCommand(cmd, args, b.getActiveSession(), b);

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;
  bm = new BrowserManager();
  await bm.launch();
});

afterAll(() => {
  try { testServer.server.stop(); } catch {}
  setTimeout(() => process.exit(0), 500);
});

describe('fill dispatches change event', () => {
  test('a change-only validator sees the filled value', async () => {
    await handleWriteCommand('goto', [baseUrl + '/change-only-validator.html'], bm);
    await handleWriteCommand('fill', ['#password', 'hello123'], bm);
    await handleWriteCommand('fill', ['#password2', 'hello123'], bm);

    const status = await bm.getPage().locator('#match-status').textContent();
    expect(status).toBe('match');
  });

  test('a change-only validator still catches a real mismatch', async () => {
    await handleWriteCommand('goto', [baseUrl + '/change-only-validator.html'], bm);
    await handleWriteCommand('fill', ['#password', 'hello123'], bm);
    await handleWriteCommand('fill', ['#password2', 'different'], bm);

    const status = await bm.getPage().locator('#match-status').textContent();
    expect(status).toBe('no-match');
  });
});
