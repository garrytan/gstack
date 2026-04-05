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
    it('meta-commands.ts validateOutputPath contains realpathSync', () => {
      const fn = extractFunction(META_SRC, 'validateOutputPath');
      expect(fn).toBeTruthy();
      expect(fn).toContain('realpathSync');
    });

    it('write-commands.ts validateOutputPath contains realpathSync', () => {
      const fn = extractFunction(WRITE_SRC, 'validateOutputPath');
      expect(fn).toBeTruthy();
      expect(fn).toContain('realpathSync');
    });

    it('meta-commands.ts SAFE_DIRECTORIES resolves with realpathSync', () => {
      const safeBlock = sliceBetween(META_SRC, 'const SAFE_DIRECTORIES', ';');
      expect(safeBlock).toContain('realpathSync');
    });

    it('write-commands.ts SAFE_DIRECTORIES resolves with realpathSync', () => {
      const safeBlock = sliceBetween(WRITE_SRC, 'const SAFE_DIRECTORIES', ';');
      expect(safeBlock).toContain('realpathSync');
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
      expect(resolvedLink).toBe('/etc');
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
      const legitimatePath = path.join(os.tmpdir(), 'gstack-screenshot.png');
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
