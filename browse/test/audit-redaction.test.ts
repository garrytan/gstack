import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initAuditLog, writeAuditEntry } from '../src/audit';
import { formatDialogLogLine } from '../src/buffers';

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

function write(cmd: string, args: string[], error?: string) {
  writeAuditEntry({
    ts: '2026-11-06T00:00:00.000Z',
    cmd,
    args,
    origin: 'https://example.com/login',
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

  it('chain redacts every subcommand, in JSON and pipe form', () => {
    write('chain', [JSON.stringify([['goto', 'https://example.com/login'], ['fill', '#pw', 'hunter2'], ['cookie', 'sid=zz9plural'], ['click', '@e3']])]);
    expect(raw()).not.toMatch(/hunter2|zz9plural/);
    expect(JSON.parse(line().args)).toEqual([['goto', 'https://example.com/login'], ['fill', '#pw', '[REDACTED]'], ['cookie', 'sid=[REDACTED]'], ['click', '@e3']]);
    write('chain', ['goto https://example.com | fill #pw "two words" | click @e3']);
    expect(raw()).not.toMatch(/two words|"two|words"/);
    expect(line().args).toBe('goto https://example.com | fill #pw [REDACTED] | click @e3');
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
    expect(line().args).toBe('goto https://example.com | fill #pw [REDACTED]');
  });

  it('pipe-form js with a quoted inner --out keeps nothing of the expression', () => {
    write('chain', ['goto https://x | js "a --out b"']);
    expect(line().args).toBe('goto https://x | js [REDACTED]');
  });

  it('scrubs a token a js error echoes without its surrounding punctuation', () => {
    write('js', ["localStorage.setItem('t', sk_live_abcdef123)"], 'ReferenceError: sk_live_abcdef123 is not defined');
    expect(raw()).not.toContain('sk_live_abcdef123');
  });

  it('matches a short value only as a whole token', () => {
    write('type', ['a'], 'type a: failed at a step');
    expect(line().error).toBe('type [REDACTED]: failed at [REDACTED] step');
    write('fill', ['#otp', '5000'], 'locator.fill: Timeout 5000ms exceeded; value 5000 rejected');
    expect(line().error).toBe('locator.fill: Timeout 5000ms exceeded; value [REDACTED] rejected');
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
