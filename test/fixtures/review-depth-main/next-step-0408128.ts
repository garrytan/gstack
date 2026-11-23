/**
 * lib/review-depth.ts's transition table (nextStep and its helpers) as origin/main had it at 0408128 (v1.102.2.0), before
 * GST-3562 A retired the fix-check step. Frozen for the no-loss replays in test/review-depth*.test.ts: they plan each grid
 * case with this table through planReviewAt and check that every case the new table changes only adds review. Never edit.
 */
import { FULL_PASS_CAP, SCOPED_RANGE_LINES, type Depth, type History, type NextStep } from '../../../lib/review-depth';

export function mainNextStep(h: History, depth?: Depth): NextStep {
  if (h.grantedStop && h.last !== 'fix-check') return h.rangeRuntimeLines == null
    ? { step: 'stop', reason: `fix-check grant ${h.grantedStop} answers the stop, but there is no fix to read since its head: commit the fix (a base merge, an empty or reverted change is none), then ask again` }
    : { step: 'fix-check', reason: `fix-check grant ${h.grantedStop} buys the stopped review's fix round: one scoped fix-check of the PR's own change since the stop's head, never a new full review and never a second fix-check` };
  const n = prCapped(h, h.lean ? leanStep(h, depth) : loopStep(h, depth));
  if (n.step !== 'stop') return n;
  if (h.gate && !h.adversarialRan) return { step: 'voices', reason: `gate class: Step 11's ${h.lean ? 'one reader' : 'voices (adversarial, outside, targeted)'} run${h.lean ? 's' : ''} before the owner's exit, then ask again with --adversarial-ran (${n.reason})` };
  const afterFixCheck = h.last === 'fix-check' && h.fullPasses === FULL_PASS_CAP - 1 && h.fixChecks === 1;
  if (h.postReview && h.last === 'fix-check' && h.granted && !h.blockingOpen) return { step: 'fix-check', reason: `the owner's grant ${h.granted} adds one scoped fix-check for the edits after the last fix-check, a new link of the fix-check chain (docs/ship-policy.md#fix-check-chain); a later post-review edit needs a grant of its own` };
  if (h.chained && h.last === 'fix-check' && h.granted && !h.blockingOpen) return { step: 'fix-check', reason: `the owner's grant ${h.granted} adds one scoped fix-check at the last fix-check's stop, a new link of the fix-check chain (docs/ship-policy.md#fix-check-chain); another stop needs a grant of its own` };
  if (!h.lean && h.granted && !h.blockingOpen && (afterFixCheck || (h.last === 'full' && h.fullPasses === FULL_PASS_CAP))) return { step: 'fix-check', reason: `the owner's grant ${h.granted} adds one scoped fix-check after round ${FULL_PASS_CAP} (review_loop_exception), ${afterFixCheck ? 'never a second' : 'never a fourth round'}` };
  return n;
}

/**
 * R51 per pull request (GST-2673, docs/review-policy.md#rounds-per-pull-request): the rounds earlier /ship runs on this
 * PR spent count against FULL_PASS_CAP with this run's, and a recorded round grant at this head adds one. At the cap a
 * below-floor fix ships as notes and anything else stops with PR_ROUND_CAP for the lane or its Captain, never the owner.
 * A PR already at the cap gets one read-only full review of this head: no fix round, the count does not reopen, and a
 * blocker stops with PR_ROUND_CAP as the lane's Captain's decision.
 */
function prCapped(h: History, n: NextStep): NextStep {
  const prior = h.priorFull ?? 0;
  const cap = FULL_PASS_CAP + (h.roundGrant ? 1 : 0);
  if (prior >= cap) {
    if (h.last === 'none') return n.step === 'full' || n.step === 'scoped' ? { step: 'full', reason: `read-only final review (R51): this PR already had ${prior} full review rounds on earlier heads, so this head gets one full review with no fix round; a blocker goes to the lane's Captain as a decision and the count does not reopen` } : n;
    if (n.step === 'done') return n;
    if (!h.fixedBlocking && !h.blockingOpen && !h.touchedGate && n.step !== 'stop') return { step: 'done', reason: `read-only final review done (R51): its below-floor findings ship as notes in the PR body and receipt, with no fix round` };
    return { step: 'stop', reason: `PR_ROUND_CAP: the read-only final review of a PR that already had ${prior} full review rounds found a blocker; the lane's Captain decides (ship with the note, park, or buy its fix round with a fix-check grant naming the stop gstack-ship-receipt stop records), not an owner ask` };
  }
  if (!prior || (n.step !== 'full' && n.step !== 'scoped')) return n;
  const used = prior + h.fullPasses;
  if (used < cap) return { ...n, reason: `${n.reason}; this PR already had ${prior} full review round${prior === 1 ? '' : 's'} on earlier heads, so this is its full round ${used + 1} of ${cap}${used + 1 === cap ? ', the last' : ''}` };
  if (h.roundGrant && used === cap && prior === cap - 1 && h.fullPasses === 1 && h.last === 'full') return { ...n, reason: `${n.reason}; round grant ${h.roundGrant} bought pass 1 as this PR's full round ${cap}, and this is that round's fix round, its last` };
  if (h.last !== 'none' && !h.fixedBlocking && !h.blockingOpen && !h.touchedGate) return { step: 'done', reason: `PR round cap ${cap} reached (${prior} on earlier heads): the below-floor fixes ship as notes in the PR body and receipt` };
  return { step: 'stop', reason: `PR_ROUND_CAP: this PR already had ${used} full review round${used === 1 ? '' : 's'} across its heads and /ship runs${h.roundGrant ? ` (round grant ${h.roundGrant} included)` : ''}; another needs a reason the lane or its Captain records with gstack-approvals round-grant, not an owner ask` };
}

/**
 * R65's lean table (GSTA-258): pass 1 is the one reviewer; any fix on a risk-class diff, and a fixed blocker or a gate-class
 * edit on any diff, earns one scoped fix-check (round 2, the cap); below-floor fixes on a light diff ship as notes. After the
 * fix-check a blocker or gate-class edit stops for the owner, whose recorded grant adds one more fix-check, never two.
 */
function leanStep(h: History, depth?: Depth): NextStep {
  if (h.last === 'none') return { step: 'full', reason: 'pass 1: one reviewer reads the whole diff (R65)' };
  if (h.last === 'fix-check') {
    if (!h.blockingOpen && !h.fixedBlocking && !h.touchedGate) return { step: 'done', reason: h.fixedBelow ? 'round cap 2 reached: the below-floor fixes ship as notes in the PR body and receipt' : 'the fix-check found nothing blocking' };
    if (h.granted && !h.blockingOpen && h.fixChecks === 1) return { step: 'fix-check', reason: `the owner's grant ${h.granted} adds one scoped fix-check after round ${FULL_PASS_CAP} (review_loop_exception), never a second` };
    return { step: 'stop', reason: `the fix-check ${h.blockingOpen || h.fixedBlocking ? 'found a blocking finding' : 'edited a gate-class path'}: name it for the owner, whose grant may add one scoped fix-check, never a third round` };
  }
  if (h.blockingOpen) return { step: 'stop', reason: 'a blocking finding is still open in fix scope: name it for the owner' };
  if (!h.fixedBlocking && !h.fixedBelow && !h.touchedGate) return { step: 'done', reason: 'the step applied no edits' };
  if (depth === 'light' && !h.fixedBlocking && !h.touchedGate) return { step: 'done', reason: 'light depth: the below-floor fixes ship as notes in the PR body and receipt without a fix-check (R65)' };
  return { step: 'fix-check', reason: `${h.fixedBlocking ? 'a blocking finding was fixed' : h.touchedGate ? 'a fix touched a gate-class path' : 'below-floor fixes on a risk-class diff'}: one scoped fix-check reads the touched hunks (round 2, the cap)` };
}

function loopStep(h: History, depth?: Depth): NextStep {
  if (h.last === 'none') return { step: 'full', reason: 'pass 1 reviews the whole diff' };
  const fixed = !!(h.fixedBlocking || h.fixedBelow || h.touchedGate);
  if (h.last === 'fix-check') return h.blockingOpen || h.fixedBlocking || h.touchedGate ? { step: 'stop', reason: `the fix-check ${h.touchedGate && !h.blockingOpen && !h.fixedBlocking ? 'edited a gate-class path' : 'found a blocking finding'}: name it for the owner, whose grant may add one scoped fix-check, never a third round` } : { step: 'done', reason: fixed ? 'round cap 2 reached: the below-floor fixes ship as notes in the PR body and receipt' : 'the fix-check found nothing blocking' };
  if (h.blockingOpen && h.fullPasses >= FULL_PASS_CAP) return { step: 'stop', reason: `a blocking finding is open after ${FULL_PASS_CAP} rounds: name it for the owner` };
  if (h.blockingOpen) return { step: 'stop', reason: 'a blocking finding is still open in fix scope: name it for the owner' };
  if (!fixed) return { step: 'done', reason: 'the step applied no edits' };
  if (h.fullPasses >= FULL_PASS_CAP) return h.fixedBlocking || h.touchedGate
    ? { step: 'stop', reason: `${h.fixedBlocking ? 'a blocking finding was fixed' : 'a fix edited a gate-class path'} in round ${FULL_PASS_CAP}, the cap: name it for the owner, whose grant may add one scoped fix-check (review_loop_exception)` }
    : { step: 'done', reason: `round cap ${FULL_PASS_CAP} reached: the below-floor fixes ship as notes in the PR body and receipt` };
  if (!h.fixedBlocking && !h.touchedGate && depth === 'light' && h.rangeRuntimeLines === 0) return { step: 'done', reason: 'light depth: the below-floor fixes change no runtime lines, so they ship as notes without a fix-check' };
  if (h.fixedBlocking || h.touchedGate) {
    if (!h.fixedBlocking) return { step: 'full', reason: 'a fix touched a gate-class path: full pass on the range' };
    const n = h.rangeRuntimeLines;
    const keep = h.touchedGate ? 'a fix touched a gate-class path' : depth === undefined ? 'the depth is unknown' : h.pass1Depth === 'full' ? 'pass 1 ran at full depth' : depth === 'full' ? 'the diff is at full depth'
      : typeof n !== 'number' || !Number.isFinite(n) || n < 0 ? 'the fix range was not read' : n > SCOPED_RANGE_LINES ? `the fix range has ${n} runtime lines (> ${SCOPED_RANGE_LINES})` : null;
    if (keep) return { step: 'full', reason: `a blocking finding was fixed and ${keep}: full pass on the range` };
    return { step: 'scoped', reason: `a blocking finding was fixed on a ${depth} diff with ${n} runtime lines in the fix range (<= ${SCOPED_RANGE_LINES}): scoped pass on the range` };
  }
  return { step: 'fix-check', reason: 'only below-floor fixes: one fix-check reads the touched hunks (round 2)' };
}
