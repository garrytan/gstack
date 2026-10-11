/**
 * C5: the handoff record. `write` renders the fenced block identifiers-first
 * and places it at the top of a PR body; `read` parses it back from a body or
 * a PR (RECEIPT_MISSING / RECEIPT_INVALID); `census` computes the P7 adoption
 * number over merged PRs, deduplicated by run and thread, against a cohort.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { computeCensus, extractReceipt, placeReceiptFirst, receiptSummaryLine, renderReceiptBlock } from '../lib/ship-receipt';
import { cleanup, ghShim, makeFixtureRepo, makePr, recordAndBundle, restamp, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo({ prefix: 'ship-receipt-' }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const HEAD = 'a'.repeat(40);
const block = (receipt: Record<string, unknown>) => renderReceiptBlock(receipt as any);

describe('gstack-ship-receipt write', () => {
  test('writes the block identifiers-first, validates it against the ship-receipt schema, and puts it at the top of the PR body', () => {
    const repo = fixture();
    makePr(repo, 'pr-a', { expects: '1.2.4.0' });
    expect(restamp(repo, ['--version', '1.2.4.0']).status).toBe(EXIT.ok);
    repo.git('commit', '-qam', 'stamp');
    const head = repo.git('rev-parse', 'HEAD');
    const bundle = path.join(repo.root, 'bundle.json');
    recordAndBundle(repo, repo.work, [{ label: 'tests', command: 'true' }], bundle);
    const treeReceipt = path.join(repo.root, 'tree-receipt.json');
    const tr = runBin(repo, 'gstack-tree-receipt', ['--base', 'main', '--gated', head, '--bundle', bundle, '--predecessor', 'b'.repeat(40), '--json']);
    fs.writeFileSync(treeReceipt, tr.out);
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, '## Summary\n\nProse that a truncated message may lose.\n');
    const w = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '42', '--base', 'main', '--receipt', treeReceipt,
      '--gate', '{"tests":{"pass":1,"fail":0,"skip":0}}', '--ci', '@' + path.join(repo.root, 'ci.json'), '--spend-usd', '0.42',
      '--session-kind', 'unattended', '--artifacts-consumed', '2/3', '--run', 'run-1', '--thread', 'jam_1', '--queue-mode', 'stamp-at-merge',
      '--preregistration', 'none (no preregistration_shas)', '--history', 'squash-ok', '--body', body, '--out', path.join(repo.root, 'receipt.md')]);
    expect(w.status).toBe(EXIT.usage);
    fs.writeFileSync(path.join(repo.root, 'ci.json'), '{"checks":{"pass":3,"fail":0,"pending":0}}');
    const ok = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '42', '--base', 'main', '--receipt', treeReceipt,
      '--gate', '{"tests":{"pass":1,"fail":0,"skip":0}}', '--ci', '@' + path.join(repo.root, 'ci.json'), '--spend-usd', '0.42',
      '--session-kind', 'unattended', '--artifacts-consumed', '2/3', '--run', 'run-1', '--thread', 'jam_1', '--queue-mode', 'stamp-at-merge',
      '--preregistration', 'none (no preregistration_shas)', '--history', 'squash-ok', '--body', body, '--out', path.join(repo.root, 'receipt.md')]);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.err.trim()).toBe(`SHIP_RECEIPT: pr=42 head=${head.slice(0, 12)} version=1.2.4.0 base=main gated_tree=${repo.git('rev-parse', 'HEAD^{tree}').slice(0, 12)} tree=same-modulo-stamps gate-reuse=eligible (reusable: tests; rerun: -) predecessor=${'b'.repeat(12)} session_kind=unattended artifacts_consumed=2/3`);
    const parsed = extractReceipt(ok.out);
    expect(parsed.found).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(Object.keys(parsed.receipt!)).toEqual(['schema_version', 'pr', 'head', 'version', 'base', 'gated_tree', 'predecessor', 'tree', 'gate_reuse', 'gate', 'ci', 'spend_usd', 'session_kind', 'artifacts_consumed', 'run', 'thread', 'policy', 'queue_mode', 'preregistration', 'history']);
    expect(parsed.receipt).toMatchObject({ schema_version: 1, pr: 42, head, version: '1.2.4.0', base: 'main', tree: 'same-modulo-stamps', spend_usd: 0.42, ci: { checks: { pass: 3 } } });
    expect(parsed.receipt!.policy).toMatch(/^origin\/main@[0-9a-f]{12}:\.gstack\/ship-policy\.json$/);
    const written = fs.readFileSync(body, 'utf8');
    expect(written.startsWith('```gstack-ship-receipt\n{\n  "schema_version": 1,\n  "pr": 42,\n  "head": "' + head + '"')).toBe(true);
    expect(written).toContain('\n```\n\n## Summary\n\nProse that a truncated message may lose.\n');
    expect(fs.readFileSync(path.join(repo.root, 'receipt.md'), 'utf8')).toBe(ok.out);
    const art = runBin(repo, 'gstack-artifact', ['validate', path.join(repo.root, 'receipt.json'), '--as', 'ship-receipt']);
    expect(art.status).not.toBe(EXIT.ok);
    fs.writeFileSync(path.join(repo.root, 'receipt.json'), JSON.stringify(parsed.receipt));
    expect(runBin(repo, 'gstack-artifact', ['validate', path.join(repo.root, 'receipt.json'), '--as', 'ship-receipt']).status).toBe(EXIT.ok);
    const again = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '43', '--base', 'main', '--body', body, '--session-kind', 'interactive', '--json']);
    expect(again.status).toBe(EXIT.ok);
    const j = JSON.parse(again.out);
    expect(j).toMatchObject({ pr: 43, head, session_kind: 'interactive' });
    expect('tree' in j).toBe(false);
    const rewritten = fs.readFileSync(body, 'utf8');
    expect(rewritten.match(/```gstack-ship-receipt/g)).toHaveLength(1);
    expect(rewritten).toContain('"pr": 43');
    expect(rewritten).toContain('## Summary');
  });

  test('refuses an invalid receipt before writing (RECEIPT_INVALID) and a non-integer --pr', () => {
    const repo = fixture();
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, 'prose\n');
    const r = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', 'seven', '--base', 'main', '--session-kind', 'x', '--body', body]);
    expect(r.status).toBe(EXIT.usage);
    expect(r.err).toContain('--pr must be an integer');
    const receiptFile = path.join(repo.root, 'tree-receipt.json');
    fs.writeFileSync(receiptFile, JSON.stringify({ tree: 'sideways', gate_reuse: 'eligible', gate_reuse_reason: 'x' }));
    const inv = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--session-kind', 'x', '--receipt', receiptFile, '--body', body]);
    expect(inv.status).toBe(EXIT.fail);
    expect(inv.err).toMatch(/\(RECEIPT_INVALID\)/);
    expect(inv.err).toContain('nothing written');
    expect(fs.readFileSync(body, 'utf8')).toBe('prose\n');
  });
});

describe('gstack-ship-receipt read', () => {
  test('read --body and read --pr (through gh) return the block; a missing block is RECEIPT_MISSING, a broken one RECEIPT_INVALID', () => {
    const repo = fixture();
    const receipt = { schema_version: 1, pr: 5, head: HEAD, version: '1.2.4.0', base: 'main', session_kind: 'unattended', artifacts_consumed: '1/1', run: 'run-5', thread: 'jam_5' };
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, placeReceiptFirst('Prose.\n', receipt as any));
    const b = runBin(repo, 'gstack-ship-receipt', ['read', '--body', body, '--json']);
    expect(b.status).toBe(EXIT.ok);
    expect(JSON.parse(b.out)).toEqual(receipt);
    expect(b.err.trim()).toBe(receiptSummaryLine(receipt as any));
    const env = ghShim(repo, {
      5: { body: fs.readFileSync(body, 'utf8') },
      6: { body: 'No receipt here.\n' },
      7: { body: block({ schema_version: 2, head: HEAD, base: 'main' }) },
      8: { body: '```gstack-ship-receipt\n{not json\n```\n' },
    });
    const p = runBin(repo, 'gstack-ship-receipt', ['read', '--pr', '5', '--repo', 'o/r'], env);
    expect(p.status).toBe(EXIT.ok);
    expect(p.out).toBe(renderReceiptBlock(receipt as any));
    const missing = runBin(repo, 'gstack-ship-receipt', ['read', '--pr', '6', '--json'], env);
    expect(missing.status).toBe(EXIT.fail);
    expect(missing.err).toMatch(/PR #6.*\(RECEIPT_MISSING\)/);
    expect(JSON.parse(missing.out)).toEqual({ found: false, errors: [] });
    const invalid = runBin(repo, 'gstack-ship-receipt', ['read', '--pr', '7', '--json'], env);
    expect(invalid.status).toBe(EXIT.fail);
    expect(invalid.err).toMatch(/\(RECEIPT_INVALID\)/);
    expect(JSON.parse(invalid.out)).toMatchObject({ found: true, valid: false });
    const broken = runBin(repo, 'gstack-ship-receipt', ['read', '--pr', '8'], env);
    expect(broken.status).toBe(EXIT.fail);
    expect(broken.err).toMatch(/block is not JSON.*\(RECEIPT_INVALID\)/);
    expect(runBin(repo, 'gstack-ship-receipt', ['read', '--pr', '9'], env).status).toBe(EXIT.fail);
    expect(runBin(repo, 'gstack-ship-receipt', ['read']).status).toBe(EXIT.usage);
  });
});

describe('gstack-ship-receipt census (P7)', () => {
  const prs = [
    { number: 1, mergedAt: '2026-10-02T00:00:00Z', body: placeReceiptFirst('', { schema_version: 1, head: HEAD, base: 'main', session_kind: 'unattended', artifacts_consumed: '2/3', run: 'run-a', thread: 'jam_1' } as any) },
    { number: 2, mergedAt: '2026-10-03T00:00:00Z', body: placeReceiptFirst('', { schema_version: 1, head: HEAD, base: 'main', session_kind: 'unattended', artifacts_consumed: '2/3', run: 'run-a', thread: 'jam_1' } as any) },
    { number: 3, mergedAt: '2026-10-04T00:00:00Z', body: placeReceiptFirst('', { schema_version: 1, head: HEAD, base: 'main', session_kind: 'unattended', artifacts_consumed: '0/2', run: 'run-b', thread: 'jam_2' } as any) },
    { number: 4, mergedAt: '2026-10-05T00:00:00Z', body: placeReceiptFirst('', { schema_version: 1, head: HEAD, base: 'main', session_kind: 'interactive', artifacts_consumed: '1/1', run: 'run-c', thread: 'jam_4' } as any) },
    { number: 5, mergedAt: '2026-10-06T00:00:00Z', body: 'A PR shipped without gstack.\n' },
    { number: 6, mergedAt: '2026-10-07T00:00:00Z', body: block({ schema_version: 1, base: 'main' }) },
  ];

  test('computeCensus deduplicates by run, counts consumed threads against the cohort, and reports invalid receipts', () => {
    const c = computeCensus('o/r', '2026-10-01', prs, ['jam_1', 'jam_2', 'jam_3']);
    expect(c).toMatchObject({ merged_prs: 6, with_receipt: 5, invalid_receipts: 1, unattended_prs: 2, consumed_prs: 2, runs: ['run-a', 'run-b', 'run-c'], threads: ['jam_1', 'jam_2', 'jam_4'], consumed_threads: ['jam_1', 'jam_4'], cohort_consumed: 1, adoption: '1/3 (cohort)', durable: 'yes', by_session_kind: { unattended: 3, interactive: 1 } });
    expect(c.prs.find(p => p.number === 6)).toMatchObject({ valid: false });
    const noCohort = computeCensus('o/r', '2026-10-01', prs, null);
    expect(noCohort.adoption).toBe('2/3 (threads seen; no cohort file)');
  });

  test('census --repo --since reads merged PRs through gh and prints the CENSUS line', () => {
    const repo = fixture();
    const env = ghShim(repo, {}, prs);
    const cohort = path.join(repo.root, 'cohort.txt');
    fs.writeFileSync(cohort, '# threads in the measured cohort\njam_1\njam_2\njam_3\n\n');
    const r = runBin(repo, 'gstack-ship-receipt', ['census', '--repo', 'o/r', '--since', '2026-10-01', '--cohort', cohort], env);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^CENSUS: repo=o\/r since=2026-10-01 merged_prs=6 with_receipt=5 invalid=1 unattended=2 consumed=2 runs=3 threads=3 adoption=1\/3 \(cohort\) durable=yes$/m);
    const j = runBin(repo, 'gstack-ship-receipt', ['census', '--repo', 'o/r', '--since', '2026-10-01', '--json'], env);
    expect(JSON.parse(j.out)).toMatchObject({ repo: 'o/r', adoption: '2/3 (threads seen; no cohort file)' });
    expect(runBin(repo, 'gstack-ship-receipt', ['census', '--repo', 'o/r'], env).status).toBe(EXIT.usage);
    expect(runBin(repo, 'gstack-ship-receipt', ['census', '--repo', 'o/r', '--since', 'v9.9.9'], env).status).toBe(EXIT.fail);
  });
});
