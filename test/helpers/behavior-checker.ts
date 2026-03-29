/**
 * Behavior assertion runner for skill E2E tests.
 *
 * Loads JSON behavior specs from test/fixtures/behaviors/ and checks
 * that skill output contains (or does not contain) expected patterns.
 * Deterministic, free (no API cost), and fast.
 *
 * Used by test/skill-e2e.test.ts after E2E tests capture output.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface Assertion {
  type: 'section_exists' | 'pattern_exists' | 'pattern_absent' | 'min_sections';
  pattern?: string;
  regex?: boolean;
  case_insensitive?: boolean;
  heading_level?: number;
  min_count?: number;
  description: string;
}

export interface BehaviorSpec {
  skill: string;
  assertions: Assertion[];
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  detail?: string;
}

export interface BehaviorCheckResult {
  passed: boolean;
  results: AssertionResult[];
}

const BEHAVIORS_DIR = path.join(__dirname, '..', 'fixtures', 'behaviors');

/**
 * Load a behavior spec for a skill by name.
 * Returns null if no spec file exists.
 */
export function loadBehaviorSpec(skillName: string): BehaviorSpec | null {
  const specPath = path.join(BEHAVIORS_DIR, `${skillName}.json`);
  if (!fs.existsSync(specPath)) return null;
  return JSON.parse(fs.readFileSync(specPath, 'utf-8'));
}

/**
 * List all available behavior specs.
 */
export function listBehaviorSpecs(): string[] {
  if (!fs.existsSync(BEHAVIORS_DIR)) return [];
  return fs.readdirSync(BEHAVIORS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

/**
 * Run all assertions from a behavior spec against the given output text.
 */
export function checkBehaviors(output: string, spec: BehaviorSpec): BehaviorCheckResult {
  const results: AssertionResult[] = [];

  for (const assertion of spec.assertions) {
    const result = runAssertion(output, assertion);
    results.push(result);
  }

  return {
    passed: results.every(r => r.passed),
    results,
  };
}

function runAssertion(output: string, assertion: Assertion): AssertionResult {
  switch (assertion.type) {
    case 'section_exists':
    case 'pattern_exists':
      return checkPatternExists(output, assertion);
    case 'pattern_absent':
      return checkPatternAbsent(output, assertion);
    case 'min_sections':
      return checkMinSections(output, assertion);
    default:
      return { assertion, passed: false, detail: `Unknown assertion type: ${assertion.type}` };
  }
}

function checkPatternExists(output: string, assertion: Assertion): AssertionResult {
  if (!assertion.pattern) {
    return { assertion, passed: false, detail: 'No pattern specified' };
  }

  const flags = assertion.case_insensitive ? 'i' : '';

  if (assertion.regex) {
    const re = new RegExp(assertion.pattern, flags);
    const match = re.test(output);
    return {
      assertion,
      passed: match,
      detail: match ? undefined : `Pattern /${assertion.pattern}/${flags} not found in output`,
    };
  }

  const haystack = assertion.case_insensitive ? output.toLowerCase() : output;
  const needle = assertion.case_insensitive ? assertion.pattern.toLowerCase() : assertion.pattern;
  const found = haystack.includes(needle);
  return {
    assertion,
    passed: found,
    detail: found ? undefined : `"${assertion.pattern}" not found in output`,
  };
}

function checkPatternAbsent(output: string, assertion: Assertion): AssertionResult {
  if (!assertion.pattern) {
    return { assertion, passed: false, detail: 'No pattern specified' };
  }

  const flags = assertion.case_insensitive ? 'i' : '';

  if (assertion.regex) {
    const re = new RegExp(assertion.pattern, flags);
    const match = re.test(output);
    return {
      assertion,
      passed: !match,
      detail: match ? `Unwanted pattern /${assertion.pattern}/${flags} found in output` : undefined,
    };
  }

  const haystack = assertion.case_insensitive ? output.toLowerCase() : output;
  const needle = assertion.case_insensitive ? assertion.pattern.toLowerCase() : assertion.pattern;
  const found = haystack.includes(needle);
  return {
    assertion,
    passed: !found,
    detail: found ? `Unwanted pattern "${assertion.pattern}" found in output` : undefined,
  };
}

function checkMinSections(output: string, assertion: Assertion): AssertionResult {
  const level = assertion.heading_level ?? 2;
  const minCount = assertion.min_count ?? 1;
  const prefix = '#'.repeat(level) + ' ';

  const headingCount = output.split('\n').filter(line => line.startsWith(prefix)).length;

  return {
    assertion,
    passed: headingCount >= minCount,
    detail: headingCount >= minCount
      ? undefined
      : `Found ${headingCount} h${level} headings, expected at least ${minCount}`,
  };
}
