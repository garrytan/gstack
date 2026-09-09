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
    // A named or scored pass can ask for a missing design requirement before a
    // numbered finding heading appears. Its actual decision and opposed
    // choices establish review; a score or familiar qid alone cannot.
    const scoredPass = /^(?:D\s*\d+\s*[—–:-]\s*)?Pass\s*[1-7]\s*\([^)]*\)\s*[—–:-]\s*(?:10|[0-9])(?:\.[0-9]+)?\/10[.!:]/i.test(q.question.trim());
    const namedPass = /^(?:D\s*\d+\s*[—–:-]\s*)?Pass\s*[1-7]\s*[—–:-]\s*[A-Za-z][A-Za-z ]{3,60}:\s+/i.test(q.question.trim());
    const chosen = q.options.some(option => option.label === call.answers?.[q.question]);
    const fixChoice = q.options.some(option => /^(?:Add|Fix|Specify|Define|Restore)\b/i.test(option.label));
    const leaveChoice = q.options.some(option => /^(?:Leave as-is|Keep as-is|Defer|Accept the gap)\b/i.test(option.label) ||
      /^Skip\s*[—–-]\s*implied by\s+[^.!?]+\bgap$/i.test(option.label));
    if ((scoredPass || namedPass) && /^plan-design-review-[a-z0-9-]+$/i.test(id) &&
        (q.question.match(/<gstack-qid/gi)?.length ?? 0) === 1 &&
        /\b(?:gap|problem|defect|missing|inconsisten\w*)\b|\b(?:doesn['’]t|does not)\s+(?:record|specify|define|describe)\b/i.test(q.question) &&
        /\bShould I (?:add|fix|specify|define|restore)\b[^?]+\?\s*<gstack-qid:[^>]+>\s*$/i.test(q.question) &&
        fixChoice && leaveChoice && chosen &&
        !(call.unansweredQuestionIndices?.length) &&
        fp.signature === `${call.sessionId}:${call.toolUseId}`) return true;
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
  const completed = /^Design\s+review\s+(?:is\s+)?complete(?:[.!]|\s+\((?:\d+(?:\.\d+)?(?:\/10)?\s*(?:→|->|to)\s*)?\d+(?:\.\d+)?\/10(?:,\s*\d+\s+decisions?(?:\s+(?:made|added))?)?\)[.!])(?:\s|$)/i.exec(declaration);
  if (!completed) return null;
  const requiredGateOffer = /^The required next gate is Eng(?:ineering)? Review\s*[—–-]\s*want me to run it now\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration.slice(completed[0].length).trim());
  const requiredGateQuestion = requiredGateOffer || /^(?:\d+ implementation tasks ready\.\s*)?Eng(?:ineering)? Review is the required shipping gate\.\s*What next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration.slice(completed[0].length).trim());
  // The offered Eng action can carry the required-gate declaration while the
  // closed question asks only what is next. Its descriptions remain part of
  // the decision, so they cannot conceal a new repair or conditional closure.
  const describedRequiredGate = /^What['’]s\s+next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration.slice(completed[0].length).trim()) &&
    q.options.some(option => /^Run \/plan-eng-review(?:\s*\(recommended\))?$/i.test(option.label.trim()) &&
      /^Required gate before shipping[.!]/i.test(option.description ?? ''));
  const guardedNavigation = requiredGateQuestion || describedRequiredGate;
  if (!requiredGateQuestion && !/\bWhat['’]s\s+next\?\s*<gstack-qid:[a-z0-9-]+>\s*$/i.test(declaration)) return null;
  // A routing label cannot conceal a new repair in its description.
  if (guardedNavigation && q.options.some(option =>
    /(?:^|[.!?;]\s+|\b(?:proceed to|continue to|must|need to)\s+)(?:(?:please|first|then|also)\s+)*(?:add|fix|repair|implement|resolve|decide)\b|\b(?:(?:should|could|can|would)\s+(?:we|I)|(?:we|I)\s+(?:should|could|can|would))\s+(?:add|fix|repair|implement|resolve|decide)\b/i.test(option.description ?? '') ||
    /\b(?:Design|the|this)\s+review\s+(?:(?:is|remains)\s+)?(?:not\s+(?:complete|done|resolved)|incomplete|unfinished)\b|\bnot\s+all\s+(?:decisions|findings|issues|gaps)\s+(?:are\s+)?(?:resolved|complete|done)\b|\b(?:decisions|findings|issues|gaps)\s+(?:are\s+)?not\s+(?:resolved|complete|done)\b/i.test(option.description ?? '') ||
    /\b(?:once|after|when|if|unless|until)\b[^.!?]*\b(?:review|decisions?|findings?|issues?|gaps?)\b[^.!?]*\b(?:complete|done|resolved)\b|\b(?:review|decisions?|findings?|issues?|gaps?)\b[^.!?]*\b(?:complete|done|resolved)\b[^.!?]*\b(?:once|after|when|if|unless|until)\b/i.test(option.description ?? ''))) return null;
  // A closed heading does not override an affirmative outstanding-work claim
  // in its recap. Zero/no outstanding work is a compatible completion claim.
  const outstanding = (guardedNavigation ? [declaration, ...q.options.map(o => o.description ?? '')].join('\n') : declaration)
    .replace(/\b(?:no|zero|0)\s+(?:unresolved|open|pending|unaddressed|remaining|outstanding)\s+(?:[a-z-]+\s+){0,3}(?:gaps?|issues?|decisions?|requirements?|work)\b/gi, '')
    .replace(/\bno\s+(?:gaps?|issues?|decisions?|requirements?|work)\s+remains?\b/gi, '');
  if (/\b(?:unresolved|open|pending|unaddressed|remaining|outstanding)\s+(?:[a-z-]+\s+){0,3}(?:gaps?|issues?|decisions?|requirements?|work)\b|\b(?:gaps?|issues?|decisions?|requirements?|work)\s+(?:still\s+)?remains?\b|\b(?:gaps?|issues?|decisions?|requirements?|work)\s+(?:is|are)\s+still\s+(?:unresolved|open|pending|unaddressed)\b/i.test(outstanding)) return null;
  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z][).]\s*/i, '')
    .replace(/\s*\(recommended\)\s*$/i, '').trim());
  const manual = labels.map(label => /^(?:Handle next steps manually|Skip\s*[—–-]\s*I['’]ll handle next steps manually)$/i.test(label) ||
    (guardedNavigation && /^Skip\s*[—–-]\s*handle (?:next steps )?manually$/i.test(label)));
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
