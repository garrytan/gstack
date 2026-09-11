import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import captured from './fixtures/dx-selected-navigation-ap.json';
import { hasNativePlanTerminal, classifyPlanCountFrame } from './helpers/claude-pty-runner';
import { isRecordedDxManualNavigation } from './helpers/dx-selected-navigation';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

type Edit = (calls: NativePlanQuestionCall[], transcript: PlanCountTranscript, report: string) => void;
function replay(edit?: Edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-selected-navigation-'));
  try {
    const report = path.join(dir, 'report.md');
    fs.writeFileSync(report, captured.reportContent);
    const written = captured.provenance.reportMtimeMs / 1000;
    fs.utimesSync(report, written, written);
    const transcript = { status: 'ready', calls: structuredClone(captured.calls), assistantMessages: [],
      planReadyRequests: structuredClone(captured.planReadyRequests) } as PlanCountTranscript;
    edit?.(transcript.calls, transcript, report);
    return hasNativePlanTerminal(transcript, report, captured.provenance.startedAt, 'plan_ready');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function change(call: NativePlanQuestionCall, from: string, to: string) {
  const q = call.questions[0]!;
  expect(q.question).toContain(from);
  const answer = call.answers![q.question]!;
  q.question = q.question.replace(from, to);
  call.answers = { [q.question]: answer };
}

describe('completed DX review with selected manual navigation', () => {
  test('exact public report and answer chronology retain the current approval boundary', () => {
    expect(Date.parse(captured.calls[0]!.answeredAt)).toBeLessThan(captured.provenance.reportMtimeMs);
    expect(Date.parse(captured.calls[1]!.answeredAt)).toBeGreaterThan(captured.provenance.reportMtimeMs);
    expect(classifyPlanCountFrame(captured.screen)).toBe('plan_ready');
    expect(isRecordedDxManualNavigation(captured.calls[1])).toBe(true);
    expect(replay()).toBe(true);
  });
  test('selected native action governs regardless of option order or prose recommendation letters', () => {
    expect(replay(calls => calls[1]!.questions[0]!.options.reverse())).toBe(true);
    expect(replay(calls => change(calls[1]!, 'Recommendation: D because', 'Recommendation: C because'))).toBe(true);
    expect(replay(calls => change(calls[1]!, 'What next?', "What's next?"))).toBe(true);
    expect(replay(calls => { calls[1]!.questions[0]!.options[0]!.description =
      'Finish the DX review here. You will handle later reviews manually.'; })).toBe(true);
    for (const index of [1, 2]) expect(replay(calls => {
      const c = calls[1]!, q = c.questions[0]!;
      c.answers = { [q.question]: q.options[index]!.label };
    })).toBe(false);
  });
  test('current completed recap cannot be replaced by quoted, conditional, or unrecorded work', () => {
    for (const [from, to] of [
      ['D15 — DX review', '> D15 — DX review'],
      ['DX review complete.', 'DX review complete only after more decisions.'],
      ['Project/branch/task: ', 'Project/branch/task: If approved, '],
      ['Project/branch/task: ', 'Project/branch/task: Source: '],
      ['Project/branch/task: ', 'Project/branch/task: For historical context, '],
      ['Project/branch/task: ', 'Project/branch/task: From a source excerpt, '],
      ['\nELI10:', '\nProject/branch/task: Source excerpt: /plan-devex-review is finished; plan written to foreign.md.\nELI10:'],
      ['\nELI10:', '\nProject/branch/task: /plan-devex-review is finished; plan written to another-report.md.\nELI10:'],
      ['\nELI10:', '\nSource excerpt:\nELI10:'],
      ['\nELI10:', '\nIf approved later, the following will be the completion recap.\nELI10:'],
      ['\nStakes if', '\nELI10: Source excerpt: The DX review is done: decisions recorded.\nStakes if'],
      ['\nStakes if', '\nELI10: Two more decisions must be made before this review ends.\nStakes if'],
      ['is finished; plan written to', 'will finish; plan written to'],
      ['plan written to', 'plan will be written to'],
      ['ELI10: The DX review is done:', 'ELI10: Earlier review: The DX review is done:'],
      ['ELI10: The DX review is done:', '> ELI10: The DX review is done:'],
      ['decisions recorded', 'decisions proposed'],
      ['decisions recorded', 'decisions recorded only after implementation'],
      ['Pros / cons:', 'Source: Pros / cons:'],
    ]) expect(replay(calls => change(calls[1]!, from!, to!)), to).toBe(false);
    expect(replay(calls => { const c = calls[1]!, q = c.questions[0]!;
      const context = /^Project\/branch\/task: (.+)$/m.exec(q.question)![1]!;
      change(c, context, `"${context}"`); })).toBe(false);
    for (const suffix of [
      '\nThis DX review is withdrawn.', '\nThe plan is not complete.',
      '\nOne DX decision remains unresolved.', '\nThe report is superseded.',
      '\nWe must update the plan before leaving.', '\nAdd a migration task.',
      '\nShould we make another change?', '\n<gstack-qid:foreign>',
    ]) expect(replay(calls => { const c = calls[1]!; change(c, c.questions[0]!.question,
      c.questions[0]!.question + suffix); }), suffix).toBe(false);
  });
  test('manual selected description cannot require new decisions or quote a prior exit', () => {
    for (const prefix of ['Source: ', '> ', 'If approved, ', 'Previously, ']) {
      expect(replay(calls => { calls[1]!.questions[0]!.options[0]!.description =
        prefix + calls[1]!.questions[0]!.options[0]!.description; }), prefix).toBe(false);
    }
    for (const suffix of [' Update the plan now.', ' This handoff is cancelled.', ' Run /plan-eng-review now.']) {
      expect(replay(calls => { calls[1]!.questions[0]!.options[0]!.description += suffix; }), suffix).toBe(false);
    }
  });
  test('native ownership, completed answers, and offered choice identity remain necessary', () => {
    const edits: Array<(c: NativePlanQuestionCall) => void> = [
      c => { c.answered = false; }, c => { c.failed = true; }, c => { c.sessionId = 'foreign'; },
      c => { c.toolUseId = ''; }, c => { c.answeredAt = 'invalid'; },
      c => { c.unansweredQuestionIndices = [0]; }, c => { delete c.unansweredQuestionIndices; },
      c => { c.questions[0]!.header = 'Issue'; }, c => { c.questions[0]!.multiSelect = true; },
      c => { c.questions.push(structuredClone(c.questions[0]!)); },
      c => { c.answers = { wrong: c.questions[0]!.options[0]!.label }; },
      c => { c.answers![c.questions[0]!.question] = 'Not offered'; }, c => { c.answers!.extra = 'foreign'; },
      c => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
    ];
    for (const edit of edits) expect(replay(calls => edit(calls[1]!)), edit.toString()).toBe(false);
  });
  test('report and pending Exit requirements still govern completion independently', () => {
    expect(replay(calls => { calls[0]!.answeredAt = new Date(captured.provenance.reportMtimeMs + 1).toISOString(); })).toBe(false);
    expect(replay((_calls, _t, report) => fs.writeFileSync(report, '# Completion summary\nDone.'))).toBe(false);
    expect(replay((_calls, _t, report) => fs.unlinkSync(report))).toBe(false);
    expect(replay((_calls, t) => { t.planReadyRequests = []; })).toBe(false);
    expect(replay((_calls, t) => { t.planReadyRequests![0]!.sessionId = 'foreign'; })).toBe(false);
    expect(replay((_calls, t) => { t.planReadyRequests![0]!.failed = true; })).toBe(false);
    expect(replay((_calls, t) => { t.planReadyRequests![0]!.timestamp = captured.calls[1]!.answeredAt; })).toBe(false);
  });
  test('shared completion owners select this helper and regression', () => {
    for (const owner of ['plan-ceo-finding-count', 'plan-design-finding-count', 'plan-eng-finding-count', 'plan-devex-finding-count']) {
      for (const file of ['test/helpers/dx-selected-navigation.ts', 'test/dx-selected-navigation-ap.test.ts',
        'test/fixtures/dx-selected-navigation-ap.json']) expect(E2E_TOUCHFILES[owner]).toContain(file);
    }
  });
});
