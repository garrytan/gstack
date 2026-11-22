import { describe, test, expect } from 'bun:test';
import { parseProxyConfig, computeConfigHash, directProxyLogLine, explicitDirect, forcesDirect, serverProxyEnv, ProxyConfigError } from '../src/proxy-config';
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

  // #4662: `browse --session inventory goto …` read --session as the command.
  test('a --session before the command moves after it, where the session is read', () => {
    expect(extractGlobalFlags(['--session', 'inventory', 'goto', 'https://x'], ENV_EMPTY).args).toEqual(['goto', '--session', 'inventory', 'https://x']);
    expect(extractGlobalFlags(['--session', 'a', 'chain'], ENV_EMPTY).args).toEqual(['chain', '--session', 'a']);
    expect(extractGlobalFlags(['--session', 'a', 'goto', 'https://x', '--session', 'b'], ENV_EMPTY).args).toEqual(['goto', '--session', 'a', 'https://x', '--session', 'b']);
    expect(extractGlobalFlags(['--headed', '--session', 'a', 'tabs'], ENV_EMPTY).args).toEqual(['tabs', '--session', 'a']);
    expect(extractGlobalFlags(['goto', 'https://x', '--session', 'b'], ENV_EMPTY).args).toEqual(['goto', 'https://x', '--session', 'b']);
    expect(extractGlobalFlags(['fill', '@e1', '--session'], ENV_EMPTY).args).toEqual(['fill', '@e1', '--session']);
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

describe('forcesDirect (#3440 item 8)', () => {
  test('Linux always makes a direct connection explicit, because Chromium reads the proxy variables there', () => {
    expect(forcesDirect({}, 'linux')).toBe(true);
    expect(forcesDirect({ HTTPS_PROXY: 'http://b:2' }, 'linux')).toBe(true);
  });

  test('macOS and Windows keep the system proxy settings unless the user chose direct', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(forcesDirect({}, platform)).toBe(false);
      expect(forcesDirect({ HTTPS_PROXY: 'http://b:2' }, platform)).toBe(false);
      expect(forcesDirect({ BROWSE_PROXY_URL: 'direct' }, platform)).toBe(true);
    }
  });
});

describe('explicitDirect (#3440 item 8)', () => {
  test('is the opt-out on macOS and Windows and nothing on Linux, where direct is already explicit', () => {
    expect(explicitDirect({ BROWSE_PROXY_URL: 'direct' }, 'darwin')).toBe(true);
    expect(explicitDirect({ BROWSE_PROXY_URL: 'direct' }, 'win32')).toBe(true);
    expect(explicitDirect({ BROWSE_PROXY_URL: 'direct' }, 'linux')).toBe(false);
    expect(explicitDirect({ BROWSE_PROXY_URL: 'http://p:1' }, 'darwin')).toBe(false);
    expect(explicitDirect({}, 'darwin')).toBe(false);
  });

  test('the config hash separates an explicit direct from no proxy, and ignores it beside a proxy', () => {
    const plain = computeConfigHash({ proxyUrl: null, headed: false });
    expect(computeConfigHash({ proxyUrl: null, headed: false, explicitDirect: false })).toBe(plain);
    expect(computeConfigHash({ proxyUrl: null, headed: false, explicitDirect: true })).not.toBe(plain);
    expect(computeConfigHash({ proxyUrl: 'http://p:1', headed: false, explicitDirect: true }))
      .toBe(computeConfigHash({ proxyUrl: 'http://p:1', headed: false }));
  });

  test('the daemon reads the opt-out from its own environment for the state file, on the platforms where it matters', () => {
    expect(serverProxyEnv({ BROWSE_PROXY_URL: 'direct' }, 'darwin').direct).toBe(true);
    expect(serverProxyEnv({ BROWSE_PROXY_URL: 'direct' }, 'win32').direct).toBe(true);
    expect(serverProxyEnv({ BROWSE_PROXY_URL: 'direct' }, 'linux').direct).toBe(false);
    expect(serverProxyEnv({}, 'darwin').direct).toBe(false);
    expect(serverProxyEnv({ BROWSE_PROXY_URL: 'http://p:1' }, 'darwin').direct).toBe(false);
  });
});

describe('directProxyLogLine (#3440 item 8)', () => {
  test('names the switch alone when no standard variable is set', () => {
    expect(directProxyLogLine({}, 'linux')).toBe('[browse] [proxy] none: direct connection (--proxy-server=direct://)');
  });

  test('names every set standard variable in precedence order, and nothing else', () => {
    const line = directProxyLogLine({ all_proxy: 'socks5://a:1', HTTPS_PROXY: 'http://b:2', BROWSE_PROXY_URL: 'direct', NO_PROXY: 'x', PATH: '/bin' }, 'linux');
    expect(line).toBe('[browse] [proxy] none: direct connection (--proxy-server=direct://; ignoring HTTPS_PROXY, all_proxy)');
  });

  test('an explicit direct on macOS or Windows names the system proxy settings, never variables Chromium did not read', () => {
    const line = directProxyLogLine({ HTTPS_PROXY: 'http://b:2', BROWSE_PROXY_URL: 'direct' }, 'win32');
    expect(line).toBe('[browse] [proxy] none: direct connection (--proxy-server=direct://; ignoring the system proxy settings)');
  });

  test('no proxy on macOS or Windows reports the system proxy settings Chromium follows', () => {
    expect(directProxyLogLine({ HTTPS_PROXY: 'http://b:2' }, 'darwin'))
      .toBe("[browse] [proxy] none: system proxy settings (Chromium's default on darwin; BROWSE_PROXY_URL=direct connects directly)");
  });
});
