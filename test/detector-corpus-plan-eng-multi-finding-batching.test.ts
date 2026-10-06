/**
 * Replays stored plan-eng-multi-finding-batching census captures through the
 * case's real review-question counter (createEngBatchingIssueCounter), with
 * the saved plan rebuilt from the session's own Write/Edit calls as it stood
 * when each question was answered. The case passes at FLOOR = 3 credited
 * review questions; the floor is the paid test's and is not changed here.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { engSetupAUQ } from './helpers/claude-pty-runner';
import { createEngBatchingIssueCounter } from './helpers/eng-seeded-coverage';
import { nativePlanCallFingerprint } from './helpers/pty/auq';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const DIR = path.join(import.meta.dir, 'fixtures/detector-corpora/plan-eng-multi-finding-batching');
const FLOOR = 3;
const files = fs.readdirSync(DIR).filter(name => name !== 'inventory.json' && name.endsWith('.json')).sort();
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

interface StoredCall { sessionId: string; toolUseId: string; answeredAt: string; answer: string;
  question: NativePlanQuestionCall['questions'][number] }
type PlanEvent = { at: string; write?: string; old?: string; new?: string; all?: boolean };

function planAt(events: PlanEvent[], at: number): string {
  let plan = '';
  for (const e of events) {
    if (Date.parse(e.at) > at) continue;
    if (e.write !== undefined) plan = e.write;
    else if (plan.includes(e.old!)) plan = e.all ? plan.split(e.old!).join(e.new!) : plan.replace(e.old!, () => e.new!);
  }
  return plan;
}

/** Credited review questions, as the paid runner asks the counter once per answered call. */
function credited(input: { calls: StoredCall[]; planEvents: PlanEvent[] }): number {
  let at = 0;
  const counter = createEngBatchingIssueCounter(() => planAt(input.planEvents, at), engSetupAUQ);
  const calls: NativePlanQuestionCall[] = input.calls.map(c => ({ sessionId: c.sessionId, toolUseId: c.toolUseId,
    questions: [c.question], answered: true, failed: false, answers: { [c.question.question]: c.answer },
    unansweredQuestionIndices: [], answeredAt: c.answeredAt }) as NativePlanQuestionCall);
  return calls.filter((call, i) => {
    at = Date.parse(call.answeredAt!);
    return counter.isReviewAUQ(nativePlanCallFingerprint(call, 0, false), calls.slice(0, i));
  }).length;
}

describe('plan-eng-multi-finding-batching detector corpus', () => {
  test('inventory names every census entry', () => {
    const inventory: Array<{ entry: string | null }> = JSON.parse(fs.readFileSync(path.join(DIR, 'inventory.json'), 'utf8'));
    expect(inventory.flatMap(row => row.entry ? [row.entry] : []).sort())
      .toEqual(files.filter(name => !load(name).derived));
  });

  for (const name of files) {
    const entry = load(name);
    test(`${name}: the counter ${entry.expected === 'pass' ? 'credits' : 'refuses'} it (census ${entry.census_outcome})`, () => {
      expect(credited(entry.input) >= FLOOR ? 'pass' : 'refuse').toBe(entry.expected);
    });
  }

  test('37228573062: the target must open a sentence, and a plan identity is still required', () => {
    const entry = load('37228573062-t1-fail.json');
    const declaration = 'Review target (fixed): `PLAN.md`';
    const edit = (mutate: (text: string) => string) => ({ ...entry.input,
      planEvents: entry.input.planEvents.map((e: PlanEvent) => e.write === undefined ? e : { ...e, write: mutate(e.write) }) });
    expect(entry.input.planEvents[0].write).toContain(`Report destination requested by the user. ${declaration}`);
    expect(credited(entry.input)).toBeGreaterThanOrEqual(FLOOR);
    expect(credited(edit(t => t.replace(declaration, `the reviewer read the ${declaration}`)))).toBe(0);
    expect(credited(edit(t => t.replace(declaration, 'Review target (fixed): `NOTES.md`')))).toBe(0);
  });
});
