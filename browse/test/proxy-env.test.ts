/**
 * #915: proxy precedence, NO_PROXY translation, the config hash and the
 * mismatch refusal. The daemon round trip is in proxy-env-daemon.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { DIRECT_PROXY_ARG, computeConfigHash, directProxyLogLine, noProxyToChromiumRules, parseProxyConfig, resolveProxy, serverProxyEnv, withLoopbackBypass } from '../src/proxy-config';
import { buildHeadedServerEnv, buildRestartEnv, extractGlobalFlags, headedDaemonProxyLine, proxyMismatchLines, withLoopbackNoProxy } from '../src/cli';

describe('resolveProxy precedence', () => {
  const env = {
    BROWSE_PROXY_URL: 'http://browse.example:1',
    HTTPS_PROXY: 'http://https-upper.example:2',
    https_proxy: 'http://https-lower.example:3',
    HTTP_PROXY: 'http://http-upper.example:4',
    http_proxy: 'http://http-lower.example:5',
    ALL_PROXY: 'socks5://all-upper.example:6',
    all_proxy: 'socks5://all-lower.example:7',
  };
  const order: Array<[string, string]> = [
    ['BROWSE_PROXY_URL', 'http://browse.example:1/'],
    ['HTTPS_PROXY', 'http://https-upper.example:2/'],
    ['https_proxy', 'http://https-lower.example:3/'],
    ['HTTP_PROXY', 'http://http-upper.example:4/'],
    ['http_proxy', 'http://http-lower.example:5/'],
    ['ALL_PROXY', 'socks5://all-upper.example:6'],
    ['all_proxy', 'socks5://all-lower.example:7'],
  ];

  test('--proxy wins over every variable', () => {
    expect(resolveProxy('http://flag.example:9', env)).toMatchObject({ url: 'http://flag.example:9/', source: '--proxy' });
  });

  test('then BROWSE_PROXY_URL, HTTPS_PROXY, HTTP_PROXY and ALL_PROXY, upper case before lower case', () => {
    const remaining: Record<string, string> = { ...env };
    for (const [source, url] of order) {
      expect(resolveProxy(null, remaining)).toMatchObject({ url, source, warning: null });
      delete remaining[source];
    }
    expect(resolveProxy(null, remaining)).toEqual({ url: null, source: null, noProxyRules: null, bypass: null, warning: null });
  });

  test('BROWSE_PROXY_URL=direct opts out of the standard variables, but not out of --proxy', () => {
    expect(resolveProxy(null, { ...env, BROWSE_PROXY_URL: 'direct' })).toMatchObject({ url: null, source: null, warning: null });
    expect(resolveProxy('http://flag.example:9', { ...env, BROWSE_PROXY_URL: 'direct' }).source).toBe('--proxy');
  });

  test('empty variables count as unset', () => {
    expect(resolveProxy(null, { HTTPS_PROXY: '', HTTP_PROXY: 'http://h:8' }).source).toBe('HTTP_PROXY');
  });

  test('socks5h maps to socks5, which already resolves names through the proxy', () => {
    expect(resolveProxy(null, { ALL_PROXY: 'socks5h://u:p@sock.example:1080' }).url).toBe('socks5://u:p@sock.example:1080');
    expect(parseProxyConfig({ proxyUrl: 'socks5h://sock.example' })).toMatchObject({ scheme: 'socks5', port: 1080 });
  });

  test('env URLs keep the cred policy, and the hint names the variable', () => {
    expect(resolveProxy(null, { HTTPS_PROXY: 'http://proxy.example:3128', BROWSE_PROXY_USER: 'USER', BROWSE_PROXY_PASS: 'PASSWORD' }).url).toBe('http://USER:PASSWORD@proxy.example:3128/');
    try {
      resolveProxy(null, { HTTPS_PROXY: 'http://USER:PASSWORD@proxy.example:3128', BROWSE_PROXY_USER: 'u' });
      throw new Error('expected the cred policy to refuse');
    } catch (err: any) {
      expect(err.message).toMatch(/pick one source/);
      expect(err.hint).toBe('unset BROWSE_PROXY_USER/PASS or remove user:pass@ from HTTPS_PROXY');
    }
  });

  test('a scheme-less standard variable is read as an http:// proxy, as curl and Chromium read it (#3440), with creds kept and redactable', () => {
    expect(resolveProxy(null, { HTTPS_PROXY: 'proxy.corp:8080' })).toMatchObject({ url: 'http://proxy.corp:8080/', source: 'HTTPS_PROXY', warning: null });
    const withCreds = resolveProxy(null, { https_proxy: 'USER:PASSWORD@proxy.corp:8080' });
    expect(withCreds).toMatchObject({ source: 'https_proxy', warning: null });
    expect(withCreds.url).toBe(['http://USER', 'PASSWORD@proxy.corp:8080/'].join(':'));
    expect(resolveProxy(null, { ALL_PROXY: '[::1]:3128' })).toMatchObject({ url: 'http://[::1]:3128/', source: 'ALL_PROXY', warning: null });
    expect(resolveProxy(null, { HTTP_PROXY: 'proxy.corp' })).toMatchObject({ url: 'http://proxy.corp/', source: 'HTTP_PROXY', warning: null });
    expect(resolveProxy(null, { HTTPS_PROXY: 'socks5h://proxy.corp:1080' }).url).toBe('socks5://proxy.corp:1080');
  });

  test('surrounding whitespace, a one-slash scheme and a bare number keep the behaviour a scheme-bearing value had', () => {
    for (const value of [' http://h:3128', 'http://h:3128 ', ' h:3128 ', ' socks5://h:1080']) {
      const resolved = resolveProxy(null, { HTTPS_PROXY: value });
      expect(resolved.warning, value).toBeNull();
      expect(resolved.url, value).toMatch(/^(http|socks5):\/\/h:/);
    }
    expect(resolveProxy(null, { HTTPS_PROXY: 'http:/host:3128' }).url).toBe('http://host:3128/');
    expect(resolveProxy(null, { HTTPS_PROXY: '1234' })).toMatchObject({ url: null });
    expect(resolveProxy(null, { HTTPS_PROXY: '1234' }).warning).toStartWith('HTTPS_PROXY is not a proxy URL browse can use (');
  });

  test('a scheme-less value whose credential holds / \\ ? # or bad percent-encoding is not rewritten to http:// and warns without echoing the password or crashing', () => {
    for (const value of ['bob:1234?x@proxy.corp:3128', 'bob:1234#x@proxy.corp:3128', 'bob:1234/x@proxy.corp:3128', 'CORP\\jdoe:1234@proxy.corp:3128', 'bob:\\1234@proxy.corp:3128', 'bob:1234\\abc@proxy.corp:3128']) {
      const resolved = resolveProxy(null, { HTTPS_PROXY: value });
      expect(resolved.url, value).toBeNull();
      expect(resolved.warning, value).toStartWith('HTTPS_PROXY is not a proxy URL browse can use (');
      expect(resolved.warning, value).not.toContain('1234');
    }
    const percent = resolveProxy(null, { HTTPS_PROXY: 'bob:100%@proxy.corp:3128' });
    expect(percent.url).toBeNull();
    expect(percent.warning).toContain('credentials are not valid percent-encoding');
    expect(percent.warning).not.toContain('100%');
    expect(() => resolveProxy(['http://bob', '100%@proxy.corp:3128'].join(':'), {})).toThrow(/percent-encoding/);
  });

  test('a proxy URL with a path, query or fragment is refused for every source, so a DOMAIN\\user login never prints its password', () => {
    for (const value of [['http://CORP\\jdoe', '1234@proxy.corp:3128'].join(':'), 'http://proxy.corp:3128/path', 'http://proxy.corp:3128?x=1', 'socks5://proxy.corp:1080#f', 'http://proxy.corp:3128?', 'http://proxy.corp:3128#']) {
      expect(() => resolveProxy(value, {}), value).toThrow(/unexpected path, query or fragment/);
      const resolved = resolveProxy(null, { HTTPS_PROXY: value });
      expect(resolved.url, value).toBeNull();
      expect(resolved.warning, value).not.toContain('1234');
    }
    expect(resolveProxy('http://proxy.corp:3128/', {}).url).toBe('http://proxy.corp:3128/');
    expect(resolveProxy(null, { HTTPS_PROXY: 'http://proxy.corp:3128/' })).toMatchObject({ url: 'http://proxy.corp:3128/', warning: null });
    expect(resolveProxy('socks5://proxy.corp:1080', {}).url).toBe('socks5://proxy.corp:1080');
  });

  test('a userinfo that opens with a scheme is a slash-less URL, not scheme-less credentials, so the protocol it names is kept', () => {
    expect(resolveProxy(null, { HTTPS_PROXY: ['https:bob', 'pw@proxy.corp:3128'].join(':') }).url).toBe(['https://bob', 'pw@proxy.corp:3128/'].join(':'));
    const socks = resolveProxy(null, { HTTPS_PROXY: 'socks5:bob@proxy.corp:1080' });
    expect(socks.url).toBeNull();
    expect(socks.warning).toContain('missing host');
  });

  test('a scheme-less standard variable with credentials beside BROWSE_PROXY_USER is refused like its http:// spelling: mixed credential sources stay a hard error', () => {
    for (const value of ['bob:pw@proxy.corp:3128', ['http://bob', 'pw@proxy.corp:3128'].join(':')]) {
      expect(() => resolveProxy(null, { HTTPS_PROXY: value, BROWSE_PROXY_USER: 'alice' }), value).toThrow(/pick one source/);
    }
  });

  test('scheme-less and http:// spellings of the same proxy share a config hash, so either shell reuses the daemon', () => {
    const a = extractGlobalFlags(['status'], { HTTPS_PROXY: 'h:3128' }, 'linux');
    const b = extractGlobalFlags(['status'], { HTTPS_PROXY: 'http://h:3128' }, 'linux');
    expect(a.configHash).toBe(b.configHash);
    expect(a.redactedProxyUrl).toBe(b.redactedProxyUrl);
  });

  test('a standard variable that does not parse even as http:// warns and falls back to direct, without echoing it', () => {
    const cred = ['user', 'secret@'].join(':');
    for (const value of [`ftp://${cred}proxy.corp:21`, `http://${cred}proxy.corp:99999`, `${cred}proxy.corp:notaport`, `http://${cred}:8080`]) {
      const resolved = resolveProxy(null, { https_proxy: value });
      expect(resolved).toMatchObject({ url: null, source: null, bypass: null });
      expect(resolved.warning).toStartWith('https_proxy is not a proxy URL browse can use (');
      expect(resolved.warning).toContain('fix: export https_proxy=http://host:port (or socks5://), or set BROWSE_PROXY_URL=direct');
      expect(resolved.warning).toContain('BROWSER.md#proxy-from-environment');
      expect(resolved.warning, value).not.toContain('secret');
    }
  });

  test('--proxy and BROWSE_PROXY_URL are explicit and still fail closed, scheme required', () => {
    expect(() => resolveProxy('proxy.corp:8080', {})).toThrow(/unsupported proxy scheme/);
    expect(() => resolveProxy(null, { BROWSE_PROXY_URL: 'proxy.corp:8080' })).toThrow(/unsupported proxy scheme/);
    expect(() => resolveProxy(null, { BROWSE_PROXY_URL: 'user:secret@proxy.corp:8080' })).toThrow(/unsupported proxy scheme/);
  });
});

describe('NO_PROXY → Chromium bypass rules', () => {
  test('curl-style entries become Chromium rules; loopback is always bypassed', () => {
    expect(noProxyToChromiumRules('example.com, .corp.internal,*.wild.test  10.0.0.0/8,host.test:8080,::1,fe80::1,[2001:db8::2]:443,192.168.1.5,localhost,127.0.0.1,bad:port:x:')).toEqual([
      '*.corp.internal', '*.example.com', '*.host.test:8080', '*.wild.test', '10.0.0.0/8', '192.168.1.5',
      '[2001:db8::2]:443', '[fe80::1]', 'corp.internal', 'example.com', 'host.test:8080',
    ].sort());
    expect(noProxyToChromiumRules('*')).toEqual(['*']);
    expect(noProxyToChromiumRules(undefined)).toEqual([]);
    expect(withLoopbackBypass([])).toBe('localhost,127.0.0.1,[::1]');
  });

  test("the CLI's own loopback NO_PROXY additions never change the rules (#494)", () => {
    expect(noProxyToChromiumRules(withLoopbackNoProxy({ NO_PROXY: 'corp.internal' }))).toEqual(noProxyToChromiumRules('corp.internal'));
    expect(resolveProxy(null, { HTTP_PROXY: 'http://p:1', NO_PROXY: withLoopbackNoProxy({}) }).noProxyRules).toBeNull();
  });
});

describe('config hash', () => {
  const base = { HTTP_PROXY: 'http://proxy.example:3128' };

  test('a NO_PROXY-only change changes the hash of a proxied session', () => {
    const a = extractGlobalFlags(['text'], base);
    const b = extractGlobalFlags(['text'], { ...base, NO_PROXY: 'corp.internal' });
    expect(a.proxyUrl).toBe(b.proxyUrl!);
    expect(a.configHash).not.toBe(b.configHash);
  });

  test('without NO_PROXY entries the hash is the pre-#915 hash, so running daemons stay reusable', () => {
    expect(extractGlobalFlags(['--proxy', 'socks5://reuse.example:1080', 'text'], {}).configHash)
      .toBe(computeConfigHash({ proxyUrl: 'socks5://reuse.example:1080', headed: false }));
    expect(extractGlobalFlags(['text'], { NO_PROXY: 'corp.internal' }).configHash).toBe(computeConfigHash({ proxyUrl: null, headed: false }));
  });

  test('BROWSE_PROXY_URL=direct is part of the hash only where it bypasses the system proxy settings (#3440)', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const plain = extractGlobalFlags(['text'], {}, platform);
      const direct = extractGlobalFlags(['text'], { BROWSE_PROXY_URL: 'direct' }, platform);
      expect(plain.explicitDirect).toBe(false);
      expect(direct.explicitDirect).toBe(true);
      expect(direct.configHash).not.toBe(plain.configHash);
      expect(plain.configHash).toBe(computeConfigHash({ proxyUrl: null, headed: false }));
    }
    const linux = extractGlobalFlags(['text'], { BROWSE_PROXY_URL: 'direct' }, 'linux');
    expect(linux.explicitDirect).toBe(false);
    expect(linux.configHash).toBe(computeConfigHash({ proxyUrl: null, headed: false }));
    expect(extractGlobalFlags(['--proxy', 'http://p:1', 'text'], { BROWSE_PROXY_URL: 'direct' }, 'darwin').explicitDirect).toBe(false);
  });

  test('the env-resolved proxy is part of the hash', () => {
    expect(extractGlobalFlags(['text'], base).configHash).not.toBe(extractGlobalFlags(['text'], {}).configHash);
    expect(extractGlobalFlags(['text'], base).configHash).toBe(extractGlobalFlags(['--proxy', 'http://proxy.example:3128', 'text'], {}).configHash);
  });
});

describe('server env carries the proxy source and bypass', () => {
  const flags = extractGlobalFlags(['text'], { HTTPS_PROXY: 'http://proxy.example:3128', NO_PROXY: 'corp.internal' });
  const expected = {
    BROWSE_PROXY_URL: 'http://proxy.example:3128/',
    BROWSE_PROXY_SOURCE: 'HTTPS_PROXY',
    BROWSE_PROXY_BYPASS: '*.corp.internal,corp.internal,localhost,127.0.0.1,[::1]',
  };

  test('restart and headed launches reapply all three', () => {
    expect(buildRestartEnv(flags, null)).toMatchObject(expected);
    expect(buildHeadedServerEnv(flags)).toMatchObject(expected);
    expect(buildRestartEnv(extractGlobalFlags(['text'], {}), null).BROWSE_PROXY_URL).toBeUndefined();
  });

  // Added by: /ship test coverage audit (Capy), 2026-10-25, for #3440 item 8.
  // Value: protects=a headed connect with BROWSE_PROXY_URL=direct on macOS/Windows hands its daemon the opt-out, so the headed daemon hashes and launches direct;
  //   fails_when=buildHeadedServerEnv spreads only proxyUrl/source/bypass and drops explicitDirect, or proxyServerEnv stops re-emitting it;
  //   why_new=restart-env.test.ts covers buildRestartEnv only and the headed case above is a proxied session; seam=none;
  //   no_claim=the headed daemon's launch itself (unit: only the env it is handed; on Linux the opt-out hashes like no proxy, so the env is empty by design)
  test('a headed launch keeps BROWSE_PROXY_URL=direct where it bypasses the system proxy settings, and a --proxy still wins (#3440)', () => {
    expect(buildHeadedServerEnv(extractGlobalFlags(['connect'], { BROWSE_PROXY_URL: 'direct' }, 'darwin')).BROWSE_PROXY_URL).toBe('direct');
    expect(buildHeadedServerEnv(extractGlobalFlags(['connect'], { BROWSE_PROXY_URL: 'direct' }, 'linux')).BROWSE_PROXY_URL).toBeUndefined();
    expect(buildHeadedServerEnv(extractGlobalFlags(['connect', '--proxy', 'http://p:1'], { BROWSE_PROXY_URL: 'direct' }, 'darwin')).BROWSE_PROXY_URL).toBe('http://p:1/');
  });
});

describe('serverProxyEnv (the daemon side)', () => {
  test('direct means no proxy, and a launch without the CLI still keeps loopback and NO_PROXY', () => {
    expect(serverProxyEnv({ BROWSE_PROXY_URL: 'direct' }).url).toBeUndefined();
    expect(serverProxyEnv({ BROWSE_PROXY_URL: 'http://p:1', NO_PROXY: 'corp.internal' })).toEqual({
      url: 'http://p:1', source: 'BROWSE_PROXY_URL', bypass: '*.corp.internal,corp.internal,localhost,127.0.0.1,[::1]', direct: false,
    });
    expect(serverProxyEnv({ BROWSE_PROXY_URL: 'http://p:1', BROWSE_PROXY_SOURCE: 'ALL_PROXY', BROWSE_PROXY_BYPASS: 'x,localhost' })).toMatchObject({ source: 'ALL_PROXY', bypass: 'x,localhost' });
  });
});

describe('proxyMismatchLines', () => {
  const state = (extra: Record<string, unknown> = {}) => ({ pid: 1, port: 1, token: 't', startedAt: '', serverPath: '', mode: 'launched' as const, configHash: 'x', ...extra });
  const proxied = { proxy: 'http://proxy.example:3128/', proxySource: 'HTTPS_PROXY', proxyBypass: 'localhost,127.0.0.1,[::1]' };

  test('an env proxy meeting a direct daemon names the variable and offers stop, then direct on Linux or unsetting the variable elsewhere', () => {
    const env = { HTTPS_PROXY: 'http://proxy.example:3128' };
    const lines = proxyMismatchLines(extractGlobalFlags(['text'], env, 'linux'), state(), {}, 'linux')!;
    expect(lines[0]).toContain('(HTTPS_PROXY differs)');
    expect(lines[1]).toBe('  daemon:  no proxy');
    expect(lines[2]).toBe('  session: proxy http://proxy.example:3128/ from HTTPS_PROXY, bypassing localhost,127.0.0.1,[::1]');
    expect(lines[3]).toBe("fix: run 'browse stop' to restart the daemon with this session's proxy settings, or set BROWSE_PROXY_URL=direct to use the running daemon without a proxy.");
    expect(lines[4]).toBe('see https://github.com/garrytan/gstack/blob/main/BROWSER.md#proxy-from-environment');
    for (const platform of ['darwin', 'win32'] as const) {
      const other = proxyMismatchLines(extractGlobalFlags(['text'], env, platform), state(), {}, platform)!;
      expect(other[3], platform).toBe("fix: run 'browse stop' to restart the daemon with this session's proxy settings, or unset HTTPS_PROXY to use the running daemon with the system proxy settings.");
    }
  });

  test('a direct session meeting an env-proxied daemon names the daemon variable', () => {
    const lines = proxyMismatchLines(extractGlobalFlags(['text'], {}), state(proxied), {})!;
    expect(lines[0]).toContain('(HTTPS_PROXY differs)');
    expect(lines[2]).toBe('  session: no proxy');
    expect(lines[3]).toContain("or run this session with the daemon's HTTPS_PROXY");
  });

  test('an explicit direct session meeting a system-proxy daemon (macOS/Windows) names BROWSE_PROXY_URL and offers stop or unset (#3440)', () => {
    const env = { BROWSE_PROXY_URL: 'direct' };
    const lines = proxyMismatchLines(extractGlobalFlags(['text'], env, 'darwin'), state(), env)!;
    expect(lines[0]).toContain('(BROWSE_PROXY_URL differs)');
    expect(lines[1]).toBe('  daemon:  no proxy');
    expect(lines[2]).toBe('  session: no proxy (BROWSE_PROXY_URL=direct)');
    expect(lines[3]).toBe("fix: run 'browse stop' to restart the daemon with this session's proxy settings, or unset BROWSE_PROXY_URL to use the running daemon with the system proxy settings.");
  });

  test('a default session meeting an explicit-direct daemon (macOS/Windows) shows the daemon opt-out and offers stop or direct (#3440)', () => {
    const lines = proxyMismatchLines(extractGlobalFlags(['text'], {}, 'darwin'), state({ proxyDirect: true }), {})!;
    expect(lines[0]).toContain('(BROWSE_PROXY_URL differs)');
    expect(lines[1]).toBe('  daemon:  no proxy (BROWSE_PROXY_URL=direct)');
    expect(lines[2]).toBe('  session: no proxy');
    expect(lines[3]).toContain('or set BROWSE_PROXY_URL=direct to use the running daemon without a proxy');
  });

  test('an env proxy meeting a system-proxy daemon (macOS/Windows) offers unsetting the variable, not BROWSE_PROXY_URL=direct, which that daemon would refuse (#3440)', () => {
    const env = { HTTPS_PROXY: 'http://proxy.example:3128' };
    const lines = proxyMismatchLines(extractGlobalFlags(['text'], env, 'darwin'), state(), env, 'darwin')!;
    expect(lines[0]).toContain('(HTTPS_PROXY differs)');
    expect(lines[3]).toBe("fix: run 'browse stop' to restart the daemon with this session's proxy settings, or unset HTTPS_PROXY to use the running daemon with the system proxy settings.");
    expect(lines[3]).not.toContain('BROWSE_PROXY_URL=direct');
    const linux = proxyMismatchLines(extractGlobalFlags(['text'], env, 'linux'), state(), env, 'linux')!;
    expect(linux[3]).toContain('or set BROWSE_PROXY_URL=direct to use the running daemon without a proxy');
  });

  test('a credentialed proxy is redacted on both sides', () => {
    const lines = proxyMismatchLines(extractGlobalFlags(['text'], { HTTPS_PROXY: 'http://USER:PASSWORD@proxy.example:3128' }), state(), {})!;
    expect(lines.join('\n')).not.toContain('PASSWORD');
    expect(lines[2]).toContain('http://***:***@proxy.example:3128/');
  });

  test('--proxy and headed differences keep the existing refusals', () => {
    expect(proxyMismatchLines(extractGlobalFlags(['--proxy', 'http://p:1', 'text'], {}), state(), {})).toBeNull();
    expect(proxyMismatchLines(extractGlobalFlags(['text'], { HTTPS_PROXY: 'http://p:1' }), state({ mode: 'headed' }), {})).toBeNull();
  });
});

describe('BROWSER.md documents the proxy messages', () => {
  test('the anchor every #915 message cites exists and covers the precedence and both messages', async () => {
    const doc = await Bun.file(new URL('../../BROWSER.md', import.meta.url)).text();
    const section = doc.slice(doc.indexOf('\n### Proxy from environment\n'));
    expect(section.length).toBeLessThan(doc.length);
    for (const needle of ['BROWSE_PROXY_URL=direct', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'is not a proxy URL browse can use', 'different proxy settings', 'browse stop']) {
      expect(section).toContain(needle);
    }
  });

  // Added by: /ship test coverage audit (Capy), 2026-10-25, for #3440 item 8.
  // Value: protects=the section names the Chromium switch and the daemon-log line a user greps for, as the code emits them;
  //   fails_when=DIRECT_PROXY_ARG or the '[proxy] none:' log prefix is renamed without BROWSER.md, or the direct-mode paragraph is dropped;
  //   why_new=the #915 needles above predate the switch and the log line; seam=none;
  //   no_claim=prose accuracy beyond those two literals (doc-contract check only)
  test('the direct-mode paragraph names the switch Chromium gets and the daemon-log line that records it (#3440)', async () => {
    const doc = await Bun.file(new URL('../../BROWSER.md', import.meta.url)).text();
    const section = doc.slice(doc.indexOf('\n### Proxy from environment\n'));
    expect(section).toContain(DIRECT_PROXY_ARG);
    for (const needle of ['browse-daemon.log', '[proxy] using <url> from', '[proxy] none: direct connection (', '[proxy] none: system proxy settings']) {
      expect(section).toContain(needle);
    }
    expect(directProxyLogLine({ HTTPS_PROXY: 'http://b:2' }, 'linux')).toContain('[proxy] none: direct connection (' + DIRECT_PROXY_ARG + '; ignoring HTTPS_PROXY)');
  });
});

// Value: protects=every remedy a proxy mismatch refusal offers can be followed: a --proxy session keeps the --proxy refusal, an
//   unset remedy names every variable that would still resolve a proxy, an opted out session is told to drop BROWSE_PROXY_URL, and a
//   connect daemon names the variable when its proxy differs too; fails_when=a remedy names a setting that --proxy or
//   BROWSE_PROXY_URL=direct outranks, or leaves a set variable that refuses the next run; why_new=the existing cases pin one variable
//   per side and never pair --proxy, an opt out or a headed daemon with the other side's source (#3455); seam=proxyMismatchLines
describe('proxy mismatch remedies that can be followed (#3455)', () => {
  const state = (extra: Record<string, unknown> = {}) => ({ pid: 1, port: 1, token: 't', startedAt: '', serverPath: '', mode: 'launched' as const, configHash: 'x', ...extra });
  const proxied = { proxy: 'http://proxy.example:3128/', proxySource: 'HTTPS_PROXY', proxyBypass: 'localhost,127.0.0.1,[::1]' };
  const fixLine = (lines: string[] | null) => lines?.find(l => l.startsWith('fix: ')) ?? '';

  test('a --proxy session against an explicit-direct daemon keeps the --proxy refusal (item 1)', () => {
    const flags = extractGlobalFlags(['--proxy', 'http://corp:3128', 'text'], {}, 'darwin');
    expect(proxyMismatchLines(flags, state({ proxyDirect: true }), {}, 'darwin')).toBeNull();
  });

  test('an unset remedy names every variable that would still resolve a proxy (item 2)', () => {
    const optedOut = { BROWSE_PROXY_URL: 'direct', HTTPS_PROXY: 'http://a:1', https_proxy: 'http://a:1' };
    const a = fixLine(proxyMismatchLines(extractGlobalFlags(['text'], optedOut, 'darwin'), state(), optedOut, 'darwin'));
    for (const name of ['BROWSE_PROXY_URL', 'HTTPS_PROXY', 'https_proxy']) expect(a, name).toContain(name);
    expect(a).not.toContain('HTTP_PROXY');
    const both = { HTTPS_PROXY: 'http://a:1', https_proxy: 'http://a:1' };
    const b = fixLine(proxyMismatchLines(extractGlobalFlags(['text'], both, 'darwin'), state(), both, 'darwin'));
    for (const name of ['HTTPS_PROXY', 'https_proxy']) expect(b, name).toContain(name);
  });

  test('an opted out session against a proxied daemon is told to unset BROWSE_PROXY_URL (item 3)', () => {
    const env = { BROWSE_PROXY_URL: 'direct' };
    for (const platform of ['darwin', 'linux'] as const) {
      const fix = fixLine(proxyMismatchLines(extractGlobalFlags(['text'], env, platform), state(proxied), env, platform));
      expect(fix, platform).toContain('unset BROWSE_PROXY_URL');
      expect(fix, platform).toContain('HTTPS_PROXY');
    }
  });

  test('a connect daemon whose proxy also differs gets a line naming the variable; a headed-only difference gets none (item 4)', () => {
    const env = { BROWSE_PROXY_URL: 'direct' };
    expect(headedDaemonProxyLine(extractGlobalFlags(['text'], env, 'darwin'), state({ mode: 'headed' }), env)).toContain('BROWSE_PROXY_URL');
    expect(headedDaemonProxyLine(extractGlobalFlags(['text'], {}, 'darwin'), state({ mode: 'headed' }), {})).toBeNull();
    const same = { HTTPS_PROXY: 'http://proxy.example:3128' };
    expect(headedDaemonProxyLine(extractGlobalFlags(['text'], same, 'darwin'), state({ mode: 'headed', ...proxied }), same)).toBeNull();
  });
});
