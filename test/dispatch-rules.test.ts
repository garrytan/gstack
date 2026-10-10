/**
 * Implementer dispatch rules (docs/designs/HONEST_WORK_GATE_INTEGRITY.md W7).
 *
 * One constant renders into /spec's issue body (the archived spec that
 * `/spec --execute` pipes to `claude -p`) and into /ship Step 7's child prompt,
 * before the LAST-line JSON protocol. These checks pin the rendering sites, the
 * machine-read tokens, the untouched JSON field list and the spawn env var
 * (docs/test-value-bar.md: structure and markers, never sentences).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  IMPLEMENTER_DISPATCH_RULES, IMPLEMENTER_DISPATCH_RULES_HEADING, IMPLEMENTER_DISPATCH_RULES_ITEMS, generateImplementerDispatchRules,
} from '../scripts/resolvers/dispatch-rules';
import { RESOLVERS } from '../scripts/resolvers/index';
import { between, expectAbsent, expectMentions, expectOrdered, expectTokens } from './helpers/prompt-structure';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('the rules constant', () => {
  test('is a numbered list in the card vocabulary that forbids the forbidden dispatch', () => {
    expect(IMPLEMENTER_DISPATCH_RULES_ITEMS).toHaveLength(5);
    expect(IMPLEMENTER_DISPATCH_RULES.split('\n').map(line => line.replace(/\..*$/, ''))).toEqual(['1', '2', '3', '4', '5']);
    expectTokens(IMPLEMENTER_DISPATCH_RULES, ['`protects / fails_when / no_claim`', '"make the tests pass"'], 'rules');
    expectMentions(IMPLEMENTER_DISPATCH_RULES, [
      ['never', 'make the tests pass'],
      ['real code', 'real tests', 'same change'],
      ['test', 'timeout', 'suppression', 'own line', 'justification'],
      ['command', 'observed result'],
      ['claim', 'parent'],
    ], 'rules');
    expect(generateImplementerDispatchRules()).toBe(IMPLEMENTER_DISPATCH_RULES);
    expect(RESOLVERS.IMPLEMENTER_DISPATCH_RULES).toBe(generateImplementerDispatchRules);
    expect(IMPLEMENTER_DISPATCH_RULES_HEADING).toBe('Rules for the implementing agent');
  });
});

describe('/spec carries the rules inside the archived spec body', () => {
  const tmpl = read('spec/SKILL.md.tmpl');
  const rendered = read('spec/SKILL.md');

  test('the Standard Issues template renders the rules under its own heading and drops "Tests written and passing"', () => {
    const template = between(tmpl, '### Standard Issues', '### Epics');
    expectOrdered(template, ['## Acceptance Criteria', '## Testing Plan', `## ${IMPLEMENTER_DISPATCH_RULES_HEADING}`, '{{IMPLEMENTER_DISPATCH_RULES}}', '## Rollback Plan'], 'spec issue template');
    expectAbsent(tmpl, ['Tests written and passing'], 'spec template');
    expectAbsent(rendered, ['Tests written and passing', '{{IMPLEMENTER_DISPATCH_RULES}}'], 'spec SKILL.md');
    expect(between(rendered, '### Standard Issues', '### Epics')).toContain(IMPLEMENTER_DISPATCH_RULES);
  });

  test('acceptance criteria are written in the card vocabulary', () => {
    const criteria = between(tmpl, '## Acceptance Criteria', '## Testing Plan');
    expectTokens(criteria, ['protects=', 'fails_when=', 'no_claim=', 'none beyond protects'], 'spec acceptance criteria');
  });

  test('the --execute spawn sets GSTACK_SESSION_KIND=spawned on the claude -p line', () => {
    for (const file of ['spec/sections/gate-and-file.md.tmpl', 'spec/sections/gate-and-file.md']) {
      const spawn = read(file).split('\n').filter(line => line.includes('claude -p 2>&1'));
      expect(spawn, `${file} spawn line`).toHaveLength(1);
      expect(spawn[0]).toMatch(/GSTACK_SESSION_KIND=spawned claude -p/);
    }
  });
});

describe('/ship Step 7 child prompt carries the rules before an unchanged JSON protocol', () => {
  const JSON_LINE_PREFIX = '{"coverage_pct":N,';
  const FIELDS = ['coverage_pct', 'gaps', 'diagram', 'tests_added', 'coverage_pct_value', 'weak_gaps', 'tests_extended', 'tests_rejected', 'regression_proof'];

  test('template order: audit, rules, JSON protocol', () => {
    const child = between(read('ship/sections/test-coverage.md.tmpl'), '````text', '````\n\n**Parent processing:**');
    expectOrdered(child, ['{{TEST_COVERAGE_AUDIT_SHIP}}', `${IMPLEMENTER_DISPATCH_RULES_HEADING}:`, '{{IMPLEMENTER_DISPATCH_RULES}}', 'output a single JSON object on the LAST LINE', JSON_LINE_PREFIX], 'ship child prompt');
  });

  test('rendered prompt carries the list and the LAST-line field set is unchanged', () => {
    const child = between(read('ship/sections/test-coverage.md'), '````text', '````\n\n**Parent processing:**');
    expect(child).toContain(IMPLEMENTER_DISPATCH_RULES);
    expect(child.indexOf(IMPLEMENTER_DISPATCH_RULES)).toBeLessThan(child.indexOf(JSON_LINE_PREFIX));
    const line = child.split('\n').find(l => l.startsWith(JSON_LINE_PREFIX))!;
    const keys = Object.keys(JSON.parse(line.replace(/:N([,}])/g, ':0$1').replaceAll(',...', '')));
    expect(keys).toEqual(FIELDS);
  });
});
