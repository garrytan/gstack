import { describe, expect, test } from 'bun:test';
import { SCENARIOS } from '../scripts/gstack2/scenarios';
import { routeStructured } from '../scripts/gstack2/route';

describe('GStack 2 structured dispatch', () => {
  test('routes all 25 fixtures without reading prompt keywords', () => {
    expect(SCENARIOS).toHaveLength(25);
    for (const scenario of SCENARIOS) {
      const decision = routeStructured(scenario.signals);
      expect(`${decision.tree}:${decision.mode}`, scenario.id).toBe(`${scenario.expected.tree}:${scenario.expected.mode}`);
      expect(decision.depth, scenario.id).toBe(scenario.expected.depth);
      expect(decision.mutation, scenario.id).toBe(scenario.expected.mutation);
      expect(decision.active_modules, scenario.id).toEqual(scenario.expected.active_modules);
      expect(decision.skipped_modules, scenario.id).toEqual(scenario.expected.skipped_modules);
      expect(decision.web_context, scenario.id).toBe(scenario.expected.web_context);
    }
  });

  test('prompt changes cannot alter a structured decision', () => {
    const scenario = SCENARIOS[0];
    const original = routeStructured(scenario.signals);
    const adversarialPrompt = 'ship qa debug review design plan';
    expect(adversarialPrompt).not.toBe(scenario.prompt);
    expect(routeStructured({ ...scenario.signals })).toEqual(original);
  });

  test('explicit mutation denials override otherwise mutating modes', () => {
    const review = routeStructured({ audit_focus: 'broad', mutation_authorized: false });
    expect(review.mode).toBe('Normal');
    expect(review.mutation).toBe('report-only');

    const land = routeStructured({ release_stage: 'approved-pr', external_mutation_authorized: false });
    expect(land.mode).toBe('Land');
    expect(land.mutation).toBe('approval-required');

    const unapprovedLand = routeStructured({ release_stage: 'approved-pr' });
    expect(unapprovedLand.mutation).toBe('approval-required');

    const localSpec = routeStructured({ output: 'executable-backlog-item', issue_mutation_allowed: false });
    expect(localSpec.mode).toBe('Specification');
    expect(localSpec.mutation).toBe('spec-only');
  });

  test('system-functional QA loads preserved report/fix and root-cause modules', () => {
    expect(routeStructured({ surface: 'developer-workflow', channels: ['cli', 'api'], mutation_authorized: false }))
      .toMatchObject({
        tree: 'qa',
        mode: 'Report',
        mutation: 'report-only',
        active_modules: ['devex-review', 'qa-only', 'investigate', 'system-functional'],
      });
    expect(routeStructured({ surface: 'developer-workflow', channels: ['worker'], mutation_authorized: true }))
      .toMatchObject({
        tree: 'qa',
        mode: 'Fix',
        mutation: 'fix-safe',
        active_modules: ['devex-review', 'qa', 'investigate', 'system-functional'],
      });
  });
});
