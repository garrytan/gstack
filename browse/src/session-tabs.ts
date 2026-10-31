/**
 * Per-session tabs for agents sharing one browse daemon (#1961).
 *
 * A request that names a session runs inside BrowserManager.runInTab with a
 * scope owned by `session:<name>`: the session's first command opens its own
 * tab, and every later command, chain subcommand included, resolves to that
 * tab without moving the daemon's global active tab. Sessions isolate tab
 * routing only; cookies and storage stay shared by every tab in the browser.
 * Only the root token may name a session, so a paired or tunnel agent cannot
 * open tabs through it (a session the CLI derived on its own is ignored for
 * them instead). A request that names a tab id runs in the same kind of
 * scope with no owner, which replaces the old switch-then-restore pin.
 */
import type { BrowserManager, TabScope } from './browser-manager';
import type { TokenInfo } from './token-registry';
import { resultLine } from '../../lib/result-codes';

interface Result { status: number; result: string; json?: boolean; headers?: Record<string, string> }

interface SessionRecord extends TabScope {
  owner: string;
  lastUsed: number;
  inFlight: number;
  lastUrl: string;
  opening: Promise<void> | null;
}

const SESSION_NAME = /^[A-Za-z0-9._:-]{1,64}$/;
const REOPENING_COMMANDS = new Set(['goto', 'newtab']);
const DAEMON_COMMANDS = new Set(['status', 'stop', 'restart']);
const DEFAULT_IDLE_MINUTES = 120;
const DEFAULT_MAX_SESSIONS = 16;

const sessions = new Map<string, SessionRecord>();

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function refuse(status: number, line: string): Result {
  return { status, json: true, result: JSON.stringify({ error: line }) };
}

/** Close (headless) or release (headed) every tab of sessions idle past BROWSE_SESSION_IDLE_MINUTES (0 = never). */
async function sweepIdle(bm: BrowserManager, now: number, keep: string): Promise<void> {
  const idleMinutes = numberFromEnv('BROWSE_SESSION_IDLE_MINUTES', DEFAULT_IDLE_MINUTES);
  if (idleMinutes === 0) return;
  for (const [name, record] of sessions) {
    if (name === keep || record.inFlight > 0 || now - record.lastUsed < idleMinutes * 60_000) continue;
    await dropSession(bm, name, record);
  }
}

async function dropSession(bm: BrowserManager, name: string, record: SessionRecord): Promise<void> {
  sessions.delete(name);
  if (bm.getConnectionMode() === 'headed') {
    bm.releaseClientTabs(record.owner);
    return;
  }
  for (const id of bm.tabsOwnedBy(record.owner)) await bm.closeTab(id).catch(() => {});
}

/** Make room for session `name` by dropping the least recently used idle session. */
async function makeRoom(bm: BrowserManager, name: string): Promise<boolean> {
  const others = [...sessions].filter(([n]) => n !== name);
  if (others.length < numberFromEnv('BROWSE_MAX_SESSIONS', DEFAULT_MAX_SESSIONS)) return true;
  const idle = others.filter(([, r]) => r.inFlight === 0 && !r.opening).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
  if (!idle) return false;
  await dropSession(bm, idle[0], idle[1]);
  return true;
}

/** Open the session's tab once; concurrent first commands share the same promise. */
function openTab(bm: BrowserManager, name: string, record: SessionRecord): Promise<void> {
  record.opening ??= (async () => {
    if (!(await makeRoom(bm, name))) throw new Error('limit');
    await bm.runInTab(record, () => bm.newTab(undefined, record.owner));
  })().finally(() => { record.opening = null; });
  return record.opening;
}

async function runInSession<R extends Result>(bm: BrowserManager, name: string, command: string, fn: () => Promise<R>): Promise<Result> {
  const now = Date.now();
  await sweepIdle(bm, now, name);
  let record = sessions.get(name);
  let notice = '';
  try {
    if (!record) {
      record = { tabId: 0, owner: `session:${name}`, lastUsed: now, inFlight: 0, lastUrl: '', opening: null };
      sessions.set(name, record);
      await openTab(bm, name, record);
      notice = `[browse] session ${name} → tab ${record.tabId}`;
    } else if (record.opening) {
      await record.opening;
    } else if (!bm.hasTab(bm.resolveScopeTab(record))) {
      if (!REOPENING_COMMANDS.has(command)) {
        const last = record.lastUrl || 'about:blank';
        return refuse(409, resultLine('browse', 'BROWSE_SESSION_TAB_RESET', `session ${name}'s tab ${record.tabId} was closed; it was on ${last}`));
      }
      await openTab(bm, name, record);
      notice = `[browse] session ${name}: its tab was closed, so this runs on new tab ${record.tabId}`;
    }
  } catch (err: any) {
    if (record && !bm.hasTab(bm.resolveScopeTab(record))) sessions.delete(name);
    if (err?.message !== 'limit') throw err;
    return refuse(429, resultLine('browse', 'BROWSE_SESSION_LIMIT', `${sessions.size} sessions are running a command`));
  }
  record.inFlight++;
  record.lastUsed = Date.now();
  try {
    const cr = await bm.runInTab(record, fn);
    return notice && !cr.json ? { ...cr, result: `${notice}\n${cr.result}` } : cr;
  } finally {
    record.inFlight--;
    record.lastUsed = Date.now();
    record.lastUrl = bm.tabUrl(bm.resolveScopeTab(record)) ?? record.lastUrl;
  }
}

/**
 * Run one command on the tab its request names: `tabId` first (BROWSE_TAB,
 * --tab-id), then `session`. A request naming neither runs in whatever scope
 * it was called from, so chain subcommands inherit their parent's tab.
 */
export async function runInRequestTab<R extends Result>(
  bm: BrowserManager,
  body: { command: string; tabId?: number; session?: string; sessionAuto?: boolean },
  tokenInfo: TokenInfo | null | undefined,
  fn: () => Promise<R>,
): Promise<Result> {
  if (typeof body.tabId === 'number') {
    if (bm.hasTab(body.tabId)) return bm.runInTab({ tabId: body.tabId }, fn);
    console.warn('[browse] Failed to pin tab', body.tabId, ': not found');
    return fn();
  }
  if (body.session === undefined || body.session === null || body.session === '' || DAEMON_COMMANDS.has(body.command)) return fn();
  if (tokenInfo && tokenInfo.clientId !== 'root') {
    if (body.sessionAuto) return fn();
    return refuse(403, resultLine('browse', 'BROWSE_SESSION_ROOT_ONLY', `client ${tokenInfo.clientId}`));
  }
  const name = String(body.session);
  if (!SESSION_NAME.test(name)) {
    return refuse(400, resultLine('browse', 'BROWSE_SESSION_INVALID', JSON.stringify(name.slice(0, 80))));
  }
  return runInSession(bm, name, body.command, fn);
}
