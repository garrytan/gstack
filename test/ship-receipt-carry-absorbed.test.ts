/**
 * HARN-172 (harness-evals #625): the branch deleted one JSON array entry, main then deleted the same entry, and the lane merged
 * origin/main. The branch's diff against the new base lost that hunk, so the product patch-id moved and carry refused with
 * RECEIPT_CARRY_PRODUCT_CHANGED, forcing a fresh full review of a head whose every byte was reviewed. A path is now carried when
 * it is exactly the reviewed change replayed onto the new base (absorbedByBase); a hunk dropped or edited in the resolution, or
 * any other change, still refuses.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { absorbedByBase, comparePath } from '../lib/ship-patch';
import { extractReceipt } from '../lib/ship-receipt';
import { RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.dirname(RELEASE);
const RECEIPT = path.join(BIN, 'gstack-ship-receipt');
const UNATTENDED = { GSTACK_SESSION_KIND: 'unattended' };
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });

const LIST = 'config/cases.json';
const CODE = 'src/run.ts';
const list = (ids: string[]) => `[\n${ids.map(i => `  "${i}"`).join(',\n')}\n]\n`;
const code = (n: number) => Array.from({ length: 12 }, (_, i) => `export const v${i + 1} = ${i + 1 === 6 ? n : i + 1};`).join('\n') + '\n';
const ALL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const without = (...gone: string[]) => ALL.filter(i => !gone.includes(i));

/** The branch drops case "c" and edits run.ts; its receipt is written at that head; main then lands `baseList`. */
function absorbed(baseList: string[], resolved?: Record<string, string>) {
  const f = shipFixture({ [LIST]: list(ALL), [CODE]: code(6) }, { [LIST]: list(without('c')), [CODE]: code(60) });
  ships.push(f);
  const from = f.git('rev-parse', 'HEAD').stdout.trim();
  const reviewedBase = f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
  const body = path.join(f.root, 'body.md');
  fs.writeFileSync(body, '## Summary\n');
  const w = f.run(RECEIPT, ['write', '--pr', '5', '--base', 'main', '--body', body], UNATTENDED);
  expect([w.status, w.stderr.slice(0, 400)]).toEqual([EXIT.ok, expect.any(String)]);
  f.advanceBase({ [LIST]: list(baseList) });
  f.git('fetch', '-q', 'origin');
  if (f.git('merge', '-q', '--no-edit', 'origin/main').status !== 0 || resolved) { f.write(resolved ?? {}); f.commit('merge main'); }
  const head = f.git('rev-parse', 'HEAD').stdout.trim();
  const sides = { reviewedBase, reviewed: from, currentBase: f.git('merge-base', 'origin/main', 'HEAD').stdout.trim(), current: head };
  const carry = () => f.run(RECEIPT, ['carry', '--body', body, '--base', 'main'], UNATTENDED);
  return { f, sides, body, carry };
}

describe('receipt carry across a base merge that landed one of the branch\'s hunks (HARN-172)', () => {
  // Value: protects=a clean base merge in which main made the branch's exact deletion keeps the receipt; fails_when=carry refuses
  //   RECEIPT_CARRY_PRODUCT_CHANGED for a head with no unreviewed byte (harness-evals #625); seam=gstack-ship-receipt carry and
  //   absorbedByBase on a real merge
  test('main deleted the same entry: the path is absorbed and the receipt carries, naming it', () => {
    const x = absorbed(without('c'));
    expect(comparePath(x.f.work, x.sides, LIST)).toBe('changed');
    expect(absorbedByBase(x.f.work, x.sides, LIST)).toBe(true);
    const r = x.carry();
    expect([r.status, r.stderr.slice(0, 600)]).toEqual([EXIT.ok, expect.any(String)]);
    expect(extractReceipt(fs.readFileSync(x.body, 'utf8')).receipt!.carry!.reason).toContain(`branch hunks the base landed identically (${LIST}`);
  });

  test('main deleted the same entry and another one: still only the reviewed change replayed, so it carries', () => {
    const x = absorbed(without('c', 'g'));
    expect(absorbedByBase(x.f.work, x.sides, LIST)).toBe(true);
    expect(x.carry().status).toBe(EXIT.ok);
  });

  test('a TMPDIR it cannot write reads as not absorbed instead of crashing the carry', () => {
    const x = absorbed(without('c'));
    const r = x.f.run(RECEIPT, ['carry', '--body', x.body, '--base', 'main'], { ...UNATTENDED, TMPDIR: path.join(x.f.root, 'missing', 'tmp') });
    expect([r.status === EXIT.ok, r.stderr.includes('RECEIPT_CARRY_PRODUCT_CHANGED')]).toEqual([false, true]);
  });

  // Value: protects=the fail-closed controls; fails_when=a resolution that drops or edits a branch hunk main never landed, or that
  //   restores an entry main deleted, carries; seam=absorbedByBase and gstack-ship-receipt carry
  test('a resolution that also drops a hunk main never landed, edits a line, or keeps an entry main removed still refuses', () => {
    for (const [name, resolved] of [
      ['dropped the branch edit to run.ts', { [CODE]: code(6) }],
      ['edited the list', { [LIST]: list(without('c', 'd')) }],
      ['kept an entry main removed', { [LIST]: list(without('c')) }],
    ] as const) {
      const x = absorbed(without('c', 'g'), resolved);
      const r = x.carry();
      expect([name, r.status === EXIT.ok, r.stderr.includes('RECEIPT_CARRY_PRODUCT_CHANGED')]).toEqual([name, false, true]);
    }
  });
});
