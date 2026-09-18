import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NativeQuestion } from './plan-skill-questions';
import { pickPlanReviewQuestion } from './plan-review-cases';

// A declared fixture-actor interface, not a parser for arbitrary user prose.
// The same records are seeded before the first model turn and checked below.
export const DESIGN_BOARD_WAIT_OPTIONS = [
  { label: 'Submitted', description: 'I submitted feedback on the comparison board. Read its final feedback and continue.' },
  { label: 'Regenerate / Remix', description: 'I requested another round on the comparison board. Read that request and regenerate.' },
  { label: 'Type preferences', description: 'I will provide my preferences in chat instead of using the comparison board.' },
] as const;

// Optional outside review is separate from the native finding this fixture
// measures. Preserve the complete supported menu, not just its No label.
const DESIGN_OUTSIDE_VOICE_OPTIONS = [
  {
    "label": "Yes, run outside design voices",
    "description": "✅ Codex hard-rule + litmus scorecard plus an independent Claude completeness read. ✅ Disagreements surface with both perspectives in the relevant pass. ❌ Adds a few minutes; Codex may be missing here, in which case only the Claude voice runs and it's tagged single-model."
  },
  {
    "label": "No, proceed without",
    "description": "✅ Straight into the 7 passes with the approved mockup as anchor. ✅ Fewest steps to a fixed plan. ❌ Findings rest on one reviewer; no cross-model check on slop risk or hierarchy."
  }
] as const;

export const DESIGN_BOARD_ACTOR_PROTOCOL = [
  '## Fixture user: native Design review',
  '',
  'This fixture reviews the supplied UI through a native Design finding.',
  'Decline the optional Design Outside Voices step; do not dispatch either',
  'outside reviewer. Mockups, board feedback/confirmation, visual verification',
  'and all ordinary Design review decisions still apply.',
  'If offering that optional step, ask one single-select question with header "Voices",',
  'beginning "Want outside design voices before the detailed review?" and exactly:',
  ...DESIGN_OUTSIDE_VOICE_OPTIONS.map(option => `- ${option.label}: ${option.description}`),
  'Option order, a letter prefix, and a trailing (recommended) marker may vary.',
  'Keep this choice separate from other approvals; no previews or extra actions.',
  'The fixture user chooses No, proceed without. Observe the actual native',
  'answer before continuing when this question is offered.',
  '',
  '## Fixture user: comparison-board acknowledgment',
  '',
  'For the comparison-board wait only, ask one single-select question containing',
  'the current board URL and exactly these options, with these labels and descriptions:',
  ...DESIGN_BOARD_WAIT_OPTIONS.map(option => `- ${option.label}: ${option.description}`),
  'Option order, a letter prefix, and a trailing (recommended) marker may vary.',
  'Do not paraphrase these options or attach other approvals, choices, or previews.',
  'A question containing a board URL uses this interface. Keep other review',
  'decisions in separate questions without that URL.',
  'This interface does not mean feedback has already been submitted. Wait for the',
  'actual answer and read the board feedback as the skill requires. All design',
  'decisions, visual verification, and the remaining review still apply.',
  '',
].join('\n');

/** Declare the fixture user's interface before launch, without changing its plan. */
export function seedDesignBoardActorProtocol(cwd: string): void {
  fs.appendFileSync(path.join(cwd, 'CLAUDE.md'), `\n${DESIGN_BOARD_ACTOR_PROTOCOL}`);
  const git = (args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 10_000 });
  git(['add', 'CLAUDE.md']);
  git(['-c', 'user.name=Finding fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-m', 'Declare Design board fixture actor interface']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
}

// The native picker is synchronous. Keep identity checks and the real board
// submission together in a bounded child; the counting driver still owns the
// subsequent terminal input and requires its native acknowledgment.
const SUBMIT = `
import { readStateFile, verifyIdentity, CMDLINE_MARKER } from ${JSON.stringify(path.resolve(import.meta.dir, '../../design/src/daemon-state.ts'))};
import fs from 'node:fs';
const input = JSON.parse(await Bun.stdin.text());
const state = readStateFile(input.stateFile);
if (!fs.lstatSync(input.stateFile).isFile() || !state
  || !Number.isSafeInteger(state.pid) || state.pid <= 0
  || !Number.isSafeInteger(state.port) || state.port <= 0 || state.port > 65535
  || new URL(input.url).port !== String(state.port)
  || !verifyIdentity(state.pid, CMDLINE_MARKER)) throw new Error('No matching owned design daemon');
const remaining = input.deadlineAt - Date.now();
if (remaining <= 0) throw new Error('Design feedback deadline exhausted');
if (input.alreadySubmitted) {
  const progress = await fetch(input.url + 'api/progress', { redirect: 'error', signal: AbortSignal.timeout(remaining) });
  if (!progress.ok) throw new Error('Design feedback progress HTTP ' + progress.status);
  const state = await progress.json();
  if (state.status === 'done') {
    console.log(JSON.stringify({ received: true, action: 'submitted' }));
    process.exit(0);
  }
  if (state.status !== 'serving') throw new Error('Design board is not ready for feedback');
}
const requestBudget = input.deadlineAt - Date.now();
if (requestBudget <= 0) throw new Error('Design feedback deadline exhausted');
const response = await fetch(input.url + 'api/feedback', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(requestBudget),
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ preferred: 'A', ratings: {}, comments: {},
    overall: 'Automated review fixture preference: variant A.', regenerated: false }),
});
if (!response.ok) throw new Error('Design feedback HTTP ' + response.status);
const ack = await response.json();
if (ack?.received !== true || ack?.action !== 'submitted') throw new Error('Design feedback submission was not acknowledged');
console.log(JSON.stringify({ received: true, action: 'submitted' }));
`;

/** Decline the declared optional outside review; acknowledge board submission
 * only after it happens. Other decisions retain the recommended/manual policy. */
export function createDesignReviewPicker({ cwd, deadlineAt }: { cwd: string; deadlineAt: number }): (question: NativeQuestion) => number {
  const submitted = new Set<string>();
  const stateFile = path.resolve(cwd, '.gstack/design.json');
  return question => {
    const labels = question.options.map(option => option.label.trim()
      .replace(/^(?:[A-E][).:]?|\([A-E]\)|\[[A-E]\])\s+/i, '')
      .replace(/\s*\(recommended\)\s*$/i, '').trim());
    const lead = question.question.split(/\r?\n/, 1)[0]!.trim()
      .replace(/^D\d+(?:\.\d+)?\s*[—–:-]\s*/i, '');
    const claimsVoices = /^(?:Want|Run) outside (?:design )?voices\b/i.test(lead)
      || labels.includes(DESIGN_OUTSIDE_VOICE_OPTIONS[0].label);
    if (claimsVoices) {
      const voiceActions = question.options.map((option, index) => DESIGN_OUTSIDE_VOICE_OPTIONS.findIndex(expected =>
        labels[index] === expected.label && option.description === expected.description && option.preview === undefined));
      if (question.header.trim() !== 'Voices'
        || !/^(?:Want outside design voices before the detailed review|Run outside design voices before the 7 passes)\?(?:\s|$)/i.test(lead)
        || question.multiSelect || voiceActions.length !== 2 || voiceActions.includes(-1)
        || new Set(voiceActions).size !== 2 || /https?:\/\/[^\s<>\[\]()]*\/boards\//.test(question.question)) {
        throw new Error('Design outside-voices choice has no unambiguous declared native-only action');
      }
      return voiceActions.indexOf(1) + 1;
    }
    const actions = question.options.map((option, index) => DESIGN_BOARD_WAIT_OPTIONS.findIndex(expected =>
      labels[index] === expected.label && option.description === expected.description && option.preview === undefined));
    const submittedIndex = actions.indexOf(0);
    const boardUrl = /https?:\/\/[^\s<>\[\]()]*\/boards\//.test(question.question);
    const boardContext = /\bcomparison board\b/i.test(question.question);
    const claimsAction = boardUrl || labels.some(label => DESIGN_BOARD_WAIT_OPTIONS.some(option => label === option.label))
      || boardContext && labels.some(label => /\b(?:submit(?:ted|ting)?|clicked)\b/i.test(label));
    if (!claimsAction) return pickPlanReviewQuestion(question);
    if (question.multiSelect || actions.length !== 3
      || actions.includes(-1) || new Set(actions).size !== 3) {
      throw new Error('Design board submission has no unambiguous offered action');
    }
    const urls = [...new Set(question.question.match(/https?:\/\/[^\s<>\[\]()]+/g) ?? [])];
    if (urls.length !== 1 || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/boards\/[A-Za-z0-9_-]+\/$/.test(urls[0]!)) {
      throw new Error('Design board submission requires one exact owned board URL');
    }
    const url = urls[0]!;
    const childDeadline = Math.min(deadlineAt, Date.now() + 2_000);
    if (childDeadline <= Date.now()) throw new Error('Design feedback deadline exhausted');
    const child = spawnSync(process.execPath, ['-e', SUBMIT], {
      input: JSON.stringify({ stateFile, url, deadlineAt: childDeadline, alreadySubmitted: submitted.has(url) }),
      encoding: 'utf8', timeout: Math.max(1, childDeadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
      env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    if (child.error || child.signal || child.status !== 0) {
      throw new Error(`Design feedback failed: ${child.error?.message ?? child.signal ?? `exit ${child.status}`}\n${child.stderr?.slice(-2000) ?? ''}`,
        { cause: child.error });
    }
    const ack = JSON.parse(child.stdout);
    if (ack.received !== true || ack.action !== 'submitted') throw new Error('Design feedback acknowledgment was missing');
    submitted.add(url);
    return submittedIndex + 1;
  };
}
