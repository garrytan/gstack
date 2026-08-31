import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const FILES = ['investigate/SKILL.md.tmpl', 'investigate/SKILL.md'];

// #2469: frontmatter hooks (and early skill bash) run before any runtime
// variable exists, so a ${CLAUDE_SKILL_DIR}-relative path silently never
// resolved and the scope-lock guard failed open via `|| exit 0`. Both the
// hook commands and the Scope Lock probe must anchor on $HOME like the
// careful/freeze skills (#1871). The old standalone `gstack-freeze` sibling
// fallback was part of the never-resolving path — prefix installs keep the
// payload at ~/.claude/skills/gstack/, so the $HOME anchor covers them.
describe('investigate freeze path resolution', () => {
  for (const rel of FILES) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');

    test(`${rel} hook resolves check-freeze via the $HOME anchor`, () => {
      expect(content).toContain('S="$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh"');
      expect(content).toContain('[ -x "$S" ] && exec bash "$S"; exit 0');
      const commandLines = content.split('\n').filter((l) => l.trim().startsWith('command:'));
      expect(commandLines.length).toBeGreaterThan(0);
      for (const line of commandLines) {
        expect(line).not.toContain('CLAUDE_SKILL_DIR');
      }
    });

    test(`${rel} scope lock availability probe uses the $HOME anchor`, () => {
      expect(content).toContain('_FREEZE_SCRIPT="$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh"');
      expect(content).toContain('[ -x "$_FREEZE_SCRIPT" ] && echo "FREEZE_AVAILABLE" || echo "FREEZE_UNAVAILABLE"');
    });
  }
});
