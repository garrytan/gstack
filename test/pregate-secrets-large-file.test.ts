/**
 * GST-3665: pregate `secrets` scans an added file over gstack-redact's 16 MiB
 * limit in overlapping line-aligned parts instead of failing it unread, and
 * still fails closed on a line it cannot split or a part it cannot read.
 * Every large fixture is built in the test's temporary directory at run time.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanParts } from '../lib/pregate/checks/secrets';
import { scan } from '../lib/redact-engine';

const ROOT = path.resolve(import.meta.dir, '..');
const PREGATE = path.join(ROOT, 'bin', 'gstack-pregate');
const MIB = 1024 * 1024;
const AWS = 'AKIA' + 'ZQ3XN7P2LM4RT8WV';
const PAT = ['ghp', 'Zq8Lm2Xv7Nc4Rt9Wy1Kp6Hd3Fs5Gb0Jx8Ue2'].join('_');
/** An AWS secret key the scanner reports only with `aws_secret_access_key` within 100 characters, here the end of the line before it. */
const AWS_SECRET = ['Zq8Lm2Xv7Nc4Rt9Wy1Kp6Hd3', 'Fs5Gb0Jx8Ue2Ab1C'].join('');
const AWS_SECRET_NAME = 'aws_secret_access_key:';
const PEM = ['-----BEGIN ' + 'RSA PRIVATE KEY-----', ...Array.from({ length: 29 }, (_, i) => 'MIIEowIBAAKCAQEA' + String(i).padStart(2, '0').repeat(24)), '-----END ' + 'RSA PRIVATE KEY-----'];
/** One 1,024-byte line with its newline, so 16,384 of them fill one 16 MiB part. */
const row = (n: number, text = `{"trial":${n},"task":"repo-fix-${n % 97}","passed":${n % 3 > 0}}`) => text.padEnd(1023, ' ');
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

/** A repository whose branch commits `files` on top of main, with pregate's secrets check as the user runs it. */
function repo(files: Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pregate-large-')));
  roots.push(root);
  const dir = path.join(root, 'work');
  const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env, timeout: 120_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  fs.mkdirSync(dir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(dir, 'README'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('init', '-q', '--bare', path.join(root, 'remote.git'));
  git('remote', 'add', 'origin', path.join(root, 'remote.git'));
  git('push', '-q', 'origin', 'main');
  git('fetch', '-q', 'origin');
  git('checkout', '-qb', 'feat');
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  git('add', '.');
  git('commit', '-qm', 'feat');
  const secrets = () => {
    const r = spawnSync(PREGATE, ['--base', 'main', '--only', 'secrets', '--json'], { cwd: dir, encoding: 'utf8', env, timeout: 300_000, maxBuffer: 64 * MIB });
    const check = JSON.parse(r.stdout).checks.find((c: { id: string }) => c.id === 'secrets');
    return { status: check.status as string, detail: check.detail as string, lines: (check.lines ?? []) as string[] };
  };
  return { root, dir, env, mergeBase: git('merge-base', 'origin/main', 'HEAD'), secrets };
}

/** `count` rows of 1,024 bytes, with `at` replacing the rows at those 1-based line numbers. */
function rows(count: number, at: Record<number, string> = {}): string {
  return Array.from({ length: count }, (_, i) => row(i + 1, at[i + 1])).join('\n') + '\n';
}

/** The 1-based line numbers of the findings a fail lists, in order. */
const findingLines = (lines: string[]) => lines.map(l => /added line (\d+)\)$/.exec(l)?.[1]).filter(Boolean).map(Number);

describe('scanParts: line-aligned overlapping parts under the scanner limit (GST-3665)', () => {
  test('text at or under the limit is one part, unchanged', () => {
    expect(scanParts('a\nb', 3)).toEqual([{ first: 0, text: 'a\nb' }]);
  });

  test('parts repeat the last overlap lines of the part before and cover every line in order', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line-${String(i).padStart(4, '0')}`);
    const parts = scanParts(lines.join('\n'), 100, 2, 0);
    expect(Array.isArray(parts) && parts.map(p => p.first)).toEqual([0, 8, 16]);
    expect(Array.isArray(parts) && parts.map(p => p.text)).toEqual([lines.slice(0, 10).join('\n'), lines.slice(8, 18).join('\n'), lines.slice(16).join('\n')]);
  });

  // Value: protects=every part fits the scanner, starts and ends on a line, and no line is skipped; fails_when=a cut lands mid-line, a part passes the limit, a line falls between parts, or the overlap stops shrinking for a long line; why_new=GST-3665; seam=pure splitter; no_claim=the scanner's own verdict
  test('random line lengths, multi-byte text included: each part fits, is line-aligned, and the parts leave no gap', () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    for (let trial = 0; trial < 200; trial++) {
      const max = 40 + rand(200);
      const lines = Array.from({ length: 1 + rand(80) }, () => rand(4) ? 'x'.repeat(rand(max + 1)) : 'é'.repeat(rand(Math.floor(max / 2) + 1)));
      const chars = rand(3) ? 0 : rand(max);
      const parts = scanParts(lines.join('\n'), max, 1 + rand(6), chars);
      if (!Array.isArray(parts)) { expect(chars).toBeGreaterThan(0); continue; }
      let covered = 0;
      for (const { first, text } of parts) {
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(max);
        expect(first).toBeLessThanOrEqual(covered);
        if (first > 0) expect(lines.slice(first, covered).join('\n').length + 1).toBeGreaterThanOrEqual(chars);
        const count = text.split('\n').length;
        expect(text).toBe(lines.slice(first, first + count).join('\n'));
        expect(first + count).toBeGreaterThan(covered);
        covered = first + count;
      }
      expect(covered).toBe(lines.length);
    }
  });

  test('a line one byte over the limit cannot be split and is named; a line exactly at the limit is scanned alone', () => {
    expect(scanParts(['ok', 'x'.repeat(101), 'ok'].join('\n'), 100)).toEqual({ line: 2, why: '101 bytes, over the limit' });
    expect(scanParts(['é'.repeat(50) + 'x', 'ok'].join('\n'), 100)).toEqual({ line: 1, why: '101 bytes, over the limit' });
    expect(scanParts(['ok', 'x'.repeat(100), 'ok'].join('\n'), 100, 256, 0)).toEqual([{ first: 0, text: 'ok' }, { first: 1, text: 'x'.repeat(100) }, { first: 2, text: 'ok' }]);
  });

  // Value: protects=a match and the context its rule reads (a key and the name beside it) always share a part; fails_when=the repeat drops a long line before a cut, or two lines too long to share a part with that context are scanned apart and pass; why_new=GST-3665 review (second-model reader); seam=pure splitter; no_claim=rules reading more than 64K characters around a match
  test('the line before a cut is repeated whole however long it is, and lines that cannot share a part with that context fail', () => {
    const lines = ['x'.repeat(20), 'y'.repeat(60), 'z'.repeat(30)];
    expect(scanParts(lines.join('\n'), 100, 1, 40)).toEqual([{ first: 0, text: lines.slice(0, 2).join('\n') }, { first: 1, text: lines.slice(1).join('\n') }]);
    expect(scanParts(['a'.repeat(60), 'b'.repeat(60)].join('\n'), 100, 256, 30)).toEqual({ line: 2, why: '60 bytes, too long to share the limit with the 30 characters before it that a secret\'s context can span' });
  });

  test('a 40 MiB reading of 1,024-byte lines splits into three 16 MiB parts that repeat 256 lines', () => {
    const parts = scanParts(rows(40_960).slice(0, -1));
    expect(Array.isArray(parts) && parts.map(p => [p.first, p.text.split('\n').length, Buffer.byteLength(p.text) <= 16 * MIB])).toEqual([[0, 16_384, true], [16_128, 16_384, true], [32_256, 8_704, true]]);
  });
});

describe('pregate secrets on an added file over 16 MiB (GST-3665)', () => {
  // Value: protects=a results PR adding a clean data file over 16 MiB passes the secrets check; fails_when=the check hands the whole file to gstack-redact, which refuses it with exit 3 and no report, read as HIGH; why_new=GST-3665 (harness-evals#609, 60.5 MB trials.jsonl); seam=gstack-pregate end to end; no_claim=scan speed on other content
  test('a clean 20 MiB data file passes instead of failing as HIGH', () => {
    const r = repo({ 'results/trials.jsonl': rows(20_480) }).secrets();
    expect({ status: r.status, detail: r.detail }).toEqual({ status: 'pass', detail: '20480 added lines clean in 1 file' });
  }, 300_000);

  // Value: protects=a real secret anywhere in a split file still fails at its own line; fails_when=a part is skipped, a part's findings are dropped, line numbers stay relative to the part, or a block crossing a cut is missed; why_new=GST-3665; seam=gstack-pregate end to end; no_claim=secrets the scanner itself does not recognise
  test('secrets in the first, middle and last parts and a key block across a cut each fail at their own line', () => {
    const pem = Object.fromEntries(PEM.map((line, i) => [16_370 + i, line]));
    const at = { 100: `{"aws_access_key_id":"${AWS}"}`, ...pem, 24_000: `{"token":"${PAT}"}`, 40_000: `{"aws_access_key_id":"${AWS}"}` };
    const text = rows(40_960, at);
    const parts = scanParts(text.slice(0, -1));
    expect(Array.isArray(parts) && parts.map(p => [p.first + 1, p.first + p.text.split('\n').length])).toEqual([[1, 16_384], [16_129, 32_512], [32_257, 40_960]]);
    const r = repo({ 'results/trials.jsonl': text }).secrets();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('credential finding(s)');
    expect([...new Set(findingLines(r.lines))].sort((a, b) => a - b)).toEqual([100, 16_370, 24_000, 40_000]);
  }, 300_000);

  // Value: protects=a secret whose rule needs the line before it is found when a 5 MiB line ends right at a cut; fails_when=the repeat skips long lines, so neither part holds the key and its name; why_new=GST-3665 review (second-model reader); seam=gstack-pregate end to end, with a scanner-level control; no_claim=none
  test('an AWS secret key named at the end of a 5 MiB line before a cut fails at its own line', () => {
    expect(scan(`"${AWS_SECRET}"`, {}).findings.map(f => f.id)).toEqual([]);
    expect(scan(`${AWS_SECRET_NAME}\n"${AWS_SECRET}"`, {}).findings.map(f => f.id)).toEqual(['aws.secret_key']);
    const named = AWS_SECRET_NAME.padStart(5 * MIB - 1, ' ');
    const text = rows(11_264) + named + '\n' + rows(1_024, { 1: `"${AWS_SECRET}"` });
    const parts = scanParts(text.slice(0, -1));
    expect(Array.isArray(parts) && parts.map(p => p.first)).toEqual([0, 11_264]);
    const r = repo({ 'results/trials.jsonl': text }).secrets();
    expect(r.status).toBe('fail');
    expect(r.lines.filter(l => l.includes('aws.secret_key')).map(l => findingLines([l])[0])).toEqual([11_266]);
  }, 300_000);

  // Value: protects=a line too long to split keeps failing closed and says why; fails_when=the over-limit line is skipped, cut mid-line or scanned as a pass; why_new=GST-3665; seam=gstack-pregate end to end; no_claim=none
  test('a single line over 16 MiB fails closed and names the line', () => {
    const r = repo({ 'results/blob.json': `{"a":1}\n"${'x'.repeat(16 * MIB)}"\n{"b":2}\n` }).secrets();
    expect(r.status).toBe('fail');
    expect(r.detail).toBe("1 added line(s) cannot be scanned within gstack-redact's 16 MiB limit; a line is never cut for scanning, so it never passes");
    expect(r.lines).toContain(`line not scanned within 16 MiB: results/blob.json, added line 2 (${16 * MIB + 2} bytes, over the limit)`);
  }, 300_000);

  // Value: protects=a part the scanner does not report on never passes; fails_when=a later part's exit 0 or 2 with no JSON reads as clean or a warning; why_new=GST-3665 (each part is its own scanner run); seam=runScriptSync replaced in a child process; no_claim=gstack-redact's own output
  test('a part that prints no JSON or exits outside the contract fails closed', () => {
    const f = repo({ 'results/trials.jsonl': rows(20_480) });
    const worker = path.join(f.root, 'worker.ts');
    const invocation = path.join(ROOT, 'lib', 'script-invocation.ts');
    fs.writeFileSync(worker, `
import { mock } from 'bun:test';
const real = await import(${JSON.stringify(invocation)});
const [status, stdout] = JSON.parse(process.argv[2]);
let calls = 0;
mock.module(${JSON.stringify(invocation)}, () => ({ ...real, runScriptSync: () => ++calls === 1 ? { status: 0, stdout: '{"findings":[]}', stderr: '' } : { status, stdout, stderr: 'stub' } }));
const { secretsCheck } = await import(${JSON.stringify(path.join(ROOT, 'lib', 'pregate', 'checks', 'secrets.ts'))});
const scratch = ${JSON.stringify(path.join(f.root, 'scratch'))};
require('node:fs').mkdirSync(scratch, { recursive: true });
const check = await secretsCheck.run({ repoRoot: ${JSON.stringify(f.dir)}, mergeBase: ${JSON.stringify(f.mergeBase)}, wtree: 'w', head: 'h', baseRef: 'origin/main', baseSha: ${JSON.stringify(f.mergeBase)}, touched: [], config: { allowlist: [] }, scratch, timeoutMs: 60_000, env: process.env });
console.log(JSON.stringify({ calls, status: check.status, code: check.code, detail: check.detail }));
`);
    const run = (status: number, stdout: string) => {
      const r = spawnSync(process.execPath, [worker, JSON.stringify([status, stdout])], { cwd: f.dir, encoding: 'utf8', env: f.env, timeout: 120_000 });
      if (r.status !== 0) throw new Error(`worker exited ${r.status}: ${r.stderr}`);
      return JSON.parse(r.stdout.trim().split('\n').pop() || 'null');
    };
    expect(run(0, '')).toMatchObject({ calls: 2, status: 'incomplete', code: 'PREGATE_ENVIRONMENT', detail: 'gstack-redact printed no JSON report; an incomplete scan never passes' });
    expect(run(2, 'not json')).toMatchObject({ calls: 2, status: 'incomplete', code: 'PREGATE_ENVIRONMENT' });
    expect(run(1, '')).toMatchObject({ calls: 2, status: 'incomplete', code: 'PREGATE_ENVIRONMENT', detail: 'gstack-redact exited 1; an incomplete scan never passes' });
    expect(run(3, '')).toMatchObject({ calls: 2, status: 'fail', code: 'PREGATE_SECRETS' });
  }, 300_000);
});
