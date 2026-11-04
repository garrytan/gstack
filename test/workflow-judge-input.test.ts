/** Free regression coverage for the skill file bundle readWorkflowJudgeInput builds. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readWorkflowJudgeInput } from './helpers/workflow-judge-input';
import { ASK_QUESTIONS_HEADING, ENG_REVIEW_EXCERPT } from './helpers/workflow-excerpt';
import { readSkillStartup, SHARED_PREAMBLE_FILE } from './helpers/skill-startup';

const ROOT = resolve(import.meta.dir, '..');
const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gstack-workflow-judge-'));
  scratchRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The bundle: every generated section except runner-only profiles (manifest `runner_only`, plan B4). */
function sectionPaths(skill: string): string[] {
  const runnerOnly = new Set((JSON.parse(readFileSync(join(ROOT, skill, 'sections', 'manifest.json'), 'utf8')).sections as Array<{ file: string; runner_only?: boolean }>)
    .filter(section => section.runner_only).map(section => section.file));
  return readdirSync(join(ROOT, skill, 'sections'))
    .filter(name => name.endsWith('.md') && !runnerOnly.has(name) && name !== SHARED_PREAMBLE_FILE)
    .sort()
    .map(name => `${skill}/sections/${name}`);
}

describe('skill file bundle', () => {
  test('the Eng bundle includes authorization and the referenced final gate', () => {
    const options = { skillPath: ENG_REVIEW_EXCERPT.skillPath, startMarker: '# Plan Review Mode', endMarker: null };
    const input = readWorkflowJudgeInput({ root: ROOT, ...options });
    const entry = input.files.find(file => file.kind === 'entrypoint')!;
    const complete = readSkillStartup(join(ROOT, options.skillPath));
    expect(entry.content).toBe(complete.slice(complete.indexOf('# Plan Review Mode')));
    expect(entry.content).toContain('Do not build features, acceptance suites or benchmarks unless explicitly authorized');
    expect(entry.content).toContain('## Scope gate');
    expect(entry.content).toContain('## Section self-check');
    expect(entry.content).toContain('## EXIT PLAN MODE GATE (BLOCKING)');
    expect(entry.content.trimEnd()).toMatch(/After success telemetry and cache dispatch, call ExitPlanMode[^\n]*\.$/);
  });

  test('preserves the exact entrypoint excerpt and each complete section in sorted named files', () => {
    const entrypoint = 'excluded preamble\n## Begin\nRead sections/z-last.md when directed.\n## End\nexcluded epilogue';
    const sections = {
      'example/sections/z-last.md': 'Z section prefix\nZ section suffix',
      'example/sections/a-first.md': 'A section prefix\nA section suffix',
    };
    const root = fixture({
      'example/SKILL.md': entrypoint,
      ...sections,
      'example/sections/ignored.md.tmpl': 'DO NOT EVALUATE TEMPLATE',
      'example/sections/manifest.json': '{"ignored": true}',
    });
    const input = readWorkflowJudgeInput({ root, skillPath: 'example/SKILL.md', startMarker: '## Begin', endMarker: '## End' });

    expect(input.files).toEqual([
      { path: 'example/SKILL.md', kind: 'entrypoint', content: '## Begin\nRead sections/z-last.md when directed.\n', startLine: 2, endLine: 3 },
      { path: 'example/sections/a-first.md', kind: 'section', content: sections['example/sections/a-first.md'], startLine: 1, endLine: 2 },
      { path: 'example/sections/z-last.md', kind: 'section', content: sections['example/sections/z-last.md'], startLine: 1, endLine: 2 },
    ]);
    expect(input.text).not.toContain('excluded preamble');
    expect(input.text).not.toContain('excluded epilogue');
    expect(input.text).not.toContain('DO NOT EVALUATE TEMPLATE');
    expect(input.text).not.toContain('manifest.json');
    for (const file of input.files) {
      expect(occurrences(input.text, file.content)).toBe(1);
      const begin = input.text.split('\n').filter(line => line.includes('BEGIN FILE') && line.includes(file.path));
      const end = input.text.split('\n').filter(line => line.includes('END FILE') && line.includes(file.path));
      expect(begin).toHaveLength(1);
      expect(end).toHaveLength(1);
      expect(begin[0]).toContain(`${file.startLine}-${file.endLine}`);
    }
  });

  test('describes lazy file loading without presenting bundle order as execution order', () => {
    const root = fixture({
      'example/SKILL.md': '## Begin\nSTOP and read sections/step.md.\n## End',
      'example/sections/step.md': 'Run the separately loaded step.',
    });
    const { text } = readWorkflowJudgeInput({ root, skillPath: 'example/SKILL.md', startMarker: '## Begin', endMarker: '## End' });
    const header = text.slice(0, text.indexOf('BEGIN FILE'));
    expect(header).toMatch(/bundle/i);
    expect(header).toMatch(/file/i);
    expect(header).toMatch(/separate|separately/i);
    expect(header).toMatch(/lazy|on-demand/i);
    expect(header).toMatch(/directives|instructions/i);
    expect(header).toMatch(/(?:not|isn't|does not)[^.\n]*execution order/i);
    expect(text).toContain('STOP and read sections/step.md.');
  });

  test('cross-skill references retain complete bytes once and fail on missing assets', () => {
    const root = fixture({
      'example/SKILL.md': '## Begin\nRead the shared resource.\n## End',
      'example/sections/local.md': 'Complete local section.',
      'shared/sections/method.md': 'Shared prefix\n## End\nShared suffix',
    });
    const options = { root, skillPath: 'example/SKILL.md', startMarker: '## Begin', endMarker: '## End',
      references: ['example/sections/local.md', 'shared/sections/method.md', 'shared/sections/method.md'] };
    const input = readWorkflowJudgeInput(options);
    expect(input.files.filter(file => file.kind === 'reference')).toEqual([
      { path: 'shared/sections/method.md', kind: 'reference', content: 'Shared prefix\n## End\nShared suffix', startLine: 1, endLine: 3 },
    ]);
    expect(input.files.filter(file => file.path === 'example/sections/local.md')).toHaveLength(1);
    expect(occurrences(input.text, 'Shared prefix')).toBe(1);
    expect(() => readWorkflowJudgeInput({ ...options, references: ['shared/missing.md'] })).toThrow();
    expect(() => readWorkflowJudgeInput({ ...options, references: ['../outside.md'] })).toThrow('Reference outside root');
  });

  test('retains section prelude and suffix exactly once when both markers are inside a section', () => {
    // Generated comments made the old 120-character prefix heuristic append
    // this whole file after its partial slice, duplicating every review pass.
    const section = [
      '<!-- AUTO-GENERATED from review-sections.md.tmpl — do not edit directly -->',
      '<!-- Regenerate: bun run gen:skill-docs -->',
      'section context before the selected marker',
      '## Review Sections',
      '### Pass 1: Information Architecture',
      'Evaluate the first pass.',
      '## CRITICAL RULE',
      'section context after the selected marker',
    ].join('\n');
    const root = fixture({
      'example/SKILL.md': 'Entrypoint preamble.\nSTOP and read sections/review-sections.md.',
      'example/sections/review-sections.md': section,
    });
    const input = readWorkflowJudgeInput({ root, skillPath: 'example/SKILL.md', startMarker: '## Review Sections', endMarker: '## CRITICAL RULE' });

    expect(input.files).toEqual([
      { path: 'example/sections/review-sections.md', kind: 'section', content: section, startLine: 1, endLine: 8 },
    ]);
    expect(occurrences(input.text, '### Pass 1: Information Architecture')).toBe(1);
    expect(occurrences(input.text, 'section context before the selected marker')).toBe(1);
    expect(occurrences(input.text, 'section context after the selected marker')).toBe(1);
    expect(occurrences(input.text, section)).toBe(1);
    expect(input.text).not.toContain('Entrypoint preamble.');
  });

  test('handles marker windows spanning files without losing section prefixes or suffixes', () => {
    const root = fixture({
      'example/SKILL.md': 'omitted\n## Begin\nEntrypoint tail',
      'example/sections/a.md': 'First section prefix\nFirst section body\nFirst section suffix',
      'example/sections/b.md': 'Second section prefix\n## End\nSecond section suffix',
    });
    const input = readWorkflowJudgeInput({ root, skillPath: 'example/SKILL.md', startMarker: '## Begin', endMarker: '## End' });

    expect(input.files[0]).toEqual({
      path: 'example/SKILL.md', kind: 'entrypoint', content: '## Begin\nEntrypoint tail', startLine: 2, endLine: 3,
    });
    expect(input.files.slice(1).map(file => file.content)).toEqual([
      'First section prefix\nFirst section body\nFirst section suffix',
      'Second section prefix\n## End\nSecond section suffix',
    ]);
    expect(occurrences(input.text, 'Second section prefix')).toBe(1);
    expect(occurrences(input.text, 'Second section suffix')).toBe(1);
  });

  test('keeps separate files even when their generated preludes and contents match', () => {
    const body = '<!-- AUTO-GENERATED -->\nShared instruction';
    const root = fixture({
      'example/SKILL.md': '## Begin\nRead both sections.\n## End',
      'example/sections/a.md': body,
      'example/sections/b.md': body,
    });
    const input = readWorkflowJudgeInput({ root, skillPath: 'example/SKILL.md', startMarker: '## Begin', endMarker: '## End' });
    expect(input.files.filter(file => file.kind === 'section').map(file => file.path)).toEqual([
      'example/sections/a.md', 'example/sections/b.md',
    ]);
    expect(occurrences(input.text, body)).toBe(2);
  });

  test('supports an uncarved workflow and an open-ended slice', () => {
    const root = fixture({ 'example/SKILL.md': 'omitted\n## Begin\nRetain this final line' });
    const input = readWorkflowJudgeInput({ root, skillPath: 'example/SKILL.md', startMarker: '## Begin', endMarker: null });
    expect(input.files).toEqual([
      { path: 'example/SKILL.md', kind: 'entrypoint', content: '## Begin\nRetain this final line', startLine: 2, endLine: 3 },
    ]);
  });

  test('rejects missing start markers, missing end markers, and end markers preceding the start', () => {
    const root = fixture({ 'example/SKILL.md': '## Earlier\n## Begin\nBody' });
    expect(() => readWorkflowJudgeInput({ root, skillPath: 'example/SKILL.md', startMarker: '## Missing', endMarker: null })).toThrow(/Start marker not found/);
    expect(() => readWorkflowJudgeInput({ root, skillPath: 'example/SKILL.md', startMarker: '## Begin', endMarker: '## Missing' })).toThrow(/End marker not found/);
    expect(() => readWorkflowJudgeInput({ root, skillPath: 'example/SKILL.md', startMarker: '## Begin', endMarker: '## Earlier' })).toThrow(/End marker not found/);
  });

  test('generated ship includes base-branch initialization and every lazy section once', () => {
    const skillPath = 'ship/SKILL.md';
    const source = readFileSync(join(ROOT, skillPath), 'utf8');
    // Retain both the opening contract and initialization, regardless of their
    // ordering in the authored workflow.
    const startMarker = '# Ship:';
    const endMarker = '## Important Rules';
    const input = readWorkflowJudgeInput({ root: ROOT, skillPath, startMarker, endMarker });
    const entrypoint = input.files.find(file => file.kind === 'entrypoint');
    expect(entrypoint?.content).toBe(source.slice(source.indexOf(startMarker), source.indexOf(endMarker, source.indexOf(startMarker))));
    expect(entrypoint?.content).toContain('git remote get-url origin');
    expect(entrypoint?.content).toContain('STOP blocks advancement until the stated repair/resume route clears; without one, end this attempt');
    const flow = entrypoint!.content.replace(/\s+/g, ' ');
    expect(flow).toContain('Every new invocation repeats Steps 1–16, including both reviews and the docs audit');
    expect(flow).toContain('children return evidence, not permission to proceed');
    expect(flow).toContain('Follow the saved work list');
    expect(flow).not.toContain('| At step | Outcome |');
    expect(flow).toContain('`gstack-wtree` prints a Git tree hash');
    expect(flow).toContain('Offline output without that fallback, failure, malformed output or an empty version is unusable');
    expect(entrypoint?.content).toContain('Answer each AskUserQuestion before continuing');
    expect(entrypoint?.content).toContain('Routine authorization never waives those gates or their required user decisions');
    expect(entrypoint?.content).toContain('## Step 0: Detect platform and base branch');
    expect(entrypoint?.content).toContain('gh pr view --json baseRefName');
    expect(entrypoint?.content).toContain('Print the detected base branch name.');
    expect(occurrences(input.text, startMarker)).toBe(1);
    const sections = input.files.filter(file => file.kind === 'section');
    expect(sections.map(file => file.path)).toEqual(sectionPaths('ship'));
    for (const file of sections) {
      const source = readFileSync(join(ROOT, file.path), 'utf8');
      expect(file.content).toBe(source);
      expect(occurrences(input.text, source)).toBe(1);
      expect(file.startLine).toBe(1);
    }
  });

  test('generated engineering review includes the scope choices and readiness probe its steps reference', () => {
    const skillPath = 'plan-eng-review/SKILL.md';
    expect(ENG_REVIEW_EXCERPT.skillPath).toBe(skillPath);
    const options = { skillPath, startMarker: '# Plan Review Mode', endMarker: null };
    const input = readWorkflowJudgeInput({ root: ROOT, ...options });
    const entrypoint = input.files.find(file => file.kind === 'entrypoint')!;
    expect(entrypoint.content).toContain('B) A plan or design doc');
    expect(entrypoint.content).toContain('## Scope gate');
    expect(entrypoint.content.indexOf('## Scope gate')).toBeLessThan(entrypoint.content.indexOf('### Step 0: Scope Challenge'));
    expect(entrypoint.content).toContain('## Web research runs in Aside');
    // E7: the readiness probe prints the resolved Aside path (READY: $_A).
    expect(entrypoint.content).toContain('echo "READY: $_A');
    expect(input.text.indexOf('echo "READY: $_A')).toBeLessThan(input.text.indexOf('- **Search check:**'));
    expect(entrypoint.content).not.toContain('- **Search check:**');
    expect(occurrences(input.text, '- **Search check:**')).toBe(1);
    expect(occurrences(input.text, '## Scope gate')).toBe(1);
    expect(occurrences(input.text, '### 1. Architecture review')).toBe(1);
    const sections = input.files.filter(file => file.kind === 'section');
    expect(sections.map(file => file.path)).toEqual(sectionPaths('plan-eng-review'));
    for (const file of sections) {
      const source = readFileSync(join(ROOT, file.path), 'utf8');
      expect(file.content).toBe(source);
      expect(occurrences(input.text, source)).toBe(1);
    }
  });

  test('generated design consultation includes the prechecks its proposal and preview reference', () => {
    const skillPath = 'design-consultation/SKILL.md';
    const startMarker = '## Phase 0:';
    const endMarker = '## Phase 4:';
    const input = readWorkflowJudgeInput({ root: ROOT, skillPath, startMarker, endMarker });
    const entrypoint = input.files.find(file => file.kind === 'entrypoint')!;
    for (const prerequisite of ['## Phase 0: Pre-checks', 'DESIGN_MD_FORMAT:', 'DESIGN_READY', 'DESIGN_NOT_AVAILABLE']) {
      expect(entrypoint.content).toContain(prerequisite);
    }
    expect(entrypoint.content.indexOf('## Phase 0:')).toBeLessThan(entrypoint.content.indexOf('## Phase 1:'));
    expect(occurrences(input.text, '## Phase 0: Pre-checks')).toBe(1);
    const sections = input.files.filter(file => file.kind === 'section');
    expect(sections.map(file => file.path)).toEqual(sectionPaths('design-consultation'));
    for (const file of sections) {
      const source = readFileSync(join(ROOT, file.path), 'utf8');
      expect(file.content).toBe(source);
      expect(occurrences(input.text, source)).toBe(1);
    }
  });

  test('generated plan-design passes retain their full section without duplicating Pass 1', () => {
    const input = readWorkflowJudgeInput({
      root: ROOT, skillPath: 'plan-design-review/SKILL.md', startMarker: '## Review Sections', endMarker: ASK_QUESTIONS_HEADING,
    });
    expect(input.files.filter(file => file.kind === 'entrypoint')).toHaveLength(0);
    expect(input.files.map(file => file.path)).toEqual(sectionPaths('plan-design-review'));
    const section = input.files.find(file => file.path === 'plan-design-review/sections/review-sections.md');
    expect(section?.content).toBe(readFileSync(join(ROOT, 'plan-design-review/sections/review-sections.md'), 'utf8'));
    expect(section?.content).toStartWith('<!-- AUTO-GENERATED');
    expect(section?.content).toMatch(ASK_QUESTIONS_HEADING);
    expect(section?.content).toContain('## Formatting Rules');
    expect(occurrences(input.text, '### Pass 1: Information Architecture')).toBe(1);
  });
});
