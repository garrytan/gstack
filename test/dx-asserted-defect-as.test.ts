import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/dx-asserted-defect-as.json';
import retryFixture from './fixtures/dx-asserted-defect-as-retry.json';
import { devexSeedCoverage } from './helpers/devex-seed-coverage';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, matchGlob } from './helpers/touchfiles';

const missed = [1, 2, 4];
function transcript(): PlanCountTranscript {
  return { status: 'ready', calls: structuredClone(fixture.calls) as NativePlanQuestionCall[], assistantMessages: [] };
}
function retryTranscript(): PlanCountTranscript {
  return { status: 'ready', calls: structuredClone(retryFixture.calls) as NativePlanQuestionCall[], assistantMessages: [] };
}
function change(t: PlanCountTranscript, i: number, edit: (s: string) => string) {
  const c = t.calls[i]!, q = c.questions[0]!, answer = c.answers![q.question]!;
  q.question = edit(q.question); c.answers = { [q.question]: answer };
}
function title(t: PlanCountTranscript, i: number, edit: (s: string) => string) {
  change(t, i, s => { const lines = s.split('\n'); lines[0] = edit(lines[0]!); return lines.join('\n'); });
}
function replaceTitle(t: PlanCountTranscript, i: number, s: string) { title(t, i, () => `D${i} — ${s}`); }
function absentStage(t: PlanCountTranscript) {
  replaceTitle(t, 4, "Journey stage INSTALL / HELLO WORLD: the quickstart's first command points at a file that does not ship.");
}

describe('DX asserted defect heading families', () => {
  test('the exact completed first attempt has five distinct decisions without changing historical outcomes', () => {
    const t = transcript(), before = JSON.stringify(t), result = devexSeedCoverage(t);
    expect(t.calls).toHaveLength(6); expect(result.complete).toBe(true); expect(result.missing).toEqual([]);
    expect(Object.values(result.decisions).flat().sort()).toEqual(t.calls.slice(1).map(c => `${c.sessionId}:${c.toolUseId}`).sort());
    expect(JSON.stringify(t)).toBe(before); expect(fixture.provenance.paidOutcomesReclassified).toBe(false);
    expect(fixture.provenance.historicalOutcome).toContain('seed predicates failed');
    for (let i = 1; i <= 5; i++) { const copy = transcript(); copy.calls.splice(i, 1); expect(devexSeedCoverage(copy).missing).toHaveLength(1); }
  });
  test('equivalent nominal prerequisites and explicit signature comparisons retain concrete alternatives', () => {
    for (const heading of ['Required remote CI gate before the first local evaluation', 'Mandatory 30-second CI check before first local run.', 'Mandatory CI check before the first local result?']) {
      const t = transcript(); replaceTitle(t, 1, heading); expect(devexSeedCoverage(t).complete).toBe(true);
    }
    for (const heading of ['`run_eval(dataset, evaluator)` versus `run_batch(evaluator, dataset)`: opposite argument order', 'run_eval(dataset, evaluator) vs. run_batch(evaluator, dataset): swapped positional order?', 'run_eval(dataset, evaluator) and run_batch(evaluator, dataset): reversed positional order.']) {
      const t = transcript(); replaceTitle(t, 2, heading); expect(devexSeedCoverage(t).complete).toBe(true);
    }
    for (const i of missed) { const t = transcript(), c = t.calls[i]!, q = c.questions[0]!;
      for (const option of q.options) { c.answers = { [q.question]: option.label }; expect(devexSeedCoverage(t).complete).toBe(true); }
    }
  });
  test('same-file absence and source-defined stage vocabulary normalize without paid retry credit', () => {
    for (const suffix of ['not in the wheel or the release examples archive', 'not in the package', 'not in the wheel?']) {
      const t = transcript(); title(t, 4, s => s.replace('not in the package or the examples archive', suffix)); expect(devexSeedCoverage(t).complete).toBe(true);
    }
    // Synthetic title controls based on the source-defined journey vocabulary.
    // The fixture above contains only completed first-attempt native calls.
    for (const stage of ['INSTALL / HELLO WORLD', 'Install', 'DISCOVER / INSTALL', 'HELLO WORLD', 'REAL USAGE', 'DEBUG', 'UPGRADE']) {
      const t = transcript(); absentStage(t); title(t, 4, s => s.replace('INSTALL / HELLO WORLD', stage)); expect(devexSeedCoverage(t).complete).toBe(true);
    }
    for (const stage of ['SOURCE / HELLO WORLD', 'INSTALL / ARCHIVE', 'OLD INSTALL', 'DEPLOYMENT']) {
      const t = transcript(); absentStage(t); title(t, 4, s => s.replace('INSTALL / HELLO WORLD', stage)); expect(devexSeedCoverage(t).complete).toBe(false);
    }
  });
  test('healthy, optional, foreign and unasserted headings cannot borrow repairs from their options', () => {
    for (const [i, heading] of [
      [1, 'Optional remote CI check before the first local result'], [1, 'Mandatory remote CI check after the first local result'],
      [1, 'Current issue'], [2, 'run_eval(dataset, evaluator) vs run_batch(dataset, evaluator): same positional order'],
      [2, 'run_score(dataset, evaluator) vs run_batch(evaluator, dataset): reversed positional order'], [2, 'Function signatures'],
      [4, 'README quickstart points at examples/first_eval.py, which is in the package and the examples archive'],
      [4, 'README quickstart does not point at a file that does not ship'],
      [4, 'README quickstart points at a file that does ship'],
    ] as const) for (const punctuation of ['', '?']) { const t = transcript(); replaceTitle(t, i, heading + punctuation); expect(devexSeedCoverage(t).complete, `${i}: ${heading}${punctuation}`).toBe(false); }
  });
  test('punctuation never bypasses title, metadata or explanation ownership', () => {
    for (const questionMark of ['', '?']) for (const i of missed) {
      for (const prefix of ['Source: ', 'Source. ', 'Historical example: ', 'Earlier review: ', 'Quoted source: ', 'If approved, ', 'Assuming approval, ', 'Provided approval, ', '> ', '"', '`']) {
        const t = transcript(); title(t, i, s => s.replace(/^(D\d+ — )(.*)$/, (_, id, body) => `${id}${prefix}${body}${prefix === '"' || prefix === '`' ? prefix : ''}${questionMark}`));
        expect(devexSeedCoverage(t).complete, `title ${i} ${prefix} ${questionMark}`).toBe(false);
      }
      for (const tail of [' if approved', ' once approved', ' after approval', ' pending approval']) {
        const t = transcript(); title(t, i, s => s + tail + questionMark); expect(devexSeedCoverage(t).complete).toBe(false);
      }
      for (const prefix of ['Source: ', 'Source. ', 'Historical assessment: ', 'If approved, ', 'Assuming approval, ', 'Provided approval, ']) {
        const t = transcript(); title(t, i, s => s + questionMark); change(t, i, s => s.replace('Project/branch/task: ', `Project/branch/task: ${prefix}`)); expect(devexSeedCoverage(t).complete).toBe(false);
      }
      for (const prefix of ['Source.\n', 'Hypothetical scenario.\n', '~~~\n', 'Earlier review assessment:\n']) {
        const t = transcript(); title(t, i, s => s + questionMark); change(t, i, s => s.replace('\nELI10:', `\n${prefix}ELI10:`)); expect(devexSeedCoverage(t).complete).toBe(false);
      }
    }
  });
  test('a current same-decision withdrawal wins; foreign, quoted and prospective statuses do not', () => {
    for (const i of missed) for (const punctuation of ['', '?']) {
      for (const tail of [`D${i} is withdrawn.`, `D ${i} is "superseded".`, 'This finding is cancelled.', 'This issue is "not current".', 'This finding is no longer current.', 'This finding is "no longer current".', "This finding is 'no longer current'.", 'This finding is `no longer current`.', `D${i} is "no longer current".`]) {
        const t = transcript(); title(t, i, s => s + punctuation); change(t, i, s => `${s}\n${tail}`); expect(devexSeedCoverage(t).complete).toBe(false);
      }
      for (const tail of ['D29 is withdrawn.', `> D${i} is withdrawn.`, `Earlier note: "D${i} is withdrawn."`, '```\nThis finding is cancelled.\n```', 'If the repair is accepted, this finding is resolved in the proposed API.']) {
        const t = transcript(); title(t, i, s => s + punctuation); change(t, i, s => `${s}\n${tail}`); expect(devexSeedCoverage(t).complete).toBe(true);
      }
    }
  });
  test('current offered remedies are required for the nominal and absence forms', () => {
    for (const i of missed) for (const mode of ['quoted', 'source', 'conditional', 'withdrawn', 'own-decision', 'navigation']) {
      const t = transcript(), c = t.calls[i]!, q = c.questions[0]!;
      q.options = q.options.map((o, n) => {
        if (mode === 'quoted') return { label: `"${o.label}" ${n}`, description: `"${o.description}"` };
        if (mode === 'source') return { label: `Reference ${n}`, description: `Source. ${o.label}\n${o.description}` };
        if (mode === 'conditional') return { label: `Alternative ${n}`, description: `Assuming approval, ${o.label}\n${o.description}` };
        if (mode === 'navigation') return { label: `Continue ${n}`, description: 'Move to the next section.' };
        return { ...o, description: `${o.description}\n${mode === 'own-decision' ? `D${i}` : 'This option'} is "withdrawn".` };
      });
      c.answers = { [q.question]: q.options[0]!.label }; expect(devexSeedCoverage(t).complete).toBe(false);
    }
  });
  test('owned option statuses remain binding after a line break or an effort estimate', () => {
    for (const i of missed) for (const separator of ['\n', ' ']) {
      for (const status of ['withdrawn', 'not current', 'no longer current']) for (const [open, close] of [['', ''], ["'", "'"], ['"', '"'], ['‘', '’'], ['“', '”'], ['`', '`']]) {
        const t = transcript(), q = t.calls[i]!.questions[0]!;
        for (const option of q.options) option.description += `${separator}This option is ${open}${status}${close}.`;
        expect(devexSeedCoverage(t).complete, `${i}: ${JSON.stringify(separator)} ${open}${status}${close}`).toBe(false);
      }
      for (const tail of ['Correction: This action is "no longer current".', `D${i} is 'not current'.`]) {
        const t = transcript(); for (const option of t.calls[i]!.questions[0]!.options) option.description += separator + tail;
        expect(devexSeedCoverage(t).complete).toBe(false);
      }
      for (const tail of ['D29 is "no longer current".', 'Old note: "This option is no longer current."', '"Archived proposal (human: ~1 day / CC: ~20 min) This option is withdrawn."', 'If the repair is accepted, this option is no longer current.']) {
        const t = transcript(); for (const option of t.calls[i]!.questions[0]!.options) option.description += separator + tail;
        expect(devexSeedCoverage(t).complete, `${i}: ${tail}`).toBe(true);
      }
    }
  });
  test('native completion, exact answer, distinct calls and session identity remain mandatory', () => {
    for (const change of [
      (t: PlanCountTranscript) => { t.status = 'missing'; },
      (t: PlanCountTranscript) => { t.calls[1]!.answered = false; },
      (t: PlanCountTranscript) => { t.calls[1]!.failed = true; },
      (t: PlanCountTranscript) => { t.calls[1]!.answeredAt = 'unknown'; },
      (t: PlanCountTranscript) => { t.calls[1]!.unansweredQuestionIndices = [0]; },
      (t: PlanCountTranscript) => { t.calls[1]!.answers = { foreign: 'Remove gate from local runs and demo (recommended)' }; },
      (t: PlanCountTranscript) => { t.calls[1]!.sessionId = 'foreign'; },
      (t: PlanCountTranscript) => { t.calls.push(structuredClone(t.calls[1]!)); },
      (t: PlanCountTranscript) => { t.calls[1]!.questions[0]!.multiSelect = true; },
      (t: PlanCountTranscript) => { t.calls[1]!.questions.push(structuredClone(t.calls[2]!.questions[0]!)); },
    ]) { const t = transcript(); change(t); expect(devexSeedCoverage(t).complete).toBe(false); }
  });
  test('the separately completed retry retains its five exact current seed decisions and failed outcome', () => {
    const t = retryTranscript(), before = JSON.stringify(t), result = devexSeedCoverage(t);
    expect(t.calls).toHaveLength(14); expect(result.complete).toBe(true); expect(result.missing).toEqual([]);
    expect(Object.values(result.decisions).flat().sort()).toEqual([3, 4, 5, 6, 7, 10].map(i => `${t.calls[i]!.sessionId}:${t.calls[i]!.toolUseId}`).sort());
    expect(JSON.stringify(t)).toBe(before); expect(retryFixture.provenance.paidOutcomesReclassified).toBe(false);
    expect(retryFixture.provenance.historicalOutcome).toContain('seed predicates failed');
  });
  test('retry signature spelling and coded-error action evidence stay current and owned', () => {
    for (const i of [3, 5, 6]) {
      for (const tail of ['This finding is no longer current.', 'This finding is "no longer current".', "This finding is 'no longer current'.", 'This finding is `no longer current`.', `D${i + 1} is withdrawn.`]) {
        const t = retryTranscript(); change(t, i, s => `${s}\n${tail}`); expect(devexSeedCoverage(t).complete).toBe(false);
      }
      for (const prefix of ['Source: ', 'If approved, ', 'Assuming approval, ']) {
        const t = retryTranscript(); change(t, i, s => s.replace('ELI10: ', `ELI10: ${prefix}`)); expect(devexSeedCoverage(t).complete).toBe(false);
      }
      for (const tail of [`> D${i + 1} is withdrawn.`, `Old note: "D${i + 1} is no longer current."`, 'D39 is withdrawn.']) {
        const t = retryTranscript(); change(t, i, s => `${s}\n${tail}`); expect(devexSeedCoverage(t).complete).toBe(true);
      }
    }
    for (const text of ['take the same two concepts in the same positional order.', 'take the same two concepts in opposite positional order if approved.']) {
      const t = retryTranscript(); title(t, 5, s => s.replace('take the same two concepts in opposite positional order.', text)); expect(devexSeedCoverage(t).complete).toBe(false);
    }
    const healthy = retryTranscript(); title(healthy, 5, s => s.replace('run_batch(evaluator, dataset)', 'run_batch(dataset, evaluator)')); expect(devexSeedCoverage(healthy).complete).toBe(false);
    for (const label of ['A) Not coded, causal, fix + link', 'A) "Coded, causal, fix + link"', 'A) Reference']) {
      const t = retryTranscript(), c = t.calls[6]!, q = c.questions[0]!; q.options[0]!.label = label; c.answers = { [q.question]: label }; expect(devexSeedCoverage(t).complete).toBe(false);
    }
    for (const prefix of ['Source. ', 'If approved, ']) {
      const t = retryTranscript(), c = t.calls[6]!, q = c.questions[0]!; q.options[0]!.description = prefix + q.options[0]!.description; expect(devexSeedCoverage(t).complete).toBe(false);
    }
    const pending = retryTranscript(); pending.calls[5]!.answered = false; expect(devexSeedCoverage(pending).complete).toBe(false);
    const foreign = retryTranscript(); foreign.calls[6]!.sessionId = 'foreign'; expect(devexSeedCoverage(foreign).complete).toBe(false);
  });
  test('the focused source and exact fixture select only DX; dependency arrays stay dense', () => {
    for (const file of ['test/dx-asserted-defect-as.test.ts', 'test/fixtures/dx-asserted-defect-as.json', 'test/fixtures/dx-asserted-defect-as-retry.json']) {
      expect(Object.entries(E2E_TOUCHFILES).filter(([, patterns]) => patterns.some(p => matchGlob(file, p))).map(([name]) => name)).toEqual(['plan-devex-finding-count']);
    }
    for (const files of Object.values(E2E_TOUCHFILES)) for (let i = 0; i < files.length; i++) { expect(Object.hasOwn(files, i)).toBe(true); expect(typeof files[i]).toBe('string'); }
  });
});
