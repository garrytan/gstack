/**
 * GSTA-167 variant G part 1: both prose voices carry the blocking floor verbatim and end each
 * finding with Severity and Blocks, and the Step 11 rule is additive (normalizer v2): a finding is
 * CRITICAL when its label rule says so or it says Blocks: yes; Blocks: no never lowers one.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BLOCKING_FLOOR, proseVoiceSeverity } from '../lib/review-scope';
import { generateAdversarialStep } from '../scripts/resolvers/outside-voice-steps';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = path.join(import.meta.dir, '..');
const render = (skillName: 'ship' | 'review', host: 'claude' | 'codex') => generateAdversarialStep({ skillName, tmplPath: '', host, paths: HOST_PATHS[host] } as any);
const prompt = (text: string, opener: string) => {
  const start = text.indexOf(opener);
  expect(start).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('"\n', start));
};
const BLOCKS = `A finding blocks only if it ${BLOCKING_FLOOR}; end each finding with \`Severity: Critical|High|Medium|Low\` and \`Blocks: yes|no\`.`;

describe('prose voices carry the blocking floor (GSTA-167 part 1)', () => {
  // Value: protects=the outside voice and the native adversarial pass rate against the floor the policy states, so a real
  //   blocker labeled Medium or INVESTIGATE can still say Blocks: yes; fails_when=either prompt loses the floor sentence or the
  //   Blocks line on any host or skill; seam=generateAdversarialStep
  for (const skill of ['ship', 'review'] as const) for (const host of ['claude', 'codex'] as const) {
    test(`${skill} on ${host}: both prompts end with the floor, Severity and Blocks; the structured review prompt is unchanged`, () => {
      const text = render(skill, host);
      const native = prompt(text, 'Think like an attacker and a chaos engineer. Your job');
      const outside = prompt(text, 'Review the changes on this branch against the base branch.');
      for (const p of [native, outside]) expect(p).toContain(BLOCKS);
      expect(native).toContain('classify as FIXABLE (you know how to fix it) or INVESTIGATE (needs human judgment).');
      expect(text).toContain('Prepare a structured review prompt requesting severity-tagged findings ([P0]-[P3]) or an explicit NO_FINDINGS conclusion.');
      expect(text).toContain('**FIXABLE or `Blocks: yes` findings** are CRITICAL');
      expect(text).toContain('A Critical, High or `Blocks: yes` finding is CRITICAL; `Blocks: no` never lowers one');
    });
  }

  // Value: protects=F10, every prose copy of the floor stays the same words (wrapped copies compared with whitespace
  //   collapsed); fails_when=a copy drifts from BLOCKING_FLOOR; seam=none
  test('every prose copy of the floor matches BLOCKING_FLOOR once whitespace is collapsed', () => {
    const files = ['scripts/resolvers/fix-check.ts', 'review/SKILL.md.tmpl', 'ship/SKILL.md.tmpl', 'capy/skill/gstack/factory.md', 'capy/README.md', 'docs/review-policy.md'];
    const drift = files.filter(f => !fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ').includes(BLOCKING_FLOOR));
    expect(drift).toEqual([]);
  });
});

describe('normalizer v2: CRITICAL is the label rule or Blocks: yes', () => {
  test.each([
    ['adversarial-native', { label: 'FIXABLE', blocks: 'no' }, 'CRITICAL'],
    ['adversarial-native', { label: 'INVESTIGATE', blocks: 'yes' }, 'CRITICAL'],
    ['adversarial-native', { label: 'INVESTIGATE', blocks: 'no' }, 'INFORMATIONAL'],
    ['adversarial-native', { label: 'INVESTIGATE' }, 'INFORMATIONAL'],
    ['outside-voice', { severity: 'Critical', blocks: 'no' }, 'CRITICAL'],
    ['outside-voice', { severity: 'High' }, 'CRITICAL'],
    ['outside-voice', { severity: 'P1' }, 'CRITICAL'],
    ['outside-voice', { severity: 'Medium', blocks: 'yes' }, 'CRITICAL'],
    ['outside-voice', { severity: 'Low', blocks: 'Yes, it loses the row' }, 'CRITICAL'],
    ['outside-voice', { severity: 'Medium', blocks: 'no' }, 'INFORMATIONAL'],
    ['outside-voice', { severity: 'Low' }, 'INFORMATIONAL'],
  ] as const)('%s %j -> %s', (voice, f, want) => expect(proseVoiceSeverity(voice, f)).toBe(want));
});
