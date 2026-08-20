// /auth/mint endpoint tests. Codex-flagged: identity allowlist, capability
// cap, rate-limit cap, self-service vs owner-granted distinction.

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mintForCaller } from '../src/auth-mint';
import { SessionTokenStore } from '../src/session-tokens';
import { grantIdentity } from '../src/allowlist';

let tmpDir: string;
let listPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ios-qa-mint-'));
  listPath = join(tmpDir, 'allowlist.json');
});

describe('mintForCaller', () => {
  test('rejects unknown identity', async () => {
    const store = new SessionTokenStore();
    const r = await mintForCaller({
      callerIdentity: 'stranger@example.com',
      request: { capability: 'observe' },
      tokenStore: store,
      allowlistPath: listPath,
    });
    expect(r).toEqual({ error: 'identity_not_allowed' });
  });

  test('mints at the requested tier when allowlisted at that tier', async () => {
    await grantIdentity({ identity: 'u@e.com', capability: 'mutate', path: listPath });
    const store = new SessionTokenStore();
    const r = await mintForCaller({
      callerIdentity: 'u@e.com',
      request: { capability: 'interact' },
      tokenStore: store,
      allowlistPath: listPath,
    });
    expect('error' in r).toBe(false);
    if ('error' in r) throw new Error('unexpected');
    expect(r.capability).toBe('mutate'); // returns the granted tier (higher covers interact)
    expect(r.session_token.length).toBeGreaterThan(0);
  });

  test('refuses to mint above the allowlisted tier', async () => {
    await grantIdentity({ identity: 'observe-only@e.com', capability: 'observe', path: listPath });
    const store = new SessionTokenStore();
    const r = await mintForCaller({
      callerIdentity: 'observe-only@e.com',
      request: { capability: 'mutate' },
      tokenStore: store,
      allowlistPath: listPath,
    });
    expect(r).toEqual({ error: 'capability_insufficient' });
  });

  test('rate limits hit at 11th mint per identity', async () => {
    await grantIdentity({ identity: 'spammer@e.com', capability: 'observe', path: listPath });
    const store = new SessionTokenStore();
    let lastError: unknown = null;
    let success = 0;
    for (let i = 0; i < 11; i++) {
      const r = await mintForCaller({
        callerIdentity: 'spammer@e.com',
        request: { capability: 'observe' },
        tokenStore: store,
        allowlistPath: listPath,
      });
      if ('error' in r) lastError = r;
      else success++;
    }
    expect(success).toBe(10);
    expect(lastError).toEqual({ error: 'rate_limited' });
  });

  test('expired allowlist entries reject the mint', async () => {
    // Write an expired entry directly.
    const { saveAllowlist } = await import('../src/allowlist');
    await saveAllowlist({
      version: 1,
      entries: [{
        identity: 'expired@e.com',
        capabilities: ['restore'],
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }],
    }, listPath);
    const store = new SessionTokenStore();
    const r = await mintForCaller({
      callerIdentity: 'expired@e.com',
      request: { capability: 'observe' },
      tokenStore: store,
      allowlistPath: listPath,
    });
    expect(r).toEqual({ error: 'identity_not_allowed' });
  });
});

import { afterEach } from 'bun:test';
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});
