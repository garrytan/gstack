import type { AskUserQuestionFingerprint } from './claude-pty-runner';
import { pickCeoCompletionHandoff } from './ceo-completion-handoff';
import { findCeoModeOption } from './ceo-mode-option';

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
  const decision = /^D\s*([1-9]\d*)\s*[—–:-]\s*/i.exec(q.question.trim());
  const approachId = /^plan-ceo(?:-review)?-approach(?:-selection)?(?:-d([1-9]\d*))?$/.exec(qid);
  // Native routing ids may carry the explicit decision number. An id for a
  // different decision cannot borrow this question's recommendation policy.
  const planApproachId = approachId !== null &&
    (!approachId[1] || approachId[1] === decision?.[1]);
  const question = q.question.trim().replace(/^D\s*\d+\s*[—–:-]\s*/i, '');
  // Native approach menus vary their routing id and use/follow wording. Match
  // the selector's structure, retaining the explicit recommendation below.
  const planApproach = planApproachId &&
    /^Which implementation approach should this plan (?:use|follow)\?(?:\s|$)/i.test(question);
  const testApproach = qid === 'plan-ceo-review-impl-approach' &&
    /^Which implementation approach for the [a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*\(\) tests\?(?:\s|$)/i.test(question);
  // A named component can be the subject instead of "this plan". Consume the
  // complete direct question; the routing id alone cannot authorize a choice.
  const directQuestion = question.replace(/\s*<gstack-qid:[^>]+>\s*$/i, '').trim();
  const component = /^Which implementation approach for (?:the|this) ((?:[a-z_$][\w$.-]*\s+){0,5})(?:handler|endpoint|service|module|component|adapter|client|worker|pipeline|integration)\?$/i.exec(directQuestion);
  const componentApproach = planApproachId &&
    component !== null && !/\b(?:and|or|then)\b/i.test(component[1]!);
  if (!planApproach && !testApproach && !componentApproach) return null;
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

/** Fixed-count fixtures review existing defects without opting into expansions. */
function pickCeoCountMode(fp: AskUserQuestionFingerprint): number | null {
  const call = fp.nativeCall;
  if (!fp.preReview || !call || call.answered !== false || call.failed !== false ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}` || call.questions.length !== 1 ||
      (fp.nativeQuestionIndex !== undefined && fp.nativeQuestionIndex !== 0)) return null;
  const q = call.questions[0]!;
  if (q.multiSelect || !/^(?:Review )?mode$/i.test(q.header.trim()) || q.options.length !== 4 ||
      fp.options.length !== 4 || !fp.options.every((option, i) =>
        option.index === i + 1 && option.label === q.options[i]!.label)) return null;
  const ids = [...q.question.matchAll(/<gstack-qid:\s*([a-z0-9-]+)\s*>/gi)];
  if (ids.length !== 1 || (q.question.match(/<gstack-qid/gi)?.length ?? 0) !== 1 ||
      !/^(?:plan-)?ceo-(?:review-)?mode(?:-selection)?$/i.test(ids[0]![1]!)) return null;
  const question = q.question.trim().replace(/^D\s*[1-9]\d*\s*[—–:-]\s*/i, '')
    .replace(/\s*<gstack-qid:[^>]+>\s*$/i, '');
  if (!/^Which review mode should I (?:use|apply)(?: for this (?:test coverage )?plan)?\?$/i.test(question)) return null;
  try {
    // Require all four modes exactly once. Reuse the mode-routing parser so
    // displayed option order and side-panel text cannot pick a different mode.
    const positions = (['HOLD SCOPE', 'SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION'] as const)
      .map(mode => findCeoModeOption(fp.options, mode));
    return positions.every(position => position !== null) && new Set(positions).size === 4
      ? positions[0]! : null;
  } catch {
    return null;
  }
}

/** Preserve the existing manual handoff and all other caller/default choices. */
export function pickCeoCountQuestion(
  fp: AskUserQuestionFingerprint,
  activeCapture: AskUserQuestionFingerprint = fp,
): number | null {
  return pickCeoCountMode(activeCapture) ?? pickCeoRecommendedApproach(activeCapture) ?? pickCeoCompletionHandoff(fp, activeCapture);
}
