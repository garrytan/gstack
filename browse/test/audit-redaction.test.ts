import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initAuditLog, writeAuditEntry } from '../src/audit';
import { formatDialogLogLine, formatNetworkLogLine } from '../src/buffers';
import { handleMetaCommand } from '../src/meta-commands';

// GST-1631: the audit log is plain JSONL in the state dir, so every value a
// command types (fill, type, js, dialog-accept, cookie, header, storage set,
// skill --arg, and the same inside tab-each and chain) must be redacted before
// truncation and before the line is written. Navigation and click lines stay
// readable. Error text is scrubbed of the same values.

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-audit-redact-'));
  logPath = path.join(dir, 'browse-audit.jsonl');
  initAuditLog(logPath);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(cmd: string, args: string[], error?: string, origin = 'https://example.com/login') {
  writeAuditEntry({
    ts: '2026-11-06T00:00:00.000Z',
    cmd,
    args,
    origin,
    durationMs: 1,
    status: error ? 'error' : 'ok',
    error,
    hasCookies: false,
    mode: 'launched',
  });
}

function raw(): string {
  return fs.readFileSync(logPath, 'utf8');
}

function line(): Record<string, any> {
  const lines = raw().trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

describe('audit args redaction (on-disk line)', () => {
  it('fill keeps the selector and hides a one-word value', () => {
    write('fill', ['#password', 'hunter2']);
    expect(raw()).not.toContain('hunter2');
    expect(line().args).toBe('#password [REDACTED]');
  });

  it('fill hides a multi-word value whole', () => {
    write('fill', ['input[name=pw]', 'correct', 'horse', 'battery']);
    expect(raw()).not.toMatch(/correct|horse|battery/);
    expect(line().args).toBe('input[name=pw] [REDACTED]');
  });

  it('type hides the text and keeps --selector and --', () => {
    write('type', ['s3cretPass']);
    expect(line().args).toBe('[REDACTED]');
    write('type', ['--selector', '#pw', '--', '--s3cretPass']);
    expect(raw()).not.toContain('s3cretPass');
    expect(line().args).toBe('--selector #pw -- [REDACTED]');
  });

  it('js hides the expression and keeps --out and --raw', () => {
    write('js', ['localStorage.setItem("tok","sk-live-123")']);
    expect(line().args).toBe('[REDACTED]');
    write('js', ['document.cookie="sid=sk-live-123"', '--out', '/tmp/out.txt', '--raw']);
    expect(raw()).not.toContain('sk-live-123');
    expect(line().args).toBe('[REDACTED] --out /tmp/out.txt --raw');
  });

  it('dialog-accept hides the prompt text, and a bare dialog-accept stays empty', () => {
    write('dialog-accept', ['my', 'pin', '4321']);
    expect(raw()).not.toContain('4321');
    expect(line().args).toBe('[REDACTED]');
    write('dialog-accept', []);
    expect(line().args).toBe('');
  });

  it('cookie keeps the name and hides the value; no separator hides it whole', () => {
    write('cookie', ['session=abc123xyz']);
    expect(line().args).toBe('session=[REDACTED]');
    write('cookie', ['abc123xyz']);
    expect(line().args).toBe('[REDACTED]');
    expect(raw()).not.toContain('abc123xyz');
  });

  it('header keeps the name and hides the value, quoted or split into words', () => {
    write('header', ['Authorization: Bearer tok_live_999']);
    expect(line().args).toBe('Authorization:[REDACTED]');
    write('header', ['Authorization:', 'Bearer', 'tok_live_999']);
    expect(line().args).toBe('Authorization:[REDACTED]');
    write('header', ['tok_live_999']);
    expect(line().args).toBe('[REDACTED]');
    expect(raw()).not.toContain('tok_live_999');
  });

  it('storage set keeps the key and hides the value; a storage read is unchanged', () => {
    write('storage', ['set', 'authToken', 'eyJhbGciOi.payload.sig']);
    expect(raw()).not.toContain('eyJhbGciOi');
    expect(line().args).toBe('set authToken [REDACTED]');
    write('storage', []);
    expect(line().args).toBe('');
  });

  it('skill run keeps the skill name, arg keys and --timeout, and hides arg values', () => {
    write('skill', ['run', 'login', '--arg', 'password=pa55word!', '--arg', 'user=garry', '--timeout=30']);
    expect(raw()).not.toContain('pa55word!');
    expect(line().args).toBe('run login --arg password=[REDACTED] --arg user=[REDACTED] --timeout=30');
    write('skill', ['list']);
    expect(line().args).toBe('list');
  });

  it('tab-each redacts the command it wraps', () => {
    write('tab-each', ['fill', '#otp', '998877']);
    expect(raw()).not.toContain('998877');
    expect(line().args).toBe('fill #otp [REDACTED]');
    write('tab-each', ['goto', 'https://example.com/a']);
    expect(line().args).toBe('goto https://example.com/a');
  });

  it('chain logs only its step names, in JSON and pipe form', () => {
    write('chain', [JSON.stringify([['goto', 'https://example.com/login'], ['fill', '#pw', 'hunter2'], ['cookie', 'sid=zz9plural'], ['click', '@e3']])]);
    expect(raw()).not.toMatch(/hunter2|zz9plural/);
    expect(line().args).toBe('goto | fill | cookie | click');
    write('chain', ['goto https://example.com | fill #pw "two words" | click @e3']);
    expect(raw()).not.toMatch(/two words|"two|words"/);
    expect(line().args).toBe('goto | fill | click');
  });

  it('a chain that is not a command list is hidden whole', () => {
    write('chain', ['{"fill":"hunter2"}']);
    expect(raw()).not.toContain('hunter2');
    expect(line().args).toBe('[REDACTED]');
  });

  it('leaves navigation and click lines unchanged', () => {
    write('goto', ['https://example.com/login?next=/home']);
    expect(line().args).toBe('https://example.com/login?next=/home');
    write('click', ['@e3']);
    expect(line().args).toBe('@e3');
    write('select', ['#country', 'United', 'States']);
    expect(line().args).toBe('#country United States');
  });
});

describe('redaction runs before truncation', () => {
  it('a long fill value never leaks its head through the 200-char cut', () => {
    const secret = 'S'.repeat(20) + 'x'.repeat(480);
    write('fill', ['#password', secret]);
    expect(raw()).not.toContain('SSSS');
    expect(line().args).toBe('#password [REDACTED]');
  });

  it('a long chain is redacted first and then truncated', () => {
    const steps = Array.from({ length: 30 }, (_, i) => ['fill', `#f${i}`, `secretvalue${i}`]);
    write('chain', [JSON.stringify(steps)]);
    const args = line().args as string;
    expect(raw()).not.toContain('secretvalue');
    expect(args.length).toBeLessThanOrEqual(201);
    expect(args.endsWith('…')).toBe(true);
  });
});

describe('error text is scrubbed of the typed values', () => {
  it('scrubs a fill value echoed by the page error', () => {
    write('fill', ['#password', 'hunter2'], 'locator.fill: could not fill "#password" with "hunter2"');
    expect(raw()).not.toContain('hunter2');
    expect(line().error).toBe('locator.fill: could not fill "#password" with "[REDACTED]"');
  });

  it('scrubs each word of a multi-word value and its JSON-escaped form', () => {
    write('type', ['say', '"quoted"', 'battery'], 'Timeout typing "say \\"quoted\\" battery"; last word battery');
    expect(raw()).not.toMatch(/quoted|battery/);
  });

  it('scrubs secrets from nested chain and tab-each commands', () => {
    write('chain', [JSON.stringify([['header', 'X-Api-Key: k3y-abcdef']])], 'header rejected: k3y-abcdef');
    expect(raw()).not.toContain('k3y-abcdef');
    write('tab-each', ['cookie', 'sid=c00kievalue'], 'cookie c00kievalue invalid');
    expect(raw()).not.toContain('c00kievalue');
  });

  it('scrubs before the 300-char cut, so a value straddling it leaves no prefix', () => {
    write('fill', ['#pw', 'hunter2secret'], 'e'.repeat(295) + 'hunter2secret');
    expect(raw()).not.toContain('hunte');
  });

  it('leaves errors of value-free commands unchanged', () => {
    write('goto', ['https://example.com'], 'net::ERR_NAME_NOT_RESOLVED at https://example.com');
    expect(line().error).toBe('net::ERR_NAME_NOT_RESOLVED at https://example.com');
  });

  it('pipe-form chain tokenizes quoted values like chain does, so an unquoted echo is scrubbed', () => {
    write('chain', ['goto https://example.com | fill #pw "correct horse"'], 'fill failed: value correct horse rejected');
    expect(raw()).not.toMatch(/correct|horse/);
    expect(line().args).toBe('goto | fill');
  });

  it('pipe-form js with a quoted inner --out keeps nothing of the expression', () => {
    write('chain', ['goto https://x | js "a --out b"']);
    expect(line().args).toBe('goto | js');
  });

  it('scrubs a token a js error echoes without its surrounding punctuation', () => {
    write('js', ["localStorage.setItem('t', sk_live_abcdef123)"], 'ReferenceError: sk_live_abcdef123 is not defined');
    expect(raw()).not.toContain('sk_live_abcdef123');
  });

  it('an empty quoted selector in pipe form cannot shift the value into a kept position', () => {
    write('chain', ['fill "" "my-super-secret" | type --selector "" "my-super-secret" | storage set "" "my-super-secret"']);
    expect(raw()).not.toContain('my-super-secret');
  });

  it('a tab or newline inside a pipe-form segment never leaves the value in plain text', () => {
    write('chain', ['goto https://x | fill #pw\nhunter2secret | fill\t#pw\thunter2secret | tab-each fill\t#pw\thunter2secret'], 'Unknown command: fill\t#pw\thunter2secret');
    expect(raw()).not.toContain('hunter2secret');
  });

  it('matches a short value only as a whole token', () => {
    write('type', ['a'], 'type a: failed at a step');
    expect(line().error).toBe('type [REDACTED]: failed at [REDACTED] step');
    write('fill', ['#otp', '5000'], 'locator.fill: Timeout 5000ms exceeded; value 5000 rejected');
    expect(line().error).toBe('locator.fill: Timeout 5000ms exceeded; value [REDACTED] rejected');
  });
});

describe('short value pieces in error text (GST-1635)', () => {
  it('scrubs a 3-digit piece of a js expression, such as a CVV, as a whole token', () => {
    write('js', ["pay('4111111111111111', '123')"], 'Error: card 4111111111111111 cvv 123 rejected at eval:1:5');
    expect(line().error).toBe('Error: card [REDACTED] cvv [REDACTED] rejected at eval:1:5');
  });

  it('scrubs a 2-digit piece but never one inside a longer number', () => {
    write('fill', ['#exp', '07 / 29'], 'invalid expiry 07/29, year 2029');
    expect(line().error).toBe('invalid expiry [REDACTED]/[REDACTED], year 2029');
  });

  it('leaves short word pieces and single digits alone, so ordinary error text survives', () => {
    write('js', ['go(a, 1).is.of'], 'TypeError: a is not a function at eval:1:9; go to page 1');
    expect(line().error).toBe('TypeError: a is not a function at eval:1:9; go to page 1');
  });
});

describe('audit origin keeps scheme, host and path (GST-1635)', () => {
  it('redacts every query value a GET form put in the page URL', () => {
    write('click', ['@e3'], undefined, 'https://example.com/login?user=a&password=hunter2pw&cvv=123');
    expect(raw()).not.toMatch(/hunter2pw|cvv=123|user=a\b/);
    expect(line().origin).toBe('https://example.com/login?user=[REDACTED]&password=[REDACTED]&cvv=[REDACTED]');
  });

  it('drops a fragment and userinfo, and redacts a bare query piece', () => {
    const userinfo = 'bob:s3cretpw';
    write('click', ['@e3'], undefined, `https://${userinfo}@example.com/cb?hunter2pw#access_token=tok_abcdef`);
    expect(raw()).not.toMatch(/s3cretpw|hunter2pw|tok_abcdef|bob/);
    expect(line().origin).toBe('https://example.com/cb?[REDACTED]');
  });

  it('redacts a whole piece whose value is empty or only "=", so a padded bare token keeps nothing', () => {
    write('click', ['@e3'], undefined, 'https://example.com/cb?c2VjcmV0==&flag=&q=x');
    expect(raw()).not.toContain('c2VjcmV0');
    expect(line().origin).toBe('https://example.com/cb?[REDACTED]&[REDACTED]&q=[REDACTED]');
    expect(formatNetworkLogLine({ timestamp: 0, method: 'GET', url: 'https://api.example.com/v1?dG9rZW4=' })).not.toContain('dG9rZW4');
  });

  it('keeps a URL without a query as it was', () => {
    write('click', ['@e3'], undefined, 'https://example.com/a/b');
    expect(line().origin).toBe('https://example.com/a/b');
    write('click', ['@e3'], undefined, 'about:blank');
    expect(line().origin).toBe('about:blank');
  });

  it('cuts an unparseable origin at its query', () => {
    write('click', ['@e3'], undefined, 'not a url?token=hunter2pw');
    expect(line().origin).toBe('not a url');
  });
});

describe('network log line (browse-network.log, GST-1635)', () => {
  it('redacts query values of page-issued request URLs', () => {
    const out = formatNetworkLogLine({ timestamp: 0, method: 'GET', url: 'https://api.example.com/v1/me?access_token=tok_abcdef&page=2', status: 200, duration: 5, size: 10 });
    expect(out).not.toContain('tok_abcdef');
    expect(out).toBe('[1970-01-01T00:00:00.000Z] GET https://api.example.com/v1/me?access_token=[REDACTED]&page=[REDACTED] → 200 (5ms, 10B)');
  });

  it('keeps the pending and unknown placeholders', () => {
    expect(formatNetworkLogLine({ timestamp: 0, method: 'POST', url: 'https://api.example.com/v1/login' }))
      .toBe('[1970-01-01T00:00:00.000Z] POST https://api.example.com/v1/login → pending (?ms, ?B)');
  });

  it('is what the server flush writes', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf8');
    expect(src).toContain('appendSecureFile(NETWORK_LOG_PATH, entries.map(formatNetworkLogLine)');
  });
});

describe('chain line keeps only real command names (fix-check shapes)', () => {
  it('an empty quoted selector before an unquoted multi-word value leaves nothing', () => {
    write('chain', ['fill "" correct horse battery']);
    expect(line().args).toBe('fill');
    write('chain', ['type --selector "" correct horse']);
    expect(line().args).toBe('type');
    write('chain', ['storage set "" a b']);
    expect(line().args).toBe('storage');
    expect(raw()).not.toMatch(/correct|horse|battery/);
  });

  it('a separator other than " | " leaves nothing of the following step', () => {
    write('chain', ['goto https://x |\nfill #pw hunter2secret']);
    expect(line().args).toBe('goto');
    write('chain', ['click @e1 |fill #pw hunter2secret']);
    expect(line().args).toBe('click');
    expect(raw()).not.toContain('hunter2secret');
  });

  it('a tab inside a step leaves nothing of its args', () => {
    write('chain', ['goto https://x | storage set\tauthToken hunter2secret']);
    expect(line().args).toBe('goto | storage');
    write('chain', ['goto https://x | skill run\tlogin password=hunter2secret']);
    expect(line().args).toBe('goto | skill');
    write('chain', ['goto https://x | skill run login --timeout=30\tpassword=hunter2secret']);
    expect(line().args).toBe('goto | skill');
    expect(raw()).not.toMatch(/hunter2secret|authToken/);
  });

  it('a step name that is not a command is redacted', () => {
    write('chain', ['hunter2secret | goto https://x']);
    expect(line().args).toBe('[REDACTED] | goto');
    write('chain', [JSON.stringify([['hunter2secret', 'x']])]);
    expect(line().args).toBe('[REDACTED]');
    expect(raw()).not.toContain('hunter2secret');
  });

  it('each step still writes its own audit line with its args redacted per command', async () => {
    const bm = { getPage: () => ({ waitForLoadState: async () => {} }) } as any;
    const executeCommand = async (body: { command: string; args?: string[] }) => {
      write(body.command, body.args ?? []);
      return { status: 200, result: 'ok' };
    };
    const flows = [
      'goto https://example.com/login | fill #pw "correct horse" | cookie sid=zz9plural | click @e3',
      JSON.stringify([['goto', 'https://example.com/login'], ['fill', '#pw', 'correct horse'], ['cookie', 'sid=zz9plural'], ['click', '@e3']]),
    ];
    for (const flow of flows) {
      fs.rmSync(logPath, { force: true });
      await handleMetaCommand('chain', [flow], bm, async () => {}, null, { executeCommand });
      write('chain', [flow]);
      const lines = raw().trim().split('\n').map(l => JSON.parse(l));
      expect(lines.map(l => [l.cmd, l.args])).toEqual([
        ['goto', 'https://example.com/login'],
        ['fill', '#pw [REDACTED]'],
        ['cookie', 'sid=[REDACTED]'],
        ['click', '@e3'],
        ['chain', 'goto | fill | cookie | click'],
      ]);
      expect(raw()).not.toMatch(/correct|horse|zz9plural/);
    }
  });

  it('the server hands each command its args unjoined', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf8');
    const calls = src.split('writeAuditEntry({').slice(1).map(c => c.slice(0, c.indexOf('});')));
    expect(calls.length).toBe(2);
    for (const call of calls) expect(call).toMatch(/\n\s+args,\n/);
  });
});

describe('dialog log line (browse-dialog.log)', () => {
  it('does not persist the prompt response typed through dialog-accept', () => {
    const out = formatDialogLogLine({ timestamp: 0, type: 'prompt', message: 'Enter PIN', action: 'accepted', response: '4321' });
    expect(out).not.toContain('4321');
    expect(out).toBe('[1970-01-01T00:00:00.000Z] [prompt] "Enter PIN" → accepted "[REDACTED]"');
  });

  it('keeps lines without a response as before', () => {
    expect(formatDialogLogLine({ timestamp: 0, type: 'alert', message: 'Saved', action: 'dismissed' }))
      .toBe('[1970-01-01T00:00:00.000Z] [alert] "Saved" → dismissed');
  });

  it('is what the server flush writes', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf8');
    expect(src).toContain('appendSecureFile(DIALOG_LOG_PATH, entries.map(formatDialogLogLine)');
  });
});
