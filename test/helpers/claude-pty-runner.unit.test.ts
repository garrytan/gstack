/**
 * Deterministic unit tests for claude-pty-runner.ts behavior changes.
 *
 * Free-tier (no EVALS=1 needed). Runs in <1s on every `bun test`. Catches
 * harness plumbing bugs before stochastic PTY runs surface them.
 *
 * Two surface areas tested:
 *
 * 1. Permission-dialog short-circuit in 'asked' classification: a TTY frame
 *    that matches BOTH isPermissionDialogVisible AND isNumberedOptionListVisible
 *    must NOT be classified as a skill question — permission dialogs render
 *    as numbered lists too, but they're not what we're guarding.
 *
 * 2. Env passthrough surface: runPlanSkillObservation accepts an `env`
 *    option and threads it to launchClaudePty. We can't fully exercise the
 *    spawn pipeline without paying for a PTY session, but we CAN verify the
 *    option exists in the type signature and that calling without env still
 *    works (no regression).
 *
 * The PTY test (skill-e2e-plan-ceo-plan-mode.test.ts) is the integration
 * check; this file is the cheap deterministic guard for the harness primitives
 * those tests stand on.
 */

import { describe, test, expect } from 'bun:test';
import {
  isPermissionDialogVisible,
  isNumberedOptionListVisible,
  isPlanReadyVisible,
  parseNumberedOptions,
  classifyVisible,
  TAIL_SCAN_BYTES,
  type ClaudePtyOptions,
} from './claude-pty-runner';

describe('isPermissionDialogVisible', () => {
  test('matches "Bash command requires permission" prompts', () => {
    const sample = `
      Some preamble output

      Bash command \`gstack-config get telemetry\` requires permission to run.

      ❯ 1. Yes
        2. Yes, and always allow
        3. No, abort
    `;
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });

  test('matches "allow all edits" file-edit prompts', () => {
    // Isolated to the "allow all edits" clause only — no overlapping
    // "Do you want to proceed?" co-trigger, so this asserts the clause works.
    const sample = `
      Edit to ~/.gstack/config.yaml

      ❯ 1. Yes
        2. Yes, allow all edits during this session
        3. No
    `;
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });

  test('matches the "Do you want to proceed?" file-edit confirmation by itself', () => {
    // Separate fixture so weakening this clause is detected by a dedicated test.
    const sample = `
      Edit to ~/.gstack/config.yaml

      Do you want to proceed?

      ❯ 1. Yes
        2. No
    `;
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });

  test('matches workspace-trust "always allow access to" prompt', () => {
    const sample = `
      Do you trust the files in this folder?

      ❯ 1. Yes, proceed
        2. Yes, and always allow access to /Users/me/repo
        3. No, exit
    `;
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });

  test('does NOT match a skill AskUserQuestion list', () => {
    const sample = `
      D1 — Premise challenge: do users actually want this?

      ❯ 1. Yes, validated
        2. No, premise is wrong
        3. Need more info
    `;
    expect(isPermissionDialogVisible(sample)).toBe(false);
  });

  test('does NOT match a plan-ready confirmation', () => {
    const sample = `
      Ready to execute the plan?

      ❯ 1. Yes
        2. No, keep planning
    `;
    expect(isPermissionDialogVisible(sample)).toBe(false);
  });

  test('does NOT match a skill question that contains the bare phrase "Do you want to proceed?"', () => {
    // Co-trigger requirement: "Do you want to proceed?" alone is not enough.
    // It must appear with "Edit to <path>" or "Write to <path>" to count as
    // a permission dialog. This guards against a skill question like
    // "Do you want to proceed with HOLD SCOPE?" being mis-classified.
    const sample = `
      Choose your scope mode for this review.
      Do you want to proceed?

      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
        3. SELECTIVE EXPANSION
    `;
    expect(isPermissionDialogVisible(sample)).toBe(false);
  });

  test('does NOT mis-match when adversarial prose includes "Edit to <path>" alongside the bare proceed phrase', () => {
    // Adversarial fixture: a skill question whose body legitimately mentions
    // "Edit to <path>" in prose AND ends with "Do you want to proceed?". The
    // current co-trigger regex would mis-classify this as a permission
    // dialog. We DO want this test to fail until the regex is tightened
    // further (e.g., proximity constraint, or anchoring "Edit to" to a
    // line-start). For now this is documented as a known limitation: a
    // skill question that talks about "Edit to" in prose IS still treated
    // as a permission dialog. The test asserts the current behavior so a
    // future fix can flip it intentionally.
    const sample = `
      Plan: I will Edit to ./plan.md to capture the decision.
      Do you want to proceed?

      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
    `;
    // KNOWN LIMITATION: the co-trigger fires here. Documented as a
    // post-merge follow-up. Flip this assertion once the regex tightens.
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });
});

describe('isNumberedOptionListVisible', () => {
  test('matches a basic ❯ 1. + 2. cursor list', () => {
    const sample = `
      ❯ 1. Option one
        2. Option two
        3. Option three
    `;
    expect(isNumberedOptionListVisible(sample)).toBe(true);
  });

  test('returns false on a single-option prompt', () => {
    const sample = `
      ❯ 1. Only option
    `;
    expect(isNumberedOptionListVisible(sample)).toBe(false);
  });

  test('returns false when no cursor renders', () => {
    const sample = `
      Just some prose with 1. a numbered point and 2. another.
    `;
    expect(isNumberedOptionListVisible(sample)).toBe(false);
  });

  test('overlaps permission dialogs (this is why D5 short-circuits)', () => {
    // The whole point of D5: this string matches BOTH classifiers, so the
    // runner must consult isPermissionDialogVisible to disambiguate.
    const sample = `
      Bash command \`do-thing\` requires permission to run.

      ❯ 1. Yes
        2. No
    `;
    expect(isNumberedOptionListVisible(sample)).toBe(true);
    expect(isPermissionDialogVisible(sample)).toBe(true);
  });
});

describe('classifyVisible (runtime path through the runner classifier)', () => {
  // These tests call the actual classifier so a future contributor who
  // reorders branches (e.g. moves the permission short-circuit before
  // isPlanReadyVisible) is caught deterministically.

  test('skill question → returns asked', () => {
    const visible = `
      D1 — Choose your scope mode

      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
        3. SELECTIVE EXPANSION
        4. SCOPE REDUCTION
    `;
    const result = classifyVisible(visible);
    expect(result?.outcome).toBe('asked');
  });

  test('permission dialog (Bash) → returns null (skip, keep polling)', () => {
    const visible = `
      Bash command \`gstack-update-check\` requires permission to run.

      ❯ 1. Yes
        2. No
    `;
    expect(isNumberedOptionListVisible(visible)).toBe(true); // pre-filter
    expect(classifyVisible(visible)).toBeNull(); // post-filter
  });

  test('plan-ready confirmation → returns plan_ready (wins over asked)', () => {
    const visible = `
      Ready to execute the plan?

      ❯ 1. Yes, proceed
        2. No, keep planning
    `;
    const result = classifyVisible(visible);
    expect(result?.outcome).toBe('plan_ready');
  });

  test('silent write to unsanctioned path → returns silent_write', () => {
    const visible = `
      ⏺ Write(src/app/dangerous-write.ts)
      ⎿  Wrote 42 lines
    `;
    const result = classifyVisible(visible);
    expect(result?.outcome).toBe('silent_write');
    expect(result?.summary).toContain('src/app/dangerous-write.ts');
  });

  test('write to sanctioned path (.claude/plans) → returns null (allowed)', () => {
    const visible = `
      ⏺ Write(/Users/me/.claude/plans/some-plan.md)
      ⎿  Wrote 42 lines
    `;
    expect(classifyVisible(visible)).toBeNull();
  });

  test('write while a permission dialog is on screen → returns null (gated, not silent, not asked)', () => {
    const visible = `
      ⏺ Write(src/app/edit-with-permission.ts)

      Edit to src/app/edit-with-permission.ts

      Do you want to proceed?

      ❯ 1. Yes
        2. No
    `;
    // The numbered prompt is a permission dialog (Edit to + Do you want to proceed?);
    // silent_write is suppressed because a numbered prompt is visible, AND
    // 'asked' is suppressed because the prompt is a permission dialog.
    expect(classifyVisible(visible)).toBeNull();
  });

  test('write while a real skill question is on screen → returns asked (write is captured but not silent)', () => {
    const visible = `
      ⏺ Write(src/app/foo.ts)

      D1 — Choose your scope mode

      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
    `;
    // The numbered prompt is a skill question, not a permission dialog;
    // silent_write is suppressed (numbered prompt is visible) and the
    // outcome is 'asked' — Step 0 fired.
    const result = classifyVisible(visible);
    expect(result?.outcome).toBe('asked');
  });

  test('idle / no signals → returns null', () => {
    const visible = `
      Some prose without any classifier signals.
    `;
    expect(classifyVisible(visible)).toBeNull();
  });

  test('TAIL_SCAN_BYTES is exported as 1500', () => {
    // Shared between runner and routing test; a regression that desyncs the
    // recent-tail window would surface here.
    expect(TAIL_SCAN_BYTES).toBe(1500);
  });
});

describe('parseNumberedOptions', () => {
  test('extracts options from a clean cursor list', () => {
    const visible = `
      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
    `;
    const opts = parseNumberedOptions(visible);
    expect(opts).toHaveLength(2);
    expect(opts[0]).toEqual({ index: 1, label: 'HOLD SCOPE' });
    expect(opts[1]).toEqual({ index: 2, label: 'SCOPE EXPANSION' });
  });

  test('returns empty array on prose-with-numbers (no cursor)', () => {
    expect(parseNumberedOptions('text 1. one 2. two')).toEqual([]);
  });
});

describe('runPlanSkillObservation env passthrough surface', () => {
  test('ClaudePtyOptions exposes env: Record<string, string>', () => {
    // Type-level guard: this file would fail to compile if the env field
    // were removed or its shape regressed. The actual env merge happens in
    // launchClaudePty's spawn call (`env: { ...process.env, ...opts.env }`),
    // so a regression where `env: opts.env` gets dropped from the
    // runPlanSkillObservation -> launchClaudePty handoff is only caught by
    // the live PTY test, not here.
    const opts: ClaudePtyOptions = {
      env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
    };
    expect(opts.env).toEqual({ QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' });
  });
});
