import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { withCdpSession, getOrCreateCdpSession } from '../src/cdp-bridge';

// Static-grep tripwire + behavior tests for the CDP session lifecycle
// helpers introduced as part of the D11 EXPAND_SCOPE memory-leak fix.
//
// Direct calls to `page.context().newCDPSession(page)` are the leak class
// the helpers exist to close — every direct call needs a matching
// `session.detach()` and forgetting it leaves the Chromium-side target
// attached until the underlying transport drops. The tripwire fails CI
// if any source file calls `newCDPSession(` outside `cdp-bridge.ts`
// (the file that owns the helpers).
//
// Pattern mirrors browse/test/terminal-agent-pid-identity.test.ts and
// browse/test/server-sanitize-surrogates.test.ts: read source files
// directly, assert an invariant on their contents.

const SRC_DIR = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src');

function readAllSourceFiles(): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = [];
  for (const entry of fs.readdirSync(SRC_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    const full = path.join(SRC_DIR, entry);
    out.push({ file: entry, content: fs.readFileSync(full, 'utf-8') });
  }
  return out;
}

describe('CDP session cleanup invariant', () => {
  test('1. no source file calls `newCDPSession(` outside cdp-bridge.ts', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const { file, content } of readAllSourceFiles()) {
      // The helper file is the ONE allowed home for direct newCDPSession calls.
      if (file === 'cdp-bridge.ts') continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/newCDPSession\s*\(/.test(line)) continue;
        // Skip comment lines — documentation mentions are fine.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        offenders.push({ file, line: i + 1, text: trimmed });
      }
    }
    if (offenders.length > 0) {
      const formatted = offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
        .join('\n');
      throw new Error(
        `Direct newCDPSession(...) calls found outside cdp-bridge.ts. ` +
        `Route through withCdpSession() (one-shot, finally-detach) or ` +
        `getOrCreateCdpSession() (cached, close-detach) instead:\n${formatted}`,
      );
    }
    expect(offenders).toEqual([]);
  });

  test('2. helper file exports the two documented entry points', () => {
    // Sanity: the tripwire is meaningless if the helpers themselves are gone.
    expect(typeof withCdpSession).toBe('function');
    expect(typeof getOrCreateCdpSession).toBe('function');
  });
});

describe('withCdpSession finally-detach', () => {
  // Fake Page surface for unit-testing the helper without spinning up a real
  // browser. The helper only touches page.context().newCDPSession(page) and
  // the returned session's .detach(), so this surface is enough.
  function makeFakePage(detachSpy: { called: number; rejected?: Error }) {
    const session = {
      detach: async () => {
        detachSpy.called++;
        if (detachSpy.rejected) throw detachSpy.rejected;
      },
    };
    return {
      context: () => ({
        newCDPSession: async (_p: unknown) => session,
      }),
    } as unknown as Page;
  }

  test('3. detaches on the success path', async () => {
    const detachSpy = { called: 0 };
    const page = makeFakePage(detachSpy);
    const result = await withCdpSession(page, async (session) => {
      expect(session).toBeDefined();
      return 42;
    });
    expect(result).toBe(42);
    expect(detachSpy.called).toBe(1);
  });

  test('4. detaches even when fn throws (the actual leak fix)', async () => {
    const detachSpy = { called: 0 };
    const page = makeFakePage(detachSpy);
    await expect(
      withCdpSession(page, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(detachSpy.called).toBe(1);
  });

  test('5. swallows detach errors so they do not mask fn errors', async () => {
    const detachSpy = { called: 0, rejected: new Error('already detached') };
    const page = makeFakePage(detachSpy);
    await expect(
      withCdpSession(page, async () => {
        throw new Error('original');
      }),
    ).rejects.toThrow('original');
    expect(detachSpy.called).toBe(1);
  });

  test('6. swallows detach errors on the success path too', async () => {
    const detachSpy = { called: 0, rejected: new Error('target closed') };
    const page = makeFakePage(detachSpy);
    const result = await withCdpSession(page, async () => 'ok');
    expect(result).toBe('ok');
    expect(detachSpy.called).toBe(1);
  });
});

describe('getOrCreateCdpSession close-detach', () => {
  function makeFakePage() {
    const closeListeners: Array<() => void> = [];
    const session = {
      detach: async () => {
        session._detachCount++;
      },
      _detachCount: 0,
    };
    const page = {
      context: () => ({
        newCDPSession: async (_p: unknown) => session,
      }),
      once: (event: string, fn: () => void) => {
        if (event === 'close') closeListeners.push(fn);
      },
      _fireClose: () => {
        for (const fn of closeListeners) fn();
      },
    };
    return { page: page as unknown as Page, session, fireClose: page._fireClose };
  }

  test('7. caches the session across calls', async () => {
    const { page } = makeFakePage();
    const cache = new WeakMap<Page, any>();
    const s1 = await getOrCreateCdpSession(page, cache);
    const s2 = await getOrCreateCdpSession(page, cache);
    expect(s1).toBe(s2);
  });

  test('8. close hook detaches the session AND clears the cache', async () => {
    const { page, session, fireClose } = makeFakePage();
    const cache = new WeakMap<Page, any>();
    await getOrCreateCdpSession(page, cache);
    expect(cache.get(page)).toBeDefined();
    fireClose();
    // Detach runs synchronously up to the await in the close hook; let it settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.get(page)).toBeUndefined();
    expect(session._detachCount).toBe(1);
  });
});
