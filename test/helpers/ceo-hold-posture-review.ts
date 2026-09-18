import { basename, isAbsolute, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { nativePlanCallFingerprint } from './claude-pty-runner';
import { nativeCeoModeAnswer, type CeoPostureSource } from './ceo-mode-option';
import { evaluatePlanReviewDecisions, type PlanReviewDecisionInput, type PlanReviewJudge } from './plan-review-decisions';
import type { NativePlanQuestionCall, NativePublicToolEvent, PlanCountTranscript } from './plan-count-transcript';

export interface CeoHoldPostureReviewInput {
  transcript: PlanCountTranscript;
  publicTools: ReadonlyArray<NativePublicToolEvent>;
  source: CeoPostureSource;
  selectionStartedAt: number;
  deadlineAt: number;
  /** The one post-mode call the existing fixture actually chose to answer. */
  continuedCallId: string;
}

const target = 'hold-current-plan-proof';
const identity = (call: NativePlanQuestionCall) => `${call.sessionId}:${call.toolUseId}`;
const fail = (reason: string): never => { throw new Error(`HOLD posture review: ${reason}`); };

/** A pending answer is not a reason to launch semantic work. All other evidence
 * must already be complete and owned before the existing evaluator is called. */
export function buildCeoHoldPostureReview(input: CeoHoldPostureReviewInput): PlanReviewDecisionInput | null {
  const snapshot = structuredClone(input), { transcript, publicTools: events, source } = snapshot;
  if (transcript.status !== 'ready') return null;
  if (!Number.isFinite(input.selectionStartedAt) || !Number.isFinite(input.deadlineAt) ||
      input.selectionStartedAt > Date.now() || input.deadlineAt <= Date.now()) fail('original posture deadline exhausted or invalid');
  const mode = nativeCeoModeAnswer(transcript, 'HOLD SCOPE', input.selectionStartedAt);
  if (!mode) return null;
  const candidates = transcript.calls.filter(call => identity(call) === input.continuedCallId);
  if (!candidates.length || (candidates.length === 1 && !candidates[0]!.answered && !candidates[0]!.failed)) return null;
  if (candidates.length !== 1) fail('duplicate continued call');
  const decision = candidates[0]!;
  if (decision === mode || decision.sessionId !== mode.sessionId ||
      transcript.calls.filter(call => identity(call) === identity(mode)).length !== 1) fail('foreign or duplicate mode/decision identity');
  const completed = (call: NativePlanQuestionCall) => {
    const pairs = events.filter(event => event.sessionId === call.sessionId && event.toolUseId === call.toolUseId);
    const uses = pairs.filter(event => event.kind === 'use'), replies = pairs.filter(event => event.kind === 'result');
    if (!call.answered || call.failed || call.questions.length !== 1 ||
        !Array.isArray(call.unansweredQuestionIndices) || call.unansweredQuestionIndices.length || uses.length !== 1 || replies.length !== 1)
      fail('one complete native request and successful answer are required');
    const request = uses[0]!, reply = replies[0]!, requestedAt = Date.parse(request.timestamp), answeredAt = Date.parse(reply.timestamp);
    if (request.name !== 'AskUserQuestion' || !isDeepStrictEqual(request.input?.questions, call.questions) ||
        reply.isError !== false || reply.timestamp !== call.answeredAt || !Number.isFinite(requestedAt) ||
        !Number.isFinite(answeredAt) || requestedAt >= answeredAt || answeredAt > Date.now() || answeredAt > input.deadlineAt)
      fail('native request/answer binding or chronology differs');
    const q = call.questions[0]!;
    if (q.multiSelect !== false && q.multiSelect !== undefined || !q.question.trim() || !q.header.trim() || q.options.length < 2 || q.options.length > 4 ||
        new Set(q.options.map(option => option.label)).size !== q.options.length ||
        q.options.some(option => !option.label.trim() || typeof option.description !== 'string' || !option.description.trim()) ||
        Object.keys(call.answers ?? {}).length !== 1 || !q.options.some(option => option.label === call.answers?.[q.question]))
      fail('incomplete native question or unoffered selected answer');
    return { requestedAt, answeredAt };
  };
  const modeTime = completed(mode), decisionTime = completed(decision);
  if (modeTime.answeredAt < input.selectionStartedAt || decisionTime.requestedAt <= modeTime.answeredAt) fail('decision precedes actual mode answer');
  if (transcript.calls.filter(call => call.sessionId === mode.sessionId && call.answered &&
      Date.parse(call.answeredAt ?? '') > modeTime.answeredAt).length !== 1) fail('more than one post-mode answer');
  if (!isAbsolute(source.path) || normalize(source.path) !== source.path || !source.content.trim()) fail('missing original source identity');
  const name = basename(source.path);
  for (const call of [mode, decision]) {
    const context = /Project\/branch\/task:([^\n]*)/i.exec(call.questions[0]!.question)?.[1] ?? '';
    const plans = [...new Set(context.match(/(?<![\w./-])[\w./-]+\.md(?![\w./-])/gi) ?? [])];
    if (plans.length !== 1 || (plans[0] !== name && plans[0] !== source.path)) fail('native source context differs from original plan');
  }
  const decisionContext = /Project\/branch\/task:([^\n]*)/i.exec(decision.questions[0]!.question)?.[1] ?? '';
  if (!/\bHOLD SCOPE\b/.test(decisionContext) ||
      /\b(?:SCOPE EXPANSION|SELECTIVE EXPANSION|SCOPE REDUCTION|historical|previous|example|hypothetical|withdrawn)\b/i.test(decisionContext))
    fail('decision is not current HOLD work');
  const sourceLines = source.content.split('\n').length;
  const loaded = events.some(request => {
    if (request.kind !== 'use' || request.name !== 'Read' || request.sessionId !== mode.sessionId ||
        request.input?.file_path !== source.path || (request.input?.offset ?? 1) !== 1) return false;
    const pairs = events.filter(event => event.sessionId === request.sessionId && event.toolUseId === request.toolUseId);
    const uses = pairs.filter(event => event.kind === 'use'), replies = pairs.filter(event => event.kind === 'result');
    if (uses.length !== 1 || replies.length !== 1) return false;
    const reply = replies[0]!;
    const file = reply.file && typeof reply.file === 'object' && !Array.isArray(reply.file) ? reply.file as Record<string, unknown> : undefined;
    const at = Date.parse(request.timestamp), end = Date.parse(reply.timestamp);
    return reply.isError === false && Number.isFinite(at) && Number.isFinite(end) && at <= end && end < decisionTime.requestedAt &&
      file?.filePath === source.path && file.content === source.content && file.startLine === 1 &&
      file.numLines === sourceLines && file.totalLines === sourceLines &&
      (request.input?.limit === undefined || Number.isInteger(request.input.limit) && Number(request.input.limit) >= sourceLines);
  });
  if (!loaded) fail('complete original source Read/ACK is missing');
  return {
    plan: source.content, kind: 'findings', floor: 1, ceiling: 1, deadlineAt: input.deadlineAt,
    targets: [{ id: target, description: 'Only the actual selected post-mode remedy can cover this target. It must make an explicitly existing requirement or acceptance criterion in the original plan implementable or verifiable, while retaining that required behavior. It must not add a user capability, independently selectable policy, extra measurement objective or unrelated work, even when described as instrumentation or measurement. A definition and its necessary proof mechanism for the same existing criterion can be one decision. Removing or deferring an existing requirement, an optional enhancement, a mere mode mention, an informational answer, or a recommendation without its actual selected remedy does not cover this target. Quote the question and the actual selected option as evidence; do not infer a new requirement from the proposed options.' }],
    fingerprints: [mode, decision].map(call => ({ ...nativePlanCallFingerprint(call, Date.parse(call.answeredAt!), false),
      toolUseId: identity(call), questions: call.questions.map(question => ({ ...structuredClone(question),
        multiSelect: question.multiSelect ?? false, options: question.options.map(option => ({ ...option, description: option.description! })) })),
      selectedOptions: call.questions.map(question => question.options.findIndex(option => option.label === call.answers![question.question]) + 1) })),
  };
}

/** The existing evaluator supplies meaning; local gates retain exact evidence.
 * This assesses one already answered decision and never authorizes another. */
export async function evaluateCeoHoldPostureReview(input: PlanReviewDecisionInput, judge?: PlanReviewJudge): Promise<void> {
  const snapshot = structuredClone(input);
  const result = await evaluatePlanReviewDecisions(snapshot, judge);
  const [mode, decision] = snapshot.fingerprints;
  const rows = result.judgment.questions;
  const modeRow = rows.find(row => row.toolUseId === mode?.toolUseId), row = rows.find(row => row.toolUseId === decision?.toolUseId);
  if (rows.length !== 2 || modeRow?.kind !== 'workflow' || row?.kind !== 'finding' ||
      row.targetIds.length !== 1 || row.targetIds[0] !== target || row.independentDecisions !== 1 ||
      !row.evidence.some(evidence => evidence.field === 'question') ||
      !row.evidence.some(evidence => (evidence.field === 'optionLabel' || evidence.field === 'optionDescription') &&
        evidence.optionIndex === decision?.selectedOptions?.[0])) fail('assessment lacks the current selected remedy and exact supporting fields');
}
