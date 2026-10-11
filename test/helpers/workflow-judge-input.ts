/** Preserve source-file boundaries when a workflow judge reads carved skills. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { markerIndex } from './workflow-excerpt';

export interface WorkflowJudgeFile {
  path: string;
  kind: 'entrypoint' | 'section' | 'reference';
  content: string;
  startLine: number;
  endLine: number;
}

export interface WorkflowJudgeInput {
  files: WorkflowJudgeFile[];
  text: string;
}

export const QA_DISCOVERY_REFERENCES = [
  'qa/sections/scope.md',
  'qa/sections/exploratory.md',
  'qa/sections/system-functional.md',
  'qa/sections/browser-setup.md',
  'qa/sections/qa-patterns.md',
  'qa/templates/functional-report-template.md',
];

export const WORKFLOW_JUDGE_REASONING_WORD_LIMIT = 150;
/** The instructed length sits below the enforced limit: judges asked for <150 landed at 130-156 words. */
export const WORKFLOW_JUDGE_REASONING_WORD_TARGET = 120;

export const WORKFLOW_JUDGE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    clarity: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    completeness: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    actionability: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    reasoning: { type: 'string',
      description: `Under ${WORKFLOW_JUDGE_REASONING_WORD_TARGET} words with at most two decisive examples, evaluating the complete supplied workflow.` },
  },
  required: ['clarity', 'completeness', 'actionability', 'reasoning'],
  additionalProperties: false,
};

export function buildWorkflowJudgePrompt(opts: {
  judgeContext: string;
  judgeGoal: string;
  agentCapability?: 'frontier';
}, input: WorkflowJudgeInput): string {
  return `You are evaluating the quality of ${opts.judgeContext} for an AI coding agent.

The agent reads these source files to learn ${opts.judgeGoal}. Shared preamble definitions and
external tools/files are documented separately; do not penalize their absence from this bundle.
On-demand sections retain their original file boundaries and Read instructions; the section
index refers to those files, not duplicate work. The bundle order is not execution order.
Judge the actual instructions, including contradictory ordering or missing decisions.${opts.agentCapability === 'frontier' ? `

Target reader: a frontier coding agent with GPT-5.6 Sol-level capability or stronger.
Assume it can follow explicit cross-references, track saved state and a bounded work list,
and distinguish conditional branches. Length, technical vocabulary and multiple explicit recovery paths alone are not clarity defects.
Do not invent missing policies, permissions or evidence to make a workflow executable.

Clarity 4 means the target agent can determine the next permitted action on each applicable path;
5 additionally means those paths are easy to locate and understand.
Score clarity 3 or lower when execution still requires guessing because of
conflicting order, undefined decisions, unclear authority or missing input/output handling.
Evaluate the whole workflow, but keep the JSON reasoning under ${WORKFLOW_JUDGE_REASONING_WORD_TARGET} words with at most two decisive examples.
For a clarity defect, cite the specific file/step and explain the competing actions or missing decision.
Keep completeness and actionability independent: reader capability does not supply missing requirements.` : ''}

Rate on three dimensions (1-5 scale):
- **clarity** (1-5): Can an agent follow the instructions without ambiguity?
- **completeness** (1-5): Are all steps, decision points, and outputs well-defined?
- **actionability** (1-5): Can an agent execute this workflow and produce the expected deliverables?

Respond with ONLY valid JSON:
{"clarity": N, "completeness": N, "actionability": N, "reasoning": "brief explanation"}

Here is the source-file bundle to evaluate:

${input.text}`;
}

export function readWorkflowJudgeInput(opts: {
  root: string;
  skillPath: string;
  startMarker: string;
  endMarker: string | RegExp | null;
  references?: readonly string[];
}): WorkflowJudgeInput {
  const sources = [{
    path: opts.skillPath,
    kind: 'entrypoint' as const,
    content: fs.readFileSync(path.join(opts.root, opts.skillPath), 'utf8'),
  }];
  const sectionDir = path.join(path.dirname(opts.skillPath), 'sections');
  const sectionRoot = path.join(opts.root, sectionDir);
  // Runner-profile sections (manifest `runner_only`, plan B4) are read by
  // bin/gstack-autoplan alone; the judge evaluates the interactive workflow.
  const manifestPath = path.join(sectionRoot, 'manifest.json');
  const manifestSections: Array<{ file: string; runner_only?: boolean }> = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).sections ?? [] : [];
  const runnerOnly = new Set(manifestSections.filter(section => section.runner_only).map(section => section.file));
  const sections = fs.existsSync(sectionRoot)
    ? fs.readdirSync(sectionRoot).sort().filter(name => name.endsWith('.md') && !runnerOnly.has(name))
      .map(name => ({
        path: path.join(sectionDir, name),
        kind: 'section' as const,
        content: fs.readFileSync(path.join(sectionRoot, name), 'utf8'),
      }))
    : [];
  const references = [...new Set(opts.references ?? [])].map(file => {
    const resolved = path.resolve(opts.root, file);
    if (!resolved.startsWith(path.resolve(opts.root) + path.sep)) throw new Error(`Reference outside root: ${file}`);
    return { path: file, kind: 'reference' as const, content: fs.readFileSync(resolved, 'utf8') };
  }).filter(file => ![...sources, ...sections].some(source => source.path === file.path));
  const allSources = [...sources, ...sections, ...references];

  // Preserve the existing marker window, including markers that moved into
  // section files. Offsets identify the source of each slice; prose prefixes
  // cannot reliably identify a file after its generated header was sliced off.
  const union = allSources.map(file => file.content).join('\n');
  const start = union.indexOf(opts.startMarker);
  if (start < 0) throw new Error(`Start marker not found in ${opts.skillPath}: "${opts.startMarker}"`);
  const end = opts.endMarker === null ? union.length : markerIndex(union, opts.endMarker, start);
  if (end < 0) throw new Error(`End marker not found in ${opts.skillPath}: "${opts.endMarker}"`);

  const files: WorkflowJudgeFile[] = [];
  let offset = 0;
  for (const file of allSources) {
    // Every section was already supplied in full by the old judge input. Keep
    // that coverage, but include each file once even when the marker window
    // also covers part of it. Only the entrypoint retains the requested slice.
    const from = file.kind !== 'entrypoint' ? 0 : Math.max(0, start - offset);
    const to = file.kind !== 'entrypoint' ? file.content.length : Math.min(file.content.length, end - offset);
    if (from < to) {
      files.push({
        ...file,
        path: file.path.split(path.sep).join('/'),
        content: file.content.slice(from, to),
        startLine: file.content.slice(0, from).split('\n').length,
        endLine: file.content.slice(0, to - 1).split('\n').length,
      });
    }
    offset += file.content.length + 1;
  }

  const context = [
    'The material below is a bundle of source-file excerpts, with each original file and line range labeled.',
    'SKILL.md is the entry point; the labeled ranges identify which excerpts are supplied.',
    ...(sections.length + references.length > 0 ? [
      'The section files remain separate on disk and are read at the points and conditions specified by the skill\'s Read directives.',
      'They are supplied here as on-demand references; their order in this bundle is not execution order.',
    ] : []),
  ].join('\n');
  return {
    files,
    text: context + '\n\n' + files.map(file => [
      `--- BEGIN FILE ${JSON.stringify(file.path)} (lines ${file.startLine}-${file.endLine}; ${file.kind}) ---`,
      file.content,
      `--- END FILE ${JSON.stringify(file.path)} ---`,
    ].join('\n')).join('\n\n'),
  };
}
