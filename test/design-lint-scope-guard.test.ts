/**
 * The scope guard for GST-1741's app profile: --scope page and --scope
 * component print the same bytes and exit with the same codes on the existing
 * design-lint fixtures as bin/gstack-design-lint did on origin/main before the
 * app profile (e58be61). The golden holds each case's exit code, line count
 * and sha256; test/fixtures/ui-spacing/scope-guard-golden.json says how it was
 * produced. Static tier only: the render tier's numbers depend on the browser.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-design-lint');

function runBin(args: string[]) {
  const r = Bun.spawnSync([BIN, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe.skipIf(process.platform === 'win32')('design-lint scope guard: page and component profiles unchanged by --scope app', () => {
  test('page and component output and exit codes on the existing fixtures match origin/main byte for byte', () => {
    const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/ui-spacing/scope-guard-golden.json'), 'utf8')) as { cases: Array<{ args: string[]; code: number; sha256: string; lines: number }> };
    expect(golden.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of golden.cases) {
      const r = runBin(c.args);
      expect([c.args.join(' '), r.code, r.out.split('\n').length - 1, new Bun.CryptoHasher('sha256').update(r.out).digest('hex')]).toEqual([c.args.join(' '), c.code, c.lines, c.sha256]);
    }
  });

  test('the app rules never print under page or component scope, and --rules lists them as app rules at ask', () => {
    const page = runBin(['test/fixtures/design-lint']);
    const component = runBin(['--scope', 'component', 'test/fixtures/design-lint/tailwind-fail']);
    for (const id of ['row-crowding', 'copy-flush-under-list', 'note-in-row-weight', 'small-hit-area', 'section-overflow']) {
      expect(page.out).not.toContain(' ' + id + ' ');
      expect(component.out).not.toContain(' ' + id + ' ');
      expect(runBin(['--rules']).out).toMatch(new RegExp('^ask\\s+' + id + '\\s+app\\s', 'm'));
    }
  });
});
