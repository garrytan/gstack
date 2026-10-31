/**
 * GSTA-167 variant G part 1: both prose voices carry the blocking floor verbatim and end each
 * finding with Severity and Blocks, and the Step 11 rule is additive (normalizer v2): a finding is
 * CRITICAL when its label rule says so or it says Blocks: yes; Blocks: no never lowers one.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFindings, rank } from '../lib/review-ledger';
import { BLOCKING_FLOOR } from '../lib/review-scope';
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

describe('normalizer v2 as collected: Blocks: yes is CRITICAL, Blocks: no never lowers a label', () => {
  // Value: protects=the rule round 5's G1 was scored under, on the path production runs (gstack-review-dispatch collect);
  //   fails_when=Blocks: yes collects below CRITICAL or Blocks: no lowers a label; seam=parseFindings
  test.each([
    ['FIXABLE: race in a.ts:3\nSeverity: Medium\nBlocks: no', 'CRITICAL'],
    ['INVESTIGATE: odd lock in b.ts:9\nSeverity: Low\nBlocks: yes', 'CRITICAL'],
    ['INVESTIGATE: odd lock in b.ts:9\nBlocks: no', 'INVESTIGATE'],
    ['FIXABLE: race in a.ts:3. Severity: Medium. Blocks: no', 'CRITICAL'],
    ['1. FIXABLE: race in a.ts:3 — Severity: Low, Blocks: no', 'CRITICAL'],
    ['- FIXABLE: race in a.ts:3\n- Severity: Medium\n- Blocks: no', 'CRITICAL'],
  ] as const)('native %j -> %s', (output, want) => expect(parseFindings('adversarial-native', output).map(g => g.label)).toEqual([want]));
  test.each([
    ['1. Drops the last row (q.ts:7). Severity: Critical. Blocks: no', 'Critical'],
    ['1. Cache evicts sessions (c.ts:4)\n   Severity: High', 'High'],
    ['1. Retry storm (r.ts:2)\n   Severity: Medium\n   Blocks: yes', 'CRITICAL'],
    ['1. Index drift (i.ts:5). Severity: Low. Blocks: Yes, it loses the row', 'CRITICAL'],
    ['1. Naming (n.ts:1)\n   Severity: Low\n   Blocks: no', 'Low'],
  ] as const)('%j -> %s', (output, want) => {
    const got = parseFindings('outside-voice', output);
    expect(got.map(g => g.label)).toEqual([want]);
    expect(rank(got[0]!.label)).not.toBeNull();
  });
});
