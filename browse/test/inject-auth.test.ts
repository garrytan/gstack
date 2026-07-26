/**
 * Origin-scoped injection tests (agent-browser U5).
 *
 * Covers the R5 security invariant (the bearer is written ONLY at the app
 * origin) via the exported init-script guard, plus the daemon primitive's
 * validation — all without launching Chromium.
 */

import { describe, it, expect } from 'bun:test';

import { BrowserManager, originScopedStorageInit } from '../src/browser-manager';

function withFakeDom(origin: string, run: () => void): Record<string, string> {
  const store: Record<string, string> = {};
  const g = globalThis as any;
  const prevLocation = g.location;
  const prevWindow = g.window;
  g.location = { origin };
  g.window = { localStorage: { setItem: (k: string, v: string) => { store[k] = v; } } };
  try {
    run();
  } finally {
    g.location = prevLocation;
    g.window = prevWindow;
  }
  return store;
}

describe('U5 origin-scoped init script (R5 security)', () => {
  const payload = { origin: 'https://app.example', key: 'auth', val: '{"bearerToken":"x","roles":[]}' };

  it('writes localStorage when the page origin matches appOrigin', () => {
    const store = withFakeDom('https://app.example', () => originScopedStorageInit(payload));
    expect(store.auth).toBe('{"bearerToken":"x","roles":[]}');
  });

  it('does NOT write when the page origin differs (no bearer leak)', () => {
    const store = withFakeDom('https://evil.example', () => originScopedStorageInit(payload));
    expect(store.auth).toBeUndefined();
  });
});

describe('U5 injectOriginScopedStorage validation', () => {
  function bmWithFakeContext() {
    const bm = new BrowserManager();
    const calls: Array<unknown> = [];
    (bm as any).cur.context = { addInitScript: (_fn: unknown, arg: unknown) => { calls.push(arg); } };
    return { bm, calls };
  }

  it('throws when the session has no context', async () => {
    const bm = new BrowserManager();
    await expect(
      bm.injectOriginScopedStorage('https://app', 'auth', '{"a":1}'),
    ).rejects.toThrow(/no browser context/i);
  });

  it('throws on invalid JSON', async () => {
    const { bm } = bmWithFakeContext();
    await expect(bm.injectOriginScopedStorage('https://app', 'auth', 'not-json')).rejects.toThrow(/valid JSON/i);
  });

  it('throws on a non-object payload (array / primitive)', async () => {
    const { bm } = bmWithFakeContext();
    await expect(bm.injectOriginScopedStorage('https://app', 'auth', '[1,2]')).rejects.toThrow(/non-empty JSON object/i);
    await expect(bm.injectOriginScopedStorage('https://app', 'auth', '"x"')).rejects.toThrow(/non-empty JSON object/i);
  });

  it('throws when appOrigin or storageKey is missing', async () => {
    const { bm } = bmWithFakeContext();
    await expect(bm.injectOriginScopedStorage('', 'auth', '{"a":1}')).rejects.toThrow(/appOrigin/i);
    await expect(bm.injectOriginScopedStorage('https://app', '', '{"a":1}')).rejects.toThrow(/storageKey/i);
  });

  it('applies the init script and records it for context-recreation replay', async () => {
    const { bm, calls } = bmWithFakeContext();
    await bm.injectOriginScopedStorage('https://app.example', 'auth', '{"bearerToken":"x","roles":[]}');
    expect(calls).toEqual([{ origin: 'https://app.example', key: 'auth', val: '{"bearerToken":"x","roles":[]}' }]);
  });
});
