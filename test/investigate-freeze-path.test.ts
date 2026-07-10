import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const FILES = ['investigate/SKILL.md.tmpl', 'investigate/SKILL.md'];

describe('investigate freeze path resolution', () => {
  for (const rel of FILES) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');

    test(`${rel} hook falls back to standalone gstack-freeze install`, () => {
      expect(content).toContain('${CLAUDE_SKILL_DIR}/../freeze/bin/check-freeze.sh');
      expect(content).toContain('${CLAUDE_SKILL_DIR}/../gstack-freeze/bin/check-freeze.sh');
      expect(content).toContain('[ -x "$S" ] && bash "$S" || exit 0');
      expect(content).toContain("command: 'bash -c ''");
    });

    test(`${rel} scope lock availability check supports standalone install`, () => {
      expect(content).toContain('_FREEZE_SCRIPT="${CLAUDE_SKILL_DIR}/../freeze/bin/check-freeze.sh"');
      expect(content).toContain('[ -x "$_FREEZE_SCRIPT" ] || _FREEZE_SCRIPT="${CLAUDE_SKILL_DIR}/../gstack-freeze/bin/check-freeze.sh"');
      expect(content).toContain('[ -x "$_FREEZE_SCRIPT" ] && echo "FREEZE_AVAILABLE" || echo "FREEZE_UNAVAILABLE"');
    });
  }
});
