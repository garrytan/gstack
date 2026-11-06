/**
 * GST-1595 (1): gstack-ship-release accept reruns gstack-pregate on the final tree under the branch's own
 * .gstack/pregate.json only when that file adds test lanes and changes nothing else, so the gate gets stricter, never
 * looser; any other difference keeps the base policy. gstack-evals #240's shape: a PR that adds a runtime file plus its
 * own lane line passed preflight under --policy-from head, then refused at accept with PREGATE_NO_LANE.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fakeGhScript, type FakeWorld } from './helpers/fake-gh-runs';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const FREE = "printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [1.00ms]\\n' >&2";
const PROFILE = { workflow: 'free.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['suite'], artifact: 'tested-tree', os: 'Linux' };
const TESTS = ['test/a.test.ts', 'test/new.test.ts'];
const DEPS = { 'src/a.ts': ['test/a.test.ts'], 'src/b.ts': ['test/a.test.ts'], 'test/**': [] };
const policy = (deps: Record<string, string[]>, extra: Record<string, unknown> = {}) => JSON.stringify({
  run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: `printf '${TESTS.join('\\n')}\\n'` } }, dependencies: deps, ...extra,
}, null, 2) + '\n';
const passing = "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n";
const BASE = {
  '.gstack/pregate.json': policy(DEPS),
  '.github/workflows/free.yml': 'name: Free\non: [pull_request, workflow_dispatch]\njobs:\n  suite:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n',
  'test/a.test.ts': passing,
};
/** The #240 shape: a new runtime file, its own test, and the lane line that maps one to the other. */
const PR = { 'src/b.ts': 'export const b = 2;\n', 'src/new.ts': 'export const fresh = 1;\n', 'test/new.test.ts': passing };
const ADDS = { ...DEPS, 'src/new.ts': ['test/new.test.ts'] };

function fx(headPolicy: string): ShipFx {
  const f = shipFixture(BASE, { ...PR, '.gstack/pregate.json': headPolicy });
  fixtures.push(f);
  const head = f.git('rev-parse', 'HEAD').stdout.trim();
  const tree = f.git('rev-parse', 'HEAD^{tree}').stdout.trim();
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const run = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: head, path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
  const w: FakeWorld = { runs: [run] as FakeWorld['runs'], jobs: { 7: [{ name: 'suite', conclusion: 'success', completed_at: at(5) }] }, trees: { 7: { run_id: 7, run_attempt: 1, event: 'workflow_dispatch', sha: head, tree, files: TESTS, tests: 2, os: 'Linux' } } };
  fs.writeFileSync(path.join(f.root, 'world.json'), JSON.stringify(w));
  f.gh(fakeGhScript(path.join(f.root, 'world.json')));
  expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], { GSTACK_SESSION_KIND: 'unattended' }).status).toBe(0);
  return f;
}
const lanesCheck = (f: ShipFx) => JSON.parse(fs.readFileSync(path.join(f.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: { id: string }) => c.id === 'lanes');
const accept = (f: ShipFx) => f.run(RELEASE, ['accept', '--base', 'main', '--lane', `free=${FREE}`, '--wait', '0']);

describe('accept: a lanes-only head policy gates the final tree (GST-1595)', () => {
  // Value: protects=a PR that adds a runtime file and its own lane line passes accept, gated by that lane; fails_when=accept reruns pregate under the base
  //   policy and refuses with PREGATE_NO_LANE (gstack-evals #240); why_new=GEVA-2 had to land a lanes-only PR first; seam=fake gh, gstack-pregate
  test('a head policy that only adds the new file\'s lane: accept passes under it', () => {
    const f = fx(policy(ADDS));
    const ok = accept(f);
    expect([ok.status, lineOf(ok.stdout, 'PREGATE'), lanesCheck(f).status], ok.stdout).toEqual([0, expect.stringMatching(/^PREGATE: (pass|warn) \(final tree\)$/), 'pass']);
    expect(lineOf(ok.stdout, 'POLICY')).toBe('POLICY: head (unreviewed) .gstack/pregate.json: adds 1 test lane over origin/main and changes nothing else, so the gate is only stricter');
    expect(ok.stdout).toContain('NEXT: Step 18');
  });

  // Value: protects=accept never gates under a stale branch registry: --policy-from head loads .gstack/generated.json from the branch
  //   (lib/pregate/context.ts loadRegistryFromHead), so a branch whose copy differs from main's tip keeps the base policy;
  //   fails_when=lanesOnlyHeadPolicy compares generated.json with the fork copy and picks the head policy; seam=lanesOnlyHeadPolicy
  test('main changes .gstack/generated.json after the fork: accept keeps the base policy', () => {
    const f = fx(policy(ADDS));
    for (const step of [['checkout', '-q', 'main'], ['pull', '-q', 'origin', 'main']]) expect(f.git(...step).status).toBe(0);
    fs.mkdirSync(path.join(f.work, '.gstack'), { recursive: true });
    fs.writeFileSync(path.join(f.work, '.gstack/generated.json'), JSON.stringify({ $schema: 'https://github.com/garrytan/gstack/docs/pregate.md#generated-v1', entries: [] }, null, 2) + '\n');
    for (const step of [['add', '-A'], ['commit', '-qm', 'main: generated registry'], ['push', '-q', 'origin', 'main'], ['checkout', '-q', 'feat'], ['fetch', '-q', 'origin']]) expect(f.git(...step).status).toBe(0);
    const out = accept(f);
    expect(lineOf(out.stdout, 'POLICY'), out.stdout).toBe("POLICY: base origin/main:.gstack/pregate.json (the branch's copy comes with a changed .gstack/generated.json, so it does not count here; land it on main first)");
  });

  // Value: protects=the trust boundary: a head policy that drops, shrinks or loosens anything stays unread, and accept refuses as before;
  //   fails_when=accept runs a branch's looser policy; seam=lib/pregate/head-policy.ts lanesOnlyHeadPolicy
  test.each([
    ['removes a lane', policy({ ...ADDS, 'src/a.ts': [] }), 'dependencies["src/a.ts"] drops test/a.test.ts'],
    ['loosens a check', policy(ADDS, { warn: ['lanes'] }), 'also changes warn'],
    ['adds a lane and changes the timeout', policy(ADDS, { timeout_s: 30 }), 'also changes timeout_s'],
    ['adds a lane and changes the carry map', JSON.stringify({ ...JSON.parse(policy(ADDS)), ship_lanes_from: {} }), 'also changes ship_lanes_from'],
  ])('a head policy that %s keeps the base policy, and accept refuses', (_what, head, why) => {
    const f = fx(head);
    const out = accept(f);
    expect(lineOf(out.stdout, 'POLICY')).toBe(`POLICY: base origin/main:.gstack/pregate.json (the branch's copy ${why}, so it does not count here; land it on main first)`);
    expect([out.status, lineOf(out.stdout, 'STOP'), lanesCheck(f).code]).toEqual([3, 'STOP: pregate fail on the final tree: fix it, then rerun accept', 'PREGATE_NO_LANE']);
  });
});
