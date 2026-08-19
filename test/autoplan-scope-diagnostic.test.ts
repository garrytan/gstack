/**
 * /autoplan Phase 0 scope-detection diagnostic (gate tier)
 *
 * Phase 0 decides whether to run the Design (Phase 2) and DX (Phase 3.5)
 * reviews by grepping the plan for scope terms with a 2-match threshold.
 * Before #1957 a below-threshold result silently dropped the phase: no count,
 * no near-miss warning, no way to override. These static checks pin the
 * generated skill so the diagnostic can't quietly regress.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const AUTOPLAN = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md'), 'utf-8');
const AUTOPLAN_TMPL = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md.tmpl'), 'utf-8');

describe('autoplan Phase 0 scope diagnostic', () => {
  test('detection reports the match count, not just yes/no', () => {
    expect(AUTOPLAN).toContain('match COUNT');
    // The skip-visibility instruction must be present.
    expect(AUTOPLAN).toMatch(/never skip a phase\s+silently/);
  });

  test('a below-threshold scope is surfaced as a near-miss, not a clean no', () => {
    expect(AUTOPLAN).toContain('near-miss');
    // The known false-negative triggers from the issue are named so the agent
    // knows what to look for.
    expect(AUTOPLAN).toContain('form-control');
  });

  test('an exactly-at-threshold scope is flagged as borderline', () => {
    expect(AUTOPLAN).toMatch(/exactly 2 matches is borderline/);
  });

  test('the user is offered an override to force a skipped phase', () => {
    expect(AUTOPLAN).toContain('tell me to force');
  });

  test('the Phase 0 output line surfaces the counts and the override note', () => {
    expect(AUTOPLAN).toMatch(/UI scope: \[yes\/no\] \(\[N\] matches\)/);
    expect(AUTOPLAN).toMatch(/DX scope: \[yes\/no\] \(\[N\] matches\)/);
  });

  test('template and generated skill stay in sync on the diagnostic', () => {
    for (const needle of ['match COUNT', 'near-miss', 'tell me to force']) {
      expect(AUTOPLAN_TMPL).toContain(needle);
    }
  });
});
