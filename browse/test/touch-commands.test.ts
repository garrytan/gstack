/**
 * Phone emulation and touch input on gstack's own Chromium (#3058, GSTA-227 F3).
 *
 * Drives a real in-process BrowserManager (same harness as snapshot.test.ts)
 * against browse/test/fixtures/touch.html: a touch logger, a swipe carousel,
 * a two-finger zoom surface and a joystick plus fire button.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';
import { handleMetaCommand } from '../src/meta-commands';
import { WRITE_COMMANDS, COMMAND_DESCRIPTIONS } from '../src/commands';
import { SCOPE_WRITE } from '../src/token-registry';
import { TUNNEL_COMMANDS } from '../src/routes/commands';

const ORIGINAL_CHROMIUM_PROFILE = process.env.CHROMIUM_PROFILE;
let CHROMIUM_PROFILE_DIR: string | undefined;
let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;
const shutdown = async () => {};
const VERBS = ['device', 'tap', 'swipe', 'pinch', 'touch'];
setDefaultTimeout(20_000);

beforeAll(async () => {
  CHROMIUM_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-profile-'));
  process.env.CHROMIUM_PROFILE = CHROMIUM_PROFILE_DIR;
  testServer = startTestServer(0);
  baseUrl = testServer.url;
  bm = new BrowserManager();
  await bm.launch();
});

afterAll(async () => {
  try { testServer.server.stop(true); } catch {}
  try { await Promise.race([bm?.close(), new Promise((resolve) => setTimeout(resolve, 3000))]); } catch {}
  if (ORIGINAL_CHROMIUM_PROFILE === undefined) delete process.env.CHROMIUM_PROFILE;
  else process.env.CHROMIUM_PROFILE = ORIGINAL_CHROMIUM_PROFILE;
  if (CHROMIUM_PROFILE_DIR) { try { fs.rmSync(CHROMIUM_PROFILE_DIR, { recursive: true, force: true }); } catch {} }
});

const run = (cmd: string, args: string[] = []) => handleWriteCommand(cmd, args, bm.getActiveSession(), bm);
const page = () => bm.getActiveSession().getPage();
const probe = () => page().evaluate(() => ({
  coarse: matchMedia('(pointer: coarse)').matches,
  maxTouchPoints: navigator.maxTouchPoints,
  ua: navigator.userAgent,
  width: innerWidth,
}));
const data = (sel: string, key: string) => page().evaluate(([s, k]) => (document.querySelector(s) as HTMLElement).dataset[k], [sel, key]);

async function freshTouchTab(device: string | null = 'iPhone 15'): Promise<number> {
  const id = await bm.newTab(baseUrl + '/touch.html');
  bm.switchTab(id, { bringToFront: false });
  if (device) await run('device', [device]);
  await page().reload({ waitUntil: 'domcontentloaded' });
  return id;
}

describe('device and touch: registration', () => {
  test('verbs are write commands with descriptions, in the write scope, never on the tunnel', () => {
    for (const verb of VERBS) {
      expect(WRITE_COMMANDS.has(verb)).toBe(true);
      expect(SCOPE_WRITE.has(verb)).toBe(true);
      expect(TUNNEL_COMMANDS.has(verb)).toBe(false);
      expect(COMMAND_DESCRIPTIONS[verb]?.usage).toContain(verb);
    }
  });
});

describe('device', () => {
  test('unknown name suggests the nearest names and leaves the tab alone', async () => {
    await freshTouchTab(null);
    const before = await probe();
    let message = '';
    try { await run('device', ['iPhone 99']); } catch (err: any) { message = err.message; }
    expect(message).toContain('BROWSE_DEVICE_UNKNOWN');
    expect(message).toContain('iPhone 99');
    expect(message).toContain('fix: $B device --list');
    expect(message.match(/iPhone \d/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(await probe()).toEqual(before);
    expect(await run('device')).toContain('none');
  });

  test('--list prints Playwright device names', async () => {
    const list = await run('device', ['--list']);
    expect(list).toContain('iPhone 15');
    expect(list).toContain('Pixel 7');
  });

  test('emulates the phone on this tab only; device off restores', async () => {
    const desktopId = await freshTouchTab(null);
    const desktop = await probe();
    await freshTouchTab('iphone 15');
    const phone = await probe();
    expect(phone.coarse).toBe(true);
    expect(phone.maxTouchPoints).toBe(5);
    expect(phone.ua).toContain('iPhone');
    expect(phone.width).toBe(393);
    expect(await run('device')).toContain('iPhone 15');

    const other = bm.getSession(desktopId).getPage();
    const otherNow = await other.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, maxTouchPoints: navigator.maxTouchPoints, ua: navigator.userAgent, width: innerWidth }));
    expect(otherNow).toEqual(desktop);
    expect(otherNow.ua).not.toContain('iPhone');

    await run('device', ['off']);
    await page().reload({ waitUntil: 'domcontentloaded' });
    expect(await probe()).toEqual(desktop);
    expect(await run('device')).toContain('none');
  });

  test('--landscape swaps the orientation', async () => {
    await freshTouchTab(null);
    await run('device', ['Pixel 7', '--landscape']);
    const p = await page().evaluate(() => ({ w: innerWidth, h: innerHeight }));
    expect(p.w).toBeGreaterThan(p.h);
    await run('device', ['off']);
  });

  test('viewport and responsive refuse while a device is active', async () => {
    await freshTouchTab();
    await expect(run('viewport', ['800x600'])).rejects.toThrow('fix: $B device off');
    await expect(handleMetaCommand('responsive', [], bm, shutdown)).rejects.toThrow('fix: $B device off');
    expect((await probe()).width).toBe(393);
    await run('device', ['off']);
  });

  test('screenshots capture the phone and keep its metrics', async () => {
    await freshTouchTab();
    const out = path.join(os.tmpdir(), `touch-shot-${process.pid}.png`);
    for (const extra of [[], ['--viewport'], ['#zoom'], ['--clip', '0,0,50,50']]) {
      await handleMetaCommand('screenshot', [...extra, out], bm, shutdown);
      const png = fs.readFileSync(out);
      if (extra.length === 0 || extra[0] === '--viewport') expect(png.readUInt32BE(16)).toBe(393 * 3);
      const p = await probe();
      expect({ extra, width: p.width, coarse: p.coarse, touch: p.maxTouchPoints }).toEqual({ extra, width: 393, coarse: true, touch: 5 });
    }
    fs.rmSync(out, { force: true });
    await run('device', ['off']);
  });

  test('annotated and heatmap snapshots and prettyscreenshot keep the phone', async () => {
    await freshTouchTab();
    const out = path.join(os.tmpdir(), `touch-annotate-${process.pid}.png`);
    const captures: Array<[string, string[]]> = [
      ['snapshot', ['-i', '-a', '-o', out]],
      ['snapshot', ['-i', '-H', '{"@e1":"green"}', '-o', out]],
      ['prettyscreenshot', [out]],
    ];
    for (const [cmd, args] of captures) {
      if (cmd === 'prettyscreenshot') await run(cmd, args);
      else await handleMetaCommand(cmd, args, bm, shutdown);
      const p = await probe();
      expect({ cmd, args, width: p.width, coarse: p.coarse }).toEqual({ cmd, args, width: 393, coarse: true });
    }
    fs.rmSync(out, { force: true });
    await run('device', ['off']);
  });

  test('survives a useragent context rebuild; the first restored request carries the phone UA', async () => {
    const id = await bm.newTab(baseUrl + '/echo');
    bm.switchTab(id, { bringToFront: false });
    await run('device', ['iPhone 15']);
    await run('useragent', ['GstackDesktop/1.0']);
    expect(await run('device')).toContain('iPhone 15');
    const echoed = JSON.parse(await page().evaluate(() => document.body.innerText));
    expect(echoed['user-agent']).toContain('iPhone');
    expect((await probe()).coarse).toBe(true);
    await run('device', ['off']);
  });
});

describe('touch input', () => {
  test('touch verbs need an active device', async () => {
    await freshTouchTab(null);
    await expect(run('tap', ['#fire'])).rejects.toThrow('BROWSE_TOUCH_NO_DEVICE');
    await expect(run('touch', ['down', '0', '10', '10'])).rejects.toThrow('fix: $B device "iPhone 15"');
  });

  test('tap fires touchstart and touchend', async () => {
    await freshTouchTab();
    await run('tap', ['#fire']);
    expect(await data('#fire', 'shots')).toBe('1');
    const types = await page().evaluate(() => (window as any).__log.map((e: any) => e.type));
    expect(types).toContain('touchstart');
    expect(types).toContain('touchend');
    await run('tap', ['240', '440', '--hold', '50']);
    expect(await data('#fire', 'shots')).toBe('2');
  });

  test('swipe left advances the carousel; right goes back', async () => {
    await freshTouchTab();
    await run('swipe', ['#carousel', 'left', '--distance', '200']);
    expect(await data('#carousel', 'index')).toBe('1');
    await run('swipe', ['#carousel', 'right', '--distance', '200', '--ms', '100']);
    expect(await data('#carousel', 'index')).toBe('0');
  });

  test('pinch spreads above 1 and pinches below 1', async () => {
    await freshTouchTab();
    await run('pinch', ['#zoom', '2']);
    const spread = Number(await data('#zoom', 'scale'));
    expect(spread).toBeGreaterThan(1.5);
    await run('pinch', ['#zoom', '0.5']);
    expect(Number(await data('#zoom', 'scale'))).toBeLessThan(spread * 0.7);
  });

  test('holding finger 0 while tapping finger 1 leaves finger 0 down', async () => {
    await freshTouchTab();
    await run('touch', ['down', '0', '70', '440']);
    await run('touch', ['down', '1', '240', '440']);
    await run('touch', ['up', '1']);
    expect(await data('#fire', 'shots')).toBe('1');
    expect(await data('#joystick', 'held')).toBe('true');
    expect(await page().evaluate(() => (window as any).__log.at(-1).touches)).toBe(1);
    const held = await run('touch');
    expect(held).toContain('0');
    expect(held).not.toMatch(/\b1\b.*\(/);
    await run('touch', ['move', '0', '90', '440']);
    await run('touch', ['up', '0']);
    expect(await data('#joystick', 'held')).toBe('false');
    expect(await run('touch')).toContain('none');
  });

  test('usage errors name the problem and give a fix', async () => {
    await freshTouchTab();
    const message = (cmd: string, args: string[]) => run(cmd, args).then(() => '', (err: Error) => err.message);
    expect(await message('touch', ['up', '3'])).toMatch(/finger 3 is not down[\s\S]*fix:/);
    expect(await message('touch', ['down', '12', '1', '1'])).toMatch(/0-9[\s\S]*fix:/);
    expect(await message('swipe', ['#carousel', 'sideways'])).toMatch(/up\|down\|left\|right[\s\S]*fix:/);
    expect(await message('pinch', ['#zoom', '-1'])).toMatch(/scale[\s\S]*fix:/);
  });

  test('held fingers are cancelled on navigation and by touch cancel', async () => {
    await freshTouchTab();
    await run('touch', ['down', '0', '70', '440']);
    expect(await run('touch')).toContain('0');
    await page().goto(baseUrl + '/touch.html', { waitUntil: 'domcontentloaded' });
    expect(await run('touch')).toContain('none');
    await run('touch', ['down', '2', '240', '440']);
    expect(await data('#fire', 'shots')).toBe('1');
    await run('touch', ['cancel']);
    expect(await run('touch')).toContain('none');
    expect(await page().evaluate(() => (window as any).__log.at(-1).type)).toBe('touchcancel');
  });

  test('touch cancel with no finger held is a no-op, not a protocol error', async () => {
    await freshTouchTab();
    expect(await run('touch', ['cancel'])).toContain('nothing to cancel');
  });
});
