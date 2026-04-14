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
const AGENT_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/sidebar-agent.ts'), 'utf-8');
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

// ─── Task 4: Agent queue poisoning — full schema validation + permissions ───

describe('Agent queue security', () => {
  it('server queue directory must use restricted permissions', () => {
    const queueSection = SERVER_SRC.slice(SERVER_SRC.indexOf('agentQueue'), SERVER_SRC.indexOf('agentQueue') + 2000);
    expect(queueSection).toMatch(/0o700/);
  });

  it('sidebar-agent queue directory must use restricted permissions', () => {
    // The mkdirSync for the queue dir lives in main() — search the main() body
    const mainStart = AGENT_SRC.indexOf('async function main');
    const queueSection = AGENT_SRC.slice(mainStart);
    expect(queueSection).toMatch(/0o700/);
  });

  it('cli.ts queue file creation must use restricted permissions', () => {
    const CLI_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/cli.ts'), 'utf-8');
    const queueSection = CLI_SRC.slice(CLI_SRC.indexOf('queue') || 0, CLI_SRC.indexOf('queue') + 2000);
    expect(queueSection).toMatch(/0o700|0o600|mode/);
  });

  it('queue reader must have a validator function covering all fields', () => {
    // Extract ONLY the validator function body by walking braces
    const validatorStart = AGENT_SRC.indexOf('function isValidQueueEntry');
    expect(validatorStart).toBeGreaterThan(-1);
    let depth = 0;
    let bodyStart = AGENT_SRC.indexOf('{', validatorStart);
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < AGENT_SRC.length; i++) {
      if (AGENT_SRC[i] === '{') depth++;
      if (AGENT_SRC[i] === '}') depth--;
      if (depth === 0) { bodyEnd = i + 1; break; }
    }
    const validatorBlock = AGENT_SRC.slice(validatorStart, bodyEnd);

    expect(validatorBlock).toMatch(/prompt.*string/);
    expect(validatorBlock).toMatch(/Array\.isArray/);
    expect(validatorBlock).toMatch(/\.\./);
    expect(validatorBlock).toContain('stateFile');
    expect(validatorBlock).toContain('tabId');
    expect(validatorBlock).toMatch(/number/);
    expect(validatorBlock).toContain('null');
    expect(validatorBlock).toContain('message');
    expect(validatorBlock).toContain('pageUrl');
    expect(validatorBlock).toContain('sessionId');
  });
});

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

// ─── Round-2 finding 3: stateFile path traversal check in isValidQueueEntry ─

describe('Round-2 finding 3: isValidQueueEntry checks stateFile for path traversal', () => {
  it('isValidQueueEntry checks stateFile for .. traversal sequences', () => {
    const fn = extractFunction(AGENT_SRC, 'isValidQueueEntry');
    expect(fn).toBeTruthy();
    // Must check stateFile for '..' — find the stateFile block and look for '..' string
    const stateFileIdx = fn.indexOf('stateFile');
    expect(stateFileIdx).toBeGreaterThan(-1);
    const stateFileBlock = fn.slice(stateFileIdx, stateFileIdx + 200);
    // The block must contain a check for the two-dot traversal sequence
    expect(stateFileBlock).toMatch(/'\.\.'|"\.\."|\.\./);
  });

  it('isValidQueueEntry stateFile block contains both type check and traversal check', () => {
    const fn = extractFunction(AGENT_SRC, 'isValidQueueEntry');
    const stateFileIdx = fn.indexOf('stateFile');
    const stateBlock = fn.slice(stateFileIdx, stateFileIdx + 300);
    // Must contain the type check
    expect(stateBlock).toContain('typeof obj.stateFile');
    // Must contain the includes('..') call
    expect(stateBlock).toMatch(/includes\s*\(\s*['"]\.\.['"]\s*\)/);
  });
});

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
    const block = sliceBetween(META_SRC, 'for (const cmd of commands)', 'Wait for network to settle');
    expect(block).toContain('isWatching');
  });

  it('chain loop BLOCKED message appears for write commands in watch mode', () => {
    const block = sliceBetween(META_SRC, 'for (const cmd of commands)', 'Wait for network to settle');
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

// ─── Task 9: loadSession ID validation ──────────────────────────────────────

describe('loadSession session ID validation', () => {
  it('loadSession validates session ID format before using it in a path', () => {
    const fn = extractFunction(SERVER_SRC, 'loadSession');
    expect(fn).toBeTruthy();
    // Must contain the alphanumeric regex guard
    expect(fn).toMatch(/\[a-zA-Z0-9_-\]/);
  });

  it('loadSession returns null on invalid session ID', () => {
    const fn = extractFunction(SERVER_SRC, 'loadSession');
    const block = fn.slice(fn.indexOf('activeData.id'));
    // Must warn and return null
    expect(block).toContain('Invalid session ID');
    expect(block).toContain('return null');
  });
});

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

// ─── Task 12: Validate activeTabUrl before syncActiveTabByUrl ─────────────────

describe('Task 12: activeTabUrl sanitized before syncActiveTabByUrl', () => {
  it('sidebar-tabs route sanitizes activeUrl before syncActiveTabByUrl', () => {
    const block = sliceBetween(SERVER_SRC, "url.pathname === '/sidebar-tabs'", "url.pathname === '/sidebar-tabs/switch'");
    expect(block).toContain('sanitizeExtensionUrl');
    expect(block).toContain('syncActiveTabByUrl');
    const sanitizeIdx = block.indexOf('sanitizeExtensionUrl');
    const syncIdx = block.indexOf('syncActiveTabByUrl');
    expect(sanitizeIdx).toBeLessThan(syncIdx);
  });

  it('sidebar-command route sanitizes extensionUrl before syncActiveTabByUrl', () => {
    const block = sliceBetween(SERVER_SRC, "url.pathname === '/sidebar-command'", "url.pathname === '/sidebar-chat/clear'");
    expect(block).toContain('sanitizeExtensionUrl');
    expect(block).toContain('syncActiveTabByUrl');
    const sanitizeIdx = block.indexOf('sanitizeExtensionUrl');
    const syncIdx = block.indexOf('syncActiveTabByUrl');
    expect(sanitizeIdx).toBeLessThan(syncIdx);
  });

  it('direct unsanitized syncActiveTabByUrl calls are not present (all calls go through sanitize)', () => {
    // Every syncActiveTabByUrl call should be preceded by sanitizeExtensionUrl in the nearby code
    // We verify there are no direct browserManager.syncActiveTabByUrl(activeUrl) or
    // browserManager.syncActiveTabByUrl(extensionUrl) patterns (without sanitize wrapper)
    const block1 = sliceBetween(SERVER_SRC, "url.pathname === '/sidebar-tabs'", "url.pathname === '/sidebar-tabs/switch'");
    // Should NOT contain direct call with raw activeUrl
    expect(block1).not.toMatch(/syncActiveTabByUrl\(activeUrl\)/);

    const block2 = sliceBetween(SERVER_SRC, "url.pathname === '/sidebar-command'", "url.pathname === '/sidebar-chat/clear'");
    // Should NOT contain direct call with raw extensionUrl
    expect(block2).not.toMatch(/syncActiveTabByUrl\(extensionUrl\)/);
  });
});

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

// ─── Task 14: DOM serialization round-trip replaced with DocumentFragment ─────

const SIDEPANEL_SRC = fs.readFileSync(path.join(import.meta.dir, '../../extension/sidepanel.js'), 'utf-8');

describe('Task 14: switchChatTab uses DocumentFragment, not innerHTML round-trip', () => {
  it('switchChatTab does NOT use innerHTML to restore chat (string-based re-parse removed)', () => {
    const fn = extractFunction(SIDEPANEL_SRC, 'switchChatTab');
    expect(fn).toBeTruthy();
    // Must NOT have the dangerous pattern of assigning chatDomByTab value back to innerHTML
    expect(fn).not.toMatch(/chatMessages\.innerHTML\s*=\s*chatDomByTab/);
  });

  it('switchChatTab uses createDocumentFragment to save chat DOM', () => {
    const fn = extractFunction(SIDEPANEL_SRC, 'switchChatTab');
    expect(fn).toContain('createDocumentFragment');
  });

  it('switchChatTab moves nodes via appendChild/firstChild (not innerHTML assignment)', () => {
    const fn = extractFunction(SIDEPANEL_SRC, 'switchChatTab');
    // Must use appendChild to restore nodes from fragment
    expect(fn).toContain('chatMessages.appendChild');
  });

  it('chatDomByTab comment documents that values are DocumentFragments, not strings', () => {
    // Check module-level comment on chatDomByTab
    const commentIdx = SIDEPANEL_SRC.indexOf('chatDomByTab');
    const commentLine = SIDEPANEL_SRC.slice(commentIdx, commentIdx + 120);
    expect(commentLine).toMatch(/DocumentFragment|fragment/i);
  });

  it('welcome screen is built with DOM methods in the else branch (not innerHTML)', () => {
    const fn = extractFunction(SIDEPANEL_SRC, 'switchChatTab');
    // The else branch must use createElement, not innerHTML template literal
    expect(fn).toContain('createElement');
    // The specific innerHTML template with chat-welcome must be gone
    expect(fn).not.toMatch(/innerHTML\s*=\s*`[\s\S]*?chat-welcome/);
  });
});

// ─── Task 15: pollChat/switchChatTab reentrancy guard ────────────────────────

describe('Task 15: pollChat reentrancy guard and deferred call in switchChatTab', () => {
  it('pollInProgress guard variable is declared at module scope', () => {
    // Must be declared before any function definitions (within first 2000 chars)
    const moduleTop = SIDEPANEL_SRC.slice(0, 2000);
    expect(moduleTop).toContain('pollInProgress');
  });

  it('pollChat function checks and sets pollInProgress', () => {
    const fn = extractFunction(SIDEPANEL_SRC, 'pollChat');
    expect(fn).toBeTruthy();
    expect(fn).toContain('pollInProgress');
  });

  it('pollChat resets pollInProgress in finally block', () => {
    const fn = extractFunction(SIDEPANEL_SRC, 'pollChat');
    // The finally block must contain the reset
    const finallyIdx = fn.indexOf('finally');
    expect(finallyIdx).toBeGreaterThan(-1);
    const finallyBlock = fn.slice(finallyIdx, finallyIdx + 60);
    expect(finallyBlock).toContain('pollInProgress');
  });

  it('switchChatTab calls pollChat via setTimeout (not directly)', () => {
    const fn = extractFunction(SIDEPANEL_SRC, 'switchChatTab');
    // Must use setTimeout to defer pollChat — no direct call at the end
    expect(fn).toMatch(/setTimeout\s*\(\s*pollChat/);
    // Must NOT have a bare direct call `pollChat()` at the end (outside setTimeout)
    // We check that there is no standalone `pollChat()` call (outside setTimeout wrapper)
    const withoutSetTimeout = fn.replace(/setTimeout\s*\(\s*pollChat[^)]*\)/g, '');
    expect(withoutSetTimeout).not.toMatch(/\bpollChat\s*\(\s*\)/);
  });
});

// ─── Task 16: SIGKILL escalation in sidebar-agent timeout ────────────────────

describe('Task 16: sidebar-agent timeout handler uses SIGTERM→SIGKILL escalation', () => {
  it('timeout block sends SIGTERM first', () => {
    // Slice from "Timed out" / setTimeout block to processingTabs.delete
    const timeoutStart = AGENT_SRC.indexOf("SIDEBAR_AGENT_TIMEOUT");
    expect(timeoutStart).toBeGreaterThan(-1);
    const timeoutBlock = AGENT_SRC.slice(timeoutStart, timeoutStart + 600);
    expect(timeoutBlock).toContain('SIGTERM');
  });

  it('timeout block escalates to SIGKILL after delay', () => {
    const timeoutStart = AGENT_SRC.indexOf("SIDEBAR_AGENT_TIMEOUT");
    const timeoutBlock = AGENT_SRC.slice(timeoutStart, timeoutStart + 600);
    expect(timeoutBlock).toContain('SIGKILL');
  });

  it('SIGTERM appears before SIGKILL in timeout block', () => {
    const timeoutStart = AGENT_SRC.indexOf("SIDEBAR_AGENT_TIMEOUT");
    const timeoutBlock = AGENT_SRC.slice(timeoutStart, timeoutStart + 600);
    const sigtermIdx = timeoutBlock.indexOf('SIGTERM');
    const sigkillIdx = timeoutBlock.indexOf('SIGKILL');
    expect(sigtermIdx).toBeGreaterThan(-1);
    expect(sigkillIdx).toBeGreaterThan(-1);
    expect(sigtermIdx).toBeLessThan(sigkillIdx);
  });
});

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
