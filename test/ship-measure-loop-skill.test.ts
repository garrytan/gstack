/**
 * A6 acceptance: the generated ship skill runs the measure-then-fix loop on a
 * red paid eval (classify, measure alone, decide by the measurement bar, fix
 * at the cause, re-measure, gate once) and measures a failed free shard before calling it pre-existing, and
 * it states the "diagnostic, not verdict" rule. Every ship-measure command and
 * flag the skill names exists in scripts/ship-measure.ts.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('the generated ship skill runs the loop (A6 acceptance)', () => {
  const tests = fs.readFileSync(path.join(ROOT, 'ship/sections/tests.md'), 'utf8');
  const loop = fs.readFileSync(path.join(ROOT, 'ship/sections/measure.md'), 'utf8');
  const skeleton = fs.readFileSync(path.join(ROOT, 'ship/SKILL.md'), 'utf8');

  test('a red eval no longer stops /ship: Step 6 reads the loop instead of rerunning the gate', () => {
    expect(tests).not.toContain('Show failures and available costs, then **STOP**.');
    const step6 = tests.slice(tests.indexOf('## Step 6: Eval Suites'));
    expect(step6).toMatch(/If any eval fails:\*\* Do not rerun the full gate\./);
    expect(step6).toContain('Read `~/.claude/skills/gstack/ship/sections/measure.md`');
    expect(step6).toContain('classify, measure alone, fix at the cause, re-measure,\n  then gate once');
    expect(skeleton).toContain('| `sections/measure.md` |');
  });

  test('the loop steps run in order: classify, plan, measure, decide, fix, re-measure, stop, then gate once', () => {
    const steps = ['1. **Classify.**', '2. **Show the plan.**', '3. **Measure.**', '4. **Decide by the exit code**', '5. **Fix at the cause.**', '6. **Re-measure.**', '7. **Stop.**', '**Gate once.**'];
    const positions = steps.map(step => loop.indexOf(step));
    expect(positions.every(p => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(loop).toContain('run the full\ngate once');
    // A push that runs the gate in CI is the gate run; a second dispatch doubles the paid gate.
    expect(loop).toContain('the push is the gate run');
    expect(loop).toContain('do not also start the gate command');
  });

  test('the decision branches on every exit code the runner returns, with the bar and its rules', () => {
    const decideStep = loop.slice(loop.indexOf('4. **Decide by the exit code**'), loop.indexOf('5. **Fix at the cause.**'));
    for (const code of ['- 0: MEETS or MEETS-qualified', '- 5: needs-classify', '- 6: EXTEND', '- 1: BELOW']) expect(decideStep).toContain(code);
    for (const cls of ['provider', 'judge-noise', 'model-miss', 'timeout', 'hang', 'regression', 'fixable', 'unclassified']) expect(decideStep).toContain(`\`${cls}\``);
    expect(decideStep).toMatch(/MEETS 9\/10, MEETS-qualified 8\/10[\s\S]*EXTEND 7\/10; behavior 11\/12, 10\/12, 9\/12/);
    expect(decideStep).toMatch(/never a third batch/i);
    expect(loop.slice(loop.indexOf('7. **Stop.**'))).toContain('Exit 3 is a named red');
    const source = fs.readFileSync(path.join(ROOT, 'scripts/lib/measure-bar.ts'), 'utf8');
    for (const cls of ['provider', 'judge-noise', 'model-miss', 'timeout', 'hang', 'regression', 'fixable', 'unclassified']) expect(source).toContain(`'${cls}'`);
  });

  test('the diagnostic-not-verdict rule, the honest-fix rule and the unmeasured label are stated', () => {
    expect(loop).toContain('Every rerun here is **diagnostic, not a verdict**: it never changes the recorded\nverdict of the run that failed');
    expect(loop).toContain('Never raise a budget, lower a\nthreshold, add a verdict retry or skip a case to get a pass.');
    expect(loop).toContain('report "observed k/n after fix at <cause>", never a proven rate');
    expect(loop).toContain('labels it `unmeasured` in the PR body. It never counts as a pass.');
    expect(loop).toContain('ask\n   once and record the answer in the report');
  });

  test('a failed free shard is measured before it is called pre-existing, with the retry off', () => {
    expect(tests).toContain('When a free-suite shard failed,\nfirst Read `~/.claude/skills/gstack/ship/sections/measure.md`');
    expect(tests.indexOf('sections/measure.md')).toBeLessThan(tests.indexOf('Then apply the Test\nFailure Ownership Triage'));
    const free = loop.slice(loop.indexOf('**Failed free-suite shard (Step 5).**'), loop.indexOf('**Red paid eval (Step 6).**'));
    for (const phrase of ['Before calling the failure pre-existing or\npushing', 'exact file list', 'rerun 1 alone as the baseline', 'the flaky retry off',
      '10-minute cap', 'ship_rerun_backend=ubicloud', 'rerun the whole failing\ncommand', 'completed at the cap']) expect(free).toContain(phrase);
  });

  test('every ship-measure command and flag the skill names exists in the runner', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/ship-measure.ts'), 'utf8');
    const named = [...loop.matchAll(/ship-measure (\w+)([^`]*)`/g)];
    expect(named.length).toBeGreaterThan(5);
    for (const [, command, rest] of named) {
      expect(source).toMatch(new RegExp(`command [!=]== '${command}'`));
      for (const [flag] of rest!.matchAll(/--[a-z-]+/g)) expect(source).toContain(`'${flag}'`);
    }
  });
});
