import type { NativeQuestion } from './plan-skill-questions';
import { CEO_SCOPE_CANDIDATES, pickPlanReviewQuestion } from './plan-review-cases';
import { findCeoModeOption } from './ceo-mode-option';
import type { AskUserQuestionFingerprint } from './claude-pty-runner';
import type { PlanCountTranscript } from './plan-count-transcript';
import { isDeepStrictEqual } from 'node:util';

const optionLabel = (label: string) => label.trim().replace(/^[A-D][).] /, '')
  .replace(/ \(recommended\)$/i, '');
const platforms = ['Slack', 'Discord', '(?:Microsoft )?Teams', 'Telegram', 'Mattermost'];

export function ceoSplitOptionAction(label: string): 'include' | 'defer' | 'cut' | 'hold' | null {
  label = optionLabel(label);
  if (/^Include(?: in (?:this|the) scope| this quarter| \(over cap\))?$/i.test(label)) return 'include';
  if (/^Defer(?: to next quarter)?$/i.test(label)) return 'defer';
  if (/^Cut(?: entirely)?$/i.test(label)) return 'cut';
  return /^Hold$/i.test(label) ? 'hold' : null;
}

/** Candidate-shaped menus for live progress only. Final coverage, subject and
 * independence are established by evaluatePlanReviewDecisions over every call. */
export function ceoSplitCandidate(question: NativeQuestion): string | null {
  const lead = question.question.split(/\r?\n/, 1)[0]!
    .replace(/^D[1-9]\d*(?:\.[1-9]\d*)?\s*[—–:-]\s*/, '');
  const target = /^E([1-5])[):]\s+(.+\?)$/.exec(lead);
  if (!target || question.multiSelect || question.options.length < 3 || question.options.length > 4) return null;
  const id = `E${target[1]}`;
  const platform = platforms[Number(target[1]) - 1]!;
  if (!new RegExp(`^${id}\\s+${platform}$`, 'i').test(question.header.trim()) ||
      !new RegExp(`\\b${platform}\\b`, 'i').test(target[2]!) ||
      /\bE[1-5][):]/.test(target[2]!)) return null;
  const actions = question.options.map(option => ceoSplitOptionAction(option.label));
  return actions.every(Boolean) && new Set(actions).size === actions.length &&
    ['include', 'defer', 'cut'].every(action => actions.includes(action)) ? id : null;
}

export function isCeoSplitCandidateCall(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call || !call.answered || call.failed || fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  return call.questions.some(question => ceoSplitCandidate(question) !== null &&
    question.options.some(option => option.label === call.answers?.[question.question] &&
      ['include', 'defer', 'cut'].includes(ceoSplitOptionAction(option.label) ?? '')));
}

/** The real registration must apply this policy to the matched native tab.
 * A missing packet is a harness error; it cannot silently become option 1. */
export function pickCeoSplitCountQuestion(
  _routing: AskUserQuestionFingerprint, active: AskUserQuestionFingerprint,
): number {
  const call = active.nativeCall;
  const index = active.nativeQuestionIndex ?? (call?.questions.length === 1 ? 0 : undefined);
  const question = index === undefined ? undefined : call?.questions[index];
  const signature = call && `${call.sessionId}:${call.toolUseId}`;
  if (!call || call.answered || call.failed ||
      (active.signature !== signature && active.signature !== `${signature}:question:${index}`) ||
      !question || question.multiSelect || active.options.length !== question.options.length ||
      !active.options.every((option, i) => option.index === i + 1 && option.label === question.options[i]!.label)) {
    throw new Error('Split actor requires the complete matched native question before selecting');
  }
  return pickCeoSplitQuestion(question);
}

/** Adapt the current runner schema without dropping calls or treating a custom
 * answer as an offered disposition. The semantic judge gets every native field. */
export function ceoSplitDecisionFingerprints(
  transcript: PlanCountTranscript, fingerprints: readonly AskUserQuestionFingerprint[],
) {
  if (transcript.status !== 'ready' || !transcript.calls.length || transcript.calls.length !== fingerprints.length) {
    throw new Error('Split decisions require the complete owned native transcript');
  }
  const seen = new Set<string>();
  return transcript.calls.map(call => {
    const signature = `${call.sessionId}:${call.toolUseId}`;
    const matching = fingerprints.filter(fp => fp.signature === signature);
    if (!call.sessionId || !call.toolUseId || !call.answered || call.failed || seen.has(signature) ||
        matching.length !== 1 || !isDeepStrictEqual(matching[0]!.nativeCall, call)) {
      throw new Error('Split decisions require one complete acknowledged native call per fingerprint');
    }
    seen.add(signature);
    const selectedOptions = call.questions.map(question => {
      const labels = question.options.map(option => option.label);
      const selected = labels.indexOf(call.answers?.[question.question] ?? '');
      if (question.multiSelect || new Set(labels).size !== labels.length || selected < 0) {
        throw new Error('Split decisions require an exact offered answer for every native tab');
      }
      return selected + 1;
    });
    return { ...matching[0]!, toolUseId: signature, questions: structuredClone(call.questions), selectedOptions };
  });
}

/** Collection stops at the fixture's native scope decisions, not a full review
 * report. The unchanged semantic evaluator still examines every collected tab. */
export function isCeoSplitCollectionComplete(
  transcript: PlanCountTranscript, fingerprints: readonly AskUserQuestionFingerprint[],
): boolean {
  if (new Set(transcript.calls.map(call => call.sessionId)).size !== 1) return false;
  let decisions: ReturnType<typeof ceoSplitDecisionFingerprints>;
  try { decisions = ceoSplitDecisionFingerprints(transcript, fingerprints); }
  catch { return false; }
  const targets = new Set<string>();
  const calls = new Set<string>();
  for (const fp of decisions) {
    for (const [index, question] of fp.questions.entries()) {
      const target = ceoSplitCandidate(question);
      if (!target) continue;
      const selected = question.options[fp.selectedOptions[index]! - 1]!;
      if (targets.has(target) || !['include', 'defer', 'cut'].includes(ceoSplitOptionAction(selected.label) ?? '')) {
        return false;
      }
      targets.add(target);
      calls.add(fp.toolUseId);
    }
  }
  return calls.size >= CEO_SCOPE_CANDIDATES.length - 1 &&
    CEO_SCOPE_CANDIDATES.every(target => targets.has(target.id));
}

/** This simulated user keeps the split fixture's stated 2–3 integration cap.
 * Reconcile an over-cap set or defer an added channel atop three confirmed candidates;
 * every original candidate still gets its own native decision and evaluation. */
export function pickCeoSplitQuestion(question: NativeQuestion): number {
  const lead = question.question.split(/\r?\n/, 1)[0]!;
  // Mode selection changes review scope. The bounded fixture author chooses
  // HOLD SCOPE even when the menu recommends expansion or reorders its labels.
  if (/^(?:Review )?mode$/i.test(question.header.trim())) {
    const choices = question.options.map((option, i) => ({ index: i + 1, label: option.label }));
    const positions = (['HOLD SCOPE', 'SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION'] as const)
      .map(mode => findCeoModeOption(choices, mode));
    if (question.multiSelect || choices.length !== 4 || positions.some(position => position === null) ||
        new Set(positions).size !== 4) throw new Error('Split actor requires the complete four-mode menu');
    return positions[0]!;
  }
  // A fourth/fifth candidate still receives its own decision; preserving the
  // author's cap means choosing its offered deferral, never "Include (over cap)".
  if (ceoSplitCandidate(question) && question.options.some(option => optionLabel(option.label) === 'Include (over cap)')) {
    const deferrals = question.options.flatMap((option, i) => /^Defer(?: to next quarter)?$/i.test(optionLabel(option.label)) ? [i + 1] : []);
    if (deferrals.length !== 1) throw new Error('Over-cap candidate has no unique offered deferral');
    return deferrals[0]!;
  }
  // The native proposal states the three accepted candidate IDs itself. Do not
  // infer an ACK history, change any E1–E5 decision, or count an in-channel
  // feature (such as test alerts or severity routing) as another integration.
  const confirmed = /^Project\/branch\/task: [^\r\n]+; cherry-pick [1-9]\d* of [1-9]\d* on top of the confirmed (E[1-5](?: \+ E[1-5]){2}) scope\.$/
    .exec(question.question.split(/\r?\n/)[1] ?? '');
  if (question.header.trim() === 'Webhook'
    && /^D[1-9]\d*(?:\.[1-9]\d*)? — Expansion: add a generic Slack-compatible incoming-webhook channel\?$/.test(lead)
    && confirmed) {
    const labels = question.options.map(option => option.label.trim()
      .replace(/^[A-D][).] /, '').replace(/ \(recommended\)$/i, ''));
    const deferrals = labels.flatMap((label, index) => label === 'Defer to TODOS.md' ? [index + 1] : []);
    if (question.multiSelect || new Set(confirmed[1]!.split(' + ')).size !== 3
      || labels.length < 2 || labels.length > 4 || deferrals.length !== 1
      || labels.some(label => !['Add to scope', 'Defer to TODOS.md', 'Skip'].includes(label))) {
      throw new Error('Additional channel at the integration cap has no unique offered deferral');
    }
    return deferrals[0]!;
  }
  const capQuestion = question.header.trim() === 'Final set'
    && /^D[1-9]\d*(?:\.final)? — The assembled set is (?:[4-9]|[1-9]\d+|four|five|six|seven|eight|nine) items at ~?\d+ weeks, but the plan caps this quarter at 2[-–]3 integrations\. How do we resolve that\?$/.test(lead);
  if (!capQuestion) return pickPlanReviewQuestion(question);

  const labels = question.options.map(option => option.label.trim()
    .replace(/^[A-D][).] /, '').replace(/ \(recommended\)$/i, ''));
  const platform = '(?:Slack|Discord|(?:Microsoft )?Teams|Telegram|Mattermost)';
  const trim = new RegExp(`^Trim to cap: (${platform}(?: \\+ ${platform}){1,2})$`);
  const choices: number[] = [];
  let supported = !question.multiSelect && labels.length >= 2 && labels.length <= 4;
  for (const [index, label] of labels.entries()) {
    const match = trim.exec(label);
    if (match) {
      const selected = match[1]!.split(' + ').map(name => name.replace(/^Microsoft /, ''));
      if (new Set(selected).size !== selected.length) supported = false;
      choices.push(index + 1);
    } else if (!/^(?:Keep all (?:[4-9]|[1-9]\d+|four|five|six|seven|eight|nine), lift the cap|Revise one option|Hold — discuss first)$/.test(label)) {
      supported = false;
    }
  }
  if (!supported || choices.length !== 1) {
    throw new Error('Split scope reconciliation has no unique offered 2–3-platform cap-preserving answer');
  }
  return choices[0]!;
}
