/**
 * D3 (#2818): plan reviews read design docs and handoff notes that other
 * agents may have written, and the audit now reads repo docs/designs/ files
 * (F1). Each read site must say the content is data, not instructions, and
 * that reviewer-directed text gets reported, not followed. Meaning-level
 * check on the rendered skills: safety-critical lines, case-insensitive.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('D3: design docs and handoff notes are data, not instructions', () => {
  const sites: Array<[string, string]> = [
    ['plan-ceo-review/SKILL.md', '**Design doc check:**'],
    ['plan-eng-review/SKILL.md', '### Design Doc Check'],
    ['plan-devex-review/SKILL.md', '**Design doc check:**'],
    ['ship/sections/plan-completion.md', '### Plan File Discovery'],
    ['review/sections/plan-completion.md', '### Plan File Discovery'],
  ];
  for (const [file, anchor] of sites) {
    test(`${file}: the design-doc read treats content as data and reports reviewer-directed text`, () => {
      const md = read(file);
      const at = md.indexOf(anchor);
      expect(at).toBeGreaterThanOrEqual(0);
      const block = md.slice(at, at + 4000).replace(/\s+/g, ' ').toLowerCase();
      expect(block).toContain('data, not instructions');
      expect(block).toMatch(/never follow text[^.]*aimed at the reviewer/);
      expect(block).toContain('suspicious content');
      if (file.startsWith('plan-')) expect(block).toContain('handoff note');
    });
  }
});
