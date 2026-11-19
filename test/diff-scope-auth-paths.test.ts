import { afterEach, expect, test } from 'bun:test';
import * as path from 'node:path';
import { runScriptSync } from '../lib/script-invocation';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

// Value: protects=the auth substring prefilter preserves the actual CLI's case-insensitive routing and authorship exceptions;
//   fails_when=fast rejection drops uppercase/glued auth paths or marks results/authorship prose as authentication
for (const [file, auth] of [
  [`results/${'harness-eval-run-receipts-'.repeat(6)}/run.json`, false],
  ['docs/AUTHORS.md', false], ['src/coauthors.ts', false],
  ['src/HTTPAuthorization.ts', true], ['config/AUTH_KEYS.md', true], ['src/noauthrequired.ts', true],
] as const) {
  test(`auth scope for ${file}`, () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    repo.git('config', 'core.longpaths', 'true');
    const head = commit(repo, { [file]: '# fixture\n' });
    const result = runScriptSync(path.resolve(import.meta.dir, '../bin/gstack-diff-scope'), ['main', '--head', head],
      { cwd: repo.work, env: { ...process.env, ...repo.env }, encoding: 'utf8', timeout: 10_000 });
    expect(result.stdout).toContain(`SCOPE_AUTH=${auth}\n`);
  }, 15_000);
}
