/**
 * W10 (field list 2): #3190's requires-remote path on a gbrain-shaped repo.
 * The base branch declares gbrain's dependencies and a remote_gate that is a
 * package script (`bun run ci:ubicloud`); the gate stub behaves like gbrain's
 * scripts/ci-ubicloud.ts: it needs UBICLOUD_API_KEY, names its VMs from
 * UBI_OWNER, runs the whole corpus and prints the PREGATE_REMOTE line. Under 8
 * cores the test tier becomes an obligation naming that command; --remote
 * runs it with the caller's UBI_OWNER and key and clears the obligation only
 * on its report.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { buildContext } from '../lib/pregate/context';
import { runPregate } from '../lib/pregate/index';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const CI_UBICLOUD = [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "if (!process.env.UBICLOUD_API_KEY && !process.env.UBICLOUD_API_TOKEN) { console.error('ci-ubicloud: UBICLOUD_API_KEY is not set'); process.exit(2); }",
  "const owner = process.env.UBI_OWNER || 'capy-machine-7f3a';",
  "const files = readFileSync(process.env.PREGATE_FILES_FILE!, 'utf8').split('\\n').filter(Boolean);",
  "console.log('[ci-ubicloud] vm ubirun-' + owner + '-1760650000-ci01a7 up; 10 VMs, 3834 items');",
  "writeFileSync('../ubi-gate.json', JSON.stringify({ owner, tree: process.env.PREGATE_TREE, cap: process.env.PREGATE_SPEND_CAP_USD, files }));",
  "console.log('[ci-ubicloud] unit 3157, serial 387, e2e 250, slow 40: 0 failed; VMs destroyed');",
  "console.log('PREGATE_REMOTE: tree=' + process.env.PREGATE_TREE + ' tests=3834 failed=0 spent=1.42');",
].join('\n') + '\n';

const GBRAIN_PREGATE = {
  dependencies: { 'test/**/*.serial.test.ts': ['test/scripts/serial-files.test.ts'], 'scripts/serial-files.tsv': ['test/scripts/serial-files.test.ts'], 'docs/**': [], 'README.md': [] },
  remote_gate: 'bun run ci:ubicloud',
};

function gbrainShaped(): FixtureRepo {
  const repo = makeFixtureRepo({ pregate: GBRAIN_PREGATE });
  repos.push(repo);
  repo.git('checkout', '-q', 'main');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo.work, 'package.json'), 'utf8'));
  pkg.scripts['ci:ubicloud'] = 'bun run scripts/ci-ubicloud.ts';
  commit(repo, { 'scripts/ci-ubicloud.ts': CI_UBICLOUD, 'package.json': JSON.stringify(pkg, null, 2) + '\n', '.github/workflows/windows.yml': null, 'scripts/windows-list.js': null }, 'ci:ubicloud; Linux-only lanes like gbrain test.yml');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('merge', '-q', '--ff-only', 'main');
  commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' });
  return repo;
}

const gate = (repo: FixtureRepo) => path.join(repo.root, 'ubi-gate.json');
const pregateFile = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));

describe('requires-remote on a gbrain-shaped repo (ci:ubicloud, UBI_OWNER)', () => {
  test('under 8 cores the test tier is an obligation naming bun run ci:ubicloud, and nothing runs', async () => {
    const repo = gbrainShaped();
    const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 4, testBackend: 'local' });
    if (!('ctx' in loaded)) throw new Error('fixture context refused');
    const file = await runPregate(loaded.ctx, { stage: 'tests' });
    const lanes = file.checks.find(c => c.id === 'lanes')!;
    expect(lanes.status).toBe('requires-remote');
    expect(file.requires_remote).toEqual([expect.objectContaining({ lane: 'pregate.json/remote_gate', command: 'bun run ci:ubicloud', tests: ['test/util.test.js'], receipt: null })]);
    expect(lanes.lines).toContain('run: bun run ci:ubicloud');
    expect(fs.existsSync(gate(repo))).toBe(false);
  });

  test('--remote runs the package script with the caller\'s UBI_OWNER and key, and its report clears the obligation', () => {
    const repo = gbrainShaped();
    expect(runBin(repo, 'gstack-pregate', ['--base', 'main', '--stage', 'preflight', '--allow-repo-commands']).status).toBe(EXIT.ok);
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--stage', 'tests', '--remote', '--allow-repo-commands', '--spend-cap', '5'], { UBI_OWNER: 'gbra49q2', UBICLOUD_API_KEY: 'fixture-not-a-key' });
    expect(r.status).toBe(EXIT.ok);
    const file = pregateFile(repo);
    expect(file.verdict).toBe('requires-remote cleared');
    expect(file.requires_remote[0]).toMatchObject({ lane: 'pregate.json/remote_gate', receipt: 'remote-gate tree=' + file.tree.slice(0, 12) + ' tests=3834' });
    expect(JSON.parse(fs.readFileSync(gate(repo), 'utf8'))).toEqual({ owner: 'gbra49q2', tree: file.tree, cap: '5', files: ['test/util.test.js'] });
    expect(r.err).toContain('PREGATE_REMOTE_SPEND: spent $1.42, reserved $0, unknown $0 (cap $5)');
    expect(runBin(repo, 'gstack-pregate', ['verify']).status).toBe(EXIT.ok);
  });

  test('without the Ubicloud key the gate exits before reporting: incomplete, obligation uncleared, the gate\'s own error shown', () => {
    const repo = gbrainShaped();
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--stage', 'tests', '--remote', '--allow-repo-commands', '--spend-cap', '5'], { UBI_OWNER: 'gbra49q2', UBICLOUD_API_KEY: '', UBICLOUD_API_TOKEN: '' });
    expect(r.status).not.toBe(EXIT.ok);
    const file = pregateFile(repo);
    expect(file.requires_remote[0].receipt).toBeNull();
    const lanes = file.checks.find((c: any) => c.id === 'lanes');
    expect(lanes.status).toBe('incomplete');
    expect(lanes.detail).toContain('the remote gate exited 2 without a PREGATE_REMOTE: line');
    expect(r.out).toContain('ci-ubicloud: UBICLOUD_API_KEY is not set');
  });
});
