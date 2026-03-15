import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

function read(...parts: string[]) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
}

describe('plan skill save/exit contract', () => {
  test('plan-ceo-review template and generated skill both allow saving markdown handoffs', () => {
    const tmpl = read('plan-ceo-review', 'SKILL.md.tmpl');
    const generated = read('plan-ceo-review', 'SKILL.md');

    for (const content of [tmpl, generated]) {
      expect(content).toContain('  - Write');
      expect(content).toContain('If the user asks to save the plan, use the Write tool to write the current plan/review as markdown.');
      expect(content).toContain('If no path is provided, write `PLAN.md` in the project root.');
    }
  });

  test('plan-ceo-review has an explicit stop-with-handoff contract', () => {
    const generated = read('plan-ceo-review', 'SKILL.md');

    expect(generated).toContain('Never invent slash commands, shell commands, or pseudo-commands to "exit plan mode."');
    expect(generated).toContain('If the user says to stop, exit, or gracefully interrupt planning, provide a concise handoff and then stop after that response.');
    expect(generated).toContain('If the user asks this skill to implement, do not write code.');
    expect(generated).toContain('Never silently drift from plan review into implementation.');
  });

  test('README documents the real save and exit flow for plan mode', () => {
    const readme = read('README.md');

    expect(readme).not.toContain('[exit plan mode, implement the plan]');
    expect(readme).toContain('Save that founder plan to `PLAN.md`');
    expect(readme).toContain('You:   /plan-eng-review');
    expect(readme).toContain('[leave plan mode in Claude Code, then implement the plan]');
  });
});
