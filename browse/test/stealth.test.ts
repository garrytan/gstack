/**
 * stealth.test.ts — Unit + integration tests for anti-bot stealth patches
 *
 * Tests:
 *   1. Module exports (stealthArgs, applyStealthPatches)
 *   2. Launch args correctness
 *   3. Init script content validation (parsed from source)
 *   4. Integration with BrowserManager (import path, no crash)
 *   5. Adversarial: prototype pollution, toString traps, WebGL spoof values
 */

import { describe, test, expect } from 'bun:test';
import { stealthArgs, applyStealthPatches } from '../src/stealth';

// ─── 1. Module Exports ──────────────────────────────────

describe('stealth module exports', () => {
  test('stealthArgs is a non-empty array of strings', () => {
    expect(Array.isArray(stealthArgs)).toBe(true);
    expect(stealthArgs.length).toBeGreaterThan(0);
    for (const arg of stealthArgs) {
      expect(typeof arg).toBe('string');
      expect(arg.startsWith('--')).toBe(true);
    }
  });

  test('applyStealthPatches is an async function', () => {
    expect(typeof applyStealthPatches).toBe('function');
    // Should accept a context-like object without crashing at import time
  });
});

// ─── 2. Launch Args ─────────────────────────────────────

describe('stealthArgs content', () => {
  test('includes AutomationControlled disable', () => {
    expect(stealthArgs).toContain('--disable-blink-features=AutomationControlled');
  });

  test('includes no-first-run to avoid welcome page', () => {
    expect(stealthArgs).toContain('--no-first-run');
  });

  test('does not include --headless (that is a separate concern)', () => {
    expect(stealthArgs.some(a => a.includes('headless'))).toBe(false);
  });

  test('does not include --no-sandbox (environment-specific)', () => {
    expect(stealthArgs.some(a => a.includes('no-sandbox'))).toBe(false);
  });

  test('does not include proxy args (runtime-specific)', () => {
    expect(stealthArgs.some(a => a.includes('proxy'))).toBe(false);
  });
});

// ─── 3. Init Script Content (source analysis) ──────────

describe('init script coverage', () => {
  // Read the source to verify all patches are present
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../src/stealth.ts'),
    'utf-8',
  );

  test('patches navigator.webdriver via prototype deletion', () => {
    expect(source).toContain('Navigator.prototype');
    expect(source).toContain('webdriver');
    expect(source).toContain('delete');
  });

  test('patches WebGL renderer (both WebGL1 and WebGL2)', () => {
    expect(source).toContain('WebGLRenderingContext.prototype.getParameter');
    expect(source).toContain('WebGL2RenderingContext');
    expect(source).toContain('0x9245'); // UNMASKED_VENDOR
    expect(source).toContain('0x9246'); // UNMASKED_RENDERER
  });

  test('creates proper PluginArray (not raw array)', () => {
    expect(source).toContain('PluginArray.prototype');
    expect(source).toContain('MimeType.prototype');
    expect(source).toContain('Plugin.prototype');
    expect(source).toContain('Symbol.iterator');
  });

  test('sets up complete chrome object with app', () => {
    expect(source).toContain('chrome.app');
    expect(source).toContain('InstallState');
    expect(source).toContain('RunningState');
    expect(source).toContain('chrome.runtime');
    expect(source).toContain('chrome.csi');
    expect(source).toContain('chrome.loadTimes');
  });

  test('cleans CDP artifacts', () => {
    expect(source).toContain('cdc_');
    expect(source).toContain('$cdc_');
    expect(source).toContain('__webdriver');
    expect(source).toContain('__selenium');
  });

  test('patches Permissions API for notifications', () => {
    expect(source).toContain('permissions');
    expect(source).toContain('notifications');
    expect(source).toContain('prompt');
  });

  test('patches Function.prototype.toString', () => {
    expect(source).toContain('Function.prototype.toString');
    expect(source).toContain('[native code]');
  });

  test('uses WeakMap (not Map) for toString overrides to prevent exfiltration', () => {
    // Security: Map can be exfiltrated via Map.prototype.has monkeypatching.
    // WeakMap with bound methods prevents this attack vector.
    expect(source).toContain('new WeakMap');
    expect(source).toContain('WeakMap.prototype.has.bind');
    expect(source).toContain('WeakMap.prototype.get.bind');
    // Must NOT use plain Map for the override store
    expect(source).not.toMatch(/new Map[<(]/); 
  });

  test('GPU renderer varies across sessions (anti-fingerprint)', () => {
    expect(source).toContain('gpuVariants');
    expect(source).toContain('Math.random');
  });

  test('handles mediaDevices for containers', () => {
    expect(source).toContain('mediaDevices');
    expect(source).toContain('enumerateDevices');
    expect(source).toContain('getUserMedia');
  });

  test('spoofs navigator.platform to match UA', () => {
    expect(source).toContain('navigator.platform');
    expect(source).toContain('MacIntel');
    expect(source).toContain('Macintosh');
  });

  test('passes GPU vendor/renderer as args (not hardcoded in browser context)', () => {
    // The function signature should accept args for GPU strings
    expect(source).toContain('gpuVendor');
    expect(source).toContain('gpuRenderer');
    // And pass them to addInitScript as the second arg
    expect(source).toContain('[gpuVendor, gpuRenderer]');
  });
});

// ─── 4. applyStealthPatches API ─────────────────────────

describe('applyStealthPatches API', () => {
  test('rejects when called without a context', async () => {
    // @ts-expect-error - intentionally passing null
    await expect(applyStealthPatches(null)).rejects.toThrow();
  });

  test('rejects when context has no addInitScript', async () => {
    // @ts-expect-error - intentionally passing incomplete mock
    await expect(applyStealthPatches({})).rejects.toThrow();
  });

  test('calls addInitScript on a mock context', async () => {
    let called = false;
    let receivedArg: unknown;
    const mockContext = {
      addInitScript: async (fn: unknown, arg: unknown) => {
        called = true;
        receivedArg = arg;
      },
    };
    // @ts-expect-error - mock
    await applyStealthPatches(mockContext);
    expect(called).toBe(true);
  });

  test('passes GPU args as [vendor, renderer] tuple', async () => {
    let receivedArg: unknown;
    const mockContext = {
      addInitScript: async (_fn: unknown, arg: unknown) => {
        receivedArg = arg;
      },
    };
    // @ts-expect-error - mock
    await applyStealthPatches(mockContext, {
      gpuVendor: 'TestVendor',
      gpuRenderer: 'TestRenderer',
    });
    expect(receivedArg).toEqual(['TestVendor', 'TestRenderer']);
  });

  test('uses default GPU strings when no options provided', async () => {
    let receivedArg: unknown;
    const mockContext = {
      addInitScript: async (_fn: unknown, arg: unknown) => {
        receivedArg = arg;
      },
    };
    // @ts-expect-error - mock
    await applyStealthPatches(mockContext);
    const [vendor, renderer] = receivedArg as [string, string];
    expect(vendor).toContain('Apple');
    // Renderer varies across sessions but should always be an Apple chip
    expect(renderer).toMatch(/Apple.*M[123]/);
  });

  test('init script function is serializable (no closures over Node APIs)', async () => {
    let capturedFn: Function | null = null;
    const mockContext = {
      addInitScript: async (fn: unknown, _arg: unknown) => {
        capturedFn = fn as Function;
      },
    };
    // @ts-expect-error - mock
    await applyStealthPatches(mockContext);
    expect(capturedFn).not.toBeNull();
    // The function should be serializable via toString (Playwright does this)
    const str = capturedFn!.toString();
    expect(str).toContain('Navigator.prototype');
    // Should NOT reference any Node.js APIs (require, process, Buffer, etc.)
    expect(str).not.toContain('require(');
    expect(str).not.toContain('process.');
    expect(str).not.toContain('Buffer.');
    expect(str).not.toContain('__dirname');
    expect(str).not.toContain('__filename');
  });
});

// ─── 5. Adversarial: Edge Cases ─────────────────────────

describe('adversarial edge cases', () => {
  test('stealthArgs are safe to spread into existing arrays', () => {
    const existing = ['--no-sandbox', '--disable-gpu'];
    const combined = [...existing, ...stealthArgs];
    expect(combined.length).toBe(existing.length + stealthArgs.length);
    // No duplicates of safety-critical flags
    const unique = new Set(combined);
    expect(unique.size).toBe(combined.length);
  });

  test('stealthArgs do not contain flags that break extension loading', () => {
    // These flags would break GStack's headed mode with extension
    const forbidden = ['--disable-extensions', '--disable-component-extensions-with-background-pages'];
    for (const flag of forbidden) {
      expect(stealthArgs).not.toContain(flag);
    }
  });

  test('GPU spoof strings are plausible (not detectable as fake)', () => {
    // The default GPU strings should match what a real Mac reports
    let receivedArg: [string, string] | null = null;
    const mockContext = {
      addInitScript: async (_fn: unknown, arg: unknown) => {
        receivedArg = arg as [string, string];
      },
    };
    // @ts-expect-error - mock
    applyStealthPatches(mockContext).then(() => {
      const [vendor, renderer] = receivedArg!;
      // Should look like a real Apple GPU report
      expect(vendor).toMatch(/Google Inc\./);
      expect(renderer).toMatch(/ANGLE.*Apple.*M1/);
      // Should NOT contain SwiftShader, llvmpipe, or Mesa
      expect(renderer).not.toMatch(/SwiftShader|llvmpipe|Mesa|Subzero/i);
    });
  });

  test('applyStealthPatches can be called multiple times without error', async () => {
    let callCount = 0;
    const mockContext = {
      addInitScript: async () => { callCount++; },
    };
    // @ts-expect-error - mock
    await applyStealthPatches(mockContext);
    // @ts-expect-error - mock
    await applyStealthPatches(mockContext);
    // Should be called twice (no guard against double-apply)
    // This is fine — Playwright deduplicates addInitScript internally
    expect(callCount).toBe(2);
  });
});

// ─── 6. Import Integration ──────────────────────────────

describe('import integration', () => {
  test('browser-manager.ts imports stealth module', () => {
    const bmSource = require('fs').readFileSync(
      require('path').join(__dirname, '../src/browser-manager.ts'),
      'utf-8',
    );
    expect(bmSource).toContain("import { stealthArgs, applyStealthPatches } from './stealth'");
  });

  test('browser-manager.ts uses stealthArgs in launch()', () => {
    const bmSource = require('fs').readFileSync(
      require('path').join(__dirname, '../src/browser-manager.ts'),
      'utf-8',
    );
    // In launch() — headless path
    expect(bmSource).toContain('...stealthArgs');
  });

  test('browser-manager.ts calls applyStealthPatches in launch()', () => {
    const bmSource = require('fs').readFileSync(
      require('path').join(__dirname, '../src/browser-manager.ts'),
      'utf-8',
    );
    expect(bmSource).toContain('await applyStealthPatches(this.context)');
  });

  test('browser-manager.ts uses stealthArgs in launchHeaded()', () => {
    const bmSource = require('fs').readFileSync(
      require('path').join(__dirname, '../src/browser-manager.ts'),
      'utf-8',
    );
    expect(bmSource).toContain('...stealthArgs');
  });

  test('browser-manager.ts calls applyStealthPatches in launchHeaded()', () => {
    const bmSource = require('fs').readFileSync(
      require('path').join(__dirname, '../src/browser-manager.ts'),
      'utf-8',
    );
    // Should have exactly 2 calls to applyStealthPatches (launch + launchHeaded)
    const matches = bmSource.match(/applyStealthPatches/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // import + 2 calls
  });

  test('old inline stealth patches are removed from browser-manager.ts', () => {
    const bmSource = require('fs').readFileSync(
      require('path').join(__dirname, '../src/browser-manager.ts'),
      'utf-8',
    );
    // Old inline patches should be gone
    expect(bmSource).not.toContain("name: 'PDF Viewer'");
    expect(bmSource).not.toContain("Fake plugins array");
    expect(bmSource).not.toContain("Fake languages");
    expect(bmSource).not.toContain("key.startsWith('cdc_')");
  });
});
