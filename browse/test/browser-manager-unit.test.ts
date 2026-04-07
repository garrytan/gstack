import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

// ─── BrowserManager basic unit tests ─────────────────────────────

describe('BrowserManager defaults', () => {
  it('getConnectionMode defaults to launched', async () => {
    const { BrowserManager } = await import('../src/browser-manager');
    const bm = new BrowserManager();
    expect(bm.getConnectionMode()).toBe('launched');
  });

  it('getRefMap returns empty array initially', async () => {
    const { BrowserManager } = await import('../src/browser-manager');
    const bm = new BrowserManager();
    expect(bm.getRefMap()).toEqual([]);
  });
});

// ─── getDefaultViewport tests ───────────────────────────────────

describe('getDefaultViewport', () => {
  let originalViewport: string | undefined;

  beforeEach(() => {
    originalViewport = process.env.BROWSE_VIEWPORT;
  });

  afterEach(() => {
    if (originalViewport === undefined) {
      delete process.env.BROWSE_VIEWPORT;
    } else {
      process.env.BROWSE_VIEWPORT = originalViewport;
    }
  });

  it('returns 1280x720 when BROWSE_VIEWPORT is unset', async () => {
    delete process.env.BROWSE_VIEWPORT;
    const { getDefaultViewport } = await import('../src/browser-manager');
    expect(getDefaultViewport()).toEqual({ width: 1280, height: 720 });
  });

  it('parses valid BROWSE_VIEWPORT', async () => {
    process.env.BROWSE_VIEWPORT = '1920x1080';
    const { getDefaultViewport } = await import('../src/browser-manager');
    expect(getDefaultViewport()).toEqual({ width: 1920, height: 1080 });
  });

  it('falls back to 1280x720 on malformed input', async () => {
    process.env.BROWSE_VIEWPORT = 'notaviewport';
    const { getDefaultViewport } = await import('../src/browser-manager');
    expect(getDefaultViewport()).toEqual({ width: 1280, height: 720 });
  });

  it('clamps excessively large dimensions', async () => {
    process.env.BROWSE_VIEWPORT = '99999x99999';
    const { getDefaultViewport } = await import('../src/browser-manager');
    expect(getDefaultViewport()).toEqual({ width: 7680, height: 4320 });
  });
});
