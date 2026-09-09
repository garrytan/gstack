import { designFirstReviewAUQ } from './claude-pty-runner';
import type { AskUserQuestionFingerprint } from './claude-pty-runner';
import { pickDesignCountOutsideVoices } from './design-count-outside';

/** A completed finding can start the passes when the caller already supplied the focus. */
export function isDesignCountFirstReview(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed) return false;
  if (designFirstReviewAUQ(fp)) return true;
  return call.questions.some(q => {
    if (!call.answers?.[q.question] || q.options.length < 2) return false;
    if (/^(?:focus|scope|learnings|routing|next steps?|outside(?: design)? voices)$/i.test(q.header.trim())) return false;
    const id = /<gstack-qid:\s*([a-z0-9-]+)\s*>/i.exec(q.question)?.[1] ?? '';
    if (/(?:^|-)(?:focus|scope|setup|routing|learnings|onboarding|next-steps?|posture|mockups?|target)(?:-|$)/i.test(id)) return false;
    // Native pass decisions can carry a D-number before the pass title and
    // use plan-design-passN rather than plan-design-review-... identities.
    // Bind both forms to the same explicit pass and an offered choice that
    // leaves a named gap unresolved. Pass readiness is only setup.
    const numberedPass = /^D\s*\d+\s*[—–:-]\s*Pass\s*([1-7])\s*\([^)]*\)\s*:/i.exec(q.question.trim());
    const passId = /^plan-design-pass([1-7])-/i.exec(id);
    const unresolvedChoice = q.options.some(option =>
      /\b(?:leave|keep|defer|accept)\b/i.test(option.label) &&
      /\b(?:gap|problem|defect|inconsisten\w*)\b/i.test(`${option.label} ${option.description ?? ''}`));
    if (numberedPass && passId && numberedPass[1] === passId[1] && unresolvedChoice && /\?/.test(q.question)) return true;
    // These are issue-bearing pass statements in actual answered calls,
    // not a setup request that merely mentions the seven review passes.
    return /^Pass\s*[1-7]\s+(?:surfaces|(?:also\s+)?(?:found|flagged))\b/i.test(q.question.trim()) &&
      /\?/.test(q.question);
  });
}

function designHandoff(fp: AskUserQuestionFingerprint): { manualIndex: number | null } | null {
  const call = fp.nativeCall;
  if (!call || call.failed || call.questions.length !== 1 ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return null;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2 || !/^next\s+steps?$/i.test(q.header.trim())) return null;
  const ids = [...q.question.matchAll(/<gstack-qid:\s*([a-z0-9-]+)\s*>/gi)].map(match => match[1]);
  if ((q.question.match(/<gstack-qid\b/gi) ?? []).length !== 1 || ids.length !== 1 || !/^plan-design-(?:review-)?next-steps?$/i.test(ids[0]!)) return null;
  const declaration = q.question.trim().replace(/^D\s*\d+\s*[—–:-]\s*/i, '')
    .replace(/^next\s+steps?\s*:\s*/i, '');
  // Scores and a completed decision count describe a closed review. A
  // condition or unresolved gap cannot masquerade as its next-step menu.
  if (!/^Design\s+review\s+(?:is\s+)?complete(?:[.!]|\s+\((?:\d+(?:\.\d+)?(?:\/10)?\s*(?:→|->|to)\s*)?\d+(?:\.\d+)?\/10(?:,\s*\d+\s+decisions?\s+made)?\)[.!])(?:\s|$)/i.test(declaration) ||
      !/\bWhat['’]s\s+next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration)) return null;
  // A closed heading does not override an affirmative outstanding-work claim
  // in its recap. Zero/no outstanding work is a compatible completion claim.
  const outstanding = declaration
    .replace(/\b(?:no|zero|0)\s+(?:unresolved|open|pending|unaddressed|remaining|outstanding)\s+(?:[a-z-]+\s+){0,3}(?:gaps?|issues?|decisions?|requirements?|work)\b/gi, '')
    .replace(/\bno\s+(?:gaps?|issues?|decisions?|requirements?|work)\s+remains?\b/gi, '');
  if (/\b(?:unresolved|open|pending|unaddressed|remaining|outstanding)\s+(?:[a-z-]+\s+){0,3}(?:gaps?|issues?|decisions?|requirements?|work)\b|\b(?:gaps?|issues?|decisions?|requirements?|work)\s+(?:still\s+)?remains?\b|\b(?:gaps?|issues?|decisions?|requirements?|work)\s+(?:is|are)\s+still\s+(?:unresolved|open|pending|unaddressed)\b/i.test(outstanding)) return null;
  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z][).]\s*/i, '')
    .replace(/\s*\(recommended\)\s*$/i, '').trim());
  const manual = labels.map(label => /^(?:Handle next steps manually|Skip\s*[—–-]\s*I['’]ll handle next steps manually)$/i.test(label));
  const review = labels.map(label => /^Run \/plan-eng-review(?: next)?(?: \(required gate\))?$/i.test(label));
  const navigation = labels.map(label => /^(?:Skip to implementation|Run \/plan-ceo-review(?: first)?|Run \/design-(?:shotgun|html))$/i.test(label));
  if (manual.filter(Boolean).length > 1 || !review.some(Boolean) ||
      !labels.every((_, i) => manual[i] || review[i] || navigation[i])) return null;
  // Classification does not invent a missing stop option. Only an offered
  // manual action can steer a pending question away from another workflow.
  const index = manual.findIndex(Boolean);
  return { manualIndex: index < 0 ? null : index + 1 };
}

/** Completed handoffs retain raw evidence and their own administrative count. */
export function isDesignCompletionHandoff(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed || !Array.isArray(call.unansweredQuestionIndices) ||
      call.unansweredQuestionIndices.length || designHandoff(fp) === null) return false;
  const q = call.questions[0]!;
  return q.options.some(option => call.answers?.[q.question] === option.label);
}

/** Preserve the native-only outside opt-out, then finish this review at its actual handoff. */
export function pickDesignCountQuestion(
  routing: AskUserQuestionFingerprint,
  active: AskUserQuestionFingerprint,
): number | null {
  const outside = pickDesignCountOutsideVoices(routing, active);
  if (outside !== null) return outside;
  return active.nativeCall?.answered ? null : designHandoff(active)?.manualIndex ?? null;
}
