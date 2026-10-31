/**
 * #3539: a loopback `gbrain serve --http` entry over this machine's own gbrain
 * engine is a local brain, not a Path 4 remote one.
 *
 * Pins lib/gbrain-mcp-locality.ts, and checks the jq copy in
 * bin/gstack-skill-start (the preamble's hot path reads ~/.claude.json with
 * jq, not through bun) against it: a few end-to-end skill-start cases, plus a
 * table-driven parity run of the two jq programs themselves.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyGbrainMcpEntry,
  classifyGbrainMcpListLine,
  hasLocalGbrainEngine,
  isLoopbackMcpUrl,
} from '../lib/gbrain-mcp-locality';

const ROOT = path.resolve(import.meta.dir, '..');
const START = path.join(ROOT, 'bin', 'gstack-skill-start');

let home: string;

function writeGbrainConfig(cfg: unknown, dir = home): void {
  fs.mkdirSync(path.join(dir, '.gbrain'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gbrain', 'config.json'), JSON.stringify(cfg));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-locality-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('isLoopbackMcpUrl', () => {
  test.each([
    'http://127.0.0.1:3131/mcp',
    'http://127.8.9.10/mcp',
    'http://localhost:3131/mcp',
    'HTTP://LOCALHOST/mcp',
    'http://[::1]:3131/mcp',
  ])('%s is loopback', (url) => {
    expect(isLoopbackMcpUrl(url)).toBe(true);
  });

  test.each([
    'https://brain.example.com/mcp',
    'http://127.0.0.1.evil.example/mcp',
    'http://localhost.evil.example/mcp',
    'http://10.0.0.5:3131/mcp',
    'http://0.0.0.0:3131/mcp',
    'ws://127.0.0.1:3131/mcp',
    'wss://localhost/mcp',
    'file://localhost/etc/passwd',
    'not a url',
    '',
    // Userinfo and ${VAR}: Claude Code expands ${VAR} in the url before it
    // connects, so the host it dials is not the one written here.
    'http://evil@127.0.0.1/mcp',
    'http://user:PASSWORD@localhost:3131/mcp',
    'http://:pw@127.0.0.1/mcp',
    'http://${GBRAIN_X}@127.0.0.1:3131/mcp',
    'http://127.0.0.1:3131/${GBRAIN_X}',
  ])('%s is not loopback', (url) => {
    expect(isLoopbackMcpUrl(url)).toBe(false);
  });
});

describe('hasLocalGbrainEngine', () => {
  test('pglite engine, or a database_url, with no remote_mcp marker', () => {
    const env = { HOME: home };
    expect(hasLocalGbrainEngine(env)).toBe(false); // no config
    writeGbrainConfig({ engine: 'pglite', database_path: '/x/brain.pglite' });
    expect(hasLocalGbrainEngine(env)).toBe(true);
    writeGbrainConfig({ engine: 'postgres', database_url: 'postgresql://u@localhost:5432/brain' });
    expect(hasLocalGbrainEngine(env)).toBe(true);
    writeGbrainConfig({ engine: 'pglite', remote_mcp: { mcp_url: 'http://127.0.0.1:3131/mcp' } });
    expect(hasLocalGbrainEngine(env)).toBe(false);
    writeGbrainConfig({ database_url: '  ' });
    expect(hasLocalGbrainEngine(env)).toBe(false);
    // gbrain's isThinClient is `!!remote_mcp`: falsy values are not markers.
    for (const remote_mcp of [null, false, 0, '']) {
      writeGbrainConfig({ engine: 'pglite', remote_mcp });
      expect(hasLocalGbrainEngine(env)).toBe(true);
    }
    for (const remote_mcp of [{}, [], 'x', 1, true]) {
      writeGbrainConfig({ engine: 'pglite', remote_mcp });
      expect(hasLocalGbrainEngine(env)).toBe(false);
    }
  });

  test('honors GBRAIN_HOME as the parent of .gbrain, like gbrainConfigDir', () => {
    const gbrainHome = path.join(home, 'elsewhere');
    writeGbrainConfig({ engine: 'pglite' }, gbrainHome);
    expect(hasLocalGbrainEngine({ HOME: home })).toBe(false);
    expect(hasLocalGbrainEngine({ HOME: home, GBRAIN_HOME: gbrainHome })).toBe(true);
  });
});

describe('classifyGbrainMcpEntry', () => {
  const loopback = { type: 'http', url: 'http://127.0.0.1:3131/mcp' };

  test('loopback http entry over a local engine is local', () => {
    writeGbrainConfig({ engine: 'pglite' });
    expect(classifyGbrainMcpEntry(loopback, { HOME: home })).toBe('local');
    expect(classifyGbrainMcpEntry({ url: 'http://localhost:3131/mcp' }, { HOME: home })).toBe('local');
  });

  test('loopback http entry stays remote without a local engine or with remote_mcp', () => {
    expect(classifyGbrainMcpEntry(loopback, { HOME: home })).toBe('remote');
    writeGbrainConfig({ engine: 'pglite', remote_mcp: { mcp_url: 'http://127.0.0.1:3131/mcp' } });
    expect(classifyGbrainMcpEntry(loopback, { HOME: home })).toBe('remote');
  });

  test('non-loopback http entry stays remote even with a local engine', () => {
    writeGbrainConfig({ engine: 'pglite' });
    for (const type of ['http', 'sse', 'url']) {
      expect(classifyGbrainMcpEntry({ type, url: 'https://brain.example.com/mcp' }, { HOME: home })).toBe('remote');
    }
  });

  test('stdio and command entries are local; empty entries carry no signal', () => {
    expect(classifyGbrainMcpEntry({ type: 'stdio', command: 'gbrain' }, { HOME: home })).toBe('local');
    expect(classifyGbrainMcpEntry({ command: 'gbrain' }, { HOME: home })).toBe('local');
    expect(classifyGbrainMcpEntry({}, { HOME: home })).toBeNull();
    expect(classifyGbrainMcpEntry(undefined, { HOME: home })).toBeNull();
  });
});

describe('classifyGbrainMcpListLine (`claude mcp list`, detect tier 2)', () => {
  beforeEach(() => writeGbrainConfig({ engine: 'pglite' }));

  const LINES: Array<[string, 'local' | 'remote']> = [
    ['gbrain: http://127.0.0.1:3131/mcp (HTTP) - ✓ Connected', 'local'],
    ['gbrain: http://localhost:3131/sse (SSE) - ✓ Connected', 'local'],
    ['gbrain-local: http://[::1]:3131/mcp (HTTP) - ✗ Failed to connect', 'local'],
    ['gbrain: http://127.0.0.1:3131/mcp(x) (HTTP) - ✓ Connected', 'local'],
    ['gbrain: /usr/local/bin/gbrain serve - ✓ Connected', 'local'],
    // A URL cut at ")" or at whitespace would read these as loopback.
    ['gbrain: http://127.0.0.1)@evil.com/mcp (HTTP) - ✓ Connected', 'remote'],
    ['gbrain: http://localhost)@evil.com/mcp (HTTP) - ✓ Connected', 'remote'],
    ['gbrain: http://127.0.0.1 (HTTP)@evil.com/mcp (HTTP) - ✓ Connected', 'remote'],
    ['gbrain: http://127.0.0.1\t.evil.com/mcp (HTTP) - ✓ Connected', 'remote'],
    ['gbrain: http://127.0.0.1 .evil.com/mcp (HTTP) - ✓ Connected', 'remote'],
    ['gbrain: ws://127.0.0.1:3131/mcp (HTTP) - ✓ Connected', 'remote'],
    ['gbrain: https://brain.example.com/mcp (HTTP) - ✓ Connected', 'remote'],
    ['gbrain: https://brain.example.com/sse (SSE) - ✓ Connected', 'remote'],
    ['gbrain: (SSE)', 'remote'],
    ['gbrain: HTTP server - ✓ Connected', 'remote'],
    // Claude Code flattens a newline/CR (and U+2028/2029, NEL, VT, FF) inside
    // a url to a space when it prints the list, so an injected "second line"
    // stays inside this one line and its URL token contains whitespace.
    // These are the lines Claude Code 2.1.311 printed for such urls.
    ['gbrain: http://127.0.0.1 (HTTP) @evil.invalid/mcp (HTTP) - ✘ Failed to connect', 'remote'],
    ['gbrain: https://evil.invalid/a gbrain: http://127.0.0.1:1/mcp (HTTP) - ✓ Connected (HTTP) - ✘ Failed to connect', 'remote'],
  ];

  test.each(LINES)('%j → %s', (line: string, want: 'local' | 'remote') => {
    expect(classifyGbrainMcpListLine(line, { HOME: home })).toBe(want);
  });

  test('a loopback list line without a local engine is remote', () => {
    fs.rmSync(path.join(home, '.gbrain'), { recursive: true, force: true });
    expect(classifyGbrainMcpListLine('gbrain: http://127.0.0.1:3131/mcp (HTTP) - ✓ Connected', { HOME: home })).toBe('remote');
  });
});

// Table-driven parity: the two jq programs bin/gstack-skill-start runs (read
// out of the script, so this checks the shipped text) against the TS rule.
// The config half must match exactly. The URL half is a conservative subset:
// jq may say remote where TS says local (non-canonical loopback spellings such
// as 127.1, 0x7f.1 or 127.0.0.1. that jq's regex does not accept), and
// must never say local where TS says remote. Exact URL parity would mean
// reimplementing WHATWG host parsing in jq; those spellings fall back to the
// old remote-http answer, which is the safe side.
describe('gstack-skill-start jq copy vs the TS rule (table-driven parity)', () => {
  const src = fs.readFileSync(START, 'utf-8');
  const programs = [...src.matchAll(/jq -e '([^']+)'/g)].map((m) => m[1]);
  const JQ_URL = programs.find((p) => p.startsWith('(.url // "")'));
  const JQ_CFG = programs.find((p) => p.includes('remote_mcp'));

  function jqTrue(program: string, input: string): boolean {
    try {
      execFileSync('jq', ['-e', program], { input, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } catch {
      return false;
    }
  }

  test('both jq programs are found in bin/gstack-skill-start', () => {
    expect(JQ_URL).toBeDefined();
    expect(JQ_CFG).toBeDefined();
  });

  // [url, expected TS answer]. jq must never be true where TS is false.
  const URLS: Array<[string, boolean]> = [
    ['http://127.0.0.1:3131/mcp', true],
    ['http://localhost:3131/mcp', true],
    ['HTTP://LOCALHOST/mcp', true],
    ['https://127.0.0.1/mcp', true],
    ['http://[::1]:3131/mcp', true],
    ['http://127.255.255.255:1/x', true],
    ['http://127.0.0.1', true],
    ['http://127.0.0.1:3131?x', true],
    ['http://localhost:65535/', true],
    ['http://127.0.0.1/mcp ', true],
    // Non-canonical loopback spellings: TS local, jq remote (safe direction).
    ['http://127.1/mcp', true],
    ['http://0x7f.1/mcp', true],
    ['http://2130706433/mcp', true],
    ['http://[0:0:0:0:0:0:0:1]/mcp', true],
    ['http://127.0.0.1.:3131/mcp', true],
    [' http://127.0.0.1/mcp', true],
    // WHATWG IDNA maps U+017F to "s": TS local; jq's ascii_downcase does not.
    ['http://localhoſt/mcp', true],
    // Userinfo and ${VAR} (expanded by Claude Code before it connects): remote.
    ['http://evil@127.0.0.1/mcp', false],
    ['http://user:PASSWORD@localhost:3131/mcp', false],
    ['http://${GBRAIN_X}@127.0.0.1:3131/mcp', false],
    ['http://127.0.0.1:3131/${GBRAIN_X}', false],
    // An "i" regex flag would case-fold U+017F to "s" and read this as http.
    ['httpſ://127.0.0.1/mcp', false],
    ['HTTPſ://LOCALHOST/mcp', false],
    // Remote hosts: both must say remote.
    ['http://127.0.0.1)@evil.com/mcp', false],
    ['http://localhost)@evil.com/mcp', false],
    ['http://127.0.0.1@evil.com/mcp', false],
    ['http://localhost:3131' + '@evil.com/mcp', false],
    ['http://127.0.0.1:3131' + '@evil.com/mcp', false],
    ['http://127.0.0.1.evil.example/mcp', false],
    ['http://localhost.evil.example/mcp', false],
    ['http://127.0.0.1.nip.io/mcp', false],
    ['http://127.0.0.1%2eevil.com/', false],
    ['http://127.0.0.1\tevil.com/', false],
    ['http://127.0.0.1\nevil.com/', false],
    ['http://0.0.0.0:3131/mcp', false],
    ['http://[::ffff:127.0.0.1]/mcp', false],
    // Invalid hosts/ports: cannot connect; jq used to say local here.
    ['http://127.0.0.999/mcp', false],
    ['http://127.0.0.256/mcp', false],
    ['http://127.0.0.1:99999/mcp', false],
    ['http://localhost:65536/mcp', false],
    // Non-http schemes.
    ['ws://127.0.0.1/mcp', false],
    ['wss://localhost/mcp', false],
    ['file://localhost/etc', false],
    ['https://brain.example.com/mcp', false],
    ['not a url', false],
    ['', false],
  ];

  test.each(URLS)('url %j: TS %p, jq never local where TS is remote', (url: string, tsWant: boolean) => {
    const ts = isLoopbackMcpUrl(url);
    expect(ts).toBe(tsWant);
    if (!ts) expect(jqTrue(JQ_URL!, JSON.stringify({ url }))).toBe(false);
  });

  test('jq agrees with TS on the canonical spellings gbrain bootstrap writes', () => {
    for (const url of ['http://127.0.0.1:3131/mcp', 'http://localhost:3131/mcp', 'http://[::1]:3131/mcp']) {
      expect(jqTrue(JQ_URL!, JSON.stringify({ url }))).toBe(true);
    }
  });

  const CONFIGS: unknown[] = [
    { engine: 'pglite' },
    { database_url: 'postgresql://u@localhost:5432/brain' },
    { engine: 'postgres', database_url: 'postgresql://db.example.com/x' },
    { database_url: '  ' },
    { database_url: '\n\t' },
    { database_url: '\u00a0\u2028\u3000\ufeff' },
    { database_url: '\u0085' },
    { database_url: 5 },
    { engine: 'pglite', remote_mcp: { mcp_url: 'http://127.0.0.1:3131/mcp' } },
    { engine: 'pglite', remote_mcp: {} },
    { engine: 'pglite', remote_mcp: [] },
    { engine: 'pglite', remote_mcp: 'x' },
    { engine: 'pglite', remote_mcp: 1 },
    { engine: 'pglite', remote_mcp: true },
    { engine: 'pglite', remote_mcp: false },
    { engine: 'pglite', remote_mcp: 0 },
    { engine: 'pglite', remote_mcp: '' },
    { engine: 'pglite', remote_mcp: null },
    { engine: 'PGLite' },
    {},
    null,
    [],
    'str',
  ];

  test.each(CONFIGS.map((c) => [c]))('config %j: jq matches TS exactly', (cfg: unknown) => {
    writeGbrainConfig(cfg);
    const ts = hasLocalGbrainEngine({ HOME: home });
    const jq = jqTrue(JQ_CFG!, fs.readFileSync(path.join(home, '.gbrain', 'config.json'), 'utf-8'));
    expect(jq).toBe(ts);
  });

  test('malformed config: both say no local engine', () => {
    fs.mkdirSync(path.join(home, '.gbrain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gbrain', 'config.json'), '{not json');
    expect(hasLocalGbrainEngine({ HOME: home })).toBe(false);
    expect(jqTrue(JQ_CFG!, '{not json')).toBe(false);
  });
});

// The skill-start preamble prints `ARTIFACTS_SYNC: remote-mode (...)` only
// when it classifies the gbrain entry as remote-http; otherwise a cold home
// prints `ARTIFACTS_SYNC: off`.
describe('gstack-skill-start mirrors the rule', () => {
  function artifactsSyncLine(entry: unknown, gbrainConfig?: unknown, extraEnv: Record<string, string> = {}): string {
    const gstackHome = path.join(home, '.gstack');
    fs.mkdirSync(gstackHome, { recursive: true });
    fs.writeFileSync(path.join(gstackHome, 'config.yaml'), 'update_check: false\n');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: entry } }));
    if (gbrainConfig !== undefined) writeGbrainConfig(gbrainConfig, extraEnv.GBRAIN_HOME ?? home);
    const out = execFileSync(START, ['--skill', 'testskill'], {
      timeout: 30_000,
      encoding: 'utf-8',
      cwd: home,
      env: {
        PATH: process.env.PATH!,
        HOME: home,
        GSTACK_HOME: gstackHome,
        GSTACK_LEASE_DIR: path.join(gstackHome, 'leases'),
        ...extraEnv,
      },
    });
    return out.split('\n').find((l) => l.startsWith('ARTIFACTS_SYNC:')) ?? '';
  }

  test('loopback http entry over a local engine is not remote-mode', () => {
    expect(artifactsSyncLine({ type: 'http', url: 'http://127.0.0.1:3131/mcp' }, { engine: 'pglite' })).toBe('ARTIFACTS_SYNC: off');
  });

  test('GBRAIN_HOME locates the local engine config', () => {
    const gbrainHome = path.join(home, 'gb');
    expect(
      artifactsSyncLine({ type: 'http', url: 'http://localhost:3131/mcp' }, { engine: 'pglite' }, { GBRAIN_HOME: gbrainHome }),
    ).toBe('ARTIFACTS_SYNC: off');
  });

  test('loopback http entry with remote_mcp in the config stays remote-mode', () => {
    expect(
      artifactsSyncLine({ type: 'http', url: 'http://127.0.0.1:3131/mcp' }, { engine: 'pglite', remote_mcp: { mcp_url: 'x' } }),
    ).toMatch(/^ARTIFACTS_SYNC: remote-mode \(managed by brain server 127\.0\.0\.1\)$/);
  });

  test('non-loopback http entry stays remote-mode', () => {
    expect(artifactsSyncLine({ type: 'http', url: 'https://brain.example.com/mcp' }, { engine: 'pglite' })).toMatch(
      /^ARTIFACTS_SYNC: remote-mode \(managed by brain server brain\.example\.com\)$/,
    );
  });
});
