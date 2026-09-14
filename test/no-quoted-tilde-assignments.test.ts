import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// #1656 / #1715 (regression of #785): a tilde inside double quotes never
// expands — `_BIN="~/.claude/..."` silently resolves to a literal ./~ path,
// so the Artifacts Sync and telemetry-finalize blocks were dead code in every
// generated skill. The resolvers now emit $HOME-based paths; this tripwire
// fails the suite if a quoted-tilde assignment ever reappears in generated
// output.

const ROOT = path.resolve(import.meta.dir, '..');
const QUOTED_TILDE_ASSIGN = /=\s*"~\//;

function generatedDocs(): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const skill = path.join(ROOT, entry.name, 'SKILL.md');
    if (fs.existsSync(skill)) out.push(skill);
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

describe('quoted-tilde assignments (#1656/#1715)', () => {
  test('no generated doc assigns a double-quoted tilde path', () => {
    const violations: string[] = [];
    for (const file of generatedDocs()) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (QUOTED_TILDE_ASSIGN.test(lines[i])) {
          violations.push(`${path.relative(ROOT, file)}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('detector self-check: the pre-fix shape is caught', () => {
    expect(QUOTED_TILDE_ASSIGN.test('_BRAIN_SYNC_BIN="~/.claude/skills/gstack/bin/gstack-brain-sync"')).toBe(true);
    expect(QUOTED_TILDE_ASSIGN.test('_BIN="$HOME/.claude/skills/gstack/bin/x"')).toBe(false);
  });
});
