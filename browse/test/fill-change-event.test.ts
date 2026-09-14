/**
 * Regression test for `browse fill` on change-only validators.
 *
 * Playwright's Locator.fill() dispatches an `input` event but not `change`.
 * Frameworks that validate on `change` (AngularJS ng-change, debounced
 * strength/match checks — e.g. cPanel's Jupiter theme "Add FTP Account"
 * password-match check) never see the update: the DOM value is correct but
 * the framework's own validator still reports a mismatch.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand as _handleWriteCommand } from '../src/write-commands';

// Per-FILE Chromium profile: this file launches an in-process persistent
// context (BrowserManager.launch()), and sharing a profile dir with the
// long-lived browse daemon a sibling file may have spawned kills one side's
// Chromium (ProcessSingleton on user-data-dir). Scoped via hooks, never
// module scope (see test/gstack-home-module-scope.test.ts's rationale).
const ORIGINAL_CHROMIUM_PROFILE = process.env.CHROMIUM_PROFILE;
let CHROMIUM_PROFILE_DIR: string | undefined;
beforeAll(() => {
  CHROMIUM_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-profile-'));
  process.env.CHROMIUM_PROFILE = CHROMIUM_PROFILE_DIR;
});
afterAll(() => {
  if (ORIGINAL_CHROMIUM_PROFILE === undefined) delete process.env.CHROMIUM_PROFILE;
  else process.env.CHROMIUM_PROFILE = ORIGINAL_CHROMIUM_PROFILE;
  if (CHROMIUM_PROFILE_DIR) { try { fs.rmSync(CHROMIUM_PROFILE_DIR, { recursive: true, force: true }); } catch {} }
});


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

afterAll(async () => {
  try { testServer.server.stop(); } catch {}
  // Close only this file's own browser — never process.exit(): bun test runs
  // all files in one process, so a delayed exit kills the whole suite
  // (see test/no-suicide-exit.test.ts). close() can hang when the browser
  // already died, so race it at 3s and abandon; the child is reaped at exit.
  try { await Promise.race([bm?.close(), new Promise((resolve) => setTimeout(resolve, 3000))]); } catch {}
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
