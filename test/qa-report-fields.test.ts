import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// C2: judge rationales from failing panels named these as execution gaps.
describe('QA report fields are defined where they are used', () => {
  test('/qa defines every placeholder in its project outcome filename', () => {
    // 37186854666 qa/SKILL.md workflow sample 2: "an undefined `{user}` in the outcome filename".
    const body = read('qa/SKILL.md.tmpl');
    const start = body.indexOf('-test-outcome-{datetime}.md');
    const sentence = body.slice(start, body.indexOf('**Per-issue additions:**', start)).replace(/\s+/g, ' ');
    for (const source of ['`git config user.name`', '`git branch --show-current`', '`unknown-user`', '`detached`', 'UTC `YYYYMMDDTHHMMSSZ`'])
      expect(sentence).toContain(source);
  });

  test('report templates name the timing fields the reporting rules define', () => {
    // 37198445662 qa-only/SKILL.md workflow sample 1: template asks for "Duration / durationMs totals"
    // while reporting.md mandates Probe budget and Guarded command time.
    const rules = read('qa-only/sections/reporting.md.tmpl');
    expect(rules).toContain('**Probe budget**');
    expect(rules).toContain('**Guarded command time**');
    for (const template of ['qa/templates/functional-report-template.md', 'qa/templates/qa-report-template.md']) {
      const text = read(template);
      expect(text, template).toMatch(/Probe budget \/ guarded command time/i);
      expect(text, template).not.toMatch(/\|\s*\**Duration\b/);
    }
  });
});
