/**
 * Free contracts of the receipt-versus-prose number check (lib/ship-receipt-prose.ts,
 * gstack-ship-receipt read --check-prose): claims in the three spellings are
 * read against review_loop, gate and ci integers, the receipt block itself is
 * never a claim, a disagreement is RECEIPT_PROSE_MISMATCH (exit 1), and prose
 * without counters passes.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReceiptProse, proseLine, receiptCounters } from '../lib/ship-receipt-prose';
import { renderReceiptBlock } from '../lib/ship-receipt';
import { EXIT } from '../lib/headless-artifacts';
import { renderRecord, type ApprovalRow, type StoreLocation } from '../lib/approval-record';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin/gstack-ship-receipt');
const receipt = {
  schema_version: 1 as const, pr: 7, head: 'a'.repeat(40), base: 'main', version: '1.2.3.0',
  review_loop: { passes: 2, blocking_found: 2, deferred: 1, noted: 0, fixed: 1, scope: 'frozen' },
  gate: { status: 'green', passed: 41, failed: 0, run: '123' }, ci: { status: 'success' },
};

describe('checkReceiptProse', () => {
  test('counters are the integer leaves under review_loop, gate and ci; identifiers are never counters', () => {
    expect([...receiptCounters(receipt).keys()]).toEqual(['review_loop.passes', 'review_loop.blocking_found', 'review_loop.deferred',
      'review_loop.noted', 'review_loop.fixed', 'gate.passed', 'gate.failed']);
  });

  test('the three spellings are claims, the receipt block is not, and a disagreement names field and both values', () => {
    const body = 'Review: 2 passes, 1 deferred finding, blocking found: 2. Gate: passed=41, 0 failed.\n\n' + renderReceiptBlock({ ...receipt, review_loop: { ...receipt.review_loop, passes: 9 } });
    const ok = checkReceiptProse(receipt, body);
    expect(ok).toEqual({ checked: 5, mismatches: [] });
    expect(proseLine(ok)).toBe('PROSE: 5 receipt counter claims in the body, all match');
    const bad = checkReceiptProse(receipt, 'The loop took 3 passes; deferred=2; 41 passed.');
    expect(bad.mismatches).toEqual([{ field: 'review_loop.passes', prose: 3, receipt: 2 }, { field: 'review_loop.deferred', prose: 2, receipt: 1 }]);
    expect(proseLine(bad)).toBe('PROSE: mismatch review_loop.passes body=3 receipt=2; review_loop.deferred body=2 receipt=1');
    expect(proseLine(checkReceiptProse(receipt, 'PR #7 adds the docs.'))).toBe('PROSE: no receipt counter claims in the body');
  });

  test('a leaf key shared by several counters matches any of them, and a hyphenated word is not a claim', () => {
    // /ship writes the gate per lane ({"<lane>":{pass,fail,skip}}), so `pass` names every lane and `passed` names gate and ci alike.
    const lanes = { ...receipt, gate: { unit: { pass: 41, fail: 0, skip: 2 }, e2e: { pass: 7, fail: 0, skip: 0 } }, ci: { status: 'success', passed: 31, failed: 0 } };
    expect(checkReceiptProse(lanes, 'unit: pass=41, e2e pass: 7; CI passed: 31.')).toEqual({ checked: 3, mismatches: [] });
    expect(checkReceiptProse(lanes, '3 pass-through tests and the fail-fast path; blocking-found: 2.')).toEqual({ checked: 1, mismatches: [] });
    const bad = checkReceiptProse(lanes, 'pass: 40');
    expect(bad.mismatches).toEqual([{ field: 'gate.unit.pass', prose: 40, receipt: 41 }]);
    expect(checkReceiptProse(receipt, 'Gate passed: 41. CI passed=41.').mismatches).toEqual([]);
  });

  // #3513: the canonical REVIEW_LOOP line /ship and `gstack-ship-queue ready` print. Before the fix the `<n> <name>` branch
  // started on passes' value and read `2 blocking_found` as a blocking_found claim of 2 (PROSE: mismatch ... body=2 receipt=1).
  test('a key=value pair\'s value is that key\'s claim alone: the REVIEW_LOOP line parses as five claims that all match', () => {
    const loop = { ...receipt, review_loop: { passes: 2, blocking_found: 1, deferred: 0, noted: 4, fixed: 8, scope: 'frozen' } };
    const line = 'REVIEW_LOOP: passes=2 blocking_found=1 deferred=0 noted=4 fixed=8 scope=frozen';
    const ok = checkReceiptProse(loop, line);
    expect(ok).toEqual({ checked: 5, mismatches: [] });
    expect(proseLine(ok)).toBe('PROSE: 5 receipt counter claims in the body, all match');
    const one = { ...receipt, review_loop: { passes: 1, blocking_found: 0, deferred: 0, noted: 0, fixed: 0, scope: 'frozen' } };
    expect(checkReceiptProse(one, 'REVIEW_LOOP: passes=1 blocking_found=0 deferred=0 noted=0 fixed=0 scope=frozen')).toEqual({ checked: 5, mismatches: [] });
    // A real disagreement on the same line is still caught, and named for the key that carries it.
    expect(checkReceiptProse(loop, 'REVIEW_LOOP: passes=2 blocking_found=3 deferred=0 noted=4 fixed=8 scope=frozen').mismatches)
      .toEqual([{ field: 'review_loop.blocking_found', prose: 3, receipt: 1 }]);
    // Prose claims in the number-then-name spelling keep working when they do not follow a pair.
    expect(checkReceiptProse(loop, 'The loop ran 2 passes and found 1 blocking_found item.')).toEqual({ checked: 2, mismatches: [] });
    // The `key: value` spelling with whitespace is the same pair (pre-landing review, pass 1): the value never starts the
    // next key's claim, while a non-counter word before the number (`Review: 2 passes`) leaves the claim as it was.
    expect(checkReceiptProse(loop, 'REVIEW_LOOP: passes: 2 blocking_found: 1 deferred: 0 noted: 4 fixed: 8')).toEqual({ checked: 5, mismatches: [] });
    expect(checkReceiptProse(loop, 'Gate passed: 41 failed: 0')).toEqual({ checked: 2, mismatches: [] });
    expect(checkReceiptProse(loop, 'Review: 2 passes; passes = 2 fixed = 8.')).toEqual({ checked: 3, mismatches: [] });
  });
});

// GST-412: the `## Approvals` block gstack-approvals renders quotes the owner's words, which can hold
// numbers (`one Step 11 pass` read as a gate `pass` claim of 11). Only that rendered block is skipped.
describe('the rendered Approvals block is not prose', () => {
  const lanes = { ...receipt, gate: { unit: { pass: 1181, fail: 0, skip: 3 } } };
  const row = (words: string): ApprovalRow => ({
    schema_version: 1, id: 'a1', date: '2026-10-30', ask: 'Ship it after the gate', words, by: 'garry', scope: 'PR B',
    pending: 'none', outcome: 'approved', source: 'thread', branch: 'b', recorded_at: '2026-10-30T00:00:00Z',
  } as ApprovalRow);
  const loc = { file: '/nonexistent', branch: 'gsta195-evidence-prose', slug: 's', ephemeral: false } as StoreLocation;
  const block = renderRecord({ rows: [row('do it, one Step 11 pass is enough')], state: 'present', restored: false }, loc);

  test('a number inside the rendered table is not a claim; the same sentence outside the block still is', () => {
    expect(block).toContain('one Step 11 pass');
    const body = 'Unit lane: 1181 pass.\n\n' + block + '\n' + renderReceiptBlock(lanes);
    expect(checkReceiptProse(lanes, body)).toEqual({ checked: 1, mismatches: [] });
    const outside = checkReceiptProse(lanes, 'Garry said one Step 11 pass is enough.\n\n' + block);
    expect(outside.mismatches).toEqual([{ field: 'gate.unit.pass', prose: 11, receipt: 1181 }]);
  });

  test('text after the footer is checked, a fenced "## Approvals" example hides nothing, and CRLF bodies work', () => {
    const after = checkReceiptProse(lanes, block + '\nFollow-up: one Step 11 pass again.\n');
    expect(after.mismatches).toEqual([{ field: 'gate.unit.pass', prose: 11, receipt: 1181 }]);
    const fenced = '```md\n## Approvals\n\n| Date | Asked |\n```\n\nThe lane ran 11 pass.\n';
    expect(checkReceiptProse(lanes, fenced).mismatches).toEqual([{ field: 'gate.unit.pass', prose: 11, receipt: 1181 }]);
    const fencedThenTable = '````md\n## Approvals\n```\nstill fenced\n```\n````\n\n7 pass\n\n' + block;
    expect(checkReceiptProse(lanes, fencedThenTable).mismatches).toEqual([{ field: 'gate.unit.pass', prose: 7, receipt: 1181 }]);
    const crlf = ('Unit lane: 1181 pass.\n\n' + block).replace(/\n/g, '\r\n');
    expect(checkReceiptProse(lanes, crlf)).toEqual({ checked: 1, mismatches: [] });
    expect(checkReceiptProse(lanes, crlf + 'Then 11 pass.\r\n').mismatches).toEqual([{ field: 'gate.unit.pass', prose: 11, receipt: 1181 }]);
  });

  test('the skipped block still separates the text around it, and a row the renderer would not write keeps the block in the check', () => {
    expect(checkReceiptProse(receipt, 'Shipped in step 3\n\n' + block + '\nDeferred items are listed below.\n')).toEqual({ checked: 0, mismatches: [] });
    const forged = block.replace(/(\|---\|[^\n]*\n)/, '$1| passes=9 deferred: 7 |\n');
    expect(checkReceiptProse(receipt, forged).mismatches).toEqual([{ field: 'review_loop.passes', prose: 9, receipt: 2 }, { field: 'review_loop.deferred', prose: 7, receipt: 1 }]);
  });

  test('a heading that is not followed by the rendered table and footer is ordinary prose', () => {
    const handWritten = '## Approvals\n\n- Garry: one Step 11 pass is enough\n';
    expect(checkReceiptProse(lanes, handWritten).mismatches).toEqual([{ field: 'gate.unit.pass', prose: 11, receipt: 1181 }]);
    const noFooter = block.replace(/Source: gstack-approvals record.*\n/, '');
    expect(checkReceiptProse(lanes, noFooter).mismatches).toEqual([{ field: 'gate.unit.pass', prose: 11, receipt: 1181 }]);
  });
});

describe('gstack-ship-receipt read --check-prose', () => {
  const run = (body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-prose-'));
    const file = path.join(dir, 'body.md');
    fs.writeFileSync(file, body);
    const r = spawnSync(BIN, ['read', '--body', file, '--check-prose', '--json'], { encoding: 'utf8', timeout: 60_000 });
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };

  test('a matching body exits 0 with the PROSE line and the receipt; a mismatch is RECEIPT_PROSE_MISMATCH exit 1', () => {
    const good = run('Two passes: passes=2, deferred: 1.\n\n' + renderReceiptBlock(receipt));
    expect(good.status).toBe(EXIT.ok);
    expect(good.err).toContain('PROSE: 2 receipt counter claims in the body, all match');
    expect(JSON.parse(good.out).prose).toEqual({ checked: 2, mismatches: [] });
    const bad = run('Three passes: passes=3.\n\n' + renderReceiptBlock(receipt));
    expect(bad.status).toBe(EXIT.fail);
    expect(bad.err).toContain('PROSE: mismatch review_loop.passes body=3 receipt=2');
    expect(bad.err).toMatch(/review_loop\.passes body=3 receipt=2.*\(RECEIPT_PROSE_MISMATCH; .*troubleshooting\.md#receipt-prose-mismatch\)/);
    expect(JSON.parse(bad.out).prose.mismatches).toHaveLength(1);
  });
});
