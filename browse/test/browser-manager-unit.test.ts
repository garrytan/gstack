import { describe, it, expect } from 'bun:test';

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
