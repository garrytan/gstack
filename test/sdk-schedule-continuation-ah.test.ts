import { expect, test } from 'bun:test';
import fixture from './fixtures/sdk-schedule-continuation-ah.json';
import { hasStaleFillRaceFinding } from './helpers/ceo-section-loading-fixture';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import { selectTests } from './helpers/touchfiles';

const frame = fixture.compact;
function replace(from: string, to: string, input = frame): string {
  expect(input.includes(from)).toBe(true);
  return input.replace(from, to);
}
const originalRows = '  S2*   | await read ...             | write commits, delete(noop) |                     | -          |\n'
  + '        | resolves V0 → set V0       |                             | hit → V0            | V0 (30 s)  | VIOLATION\n';

test('retains both exact public report forms as affirmative original-race findings', () => {
  expect(hasStaleFillRaceFinding(fixture.report)).toBe(true);
  expect(hasStaleFillRaceFinding(frame)).toBe(true);
  expect(fixture.report.includes(frame.trim())).toBe(true);
});

test('binds consistently renamed actors, shared key, versions and finding/schedule IDs', () => {
  const renamed = frame.replace(/\bR1\b/g, 'R7').replace(/\bR2\b/g, 'R8').replace(/\bW\b/g, 'W9')
    .replace(/\bV0\b/g, 'oldValue').replace(/\bV1\b/g, 'freshValue')
    .replace(/\bkey\b/g, 'profile_key').replace(/\bF1\b/g, 'F9').replace(/\bS2\b/g, 'S9');
  expect(hasStaleFillRaceFinding(renamed)).toBe(true);
  expect(hasStaleFillRaceFinding(frame.replace(/→/g, '->'))).toBe(true);
  const unrelated = '## Historical example\nAn unrelated old example.\n\n## Current findings\n\n';
  expect(hasStaleFillRaceFinding(unrelated + frame)).toBe(true);
});

test('amendments, permitted earlier readers and missing continuation do not supply the original race', () => {
  for (const changed of [
    replace(originalRows, ''),
    replace('S2*   | await read', 'S2 A1 | await read'),
    replace(originalRows, '  S2* | begins before W, joins | delete + forget | — | — | OK: R1 began before W completed (permitted clause)\n'),
    replace('resolves V0 → set V0', 'resolves V0, slot gone→drop'),
    replace('hit → V0', 'miss→read V1→set'),
    replace('hit → V0', ''),
    replace('VIOLATION\n  S2 A1', 'OK (permitted earlier return)\n  S2 A1'),
    replace('VIOLATION\n  S2 A1', 'VIOLATION\n        | already guarded | | | | OK\n  S2 A1'),
  ]) expect(hasStaleFillRaceFinding(changed)).toBe(false);
});

test('requires the original schedule citation, legend and explicit post-completion boundary', () => {
  for (const changed of [
    replace('Schedule S2 makes', 'Schedule S9 makes'),
    replace('`*` = original sketch.', '`*` = amended sketch.'),
    replace('`*` = original sketch.', ''),
    replace('`*` = original sketch.', 'Hypothetically, `*` = original sketch.'),
    replace('CRITICAL GAP | 1, 2, 4, 5, 6', 'CRITICAL GAP | 1, 2, 5, 6'),
    replace('Violates retained invariant.', 'No defect in the retained invariant.'),
    replace('R2 (begins after W)', 'R2 (begins before W)'),
    replace('after `writeProfile` resolves', 'before `writeProfile` resolves'),
    replace('after `writeProfile` resolves', 'after `writeProfile` begins'),
    replace('after `writeProfile` resolves', 'after `readProfile` resolves'),
  ]) expect(hasStaleFillRaceFinding(changed)).toBe(false);
});

test('rejects actor, key, value, invalidation and ordering mismatches', () => {
  for (const changed of [
    replace('R2 (begins after W)', 'R1 (begins after W)'),
    replace('R2 (begins after W)', 'R2 (begins after W9)'),
    replace('`inflight[key]`', '`inflight[other_key]`'),
    replace('| cache[key] | Result', '| cache[other_key] | Result'),
    replace('W (commits V1)', 'W (commits V0)'),
    replace('resolves V0 → set V0', 'resolves V1 → set V0'),
    replace('resolves V0 → set V0', 'resolves V0 → set V1'),
    replace('hit → V0', 'hit → V1'),
    replace('write commits, delete(noop)', 'write begins, delete(noop)'),
    replace('write commits, delete(noop)', 'write commits'),
    replace('await read ...', 'await write ...'),
    replace(originalRows, originalRows.split('\n').slice(0, 2).reverse().join('\n') + '\n'),
    replace('V0 (30 s)  | VIOLATION', 'V1 (30 s)  | VIOLATION'),
    replace('see V0 for 30 s;', 'see V1 for 30 s;'),
  ]) expect(hasStaleFillRaceFinding(changed)).toBe(false);
});

test('quotes, source introductions and withdrawn findings remain negative', () => {
  for (const prefix of ['An unproven hypothesis.', 'Historical example only.', 'The following is a hypothetical example.']) {
    expect(hasStaleFillRaceFinding(prefix + '\n\n' + frame)).toBe(false);
    expect(hasStaleFillRaceFinding(replace('### Async Ordering Record', prefix + '\n\n### Async Ordering Record'))).toBe(false);
    expect(hasStaleFillRaceFinding(replace('### Findings Registry\n', '### Findings Registry\n\n' + prefix))).toBe(false);
  }
  expect(hasStaleFillRaceFinding(frame.split('\n').map(line => '> ' + line).join('\n'))).toBe(false);
  expect(hasStaleFillRaceFinding('````text\n' + frame + '\n````')).toBe(false);
  expect(hasStaleFillRaceFinding(replace('```\n  Sched', '```javascript\n  Sched'))).toBe(false);
  for (const dismissal of [
    'The original trace is impossible.', 'This schedule is not a bug.',
    'The original race is permitted.', 'The stale fill is accepted.',
    'No coordination is required.',
  ]) {
    expect(hasStaleFillRaceFinding(frame + '\n' + dismissal)).toBe(false);
    expect(hasStaleFillRaceFinding(replace('Violates retained invariant.', 'Violates retained invariant. ' + dismissal))).toBe(false);
  }
});


test('completed prior decision section is independent; spoofed or withdrawn framing is not', () => {
  const close = '### Decision Registry (all auto-resolved to recommended option)\n\n| D1 | A | B |\n\nLake Score: 7/7 recommendations chose the complete option.\n\n';
  expect(hasStaleFillRaceFinding(close + frame)).toBe(true);
  expect(hasStaleFillRaceFinding(close.replace('### Decision Registry (all auto-resolved to recommended option)', '### Historical example') + frame)).toBe(false);
  expect(hasStaleFillRaceFinding(close.replace('Lake Score: 7/7 recommendations chose the complete option.', 'An unproven hypothesis.') + frame)).toBe(false);
  const row = frame.split('\n').find(line => line.startsWith('| F1 |'))!;
  expect(hasStaleFillRaceFinding(replace(row, row + '\n' + row))).toBe(false);
});

test('only the existing SDK paid owner selects the added fixture and controls', () => {
  for (const file of ['test/sdk-schedule-continuation-ah.test.ts', 'test/fixtures/sdk-schedule-continuation-ah.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, files]) => files.includes(file)).map(([name]) => name)).toEqual(['plan-ceo-section-loading']);
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-ceo-section-loading']);
  }
});


test('same finding or schedule tail withdrawals remain authoritative', () => {
  for (const tail of ['S2 is impossible.', 'F1 is rejected. The original trace is impossible.', 'F1 is rejected.', 'S2 is withdrawn.']) {
    expect(hasStaleFillRaceFinding(frame + '\n' + tail)).toBe(false);
  }
  expect(hasStaleFillRaceFinding(frame + '\nF2 is rejected. The original trace is impossible.')).toBe(true);
  expect(hasStaleFillRaceFinding(frame + '\nS3 is impossible.')).toBe(true);
});
