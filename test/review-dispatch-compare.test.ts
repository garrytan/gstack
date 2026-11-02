import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScriptSync } from '../lib/script-invocation';

const ROOT = path.join(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'review-dispatch-compare.ts');
const FIXTURES = ['test/fixtures/review-depth/docs-only.json', 'test/fixtures/review-depth/code.json'].map(f => path.join(ROOT, f));
const run = (args: string[]) => {
  const r = runScriptSync(SCRIPT, [...FIXTURES.flatMap(f => ['--fixture', f]), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  expect(r.status).toBe(0);
  return r.stdout as string;
};

describe('scripts/review-dispatch-compare.ts', () => {
  test('the new policy never dispatches more reviewers than the legacy one, and a docs diff costs under a third', () => {
    const out = JSON.parse(run(['--json']));
    expect(out.tokens_source).toBe('DEFAULT');
    expect(out.ship.length).toBe(10);
    for (const row of out.ship) {
      expect(row.new_dispatches).toBeLessThanOrEqual(row.legacy_dispatches);
      expect(row.new_tokens).toBeLessThanOrEqual(row.legacy_tokens);
    }
    for (const row of out.ship.filter((r: any) => r.class === 'docs')) expect(row.ratio).toBeLessThan(0.34);
    for (const f of out.autoplan) for (const r of f.runs) expect(r.next).toBeLessThanOrEqual(r.legacy);
  });

  test('--tokens replaces the default output estimates and the table says which it used', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-compare-'));
    try {
      const tok = path.join(dir, 'measured.json');
      fs.writeFileSync(tok, JSON.stringify({ specialist: { full: 6929, light: 5446 } }));
      const table = run(['--tokens', tok]);
      expect(table).toContain(`TOKENS: measured (${tok})`);
      expect(table).toMatch(/^SHIP_TOKEN_RATIO: median=0\.\d+ min=0\.\d+ max=\d\.\d+ \(n=10\)$/m);
      expect(table).toMatch(/^SHIP_TOKEN_RATIO_BY_CLASS: docs median=0\.\d+ \(n=5\); gate median=0\.\d+ \(n=5\)$/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
