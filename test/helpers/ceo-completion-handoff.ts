import type { AskUserQuestionFingerprint } from './claude-pty-runner';

/** Only the CEO's finished-review menu, never a finding/TODO mentioning another skill. */
function manualHandoffIndex(fp: AskUserQuestionFingerprint): number | null {
  const call = fp.nativeCall;
  // The capture path assigns this native identity only after matching the
  // active question. UI-only and mismatched pending records cannot steer it.
  if (!call || call.failed || fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1) return null;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2) return null;
  const id = /<gstack-qid:\s*([a-z0-9-]+)\s*>/i.exec(q.question)?.[1]?.toLowerCase();
  if (id && !/^plan-ceo-(?:review-)?next-(?:steps?|review)$/.test(id)) return null;
  const declaration = q.question.replace(/^D\s*\d+\s*[—–:-]\s*/i, '')
    .replace(/^next\s+(?:review|steps?)\s*:\s*/i, '');
  const completion = /(?:^|[.!?]\s+)(?:The\s+)?CEO\s+review\s+(?:is\s+)?(?:complete|cleared|clean)(?=\s*(?:[.!?—–]|$))/i.test(declaration);
  const gateContext = [q.question, ...q.options.map(option => option.description ?? '')].join('\n');
  const requiredEng = /(?:\bEng(?:ineering)?\s+review|\/plan-eng-review)\b[^.!?]{0,180}\brequired(?:\s+shipping)?\s+gate\b/i.test(gateContext);
  // A qid names the menu; it cannot replace its completed-review declaration
  // or authorize another fix. The named gate can be explained in a choice.
  if (!/^next\s+(?:review|steps?)$/i.test(q.header.trim()) || !completion || !requiredEng) return null;

  const labels = q.options.map(o => o.label.trim().replace(/^[A-Z][).]\s*/i, '').replace(/\s*\(recommended\)\s*$/i, '').trim());
  const runs = labels.map(label => /^Run\s+\/plan-(?:eng|design)-review\s+(?:next|now)(?:\s*\(required gate\))?$/i.test(label));
  const manual = labels.map(label => /^(?:Skip|Done)\s*[—–-]\s*(?:I['’]ll\s+)?handle\s+reviews\s+manually$/i.test(label));
  // Every choice must be administrative. Adding a fix/TODO/build option
  // makes the whole call substantive, even if it also offers a next review.
  if (!runs.some(Boolean) || manual.filter(Boolean).length !== 1 || !labels.every((_, i) => runs[i] || manual[i])) return null;
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
