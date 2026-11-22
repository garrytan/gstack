/**
 * GST-3067 (GBRA-108, gbrain#9679): a PR whose head merged a release commit differs from the tree the remote gate
 * tested in the version files and in a generated file the release regenerated. That file is a declared
 * release_outputs path, but `gstack-pregate clear --receipt` refused it through the stamp_files allowlist before the
 * release-output rule ran, and never reran release_tool the way the tree receipt does (GST-1176). With
 * --allow-repo-commands a release output that release_tool regenerates byte for byte at the head is a stamp; a row the
 * PR wrote by hand, a path outside release_outputs, and the same merge without the flag are still refused.
 * Synthetic repo only: the release tool renders one row per released CHANGELOG heading.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { buildContext } from '../lib/pregate/context';
import { runPregate } from '../lib/pregate/index';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, readFile, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const LANE = 'pregate.json/remote_gate';
const PREGATE_FILE = '.gstack/tmp/pregate.json';
const OUTPUT = 'src/rows.generated.ts';
const POLICY = {
  bump: 'patch', queue_mode: 'stamp-at-merge', changelog: 'CHANGELOG.md',
  stamp_files: ['VERSION', 'package.json', 'CHANGELOG.md'],
  release_tool: 'node scripts/build-rows.js', release_outputs: [OUTPUT],
};
const BUILD_ROWS = [
  "const fs = require('fs');",
  'const rows = [];',
  'let v = null;',
  "for (const l of fs.readFileSync('CHANGELOG.md', 'utf8').split('\\n')) {",
  '  const h = /^## \\[(\\d[^\\]]*)\\]/.exec(l);',
  '  if (h) { v = h[1]; continue; }',
  "  if (l.startsWith('## ')) { v = null; continue; }",
  "  if (v && l.startsWith('- ')) rows.push(\"  { version: '\" + v + \"', change: '\" + l.slice(2) + \"' },\");",
  '}',
  "fs.writeFileSync('src/rows.generated.ts', 'export const ROWS = [\\n' + rows.map(r => r + '\\n').join('') + '];\\n');",
  '',
].join('\n');
const CHANGELOG_BASE = '# Changelog\n\n## [Unreleased]\n\n- add rows\n\n## [1.0.0] - 2026-11-01\n\n- first\n';
const CHANGELOG_RELEASED = '# Changelog\n\n## [1.0.1] - 2026-11-18\n\n- add rows\n\n## [1.0.0] - 2026-11-01\n\n- first\n';
const ROWS_BASE = "export const ROWS = [\n  { version: '1.0.0', change: 'first' },\n];\n";
const ROWS_RELEASED = "export const ROWS = [\n  { version: '1.0.1', change: 'add rows' },\n  { version: '1.0.0', change: 'first' },\n];\n";

/** The PR's real change is the gated head; main then takes a release commit, and the PR merges it. */
function releaseMergeRepo(): { repo: FixtureRepo; gatedTree: string } {
  const repo = makeFixtureRepo({
    prefix: 'gstack-pregate-release-output-',
    pregate: { ...BASE_PREGATE, remote_gate: 'node scripts/remote-gate.js', dependencies: { ...BASE_PREGATE.dependencies, 'CHANGELOG.md': [], VERSION: [], [OUTPUT]: [], 'scripts/**': [] } },
    baseFiles: {
      '.gstack/ship-policy.json': JSON.stringify(POLICY, null, 2) + '\n', VERSION: '1.0.0\n', 'CHANGELOG.md': CHANGELOG_BASE,
      'scripts/build-rows.js': BUILD_ROWS, [OUTPUT]: ROWS_BASE,
      'scripts/remote-gate.js': "console.log('PREGATE_REMOTE: tree=' + process.env.PREGATE_TREE + ' tests=3 failed=0');\n",
    },
  });
  repos.push(repo);
  const gated = commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'the real change (gated)');
  repo.git('checkout', '-q', 'main');
  const pkg = JSON.parse(readFile(repo, 'package.json'));
  pkg.version = '1.0.1';
  commit(repo, { VERSION: '1.0.1\n', 'package.json': JSON.stringify(pkg, null, 2) + '\n', 'CHANGELOG.md': CHANGELOG_RELEASED, [OUTPUT]: ROWS_RELEASED }, 'release 1.0.1');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('merge', '-q', '--no-edit', 'origin/main');
  return { repo, gatedTree: repo.git('rev-parse', gated + '^{tree}') };
}

async function pregateAt(repo: FixtureRepo, stage: 'tests' | 'all' = 'tests') {
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 4, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  const file = await runPregate(loaded.ctx, { stage });
  expect(file.requires_remote).toEqual([expect.objectContaining({ lane: LANE, receipt: null })]);
  fs.mkdirSync(path.join(repo.work, '.gstack/tmp'), { recursive: true });
  fs.writeFileSync(path.join(repo.work, PREGATE_FILE), JSON.stringify(file));
  return file;
}

const receiptFile = (repo: FixtureRepo, tree: string) => { const f = path.join(repo.root, 'gate.log'); fs.writeFileSync(f, 'gate log\nPREGATE_REMOTE: tree=' + tree + ' tests=3 failed=0\n'); return f; };
const clear = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, ...args]);
const pregateJson = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, PREGATE_FILE), 'utf8'));

describe.skipIf(process.platform === 'win32')('clear --receipt over a merged release commit that regenerated a declared release output (GST-3067)', () => {
  test('with --allow-repo-commands the regenerated release output is a stamp and the receipt clears', async () => {
    const { repo, gatedTree } = releaseMergeRepo();
    const file = await pregateAt(repo, 'all');
    const r = clear(repo, ['--receipt', receiptFile(repo, gatedTree), '--allow-repo-commands']);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('PREGATE_RECEIPT_SUBSTITUTED: gated tree ' + gatedTree.slice(0, 12) + ' accepted for tree ' + file.tree.slice(0, 12));
    expect(r.out).toContain(OUTPUT + ' (release_tool)');
    expect(pregateJson(repo).requires_remote[0].substitution.files).toContainEqual({ path: OUTPUT, rule: 'release_tool' });
    const verify = runBin(repo, 'gstack-pregate', ['verify']);
    expect(verify.err).toBe('');
    expect(verify.status).toBe(EXIT.ok);
    expect(verify.out).toContain(OUTPUT + ' (release_tool)');
  }, 120_000);

  test('without --allow-repo-commands the same merge is refused, and the refusal names the flag', async () => {
    const { repo, gatedTree } = releaseMergeRepo();
    await pregateAt(repo);
    const r = clear(repo, ['--receipt', receiptFile(repo, gatedTree)]);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain(OUTPUT + ' (release_outputs: ');
    expect(r.err).toContain('--allow-repo-commands');
    expect(pregateJson(repo).requires_remote[0].receipt).toBeNull();
  }, 120_000);

  test('a row the PR added to the generated file by hand, which release_tool does not write, is refused', async () => {
    const { repo, gatedTree } = releaseMergeRepo();
    commit(repo, { [OUTPUT]: ROWS_RELEASED.replace('];', "  { version: '1.0.1', change: 'hand-written' },\n];") }, 'a hand-added row');
    await pregateAt(repo);
    const r = clear(repo, ['--receipt', receiptFile(repo, gatedTree), '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain(OUTPUT + ' (release_outputs: ');
    expect(r.err).toContain('not what release_tool generates at 1.0.1');
    expect(pregateJson(repo).requires_remote[0].receipt).toBeNull();
  }, 120_000);

  test('a path outside release_outputs is still refused by the stamp_files allowlist', async () => {
    const { repo, gatedTree } = releaseMergeRepo();
    commit(repo, { 'lib/retry.js': 'exports.MAX_RETRIES = 4;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\n' }, 'a real edit after the gate');
    await pregateAt(repo);
    const r = clear(repo, ['--receipt', receiptFile(repo, gatedTree), '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain("lib/retry.js (stamp_files: not in the repo's stamp_files allowlist, line 1)");
    expect(r.err).not.toContain(OUTPUT + ' (');
    expect(pregateJson(repo).requires_remote[0].receipt).toBeNull();
  }, 120_000);
});
