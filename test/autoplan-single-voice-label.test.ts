/**
 * /autoplan single-voice consensus labeling (gate tier)
 *
 * When Codex is unavailable, every review phase degrades to a single Claude
 * voice. Before #1956 the Final Approval Gate still printed CONFIRMED for those
 * rows, which reads as "two independent reviewers agreed" when only one ran —
 * a silent quality regression. These static checks pin the generated skill so
 * the degradation stays visible: a CONFIRMED-1V label plus a top-of-gate banner.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const AUTOPLAN = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md'), 'utf-8');
const AUTOPLAN_TMPL = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md.tmpl'), 'utf-8');

describe('autoplan single-voice consensus labeling', () => {
  test('the consensus legend defines a distinct single-voice label', () => {
    expect(AUTOPLAN).toContain('CONFIRMED-1V');
    // It must be explicit that one voice is NOT a dual confirmation.
    expect(AUTOPLAN).toMatch(/NOT dual-confirmed/);
  });

  test('a missing voice is never silently rolled into CONFIRMED', () => {
    expect(AUTOPLAN).toMatch(/missing voice is N\/A, never CONFIRMED/);
  });

  test('the Final Approval Gate carries a single-voice banner', () => {
    expect(AUTOPLAN).toContain('SINGLE-VOICE MODE');
    // The banner must explain WHY the consensus columns are weaker.
    expect(AUTOPLAN).toMatch(/one independent reviewer, not two/);
  });

  test('the banner is gated on degradation, not always shown', () => {
    // Cognitive-load rule: skip when every phase ran dual voices.
    expect(AUTOPLAN).toMatch(/All review phases ran dual voices: skip the "Review Mode" banner/);
  });

  test('all three phase legends (CEO, eng, design) carry the label', () => {
    // The legend block repeats once per dual-voice phase; every copy must
    // teach the same CONFIRMED-1V semantics so no phase regresses alone.
    const occurrences = AUTOPLAN.split('CONFIRMED-1V = only one voice ran').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  test('template and generated skill stay in sync on the labeling', () => {
    for (const needle of ['CONFIRMED-1V', 'SINGLE-VOICE MODE', 'one independent reviewer, not two']) {
      expect(AUTOPLAN_TMPL).toContain(needle);
    }
  });
});
