/**
 * Snapshot command tests
 *
 * Tests: accessibility tree snapshots, ref-based element selection,
 * ref invalidation on navigation, and ref resolution in commands.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleReadCommand as _handleReadCommand } from '../src/read-commands';
import { handleWriteCommand as _handleWriteCommand } from '../src/write-commands';
import { handleMetaCommand } from '../src/meta-commands';
import * as fs from 'fs';

const handleReadCommand = (cmd: string, args: string[], b: BrowserManager) =>
  _handleReadCommand(cmd, args, b.getActiveSession());
const handleWriteCommand = (cmd: string, args: string[], b: BrowserManager) =>
  _handleWriteCommand(cmd, args, b.getActiveSession(), b);

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;
const shutdown = async () => {};

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;

  bm = new BrowserManager();
  await bm.launch();
});

afterAll(() => {
  try { testServer.server.stop(); } catch {}
  setTimeout(() => process.exit(0), 500);
});

// ─── Snapshot Output ────────────────────────────────────────────

describe('Snapshot', () => {
  test('snapshot returns accessibility tree with refs', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const result = await handleMetaCommand('snapshot', [], bm, shutdown);
    expect(result).toContain('@e');
    expect(result).toContain('[heading]');
    expect(result).toContain('"Snapshot Test"');
    expect(result).toContain('[button]');
    expect(result).toContain('[link]');
  });

  test('snapshot -i returns only interactive elements', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    expect(result).toContain('[button]');
    expect(result).toContain('[link]');
    expect(result).toContain('[textbox]');
    // Should NOT contain non-interactive roles like heading or paragraph
    expect(result).not.toContain('[heading]');
  });

  test('snapshot -c returns compact output', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const full = await handleMetaCommand('snapshot', [], bm, shutdown);
    const compact = await handleMetaCommand('snapshot', ['-c'], bm, shutdown);
    // Compact should have fewer lines (empty structural elements removed)
    const fullLines = full.split('\n').length;
    const compactLines = compact.split('\n').length;
    expect(compactLines).toBeLessThanOrEqual(fullLines);
  });

  test('snapshot -d 2 limits depth', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const shallow = await handleMetaCommand('snapshot', ['-d', '2'], bm, shutdown);
    const deep = await handleMetaCommand('snapshot', [], bm, shutdown);
    // Shallow should have fewer or equal lines
    expect(shallow.split('\n').length).toBeLessThanOrEqual(deep.split('\n').length);
  });

  test('snapshot -s "#main" scopes to selector', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const scoped = await handleMetaCommand('snapshot', ['-s', '#main'], bm, shutdown);
    // Should contain elements inside #main
    expect(scoped).toContain('[button]');
    expect(scoped).toContain('"Submit"');
    // Should NOT contain elements outside #main (like nav links)
    expect(scoped).not.toContain('"Internal Link"');
  });

  test('snapshot on page with no interactive elements', async () => {
    // Navigate to about:blank which has minimal content
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // basic.html has links, so this should find those
    expect(result).toContain('[link]');
  });

  test('second snapshot generates fresh refs', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const snap1 = await handleMetaCommand('snapshot', [], bm, shutdown);
    const snap2 = await handleMetaCommand('snapshot', [], bm, shutdown);
    // Both should have @e1 (refs restart from 1)
    expect(snap1).toContain('@e1');
    expect(snap2).toContain('@e1');
  });
});

// ─── Ref-Based Interaction ──────────────────────────────────────

describe('Ref resolution', () => {
  test('click @ref works after snapshot', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const snap = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // Find a button ref
    const buttonLine = snap.split('\n').find(l => l.includes('[button]') && l.includes('"Submit"'));
    expect(buttonLine).toBeDefined();
    const refMatch = buttonLine!.match(/@(e\d+)/);
    expect(refMatch).toBeDefined();
    const ref = `@${refMatch![1]}`;
    const result = await handleWriteCommand('click', [ref], bm);
    expect(result).toContain('Clicked');
  });

  test('fill @ref works after snapshot', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const snap = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // Find a textbox ref (Username)
    const textboxLine = snap.split('\n').find(l => l.includes('[textbox]') && l.includes('"Username"'));
    expect(textboxLine).toBeDefined();
    const refMatch = textboxLine!.match(/@(e\d+)/);
    expect(refMatch).toBeDefined();
    const ref = `@${refMatch![1]}`;
    const result = await handleWriteCommand('fill', [ref, 'testuser'], bm);
    expect(result).toContain('Filled');
  });

  test('hover @ref works after snapshot', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const snap = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    const linkLine = snap.split('\n').find(l => l.includes('[link]'));
    expect(linkLine).toBeDefined();
    const refMatch = linkLine!.match(/@(e\d+)/);
    const ref = `@${refMatch![1]}`;
    const result = await handleWriteCommand('hover', [ref], bm);
    expect(result).toContain('Hovered');
  });

  test('html @ref returns innerHTML', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const snap = await handleMetaCommand('snapshot', [], bm, shutdown);
    // Find a heading ref
    const headingLine = snap.split('\n').find(l => l.includes('[heading]') && l.includes('"Snapshot Test"'));
    expect(headingLine).toBeDefined();
    const refMatch = headingLine!.match(/@(e\d+)/);
    const ref = `@${refMatch![1]}`;
    const result = await handleReadCommand('html', [ref], bm);
    expect(result).toContain('Snapshot Test');
  });

  test('css @ref returns computed CSS', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const snap = await handleMetaCommand('snapshot', [], bm, shutdown);
    const headingLine = snap.split('\n').find(l => l.includes('[heading]') && l.includes('"Snapshot Test"'));
    const refMatch = headingLine!.match(/@(e\d+)/);
    const ref = `@${refMatch![1]}`;
    const result = await handleReadCommand('css', [ref, 'font-family'], bm);
    expect(result).toBeTruthy();
  });

  test('attrs @ref returns element attributes', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const snap = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    const textboxLine = snap.split('\n').find(l => l.includes('[textbox]') && l.includes('"Username"'));
    const refMatch = textboxLine!.match(/@(e\d+)/);
    const ref = `@${refMatch![1]}`;
    const result = await handleReadCommand('attrs', [ref], bm);
    expect(result).toContain('id');
  });
});

// ─── Ref Invalidation ───────────────────────────────────────────

describe('Ref invalidation', () => {
  test('stale ref after goto returns clear error', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // Navigate away — should invalidate refs
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // Try to use old ref
    try {
      await handleWriteCommand('click', ['@e1'], bm);
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.message).toContain('not found');
      expect(err.message).toContain('snapshot');
    }
  });

  test('refs cleared on page navigation', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    expect(bm.getRefCount()).toBeGreaterThan(0);
    // Navigate
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    expect(bm.getRefCount()).toBe(0);
  });
});


// ─── Ref Staleness Detection ────────────────────────────────────

describe('Ref staleness detection', () => {
  test('ref metadata stores role and name', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // Refs should exist with metadata
    expect(bm.getRefCount()).toBeGreaterThan(0);
  });

  test('stale ref after DOM removal gives descriptive error', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const snap = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // Find a button ref
    const buttonLine = snap.split('\n').find(l => l.includes('[button]') && l.includes('"Submit"'));
    expect(buttonLine).toBeDefined();
    const refMatch = buttonLine!.match(/@(e\d+)/);
    expect(refMatch).toBeDefined();
    const ref = `@${refMatch![1]}`;
    
    // Remove the button from DOM (simulates SPA re-render)
    await handleReadCommand('js', ['document.querySelector("button[type=submit]").remove()'], bm);
    
    // Try to click — should get descriptive staleness error
    try {
      await handleWriteCommand('click', [ref], bm);
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.message).toContain('stale');
      expect(err.message).toContain('button');
      expect(err.message).toContain('Submit');
      expect(err.message).toContain('snapshot');
    }
  });

  test('valid ref still resolves normally after staleness check', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const snap = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    const linkLine = snap.split('\n').find(l => l.includes('[link]'));
    expect(linkLine).toBeDefined();
    const refMatch = linkLine!.match(/@(e\d+)/);
    const ref = `@${refMatch![1]}`;
    // Should work normally — element still exists
    const result = await handleWriteCommand('hover', [ref], bm);
    expect(result).toContain('Hovered');
  });
});

// ─── Snapshot Diffing ──────────────────────────────────────────

describe('Snapshot diff', () => {
  test('first snapshot -D stores baseline', async () => {
    // Clear any previous snapshot
    bm.setLastSnapshot(null);
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-D'], bm, shutdown);
    expect(result).toContain('no previous snapshot');
    expect(result).toContain('baseline');
  });

  test('snapshot -D shows diff after change', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    // Take first snapshot
    await handleMetaCommand('snapshot', [], bm, shutdown);
    // Modify DOM
    await handleReadCommand('js', ['document.querySelector("h1").textContent = "Changed Title"'], bm);
    // Take diff
    const diff = await handleMetaCommand('snapshot', ['-D'], bm, shutdown);
    expect(diff).toContain('---');
    expect(diff).toContain('+++');
    expect(diff).toContain('previous snapshot');
    expect(diff).toContain('current snapshot');
  });

  test('snapshot -D with identical page shows no changes', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleMetaCommand('snapshot', [], bm, shutdown);
    const diff = await handleMetaCommand('snapshot', ['-D'], bm, shutdown);
    // All lines should be unchanged (prefixed with space)
    const lines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'));
    // Header lines start with --- and +++ so filter those
    const contentChanges = lines.filter(l => !l.startsWith('---') && !l.startsWith('+++'));
    expect(contentChanges.length).toBe(0);
  });
});

// ─── Annotated Screenshots ─────────────────────────────────────

describe('Annotated screenshots', () => {
  test('snapshot -a creates annotated screenshot', async () => {
    const screenshotPath = '/tmp/browse-test-annotated.png';
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-a', '-o', screenshotPath], bm, shutdown);
    expect(result).toContain('annotated screenshot');
    expect(result).toContain(screenshotPath);
    expect(fs.existsSync(screenshotPath)).toBe(true);
    const stat = fs.statSync(screenshotPath);
    expect(stat.size).toBeGreaterThan(1000);
    fs.unlinkSync(screenshotPath);
  });

  test('snapshot -a uses default path', async () => {
    const defaultPath = '/tmp/browse-annotated.png';
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-a'], bm, shutdown);
    expect(result).toContain('annotated screenshot');
    expect(fs.existsSync(defaultPath)).toBe(true);
    fs.unlinkSync(defaultPath);
  });

  test('snapshot -a -i only annotates interactive', async () => {
    const screenshotPath = '/tmp/browse-test-annotated-i.png';
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-i', '-a', '-o', screenshotPath], bm, shutdown);
    expect(result).toContain('[button]');
    expect(result).toContain('[link]');
    expect(result).toContain('annotated screenshot');
    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
  });

  test('annotation overlays are cleaned up', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    await handleMetaCommand('snapshot', ['-a'], bm, shutdown);
    // Check that overlays are removed
    const overlays = await handleReadCommand('js', ['document.querySelectorAll(".__browse_annotation__").length'], bm);
    expect(overlays).toBe('0');
    // Clean up default file
    try { fs.unlinkSync('/tmp/browse-annotated.png'); } catch {}
  });
});

// ─── Cursor-Interactive ────────────────────────────────────────

describe('Cursor-interactive', () => {
  test('snapshot -C finds cursor:pointer elements', async () => {
    await handleWriteCommand('goto', [baseUrl + '/cursor-interactive.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-C'], bm, shutdown);
    expect(result).toContain('cursor-interactive');
    expect(result).toContain('@c');
    expect(result).toContain('cursor:pointer');
  });

  test('snapshot -C includes onclick elements', async () => {
    await handleWriteCommand('goto', [baseUrl + '/cursor-interactive.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-C'], bm, shutdown);
    expect(result).toContain('onclick');
  });

  test('snapshot -C includes tabindex elements', async () => {
    await handleWriteCommand('goto', [baseUrl + '/cursor-interactive.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-C'], bm, shutdown);
    expect(result).toContain('tabindex');
  });

  test('@c ref is clickable', async () => {
    await handleWriteCommand('goto', [baseUrl + '/cursor-interactive.html'], bm);
    const snap = await handleMetaCommand('snapshot', ['-C'], bm, shutdown);
    // Find a @c ref
    const cLine = snap.split('\n').find(l => l.includes('@c'));
    if (cLine) {
      const refMatch = cLine.match(/@(c\d+)/);
      if (refMatch) {
        const result = await handleWriteCommand('click', [`@${refMatch[1]}`], bm);
        expect(result).toContain('Clicked');
      }
    }
  });

  test('snapshot -C on page with no cursor elements', async () => {
    await handleWriteCommand('goto', [baseUrl + '/empty.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-C'], bm, shutdown);
    // Should not contain cursor-interactive section
    expect(result).not.toContain('cursor-interactive');
  });

  test('snapshot -i -C combines both modes', async () => {
    await handleWriteCommand('goto', [baseUrl + '/cursor-interactive.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-i', '-C'], bm, shutdown);
    // Should have interactive elements (button, link)
    expect(result).toContain('[button]');
    expect(result).toContain('[link]');
    // And cursor-interactive section
    expect(result).toContain('cursor-interactive');
  });

  test('snapshot -i alone also includes cursor-interactive elements', async () => {
    await handleWriteCommand('goto', [baseUrl + '/cursor-interactive.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // -i now auto-enables -C
    expect(result).toContain('[button]');
    expect(result).toContain('[link]');
    expect(result).toContain('cursor-interactive');
    expect(result).toContain('@c');
  });
});

// ─── Dropdown/Popover Detection ─────────────────────────────────

describe('Dropdown/popover detection', () => {
  test('snapshot -i auto-enables cursor scan and finds dropdown items', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dropdown.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // Should find standard interactive elements
    expect(result).toContain('[button]');
    expect(result).toContain('[link]');
    expect(result).toContain('[textbox]');
    // Should also find cursor-interactive dropdown items
    expect(result).toContain('cursor-interactive');
    expect(result).toContain('@c');
    expect(result).toContain('Alice Johnson');
    expect(result).toContain('Bob Smith');
  });

  test('dropdown items in floating container are tagged as popover-child', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dropdown.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    expect(result).toContain('popover-child');
  });

  test('dropdown items with role="option" in portal are captured', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dropdown.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // Dave Wilson has role="option" — should be captured even though it has a role
    expect(result).toContain('Dave Wilson');
  });

  test('static text in dropdown without interactivity is NOT captured', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dropdown.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // "No results? Try a different search." has no cursor:pointer, no onclick, no tabindex
    expect(result).not.toContain('No results');
  });

  test('@c ref from dropdown is clickable', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dropdown.html'], bm);
    const snap = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // Find a @c ref for Alice
    const aliceLine = snap.split('\n').find(l => l.includes('@c') && l.includes('Alice'));
    expect(aliceLine).toBeTruthy();
    const refMatch = aliceLine!.match(/@(c\d+)/);
    expect(refMatch).toBeTruthy();
    const result = await handleWriteCommand('click', [`@${refMatch![1]}`], bm);
    expect(result).toContain('Clicked');
  });

  test('snapshot -C still works standalone without -i', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dropdown.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-C'], bm, shutdown);
    expect(result).toContain('cursor-interactive');
    expect(result).toContain('Alice Johnson');
    // Without -i, should include non-interactive ARIA elements too
    expect(result).toContain('[heading]');
  });
});

// ─── Snapshot Error Paths ───────────────────────────────────────

describe('Snapshot errors', () => {
  test('unknown flag throws', async () => {
    try {
      await handleMetaCommand('snapshot', ['--bogus'], bm, shutdown);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Unknown snapshot flag');
    }
  });

  test('-d without number throws', async () => {
    try {
      await handleMetaCommand('snapshot', ['-d'], bm, shutdown);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('-s without selector throws', async () => {
    try {
      await handleMetaCommand('snapshot', ['-s'], bm, shutdown);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });

  test('-s with nonexistent selector throws', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    try {
      await handleMetaCommand('snapshot', ['-s', '#nonexistent-element-12345'], bm, shutdown);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Selector not found');
    }
  });

  test('-o without path throws', async () => {
    try {
      await handleMetaCommand('snapshot', ['-o'], bm, shutdown);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });
});

// ─── Combined Flags ─────────────────────────────────────────────

describe('Snapshot combined flags', () => {
  test('-i -c -d 2 combines all filters', async () => {
    await handleWriteCommand('goto', [baseUrl + '/snapshot.html'], bm);
    const result = await handleMetaCommand('snapshot', ['-i', '-c', '-d', '2'], bm, shutdown);
    // Should be filtered to interactive, compact, shallow
    expect(result).toContain('[button]');
    expect(result).toContain('[link]');
    // Should NOT contain deep nested non-interactive elements
    expect(result).not.toContain('[heading]');
  });

  test('closetab last tab auto-creates new', async () => {
    // Get down to 1 tab
    const tabs = await bm.getTabListWithTitles();
    for (let i = 1; i < tabs.length; i++) {
      await bm.closeTab(tabs[i].id);
    }
    expect(bm.getTabCount()).toBe(1);
    // Close the last tab
    const lastTab = (await bm.getTabListWithTitles())[0];
    await bm.closeTab(lastTab.id);
    // Should have auto-created a new tab
    expect(bm.getTabCount()).toBe(1);
  });
});
