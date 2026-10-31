/**
 * GST-467: a subagent running /ship cannot read its own jam id, so its Capy reading is the root
 * thread's counter, which also holds every sibling lane. Such a run is tree-scoped and every cost
 * line it prints carries METER: tree (root counter, upper bound); a subagent that asks for a self
 * scope while metering from "this" is refused (METER_SCOPE_PARENT).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RESULT_CODES } from '../lib/result-codes';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const ROOT = path.resolve(import.meta.dir, '..');
const TREE = 'METER: tree (root counter, upper bound)';
const COST = /^(BUDGET|BUDGET_FINAL|BUDGET_TIMELINE|NOTE):/;
const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

function costLinesLabeled(out: string): boolean[] {
  const lines = out.split('\n');
  return lines.flatMap((l, i) => COST.test(l) ? [lines[i + 1] === TREE] : []);
}

function observedRun(h: Harness, start: string[], env: NodeJS.ProcessEnv = {}) {
  const s = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--reading', '1000000', '--credits', '100', ...start], env);
  if (s.code !== 0) return { start: s, note: s, close: s };
  const run = h.field(s.out, 'BUDGET_RUN', 'id');
  const note = h.sb(['note', '--run', run, '--step', '6', '--reading', '1500000', '--credits', '150']);
  const close = h.sb(['close', '--run', run, '--reading', '2000000', '--credits', '200']);
  return { start: s, note, close };
}

describe('meter scope (GST-467)', () => {
  // Value: protects=a run metered off the root counter never prints a cost without saying it is the root counter, an upper bound; fails_when=a tree-scoped run prints a BUDGET, NOTE, BUDGET_FINAL or BUDGET_TIMELINE line with no METER: tree line under it, or a self run is labeled tree;
  //   why_new=#3686's ledger baseline 5,769,355,282 was the root thread's counter, sibling lanes included (GST-467); seam=none; no_claim=the exact per-run cost, which only a root replay thread measures
  test('every cost line of a tree-scoped run is labeled, whether asked for or implied by a subagent reading "this"; a self run is not', () => {
    for (const [start, env] of [[['--meter-scope', 'tree'], {}], [['--subagent', '--reading-from', 'this'], {}], [['--reading-from', 'this'], { GSTACK_SHIP_SUBAGENT: '1' }]] as const) {
      const r = observedRun(fresh(), [...start], env);
      for (const out of [r.start, r.note, r.close]) {
        expect(out.code, out.err).toBe(0);
        const labels = costLinesLabeled(out.out);
        expect(labels.length, out.out).toBeGreaterThan(0);
        expect(labels.every(Boolean), out.out).toBe(true);
      }
      expect(r.close.out).toMatch(/^BUDGET_FINAL: [^\n]*\nMETER: tree \(root counter, upper bound\)$/m);
      expect(r.close.out).toMatch(/^BUDGET_TIMELINE: [^\n]*\nMETER: tree \(root counter, upper bound\)$/m);
    }
    for (const start of [['--meter-scope', 'self'], ['--reading-from', 'this', '--meter-scope', 'self'], []]) {
      const r = observedRun(fresh(), start);
      for (const out of [r.start, r.note, r.close]) {
        expect(out.code, out.err).toBe(0);
        expect(out.out).not.toContain('METER: tree');
      }
    }
  });

  // Value: protects=resume and a handoff child of a tree-scoped run keep the label; fails_when=resume or verify-handoff prints a BUDGET line with no METER: tree line under it;
  //   why_new=the test above drives start, note and close only; seam=none; no_claim=a child's exact cost
  test('resume and a handoff child of a tree-scoped run label their cost lines too', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--token-cap', '200M', '--reading', '1000000', '--meter-scope', 'tree']);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const resumed = h.sb(['resume', '--run', run, '--reading', '1200000']);
    const ho = h.sb(['handoff', '--run', run, '--from', '9', '--to', '11.5', '--base', 'origin/main', '--reading', '1300000']);
    expect(ho.code, ho.out + ho.err).toBe(0);
    const child = h.sb(['verify-handoff', '--in', ho.out.match(/^HANDOFF: (\S+) /m)![1]!]);
    for (const out of [resumed, ho, child]) {
      expect(out.code, out.out + out.err).toBe(0);
      const labels = costLinesLabeled(out.out);
      expect(labels.length, out.out).toBeGreaterThan(0);
      expect(labels.every(Boolean), out.out).toBe(true);
    }
  });

  // Value: protects=a tree run rebuilt from its record after a lost ledger keeps the label; fails_when=the record block drops meter_scope or rebuildLedger does not restore it (red-team, ship gst467-p1);
  //   why_new=the cases above never lose the ledger; seam=none; no_claim=checkpoint restore, which copies the whole ledger
  test('a tree run rebuilt from its record still labels its cost lines', () => {
    const h = fresh();
    const record = h.record();
    const s = h.sb(['start', '--record', record, '--mode', 'observe', '--reading', '1000000', '--meter-scope', 'tree']);
    const ledger = h.field(s.out, 'BUDGET_RUN', 'ledger');
    fs.writeFileSync(ledger, '{"kind": "gstack-ship-budget", oops');
    const rebuilt = h.sb(['resume', '--record', record, '--rebuild-from-record', '--reading', '1500000']);
    expect(rebuilt.out, rebuilt.out + rebuilt.err).toContain('REBUILT:');
    const close = h.sb(['close', '--record', record, '--reading', '2000000']);
    for (const out of [rebuilt, close]) {
      const labels = costLinesLabeled(out.out);
      expect(labels.length, out.out).toBeGreaterThan(0);
      expect(labels.every(Boolean), out.out).toBe(true);
    }
  });

  // Value: protects=a subagent cannot claim its own cost while reading the root counter; fails_when=start accepts --meter-scope self from a subagent metering "this", or the refusal lacks its code and fix;
  //   why_new=GST-467; seam=none; no_claim=whether the brief sets the subagent flag
  test('a subagent metering "this" that asks for a self scope is refused with METER_SCOPE_PARENT and a fix', () => {
    const h = fresh();
    for (const [args, env] of [[['--subagent'], {}], [[], { GSTACK_SHIP_SUBAGENT: '1' }]] as const) {
      const r = h.sb(['start', '--record', h.record(), '--mode', 'observe', '--reading', '1000000', '--reading-from', 'this', '--meter-scope', 'self', ...args], env);
      expect(r.code).toBe(2);
      expect(r.err).toContain('(METER_SCOPE_PARENT)');
      expect(r.err).toContain('--meter-scope tree');
    }
    const bad = h.sb(['start', '--record', h.record(), '--reading', '1', '--meter-scope', 'mine']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--meter-scope');
    expect(RESULT_CODES.METER_SCOPE_PARENT.fix).toContain('--meter-scope tree');
    expect(fs.readFileSync(path.join(ROOT, 'docs/troubleshooting.md'), 'utf8')).toContain(`<a id="${RESULT_CODES.METER_SCOPE_PARENT.anchor}"></a>`);
  });

  // Value: protects=the /ship brief tells a subagent to meter tree-scoped and the docs say where exact cost comes from; fails_when=the Capy skill or docs/ship-budget.md drops --meter-scope tree or the root-replay pointer;
  //   why_new=GST-467; seam=none; no_claim=agent compliance
  test('the Capy skill and docs/ship-budget.md tell a subagent to pass --meter-scope tree; exact per-run cost comes from root replay threads', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'capy/skill/gstack/SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(skill).toContain('--subagent --reading-from this --meter-scope tree');
    const doc = fs.readFileSync(path.join(ROOT, 'docs/ship-budget.md'), 'utf8').replace(/\s+/g, ' ');
    expect(doc).toContain('--meter-scope tree');
    expect(doc).toContain(TREE);
    expect(doc).toContain('root replay thread');
  });
});
