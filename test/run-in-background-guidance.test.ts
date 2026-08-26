import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Regression guard for #2440 (which itself regressed the #497 fix).
//
// Claude Code v2.1.198 made subagents run in the BACKGROUND by default.
// Guidance written before that ("do NOT use run_in_background") stopped
// producing a foreground run — the review army and autoplan dual-voice
// steps silently launched specialists in the background and merged before
// they completed. The only guidance that works post-2.1.198 is an explicit
// `run_in_background: false` on the Agent call.
//
// This tripwire pins the corrected phrasing in the generated skill output
// and fails if the inverted form ever comes back through a template or
// resolver edit.

const ROOT = path.resolve(import.meta.dir, '..');

const GENERATED_WITH_GUIDANCE = ['review/SKILL.md', 'autoplan/SKILL.md'];

// The inverted, post-2.1.198-inert phrasings. Checked across every generated
// SKILL.md so the regression can't migrate to another skill unnoticed.
const INVERTED = /do not use\s+`?run_in_background`?/i;

function allGeneratedSkillFiles(): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const p = path.join(ROOT, entry.name, 'SKILL.md');
    if (fs.existsSync(p)) out.push(p);
    // Generated on-demand section files (e.g. ship/sections/review-army.md)
    // carry the same resolver output as SKILL.md bodies — scan them too.
    const sections = path.join(ROOT, entry.name, 'sections');
    if (fs.existsSync(sections)) {
      for (const f of fs.readdirSync(sections)) {
        if (f.endsWith('.md')) out.push(path.join(sections, f));
      }
    }
  }
  const rootSkill = path.join(ROOT, 'SKILL.md');
  if (fs.existsSync(rootSkill)) out.push(rootSkill);
  return out;
}

describe('run_in_background guidance (#2440)', () => {
  test('foreground-required skills instruct run_in_background: false explicitly', () => {
    for (const rel of GENERATED_WITH_GUIDANCE) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(content).toContain('run_in_background: false');
    }
  });

  test('the inverted "do NOT use run_in_background" phrasing never comes back', () => {
    for (const file of allGeneratedSkillFiles()) {
      const content = fs.readFileSync(file, 'utf-8');
      if (INVERTED.test(content)) {
        throw new Error(
          `${path.relative(ROOT, file)} contains the inverted run_in_background guidance — ` +
          'since Claude Code v2.1.198 subagents default to background, so "do not use" is inert; ' +
          'instruct `run_in_background: false` instead (see #2440).',
        );
      }
    }
  });
});
