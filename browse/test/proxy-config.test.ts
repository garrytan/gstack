import { describe, test, expect } from 'bun:test';
import { parseProxyConfig, computeConfigHash, ProxyConfigError } from '../src/proxy-config';
import { extractGlobalFlags } from '../src/cli';

describe('parseProxyConfig', () => {
  test('parses socks5 URL with embedded creds', () => {
    const cfg = parseProxyConfig({
      proxyUrl: 'socks5://alice:secret@host.example.com:1080',
    });
    expect(cfg.scheme).toBe('socks5');
    expect(cfg.host).toBe('host.example.com');
    expect(cfg.port).toBe(1080);
    expect(cfg.userId).toBe('alice');
    expect(cfg.password).toBe('secret');
    expect(cfg.hasAuth).toBe(true);
  });

  test('parses URL-only env-credentials', () => {
    const cfg = parseProxyConfig({
      proxyUrl: 'socks5://host.example.com:1080',
      envUser: 'env-user',
      envPass: 'env-pass',
    });
    expect(cfg.userId).toBe('env-user');
    expect(cfg.password).toBe('env-pass');
    expect(cfg.hasAuth).toBe(true);
  });

  test('parses URL-only no-auth', () => {
    const cfg = parseProxyConfig({ proxyUrl: 'http://proxy.corp:3128' });
    expect(cfg.scheme).toBe('http');
    expect(cfg.hasAuth).toBe(false);
    expect(cfg.userId).toBeUndefined();
  });

  test('D9: refuses on mixed cred sources (env + URL)', () => {
    expect(() => parseProxyConfig({
      proxyUrl: 'socks5://alice:secret@host:1080',
      envUser: 'env-user',
      envPass: 'env-pass',
    })).toThrow(/proxy creds set in both env.*and URL/);
  });

  test('D9: refuses when env has only password and URL has user', () => {
    // Asymmetric mixing still counts.
    expect(() => parseProxyConfig({
      proxyUrl: 'socks5://alice@host:1080',
      envPass: 'env-pass',
    })).toThrow(/pick one source/);
  });

  test('rejects malformed URL', () => {
    expect(() => parseProxyConfig({ proxyUrl: 'not-a-url' }))
      .toThrow(ProxyConfigError);
  });

  test('rejects unsupported scheme', () => {
    expect(() => parseProxyConfig({ proxyUrl: 'ftp://host:21' }))
      .toThrow(/unsupported proxy scheme/);
  });

  test('decodes URL-encoded creds', () => {
    const cfg = parseProxyConfig({
      proxyUrl: 'socks5://user%40example.com:p%40ss%21@host:1080',
    });
    expect(cfg.userId).toBe('user@example.com');
    expect(cfg.password).toBe('p@ss!');
  });
});

describe('computeConfigHash', () => {
  test('same inputs → same hash', () => {
    const a = computeConfigHash({ proxyUrl: 'socks5://host:1080', headed: true });
    const b = computeConfigHash({ proxyUrl: 'socks5://host:1080', headed: true });
    expect(a).toBe(b);
  });

  test('different proxy → different hash', () => {
    const a = computeConfigHash({ proxyUrl: 'socks5://host:1080', headed: false });
    const b = computeConfigHash({ proxyUrl: 'socks5://other:1080', headed: false });
    expect(a).not.toBe(b);
  });

  test('different headed → different hash', () => {
    const a = computeConfigHash({ proxyUrl: null, headed: false });
    const b = computeConfigHash({ proxyUrl: null, headed: true });
    expect(a).not.toBe(b);
  });

  test('strips creds before hashing (cred-stable hash)', () => {
    // Same proxy host, different creds → same hash. We don't want the hash
    // to change just because the user rotated their password.
    const a = computeConfigHash({ proxyUrl: 'socks5://alice:pass1@host:1080', headed: false });
    const b = computeConfigHash({ proxyUrl: 'socks5://alice:pass2@host:1080', headed: false });
    expect(a).toBe(b);
  });

  test('null proxy + headed=false → stable hash', () => {
    const hash = computeConfigHash({ proxyUrl: null, headed: false });
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('extractGlobalFlags', () => {
  const ENV_EMPTY: NodeJS.ProcessEnv = {};

  test('strips --proxy and --headed from args', () => {
    const result = extractGlobalFlags(
      ['goto', 'https://example.com', '--proxy', 'socks5://h:1080', '--headed'],
      ENV_EMPTY,
    );
    expect(result.args).toEqual(['goto', 'https://example.com']);
    expect(result.proxyUrl).toContain('socks5://h:1080');
    expect(result.headed).toBe(true);
  });

  test('supports --proxy=value form', () => {
    const result = extractGlobalFlags(
      ['goto', 'https://x', '--proxy=socks5://h:1080'],
      ENV_EMPTY,
    );
    expect(result.proxyUrl).toContain('socks5://h:1080');
    expect(result.args).toEqual(['goto', 'https://x']);
  });

  test('no flags → empty proxy + headed=false + non-empty hash', () => {
    const result = extractGlobalFlags(['goto', 'https://x'], ENV_EMPTY);
    expect(result.proxyUrl).toBeNull();
    expect(result.headed).toBe(false);
    expect(result.configHash).toMatch(/^[a-f0-9]{16}$/);
  });

  test('redactedProxyUrl masks creds from --proxy URL', () => {
    const result = extractGlobalFlags(
      ['goto', 'https://x', '--proxy', 'socks5://alice:secret@host:1080'],
      ENV_EMPTY,
    );
    expect(result.redactedProxyUrl).not.toContain('alice');
    expect(result.redactedProxyUrl).not.toContain('secret');
    expect(result.redactedProxyUrl).toContain('***');
    expect(result.redactedProxyUrl).toContain('host:1080');
  });

  test('D9: throws on mixed cred sources', () => {
    expect(() => extractGlobalFlags(
      ['goto', 'https://x', '--proxy', 'socks5://alice:secret@host:1080'],
      { BROWSE_PROXY_USER: 'env-user', BROWSE_PROXY_PASS: 'env-pass' } as NodeJS.ProcessEnv,
    )).toThrow(ProxyConfigError);
  });

  test('--proxy without value → throws', () => {
    expect(() => extractGlobalFlags(
      ['goto', 'https://x', '--proxy'],
      ENV_EMPTY,
    )).toThrow(ProxyConfigError);
  });

  test('env-only creds resolve into canonical proxyUrl', () => {
    const result = extractGlobalFlags(
      ['goto', 'https://x', '--proxy', 'socks5://host:1080'],
      { BROWSE_PROXY_USER: 'envuser', BROWSE_PROXY_PASS: 'envpass' } as NodeJS.ProcessEnv,
    );
    // proxyUrl should now have the env creds embedded (URL-encoded).
    expect(result.proxyUrl).toContain('envuser');
    expect(result.proxyUrl).toContain('envpass');
    expect(result.proxyUrl).toContain('host:1080');
  });

  test('configHash is stable across cred rotations', () => {
    const a = extractGlobalFlags(
      ['goto', 'x', '--proxy', 'socks5://u1:p1@host:1080'],
      ENV_EMPTY,
    );
    const b = extractGlobalFlags(
      ['goto', 'x', '--proxy', 'socks5://u2:p2@host:1080'],
      ENV_EMPTY,
    );
    expect(a.configHash).toBe(b.configHash);
  });

  test('configHash changes between proxied vs no-proxy', () => {
    const a = extractGlobalFlags(['goto', 'x'], ENV_EMPTY);
    const b = extractGlobalFlags(
      ['goto', 'x', '--proxy', 'socks5://host:1080'],
      ENV_EMPTY,
    );
    expect(a.configHash).not.toBe(b.configHash);
  });
});
