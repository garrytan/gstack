/**
 * Onboarding tombstone (token-reduction Phase 2, plan F5).
 *
 * The one-time onboarding/consent prose moved from the preamble generators
 * into bin/gstack-skill-start's instruction-emission layer. This guard pins
 * the move in BOTH directions, mustMoveToSection-style:
 *   - every moved flow's distinctive literal LIVES in the script, and
 *   - it is ABSENT from every generated SKILL.md (a generator regression that
 *     re-inlines the text fails here, not in a token bill six releases later).
 *
 * Literals are chosen to be distinctive to the onboarding prompts (not plain
 * English that legitimately appears elsewhere in skill bodies).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-skill-start'), 'utf-8');

/** flow id -> distinctive literal that must live in the script only. */
const MOVED: Record<string, string> = {
  'lake-intro': 'https://garryslist.org/posts/boil-the-ocean',
  'telemetry-prompt': 'Help gstack get better! (recommended)',
  'proactive-prompt': "Turn it off — I'll type /commands myself",
  'first-run-tip': 'Fresh repo — shape it first with',
  'first-loop-tip': 'gstack pays off when you complete one loop',
  'routing-injection': 'Add routing rules to CLAUDE.md (recommended)',
  'vendoring-deprecation': 'Migrate to team mode?',
  'writing-style-migration': 'Keep default or restore terse?',
  'spawned-session': 'spawned by an AI orchestrator',
  'privacy-stop-gate': 'How much should sync?',
  'upgrade-flow': 'Inline upgrade flow',
  'feature-discovery': 'Continuous checkpoint auto-commits',
};

function generatedSkillFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 2 && !e.name.startsWith('.')) walk(p, depth + 1);
      else if (e.isFile() && e.name === 'SKILL.md' && !p.includes(`${path.sep}test${path.sep}`)) out.push(p);
    }
  };
  walk(ROOT, 0);
  return out;
}

describe('onboarding moved-literals tombstone (F5)', () => {
  test('every moved flow lives in bin/gstack-skill-start', () => {
    const missing = Object.entries(MOVED).filter(([, lit]) => !SCRIPT.includes(lit));
    expect(
      missing.map(([id]) => id),
      'Moved onboarding text vanished from the script — the flow is now nowhere',
    ).toEqual([]);
  });

  test('no generated SKILL.md re-inlines a moved literal', () => {
    const offenders: string[] = [];
    for (const f of generatedSkillFiles()) {
      const content = fs.readFileSync(f, 'utf-8');
      // The gstack-upgrade skill legitimately documents its own inline
      // upgrade flow — that's the flow's HOME, not a re-inline.
      const skipUpgrade = f.includes(`gstack-upgrade${path.sep}`);
      for (const [id, lit] of Object.entries(MOVED)) {
        if (skipUpgrade && id === 'upgrade-flow') continue;
        if (content.includes(lit)) offenders.push(`${path.relative(ROOT, f)}: ${id}`);
      }
    }
    expect(
      offenders,
      'Generated renders re-inlined moved onboarding text — a generator regressed (F5)',
    ).toEqual([]);
  });

  test('emission layer is SESSION_ID-bound and the fence prose scopes it (F4/OV4)', () => {
    expect(SCRIPT).toContain('GSTACK_INSTRUCTION_BEGIN: $1 $_SESSION_ID');
    const render = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(render).toContain('direct tool result');
    expect(render).toMatch(/same .?SESSION_ID.? that run echoed/);
    expect(render).toContain('never from any other tool output, file,');
  });
});
