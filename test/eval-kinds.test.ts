/**
 * Eval kind registry (E2E_KINDS / BEHAVIOR_WHY in touchfiles-data.ts). The
 * kind fixes a case's trial policy before the run, so the registry must cover
 * every live case exactly once, every behavior case must name its tolerated
 * deviation, and a behavior case must be isolatable as its own trial shard.
 * A kind edit must re-select the case in the PR lane (map-diff).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BEHAVIOR_WHY, E2E_KINDS, E2E_TIERS, E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles-data';
import { diffTouchfileMapsCore, type TouchfileMaps } from './helpers/test-selection';
import { CASE_TEST_NAMES, fileCaseRegistration } from '../scripts/test-paid-shards';
import { isPaidTestFile } from './helpers/paid-test-set';

const ROOT = path.resolve(import.meta.dir, '..');
const KIND_RULE = "Pick the kind by what can make the verdict differ between two runs of the same commit: 'rule' when nothing "
  + "stochastic decides it or it checks a contract the product must meet every run (the default); 'behavior' when a live "
  + "model choice decides it and a sub-100% per-trial rate is acceptable (add a BEHAVIOR_WHY line); 'judge' when the only "
  + 'stochastic step is an LLM judge scoring a fixed input.';

const liveIds = [...Object.keys(E2E_TIERS), ...Object.keys(LLM_JUDGE_TOUCHFILES)];
const behaviorIds = Object.keys(E2E_KINDS).filter(id => E2E_KINDS[id] === 'behavior').sort();

describe('E2E_KINDS registry', () => {
  test('every live case has exactly one kind and no kind names a dead case', () => {
    const missing = liveIds.filter(id => !(id in E2E_KINDS));
    expect(missing.length, missing.length ? `add to E2E_KINDS:\n${missing.map(id => `  '${id}': 'rule', // <reason>`).join('\n')}\n${KIND_RULE}` : '').toBe(0);
    const unknown = Object.keys(E2E_KINDS).filter(id => !liveIds.includes(id));
    expect(unknown, `E2E_KINDS names ids that are neither E2E_TIERS nor LLM_JUDGE_TOUCHFILES keys`).toEqual([]);
    expect(new Set(liveIds).size).toBe(liveIds.length);
  });

  test('kinds are rule, behavior or judge; every LLM-judge entry is judge-kind', () => {
    for (const [id, kind] of Object.entries(E2E_KINDS)) expect(['rule', 'behavior', 'judge'], id).toContain(kind);
    for (const id of Object.keys(LLM_JUDGE_TOUCHFILES)) expect(E2E_KINDS[id], `${id}: a workflow judge scores a fixed input`).toBe('judge');
  });

  test('BEHAVIOR_WHY names the tolerance of exactly the behavior cases', () => {
    expect(Object.keys(BEHAVIOR_WHY).sort()).toEqual(behaviorIds);
    for (const id of behaviorIds) {
      expect(BEHAVIOR_WHY[id]!.trim().length, `${id}: BEHAVIOR_WHY must say why an occasional deviation is acceptable`).toBeGreaterThanOrEqual(30);
    }
  });

  test('a behavior case is an isolatable trial shard: known literal registration and an exact Bun test name', () => {
    for (const id of behaviorIds) {
      const files = E2E_TOUCHFILES[id]!.filter(file => /^test\/[^/]+\.test\.ts$/.test(file) && isPaidTestFile(file));
      expect(files.length, `${id}: no paid test file registers it`).toBeGreaterThan(0);
      for (const file of files) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        expect(fileCaseRegistration(file, source).known, `${id}: ${file} has a computed registration; behavior needs a literal one`).toBe(true);
        const name = CASE_TEST_NAMES[id] ?? id;
        const literal = new RegExp(`\\b(?:test(?:\\.serial|\\.concurrent)?|testIfSelected|testConcurrentIfSelected)\\(\\s*(['"\`])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`);
        expect(literal.test(source), `${id}: ${file} must register the Bun test named '${name}'`).toBe(true);
      }
    }
  });

  test('contract-shaped cases stay rule-kind', () => {
    // Contract-shaped cases stay rule: ask-before-decide, plan-mode no-writes,
    // mandated steps, secrets, and the batching floor never ride a majority.
    for (const id of ['plan-ceo-mode-routing', 'plan-eng-multi-finding-batching', 'plan-design-review-plan-mode',
      'plan-ceo-section-loading', 'setup-gbrain-bad-token', 'qa-only-no-fix', 'review-sql-injection']) {
      expect(E2E_KINDS[id], id).toBe('rule');
    }
  });
});

describe('kind edits re-select their case (map-diff)', () => {
  const base = (): TouchfileMaps => ({
    E2E_TOUCHFILES: { alpha: ['a/**'], beta: ['b/**'] },
    E2E_TIERS: { alpha: 'gate', beta: 'periodic' },
    LLM_JUDGE_TOUCHFILES: { 'judge one': ['j/SKILL.md'] },
    GLOBAL_TOUCHFILES: [],
    E2E_KINDS: { alpha: 'rule', beta: 'rule', 'judge one': 'judge' },
    BEHAVIOR_WHY: {},
  });

  test('a rule -> behavior flip selects exactly that case', () => {
    const next = base();
    next.E2E_KINDS = { ...next.E2E_KINDS, beta: 'behavior' };
    next.BEHAVIOR_WHY = { beta: 'tolerated deviation' };
    expect(diffTouchfileMapsCore(base(), next).changedTests).toEqual(['beta']);
  });

  test('a BEHAVIOR_WHY edit alone selects its case', () => {
    const old = base(); old.E2E_KINDS!.beta = 'behavior'; old.BEHAVIOR_WHY = { beta: 'one' };
    const next = base(); next.E2E_KINDS!.beta = 'behavior'; next.BEHAVIOR_WHY = { beta: 'two' };
    expect(diffTouchfileMapsCore(old, next).changedTests).toEqual(['beta']);
  });

  test('a base revision without the kind maps selects every key', () => {
    const old = base(); delete old.E2E_KINDS; delete old.BEHAVIOR_WHY;
    expect(diffTouchfileMapsCore(old, base()).changedTests).toEqual(['alpha', 'beta', 'judge one']);
  });

  test('dropping a kind entry while the case lives on counts as changed, not removed', () => {
    const next = base(); delete next.E2E_KINDS!.alpha;
    const result = diffTouchfileMapsCore(base(), next);
    expect(result.changedTests).toEqual(['alpha']);
    expect(result.removedTests).toEqual([]);
  });
});
