/**
 * GST-3562 A's no-loss replay. /ship plans no new fix-check: a fix that main at 0408128 (v1.102.2.0) answered with a fix-check
 * now gets a full pass on the range, and a fix made in the last allowed round gets one read-only full review of the final head
 * instead of shipping unread or stopping; R51's 2-round cap stays. The Captain ruled on 2026-11-23 under rule 15 (approval
 * a-6ec01c09edf8): "Only B removes a reader that can block a merge. A replaces narrow re-checks with full rounds…".
 *
 * asMainBeforeGst3562 plans the input with main's frozen transition table (mainNextStep) through planReviewAt. When that plan
 * equals the branch's, it returns the branch's plan. Otherwise it asserts the change is one of the kinds the ruling allows and
 * returns main's plan, so a grid hash frozen to an older main still matches after the earlier adapters run:
 *   a. main planned a fix-check; the branch plans a full or scoped pass on the same range that keeps main's readers: a
 *      full-effort reader excluding nothing main's fix-check read, and each of main's other readers (the targeted brief may
 *      ride on the one adversarial reader, as R65's merged reader carries it).
 *   b. both plans take the same stop, voices or done step and differ only in its reason text.
 *   c. main planned a fix-check at the cap after a read-only review had run; the branch stops for the lane's Captain (on gate
 *      class, Step 11's voices first).
 *   d. main was done with an unread below-floor fix; the branch reviews it (a full pass, a read-only full review, or a stop or
 *      the voices before one).
 *   e. main stopped (or ran the voices before stopping) on a blocker fixed or a gate edit made at the cap; the branch gives the
 *      final head one read-only full review.
 *   f. a new /ship run on a PR whose full rounds are spent: both plan the same read-only full review of the head, and the
 *      branch marks it read-only (no fix round, staged on the merge base) and keeps every reader main dispatched (GST-3562 part 2).
 *   g. main planned a scoped pass after a small blocking fix; the branch plans a full pass on the same range that keeps main's
 *      readers the way kind a does, so no reader runs outside the pass record (GST-3562 part 3; Captain GStack Minder, 2026-11-24),
 *      and each specialist main dispatched is read by a branch specialist under its name or checklist excluding no more paths.
 */
import { expect } from 'bun:test';
import { planReviewAt, type PlanInput, type ReviewPlan } from '../../lib/review-depth';
import { mainNextStep } from '../fixtures/review-depth-main/next-step-0408128';

export type Gst3562Kind = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';

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
    : h.last === 'none' && was.step === 'full' && !was.readOnly && now.readOnly && now.reason === was.reason && was.reason.startsWith('read-only final review (R51)') ? 'f'
    : was.step === 'scoped' && now.step === 'full' && now.reason.includes('never a scoped pass') ? 'g'
    : undefined;
  expect([h, was, now, kind]).toEqual([h, was, now, expect.any(String)]);
  if (kind === 'b') expect({ ...plan, next: was }).toEqual(main);
  if (kind === 'f') expect([h, main.dispatches.filter(d => !plan.dispatches.some(p => Bun.deepEquals(p, d)))]).toEqual([h, []]);
  if (kind === 'a' || kind === 'g') {
    const lost = main.dispatches.filter(d => d.role === 'fix-check'
      ? !plan.dispatches.some(p => p.role !== 'targeted' && p.effort === 'full' && p.exclude.every(e => d.exclude.includes(e)))
      : !plan.dispatches.some(p => p.role === d.role || (d.role === 'targeted' && p.role === 'adversarial-native' && !!p.classes?.length)));
    expect([h, plan.mode, lost]).toEqual([h, plan.mode, []]);
  }
  if (kind === 'g') {
    const unread = main.dispatches.filter(d => d.role === 'specialist' && !plan.dispatches.some(p => p.role === 'specialist'
      && (p.name === d.name || !!p.checklists?.includes(d.name as never)) && p.exclude.every(e => d.exclude.includes(e))));
    expect([h, unread]).toEqual([h, []]);
  }
  return { plan: main, kind };
}
