/**
 * Security audit round-2 tests — static source checks + behavioral verification.
 *
 * These tests verify that security fixes are present at the source level and
 * behave correctly at runtime. Source-level checks guard against regressions
 * that could silently remove a fix without breaking compilation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Shared source reads (used across multiple test sections) ───────────────
const META_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/meta-commands.ts'), 'utf-8');
const WRITE_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/write-commands.ts'), 'utf-8');
const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');
// sidebar-agent.ts was ripped (chat queue replaced by interactive PTY).
// AGENT_SRC kept as empty string so the legacy describe block below skips
// without crashing module load on a missing file.
const AGENT_SRC = (() => {
  try { return fs.readFileSync(path.join(import.meta.dir, '../src/sidebar-agent.ts'), 'utf-8'); }
  catch { return ''; }
})();
const SNAPSHOT_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/snapshot.ts'), 'utf-8');
const PATH_SECURITY_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/path-security.ts'), 'utf-8');

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

// ─── Task 1: Harden validateOutputPath to use realpathSync ──────────────────

describe('Task 1: validateOutputPath uses realpathSync', () => {
  describe('source-level checks', () => {
    it('path-security.ts validateOutputPath contains realpathSync', () => {
      const fn = extractFunction(PATH_SECURITY_SRC, 'validateOutputPath');
      expect(fn).toBeTruthy();
      expect(fn).toContain('realpathSync');
    });

    it('path-security.ts SAFE_DIRECTORIES resolves with realpathSync', () => {
      const safeBlock = sliceBetween(PATH_SECURITY_SRC, 'const SAFE_DIRECTORIES', ';');
      expect(safeBlock).toContain('realpathSync');
    });

    it('meta-commands.ts re-exports validateOutputPath from path-security', () => {
      expect(META_SRC).toContain("from './path-security'");
      expect(META_SRC).toContain('validateOutputPath');
    });

    it('write-commands.ts imports validateOutputPath from path-security', () => {
      expect(WRITE_SRC).toContain("from './path-security'");
      expect(WRITE_SRC).toContain('validateOutputPath');
    });
  });

  describe('behavioral checks', () => {
    let tmpDir: string;
    let symlinkPath: string;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sec-test-'));
      symlinkPath = path.join(tmpDir, 'evil-link');
      try {
        fs.symlinkSync('/etc', symlinkPath);
      } catch {
        symlinkPath = '';
      }
    });

    afterAll(() => {
      try {
        if (symlinkPath) fs.unlinkSync(symlinkPath);
        fs.rmdirSync(tmpDir);
      } catch {
        // best-effort cleanup
      }
    });

    it('meta-commands validateOutputPath rejects path through /etc symlink', async () => {
      if (!symlinkPath) {
        console.warn('Skipping: symlink creation failed');
        return;
      }
      const mod = await import('../src/meta-commands.ts');
      const attackPath = path.join(symlinkPath, 'passwd');
      expect(() => mod.validateOutputPath(attackPath)).toThrow();
    });

    it('realpathSync on symlink-to-/etc resolves to /etc (out of safe dirs)', () => {
      if (!symlinkPath) {
        console.warn('Skipping: symlink creation failed');
        return;
      }
      const resolvedLink = fs.realpathSync(symlinkPath);
      // macOS: /etc -> /private/etc
      expect(resolvedLink).toBe(fs.realpathSync('/etc'));
      const TEMP_DIR_VAL = process.platform === 'win32' ? os.tmpdir() : '/tmp';
      const safeDirs = [TEMP_DIR_VAL, process.cwd()].map(d => {
        try { return fs.realpathSync(d); } catch { return d; }
      });
      const passwdReal = path.join(resolvedLink, 'passwd');
      const isSafe = safeDirs.some(d => passwdReal === d || passwdReal.startsWith(d + path.sep));
      expect(isSafe).toBe(false);
    });

    it('meta-commands validateOutputPath accepts legitimate tmpdir paths', async () => {
      const mod = await import('../src/meta-commands.ts');
      // Use /tmp (which resolves to /private/tmp on macOS) — matches SAFE_DIRECTORIES
      const tmpBase = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
      const legitimatePath = path.join(tmpBase, 'gstack-screenshot.png');
      expect(() => mod.validateOutputPath(legitimatePath)).not.toThrow();
    });

    it('meta-commands validateOutputPath accepts paths in cwd', async () => {
      const mod = await import('../src/meta-commands.ts');
      const cwdPath = path.join(process.cwd(), 'output.png');
      expect(() => mod.validateOutputPath(cwdPath)).not.toThrow();
    });

    it('meta-commands validateOutputPath rejects paths outside safe dirs', async () => {
      const mod = await import('../src/meta-commands.ts');
      expect(() => mod.validateOutputPath('/home/user/secret.png')).toThrow(/Path must be within/);
      expect(() => mod.validateOutputPath('/var/log/access.log')).toThrow(/Path must be within/);
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

// ─── Task 5: /health endpoint must not expose sensitive fields ───────────────

describe('/health endpoint security', () => {
  it('must not expose currentMessage', () => {
    const block = sliceBetween(SERVER_SRC, "url.pathname === '/health'", "url.pathname === '/refs'");
    expect(block).not.toContain('currentMessage');
  });
  it('must not expose currentUrl', () => {
    const block = sliceBetween(SERVER_SRC, "url.pathname === '/health'", "url.pathname === '/refs'");
    expect(block).not.toContain('currentUrl');
  });
});

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
    const mod = await import('../src/meta-commands.ts');
    const { escapeRegExp } = mod as any;
    expect(typeof escapeRegExp).toBe('function');
    const evil = '(a+)+$';
    const escaped = escapeRegExp(evil);
    const start = Date.now();
    new RegExp(escaped).test('aaaaaaaaaaaaaaaaaaaaaaaaaaa!');
    expect(Date.now() - start).toBeLessThan(100);
  });
});

// ─── Task 7: watch-mode guard in chain command ───────────────────────────────

describe('chain command watch-mode guard', () => {
  it('chain loop contains isWatching() guard before write dispatch', () => {
    // Post-alias refactor: loop iterates over canonicalized `c of commands`.
    const block = sliceBetween(META_SRC, 'for (const c of commands)', 'Wait for network to settle');
    expect(block).toContain('isWatching');
  });

  it('chain loop BLOCKED message appears for write commands in watch mode', () => {
    const block = sliceBetween(META_SRC, 'for (const c of commands)', 'Wait for network to settle');
    expect(block).toContain('BLOCKED: write commands disabled in watch mode');
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

  it('cookie-import-browser handler validates --domain against page hostname', () => {
    const block = sliceBetween(WRITE_SRC, "case 'cookie-import-browser':", "case 'style':");
    expect(block).toContain('normalizedDomain');
    expect(block).toContain('pageHostname');
    expect(block).toContain('does not match current page domain');
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

  it('results.push is present in the loop block (loop structure intact)', () => {
    const block = sliceBetween(META_SRC, 'for (const vp of viewports)', 'Restore original viewport');
    expect(block).toContain('results.push');
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

  it('viewport case uses rawW/rawH before clamping (not direct destructure)', () => {
    const block = sliceBetween(WRITE_SRC, "case 'viewport':", "case 'cookie':");
    expect(block).toContain('rawW');
    expect(block).toContain('rawH');
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
