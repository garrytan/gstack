import { test, expect } from 'bun:test';
import { hasStaleFillRaceFinding } from './helpers/ceo-section-loading-fixture';
import captured from './fixtures/sdk-compact-sequence-aj.json';

const sequence = 'fill starts, write commits, write deletes (no-op), fill sets pre-commit v1, later read hits v1.';
const report = captured.finding;

test('recognizes the captured current original-plan sequence without borrowing the amended diagram', () => {
  expect(hasStaleFillRaceFinding(report)).toBe(true);
  expect(hasStaleFillRaceFinding(report.replaceAll('v1', 'snapshot_A'))).toBe(true);
  expect(hasStaleFillRaceFinding(report.replace('Schedule Diagram 2b: ', ''))).toBe(true);
});

test('requires the ordered original fill, commit, invalidation, old cache value and same later value', () => {
  for (const changed of [
    sequence.replace('fill starts, ', ''),
    sequence.replace('write commits, ', ''),
    sequence.replace('write deletes (no-op), ', ''),
    sequence.replace('fill sets pre-commit v1, ', ''),
    sequence.replace(', later read hits v1', ''),
    sequence.replace('later read hits v1', 'later read hits v2'),
    sequence.replace('pre-commit v1', 'post-commit v1'),
    sequence.replace('fill starts, write commits', 'write commits, fill starts'),
    sequence.replace('write deletes (no-op), fill sets pre-commit v1', 'fill sets pre-commit v1, write deletes (no-op)'),
    sequence.replace('later read hits', 'another key later read hits'),
  ]) expect(hasStaleFillRaceFinding(report.replace(sequence, changed))).toBe(false);
  expect(hasStaleFillRaceFinding(report.replace('Original plan', 'Amended plan'))).toBe(false);
  expect(hasStaleFillRaceFinding(report.replace(sequence, '"' + sequence + '"'))).toBe(false);
});

test('preserves accepted-staleness and explicit dismissal boundaries', () => {
  for (const suffix of [
    'This is not a gap; no guard is needed.',
    'This staleness is the accepted consistency model.',
    'This finding is withdrawn.',
    'F1 is rejected.',
  ]) expect(hasStaleFillRaceFinding(report.trimEnd() + '\n\n' + suffix)).toBe(false);
  expect(hasStaleFillRaceFinding(report.replace('fill starts', 'fill never starts'))).toBe(false);
});

test('source, quotes and hypothetical framing cannot supply current coverage', () => {
  for (const text of [
    '```text\n' + report + '```',
    report.split('\n').map(line => '> ' + line).join('\n'),
    report.split('\n').map(line => '    ' + line).join('\n'),
    '## Historical example\n\n' + report,
    '## Quoted source\n\n' + report,
    'An unproven hypothesis.\n\n' + report,
    'The following is a hypothetical example.\n\n' + report,
  ]) expect(hasStaleFillRaceFinding(text)).toBe(false);
  expect(hasStaleFillRaceFinding('## Historical example\nOld material.\n\n## Current review\n' + report)).toBe(true);
  expect(hasStaleFillRaceFinding(report + '\n## Unrelated issue\nF2 is rejected.')).toBe(true);
});

test('source framing remains attached to descendant registry headings', () => {
  for (const prefix of [
    '## Copied material\nThe following subsections reproduce source examples, not current findings.\n\n',
    '## Input material\nThe following sections quote historical examples.\n\n',
    'The following subsections reproduce source examples, not current findings.\n\n',
  ]) expect(hasStaleFillRaceFinding(prefix + report)).toBe(false);
  expect(hasStaleFillRaceFinding('## Source notes\nThe following material quotes historical examples.\n\n## Current findings\n' + report)).toBe(true);
});

test('same finding assessments retain identity across sections and unrelated findings', () => {
  for (const suffix of [
    '## F1 assessment\nThis finding is withdrawn.',
    '## Final assessment\nF1 is rejected.',
    '## F2\nUnrelated issue accepted.\n\n## Final assessment\nF1 is dismissed.',
  ]) expect(hasStaleFillRaceFinding(report + '\n\n' + suffix)).toBe(false);
  for (const suffix of [
    '## F2 assessment\nThis finding is withdrawn.',
    '## Final assessment\nF2 is rejected.',
    '## Quoted source\nF1 is rejected.',
    '## Source notes\nThe following subsections quote historical examples.\n\n### F1 assessment\nThis finding is withdrawn.',
  ]) expect(hasStaleFillRaceFinding(report + '\n\n' + suffix)).toBe(true);
});

import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
test('compact evidence selects exactly the existing section-loading workflow', () => {
  for (const file of ['test/sdk-compact-sequence-aj.test.ts', 'test/fixtures/sdk-compact-sequence-aj.json']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-ceo-section-loading']);
  }
});
