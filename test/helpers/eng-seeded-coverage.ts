import type { NativePlanQuestionCall, PlanCountTranscript } from './plan-count-transcript';

/** Evidence for this fixture's four decision seeds; regression coverage is auto-added by the skill. */
export const ENG_DECISION_SEEDS = ['complexity', 'shared-cache', 'swallowed-errors', 'sequential-idp'] as const;
type Seed = typeof ENG_DECISION_SEEDS[number];

// Ignore displayed examples/code, while retaining inline code identifiers.
function prose(text: string): string {
  let fence: string | undefined;
  return text.split('\n').filter(line => {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (mark) {
      if (!fence) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = undefined;
      return false;
    }
    return !fence && !/^(?: {0,3}>| {4}|\t)/.test(line);
  }).join('\n').replace(/[`*]/g, '');
}

function seedSubjects(call: NativePlanQuestionCall): Seed[] {
  const q = call.questions[0]!;
  // The actual issue subject, not cross-references in recommendations or other options,
  // assigns credit. ELI10 can identify what a terse Promise.all title operates on.
  const subject = q.question.split('\n').find(line => line.trim())?.trim() ?? '';
  if (/^(?:>|`{3}|~{3}|example\b|quote\b|["“])|\b(?:no (?:issue|defect)|already (?:fixed|resolved)|hypothetical)\b/i.test(subject)) return [];
  const title = subject.replace(/[`*]/g, '');
  const offered = q.options.map(o => `${o.label} ${o.description ?? ''}`).join('\n');
  const directAction = title.match(/\b(?:should|shall|can|do|would)\s+(?:we|I)\s+([^?]+)\?\s*$/i)?.[1];
  const action = (re: RegExp) => re.test(offered) || Boolean(directAction && new RegExp(`^(?:${re.source})`, re.flags).test(directAction));
  const ids: Seed[] = [];
  if (/\b(?:scope|complexity|classes|types|abstractions)\b/i.test(title) &&
      /\b(?:files|classes|types|abstractions)\b/i.test(title) &&
      action(/\b(?:reduce|cut|simplify|remove|collapse|merge|pure function)\b/i)) ids.push('complexity');
  if (/\b(?:AuthCache|cache)\b/i.test(title) &&
      /\b(?:global|module[ -]level|mutab\w*|both|shar\w*|ownership|writers)\b/i.test(title) &&
      action(/\b(?:inject\w*|DI|serializ\w*|single[ -]writer|ownership|composition root)\b/i)) ids.push('shared-cache');
  if (/\b(?:validateAndDispatch|catch\w*)\b/i.test(title) &&
      /\b(?:swallow\w*|nested|silent\w*|hidden|suppres\w*)\b/i.test(title) &&
      action(/\b(?:split|rethrow|typed|flatten|propagat\w*)\b/i)) ids.push('swallowed-errors');
  if (/\b(?:sequential|parallel\w*|Promise\.all(?:Settled)?)\b/i.test(title) &&
      /\b(?:IDP|identity provider)\b/i.test(prose(q.question)) &&
      action(/\b(?:parallel\w*|Promise\.all(?:Settled)?)\b/i)) ids.push('sequential-idp');
  return ids;
}

function completedDecision(call: NativePlanQuestionCall, startedAt: number, finishedAt: number): boolean {
  const answeredAt = Date.parse(call.answeredAt ?? '');
  if (!call.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      !Number.isFinite(answeredAt) || answeredAt < startedAt || answeredAt > finishedAt ||
      call.questions.length !== 1 || !Array.isArray(call.unansweredQuestionIndices) ||
      call.unansweredQuestionIndices.length !== 0) return false;
  const q = call.questions[0]!;
  return !q.multiSelect && q.options.length >= 2 && q.options.length <= 4 &&
    q.options.every(o => o.label.trim()) && new Set(q.options.map(o => o.label)).size === q.options.length &&
    Object.keys(call.answers ?? {}).length === 1 &&
    q.options.some(o => call.answers?.[q.question] === o.label);
}

function regressionEvidence(text: string): boolean {
  return prose(text).split(/\n\s*\n|\n(?=\s*[-#])/).some(block => {
    const task = block.trim().replace(/^[-+]\s+(?:\[[ xX]\]\s*)?/, '')
      .replace(/^T\d+(?:\s*\([^\n)]*\))?\s*[—–:-]\s*/, '');
    const legacySubject = /^legacyAuthFlow(?:\(\))?\s*[—–:-]\s*/i;
    const action = task.replace(legacySubject, '');
    const instruction = action.match(/^(?:(?:I|we)\s+)?(?:add(?:ed)?|record(?:ed)?|write|wrote|require(?:d)?|include(?:d)?)\s+((?:(?:a|the|new|required|legacyAuthFlow(?:\(\))?|regression|characterization|baseline|prior-behavior)\s+)*(?:tests?|fixtures?))\b([^.;\n]*)/i);
    const explicitTarget = instruction && /^\s+(?:for|of|covering|characterizing)\b/i.test(instruction[2]!);
    const legacyTarget = instruction && /^\s+(?:for|of|covering|characterizing)\s+(?:the\s+)?(?:prior behavior of\s+)?legacyAuthFlow\b/i.test(instruction[2]!);
    const target = instruction && (!explicitTarget || legacyTarget) &&
      (legacySubject.test(task) || /\blegacyAuthFlow\b/.test(instruction[1]!) || legacyTarget);
    // An affirmative task or completed addition, not an example, quotation,
    // conditional proposal or an uncertain discussion of whether to add it.
    return Boolean(target) &&
    /\b(?:regression|characterization)\b/i.test(instruction![0]) &&
    /\b(?:before|prior behavior|parity|compatibility|characterization)\b/i.test(instruction![0]) &&
    !/\b(?:no|not|never|skip\w*|defer\w*|maybe|might|could|if|unless|optional)\b/i.test(block);
  });
}

export function evaluateEngSeedCoverage(transcript: PlanCountTranscript, plan: string,
  startedAt: number, finishedAt: number) {
  const decisions: Partial<Record<Seed, string>> = {};
  const problems: string[] = [];
  const sessions = new Set(transcript.calls.map(c => c.sessionId));
  const identities = transcript.calls.map(c => `${c.sessionId}:${c.toolUseId}`);
  const bound = transcript.status === 'ready' && sessions.size === 1 && !sessions.has('') &&
    identities.length === new Set(identities).size && Number.isFinite(startedAt) &&
    Number.isFinite(finishedAt) && startedAt <= finishedAt;
  if (!bound) problems.push('missing, ambiguous or unbound native transcript');
  if (bound) for (const call of transcript.calls) {
    if (!completedDecision(call, startedAt, finishedAt)) continue;
    const seeds = seedSubjects(call);
    // One combined approval cannot replace separate decisions for independent seeds.
    if (seeds.length === 1) decisions[seeds[0]!] ??= `${call.sessionId}:${call.toolUseId}`;
  }
  const missing = ENG_DECISION_SEEDS.filter(seed => !decisions[seed]);
  const regression = regressionEvidence(plan) ? 'plan' : bound && transcript.assistantMessages.some(m =>
    sessions.has(m.sessionId) && Date.parse(m.timestamp) >= startedAt && Date.parse(m.timestamp) <= finishedAt &&
    regressionEvidence(m.text)) ? 'public-narration' : undefined;
  if (!regression) problems.push('mandatory legacy regression coverage absent');
  // The caller also retains the existing fresh owned-path/native completion and D19 checks.
  if (!/^## GSTACK REVIEW REPORT[\t ]*\n\s*\S/m.test(prose(plan))) problems.push('final review report absent or empty');
  return { ok: bound && missing.length === 0 && problems.length === 0, decisions, missing, regression, problems };
}
