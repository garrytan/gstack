import {expect, test} from 'bun:test';
import fixture from './fixtures/sdk-ordering-ae.json';
import {hasStaleFillRaceFinding as found} from './helpers/ceo-section-loading-fixture';
import {E2E_TOUCHFILES, selectTests} from './helpers/touchfiles';

const trace = fixture.f1.split('|')[4]!.trim();
function withTrace(value: string): string {
  const cells = fixture.f1.split('|');
  cells[4] = ` ${value} `;
  return cells.join('|');
}

test('actual completed F1 report row supplies ordered stale-fill evidence without a race keyword', () => {
  expect(found(fixture.f1)).toBe(true);
  expect(fixture.provenance.historicalOutcome).toContain('timeout480032ms');
  expect(trace).not.toMatch(/\b(?:race|in-flight|concurrent|pending)\b/i);
  expect(found(`F1 — P1: ${trace}`)).toBe(true);
});

test('ordering evidence requires miss, committed invalidation, stale refill and later stale readers', () => {
  for (const value of [
    'Reader fills the pre-commit snapshot; write commits and deletes; read misses; every later reader sees stale data.',
    'Read misses; reader then fills the pre-commit snapshot; write commits and deletes; every later reader sees stale data.',
    'Write commits and deletes; read misses; reader then fills the pre-commit snapshot; every later reader sees stale data.',
    'Read misses; reader then fills the pre-commit snapshot; every later reader sees stale data.',
    'Read misses, write commits; reader then fills the pre-commit snapshot; every later reader sees stale data.',
    'Read misses, write commits and deletes; every later reader sees stale data.',
    'Read misses, write commits and deletes; reader then fills the post-commit snapshot; every later reader sees fresh data.',
    'Read misses, write commits and deletes; the original reader returns its pre-commit snapshot to its own caller; every later reader sees fresh data.',
  ]) expect(found(withTrace(value))).toBe(false);
});

test('explicit other cache, key or reader references cannot borrow the anonymous same-read trace', () => {
  for (const value of [
    'Read misses cache A, write commits and deletes cache B, reader then fills cache A with the pre-commit snapshot; every later reader sees stale data in cache A.',
    'Read misses key u1, write commits and deletes key u2, reader then fills key u1 with the pre-commit snapshot; every later reader sees stale data for key u1.',
    'Read R1 misses, write commits and deletes, reader R2 then fills the pre-commit snapshot; every later reader sees stale data.',
  ]) expect(found(withTrace(value))).toBe(false);
});

test('hypothetical, negated and unestablished traces do not assert a current defect', () => {
  for (const value of [
    `If ${trace[0]!.toLowerCase()}${trace.slice(1)}`,
    `A hypothetical example: ${trace}`,
    `An unproven hypothesis: ${trace}`,
    `The following trace is impossible: ${trace}`,
    `An unrelated illustration: ${trace}`,
    `It is unclear whether this happens: ${trace}`,
    `This trace did not occur: ${trace}`,
    trace.replace('Read misses', 'Read may miss'),
    trace.replace('write commits and deletes', 'write does not commit or delete'),
    trace.replace('reader then fills', 'reader never fills'),
    trace.replace('every later reader sees stale data', 'every later reader never sees stale data'),
    'Read misses, write commits and deletes, reader then fills the pre-commit snapshot; every later reader sees stale data?',
    'Read misses, write commits and deletes, reader then fills the pre-commit snapshot; every later reader sees stale data. This scenario is impossible.',
  ]) expect(found(withTrace(value))).toBe(false);
});

test('copied source and independent rows or cells cannot supply missing ordered operations', () => {
  for (const value of [`> ${fixture.f1}`, `    ${fixture.f1}`, `\t${fixture.f1}`,
    `\`\`\`text\n${fixture.f1}\n\`\`\``, `~~~text\n${fixture.f1}\n~~~`]) expect(found(value)).toBe(false);
  const first = withTrace('Read misses; write commits and deletes.');
  const last = withTrace('Reader then fills the pre-commit snapshot; every later reader sees stale data.').replace('| F1 |', '| F2 |');
  expect(found(first + '\n' + last)).toBe(false);
  const cells = fixture.f1.split('|');
  cells[4] = ' Read misses; write commits and deletes. ';
  cells[6] = ' Reader then fills the pre-commit snapshot; every later reader sees stale data. ';
  expect(found(cells.join('|'))).toBe(false);
  expect(found(first + '\n\n> ' + trace)).toBe(false);
  expect(found(withTrace(`"${trace}" is a copied source example, not an observed defect.`))).toBe(false);
});

test('a real trace still rejects dismissal or acceptance of the later stale consequence', () => {
  for (const suffix of [' No fix is required.', ' This stale-read behavior is accepted.', ' There is no stale-fill race.',
    ' Later readers may return stale data and that is permitted.']) expect(found(withTrace(trace + suffix))).toBe(false);
  expect(found(withTrace(trace + ' Original reader returns v1 to its own caller (allowed: it began before commit).'))).toBe(true);
  expect(found(withTrace(trace + ' Later reader returns v1 to its own caller (allowed: it began after commit).'))).toBe(false);
});

test('new ordered-report evidence selects only the existing SDK section-loading case', () => {
  for (const file of ['test/sdk-ordering-ae.test.ts', 'test/fixtures/sdk-ordering-ae.json'])
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-ceo-section-loading']);
});
