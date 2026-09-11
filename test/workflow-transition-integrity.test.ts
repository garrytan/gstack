import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

function workflow(skill: string): string {
  const chunks = [fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf8')];
  const sections = path.join(ROOT, skill, 'sections');
  for (const file of fs.readdirSync(sections).filter((name) => name.endsWith('.md'))) {
    chunks.push(fs.readFileSync(path.join(sections, file), 'utf8'));
  }
  return chunks.join('\n');
}

describe('generated workflow transition integrity', () => {
  for (const skill of ['ship', 'land-and-deploy']) {
    test(`${skill} directive targets name an existing generated step`, () => {
      const content = workflow(skill);
      const headings = new Set([...content.matchAll(/^#{2,3} Step ([0-9]+(?:\.[0-9]+)?):/gmi)].map((match) => match[1]));
      const directives = [...content.matchAll(/(?:go|continue|resume|proceed|moving|re-run|skip)[^\n]{0,100}?Step ([0-9]+(?:\.[0-9]+)?)/gmi)];
      expect(directives.length).toBeGreaterThan(0);
      for (const directive of directives) expect(headings.has(directive[1])).toBe(true);
    });
  }

  test('known transition regressions use the next reachable stage', () => {
    const land = fs.readFileSync(path.join(ROOT, 'land-and-deploy/SKILL.md.tmpl'), 'utf8');
    const tests = fs.readFileSync(path.join(ROOT, 'ship/sections/tests.md.tmpl'), 'utf8');
    const review = fs.readFileSync(path.join(ROOT, 'ship/sections/review-army.md.tmpl'), 'utf8');
    const greptile = fs.readFileSync(path.join(ROOT, 'ship/sections/greptile.md.tmpl'), 'utf8');
    const prBody = fs.readFileSync(path.join(ROOT, 'ship/sections/pr-body.md.tmpl'), 'utf8');
    expect(land).toContain('continue to Step 3.4, then Step 3.5 before merging');
    expect(tests).toContain('continue to Step 7');
    expect(review).toContain('continue to Step 10');
    expect(greptile).toContain('continue to Step 11');
    expect(prBody).toContain('path (Step 19)');
  });
});
