import { describe, expect, test } from 'bun:test';
import captured from './fixtures/design-count-sep20-calls.json';
import { designCountExistingInteractionStates } from './helpers/design-count-fixture';
import { designStep0Boundary, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCompletionHandoff, isDesignCountFirstReview, isDesignCountSetup } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

describe('September 20 design count fixture omissions', () => {
  test('the failed retry contains eight real decisions, including three unseeded requirements', () => {
    let started = false;
    const reviewHeaders: string[] = [];
    for (const call of structuredClone(captured.calls) as NativePlanQuestionCall[]) {
      const phase = planCountQuestionPhase(nativePlanCallFingerprint(call, 0, true), started,
        designStep0Boundary, isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff);
      started = phase.reviewStarted;
      if (!phase.preReview && !phase.administrative) reviewHeaders.push(call.questions[0]!.header);
    }
    expect(reviewHeaders).toEqual(Array.from({ length: 8 }, (_, index) => `Issue ${index + 1}`));
    expect(captured.provenance.expectedCeiling).toBe(7);
    for (const header of captured.provenance.unseededHeaders) expect(reviewHeaders).toContain(header);
  });

  test('the first finding owns its review evidence independently of the earlier mixed setup packet', () => {
    const first = (structuredClone(captured.calls) as NativePlanQuestionCall[])
      .find(call => call.questions[0]!.header === 'Issue 1')!;
    const q = first.questions[0]!;
    for (const option of q.options) {
      first.answers = { [q.question]: option.label };
      expect(isDesignCountFirstReview(nativePlanCallFingerprint(first, 0, true))).toBe(true);
    }
    for (const opposition of [
      'Leaves the plan no longer violating DESIGN.md.',
      'Leaves another plan violating DESIGN.md.',
      '"Leaves the plan violating DESIGN.md."',
      'Leaves the plan violating DESIGN.md. This issue is resolved.',
    ]) {
      const changed = structuredClone(first);
      changed.questions[0]!.options[2]!.description = opposition;
      expect(isDesignCountFirstReview(nativePlanCallFingerprint(changed, 0, true)), opposition).toBe(false);
    }
  });

  test('retained contract violations require an affirmative, unconditional alternative', () => {
    const first = (structuredClone(captured.calls) as NativePlanQuestionCall[])
      .find(call => call.questions[0]!.header === 'Issue 1')!;
    const accepts = (description: string) => {
      const changed = structuredClone(first);
      changed.questions[0]!.options[2]!.description = description;
      return isDesignCountFirstReview(nativePlanCallFingerprint(changed, 0, true));
    };
    for (const verb of ['Leave', 'Keep']) for (const owner of ['the plan', 'this header', 'the design', 'this page']) {
      const action = `${verb.toLowerCase()} ${owner} violating DESIGN.md`;
      const assertion = `${verb}s ${owner} violating DESIGN.md`;
      for (const positive of [
        assertion + '.',
        `✅ No visual change to review. ❌ ${assertion} and users scanning four labels.`,
        assertion + '. Users still scan the labels. Historical note: "Never ' + action + '."',
      ]) expect(accepts(positive), positive).toBe(true);
      for (const negative of [
        `Does not ${action}.`, `Never ${action}.`, `Do not ${action}.`,
        `Cannot ${action}.`, `Must not ${action}.`, `Should not ${action}.`,
        `If approved, ${assertion.toLowerCase()}.`,
        `Assuming approval, ${assertion.toLowerCase()}.`,
        `${assertion} only if approved later.`, `${assertion} once approval arrives.`,
        `${assertion} after approval.`, `${assertion} subject to approval.`,
        `${assertion}; pending approval.`, `${assertion}. This alternative requires approval.`,
        `${assertion}. Correction: do not ${action}.`,
        `${assertion}. This option does not ${action}.`,
      ]) expect(accepts(negative), negative).toBe(false);
    }
  });

  const accepted = designCountExistingInteractionStates.join(' ');

  test('the surrounding contract supplies the three missing operation-specific error strings', () => {
    expect(accepted).toContain('Save: “Couldn’t save your changes. Your edits are still here.”');
    expect(accepted).toContain('Export: “Couldn’t prepare your export.”');
    expect(accepted).toContain('Load: “Couldn’t load your settings.”');
    expect(accepted).toContain('Each uses the existing error icon and its sibling Retry');
  });

  test('the surrounding contract defines a clean Save without changing its pending or dirty behavior', () => {
    expect(accepted).toContain('Save stays enabled and focusable while idle, whether clean or dirty.');
    expect(accepted).toContain('A clean Save is a no-op: no request, validation, pending state, timestamp, status, or focus change.');
    expect(accepted).toContain('Only a dirty Save sends the existing atomic request.');
    expect(accepted).toContain('both request buttons use aria-disabled=true');
  });

  test('the surrounding contract names exports without introducing personal data or a date ambiguity', () => {
    expect(accepted).toContain('account-settings-YYYY-MM-DD.json');
    expect(accepted).toContain('the user’s local calendar date');
    expect(accepted).toContain('no account name or email');
    expect(accepted).toContain('no account identifiers');
    expect(accepted).toContain('Repeated same-day exports keep the browser’s normal collision suffix');
  });

  test('the surrounding contract locates validation errors and responsive retry feedback', () => {
    expect(accepted).toContain('ErrorSummary mounts in the status/error area below the action group and above Profile');
    expect(accepted).toContain('focus goes to the first invalid field and the summary is not a second live region');
    expect(accepted).toContain('error/Retry row is inline above 640px with an 8px gap');
    expect(accepted).toContain('Retry wraps below the text as a full-width 44px ghost button, outside the live region');
    expect(accepted).toContain('long errors fit 320px without horizontal scroll');
  });
});
