import type { AskUserQuestionFingerprint } from './claude-pty-runner';

/** Accepted rendering of existing decisions adds an artifact, not a finding.
 * It still changes the deliverable and therefore remains a freshness boundary.
 */
export function isDesignArtifactGeneration(fp: AskUserQuestionFingerprint): boolean {
  const call = fp.nativeCall;
  if (!call?.sessionId || !call.toolUseId || call.answered !== true || call.failed !== false ||
      call.questions.length !== 1 || !Array.isArray(call.unansweredQuestionIndices) ||
      call.unansweredQuestionIndices.length || !Number.isFinite(Date.parse(call.answeredAt ?? '')) ||
      fp.signature !== `${call.sessionId}:${call.toolUseId}`) return false;
  const q = call.questions[0]!;
  if (q.multiSelect || q.options.length !== 2 || Object.keys(call.answers ?? {}).length !== 1 ||
      q.options.some(o => typeof o.description !== 'string' || ('preview' in o && Boolean(o.preview))) ||
      fp.options.length !== q.options.length || fp.options.some((o, i) => o.index !== i + 1 || o.label !== q.options[i]!.label)) return false;
  const clean = (text: string) => text.trim().replace(/\s+/g, ' ');
  const label = (text: string) => clean(text).replace(/^[AB]\) /, '').replace(/ \(Recommended\)$/, '');
  const positive = q.options.find(o => call.answers?.[q.question] === o.label);
  if (!positive) return false;
  const other = q.options.find(o => o !== positive)!;
  const question = clean(q.question);
  const description = clean(positive.description!);
  const alternative = clean(other.description!);
  // Consume every sentence. A heading or "no new decisions" claim alone
  // cannot conceal an added requirement, omitted state, or actual design choice.
  if (/^D\d+ StateTable$/.test(q.header) &&
      /^D\d+ — Add a state coverage table to the plan body for implementer reference\? <gstack-qid:plan-design-review-states-\d+>$/.test(question)) {
    return label(positive.label) === 'Add state table' && label(other.label) === 'Leave states in prose only' &&
      /^Insert a feature × state table \(Form load \/ Save \/ Export \/ Dirty state × Loading \/ Empty \/ Error \/ Success \/ Pending\)\. No new design decisions — all cells derive from existing specs\. Completeness: \d+\/10 — implementers can verify each state against a single reference\.$/.test(description) &&
      /^Keep the existing prose descriptions without a structured table\. Completeness: \d+\/10 — specs are all there but scattered across paragraphs; edge cases like Export error during dirty-edit are harder to spot\.$/.test(alternative);
  }
  if (/^D\d+ Storyboard$/.test(q.header) &&
      /^D\d+ — Add a user journey storyboard to the plan\? <gstack-qid:plan-design-review-journey-\d+>$/.test(question)) {
    return label(positive.label) === 'Add storyboard' && label(other.label) === 'Keep one-sentence journey description' &&
      /^Render the accepted journey as a step\/user-does\/user-feels\/plan-specifies table \(\d+ rows covering happy path, save failure, cancel with dirty state, first-time new account\)\. No new design decisions — pure rendering of existing specs\. Completeness: \d+\/10 — implementers understand the emotional arc and can verify the spec covers each moment\.$/.test(description) &&
      /^Leave the current one-sentence happy-path description\. Completeness: \d+\/10 — the journey exists but reads like a state machine; error recovery arcs and first-time experience aren't visible without cross-referencing multiple paragraphs\.$/.test(alternative);
  }
  return false;
}
