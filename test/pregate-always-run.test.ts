/**
 * GST-167 PR 1 (GST-98): whole-tree tests named in .gstack/always-run.json join
 * every selection that runs a test, because no touched file maps to a scanner
 * that reads the whole tree. #3592 and #3593 passed their selected gate and
 * then failed CI on exactly these tests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { ALWAYS_RUN_PATH, alwaysRunTests } from '../lib/pregate/lane-selection';
import { listRepoFiles, isTestFile } from '../lib/pregate/import-graph';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const SCANNER = "const test = require('node:test');\ntest('scans the tree', () => {});\n";
const repos: FixtureRepo[] = [];
const fixture = (alwaysRun: unknown) => {
  const r = makeFixtureRepo({ baseFiles: { 'test/tree-tripwire.test.js': SCANNER, ...(alwaysRun === undefined ? {} : { [ALWAYS_RUN_PATH]: typeof alwaysRun === 'string' ? alwaysRun : JSON.stringify(alwaysRun) }) } });
  repos.push(r);
  return r;
};
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const lanes = (repo: FixtureRepo) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--only', 'lanes', '--explain']);

describe('always_run selection', () => {
  test('a code change adds the listed scanner the import graph never selects; without the file it is not added', () => {
    const repo = fixture({ tests: ['test/*-tripwire.test.js', 'test/missing-*.test.js'] });
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' });
    const r = lanes(repo);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('test/util.test.js ← lib/util.js');
    expect(r.out).toContain(`test/tree-tripwire.test.js (always_run, ${ALWAYS_RUN_PATH})`);
    expect(r.out).toContain(`${ALWAYS_RUN_PATH}: test/missing-*.test.js matches no test file`);

    const bare = fixture(undefined);
    commit(bare, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' });
    const b = lanes(bare);
    expect(b.status).toBe(EXIT.ok);
    expect(b.out).toContain('test/util.test.js ← lib/util.js');
    expect(b.out).not.toContain('always_run');
  });

  test('a docs-only branch adds nothing; editing the list itself runs it and owes no lane', () => {
    const docs = fixture({ tests: ['test/*-tripwire.test.js'] });
    commit(docs, { 'docs/README.md': '# docs\n\nupdated\n' });
    const d = lanes(docs);
    expect(d.status).toBe(EXIT.ok);
    expect(d.out).not.toContain('always_run');

    const list = fixture({ tests: ['test/*-tripwire.test.js'] });
    commit(list, { [ALWAYS_RUN_PATH]: JSON.stringify({ tests: ['test/tree-*.test.js'] }) });
    const l = lanes(list);
    expect(l.status).toBe(EXIT.ok);
    expect(l.out).toContain(`${ALWAYS_RUN_PATH}: pin file validated by pregate`);
    expect(l.out).toContain(`test/tree-tripwire.test.js (always_run, ${ALWAYS_RUN_PATH})`);
    expect(l.err).not.toContain('PREGATE_NO_LANE');
  });

  test('a malformed list stops with a message naming the file and the fix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-always-run-'));
    try {
      fs.mkdirSync(path.join(dir, '.gstack'));
      fs.writeFileSync(path.join(dir, ALWAYS_RUN_PATH), '{ not json');
      expect(() => alwaysRunTests(dir, [])).toThrow(`${ALWAYS_RUN_PATH}: not valid JSON`);
      fs.writeFileSync(path.join(dir, ALWAYS_RUN_PATH), JSON.stringify({ tests: ['ok', ''] }));
      expect(() => alwaysRunTests(dir, [])).toThrow('"tests" must be a list of non-empty glob strings');
      fs.writeFileSync(path.join(dir, ALWAYS_RUN_PATH), JSON.stringify({ tests: 'test/*.ts' }));
      expect(() => alwaysRunTests(dir, [])).toThrow('"tests" must be a list of non-empty glob strings');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("gstack's own list: every glob names a tracked test, and the GST-98 scanners are on it", () => {
    const tracked = listRepoFiles(ROOT).filter(isTestFile);
    const own = alwaysRunTests(ROOT, tracked);
    expect(own.unmatched).toEqual([]);
    for (const t of ['test/spawnsync-timeout-tripwire.test.ts', 'test/script-invocation-tripwire.test.ts', 'test/egress-receipt-wiring.test.ts',
      'test/env-host-fence-conformance.test.ts', 'test/free-fixtures.test.ts', 'test/bun-entry-isolation.test.ts', 'test/module-size-ratchet.test.ts']) {
      expect(own.tests).toContain(t);
    }
    expect(own.tests).not.toContain('test/host-conformance.test.ts');
  });
});
