import { expect, test } from 'bun:test';
import captured from './fixtures/sdk-order-b-ag.json';
import { hasStaleFillRaceFinding } from './helpers/ceo-section-loading-fixture';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const compactFirst = () => `${captured.first.finding}\n\n${captured.first.heading}\n\`\`\`\n${captured.first.trace}\n\`\`\``;
const compactRetry = () => `${captured.retry.finding}\n\n${captured.retry.heading}\n\`\`\`\n${captured.retry.trace}\n\`\`\``;

test('actual first completed report proves a later stale cache hit', () => {
  expect(hasStaleFillRaceFinding(captured.first.report)).toBe(true);
});

test('isolated Order B proves a later stale cache hit', () => {
  expect(hasStaleFillRaceFinding(compactFirst())).toBe(true);
});

test('actual retry and its explicit original-sketch override establish the unsafe execution', () => {
  expect(hasStaleFillRaceFinding(captured.retry.report)).toBe(true);
  expect(hasStaleFillRaceFinding(compactRetry())).toBe(true);
});

function replaceOnce(text: string, before: string, after: string): string {
  expect(text.includes(before)).toBe(true);
  return text.replace(before, after);
}

test('original-caller return or flight joining alone cannot supply the later cache reader', () => {
  for (const [before, after] of [
    ['  Order B: R2 begins after t5 -> cache hit v1  VIOLATION (until TTL or next write)\n', ''],
    ['Order B: R2 begins after t5', 'Order B: R1 begins after t5'],
    ['Order B: R2 begins after t5', 'Order B: R2 begins before t3'],
    ['Order B: R2 begins after t5', 'Order B: R2 begins after t2'],
    ['cache hit v1  VIOLATION', 'fresh DB read v2'],
    ['cache hit v1  VIOLATION', 'cache hit v2  SAFE'],
  ]) expect(hasStaleFillRaceFinding(replaceOnce(compactFirst(), before!, after!))).toBe(false);
});

test('all read, commit, invalidation and late-fill operations retain shared key and version ownership', () => {
  for (const [before, after] of [
    ['R1 readProfile(k)', 'R1 readProfile(other)'],
    ['W writeProfile(k, v2)', 'W writeProfile(other, v2)'],
    ['R2 readProfile(k)', 'R2 readProfile(other)'],
    ['cache[k]', 'cache[other]'],
    ['inflight[k]', 'inflight[other]'],
    ['set(k, v1)', 'set(other, v1)'],
    ['set(k, v1)', 'set(k, v2)'],
    ['read resolves v1; set(k, v1)', 'read resolves v2; set(k, v1)'],
    ['miss; flight f1; await read', 'cache hit v1; return'],
    ['await write ... commit v2', 'await write ... abort'],
    ['delete(k) no-op; return', 'delete(other) no-op; return'],
    ['delete(k) no-op; return', 'write still pending'],
    ['read resolves v1; set(k, v1)', 'read resolves v1; return to R1 only'],
    ['v1  BAD  | -', 'v2  SAFE | -'],
  ]) expect(hasStaleFillRaceFinding(replaceOnce(compactFirst(), before!, after!))).toBe(false);
});

test('quoted, conditional and impossible schedules are not actual asserted execution', () => {
  const report = compactFirst();
  for (const changed of [
    report.split('\n').map(line => `> ${line}`).join('\n'),
    `\`\`\`markdown\n${report}\n\`\`\``,
    `An unproven hypothesis:\n${report}`,
    replaceOnce(report, 'Schedule below shows', 'An unproven hypothesis: Schedule below shows'),
    replaceOnce(report, 'Order B: R2 begins', 'Order B: If R2 begins'),
    replaceOnce(report, 'Order B: R2 begins', 'Order B: R2 never begins'),
    replaceOnce(report, 'Order B: R2 begins after t5 -> cache hit v1  VIOLATION', 'Order B: R2 begins after t5 -> cache hit v1  VIOLATION?'),
    report + '\nThis trace is impossible.',
    report + '\n\nThe trace is impossible.',
  ]) expect(hasStaleFillRaceFinding(changed)).toBe(false);
});

test('one finding owns the original trace and every same-row assessment', () => {
  const report = compactFirst();
  for (const changed of [
    replaceOnce(report, 'Async schedule (F1)', 'Async schedule (F9)'),
    replaceOnce(report, '| F1 |', '| F9 |'),
    replaceOnce(report, 'Fills overlapping a write are not cached (bounded hit-rate cost, visible in metric)', 'There is no stale-fill race.'),
    replaceOnce(report, 'Fills overlapping a write are not cached (bounded hit-rate cost, visible in metric)', 'Rejected: "There is no stale-fill race."'),
    replaceOnce(report, 'D3: single-flight `invalidate(key)` before and after the write; invalidated fills never `set`; `fill_discarded` metric', 'The stale-fill behavior is accepted. No guard is required.'),
  ]) expect(hasStaleFillRaceFinding(changed)).toBe(false);
});

test('retry amendment alone and unasserted original-sketch annotations cannot prove a stale fill', () => {
  const original = 'Original sketch: step 6 fills v1 after step 4 → R2 hits v1 → VIOLATION (S1).';
  for (const replacement of [
    '',
    `"${original}"`,
    `> ${original}`,
    `If ${original}`,
    `Example: ${original}`,
    original.replace('fills v1', 'does not fill v1'),
    original.replace('VIOLATION (S1).', 'VIOLATION (S1)?'),
    original.replace('fills v1', 'fills v2'),
    original.replace('after step 4', 'before step 4'),
    original.replace('after step 4', 'after step 3'),
    original.replace('step 6 fills', 'step 7 fills'),
    original.replace('R2 hits v1', 'R1 receives v1'),
    original.replace('R2 hits v1', 'R2 hits v2'),
    original.replace('(S1)', '(S9)'),
  ]) expect(hasStaleFillRaceFinding(replaceOnce(compactRetry(), original, replacement))).toBe(false);
  expect(hasStaleFillRaceFinding(compactRetry() + '\n\nThe trace is impossible.')).toBe(false);
});

test('retry original override is bound to the same actors, cancelled token and completed write', () => {
  for (const [before, after] of [
    ['R1 read (began before commit)', 'R1 read (began after commit)'],
    ['R2 read (began after W resolves)', 'R2 read (began before W resolves)'],
    ['R2 read (began after W resolves)', 'R2 read (other key, began after W resolves)'],
    ['invalidate: cancel t1, detach, delete', 'invalidate: cancel other, detach, delete'],
    ['writeProfile resolves (write "complete")', 'writeProfile still pending'],
    ['await repo.write → v2 committed', 'await repo.write → aborted'],
    ['read resolves v1; t1✗ → no fill', 'read resolves v2; t1✗ → no fill'],
    ['read resolves v1; t1✗ → no fill', 'read resolves v1; other✗ → no fill'],
    ['S1: R1 misses, W commits and deletes, R1 fills stale v1, R2 hits v1.', 'S1: R1 misses, W commits and deletes, R1 fills stale v1, R1 receives v1.'],
    ['### 4. Async schedule (F1)', '### 4. Async schedule (F9)'],
  ]) expect(hasStaleFillRaceFinding(replaceOnce(compactRetry(), before!, after!))).toBe(false);
});

test('consistent actor, key, version and pending-identity renaming preserves each causal proof', () => {
  const names: Record<string, string> = {
    R1: 'R7', R2: 'R8', W: 'W9', k: 'profile_key', v1: 'oldValue', v2: 'newValue',
    f1: 'flight_old', f2: 'flight_new', t1: 'token_old', t2: 'token_new',
  };
  for (const report of [compactFirst(), compactRetry()]) {
    const renamed = report.replace(/\b(?:R1|R2|W|k|v1|v2|f1|f2|t1|t2)\b/g, token => names[token]!);
    expect(hasStaleFillRaceFinding(renamed)).toBe(true);
  }
});

test('current findings cannot borrow assertion authority from a hypothetical preceding frame', () => {
  for (const report of [compactFirst(), compactRetry()]) {
    for (const prefix of ['An unproven hypothesis.', 'Historical example only.', 'The following is a hypothetical example.']) {
      expect(hasStaleFillRaceFinding(`${prefix}\n\n${report}`)).toBe(false);
    }
    expect(hasStaleFillRaceFinding(`## Prior example\nA completed historical illustration.\n\n## Current findings\n${report}`)).toBe(true);
  }
});

test('new replay inputs select exactly the existing SDK section-loading owner', () => {
  for (const file of ['test/sdk-order-b-ag.test.ts', 'test/fixtures/sdk-order-b-ag.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, files]) => files.includes(file)).map(([owner]) => owner))
      .toEqual(['plan-ceo-section-loading']);
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-ceo-section-loading']);
  }
});
