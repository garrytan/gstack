/**
 * GST-1334 (gbrain #8481): a big diff whose touched files each reach many tests gives the lanes check one provenance row
 * per (touched file, test) pair. The check used to append them with `ctx.explain.push(...sel.provenance)`, and past the
 * engine's argument limit that throws RangeError, so PREGATE reported `lanes: threw: Maximum call stack size exceeded`
 * before any lane ran. The fixture declares every test as a dependency of every touched file: SEEDS x TESTS rows.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { buildContext } from '../lib/pregate/context';
import { runPregate } from '../lib/pregate/index';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const SEEDS = 1000;
const TESTS = 1000;
const pad = (i: number) => String(i).padStart(4, '0');

describe.skipIf(process.platform === 'win32')('lanes check on a selection with a million provenance rows', () => {
  // Value: protects=a large diff still gets a lanes verdict instead of PREGATE incomplete; fails_when=the provenance rows go
  //   into ctx.explain through one spread call (RangeError past Bun's argument limit, about 600k on 1.4.4);
  //   why_new=GST-1334, gbrain #8481 (335 touched files) on gstack 1.95.5; seam=runPregate --only lanes on a fixture repo, no tests run
  test('every provenance row reaches explain and the check reports its selection', async () => {
    const tests = Array.from({ length: TESTS }, (_, i) => `test/big/t${pad(i)}.test.js`);
    const repo = makeFixtureRepo({
      pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'src/big/**': tests } },
      baseFiles: Object.fromEntries([...tests.map(t => [t, "require('node:test');\n"]), ['src/big/.keep', '']]),
    });
    repos.push(repo);
    commit(repo, Object.fromEntries(Array.from({ length: SEEDS }, (_, i) => [`src/big/f${pad(i)}.js`, `exports.n = ${i};\n`])), 'touch many files');
    const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: false, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 64, testBackend: 'local' });
    if (!('ctx' in loaded)) throw new Error('fixture context refused');
    const file = await runPregate(loaded.ctx, { stage: 'tests', only: ['lanes'] });
    const lanes = file.checks.find(c => c.id === 'lanes')!;
    expect(lanes.detail).not.toContain('threw');
    expect(lanes).toMatchObject({ status: 'incomplete', code: 'REPO_COMMANDS_NOT_ALLOWED', detail: `${TESTS} local test file(s) selected but not run (pass --allow-repo-commands)` });
    expect(loaded.ctx.explain.filter(l => l.endsWith('[touched]')).length).toBe(SEEDS * TESTS);
  }, 300_000);
});
