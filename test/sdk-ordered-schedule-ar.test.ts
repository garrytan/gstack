import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import { hasStaleFillRaceFinding } from './helpers/ceo-section-loading-fixture';

const report = fs.readFileSync(new URL('./fixtures/sdk-ordered-schedule-ar.md', import.meta.url), 'utf8');
const row = report.split('\n').find(line => line.startsWith('| F1 |'))!;
const schedule = 'Schedule: read misses, write commits and deletes (no-op), read resolves and stores the pre-write snapshot. A later read hits the stale value';

test('an actual review supplies the stale-fill ordering without a concurrency keyword', () => {
  expect(row).toContain(schedule);
  expect(row).not.toMatch(/\b(?:race|concurrent|in-flight|pending)\b/i);
  expect(hasStaleFillRaceFinding(row)).toBe(true);
  expect(hasStaleFillRaceFinding(report)).toBe(true);
  expect(hasStaleFillRaceFinding(row.replace('Original sketch', 'Original wrapper'))).toBe(true);
  expect(hasStaleFillRaceFinding(row.replace('pre-write snapshot', 'old value'))).toBe(true);
  expect(hasStaleFillRaceFinding(row.replace('A later read', 'The subsequent read'))).toBe(true);
  expect(hasStaleFillRaceFinding(row.replaceAll('"', ''))).toBe(true);
});

test('every operation and the stale value observed by a later read are required', () => {
  for (const [from, to] of [
    ['read misses, ', ''],
    ['write commits and deletes (no-op), ', ''],
    ['write commits and deletes', 'write rolls back and deletes'],
    ['write commits and deletes', 'write commits without deleting'],
    ['read resolves and stores the pre-write snapshot', 'read resolves and skips the fill'],
    ['read resolves and stores the pre-write snapshot', 'read resolves and stores the fresh snapshot'],
    ['A later read hits the stale value', 'The original read returns its own pre-write snapshot'],
    ['A later read hits the stale value', 'A later read hits the fresh value'],
    ['write commits and deletes (no-op), read resolves and stores the pre-write snapshot', 'read resolves and stores the pre-write snapshot, write commits and deletes (no-op)'],
    ['write commits and deletes (no-op), read resolves', 'write commits and deletes (no-op) | read resolves'],
    ['read resolves and stores', 'another reader resolves and stores'],
    ['write commits and deletes (no-op)', 'write commits and deletes another key'],
  ]) {
    expect(row).toContain(from);
    expect(hasStaleFillRaceFinding(row.replace(from, to))).toBe(false);
  }
});

test('copied, conditional, quoted and hypothetical schedules cannot supply current evidence', () => {
  for (const text of [
    '> ' + row,
    '```text\n' + row + '\n```',
    '## Historical example\n' + row,
    'Source:\n' + row,
    'Earlier review:\n' + row,
    row.replace('Original sketch fills', 'Original sketch source excerpt only: fills'),
    row.replace('Original sketch fills', 'Original sketch from an earlier review fills'),
    row.replace('Schedule:', '\nFinding F2. Schedule:'),
    '## Source notes\nThe following material is copied from a template.\n' + row,
    row.replace('Original sketch', 'Quoted original sketch'),
    row.replace('Schedule: read misses', 'Schedule: if a read misses'),
    row.replace('Schedule: read misses', 'Hypothetical schedule: read misses'),
    row.replace('read resolves and stores', 'read never resolves and stores'),
    row.replace(schedule, '"' + schedule + '"'),
    row.replace(schedule, '`' + schedule + '`'),
    row.replace('read resolves and stores the pre-write snapshot', '`read resolves and stores the pre-write snapshot`'),
    row.replace('Flag flip mid-read has the same shape.', 'This sequence is impossible.'),
  ]) expect(hasStaleFillRaceFinding(text)).toBe(false);
});

test('a current dismissal stays a dismissal even when the original schedule is complete', () => {
  for (const suffix of [
    'F1 is withdrawn.',
    'F1 is "withdrawn".',
    'F1 is “withdrawn”.',
    'F1 is rejected.',
    'This finding is dismissed.',
    'This is not a bug; no fix is needed.',
    'The stale-fill behavior is permitted.',
  ]) expect(hasStaleFillRaceFinding(row + '\n\n' + suffix)).toBe(false);
  expect(hasStaleFillRaceFinding(row + '\n\nF2 is rejected.')).toBe(true);
  expect(hasStaleFillRaceFinding('## Historical example\nOld material.\n\n## Current findings\n' + row)).toBe(true);
});

test('new regression files select the existing SDK workflow owner', () => {
  for (const file of ['test/sdk-ordered-schedule-ar.test.ts', 'test/fixtures/sdk-ordered-schedule-ar.md']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['plan-ceo-section-loading']);
  }
});
