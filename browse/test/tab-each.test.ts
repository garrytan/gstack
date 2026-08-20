/**
 * tab-each — fan-out command for the live Terminal pane.
 *
 * Source-level guards: command is registered, has a description + usage,
 * scope-check the inner command, restore the original active tab in a
 * finally block (so a mid-batch exception doesn't leave the user looking
 * at a tab they didn't choose).
 *
 * Behavioral logic test: drive handleMetaCommand directly with a mock
 * BrowserManager + executeCommand callback. Verify the iteration order,
 * the JSON shape, the tab restore, and the chrome:// skip.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { handleMetaCommand } from '../src/meta-commands';
import { META_COMMANDS, COMMAND_DESCRIPTIONS } from '../src/commands';

const META_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/meta-commands.ts'), 'utf-8');

describe('tab-each: registration', () => {
  test('command is in META_COMMANDS', () => {
    expect(META_COMMANDS.has('tab-each')).toBe(true);
  });

  test('has a description and usage entry', () => {
    expect(COMMAND_DESCRIPTIONS['tab-each']).toBeDefined();
    expect(COMMAND_DESCRIPTIONS['tab-each'].usage).toContain('tab-each');
    expect(COMMAND_DESCRIPTIONS['tab-each'].category).toBe('Tabs');
  });
});

describe('tab-each: source-level guards', () => {
  test('scope-checks the inner command before fanning out', () => {
    const block = META_SRC.slice(META_SRC.indexOf("case 'tab-each':"));
    expect(block).toContain('checkScope(tokenInfo, innerName)');
    // The scope check must run BEFORE the for-loop. If it ran inside the
    // loop, a permission failure on the second tab would leave the first
    // tab already mutated.
    const checkIdx = block.indexOf('checkScope(tokenInfo, innerName)');
    const loopIdx = block.indexOf('for (const tab of tabs)');
    expect(checkIdx).toBeLessThan(loopIdx);
  });

  test('restores the original active tab in a finally block', () => {
    const block = META_SRC.slice(META_SRC.indexOf("case 'tab-each':"), META_SRC.indexOf("case 'tab-each':") + 4000);
    expect(block).toContain('finally');
    expect(block).toContain('originalActive');
    expect(block).toContain('switchTab(originalActive');
  });

  test('uses bringToFront: false so the OS window does NOT jump', () => {
    const block = META_SRC.slice(META_SRC.indexOf("case 'tab-each':"), META_SRC.indexOf("case 'tab-each':") + 4000);
    // tab-each is a background operation — pulling focus would steal the
    // user's foreground app every time claude fans out, which is
    // unacceptable.
    expect(block).toContain('bringToFront: false');
  });

  test('skips chrome:// and chrome-extension:// internal pages', () => {
    const block = META_SRC.slice(META_SRC.indexOf("case 'tab-each':"), META_SRC.indexOf("case 'tab-each':") + 4000);
    expect(block).toContain("startsWith('chrome://')");
    expect(block).toContain("startsWith('chrome-extension://')");
  });
});

describe('tab-each: behavior', () => {
  function mockBm(tabs: Array<{ id: number; url: string; title: string; active: boolean }>) {
    let activeId = tabs.find(t => t.active)?.id ?? tabs[0]?.id ?? 0;
    const switched: number[] = [];
    return {
      __switched: switched,
      __activeId: () => activeId,
      getActiveSession: () => ({}),
      getActiveTabId: () => activeId,
      getTabListWithTitles: async () => tabs.map(t => ({ ...t })),
      switchTab: (id: number, _opts?: any) => { switched.push(id); activeId = id; },
    } as any;
  }

  test('iterates every tab, calls executeCommand for each, returns JSON results', async () => {
    const tabs = [
      { id: 1, url: 'https://news.example.com', title: 'News', active: true },
      { id: 2, url: 'https://docs.example.com', title: 'Docs', active: false },
      { id: 3, url: 'https://github.com', title: 'GitHub', active: false },
    ];
    const bm = mockBm(tabs);
    const calls: Array<{ command: string; args?: string[]; tabId?: number }> = [];
    const out = await handleMetaCommand(
      'tab-each',
      ['snapshot', '-i'],
      bm,
      async () => {},
      null,
      {
        executeCommand: async (body) => {
          calls.push(body);
          return { status: 200, result: `snap-of-${body.tabId}` };
        },
      },
    );

    const parsed = JSON.parse(out);
    expect(parsed.command).toBe('snapshot');
    expect(parsed.args).toEqual(['-i']);
    expect(parsed.total).toBe(3);
    expect(parsed.results.map((r: any) => r.tabId)).toEqual([1, 2, 3]);
    expect(parsed.results.every((r: any) => r.status === 200)).toBe(true);
    expect(parsed.results[0].output).toBe('snap-of-1');

    // Inner command was dispatched 3 times, once per tab, with the right tabId.
    expect(calls).toHaveLength(3);
    expect(calls.map(c => c.tabId)).toEqual([1, 2, 3]);
    expect(calls.every(c => c.command === 'snapshot')).toBe(true);
  });

  test('skips chrome:// pages with status=0 + "skipped" output', async () => {
    const tabs = [
      { id: 1, url: 'chrome://newtab', title: 'New Tab', active: true },
      { id: 2, url: 'https://example.com', title: 'Example', active: false },
      { id: 3, url: 'chrome-extension://abc/page.html', title: 'Ext', active: false },
    ];
    const bm = mockBm(tabs);
    const calls: any[] = [];
    const out = await handleMetaCommand(
      'tab-each',
      ['text'],
      bm,
      async () => {},
      null,
      {
        executeCommand: async (body) => {
          calls.push(body);
          return { status: 200, result: `text-of-${body.tabId}` };
        },
      },
    );

    const parsed = JSON.parse(out);
    expect(parsed.total).toBe(3);
    // chrome:// and chrome-extension:// → skipped (status 0).
    expect(parsed.results[0].status).toBe(0);
    expect(parsed.results[0].output).toContain('skipped');
    expect(parsed.results[2].status).toBe(0);
    // Only the real tab dispatched.
    expect(calls).toHaveLength(1);
    expect(calls[0].tabId).toBe(2);
  });

  test('restores the originally active tab even if a tab errors', async () => {
    const tabs = [
      { id: 10, url: 'https://a.example', title: 'A', active: false },
      { id: 20, url: 'https://b.example', title: 'B', active: true }, // initially active
      { id: 30, url: 'https://c.example', title: 'C', active: false },
    ];
    const bm = mockBm(tabs);
    let calls = 0;
    const out = await handleMetaCommand(
      'tab-each',
      ['text'],
      bm,
      async () => {},
      null,
      {
        executeCommand: async (body) => {
          calls++;
          if (body.tabId === 20) {
            return { status: 500, result: JSON.stringify({ error: 'boom' }) };
          }
          return { status: 200, result: `ok-${body.tabId}` };
        },
      },
    );

    const parsed = JSON.parse(out);
    expect(parsed.results.find((r: any) => r.tabId === 20).status).toBe(500);
    expect(parsed.results.find((r: any) => r.tabId === 20).output).toBe('boom');
    expect(parsed.results.find((r: any) => r.tabId === 10).status).toBe(200);
    expect(parsed.results.find((r: any) => r.tabId === 30).status).toBe(200);
    // Active tab restored to 20 (the one that was active when we started).
    expect(bm.__activeId()).toBe(20);
  });

  test('throws on empty args (no inner command)', async () => {
    const bm = mockBm([{ id: 1, url: 'https://x.example', title: 'X', active: true }]);
    await expect(handleMetaCommand(
      'tab-each',
      [],
      bm,
      async () => {},
      null,
      { executeCommand: async () => ({ status: 200, result: '' }) },
    )).rejects.toThrow(/Usage/);
  });
});
