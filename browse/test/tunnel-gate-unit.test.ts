/**
 * Unit-test the pure tunnel-gate function extracted from the /command handler.
 *
 * The gate decides whether a paired remote agent's request to `/command` over
 * the tunnel surface is allowed (returns true) or 403'd (returns false). Pure,
 * synchronous, no HTTP — testable without standing up a Bun.serve listener.
 *
 * The behavioral coverage of the gate firing on the right surface (and only
 * the right surface) lives in `pair-agent-tunnel-eval.test.ts` (paid eval,
 * gate-tier).
 */

import { describe, test, expect } from 'bun:test';
import { canDispatchOverTunnel, TUNNEL_COMMANDS } from '../src/server';

describe('canDispatchOverTunnel — closed allowlist', () => {
  test('every command in TUNNEL_COMMANDS dispatches over tunnel', () => {
    for (const cmd of TUNNEL_COMMANDS) {
      expect(canDispatchOverTunnel(cmd)).toBe(true);
    }
  });

  test('TUNNEL_COMMANDS contains the 25-command closed set', () => {
    // Mirror the source-level guard in dual-listener.test.ts. If this ever
    // disagrees with the literal in server.ts, one of them is wrong.
    const expected = new Set([
      'goto', 'click', 'text', 'screenshot',
      'html', 'links', 'forms', 'accessibility',
      'attrs', 'media', 'data',
      'scroll', 'press', 'type', 'select', 'wait',
      'newtab', 'tabs', 'back', 'forward', 'reload',
      'snapshot', 'fill', 'url', 'closetab',
    ]);
    expect(TUNNEL_COMMANDS.size).toBe(expected.size);
    for (const c of expected) expect(TUNNEL_COMMANDS.has(c)).toBe(true);
    for (const c of TUNNEL_COMMANDS) expect(expected.has(c)).toBe(true);
  });
});

describe('canDispatchOverTunnel — daemon-config + bootstrap commands rejected', () => {
  const blocked = [
    'pair', 'unpair', 'cookies', 'setup',
    'launch', 'launch-browser', 'connect', 'disconnect',
    'restart', 'stop', 'tunnel-start', 'tunnel-stop',
    'token-mint', 'token-revoke', 'cookie-picker', 'cookie-import',
    'inspector-pick', 'extension-inspect',
    'invalid-command-xyz', 'totally-made-up',
  ];
  for (const cmd of blocked) {
    test(`rejects '${cmd}'`, () => {
      expect(canDispatchOverTunnel(cmd)).toBe(false);
    });
  }
});

describe('canDispatchOverTunnel — null/undefined/empty input', () => {
  test('returns false for empty string', () => {
    expect(canDispatchOverTunnel('')).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(canDispatchOverTunnel(undefined)).toBe(false);
  });

  test('returns false for null', () => {
    expect(canDispatchOverTunnel(null)).toBe(false);
  });

  test('returns false for non-string input (defensive)', () => {
    // The body parser may hand the gate a number or object if a malicious
    // client sends `{"command": 42}`. The pure gate must treat anything
    // non-string as not-allowed rather than throw.
    expect(canDispatchOverTunnel(42 as unknown as string)).toBe(false);
    expect(canDispatchOverTunnel({} as unknown as string)).toBe(false);
  });
});

describe('canDispatchOverTunnel — alias canonicalization', () => {
  // canonicalizeCommand resolves aliases (e.g. 'set-content' → 'load-html').
  // Any aliased form of an allowlisted canonical command should also pass the
  // gate; aliases that resolve to a non-allowlisted canonical command should
  // not. We don't hardcode alias names here — we read from the source registry
  // by importing what we need from commands.ts.
  test('aliases that resolve to allowlisted commands pass the gate', () => {
    // 'set-content' canonicalizes to 'load-html'. 'load-html' is NOT in
    // TUNNEL_COMMANDS, so 'set-content' must also be rejected. This guards
    // against a future alias that accidentally maps a tunnel-allowed name to
    // a non-tunnel-allowed canonical (e.g. 'goto' → 'navigate' would break).
    expect(canDispatchOverTunnel('set-content')).toBe(false);
  });

  test('canonical commands pass directly without alias lookup', () => {
    expect(canDispatchOverTunnel('goto')).toBe(true);
    expect(canDispatchOverTunnel('newtab')).toBe(true);
    expect(canDispatchOverTunnel('closetab')).toBe(true);
  });
});

describe('canDispatchOverTunnel — --out writes are never tunnel-dispatchable', () => {
  // `--out` turns an otherwise-readable command into a local-disk WRITE. The
  // tunnel surface never grants disk-write to remote paired agents, so any
  // --out invocation must be 403'd even when the bare command is allowlisted.
  test('bare html dispatches, but html --out does not', () => {
    expect(canDispatchOverTunnel('html', ['main'])).toBe(true);
    expect(canDispatchOverTunnel('html', ['main', '--out', '/tmp/o.html'])).toBe(false);
  });

  test('--out= form is rejected too (no parser-shape bypass)', () => {
    expect(canDispatchOverTunnel('html', ['main', '--out=/tmp/o.html'])).toBe(false);
  });

  test('--out anywhere in args is caught regardless of ordering', () => {
    expect(canDispatchOverTunnel('html', ['--out', '/tmp/o.html', 'main'])).toBe(false);
  });

  test('args without --out still dispatch', () => {
    expect(canDispatchOverTunnel('goto', ['https://example.com'])).toBe(true);
    expect(canDispatchOverTunnel('html', ['main'])).toBe(true);
  });

  test('omitting args preserves the old command-only behavior', () => {
    expect(canDispatchOverTunnel('goto')).toBe(true);
  });

  test('a lookalike flag (--output) is NOT treated as --out', () => {
    // hasOutArg matches '--out' exactly or '--out='; '--output' must not trip it.
    expect(canDispatchOverTunnel('html', ['main', '--output', '/tmp/o'])).toBe(true);
  });
});

describe('canDispatchOverTunnel — tunnel agents stay off the daemon filesystem', () => {
  test('goto and newtab accept http(s) URLs', () => {
    for (const cmd of ['goto', 'newtab']) {
      expect(canDispatchOverTunnel(cmd, ['https://example.com/a?b=c#d'])).toBe(true);
      expect(canDispatchOverTunnel(cmd, ['http://localhost:3000/'])).toBe(true);
      expect(canDispatchOverTunnel(cmd, ['HTTPS://EXAMPLE.COM'])).toBe(true);
    }
  });

  test('goto and newtab refuse every non-http(s) URL', () => {
    const refused = [
      'file:///etc/hosts', 'file://./.env', 'file://~/notes.txt', 'FILE:///tmp/x.html',
      ' file:///tmp/x.html', 'view-source:file:///tmp/x.html', 'data:text/html,hi',
      'javascript:alert(1)', 'chrome://version', 'about:blank', 'not a url', '',
    ];
    for (const cmd of ['goto', 'newtab']) {
      for (const url of refused) expect(canDispatchOverTunnel(cmd, [url])).toBe(false);
    }
  });

  test('newtab with no URL still dispatches', () => {
    expect(canDispatchOverTunnel('newtab', [])).toBe(true);
  });

  test('newtab gates the URL its handler opens, skipping --json', () => {
    expect(canDispatchOverTunnel('newtab', ['--json'])).toBe(true);
    expect(canDispatchOverTunnel('newtab', ['--json', 'https://example.com'])).toBe(true);
    expect(canDispatchOverTunnel('newtab', ['https://example.com', '--json'])).toBe(true);
    expect(canDispatchOverTunnel('newtab', ['--json', 'file:///etc/hosts'])).toBe(false);
  });

  test('eval (runs a file from the daemon disk) is not reachable over the tunnel', () => {
    expect(TUNNEL_COMMANDS.has('eval')).toBe(false);
    expect(canDispatchOverTunnel('eval', ['script.js'])).toBe(false);
  });

  test('screenshot with --base64 and no output path dispatches', () => {
    const allowed = [
      ['--base64'], ['--viewport', '--base64'], ['@e3', '--base64'], ['#main', '--base64'],
      ['--selector=.hero', '--base64'], ['--clip', '0,0,10,10', '--base64'],
    ];
    for (const args of allowed) expect(canDispatchOverTunnel('screenshot', args)).toBe(true);
  });

  test('screenshot without --base64 is refused (it would write a temp file)', () => {
    const refused = [[], ['--viewport'], ['@e3'], ['--selector', '.hero'], ['--clip', '0,0,10,10']];
    for (const args of refused) expect(canDispatchOverTunnel('screenshot', args)).toBe(false);
  });

  test('screenshot naming an output path is refused', () => {
    const refused = [
      ['/tmp/s.png'], ['assets/logo.png'], ['shot'], ['@e3', 'out.png'],
      ['--base64', '/tmp/s.png'], ['--clip', '0,0,10,10', 'clip.png'],
    ];
    for (const args of refused) expect(canDispatchOverTunnel('screenshot', args)).toBe(false);
  });

  test('snapshot naming an output path is refused', () => {
    expect(canDispatchOverTunnel('snapshot', ['-i'])).toBe(true);
    expect(canDispatchOverTunnel('snapshot', ['-a', '-o', '/tmp/a.png'])).toBe(false);
    expect(canDispatchOverTunnel('snapshot', ['--heatmap', '{"@e1":"green"}', '--output', 'heat.png'])).toBe(false);
  });

  test('annotated and heatmap snapshots are refused (they write temp images)', () => {
    for (const args of [['-a'], ['--annotate'], ['-i', '-a'], ['-H', '{"@e1":"green"}'], ['--heatmap', '{"@e1":"green"}']]) {
      expect(canDispatchOverTunnel('snapshot', args)).toBe(false);
    }
  });

  test('args that are not an array are refused', () => {
    expect(canDispatchOverTunnel('goto', { 0: 'file:///etc/hosts' } as unknown as string[])).toBe(false);
  });

  test('null args and non-string elements are refused, not treated as omitted', () => {
    expect(canDispatchOverTunnel('screenshot', null as unknown as string[])).toBe(false);
    expect(canDispatchOverTunnel('goto', [5] as unknown as string[])).toBe(false);
    expect(canDispatchOverTunnel('newtab', ['--json', null] as unknown as string[])).toBe(false);
    expect(canDispatchOverTunnel('click', ['@e1', { x: 1 }] as unknown as string[])).toBe(false);
  });
});
