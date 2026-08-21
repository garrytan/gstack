import { describe, expect, test } from 'bun:test';
import {
  cookieDomainsMatch,
  withCookieImportRetry,
  CookieImportError,
} from '../src/cookie-import-browser';
import { verifyCookieAuthentication } from '../src/cookie-auth-verification';

describe('cookie import reliability contracts', () => {
  test('matches only exact or dot-boundary cookie domains', () => {
    expect(cookieDomainsMatch('app.armalo.ai', '.armalo.ai')).toBe(true);
    expect(cookieDomainsMatch('armalo.ai', '.armalo.ai')).toBe(true);
    expect(cookieDomainsMatch('evilarmalo.ai', '.armalo.ai')).toBe(false);
    expect(cookieDomainsMatch('app.notarmalo.ai', '.armalo.ai')).toBe(false);
  });

  test('retries transient source contention and then succeeds', async () => {
    let attempts = 0;
    const result = await withCookieImportRetry(async () => {
      attempts++;
      if (attempts < 3) throw new CookieImportError('locked', 'db_locked', 'retry');
      return 'ok';
    }, { delaysMs: [0, 0], attempts: 3 });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  test('fails closed when auth verification has no identity contract', async () => {
    const result = await verifyCookieAuthentication({
      url: () => 'https://app.example.test/dashboard',
      reload: async () => ({ status: () => 200 }),
      locator: () => ({ isVisible: async () => true, textContent: async () => 'signed out' }),
    });

    expect(result).toMatchObject({ verified: false, reason: 'verification_not_configured', status: 200 });
  });
});
