import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { hasStaleFillRaceFinding } from './helpers/ceo-section-loading-fixture';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const report = fs.readFileSync(new URL('./fixtures/sdk-reported-coordination-ar.md', import.meta.url), 'utf8');
const paragraph = report.split('\n\n').find(text => text.startsWith('## Proposed wrapper integration'))!.split('\n').slice(1).join('\n');
const matches = (text = paragraph) => hasStaleFillRaceFinding(text);

test('the actual retry independently reports the original coordination violation', () => {
  expect(paragraph).toContain('review found that this violates the read-after-write rule above (F1)');
  expect(paragraph).not.toMatch(/stale|in-flight|race|pending/);
  expect(matches()).toBe(true);
  expect(matches(report)).toBe(true);
  expect(matches(paragraph.replace('proposed no coordination', 'had no coordination'))).toBe(true);
  expect(matches(paragraph.replace('proposed no coordination', 'has no coordination'))).toBe(true);
  expect(matches(paragraph.replace('sketch', 'wrapper'))).toBe(true);
  expect(matches(paragraph.replace('rule above', 'contract'))).toBe(true);
  expect(matches(paragraph.replace(/ and omits[\s\S]*/, '.'))).toBe(true);
});

test('missing or hypothetical premise and conclusion cannot become findings', () => {
  for (const [from, to] of [
    ['proposed no coordination', 'proposed coordination'],
    ['proposed no coordination', 'may propose no coordination'],
    ['review found that this violates', 'review may find that this violates'],
    ['review found that this violates', 'review found that this does not violate'],
    ['review found that this violates', 'review hypothesized that this violates'],
    ['review found that this violates', 'review found that another wrapper violates'],
    ['read-after-write rule above', 'formatting rule'],
    ['(F1)', '(unknown)'],
    ['; the\nreview found', '. Another unrelated finding. The\nreview found'],
    ['; the\nreview found', '\n\nThe\nreview found'],
    ['; the\nreview found', ' | The\nreview found'],
  ]) {
    expect(paragraph).toContain(from);
    expect(matches(paragraph.replace(from, to))).toBe(false);
  }
});

test('source and quoted evidence cannot assert the current violation', () => {
  for (const text of [
    'Source:\n\n' + paragraph,
    'Hypothetical scenario. ' + paragraph,
    'Earlier review:\n\n' + paragraph,
    '## Historical example\n' + paragraph,
    '> ' + paragraph.replaceAll('\n', '\n> '),
    '```text\n' + paragraph + '\n```',
    '~~~text\n' + paragraph + '\n~~~',
    paragraph.replace('original sketch proposed no coordination between a cache fill and a write', '`original sketch proposed no coordination between a cache fill and a write`'),
    paragraph.replace('review found that this violates the read-after-write rule above (F1)', '"review found that this violates the read-after-write rule above (F1)"'),
  ]) expect(matches(text)).toBe(false);
});

test('the referenced finding owns its later assessment', () => {
  for (const tail of ['F1 is withdrawn.', 'F1 is "withdrawn".', 'F1 is rejected.', 'This finding is dismissed.', 'No coordination is required.', '| ID | Assessment |\n| F1 | Withdrawn: no coordination is required. |', '| F1 | Withdrawn |', '| F1 | "rejected" |']) {
    expect(matches(paragraph + '\n\n' + tail)).toBe(false);
  }
  expect(matches(paragraph + '\n\nF2 is withdrawn.')).toBe(true);
  expect(matches(paragraph + '\n\n| F2 | Withdrawn |')).toBe(true);
  expect(matches(paragraph + '\n\n## Historical assessment\n| F1 | Withdrawn |')).toBe(true);
  expect(matches('## Earlier material\nSource:\nOld source.\n\n## Current findings\n' + paragraph)).toBe(true);
});

test('the new regression selects its existing SDK workflow owner', () => {
  for (const file of ['test/sdk-reported-coordination-ar.test.ts', 'test/fixtures/sdk-reported-coordination-ar.md']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['plan-ceo-section-loading']);
  }
});
