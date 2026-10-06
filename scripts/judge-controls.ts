#!/usr/bin/env bun
/**
 * C1 workflow-judge control bundles (pre-registered in docs/evals/judge-controls-2026-10.md).
 *
 * For each judge that produced low samples, builds the production bundle with the
 * eval's own reader and prompt builder, derives a negative and a targeted-defect
 * bundle, and runs one 3-sample panel per bundle with the eval's request options.
 *
 * Usage:
 *   bun run scripts/judge-controls.ts --list     (builds every bundle, no API calls)
 *   bun run scripts/judge-controls.ts --run      (36 judge calls; writes docs/evals/judge-controls/results.json)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildQaWorkflowJudgePrompt, callJudge, judgePanelMean, judgePanelMedian, DEFAULT_JUDGE_MAX_TOKENS, JUDGE_SCORE_DIMENSIONS, type CallJudgeOptions } from '../test/helpers/llm-judge';
import { buildWorkflowJudgePrompt, readWorkflowJudgeInput, QA_DISCOVERY_REFERENCES, WORKFLOW_JUDGE_RESPONSE_SCHEMA } from '../test/helpers/workflow-judge-input';

const ROOT = path.resolve(import.meta.dir, '..');
const FLOORS = { clarity: 3, completeness: 3, actionability: 4 } as const;
const SAMPLES = 3;

type Judge = {
  name: string;
  read: () => string;
  prompt: (text: string) => string;
  options: CallJudgeOptions;
  defect: (text: string) => string;
};

function cut(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`defect anchor missing: ${start} … ${end}`);
  return text.slice(0, from) + text.slice(to);
}

function insertAfter(text: string, anchor: string, line: string): string {
  const at = text.indexOf(anchor);
  if (at < 0) throw new Error(`defect anchor missing: ${anchor}`);
  return text.slice(0, at + anchor.length) + '\n\n' + line + text.slice(at + anchor.length);
}

const workflow = (skillPath: string, startMarker: string, endMarker: string | null, references: readonly string[] | undefined) =>
  () => readWorkflowJudgeInput({ root: ROOT, skillPath, startMarker, endMarker, references }).text;

const JUDGES: Judge[] = [
  {
    name: 'qa/SKILL.md workflow',
    read: workflow('qa/SKILL.md', '# /qa: Test', null,
      ['qa/templates/functional-report-template.md', 'qa/templates/qa-report-template.md', 'qa/references/issue-taxonomy.md']),
    prompt: buildQaWorkflowJudgePrompt,
    options: {},
    defect: text => cut(text, '## Phase 10: Report', '## Phase 11:'),
  },
  {
    name: 'qa-only/SKILL.md workflow',
    read: workflow('qa-only/SKILL.md', '# /qa-only:', null, QA_DISCOVERY_REFERENCES.filter(file => file !== 'qa/sections/exploratory.md')),
    prompt: text => buildWorkflowJudgePrompt({ judgeContext: 'a report-only QA testing workflow',
      judgeGoal: 'how to select browser/native functional/mixed targets, explore safely with repository tools, report exact contract evidence and coverage limits, conditionally load browser/DX instructions and never mutate product/tests/Git through any tool' }, { files: [], text }),
    options: { max_tokens: DEFAULT_JUDGE_MAX_TOKENS, jsonSchema: WORKFLOW_JUDGE_RESPONSE_SCHEMA },
    defect: text => insertAfter(text, '# /qa-only: Report-Only QA Testing', 'After reporting each bug, fix it in the source and commit the fix.'),
  },
  {
    name: 'review/SKILL.md workflow',
    read: workflow('review/SKILL.md', '## Step 0: Detect platform and base branch', null,
      [...QA_DISCOVERY_REFERENCES, 'review/checklist.md', 'review/specialists/testing.md']),
    prompt: text => buildWorkflowJudgePrompt({ judgeContext: 'a pre-landing review with bounded exploratory QA',
      judgeGoal: 'how to review and explore changed behavior even for small diffs without a plan or server, preserve report-only discovery and the test_stub ASK gate, handle incomplete probes honestly, and rerun affected evidence after approved repairs',
      agentCapability: 'frontier' }, { files: [], text }),
    options: { max_tokens: DEFAULT_JUDGE_MAX_TOKENS },
    defect: text => cut(text, '## Step 3: Get the diff', '## Step 3.4'),
  },
  {
    name: 'setup-deploy/SKILL.md platform setup',
    read: workflow('setup-deploy/SKILL.md', '### Step 2: Detect platform', '## Important Rules', undefined),
    prompt: text => buildWorkflowJudgePrompt({ judgeContext: 'a deployment configuration setup workflow that detects deploy platforms and writes config to CLAUDE.md',
      judgeGoal: 'how to detect deploy platforms (Fly.io, Render, Vercel, Netlify, Heroku, GitHub Actions, custom), gather platform-specific configuration (URLs, status commands, health checks, custom hooks), and persist everything to CLAUDE.md for future automated use' }, { files: [], text }),
    options: { max_tokens: DEFAULT_JUDGE_MAX_TOKENS, jsonSchema: WORKFLOW_JUDGE_RESPONSE_SCHEMA },
    defect: text => {
      const step = text.indexOf('### Step 2: Detect platform');
      const open = text.indexOf('```bash', step);
      const close = text.indexOf('```', open + 7);
      if (step < 0 || open < 0 || close < 0) throw new Error('defect anchor missing: Step 2 bash block');
      return text.slice(0, open) + text.slice(close + 3);
    },
  },
];

/** Keep only file boundaries and headings. */
const negative = (text: string) => text.split('\n')
  .filter(line => /^--- (BEGIN|END) FILE /.test(line) || /^#{1,6} /.test(line)).join('\n');

function bundles(judge: Judge): Record<'positive' | 'negative' | 'defect', string> {
  const positive = judge.read();
  return { positive, negative: negative(positive), defect: judge.defect(positive) };
}

const mode = process.argv[2];
if (mode !== '--list' && mode !== '--run') {
  console.error('usage: bun run scripts/judge-controls.ts --list | --run');
  process.exit(2);
}
if (mode === '--list') {
  for (const judge of JUDGES) {
    const built = bundles(judge);
    console.log(judge.name, Object.fromEntries(Object.entries(built).map(([k, v]) => [k, v.length])));
  }
  process.exit(0);
}

type Sample = { clarity: number; completeness: number; actionability: number; reasoning: string };
const results = await Promise.all(JUDGES.flatMap(judge => Object.entries(bundles(judge)).map(async ([bundle, text]) => {
  const prompt = judge.prompt(text);
  const samples = await Promise.all(Array.from({ length: SAMPLES }, () => callJudge<Sample>(prompt, undefined, judge.options)));
  const mean = judgePanelMean(samples, JUDGE_SCORE_DIMENSIONS);
  const median = judgePanelMedian(samples, JUDGE_SCORE_DIMENSIONS);
  const verdict = Object.entries(FLOORS).every(([key, floor]) => median[key as keyof typeof FLOORS] >= floor) ? 'pass' : 'fail';
  return { judge: judge.name, bundle, verdict, median, mean, samples };
})));
const out = path.join(ROOT, 'docs/evals/judge-controls/results.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ recorded_at: new Date().toISOString(), results }, null, 2) + '\n');
for (const r of results) console.log(`${r.judge} | ${r.bundle} | ${r.verdict} | median ${JSON.stringify(r.median)} mean ${JSON.stringify(r.mean)}`);
