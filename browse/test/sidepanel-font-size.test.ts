import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// Sidebar terminal text-size picker. Runs the real sidepanel-terminal.js in a
// VM with a fake DOM, xterm, WebSocket and chrome.storage, drives one
// auto-connect to a live terminal, and checks the size the terminal is created
// with, what persists, and that a live change re-fits and resizes the PTY.

const TERMINAL_JS = path.resolve(
  import.meta.path, '..', '..', '..', 'extension', 'sidepanel-terminal.js',
);
const SIDEPANEL_HTML = path.resolve(
  import.meta.path, '..', '..', '..', 'extension', 'sidepanel.html',
);

function fakeElement() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const el: any = {
    style: {},
    textContent: '',
    value: '',
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(type: string, fn: (e: unknown) => void) { (listeners[type] ||= []).push(fn); },
    dispatch(type: string) { for (const fn of listeners[type] || []) fn({ target: el }); },
  };
  return el;
}

async function bootSidebar(stored: Record<string, unknown>) {
  const elements = new Map<string, any>();
  const terminals: any[] = [];
  const sent: string[] = [];
  const frames: Array<() => void> = [];
  const store = { ...stored };

  class FakeTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      terminals.push(this);
    }
    loadAddon() {}
    open() {}
    onData() {}
    refresh() {}
  }
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    binaryType = '';
    send(msg: unknown) { if (typeof msg === 'string') sent.push(msg); }
    addEventListener() {}
    close() {}
  }
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  const ctx: any = {
    console,
    TextEncoder,
    Response,
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
    },
    Terminal: FakeTerminal,
    FitAddon: { FitAddon: class { fit() {} } },
    WebSocket: FakeWebSocket,
    ResizeObserver: class { observe() {} },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval() {},
    clearTimeout() {},
    fetch: async (url: string) =>
      url.endsWith('/pty-session')
        ? json({ terminalPort: 4000, sessionId: 'sess', attachToken: 'tok' })
        : json({ available: true }),
    chrome: {
      storage: {
        local: {
          get(_keys: string[], cb: (r: Record<string, unknown>) => void) { cb({ ...store }); },
          set(items: Record<string, unknown>) { Object.assign(store, items); },
        },
      },
      runtime: { sendMessage() {} },
    },
    gstackServerPort: 34567,
    gstackAuthToken: 'auth',
  };
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(TERMINAL_JS, 'utf-8'), ctx);
  for (let i = 0; i < 50 && terminals.length === 0; i++) await new Promise((r) => setImmediate(r));
  expect(terminals).toHaveLength(1);

  const flushFrames = () => { for (const fn of frames.splice(0)) fn(); };
  return { term: terminals[0], picker: elements.get('terminal-fontsize'), store, sent, flushFrames };
}

describe('sidebar terminal text size', () => {
  test('defaults to 13px (sm) when nothing is stored', async () => {
    const { term, picker } = await bootSidebar({});
    expect(term.options.fontSize).toBe(13);
    expect(picker.value).toBe('sm');
  });

  test('creates the terminal at the stored size; an unknown stored value falls back to sm', async () => {
    const large = await bootSidebar({ terminalFontSize: 'lg' });
    expect(large.term.options.fontSize).toBe(17);
    expect(large.picker.value).toBe('lg');

    const bogus = await bootSidebar({ terminalFontSize: 'huge' });
    expect(bogus.term.options.fontSize).toBe(13);
    expect(bogus.picker.value).toBe('sm');
  });

  test('a live change persists, resizes xterm, and re-sends PTY size after the font re-measures', async () => {
    const { term, picker, store, sent, flushFrames } = await bootSidebar({});
    flushFrames();
    sent.length = 0;

    picker.value = 'xl';
    picker.dispatch('change');
    expect(store.terminalFontSize).toBe('xl');
    expect(term.options.fontSize).toBe(20);
    expect(sent).toEqual([]);

    flushFrames();
    flushFrames();
    expect(sent.map((m) => JSON.parse(m))).toContainEqual({ type: 'resize', cols: 80, rows: 24 });
  });

  test('the toolbar picker offers every size with sm preselected', () => {
    const html = fs.readFileSync(SIDEPANEL_HTML, 'utf-8');
    const select = html.match(/<select id="terminal-fontsize"[\s\S]*?<\/select>/)?.[0] ?? '';
    expect([...select.matchAll(/value="(\w+)"/g)].map((m) => m[1])).toEqual(['xs', 'sm', 'md', 'lg', 'xl']);
    expect(select).toContain('<option value="sm" selected>');
  });
});
