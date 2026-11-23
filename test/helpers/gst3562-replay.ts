/**
 * GST-3562 A's no-loss replay. /ship plans no new fix-check: a fix that main at 0408128 (v1.102.2.0) answered with a fix-check
 * now gets a full pass on the range, and a fix made in the last allowed round gets one read-only full review of the final head
 * instead of shipping unread or stopping; R51's 2-round cap stays. The Captain ruled on 2026-11-23 under rule 15 (approval
 * a-6ec01c09edf8): "Only B removes a reader that can block a merge. A replaces narrow re-checks with full rounds…".
 *
 * asMainBeforeGst3562 plans the input with main's frozen transition table (mainNextStep) through planReviewAt. When that plan
 * equals the branch's, it returns the branch's plan. Otherwise it asserts the change is one of the kinds the ruling allows and
 * returns main's plan, so a grid hash frozen to an older main still matches after the earlier adapters run:
 *   a. main planned a fix-check; the branch plans a full or scoped pass on the same range.
 *   b. both plans take the same stop, voices or done step and differ only in its reason text.
 *   c. main planned a fix-check at the cap after a read-only review had run; the branch stops for the lane's Captain (on gate
 *      class, Step 11's voices first).
 *   d. main was done with an unread below-floor fix; the branch reviews it (a full pass, a read-only full review, or a stop or
 *      the voices before one).
 *   e. main stopped (or ran the voices before stopping) on a blocker fixed or a gate edit made at the cap; the branch gives the
 *      final head one read-only full review.
 */
import { expect } from 'bun:test';
import { planReviewAt, type PlanInput, type ReviewPlan } from '../../lib/review-depth';
import { mainNextStep } from '../fixtures/review-depth-main/next-step-0408128';

export type Gst3562Kind = 'a' | 'b' | 'c' | 'd' | 'e';

export function asMainBeforeGst3562(input: PlanInput, plan: ReviewPlan): { plan: ReviewPlan; kind?: Gst3562Kind } {
  const main = planReviewAt(input, mainNextStep);
  if (Bun.deepEquals(main, plan)) return { plan };
  const h = input.history;
  const [was, now] = [main.next, plan.next];
  const kind: Gst3562Kind | undefined =
    was.step === now.step && ['stop', 'voices', 'done'].includes(now.step) ? 'b'
    : was.step === 'fix-check' && (now.step === 'full' || now.step === 'scoped') && now.reason.includes('GST-3562 A') ? 'a'
    : was.step === 'fix-check' && (now.step === 'stop' || now.step === 'voices') && now.reason.includes('a fix followed the read-only final review') ? 'c'
    : was.step === 'done' && !!h.fixedBelow && ['full', 'stop', 'voices', 'fix-check'].includes(now.step) ? 'd'
    : (was.step === 'stop' || was.step === 'voices') && !!(h.fixedBlocking || h.touchedGate) && now.step === 'full' && now.reason.startsWith('read-only final review (R51)') ? 'e'
    : undefined;
  expect([h, was, now, kind]).toEqual([h, was, now, expect.any(String)]);
  if (kind === 'b') expect({ ...plan, next: was }).toEqual(main);
  return { plan: main, kind };
}
