/**
 * A pregate record is publication evidence only when it holds every registered check (GST-2194). A `--only <check>` or
 * `--stage` run writes a record with some checks missing, so `gstack-pregate verify` (and through it
 * `gstack-ship-queue ready` and `gstack-ship-receipt write`) refuses it PREGATE_INCOMPLETE. A staged run at the same
 * head, tree, base and policy as the record it replaces keeps the checks it did not run, so rerunning one stage
 * neither drops an earlier failure nor loses an earlier pass. Pinned on result codes, exit codes and the PREGATE line.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { CHECK_IDS } from '../lib/pregate/index';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo(); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const run = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', ...args]);
const verify = (repo: FixtureRepo) => runBin(repo, 'gstack-pregate', ['verify']);
const record = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')) as { tree: string; verdict: string; checks: { id: string; status: string }[] };
const ALL = CHECK_IDS.length;
const fakePat = () => ['ghp', Array.from(randomBytes(36), b => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('')].join('_');

// Like test/pregate-remote.test.ts, this expects the Linux-host lanes verdict: on windows-latest the fixture's Linux lane is a
// requires-remote obligation too, so the single-obligation assertions and `verify` ok do not hold there. The curation list in
// scripts/lib/windows-curation.ts is the usual home for that; this file skips itself so the shared list is not edited here.
describe.skipIf(process.platform === 'win32')('pregate verify refuses a partial record', () => {
  // Value: protects=a secrets failure from the full run cannot be erased by the tests-stage rerun pregate's own fix line
  // suggests, after a commit moved the tree; fails_when=verify accepts a tests-only record (the GSTA-461 audit repro:
  // PREGATE_VERIFY ok with the token still in HEAD); why_new=no test ran verify on a staged record; seam=none;
  // no_claim=gstack-ship-queue ready's own wording (it calls verifyPregate)
  test('a tests-stage rerun after a commit cannot hide the full run\'s secrets failure', () => {
    const repo = fixture();
    commit(repo, { 'lib/util.js': `exports.add = (a, b) => a + b;\nexports.token = '${fakePat()}';\n` });
    expect(run(repo, []).status).toBe(EXIT.fail);
    expect(record(repo).checks.find(c => c.id === 'secrets')?.status).toBe('fail');
    expect(verify(repo).out).toContain('PREGATE_VERIFY: refused PREGATE_LANE_FAILED');
    commit(repo, { 'README.md': '# fixture, lane fixed\n' });
    const staged = run(repo, ['--stage', 'tests']);
    expect(staged.status, staged.out + staged.err).toBe(EXIT.ok);
    expect(staged.out).toMatch(new RegExp(`^PREGATE: \\S+ tree=[0-9a-f]{12} head=[0-9a-f]{12} checks=1 of ${ALL}$`, 'm'));
    const v = verify(repo);
    expect(v.status).toBe(EXIT.fail);
    expect(v.out).toContain('PREGATE_VERIFY: refused PREGATE_INCOMPLETE');
    expect(v.err).toContain(`checks=1 of ${ALL}`);
    expect(v.err).toMatch(/missing: [^;]*\bsecrets\b/);
  }, 120_000);

  // Value: protects=a one-check or one-stage run on a fresh tree is never a full pass; fails_when=verify accepts
  // `--only strays` (checks=1) or `--stage preflight` (no lanes); why_new=the audit's second repro had no test;
  // seam=none; no_claim=which checks a full run selects
  test('--only and --stage preflight records refuse PREGATE_INCOMPLETE and name the missing checks', () => {
    const repo = fixture();
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' });
    const only = run(repo, ['--only', 'strays']);
    expect(only.status).toBe(EXIT.ok);
    expect(only.out).toMatch(new RegExp(`^PREGATE: pass tree=[0-9a-f]{12} head=[0-9a-f]{12} checks=1 of ${ALL}$`, 'm'));
    const v1 = verify(repo);
    expect(v1.status).toBe(EXIT.fail);
    expect(v1.out).toContain('PREGATE_VERIFY: refused PREGATE_INCOMPLETE');
    expect(v1.err).toContain(`checks=1 of ${ALL}`);
    const pre = run(repo, ['--stage', 'preflight']);
    expect(pre.status).toBe(EXIT.ok);
    const v2 = verify(repo);
    expect(v2.status).toBe(EXIT.fail);
    expect(v2.out).toContain('PREGATE_VERIFY: refused PREGATE_INCOMPLETE');
    expect(v2.err).toContain(`checks=${ALL - 1} of ${ALL} (missing: lanes)`);
  }, 120_000);

  // Value: protects=a staged rerun at the same tree keeps the failure it did not rerun; fails_when=the tests-stage
  // record replaces the failed full run and verify passes with the token in HEAD; why_new=no test reran one stage at
  // an unchanged tree; seam=none; no_claim=a record for another head or tree
  test('a tests-stage rerun at the same tree keeps the earlier secrets failure', () => {
    const repo = fixture();
    commit(repo, { 'lib/util.js': `exports.add = (a, b) => a + b;\nexports.token = '${fakePat()}';\n` });
    expect(run(repo, []).status).toBe(EXIT.fail);
    const staged = run(repo, ['--stage', 'tests']);
    expect(staged.status).toBe(EXIT.fail);
    expect(staged.out).toMatch(/^PREGATE_MERGED: kept \S*secrets\S* /m);
    expect(record(repo).checks.map(c => c.id)).toEqual([...CHECK_IDS]);
    expect(record(repo).checks.find(c => c.id === 'secrets')?.status).toBe('fail');
    expect(verify(repo).out).toContain('PREGATE_VERIFY: refused PREGATE_LANE_FAILED');
  }, 120_000);

  // Value: protects=today's correct paths keep verifying: a full run, and a staged or --only rerun at the same head and
  // tree after a full green run; fails_when=the completeness rule refuses a full record or a same-tree rerun drops the
  // checks it did not run; why_new=the merge rule is new; seam=none; no_claim=remote obligations
  test('a full run verifies, and so does a staged or --only rerun at the same tree after it', () => {
    const repo = fixture();
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' });
    const full = run(repo, []);
    expect(full.status).toBe(EXIT.ok);
    expect(full.out).toMatch(new RegExp(`^PREGATE: pass tree=[0-9a-f]{12} head=[0-9a-f]{12} checks=${ALL} of ${ALL}$`, 'm'));
    expect(full.out).not.toContain('PREGATE_MERGED');
    expect(verify(repo).out).toMatch(/^PREGATE_VERIFY: ok pregate pass is current for tree [0-9a-f]{12}$/m);
    for (const args of [['--stage', 'tests'], ['--stage', 'preflight'], ['--only', 'strays']]) {
      const again = run(repo, args);
      expect(again.status, args.join(' ')).toBe(EXIT.ok);
      expect(again.out).toMatch(/^PREGATE_MERGED: kept \S+ from the record at this tree [0-9a-f]{12}/m);
      expect(again.out).toMatch(new RegExp(`checks=${ALL} of ${ALL}$`, 'm'));
      expect(record(repo).checks.map(c => c.id)).toEqual([...CHECK_IDS]);
      expect(verify(repo).out).toMatch(/^PREGATE_VERIFY: ok pregate pass is current for tree [0-9a-f]{12}$/m);
    }
  }, 180_000);

  // Value: protects=checks carry only into a rerun at the same head, not a reworded commit with the same tree;
  // fails_when=a staged run merges a record from another head; why_new=the merge rule is new; seam=none; no_claim=base moves
  test('a staged run at a new head with the same tree keeps nothing', () => {
    const repo = fixture();
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' });
    expect(run(repo, []).status).toBe(EXIT.ok);
    repo.git('commit', '-q', '--amend', '-m', 'reworded');
    const staged = run(repo, ['--stage', 'tests']);
    expect(staged.status).toBe(EXIT.ok);
    expect(staged.out).not.toContain('PREGATE_MERGED');
    expect(verify(repo).out).toContain('PREGATE_VERIFY: refused PREGATE_INCOMPLETE');
  }, 120_000);
});
