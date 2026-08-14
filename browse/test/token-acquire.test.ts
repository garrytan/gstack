import { describe, it, expect } from 'bun:test';
import * as path from 'path';

import { acquireToken, decodeJwtExpMs } from '../src/token-manager';
import { validateAdapter, type FrontendAdapter } from '../src/frontend-adapter';

const XPLOR_CONFIG = path.join(
  import.meta.dir,
  '../../../../consumers/xplor-client/agent-browser.config.mjs',
);

async function xplorAdapter(): Promise<FrontendAdapter> {
  const mod = await import(XPLOR_CONFIG);
  return validateAdapter(mod.default ?? mod, XPLOR_CONFIG);
}

/** Build a signed-looking JWT with the given exp (seconds). Signature is unused. */
function jwt(exp: number | null): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const claims: Record<string, unknown> = { userName: 'WhisperingShadow', roles: ['SUPER'] };
  if (exp !== null) claims.exp = exp;
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

/** A fetch that returns queued JSON bodies in order. */
function scriptedFetch(responses: Array<{ status?: number; body: unknown }>) {
  let call = 0;
  const calls: unknown[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    const { status = 200, body } = responses[call++] ?? { body: '' };
    return {
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const providers = {
  credsProvider: () => ({ userName: 'WhisperingShadow', password: 'pw' }),
  totpProvider: () => '123456',
  now: () => 1_000_000,
};

describe('U1 acquireToken — happy path (mfa -> totp -> bearer)', () => {
  it('returns validated auth with realm and JWT-derived expiry', async () => {
    const adapter = await xplorAdapter();
    const exp = 1_000 + 36_000; // seconds
    const fetchMock = scriptedFetch([
      { body: { mfaRequired: true } },
      { body: { bearerToken: jwt(exp), roles: ['SUPER'] } },
    ]);
    const token = await acquireToken(adapter, 'release-6-7-0', {
      ...providers,
      fetchImpl: fetchMock.impl,
    });
    expect(token.realm).toBe('release');
    expect(token.appOrigin).toBe('https://release-6-7-0.exlabs.cloud');
    expect(token.userName).toBe('WhisperingShadow');
    expect(token.expiresAt).toBe(exp * 1000);
    // two POSTs: step1 without authKey, step2 with it
    expect(fetchMock.calls()).toEqual([
      { userName: 'WhisperingShadow', password: 'pw' },
      { userName: 'WhisperingShadow', password: 'pw', authKey: '123456' },
    ]);
  });

  it('falls back to defaultTtlMs when the JWT carries no exp', async () => {
    const adapter = await xplorAdapter();
    const fetchMock = scriptedFetch([
      { body: { mfaRequired: true } },
      { body: { bearerToken: jwt(null), roles: [] } },
    ]);
    const token = await acquireToken(adapter, 'demo', { ...providers, fetchImpl: fetchMock.impl });
    expect(token.expiresAt).toBe(1_000_000 + 8 * 60 * 60 * 1000);
  });
});

describe('U1 acquireToken — error branches', () => {
  it('surfaces QR-enrollment as an actionable error (no hang)', async () => {
    const adapter = await xplorAdapter();
    const fetchMock = scriptedFetch([{ body: { authKey: 'k', qr: 'data:...' } }]);
    await expect(
      acquireToken(adapter, 'demo', { ...providers, fetchImpl: fetchMock.impl }),
    ).rejects.toThrow(/enroll/i);
  });

  it('errors clearly when step 2 returns no bearerToken (wrong TOTP)', async () => {
    const adapter = await xplorAdapter();
    const fetchMock = scriptedFetch([
      { body: { mfaRequired: true } },
      { body: { message: 'invalid code' } },
    ]);
    await expect(
      acquireToken(adapter, 'demo', { ...providers, fetchImpl: fetchMock.impl }),
    ).rejects.toThrow(/step 2/i);
  });

  it('rejects an unknown env before any network call', async () => {
    const adapter = await xplorAdapter();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { status: 200, text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(acquireToken(adapter, 'bogus', { ...providers, fetchImpl })).rejects.toThrow(
      /Unknown env "bogus"/,
    );
    expect(called).toBe(false);
  });
});

describe('U1 decodeJwtExpMs', () => {
  it('decodes exp in ms', () => {
    expect(decodeJwtExpMs(jwt(1_784_854_757))).toBe(1_784_854_757 * 1000);
  });
  it('returns null for a token without exp', () => {
    expect(decodeJwtExpMs(jwt(null))).toBeNull();
  });
  it('returns null for a non-JWT string', () => {
    expect(decodeJwtExpMs('not-a-jwt')).toBeNull();
  });
});
