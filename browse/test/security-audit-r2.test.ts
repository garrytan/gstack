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
