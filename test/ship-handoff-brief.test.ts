/**
 * GSTA-167 PR 3a: a handoff child reads only its segment's sections. On #34
 * and #36 the Steps 7-11.5 child booted at 1.29M by reading the whole ship
 * skill, preamble.md and docs/ship-budget.md before its first step; the brief
 * now names ship/SKILL.md's step list, the segment's sections and
 * budget-handoff.md, and nothing else.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { segmentSections } from '../lib/ship-handoff';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

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
  test('Steps 7-11.5: the step list plus test-coverage, plan-completion, review-army and adversarial', () => {
    const read = readSection(briefFor('7', '11.5'));
    expect(read).toContain("ship/SKILL.md's step list");
    for (const s of ['test-coverage.md', 'plan-completion.md', 'review-army.md', 'adversarial.md', 'budget-handoff.md']) expect(read).toContain(s);
    for (const s of ['changelog.md', 'documentation.md', 'pr-body.md', 'capy-pr.md', 'tests.md']) expect(read).not.toContain(s);
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

  test('every section the brief can name is a registered ship section', () => {
    const manifest = JSON.parse(fs.readFileSync(`${import.meta.dir}/../ship/sections/manifest.json`, 'utf8'));
    const ids = new Set(manifest.sections.map((s: any) => s.id));
    for (const id of segmentSections('1', '22')) expect(ids.has(id)).toBe(true);
  });
});
