/**
 * Per-session tabs (#1961) through the real command dispatch (server.ts
 * handleCommandInternal on the module's own BrowserManager). Four sessions
 * drive their own tabs at the same time; a slow fixture route forces the
 * commands to overlap instead of relying on scheduler timing. The first two
 * steps are the before: unsessioned callers share one tab, and the BROWSE_TAB
 * pin moved the global active tab for everyone else while it ran. Runs in a
 * child process so the module-level server state never touches this process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let dir = '';
let steps: Record<string, any> = {};

const SCRIPT = (root: string) => `
import { __testInternals__ } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/server.ts'))};
const fixture = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const u = new URL(req.url);
  const s = u.searchParams.get('s') || 'x';
  const ms = Number(u.searchParams.get('ms') || 0);
  if (ms) await Bun.sleep(ms);
  const html = '<!doctype html><title>' + s + '</title><h1>' + s + '</h1><input id="q" aria-label="query">'
    + '<button onclick="document.title = document.title + \\'-clicked\\'">Go ' + s + '</button>';
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
} });
const U = (s, ms = 0) => 'http://127.0.0.1:' + fixture.port + '/page?s=' + s + '&ms=' + ms;
const bm = __testInternals__.browserManager;
const run = (command, args = [], extra = {}, tokenInfo = null) => __testInternals__.handleCommandInternal({ command, args, ...extra }, tokenInfo);
const owned = (owner) => [...bm.pages.keys()].filter(id => bm.getTabOwner(id) === owner);
const steps = {};
await bm.launch();
await run('goto', [U('root')]);
const rootTab = bm.getActiveTabId();

{ // before: two unsessioned agents share the one active tab
  const a = run('goto', [U('a', 400)]);
  await Bun.sleep(100);
  const b = run('goto', [U('b')]);
  await Promise.all([a, b]);
  steps.shared = { title: (await run('js', ['document.title'])).result };
  await run('goto', [U('root')]);
}

{ // BROWSE_TAB pin: an unsessioned caller during the pinned command, and the global tab afterwards
  const t2 = JSON.parse((await run('newtab', ['--json'])).result).tabId;
  const t3 = JSON.parse((await run('newtab', ['--json'])).result).tabId;
  bm.switchTab(rootTab, { bringToFront: false });
  const pinned = run('goto', [U('p', 400)], { tabId: t2 });
  await Bun.sleep(100);
  const during = (await run('url')).result;
  await pinned;
  const p1 = run('goto', [U('p1', 200)], { tabId: t2 });
  await Bun.sleep(100);
  const p2 = run('goto', [U('p2', 400)], { tabId: t3 });
  await Promise.all([p1, p2]);
  steps.pin = { during, activeAfter: bm.getActiveTabId(), rootTab };
  await bm.closeTab(t2); await bm.closeTab(t3);
  bm.switchTab(rootTab, { bringToFront: false });
}

{ // four sessions at once, three rounds, overlapping on the slow route
  const names = ['a', 'b', 'c', 'd'];
  const seen = [];
  const flow = async (s, round) => {
    await run('goto', [U(s, 60 * (names.indexOf(s) + 1) + 40 * round)], { session: s });
    const snap = (await run('snapshot', ['-i'], { session: s })).result;
    await run('click', ['button'], { session: s });
    await run('fill', ['#q', 'hello-' + s], { session: s });
    const title = (await run('js', ['document.title'], { session: s })).result;
    const value = (await run('js', ["document.querySelector('#q').value"], { session: s })).result;
    seen.push({ s, round, snapOk: snap.includes('Go ' + s), title, value });
  };
  let unsessioned = '';
  for (let round = 0; round < 3; round++) {
    const all = Promise.all(names.map(s => flow(s, round)));
    await Bun.sleep(80);
    unsessioned = (await run('url')).result;
    await all;
  }
  steps.sessions = { seen, unsessioned, activeAfter: bm.getActiveTabId(), rootTab,
    tabsPer: names.map(s => owned('session:' + s).length) };
}

{ // first use from four parallel commands opens one tab
  await Promise.all([1, 2, 3, 4].map(() => run('url', [], { session: 'e' })));
  steps.firstUse = { tabs: owned('session:e').length };
}

{ // chain subcommands stay on the session tab
  const r = await run('chain', [JSON.stringify([['goto', U('ch', 200)], ['js', 'document.title']])], { session: 'a' });
  steps.chain = { result: r.result, rootUrl: (await run('url')).result };
}

{ // per-session newtab and tabs
  await run('newtab', [U('n2')], { session: 'c' });
  steps.newtab = { title: (await run('js', ['document.title'], { session: 'c' })).result,
    tabsC: owned('session:c').length, activeAfter: bm.getActiveTabId(), rootTab,
    tabs: (await run('tabs', [], { session: 'c' })).result };
}

{ // a closed session tab: reads fail with the reset code, goto reopens
  const id = owned('session:a')[0];
  await bm.closeTab(id);
  const text = await run('text', [], { session: 'a' });
  const goto = await run('goto', [U('a2')], { session: 'a' });
  steps.reset = { textStatus: text.status, text: text.result, gotoStatus: goto.status, goto: goto.result,
    title: (await run('js', ['document.title'], { session: 'a' })).result };
}

{ // context recreation keeps the session's page
  await run('goto', [U('rb')], { session: 'b' });
  const ua = await run('useragent', ['Mozilla/5.0 gstack-session-test'], { session: 'b' });
  steps.rebuild = { uaStatus: ua.status, url: (await run('url', [], { session: 'b' })).result, tabsB: owned('session:b').length };
}

{ // context recreation under a tab pin keeps every tab and the global active tab
  const home = bm.getActiveTabId();
  const t = JSON.parse((await run('newtab', [U('pinrb'), '--json'])).result).tabId;
  bm.switchTab(home, { bringToFront: false });
  const before = bm.pages.size;
  const ua = await run('useragent', ['Mozilla/5.0 gstack-pin-test'], { tabId: t });
  const pinned = [...bm.pages.entries()].find(([, p]) => p.url().includes('s=pinrb'))?.[0];
  steps.pinRebuild = { status: ua.status, result: ua.result, before, after: bm.pages.size, rootUrl: (await run('url')).result,
    pinnedUrl: pinned === undefined ? null : (await run('url', [], { tabId: pinned })).result };
  if (pinned !== undefined) await bm.closeTab(pinned);
}

{ // only root may name a session; names are validated
  const scoped = { token: 't', clientId: 'agent-x', type: 'session', scopes: ['read', 'write', 'admin', 'meta'], tabPolicy: 'shared', rateLimit: 0, createdAt: new Date().toISOString(), commandCount: 0 };
  const denied = await run('url', [], { session: 'z' }, scoped);
  const bad = await run('url', [], { session: 'bad name!' });
  steps.auth = { deniedStatus: denied.status, denied: denied.result, zTabs: owned('session:z').length, badStatus: bad.status, bad: bad.result };
}

{ // idle sessions are closed on the next session lookup
  process.env.BROWSE_SESSION_IDLE_MINUTES = '0.01';
  await Bun.sleep(1200);
  await run('url', [], { session: 'fresh' });
  steps.sweep = { a: owned('session:a').length, d: owned('session:d').length, fresh: owned('session:fresh').length };
}

{ // a session the CLI derived on its own is ignored for a scoped token
  const scoped = { token: 't', clientId: 'agent-y', type: 'session', scopes: ['read', 'write', 'admin', 'meta'], tabPolicy: 'shared', rateLimit: 0, createdAt: new Date().toISOString(), commandCount: 0 };
  const auto = await run('url', [], { session: 'auto1', sessionAuto: true }, scoped);
  steps.auto = { status: auto.status, tabs: owned('session:auto1').length };
}

{ // the session cap: refused while every other session is busy, LRU eviction once one is idle
  process.env.BROWSE_SESSION_IDLE_MINUTES = '0';
  process.env.BROWSE_MAX_SESSIONS = '1';
  const busy = run('goto', [U('busy', 600)], { session: 'fresh' });
  await Bun.sleep(150);
  const limited = await run('url', [], { session: 'limit' });
  await busy;
  const freshTab = owned('session:fresh')[0];
  const evicted = await run('url', [], { session: 'limit2' });
  steps.limit = { status: limited.status, result: limited.result, limitTabs: owned('session:limit').length,
    evictedStatus: evicted.status, fresh: owned('session:fresh').length, freshOpen: bm.pages.has(freshTab),
    limit2: owned('session:limit2').length };
  process.env.BROWSE_MAX_SESSIONS = '16';
  const victim = await run('url', [], { session: 'fresh' });
  steps.evictedRead = { status: victim.status, result: victim.result, tabs: owned('session:fresh').length };
  await run('goto', [U('back')], { session: 'fresh' });
  steps.evictedRead.reopened = (await run('js', ['document.title'], { session: 'fresh' })).result;
  process.env.BROWSE_MAX_SESSIONS = '1';
}

{ // in headed mode an evicted session's tab is released to the user, not closed
  const tab = owned('session:limit2')[0];
  const mode = bm.getConnectionMode;
  bm.getConnectionMode = () => 'headed';
  try { await run('url', [], { session: 'limit3' }); } finally { bm.getConnectionMode = mode; }
  steps.headed = { open: bm.pages.has(tab), owner: bm.getTabOwner(tab) ?? null, limit2: owned('session:limit2').length };
}

{ // tab <id> inside a session sticks for the session's next command
  await run('goto', [U('mine')], { session: 'pick' });
  const other = JSON.parse((await run('newtab', [U('theirs'), '--json'])).result).tabId;
  const switched = await run('tab', [String(other)], { session: 'pick' });
  const next = (await run('js', ['document.title'], { session: 'pick' })).result;
  steps.pick = { switched: switched.status, next, owner: bm.getTabOwner(other) ?? null };
}

{ // another session's context rebuild leaves this session on the tab it picked
  process.env.BROWSE_MAX_SESSIONS = '16';
  await run('goto', [U('first')], { session: 'two' });
  const first = owned('session:two')[0];
  await run('newtab', [U('second')], { session: 'two' });
  await run('tab', [String(first)], { session: 'two' });
  const ua = await run('useragent', ['Mozilla/5.0 gstack-other-rebuild'], { session: 'other' });
  steps.otherRebuild = { ua: ua.status, title: (await run('js', ['document.title'], { session: 'two' })).result };
}

{ // a first-use notice never prefixes --json output
  const r = await run('newtab', [U('j'), '--json'], { session: 'jsonfirst' });
  let parsed = null;
  try { parsed = JSON.parse(r.result); } catch {}
  steps.jsonFirst = { status: r.status, parsed: parsed !== null && typeof parsed.tabId === 'number' };
}

{ // headed mode: a session's new tab is registered once and the user's active tab stays put
  const ctx = bm.context;
  const listener = (page) => {
    const id = bm.nextTabId++;
    bm.pages.set(id, page);
    bm.tabSessions.set(id, new (bm.tabSessions.values().next().value.constructor)(page));
    bm.activeTabId = id;
  };
  ctx.on('page', listener);
  const userTab = bm.getActiveTabId();
  const before = bm.pages.size;
  try { await run('url', [], { session: 'headednew' }); } finally { ctx.off('page', listener); }
  const tab = owned('session:headednew')[0];
  steps.headedNew = { activeKept: bm.getActiveTabId() === userTab, added: bm.pages.size - before,
    sameObject: [...bm.pages.values()].filter(p => p === bm.pages.get(tab)).length };
}

{ // headed viewport auto under a tab pin rebuilds the pinned tab, not the global one
  const userTab = bm.getActiveTabId();
  const userPage = bm.pages.get(userTab);
  const pinned = JSON.parse((await run('newtab', [U('vp'), '--json'])).result).tabId;
  bm.switchTab(userTab, { bringToFront: false });
  const mode = bm.connectionMode;
  bm.connectionMode = 'headed';
  let r;
  try { r = await run('viewport', ['auto'], { tabId: pinned }); } finally { bm.connectionMode = mode; }
  steps.headedViewport = { status: r.status, userTracked: bm.pages.get(userTab) === userPage,
    pinnedLive: bm.pages.has(pinned), pinnedUrl: bm.pages.get(pinned)?.url() ?? null };
}

{ // state save and load inside a session land the session on its own saved page
  await run('goto', [U('st')], { session: 'st' });
  const save = await run('state', ['save', 'gsta227-session'], { session: 'st' });
  const load = await run('state', ['load', 'gsta227-session'], { session: 'st' });
  const after = await run('js', ['document.title'], { session: 'st' });
  steps.stateLoad = { save: save.status, load: load.status, loadText: load.result, afterStatus: after.status, title: after.result,
    rootStatus: (await run('url')).status };
}

await Bun.write(${JSON.stringify(path.join(root, 'steps.json'))}, JSON.stringify(steps));
fixture.stop(true);
await Promise.race([bm.close(), Bun.sleep(3000)]);
process.exit(0);
`;

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browse-session-tabs-')));
  fs.writeFileSync(path.join(dir, 'drive.ts'), SCRIPT(dir));
  const r = spawnSync(process.execPath, [path.join(dir, 'drive.ts')], {
    encoding: 'utf8', timeout: 150_000,
    env: { ...process.env, GSTACK_HOME: path.join(dir, 'state'), CHROMIUM_PROFILE: path.join(dir, 'profile'),
      BROWSE_STATE_FILE: path.join(dir, 'state', 'browse.json'), BROWSE_PARENT_PID: '0' },
  });
  if (!fs.existsSync(path.join(dir, 'steps.json'))) throw new Error(`driver failed (${r.status}): ${r.stderr.slice(-2000)}`);
  steps = JSON.parse(fs.readFileSync(path.join(dir, 'steps.json'), 'utf8'));
}, 180_000);
afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe('before: callers without a session share one tab', () => {
  test('the second agent navigates the first agent away (negative control)', () => {
    expect(steps.shared.title).toBe('b');
  });
});

describe('a pinned tab no longer moves the global active tab', () => {
  test('an unsessioned caller during a pinned command still sees its own tab', () => {
    expect(steps.pin.during).toContain('s=root');
  });
  test('overlapping pinned commands leave the global active tab where it was', () => {
    expect(steps.pin.activeAfter).toBe(steps.pin.rootTab);
  });
});

describe('four sessions at once (#1961)', () => {
  test('every session only ever sees its own page', () => {
    expect(steps.sessions.seen).toHaveLength(12);
    for (const row of steps.sessions.seen) {
      expect(row).toMatchObject({ snapOk: true, title: row.s + '-clicked', value: 'hello-' + row.s });
    }
  });
  test('each session owns one tab and the global active tab is untouched', () => {
    expect(steps.sessions.tabsPer).toEqual([1, 1, 1, 1]);
    expect(steps.sessions.activeAfter).toBe(steps.sessions.rootTab);
    expect(steps.sessions.unsessioned).toContain('s=root');
  });
  test('parallel first commands of one session open a single tab', () => {
    expect(steps.firstUse.tabs).toBe(1);
  });
  test('chain subcommands run on the session tab', () => {
    expect(steps.chain.result).toContain('ch');
    expect(steps.chain.rootUrl).toContain('s=root');
  });
  test('newtab inside a session moves only that session', () => {
    expect(steps.newtab).toMatchObject({ title: 'n2', tabsC: 2 });
    expect(steps.newtab.activeAfter).toBe(steps.newtab.rootTab);
    expect(steps.newtab.tabs).toContain('session:c');
  });
});

describe('session lifecycle', () => {
  test('a read on a closed session tab fails with the last URL; goto reopens it', () => {
    expect(steps.reset.textStatus).not.toBe(200);
    expect(steps.reset.text).toContain('BROWSE_SESSION_TAB_RESET');
    expect(steps.reset.text).toContain('s=ch');
    expect(steps.reset.gotoStatus).toBe(200);
    expect(steps.reset.title).toBe('a2');
  });
  test('context recreation keeps the session on its page', () => {
    expect(steps.rebuild.uaStatus).toBe(200);
    expect(steps.rebuild.url).toContain('s=rb');
    expect(steps.rebuild.tabsB).toBe(1);
  });
  test('context recreation under a tab pin keeps every tab', () => {
    expect(steps.pinRebuild.status).toBe(200);
    expect(steps.pinRebuild.result).not.toContain('Browser reset');
    expect(steps.pinRebuild.after).toBe(steps.pinRebuild.before);
    expect(steps.pinRebuild.rootUrl).toContain('s=root');
    expect(steps.pinRebuild.pinnedUrl).toContain('s=pinrb');
  });
  test('a scoped token cannot name a session and opens no tab', () => {
    expect(steps.auth.deniedStatus).toBe(403);
    expect(steps.auth.denied).toContain('BROWSE_SESSION_ROOT_ONLY');
    expect(steps.auth.zTabs).toBe(0);
  });
  test('an invalid session name is refused', () => {
    expect(steps.auth.badStatus).toBe(400);
    expect(steps.auth.bad).toContain('BROWSE_SESSION_INVALID');
  });
  test('idle sessions are closed on the next lookup', () => {
    expect(steps.sweep).toEqual({ a: 0, d: 0, fresh: 1 });
  });
  test('an automatic session from a scoped token falls through and opens no tab', () => {
    expect(steps.auto).toEqual({ status: 200, tabs: 0 });
  });
  test('at the cap a new session is refused while the others are busy', () => {
    expect(steps.limit.status).toBe(429);
    expect(steps.limit.result).toContain('BROWSE_SESSION_LIMIT');
    expect(steps.limit.limitTabs).toBe(0);
  });
  test('at the cap the least recently used idle session is evicted', () => {
    expect(steps.limit).toMatchObject({ evictedStatus: 200, fresh: 0, freshOpen: false, limit2: 1 });
  });
  test('tab <id> in a session moves that session to the tab for its next command', () => {
    expect(steps.pick).toEqual({ switched: 200, next: 'theirs', owner: null });
  });
  test('a session evicted at the cap reports the reset on its next read; goto reopens it', () => {
    expect(steps.evictedRead.status).toBe(409);
    expect(steps.evictedRead.result).toContain('BROWSE_SESSION_TAB_RESET');
    expect(steps.evictedRead.result).toContain('s=busy');
    expect(steps.evictedRead.tabs).toBe(0);
    expect(steps.evictedRead.reopened).toBe('back');
  });
  test('another session\'s context rebuild keeps this session on the tab it picked', () => {
    expect(steps.otherRebuild).toEqual({ ua: 200, title: 'first' });
  });
  test('the first-use notice never corrupts --json output', () => {
    expect(steps.jsonFirst).toEqual({ status: 200, parsed: true });
  });
  test('headed: a session tab is registered once and the user keeps the active tab', () => {
    expect(steps.headedNew).toEqual({ activeKept: true, added: 1, sameObject: 1 });
  });
  test('headed: viewport auto under a tab pin rebuilds only the pinned tab', () => {
    expect(steps.headedViewport).toMatchObject({ status: 200, userTracked: true, pinnedLive: true });
    expect(steps.headedViewport.pinnedUrl).toContain('s=vp');
  });
  test('state save and load inside a session leave it on its saved page', () => {
    expect(steps.stateLoad).toMatchObject({ save: 200, load: 200, afterStatus: 200, title: 'st', rootStatus: 200 });
  });
  test('in headed mode an evicted session keeps its tab open and unowned', () => {
    expect(steps.headed).toEqual({ open: true, owner: null, limit2: 0 });
  });
});
