/** Free regression coverage for the file bundle sent to workflow judges. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readWorkflowJudgeInput } from './helpers/workflow-judge-input';

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

function sectionPaths(skill: string): string[] {
  return readdirSync(join(ROOT, skill, 'sections'))
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => `${skill}/sections/${name}`);
}

describe('workflow judge file bundle', () => {
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
    // Read the paid caller's actual slice so changing its marker back to the
    // title cannot silently drop initialization while this helper test passes.
    const caller = readFileSync(join(ROOT, 'test/skill-llm-eval.test.ts'), 'utf8');
    const markers = caller.match(/skillPath: 'ship\/SKILL\.md',\s+startMarker: '([^']+)',\s+endMarker: '([^']+)'/);
    expect(markers).not.toBeNull();
    const [, startMarker, endMarker] = markers!;
    expect(startMarker).toBe('## Step 0: Detect platform and base branch');
    const input = readWorkflowJudgeInput({ root: ROOT, skillPath, startMarker, endMarker });
    const entrypoint = input.files.find(file => file.kind === 'entrypoint');
    expect(entrypoint?.content).toBe(source.slice(source.indexOf(startMarker), source.indexOf(endMarker, source.indexOf(startMarker))));
    expect(entrypoint?.content).toContain('git remote get-url origin');
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

  test('generated plan-design passes retain their full section without duplicating Pass 1', () => {
    const input = readWorkflowJudgeInput({
      root: ROOT, skillPath: 'plan-design-review/SKILL.md', startMarker: '## Review Sections', endMarker: '## CRITICAL RULE',
    });
    expect(input.files.filter(file => file.kind === 'entrypoint')).toHaveLength(0);
    expect(input.files.map(file => file.path)).toEqual(sectionPaths('plan-design-review'));
    const section = input.files.find(file => file.path === 'plan-design-review/sections/review-sections.md');
    expect(section?.content).toBe(readFileSync(join(ROOT, 'plan-design-review/sections/review-sections.md'), 'utf8'));
    expect(section?.content).toStartWith('<!-- AUTO-GENERATED');
    expect(section?.content).toContain('## CRITICAL RULE');
    expect(section?.content).toContain('## Formatting Rules');
    expect(occurrences(input.text, '### Pass 1: Information Architecture')).toBe(1);
  });
});
