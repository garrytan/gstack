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
      expect(section).toMatch(/^Before dispatch, fully Read \{\{AUTOPLAN_REVIEW_FILE:plan-[a-z-]+\}\} \+ triggered sections/);
      const load = section.split('**Override rules:**')[0]!;
      expect(load).toContain('record successful start/end/total ranges');
      expect(load).toContain('fill gaps to EOF');
      expect(load).toContain('Load skip-listed sections; skip execution');
    }
  });

  for (const phase of phases) {
    test(`${phase} places schema-aware dispatch and the actual completion wait before outside review`, () => {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const native = section.indexOf(`**{{NATIVE_LABEL}} ${phase === 'design' ? 'design' : phase === 'dx' ? 'DX' : phase === 'ceo' ? 'CEO' : 'eng'} subagent**`);
      const outside = section.indexOf('{{OUTSIDE_INVOCATION:autoplan}}');
      expect(native).toBeGreaterThan(-1);
      expect(native).toBeLessThan(outside);
      const dispatch = section.slice(native, outside);
      expect(dispatch).toContain('run_in_background: false');
      expect(dispatch).toContain("ONLY/FINAL tool call");
      expect(dispatch).toContain('Keep native Reads enabled');
      expect(dispatch).toContain('Child first Reads `nativePromptPath` to EOF');
      expect(dispatch).toContain('all criteria + plan');
      expect(dispatch).toContain('if its schema exposes it');
      expect(dispatch).toContain('isAsync: true');
      expect(dispatch).toContain('Claude Code: end response immediately');
      expect(dispatch).toContain('No further tool calls/review until');
      expect(dispatch).toContain('Completed-native INPUT must match snapshot phase/hash');
      expect(dispatch).toContain('Retry invalid input once; then failure policy if still invalid');
      expect(dispatch).toContain('Other hosts await that ID');
      expect(dispatch).toContain("Then outside → this phase's review ONLY");
      expect(dispatch).toContain('No inline substitute; apply failure policy');
      // Provider preflight, timeout and native fallback remain at every call.
      expect(section).toContain('Outer tool timeout: 720000ms');
      expect(section).toContain('disabled → skip outside. Both retain the native pass.');
      expect(section).toContain(`{{OUTSIDE_PROVENANCE:${phase}}}`);
      expect(section).toContain('Missing/disabled');
      expect(section).toContain('N/A');
      expect(section).toContain('primary cannot replace');
      expect(section).toContain(phase === 'design' ? 'not CONFIRMED' : 'never CONFIRMED');
    });
  }

  test('the parent completes only the current phase and cannot waive native work for context pressure', () => {
    const contract = tmpl.split('## Sequential Execution')[1]?.split('---')[0] ?? '';
    expect(contract).toContain('Keep ONE phase active');
    expect(contract).toContain('Never draft future-phase reviews or outputs');
    expect(contract).toContain('After compaction, reload current phase instructions/skill/sections; reconcile disk progress before resuming');
    expect(contract).toContain('Load its phase instructions and full skill/sections');
    expect(contract).toContain('Create the fresh snapshot and dispatch its nativeDispatchPrompt unchanged');
    expect(contract).toContain('Consume native completion, then enabled outside results; only then do the full primary review');
    expect(contract).toContain("Persist outputs/amendments and run the phase's implementation check/readback");
    expect(contract).toContain('Emit actual completion; only then load the next required phase');
    expect(contract).toContain('A missing gate means the current phase remains open');
    expect(contract).toContain('Read requests/self-reports and INPUT hashes do not prove uptake or review quality');
    expect(contract).toContain('Pending is not unavailable');
    expect(contract).toContain('Time/context pressure or your own review never permits\nskipping native passes or required sections');
    expect(contract).toContain('Never read raw agent transcripts');
    expect(tmpl).toContain('LOG each decision and amend ALL accepted obligations in `Implementation plan` in the SAME edit');
  });

  test('each completed phase announces only after persisted full outputs and settled reviewers', () => {
    for (const [phase, number] of [['ceo', '1'], ['design', '2'], ['dx', '2.5'], ['eng', '3']]) {
      const section = read(`autoplan/sections/${phase}-phase.md.tmpl`);
      const barrier = section.indexOf('**Close this phase:**');
      const announcement = section.indexOf(`\n**Phase ${number} complete.**\n`);
      expect(barrier).toBeGreaterThan(-1);
      expect(barrier).toBeLessThan(announcement);
      const checkpoint = section.slice(barrier, announcement);
      expect(checkpoint).toContain('Require full skill/section Read ranges');
      expect(checkpoint).toContain('successful writes');
      expect(checkpoint).toContain('terminal reviewers');
      expect(checkpoint).toContain('matched INPUT for completed native reviews');
      expect(checkpoint).toContain('(unavailable/disabled allowed)');
      expect(checkpoint).toContain('successful writes/check');
      expect(checkpoint).toContain(phase === 'eng'
        ? 'announce completion and proceed to final synthesis/approval'
        : 'announce completion AND load/create/dispatch the next phase');
      expect(checkpoint).toContain('record EVERY accepted');
      expect(checkpoint).toContain('obligation (split bundles) → exact `Implementation plan` text. Edit omissions');
      expect(checkpoint).toContain('Reread full phase `Review record`');
      expect(checkpoint).toContain('Verify each mapping in readback');
      expect(checkpoint).toContain('bytes prove neither completeness nor correctness');
      expect(checkpoint).toContain('Taste: provisional');
      expect(checkpoint).toContain('unresolved User Challenges: original direction');
      expect(checkpoint).toContain('Only then announce');
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
    expect(intake).toContain('ACTIVE_PLAN (harness-assigned plan, else SOURCE_PLAN)');
    expect(intake).toContain('Write all amendments/outputs to ACTIVE_PLAN');
    expect(intake).toContain("init backs up SOURCE_PLAN exactly");
    expect(intake).toContain('without losing requirements');
    expect(intake).toContain('init "<SOURCE_PLAN>" "<ACTIVE_PLAN>" "<RESTORE_PATH>"');
    expect(intake).toContain('Use returned paths/`scope`');
    expect(intake).toContain('On helper errors, stop');
    expect(intake).toContain('analysis stays in `## Review record`');
    // Binding belongs to the lazy execution site, not a stale intake variable.
    expect(intake).not.toContain('Bind `<review_plan_path>`');
  });

  test('DX scope consumes the deterministic full-input result and permits only enabling overrides', () => {
    const intake = read('autoplan/SKILL.md.tmpl').split('### Step 2: Read context')[1]?.split('### Step 3:')[0] ?? '';
    expect(intake).toContain('scope "<ACTIVE_PLAN>"');
    expect(intake).toContain('Use returned `dxRequired`');
    expect(intake).toContain('threshold is 2+ term matches');
    expect(intake).toContain('`--developer-tool` or `--agent-primary`');
    expect(intake).toContain('no context label can negate a positive result');
    expect(intake).toContain('false and neither semantic trigger applies');
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
      expect(preparation).toContain(`create ${phase} "<ACTIVE_PLAN>" "<RESTORE_PATH>"`);
      expect(preparation).toContain('`snapshotPath` as `<' + phase.toUpperCase() + '_INPUT>` for both voices');
      expect(preparation).toContain('excludes `Review record`');
      expect(section).toContain('Send `nativeDispatchPrompt` verbatim');
      expect(section).toContain('Reads `nativePromptPath` to EOF');
      expect(section).toContain(`Outside prompt: inline the full contents of <${phase.toUpperCase()}_INPUT>`);
      expect(section).toContain(`check ${phase} "<ACTIVE_PLAN>" "<${phase.toUpperCase()}_INPUT>" changed`);
      expect(section).toContain('No accepted implementation change: `unchanged` + reason');
      expect(section).toContain('Report/task edits do not count');
      expect(section).not.toContain('<review_plan_path>');
      expect(section).not.toContain('<plan_path>');
      expect(section).toContain('no summaries or prior reviews');
    }
    const eng = read('autoplan/sections/eng-phase.md.tmpl');
    expect(eng).toContain('no summaries or prior reviews');
    expect(eng).toContain('DX: <insert DX consensus table summary');
  });
});
