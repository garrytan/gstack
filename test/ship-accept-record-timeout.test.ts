/**
 * GST-1606: gstack-ship-release accept bounds each `gstack-evidence record-ci` by the base ship policy's
 * `ci_record_timeout_s` (600 s by default, 3600 s at most) and prints the value it used, and it says when the final
 * pregate's tests stage got no CI carry and ran here. harness-evals #271: its CI takes about 745 s, so record-ci hit the
 * hard 600 s cap, and the final pregate ran 3,666 tests locally with no line saying why.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CI_RECORD_TIMEOUT_KEY_VERSION, validatePolicy } from '../lib/ship-policy';
import { fakeGhScript, type FakeWorld } from './helpers/fake-gh-runs';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const FREE = "printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [1.00ms]\\n' >&2";
const HOST_OS = ({ darwin: 'macOS', win32: 'Windows' } as Record<string, string>)[process.platform] ?? 'Linux';
const RUNNER = ({ darwin: 'macos-latest', win32: 'windows-latest' } as Record<string, string>)[process.platform] ?? 'ubuntu-latest';
const PROFILE = { workflow: 'free.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['suite'], artifact: 'tested-tree', os: HOST_OS };
const TESTS = ['test/a.test.ts'];
const pregate = (profile: Record<string, unknown>) => JSON.stringify({
  run_profiles: { 'ci/free': profile }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: `printf '${TESTS.join('\\n')}\\n'` } }, dependencies: { 'src/a.ts': ['test/a.test.ts'], 'src/b.ts': ['test/a.test.ts'], 'test/**': [], '.gstack/ship-policy.json': [] },
}, null, 2) + '\n';
const ship = (timeout: number) => JSON.stringify({ ci_record_timeout_s: timeout, min_gstack_version: CI_RECORD_TIMEOUT_KEY_VERSION }, null, 2) + '\n';
const BASE = {
  '.gstack/pregate.json': pregate(PROFILE),
  '.github/workflows/free.yml': `name: Free\non: [pull_request, workflow_dispatch]\njobs:\n  suite:\n    runs-on: ${RUNNER}\n    steps:\n      - run: bun test\n`,
  'test/a.test.ts': "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n",
};

function fx(base: Record<string, string>, head: Record<string, string> = {}): ShipFx {
  const f = shipFixture({ ...BASE, ...base }, { 'src/b.ts': 'export const b = 2;\n', ...head });
  fixtures.push(f);
  const sha = f.git('rev-parse', 'HEAD').stdout.trim();
  const tree = f.git('rev-parse', 'HEAD^{tree}').stdout.trim();
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const run = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: sha, path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
  const w: FakeWorld = { runs: [run] as FakeWorld['runs'], jobs: { 7: [{ name: 'suite', conclusion: 'success', completed_at: at(5) }] }, trees: { 7: { run_id: 7, run_attempt: 1, event: 'workflow_dispatch', sha, tree, files: TESTS, tests: 1, os: HOST_OS } } };
  fs.writeFileSync(path.join(f.root, 'world.json'), JSON.stringify(w));
  f.gh(fakeGhScript(path.join(f.root, 'world.json')));
  expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], { GSTACK_SESSION_KIND: 'unattended' }).status).toBe(0);
  return f;
}
const accept = (f: ShipFx) => f.run(RELEASE, ['accept', '--base', 'main', '--lane', `free=${FREE}`, '--wait', '0']);

describe('accept: record-ci timeout from the base ship policy (GST-1606)', () => {
  // Value: protects=a repo whose record-ci runs past 600 s (harness-evals #271, CI about 745 s) raises the bound on its base branch and
  //   accept uses it; fails_when=accept keeps the hard 600_000 ms cap or does not say which bound it used; seam=bin/gstack-ship-release accept
  test('the base sets ci_record_timeout_s: accept uses it and says so', () => {
    const out = accept(fx({ '.gstack/ship-policy.json': ship(900) }));
    expect([out.status, lineOf(out.stdout, 'CI_RECORD_TIMEOUT')], out.stdout).toEqual([0, 'CI_RECORD_TIMEOUT: 900s (origin/main ci_record_timeout_s)']);
  });

  // Value: protects=one policy line cannot hold accept for hours: the bound stops at 3600 s; fails_when=accept passes 7200 s through;
  //   seam=recordCiTimeout
  test('a value over the 3600 s ceiling is clamped to it', () => {
    const out = accept(fx({ '.gstack/ship-policy.json': ship(7200) }));
    expect([out.status, lineOf(out.stdout, 'CI_RECORD_TIMEOUT')], out.stdout).toEqual([0, 'CI_RECORD_TIMEOUT: 3600s (origin/main ci_record_timeout_s 7200 is over the 3600s ceiling)']);
  });

  // Value: protects=the trust boundary: a branch cannot raise its own gate's bound; fails_when=accept reads the head's ship policy;
  //   seam=shipPolicy (gstack-ship-policy show-effective --base)
  test('a value only the branch sets is ignored: accept keeps the 600 s default', () => {
    const out = accept(fx({}, { '.gstack/ship-policy.json': ship(900) }));
    expect([out.status, lineOf(out.stdout, 'CI_RECORD_TIMEOUT')], out.stdout).toEqual([0, 'CI_RECORD_TIMEOUT: 600s (default)']);
  });

  // Value: protects=a malformed bound fails validation by name instead of silently falling back; fails_when=validatePolicy accepts a
  //   string, a fraction or a value under 60, or the key without min_gstack_version; seam=lib/ship-policy.ts validatePolicy
  test('validation: an integer of at least 60 seconds, behind min_gstack_version', () => {
    const codes = (raw: Record<string, unknown>) => validatePolicy(raw).map(e => `${e.code}:${e.path}`);
    const at = (v: unknown) => codes({ ci_record_timeout_s: v, min_gstack_version: CI_RECORD_TIMEOUT_KEY_VERSION });
    expect([at(60), at(7200)]).toEqual([[], []]);
    for (const bad of ['900', 59, 600.5, null]) expect(at(bad), String(bad)).toEqual(['POLICY_INVALID:ci_record_timeout_s']);
    expect(codes({ ci_record_timeout_s: 900 })).toEqual(['POLICY_INVALID:ci_record_timeout_s']);
  });
});

describe('accept: the final pregate says when its tests stage ran without a CI carry (GST-1606)', () => {
  // Value: protects=the operator sees why accept's final pregate ran the selected tests here (harness-evals #271 ran 3,666 with no
  //   reason given); fails_when=accept relays only the bare CI_CARRY none line or nothing; seam=bin/gstack-ship-release accept
  test('a run profile without os carries the lane but not the tests stage: one line says why the tests ran here', () => {
    const { os: _os, ...noOs } = PROFILE;
    const out = accept(fx({ '.gstack/pregate.json': pregate(noOs) }));
    expect([out.status, lineOf(out.stdout, 'CI_CARRY')], out.stdout).toEqual([0, expect.stringMatching(/^CI_CARRY: none \(no_profile: [^)]*\); the final pregate's tests stage ran here instead: tests pass in \d+(\.\d+)?s \(docs\/pregate\.md#accept-local-tests\)$/)]);
  });

  // Value: protects=a carried tests stage keeps its plain CI_CARRY line; fails_when=the local-run note is added to an accepted carry;
  //   seam=bin/gstack-ship-release accept
  test('a profile for this OS carries the tests stage: the accepted line stands alone', () => {
    const out = accept(fx({}));
    expect([out.status, lineOf(out.stdout, 'CI_CARRY')], out.stdout).toEqual([0, expect.stringMatching(/^CI_CARRY: accepted /)]);
  });
});
