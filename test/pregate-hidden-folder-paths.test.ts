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
import { runAt } from '../lib/base-red';
import { perFileCommand } from '../lib/ci-carry';
import { execFileSync } from 'node:child_process';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const TEST = '.github/scripts/select.test.mjs';
const GREEN = "import { expect, test } from 'bun:test';\nimport { pick } from './select.mjs';\ntest('picks the first lane', () => expect(pick(['a', 'b'])).toBe('a'));\n";
const RED = "import { expect, test } from 'bun:test';\nimport { pick } from './select.mjs';\ntest('picks the last lane', () => expect(pick(['a', 'b'])).toBe('b'));\n";
const DETECTED = { $schema: 'https://github.com/garrytan/gstack/docs/pregate.md#pregate-v1', dependencies: { '.github/scripts/**': [TEST], 'docs/**': [], 'README.md': [] } };
const DECLARED = { ...DETECTED, runner: 'bun test {files}' };

async function lanes(policy: Record<string, unknown>, files: Record<string, string>, unlink: string[] = [], machine: { cores: number; testBackend: string } = { cores: 64, testBackend: 'local' }) {
  const repo = makeFixtureRepo({ pregate: policy, baseFiles: { 'bun.lock': '' } });
  repos.push(repo);
  commit(repo, { '.github/scripts/select.mjs': 'export const pick = (lanes) => lanes[0];\n', ...files }, 'add the lane selector');
  for (const rel of unlink) fs.rmSync(path.join(repo.work, rel));
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, ...machine } as never);
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
    expect(testFileArgs('bun --no-env-file --config=/dev/null test {files}', ['.github/x.test.ts'])).toEqual(['./.github/x.test.ts']);
    expect(testFileArgs('npx vitest run {files}', ['.github/x.test.ts'])).toEqual(['.github/x.test.ts']);
  });

  // Value: protects=perFileCommand single-quotes each path after anchoring it with one ./; fails_when=quoting runs before the prefix, ./ doubles, or an absolute path gains ./;
  //   why_new=no test called perFileCommand after it moved to explicitPath; seam=none; no_claim=bash execution of the command (string only)
  test('perFileCommand anchors and quotes per-file paths', () => {
    expect(perFileCommand('bun test {files}', [".github/it's.test.ts", './a.test.ts', '/abs/b.test.ts']))
      .toBe("bun test './.github/it'\\''s.test.ts' './a.test.ts' '/abs/b.test.ts'");
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

  // Value: protects=the remote-gate command a small machine records carries ./-prefixed bun paths; fails_when=remoteObligation drops testFileArgs and records the bare .github path;
  //   why_new=only the local lane was tested; seam=none (runPregate on a 4-core ubicloud-backend context); no_claim=the remote VM run itself
  test('a small machine records the remote-gate command with ./ paths', async () => {
    const result = await lanes(DETECTED, { [TEST]: GREEN }, [], { cores: 4, testBackend: 'ubicloud' });
    expect(result.status).toBe('requires-remote');
    const run = result.lines?.find(l => l.startsWith('run: ')) ?? '';
    expect(run).toContain('./.github/scripts/select.test.mjs');
    expect(run).not.toMatch(/'\.github\/scripts/);
  }, 120_000);

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

describe.skipIf(process.platform === 'win32')('base-red select anchors bun test paths', () => {
  // Value: protects=runAt hands a bun select ./-prefixed, quoted paths; fails_when=runAt drops testFileArgs and passes the bare .github path;
  //   why_new=no test reached runAt's select string; seam=none (runAt's existing Runner parameter); no_claim=bun execution (recording runner)
  test('runAt passes ./-prefixed paths to a bun select', () => {
    const repo = makeFixtureRepo({ pregate: DETECTED });
    repos.push(repo);
    const prev = process.env.GSTACK_STATE_ROOT;
    process.env.GSTACK_STATE_ROOT = path.join(repo.work, '..', 'state');
    try {
      const seen: string[] = [];
      const sha = execFileSync('git', ['-C', repo.work, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim();
      runAt(repo.work, sha, { select: 'bun test {files}', timeout_sec: 30 } as never, [TEST, 'test/a.test.ts'], (_d, cmd) => { seen.push(cmd); return { status: 0, out: '' }; });
      expect(seen).toEqual(["bun test './.github/scripts/select.test.mjs' './test/a.test.ts'"]);
    } finally {
      if (prev === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prev;
    }
  });
});
