/**
 * plan-ceo-review carve — static ordering guard (GATE tier, free, deterministic).
 *
 * This is the per-PR mechanical backstop for the v2-plan Phase B carve of
 * plan-ceo-review (Codex outside-voice P2). The periodic real-PTY E2E
 * (skill-e2e-plan-ceo-review-section-loading.test.ts) is the behavioral proof,
 * but it runs weekly and costs money. This file runs on every `bun test` and
 * fails CI the moment the carve's structural invariants break:
 *
 *  1. The skeleton points at the section with a STOP-Read directive, and that
 *     directive sits AFTER Step 0 (scope + mode) — so the conversational Step 0
 *     stays in the always-loaded skeleton, never stranded in the on-demand file.
 *  2. The heavy review body (Sections 1-11) is NOT in the skeleton — it moved to
 *     the section. A regression that inlines it back would re-bloat the skeleton.
 *  3. The review report writer ("GSTACK REVIEW REPORT") lives in the section, and
 *     the blocking EXIT PLAN MODE GATE that verifies it lives in the skeleton
 *     AFTER the STOP — so the gate fires once the section work returns.
 *  4. Nothing review-governing sits in the skeleton below the STOP (Codex P1):
 *     no "Section N", no "## Mode Quick Reference", no "## Formatting Rules".
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SKELETON = path.join(ROOT, 'plan-ceo-review', 'SKILL.md');
const SECTION = path.join(ROOT, 'plan-ceo-review', 'sections', 'review-sections.md');

describe('plan-ceo-review carve — static ordering', () => {
  const skeleton = fs.readFileSync(SKELETON, 'utf-8');
  const section = fs.readFileSync(SECTION, 'utf-8');

  // Index into the skeleton, -1 if absent.
  const at = (needle: string): number => skeleton.indexOf(needle);

  const STEP0 = '## Step 0: Nuclear Scope Challenge + Mode Selection';
  const STOP = 'sections/review-sections.md'; // appears in the index row + STOP directive
  const GATE = 'GSTACK REVIEW REPORT';

  test('skeleton emits a STOP-Read directive pointing at the section', () => {
    expect(skeleton).toContain('> **STOP.**');
    expect(skeleton).toContain('plan-ceo-review/sections/review-sections.md');
    expect(skeleton).toContain('## Section index — Read each section when its situation applies');
  });

  test('Step 0 (scope + mode) stays in the skeleton, BEFORE the STOP', () => {
    const step0 = at(STEP0);
    const stop = skeleton.indexOf('> **STOP.**');
    expect(step0).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(step0); // STOP fires only after Step 0
  });

  test('the heavy review body (Sections 1-11) is NOT in the skeleton', () => {
    expect(skeleton).not.toContain('### Section 1: Architecture Review');
    expect(skeleton).not.toContain('### Section 11:');
    // ...it lives in the section instead.
    expect(section).toContain('### Section 1: Architecture Review');
    expect(section).toContain('### Section 11:');
  });

  test('nothing review-governing sits in the skeleton below the STOP (Codex P1)', () => {
    // Mode Quick Reference + Formatting Rules govern review-time behavior and must
    // travel with the section, not be stranded below the STOP in the skeleton.
    expect(skeleton).not.toContain('## Mode Quick Reference');
    expect(skeleton).not.toContain('## Formatting Rules');
    expect(section).toContain('## Mode Quick Reference');
  });

  test('review report writer lives in the section; the EXIT PLAN MODE GATE stays in the skeleton AFTER the STOP', () => {
    // The report itself is produced inside the section work...
    expect(section).toContain(GATE);
    // ...and the blocking gate that verifies it is the last thing the skeleton runs.
    const stop = skeleton.indexOf('> **STOP.**');
    const gate = skeleton.lastIndexOf(GATE);
    expect(gate).toBeGreaterThan(stop);
  });

  test('the loaded test-review section preserves mandatory behaviors and individual assertion decisions', () => {
    const template = fs.readFileSync(`${SECTION}.tmpl`, 'utf-8');
    for (const document of [template, section]) {
      const testReview = document.split('### Section 6: Test Review')[1]?.split('### Section 7:')[0];
      expect(testReview).toBeDefined();
      const instructions = testReview!.replace(/\s+/g, ' ');
      expect(instructions).toContain("First map it to the user's exact requirement or individually approved remedy.");
      expect(instructions).toContain('A stated outcome plus its retained caller contract can already determine the assertion, even without assertion syntax.');
      expect(instructions).toContain('Translate semantic counts, conditions and quantifiers exactly');
      expect(instructions).toContain('Never weaken an exact count to a lower bound.');
      expect(instructions).toContain('Reuse these requirements without asking again.');
      expect(instructions).toContain('Ask individually only for an unresolved behavioral choice, new outcome, or independent uncovered failure mode.');
      expect(instructions).toContain('Vague success labels do not settle values');
      expect(instructions).toContain('scope/approach approval does not resolve an individual assertion gap.');
      expect(instructions).toContain("Helper coverage alone does not prove the caller's path.");
      expect(instructions).toContain('Explain what the existing requirement or approved remedy fails to cover before calling a check missing.');
      expect(instructions).toContain('Never silently add, defer or waive a missing behavioral assertion.');
      expect(instructions).toContain('Keep required behaviors mandatory unless the user explicitly approves changing them');
      expect(instructions).toContain('honor previously accepted risks and equivalent caller coverage.');
      expect(instructions).toContain('AskUserQuestion once per issue. Do NOT batch.');
    }
  });

  test('the loaded data-flow review requires evidence across interacting operations', () => {
    const template = fs.readFileSync(`${SECTION}.tmpl`, 'utf-8');
    for (const document of [template, section]) {
      const dataFlow = document.split('### Section 4: Data Flow & Interaction Edge Cases')[1]?.split('### Section 5:')[0];
      expect(dataFlow).toBeDefined();
      const instructions = dataFlow!.replace(/\s+/g, ' ');
      expect(instructions).toContain('include a combined ASCII schedule with one column per operation and one for shared state.');
      expect(instructions).toContain('pause, let a competing operation complete, resume, then start a fresh consumer.');
      expect(instructions).toContain('compare it with the exact caller/time boundary of the stated invariant.');
      expect(instructions).toContain('If safe, name the mechanism that prevents the violating schedule.');
      expect(instructions).toContain('Separate flow diagrams do not prove ordering.');
      expect(instructions).toContain('An accepted exception needs its exact contract clause; bounded damage is insufficient.');
      expect(instructions).toContain('Test this schedule with controlled pause/release points.');
    }
  });

  test('the section is generated, not hand-edited', () => {
    expect(section.slice(0, 120)).toContain('AUTO-GENERATED');
  });
});
