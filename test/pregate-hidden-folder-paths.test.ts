/**
 * GST-2640 (gbrain #3965): the lanes check ran `bun test {files}` with bare repo-relative paths. Bun 1.4.4 reads a bare
 * path as a name filter whose search skips hidden folders, so a selected test under .github/scripts/ ran nothing, Bun
 * exited 1 and the lane failed with PREGATE_LANE_FAILED on a green test. The fixture repo has its test under
 * .github/scripts/; the failing control proves the lane still judges that test instead of passing it unrun.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildContext } from '../lib/pregate/context';
import { runPregate } from '../lib/pregate/index';
import { explicitPath, testFileArgs } from '../lib/test-paths';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const TEST = '.github/scripts/select.test.mjs';
const GREEN = "import { expect, test } from 'bun:test';\nimport { pick } from './select.mjs';\ntest('picks the first lane', () => expect(pick(['a', 'b'])).toBe('a'));\n";
const RED = "import { expect, test } from 'bun:test';\nimport { pick } from './select.mjs';\ntest('picks the last lane', () => expect(pick(['a', 'b'])).toBe('b'));\n";
const DETECTED = { $schema: 'https://github.com/garrytan/gstack/docs/pregate.md#pregate-v1', dependencies: { '.github/scripts/**': [TEST], 'docs/**': [], 'README.md': [] } };
const DECLARED = { ...DETECTED, runner: 'bun test {files}' };

async function lanes(policy: Record<string, unknown>, files: Record<string, string>, unlink: string[] = []) {
  const repo = makeFixtureRepo({ pregate: policy, baseFiles: { 'bun.lock': '' } });
  repos.push(repo);
  commit(repo, { '.github/scripts/select.mjs': 'export const pick = (lanes) => lanes[0];\n', ...files }, 'add the lane selector');
  for (const rel of unlink) fs.rmSync(path.join(repo.work, rel));
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 64, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  const file = await runPregate(loaded.ctx, { stage: 'tests', only: ['lanes'] });
  return file.checks.find(c => c.id === 'lanes')!;
}

describe('explicit test paths for bun test', () => {
  // Value: protects=every relative test path reaches bun test as a path; fails_when=a bare path (Bun's name filter) or a doubled ./ is passed;
  //   why_new=GST-2640; seam=the pure helper the lanes, remote-gate, docs-only, base-red and CI-carry commands share
  test('adds ./ to a bare relative path, keeps explicit ones, and leaves other runners alone', () => {
    expect(['.github/scripts/x.test.mjs', 'test/a.test.ts', './b.test.ts', '../c.test.ts', '/abs/d.test.ts'].map(explicitPath))
      .toEqual(['./.github/scripts/x.test.mjs', './test/a.test.ts', './b.test.ts', '../c.test.ts', '/abs/d.test.ts']);
    expect(testFileArgs('bun test --timeout=30000 {files}', ['.github/x.test.ts'])).toEqual(['./.github/x.test.ts']);
    expect(testFileArgs('npx vitest run {files}', ['.github/x.test.ts'])).toEqual(['.github/x.test.ts']);
  });
});

describe.skipIf(process.platform === 'win32')('lanes check on a test under a hidden folder', () => {
  // Value: protects=a green test under .github/ passes the lane, with the runner detected from bun.lock or declared;
  //   fails_when=bun test gets the bare path, runs nothing and exits 1 (PREGATE_LANE_FAILED);
  //   why_new=GST-2640, gbrain #3965 blocked /ship on bun 1.4.4; seam=runPregate --only lanes on a fixture repo that runs bun test
  for (const [name, policy] of [['detected', DETECTED], ['declared', DECLARED]] as const) {
    test(`a green hidden-folder test passes the lane (${name} runner)`, async () => {
      const result = await lanes(policy, { [TEST]: GREEN });
      expect(result.lines).toContainEqual(expect.stringContaining("bun test './.github/scripts/select.test.mjs'"));
      // The fixture's windows.yml claims every test, so the green local lane leaves a windows obligation instead of a bare pass.
      expect(result).toMatchObject({ status: 'requires-remote', detail: '1 tests ran in 1 file(s), exit 0; 1 requires-remote obligation(s)' });
    }, 120_000);
  }

  // Value: protects=the lane still runs and judges a hidden-folder test; fails_when=the fix passes the lane without running the test
  test('a failing hidden-folder test still fails the lane', async () => {
    const result = await lanes(DETECTED, { [TEST]: RED });
    expect(result).toMatchObject({ status: 'fail', code: 'PREGATE_LANE_FAILED', detail: expect.stringContaining('1 failed of 1 ran') });
  }, 120_000);

  // Value: protects=AGENTS.md's rule that a missing test file never reaches Bun, which drops a missing ./ path beside a present one
  //   without an error; fails_when=selection hands bun test a path the working tree no longer has
  test('a declared test file missing from the working tree is never passed to bun test', async () => {
    const gone = '.github/scripts/gone.test.mjs';
    const result = await lanes({ ...DETECTED, dependencies: { ...DETECTED.dependencies, '.github/scripts/**': [TEST, gone] } }, { [TEST]: GREEN, [gone]: GREEN }, [gone]);
    expect(result.lines).toContain("ran: bun test './.github/scripts/select.test.mjs'");
    expect(result.lines?.join('\n')).not.toContain('gone.test.mjs');
  }, 120_000);
});
