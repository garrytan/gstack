import type { AskUserQuestionFingerprint } from './claude-pty-runner';

/** Recording or skipping an explicitly deferred typography TODO preserves the
 * current design. Selecting its build-now alternative remains a review choice.
 */
function deferredTypographyTodo(q: NonNullable<AskUserQuestionFingerprint['nativeCall']>['questions'][number], selected: string): boolean {
  const clean = (text: string) => text.trim().replace(/\s+/g, ' ');
  const lines = q.question.trim().split('\n').map(clean);
  const title = /^D[1-9]\d* [—–-] TODO proposal: (?:record|add) a deferred TODOS\.md (?:item|note) to (?:evaluate|explore|consider) [^?\n]+ \(replacing ([A-Za-z][A-Za-z0-9-]{0,39})\) (?:in a later|during a future) design pass\?$/.exec(lines[0] ?? '');
  if (!title || !/^TODO [1-9]\d*$/.test(q.header) || lines.length !== 7 ||
      !/^Project\/branch\/task: [A-Za-z0-9_./-]+, \/plan-design-review of PLAN\.md, post-pass TODOS\.md updates\.$/.test(lines[1]!)) return false;
  const font = title[1]!;
  const assessment = lines[2]!;
  // Bind the current scope before reading the optional explanation of future
  // value. Font examples, effort estimates and brand prose are not evidence.
  const scope = new RegExp(`^ELI10: DESIGN\\.md and (?:this|the current) plan (?:keep|retain|preserve) ${font} as the app font(?:, and you excluded visual exploration from this update|\\. Visual exploration (?:remains|is) out of scope for this update), so (?:nothing changes now|the current design remains unchanged)\\.`);
  const recordOnly = /\bThis question is only about whether to (?:write|record) [^.]+ in TODOS\.md [^.]*\bfuture \/design-consultation\b[^.]*, not about changing anything here\./.test(assessment)
    || /\bThis question only (?:records|skips) a deferred TODOS\.md (?:item|note) for a future \/design-consultation; it does not change the current design\./.test(assessment);
  if (!scope.test(assessment) || !recordOnly ||
      !/^Stakes if we pick wrong: .+\.$/.test(lines[3]!) ||
      !/^Recommendation: A\b/.test(lines[4]!) || !/\bout[- ]of[- ]scope\b/.test(lines[4]!) ||
      !/^Note: options differ in kind, not coverage\b/.test(lines[5]!) ||
      !/^Net: .+\.$/.test(lines[6]!)) return false;
  const choices = ['A Add to TODOS.md', 'B Skip, not valuable enough', 'C Build it now in this PR'];
  const labels = q.options.map(o => clean(o.label).replace(/ \(recommended\)$/i, ''));
  if (labels.length !== 3 || choices.some(label => labels.filter(l => l === label).length !== 1)) return false;
  const description = (label: string) => clean(q.options[labels.indexOf(label)]!.description!);
  const [add, skip, build] = choices.map(description) as [string, string, string];
  const selectedLabel = labels[q.options.findIndex(o => o.label === selected)];
  if (selectedLabel !== choices[0] && selectedLabel !== choices[1]) return false;
  // A and B are record/skip-only choices; C is explicitly an implementation
  // alternative. Additional present-work instructions invalidate the boundary.
  const all = [...lines, add, skip, build].join('\n');
  if (/\b(?:Correction|Hypothetical|Source only|Example only)\s*:|\b(?:this (?:scope|proposal|deferment)|the (?:scope|proposal|deferment)) (?:is|was) (?:withdrawn|cancelled|rejected)\b/i.test(all) ||
      /\b(?:Also|Additionally|Instead|Now|Then)\s+(?:we\s+)?(?:must\s+|will\s+)?(?:fix|replace|change|implement|build|add|load|remove)\b/i.test(all) ||
      /\b(?:font replacement|visual exploration|typography work)\s+(?:is|becomes|remains)\s+(?:now\s+)?in scope\b/i.test(all)) return false;
  const unquoted = (text: string) => text.replace(/"[^"\n]*"|“[^”\n]*”/g, '[quoted]');
  const retained = unquoted([...lines, add, skip].join('\n'));
  if (/\bVisual exploration (?:is|remains) (?:no longer|not) out of scope\b/i.test(retained) ||
      new RegExp(`\\b(?:This|The current) plan (?:no longer|does not) (?:keeps?|retains?|preserves?) ${font}\\b`, 'i').test(retained)) return false;
  const recording = unquoted(add + '\n' + skip).split(/[.!?]\s+|[✅❌]|\n/).map(clean);
  if (recording.some(sentence => /^(?:Add|Create|Fix|Replace|Change|Implement|Build|Load|Remove|Set|Make)\b/i.test(sentence) &&
      (!/^(?:Add|Create) (?:a |the |one )?TODOS\.md (?:file|item|note)(?: for (?:the )?(?:future|deferred|later) [A-Za-z0-9 /_-]+)?\.?$/i.test(sentence) || /\b(?:and|then|plus)\s+(?:add|create|fix|replace|change|implement|build|load|remove|set|make)\b/i.test(sentence)))) return false;
  if (/\b(?:it is false that|not true that|if approved|no longer preserves?)\b/i.test(retained) ||
      /\b(?:replace|change|implement|build|load|remove)\b[^.!?\n]*\b(?:now|in this PR|in this update)\b/i.test(retained.replace(/not about changing anything here\./g, '').replace(/do not add it now/g, 'deferred'))) return false;
  const preservesFont = new RegExp(`(?:Nothing changes|No design changes) in this update; DESIGN\\.md and ${font} (?:stay as approved|remain unchanged)\\.`);
  return /\b(?:next|future) \/design-consultation\b/.test(add) && preservesFont.test(add) &&
    /\b(?:Adds a TODOS\.md file|Records only a TODOS\.md note)\b/.test(add) &&
    /\b(?:No TODOS\.md noise|No TODO is recorded)\b/.test(skip) && /\b(?:Zero follow-up work|No follow-up work)\./.test(skip) &&
    /\b(?:immediately|now|this PR)\b/i.test(build) && /\b(?:Fonts? load|Replace the font|Change the font)\b/i.test(build);
}

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
  if (q.multiSelect || q.options.length < 2 || q.options.length > 3 || Object.keys(call.answers ?? {}).length !== 1 ||
      q.options.some(o => typeof o.description !== 'string' || ('preview' in o && Boolean(o.preview))) ||
      fp.options.length !== q.options.length || fp.options.some((o, i) => o.index !== i + 1 || o.label !== q.options[i]!.label)) return false;
  const clean = (text: string) => text.trim().replace(/\s+/g, ' ');
  const label = (text: string) => clean(text).replace(/^[AB]\) /, '').replace(/ \(Recommended\)$/, '');
  const positive = q.options.find(o => call.answers?.[q.question] === o.label);
  if (!positive) return false;
  if (q.options.length === 3) return (fp.nativeQuestionIndex === undefined || fp.nativeQuestionIndex === 0) &&
    deferredTypographyTodo(q, positive.label);
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
