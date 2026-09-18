import { expect, test } from 'bun:test';
import capture from './fixtures/design-scope-selection-aj.json';
import { nativeSeededPlanSelection } from './helpers/plan-scope-selection';
import type { PlanCountTranscript, NativePublicToolEvent } from './helpers/plan-count-transcript';
import { selectTests, E2E_TOUCHFILES } from './helpers/touchfiles';

const originals = capture.observations;
const check = (observation = structuredClone(originals[0]!)) => nativeSeededPlanSelection(
  observation.transcript as PlanCountTranscript,
  observation.tools as NativePublicToolEvent[],
  observation.opts,
);
const selectedMessage = (o: typeof originals[number]) => o.transcript.assistantMessages.find(m => m.text.includes('"Marketing landing page"'))!;

test('both actual explicit draft selections bind the named seed after this session loaded the skill', () => {
  for (const o of originals) expect(check(o)).toBe(true);
  for (const verb of ["I'll review", 'I will review', "I'll go with reviewing", 'I will go with reviewing']) {
    const o = structuredClone(originals[1]!);
    selectedMessage(o).text = `${verb} the "Marketing landing page" draft, starting by checking the design system.`;
    expect(check(o)).toBe(true);
  }
});

test('a named target still requires the successful current skill and invocation', () => {
  for (const original of originals) {
    for (const mutate of [
      (o: typeof original) => { o.opts.seed = '# Plan: Other page'; },
      (o: typeof original) => { o.opts.seed += '\n# Plan: Another'; },
      (o: typeof original) => { o.opts.sessionId = 'foreign'; },
      (o: typeof original) => { o.opts.commandStartedAt = Date.parse(selectedMessage(o).timestamp) + 1; },
      (o: typeof original) => { o.tools[0]!.input!.skill = 'plan-ceo-review'; },
      (o: typeof original) => { o.tools[1]!.isError = true; },
      (o: typeof original) => { o.tools[1]!.toolUseId = 'foreign'; },
      (o: typeof original) => { o.tools.pop(); },
    ]) {
      const o = structuredClone(original); o.transcript.assistantMessages = [selectedMessage(o)]; mutate(o); expect(check(o)).toBe(false);
    }
  }
});

test('quoted, hypothetical, conditional and withdrawn selections do not select the seed', () => {
  for (const original of originals) {
    const text = selectedMessage(original).text.trim();
    for (const invalid of [
      '> ' + text, '    ' + text, '"' + text + '"', 'Example:\n' + text,
      'The following is a source excerpt.\n' + text, 'An unproven hypothesis.\n' + text,
      text.replace("I'll", 'I might'), text.replace("I'll", "I won't"),
      text.replace('Marketing landing page', 'Other page'),
      text.replace('draft', 'branch diff'), text.replace(/,$/, '?'),
      text.replace(', ', ', if approved, '),
      text + ' I retract that selection.', text + ' This selection is withdrawn.',
      text + ' Treat that declaration as a hypothetical example.',
    ].filter(value => value !== text)) {
      const o = structuredClone(original); o.transcript.assistantMessages = [selectedMessage(o)]; selectedMessage(o).text = invalid;
      expect(check(o), invalid).toBe(false);
    }
  }
});

test('scope selection remains mapped to the existing design and engineering mode workflows', () => {
  for (const file of ['test/design-scope-selection-aj.test.ts', 'test/fixtures/design-scope-selection-aj.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected.sort()).toEqual(['plan-design-review-plan-mode', 'plan-eng-review-plan-mode']);
  }
});

test('a complete owned observation cannot use a withdrawn selection or a replacement target', () => {
  for (const original of originals) {
    for (const correction of ['The selection has been withdrawn.', 'The selected target is now the branch diff.', 'I have withdrawn this selection.', 'Correction: The selected target is now the branch diff.']) {
      for (const separator of [' ', '\n\n']) {
        const o = structuredClone(original);
        selectedMessage(o).text = selectedMessage(o).text.trim() + separator + correction;
        expect(check(o)).toBe(false);
      }
      const o = structuredClone(original);
      o.transcript.assistantMessages.push({ sessionId: o.opts.sessionId, timestamp: new Date(Date.parse(selectedMessage(o).timestamp) + 1000).toISOString(), text: correction });
      expect(check(o)).toBe(false);
    }
  }
});

test('old, unrelated, foreign and quoted assessments do not withdraw the current target', () => {
  for (const original of originals) {
    for (const text of [
      'Old note: "The selection has been withdrawn."',
      '> The selection has been withdrawn.',
      '```text\nThe selected target is now the branch diff.\n```',
      'Source excerpt:\nThe selection has been withdrawn.',
      'The following is a hypothetical example.\nThe selected target is now the branch diff.',
      'An unrelated payment selection has been withdrawn.',
      'The selected target is now the "Marketing landing page" draft.',
      'If approved, the selection has been withdrawn.',
      'The selected target is now the branch diff?',
      'The selected target is now the branch diff? This is a question.',
      'I have withdrawn this selection?',
    ]) {
      const o = structuredClone(original);
      o.transcript.assistantMessages.push({ sessionId: o.opts.sessionId, timestamp: new Date(Date.parse(selectedMessage(o).timestamp) + 1000).toISOString(), text });
      expect(check(o), text).toBe(true);
    }
    for (const foreign of [false, true]) {
      const o = structuredClone(original);
      o.transcript.assistantMessages.push({ sessionId: foreign ? 'foreign' : o.opts.sessionId, timestamp: new Date(Date.parse(selectedMessage(o).timestamp) + (foreign ? 1000 : -1000)).toISOString(), text: 'The selection has been withdrawn.' });
      expect(check(o)).toBe(true);
    }
    const o = structuredClone(original), selected = structuredClone(selectedMessage(o));
    o.transcript.assistantMessages.push({ sessionId: o.opts.sessionId, timestamp: new Date(Date.parse(selected.timestamp) + 1000).toISOString(), text: 'The selection has been withdrawn.' });
    o.transcript.assistantMessages.push({ ...selected, timestamp: new Date(Date.parse(selected.timestamp) + 2000).toISOString() });
    expect(check(o)).toBe(true);
  }
});
