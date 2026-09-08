/**
 * /autoplan phase-order pin (free, static).
 *
 * The pipeline order is a deliberate design decision (2026-08-25, user-directed):
 * CEO → Design (if UI scope) → DX (if developer-facing scope) → Eng, ALWAYS LAST.
 * Eng is the required shipping gate — it must review the FINAL amended plan, so
 * every other phase's amendments land before it. The original order buried Eng
 * mid-pipeline (CEO → Design → Eng → DX), which let DX findings land AFTER the
 * gate had signed off — the gate validated a stale plan.
 *
 * These assertions pin the template so a refactor can't silently restore the
 * old order. The paid chain E2E (skill-e2e-autoplan-chain.test.ts) verifies the
 * runtime behavior; this pins the source of truth for free on every PR.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('autoplan phase order (Eng always last)', () => {
  const tmpl = read('autoplan/SKILL.md.tmpl');

  test('Sequential Execution block names Eng as the terminal phase', () => {
    const block = tmpl.split('## Sequential Execution')[1]?.split('---')[0] ?? '';
    expect(block).toContain('Eng runs LAST, always');
    expect(block).toMatch(/CEO → Design.*→ DX.*→ Eng/s);
    // The old order must not resurface anywhere in the template.
    expect(tmpl).not.toContain('CEO → Design → Eng → DX');
  });

  test('phase headings appear in the new order: 1, 2, 2.5, 3', () => {
    const idx = (h: string) => {
      const i = tmpl.indexOf(h);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const p1 = idx('## Phase 1: CEO Review');
    const p2 = idx('## Phase 2: Design Review');
    const p25 = idx('## Phase 2.5: DX Review');
    const p3 = idx('## Phase 3: Eng Review');
    expect(p1).toBeLessThan(p2);
    expect(p2).toBeLessThan(p25);
    expect(p25).toBeLessThan(p3);
    // No stale Phase 3.5 heading or transition marker survives.
    expect(tmpl).not.toContain('Phase 3.5');
  });

  test('phase sections hand off in the new order', () => {
    expect(read('autoplan/sections/dx-phase.md.tmpl')).toContain(
      'Passing to Phase 3 (Eng Review',
    );
    expect(read('autoplan/sections/eng-phase.md.tmpl')).toContain(
      'Passing to Phase 4 (Final Gate)',
    );
    // Eng's Codex voice sees every prior phase's consensus, DX included.
    expect(read('autoplan/sections/eng-phase.md.tmpl')).toContain(
      'DX: <insert DX consensus table summary',
    );
  });

  test('single final gate: premises queue for the gate, never a mid-run stop', () => {
    expect(tmpl).toContain('One exception class — never auto-decided');
    expect(tmpl).not.toContain('Premise gate passed (user confirmed)');
    const ceo = read('autoplan/sections/ceo-phase.md.tmpl');
    expect(ceo).not.toContain('GATE: Present premises to user for confirmation');
    expect(ceo).toContain('Final');
  });
});

describe('autoplan phase execution checkpoints', () => {
  const tmpl = read('autoplan/SKILL.md.tmpl');
  const phases = ['ceo', 'design', 'dx', 'eng'];

  test('loads full review skills at phase entry instead of prefetching future phases', () => {
    const intake = tmpl.split('### Step 3:')[1]?.split('## Phase 0.5:')[0] ?? '';
    expect(intake).toContain('At each phase, follow its full-load checkpoint');
    expect(intake).toContain('Do not prefetch future phase sections or review skills');
    for (const phase of phases) {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      expect(section).toMatch(/^Read \{\{AUTOPLAN_REVIEW_FILE:plan-[a-z-]+\}\} in full/);
      const load = section.split('**Override rules:**')[0]!;
      expect(load).toContain('successful Read ranges span 1–EOF');
      expect(load).toContain('fetch truncated remainders');
      expect(load).toContain('load skip-listed sections; skip execution');
    }
  });

  for (const phase of phases) {
    test(`${phase} places explicit foreground dispatch and its completion barrier before the outside invocation`, () => {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const native = section.indexOf(`**{{NATIVE_LABEL}} ${phase === 'design' ? 'design' : phase === 'dx' ? 'DX' : phase === 'ceo' ? 'CEO' : 'eng'} subagent**`);
      const outside = section.indexOf('{{OUTSIDE_INVOCATION:autoplan}}');
      expect(native).toBeGreaterThan(-1);
      expect(native).toBeLessThan(outside);
      const dispatch = section.slice(native, outside);
      expect(dispatch).toContain('"run_in_background": false');
      expect(dispatch).toContain('isAsync: true');
      expect(dispatch).toContain('wait for that same agent');
      expect(dispatch).toContain('before outside dispatch or parent review');
      // Provider preflight, timeout and native fallback remain at every call.
      expect(section).toContain('Outer tool timeout: 720000ms');
      expect(section).toContain('Disabled skips the outside invocation; it retains the native pass.');
      expect(section).toContain(`{{OUTSIDE_PROVENANCE:${phase}}}`);
    });
  }

  test('each completed phase announces only after persisted full outputs and settled reviewers', () => {
    for (const [phase, number] of [['ceo', '1'], ['design', '2'], ['dx', '2.5'], ['eng', '3']]) {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const barrier = section.indexOf('**Close this phase before continuing:**');
      const announcement = section.indexOf(`\n**Phase ${number} complete.**\n`);
      expect(barrier).toBeGreaterThan(-1);
      expect(barrier).toBeLessThan(announcement);
      const checkpoint = section.slice(barrier, announcement);
      expect(checkpoint).toContain('successful Write/Edit results');
      expect(checkpoint).toContain('terminal status');
      expect(checkpoint).toContain('actual assistant message');
      expect(checkpoint).toContain('Apply accepted decisions');
      expect(checkpoint).toContain('Read back against decisions');
      expect(checkpoint).toContain('Mark taste pending final approval');
      expect(checkpoint).toContain('preserve original\ndirection for unresolved User Challenges');
      expect(checkpoint).toContain('Only then emit');
    }
  });

  test('Design hands off to conditional DX and DX never requests a future Eng result', () => {
    const design = read('autoplan/sections/design-phase.md.tmpl');
    const dx = read('autoplan/sections/dx-phase.md.tmpl');
    expect(design).toContain('Passing to Phase 2.5 (DX Review) if DX scope was detected; otherwise Phase 3');
    expect(design).not.toContain('> Passing to Phase 3.');
    expect(dx).toContain("Design: <insert Design consensus summary, or 'skipped, no UI scope'>");
    expect(dx).not.toContain('Eng: <insert Eng consensus summary>');
  });
});


describe('autoplan current implementation-plan identity', () => {
  test('pins the assigned active plan and keeps accepted amendments separate from review analyses', () => {
    const intake = read('autoplan/SKILL.md.tmpl').split('## Phase 0: Intake')[1]?.split('### Step 2:')[0] ?? '';
    expect(intake).toContain('ACTIVE_PLAN is the harness-assigned');
    expect(intake).toContain('All amendments/outputs go to ACTIVE_PLAN');
    expect(intake).toContain("SOURCE_PLAN's full current state externally");
    expect(intake).toContain('without dropping\nrequirements');
    expect(intake).toContain("Copy SOURCE_PLAN into ACTIVE_PLAN's `## Implementation plan`");
    expect(intake).toContain('Keep analyses/audit in `## Review record`');
    // Binding belongs to the lazy execution site, not a stale intake variable.
    expect(intake).not.toContain('Bind `<review_plan_path>`');
  });

  test('every native and outside call site binds the fresh snapshot, retaining requested outside consensus', () => {
    for (const phase of ['ceo', 'design', 'dx', 'eng']) {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const bind = section.indexOf("**Bind this phase's input:**");
      const native = section.indexOf('subagent**');
      const outside = section.indexOf('{{OUTSIDE_INVOCATION:autoplan}}');
      expect(bind).toBeGreaterThan(-1);
      expect(bind).toBeLessThan(native);
      expect(native).toBeLessThan(outside);
      const preparation = section.slice(bind, native);
      expect(preparation).toContain("Read ACTIVE_PLAN's `Implementation plan`");
      expect(preparation).toContain('full text beside RESTORE_PATH');
      expect(preparation).toContain("as a new `<review_plan_path>` for both voices");
      expect(preparation).toContain('Exclude `Review record`');
      expect(section).toContain('Read the plan file at <review_plan_path>');
      expect(section).toContain('Outside prompt: inline the full contents of <review_plan_path>');
      expect(section).not.toContain('<plan_path>');
      expect(section).toContain('You have NOT seen any prior review');
    }
    const eng = read('autoplan/sections/eng-phase.md.tmpl');
    expect(eng).toContain('NO prior-phase context — subagent must be truly independent');
    expect(eng).toContain('DX: <insert DX consensus table summary');
  });
});
