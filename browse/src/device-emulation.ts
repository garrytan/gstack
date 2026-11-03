/**
 * Phone emulation per tab (`$B device`, #3058). Sizes and user agents come
 * from Playwright's own `devices` table. Everything is applied through the
 * tab's own CDP session, never through context options or recreateContext(),
 * so one agent's phone never resizes another agent's tab.
 *
 *   device "iPhone 15" ─▶ Emulation.setDeviceMetricsOverride (mobile, screen, orientation)
 *                     ─▶ Emulation.setTouchEmulationEnabled (maxTouchPoints 5)
 *                     ─▶ Emulation.setUserAgentOverride (UA, platform, UA-CH metadata)
 *   device off        ─▶ the three clears, then Playwright's viewport re-applied
 *
 * The profile lives on TabSession; BrowserManager.saveState()/restoreState()
 * carry it across context recreation and re-apply it before the first request.
 */

import * as fs from 'fs';
import { devices } from 'playwright';
import type { Page } from 'playwright';
import type { DeviceProfile, TabSession } from './tab-session';
import { getOrCreateCdpSession } from './cdp-bridge';
import { levenshtein } from './commands';
import { resultLine } from '../../lib/result-codes';

const DEVICE_NAMES = Object.keys(devices);
const cdpSessions: WeakMap<Page, any> = new WeakMap();

/** The tab's long-lived CDP session; emulation overrides live as long as it does. */
export function tabCdpSession(page: Page): Promise<any> {
  return getOrCreateCdpSession(page, cdpSessions);
}

export function describeDevice(profile: DeviceProfile | null): string {
  if (!profile) return 'none';
  return profile.landscape ? `${profile.name} (landscape)` : profile.name;
}

/** Usage error for commands that would fight an active phone profile. */
export function refuseWhileDevice(session: TabSession, command: string): void {
  const profile = session.getDevice();
  if (!profile) return;
  throw new Error(
    `Usage: ${command} cannot change the size of a tab that emulates ${describeDevice(profile)}; the phone profile sets its size.\n` +
    'fix: $B device off',
  );
}

function findDevice(name: string): string | null {
  const lower = name.toLowerCase();
  return DEVICE_NAMES.find((n) => n.toLowerCase() === lower) ?? null;
}

function nearestDevices(name: string): string[] {
  const lower = name.toLowerCase();
  return DEVICE_NAMES
    .filter((n) => !n.endsWith(' landscape'))
    .map((n) => ({ n, d: levenshtein(lower, n.toLowerCase()) }))
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, 3)
    .map((x) => x.n);
}

function resolveProfile(profile: DeviceProfile) {
  const name = findDevice(profile.name);
  if (!name) {
    throw new Error(resultLine('browse', 'BROWSE_DEVICE_UNKNOWN',
      `"${profile.name}"; nearest: ${nearestDevices(profile.name).map((n) => `"${n}"`).join(', ')}`));
  }
  const landscapeName = profile.landscape ? findDevice(`${name} landscape`) : null;
  const d = devices[landscapeName ?? name]!;
  const landscape = profile.landscape || name.endsWith(' landscape');
  const swap = profile.landscape && !landscapeName;
  const viewport = swap ? { width: d.viewport.height, height: d.viewport.width } : d.viewport;
  const screen = (d as { screen?: { width: number; height: number } }).screen ?? d.viewport;
  return {
    profile: { name, landscape: profile.landscape },
    viewport,
    screen: swap ? { width: screen.height, height: screen.width } : screen,
    deviceScaleFactor: d.deviceScaleFactor,
    isMobile: d.isMobile,
    hasTouch: d.hasTouch,
    userAgent: d.userAgent,
    landscape,
  };
}

function userAgentMetadata(ua: string, mobile: boolean) {
  const android = ua.match(/Android (\d+(?:\.\d+)*)/);
  const ios = ua.match(/(?:iPhone|CPU) OS (\d+(?:_\d+)*)/);
  const chrome = ua.match(/Chrome\/(\d+)\.([\d.]+)/);
  const platform = android ? 'Android' : ios ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'Linux';
  return {
    brands: chrome ? [{ brand: 'Chromium', version: chrome[1]! }, { brand: 'Not.A/Brand', version: '99' }] : [],
    fullVersion: chrome ? `${chrome[1]}.${chrome[2]}` : '',
    platform,
    platformVersion: android ? android[1]! : ios ? ios[1]!.replace(/_/g, '.') : '',
    architecture: android || ios ? 'arm' : 'x86',
    model: android ? (ua.match(/Android [\d.]+; ([^;)]+)/)?.[1] ?? '') : '',
    mobile,
  };
}

function navigatorPlatform(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Linux armv81';
  if (/Mac OS X/.test(ua)) return 'MacIntel';
  return /Windows/.test(ua) ? 'Win32' : 'Linux x86_64';
}

async function sendAll(page: Page, steps: Array<[string, Record<string, unknown>]>, partly: string): Promise<void> {
  const cdp = await tabCdpSession(page);
  let done = 0;
  for (const [method, params] of steps) {
    try {
      await cdp.send(method, params);
      done++;
    } catch (err: any) {
      const failure = new Error(resultLine('browse', 'BROWSE_DEVICE_CDP_FAILED',
        `${method}: ${err?.message ?? err}; ${done === 0 ? 'the tab is unchanged' : partly}`));
      throw Object.assign(failure, { partial: done > 0 });
    }
  }
}

/** Validate, then emulate the phone on this tab. Throws before touching the browser on an unknown name. */
export async function applyDevice(session: TabSession, requested: DeviceProfile): Promise<string> {
  const r = resolveProfile(requested);
  const page = session.getPage();
  try {
    await sendAll(page, [
      ['Emulation.setDeviceMetricsOverride', {
        width: r.viewport.width,
        height: r.viewport.height,
        deviceScaleFactor: r.deviceScaleFactor,
        mobile: r.isMobile,
        screenWidth: r.screen.width,
        screenHeight: r.screen.height,
        screenOrientation: r.landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
      }],
      ['Emulation.setTouchEmulationEnabled', { enabled: r.hasTouch, maxTouchPoints: 5 }],
      ['Emulation.setUserAgentOverride', {
        userAgent: r.userAgent,
        platform: navigatorPlatform(r.userAgent),
        userAgentMetadata: userAgentMetadata(r.userAgent, r.isMobile),
      }],
    ], 'the tab is partly emulated');
  } catch (err: any) {
    if (err.partial) session.setDevice(r.profile);
    throw err;
  }
  session.setDevice(r.profile);
  return `Emulating ${describeDevice(r.profile)} on this tab: ${r.viewport.width}x${r.viewport.height} @${r.deviceScaleFactor}x, ` +
    `${r.hasTouch ? 'touch on' : 'no touch'}, ${r.isMobile ? 'mobile' : 'desktop'} user agent. Reload to rerun page scripts; $B device off restores.`;
}

/** Drop held fingers and clear the three overrides; Playwright's own viewport comes back. */
export async function clearDevice(session: TabSession): Promise<string> {
  const page = session.getPage();
  const had = session.getDevice();
  session.dropFingers();
  await sendAll(page, [
    ['Emulation.clearDeviceMetricsOverride', {}],
    ['Emulation.setTouchEmulationEnabled', { enabled: false }],
    ['Emulation.setUserAgentOverride', { userAgent: '' }],
  ], 'the tab is partly restored');
  session.setDevice(null);
  const viewport = page.viewportSize();
  if (viewport) await page.setViewportSize(viewport);
  return had ? `Device emulation off (was ${describeDevice(had)}); desktop size, mouse input and user agent restored` : 'No device was active on this tab';
}

/**
 * Playwright re-sends its own metrics after a full-page capture, which puts the
 * tab back at desktop size. Chromium skips a repeated identical override from
 * the same session, so clear ours first, then apply the phone again.
 */
export async function reassertDevice(session: TabSession): Promise<void> {
  const profile = session.getDevice();
  if (!profile) return;
  await sendAll(session.getPage(), [['Emulation.clearDeviceMetricsOverride', {}]], 'the tab is partly emulated');
  await applyDevice(session, profile);
}

/**
 * Screenshot that keeps a device tab at phone size. Playwright's own capture
 * clips to its desktop viewport and then re-sends that viewport, so a device
 * tab's viewport and full-page captures go through the tab's CDP session
 * (at the phone's pixel ratio); clip captures go through Playwright. Both
 * Playwright's capture and a full-page one drop parts of the emulation, so the
 * phone is put back afterwards.
 */
export async function screenshotTab(session: TabSession, opts: { path?: string; fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } }): Promise<Buffer> {
  const page = session.getPage();
  if (!session.getDevice()) return page.screenshot(opts);
  if (opts.clip) {
    const clipped = await page.screenshot(opts);
    await reassertDevice(session);
    return clipped;
  }
  const cdp = await tabCdpSession(page);
  const params: Record<string, unknown> = { format: 'png' };
  if (opts.fullPage) {
    const { cssContentSize } = await cdp.send('Page.getLayoutMetrics');
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height), scale: 1 };
  }
  const { data } = await cdp.send('Page.captureScreenshot', params);
  if (opts.fullPage) await reassertDevice(session);
  const buffer = Buffer.from(data, 'base64');
  if (opts.path) fs.writeFileSync(opts.path, buffer);
  return buffer;
}

export async function handleDeviceCommand(args: string[], session: TabSession): Promise<string> {
  const landscape = args.includes('--landscape');
  const unknownFlag = args.find((a) => a.startsWith('--') && a !== '--landscape' && a !== '--list');
  if (unknownFlag) throw new Error(`Usage: unknown device flag ${unknownFlag}.\nfix: $B device <name> [--landscape] | $B device off | $B device --list`);
  if (args.includes('--list')) return DEVICE_NAMES.join('\n');
  const name = args.filter((a) => a !== '--landscape').join(' ').trim();
  if (!name) return describeDevice(session.getDevice());
  if (['off', 'reset', 'auto'].includes(name.toLowerCase())) return clearDevice(session);
  const result = await applyDevice(session, { name, landscape });
  session.dropFingers();
  return result;
}
