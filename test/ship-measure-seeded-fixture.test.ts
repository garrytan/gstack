/**
 * Free checks of the seeded-flake fixture the paid case drives (CEO-3,
 * ENG-13), measured through the real scripts/ship-measure.ts CLI: unsorted it
 * measures 7 of 10 with failures that name the line, which the bar sends to
 * needs-classify and, classified fixable, to a fix round; parallel trials claim
 * unique slots that reset per round, an unrelated edit still measures 7 of 10
 * and leaves the gate red, and only the sorting fix measures 10 of 10 and turns
 * the gate green.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SEEDED_CASE, SEEDED_LINE, SORTED_FIX, UNRELATED_EDIT, createSeededFixture, readFixtureRuns } from './helpers/ship-measure-seeded-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seeded-flake-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('seeded-flake fixture (free)', () => {
  test('measures 7/10 unsorted, 7/10 after an unrelated edit, 10/10 after the sort; the gate follows', () => {
    const { repo, log } = createSeededFixture(root);
    const state = path.join(root, 'state');
    const env = { ...process.env, GSTACK_HOME: state, GSTACK_STATE_ROOT: state, SEEDED_FLAKE_LOG: log };
    const measure = (round: string) => spawnSync(process.execPath, ['run', path.join(ROOT, 'scripts/ship-measure.ts'), 'measure', '--case', SEEDED_CASE,
      '--round', round, '--command', './evals.sh case {case}', '--cost-per-trial', '0', '--jobs', '10'], { cwd: repo, env, encoding: 'utf8', timeout: 120_000 });
    const gate = () => spawnSync('./evals.sh', ['gate'], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    const roundDir = (round: string) => path.join(repo, '.context/ship-measure', SEEDED_CASE, round);

    expect(spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', timeout: 10_000 }).stdout).toBe('');
    expect(gate().status).toBe(1);

    const baseline = measure('baseline');
    expect(baseline.stdout).toContain(`DIAGNOSTIC ${SEEDED_CASE} baseline: observed 7/10 trials (baseline); needs-classify`);
    expect(baseline.status).toBe(5);
    const failed = fs.readdirSync(roundDir('baseline')).filter(t => /^t\d+$/.test(t))
      .map(t => JSON.parse(fs.readFileSync(path.join(roundDir('baseline'), t, 'trial.json'), 'utf8'))).filter(t => !t.passed);
    expect(failed).toHaveLength(3);
    for (const trial of failed) {
      expect(trial.failureCause).toBe('assertion');
      expect(trial.failureDetail).toContain(`src/priorities.js:${SEEDED_LINE} returns loadTasks(seed) in storage order`);
    }
    const slotsOf = (dir: string) => readFixtureRuns(log).filter(r => r.kind === 'case' && r.measureDir?.startsWith(dir)).map(r => r.slot).sort((a, b) => a! - b!);
    expect(slotsOf(roundDir('baseline'))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(readFixtureRuns(log).filter(r => r.kind === 'case' && r.result === 'fail').map(r => r.slot).sort()).toEqual([2, 5, 9]);
    const classify = spawnSync(process.execPath, ['run', path.join(ROOT, 'scripts/ship-measure.ts'), 'classify', '--case', SEEDED_CASE, '--round', 'baseline',
      '--trials', failed.map(t => t.trial).join(','), '--class', 'fixable', '--evidence', `src/priorities.js:${SEEDED_LINE} returns storage order`], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
    expect(classify.stdout).toContain('BELOW (fix round)');
    expect(classify.status).toBe(1);

    fs.writeFileSync(path.join(repo, 'src/priorities.js'), UNRELATED_EDIT);
    const control = measure('round-1');
    expect(control.stdout).toContain(`DIAGNOSTIC ${SEEDED_CASE} round-1: observed 7/10 trials`);
    expect(control.status).toBe(5);
    expect(slotsOf(roundDir('round-1'))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(gate().status).toBe(1);

    fs.writeFileSync(path.join(repo, 'src/priorities.js'), SORTED_FIX);
    const fixed = measure('round-2');
    expect(fixed.stdout).toContain(`DIAGNOSTIC ${SEEDED_CASE} round-2: observed 10/10 trials`);
    expect(fixed.stdout).toContain('; MEETS');
    expect(fixed.status).toBe(0);
    expect(gate().status).toBe(0);
    const runs = readFixtureRuns(log);
    expect(runs.filter(r => r.kind === 'gate').map(r => `${r.sorted}:${r.result}`)).toEqual(['0:fail', '0:fail', '1:pass']);
    expect(runs.filter(r => r.kind === 'case' && r.measureDir?.startsWith(roundDir('round-2'))).every(r => r.sorted === '1' && r.result === 'pass')).toBe(true);
  });
});
