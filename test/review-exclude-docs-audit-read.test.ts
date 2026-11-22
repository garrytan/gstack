/**
 * GST-3532 (GBRA-615, gbrain#10059): Step 14.5's docs audit corrected one line in a doc the review keeps for reviewers to read
 * (docs/guides/secret-store.md, a gate path) after the PR's last review round. Receipt write refused on review_exclude, because
 * the docs-audit exception binds only docs the exclusion hides or keeps because code names them, and the only fix it offered was
 * another review round, which the round cap forbids. Write now asks for one scoped reader of that audit change instead (not a
 * review round under R51): it writes the packet, and a clean record bound to the packet binds into the receipt. A finding, a stale
 * record, or an edit too large for one reader still refuses.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const DOC = 'docs/guides/secret-store.md';
const policyText = JSON.stringify({ review_exclude_paths: ['docs/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n';
const STORE = ['# Secret store', '', 'A token is read from the store and retried 4 times on a timeout.', ''];

/** The PR adds the store and its doc; the review reads them; the docs audit then edits the doc (`lines` replace the retry line) and adds a page the exclusion hides, which changes the selection. */
function auditedAfterReview(lines = ['A token is read from the store and retried 2 times on a timeout.']) {
  const repo = makeFixtureRepo({ prefix: 'gst3532-', baseFiles: { '.gstack/ship-policy.json': policyText, 'lib/index.js': 'exports.i = 1;\n' } });
  repos.push(repo);
  commit(repo, { 'lib/secret-store.js': 'exports.retries = 2;\n', [DOC]: STORE.join('\n') }, 'feat: secret store');
  const plan = JSON.parse(runBin(repo, 'gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--json']).out);
  const reviewed = plan.review_exclude.digest as string;
  const base = repo.git('rev-parse', 'origin/main');
  const snapshot = (out: string, extra: string[] = []) => runBin(repo, 'gstack-docs-candidate', ['snapshot', '--out', out, '--audit-id', 'ship-docs-1', '--mode', 'edit', '--base', base, '--docs', 'docs', '--run', '/records/ship-record.md', ...extra]);
  const pre = path.join(repo.root, 'docs-audit.json');
  expect(snapshot(pre).status).toBe(0);
  write(repo.work, DOC, [STORE[0], STORE[1], ...lines, ''].join('\n'));
  write(repo.work, 'docs/guides/restore.md', '# Restore\n\nRestore reads the sealed copy back.\n');
  const post = path.join(repo.root, 'ship-docs-1-post.json');
  expect(snapshot(post, ['--pre', pre]).status).toBe(0);
  commit(repo, {}, 'docs audit');
  const head = repo.git('rev-parse', 'HEAD');
  const body = path.join(repo.root, 'body.md');
  const writeReceipt = (extra: string[] = []) => runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '10059', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body,
    '--review-exclude', reviewed, '--docs-post', post, '--docs-pre', pre,
    '--review-targeted', JSON.stringify({ classes: ['money', 'gate', 'auth', 'secret'], rules: 'r', brief_sha: 'a'.repeat(64), status: 'done', findings: 0, raised_by: 'targeted', head }), ...extra]);
  const record = (over: Record<string, unknown>) => { const f = path.join(repo.root, 'docs-read.json'); fs.writeFileSync(f, JSON.stringify({ head, paths: [DOC], reviewer: 'claude-opus-5-5', verdict: 'clean', ...over })); return f; };
  return { repo, head, body, writeReceipt, record };
}
const packetOf = (err: string) => /reads (\S+\.md)/.exec(err)?.[1];
const shaOf = (err: string) => /"packet_sha256":"([0-9a-f]{64})"/.exec(err)?.[1];

describe('a docs-audit edit to a doc the reviewers read takes one scoped reader after the round cap (GST-3532)', () => {
  // Value: protects=a /ship run whose docs audit corrected a reviewed gate-path doc after the last round still gets its receipt
  //   (gbrain#10059 was waived to land); fails_when=write offers only another review round, or binds without anyone reading the
  //   audit's change; seam=gstack-ship-receipt write --docs-post --docs-audit-read; no_claim=gh
  test('the gbrain#10059 shape: write asks for one reader, and its clean record binds into the receipt', () => {
    const s = auditedAfterReview();
    const ask = s.writeReceipt();
    expect(ask.status).toBe(EXIT.fail);
    expect(ask.err).toContain('RECEIPT_DOCS_AUDIT_READ');
    expect(ask.err).toContain('not a review round');
    const packet = packetOf(ask.err)!;
    const text = fs.readFileSync(packet, 'utf8');
    expect(text).toContain('-A token is read from the store and retried 4 times on a timeout.');
    expect(text).toContain('+A token is read from the store and retried 2 times on a timeout.');
    const w = s.writeReceipt(['--docs-audit-read', s.record({ packet_sha256: shaOf(ask.err) })]);
    expect({ status: w.status, err: w.status === EXIT.ok ? '' : w.err }).toEqual({ status: EXIT.ok, err: '' });
    expect(w.err).toContain('REVIEW_EXCLUDE_DOCS_AUDIT:');
    expect(JSON.parse(/```gstack-ship-receipt\n([\s\S]*?)\n```/.exec(fs.readFileSync(s.body, 'utf8'))![1]!).docs_audit_read).toEqual({ paths: [DOC], reviewer: 'claude-opus-5-5', packet_sha256: shaOf(ask.err) });
  }, 240_000);

  // Value: protects=a reader's finding, a record for another packet or head, and an edit too big for one reader keep refusing
  //   (negative controls); fails_when=any record binds; seam=gstack-ship-receipt write --docs-audit-read; no_claim=-
  test('a finding, a stale record or a large edit still refuses', () => {
    const s = auditedAfterReview();
    const sha = shaOf(s.writeReceipt().err);
    const finding = s.writeReceipt(['--docs-audit-read', s.record({ packet_sha256: sha, verdict: 'findings' })]);
    expect(finding.status).toBe(EXIT.fail);
    expect(finding.err).toContain('not clean');
    const stale = s.writeReceipt(['--docs-audit-read', s.record({ packet_sha256: '0'.repeat(64) })]);
    expect(stale.status).toBe(EXIT.fail);
    expect(stale.err).toContain('packet_sha256');
    const other = s.writeReceipt(['--docs-audit-read', s.record({ packet_sha256: sha, head: '0'.repeat(40) })]);
    expect(other.status).toBe(EXIT.fail);
    const big = auditedAfterReview(Array.from({ length: 25 }, (_, i) => `Line ${i} of a rewritten section.`));
    const r = big.writeReceipt();
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).not.toContain('RECEIPT_DOCS_AUDIT_READ');
    expect(r.err).toContain('too large for one scoped reader');
  }, 240_000);
});
