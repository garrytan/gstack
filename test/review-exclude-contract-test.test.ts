/**
 * review_exclude_paths and the repo's own contract test (GST-3512): a test that pins the exclusion's pattern list, or quotes
 * paths it expects the patterns to match, names those paths without reading them, so it does not keep them in review as
 * named-by-code. Code that reads a path, a test that is not about the exclusion, and any unquoted or joined form still keep it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const PATTERNS = ['results/**', 'wiki/b2/sessions.jsonl'];
const CONTRACT = 'tests/ci/review-exclude-policy.test.ts';
const contract = (extra = '') => [
  "import policy from '../../.gstack/ship-policy.json';",
  "const PATTERNS = ['results/**', 'wiki/b2/sessions.jsonl'];",
  "const HITS = [\"results/b2/run.json\", `wiki/b2/sessions.jsonl`];",
  "test('pins the list', () => expect(policy.review_exclude_paths).toEqual(PATTERNS));",
  extra,
].join('\n') + '\n';

function repo(files: Record<string, string>) {
  const r = makeFixtureRepo({ prefix: 'gstack-exclude-contract-', baseFiles: { '.gstack/ship-policy.json': JSON.stringify({ review_exclude_paths: PATTERNS, min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n' } });
  repos.push(r);
  commit(r, { 'results/b2/run.json': '{"pass": 1}\n', 'results/b2/other.json': '{"pass": 2}\n', 'results/b2/third.json': '{"pass": 3}\n', 'wiki/b2/sessions.jsonl': '{"s": 1}\n', ...files });
  const x = JSON.parse(runBin(r, 'gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--json']).out).review_exclude;
  return { kept: x.kept_files as Array<{ path: string; reason: string }>, excluded: x.excluded as number };
}

describe('review_exclude_paths and its contract test', () => {
  // Value: protects=a test that pins review_exclude_paths and quotes the paths it expects to match leaves those files
  //   excluded; fails_when=the contract test's quoted examples keep them as named-by-code, undoing the exclusion;
  //   why_new=GST-3512 (GEVA-569: a B2 results PR stayed at about 4.8 MB because its contract test named sessions.jsonl)
  test('the exclusion\'s own contract test quoting a path keeps nothing', () => {
    expect(repo({ [CONTRACT]: contract() })).toEqual({ kept: [], excluded: 4 });
  }, 120_000);

  // Value: protects=named-by-code still keeps a file that code reads, that a test outside the exclusion's contract names,
  //   or that the contract test names in any form but a quoted array element (a joined path, a './' prefix, a call
  //   argument, an object value); fails_when=the exemption reaches past the contract test's listed examples;
  //   why_new=GST-3512 negative control, /ship review of #4699 (lib/review-exclude.ts:398, test:38)
  test('code, other tests, call arguments and joined paths still keep the files they name', () => {
    const r = repo({
      [CONTRACT]: contract([
        "const local = `${ROOT}/results/b2/other.json`;",
        "const raw = require('fs').readFileSync('results/b2/fourth.json', 'utf8');",
        "const dotted = ['./results/b2/fifth.json'];",
        "const cfg = { file: 'results/b2/sixth.json' };",
      ].join('\n')),
      'results/b2/fourth.json': '{"pass": 4}\n', 'results/b2/fifth.json': '{"pass": 5}\n', 'results/b2/sixth.json': '{"pass": 6}\n',
      'lib/load.js': "module.exports = () => require('fs').readFileSync('wiki/b2/sessions.jsonl', 'utf8');\n",
      'test/reader.test.js': "const fixture = 'results/b2/third.json';\n",
    });
    expect(r.kept.filter(k => k.path !== 'results/b2/run.json')).toEqual([
      { path: 'results/b2/fifth.json', reason: 'named-by-code' },
      { path: 'results/b2/fourth.json', reason: 'named-by-code' },
      { path: 'results/b2/other.json', reason: 'named-by-code' },
      { path: 'results/b2/sixth.json', reason: 'named-by-code' },
      { path: 'results/b2/third.json', reason: 'named-by-code' },
      { path: 'wiki/b2/sessions.jsonl', reason: 'named-by-code' },
    ]);
  }, 120_000);
});
