/**
 * Evidence for the /autoplan --ceo-only paid case (test/skill-e2e-autoplan-ceo-only.test.ts):
 * the run asked nothing, reviewed the plan through the CEO phase, skipped every
 * later phase, wrote ceo-review.md, ended status=reviewed, and wrote nothing in
 * HOME outside its declared roots. Pure over the transcript and files the test
 * collects, so test/autoplan-ceo-only.test.ts proves each check fails on a
 * synthetic negative control before any paid run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CEO_REVIEW_HEADINGS = [
  '## User challenges (direction kept)', '## Scope added', '## Conservative choices', '## Findings', '## Decision Audit Trail',
] as const;

const QUESTION_TOOL = /(^|__)(AskUserQuestion|ExitPlanMode)$/;
const PROSE_QUESTION = /\b(would you like|do you want|should i\b|want me to|shall i\b|which (?:option|mode|one) (?:do|would|should) you|reply with|let me know (?:if|which|whether))/i;
const LATER_PHASE = /autoplan\/sections\/(?:design-phase|dx-phase|eng-phase|tasks-aggregator)\.md$/;
const DISPATCH_TOOL = /^(Agent|Task)$/;

export interface CeoOnlyEvidenceInput {
  transcript: any[];
  /** The session's final result text. */
  output: string;
  /** New files under HOME outside the declared roots (the test's before/after diff). */
  strayWrites: string[];
  /** Patterns the reviewed plan or ceo-review.md must contain for the seeded flaw. */
  mustMention: RegExp[];
}
export interface CeoOnlyEvidence { passed: boolean; reasons: string[]; runDir?: string; questions: string[] }

function blocks(transcript: any[]): Array<{ role: string; block: any }> {
  return transcript.flatMap(event => {
    const role = event?.type === 'assistant' ? 'assistant' : event?.type === 'user' ? 'user' : '';
    const content = event?.message?.content;
    return role && Array.isArray(content) ? content.map((block: any) => ({ role, block })) : [];
  });
}

export function ceoOnlyEvidence(input: CeoOnlyEvidenceInput): CeoOnlyEvidence {
  const reasons: string[] = [];
  const all = blocks(input.transcript);
  const uses = all.filter(b => b.role === 'assistant' && b.block?.type === 'tool_use').map(b => b.block);
  const texts = all.filter(b => b.role === 'assistant' && b.block?.type === 'text').map(b => String(b.block.text ?? ''));
  const results = all.filter(b => b.role === 'user' && b.block?.type === 'tool_result')
    .map(b => (typeof b.block.content === 'string' ? b.block.content : JSON.stringify(b.block.content ?? '')));

  const questions = [
    ...uses.filter(u => QUESTION_TOOL.test(String(u.name))).map(u => `tool ${u.name}`),
    ...[...texts, input.output].flatMap(t => t.split('\n').filter(line => line.trim().endsWith('?') && PROSE_QUESTION.test(line)).map(line => `prose: ${line.trim().slice(0, 160)}`)),
  ];
  if (questions.length) reasons.push(`asked ${questions.length} question(s): ${questions.join(' | ')}`);

  const handoff = uses.some(u => u.name === 'Bash' && /gstack-ceo-mode-handoff\b/.test(String(u.input?.command)) && /--ceo-only\b/.test(String(u.input?.command)))
    && results.some(r => r.includes('(CEO-only run: Step 0E'));
  if (!handoff) reasons.push('no gstack-ceo-mode-handoff --ceo-only call with its CEO-only line');
  if (!uses.some(u => DISPATCH_TOOL.test(String(u.name)))) reasons.push('no CEO reviewer subagent was dispatched');
  const later = uses.filter(u => u.name === 'Read' && LATER_PHASE.test(String(u.input?.file_path ?? '')));
  if (later.length) reasons.push(`loaded a skipped phase: ${later.map(u => u.input.file_path).join(', ')}`);

  const result = /^GSTACK_RESULT: skill=autoplan status=(\S+) run=(.+)$/m.exec(input.output.split('\n').filter(l => l.startsWith('GSTACK_RESULT: ')).pop() ?? '');
  if (!result) reasons.push('no GSTACK_RESULT line for autoplan in the final output');
  else if (result[1] !== 'reviewed') reasons.push(`GSTACK_RESULT status=${result[1]}, expected reviewed`);
  const runDir = result?.[2]?.trim();
  const reviewFile = runDir ? path.join(runDir, 'ceo-review.md') : '';
  const review = reviewFile && fs.existsSync(reviewFile) ? fs.readFileSync(reviewFile, 'utf8') : undefined;
  if (runDir && review === undefined) reasons.push(`${reviewFile} is missing`);
  if (review !== undefined) {
    const missing = CEO_REVIEW_HEADINGS.filter(h => !review.includes(h));
    if (missing.length) reasons.push(`ceo-review.md lacks ${missing.join(', ')}`);
    if (!/\|\s*\d+\s*\|/.test(review.slice(review.indexOf('## Decision Audit Trail')))) reasons.push('ceo-review.md has no Decision Audit Trail rows');
    const unmet = input.mustMention.filter(re => !re.test(review));
    if (unmet.length) reasons.push(`ceo-review.md never names the seeded flaw (${unmet.map(String).join(', ')})`);
  }
  if (input.strayWrites.length) {
    const dirs = [...new Set(input.strayWrites.map(f => f.split('/').slice(0, 2).join('/')))];
    reasons.push(`wrote ${input.strayWrites.length} file(s) outside its roots, under ${dirs.join(', ')}: ${input.strayWrites.slice(0, 5).join(', ')}`);
  }
  return { passed: reasons.length === 0, reasons, runDir, questions };
}

/** Every file under root, relative, skipping the given relative prefixes. */
export function listFiles(root: string, skip: string[] = []): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (skip.some(s => rel === s || rel.startsWith(s + path.sep))) continue;
      if (entry.isDirectory()) walk(abs); else out.push(rel);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}
