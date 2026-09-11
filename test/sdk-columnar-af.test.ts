import { expect, test } from 'bun:test';
import captured from './fixtures/sdk-columnar-af.json';
import { hasStaleFillRaceFinding } from './helpers/ceo-section-loading-fixture';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

const evidence = () => captured.retryFinding + '\n\n' + captured.retrySchedule;
function replace(text: string, before: string, after: string) {
  expect(text).toContain(before);
  return text.replace(before, after);
}

test('AF exact retry columnar schedule establishes a post-write stale reader', () => {
  expect(hasStaleFillRaceFinding(captured.retryReport)).toBe(true);
  expect(hasStaleFillRaceFinding(captured.firstGuardedEvidence)).toBe(false);
});

test('AF columnar evidence binds named actors, keys and distinct versions independently of their spelling', () => {
  expect(hasStaleFillRaceFinding(evidence())).toBe(true);
  const varied = evidence().replace(/\bR1\b/g, 'R4').replace(/\bR2\b/g, 'R8').replace(/\bW\b/g, 'W3')
    .replace(/\bK\b/g, 'profileKey').replace(/\bv1\b/g, 'oldVersion').replace(/\bv2\b/g, 'newVersion')
    .replace(/->/g, '→');
  expect(hasStaleFillRaceFinding(varied)).toBe(true);
  expect(hasStaleFillRaceFinding(evidence().replace(/\bv2\b/g, 'v1'))).toBe(false);
});

test('AF every ordered operation and version witness is required', () => {
  for (const [before, after] of [
    ['get(K) -> undefined', 'get(K) -> v1'],
    ['await repository.read -> v1', 'await repository.read -> v2'],
    ['await write commits v2', 'await write fails'],
    ['delete(K) (no entry)', 'keep(K)'],
    ['| returns                   |', '| still pending             |'],
    ['resume: set(K, v1); return v1', 'resume: set(K, v2); return v2'],
    ['get(K) -> v1; return v1', 'get(K) -> v2; return v2'],
    ['v1 STALE  | v2', 'v1 STALE  | v1'],
    ['6 | resume:', '8 | resume:'],
  ]) expect(hasStaleFillRaceFinding(replace(evidence(), before!, after!))).toBe(false);
  for (let event = 1; event <= 7; event++) {
    expect(hasStaleFillRaceFinding(evidence().split('\n').filter(line => !line.trim().startsWith(`${event} |`)).join('\n'))).toBe(false);
  }
});

test('AF a different key, reader, write or column cannot lend ownership', () => {
  for (const [before, after] of [
    ['cache[K]  | DB[K]', 'cache[K]  | DB[J]'],
    ['delete(K) (no entry)', 'delete(J) (no entry)'],
    ['set(K, v1)', 'set(J, v1)'],
    ['get(K) -> v1; return v1', 'get(J) -> v1; return v1'],
    ['R2 read (begins after W)', 'R1 read (begins after W)'],
    ['R2 read (begins after W)', 'R2 read (begins after W2)'],
    ['R2 began after W completed (t5)', 'R1 began after W completed (t5)'],
    ['R2 began after W completed (t5)', 'R2 began before W completed (t5)'],
    ['R2 began after W completed (t5)', 'R2 began after W completed (t6)'],
    ['observes v1 for up to 30 s.', 'observes v2 for up to 30 s.'],
  ]) expect(hasStaleFillRaceFinding(replace(evidence(), before!, after!))).toBe(false);
});

test('AF current declarative execution cannot borrow a conditional, negated or quoted schedule', () => {
  for (const [before, after] of [
    ['await write commits v2', 'write might commit v2'],
    ['resume: set(K, v1); return v1', 'resume: no set(K, v1); return v1'],
    ['VIOLATION t7:', 'If VIOLATION t7:'],
    ['VIOLATION t7:', 'Quoted VIOLATION t7:'],
    ['observes v1 for up to 30 s.', 'observes v1 for up to 30 s.?'],
  ]) expect(hasStaleFillRaceFinding(replace(evidence(), before!, after!))).toBe(false);
});

test('AF the same named finding and a real top-level fence own the schedule', () => {
  const text = evidence();
  for (const value of [
    captured.retrySchedule,
    text.replace('(F1 evidence)', '(F2 evidence)'),
    text.replace('Schedule S1 below', 'Schedule S2 below'),
    captured.retryFinding + '\n' + text,
    text.split('\n').map(line => '> ' + line).join('\n'),
    '````text\n' + text + '\n````',
    text.replace('```\n t |', '```javascript\n t |'),
    text.slice(0, text.lastIndexOf('```')),
    'Example:\n\n' + text,
    captured.retryFinding + '\n\nTemplate:\n' + captured.retrySchedule,
  ]) expect(hasStaleFillRaceFinding(value)).toBe(false);
});

test('AF an original-caller allowance cannot excuse a stale cache or later caller', () => {
  const allowed = 'Allowed by contract: R1 itself returns v1 (read in progress when write committed).';
  for (const value of [
    replace(evidence(), allowed, 'Allowed by contract: R2 itself returns v1 (read in progress when write committed).'),
    replace(evidence(), allowed, 'The stale-fill behavior is accepted.'),
    replace(evidence(), allowed, 'There is no stale-fill race.'),
    replace(evidence(), allowed, 'The trace is impossible.'),
    evidence() + '\n\nThis is not a violation. No guard is required.',
  ]) expect(hasStaleFillRaceFinding(value)).toBe(false);
});

test('AF columnar regression inputs select only their SDK workflow owner', () => {
  for (const file of ['test/sdk-columnar-af.test.ts', 'test/fixtures/sdk-columnar-af.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(file)).map(([name]) => name))
      .toEqual(['plan-ceo-section-loading']);
  }
});

test('AF every same-row assessment and an unproven source frame remain authoritative', () => {
  for (const [cell, value] of [
    [6, 'Rejected: there is no stale-fill race.'],
    [5, 'The stale-fill behavior is accepted. No guard is required.'],
    [6, 'Rejected: “There is no stale-fill race.”'],
    [6, 'Rejected: "The stale-fill behavior is accepted. No guard is required."'],
  ] as const) {
    const cells = captured.retryFinding.split('|'); cells[cell] = value;
    expect(hasStaleFillRaceFinding(cells.join('|') + '\n\n' + captured.retrySchedule)).toBe(false);
  }
  expect(hasStaleFillRaceFinding('An unproven hypothesis:\n\n' + evidence())).toBe(false);
});
