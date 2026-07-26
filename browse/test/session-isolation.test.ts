/**
 * Session isolation tests (agent-browser U4).
 *
 * Fast, deterministic proof that per-session state does not cross-contaminate —
 * driven with fake pages via the same private-method pattern the memory-leak
 * reproducer uses, so no real Chromium launch is required. Covers the crux
 * invariant: an async page event must write to the buffers of the session that
 * OWNED the page at wire-time, even after the active session has switched.
 */

import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'events';

import { BrowserManager, DEFAULT_SESSION_ID } from '../src/browser-manager';

function makeFakePage(): any {
  const page = new EventEmitter() as any;
  page.url = () => 'https://example.invalid/';
  page.mainFrame = () => ({});
  return page;
}

function wire(bm: BrowserManager, page: unknown): void {
  (bm as unknown as { wirePageEvents: (p: unknown) => void }).wirePageEvents.bind(bm)(page);
}

describe('U4 session isolation — buffers', () => {
  it('console events land in the OWNING session, not the active one', () => {
    const bm = new BrowserManager();

    // Wire a page under the default session.
    const defaultPage = makeFakePage();
    wire(bm, defaultPage);

    // Wire a second page under session "s2".
    bm.setCurrentSession('s2');
    const s2Page = makeFakePage();
    wire(bm, s2Page);

    // Now, with s2 active, fire a console event on the DEFAULT-owned page.
    // The owner was captured at wire-time, so it must land in default's buffer.
    defaultPage.emit('console', { type: () => 'log', text: () => 'from-default' });
    s2Page.emit('console', { type: () => 'log', text: () => 'from-s2' });

    bm.setCurrentSession(DEFAULT_SESSION_ID);
    const defaultConsole = bm.getBuffers().consoleBuffer.toArray().map((entry) => entry.text);
    bm.setCurrentSession('s2');
    const s2Console = bm.getBuffers().consoleBuffer.toArray().map((entry) => entry.text);

    expect(defaultConsole).toEqual(['from-default']);
    expect(s2Console).toEqual(['from-s2']);
  });

  it('network events are isolated per owning session', () => {
    const bm = new BrowserManager();
    const p1 = makeFakePage();
    wire(bm, p1);
    bm.setCurrentSession('s2');
    const p2 = makeFakePage();
    wire(bm, p2);

    p1.emit('request', { url: () => 'https://a/1', method: () => 'GET' });
    p2.emit('request', { url: () => 'https://b/2', method: () => 'POST' });

    bm.setCurrentSession(DEFAULT_SESSION_ID);
    expect(bm.getBuffers().networkBuffer.toArray().map((entry) => entry.url)).toEqual(['https://a/1']);
    bm.setCurrentSession('s2');
    expect(bm.getBuffers().networkBuffer.toArray().map((entry) => entry.url)).toEqual(['https://b/2']);
  });
});

describe('U4 session isolation — session registry', () => {
  it('default session exists implicitly; getAllSessions surfaces created ones', () => {
    const bm = new BrowserManager();
    bm.getBuffers(); // touch default -> lazily created
    bm.setCurrentSession('alpha');
    bm.getBuffers();
    const ids = bm.getAllSessions().map((session) => session.id).sort();
    expect(ids).toContain(DEFAULT_SESSION_ID);
    expect(ids).toContain('alpha');
  });

  it('closeSession refuses to close the default session', async () => {
    const bm = new BrowserManager();
    await expect(bm.closeSession(DEFAULT_SESSION_ID)).rejects.toThrow(/default/i);
  });

  it('closeSession drops a non-default session and resets current to default', async () => {
    const bm = new BrowserManager();
    bm.setCurrentSession('temp');
    bm.getBuffers();
    await bm.closeSession('temp');
    expect(bm.hasSession('temp')).toBe(false);
    expect(bm.getCurrentSessionId()).toBe(DEFAULT_SESSION_ID);
  });
});
