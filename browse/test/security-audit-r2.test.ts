/**
 * Security audit round-2 tests — static source checks + behavioral verification.
 *
 * These tests verify that security fixes are present at the source level and
 * behave correctly at runtime. Source-level checks guard against regressions
 * that could silently remove a fix without breaking compilation.
 */

import { describe, it, expect, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// ─── Shared source reads (used across multiple test sections) ───────────────
const META_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/meta-commands.ts'), 'utf-8');
const WRITE_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/write-commands.ts'), 'utf-8');
const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');
const SNAPSHOT_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/snapshot.ts'), 'utf-8');

// ─── Helper ─────────────────────────────────────────────────────────────────

/**
 * Extract the source text between two string markers.
 */
function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end === -1) return src.slice(start);
  return src.slice(start, end + endMarker.length);
}

/**
 * Extract a function body by name — finds `function name(` or `export function name(`
 * and returns the full balanced-brace block.
 */
function extractFunction(src: string, name: string): string {
  const pattern = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`);
  const match = pattern.exec(src);
  if (!match) return '';
  let depth = 0;
  let inBody = false;
  const start = match.index;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; inBody = true; }
    else if (src[i] === '}') { depth--; }
    if (inBody && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

// ─── Agent queue security ──────────────────────────────────────────────────
// Original block validated the chat queue's filesystem permissions and
// schema validator on sidebar-agent.ts. Both are gone (chat queue ripped
// in favor of the interactive Terminal PTY). The remaining 0o700 / 0o600
// invariants on extension queue paths are now covered by terminal-agent
// integration tests and the sidebar-tabs regression suite.

// ─── Shared source reads for CSS validator tests ────────────────────────────
const CDP_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/cdp-inspector.ts'), 'utf-8');
const EXTENSION_SRC = fs.readFileSync(
  path.join(import.meta.dir, '../../extension/inspector.js'),
  'utf-8'
);

// ─── Task 2: Shared CSS value validator ─────────────────────────────────────

describe('Task 2: CSS value validator blocks dangerous patterns', () => {
  describe('source-level checks', () => {
    it('write-commands.ts style handler contains DANGEROUS_CSS url check', () => {
      const styleBlock = sliceBetween(WRITE_SRC, "case 'style':", 'case \'cleanup\'');
      expect(styleBlock).toMatch(/url\\s\*\\\(/);
    });

    it('write-commands.ts style handler blocks expression()', () => {
      const styleBlock = sliceBetween(WRITE_SRC, "case 'style':", "case 'cleanup'");
      expect(styleBlock).toMatch(/expression\\s\*\\\(/);
    });

    it('write-commands.ts style handler blocks @import', () => {
      const styleBlock = sliceBetween(WRITE_SRC, "case 'style':", "case 'cleanup'");
      expect(styleBlock).toContain('@import');
    });

    it('cdp-inspector.ts modifyStyle contains DANGEROUS_CSS url check', () => {
      const fn = extractFunction(CDP_SRC, 'modifyStyle');
      expect(fn).toBeTruthy();
      expect(fn).toMatch(/url\\s\*\\\(/);
    });

    it('cdp-inspector.ts modifyStyle blocks @import', () => {
      const fn = extractFunction(CDP_SRC, 'modifyStyle');
      expect(fn).toContain('@import');
    });

    it('extension injectCSS validates id format', () => {
      const fn = extractFunction(EXTENSION_SRC, 'injectCSS');
      expect(fn).toBeTruthy();
      // Should contain a regex test for valid id characters
      expect(fn).toMatch(/\^?\[a-zA-Z0-9_-\]/);
    });

    it('extension injectCSS blocks dangerous CSS patterns', () => {
      const fn = extractFunction(EXTENSION_SRC, 'injectCSS');
      expect(fn).toMatch(/url\\s\*\\\(/);
    });

    it('extension toggleClass validates className format', () => {
      const fn = extractFunction(EXTENSION_SRC, 'toggleClass');
      expect(fn).toBeTruthy();
      expect(fn).toMatch(/\^?\[a-zA-Z0-9_-\]/);
    });
  });
});

// ─── Round-2 review findings: applyStyle CSS check ──────────────────────────

describe('Round-2 finding 1: extension applyStyle blocks dangerous CSS values', () => {
  const INSPECTOR_SRC = fs.readFileSync(
    path.join(import.meta.dir, '../../extension/inspector.js'),
    'utf-8'
  );

  it('applyStyle function exists in inspector.js', () => {
    const fn = extractFunction(INSPECTOR_SRC, 'applyStyle');
    expect(fn).toBeTruthy();
  });

  it('applyStyle validates CSS value with url() block', () => {
    const fn = extractFunction(INSPECTOR_SRC, 'applyStyle');
    // Source contains literal regex /url\s*\(/ — match the source-level escape sequence
    expect(fn).toMatch(/url\\s\*\\\(/);
  });

  it('applyStyle blocks expression()', () => {
    const fn = extractFunction(INSPECTOR_SRC, 'applyStyle');
    expect(fn).toMatch(/expression\\s\*\\\(/);
  });

  it('applyStyle blocks @import', () => {
    const fn = extractFunction(INSPECTOR_SRC, 'applyStyle');
    expect(fn).toContain('@import');
  });

  it('applyStyle blocks javascript: scheme', () => {
    const fn = extractFunction(INSPECTOR_SRC, 'applyStyle');
    expect(fn).toContain('javascript:');
  });

  it('applyStyle blocks data: scheme', () => {
    const fn = extractFunction(INSPECTOR_SRC, 'applyStyle');
    expect(fn).toContain('data:');
  });

  it('applyStyle value check appears before setProperty call', () => {
    const fn = extractFunction(INSPECTOR_SRC, 'applyStyle');
    // Check that the CSS value guard (url\s*\() appears before setProperty
    const valueCheckIdx = fn.search(/url\\s\*\\\(/);
    const setPropIdx = fn.indexOf('setProperty');
    expect(valueCheckIdx).toBeGreaterThan(-1);
    expect(setPropIdx).toBeGreaterThan(-1);
    expect(valueCheckIdx).toBeLessThan(setPropIdx);
  });
});

// ─── Round-2 finding 2: snapshot.ts annotated path uses realpathSync ────────

describe('Round-2 finding 2: snapshot.ts annotated path uses realpathSync', () => {
  it('snapshot.ts annotated screenshot section contains realpathSync', () => {
    // Slice the annotated screenshot block from the source
    const annotateStart = SNAPSHOT_SRC.indexOf('opts.annotate');
    expect(annotateStart).toBeGreaterThan(-1);
    const annotateBlock = SNAPSHOT_SRC.slice(annotateStart, annotateStart + 2000);
    expect(annotateBlock).toContain('realpathSync');
  });

  it('snapshot.ts annotated path validation resolves safe dirs with realpathSync', () => {
    const annotateStart = SNAPSHOT_SRC.indexOf('opts.annotate');
    const annotateBlock = SNAPSHOT_SRC.slice(annotateStart, annotateStart + 2000);
    // safeDirs array must be built with .map() that calls realpathSync
    // Pattern: [TEMP_DIR, process.cwd()].map(...realpathSync...)
    expect(annotateBlock).toContain('[TEMP_DIR, process.cwd()].map');
    expect(annotateBlock).toContain('realpathSync');
  });
});

// ─── Round-2 finding 3: stateFile path traversal check ─────────────────────
// Tested isValidQueueEntry's stateFile validator on sidebar-agent.ts. Both
// the function and the file are gone (chat queue ripped). The terminal-agent
// PTY path no longer takes a queue entry — it accepts WebSocket frames
// gated on Origin + session token, no on-disk queue to traverse. Path
// traversal in browse-server's tab-state writer is covered by
// browse/test/terminal-agent.test.ts (handleTabState atomic-write tests).

// ─── Task 6: frame --url ReDoS fix ──────────────────────────────────────────

describe('frame --url ReDoS fix', () => {
  it('frame --url section does not pass raw user input to new RegExp()', () => {
    const block = sliceBetween(META_SRC, "target === '--url'", 'else {');
    expect(block).not.toMatch(/new RegExp\(args\[/);
  });

  it('frame --url section uses escapeRegExp before constructing RegExp', () => {
    const block = sliceBetween(META_SRC, "target === '--url'", 'else {');
    expect(block).toContain('escapeRegExp');
  });

  it('escapeRegExp neutralizes catastrophic patterns (behavioral)', async () => {
    const { escapeRegExp } = await import('../src/path-security.ts');
    const evil = '(a+)+$';
    const escaped = escapeRegExp(evil);
    const start = Date.now();
    new RegExp(escaped).test('aaaaaaaaaaaaaaaaaaaaaaaaaaa!');
    expect(Date.now() - start).toBeLessThan(100);
  });
});

// ─── Task 7: watch-mode guard in chain command ───────────────────────────────

describe('chain command watch-mode guard', () => {
  // The direct-dispatch fallback (which carried its own isWatching() guard)
  // was deleted — it skipped every OTHER server gate. Chain subcommands now
  // route exclusively through executeCommand -> handleCommandInternal, whose
  // watch-mode write gate covers them. Pin both halves of that contract.
  it('chain has no direct-dispatch fallback (executeCommand is mandatory)', () => {
    const block = sliceBetween(META_SRC, 'const executeCmd = opts?.executeCommand', 'Wait for network to settle');
    expect(block).toContain('chain requires the browse server (no executeCommand context)');
    expect(block).not.toContain('handleWriteCommand(');
  });

  it('server pipeline blocks write commands in watch mode (covers chain subcommands)', () => {
    expect(SERVER_SRC).toMatch(/isWatching\(\)\s*&&\s*isWriteInvocation\(command, args\)/);
  });
});

// ─── Task 8: Cookie domain validation ───────────────────────────────────────

describe('cookie-import domain validation', () => {
  it('cookie-import handler validates cookie domain against page domain', () => {
    const block = sliceBetween(WRITE_SRC, "case 'cookie-import':", "case 'cookie-import-browser':");
    expect(block).toContain('cookieDomain');
    expect(block).toContain('defaultDomain');
    expect(block).toContain('does not match current page domain');
  });

  it('cookie-import-browser handler validates --domain against page hostname', async () => {
    const operation = await import('../src/cookie-import-operation');
    const { handleWriteCommand } = await import('../src/write-commands');
    const imported = spyOn(operation, 'runCookieImport').mockResolvedValue({
      browser: 'chromium', profile: 'Profile 2', imported: 2, failed: 0,
      domainCounts: { '.example.test': 2 }, failureReasons: {}, outcome: 'imported',
      reset: 'not_requested', verification: { verified: false, reason: 'not_requested' }, message: 'Cookie copy complete.',
    });
    let currentUrl = 'https://example.test';
    const page = { url: () => currentUrl, isClosed: () => false } as any;
    const session = { getPage: () => page, getActiveFrameOrPage: () => page, getFrame: () => null } as any;
    const manager = { trackCookieImportDomains() {} } as any;
    try {
      for (const [target, domain] of [
        ['https://example.test', 'unrelated.test'],
        ['https://example.test.evil.invalid', 'example.test'],
        ['https://badexample.test', 'example.test'],
      ]) {
        currentUrl = target;
        await expect(handleWriteCommand('cookie-import-browser', ['chromium', '--domain', domain], session, manager))
          .rejects.toMatchObject({ code: 'target_mismatch' });
      }
      expect(imported).not.toHaveBeenCalled();
      currentUrl = 'https://sub.example.test/protected';
      const result = await handleWriteCommand('cookie-import-browser', ['chromium', '--domain', '.Example.Test.', '--profile', 'Profile 2'], session, manager);
      expect(imported).toHaveBeenCalledTimes(1);
      expect(imported.mock.calls[0][0]).toMatchObject({ browser: 'chromium', domains: ['example.test'], profile: 'Profile 2' });
      expect(imported.mock.calls[0][1]).toEqual({ page, url: currentUrl });
      expect(result).toContain('Imported 2 cookies from chromium (profile: Profile 2)');
    } finally {
      imported.mockRestore();
    }
  });
});

// loadSession session ID validation — loadSession lived inside the chat
// agent state block (sidebar-agent.ts session persistence). Chat queue
// is gone, so the function and its session-ID validator are gone. The
// terminal-agent's PTY session has no on-disk session ID — the WebSocket
// holds the session for its lifetime.

// ─── Task 10: Responsive screenshot path validation ──────────────────────────

describe('Task 10: responsive screenshot path validation', () => {
  it('responsive loop contains validateOutputPath before page.screenshot()', () => {
    // Extract the responsive case block
    const block = sliceBetween(META_SRC, "case 'responsive':", 'Restore original viewport');
    expect(block).toBeTruthy();
    expect(block).toContain('validateOutputPath');
  });

  it('responsive loop calls validateOutputPath on the per-viewport path, not just the prefix', () => {
    const block = sliceBetween(META_SRC, 'for (const vp of viewports)', 'Restore original viewport');
    expect(block).toContain('validateOutputPath');
  });

  it('validateOutputPath appears before page.screenshot() in the loop', () => {
    const block = sliceBetween(META_SRC, 'for (const vp of viewports)', 'Restore original viewport');
    const validateIdx = block.indexOf('validateOutputPath');
    const screenshotIdx = block.indexOf('page.screenshot');
    expect(validateIdx).toBeGreaterThan(-1);
    expect(screenshotIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeLessThan(screenshotIdx);
  });

});

// ─── Task 11: State load — cookie + page URL validation ──────────────────────

const BROWSER_MANAGER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/browser-manager.ts'), 'utf-8');

describe('Task 11: state load cookie validation', () => {
  it('state load block filters cookies by domain and type', () => {
    const block = sliceBetween(META_SRC, "action === 'load'", "throw new Error('Usage: state save|load");
    expect(block).toContain('cookie');
    expect(block).toContain('domain');
    expect(block).toContain('filter');
  });

  it('state load block checks for localhost and .internal in cookie domains', () => {
    const block = sliceBetween(META_SRC, "action === 'load'", "throw new Error('Usage: state save|load");
    expect(block).toContain('localhost');
    expect(block).toContain('.internal');
  });

  it('state load block uses validatedCookies when calling restoreState', () => {
    const block = sliceBetween(META_SRC, "action === 'load'", "throw new Error('Usage: state save|load");
    expect(block).toContain('validatedCookies');
    // Must pass validatedCookies to restoreState, not the raw data.cookies
    const restoreIdx = block.indexOf('restoreState');
    const restoreBlock = block.slice(restoreIdx, restoreIdx + 200);
    expect(restoreBlock).toContain('validatedCookies');
  });

  it('browser-manager restoreState validates page URL before goto', () => {
    // restoreState is a class method — use sliceBetween to extract the method body
    const restoreFn = sliceBetween(BROWSER_MANAGER_SRC, 'async restoreState(', 'async recreateContext(');
    expect(restoreFn).toBeTruthy();
    expect(restoreFn).toContain('validateNavigationUrl');
  });

  it('browser-manager restoreState skips invalid URLs with a warning', () => {
    const restoreFn = sliceBetween(BROWSER_MANAGER_SRC, 'async restoreState(', 'async recreateContext(');
    expect(restoreFn).toContain('Skipping invalid URL');
    expect(restoreFn).toContain('continue');
  });

  it('validateNavigationUrl call appears before page.goto in restoreState', () => {
    const restoreFn = sliceBetween(BROWSER_MANAGER_SRC, 'async restoreState(', 'async recreateContext(');
    const validateIdx = restoreFn.indexOf('validateNavigationUrl');
    const gotoIdx = restoreFn.indexOf('page.goto');
    expect(validateIdx).toBeGreaterThan(-1);
    expect(gotoIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeLessThan(gotoIdx);
  });
});

// activeTabUrl sanitized before syncActiveTabByUrl — tested URL sanitization
// on the now-deleted /sidebar-tabs and /sidebar-command routes. The
// terminal-agent reads tab URLs from the live tabs.json file (atomic write
// from background.js), and chrome:// / chrome-extension:// pages are
// filtered server-side in handleTabState — see browse/test/terminal-agent.test.ts.

// ─── Task 13: Inbox output wrapped as untrusted ──────────────────────────────

describe('Task 13: inbox output wrapped as untrusted content', () => {
  it('inbox handler wraps userMessage with wrapUntrustedContent', () => {
    const block = sliceBetween(META_SRC, "case 'inbox':", "case 'state':");
    expect(block).toContain('wrapUntrustedContent');
  });

  it('inbox handler applies wrapUntrustedContent to userMessage', () => {
    const block = sliceBetween(META_SRC, "case 'inbox':", "case 'state':");
    // Should wrap userMessage
    expect(block).toMatch(/wrapUntrustedContent.*userMessage|userMessage.*wrapUntrustedContent/);
  });

  it('inbox handler applies wrapUntrustedContent to url', () => {
    const block = sliceBetween(META_SRC, "case 'inbox':", "case 'state':");
    // Should also wrap url
    expect(block).toMatch(/wrapUntrustedContent.*msg\.url|msg\.url.*wrapUntrustedContent/);
  });

  it('wrapUntrustedContent calls appear in the message formatting loop', () => {
    const block = sliceBetween(META_SRC, 'for (const msg of messages)', 'Handle --clear flag');
    expect(block).toContain('wrapUntrustedContent');
  });
});

// switchChatTab DocumentFragment + pollChat reentrancy guard tests targeted
// now-deleted chat-tab DOM logic and chat-polling reentrancy. Both are gone
// (Terminal pane is the sole sidebar surface; xterm.js owns its own DOM
// lifecycle, and the WebSocket has no reentrancy hazard).

// ─── Task 16: SIGKILL escalation ────────────────────────────────────────────
// Originally tested sidebar-agent's SIDEBAR_AGENT_TIMEOUT block. The chat
// queue and its watchdog are gone. terminal-agent.ts disposes claude with
// the same SIGINT-then-SIGKILL-after-3s pattern; that's covered by
// browse/test/terminal-agent.test.ts ("cleanup escalates SIGINT to SIGKILL
// after 3s on close").

// ─── Task 17: viewport and wait bounds clamping ──────────────────────────────

describe('Task 17: viewport dimensions and wait timeouts are clamped', () => {
  it('viewport case clamps width and height with Math.min/Math.max', () => {
    const block = sliceBetween(WRITE_SRC, "case 'viewport':", "case 'cookie':");
    expect(block).toBeTruthy();
    expect(block).toMatch(/Math\.min|Math\.max/);
  });

  it('wait case (networkidle branch) clamps timeout with MAX_WAIT_MS', () => {
    const block = sliceBetween(WRITE_SRC, "case 'wait':", "case 'viewport':");
    expect(block).toBeTruthy();
    expect(block).toMatch(/MAX_WAIT_MS/);
  });

  it('wait case (element branch) also clamps timeout', () => {
    const block = sliceBetween(WRITE_SRC, "case 'wait':", "case 'viewport':");
    // Both the networkidle and element branches declare MAX_WAIT_MS
    const maxWaitCount = (block.match(/MAX_WAIT_MS/g) || []).length;
    expect(maxWaitCount).toBeGreaterThanOrEqual(2);
  });

  it('wait case uses MIN_WAIT_MS as a floor', () => {
    const block = sliceBetween(WRITE_SRC, "case 'wait':", "case 'viewport':");
    expect(block).toContain('MIN_WAIT_MS');
  });
});
