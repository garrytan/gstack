/**
 * A foreign version on a line the PR added to a stamp file is not the PR's stamp (GST-1245, HARN-7 on gstack
 * 1.94.19.0): harness-evals#235 added three README.md lines saying "QM v0.1.15", README.md was in stamp_files,
 * and the land stamp turned all three into "QM v0.0.115" (the repo's new VERSION), then "QM v0.0.116" on the
 * next stamp, because the stamp_paths stage read any built-in `vX` mention newer than the fork point on a
 * branch-added line as the branch's tentative stamp. The tree receipt called the rewrite stamp-only for the same
 * reason. The stamper and every stamp-only check now move a built-in form above the version being stamped
 * only when the branch itself recorded it (its version source at its fork point or at any of its own
 * commits); a declared stamp_patterns slot keeps the fork-point bound (#3512).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { tentativeMentions } from '../lib/restamp';
import { stampOnlyLine } from '../lib/stamp-only';
import { BASE_POLICY, cleanup, makeFixtureRepo, makePr, mergeMain, mergeToMain, readFile, restamp, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const POLICY = { ...BASE_POLICY, release_tool: null, release_outputs: [], stamp_files: ['VERSION', 'package.json', 'package-lock.json', 'CHANGELOG.md', 'README.md'] };
const BASE_README = '# harness\n\nScored with qm v0.1.15 since the start.\n';
const QM = ['QM v0.1.15 grades every run.', 'Pin QM v0.1.15 in CI.', 'Upgrade notes for QM v0.1.15 are below.'];

/** harness-evals' shape: a three-part repo at 0.0.114 whose README.md (a stamp file) already mentions qm v0.1.15. */
function harness(): FixtureRepo {
  const repo = makeFixtureRepo({ prefix: 'restamp-foreign-', policy: POLICY, version: '0.0.114' });
  repos.push(repo);
  fs.writeFileSync(path.join(repo.work, 'README.md'), BASE_README);
  repo.git('add', '-A'); repo.git('commit', '-qm', 'readme'); repo.git('push', '-q', 'origin', 'main');
  return repo;
}
const addReadme = (repo: FixtureRepo, lines: string[]) => fs.writeFileSync(path.join(repo.work, 'README.md'), BASE_README + lines.join('\n') + '\n');

describe('a foreign version on a PR-added stamp_files line (GST-1245)', () => {
  // Value: protects=a third-party version a PR writes into a stamp file survives the stamp byte for byte (HARN-7's
  //   "QM v0.1.15" -> "QM v0.0.115"); fails_when=the stamp_paths stage reads any vX newer than the fork point on a
  //   branch-added line as the branch's own stamp; why_new=no case put a foreign same-width version on a branch line;
  //   seam=lib/restamp.ts rewriteStampPaths; no_claim=versions of another width (already never candidates)
  test('the stamp leaves three PR-added "QM v0.1.15" lines and the base\'s qm line exactly as written', () => {
    const repo = harness();
    makePr(repo, 'pr-235');
    addReadme(repo, QM);
    repo.git('commit', '-qam', 'docs: QM v0.1.15');
    const pinned = readFile(repo, 'README.md');
    const r = restamp(repo, ['--next']);
    expect(r.status, r.err).toBe(EXIT.ok);
    expect(readFile(repo, 'VERSION')).toBe('0.0.115\n');
    expect(readFile(repo, 'README.md')).toBe(pinned);
    expect(r.out).not.toContain('0.1.15 -> 0.0.115');
  });

  // Value: protects=the PR's own recorded version still moves on its own lines while the foreign one beside it stays
  //   (the negative control; harness-evals' second stamp d6801432 moved the QM lines again); fails_when=the fix stops
  //   moving the branch's own tentative stamp after it lost its slot; why_new=the lost-slot cases carry no foreign
  //   version; seam=lib/restamp.ts recordedVersions + tentativeMentions; no_claim=none beyond protects
  test('control: after a lost slot the PR\'s own v0.0.115 line moves to v0.0.116 and the QM lines beside it do not', () => {
    const repo = harness();
    makePr(repo, 'pr-235');
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '0.0.115\n');
    addReadme(repo, [...QM, 'harness v0.0.115 adds QM grading.']);
    repo.git('commit', '-qam', 'docs and my tentative stamp');
    makePr(repo, 'pr-other');
    expect(restamp(repo, ['--next']).status).toBe(EXIT.ok);
    repo.git('commit', '-qam', 'stamp other');
    mergeToMain(repo, 'pr-other');
    repo.git('checkout', '-q', 'pr-235');
    mergeMain(repo);
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '0.0.115\n');
    const r = restamp(repo, ['--next']);
    expect(r.status, r.err).toBe(EXIT.ok);
    expect(readFile(repo, 'VERSION')).toBe('0.0.116\n');
    expect(readFile(repo, 'README.md')).toBe(BASE_README + [...QM, 'harness v0.0.116 adds QM grading.'].join('\n') + '\n');
  });

  // Value: protects=the tree receipt (stamp, verify, gate-ahead replay) reads a rewritten foreign version as product,
  //   so a corrupting stamp can no longer pass as stamp-only; fails_when=stampOnlyLine accepts any moved version at or
  //   above the gated head's or the fork point's; why_new=no receipt case moved a foreign same-width version;
  //   seam=lib/stamp-only.ts stampOnlyWithin; no_claim=none beyond protects
  test('the tree receipt calls the corrupt stamp a product change in README.md and the honest stamp stamp-only', () => {
    const repo = harness();
    makePr(repo, 'pr-235');
    addReadme(repo, QM);
    repo.git('commit', '-qam', 'docs: QM v0.1.15');
    const gated = repo.git('rev-parse', 'HEAD');
    expect(restamp(repo, ['--next']).status).toBe(EXIT.ok);
    repo.git('commit', '-qam', 'honest stamp');
    const honest = runBin(repo, 'gstack-tree-receipt', ['--gated', gated, '--base', 'main']);
    expect(honest.out, honest.err).toContain('TREE: same-modulo-stamps');
    fs.writeFileSync(path.join(repo.work, 'README.md'), readFile(repo, 'README.md').replace(/QM v0\.1\.15/g, 'QM v0.0.115'));
    repo.git('commit', '-q', '--allow-empty', '-am', 'the 1.94.19.0 stamp: QM rewritten');
    const corrupt = runBin(repo, 'gstack-tree-receipt', ['--gated', gated, '--base', 'main']);
    expect(corrupt.out).toMatch(/^TREE: changed \(README\.md\)$/m);
    expect(corrupt.out).toContain('changed README.md (stamp_files: "QM v0.1.15 grades every run." -> "QM v0.0.115 grades every run.")');
  });

  // Value: protects=a declared stamp_patterns slot moves only inside its own match, so the same foreign version in a
  //   built-in form beside it (same line or another PR line) survives, and the receipt agrees (GST-1245 outside voice);
  //   fails_when=a template match marks the version tentative and every form of it moves; why_new=no case mixed a slot
  //   and a foreign built-in mention of one version; seam=lib/restamp.ts slotOnly + lib/stamp-only.ts free; no_claim=none
  test('a template slot at an unrecorded version moves alone; the same version as "QM v0.1.15" beside it stays', () => {
    const repo = makeFixtureRepo({ prefix: 'restamp-foreign-slot-', policy: { ...POLICY, stamp_patterns: ["_KEY_VERSION = '{version}'"] }, version: '0.0.114' });
    repos.push(repo);
    fs.writeFileSync(path.join(repo.work, 'README.md'), BASE_README);
    repo.git('add', '-A'); repo.git('commit', '-qm', 'readme'); repo.git('push', '-q', 'origin', 'main');
    makePr(repo, 'pr-slot');
    addReadme(repo, ["export const T_KEY_VERSION = '0.1.15'; // QM v0.1.15", QM[0]!]);
    repo.git('commit', '-qam', 'a key at a guessed version and a QM line');
    const gated = repo.git('rev-parse', 'HEAD');
    expect(restamp(repo, ['--next']).status).toBe(EXIT.ok);
    expect(readFile(repo, 'README.md')).toBe(BASE_README + ["export const T_KEY_VERSION = '0.0.115'; // QM v0.1.15", QM[0]!].join('\n') + '\n');
    repo.git('commit', '-qam', 'stamp');
    const receipt = runBin(repo, 'gstack-tree-receipt', ['--gated', gated, '--base', 'main']);
    expect(receipt.out, receipt.err).toContain('TREE: same-modulo-stamps');
  });

  // Value: protects=the pure seams agree: a built-in form moves only a recorded version, a declared template slot keeps
  //   the fork bound (#3512's next-minor key); fails_when=either seam reads an unrecorded built-in mention as a stamp,
  //   or the template slot stops moving; why_new=the seams took no recorded set; seam=tentativeMentions, stampOnlyLine;
  //   no_claim=none beyond protects
  test('pure: tentativeMentions and stampOnlyLine take a built-in mention above the new version only when the branch recorded it', () => {
    const added = new Map([['README.md', new Set([...QM, 'harness v0.0.117', 'since: 0.0.115', "export const X_KEY_VERSION = '0.1.0';"])]]);
    expect(tentativeMentions(added, '0.0.114', '0.0.116', ["_KEY_VERSION = '{version}'"], new Set(['0.0.114', '0.0.117'])).sort()).toEqual(['0.0.115', '0.0.117', '0.1.0']);
    expect(stampOnlyLine(QM[0]!, 'QM v0.0.115 grades every run.', '0.0.114', '0.0.115')).toBe(false);
    const side = { fork: '0.0.114', added: new Set([QM[0]!]), at: new Set([4]) };
    expect(stampOnlyLine(QM[0]!, 'QM v0.0.115 grades every run.', '0.0.114', '0.0.115', [], side, 4)).toBe(false);
    expect(stampOnlyLine('harness v0.0.114', 'harness v0.0.115', '0.0.114', '0.0.115')).toBe(true);
    expect(stampOnlyLine('harness v0.0.117', 'harness v0.0.116', '0.0.114', '0.0.116', [], { ...side, added: new Set(['harness v0.0.117']), recorded: new Set(['0.0.114', '0.0.117']) }, 4)).toBe(true);
    expect(stampOnlyLine('harness v0.0.117', 'harness v0.0.116', '0.0.114', '0.0.116', [], { ...side, added: new Set(['harness v0.0.117']) }, 4)).toBe(false);
    expect(stampOnlyLine('since: 0.0.115', 'since: 0.0.116', '0.0.114', '0.0.116', [], { ...side, added: new Set(['since: 0.0.115']) }, 4)).toBe(true);
    const key = "export const T_KEY_VERSION = '0.1.15'; // QM v0.1.15";
    const tpl = ["_KEY_VERSION = '{version}'"];
    expect(stampOnlyLine(key, "export const T_KEY_VERSION = '0.0.115'; // QM v0.1.15", '0.0.114', '0.0.115', tpl, { ...side, added: new Set([key]) }, 4)).toBe(true);
    expect(stampOnlyLine(key, "export const T_KEY_VERSION = '0.0.115'; // QM v0.0.115", '0.0.114', '0.0.115', tpl, { ...side, added: new Set([key]) }, 4)).toBe(false);
  });
});
