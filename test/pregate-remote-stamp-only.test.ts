/**
 * GSTA-117 (gbrain's gate-ahead ask): `gstack-pregate clear --remote
 * pregate.json/remote_gate --receipt <file>` accepts a remote gate report
 * whose tree differs from pregate.json's tree only in the repo's declared
 * stamp paths, classified by the tree receipt's own rule
 * (lib/tree-receipt.ts classifyFile under .gstack/ship-policy.json on the
 * base branch), and records the substitution: the gated tree, the tree it
 * was accepted for, the policy, and every differing path with its rule. A
 * non-stamp path, a stamp path with a non-stamp hunk, a gated tree that is
 * not in the object store and an unreadable receipt file still refuse with
 * PREGATE_RECEIPT_INVALID and a fix naming the offending path.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { buildContext } from '../lib/pregate/context';
import { clearDecision, runPregate, verifyPregate } from '../lib/pregate/index';
import { baseBranchOf, substituteStampOnlyTree } from '../lib/pregate/remote-receipt';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, readFile, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const GATE = 'node scripts/remote-gate.js';
const LANE = 'pregate.json/remote_gate';
const PREGATE_FILE = '.gstack/tmp/pregate.json';
const POLICY = {
  bump: 'patch', queue_mode: 'stamp-at-merge', changelog: 'CHANGELOG.md',
  stamp_files: ['VERSION', 'package.json', 'CHANGELOG.md', 'plugin.json', 'README.md'],
  stamp_patterns: ['"version": "{version}"', '<!-- fixture-stamp: {version} -->'],
};
const PLUGIN = (v: string, description = 'Fixture plugin') => `{\n  "name": "fx",\n  "version": "${v}",\n  "description": "${description}"\n}\n`;
const STAMP_FILES = [
  { path: 'CHANGELOG.md', rule: 'changelog-heading' }, { path: 'README.md', rule: 'stamp_files' }, { path: 'VERSION', rule: 'version-file' },
  { path: 'package.json', rule: 'manifest-version' }, { path: 'plugin.json', rule: 'stamp_files' },
];
const ANCHOR = '(PREGATE_RECEIPT_INVALID; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#pregate-receipt-invalid)';

/** A gated repo with a stamp rule on main: the feature branch's real change is committed as the gated head G. */
function gatedRepo(): { repo: FixtureRepo; gated: string; gatedTree: string } {
  const repo = makeFixtureRepo({
    pregate: { ...BASE_PREGATE, remote_gate: GATE, dependencies: { ...BASE_PREGATE.dependencies, 'CHANGELOG.md': [], 'plugin.json': [], VERSION: [] } },
    baseFiles: { '.gstack/ship-policy.json': JSON.stringify(POLICY, null, 2) + '\n', VERSION: '1.0.0\n', 'plugin.json': PLUGIN('1.0.0'), 'README.md': '# fixture\n<!-- fixture-stamp: 1.0.0 -->\n', 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- add\n' },
  });
  repos.push(repo);
  repo.git('checkout', '-q', 'main');
  commit(repo, { 'scripts/remote-gate.js': "console.log('PREGATE_REMOTE: tree=' + process.env.PREGATE_TREE + ' tests=3 failed=0');\n" }, 'remote gate');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('merge', '-q', '--ff-only', 'main');
  const gated = commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'the real change (gated ahead)');
  return { repo, gated, gatedTree: repo.git('rev-parse', `${gated}^{tree}`) };
}

/** /ship's restamp on top of the gated head: every stamp file moves 1.0.0 -> 1.0.1 and nothing else. */
function stamp(repo: FixtureRepo): string {
  const pkg = JSON.parse(readFile(repo, 'package.json'));
  pkg.version = '1.0.1';
  return commit(repo, {
    VERSION: '1.0.1\n', 'package.json': JSON.stringify(pkg, null, 2) + '\n', 'plugin.json': PLUGIN('1.0.1'),
    'README.md': '# fixture\n<!-- fixture-stamp: 1.0.1 -->\n', 'CHANGELOG.md': '# Changelog\n\n## [1.0.1] - 2026-10-26\n\n- add\n',
  }, 'v1.0.1 stamp');
}

/** pregate.json for the current head on a 4-core machine: the test tier is the remote_gate obligation, uncleared. */
async function pregateAt(repo: FixtureRepo) {
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 4, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  const file = await runPregate(loaded.ctx, { stage: 'tests' });
  expect(file.requires_remote).toEqual([expect.objectContaining({ lane: LANE, receipt: null })]);
  fs.mkdirSync(path.join(repo.work, '.gstack/tmp'), { recursive: true });
  fs.writeFileSync(path.join(repo.work, PREGATE_FILE), JSON.stringify(file));
  return file;
}

const receiptFile = (repo: FixtureRepo, tree: string, tests = 3, failed = 0) => { const f = path.join(repo.root, `gate-${Math.random().toString(36).slice(2)}.log`); fs.writeFileSync(f, `gate log\nPREGATE_REMOTE: tree=${tree} tests=${tests} failed=${failed}\n`); return f; };
const clear = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, ...args]);
const pregateJson = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, PREGATE_FILE), 'utf8'));
const policyLabel = (repo: FixtureRepo) => `origin/main@${repo.git('rev-parse', 'origin/main').slice(0, 12)}:.gstack/ship-policy.json`;
const describeStamps = STAMP_FILES.map(f => `${f.path} (${f.rule})`).join(', ');

// Like test/pregate-remote.test.ts, this expects the Linux-host lanes verdict: on windows-latest the fixture's Linux lane is a
// requires-remote obligation too, so the single-obligation assertions and `verify` ok do not hold there. The curation list in
// scripts/lib/windows-curation.ts is the usual home for that; this file skips itself so the shared list is not edited here.
describe.skipIf(process.platform === 'win32')('clear --receipt accepts a stamp-only predecessor tree (gate ahead of the stamp)', () => {
  test('a receipt for the gated tree clears the stamped head; the substitution names the trees, the policy and every file with its rule, and verify passes', async () => {
    const { repo, gated, gatedTree } = gatedRepo();
    const head = stamp(repo);
    const file = await pregateAt(repo);
    expect(file.tree).toBe(repo.git('rev-parse', `${head}^{tree}`));
    expect(file.tree).not.toBe(gatedTree);
    const r = clear(repo, ['--receipt', receiptFile(repo, gatedTree)]);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain(`PREGATE_RECEIPT_SUBSTITUTED: gated tree ${gatedTree.slice(0, 12)} accepted for tree ${file.tree.slice(0, 12)} under ${policyLabel(repo)}; stamp-only: ${describeStamps}`);
    expect(r.out).toMatch(new RegExp(`^PREGATE_CLEARED: pregate\\.json/remote_gate receipt=remote-gate tree=${gatedTree.slice(0, 12)} tests=3 accepted-for=${file.tree.slice(0, 12)} stamp-only=5 receipt=\\S+ sha256=[0-9a-f]{12} verdict=requires-remote cleared$`, 'm'));
    const stored = pregateJson(repo).requires_remote[0];
    expect(stored.receipt).toMatch(/^remote-gate tree=/);
    expect(stored.cleared_by).toMatch(/^gstack-pregate clear /);
    expect(stored.substitution).toEqual({ gated_tree: gatedTree, accepted_for: file.tree, policy: policyLabel(repo), files: STAMP_FILES });
    // The same rule the tree receipt applies to the same pair: identical files and verdicts.
    const receipt = JSON.parse(runBin(repo, 'gstack-tree-receipt', ['--gated', gated, '--current', head, '--base', 'main', '--json']).out);
    expect(receipt.tree).toBe('same-modulo-stamps');
    expect(receipt.files.map((f: any) => ({ path: f.path, rule: f.rule }))).toEqual(STAMP_FILES);
    const verify = runBin(repo, 'gstack-pregate', ['verify']);
    expect(verify.status).toBe(EXIT.ok);
    expect(verify.out).toContain(`PREGATE_VERIFY: ok pregate requires-remote cleared is current for tree ${file.tree.slice(0, 12)}; pregate.json/remote_gate: gated tree ${gatedTree.slice(0, 12)} accepted for tree ${file.tree.slice(0, 12)} under ${policyLabel(repo)}; stamp-only: ${describeStamps}`);
  }, 120_000);

  test('a receipt for the very tree pregate.json recorded still clears with no substitution', async () => {
    const { repo } = gatedRepo();
    stamp(repo);
    const file = await pregateAt(repo);
    const r = clear(repo, ['--receipt', receiptFile(repo, file.tree)]);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).not.toContain('PREGATE_RECEIPT_SUBSTITUTED');
    expect(r.out).not.toContain('accepted-for=');
    expect(pregateJson(repo).requires_remote[0].substitution).toBeUndefined();
  }, 120_000);

  test('a path outside the stamp rule refuses the receipt, names the path, and leaves the obligation uncleared', async () => {
    const { repo, gatedTree } = gatedRepo();
    stamp(repo);
    commit(repo, { 'lib/retry.js': 'exports.MAX_RETRIES = 4;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\n' }, 'a real edit after the gate');
    const file = await pregateAt(repo);
    const r = clear(repo, ['--receipt', receiptFile(repo, gatedTree)]);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain(`receipt refused — the remote gate tested tree ${gatedTree.slice(0, 12)}, not ${file.tree.slice(0, 12)}, and the trees differ beyond the stamp rule of ${policyLabel(repo)}: lib/retry.js (stamp_files: not in the repo's stamp_files allowlist, line 1); pregate.json/remote_gate stays uncleared; fix: rerun the remote gate on tree ${file.tree.slice(0, 12)} and pass its output with --receipt`);
    expect(r.err).toContain('a receipt from a predecessor tree is accepted only when every differing path is a stamp');
    expect(r.err).toContain(ANCHOR);
    expect(pregateJson(repo).requires_remote[0].receipt).toBeNull();
    expect(pregateJson(repo).requires_remote[0].substitution).toBeUndefined();
    const verify = runBin(repo, 'gstack-pregate', ['verify']);
    expect(verify.status).toBe(EXIT.fail);
    expect(verify.err).toContain('PREGATE_REMOTE_UNCLEARED');
  }, 120_000);

  test('a stamp path whose hunk is not the stamp rewrite is a change: refused with the path, the rule and the line', async () => {
    const { repo, gated, gatedTree } = gatedRepo();
    stamp(repo);
    commit(repo, { 'plugin.json': PLUGIN('1.0.1', 'Fixture Plugin') }, 'description edit inside a stamp file');
    const file = await pregateAt(repo);
    const r = clear(repo, ['--receipt', receiptFile(repo, gatedTree)]);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain(`the remote gate tested tree ${gatedTree.slice(0, 12)}, not ${file.tree.slice(0, 12)}, and the trees differ beyond the stamp rule`);
    expect(r.err).toContain(': plugin.json (stamp_files: "\\"description\\": \\"Fixture plugin\\"" -> "\\"description\\": \\"Fixture Plugin\\"", line 4); pregate.json/remote_gate stays uncleared; fix: ');
    expect(r.err).toContain(ANCHOR);
    expect(pregateJson(repo).requires_remote[0].receipt).toBeNull();
    // The tree receipt agrees: the pair is `changed` on the same path.
    const receipt = JSON.parse(runBin(repo, 'gstack-tree-receipt', ['--gated', gated, '--current', 'HEAD', '--base', 'main', '--json']).out);
    expect(receipt.residual).toEqual(['plugin.json']);
  }, 120_000);

  test('a gated tree that is not in the object store, or an unreadable receipt file, refuses with the fix', async () => {
    const { repo } = gatedRepo();
    stamp(repo);
    const file = await pregateAt(repo);
    const unknown = clear(repo, ['--receipt', receiptFile(repo, 'deadbeef'.repeat(8))]);
    expect(unknown.status).toBe(EXIT.fail);
    expect(unknown.err).toContain(`the remote gate tested tree deadbeefdead, not ${file.tree.slice(0, 12)}; the gated tree deadbeefdead is not an object in this repository, so the two trees cannot be compared; pregate.json/remote_gate stays uncleared; fix: fetch the commit the remote gate tested (git fetch origin <its sha>) so its tree is here, then clear again`);
    expect(unknown.err).toContain(ANCHOR);
    const missing = clear(repo, ['--receipt', path.join(repo.root, 'no-such-receipt.log')]);
    expect(missing.status).toBe(EXIT.fail);
    expect(missing.err).toContain('receipt refused — cannot read ');
    expect(missing.err).toContain(ANCHOR);
    expect(pregateJson(repo).requires_remote[0].receipt).toBeNull();
  }, 120_000);

  test('a predecessor receipt that reports zero tests or a failure is still refused on its own terms', async () => {
    const { repo, gatedTree } = gatedRepo();
    stamp(repo);
    await pregateAt(repo);
    const zero = clear(repo, ['--receipt', receiptFile(repo, gatedTree, 0)]);
    expect(zero.status).toBe(EXIT.fail);
    expect(zero.err).toContain('the remote gate reported 0 tests; pregate.json/remote_gate stays uncleared');
    const failed = clear(repo, ['--receipt', receiptFile(repo, gatedTree, 3, 1)]);
    expect(failed.status).toBe(EXIT.fail);
    expect(failed.err).toContain('the remote gate reported 1 failed of 3');
    expect(pregateJson(repo).requires_remote[0].receipt).toBeNull();
  }, 120_000);

  test('verify refuses a recorded substitution that was accepted for another tree', async () => {
    const { repo, gatedTree } = gatedRepo();
    stamp(repo);
    const file = await pregateAt(repo);
    expect(clear(repo, ['--receipt', receiptFile(repo, gatedTree)]).status).toBe(EXIT.ok);
    const edited = pregateJson(repo);
    edited.requires_remote[0].substitution.accepted_for = 'cafe'.repeat(10);
    fs.writeFileSync(path.join(repo.work, PREGATE_FILE), JSON.stringify(edited));
    const v = verifyPregate(repo.work, edited, { tree: file.tree });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('PREGATE_REMOTE_UNCLEARED');
    expect(v.message).toContain(`pregate.json/remote_gate (accepted for cafecafecafe from gated ${gatedTree.slice(0, 12)}, pregate.json is ${file.tree.slice(0, 12)}); clear again`);
    const r = runBin(repo, 'gstack-pregate', ['verify']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain('PREGATE_REMOTE_UNCLEARED');
    // A substitution whose gated tree is not the one the receipt string names is refused too: the record and the receipt must agree.
    const swapped = pregateJson(repo);
    swapped.requires_remote[0].substitution.gated_tree = 'beef'.repeat(10);
    const w = verifyPregate(repo.work, swapped, { tree: file.tree });
    expect(w.ok).toBe(false);
    expect(w.code).toBe('PREGATE_REMOTE_UNCLEARED');
    expect(w.message).toContain('from gated beefbeefbeef');
  }, 120_000);

  test('a same-tree receipt after a substituted clear drops the recorded substitution', async () => {
    const { repo, gatedTree } = gatedRepo();
    stamp(repo);
    const file = await pregateAt(repo);
    expect(clear(repo, ['--receipt', receiptFile(repo, gatedTree)]).status).toBe(EXIT.ok);
    expect(pregateJson(repo).requires_remote[0].substitution).toBeDefined();
    expect(clear(repo, ['--receipt', receiptFile(repo, file.tree)]).status).toBe(EXIT.ok);
    expect(pregateJson(repo).requires_remote[0].substitution).toBeUndefined();
    const verify = runBin(repo, 'gstack-pregate', ['verify']);
    expect(verify.status).toBe(EXIT.ok);
    expect(verify.out).not.toContain('stamp-only');
  }, 120_000);

  test('a symbolic tree, a head tree that is not here, a mode-only difference and a stamp file at the wrong version are refused', async () => {
    const { repo, gatedTree } = gatedRepo();
    stamp(repo);
    const file = await pregateAt(repo);
    const symbolic = clear(repo, ['--receipt', receiptFile(repo, 'HEAD^{tree}')]);
    expect(symbolic.status).toBe(EXIT.fail);
    expect(symbolic.err).toContain(`the remote gate tested tree HEAD^{tree}, not ${file.tree.slice(0, 12)}; the gated tree "HEAD^{tree}" is not a git object id, so it cannot be compared; pregate.json/remote_gate stays uncleared`);
    expect(pregateJson(repo).requires_remote[0].receipt).toBeNull();
    const headGone = substituteStampOnlyTree(repo.work, 'main', gatedTree, 'f00d'.repeat(10));
    expect('problem' in headGone && headGone.problem).toContain('the head tree f00df00df00d is not an object in this repository');
    const upper = substituteStampOnlyTree(repo.work, 'main', gatedTree.toUpperCase(), file.tree);
    expect('problem' in upper && upper.problem).toContain('is not a git object id');
    // A mode-only change leaves git diff --unified=0 with a file header and no hunk: classifyFile's mode rule, a change.
    fs.chmodSync(path.join(repo.work, 'lib/util.js'), 0o755);
    const modeHead = commit(repo, {}, 'mode only');
    const mode = substituteStampOnlyTree(repo.work, 'main', gatedTree, repo.git('rev-parse', `${modeHead}^{tree}`));
    expect('problem' in mode && mode.problem).toContain('lib/util.js (mode: file mode changed');
    fs.chmodSync(path.join(repo.work, 'lib/util.js'), 0o644);
    commit(repo, {}, 'mode back');
    // A stamp file rewritten to a version other than the head's is not the old -> new rewrite.
    const wrongHead = commit(repo, { 'README.md': '# fixture\n<!-- fixture-stamp: 1.0.7 -->\n' }, 'README at the wrong version');
    const wrong = substituteStampOnlyTree(repo.work, 'main', gatedTree, repo.git('rev-parse', `${wrongHead}^{tree}`));
    expect('problem' in wrong && wrong.problem).toContain('README.md (stamp_files: ');
    expect('problem' in wrong && wrong.problem).toContain('1.0.7');
  }, 120_000);

  test("the policy branch is origin/HEAD's; a pregate.json base naming another branch, a stamp-sensitive test lane and an invalid base policy refuse", async () => {
    const { repo, gatedTree } = gatedRepo();
    stamp(repo);
    const file = await pregateAt(repo);
    expect(baseBranchOf(file.base)).toBe('main');
    expect(baseBranchOf('origin/release/2026@0123456789ab')).toBe('release/2026');
    expect(baseBranchOf(undefined)).toBeNull();
    expect(baseBranchOf('main')).toBeNull();
    const noBase = substituteStampOnlyTree(repo.work, 'no-such-branch', gatedTree, file.tree);
    expect('problem' in noBase && noBase.problem).toContain('the ship policy on origin/no-such-branch could not be read');
    // No base field: clearDecision uses origin/HEAD's branch (main here) and still accepts; a base field naming another branch refuses.
    const { base: _b, ...noField } = file;
    const d = clearDecision(noField as typeof file, LANE, { receiptPath: receiptFile(repo, gatedTree) }, repo.work);
    expect('substitution' in d && d.substitution?.files).toEqual(STAMP_FILES);
    const other = clearDecision({ ...file, base: 'origin/release@0123456789ab' }, LANE, { receiptPath: receiptFile(repo, gatedTree) }, repo.work);
    expect('refused' in other && other.message).toContain(`pregate.json was recorded against origin/release, not this repository's base origin/main`);
    expect('refused' in other && other.fix).toBe('rerun gstack-pregate --base main, then clear again');
    // Without origin/HEAD the base falls back to main, so the fix also says how to set the recorded base instead.
    repo.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    const unset = clearDecision({ ...file, base: 'origin/release@0123456789ab' }, LANE, { receiptPath: receiptFile(repo, gatedTree) }, repo.work);
    expect('refused' in unset && unset.fix).toBe('rerun gstack-pregate --base main, then clear again; or, since origin/HEAD is unset here, git remote set-head origin release so clear reads that base\'s policy');
    repo.git('remote', 'set-head', 'origin', 'main');
    // A policy that lists the test lane as stamp-sensitive (gstack's own does) refuses the substitution: that lane never reuses across a stamp.
    repo.git('checkout', '-q', 'main');
    commit(repo, { '.gstack/ship-policy.json': JSON.stringify({ ...POLICY, stamp_sensitive_gates: ['tests'] }, null, 2) + '\n' }, 'tests read the stamps');
    repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    repo.git('fetch', '-q', 'origin');
    const sensitive = clear(repo, ['--receipt', receiptFile(repo, gatedTree)]);
    expect(sensitive.status).toBe(EXIT.fail);
    expect(sensitive.err).toContain(`not ${file.tree.slice(0, 12)}, and origin/main@`);
    expect(sensitive.err).toContain(':.gstack/ship-policy.json lists the test lane as stamp-sensitive (stamp_sensitive_gates: tests), so a run on another tree never covers this one; pregate.json/remote_gate stays uncleared');
    expect(pregateJson(repo).requires_remote[0].receipt).toBeNull();
    // An invalid policy on the base refuses rather than classifying under the defaults.
    repo.git('checkout', '-q', 'main');
    commit(repo, { '.gstack/ship-policy.json': '{ "stamp_files": "VERSION" }\n' }, 'break the policy');
    repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    repo.git('fetch', '-q', 'origin');
    const broken = clear(repo, ['--receipt', receiptFile(repo, gatedTree)]);
    expect(broken.status).toBe(EXIT.fail);
    expect(broken.err).toContain('.gstack/ship-policy.json on origin/main@');
    expect(broken.err).toContain('is invalid (');
    expect(broken.err).toContain('fix: fix the policy on the base branch (gstack-ship-policy validate)');
    expect(pregateJson(repo).requires_remote[0].receipt).toBeNull();
  }, 120_000);
});

// /ship docs audit (GSTA-154 PR A): clear's substitution and gstack-tree-receipt share one classifier, fragment fold included.
describe.skipIf(process.platform === 'win32')('clear --receipt under changelog_fragments', () => {
  // Value: protects=a receipt for the fragment head clears the stamped head when the stamp is exactly the fold; fails_when=clear treats the fold as a change and forces a second remote gate, or accepts a fold that dropped the text; why_new=every other case uses [Unreleased]; seam=none; no_claim=restamp's own fold (its tests)
  test('the fold of a deleted fragment is a stamp; a fold that changed the text is not', () => {
    const repo = makeFixtureRepo({
      pregate: { ...BASE_PREGATE, remote_gate: GATE },
      baseFiles: { '.gstack/ship-policy.json': JSON.stringify({ ...POLICY, changelog_fragments: { dir: 'changelog.d' }, min_gstack_version: '1.91.336.0' }, null, 2) + '\n', VERSION: '1.0.0\n', 'CHANGELOG.md': '# Changelog\n\n## [1.0.0] - 2026-10-01\n\n- base\n' },
    });
    repos.push(repo);
    repo.git('checkout', '-q', 'feature');
    repo.git('merge', '-q', '--ff-only', 'main');
    const gated = commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b;\n', 'changelog.d/add.md': '- add\n' }, 'change with a fragment');
    const gatedTree = repo.git('rev-parse', `${gated}^{tree}`);
    const stampTo = (entry: string) => {
      repo.git('checkout', '-q', '--detach', gated);
      fs.rmSync(path.join(repo.work, 'changelog.d', 'add.md'));
      return repo.git('rev-parse', `${commit(repo, { VERSION: '1.0.1\n', 'CHANGELOG.md': `# Changelog\n\n## [1.0.1] - 2026-10-29\n\n${entry}\n## [1.0.0] - 2026-10-01\n\n- base\n` }, 'v1.0.1 stamp')}^{tree}`);
    };
    const ok = substituteStampOnlyTree(repo.work, 'main', gatedTree, stampTo('- add\n'));
    expect('substitution' in ok && ok.substitution.files).toEqual(expect.arrayContaining([{ path: 'CHANGELOG.md', rule: 'changelog-fragments' }, { path: 'changelog.d/add.md', rule: 'changelog_fragments' }]));
    const edited = substituteStampOnlyTree(repo.work, 'main', gatedTree, stampTo('- add, reworded\n'));
    expect('problem' in edited && edited.problem).toContain('changelog.d/add.md (changelog_fragments: deleted without its text folded');
  }, 120_000);
});
