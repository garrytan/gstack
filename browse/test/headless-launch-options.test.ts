/**
 * E8 (#2771, #1968) and #2281: the headless launch honors GSTACK_CHROMIUM_PATH
 * and names it when it fails; BROWSE_EXTENSIONS_DIR loads extensions in new
 * headless mode (no window, extension actually runs) instead of an off-screen
 * headed window.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { BrowserManager } from '../src/browser-manager';
import { readPidCmdline } from '../src/xvfb';
import { handleWriteCommand } from '../src/write-commands';

const ENV_KEYS = ['GSTACK_CHROMIUM_PATH', 'BROWSE_EXTENSIONS_DIR', 'BROWSE_STATE_FILE'] as const;
let saved: Record<string, string | undefined>;
let scratch: string;
let bm: BrowserManager | null;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-launch-opts-'));
  process.env.BROWSE_STATE_FILE = path.join(scratch, 'state', 'browse.json');
  bm = null;
});

afterEach(async () => {
  try { await Promise.race([bm?.close(), new Promise((resolve) => setTimeout(resolve, 3000))]); } catch {}
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('headless launch options (Linux, real Chromium)', () => {
  test('GSTACK_CHROMIUM_PATH is the binary the headless launch runs', async () => {
    const custom = chromium.executablePath();
    process.env.GSTACK_CHROMIUM_PATH = custom;
    // Only browsers this launch started count: an earlier file in the same
    // shard process may still be reaping its own headless_shell child.
    const children = () => new Set(fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).filter(d => {
      try { return fs.readFileSync(`/proc/${d}/stat`, 'utf-8').split(') ')[1].split(' ')[1] === String(process.pid); } catch { return false; }
    }));
    const before = children();
    bm = new BrowserManager();
    await bm.launch();
    const cmdlines = [...children()].filter(pid => !before.has(pid)).map(pid => readPidCmdline(Number(pid)));
    expect(cmdlines.some(c => c.startsWith(custom) && c.includes('--headless'))).toBe(true);
    expect(cmdlines.some(c => c.includes('headless_shell'))).toBe(false);
  }, 60_000);

  test('close returns when Chromium exits, not at the close race timeout', async () => {
    // Removing every 'disconnected' listener used to strip Playwright's own,
    // so browser.close() never resolved and every close waited 5 s.
    bm = new BrowserManager();
    await bm.launch();
    const started = performance.now();
    await bm.close();
    expect(performance.now() - started).toBeLessThan(2_500);
    bm = null;
  }, 60_000);

  test('a broken GSTACK_CHROMIUM_PATH fails with the path named', async () => {
    const missing = path.join(scratch, 'no-such-chromium');
    process.env.GSTACK_CHROMIUM_PATH = missing;
    bm = new BrowserManager();
    await expect(bm.launch()).rejects.toThrow(`Chromium at GSTACK_CHROMIUM_PATH=${missing} failed to launch`);
  }, 60_000);

  test('BROWSE_EXTENSIONS_DIR runs the extension in new headless mode', async () => {
    const ext = path.join(scratch, 'ext');
    fs.mkdirSync(ext);
    fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'probe', version: '1',
      content_scripts: [{ matches: ['<all_urls>'], js: ['c.js'], run_at: 'document_start' }],
    }));
    fs.writeFileSync(path.join(ext, 'c.js'), 'document.documentElement.setAttribute("data-probe-ext", "1");');
    process.env.BROWSE_EXTENSIONS_DIR = ext;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<p>x</p>', { headers: { 'Content-Type': 'text/html' } }) });
    try {
      bm = new BrowserManager();
      await bm.launch();
      const session = bm.getActiveSession();
      await handleWriteCommand('goto', [`http://127.0.0.1:${server.port}/`], session, bm);
      expect(await session.getPage().evaluate(() => document.documentElement.getAttribute('data-probe-ext'))).toBe('1');
      expect(fs.existsSync(path.join(scratch, 'state', 'extensions', 'chromium-profile'))).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 60_000);
});
