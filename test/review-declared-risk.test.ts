import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyDiff, depthOfCommitInput } from '../lib/review-depth';
import { matchRisk } from '../lib/review-risk';
import { receiptReviewAtHead } from '../lib/ship-receipt-depth';
import { ARTIFACT_SCHEMAS, checkSchema, type ValidationError } from '../lib/headless-artifacts';

const BIN = path.join(import.meta.dir, '..', 'bin');
const money = (p: string, lines: string[]) => matchRisk({ codePaths: [p], added: { [p]: lines }, scopeAuth: false }).get('money');

// GST-1129: gstack-evals#170 (GEVA-221) reserves and binds paid spend in quick/laneb/r3/screen.ts. These are its run() hunk's added
// lines without the UBICLOUD_API_KEY line, which was the only thing that took the review to full depth.
const SCREEN = 'quick/laneb/r3/screen.ts';
const GEVA221 = [
  '  const bound = ledger + ".bound";',
  '  if (existsSync(bound)) throw new Error(boundTo());',
  '  const runner = process.env.UBI_RUNNER ?? "";',
  '  const ttl = process.env.UBI_TTL_HOURS || "3";',
  '  bindCheck(ledger, m, configs);',
  '    throw new Error(boundTo());',
];

describe('GST-1129 item 1: code that reserves or binds spend is money (GEVA-221)', () => {
  test("GEVA-221's run() hunk, without the UBICLOUD_API_KEY line, plans full depth with money in the risk list", () => {
    expect(money(SCREEN, GEVA221)).toBe('money line: ' + SCREEN);
    const d = depthOfCommitInput({ paths: [SCREEN], gateTagged: 0, added: { [SCREEN]: GEVA221 }, perPath: [{ path: SCREEN, lines: GEVA221.length, binary: false }] });
    expect([d.depth, d.risk]).toEqual(['full', ['money']]);
  });
  test.each([['reserveSession(ledger, item)'], ['const ok = bindCap(item, cap);'], ['lease.settle(budget)'], ['await reserveSpend(id)'], ['if (spendCap === null) return;'], ['const leased = leaseCredits(n);']])('money: %s', line => {
    expect(money('src/run.ts', [line])).toBeDefined();
  });
  test.each([['appendEvent(m.ledger, { event: "rendered" });'], ['const bound = Math.min(a, b);'], ['reserve(slots);'], ['handler.bind(this);'], ['const cap = Math.max(0, n);']])('not money: %s', line => {
    expect(money('src/run.ts', [line])).toBeUndefined();
  });
  test('prose never names money by these pairs: skill text says binds and ledger in passing (#3698, #3798)', () => {
    expect(money('capy/skill/gstack/SKILL.md', ['Each pass binds its reviewers to the review ledger before Step 11.'])).toBeUndefined();
    expect(money('src/run.ts', ['Each pass binds its reviewers to the review ledger before Step 11.'])).toBeDefined();
  });
  test('code paths only (HARN-1): a data file and a stats script with the same words never name money', () => {
    expect(money('runs/item.json', ['  "bindCheck": "ledger", "reserve": "budget"'])).toBeUndefined();
    expect(money('docs/results/bind-check.py', ['bindCheck(ledger, m)'])).toBeUndefined();
  });
});

describe('GST-1129 item 2: a declared risk class only raises the depth', () => {
  const light = { paths: ['src/app.ts'], gateTagged: 0, perPath: [{ path: 'src/app.ts', lines: 10, binary: false }] };
  test('a class the matcher missed raises light to full, and the result keeps detected and declared apart', () => {
    expect(depthOfCommitInput(light).depth).toBe('light');
    const d = depthOfCommitInput({ ...light, declared: ['money'] });
    expect([d.depth, d.risk, d.detected, d.declared]).toEqual(['full', ['money'], [], ['money']]);
  });
  test('declaring nothing or another class never drops a detected one; a docs diff with a declared class plans full', () => {
    const c = classifyDiff({ paths: ['lib/billing.ts'], gateTagged: 0, declared: [] });
    expect([c.risk, c.detected, c.declared]).toEqual([['money'], ['money'], []]);
    const both = classifyDiff({ paths: ['lib/billing.ts'], gateTagged: 0, declared: ['auth'] });
    expect([both.risk, both.detected, both.declared]).toEqual([['money', 'auth'], ['money'], ['auth']]);
    expect(depthOfCommitInput({ paths: ['docs/a.md'], gateTagged: 0, declared: ['security'] }).depth).toBe('full');
  });

  function repo(): { dir: string; head: string; state: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-state-'));
    const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 30_000 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), '# x\n'); git('add', '.'); git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', 'feat');
    fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/app.ts'), 'export const a = 1;\n');
    git('add', '.'); git('commit', '-qm', 'change');
    return { dir, head: git('rev-parse', 'HEAD'), state };
  }
  test('gstack-review-plan --declare-risk prints the declared and detected classes and plans full; an unknown class is a usage error', () => {
    const r = repo();
    const plan = (...a: string[]) => spawnSync(path.join(BIN, 'gstack-review-plan'), ['--base', 'main', '--gate-tagged', '0', ...a], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(plan().stdout).toMatch(/^REVIEW_DEPTH: light /m);
    const out = plan('--declare-risk', 'money').stdout;
    expect(out).toMatch(/^REVIEW_DEPTH: full .*reasons=risk:money,/m);
    expect(out).toContain('RISK_DECLARED: classes=money detected=none');
    const bad = plan('--declare-risk', 'cash');
    expect([bad.status, bad.stdout]).toEqual([2, '']);
    expect(bad.stderr).toContain('--declare-risk cash');
  }, 60_000);
  test('the receipt records declared and detected classes beside the raised depth, and the schema accepts them', () => {
    const r = repo();
    const prior = process.env.GSTACK_STATE_ROOT;
    process.env.GSTACK_STATE_ROOT = r.state;
    let d: ReturnType<typeof receiptReviewAtHead>['depth'];
    try {
      d = receiptReviewAtHead(r.dir, 'main', BIN, r.head, ['money']).depth;
      expect(receiptReviewAtHead(r.dir, 'main', BIN, r.head).depth).not.toHaveProperty('declared');
    } finally { if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior; }
    expect([d.depth, d.risk, d.declared, d.detected]).toEqual(['full', ['money'], ['money'], []]);
    const errors: ValidationError[] = [];
    checkSchema({ schema_version: 1, head: r.head, base: 'main', review_depth: d }, ARTIFACT_SCHEMAS['ship-receipt'], '', errors);
    expect(errors.filter(e => JSON.stringify(e).includes('review_depth'))).toEqual([]);
  }, 60_000);
});
