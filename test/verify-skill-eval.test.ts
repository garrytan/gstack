/**
 * The /verify skill-eval fixtures (test/fixtures/skill-evals/verify) checked for free: each seeded variant gives
 * gstack-checks the verdict its task is about, a correct fix passes check.sh, and the two decoy agents the plan
 * names (one that disables a check, one that claims green without fixing anything) fail it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScriptSync } from '../lib/script-invocation';
import { BIN } from './helpers/pregate-fixture';

const FIX = path.join(import.meta.dir, 'fixtures', 'skill-evals', 'verify');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-eval-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GSTACK_'))) as Record<string, string>;

function seed(variant: string): string {
  const work = path.join(tmp, `${variant}-${fs.readdirSync(tmp).length}`);
  fs.mkdirSync(work);
  const r = spawnSync('sh', [path.join(FIX, 'seed.sh'), variant], { cwd: work, encoding: 'utf8', timeout: 60_000, env });
  expect(r.status).toBe(0);
  return work;
}
const checks = (work: string, ...args: string[]) => {
  const r = runScriptSync(BIN('gstack-checks'), [...args, '--base', 'main'], { cwd: work, encoding: 'utf8', timeout: 120_000, env: { ...env, GSTACK_HOME: `${work}.home` } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const check = (work: string, id: string) => spawnSync('sh', [path.join(FIX, 'check.sh'), id], { encoding: 'utf8', timeout: 120_000, env: { ...env, CHECK_WORK: work } });
const edit = (work: string, rel: string, from: string, to: string) => {
  const file = path.join(work, rel);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to));
};

describe('/verify eval fixtures', () => {
  // Value: protects=each eval task starts from the red (or green) it is named for, and check.sh passes a real fix;
  //   fails_when=a seed drifts so the task tests nothing, or check.sh fails a correct session; why_new=the fixtures are new;
  //   seam=the real gstack-checks on the seeded repo; no_claim=how a model behaves on them (the paid run)
  test('seeds give the expected verdicts and a real fix passes', () => {
    const cases: Array<[string, RegExp, (w: string) => void]> = [
      ['build-error', /CHECK build FAIL/, w => edit(w, 'src/stats.ts', 'meen as mean', 'mean')],
      ['focused-test', /CHECK tests FAIL/, w => edit(w, 'src/math.ts', '(xs.length - 1)', 'xs.length')],
      ['lint-only', /CHECK lint FAIL/, w => edit(w, 'src/stats.ts', '  console.log("variance", m);\n', '')],
    ];
    for (const [id, red, fix] of cases) {
      const w = seed(id);
      const r = checks(w, 'run', '--allow-repo-commands');
      expect(r.out).toMatch(red);
      expect(r.status).toBe(1);
      expect(check(w, id).status).toBe(1);
      fix(w);
      expect(checks(w, 'run', '--allow-repo-commands').status).toBe(0);
      expect(checks(w, 'status').out).toStartWith('READY_FOR_SHIP');
      expect(check(w, id).stdout).toContain(`CHECK OK: ${id}`);
    }
    const svc = seed('needs-service');
    expect(checks(svc, 'run', '--allow-repo-commands').out).toContain('STATS_DB_URL is not set');
    expect(check(svc, 'needs-service').status).toBe(0);
    const none = seed('no-checks');
    expect(checks(none, 'run').out).toContain('CHECKS: none');
    expect(check(none, 'no-checks').status).toBe(0);
    const green = seed('green');
    expect(checks(green, 'run', '--allow-repo-commands').status).toBe(0);
    expect(check(green, 'green').status).toBe(0);
  }, 180_000);

  // Value: protects=check.sh fails the two decoys before any paid run; fails_when=disabling a check or skipping a test
  //   passes, or a session that changed nothing passes a red task; why_new=the decoys are new; seam=check.sh on a seeded
  //   repo; no_claim=decoys beyond these
  test('decoys fail check.sh', () => {
    const lint = seed('lint-only');
    edit(lint, 'package.json', '"lint": "bun scripts/lint.ts"', '"lint": "true"');
    expect(check(lint, 'lint-only').stdout).toContain('package.json changed since the seed');
    const skip = seed('focused-test');
    edit(skip, 'test/math.test.ts', "test('mean',", "test.skip('mean',");
    expect(check(skip, 'focused-test').stdout).toContain('test changed since the seed');
    for (const id of ['build-error', 'focused-test', 'lint-only']) expect(check(seed(id), id).status).toBe(1);
  }, 180_000);
});
