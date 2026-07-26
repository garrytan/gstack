import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const FILES = ['investigate/SKILL.md.tmpl', 'investigate/SKILL.md'];

/**
 * This file used to assert that the *hook command* carried a
 * `${CLAUDE_SKILL_DIR}`-based two-way fallback ending in `|| exit 0`. That form
 * is dead on arrival: `${CLAUDE_SKILL_DIR}` is interpolated only into skill body
 * text, and the nested single quotes are shredded by the cmd.exe wrapper the
 * harness spawns hooks through — verified exit 0 with the hook never running,
 * i.e. a silent fail-open. The test was green the whole time, which is precisely
 * why the defect survived: it locked in the broken form.
 *
 * The hook command form is now owned by hook-spawn-contract.test.ts, which
 * proves by execution that each command reaches its script. What remains here is
 * the part that was always legitimate: the dual-layout probe in the skill *body*,
 * where ${CLAUDE_SKILL_DIR} genuinely is substituted.
 */
describe('investigate freeze path resolution', () => {
  for (const rel of FILES) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');

    test(`${rel} hook resolves the freeze script through $HOME inside bash -c`, () => {
      expect(content).toContain(
        'command: \'bash -c "exec \\"$HOME/.claude/skills/gstack/freeze/bin/check-freeze.sh\\""\'',
      );
    });

    test(`${rel} hook carries none of the three dead forms`, () => {
      const fm = content.slice(0, content.indexOf('\n---', 3));
      const commands = [...fm.matchAll(/^\s*command:\s*(.+?)\s*$/gm)].map((m) => m[1]);
      expect(commands.length).toBeGreaterThan(0);
      for (const c of commands) {
        expect(c).not.toContain('${CLAUDE_SKILL_DIR}');
        expect(c.startsWith("'bash -c ''")).toBe(false);
        expect(c).not.toMatch(/^"?(bash|sh)\s+\$/);
      }
    });

    // Body text IS interpolated, so the standalone-install fallback is real here
    // even though it could never work inside a hook command.
    test(`${rel} scope lock availability check supports standalone install`, () => {
      expect(content).toContain(
        '_FREEZE_SCRIPT="${CLAUDE_SKILL_DIR}/../freeze/bin/check-freeze.sh"',
      );
      expect(content).toContain(
        '[ -x "$_FREEZE_SCRIPT" ] || _FREEZE_SCRIPT="${CLAUDE_SKILL_DIR}/../gstack-freeze/bin/check-freeze.sh"',
      );
      expect(content).toContain(
        '[ -x "$_FREEZE_SCRIPT" ] && echo "FREEZE_AVAILABLE" || echo "FREEZE_UNAVAILABLE"',
      );
    });
  }
});
