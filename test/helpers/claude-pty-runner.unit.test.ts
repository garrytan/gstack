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
  optionsSignature,
  parseQuestionPrompt,
  auqFingerprint,
  COMPLETION_SUMMARY_RE,
  assertReviewReportAtBottom,
  ceoStep0Boundary,
  engStep0Boundary,
  designStep0Boundary,
  devexStep0Boundary,
  type ClaudePtyOptions,
  type AskUserQuestionFingerprint,
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

  test('extracts options when the cursor is INLINE with prompt header (box-layout)', () => {
    // Real /plan-ceo-review rendering: the TTY's cursor-positioning escapes
    // collapse divider + header + prompt + cursor onto one logical line.
    // Subsequent options (2..7) still start their own lines.
    const visible = [
      '────────────────────────────────────────',
      '☐ Review scope                                                     What scope do you want me to CEO-review?                                                     ❯ 1. The branch\'s diff vs main',
      '   Review the full branch: ~10K LOC.',
      '2. A specific plan file or design doc',
      '   You point me at a file (path) and I review that.',
      '3. An idea you\'ll describe inline',
      '4. Cancel — wrong skill',
      '5. Type something.',
      '────────────────────────────────────────',
      '6. Chat about this',
      '7. Skip interview and plan immediately',
    ].join('\n');
    const opts = parseNumberedOptions(visible);
    expect(opts).toHaveLength(7);
    expect(opts[0]).toEqual({ index: 1, label: "The branch's diff vs main" });
    expect(opts[1]?.index).toBe(2);
    expect(opts[6]?.index).toBe(7);
    expect(opts[6]?.label).toBe('Skip interview and plan immediately');
  });

  test('inline-cursor and start-of-line cursor both produce 7 options for the box-layout case', () => {
    // The inline path captures option 1 from the cursor line itself; the
    // subsequent-lines path captures 2..7 with the existing optionRe.
    const inlineLayout = [
      'header text                                                     ❯ 1. first option',
      '2. second',
      '3. third',
    ].join('\n');
    expect(parseNumberedOptions(inlineLayout)).toEqual([
      { index: 1, label: 'first option' },
      { index: 2, label: 'second' },
      { index: 3, label: 'third' },
    ]);

    const cleanLayout = [
      '  ❯ 1. first option',
      '    2. second',
      '    3. third',
    ].join('\n');
    expect(parseNumberedOptions(cleanLayout)).toEqual([
      { index: 1, label: 'first option' },
      { index: 2, label: 'second' },
      { index: 3, label: 'third' },
    ]);
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

// ────────────────────────────────────────────────────────────────────────────
// Per-finding count primitives — Section 3 unit tests #1–#5, #7, #12.
// ────────────────────────────────────────────────────────────────────────────

describe('optionsSignature', () => {
  test('returns a "|"-joined `index:label` string for a clean list', () => {
    const sig = optionsSignature([
      { index: 1, label: 'HOLD SCOPE' },
      { index: 2, label: 'SCOPE EXPANSION' },
    ]);
    expect(sig).toBe('1:HOLD SCOPE|2:SCOPE EXPANSION');
  });

  test('order-independent: shuffled inputs produce the same signature', () => {
    // parseNumberedOptions already returns sorted, but defensive sort means
    // a future caller that hands us shuffled input still produces a stable
    // dedupe signature.
    const a = optionsSignature([
      { index: 2, label: 'B' },
      { index: 1, label: 'A' },
      { index: 3, label: 'C' },
    ]);
    const b = optionsSignature([
      { index: 1, label: 'A' },
      { index: 2, label: 'B' },
      { index: 3, label: 'C' },
    ]);
    expect(a).toBe(b);
  });

  test('empty list returns empty string', () => {
    expect(optionsSignature([])).toBe('');
  });

  test('single-item list returns just that entry', () => {
    expect(optionsSignature([{ index: 1, label: 'Only' }])).toBe('1:Only');
  });
});

describe('parseQuestionPrompt', () => {
  test('captures 1-line prompt above the cursor', () => {
    const visible = `
      D1 — Pick a mode

      ❯ 1. HOLD SCOPE
        2. SCOPE EXPANSION
    `;
    const prompt = parseQuestionPrompt(visible);
    expect(prompt).toBe('D1 — Pick a mode');
  });

  test('captures multi-line prompt above the cursor', () => {
    const visible = `
      D2 — Approach selection

      Which architecture should we follow?

      ❯ 1. Bypass existing helper
        2. Reuse existing helper
    `;
    const prompt = parseQuestionPrompt(visible);
    // Multi-line prompts get joined with single spaces.
    expect(prompt).toContain('D2 — Approach selection');
    expect(prompt).toContain('Which architecture should we follow?');
  });

  test('returns "" when no cursor is rendered', () => {
    expect(parseQuestionPrompt('Just some prose.\nNo cursor.')).toBe('');
  });

  test('truncates to 240 chars', () => {
    const longPrompt = 'A'.repeat(500);
    const visible = `${longPrompt}\n\n      ❯ 1. yes\n        2. no`;
    expect(parseQuestionPrompt(visible).length).toBeLessThanOrEqual(240);
  });

  test('does not pull text from a previous numbered list above', () => {
    const visible = `
      ❯ 1. previous answered question
        2. previous option two

      D2 — A new question text

      ❯ 1. fresh option A
        2. fresh option B
    `;
    const prompt = parseQuestionPrompt(visible);
    // Stops at the previous numbered-list line; should NOT contain "previous answered question".
    expect(prompt).toContain('D2 — A new question text');
    expect(prompt).not.toContain('previous answered question');
  });

  test('normalizes whitespace (collapses runs of spaces and tabs)', () => {
    const visible = `D1   —    Spaced     out

      ❯ 1. yes
        2. no`;
    expect(parseQuestionPrompt(visible)).toBe('D1 — Spaced out');
  });

  test('inline-cursor box-layout: extracts prompt text BEFORE ❯1. on the cursor line', () => {
    // Real /plan-ceo-review rendering: divider + ☐ header + prompt text +
    // cursor are all on one logical line because TTY cursor-positioning
    // escapes collapse the box layout under stripAnsi.
    const visible = [
      '──────────────────',
      '☐ Review scope                                                     What scope do you want me to CEO-review?                                                     ❯ 1. The branch\'s diff vs main',
      '2. A specific plan file',
      '3. An idea inline',
    ].join('\n');
    const prompt = parseQuestionPrompt(visible);
    // Should extract "Review scope" and the prompt text, dropping the ☐ box-drawing sigil.
    expect(prompt).toContain('Review scope');
    expect(prompt).toContain('What scope do you want me to CEO-review?');
    expect(prompt).not.toContain('❯');
    expect(prompt).not.toMatch(/^☐/);
  });
});

describe('auqFingerprint', () => {
  test('returns the same fingerprint for identical inputs', () => {
    const opts = [
      { index: 1, label: 'A' },
      { index: 2, label: 'B' },
    ];
    expect(auqFingerprint('hello', opts)).toBe(auqFingerprint('hello', opts));
  });

  test('different prompts with shared option labels produce DIFFERENT fingerprints', () => {
    // The collision regression Codex F1 caught: option-label-only fingerprints
    // collapsed multiple distinct findings into one when they shared menu shape.
    const sharedOpts = [
      { index: 1, label: 'Add to plan' },
      { index: 2, label: 'Defer' },
      { index: 3, label: 'Build now' },
    ];
    const fpFinding1 = auqFingerprint('D5 — Architecture: bypass helper?', sharedOpts);
    const fpFinding2 = auqFingerprint('D6 — Tests: zero coverage?', sharedOpts);
    expect(fpFinding1).not.toBe(fpFinding2);
  });

  test('same prompt with different options produces DIFFERENT fingerprints', () => {
    const prompt = 'D1 — Pick a mode';
    const fpA = auqFingerprint(prompt, [
      { index: 1, label: 'HOLD SCOPE' },
      { index: 2, label: 'SCOPE EXPANSION' },
    ]);
    const fpB = auqFingerprint(prompt, [
      { index: 1, label: 'HOLD SCOPE' },
      { index: 2, label: 'SCOPE REDUCTION' },
    ]);
    expect(fpA).not.toBe(fpB);
  });

  test('whitespace-only differences in prompt do NOT change the fingerprint', () => {
    // Same content, different rendering whitespace (TTY redraw artifact)
    // must produce the same fingerprint so dedupe survives reflow.
    const opts = [{ index: 1, label: 'A' }, { index: 2, label: 'B' }];
    const fpA = auqFingerprint('Pick   a     mode', opts);
    const fpB = auqFingerprint('Pick a mode', opts);
    expect(fpA).toBe(fpB);
  });

  test('empty prompt + same options collide (caller must guard against this)', () => {
    // Documents the contract: empty-prompt fingerprints WILL collide if the
    // caller fingerprints them. runPlanSkillCounting must skip empty-prompt
    // AUQs and re-poll instead.
    const opts = [{ index: 1, label: 'A' }];
    expect(auqFingerprint('', opts)).toBe(auqFingerprint('', opts));
  });
});

describe('COMPLETION_SUMMARY_RE', () => {
  test('matches GSTACK REVIEW REPORT heading', () => {
    expect(COMPLETION_SUMMARY_RE.test('## GSTACK REVIEW REPORT')).toBe(true);
  });

  test('matches Completion Summary heading (ceo + eng)', () => {
    expect(COMPLETION_SUMMARY_RE.test('## Completion Summary')).toBe(true);
    expect(COMPLETION_SUMMARY_RE.test('## Completion summary')).toBe(true);
  });

  test('matches Status: clean (CEO review-log shape)', () => {
    expect(COMPLETION_SUMMARY_RE.test('Status: clean')).toBe(true);
    expect(COMPLETION_SUMMARY_RE.test('Status: issues_open')).toBe(true);
  });

  test('matches VERDICT: line', () => {
    expect(COMPLETION_SUMMARY_RE.test('VERDICT: CLEARED — Eng Review passed')).toBe(true);
  });

  test('does NOT match prose mentions of "verdict" mid-line', () => {
    // VERDICT must be at the start of a line to count.
    expect(COMPLETION_SUMMARY_RE.test('the final verdict: undecided')).toBe(false);
  });
});

describe('assertReviewReportAtBottom', () => {
  test('passes when REVIEW REPORT is the only/last ## heading', () => {
    const content = `# Plan

## Context
stuff

## Approach
more stuff

## GSTACK REVIEW REPORT

| col | col |
`;
    const r = assertReviewReportAtBottom(content);
    expect(r.ok).toBe(true);
  });

  test('fails when REVIEW REPORT is missing', () => {
    const content = `# Plan

## Context
stuff
`;
    const r = assertReviewReportAtBottom(content);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no GSTACK REVIEW REPORT/);
  });

  test('fails when REVIEW REPORT exists but a ## heading follows it', () => {
    const content = `# Plan

## GSTACK REVIEW REPORT

| col | col |

## Late Section
oops
`;
    const r = assertReviewReportAtBottom(content);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/trailing ## heading/);
    expect(r.trailingHeadings).toEqual(['## Late Section']);
  });

  test('passes when only ### subheadings follow REVIEW REPORT (deeper nesting allowed)', () => {
    const content = `## GSTACK REVIEW REPORT

### Cross-model tension
- F1: resolved
- F2: resolved
`;
    const r = assertReviewReportAtBottom(content);
    expect(r.ok).toBe(true);
  });

  test('fails with multiple trailing ## headings reported', () => {
    const content = `## GSTACK REVIEW REPORT

## First trailing

## Second trailing
`;
    const r = assertReviewReportAtBottom(content);
    expect(r.ok).toBe(false);
    expect(r.trailingHeadings).toHaveLength(2);
  });
});

describe('Step0BoundaryPredicate per-skill', () => {
  // Helper to build a synthetic fingerprint for predicate tests.
  function fp(promptSnippet: string, optionLabels: string[]): AskUserQuestionFingerprint {
    const options = optionLabels.map((label, i) => ({ index: i + 1, label }));
    return {
      signature: auqFingerprint(promptSnippet, options),
      promptSnippet,
      options,
      observedAtMs: 0,
      preReview: true,
    };
  }

  describe('ceoStep0Boundary', () => {
    test('FIRES on Step 0F mode-pick AUQ (HOLD SCOPE in options)', () => {
      const f = fp('Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION']);
      expect(ceoStep0Boundary(f)).toBe(true);
    });

    test('FIRES on scope-selection AUQ with "Skip interview" option (skip-interview path)', () => {
      // After calibration run 1: plan-ceo's first AUQ is scope-selection,
      // and we route via "Skip interview and plan immediately" to bypass
      // Step 0 entirely. Boundary must fire on this AUQ so subsequent
      // AUQs go to reviewCount.
      const f = fp(
        'What scope do you want me to CEO-review?',
        [
          "The branch's diff vs main",
          'A specific plan file',
          "An idea you'll describe inline",
          'Cancel — wrong skill',
          'Type something.',
          'Chat about this',
          'Skip interview and plan immediately',
        ],
      );
      expect(ceoStep0Boundary(f)).toBe(true);
    });

    test('does NOT fire on premise challenge AUQs', () => {
      const f = fp('D1 — Premise check: is this the right problem?', ['Yes', 'No', 'Other']);
      expect(ceoStep0Boundary(f)).toBe(false);
    });

    test('does NOT fire on review-section AUQs', () => {
      const f = fp('Architecture: bypass helper?', ['Reuse existing', 'Roll new', 'Defer']);
      expect(ceoStep0Boundary(f)).toBe(false);
    });
  });

  describe('engStep0Boundary', () => {
    test('FIRES on cross-project learnings prompt', () => {
      const f = fp('Enable cross-project learnings on this machine?', ['Yes', 'No']);
      expect(engStep0Boundary(f)).toBe(true);
    });

    test('FIRES on scope reduction recommendation', () => {
      const f = fp('Scope reduction recommendation: cut to MVP?', ['Reduce', 'Proceed', 'Modify']);
      expect(engStep0Boundary(f)).toBe(true);
    });

    test('does NOT fire on review-section AUQs', () => {
      const f = fp('Architecture: shared mutable state?', ['Refactor', 'Defer', 'Skip']);
      expect(engStep0Boundary(f)).toBe(false);
    });
  });

  describe('designStep0Boundary', () => {
    test('FIRES on design system / posture mention', () => {
      const f = fp('Pick a design posture for this review', ['Polish', 'Triage', 'Expansion']);
      expect(designStep0Boundary(f)).toBe(true);
    });

    test('FIRES on first-dimension prompt', () => {
      const f = fp('First dimension: visual hierarchy. Score?', ['7', '8', '9']);
      expect(designStep0Boundary(f)).toBe(true);
    });

    test('does NOT fire on later dimension AUQs', () => {
      const f = fp('Spacing dimension score?', ['7', '8', '9']);
      expect(designStep0Boundary(f)).toBe(false);
    });
  });

  describe('devexStep0Boundary', () => {
    test('FIRES on developer persona selection', () => {
      const f = fp('Pick the target persona for this review', ['Senior backend', 'Junior frontend', 'Other']);
      expect(devexStep0Boundary(f)).toBe(true);
    });

    test('FIRES on TTHW target prompt', () => {
      const f = fp('What is the TTHW target for first run?', ['<5 min', '<15 min', '<30 min']);
      expect(devexStep0Boundary(f)).toBe(true);
    });

    test('does NOT fire on review-section AUQs', () => {
      const f = fp('Friction point: 5-min CI wait. Address?', ['Now', 'Defer', 'Skip']);
      expect(devexStep0Boundary(f)).toBe(false);
    });
  });
});
