/**
 * GST-3277: every refused CI carry stops gstack-ship-preflight with SHIP_LANE_NOT_CARRIED before a mapped lane runs here, in a
 * full preflight as well as under --tests-only, unless --run-uncarried-here is passed; and the stop never suggests a
 * workflow_dispatch the lane's workflow cannot take. Fixture repository with a fake gh, so nothing reaches GitHub.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fakeGhScript, type FakeWorld } from './helpers/fake-gh-runs';
import { lineOf, PREFLIGHT, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const FREE = "printf x >> ../free-runs; printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [1.00ms]\\n' >&2";
const fx = (on: string, events: string[]) => {
  const profile = { workflow: 'free.yml', events, jobs: ['suite'], artifact: 'tested-tree', os: 'Linux' };
  const f = shipFixture({
    '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': profile }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: "printf 'test/a.test.ts\\ntest/b.test.ts\\n'" } } }, null, 2) + '\n',
    '.github/workflows/free.yml': `name: Free\non: ${on}\njobs:\n  suite:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n`,
  });
  fixtures.push(f);
  return f;
};
const freeRuns = (f: ShipFx) => { const p = path.join(f.root, 'free-runs'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').length : 0; };
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** One green pull_request run of free.yml at HEAD that tested a merge with an older origin/main: the base moved after the run. */
function baseMovedWorld(f: ShipFx): void {
  const head = f.git('rev-parse', 'HEAD').stdout.trim();
  const merge = f.git('rev-parse', 'origin/main').stdout.trim();
  const run = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: head, head_branch: 'feat', path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
  const w: FakeWorld = {
    runs: [run] as FakeWorld['runs'],
    jobs: { 7: [{ name: 'suite', conclusion: 'success', completed_at: at(5) }] },
    trees: { 7: { run_id: 7, run_attempt: 1, event: 'pull_request', sha: merge, head_sha: head, tree: f.git('rev-parse', 'origin/main^{tree}').stdout.trim(), files: ['test/a.test.ts', 'test/b.test.ts'], tests: 12, os: 'Linux' } },
  };
  const file = path.join(f.root, 'world.json');
  fs.writeFileSync(file, JSON.stringify(w));
  f.gh(fakeGhScript(file));
}
const STOP = 'STOP: SHIP_LANE_NOT_CARRIED: lane free did not carry from a verified CI run at this tree, and preflight never starts a mapped lane on its own: nothing ran here (docs/troubleshooting.md#ship-lane-not-carried)';

describe('GST-3277: a refused CI carry stops every preflight unless --run-uncarried-here', () => {
  // Value: protects=a full preflight (ship/DRIVER.md's Phase 2 call) stops on CI_CARRY: none instead of running the full suite here
  //   (GBEV-115: 7 minutes of a keyless local suite on a base-moved tree_mismatch); fails_when=the mapped lane runs without the flag, the
  //   stop has no code, or the flag no longer runs it here; why_new=GST-3277; seam=fake gh, gstack-ci-carry find, gstack-evidence ledger
  test('a full preflight with a base-moved tree_mismatch stops before the lane runs; --run-uncarried-here runs it here', () => {
    const f = fx('[pull_request, workflow_dispatch]', ['pull_request', 'workflow_dispatch']);
    baseMovedWorld(f);
    const held = f.run(PREFLIGHT, ['--base', 'main', '--lane', `free=${FREE}`]);
    expect(held.status, held.stdout + held.stderr).toBe(3);
    expect(held.stdout).toMatch(/^CI_CARRY: none label=free \(no_verified_run: ci\/free: run 7: tree_mismatch \(the pull request's base moved after the run; fix: gh workflow run free\.yml --ref /m);
    expect(lineOf(held.stdout, 'STOP')).toBe(STOP);
    expect(held.stdout).toContain('once it prints CI_WAIT: green, rerun with --tests-only --base main and the same --lane flags');
    expect(held.stdout).toContain('NEXT: or rerun with --tests-only --base main and the same --lane flags, adding --run-uncarried-here to run lane free on this machine');
    expect(held.stdout).not.toContain('rerun this command');
    expect(freeRuns(f)).toBe(0);
    const tests = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lane', `free=${FREE}`]);
    expect([tests.status, lineOf(tests.stdout, 'STOP'), freeRuns(f)]).toEqual([3, STOP, 0]);
    const here = f.run(PREFLIGHT, ['--base', 'main', '--run-uncarried-here', '--lane', `free=${FREE}`]);
    expect(here.status, here.stdout + here.stderr).toBe(0);
    expect(here.stdout).toContain('CI_CARRY: none label=free (no_verified_run: ');
    expect(here.stdout).toMatch(/^LANE: free pass exit=0 tests_ran=3 /m);
    expect(freeRuns(f)).toBe(1);
  });

  // Value: protects=the stop never tells an outside-author PR to dispatch a workflow with no workflow_dispatch trigger (gbrain-evals ci.yml)
  //   and names the ways that work: push a merge of the base, or ask the author to; fails_when=a gh workflow run is suggested for a
  //   workflow that cannot take it, or the merge route is missing; why_new=GST-3277; seam=fake gh, .github/workflows trigger read from origin/main
  test('a workflow with no workflow_dispatch trigger gets the merge-and-push route, never a dispatch', () => {
    for (const [on, events] of [['[pull_request]', ['pull_request', 'workflow_dispatch']], ['[pull_request, workflow_dispatch]', ['pull_request']]] as const) {
      const f = fx(on, [...events]);
      baseMovedWorld(f);
      const branch = f.git('branch', '--show-current').stdout.trim();
      const held = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lane', `free=${FREE}`]);
      expect([on, held.status]).toEqual([on, 3]);
      expect(held.stdout).not.toContain('gh workflow run');
      expect(held.stdout).toContain(`fix: push a merge of the base to ${branch}, or ask the pull request's author to`);
      const find = f.run(path.join(path.dirname(PREFLIGHT), 'gstack-ci-carry'), ['find', '--base', 'main', '--command', FREE, '--allow-repo-commands']);
      expect(find.stdout).toContain(`fix: push a merge of the base to ${branch}, or ask the pull request's author to (free.yml cannot be dispatched for this run profile), then gstack-ci-carry wait)`);
      expect(find.stdout).not.toContain('gh workflow run');
      expect(held.stdout).toContain(`NEXT: free.yml cannot be dispatched for this run profile: merge origin/main into ${branch} and push it, or ask the pull request's author to; then gstack-ci-carry wait --base main; once it prints CI_WAIT: green, rerun this command`);
      expect(freeRuns(f)).toBe(0);
    }
  });
});
