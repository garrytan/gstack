import type { AskUserQuestionFingerprint } from './claude-pty-runner';
import { pickCeoCompletionHandoff } from './ceo-completion-handoff';

/** Follow the offered recommendation only in the native pre-review approach menu. */
export function pickCeoRecommendedApproach(fp: AskUserQuestionFingerprint): number | null {
  const call = fp.nativeCall;
  if (!fp.preReview || !call || call.answered !== false || call.failed !== false ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1 ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0)) return null;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length < 2 || !/^Approach$/i.test(q.header.trim())) return null;
  const ids = [...q.question.matchAll(/<gstack-qid:\s*([a-z0-9-]+)\s*>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1) return null;
  const qid = ids[0]![1]!.toLowerCase();
  const question = q.question.trim().replace(/^D\s*\d+\s*[—–:-]\s*/i, '');
  const planApproach = qid === 'plan-ceo-approach' &&
    /^Which implementation approach should this plan use\?(?:\s|$)/i.test(question);
  const testApproach = qid === 'plan-ceo-review-impl-approach' &&
    /^Which implementation approach for the [a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*\(\) tests\?(?:\s|$)/i.test(question);
  if (!planApproach && !testApproach) return null;
  if (fp.options.length !== q.options.length || !fp.options.every((option, i) =>
    option.index === i + 1 && option.label === q.options[i]!.label)) return null;
  const labels = q.options.map(option => option.label.trim());
  if (new Set(labels).size !== labels.length) return null;
  const recommended = labels.map((label, i) => ({ label, index: i + 1 })).filter(({ label }) =>
    /\s\(Recommended\)\s*$/i.test(label) &&
    (label.match(/\brecommended\b/gi)?.length ?? 0) === 1 &&
    !/\b(?:not|never)\s*\(recommended\)/i.test(label));
  return recommended.length === 1 ? recommended[0]!.index : null;
}

/** Preserve the existing manual handoff and all other caller/default choices. */
export function pickCeoCountQuestion(
  fp: AskUserQuestionFingerprint,
  activeCapture: AskUserQuestionFingerprint = fp,
): number | null {
  return pickCeoRecommendedApproach(activeCapture) ?? pickCeoCompletionHandoff(fp, activeCapture);
}
