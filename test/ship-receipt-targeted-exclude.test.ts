/**
 * The receipt's targeted check under review_exclude_paths (GST-1900; HARN-1, harness-evals#322): a file the base policy
 * excludes names no targeted class at receipt write, carry or the queue, as gstack-review-plan reads it at the same head.
 * An exclusion that is not active (no key, a pattern only the branch adds, a gate scan the receipt does not bind) excludes
 * nothing, so the check stays closed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt } from '../lib/ship-receipt';
import { bindShippedReceipt, receiptReviewAtHead, receiptTargetedAtHead, targetedClassesSince } from '../lib/ship-receipt-depth';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const SQLITE = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(64, 1)]);
const LEDGER = 'probe/probe-cc.ledger.sqlite';
const policyFile = (patterns: string[]) => ({ '.gstack/ship-policy.json': JSON.stringify({ review_exclude_paths: patterns, min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n' });

/** A branch that commits SQLite ledgers (HARN-1's probe ledger shape) and a docs note; the policy sits on the base, or on the branch only. */
function branch(patterns: string[] | null, ledgers: string[], on: 'base' | 'branch' = 'base'): FixtureRepo {
  const repo = makeFixtureRepo({ prefix: 'gstack-targeted-exclude-', baseFiles: patterns && on === 'base' ? policyFile(patterns) : {} });
  repos.push(repo);
  for (const rel of ledgers) {
    fs.mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo.work, rel), SQLITE);
    repo.git('add', rel);
  }
  commit(repo, { 'docs/probe.md': '# probe\n', ...(patterns && on === 'branch' ? policyFile(patterns) : {}) });
  return repo;
}
const planOf = (repo: FixtureRepo) => JSON.parse(runBin(repo, 'gstack-review-plan', ['--base', 'main', '--json']).out);
const listOf = (classes: string[]) => (classes.length ? classes.join(',') : 'none');
const requiredIn = (text: string) => /REVIEW_TARGETED: required=(\S+)/.exec(text)?.[1];
/** Receipt write with no targeted record and the digest the plan printed, as /ship writes it when the plan names no class. */
function writeReceipt(repo: FixtureRepo, digest: string) {
  const body = path.join(repo.root, 'body.md');
  const r = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body, '--review-exclude', digest]);
  return { ...r, body };
}

describe('the receipt reads the targeted classes the review plan reads (GST-1900)', () => {
  // Value: protects=a ledger under review_exclude_paths needs no money reader at receipt write, carry or ready, as the plan says
  //   fails_when=receiptTargetedAtHead classifies excluded paths (HARN-1: REVIEW_TARGETED required=money vs plan classes=none)
  //   why_new=the exclusion tests check the plan's classes and the receipt digest, never the receipt's targeted verdict
  //   seam=gstack-review-plan --json, gstack-ship-receipt write, receiptTargetedAtHead, bindShippedReceipt on one head
  test('an excluded money path gives no class at write, at the queue, or in the plan', () => {
    const repo = branch(['probe/**'], [LEDGER]);
    const plan = planOf(repo);
    expect(plan.review_exclude).toMatchObject({ state: 'active', excluded: 1, kept: 0 });
    expect(plan.targeted.classes).toEqual([]);
    const w = writeReceipt(repo, plan.review_exclude.digest);
    expect({ status: w.status, targeted: requiredIn(w.err) ?? null }).toEqual({ status: EXIT.ok, targeted: null });
    const text = fs.readFileSync(w.body, 'utf8');
    const receipt = extractReceipt(text).receipt!;
    const head = repo.git('rev-parse', 'HEAD');
    const atHead = receiptTargetedAtHead(repo.work, 'origin/main', receipt, head);
    expect({ ok: atHead.ok, required: requiredIn(atHead.line) }).toEqual({ ok: true, required: listOf(plan.targeted.classes) });
    const queue = bindShippedReceipt(repo.work, 'origin/main', text, undefined, [head]);
    expect(requiredIn(queue.ok ? queue.targetedLine : queue.targetedLine ?? queue.message)).toBe(listOf(plan.targeted.classes));
  }, 180_000);

  // Value: protects=a money path outside the patterns still needs the money reader beside an excluded one
  //   fails_when=the exclusion fix drops every path, or classifies only the excluded file set
  //   why_new=the narrowing must keep the fail-closed check for the paths reviewers read
  //   seam=gstack-review-plan --json and gstack-ship-receipt write on one head
  test('a money path the patterns do not match still requires money at write, as the plan says', () => {
    const repo = branch(['probe/**'], [LEDGER, 'results/spend.ledger.sqlite']);
    const plan = planOf(repo);
    expect(plan.review_exclude).toMatchObject({ state: 'active', excluded: 1 });
    expect(plan.targeted.classes).toEqual(['money']);
    const w = writeReceipt(repo, plan.review_exclude.digest);
    expect(w.status).toBe(EXIT.fail);
    expect(w.err).toContain('REVIEW_TARGETED: required=money receipt=legacy verdict=missing');
    expect(requiredIn(w.err)).toBe(listOf(plan.targeted.classes));
    expect(fs.existsSync(w.body)).toBe(false);
  }, 180_000);

  // Value: protects=no key, or a pattern only the branch adds, excludes nothing, so the ledger still needs the money reader
  //   fails_when=the receipt reads a head-only or absent policy as an exclusion
  //   why_new=the fix narrows a fail-closed check; these are the states it must not narrow
  //   seam=gstack-review-plan --json and gstack-ship-receipt write on one head
  for (const [name, patterns, on] of [['no review_exclude_paths', null, 'base'], ['a pattern only the branch adds', ['probe/**'], 'branch']] as const) {
    test(`${name} still requires money at write, as the plan says`, () => {
      const repo = branch(patterns ? [...patterns] : null, [LEDGER], on);
      const plan = planOf(repo);
      expect(plan.review_exclude?.state ?? 'none').not.toBe('active');
      expect(plan.targeted.classes).toEqual(['money']);
      const w = writeReceipt(repo, 'none');
      expect(w.status).toBe(EXIT.fail);
      expect(requiredIn(w.err)).toBe('money');
    }, 180_000);
  }

  // Value: protects=a receipt whose gate scan names another head narrows nothing: the check fails closed and defers to the queue
  //   fails_when=the targeted check takes the exclusion without the receipt's bound gate scan
  //   why_new=the gate scan decides which candidates the exclusion keeps; an unbound scan keeps them all
  //   seam=receiptTargetedAtHead on a written receipt with its gate_scan head moved
  test('a receipt that does not bind the gate scan to its head fails closed to every class', () => {
    const repo = branch(['probe/**'], [LEDGER]);
    const w = writeReceipt(repo, planOf(repo).review_exclude.digest);
    expect(w.status).toBe(EXIT.ok);
    const receipt = extractReceipt(fs.readFileSync(w.body, 'utf8')).receipt!;
    const unbound = { ...receipt, review_depth: { ...receipt.review_depth!, gate_scan: { ...receipt.review_depth!.gate_scan, head: '0'.repeat(40) } } };
    const v = receiptTargetedAtHead(repo.work, 'origin/main', unbound, repo.git('rev-parse', 'HEAD'));
    expect(requiredIn(v.line)).toBe('money,gate,auth,secret');
    expect(v.line).toContain('(unchecked: gate scan unavailable; the queue decides at ready)');
  }, 180_000);

  // Value: protects=a targeted record carries past a later commit that only changes an excluded ledger
  //   fails_when=targetedClassesSince classifies paths the head's exclusion leaves out
  //   why_new=write's since read is the other targeted read in lib/ship-receipt-depth.ts with no exclusion
  //   seam=targetedClassesSince with the exclusion receiptReviewAtHead gives write; no_claim=the CLI's product-patch check
  test('the change since a targeted read names no class for a ledger the head excludes, and money without the exclusion', () => {
    const repo = branch(['probe/**'], []);
    const read = repo.git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(repo.work, 'probe'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, LEDGER), SQLITE);
    repo.git('add', LEDGER);
    const head = commit(repo, { 'docs/probe.md': '# probe\n\nThe ledger is committed.\n' }, 'probe ledger');
    const prior = process.env.GSTACK_STATE_ROOT;
    process.env.GSTACK_STATE_ROOT = path.join(repo.root, 'receipt-state');
    try {
      const { exclude } = receiptReviewAtHead(repo.work, 'main', path.join(import.meta.dir, '..', 'bin'), head);
      expect(exclude.state === 'active' ? [...exclude.excluded] : exclude.state).toEqual([LEDGER]);
      expect(targetedClassesSince(repo.work, read, head, 'main', exclude.state === 'active' ? exclude.excluded : undefined)).toEqual([]);
      expect(targetedClassesSince(repo.work, read, head, 'main')).toEqual(['money']);
    } finally { if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior; }
  }, 180_000);
});
