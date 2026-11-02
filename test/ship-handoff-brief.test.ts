/**
 * GSTA-167 PR 3a: a handoff child reads only its segment's sections. On #34
 * and #36 the Steps 7-11.5 child booted at 1.29M by reading the whole ship
 * skill, preamble.md and docs/ship-budget.md before its first step; the brief
 * now names ship/SKILL.md's step list, the segment's sections and
 * budget-handoff.md, and nothing else. Variant E (replay 5): Steps 7-8 stay
 * with the parent, so the review child (Steps 9-11.5) reads review-army.md and
 * adversarial.md, and the record the driver keeps carries the six headings.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { RECORD_HEADINGS, segmentSections } from '../lib/ship-handoff';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const ROOT = `${import.meta.dir}/..`;
const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

function briefFor(from: string, to: string): string {
  const h = fresh();
  const s = h.sb(['start', '--record', h.record(), '--token-cap', '400M', '--reading', '98000']);
  expect(s.code, s.out + s.err).toBe(0);
  const ho = h.sb(['handoff', '--run', h.field(s.out, 'BUDGET_RUN', 'id'), '--from', from, '--to', to, '--base', 'origin/main', '--reading', '1000000']);
  expect(ho.code, ho.out + ho.err).toBe(0);
  return fs.readFileSync(ho.out.match(/^HANDOFF: (\S+) /m)![1]!, 'utf8');
}
const readSection = (text: string) => text.slice(text.indexOf('## Read'), text.indexOf('\n## ', text.indexOf('## Read') + 1));

describe('the handoff brief names only the segment\'s sections', () => {
  test('Steps 9-11.5: the step list plus review-army and adversarial only', () => {
    const read = readSection(briefFor('9', '11.5'));
    expect(read).toContain("ship/SKILL.md's step list");
    for (const s of ['review-army.md', 'adversarial.md', 'budget-handoff.md']) expect(read).toContain(s);
    for (const s of ['test-coverage.md', 'plan-completion.md', 'changelog.md', 'documentation.md', 'pr-body.md', 'capy-pr.md', 'tests.md']) expect(read).not.toContain(s);
    expect(read).toMatch(/Never read ship\/sections\/preamble\.md in full or docs\/ship-budget\.md/);
  });

  test('Steps 12-22: the step list plus changelog, documentation, pr-body and capy-pr', () => {
    const read = readSection(briefFor('12', '22'));
    for (const s of ['changelog.md', 'documentation.md', 'pr-body.md', 'capy-pr.md', 'budget-handoff.md']) expect(read).toContain(s);
    for (const s of ['test-coverage.md', 'plan-completion.md', 'review-army.md', 'adversarial.md']) expect(read).not.toContain(s);
    expect(read).toMatch(/Never read ship\/sections\/preamble\.md in full or docs\/ship-budget\.md/);
  });

  test('a grandchild segment names only the sections of its own steps', () => {
    expect(segmentSections('9', '11.5')).toEqual(['review-army', 'adversarial']);
    expect(segmentSections('19', '22')).toEqual(['pr-body', 'capy-pr']);
    expect(segmentSections('1', '22')).toEqual(['tests', 'greptile-early', 'test-coverage', 'plan-completion', 'review-army', 'adversarial', 'changelog', 'documentation', 'pr-body', 'capy-pr']);
  });

  // Value: protects=a handoff child reads exact line ranges: never ship/SKILL.md's preamble, the section index or another segment's steps, and every review section whole, so its reviewer briefs are the section's own text; fails_when=the brief names files without ranges, a range starts at line 1 of SKILL.md, a review section is cut, or a gate heading falls outside the ranges;
  //   why_new=the tests above check file names only; seam=none; no_claim=that a child obeys the ranges
  test('the brief prints READ: ranges per file that skip the preamble, keep every gate heading and read each review section whole', () => {
    const ranges = (text: string) => Object.fromEntries([...text.matchAll(/^READ: (\S+?):([\d,-]+)$/gm)].map(m => [m[1]!, m[2]!.split(',').map(r => r.split('-').map(Number) as [number, number])]));
    const lineOf = (file: string, heading: string) => fs.readFileSync(`${ROOT}/${file}`, 'utf8').split('\n').findIndex(l => l.startsWith(heading)) + 1;
    const inside = (rs: [number, number][], n: number) => n > 0 && rs.some(([a, b]) => a <= n && n <= b);
    const total = (file: string) => fs.readFileSync(`${ROOT}/${file}`, 'utf8').replace(/\n$/, '').split('\n').length;
    const seg = briefFor('9', '11.5');
    expect(seg).toMatch(/Read only the `READ:` ranges below/);
    const r = ranges(seg);
    const skill = r['ship/SKILL.md']!;
    expect(skill[0]![0]).toBe(lineOf('ship/SKILL.md', '# Ship:'));
    for (const h of ['## Step 11.5:', '## Important Rules', '### Ship control flow']) expect(inside(skill, lineOf('ship/SKILL.md', h)), h).toBe(true);
    for (const h of ['## Preamble (run first)', '## Section index', '## Step 3:', '## Step 7:', '## Step 8:', '## Step 12:']) expect(inside(skill, lineOf('ship/SKILL.md', h)), h).toBe(false);
    for (const s of ['review-army', 'adversarial', 'budget-handoff']) expect(r[`ship/sections/${s}.md`]).toEqual([[1, total(`ship/sections/${s}.md`)]]);
    for (const s of ['test-coverage', 'plan-completion']) expect(r[`ship/sections/${s}.md`]).toBeUndefined();
    expect(Object.keys(r).filter(k => k.includes('audit-') || k.includes('changelog'))).toEqual([]);
    const late = ranges(briefFor('12', '22'))['ship/SKILL.md']!;
    for (const h of ['## Step 12:', '## Step 14.5:', '## Step 17:', '## Step 22:', '## Important Rules']) expect(inside(late, lineOf('ship/SKILL.md', h)), h).toBe(true);
    for (const h of ['## Step 3:', '## Step 11.5:']) expect(inside(late, lineOf('ship/SKILL.md', h)), h).toBe(false);
  });

  // Value: protects=a segment ending at Step 22 is returned at Step 22, so the parent's reconcile reads it complete; fails_when=the brief leaves the return step to the child's reading of "Steps 1-21" (GSTA-167: --to 21 on a 12-22 handoff reconciled child=incomplete and stopped the parent);
  //   why_new=no test follows a brief through return and reconcile at Step 22; seam=none; no_claim=what the child did between verify and return
  test('a Steps 12-22 brief names Step 22 as the last step and its return command; following it reconciles complete', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--token-cap', '400M', '--reading', '98000']);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const ho = h.sb(['handoff', '--run', run, '--from', '12', '--to', '22', '--base', 'origin/main', '--reading', '1000000']);
    expect(ho.code, ho.out + ho.err).toBe(0);
    const file = ho.out.match(/^HANDOFF: (\S+) /m)![1]!;
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('Your last step is Step 22');
    expect(text).toContain('gstack-ship-budget return --run <your child run> --to 22');
    const v = h.sb(['verify-handoff', '--in', file, '--reading', '1100000']);
    expect(v.code, v.out + v.err).toBe(0);
    const child = h.field(v.out, 'BUDGET_RUN', 'id');
    const ret = h.sb(['return', '--run', child, '--to', '22', '--reading', '2000000']);
    expect(ret.code, ret.out + ret.err).toBe(0);
    const rec = h.sb(['reconcile', '--run', run, '--return', ho.out.match(/^RETURN_FILE: (\S+)$/m)![1]!, '--reading', '2100000']);
    expect(rec.out).toContain('child=complete');
    expect(rec.code, rec.out).toBe(0);
  });

  test('every section the brief can name is a registered ship section', () => {
    const manifest = JSON.parse(fs.readFileSync(`${import.meta.dir}/../ship/sections/manifest.json`, 'utf8'));
    const ids = new Set(manifest.sections.map((s: any) => s.id));
    for (const id of segmentSections('1', '22')) expect(ids.has(id)).toBe(true);
  });

  // Value: protects=the record ship/DRIVER.md tells the parent to keep is one gstack-ship-budget handoff accepts: the driver names each of the six headings with the phase that writes it, and a record holding them hands Steps 9-11.5 off while one missing a heading is refused by name; fails_when=the driver drops or renames a heading the handoff requires (GSTA-167 replay 5: "record ... lacks headings: Release, Decisions, Reviews, Checks, Documentation, Next steps"), or the refusal stops naming the missing heading;
  //   why_new=the harness record above is hand-written, never the driver's; seam=none; no_claim=that the parent writes each heading on time
  test('the driver names each record heading with its phase, and a record built from it hands Steps 9-11.5 off', () => {
    const driver = fs.readFileSync(`${ROOT}/ship/DRIVER.md`, 'utf8');
    const named = [...driver.matchAll(/\*\*([A-Z][a-z]+(?: steps)?)\*\*\s+\((?:Phases? [\d-]+|Step [\d.]+|any\s+phase|every phase)/g)].map(m => m[1]);
    expect(new Set(named)).toEqual(new Set(RECORD_HEADINGS));
    expect(driver).toContain('write its six headings at Phase 1');
    const h = fresh();
    const record = (headings: readonly string[]) => {
      const file = h.record(`driver-${headings.length}.md`);
      fs.writeFileSync(file, ['# /ship invocation record', '', ...headings.flatMap(x => [`## ${x}`, x === 'Checks' ? '- Coverage: 89% value-weighted; Scope Check: CLEAN' : '', ''])].join('\n'));
      return file;
    };
    const handoff = (file: string) => {
      const s = h.sb(['start', '--record', file, '--token-cap', '400M', '--reading', '98000']);
      expect(s.code, s.out + s.err).toBe(0);
      return h.sb(['handoff', '--run', h.field(s.out, 'BUDGET_RUN', 'id'), '--from', '9', '--to', '11.5', '--base', 'origin/main', '--reading', '1000000']);
    };
    const ok = handoff(record(RECORD_HEADINGS));
    expect(ok.code, ok.out + ok.err).toBe(0);
    const read = readSection(fs.readFileSync(ok.out.match(/^HANDOFF: (\S+) /m)![1]!, 'utf8'));
    expect(read).toContain('review-army.md, adversarial.md, budget-handoff.md');
    const refused = handoff(record(RECORD_HEADINGS.filter(x => x !== 'Next steps')));
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('lacks headings: Next steps');
  });
});
