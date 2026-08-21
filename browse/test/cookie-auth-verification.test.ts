import { describe, expect, test } from 'bun:test';
import { verifyCookieAuthentication } from '../src/cookie-auth-verification';

function mockPage(options: {
  status?: number | null;
  url?: string;
  visible?: boolean;
  text?: string | null;
  reloadError?: boolean;
}) {
  return {
    url: () => options.url || 'https://app.example.test/dashboard',
    reload: async () => {
      if (options.reloadError) throw new Error('reload failed');
      return { status: () => options.status ?? 200 };
    },
    locator: () => ({
      isVisible: async () => options.visible ?? true,
      textContent: async () => options.text ?? null,
    }),
  };
}

describe('cookie authentication verification', () => {
  test('accepts a successful page response', async () => {
    await expect(verifyCookieAuthentication(mockPage({}))).resolves.toMatchObject({
      verified: true,
      reason: 'ok',
      status: 200,
    });
  });

  test('rejects HTTP unauthorized responses', async () => {
    await expect(verifyCookieAuthentication(mockPage({ status: 401 }))).resolves.toMatchObject({
      verified: false,
      reason: 'http_unauthorized',
    });
  });

  test('rejects redirects to authentication paths', async () => {
    await expect(verifyCookieAuthentication(mockPage({ url: 'https://app.example.test/sign-in' }))).resolves.toMatchObject({
      verified: false,
      reason: 'redirected_to_auth',
    });
  });

  test('requires a visible configured identity selector without returning its text', async () => {
    const result = await verifyCookieAuthentication(mockPage({ visible: true, text: 'alice@example.test' }), {
      identitySelector: '[data-user-email]',
      expectedIdentity: 'alice@example.test',
    });
    expect(result).toMatchObject({ verified: true, reason: 'ok' });
    expect(result).not.toHaveProperty('identity');
    expect(result).not.toHaveProperty('text');
  });

  test('rejects an identity mismatch without exposing expected or actual text', async () => {
    const result = await verifyCookieAuthentication(mockPage({ visible: true, text: 'other@example.test' }), {
      identitySelector: '[data-user-email]',
      expectedIdentity: 'alice@example.test',
    });
    expect(result).toMatchObject({ verified: false, reason: 'identity_mismatch' });
    expect(JSON.stringify(result)).not.toContain('alice@example');
    expect(JSON.stringify(result)).not.toContain('other@example');
  });
});
