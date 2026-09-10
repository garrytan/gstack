import type { NativePlanQuestion, PlanCountTranscript } from './plan-count-transcript';

export const DEVEX_SEEDED_GAPS = [
  'local-ci-gate', 'missing-quickstart', 'reversed-arguments', 'opaque-auth-error', 'breaking-upgrade',
] as const;
export type DevexSeededGap = typeof DEVEX_SEEDED_GAPS[number];

/** Bind an unnamed signature question to its own first asserted explanation. */
function explainedReversedSignatures(q: NativePlanQuestion, title: string): boolean {
  if (!/^(?:Journey stage [A-Z ]+: )?the two public functions take the same two arguments in (?:opposite|reversed) positional order\. How should (?:the plan|we) (?:fix|align|unify) the signatures\?$/i.test(title)) return false;
  const lines = q.question.split('\n');
  if (lines[0]!.trim().replace(/^D\s*\d+\s*[—–:-]\s*/i, '') !== title) return false;
  const explanation = lines.findIndex(line => line.startsWith('ELI10: '));
  if (explanation < 1 || lines.slice(1, explanation).filter(line => line.trim()).some(line =>
    !/^Project\/branch\/task: [^;\n]+; reviewing the public function signatures in [\w./-]+\.$/.test(line) ||
    /\b(?:quoted|source excerpt|source example|hypothetical|historical|not (?:a )?current|if approved)\b/i.test(line))) return false;
  // Inline code may name each signature; a quoted/fenced explanation, earlier
  // unrelated sentence, past definition or hypothetical definition cannot.
  if (!/^ELI10: [\w./-]+(?: lines? \d+(?:\s*[-–]\s*\d+)?)? define (`?)run_eval\(\s*dataset\s*,\s*evaluator\s*\)\1 and (`?)run_batch\(\s*evaluator\s*,\s*dataset\s*\)\2\./.test(lines[explanation]!)) return false;
  const currentProse = (text: string) => {
    let fence = false;
    return text.split('\n').filter(line => {
      if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; return false; }
      return !fence && !/^\s*>/.test(line);
    }).join('\n').replace(/`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g, '');
  };
  const current = currentProse(lines.slice(explanation).join('\n'));
  if ((current.match(/^ELI10:/gm)?.length ?? 0) !== 1) return false;
  if (/(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:(?:this|that|the) (?:finding|explanation)|(?:(?:this|that|the) )?argument[- ]order (?:issue|defect)|these signatures)\b[^.\n]*\b(?:withdrawn|rejected|(?:already )?(?:fixed|resolved)|historical|not current)\b/i.test(current) ||
      /(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:there is|there's) no argument[- ]order (?:issue|defect)\b/i.test(current) ||
      /(?:^|[.!?\n]\s*)(?:Correction:\s*)?run_eval and run_batch now (?:use|take) the same positional order\b/i.test(current)) return false;
  // The same offered action must align both functions and retain the call-site
  // swap guard. Selecting an offered alternate or deferral is still a decision.
  return q.options.some(option => /^Same order\s*\+\s*swap guard(?: \(recommended\))?$/i.test(option.label) &&
    /^(?:✅\s*)?Both (?:become|use|take) `?\(\s*dataset\s*,\s*evaluator\s*\)`?, accept keywords, and raise a call-site `?TypeError`? naming the swapped argument and the fix if types are reversed\./i.test(option.description ?? '') &&
    !/(?:^|[.!?\n]\s*)(?:Correction:\s*)?(?:(?:do not|don't|never) (?:change|align|unify) (?:either|both|the) signatures?\b|(?:do not|don't|never|skip) (?:add|require|implement) (?:a |the )?swap guard\b|(?:this|the) (?:option|correction|action) is (?:withdrawn|rejected|cancelled)\b)/i.test(currentProse(option.description ?? '')));
}

/** Identify a dedicated seed decision by its subject and meaningful alternatives. */
function decisionGaps(q: NativePlanQuestion): DevexSeededGap[] {
  const title = q.question.split('\n')[0]!.trim().replace(/^D\s*\d+\s*[—–:-]\s*/i, '')
    .replace(/`([^`\n]+)`/g, '$1');
  if (!title.endsWith('?') || (title.match(/\?/g)?.length ?? 0) !== 1 ||
      /^(?:>|"|“|Example\b|Quoted\b|Suppose\b)|\bhypothetical\b/i.test(title) ||
      /\b(?:continue|proceed|next section|move on|format|already (?:fixed|resolved))\b/i.test(title) ||
      /\b(?:have|did)\b[^?]*\bread\b|\b(?:narrative|trace|recap|summary)\b[^?]*\b(?:accurate|match|confirm)\b/i.test(title) ||
      /\b(?:report|summary|recap)\b[^?]*\b(?:mention|include|reference|list)\b|\b(?:mention|include|reference|list)\b[^?]*\b(?:report|summary|recap)\b/i.test(title)) return [];
  const options = q.options.map(o => `${o.label} ${o.description ?? ''}`);
  const labels = q.options.map(o => o.label.trim().replace(/\s*\(recommended\)$/i, '').toLowerCase());
  const yesNo = labels.length === 2 && labels.includes('yes') && labels.includes('no');
  // A terse Yes/No panel still resolves an action explicitly asked in the
  // main question; action words in background prose never supply this arm.
  const directAction = (verbs: string) => yesNo && new RegExp(
    `^(?:should|shall|can|do|would) (?:we|I) (?:${verbs})\\b[^?]*\\?$`, 'i').test(title);

  const found: DevexSeededGap[] = [];
  if (/\bCI\b/i.test(title) && /\b(?:local|demo|first)\b/i.test(title) &&
      /\b(?:gate|check|blocks?|waits?|bypass|mandatory|required)\b/i.test(title) &&
      (options.some(o => /\b(?:no CI gate|remove|move|skip|bypass|gate)\b/i.test(o) && /\b(?:CI|check|gate|local|demo)\b/i.test(o)) || directAction('remove|move|skip|bypass|gate'))) found.push('local-ci-gate');
  if (/\bquickstart\b|examples\/first_eval\.py/i.test(title) &&
      /\b(?:README|file|example|demo|missing|absent|package|wheel|ship|point)\b|first_eval\.py/i.test(title) &&
      (options.some(o => /\b(?:point|ship|add|demo is)\b/i.test(o) && /\bquickstart\b|first_eval\.py/i.test(o)) || directAction('point|ship|add|replace|fix'))) found.push('missing-quickstart');
  if (explainedReversedSignatures(q, title) || (/\brun_eval\b/i.test(title) && /\brun_batch\b/i.test(title) &&
      /\b(?:arguments?|order|positional|reversed|opposite|consistent|align|unify|dataset|evaluator)\b/i.test(title) &&
      (options.some(o => /\b(?:align|unify|standardize|keyword|swap)\b/i.test(o) && /\b(?:order|dataset|arguments?|positional)\b/i.test(o)) || directAction('align|unify|standardize|enforce|make')))) found.push('reversed-arguments');
  if (/\bAuthError\b|\binvalid API key\b/i.test(title) &&
      /\b(?:error|message|code|cause|fix|guidance|opaque|explain)\b|request failed/i.test(title) &&
      (options.some(o => /\bcode\b/i.test(o) && /\b(?:cause|fix|link)\b/i.test(o)) || directAction('add|include|explain|replace|report|give'))) found.push('opaque-auth-error');
  if (/Client\.evaluate\b/i.test(title) &&
      /Client\.run\b|\b(?:v\d+|version \d+|alias|deprecation|migration)\b/i.test(title) &&
      /\b(?:alias|warning|compatibility|deprecat\w*|migration|remov\w*|rename|keep)\b/i.test(title) &&
      (options.some(o => /\balias\b/i.test(o) && /\b(?:warning|DeprecationWarning|migration)\b/i.test(o)) || directAction('keep|add|preserve|provide|retain'))) found.push('breaking-upgrade');
  return found;
}

/** Extra real decisions are permitted; each seeded gap needs its own completed native call. */
export function devexSeedCoverage(transcript: PlanCountTranscript) {
  const decisions = Object.fromEntries(DEVEX_SEEDED_GAPS.map(gap => [gap, []])) as Record<DevexSeededGap, string[]>;
  const batched: string[] = [];
  const invalid: string[] = [];
  const sessions = new Set(transcript.calls.map(c => c.sessionId));
  if (transcript.status !== 'ready' || sessions.size !== 1 || sessions.has('')) invalid.push('missing or mixed native session');
  const ids = new Set<string>();
  for (const call of transcript.calls) {
    const id = `${call.sessionId}:${call.toolUseId}`;
    if (!call.toolUseId || ids.has(id)) { invalid.push(`missing or repeated native call: ${id}`); continue; }
    ids.add(id);
    const gaps = call.questions.flatMap(decisionGaps);
    if (!gaps.length) continue;
    if (call.questions.length !== 1 || gaps.length !== 1 || call.questions[0]!.multiSelect) {
      batched.push(id); continue;
    }
    const q = call.questions[0]!;
    const labels = q.options.map(o => o.label);
    const complete = call.answered === true && call.failed === false &&
      Array.isArray(call.unansweredQuestionIndices) && call.unansweredQuestionIndices.length === 0 &&
      Number.isFinite(Date.parse(call.answeredAt ?? '')) && q.options.length >= 2 && q.options.length <= 4 &&
      new Set(labels).size === labels.length && labels.every(Boolean) &&
      Object.keys(call.answers ?? {}).length === 1 && labels.includes(call.answers?.[q.question] ?? '');
    if (complete) decisions[gaps[0]!]!.push(id);
  }
  const missing = DEVEX_SEEDED_GAPS.filter(gap => decisions[gap].length === 0);
  const matchedIds = new Set(Object.values(decisions).flat());
  return {
    complete: invalid.length === 0 && batched.length === 0 && missing.length === 0 && matchedIds.size >= DEVEX_SEEDED_GAPS.length,
    missing, decisions, batched, invalid,
  };
}
