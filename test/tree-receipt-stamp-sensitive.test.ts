/**
 * C3: the tree-equality receipt classifies hunk by hunk, keeps stamp-sensitive
 * gates on the rerun side, names the negative fixtures (a dependency pin equal
 * to the old version; a lockfile dependency entry), refuses `eligible` when the
 * predecessor moved, and emits the same receipt as JSON.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { stampOnlyLine } from '../lib/stamp-only';
import { BASE_POLICY, cleanup, ghShim, makeFixtureRepo, makePr, readFile, recordAndBundle, restamp, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo({ prefix: 'tree-receipt-', ...opts }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const LANES = [{ label: 'tests', command: 'true' }, { label: 'digest', command: 'cat generated/digest.md' }];

/** A gated head: pr-a stamped at 1.2.4.0 with both lanes recorded and bundled. */
function gated(repo: FixtureRepo, env: Record<string, string> = {}): { head: string; bundle: string } {
  makePr(repo, 'pr-a', { expects: '1.2.4.0' });
  fs.writeFileSync(path.join(repo.work, 'docs', 'deps.md'), 'left-pad: 1.2.4.0\n');
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'deps doc');
  expect(restamp(repo, ['--version', '1.2.4.0']).status).toBe(EXIT.ok);
  repo.git('commit', '-qam', 'stamp 1.2.4.0');
  const bundle = path.join(repo.root, 'bundle.json');
  recordAndBundle(repo, repo.work, LANES, bundle, env);
  return { head: repo.git('rev-parse', 'HEAD'), bundle };
}

const receipt = (repo: FixtureRepo, args: string[], env: Record<string, string> = {}) => runBin(repo, 'gstack-tree-receipt', ['--base', 'main', ...args], env);

describe('tree receipt: stamps, stamp-sensitive gates and negative fixtures', () => {
  test('a restamp is same-modulo-stamps: tests reusable, the digest lane (stamp-sensitive) reruns, the diff is limited to stamp files', () => {
    const repo = fixture();
    const g = gated(repo);
    expect(restamp(repo, ['--version', '1.2.5.0']).status).toBe(EXIT.ok);
    repo.git('commit', '-qam', 'stamp 1.2.5.0');
    expect(readFile(repo, 'docs/pr-a.md')).toBe('since: 1.2.5.0\nRequires v1.2.5.0 or later.\n');
    const r = receipt(repo, ['--gated', g.head, '--bundle', g.bundle]);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^version:\s+1\.2\.4\.0 -> 1\.2\.5\.0$/m);
    expect(r.out).toMatch(/^  stamp   VERSION \(version-file\)$/m);
    expect(r.out).toMatch(/^  stamp   package-lock\.json \(lockfile-root-version\)$/m);
    expect(r.out).toMatch(/^  stamp   package\.json \(manifest-version\)$/m);
    expect(r.out).toMatch(/^  stamp   CHANGELOG\.md \(changelog-heading\)$/m);
    expect(r.out).toMatch(/^  stamp   docs\/pr-a\.md \(stamp_paths\)$/m);
    expect(r.out).toMatch(/^  stamp   generated\/digest\.md \(release_outputs\)$/m);
    expect(r.out).toMatch(/^  gate tests: reusable \(identity matches; tree same modulo stamps\)$/m);
    expect(r.out).toMatch(/^  gate digest: rerun \(stamp-sensitive/m);
    expect(r.out).toMatch(/^TREE: same-modulo-stamps$/m);
    expect(r.out).toMatch(/^gate-reuse: eligible \(reusable: tests; rerun: digest\)$/m);
    expect(r.out).toContain('-since: 1.2.4.0');
    expect(r.out).toContain('+since: 1.2.5.0');
    expect(r.out).not.toContain('pr-a.txt');
  });

  // #3512: under the next-minor convention a new `*_KEY_VERSION` constant is written as a tentative future version, which the
  // stamp_paths stage moves to the released one at the slot. The receipt accepted a stamp_paths pair only as base -> new, so the
  // moved constant classified the file `changed` and the train refused the stamp commit (QUEUE_STAMP_NOT_STAMP_ONLY).
  test('a tentative key version a restamp moved is a stamp, like the base version; a line that changes more than the mention is not', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, stamp_paths: ['docs/**/*.md', 'lib/policy.ts'], stamp_patterns: ["_KEY_VERSION = '{version}'"] } });
    makePr(repo, 'pr-a', { expects: '1.2.4.0' });
    fs.mkdirSync(path.join(repo.work, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'lib', 'policy.ts'), "export const DOCS_KEY_VERSION = '1.3.0.0';\nexport const OLD_KEY_VERSION = '1.2.2.0';\n");
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'a new policy key, tentative next minor');
    const bundle = path.join(repo.root, 'bundle.json');
    recordAndBundle(repo, repo.work, LANES, bundle);
    const gatedHead = repo.git('rev-parse', 'HEAD');
    expect(restamp(repo, ['--version', '1.2.4.0']).status).toBe(EXIT.ok);
    // The tentative 1.3.0.0 moved; the released 1.2.2.0 stayed.
    expect(readFile(repo, 'lib/policy.ts')).toBe("export const DOCS_KEY_VERSION = '1.2.4.0';\nexport const OLD_KEY_VERSION = '1.2.2.0';\n");
    repo.git('commit', '-qam', 'stamp 1.2.4.0');
    const r = receipt(repo, ['--gated', gatedHead, '--bundle', bundle]);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^version:\s+1\.2\.3\.0 -> 1\.2\.4\.0$/m);
    expect(r.out).toMatch(/^  stamp   lib\/policy\.ts \(stamp_paths\)$/m);
    expect(r.out).toMatch(/^TREE: same-modulo-stamps$/m);
    expect(r.out).toMatch(/^gate-reuse: eligible/m);
    // Negative: the version moves and the key is renamed on the same line; a tentative value moved by hand to the wrong version.
    fs.writeFileSync(path.join(repo.work, 'lib', 'policy.ts'), "export const DOCS_CAPS_KEY_VERSION = '1.2.4.0';\nexport const OLD_KEY_VERSION = '1.2.2.0';\n");
    repo.git('commit', '-qam', 'rename the key too');
    const renamed = receipt(repo, ['--gated', gatedHead, '--bundle', bundle]);
    expect(renamed.status).toBe(EXIT.fail);
    expect(renamed.out).toMatch(/^  changed lib\/policy\.ts \(stamp_paths: "export const DOCS_KEY_VERSION = '1\.3\.0\.0';" -> "export const DOCS_CAPS_KEY_VERSION = '1\.2\.4\.0';"\)$/m);
    repo.git('reset', '-q', '--hard', 'HEAD~1');
    fs.writeFileSync(path.join(repo.work, 'lib', 'policy.ts'), "export const DOCS_KEY_VERSION = '1.2.4.0';\nexport const OLD_KEY_VERSION = '1.2.4.0';\n");
    repo.git('commit', '-qam', 'move a released key by hand');
    const wrong = receipt(repo, ['--gated', gatedHead, '--bundle', bundle]);
    expect(wrong.status).toBe(EXIT.fail);
    expect(wrong.out).toMatch(/^TREE: changed \(lib\/policy\.ts\)$/m);
    // A mention of another width (a 3-digit pin in a 4-digit repo) is never a stamp candidate, so moving it by hand to the
    // new version is a product change even though it reads newer than the gated head (pre-landing review, pass 1).
    repo.git('reset', '-q', '--hard', 'HEAD~1');
    fs.writeFileSync(path.join(repo.work, 'lib', 'policy.ts'), "export const DOCS_KEY_VERSION = '1.2.4.0';\nexport const OLD_KEY_VERSION = '1.2.2.0';\nexport const PIN_KEY_VERSION = '9.9.9';\n");
    repo.git('commit', '-qam', 'a 3-digit pin');
    const pinned = repo.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo.work, 'lib', 'policy.ts'), "export const DOCS_KEY_VERSION = '1.2.4.0';\nexport const OLD_KEY_VERSION = '1.2.2.0';\nexport const PIN_KEY_VERSION = '1.2.4.0';\n");
    repo.git('commit', '-qam', 'move the 3-digit pin by hand');
    expect(stampOnlyLine("export const PIN_KEY_VERSION = '9.9.9';", "export const PIN_KEY_VERSION = '1.2.4.0';", '1.2.3.0', '1.2.4.0', ["_KEY_VERSION = '{version}'"])).toBe(false);
    expect(stampOnlyLine('left-pad since: 1.2.3', 'left-pad since: 1.2.4.0', '1.2.3.0', '1.2.4.0')).toBe(false);
    const width = receipt(repo, ['--gated', pinned, '--bundle', bundle]);
    expect(width.status).toBe(EXIT.fail);
    expect(width.out).toMatch(/^TREE: changed \(lib\/policy\.ts\)$/m);
  });

  // Value: protects=the fork-version bound reads the branch's own line by its position, so a base copy of the same text
  //   is still floored at the old version, and when the slot keeps its VERSION only the branch's own lines may move
  //   (GST-979); fails_when=stampOnlyLine matches the branch's lines by text alone or takes the old-version floor at equal
  //   versions; seam=lib/stamp-only.ts stampOnlyLine
  test('the fork-version bound holds only at the branch line\'s own position, and a kept VERSION moves only the branch\'s own lines (GST-979)', () => {
    const tpl = ["since: '{version}'"];
    const row = "  { since: '1.2.3.0', id: 'x' },";
    const moved = row.replace('1.2.3.0', '1.2.5.0');
    const side = { fork: '1.2.3.0', added: new Set([row]), at: new Set([10]) };
    expect(stampOnlyLine(row, moved, '1.2.4.0', '1.2.5.0', tpl, side, 10)).toBe(true);
    expect(stampOnlyLine(row, moved, '1.2.4.0', '1.2.5.0', tpl, side, 2)).toBe(false);
    const mine = { fork: '1.2.3.0', added: new Set(["mine since: '1.2.3.0'"]), at: new Set([5]) };
    expect(stampOnlyLine("base since: '1.3.0.0'", "base since: '1.2.4.0'", '1.2.4.0', '1.2.4.0', tpl, mine, 1)).toBe(false);
    expect(stampOnlyLine("mine since: '1.2.3.0'", "mine since: '1.2.4.0'", '1.2.4.0', '1.2.4.0', tpl, mine, 5)).toBe(true);
  });

  test('negative fixture: a dependency pin equal to the old version is `changed`, not a stamp, even inside stamp_paths', () => {
    const repo = fixture();
    const g = gated(repo);
    expect(restamp(repo, ['--version', '1.2.5.0']).status).toBe(EXIT.ok);
    expect(readFile(repo, 'docs/deps.md')).toBe('left-pad: 1.2.4.0\n');
    fs.writeFileSync(path.join(repo.work, 'docs', 'deps.md'), 'left-pad: 1.2.5.0\n');
    repo.git('commit', '-qam', 'bump the pin by hand');
    const r = receipt(repo, ['--gated', g.head, '--bundle', g.bundle]);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^  changed docs\/deps\.md \(stamp_paths: "left-pad: 1\.2\.4\.0" -> "left-pad: 1\.2\.5\.0"\)$/m);
    expect(r.out).toMatch(/^TREE: changed \(docs\/deps\.md\)$/m);
    expect(r.out).toMatch(/^gate-reuse: not-eligible \(tree changed: docs\/deps\.md\) — fix: gstack-evidence run --label <lane> -- <lane command> \(GATE_REUSE_NOT_ELIGIBLE\)$/m);
  });

  test('lockfile rule: only the root package version keys are stamps; a dependency entry is a change', () => {
    const repo = fixture();
    const g = gated(repo);
    const lock = JSON.parse(readFile(repo, 'package-lock.json'));
    lock.packages['node_modules/left-pad'].version = '1.2.4';
    fs.writeFileSync(path.join(repo.work, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    repo.git('commit', '-qam', 'dependency moved');
    const r = receipt(repo, ['--gated', g.head, '--bundle', g.bundle]);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^  changed package-lock\.json \(lockfile: a dependency entry changed \(only the root version keys are stamps\)\)$/m);
    expect(r.out).toMatch(/^TREE: changed \(package-lock\.json\)$/m);
  });

  test('a changed generated prompt or CHANGELOG entry is a change even when the version moved', () => {
    const repo = fixture();
    const g = gated(repo);
    expect(restamp(repo, ['--version', '1.2.5.0']).status).toBe(EXIT.ok);
    fs.appendFileSync(path.join(repo.work, 'generated', 'digest.md'), 'an extra generated line\n');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), readFile(repo, 'CHANGELOG.md').replace('- pr-a change', '- pr-a change, reworded'));
    repo.git('commit', '-qam', 'stamp plus edits');
    const r = receipt(repo, ['--gated', g.head, '--bundle', g.bundle, '--json']);
    expect(r.status).toBe(EXIT.fail);
    const j = JSON.parse(r.out);
    expect(j.files.find((f: any) => f.path === 'generated/digest.md')).toMatchObject({ verdict: 'changed', rule: 'release_outputs' });
    expect(j.files.find((f: any) => f.path === 'CHANGELOG.md')).toMatchObject({ verdict: 'changed', rule: 'changelog' });
    expect(j.residual.sort()).toEqual(['CHANGELOG.md', 'generated/digest.md']);
    expect(j.tree).toBe('changed');
    expect(j.gate_reuse).toBe('not-eligible');
    expect(j.code).toBe('GATE_REUSE_NOT_ELIGIBLE');
  });
});

describe('tree receipt: identity and predecessor', () => {
  test('without a bundle the identity is unknown and reuse is refused even on an equal tree', () => {
    const repo = fixture();
    const g = gated(repo);
    const r = receipt(repo, ['--gated', g.head]);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^TREE: same-modulo-stamps$/m);
    expect(r.out).toMatch(/^gate-reuse: not-eligible \(none \(no evidence bundle; execution identity unknown\)\)/m);
  });

  test('an environment change under an identical tree (runner image) is not-eligible and names what changed', () => {
    const repo = fixture();
    const g = gated(repo, { GSTACK_RUNNER_IMAGE: 'ubuntu-24.04/20261001' });
    const r = receipt(repo, ['--gated', g.head, '--bundle', g.bundle], { GSTACK_RUNNER_IMAGE: 'ubuntu-24.04/20261008' });
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^identity:\s+bundle .* — changed: runner image ubuntu-24\.04\/20261001 -> ubuntu-24\.04\/20261008$/m);
    expect(r.out).toMatch(/^  gate tests: not-reusable \(identity changed: runner image/m);
    expect(r.out).toMatch(/^gate-reuse: not-eligible \(runner image ubuntu-24\.04\/20261001 -> ubuntu-24\.04\/20261008\)/m);
    const same = receipt(repo, ['--gated', g.head, '--bundle', g.bundle], { GSTACK_RUNNER_IMAGE: 'ubuntu-24.04/20261001' });
    expect(same.status).toBe(EXIT.ok);
  });

  test('a bundle produced on another tree is not the gated identity', () => {
    const repo = fixture();
    const g = gated(repo);
    expect(restamp(repo, ['--version', '1.2.5.0']).status).toBe(EXIT.ok);
    repo.git('commit', '-qam', 'stamp 1.2.5.0');
    const other = path.join(repo.root, 'other.json');
    recordAndBundle(repo, repo.work, LANES, other);
    const r = receipt(repo, ['--gated', g.head, '--bundle', other]);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^gate-reuse: not-eligible \(bundle .* was produced on tree [0-9a-f]{12}, not the gated tree [0-9a-f]{12}\)/m);
  });

  test('PREDECESSOR MOVED: a predecessor ref or PR whose head is no longer the recorded one refuses with RESTAMP_PREDECESSOR_MOVED', () => {
    const repo = fixture();
    const recorded = repo.git('rev-parse', 'origin/main');
    const g = gated(repo);
    repo.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo.work, 'moved.txt'), 'moved\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'main moved'); repo.git('push', '-q', 'origin', 'main');
    const moved = repo.git('rev-parse', 'main');
    repo.git('checkout', '-q', 'pr-a');
    const byRef = receipt(repo, ['--gated', g.head, '--bundle', g.bundle, '--predecessor', recorded, '--predecessor-ref', 'origin/main']);
    expect(byRef.status).toBe(EXIT.fail);
    expect(byRef.out).toMatch(/^TREE: same-modulo-stamps$/m);
    expect(byRef.out).toContain(`PREDECESSOR MOVED ${recorded} -> ${moved} — fix: gstack-restamp --after <pr> again (RESTAMP_PREDECESSOR_MOVED)`);
    expect(byRef.out).toMatch(/^gate-reuse: not-eligible \(PREDECESSOR MOVED/m);
    const byPr = receipt(repo, ['--gated', g.head, '--bundle', g.bundle, '--predecessor', recorded, '--predecessor-pr', '7', '--json'], ghShim(repo, { 7: { headRefOid: moved } }));
    const j = JSON.parse(byPr.out);
    expect(j.predecessor).toEqual({ pr: '7', recorded_head: recorded, current_head: moved, moved: true });
    expect(j.code).toBe('RESTAMP_PREDECESSOR_MOVED');
    const still = receipt(repo, ['--gated', g.head, '--bundle', g.bundle, '--predecessor', recorded, '--predecessor-pr', '7'], ghShim(repo, { 7: { headRefOid: recorded } }));
    expect(still.status).toBe(EXIT.ok);
    expect(still.out).toMatch(/^predecessor:\s+#7 recorded=[0-9a-f]{12} current=[0-9a-f]{12}$/m);
  });

  test('--json carries every identifier the human rendering prints', () => {
    const repo = fixture();
    const g = gated(repo);
    const r = receipt(repo, ['--gated', g.head, '--bundle', g.bundle, '--json']);
    expect(r.status).toBe(EXIT.ok);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ schema_version: 1, gated_head: g.head, current_head: g.head, tree: 'same-modulo-stamps', gate_reuse: 'eligible', old_version: '1.2.4.0', new_version: '1.2.4.0', residual: [], files: [] });
    expect(j.gated_tree).toBe(repo.git('rev-parse', `${g.head}^{tree}`));
    expect(j.identity.gated.lockfiles['package-lock.json']).toMatch(/^[0-9a-f]{64}$/);
    expect(j.identity.diffs).toEqual([]);
    expect(j.gates.map((x: any) => [x.label, x.verdict])).toEqual([['tests', 'reusable'], ['digest', 'rerun']]);
    expect(j.gates[0].cmd_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(j.policy).toMatch(/^origin\/main@[0-9a-f]{12}:\.gstack\/ship-policy\.json$/);
  });

  test('a gated head that is not a commit here is EVIDENCE_IDENTITY_UNKNOWN with the fetch hint', () => {
    const repo = fixture();
    const r = receipt(repo, ['--gated', '0123456789abcdef0123456789abcdef01234567']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toMatch(/not a committed head here \(fetch it, or copy the gate-ahead worktree's object store\).*\(EVIDENCE_IDENTITY_UNKNOWN\)/);
  });
});
