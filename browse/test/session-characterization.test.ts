/**
 * Characterization tests — pin CURRENT single-session behavior before the
 * ContextSession extraction (agent-browser U4). These lock the observable
 * contract that must not regress for existing callers (which send no `session`
 * field). Launch-free: exercises the ownership map + buffer module directly.
 *
 * After the extraction, the default/legacy session must reproduce every
 * assertion here unchanged.
 */

import { describe, it, expect, beforeEach } from 'bun:test';

import { BrowserManager } from '../src/browser-manager';
import {
  consoleBuffer,
  networkBuffer,
  dialogBuffer,
  addConsoleEntry,
  addNetworkEntry,
  addDialogEntry,
} from '../src/buffers';

describe('U4 characterization — tab ownership survives extraction', () => {
  let bm: BrowserManager;
  beforeEach(() => {
    bm = new BrowserManager();
  });

  it('unowned tab has no owner', () => {
    expect(bm.getTabOwner(1)).toBeNull();
  });

  it('root reads and writes any tab', () => {
    expect(bm.checkTabAccess(1, 'root', { isWrite: false })).toBe(true);
    expect(bm.checkTabAccess(1, 'root', { isWrite: true })).toBe(true);
  });

  it('shared scoped agent can write an unowned tab (skill ergonomics)', () => {
    expect(bm.checkTabAccess(1, 'agent-1', { isWrite: true })).toBe(true);
  });
});

describe('U4 characterization — buffers are a shared global today', () => {
  beforeEach(() => {
    consoleBuffer.clear();
    networkBuffer.clear();
    dialogBuffer.clear();
  });

  it('console entries land in the single global buffer', () => {
    addConsoleEntry({ timestamp: 1, level: 'log', text: 'a' });
    addConsoleEntry({ timestamp: 2, level: 'error', text: 'b' });
    expect(consoleBuffer.toArray().map((entry) => entry.text)).toEqual(['a', 'b']);
  });

  it('network entries carry no session/tab identity (pre-extraction)', () => {
    addNetworkEntry({ timestamp: 1, method: 'GET', url: 'https://x/1' });
    const entry = networkBuffer.toArray()[0];
    expect(entry).not.toHaveProperty('session');
    expect(entry).not.toHaveProperty('tabId');
  });

  it('dialog entries land in the single global buffer', () => {
    addDialogEntry({ timestamp: 1, type: 'alert', message: 'hi', action: 'accepted' });
    expect(dialogBuffer.toArray()).toHaveLength(1);
  });

  it('clear empties the global buffer', () => {
    addConsoleEntry({ timestamp: 1, level: 'log', text: 'a' });
    consoleBuffer.clear();
    expect(consoleBuffer.toArray()).toEqual([]);
  });
});
