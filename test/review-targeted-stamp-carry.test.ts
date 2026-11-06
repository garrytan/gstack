/**
 * GST-1689 (GBRA-345, gbrain #8727): gstack-ship-receipt write and gstack-review-plan classify the change after a targeted
 * read with one classifier (docsChangeSince). A /ship restamp (VERSION, manifests, CHANGELOG re-heading, stamp_patterns lines)
 * plus a plain docs-audit edit carries the record at write, and the plan agrees with NEXT: done; a code change drops it, and a
 * docs edit that adds a numeric claim on a money-class PR drops it with the plan dispatching the one targeted reader.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { checkoutTree } from '../lib/review-brief';
import { BASE_POLICY, cleanup, makeFixtureRepo, mergeMain, restamp, runBin, type FixtureRepo } from './helpers/restamp-fixture';

setDefaultTimeout(180_000);
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const commit = (repo: FixtureRepo, files: Record<string, string>, msg: string) => {
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo.work, f)), { recursive: true }); fs.writeFileSync(path.join(repo.work, f), t); }
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', msg);
  return repo.git('rev-parse', 'HEAD');
};

/**
 * A money-class branch with an [Unreleased] CHANGELOG entry and a stamp_patterns line in a code file, read clean by the
 * targeted reader through the real dispatch steps: the commit it read, the record verify wrote and the targeted patch-id.
 */
function readBranch(): { repo: FixtureRepo; read: string; record: string; ran: string } {
  const repo = makeFixtureRepo({ prefix: 'gst1689-', policy: { ...BASE_POLICY, stamp_paths: ['docs/**/*.md', 'src/meta.ts'], stamp_patterns: ["CHARGE_SINCE = '{version}'"] } });
  repos.push(repo);
  repo.git('checkout', '-q', '-b', 'feat');
  const changelog = fs.readFileSync(path.join(repo.work, 'CHANGELOG.md'), 'utf8').replace('# Changelog\n', '# Changelog\n\n## [Unreleased]\n\n- Adds a per-run spend cap.\n');
  const read = commit(repo, { 'src/charge.ts': 'export const spend_cap_usd = 5;\n', 'src/meta.ts': "export const CHARGE_SINCE = '1.2.4.0';\n", 'CHANGELOG.md': changelog }, 'charge');
  const out = path.join(repo.root, 'read');
  const ledger = path.join(out, 'review-ledger.jsonl');
  const render = runBin(repo, 'gstack-review-dispatch', ['render', '--role', 'targeted', '--classes', 'money', '--diff-base', repo.git('merge-base', 'origin/main', 'HEAD'), '--out', out]);
  expect(render.status, render.err).toBe(0);
  expect(runBin(repo, 'gstack-review-dispatch', ['sent', '--ledger', ledger, '--role', 'targeted', '--sent', /file=(\S+)/.exec(render.out)![1]!]).status).toBe(0);
  fs.writeFileSync(path.join(out, 'targeted.out'), `REVIEWED_TREE: ${checkoutTree(repo.work)}\nNO FINDINGS\n`);
  expect(runBin(repo, 'gstack-review-dispatch', ['collect', '--ledger', ledger, '--role', 'targeted', '--output', path.join(out, 'targeted.out'), '--merged', path.join(out, 'merged.jsonl')]).status).toBe(0);
  fs.writeFileSync(path.join(out, 'judged.jsonl'), '');
  expect(runBin(repo, 'gstack-review-dispatch', ['judge', '--ledger', ledger, '--merged', path.join(out, 'merged.jsonl'), '--judged', path.join(out, 'judged.jsonl')]).status).toBe(0);
  const record = path.join(repo.root, 'targeted.json');
  const v = runBin(repo, 'gstack-review-dispatch', ['verify', '--ledger', ledger, '--targeted-out', record]);
  expect(v.out).toContain('TARGETED_RECORD: classes=money status=done findings=0 ');
  const plan = JSON.parse(runBin(repo, 'gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--json']).out);
  expect(plan.targeted.classes).toEqual(['money']);
  return { repo, read, record, ran: plan.targeted.targeted_patch_id };
}

/** /ship Step 12's restamp to 1.2.5.0, committed: VERSION, manifests, the CHANGELOG re-heading and the stamp_patterns line. */
function restampTo(repo: FixtureRepo, version = '1.2.5.0'): void {
  const r = restamp(repo, ['--version', version]);
  expect(r.status, r.err).toBe(EXIT.ok);
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', `restamp ${version}`);
  expect(fs.readFileSync(path.join(repo.work, 'src', 'meta.ts'), 'utf8')).toBe(`export const CHARGE_SINCE = '${version}';\n`);
}

const write = (repo: FixtureRepo, record: string) => runBin(repo, 'gstack-ship-receipt', ['write', '--base', 'main', '--session-kind', 'unattended', '--review-targeted', `@${record}`, '--json']);
/** The plan after a clean fix-check, with the documented recovery flags: the commit the reader read and its targeted patch-id. */
const planAfter = (repo: FixtureRepo, read: string, ran: string) => runBin(repo, 'gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--pass', '1', '--last', 'fix-check', '--fixed-below', '--range-base', read, '--targeted-ran', ran]);
const dispatches = (out: string) => out.split('\n').filter(l => l.startsWith('DISPATCH: '));

describe('GST-1689: the receipt and the review plan agree on what carries a targeted record', () => {
  // Value: protects=a restamp (VERSION, package.json, lockfile, CHANGELOG re-heading, a stamp_patterns line in a code file) plus a
  //   plain docs-audit edit after a clean targeted read carries the record at write, as the plan already said (GBRA-345: write refused,
  //   the plan printed NEXT: done, and only a 3-reader third round could finish); fails_when=write refuses the record or the plan
  //   dispatches a reader; seam=gstack-ship-receipt write --review-targeted and gstack-review-plan --range-base --targeted-ran;
  //   no_claim=what the reader finds
  test('restamp plus a plain docs-audit edit: write binds the record and the plan is done', () => {
    const { repo, read, record, ran } = readBranch();
    restampTo(repo);
    commit(repo, { 'docs/run-order.md': '# Run order\n\nRead the overview first, then the walkthrough.\n' }, 'Step 14.5 docs audit');
    const w = write(repo, record);
    expect(w.status, w.err).toBe(EXIT.ok);
    expect(JSON.parse(w.out).review_targeted).toMatchObject({ classes: ['money'], status: 'done' });
    const p = planAfter(repo, read, ran);
    expect(p.status, p.err).toBe(0);
    expect(p.out).toContain('NEXT: done');
    expect(dispatches(p.out)).toEqual([]);
    expect(p.out).toContain('is plain docs and release stamps, which the targeted record carries');
  });

  // Value: protects=a restamp alone after the read is release stamps, which carry the record, with the plan's stamps-only reason;
  //   fails_when=an empty docs remainder stops counting as plain; seam=gstack-ship-receipt write and the plan's skip reason
  test('restamp alone: write binds the record and the plan is done', () => {
    const { repo, read, record, ran } = readBranch();
    restampTo(repo);
    const w = write(repo, record);
    expect(w.status, w.err).toBe(EXIT.ok);
    expect(JSON.parse(w.out).review_targeted).toMatchObject({ classes: ['money'], status: 'done' });
    const p = planAfter(repo, read, ran);
    expect(p.out).toContain('NEXT: done');
    expect(dispatches(p.out)).toEqual([]);
    expect(p.out).toContain('is release stamps, which the targeted record carries');
  });

  // Value: protects=a slot restamp after a base merge brought a sibling release whose CHANGELOG entry has a numeric line still
  //   carries the record: main's released section is not the PR's docs change; fails_when=the CHANGELOG is classified against the
  //   pre-merge read, so write refuses and the plan dispatches the reader; seam=gstack-ship-receipt write and gstack-review-plan
  test('base merge with a sibling release, then restamp: write binds the record and the plan is done', () => {
    const { repo, read, record, ran } = readBranch();
    repo.git('checkout', '-q', 'main');
    const cl = fs.readFileSync(path.join(repo.work, 'CHANGELOG.md'), 'utf8').replace('# Changelog\n', '# Changelog\n\n## [1.2.5.0] - 2026-10-20\n\n- Cuts startup time by 40%.\n');
    commit(repo, { 'CHANGELOG.md': cl, VERSION: '1.2.5.0\n' }, 'sibling release');
    repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feat');
    mergeMain(repo);
    restampTo(repo, '1.2.6.0');
    const w = write(repo, record);
    expect(w.status, w.err).toBe(EXIT.ok);
    expect(JSON.parse(w.out).review_targeted).toMatchObject({ classes: ['money'], status: 'done' });
    const p = planAfter(repo, read, ran);
    expect(p.out).toContain('NEXT: done');
    expect(dispatches(p.out)).toEqual([]);
    expect(p.out).toContain('is release stamps, which the targeted record carries');
  });

  // Value: protects=a one-line code change after the read still drops the record, release stamps beside it or not; fails_when=the
  //   stamp carry swallows a code edit; seam=gstack-ship-receipt write --review-targeted and the plan's skip reason
  test('restamp plus a one-line code change: write refuses and the plan sends it to the review loop', () => {
    const { repo, read, record, ran } = readBranch();
    restampTo(repo);
    commit(repo, { 'src/charge.ts': 'export const spend_cap_usd = 50;\n' }, 'code after the read');
    const w = write(repo, record);
    expect(w.status).toBe(EXIT.fail);
    expect(w.err).toContain(`the targeted reader read ${read.slice(0, 12)}`);
    const p = planAfter(repo, read, ran);
    expect(p.status, p.err).toBe(0);
    expect(dispatches(p.out)).toEqual([]);
    expect(p.out).toContain('is not docs-only (src/charge.ts), so it takes the review loop');
  });

  // Value: protects=on a money-class PR a docs edit that adds a numeric claim still drops the record as strictly as before, and the
  //   plan dispatches the one targeted reader the receipt asks for rather than printing done; fails_when=the stamp carry lets a
  //   claim through, or the plan and the receipt disagree; seam=gstack-ship-receipt write --review-targeted and gstack-review-plan
  test('restamp plus a docs edit with a numeric claim on a money-class PR: write refuses and the plan dispatches the targeted reader', () => {
    const { repo, read, record, ran } = readBranch();
    restampTo(repo);
    commit(repo, { 'docs/run-order.md': '# Run order\n\nEach run now finishes 40% faster.\n' }, 'docs claim');
    const w = write(repo, record);
    expect(w.status).toBe(EXIT.fail);
    expect(w.err).toContain(`the targeted reader read ${read.slice(0, 12)}`);
    const p = planAfter(repo, read, ran);
    expect(p.status, p.err).toBe(0);
    expect(p.out).toContain('NEXT: targeted');
    expect(dispatches(p.out)).toEqual(['DISPATCH: targeted targeted effort=full classes=money']);
    expect(p.out).toContain(`TARGETED_DELTA: range_base=${read} paths=docs/run-order.md classes=money`);
  });
});
