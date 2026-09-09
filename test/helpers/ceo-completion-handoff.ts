import type { AskUserQuestionFingerprint } from './claude-pty-runner';

/** A native choice may carry the CEO-specific recap beside a generic completion question. */
function closedCeoRecap(description: string): boolean {
  const clause = /(?:^|[.!?]\s+)((?:The\s+)?CEO\s+review\b[^.!?]{0,240})(?=[.!?]|$)/i.exec(description)?.[1];
  if (!clause || /\b(?:if|unless|until|once|when|after|not|never)\b|n['’]t\b/i.test(clause)) return false;
  return /\b(?:all(?:\s+(?:gaps?|issues?|findings?))?(?:\s+(?:are|were))?\s+resolved|(?:no|0)\s+unresolved\s+(?:decisions|gaps|issues|findings))(?=\s*\)?\s*(?:;|$))/i.test(clause);
}

/** Past-tense resolution can close a native next-review recap without the word "complete". */
function resolvedCeoRecap(description: string): boolean {
  const clause = /(?:^|[.!?]\s+)((?:(?:This|The)\s+)?CEO\s+review\s+resolved\s+[^.!?;]{1,180}\b(?:bugs|gaps|issues|findings))(?=\s*(?:[.!?;]|$))/i.exec(description)?.[1];
  return Boolean(clause && !/\b(?:if|unless|until|once|when|after|not|never|some|most|partially|only|of|but|several|few)\b|n['’]t\b/i.test(clause));
}

/** A closed-review declaration plus one direct navigation query, even when its recap follows it. */
function closedReviewNavigation(declaration: string, context: string): boolean {
  const question = declaration.replace(/<gstack-qid:[^>]+>/gi, '');
  const unfinished = context.replace(/\b(?:no|0)\s+unresolved\s+(?:decisions|gaps|issues|findings)\b/gi, '');
  // Conditional closure of this review is unfinished work. Sequencing the
  // next review after implementation does not reopen the completed CEO review.
  const stateVerb = String.raw`(?:is|are|was|were|becomes?|became|(?:will|would|can|could|may|might)\s+(?:be|become))`;
  const closure = String.raw`(?:(?:all\s+)?(?:decisions|gaps|issues|findings)\s+(?:${stateVerb}\s+)?resolved|(?:the\s+)?CEO\s+review\s+(?:${stateVerb}\s+)?(?:complete|done|cleared|clean)|the\s+review\s+(?:${stateVerb}\s+)?(?:complete|done|cleared|clean))`;
  const conditionalClosure = new RegExp(String.raw`\b(?:once|when|after)\b[^.!?]{0,180}\b${closure}\b|\b${closure}\b[^.!?]{0,100}\b(?:once|when|after)\b`, 'i');
  return /^CEO review (?:is )?(?:complete|done|cleared|clean)[.!](?:\s|$)/i.test(question) &&
    /(?:^|[.!]\s+)What(?:['’]s)? next\?(?:\s|$)/i.test(question) &&
    (context.match(/\?/g)?.length ?? 0) === 1 &&
    !/\b(?:unresolved|outstanding|remaining|pending|if|unless|until)\b|\b(?:gap|issue|finding|decision)s?\s+(?:still\s+)?remains?\b|\bstill\s+open\b/i.test(unfinished) &&
    !/\bnot\s+(?:all|no|0)\b/i.test(context) &&
    !conditionalClosure.test(context) &&
    !/(?:^|[.!?;]\s+|\b(?:proceed to|continue to|should|must|will|need to|can|could|would)\s+)(?:(?:please|first|then|also)\s+)*(?:add|fix|implement|resolve|decide)\b/im.test(context);
}

/** Only the CEO's finished-review menu, never a finding/TODO mentioning another skill. */
function manualHandoffIndex(fp: AskUserQuestionFingerprint): number | null {
  const call = fp.nativeCall;
  // The capture path assigns this native identity only after matching the
  // active question. UI-only and mismatched pending records cannot steer it.
  if (!call || call.failed || fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1) return null;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2) return null;
  const ids = [...q.question.matchAll(/<gstack-qid:\s*([a-z0-9-]+)\s*>/gi)];
  if (ids.length > 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== ids.length) return null;
  const id = ids[0]?.[1]?.toLowerCase();
  if (id && !/^(?:plan-ceo-(?:review-)?next-(?:steps?|review)|ceo-review-next-(?:steps?|review)|ceo-next-step-eng-review|ceo-plan-next-steps)$/.test(id)) return null;
  const declaration = q.question.replace(/^D\s*\d+\s*[—–:-]\s*/i, '')
    .replace(/^next\s+(?:review|steps?)\s*:\s*/i, '');
  const gateContext = [q.question, ...q.options.map(option => option.description ?? '')].join('\n');
  const explicitCompletion = /(?:^|[.!?]\s+)(?:ELI10:\s*)?(?:The\s+)?CEO\s+review\s+(?:is\s+)?(?:complete|cleared|clean|done(?:\s+and\s+the\s+plan\s+is\s+cleared)?)(?:\s+with\s+0\s+unresolved\s+decisions)?(?=\s*(?:[.!?—–]|$))/i.test(declaration);
  const genericCompletion = /(?:^|[.!?]\s+)(?:The\s+)?review\s+(?:is\s+)?(?:complete|cleared|clean|done)(?=\s*(?:[.!?—–]|$))/i.test(declaration);
  const questionText = declaration.replace(/<gstack-qid:[^>]+>/gi, '').trim();
  const recappedNavigation = Boolean(id) &&
    /^What(?:['’]s|\s+is)\s+the\s+next\s+(?:steps?|review)\s+after\s+(?:this|the)\s+CEO\s+review\?$/i.test(questionText) &&
    q.options.some(option => resolvedCeoRecap(option.description ?? ''));
  const unfinished = gateContext.replace(/\b(?:no|0)\s+unresolved\s+(?:decisions|gaps|issues|findings)\b/gi, '');
  const describedCompletion = (recappedNavigation || (genericCompletion && q.options.some(option => closedCeoRecap(option.description ?? '')))) &&
    !/\b(?:unresolved|outstanding|remains?|remaining|pending)\b/i.test(unfinished) &&
    !/(?:^|[.!?;]\s+|\b(?:please|must|need\s+to)\s+)(?:(?:please|first|then|also)\s+)*(?:add|fix|implement|resolve|decide)\b/im.test(gateContext);
  const completion = explicitCompletion || describedCompletion;
  const requiredEng = /(?:\bEng(?:ineering)?\s+review|\/plan-eng-review)\b[^.!?]{0,180}\brequired(?:\s+shipping)?\s+gate\b/i.test(gateContext) ||
    /\brequired(?:\s+shipping)?\s+gate\s+is\s+(?:an?\s+)?(?:Eng(?:ineering)?\s+review|\/plan-eng-review)\b/i.test(gateContext);
  // These native next-review identities share a closed navigation contract;
  // the question or a following recap cannot hide a new repair obligation.
  if (id && /^(?:ceo-plan-next-steps|ceo-review-next-(?:steps?|review))$/.test(id) &&
      !closedReviewNavigation(declaration, gateContext)) return null;
  // A qid names the menu; it cannot replace its completed-review declaration
  // or authorize another fix. The named gate can be explained in a choice.
  if (!/^next\s+(?:review|steps?)$/i.test(q.header.trim()) || !completion || !requiredEng) return null;

  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z][).]\s*/i, '').replace(/\s*\(recommended\)\s*$/i, '').trim());
  const runs = labels.map(label => /^Run\s+\/plan-(?:eng|design)-review(?:\s+(?:next|now))?(?:\s*\(required gate\))?$/i.test(label));
  const manual = labels.map(label => /^(?:Skip|Done)\s*[—–-]\s*(?:I['’]ll\s+)?handle\s+(?:reviews\s+)?manually$/i.test(label));
  // Deferring the next review until after already-approved implementation is
  // navigation too. A new fix/TODO/task choice remains substantive. The picker
  // always selects manual, never this implementation route.
  const deferred = labels.map((label, i) => /^Implement\s+now,\s+eng\s+review\s+later$/i.test(label) &&
    /^Proceed to implementation with (?:the )?(?:\d+ )?(?:already )?approved (?:tasks|plan|changes)(?: \([A-Z0-9–-]+\))?\. Run \/plan-eng-review before (?:the PR is merged|shipping)\.(?: Acceptable if implementation is expected to be fast with CC\.)?$/i.test(q.options[i]!.description?.trim() ?? ''));
  if (!runs.some(Boolean) || manual.filter(Boolean).length !== 1 || !labels.every((_, i) => runs[i] || manual[i] || deferred[i])) return null;
  return manual.findIndex(Boolean) + 1;
}

/** Classification happens only after one real, successful, fully answered native call. */
export function isCeoCompletionHandoff(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.answered || call.failed || !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length) return false;
  if (manualHandoffIndex(fp) === null) return false;
  const q = call.questions[0]!;
  // A free-form answer can introduce a new substantive request. Do not
  // silently discard it merely because the menu itself was administrative.
  return q.options.some(option => option.label === call.answers?.[q.question]);
}

/** Finish this CEO fixture instead of starting another skill; reuse the existing caller-pick hook. */
export function pickCeoCompletionHandoff(
  fp: AskUserQuestionFingerprint,
  activeCapture: AskUserQuestionFingerprint = fp,
): number | null {
  return activeCapture.nativeCall?.answered ? null : manualHandoffIndex(activeCapture);
}
