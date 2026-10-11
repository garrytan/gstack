/**
 * Plan D2: review and cso look sideways. Pins the tokens, not the prose: the
 * sideways sweep and the forced-CRITICAL list reach review Step 4 and the
 * checklist, the flake-fix number reaches review and investigate from one
 * resolver, the review-mode Scope Check carries `Diff read` and `Undeclared
 * behavior changes`, /cso adopts the sibling sweep and nothing else, and ship's
 * byte-pinned plan-completion section is untouched.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORCED_CRITICAL, generateFlakeFixNumber, generateSidewaysSweep, undeclaredBehaviorLines } from '../scripts/resolvers/sideways';
import type { TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ctx = { skillName: 'review', host: 'claude' } as unknown as TemplateContext;
const between = (text: string, from: string, to: string) => {
  const a = text.indexOf(from);
  expect(a, `missing ${from}`).toBeGreaterThanOrEqual(0);
  const b = text.indexOf(to, a + from.length);
  return text.slice(a, b < 0 ? undefined : b);
};

describe('sideways resolver', () => {
  test('the forced-CRITICAL classes are the three the plan names and the review variant carries them', () => {
    expect([...FORCED_CRITICAL]).toEqual(['data loss', 'trust-boundary bypass', 'uncapped spend']);
    const review = generateSidewaysSweep(ctx);
    expect(review).toContain('worst sibling');
    expect(review).toContain('forced CRITICAL');
    for (const cls of FORCED_CRITICAL) expect(review.toLowerCase()).toContain(cls);
  });
  test('the cso variant is the sibling sweep and nothing else', () => {
    const cso = generateSidewaysSweep(ctx, ['cso']);
    expect(cso).toContain('worst sibling');
    expect(cso).not.toMatch(/CRITICAL|data loss|uncapped/);
    expect(cso.split('\n').length).toBe(1);
  });
  test('the flake-fix number is one rule in two sizes', () => {
    for (const variant of [['review'], ['investigate']]) {
      const text = generateFlakeFixNumber(ctx, variant);
      expect(text).toContain('P(fail | regression)');
      expect(text).toContain('RH-15');
      expect(text).toMatch(/before and after/);
    }
  });
  test('undeclared behavior lines: two Scope Check fields and a rule that ties approval to a full-diff read', () => {
    const { fields, rule } = undeclaredBehaviorLines();
    expect(fields.split('\n').map(l => l.split(':')[0])).toEqual(['Diff read', 'Undeclared behavior changes']);
    expect(rule).toContain('`Diff read: full`');
    expect(rule).toContain('`Scope Check: CLEAN`');
  });
});

describe('rendered review', () => {
  const skill = read('review/SKILL.md');
  const step4 = between(skill, '## Step 4: Critical pass (core review)', '### Shared-code opportunities (core pass)');
  test('Step 4 carries the sideways sweep with the forced-CRITICAL list and the flake-fix number; the enum-only paragraph is gone', () => {
    expect(step4).toContain('**Sideways sweep (every finding; reads code OUTSIDE the diff).**');
    expect(step4).toContain('forced CRITICAL');
    expect(step4).toContain('P(fail | regression)');
    expect(step4).not.toContain('**Enum & Value Completeness requires reading code OUTSIDE the diff.**');
    expect(step4).toMatch(/enum value, status, tier or type constant/);
  });
  test('the checklist has a Sideways sweep section with every shape the plan names and the forced-CRITICAL note in the severity table', () => {
    const checklist = read('review/checklist.md');
    const sweep = between(checklist, '## Sideways sweep (every finding)', '## Severity Classification');
    for (const bullet of ['**Siblings.**', '**Forced-CRITICAL.**', '**A new cache in front of a guarded or metered call.**', '**Imports moved from static to dynamic.**', '**A changed function with parity claims.**', "**Pool queries inside a caller's transaction.**", '**Test-only flake fix.**']) {
      expect(sweep).toContain(bullet);
    }
    for (const cls of FORCED_CRITICAL) expect(sweep.toLowerCase()).toContain(cls);
    expect(sweep).toContain('P(fail | regression)');
    const severity = between(checklist, '## Severity Classification', '## Fix-First Heuristic');
    expect(severity).toContain('Forced-CRITICAL (Sideways sweep)');
    expect(severity).toMatch(/└─ Gate Integrity/);
  });
  test('the review-mode Scope Check carries Diff read and Undeclared behavior changes; ship stays byte-identical', () => {
    const section = read('review/sections/plan-completion.md');
    const fence = between(section, 'Scope Check: [CLEAN / DRIFT DETECTED / REQUIREMENTS MISSING]', '```');
    expect(fence).toContain('Diff read: full (<n> files, <m> hunks) | partial (<unread paths>)');
    expect(fence).toContain('Undeclared behavior changes:');
    expect(section).toContain('count as approved only with `Diff read: full` recorded');
    for (const rel of ['ship/sections/plan-completion.md', 'ship/SKILL.md']) {
      expect(read(rel)).not.toContain('Undeclared behavior changes');
    }
  });
});

describe('rendered cso', () => {
  test('Phase 12 adopts the sibling sweep and keeps its own severity vocabulary', () => {
    const skill = read('cso/SKILL.md');
    const phase12 = between(skill, '### Phase 12', '### Phase 13');
    expect(phase12).toContain('severity follows the worst sibling');
    expect(phase12).not.toContain('root-cause variants');
    expect(phase12).not.toMatch(/forced CRITICAL|Forced-CRITICAL/);
  });
});
