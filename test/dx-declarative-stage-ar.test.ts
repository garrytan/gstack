import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/dx-declarative-stage-ar.json';
import { devexSeedCoverage } from './helpers/devex-seed-coverage';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, matchGlob } from './helpers/touchfiles';

function transcript(): PlanCountTranscript {
  return { status: 'ready', calls: structuredClone(fixture.calls) as NativePlanQuestionCall[], assistantMessages: [] };
}
function change(t: PlanCountTranscript, index: number, edit: (text: string) => string) {
  const c = t.calls[index]!, q = c.questions[0]!, answer = c.answers![q.question]!;
  q.question = edit(q.question); c.answers = { [q.question]: answer };
}
function title(t: PlanCountTranscript, index: number, edit: (text: string) => string) {
  change(t, index, text => { const lines = text.split('\n'); lines[0] = edit(lines[0]!); return lines.join('\n'); });
}
const seeds = [3, 4, 5, 6, 7];

describe('DX completed journey-stage declarations', () => {
  test('all nine exact calls retain five separate seed decisions and the failed live outcome', () => {
    const t = transcript(), bytes = JSON.stringify(t), result = devexSeedCoverage(t);
    expect(t.calls).toHaveLength(9);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(Object.values(result.decisions).flat().sort()).toEqual(seeds.map(i => `${t.calls[i]!.sessionId}:${t.calls[i]!.toolUseId}`).sort());
    expect(JSON.stringify(t)).toBe(bytes);
    expect(fixture.provenance.paidOutcomesReclassified).toBe(false);
    expect(fixture.provenance.historicalOutcome).toBe('plan_ready; all five seeded-gap predicates failed');
    for (const i of seeds) { const copy = transcript(); copy.calls.splice(i, 1); expect(devexSeedCoverage(copy).missing).toHaveLength(1); }
  });
  test('equivalent presentation and every offered alternate keep the same decisions', () => {
    for (const edit of [
      (s: string) => s.replace('Journey stage', 'journey stage'),
      (s: string) => s.replace("quickstart's", 'quickstart’s'),
      (s: string) => s.replace('including the keyless demo', 'including the offline demo'),
      (s: string) => s.replace('run_eval and run_batch', '`run_eval` and `run_batch`'),
      (s: string) => s + '.',
    ]) { const t = transcript(); for (const i of seeds) title(t, i, edit); expect(devexSeedCoverage(t).complete).toBe(true); }
    for (const i of seeds) { const t = transcript(), c = t.calls[i]!, q = c.questions[0]!;
      for (const option of q.options) { c.answers = { [q.question]: option.label }; expect(devexSeedCoverage(t).complete).toBe(true); }
    }
  });
  test('only supported current journey labels frame the declaration', () => {
    for (const prefix of ['Earlier review: ', 'Source: ', 'If approved, ', 'Assuming approval, ', '> ', '"', '`']) {
      for (const i of seeds) { const t = transcript(); title(t, i, s => s.replace(/^(D\d+ — )(.*)$/, (_, id, body) => `${id}${prefix}${body}${prefix === '"' || prefix === '`' ? prefix : ''}`)); expect(devexSeedCoverage(t).complete).toBe(false); }
    }
    for (const label of ['SOURCE', 'OLD DEBUG', 'DEPLOYMENT', 'HISTORICAL UPGRADE']) {
      const t = transcript(); title(t, 4, s => s.replace('HELLO WORLD', label)); expect(devexSeedCoverage(t).complete).toBe(false);
    }
  });
  test('a changed aside cannot erase a condition, exception, negation or historical premise', () => {
    for (const aside of [
      'excluding the keyless demo', 'except the keyless demo', 'including no local runs',
      'including only the keyless demo', 'including a hypothetical demo', 'including an earlier demo',
      'including source examples', 'including the already fixed demo', 'including the cancelled demo',
      'including the demo if approved', 'including the demo without CI',
    ]) { const t = transcript(); title(t, 4, s => s.replace('including the keyless demo', aside)); expect(devexSeedCoverage(t).complete).toBe(false); }
    for (const edit of [(s: string) => s.replace('blocks', 'does not block'), (s: string) => s.replace('blocks', 'no longer blocks')]) {
      const t = transcript(); title(t, 4, edit); expect(devexSeedCoverage(t).complete).toBe(false);
    }
  });
  test('the stage subject and its own decision ordinal retain current authority', () => {
    for (const prefix of ['Assuming approval ', 'Provided approval ']) {
      const t = transcript(); title(t, 4, s => s.replace('HELLO WORLD: ', `HELLO WORLD: ${prefix}`)); expect(devexSeedCoverage(t).complete).toBe(false);
    }
    for (const status of ['withdrawn', '"withdrawn"', 'superseded', '"not current"']) {
      const t = transcript(); change(t, 4, s => `${s}\nD5 is ${status}.`); expect(devexSeedCoverage(t).complete).toBe(false);
    }
    for (const tail of ['D27 is withdrawn.', '> D5 is withdrawn.', 'Earlier note: "D5 is withdrawn."']) {
      const t = transcript(); change(t, 4, s => `${s}\n${tail}`); expect(devexSeedCoverage(t).complete).toBe(true);
    }
  });
  test('spaced decision counters bind to their own current withdrawal', () => {
    const t = transcript(); title(t, 4, s => s.replace('D5 —', 'D 5 —')); expect(devexSeedCoverage(t).complete).toBe(true);
    for (const ordinal of ['D5', 'D 5']) { const copy = structuredClone(t); change(copy, 4, s => `${s}\n${ordinal} is withdrawn.`); expect(devexSeedCoverage(copy).complete).toBe(false); }
  });
  test('current metadata and explanation cannot be supplied by conditional or source owners', () => {
    for (const prefix of ['Assuming approval, ', 'Provided approval, ', 'Source: ', 'Earlier review assessment: ', 'If approved, ']) {
      for (const i of seeds) { const t = transcript(); change(t, i, s => s.replace('Project/branch/task: ', `Project/branch/task: ${prefix}`)); expect(devexSeedCoverage(t).complete).toBe(false); }
    }
    for (const prefix of ['Source:\n', 'Earlier review assessment:\n', '```\n', '~~~\n']) {
      const t = transcript(); change(t, 4, s => s.replace('\nELI10:', `\n${prefix}ELI10:`)); expect(devexSeedCoverage(t).complete).toBe(false);
    }
  });
  test('a current withdrawal overrides the asserted stage title but quoted history does not', () => {
    for (const tail of ['This finding is cancelled.', 'This issue is "superseded".', 'This defect is not current.', 'Correction: this finding is withdrawn.']) {
      for (const i of seeds) { const t = transcript(); change(t, i, s => `${s}\n${tail}`); expect(devexSeedCoverage(t).complete).toBe(false); }
    }
    for (const tail of ['> This finding is cancelled.', 'Earlier note: "This issue is superseded."', '```\nThis finding is withdrawn.\n```', 'If the repair is accepted, this defect is resolved in the proposed API.']) {
      const t = transcript(); for (const i of seeds) change(t, i, s => `${s}\n${tail}`); expect(devexSeedCoverage(t).complete).toBe(true);
    }
  });
  test('offered action evidence stays current, meaningful and owned', () => {
    for (const mode of ['quoted', 'fenced', 'blockquoted', 'withdrawn', 'superseded', 'navigation']) {
      const t = transcript(), c = t.calls[6]!, q = c.questions[0]!;
      q.options = q.options.map(o => {
        const text = `${o.label}\n${o.description ?? ''}`;
        if (mode === 'quoted') return { label: `"${o.label}"`, description: `"${o.description}"` };
        if (mode === 'fenced') return { label: 'Reference', description: `~~~\n${text}\n~~~` };
        if (mode === 'blockquoted') return { label: 'Reference', description: text.split('\n').map(s => `> ${s}`).join('\n') };
        if (mode === 'navigation') return { label: 'Continue', description: 'Move to the next section.' };
        return { ...o, description: `${o.description}\nThis option is "${mode}".` };
      });
      // Preserve valid distinct native labels; the test targets action ownership.
      q.options.forEach((o, i) => { o.label += ` ${i}`; });
      c.answers = { [q.question]: q.options[0]!.label };
      expect(devexSeedCoverage(t).complete).toBe(false);
    }
  });
  test('native completion, separate calls, answer binding and session ownership stay required', () => {
    const edits: Array<(t: PlanCountTranscript) => void> = [
      t => { t.status = 'missing'; }, t => { t.calls[4]!.answered = false; }, t => { t.calls[4]!.failed = true; },
      t => { t.calls[4]!.answeredAt = 'unknown'; }, t => { t.calls[4]!.unansweredQuestionIndices = [0]; },
      t => { t.calls[4]!.answers = { oldQuestion: 'Continue' }; },
      t => { const c = t.calls[4]!; c.answers = { [c.questions[0]!.question]: 'Not offered' }; },
      t => { t.calls[4]!.sessionId = 'foreign'; }, t => { t.calls.push(structuredClone(t.calls[4]!)); },
      t => { t.calls[4]!.questions[0]!.multiSelect = true; },
      t => { t.calls[4]!.questions.push(structuredClone(t.calls[3]!.questions[0]!)); },
    ];
    for (const edit of edits) { const t = transcript(); edit(t); expect(devexSeedCoverage(t).complete).toBe(false); }
  });
  test('both files select only the existing DX coverage owner and owner arrays stay dense', () => {
    for (const file of ['test/dx-declarative-stage-ar.test.ts', 'test/fixtures/dx-declarative-stage-ar.json']) {
      expect(Object.entries(E2E_TOUCHFILES).filter(([, patterns]) => patterns.some(p => matchGlob(file, p))).map(([name]) => name)).toEqual(['plan-devex-finding-count']);
    }
    for (const files of Object.values(E2E_TOUCHFILES)) for (let i = 0; i < files.length; i++) {
      expect(Object.hasOwn(files, i)).toBe(true); expect(typeof files[i]).toBe('string');
    }
  });
});
