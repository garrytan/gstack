import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NEUTRAL_POSTURE_RE } from './helpers/prosons-posture';

// C3: both plan-review-prosons-neutral-neg reds (37179171083 t3,
// 37193478719 t3) recommended A and closed with "a coverage call, not a taste
// call"; the old /taste call/i read that negation as the neutral dodge.
const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'prosons-neutral-neg-captures.json'), 'utf8')) as {
  captures: Array<{ census: string; captured: string }>;
};

describe('prosons neutral-posture detector (C3)', () => {
  test('the two census false reds replay as not neutral', () => {
    expect(fixture.captures.map((c) => c.census).sort()).toEqual(['37179171083', '37193478719']);
    for (const c of fixture.captures) {
      expect(c.captured).toContain('not a taste call');
      expect(c.captured).not.toMatch(NEUTRAL_POSTURE_RE);
    }
  });

  test('negated mentions are not the dodge', () => {
    for (const line of ['This is NOT a taste call.', 'a coverage call, not a taste call', 'This is not taste call territory.']) {
      expect(line).not.toMatch(NEUTRAL_POSTURE_RE);
    }
  });

  test('the neutral dodge is still caught', () => {
    for (const line of ['This is a taste call; either is fine.', 'Taste call: pick what you prefer.', 'No preference — taste call.', "Honestly it's a taste call."]) {
      expect(line).toMatch(NEUTRAL_POSTURE_RE);
    }
  });
});
