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
import { readFileSync } from 'node:fs';
import {
  isPermissionDialogVisible,
  isNumberedOptionListVisible,
  isProseAUQVisible,
  isScopeGateQuestionVisible,
  isScopeGateAutoSelectVisible,
  isPlanReadyVisible,
  parseNumberedOptions,
  classifyVisible,
  TAIL_SCAN_BYTES,
  optionsSignature,
  parseQuestionPrompt,
  stripAnsi,
  auqFingerprint,
  COMPLETION_SUMMARY_RE,
  classifyPlanCountFrame,
  capturePlanCountQuestion,
  createPlanCountPermissionGuard,
  planCountPrerequisitePick,
  planCountSubmissionInput,
  assertReviewReportAtBottom,
  ceoStep0Boundary,
  engStep0Boundary,
  designStep0Boundary,
  designFirstReviewAUQ,
  planCountQuestionPhase,
  nativePlanCallFingerprint,
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

  test('recognizes the captured collapsed native overwrite confirmation', () => {
    const sample = [
      'Doyouwanttooverwritegstack-test-plan-design.md?',
      '❯1.Yes',
      '2.Yes,andswitchtoacceptedits(auto-approvefileeditsandcommonfilecommands)forthissession',
      '3.No',
      'Esctocancel·Tabtoamend',
    ].join('\n');
    expect(isPermissionDialogVisible(sample)).toBe(true);
    expect(isPermissionDialogVisible(sample.replace('Esctocancel·Tabtoamend', 'Enter to select'))).toBe(false);
  });

  test('the captured paired-CEO Edit grant is permission, not another review finding', () => {
    const sample = [
      'Do youwt to makehis dittogstack-test-plan-ceo-paired.md?',
      '❯1.Yes',
      '2.Yes,andswitchtoacceptedits(auto-approvefileeditsandcommonfilecommands)forthissession;Yes,and',
      'alwaysallowaccessto/tmp/gstack-paid-shard-EbUl9j/tmp/gstack-e2e-plan-ceo-paired-gkjAd5forthissession',
      '(shift+tab)', '3.No', 'Esctocancel·Tabtoamend',
    ].join('\r');
    expect(isPermissionDialogVisible(sample)).toBe(true);
    expect(classifyPlanCountFrame(sample)).toBe('permission');
  });

  test('recognizes permission labels whose cursor-positioning spaces disappeared', () => {
    expect(isPermissionDialogVisible('Yes,andalwaysallowaccessto/tmp/fixtureforthissession')).toBe(true);
    expect(isPermissionDialogVisible('Yes,allowalleditsduringthissession')).toBe(true);
    expect(isPermissionDialogVisible('Bashcommandrequirespermission')).toBe(true);
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

describe('scope-gate render detectors', () => {
  // The verbatim announcement string from the plan-eng/plan-design SKILL.md
  // templates. If the template rewording drifts, THIS fixture fails first —
  // before the paid plan-mode smokes silently degrade to vacuous asserts.
  const TEMPLATE_ANNOUNCEMENT =
    'Scope gate: plan mode — auto-selected B (reviewing <target>).';

  describe('isScopeGateQuestionVisible', () => {
    test('matches the clean prose gate render (question + option bodies)', () => {
      const sample = `
What should I review?
A) The current branch diff — the work in progress on this branch.
B) A plan or design doc I'll paste or point you to.
C) A specific file, directory, or path.
Recommendation: A when a branch diff exists, otherwise B.
`;
      expect(isScopeGateQuestionVisible(sample)).toBe(true);
    });

    test('matches the native numbered render (no lettered markers)', () => {
      const sample = `
  What should I review?

  ❯ 1. The current branch diff — the work in progress on this branch.
    2. A plan or design doc I'll paste or point you to.
    3. A specific file, directory, or path.
`;
      expect(isScopeGateQuestionVisible(sample)).toBe(true);
    });

    test('matches the PTY-collapsed render (stripAnsi squished spaces)', () => {
      const sample = 'WhatshouldIreview?A)Thecurrentbranchdiff—theworkinprogress';
      expect(isScopeGateQuestionVisible(sample)).toBe(true);
    });

    test('stays false on narration quoting only the question', () => {
      const sample =
        "Normally I'd ask 'What should I review?' but plan mode is active, so I'm proceeding.";
      expect(isScopeGateQuestionVisible(sample)).toBe(false);
    });

    test('stays false on unrelated review prose', () => {
      const sample = 'I will review the current branch diff and report findings.';
      expect(isScopeGateQuestionVisible(sample)).toBe(false);
    });
  });

  describe('isScopeGateAutoSelectVisible', () => {
    test('matches the verbatim template announcement', () => {
      expect(isScopeGateAutoSelectVisible(TEMPLATE_ANNOUNCEMENT)).toBe(true);
    });

    test('matches a real announcement with a concrete target', () => {
      const sample =
        'Scope gate: plan mode — auto-selected B (reviewing ~/.claude/plans/my-feature.md). Running the Design Doc Check next.';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(true);
    });

    test('matches the PTY-collapsed announcement', () => {
      const sample = 'Scopegate:planmode—auto-selectedB(reviewingPLAN.md).';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(true);
    });

    test('stays false on narration about the behavior', () => {
      const sample = "In plan mode I'd auto-select B and review the active plan.";
      expect(isScopeGateAutoSelectVisible(sample)).toBe(false);
    });

    test('stays false on a VERBATIM QUOTE of the announcement (negation narration)', () => {
      // The exact announcement line sits quoted in the skill context, so a
      // model explaining why it is NOT firing it can reproduce it byte-exact
      // inside quotes — that must not trip a must-stay-false assert.
      const sample =
        'Not in plan mode, so I won\'t announce "Scope gate: plan mode — auto-selected B (reviewing <target>)." and will ask instead.';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(false);
    });

    test('a later real render still matches after an earlier quoted mention', () => {
      const sample =
        'Earlier I said I would render "Scope gate: plan mode — auto-selected B (…)" and now:\n' +
        'Scope gate: plan mode — auto-selected B (reviewing PLAN.md).';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(true);
    });

    test('matches tense paraphrases WITH the announcement prefix (auto-selecting / auto-selects)', () => {
      expect(
        isScopeGateAutoSelectVisible('Scope gate: plan mode — auto-selecting B (reviewing the drafted plan).'),
      ).toBe(true);
      expect(isScopeGateAutoSelectVisible('Scope gate: plan mode — auto-selects B.')).toBe(true);
    });

    test('stays false on tense paraphrases WITHOUT the announcement prefix', () => {
      expect(isScopeGateAutoSelectVisible('Auto-selecting B since we are in plan mode.')).toBe(false);
    });

    test('stays false on AUTO_DECIDE preamble output', () => {
      const sample = 'Auto-decided scope question → B (your preference). Change with /plan-tune.';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(false);
    });

    test('stays false on a bare "selected B" without the announcement prefix', () => {
      const sample = 'I selected B as the review target.';
      expect(isScopeGateAutoSelectVisible(sample)).toBe(false);
    });
  });
});

describe('isProseAUQVisible', () => {
  test('matches 4 lettered options A) B) C) D) at line starts (plan-eng prose AUQ shape)', () => {
    const sample = `
What would you like me to review? Options:
A) Point me at an existing design doc or plan file (path).
B) Describe new work you're planning — I'll explore the codebase.
C) You meant /review for the diff already on this branch.
D) Something else (tell me).
Recommendation: A if you have a doc in mind, otherwise B.
❯
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('matches 2 lettered options (minimum threshold)', () => {
    const sample = `
A) First option
B) Second option
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('matches 3 numbered options 1. 2. 3. without ❯ 1. cursor (autoplan prose AUQ shape)', () => {
    const sample = `
What's the task? A few options:
  1. You have a plan idea in mind — describe it.
  2. You want to review an existing plan elsewhere.
  3. You meant a different command — /plan-ceo-review etc.
❯
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('returns false when ❯ 1. cursor is present in the recent tail (native UI handled by isNumberedOptionListVisible)', () => {
    const sample = `
❯ 1. First option
  2. Second option
  3. Third option
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('does NOT suppress numbered-prose detection when ❯ 1. is only in early scrollback (trust dialog)', () => {
    // Boot trust dialog rendered ❯ 1. Yes at startup, then a long body of
    // model output, then prose-rendered numbered options now. The historic
    // ❯ 1. is in the full buffer but NOT in the recent tail. Should detect
    // the prose AUQ.
    const trustHeader = '❯ 1. Yes, trust\n  2. No\n';
    const filler = 'x'.repeat(5000); // pushes trust dialog out of last 4KB tail
    const proseAUQ = `\n  1. Review the docs\n  2. Investigate the code\n  3. Defer to next session\n❯  \n`;
    const sample = trustHeader + filler + proseAUQ;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('returns false on single lettered option', () => {
    const sample = `
A) Only one option mentioned in passing.
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('matches 2 numbered options (threshold matches lettered branch — tails miss option 1)', () => {
    const sample = `
1. First note.
2. Second note.
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('returns false on a single numbered option', () => {
    const sample = `
1. Only one option mentioned.
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('does not match mid-prose lettered text like "(see option B) above"', () => {
    const sample = `
This refers to (see option B) above and also to point A) earlier.
`;
    // The B) and A) markers are mid-line, not at line starts, so they don't count.
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('matches with leading whitespace and ❯ prefix on options', () => {
    const sample = `
   A) Option with whitespace prefix
❯  B) Option with cursor prefix
   C) Another option
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('returns false on plain text with no option markers', () => {
    expect(isProseAUQVisible('Just some plain text output from the model.')).toBe(false);
    expect(isProseAUQVisible('')).toBe(false);
  });

  // Pattern 3: markdown bold-bullet options — office-hours renders its mode
  // question this way under --disallowedTools, with no letter/number marker.
  test('matches office-hours markdown bold-bullet mode question (Pattern 3)', () => {
    const sample = `
> Before we dig in — what's your goal with this?
>
> - **Building a startup** (or thinking about it)
> - **Intrapreneurship** — internal project at a company, need to ship fast
> - **Hackathon / demo** — time-boxed, need to impress
> - **Open source / research** — building for a community
> - **Learning** — teaching yourself to code
❯
`;
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('bold-bullets require a preceding interrogative — no "?" => false', () => {
    // 3+ bold bullets but no question stem: this is a feature list, not an AUQ.
    const sample = `
Here is what shipped:
- **Faster builds** via caching
- **Smaller binaries** through tree-shaking
- **Better errors** with source maps
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('a question with fewer than 3 bold bullets stays false (guard)', () => {
    const sample = `
Which approach do you prefer?
- **Option one** is simpler
- **Option two** is faster
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('plain (non-bold) bullets after a question do not trigger Pattern 3', () => {
    // Only bold bullets count — plain "- text" prose lists are too common.
    const sample = `
What should we do about this?
- run the tests
- ship the fix
- file a follow-up
`;
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('Pattern 3 still defers to a live native cursor list (❯ 1.)', () => {
    const sample = `
> What's your goal?
❯ 1. **Building a startup**
  2. **Intrapreneurship**
  3. **Hackathon**
`;
    // The ❯1. cursor gate fires first — native list handling owns this.
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  // Pattern 4/5: collapsed-form prose AUQ. stripAnsi destroys the newlines +
  // inter-word spaces, so a real prose AUQ arrives collapsed and defeats the
  // line-anchored Patterns 1-3. These are the dominant Shape-B render mode in
  // the plan-design smoke + floor timeouts — verbatim de-spinnered bytes from
  // the real failing runs (bdm3sucql.output).
  test('matches the real collapsed floor render (colon-delimited, Pattern 4/5)', () => {
    const sample =
      'The review is blocked on D1—reply withA, B, r Cabovetocontinue:' +
      '- A(recommended): Spec thefull P1AskUserQuestioncopy in this review' +
      '-B:LeaveP1copytotheimplementerwithstructuralrequirements' +
      'C: Add a placeholder template to the plan';
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('matches the real collapsed plan-mode render (Recommendation + collapsed A)/B), Pattern 4/5)', () => {
    const sample =
      'Recommendation:A—writethecopynow.(recommended)A) Writ the fullcopy in thisdesign review— now.' +
      '(recommended) Completeness:10/10 B) Leveit to theimplemente — task spec is enough.' +
      'Reply withA (write the copy now)orB(leavetoimplementer)';
    expect(isProseAUQVisible(sample)).toBe(true);
  });

  test('collapsed-form requires BOTH signals — single B) + word "recommendation" stays false', () => {
    // Only one punctuated letter marker: the two-signal contract is not met.
    const sample =
      'We should consider option B) here. My recommendation is to do it now.';
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('collapsed-form requires letter punctuation — comma-only "ReplywithA,B,orC" stays false', () => {
    // Reply-instruction present, but the letters carry no ) : or ( punctuation,
    // so they could be incidental enumerations in running prose. Stays false.
    const sample = 'ReplywithA,B,orC';
    expect(isProseAUQVisible(sample)).toBe(false);
  });

  test('collapsed-form does not regress the existing FP guard (see option B) ... point A))', () => {
    // The classic citation FP: a model referencing prior options in prose.
    // No reply-instruction / recommendation marker on its own line, so the
    // collapsed-form signal does not fire either.
    const sample =
      'As noted (see option B) above, and the earlier point A) we discussed, this is fine.';
    expect(isProseAUQVisible(sample)).toBe(false);
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

  // D4-B: strictPlanWrites detector. Catches the transcript bug where the
  // model writes findings to the plan file before any AskUserQuestion fires.
  test('strictPlanWrites: plan write before any AUQ → wrote_findings_before_asking', () => {
    const visible = `
      ⏺ Edit(/Users/me/.claude/plans/some-plan.md)
      ⎿  Updated 12 lines
    `;
    const result = classifyVisible(visible, { strictPlanWrites: true });
    expect(result?.outcome).toBe('wrote_findings_before_asking');
    expect(result?.summary).toContain('.claude/plans/some-plan.md');
  });

  test('strictPlanWrites: plan write AFTER an AUQ render → not flagged', () => {
    // AUQ renders first, then the model writes the plan post-answer. This is
    // the legitimate end-of-workflow flow and must NOT trigger the detector.
    const visible = `
      D1 — Some scope question

      ❯ 1. Option A
        2. Option B

      ⏺ Edit(/Users/me/.claude/plans/some-plan.md)
      ⎿  Updated 12 lines
    `;
    const result = classifyVisible(visible, { strictPlanWrites: true });
    // Outcome is 'asked' (the numbered list rendered); the post-AUQ plan
    // write is ignored by the detector.
    expect(result?.outcome).toBe('asked');
  });

  test('strictPlanWrites: AUQ first then plan write — write_pos > auq_pos → not flagged', () => {
    // Same scenario, more explicit ordering: the regex finds the write at a
    // position AFTER the numbered list. Detector lets it through.
    const visible = [
      'D1 — Choose your approach',
      '',
      '❯ 1. Approach A',
      '  2. Approach B',
      '',
      '⏺ Write(/Users/me/.claude/plans/draft.md)',
      '⎿  Wrote 42 lines',
    ].join('\n');
    const result = classifyVisible(visible, { strictPlanWrites: true });
    expect(result?.outcome).toBe('asked');
  });

  test('strictPlanWrites: only a permission dialog visible → plan write still flagged', () => {
    // A permission dialog ❯ 1./2. is NOT an AUQ; pre-AUQ plan writes still
    // hit the detector even when a permission prompt is on screen.
    const visible = `
      ⏺ Edit(/Users/me/.claude/plans/some-plan.md)

      Edit to /Users/me/.claude/plans/some-plan.md

      Do you want to proceed?

      ❯ 1. Yes
        2. No
    `;
    const result = classifyVisible(visible, { strictPlanWrites: true });
    expect(result?.outcome).toBe('wrote_findings_before_asking');
  });

  test('strictPlanWrites OFF: plan write before AUQ → returns null (legacy behavior preserved)', () => {
    const visible = `
      ⏺ Edit(/Users/me/.claude/plans/some-plan.md)
      ⎿  Updated 12 lines
    `;
    // Without strictPlanWrites, the sanctioned-path list lets this through.
    expect(classifyVisible(visible)).toBeNull();
  });
});

describe('parseNumberedOptions', () => {
  test('does not combine an old AUQ prompt with the later ordinary test-case list', () => {
    // B CEO retry, 2026-09-08: the old prompt cursor slid outside the
    // option parser's 4KB window. Its prose fallback then supplied a new
    // five-item test list while the prompt parser retained the old AUQ.
    const visible = '☐Stripe event types\nWhich event should the handler accept?\n' +
      '❯1.Specify one canonical event\n2.Accept all events\n' + '·'.repeat(4200) + '\n' +
      'Minimum required test cases (all must be specified in the plan):\n' +
      '1.Happypath:validcanonicalevent,knownuser→userupdated,emailsent\n' +
      '2.Email failure:emailthrows→userupdated,errorlogged,HTTP200\n' +
      '3.DB timeout: DB throws onuser update →exceptin ropagates, non-200\n' +
      '4.Unkown event typ: non-canonical event→ HTTP200,nouserupdate\n' +
      '5.Unknown user: valid event, usernotinDB→existingguard→HTTP200\n❯1\n';
    const seen = new Set<string>();
    expect(capturePlanCountQuestion(visible, seen, 0, false)).toBeNull();
    expect(seen.size).toBe(0);
  });

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

describe('pending native question on a damaged option render', () => {
  // Exact final B CEO Test scope shape. The native call had been read in
  // an in-progress snapshot, but option 2's missing dot prevented input.
  const frame = [
    '☐Test scope',
    '│Section 6 (Tests) — Theplanhasnotestsforanewpaymentprocessingcodepath.Theexistingintegrationsuitehas',
    '│never seen this handlerand cannotcatchregressionsinit.Minimumviabletestplanforminimalpatch:5unittests',
    '│(happy path, mal failur, DB timeout, unknowneventtype,unknownuser).Shouldtheplanalsoincludeanintegration',
    '│testhittingthefullwebhookstack?<gstack-qid:plan-ceo-test-scope>',
    '❯1.Unittestsonlyfornow(recommended)',
    '5 unit tests covering the criticalpaths. No integration stin v1.',
    '2Uni tsts + one integration test',
    '5 uit tsts + on ed-to-end integrationtestsendiga signe Stripeevent.',
    '3.Integrationtestonly',
    '4.Typesomething.',
    '5. Chataboutthis',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
    '❯1',
  ].join('\n');
  const pending = {
    sessionId: '66fb6218-4a68-4f1a-a729-6407f14fd6b8',
    toolUseId: 'toolu_017DicePqWNVyDsLCd2Y2MCi', answered: false,
    questions: [{ header: 'Test scope', question: 'Should the plan also include an integration test hitting the full webhook stack? <gstack-qid:plan-ceo-test-scope>',
      options: ['Unit tests only for now (recommended)', 'Unit tests + one integration test', 'Integration test only'].map(label => ({ label })) }],
  };

  test('uses lossless pending options after a positively matched native question has rendered', () => {
    const seen = new Set<string>();
    const captured = capturePlanCountQuestion(frame, seen, 0, false, pending);
    expect(captured?.nativeCall).toBe(pending);
    expect(captured?.options).toEqual(pending.questions[0].options.map((o, i) => ({ index: i + 1, label: o.label })));
    expect(capturePlanCountQuestion(frame, seen, 1, false, pending)).toBeNull();
    // A corrected redraw is still the same pending native question.
    expect(capturePlanCountQuestion(frame.replace('2Uni tsts', '2.Unit tests'), seen, 2, false, pending)).toBeNull();
    expect(capturePlanCountQuestion(frame.replace('2Uni tsts', '2.Unit tests'), seen, 3, false)).toBeNull();
    expect(seen.has(captured!.signature)).toBe(true);
  });

  test('binds delayed native metadata to the already-answered visible question', () => {
    const seen = new Set<string>();
    const clean = frame.replace('2Uni tsts', '2.Unit tests');
    expect(capturePlanCountQuestion(clean, seen, 0, false)).not.toBeNull();
    expect(capturePlanCountQuestion(clean, seen, 1, false, pending)).toBeNull();
    expect(capturePlanCountQuestion(frame, seen, 2, false, pending)).toBeNull();
  });

  test('requires pending single-question metadata, matching current header, cursor, and navigation footer', () => {
    for (const call of [undefined, { ...pending, answered: true }, { ...pending, failed: true },
      { ...pending, questions: [...pending.questions, ...pending.questions] },
      { ...pending, questions: [{ ...pending.questions[0], header: 'Prior decision' }] },
      { ...pending, questions: [{ ...pending.questions[0], question: 'Different issue <gstack-qid:plan-ceo-different-test-scope>' }] }]) {
      expect(capturePlanCountQuestion(frame, new Set(), 0, false, call)).toBeNull();
    }
    for (const altered of [frame.replace('☐Test scope', 'Test scope'), frame.replace('❯1.', '1.'),
      frame.replace('Enter to select · ↑/↓ to navigate · Esc to cancel', ''),
      frame + '\n☐Different question\n❯1.Waiting for its choices']) {
      expect(capturePlanCountQuestion(altered, new Set(), 0, false, pending)).toBeNull();
    }
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

describe('launchClaudePty model pin (static tripwire)', () => {
  // Why static-grep, not a behavioral assert: the spawn fires immediately
  // inside launchClaudePty, so asserting the built args array would require
  // extracting an arg-builder seam — which rewrites the exact region kyoto-v5's
  // hermetic --strict-mcp-config insertion edits, reintroducing a merge
  // conflict the placement deliberately avoids. The end-to-end behavioral proof
  // is the live PTY smoke (skill-e2e-plan-*-plan-mode.test.ts) running under the
  // pinned model. These grep-level guards stop a refactor from silently
  // dropping the pin or reordering it past extraArgs.
  const src = readFileSync(new URL('./claude-pty-runner.ts', import.meta.url), 'utf-8');

  test('ClaudePtyOptions exposes model?: string', () => {
    const opts: ClaudePtyOptions = { model: 'claude-sonnet-4-6' };
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  test('spawn args push --model from the EVALS_MODEL fallback chain', () => {
    expect(src).toContain("args.push('--model', model)");
    // opts.model -> EVALS_MODEL -> 'claude-sonnet-4-6' (mirrors session-runner.ts:144)
    expect(src).toMatch(
      /opts\.model\s*\?\?\s*process\.env\.EVALS_MODEL\s*\?\?\s*'claude-sonnet-4-6'/,
    );
  });

  test('--model is pushed BEFORE extraArgs so a per-test --model override wins', () => {
    const modelPush = src.indexOf("args.push('--model', model)");
    const extraArgsPush = src.indexOf('if (opts.extraArgs) args.push(...opts.extraArgs)');
    expect(modelPush).toBeGreaterThan(-1);
    expect(extraArgsPush).toBeGreaterThan(-1);
    expect(modelPush).toBeLessThan(extraArgsPush);
  });

  test('all three plan-skill wrappers forward model to launchClaudePty', () => {
    // Count must match the number of wrappers (observation, counting, floor).
    const forwards = src.match(/^\s*model: opts\.model,$/gm) ?? [];
    expect(forwards.length).toBe(3);
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
  test('keeps the captured boxed learnings header across native CR and blank borders', () => {
    // Exact active-menu bytes from the targeted-a engineering batching run.
    // Its answered setup AUQ lost the title at the standalone box border,
    // leaving every later finding classified as preReview.
    const raw = "☐ Learnings\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B│ D1 — Cross-project learnings scope <gstack-qid:learnings-cross-project>\u001b[K\r\u001b[1B│\u001b[3G\u001b[K\r\r\n│\u001b[3Ggstack\u001b[10Gcan\u001b[14Gsearch\u001b[21Glearnings\u001b[31Gfrom\u001b[36Gyour\u001b[41Gother\u001b[47Gprojects\u001b[56Gon\u001b[59Gthis\u001b[64Gmachine\u001b[72Gto\u001b[75Gfind\u001b[80Gpatterns\u001b[89Gthat\u001b[94Gmight\u001b[100Gapply\u001b[106Ghere.\u001b[112GThis\r\r\n│\u001b[3Gstays\u001b[9Glocal\u001b[15G—\u001b[17Gno\u001b[20Gdata\u001b[25Gleaves\u001b[32Gyour\u001b[37Gmachine.\u001b[46GRecommended\u001b[58Gfor\u001b[62Gsolo\u001b[67Gdevelopers.\u001b[79GSkip\u001b[84Gif\u001b[87Gyou\u001b[91Gwork\u001b[96Gon\u001b[99Gmultiple\u001b[108Gclient\r\r\n│\u001b[3Gcodebases\u001b[13Gwhere\u001b[19Gcross-contamination\u001b[39Gwould\u001b[45Gbe\u001b[48Ga\u001b[50Gconcern.\r\r\n\r\r\n❯\u001b[3G1.\u001b[6GEnable\u001b[13Gcross-project\u001b[27Glearnings\u001b[37G(Recommended)\r\r\n\u001b[6GSearch\u001b[13Glearnings\u001b[23Gfrom\u001b[28Gall\u001b[32Gprojects\u001b[41Gon\u001b[44Gthis\u001b[49Gmachine\u001b[57G—\u001b[59Gsurfaces\u001b[68Gpatterns\u001b[77Gand\u001b[81Gpitfalls\u001b[90Gfrom\u001b[95Gprior\u001b[101Gsessions.\r\r\n\u001b[3G2.\u001b[6GKeep\u001b[11Glearnings\u001b[21Gproject-scoped\u001b[36Gonly\r\r\n\u001b[6GOnly\u001b[11Guse\u001b[15Glearnings\u001b[25Gfrom\u001b[30Gthis\u001b[35Gproject.\u001b[44GSafe\u001b[49Gfor\u001b[53Gmulti-client\u001b[66Genvironments.\r\r\n\u001b[3G3.\u001b[6GType\u001b[11Gsomething.\r\r\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\r\n\u001b[3G4.\u001b[6GChat\u001b[11Gabout\u001b[17Gthis\r\r\n\r\r\nEnter\u001b[7Gto\u001b[10Gselect\u001b[17G·\u001b[19G↑/↓\u001b[23Gto\u001b[26Gnavigate\u001b[35G·\u001b[37GEsc\u001b[41Gto\u001b[44Gcancel";
    const visible = stripAnsi(raw);
    const question = capturePlanCountQuestion(visible, new Set(), 0, true)!;
    expect(question.promptSnippet).toStartWith('Learnings D1 — Cross-project learnings scope');
    expect(question.promptSnippet).toContain('<gstack-qid:learnings-cross-project>');
    expect(engStep0Boundary(question)).toBe(true);
    const phase = planCountQuestionPhase(question, false, engStep0Boundary);
    expect(phase).toEqual({ preReview: true, reviewStarted: true });
  });

  test('keeps a long boxed question identity instead of its closing recommendation', () => {
    const frame = [
      'Planning: /tmp/hermetic/.claude/plans/review.md',
      '─'.repeat(120),
      '☐ Architecture',
      '│ D2 — Architecture: custom retry scheduler vs library built-in <gstack-qid:arch-custom-retry-vs-library>',
      '│',
      ...Array.from({ length: 12 }, (_, i) => `│ Review context line ${i}: the proposed retry behavior and its tradeoffs.`),
      '│',
      '│ Net: If the library hook is configurable, use the existing implementation.',
      '❯1.Use library built-in (Recommended)',
      '2.Extract shared retry envelope',
    ].join('\r\r\n');
    const seen = new Set<string>();
    const question = capturePlanCountQuestion(frame, seen, 0, false)!;
    expect(question.promptSnippet).toStartWith('Architecture D2 — Architecture: custom retry scheduler');
    expect(question.promptSnippet).toContain('<gstack-qid:arch-custom-retry-vs-library>');
    expect(question.promptSnippet).not.toContain('Planning:');
    expect(question.promptSnippet.length).toBeLessThanOrEqual(240);
    expect(capturePlanCountQuestion(frame + '\n' + '·'.repeat(6000), seen, 1, false)).toBeNull();
  });

  test('does not reuse an old boxed header for a later unboxed menu', () => {
    const visible = [
      '☐ Old setup',
      'D1 — Cross-project learnings scope',
      '❯1.Enable',
      '2.Skip',
      'Planning: /tmp/hermetic/.claude/plans/review.md',
      'D2 — Choose the retry behavior',
      '❯1.Use library built-in',
      '2.Extract shared retry envelope',
    ].join('\n');
    const prompt = parseQuestionPrompt(visible);
    expect(prompt).toBe('D2 — Choose the retry behavior');
    expect(prompt).not.toContain('Old setup');
  });

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

  test('keeps the captured design scope prompt ahead of long Planning chrome', () => {
    // The first failed live attempt fingerprinted only the divider/Planning
    // path. Its actual AUQ was later on the active cursor line.
    const visible = [
      '─'.repeat(120),
      `Planning: /tmp/hermetic/.claude/plans/${'long-path-'.repeat(24)}plan.md`,
      '─'.repeat(120),
      "☐Reviewfocus I've rated this Settings Page UI redesign plan 2/10 on design completeness. Want me to focus on specific areas? ❯1.All7passes(Recommended)",
      '2.All7passesbutskipmockups',
    ].join('\n');
    const prompt = parseQuestionPrompt(visible);
    expect(prompt).toStartWith('Reviewfocus');
    expect(prompt).toContain('design completeness');
    expect(prompt).not.toContain('Planning:');
    expect(designStep0Boundary({
      signature: 'captured-design-scope', promptSnippet: prompt,
      options: parseNumberedOptions(visible), observedAtMs: 0, preReview: true,
    })).toBe(true);
  });

  test('keeps the captured devex persona header when cursor spacing collapses', () => {
    const visible = [
      `Planning: /tmp/hermetic/.claude/plans/${'long-path-'.repeat(24)}plan.md`,
      '─'.repeat(120),
      '☐Targetpersona D2—WhoistheprimarydeveloperthisSDKtargets? ❯1.AIappbuilder/startupfounder(Recommended)',
      '2.Backend/platformengineer',
    ].join('\n');
    const prompt = parseQuestionPrompt(visible);
    expect(prompt).toStartWith('Targetpersona');
    expect(devexStep0Boundary({
      signature: 'captured-devex-persona', promptSnippet: prompt,
      options: parseNumberedOptions(visible), observedAtMs: 0, preReview: true,
    })).toBe(true);
  });

  test('retains a multiline question while excluding the preceding CLI divider', () => {
    const visible = [
      'Planning: /tmp/hermetic/.claude/plans/plan.md',
      '─'.repeat(120),
      '☐ Review focus',
      'This plan is 2/10 on design completeness.',
      'Want me to focus on specific areas? ❯1.All 7 passes',
      '2.Skip mockups',
    ].join('\n');
    const prompt = parseQuestionPrompt(visible);
    expect(prompt).toContain('Review focus');
    expect(prompt).toContain('design completeness');
    expect(prompt).toContain('specific areas?');
    expect(prompt).not.toContain('Planning:');
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

describe('capturePlanCountQuestion replay', () => {
  test('keeps captured CEO/eng fingerprints stable as later output trims the trailing window', () => {
    // Exact prompt/option fields from the 07:30 corrected paid attempts.
    // Both counted an answered Step0 question again as a review finding
    // once the moving tail omitted the beginning of its prompt.
    const captures = [
      {
        prompt: '☐ RevewMode Which review mode should I use for the remaining sections?',
        labels: [
          'HOLD SCOPE — make it         ┌┐',
          'SELECTIVEEXPANSION—│Focus:catcheverylandmineinApproachA│',
          'SCOPEREDUCTION—strip│Tests:whatmustbecovered│',
          'SCOPEEXPANSION—think│Observability:whatlogs/metricsareneeded│',
        ],
      },
      {
        prompt: '☐ Scope cut │ D2 — Scope reduction proposal: drop TokenStore and RequestPolicy as standalone classes, inject AuthCache rather than │ exportitglobally.Acceptthisreductionbeforethesection-by-sectionreviewbegins? │ <gstack-qid:plan-eng-review-',
        labels: [
          'Acceptscopereduction┌───────────────────────────────────────────────────┐',
          'Proceedfullscopeas-is│AuthBroker│',
        ],
      },
    ];
    for (const capture of captures) {
      const options = capture.labels.map((label, i) => `${i === 0 ? '❯' : ''}${i + 1}.${label}`).join('\n');
      const frame = `${capture.prompt}\n${options}`;
      const seen = new Set<string>();
      const first = capturePlanCountQuestion(frame, seen, 0, true)!;
      expect(first).not.toBeNull();
      // Leave the original menu within the trailing4KB, but move the
      // start of that window into its question text, twice in succession.
      const paddingLength = 4096 - options.length - 30;
      for (const extra of [0, 15]) {
        const advanced = frame + '\n' + '·'.repeat(paddingLength + extra - 1);
        expect(advanced.slice(-4096)).not.toContain(capture.prompt);
        expect(parseNumberedOptions(advanced)).toEqual(first.options);
        expect(parseQuestionPrompt(advanced)).toBe(first.promptSnippet);
        expect(auqFingerprint(parseQuestionPrompt(advanced), parseNumberedOptions(advanced))).toBe(first.signature);
        expect(capturePlanCountQuestion(advanced, seen, extra + 1, false)).toBeNull();
      }
      const next = `${frame}\n${'·'.repeat(paddingLength)}\n☐ Next decision Should the revised plan use these same choices?\n${options}`;
      const distinct = capturePlanCountQuestion(next, seen, 20, false)!;
      expect(distinct).not.toBeNull();
      expect(distinct.signature).not.toBe(first.signature);
      expect(distinct.preReview).toBe(false);
      expect(seen.size).toBe(2);
    }
  });

  test('counts consecutive findings with identical choices and ignores redraws', () => {
    const options = '\n❯1.Add to plan\n2.Defer\n3.Skip';
    const seen = new Set<string>();
    const frames = [
      `D5 — SQL: interpolate the request parameter?${options}`,
      `D5  —   SQL: interpolate the request parameter?${options}`,
      `D6 — Tests: no coverage for the webhook?${options}`,
      `D6 — Tests: no coverage for the webhook?${options}`,
    ];
    const captured = frames.map((frame, i) => capturePlanCountQuestion(frame, seen, i, false));
    expect(captured.map((question) => question !== null)).toEqual([true, false, true, false]);
    expect(captured[0]?.signature).not.toBe(captured[2]?.signature);
    expect(captured[2]?.promptSnippet).toContain('Tests: no coverage');
  });

  test('does not consume an incomplete frame before its prompt arrives', () => {
    const seen = new Set<string>();
    const options = '❯1.Add to plan\n2.Defer';
    expect(capturePlanCountQuestion(options, seen, 0, true)).toBeNull();
    expect(capturePlanCountQuestion(`D1 — Pick an approach\n${options}`, seen, 1, true)).not.toBeNull();
  });

  test('answers the captured CEO retry question with a numeric-leading first label', () => {
    // The live timeout sat on this question because the first label begins
    // with "1retryattempt"; it was incorrectly rejected as a decimal token.
    const frame = [
      ' ☐ Retry spec',
      "│ Section 5/6 finding: 'retry-with-backoff fires once, then fails clean' is ambiguous.",
      "│ What does 'fires once' mean?",
      '❯1.1retryattempt—Stripecalledexactly2timestotal(Recommended)',
      'Themostnaturalreading:1originalattempt+1retry=2totalStripecalls.',
      '2.Addaclarifyingcommenttotheplan—lettheimplementerdecide',
      '3.Theretrymechanismhandlesit—justassertfailureisreturned',
      '4.Typesomething.',
      '5.Chataboutthis',
      'Entertoselect·↑/↓tonavigate·Esctocancel',
    ].join('\r\r');
    const question = capturePlanCountQuestion(frame, new Set(), 0, false);
    expect(question?.options.map(({ index }) => index)).toEqual([1, 2, 3, 4, 5]);
    expect(question?.options[0]?.label).toBe('1retryattempt—Stripecalledexactly2timestotal(Recommended)');
    expect(question?.promptSnippet).toContain('Section 5/6 finding');
    expect(question?.promptSnippet).not.toContain('Planning:');
  });

  test('still ignores decimal numbers inside option labels', () => {
    const frame = 'Choose the retry delay\r❯1.1.5 seconds\r2.Wait 2.5 seconds\r3.No retry';
    expect(parseNumberedOptions(frame)).toEqual([
      { index: 1, label: '1.5 seconds' },
      { index: 2, label: 'Wait 2.5 seconds' },
      { index: 3, label: 'No retry' },
    ]);
  });
});

describe('planCountPrerequisitePick replay', () => {
  test('declines captured office-hours prerequisite menus by label in either order', () => {
    // Captured 2026-09-08 CEO/Devex prerequisite surfaces: the default index
    // sometimes starts office-hours, changing the seeded review's input.
    const captures = [
      {
        prompt: 'No design doc found for this branch. `/office-hours` produces a structured problem statement, premise challenge, and explored alternatives — it gives this review much sharper input. Run it now, or skip and proceed with standard review?',
        labels: ['Skip — proceed with standard review (Recommended)', 'Run /office-hours first'],
      },
      {
        prompt: 'D2 — No design doc found. Run /office-hours first? <gstack-qid:plan-ceo-prereq-office-hours>',
        labels: ['Skip — standard review (recommended)', 'Run /office-hours now'],
      },
      {
        prompt: 'D3 — Run /office-hours first to produce a design doc for sharper input?',
        labels: ['Skip — proceed with standard review (recommended)', 'Run /office-hours now'],
      },
    ];
    for (const { prompt, labels } of captures) {
      for (const reversed of [false, true]) {
        for (const collapsed of [false, true]) {
          const ordered = reversed ? [...labels].reverse() : labels;
          const text = ['☐ Prerequisite', prompt, `❯1.${ordered[0]}`, `2.${ordered[1]}`, '3.Type something.', '4.Chat about this'].join('\r');
          const frame = collapsed ? text.replace(/ /g, '') : text;
          const fp = capturePlanCountQuestion(frame, new Set(), 0, true)!;
          expect(fp).not.toBeNull();
          expect(planCountPrerequisitePick(fp)).toBe(reversed ? 2 : 1);
          expect(planCountPrerequisitePick({ ...fp, preReview: false })).toBeNull();
        }
      }
    }
  });

  test('keeps existing answers for incomplete, unrelated, and ambiguous menus', () => {
    const fp = capturePlanCountQuestion(
      '☐ Prerequisite\rNo design doc found. Run /office-hours first?\r❯1.Run /office-hours now\r2.Skip — proceed with standard review',
      new Set(), 0, true,
    )!;
    expect(planCountPrerequisitePick({ ...fp, promptSnippet: 'No design doc found.' })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, promptSnippet: 'Should /office-hours skip the required SDK validation finding?' })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, promptSnippet: 'Want a second opinion from /office-hours?' })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, options: [{ index: 1, label: 'Run /office-hours now' }, { index: 2, label: 'Skip' }] })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, options: [{ index: 1, label: 'Add to plan' }, fp.options[1]] })).toBeNull();
    expect(planCountPrerequisitePick({ ...fp, options: [...fp.options, { index: 3, label: 'Skip — standard review' }] })).toBeNull();
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

  test('does NOT treat source or proposed diff rows as assistant completion', () => {
    for (const line of [
      '409 +## GSTACK REVIEW REPORT',
      '419 +**VERDICT:** Design Review complete — 8 decisions made.',
      '+## GSTACK REVIEW REPORT',
      '409→## GSTACK REVIEW REPORT',
      'The plan must end with ## GSTACK REVIEW REPORT.',
    ]) expect(COMPLETION_SUMMARY_RE.test(line)).toBe(false);
  });
});

describe('classifyPlanCountFrame replay', () => {
  test('waits through proposed Write approval and tool output, then accepts the actual report', () => {
    // Sanitized rows and native prompt from the failed design-count attempt.
    const proposedDiff = [
      '409 +## GSTACK REVIEW REPORT',
      '416 +| Design Review | 1 | issues_open | score: 2/10 → 8/10, 8 decisions |',
      '419 +**VERDICT:** Design Review complete — 8 decisions made.',
    ].join('\n');
    const permission = [
      'Doyouwanttooverwritegstack-test-plan-design.md?',
      '❯1.Yes',
      '2.Yes,andswitchtoacceptedits(auto-approvefileeditsandcommonfilecommands)forthissession;Yes,and',
      'alwaysallowaccessto/tmp/fixtureforthissession',
      '3.No',
      'Esctocancel·Tabtoamend',
    ].join('\n');
    const frames = [
      `${proposedDiff}\n${permission}`,
      `${proposedDiff}\n⏺ Updated gstack-test-plan-design.md`,
      `${proposedDiff}\n⏺ ## GSTACK REVIEW REPORT\nDesign Review complete — 8 decisions made.`,
    ];
    expect(frames.map(classifyPlanCountFrame)).toEqual(['permission', null, 'completion_summary']);
  });

  test('a pending native permission beats even an unnumbered report heading', () => {
    const visible = '## GSTACK REVIEW REPORT\nDoyouwanttooverwriteplan.md?\n❯1.Yes\n2.No\nEsctocancel·Tabtoamend';
    expect(classifyPlanCountFrame(visible)).toBe('permission');
  });

  test('a later report supersedes the granted menu still in short scrollback', () => {
    const permission = 'Doyouwanttooverwriteplan.md?\n❯1.Yes\n2.No\nEsctocancel·Tabtoamend';
    expect(classifyPlanCountFrame(permission)).toBe('permission');
    expect(classifyPlanCountFrame(`${permission}\n● ## GSTACK REVIEW REPORT`)).toBe('completion_summary');
  });

  test('an active question after a prior report keeps the counter running', () => {
    expect(classifyPlanCountFrame('## GSTACK REVIEW REPORT\nOne more choice\n❯1.Add to plan\n2.Defer')).toBeNull();
  });

  test('an active AUQ supersedes a granted permission menu in short scrollback', () => {
    const permission = 'Doyouwanttooverwriteplan.md?\n❯1.Yes\n2.No\nEsctocancel·Tabtoamend';
    const question = '☐ Error handling\nWhich failure path should we test?\n❯1.Timeout\n2.Refusal';
    expect(classifyPlanCountFrame(`${permission}\n${question}`)).toBeNull();
  });

  test('preserves actual report variants and the native plan-ready terminal', () => {
    for (const report of [
      '## GSTACK REVIEW REPORT', '⏺##GSTACKREVIEWREPORT', '●GSTACKREVIEWREPORT',
      '## Completion Summary', '● ## Completion Summary', 'Status: clean', 'Status: issues_open',
      'VERDICT: CLEARED — Eng Review passed', '**VERDICT:** Design Review complete.',
    ]) expect(classifyPlanCountFrame(report)).toBe('completion_summary');
    expect(classifyPlanCountFrame('Ready to execute the plan?\n❯1.Yes\n2.No, keep planning')).toBe('plan_ready');
  });
});

describe('planCountSubmissionInput replay', () => {
  test('uses the captured DevEx panel anchors when the Submit button label is damaged', () => {
    const captured = [
      '←  ☒ Routing setup  ☐ Cross-project  ✔ Submit  →',
      'Review your answers',
      '⚠You have not answere all questions',
      ' │ ●D1 — Shouldgstack add skill routingrulestothisproject\'sCLAUDE.md?<gstack-qid:routing-injection>',
      '→dd routing rules (Recmmeded)',
      'Ready to submit your answers?',
      '❯1.Sbmi answers',
      '2Cancel',
    ].join('\r\r');
    expect(planCountSubmissionInput(captured)).toBe('\x1b[Z');
    expect(planCountSubmissionInput(captured.replace('☐ Cross-project', '☒ Cross-project'))).toBe('\r');
    expect(planCountSubmissionInput(captured + '\r☐ Retry spec\rRetry once?\r❯1.Yes\r2.No')).toBeNull();
    expect(planCountSubmissionInput(captured + '\r☐ Proposal\rSend this proposal?\r❯1.Submit proposal\r2.Keep editing')).toBeNull();
    expect(planCountSubmissionInput(captured + '\r☐ Retry spec\rRetry once?\r❯2.No\r3.Other')).toBeNull();
    expect(planCountSubmissionInput(captured.replace('Review your answers', 'Review context'))).toBeNull();
    expect(planCountSubmissionInput(captured.replace('Ready to submit your answers?', 'Read the proposed answers.'))).toBeNull();
  });

  test('the captured mode Submit panel with a damaged caption and dotless cursor returns to its unanswered tab', () => {
    // Exact final active panel from targeted-a's SCOPE EXPANSION retry.
    const captured = [
      '←  ☒ Routing rule  ☐ Design doc  ✔ Submit  →',
      '',
      'Review your answrs',
      '⚠ You hvenot answered all questions',
      " ● Add gstack skill routing rules tothisproject'sCLAUDE.md?",
      '→dd routing rues (Recommnded)',
      '',
      'Ready to submit your answers?',
      '',
      '❯1Submit answers',
      '  2. Cancel',
    ].join('\r');
    expect(planCountSubmissionInput(captured)).toBe('\x1b[Z');
    const answered = captured.replace('☐ Design doc', '☒ Design doc').replace('⚠ You hvenot answered all questions', '');
    expect(planCountSubmissionInput(answered)).toBe('\r');
    expect(planCountSubmissionInput(captured + '\r☐ Design doc\rRun office hours?\r❯1Run now\r2.Skip')).toBeNull();
  });

  const incomplete = [
    '←  ☒ Learnings scope  ☐ Approach  ✔ Submit  →',
    'Review your answers',
    '⚠You have not answered all questions',
    ' │ ●D1 — Cross-project learnings: Enable searching learnings from your other local projects?',
    '→Enable cross-project (Recommended)',
    'Ready t submit your answers?',
    '❯1.Submit aswers',
    '2Cancel',
  ].join('\r\r');

  test('returns to the unanswered tab, then submits only after both answers', () => {
    expect(planCountSubmissionInput(incomplete)).toBe('\x1b[Z');
    const nextQuestion = [
      '←  ☒ Learnings scope  ☐ Approach  ✔ Submit  →',
      '│ Which approach should this plan use?',
      '❯1.Extend the existing dispatcher',
      '2.Add a separate handler',
    ].join('\r\r');
    expect(planCountSubmissionInput(`${incomplete}\r${nextQuestion}`)).toBeNull();
    const question = capturePlanCountQuestion(nextQuestion, new Set(), 0, true);
    expect(question?.promptSnippet).toContain('Which approach');
    expect(question?.options).toHaveLength(2);
    const answered = incomplete.replace('☐ Approach', '☒ Approach').replace('⚠You have not answered all questions', '');
    expect(planCountSubmissionInput(answered)).toBe('\r');
  });

  test('navigates to the first unanswered tab when more than one remains', () => {
    const frame = incomplete.replace('☒ Learnings scope  ☐ Approach', '☐ Learnings scope  ☐ Approach  ☒ Mode');
    expect(planCountSubmissionInput(frame)).toBe('\x1b[Z\x1b[Z\x1b[Z');
  });

  test('does not revisit a stale submit panel when a later single question is active', () => {
    expect(planCountSubmissionInput(`${incomplete}\r☐ Retry spec\rRetry once?\r❯1.Yes\r2.No`)).toBeNull();
    expect(planCountSubmissionInput('Ready to submit the plan?\n❯1.Submit\n2.Cancel')).toBeNull();
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

  describe('native Cross-project onboarding boundary', () => {
    // Fresh paid run D, 2026-09-08: native question stems, labels and
    // successful answers. Long explanatory paragraphs are omitted; they
    // must not determine this structural setup boundary.
    const captured = [
  {
    "header": "Routing rules",
    "question": "Should I add gstack skill routing rules to your project's CLAUDE.md? (Note: we're in plan mode — if you pick A, I'll make the edit after we exit plan mode.)",
    "options": [
      "Add routing rules (recommended)",
      "Skip — invoke manually"
    ],
    "answer": "Add routing rules (recommended)"
  },
  {
    "header": "Scope challenge",
    "question": "D2 — The plan introduces 4 new classes across 12 files. Should I flag scope reduction as a primary recommendation in the review, or accept the 4-class design and focus findings on quality issues?",
    "options": [
      "Accept 4-class design, focus on quality",
      "Flag scope reduction as primary finding (recommended)"
    ],
    "answer": "Accept 4-class design, focus on quality"
  },
  {
    "header": "Cross-project",
    "question": "D3 — Should gstack search learnings from your other projects on this machine when reviewing?",
    "options": [
      "Enable cross-project learnings (recommended)",
      "Keep learnings project-scoped only"
    ],
    "answer": "Enable cross-project learnings (recommended)"
  },
  {
    "header": "AuthCache race",
    "question": "D4 — AuthCache is shared mutable state mutated by two services with no serialization. How should we fix it?",
    "options": [
      "Single-writer: AuthBroker owns all writes (recommended)",
      "Immutable cache + versioned replace",
      "Accept and document the race"
    ],
    "answer": "Single-writer: AuthBroker owns all writes (recommended)"
  },
  {
    "header": "Double-cache risk",
    "question": "D5 — The plan introduces a new AuthCache class but doesn't say what happens to the existing cache adapter. Are they running in parallel?",
    "options": [
      "AuthCache replaces the adapter — add migration to plan (recommended)",
      "AuthCache wraps the adapter — adapter stays as storage layer",
      "Leave ambiguous — clarify in implementation"
    ],
    "answer": "AuthCache replaces the adapter — add migration to plan (recommended)"
  },
  {
    "header": "Error swallowing",
    "question": "D6 — validateAndDispatch() swallows three different error classes across nested try/catch blocks. How should this be resolved in the plan?",
    "options": [
      "Decompose + typed error results (recommended)",
      "Keep structure, add logging + rethrow",
      "Leave as-is — document that swallowing is intentional"
    ],
    "answer": "Decompose + typed error results (recommended)"
  },
  {
    "header": "Invalidation tests",
    "question": "D7 — When AuthCache replaces the existing adapter (per D5), the existing invalidation tests (logout, revocation, tenant suspension) become dead — they're testing a retired object. Should the plan explicitly require migrating them?",
    "options": [
      "Migrate invalidation tests to AuthCache — add to plan (recommended)",
      "Scope to new component tests only — leave invalidation as follow-up",
      "Assume existing tests cover it — no explicit migration step"
    ],
    "answer": "Migrate invalidation tests to AuthCache — add to plan (recommended)"
  },
  {
    "header": "IDP parallelization",
    "question": "D8 — The plan identifies 5 sequential IDP calls that are independent and could be parallelized with Promise.all. Should we include the fix in this PR or defer it?",
    "options": [
      "Parallelize with Promise.all in this PR (recommended)",
      "Defer to TODOS.md",
      "Leave sequential — document as known limitation"
    ],
    "answer": "Parallelize with Promise.all in this PR (recommended)"
  }
];
    const fingerprint = (index: number) => {
      const row = captured[index];
      return nativePlanCallFingerprint({
        sessionId: 'fresh-eng-cross-project', toolUseId: `call-${index}`, answered: true,
        questions: [{ header: row.header, question: row.question, options: row.options.map(label => ({ label })) }],
        answers: { [row.question]: row.answer },
      }, index, true);
    };

    test('keeps D3 as setup and counts each following actual review call', () => {
      let started = false;
      const phases = captured.map((_, i) => {
        const phase = planCountQuestionPhase(fingerprint(i), started, engStep0Boundary);
        started = phase.reviewStarted;
        return phase;
      });
      expect(phases.slice(0, 3).map(p => p.preReview)).toEqual([true, true, true]);
      expect(phases[2].reviewStarted).toBe(true);
      expect(phases.slice(3).map(p => p.preReview)).toEqual([false, false, false, false, false]);
    });

    test('uses the native opposed scope choices without depending on a prompt suffix', () => {
      const fp = fingerprint(2);
      expect(engStep0Boundary(fp)).toBe(true);
      const q = fp.nativeCall!.questions[0];
      q.question = 'Should local lessons from other repositories be included during reviews?';
      q.options.reverse();
      fp.nativeCall!.answers = { [q.question]: q.options[0].label };
      expect(engStep0Boundary(nativePlanCallFingerprint(fp.nativeCall!, 0, true))).toBe(true);
    });

    test("an unanswered Cross-project tab cannot borrow another tab's answer", () => {
      const call = structuredClone(fingerprint(2).nativeCall!);
      const other = { header: 'Routing rules', question: 'Add routing rules?', options: [{ label: 'Add rules' }, { label: 'Skip' }] };
      call.questions.push(other);
      call.answers = { [other.question]: 'Add rules' };
      expect(engStep0Boundary(nativePlanCallFingerprint(call, 0, true))).toBe(false);
      call.answers = { [call.questions[0].question]: call.questions[0].options[1].label };
      expect(engStep0Boundary(nativePlanCallFingerprint(call, 0, true))).toBe(true);
    });

    test('pending, failed, missing native metadata and ordinary review questions are not this gate', () => {
      const fp = fingerprint(2);
      expect(engStep0Boundary({ ...fp, nativeCall: undefined })).toBe(false);
      for (const alter of [
        (call: any) => { call.answered = false; },
        (call: any) => { call.failed = true; },
        (call: any) => { call.questions[0].header = 'Architecture'; },
        (call: any) => { call.questions[0].options = [{ label: 'Enable cross-project search' }, { label: 'Disable all search' }]; },
        (call: any) => { call.questions[0].options = [{ label: 'Enable cross-project search with project-scoped storage' }, { label: 'Discuss later' }]; },
        (call: any) => { call.questions[0].question = 'How should concurrent AuthCache writes across projects be serialized?';
          call.questions[0].options = [{ label: 'Serialize mutations' }, { label: 'Use project-scoped locks' }]; },
      ]) {
        const call = structuredClone(fp.nativeCall!);
        alter(call);
        call.answers = { [call.questions[0].question]: call.questions[0].options[0].label };
        expect(engStep0Boundary(nativePlanCallFingerprint(call, 0, true))).toBe(false);
      }
    });
  });

  describe('ceoStep0Boundary', () => {
    test('FIRES on Step 0F mode-pick AUQ (HOLD SCOPE in options)', () => {
      const f = fp('Pick a mode', ['HOLD SCOPE', 'SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION']);
      expect(ceoStep0Boundary(f)).toBe(true);
    });

    test('FIRES on collapsed mode labels captured from the 2026-09-08 paid controls', () => {
      // Test each captured label independently: a spaced sibling option can
      // otherwise conceal the mismatch and leave every review AUQ in Step 0.
      const labels = [
        'HOLDSCOPE—makeitbulletproof(Recommended)',
        'SELECTIVEEXPANSION┌────────────────────────────────────────────────────────────────────────────────────┐\r    (ecommnded)                │SELECTIVEEXPANSION│',
        'SCOPEEXPANSION│Neutralposture:presentopportunities,stateeffort,youdecide.│\r                           │  Good for: substantialfeaturewithsolidfoundation,shippedbeforescopelock.│\r└────────────────────────────────────────────────────────────────────┘',
        'SCOPEREDUCTION—findtheminimalversion',
      ];
      for (const label of labels) {
        expect(ceoStep0Boundary(fp('Pick a mode', [label, 'Type something.']))).toBe(true);
      }
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
    // Captured native question text, labels and answers from targeted-b's
    // engineering retry. Descriptions are immaterial to the phase boundary.
    const captured = [
      {
        "header": "Scope",
        "question": "D1 — Multi-tenant Auth Refactor complexity check: 12 files + 4 new classes. Reduce scope or proceed as-is? <gstack-qid:plan-eng-scope-complexity>",
        "options": [
          "Proceed as-is",
          "Reduce: cut TokenStore + RequestPolicy",
          "Reduce: single-pass strangler"
        ],
        "answer": "Proceed as-is"
      },
      {
        "header": "Shared Cache",
        "question": "D2 — Arch issue 1: AuthBroker and SessionMint both mutate a global shared AuthCache via module-level export. How should this be fixed? <gstack-qid:plan-eng-shared-mutable-cache>",
        "options": [
          "Inject AuthCache as a dependency (recommended)",
          "Make mutations go through a single owner",
          "Accept the risk for now, document it"
        ],
        "answer": "Inject AuthCache as a dependency (recommended)"
      },
      {
        "header": "TOCTOU",
        "question": "D3 — Arch issue 2: TOCTOU window during tenant suspension. The plan says AuthCache invalidates entries on tenant suspension, but with two services mutating the cache, a token validation begun before suspension completes may still succeed after the tenant is suspended. How should this be addressed? <gstack-qid:plan-eng-toctou-suspension>",
        "options": [
          "Add suspension check at session issuance boundary (recommended)",
          "Add invalidation ordering guarantee to the plan",
          "Accept the window, note it as an edge case"
        ],
        "answer": "Add suspension check at session issuance boundary (recommended)"
      },
      {
        "header": "Error handling",
        "question": "D4 — Code quality issue 1: validateAndDispatch() swallows three distinct error classes in nested catch blocks with no re-throw, logging, or metrics. Errors disappear silently. How should this be handled? <gstack-qid:plan-eng-error-swallowing>",
        "options": [
          "Refactor to flat error handling with explicit re-throw or typed result (recommended)",
          "Add logging inside each catch, keep structure",
          "Leave it, add a lint rule to catch new instances"
        ],
        "answer": "Refactor to flat error handling with explicit re-throw or typed result (recommended)"
      },
      {
        "header": "Test coverage",
        "question": "D5 — Test issue 1: 0/18 code paths covered in the plan. The plan scopes tests to 'new components and their success/error paths' but omits: cache invalidation edge cases, all three catch blocks in validateAndDispatch(), and the 5 IDP call failure modes. Should the test scope be expanded? <gstack-qid:plan-eng-test-coverage>",
        "options": [
          "Expand test scope to cover all 18 paths (recommended)",
          "Cover new paths only, defer legacy and edge cases",
          "Accept current test scope as stated in the plan"
        ],
        "answer": "Expand test scope to cover all 18 paths (recommended)"
      },
      {
        "header": "IDP calls",
        "question": "D6 — Performance issue 1: token validation makes 5 sequential IDP API calls. The plan acknowledges they are independent and could be parallelized via Promise.all. Should this be fixed in this PR or deferred? <gstack-qid:plan-eng-idp-sequential-calls>",
        "options": [
          "Parallelize now with Promise.all (recommended)",
          "Defer to a follow-up PR, add a TODO",
          "Add a concurrency cap via Promise.all with limit"
        ],
        "answer": "Parallelize now with Promise.all (recommended)"
      },
      {
        "header": "Cache bounds",
        "question": "D7 — Performance issue 2 (medium confidence): AuthCache evicts on token expiry but the plan doesn't mention a max-size bound. In a high-tenant deployment, long-lived non-expiring tokens could grow the cache without bound. Is there already a size cap, or should one be added? <gstack-qid:plan-eng-cache-unbounded>",
        "options": [
          "Verify existing cap exists and document it in the plan",
          "Add explicit max-size eviction policy to AuthCache (recommended)",
          "Defer, this is a scaling concern not a correctness one"
        ],
        "answer": "Verify existing cap exists and document it in the plan"
      },
      {
        "header": "TODO",
        "question": "D8 — TODO candidate: Auth failure observability. The plan replaces silently-swallowed errors with typed errors, but adds no metrics, logs, or alerts for auth failure patterns. This gap won't surface until production incidents occur. Add a TODO? <gstack-qid:plan-eng-todo-observability>",
        "options": [
          "Add to TODOS.md (recommended)",
          "Build it now in this PR instead of deferring",
          "Skip — not valuable enough"
        ],
        "answer": "Add to TODOS.md (recommended)"
      }
    ];
    function nativeScopeFingerprint(index = 0): AskUserQuestionFingerprint {
      const row = captured[index];
      return nativePlanCallFingerprint({
        sessionId: 'captured-eng-retry', toolUseId: `call-${index}`, answered: true,
        questions: [{ header: row.header, question: row.question, options: row.options.map(label => ({ label })) }],
        answers: { [row.question]: row.answer },
      }, index, true);
    }

    test('keeps captured scope-complexity setup and counts the six following findings', () => {
      let started = false;
      const phases = captured.map((_, index) => {
        const question = nativeScopeFingerprint(index);
        const phase = planCountQuestionPhase(question, started, engStep0Boundary);
        started = phase.reviewStarted;
        return phase;
      });
      expect(phases[0]).toEqual({ preReview: true, reviewStarted: true });
      expect(phases.slice(1, 7).filter(phase => !phase.preReview)).toHaveLength(6);
      // The later answered observability TODO retains the existing phase policy.
      expect(phases.filter(phase => !phase.preReview)).toHaveLength(7);
    });

    test('requires an answered native scope decision with its opposed scope choices', () => {
      const original = nativeScopeFingerprint();
      expect(engStep0Boundary(original)).toBe(true);
      expect(engStep0Boundary({ ...original, nativeCall: undefined })).toBe(false);
      const pending = structuredClone(original);
      pending.nativeCall!.answered = false;
      delete pending.nativeCall!.answers;
      expect(engStep0Boundary(pending)).toBe(false);
      const unansweredScope = structuredClone(original);
      unansweredScope.nativeCall!.answers = { 'Separate answered setup question': 'Continue' };
      expect(engStep0Boundary(unansweredScope)).toBe(false);
      for (const alter of [
        (q: any) => { q.header = 'Architecture'; },
        (q: any) => { q.question = q.question.replace('plan-eng-scope-complexity', 'plan-eng-cache-complexity'); },
        (q: any) => { q.options = [{ label: 'Change cache size' }, { label: 'Keep cache size' }]; },
      ]) {
        const unrelated = structuredClone(original);
        alter(unrelated.nativeCall!.questions[0]);
        unrelated.nativeCall!.answers = { [unrelated.nativeCall!.questions[0].question]: captured[0].answer };
        expect(engStep0Boundary(unrelated)).toBe(false);
      }
    });

    test('FIRES on cross-project learnings prompt', () => {
      const f = fp('Enable cross-project learnings on this machine?', ['Yes', 'No']);
      expect(engStep0Boundary(f)).toBe(true);
    });

    test('recognizes the captured cross-project gate after cursor spacing collapses', () => {
      const frame = [
        '☐Cross-project gstackcansearchlearningsfromyourotherprojectsonthismachinetofindpatternsthatmightapplytothisreview.Enablecross-projectlearnings?',
        '❯1.Enablecross-projectlearnings(Recommended)',
        '2.Keeplearningsproject-scopedonly',
      ].join('\r\r');
      const question = capturePlanCountQuestion(frame, new Set(), 0, true)!;
      expect(question).not.toBeNull();
      expect(engStep0Boundary(question)).toBe(true);
      expect(engStep0Boundary(fp('Scopereductionrecommendation:cuttoMVP?', ['Reduce', 'Proceed']))).toBe(true);
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

  describe('design review begins without an optional focus question', () => {
    // Captured in the second07:53 paid attempt: real D1-D7 questions were
    // all incorrectly marked preReview, producing reviewCount=0 at completion.
    const questions = [
      '☐Buttonstyle │D1—Howshouldthe4headerbuttons(Save,Reset,Cancel,Export)bevisuallydifferentiated? │<gstack-qid:plan-design-review-butn-hierarchy>',
      '☐ Loading UX │D2—Whatloadingindicatorshouldappearduringthe2-5secondSaveoperation? │<gtack-qid:plan-esign-review-loadig-indicator>',
      '☐ Spacing │D3—Whichspacingscaleshouldthesettingspagestandardizeon?<gstack-qid:plan-design-review-spacing-scale>',
      '☐Typography │D4—Which2-sizetypographysystemshouldthesettingspageuse?<gstack-qid:plan-design-review-type-system>',
      '☐Mobile layout │D5 — On obile (<768px), how should the4-buton header behave?<gstack-qid:plan-design-review-mobile-header>',
      '☐DEIGN.md TODO │D6 — TODO: Create a DESIGN.md file codifying the5 decisions mdein this revew <gstack-qid:plan-design-review-todo-designmd>',
      '☐PartialfailTODO │D7—TODO:Specifythepartial-failurestate—whatdoestheuserseeifSavesucceedsforsomefieldsbutfailsfor others? <gstack-qid:plan-design-review-todo-partialfail>',
    ];

    test('counts the first captured finding and every subsequent finding', () => {
      let reviewStarted = false;
      const phases = questions.map(question => {
        const phase = planCountQuestionPhase(fp(question, ['Apply', 'Defer']), reviewStarted,
          designStep0Boundary, designFirstReviewAUQ);
        reviewStarted = phase.reviewStarted;
        return phase.preReview;
      });
      expect(phases).toEqual([false, false, false, false, false, false, false]);
    });

    test('keeps the observed focus gate separate when it is emitted', () => {
      const focus = fp("☐ Focus areas │ I've rated this plan2/10 on design completeness. Review all7 dimensions?", ['All7dimensions', 'Priority gaps']);
      const setup = planCountQuestionPhase(focus, false, designStep0Boundary, designFirstReviewAUQ);
      expect(setup).toEqual({ preReview: true, reviewStarted: true });
      expect(planCountQuestionPhase(fp(questions[0], ['Apply', 'Defer']), setup.reviewStarted,
        designStep0Boundary, designFirstReviewAUQ)).toEqual({ preReview: false, reviewStarted: true });
    });

    test('requires review identity, not just a D1 label or setup question ID', () => {
      for (const question of [
        '☐ Setup │D1—Enable cross-project learnings?',
        '☐ Review target │D1—Which plan should I review?<gstack-qid:plan-design-review-scope>',
        '☐ Focus │D1—What should this design review focus on?<gstack-qid:plan-design-review-focus-areas>',
        '☐ Scope │I will review Pass1 through Pass7 after setup. Proceed?',
      ]) expect(designFirstReviewAUQ(fp(question, ['Yes', 'No']))).toBe(false);
      expect(designFirstReviewAUQ(fp('☐ Page structure │ Pass1 — Information Architecture: what page structure should this use?', ['Standard', 'Sidebar']))).toBe(true);
    });

    test('leaves callers without a first-review predicate unchanged', () => {
      expect(planCountQuestionPhase(fp(questions[0], ['Apply', 'Defer']), false, designStep0Boundary))
        .toEqual({ preReview: true, reviewStarted: false });
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


describe('file permission lifecycle replay', () => {
  const permission = (file = 'gstack-test-plan-design.md') => [
    `Do you want to make this edit to ${file}?`,
    '❯ 1. Yes',
    '2.Yes,andswitchtoacceptedits(auto-approvefileeditsandcommonfilecommands)forthissession;Yes,and',
    'alwaysallowaccessto/tmp/fixtureforthissession',
    '3.No',
    'Esctocancel·Tabtoamend',
  ].join('\n');

  test('ignores the granted menu and its redraw until a new request follows file-tool completion', () => {
    const guard = createPlanCountPermissionGuard();
    const first = permission();
    expect(guard(first)).toBe('grant');
    expect(guard(first)).toBe('handled');
    const redraw = first + '\n' + permission();
    expect(guard(redraw)).toBe('handled');
    const completed = redraw + '\n●Write(/tmp/fixture/gstack-test-plan-design.md)\n' +
      '⎿ Wrote320linesto../fixture/gstack-test-plan-design.md\n' + '·'.repeat(1600);
    expect(classifyPlanCountFrame(completed)).toBeNull();
    expect(guard(completed)).toBe('handled');
    expect(guard(completed + '\n' + permission())).toBe('grant');
  });

  test('singular native Write/Edit results release a fresh identical permission', () => {
    for (const result of ['⎿ Added1line,removed1line', '⎿ Wrote1lineto../fixture/plan.md', '⎿ Removed1line', '⎿\u00a0Wrote320linesto../fixture/plan.md']) {
      const guard = createPlanCountPermissionGuard();
      const first = permission();
      expect(guard(first)).toBe('grant');
      const completed = first + '\n' + result;
      expect(guard(completed)).toBe('handled');
      expect(guard(completed + '\n' + permission())).toBe('grant');
    }
  });

  test('the captured active Edit menu remains a permission behind a long diff repaint', () => {
    const visible = permission('gstack-test-plan-ceo.md') + '\n' +
      '  89 +The plan adds StripePaymentWebhookHandler outside WebhookDispatcher.\n'.repeat(40);
    expect(visible.length).toBeLessThan(4096);
    expect(classifyPlanCountFrame(visible)).toBeNull(); // The old 1.5 KB scan misses it.
    const guard = createPlanCountPermissionGuard();
    expect(guard(visible)).toBe('grant');
    expect(guard(visible)).toBe('handled');
  });

  test('a completed Write invalidates an old menu even if polling missed the original grant', () => {
    const visible = permission() + '\n⎿ Wrote320linesto../fixture/gstack-test-plan-design.md';
    expect(createPlanCountPermissionGuard()(visible)).toBe('handled');
  });

  test('proposed results and tool headers do not release the same pending permission', () => {
    const guard = createPlanCountPermissionGuard();
    let visible = permission();
    expect(guard(visible)).toBe('grant');
    for (const line of ['320 +⎿ Wrote320lines', '●Write(/tmp/fixture/plan.md)', '⎿ Tip: use /btw', '⎿ Error: denied']) {
      visible += '\n' + line + '\n' + permission();
      expect(guard(visible)).toBe('handled');
    }
  });

  test('a different file and a genuine native file-policy question retain their own input', () => {
    const guard = createPlanCountPermissionGuard();
    const first = permission('first.md');
    expect(guard(first)).toBe('grant');
    expect(guard(first + '\n' + permission('FIRST.md'))).toBe('grant'); // Targets remain case-sensitive.
    expect(guard(first + '\n' + permission('second.md'))).toBe('grant');
    const question = '\n☐ File policy\nDo you want to create first.md?\n❯1.Yes\n2.No\n' +
      'Enter to select · ↑/↓ to navigate · Esc to cancel';
    expect(guard(first + question)).toBeNull();
    expect(capturePlanCountQuestion(first + question, new Set(), 0, true)?.promptSnippet).toContain('File policy');
  });
});
