/**
 * Touch input for phone-emulated tabs (`$B tap|swipe|pinch|touch`, #3058).
 * Everything goes through Input.dispatchTouchEvent on the tab's own CDP
 * session (the one device-emulation.ts set up), so it needs `$B device` first.
 *
 *   held fingers (touch down 0-9) ── TabSession.heldFingers()
 *   gesture fingers (tap/swipe/pinch) use ids 10+, added beside held ones
 *
 * Chromium 151 dispatches an event only for the points it lists: touchStart
 * with the new finger, touchMove with the moved ones, touchEnd with the lifted
 * one (measured: a touchMove that omits a finger does not release it). Fingers
 * not listed stay down, which is what multi-finger chords need. Gestures on one
 * tab run one at a time (TabSession.runGesture).
 */

import type { TabSession } from './tab-session';
import { tabCdpSession } from './device-emulation';
import { resultLine } from '../../lib/result-codes';

type Point = { x: number; y: number };
type Points = Map<number, Point>;

const GESTURE_ID = 10;
const STEPS = 10;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function usage(problem: string, fix: string): Error {
  return new Error(`Usage: ${problem}\nfix: ${fix}`);
}

async function dispatch(session: TabSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Points): Promise<void> {
  const cdp = await tabCdpSession(session.getPage());
  session.setFingerCancel(() => {
    cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {});
  });
  const touchPoints = [...points].map(([id, p]) => ({ id, x: p.x, y: p.y, radiusX: 1, radiusY: 1, force: 1 }));
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
}

function parseNumber(raw: string | undefined, what: string, fix: string): number {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n)) throw usage(`${what} must be a number, got "${raw ?? ''}".`, fix);
  return n;
}

function flag(args: string[], name: string, fallback: number, fix: string): number {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const n = parseNumber(args[i + 1], name, fix);
  if (n < 0 || n > 10000) throw usage(`${name} must be between 0 and 10000, got ${n}.`, fix);
  args.splice(i, 2);
  return n;
}

/** `<@ref|selector|x y>` → a viewport point; element targets scroll into view first. */
async function resolvePoint(session: TabSession, args: string[], fix: string): Promise<Point> {
  const [a, b] = args;
  if (!a) throw usage('missing target (@ref, selector, or x y).', fix);
  if (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && b !== undefined && b !== '') {
    args.splice(0, 2);
    return { x: Number(a), y: Number(b) };
  }
  args.splice(0, 1);
  const resolved = await session.resolveRef(a);
  const locator = 'locator' in resolved ? resolved.locator : session.getActiveFrameOrPage().locator(resolved.selector).first();
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
  const box = await locator.boundingBox();
  if (!box) throw usage(`${a} has no visible box to touch.`, `$B snapshot -i, then target a visible element`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function viewportClamp(session: TabSession): Promise<(p: Point) => Point> {
  const [w, h] = await session.getPage().evaluate(() => [innerWidth, innerHeight]);
  return (p) => ({ x: Math.min(Math.max(p.x, 0), w - 1), y: Math.min(Math.max(p.y, 0), h - 1) });
}

/** Press gesture fingers at `from`, move them to `to` in STEPS moves over `ms`, lift them; held fingers stay down. */
async function stroke(session: TabSession, from: Points, to: Points, ms: number): Promise<void> {
  await dispatch(session, 'touchStart', from);
  let at: Points = from;
  for (let i = 1; i <= STEPS; i++) {
    await sleep(ms / STEPS);
    at = new Map([...from].map(([id, a]) => {
      const b = to.get(id)!;
      return [id, { x: a.x + (b.x - a.x) * i / STEPS, y: a.y + (b.y - a.y) * i / STEPS }];
    }));
    await dispatch(session, 'touchMove', at);
  }
  await dispatch(session, 'touchEnd', at);
}

const fmt = (p: Point) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;

async function tap(session: TabSession, args: string[]): Promise<string> {
  const fix = '$B tap <@ref|selector|x y> [--hold <ms>]';
  const hold = flag(args, '--hold', 0, fix);
  const point = await resolvePoint(session, args, fix);
  const finger: Points = new Map([[GESTURE_ID, point]]);
  await dispatch(session, 'touchStart', finger);
  if (hold) await sleep(hold);
  await dispatch(session, 'touchEnd', finger);
  return `Tapped ${fmt(point)}${hold ? ` held ${hold}ms` : ''}`;
}

async function swipe(session: TabSession, args: string[]): Promise<string> {
  const fix = '$B swipe <@ref|selector|x y> <up|down|left|right> [--distance <px>] [--ms <n>]';
  const distance = flag(args, '--distance', 300, fix);
  const ms = flag(args, '--ms', 300, fix);
  const start = await resolvePoint(session, args, fix);
  const direction = args[0];
  const delta: Record<string, Point> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  const unit = direction ? delta[direction] : undefined;
  if (!unit || args.length > 1) throw usage(`swipe direction must be up|down|left|right, got "${args.join(' ')}".`, fix);
  const clamp = await viewportClamp(session);
  const end = clamp({ x: start.x + unit.x * distance, y: start.y + unit.y * distance });
  await stroke(session, new Map([[GESTURE_ID, start]]), new Map([[GESTURE_ID, end]]), ms);
  const moved = Math.round(Math.hypot(end.x - start.x, end.y - start.y));
  return `Swiped ${direction} ${moved}px from ${fmt(start)} in ${ms}ms${moved < distance ? ' (stopped at the viewport edge)' : ''}`;
}

async function pinch(session: TabSession, args: string[]): Promise<string> {
  const fix = '$B pinch <@ref|selector|x y> <scale>  (2 spreads two fingers apart, 0.5 pinches them together)';
  const centre = await resolvePoint(session, args, fix);
  const scale = parseNumber(args[0], 'pinch scale', fix);
  if (scale <= 0 || scale > 10 || args.length > 1) throw usage(`pinch scale must be one number above 0 and at most 10, got "${args.join(' ')}".`, fix);
  const clamp = await viewportClamp(session);
  const startHalf = scale >= 1 ? 40 : 40 / scale;
  const at = (half: number) => new Map([
    [GESTURE_ID, clamp({ x: centre.x - half, y: centre.y })],
    [GESTURE_ID + 1, clamp({ x: centre.x + half, y: centre.y })],
  ]);
  await stroke(session, at(startHalf), at(startHalf * scale), 300);
  return `Pinched at ${fmt(centre)} to scale ${scale}`;
}

function fingerArg(raw: string | undefined, fix: string): number {
  const finger = Number(raw);
  if (!Number.isInteger(finger) || finger < 0 || finger > 9) throw usage(`finger must be 0-9, got "${raw ?? ''}".`, fix);
  return finger;
}

function listFingers(held: Points): string {
  if (held.size === 0) return 'Held fingers: none';
  return 'Held fingers:\n' + [...held].map(([f, p]) => `  finger ${f} at ${fmt(p)}`).join('\n');
}

async function touch(session: TabSession, args: string[]): Promise<string> {
  const fix = '$B touch down|move <finger 0-9> <x> <y> | $B touch up <finger> | $B touch cancel | $B touch';
  const held = session.heldFingers();
  const [sub, rawFinger, rawX, rawY] = args;
  if (!sub) return listFingers(held);
  if (sub === 'cancel') {
    if (held.size === 0) return 'No fingers held; nothing to cancel';
    const cdp = await tabCdpSession(session.getPage());
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    held.clear();
    return 'Cancelled all held fingers';
  }
  if (!['down', 'move', 'up'].includes(sub)) throw usage(`unknown touch action "${sub}".`, fix);
  const finger = fingerArg(rawFinger, fix);
  if (sub === 'down' && held.has(finger)) throw usage(`finger ${finger} is already down.`, `$B touch move ${finger} <x> <y> or $B touch up ${finger}`);
  if (sub !== 'down' && !held.has(finger)) {
    throw usage(`finger ${finger} is not down (${listFingers(held).toLowerCase()}).`, `$B touch down ${finger} <x> <y>`);
  }
  if (sub === 'up') {
    await dispatch(session, 'touchEnd', new Map([[finger, held.get(finger)!]]));
    held.delete(finger);
    return `Finger ${finger} up; ${listFingers(held).toLowerCase()}`;
  }
  const point = { x: parseNumber(rawX, 'x', fix), y: parseNumber(rawY, 'y', fix) };
  await dispatch(session, sub === 'down' ? 'touchStart' : 'touchMove', new Map([[finger, point]]));
  held.set(finger, point);
  return `Finger ${finger} ${sub} at ${fmt(point)}`;
}

export const TOUCH_COMMANDS = new Set(['tap', 'swipe', 'pinch', 'touch']);

export async function handleTouchCommand(command: string, args: string[], session: TabSession): Promise<string> {
  if (!session.getDevice()) {
    throw new Error(resultLine('browse', 'BROWSE_TOUCH_NO_DEVICE', `$B ${command} on this tab`));
  }
  const rest = [...args];
  const run = { tap, swipe, pinch, touch }[command as 'tap' | 'swipe' | 'pinch' | 'touch'];
  return session.runGesture(() => run(session, rest));
}
