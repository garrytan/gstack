import { describe, test, expect } from 'bun:test';
import { checkBehaviors, loadBehaviorSpec, listBehaviorSpecs } from './helpers/behavior-checker';
import type { BehaviorSpec } from './helpers/behavior-checker';

describe('behavior-checker', () => {
  test('listBehaviorSpecs returns all spec files', () => {
    const specs = listBehaviorSpecs();
    expect(specs).toContain('review');
    expect(specs).toContain('retro');
    expect(specs).toContain('qa');
    expect(specs).toContain('ship');
    expect(specs).toContain('plan-ceo-review');
    expect(specs).toContain('plan-eng-review');
    expect(specs.length).toBe(6);
  });

  test('loadBehaviorSpec returns null for nonexistent skill', () => {
    expect(loadBehaviorSpec('nonexistent-skill')).toBeNull();
  });

  test('loadBehaviorSpec loads valid spec', () => {
    const spec = loadBehaviorSpec('review');
    expect(spec).not.toBeNull();
    expect(spec!.skill).toBe('review');
    expect(spec!.assertions.length).toBeGreaterThan(0);
  });

  test('pattern_exists passes when pattern is found', () => {
    const spec: BehaviorSpec = {
      skill: 'test',
      assertions: [
        { type: 'pattern_exists', pattern: 'hello', description: 'find hello' },
      ],
    };
    const result = checkBehaviors('hello world', spec);
    expect(result.passed).toBe(true);
    expect(result.results[0].passed).toBe(true);
  });

  test('pattern_exists fails when pattern is missing', () => {
    const spec: BehaviorSpec = {
      skill: 'test',
      assertions: [
        { type: 'pattern_exists', pattern: 'goodbye', description: 'find goodbye' },
      ],
    };
    const result = checkBehaviors('hello world', spec);
    expect(result.passed).toBe(false);
    expect(result.results[0].detail).toContain('not found');
  });

  test('pattern_exists with regex', () => {
    const spec: BehaviorSpec = {
      skill: 'test',
      assertions: [
        { type: 'pattern_exists', pattern: '\\d+ commits', regex: true, description: 'metric' },
      ],
    };
    expect(checkBehaviors('Found 42 commits this week', spec).passed).toBe(true);
    expect(checkBehaviors('No metrics here', spec).passed).toBe(false);
  });

  test('pattern_exists with case_insensitive', () => {
    const spec: BehaviorSpec = {
      skill: 'test',
      assertions: [
        { type: 'pattern_exists', pattern: 'CRITICAL', regex: true, case_insensitive: true, description: 'crit' },
      ],
    };
    expect(checkBehaviors('critical finding: SQL injection', spec).passed).toBe(true);
    expect(checkBehaviors('CRITICAL: race condition', spec).passed).toBe(true);
  });

  test('pattern_absent passes when pattern is not found', () => {
    const spec: BehaviorSpec = {
      skill: 'test',
      assertions: [
        { type: 'pattern_absent', pattern: 'variable name', regex: true, case_insensitive: true, description: 'no nitpick' },
      ],
    };
    expect(checkBehaviors('SQL injection in user controller', spec).passed).toBe(true);
  });

  test('pattern_absent fails when pattern is found', () => {
    const spec: BehaviorSpec = {
      skill: 'test',
      assertions: [
        { type: 'pattern_absent', pattern: 'variable name', regex: true, case_insensitive: true, description: 'no nitpick' },
      ],
    };
    const result = checkBehaviors('Consider renaming this variable name to something clearer', spec);
    expect(result.passed).toBe(false);
    expect(result.results[0].detail).toContain('Unwanted');
  });

  test('min_sections counts headings correctly', () => {
    const spec: BehaviorSpec = {
      skill: 'test',
      assertions: [
        { type: 'min_sections', heading_level: 2, min_count: 3, description: 'enough sections' },
      ],
    };
    const output = `# Title
## Section One
content
## Section Two
content
## Section Three
content`;
    expect(checkBehaviors(output, spec).passed).toBe(true);
  });

  test('min_sections fails when not enough headings', () => {
    const spec: BehaviorSpec = {
      skill: 'test',
      assertions: [
        { type: 'min_sections', heading_level: 2, min_count: 3, description: 'enough sections' },
      ],
    };
    const result = checkBehaviors('## Only One\ncontent', spec);
    expect(result.passed).toBe(false);
    expect(result.results[0].detail).toContain('Found 1');
  });

  test('all spec files parse correctly', () => {
    const specs = listBehaviorSpecs();
    for (const name of specs) {
      const spec = loadBehaviorSpec(name);
      expect(spec).not.toBeNull();
      expect(spec!.skill).toBe(name);
      expect(spec!.assertions.length).toBeGreaterThan(0);
      for (const a of spec!.assertions) {
        expect(a.type).toBeDefined();
        expect(a.description).toBeDefined();
      }
    }
  });

  test('review spec passes on realistic output', () => {
    const spec = loadBehaviorSpec('review')!;
    const output = `# Pre-Landing Review

## CRITICAL Findings

1. SQL injection in user_controller.rb line 15

## INFORMATIONAL Findings

1. Missing index on users.email column
2. Consider adding rate limiting to login endpoint`;
    const result = checkBehaviors(output, spec);
    expect(result.passed).toBe(true);
  });

  test('retro spec passes on realistic output', () => {
    const spec = loadBehaviorSpec('retro')!;
    const output = `# Weekly Retrospective

## Summary

15 commits by 3 contributors this week.

## Team Contributions

### Alice
- 8 commits, 2 PRs merged
- Strong work on the auth module

### Bob
- 5 commits focused on testing
- 1 PR merged`;
    const result = checkBehaviors(output, spec);
    expect(result.passed).toBe(true);
  });
});
