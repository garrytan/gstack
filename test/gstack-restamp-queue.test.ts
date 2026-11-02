/**
 * C2/C3 queue replay (plan Validation 3): three PRs on a fixture repo with a
 * `release:restamp` script, a CHANGELOG, `since:` fields and `vX` mentions;
 * the queue is reordered twice with zero manual edits. Pins the stamp text,
 * CHANGELOG order, the journal, injected failures after every stage,
 * idempotency, dry-run, gate-ahead on a squash-history PR, the PREDECESSOR
 * MOVED refusal, QUEUE_STALE for a moved base and a moved order, and the
 * version-source shapes (package-manifest pin, monorepo pin, absent source).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { checkChangelog, mergeChangelogs, normalizeChangelog, reheadChangelog } from '../lib/changelog-check';
import { rewriteStamps, tentativeMentions } from '../lib/restamp';
import { BUMP_NEVER_KEY_VERSION } from '../lib/ship-policy';
import {
  BASE_POLICY, cleanup, ghShim, makeFixtureRepo, makePr, mergeToMain, readFile, recordAndBundle, restamp, runBin, type FixtureRepo, mergeMain } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const topHeading = (repo: FixtureRepo) => readFile(repo, 'CHANGELOG.md').split('\n').find(l => l.startsWith('## '));
const headings = (repo: FixtureRepo) => readFile(repo, 'CHANGELOG.md').split('\n').filter(l => l.startsWith('## ')).map(l => /\[([^\]]+)\]/.exec(l)![1]);
const stages = (out: string) => Object.fromEntries([...out.matchAll(/^stage (\w+): (\w+)/gm)].map(m => [m[1], m[2]]));

describe('pure pieces', () => {
  test('rewriteStamps: exact (was X) / since: X / vX only; a bare dependency pin equal to X stays', () => {
    const r = rewriteStamps('since: 1.2.3.0, v1.2.3.0, (was 1.2.3.0), pinned 1.2.3.0, v1.2.3.01, av1.2.3.0, since:1.2.3.0', '1.2.3.0', '1.2.4.0');
    expect(r.text).toBe('since: 1.2.4.0, v1.2.4.0, (was 1.2.4.0), pinned 1.2.3.0, v1.2.3.01, av1.2.3.0, since:1.2.4.0');
    expect(r.count).toBe(4);
  });

  test('tentativeMentions: only lines the branch added, newer than the fork version, matching width, not the allocated one', () => {
    const added = new Map([['docs/a.md', new Set(['since: 1.2.4.0 v1.2.3.0 (was 1.2.2.0) v1.2.9.0 since: 1.2.4 v2.0.0.0', 'pinned 1.2.5.0'])]]);
    expect(tentativeMentions(added, '1.2.3.0', '1.2.9.0').sort()).toEqual(['1.2.4.0', '2.0.0.0']);
    expect(tentativeMentions(added, '1.2.6.0', '1.2.7.0').sort()).toEqual(['1.2.9.0', '2.0.0.0']);
    expect(tentativeMentions(new Map([['x', new Set(['since: 1.2.4'])]]), '1.2.3', '1.2.5')).toEqual(['1.2.4']);
    expect(tentativeMentions(new Map(), '1.2.3.0', '1.2.4.0')).toEqual([]);
  });

  test('CHANGELOG: re-heading moves [Unreleased] to the top; duplicates and a top mismatch are errors; a heading move normalizes equal', () => {
    const text = '# Changelog\n\n## [1.2.3.0] - 2026-10-01\n\n- base\n\n## [Unreleased]\n\n- mine\n';
    const r = reheadChangelog(text, { from: '1.2.4.0', to: '1.2.5.0', date: '2026-10-10' });
    expect(r.moved).toBe(true);
    expect(r.text).toBe('# Changelog\n\n## [1.2.5.0] - 2026-10-10\n\n- mine\n\n## [1.2.3.0] - 2026-10-01\n\n- base\n');
    expect(checkChangelog(r.text, '1.2.5.0')).toEqual([]);
    expect(checkChangelog(r.text, '1.2.6.0').map(e => e.code)).toEqual(['CHANGELOG_TOP_MISMATCH']);
    expect(checkChangelog(r.text + '\n## [1.2.3.0] - 2026-10-02\n\n- dup\n', '1.2.5.0').map(e => e.code)).toEqual(['CHANGELOG_DUPLICATE_HEADING']);
    // A duplicate the base already carries is inherited history, not the PR's; one more copy still is.
    const dupBase = '# Changelog\n\n## [1.2.3.0] - 2026-10-01\n\n- base\n\n## [1.2.3.0] - 2026-10-02\n\n- dup\n';
    const prText = '# Changelog\n\n## [1.2.5.0] - 2026-10-10\n\n- mine\n\n' + dupBase.slice('# Changelog\n\n'.length);
    expect(checkChangelog(prText, '1.2.5.0')).toHaveLength(1);
    expect(checkChangelog(prText, '1.2.5.0', 'CHANGELOG.md', [dupBase])).toEqual([]);
    const third = checkChangelog(prText + '\n## [1.2.3.0] - 2026-10-03\n\n- third\n', '1.2.5.0', 'CHANGELOG.md', [dupBase]);
    expect(third.map(e => [e.code, e.path])).toEqual([['CHANGELOG_DUPLICATE_HEADING', 'CHANGELOG.md:15']]);
    expect(third[0]!.message).toBe('1.2.3.0 headed 3 times (the base carries it 2 times; first at line 7)');
    expect(checkChangelog(prText + '\n## [1.2.5.0] - 2026-10-11\n\n- again\n', '1.2.5.0', 'CHANGELOG.md', [dupBase]).map(e => e.message)).toEqual(['1.2.5.0 already headed at line 3']);
    // Several readings of the base (its tip and the fork point) grant the larger count; an [Unreleased]
    // placeholder the base keeps is inherited like any heading, and a second one is still the PR's.
    const collapsed = '# Changelog\n\n## [1.2.3.0] - 2026-10-01\n\n- base, merged copy\n';
    expect(checkChangelog(prText, '1.2.5.0', 'CHANGELOG.md', [collapsed, dupBase])).toEqual([]);
    expect(checkChangelog(prText, '1.2.5.0', 'CHANGELOG.md', [collapsed])).toHaveLength(1);
    expect(checkChangelog(prText, '1.2.5.0', 'CHANGELOG.md', [])).toHaveLength(1);
    const placeholders = '# Changelog\n\n## [Unreleased]\n\n## [Unreleased]\n\n## [1.2.3.0] - 2026-10-01\n\n- base\n';
    expect(checkChangelog(placeholders, null, 'CHANGELOG.md', [placeholders])).toEqual([]);
    expect(checkChangelog(placeholders, null)).toHaveLength(1);
    expect(checkChangelog(placeholders + '\n## [Unreleased]\n\n- mine\n', null, 'CHANGELOG.md', [placeholders]).map(e => e.message)).toEqual(['Unreleased headed 3 times (the base carries it 2 times; first at line 3)']);
    expect(reheadChangelog(r.text, { from: '1.2.5.0', to: '1.2.5.0', date: 'x' }).moved).toBe(false);
    expect(reheadChangelog('# Changelog\n\n## [1.2.3.0] - d\n\n- base\n', { from: '9.9.9.9', to: '1.2.5.0', date: 'x' }).error?.code).toBe('CHANGELOG_SECTION_MISSING');
    expect(normalizeChangelog(r.text)).toBe(normalizeChangelog(text.replace('[Unreleased]', '[1.2.9.0] - 2026-10-11')));
    expect(normalizeChangelog(r.text)).not.toBe(normalizeChangelog(r.text.replace('- mine', '- mine edited')));
    const merged = mergeChangelogs('# Changelog\n\n## [Unreleased]\n\n- b\n\n## [1.2.3.0] - d\n\n- base\n', '# Changelog\n\n## [1.2.4.0] - d\n\n- a\n\n## [1.2.3.0] - d\n\n- base\n');
    expect(merged).toBe('# Changelog\n\n## [Unreleased]\n\n- b\n\n## [1.2.4.0] - d\n\n- a\n\n## [1.2.3.0] - d\n\n- base\n');
    expect(mergeChangelogs('# C\n\n## [Unreleased]\n\n- b\n', '# C\n\n## [Unreleased]\n\n- a\n')).toBeNull();
  });
});

describe('three PRs, reordered twice, zero manual edits', () => {
  test('stamp-at-merge: each PR stamps from main at its turn; since:/vX text, CHANGELOG order and journals follow', () => {
    const repo = fixture();
    makePr(repo, 'pr-a', { expects: '1.2.4.0' });
    makePr(repo, 'pr-b', { expects: '1.2.4.0' });
    makePr(repo, 'pr-c', { expects: '1.2.4.0' });

    // A is next.
    repo.git('checkout', '-q', 'pr-a');
    const a = restamp(repo, ['--next', '--pr', '1']);
    expect(a.status).toBe(EXIT.ok);
    expect(a.out).toContain('ship, next in queue at 1.2.4.0');
    expect(a.out).toContain('claims: ignored (stamp-at-merge)');
    // Under a train the stamp commit may hold only restamp's own output: the next: line must not ask the lane
    // to edit the CHANGELOG by hand (a lane that did was refused by the train's verify, freezing the queue).
    // Value: protects=restamp's stamp-at-merge handoff never instructs a hand edit of CHANGELOG; fails_when=the
    // claim-at-open wording ("write the CHANGELOG entry text") leaks into the train path; why_new=the earlier
    // assertion pinned that wording as the contract; seam=none; no_claim=nothing about the lane obeying it.
    expect(a.out).toMatch(/^next: NEW_VERSION=1\.2\.4\.0; commit and push only the stamp diff above \(FILES\), with no edit of your own: .*expected head [0-9a-f]{40}/m);
    expect(a.out).not.toMatch(/write the CHANGELOG|entry text|release summary/i);
    expect(stages(a.out)).toMatchObject({ version: 'done', release_tool: 'done', changelog: 'done', stamp_paths: 'skipped', apply: 'done' });
    expect(readFile(repo, 'VERSION')).toBe('1.2.4.0\n');
    expect(readFile(repo, 'generated/digest.md')).toBe('# digest v1.2.4.0\nbody\n');
    expect(topHeading(repo)).toMatch(/^## \[1\.2\.4\.0\] - \d{4}-\d{2}-\d{2}$/);
    expect(JSON.parse(readFile(repo, 'package.json')).version).toBe('1.2.4');
    expect(JSON.parse(readFile(repo, 'package-lock.json')).packages[''].version).toBe('1.2.4');
    const journal = JSON.parse(readFile(repo, '.gstack/tmp/restamp-journal.json'));
    expect(journal.status).toBe('complete');
    expect(journal.inputs).toMatchObject({ old_version: '1.2.3.0', new_version: '1.2.4.0', queue_mode: 'stamp-at-merge' });
    expect(journal.stages.map((s: any) => s.name)).toEqual(['version', 'release_tool', 'changelog', 'stamp_paths', 'mirror', 'apply']);
    expect(journal.stages.at(-1).writes.every((w: any) => w.applied && w.post_sha256)).toBe(true);
    // Idempotent.
    const again = restamp(repo, ['--next', '--pr', '1']);
    expect(again.out).toMatch(/^RESTAMP: 1\.2\.4\.0 -> 1\.2\.4\.0 \(noop;/m);
    expect(again.out).toContain('FILES: (none)');
    repo.git('commit', '-qam', 'stamp a');
    mergeToMain(repo, 'pr-a');

    // Reorder 1: C jumps ahead of B. C wrote docs for 1.2.4.0; main is 1.2.4.0 now, so 1.2.4.0 is released and its docs mention must move to 1.2.5.0.
    repo.git('checkout', '-q', 'pr-c');
    mergeMain(repo);
    const c = restamp(repo, ['--next', '--pr', '3']);
    expect(c.status).toBe(EXIT.ok);
    expect(c.out).toContain('STAMP_VERSION: 1.2.5.0');
    expect(stages(c.out).stamp_paths).toBe('done');
    expect(readFile(repo, 'docs/pr-c.md')).toBe('since: 1.2.5.0\nRequires v1.2.5.0 or later.\n');
    expect(readFile(repo, 'docs/notes.md')).toBe('Previous release v1.2.3.0.\nleft-pad pinned at 1.2.3 (was 1.2.2)\n');
    expect(headings(repo).slice(0, 3)).toEqual(['1.2.5.0', '1.2.4.0', '1.2.3.0']);
    repo.git('commit', '-qam', 'stamp c');
    mergeToMain(repo, 'pr-c');

    // Reorder 2: B was once "next"; it is last now and goes 1.2.6.0.
    repo.git('checkout', '-q', 'pr-b');
    mergeMain(repo);
    const b = restamp(repo, ['--next', '--pr', '2']);
    expect(b.status).toBe(EXIT.ok);
    expect(b.out).toContain('ship, next in queue at 1.2.6.0');
    expect(readFile(repo, 'docs/pr-b.md')).toBe('since: 1.2.6.0\nRequires v1.2.6.0 or later.\n');
    expect(headings(repo).slice(0, 4)).toEqual(['1.2.6.0', '1.2.5.0', '1.2.4.0', '1.2.3.0']);
    // A later tentative stamp on the branch itself is rewritten exactly, and the re-stamp is a pure stamp for the receipt.
    repo.git('commit', '-qam', 'stamp b');
    const gated = repo.git('rev-parse', 'HEAD');
    const b2 = restamp(repo, ['--version', '1.2.7.0', '--pr', '2']);
    expect(b2.status).toBe(EXIT.ok);
    expect(stages(b2.out).stamp_paths).toBe('done');
    expect(b2.out).toContain('(1.2.6.0 -> 1.2.7.0)');
    expect(readFile(repo, 'docs/pr-b.md')).toBe('since: 1.2.7.0\nRequires v1.2.7.0 or later.\n');
    expect(headings(repo)[0]).toBe('1.2.7.0');
    repo.git('commit', '-qam', 'restamp b');
    const receipt = runBin(repo, 'gstack-tree-receipt', ['--gated', gated, '--base', 'main', '--json']);
    const parsed = JSON.parse(receipt.out);
    expect(parsed.tree).toBe('same-modulo-stamps');
    expect(parsed.files.map((f: any) => `${f.path}:${f.verdict}:${f.rule}`).sort()).toEqual([
      'CHANGELOG.md:stamp:changelog-heading', 'VERSION:stamp:version-file', 'docs/pr-b.md:stamp:stamp_paths', 'generated/digest.md:stamp:release_outputs',
      'package-lock.json:stamp:lockfile-root-version', 'package.json:stamp:manifest-version',
    ]);
    expect(parsed.gate_reuse).toBe('not-eligible');
    expect(parsed.gate_reuse_reason).toContain('no evidence bundle');
    expect(receipt.out).not.toContain('TREE:');
    // A real edit after the gate is a change.
    fs.appendFileSync(path.join(repo.work, 'pr-b.txt'), 'more\n');
    repo.git('commit', '-qam', 'edit');
    const changed = runBin(repo, 'gstack-tree-receipt', ['--gated', gated, '--base', 'main']);
    expect(changed.status).toBe(EXIT.fail);
    expect(changed.out).toMatch(/^TREE: changed \(pr-b\.txt\)$/m);
    expect(changed.out).toMatch(/^gate-reuse: not-eligible \(tree changed: pr-b\.txt\) — fix: .* \(GATE_REUSE_NOT_ELIGIBLE\)$/m);
  });

  test('--dry-run prints the full diff and writes nothing; --was overrides the mention source', () => {
    const repo = fixture();
    makePr(repo, 'pr-a', { expects: '1.9.0.0' });
    const r = restamp(repo, ['--next', '--dry-run', '--was', '1.9.0.0']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^-since: 1\.9\.0\.0$/m);
    expect(r.out).toMatch(/^\+since: 1\.2\.4\.0$/m);
    expect(r.out).toMatch(/^-## \[Unreleased\]$/m);
    expect(repo.git('status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(repo.work, '.gstack', 'tmp', 'restamp-journal.json'))).toBe(false);
  });

  test('legacy claim-at-open: --next reads the claim queue (unverified falls back to arithmetic) and says so', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, queue_mode: 'claim-at-open' } });
    makePr(repo, 'pr-a');
    const r = restamp(repo, ['--next', '--dry-run']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('queue_mode=claim-at-open');
    expect(r.out).toMatch(/^claims: (read \(claim-at-open|unverified \(claim-at-open)/m);
    expect(r.out).not.toContain('ship, next in queue at');
    const forced = restamp(repo, ['--next', '--dry-run', '--queue-mode', 'stamp-at-merge']);
    expect(forced.out).toContain('claims: ignored (stamp-at-merge)');
    // claim-at-open's bump still writes the entry text at /ship's CHANGELOG step; only the train path drops the ask.
    const stamped = restamp(repo, ['--next']);
    expect(stamped.status).toBe(EXIT.ok);
    expect(stamped.out).toMatch(/^next: NEW_VERSION=1\.2\.4\.0; record the release decision, then write the CHANGELOG entry text only/m);
  });

  // Value: protects=a bump never repo's --next never invents a MICRO stamp: without --bump or --version it refuses and writes nothing, and an explicit level stamps as before; fails_when=restamp falls back to micro for a repo whose policy names no level;
  //   why_new=GST-380 added bump never; seam=gstack-ship-policy, gstack-version-bump write; no_claim=the claim queue read
  test('bump never: --next without a level is RESTAMP_VERSION_SOURCE with nothing written; --bump stamps', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, queue_mode: 'claim-at-open', bump: 'never', min_gstack_version: BUMP_NEVER_KEY_VERSION } });
    makePr(repo, 'pr-a');
    const before = readFile(repo, 'VERSION');
    const r = restamp(repo, ['--next']);
    expect([r.status, /bump never names no level.*nothing written.*\(RESTAMP_VERSION_SOURCE\)/.test(r.err)]).toEqual([3, true]);
    expect(readFile(repo, 'VERSION')).toBe(before);
    expect(restamp(repo, ['--next', '--bump', 'patch', '--dry-run']).status).toBe(EXIT.ok);
  });

  test('claim-at-open with an unknown claim says incomplete, names the PR and never says read', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, queue_mode: 'claim-at-open' }, prefix: 'gstack-restamp-github.com-' });
    makePr(repo, 'pr-a');
    const shim = path.join(repo.root, 'gh-unknown-claim');
    fs.mkdirSync(shim);
    const list = JSON.stringify([41, 42].map(n => ({ number: n, headRefName: `pr-${n}`, headRepositoryOwner: { login: 'o' }, url: `https://github.com/o/r/pull/${n}`, isDraft: false })));
    fs.writeFileSync(path.join(shim, 'gh'), [
      '#!/bin/sh',
      'case "$*" in',
      `  "pr list --state open --base main --limit 200 --json number,headRefName,headRepositoryOwner,url,isDraft") printf '%s\\n' '${list}'; exit 0 ;;`,
      "  \"repo view --json owner -q .owner.login\") echo o; exit 0 ;;",
      `  "api repos/{owner}/{repo}/contents/VERSION?ref=pr-41 -q .content") echo '${Buffer.from('1.2.5.0\n').toString('base64')}'; exit 0 ;;`,
      "  \"api repos/{owner}/{repo}/contents/VERSION?ref=pr-42 -q .content\") echo 'gh: Server Error (HTTP 502)' >&2; exit 1 ;;",
      'esac',
      'exit 2',
      '',
    ].join('\n'), { mode: 0o755 });
    const r = restamp(repo, ['--next', '--dry-run'], { PATH: `${shim}:${process.env.PATH ?? ''}` });
    expect(r.status, r.err).toBe(EXIT.ok);
    expect(r.out).toContain('STAMP_VERSION: 1.2.6.0');
    expect(r.out).toContain('claims: incomplete (claim-at-open; the VERSION claims of PR #42 are unknown, so 1.2.6.0 is provisional and may collide; rerun, then ask the coordinator before stamping; queue [');
    expect(r.out).not.toMatch(/^claims: read/m);
  });
});

describe('CHANGELOG duplicates and the base branch', () => {
  const dupHistory = (repo: FixtureRepo) => {
    const cl = readFile(repo, 'CHANGELOG.md');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), cl + '\n## [1.2.2.0] - 2026-09-02\n\n- older, headed a second time on main\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'history with a duplicate heading'); repo.git('push', '-q', 'origin', 'main');
  };

  test('a duplicate heading the base already carries is not the PR\'s: the stamp proceeds and keeps both copies', () => {
    const repo = fixture();
    dupHistory(repo);
    expect(headings(repo)).toEqual(['1.2.3.0', '1.2.2.0', '1.2.2.0']);
    makePr(repo, 'pr-a');
    const r = restamp(repo, ['--next', '--pr', '1']);
    expect(r.status).toBe(EXIT.ok);
    expect(stages(r.out).changelog).toBe('done');
    expect(headings(repo)).toEqual(['1.2.4.0', '1.2.3.0', '1.2.2.0', '1.2.2.0']);
    expect(readFile(repo, 'VERSION')).toBe('1.2.4.0\n');
  });

  test('a duplicate heading the PR introduces is still CHANGELOG_DUPLICATE_HEADING with nothing written, base duplicates or not', () => {
    const repo = fixture();
    dupHistory(repo);
    makePr(repo, 'pr-a');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), readFile(repo, 'CHANGELOG.md') + '\n## [1.2.2.0] - 2026-09-03\n\n- a third copy, added by the PR\n');
    repo.git('commit', '-q', '-am', 'pr adds a duplicate');
    const r = restamp(repo, ['--next', '--pr', '1']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/CHANGELOG\.md:\d+: 1\.2\.2\.0 headed 3 times \(the base carries it 2 times; first at line \d+\); nothing written.*\(CHANGELOG_DUPLICATE_HEADING\)/);
    expect(readFile(repo, 'VERSION')).toBe('1.2.3.0\n');
    expect(headings(repo)).toEqual(['Unreleased', '1.2.3.0', '1.2.2.0', '1.2.2.0', '1.2.2.0']);

    const plain = fixture();
    makePr(plain, 'pr-b');
    fs.writeFileSync(path.join(plain.work, 'CHANGELOG.md'), readFile(plain, 'CHANGELOG.md') + '\n## [1.2.2.0] - 2026-09-03\n\n- second copy, added by the PR\n');
    plain.git('commit', '-q', '-am', 'pr adds a duplicate');
    const p = restamp(plain, ['--next', '--pr', '1']);
    expect(p.status).toBe(EXIT.refused);
    expect(p.err).toMatch(/1\.2\.2\.0 already headed at line \d+; nothing written.*\(CHANGELOG_DUPLICATE_HEADING\)/);
    expect(readFile(plain, 'VERSION')).toBe('1.2.3.0\n');
  });

  // Value: protects=a PR forked while main headed a version twice still stamps after main collapsed the copies into
  // one, because the allowance reads the fork point as well as the tip; fails_when=restamp reads only plan.baseSha;
  // why_new=the other rows never move main after makePr; seam=none; no_claim=nothing about a duplicate main gained
  // after the fork (the tip reading grants it, and the train merge dedups by heading).
  test('a duplicate main collapsed after the fork is still inherited: the merge-base reading keeps the stamp going', () => {
    const repo = fixture();
    dupHistory(repo);
    makePr(repo, 'pr-a');
    repo.git('checkout', '-q', 'main');
    const cl = readFile(repo, 'CHANGELOG.md').replace('\n## [1.2.2.0] - 2026-09-02\n\n- older, headed a second time on main\n', '');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), cl);
    repo.git('commit', '-q', '-am', 'collapse the duplicate'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'pr-a');
    expect(headings(repo)).toEqual(['Unreleased', '1.2.3.0', '1.2.2.0', '1.2.2.0']);
    const r = restamp(repo, ['--next', '--pr', '1']);
    expect(r.status).toBe(EXIT.ok);
    expect(headings(repo)).toEqual(['1.2.4.0', '1.2.3.0', '1.2.2.0', '1.2.2.0']);
  });

  // Value: protects=a base with no CHANGELOG at all (the PR introduces the file) stamps, and the refusal for a
  // duplicate the new file carries says the base reading was unavailable; fails_when=the git show failure is
  // treated as an error, or the fallback to the self-contained rule is silent; why_new=every fixture seeds
  // CHANGELOG.md on main; seam=none; no_claim=other git show failures are not distinguished from an absent file.
  test('no CHANGELOG at the base: the PR\'s new file is checked against itself and the detail says so', () => {
    const repo = fixture();
    repo.git('rm', '-q', 'CHANGELOG.md'); repo.git('commit', '-q', '-m', 'no changelog yet'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'origin/main', '-b', 'pr-a');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- first entry\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'add changelog');
    const r = restamp(repo, ['--next', '--pr', '1']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^stage changelog: done \(Unreleased -> 1\.2\.4\.0; base CHANGELOG\.md unreadable at [0-9a-f]{12}:CHANGELOG\.md, so every duplicate heading counts\)$/m);
    expect(headings(repo)).toEqual(['1.2.4.0']);

    const dup = fixture();
    dup.git('rm', '-q', 'CHANGELOG.md'); dup.git('commit', '-q', '-m', 'no changelog yet'); dup.git('push', '-q', 'origin', 'main');
    dup.git('checkout', '-q', 'origin/main', '-b', 'pr-b');
    fs.writeFileSync(path.join(dup.work, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- first entry\n\n## [0.9.0.0] - d\n\n- a\n\n## [0.9.0.0] - d\n\n- b\n');
    dup.git('add', '-A'); dup.git('commit', '-q', '-m', 'add changelog with a duplicate');
    const d = restamp(dup, ['--next', '--pr', '1']);
    expect(d.status).toBe(EXIT.refused);
    expect(d.err).toMatch(/0\.9\.0\.0 already headed at line \d+; base CHANGELOG\.md unreadable at [0-9a-f]{12}:CHANGELOG\.md, so every duplicate heading counts; nothing written.*\(CHANGELOG_DUPLICATE_HEADING\)/);
    expect(fs.existsSync(path.join(dup.work, 'VERSION')) && readFile(dup, 'VERSION')).toBe('1.2.3.0\n');
  });

  // Value: protects=when only one base reading exists (main gained the CHANGELOG after the fork), inherited
  // headings are still counted from it and the detail names the reading that was used; fails_when=the note
  // claims every duplicate counts while the readable reading granted an allowance, or the unreadable reading
  // is treated as an error; why_new=the other rows read the same sha twice; seam=none; no_claim=nothing about
  // a file renamed between the two readings.
  test('one readable base reading: inherited headings count from it and the detail says so', () => {
    const repo = fixture();
    repo.git('rm', '-q', 'CHANGELOG.md'); repo.git('commit', '-q', '-m', 'no changelog yet'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'origin/main', '-b', 'pr-a');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- mine\n\n## [0.9.0.0] - d\n\n- a\n\n## [0.9.0.0] - d\n\n- b\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'pr adds the changelog, carrying history with a duplicate');
    repo.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), '# Changelog\n\n## [0.9.0.0] - d\n\n- a\n\n## [0.9.0.0] - d\n\n- b\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'main adds the changelog too'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'pr-a');
    const r = restamp(repo, ['--next', '--pr', '1']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^stage changelog: done \(Unreleased -> 1\.2\.4\.0; base CHANGELOG\.md unreadable at [0-9a-f]{12}:CHANGELOG\.md, inherited headings counted at [0-9a-f]{12} only\)$/m);
    expect(headings(repo)).toEqual(['1.2.4.0', '0.9.0.0', '0.9.0.0']);
  });
});

describe('journal and injected failures', () => {
  for (const stage of ['version', 'release_tool', 'changelog', 'stamp_paths']) {
    test(`a failure after the ${stage} stage leaves the branch untouched and the staging worktree removed`, () => {
      const repo = fixture();
      makePr(repo, 'pr-a', { expects: '1.2.4.0' });
      const before = repo.git('status', '--porcelain');
      const r = restamp(repo, ['--version', '1.2.5.0'], { GSTACK_RESTAMP_FAIL_AFTER: stage });
      expect(r.status).toBe(EXIT.fail);
      expect(r.err).toMatch(new RegExp(`injected failure after ${stage}.*\\(RESTAMP_CONFLICT\\)`));
      expect(r.out).toMatch(/GSTACK_RESULT: skill=restamp status=incomplete/);
      expect(repo.git('status', '--porcelain')).toBe(before);
      expect(readFile(repo, 'VERSION')).toBe('1.2.3.0\n');
      expect(repo.git('worktree', 'list').split('\n')).toHaveLength(1);
    });
  }

  test('a failure mid-apply rolls back the applied writes, records it, and a rerun completes the stamp', () => {
    const repo = fixture();
    makePr(repo, 'pr-a', { expects: '1.2.4.0' });
    const r = restamp(repo, ['--version', '1.2.5.0'], { GSTACK_RESTAMP_FAIL_AFTER: 'apply:2' });
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toMatch(/injected failure after apply:2; rolled back 2 write\(s\).*\(RESTAMP_CONFLICT\)/);
    expect(repo.git('status', '--porcelain')).toBe('');
    const journal = JSON.parse(readFile(repo, '.gstack/tmp/restamp-journal.json'));
    expect(journal.status).toBe('rolled_back');
    expect(journal.stages.at(-1).writes.filter((w: any) => w.applied)).toHaveLength(0);
    const again = restamp(repo, ['--version', '1.2.5.0']);
    expect(again.status).toBe(EXIT.ok);
    expect(readFile(repo, 'VERSION')).toBe('1.2.5.0\n');
    expect(readFile(repo, 'docs/pr-a.md')).toContain('since: 1.2.5.0');
    expect(JSON.parse(readFile(repo, '.gstack/tmp/restamp-journal.json')).status).toBe('complete');
  });

  test('an edit to a stamp file while the restamp stages is RESTAMP_CONFLICT: the preimage check refuses and nothing is applied', async () => {
    const repo = fixture({ policy: { ...BASE_POLICY, release_tool: 'node gen.js && while [ ! -f "$GSTACK_TEST_GO" ]; do sleep 0.05; done' } });
    makePr(repo, 'pr-a', { expects: '1.2.4.0' });
    const go = path.join(repo.root, 'go');
    const { spawn } = await import('node:child_process');
    const child = spawn(path.join(path.resolve(import.meta.dir, '..'), 'bin', 'gstack-restamp'), ['--base', 'main', '--allow-repo-commands', '--version', '1.2.5.0'], { cwd: repo.work, env: { ...process.env, ...repo.env, GSTACK_TEST_GO: go }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(path.join(repo.work, 'generated', 'digest.md')) || repo.git('worktree', 'list').split('\n').length < 2) {
      if (Date.now() > deadline) throw new Error('staging worktree never appeared');
      await new Promise(r => setTimeout(r, 50));
    }
    fs.appendFileSync(path.join(repo.work, 'docs', 'pr-a.md'), 'edited meanwhile\n');
    fs.writeFileSync(go, '1');
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(EXIT.fail);
    expect(err).toMatch(/docs\/pr-a\.md changed in the working tree while the restamp staged.*\(RESTAMP_CONFLICT\)/);
    expect(out).toMatch(/status=incomplete/);
    expect(readFile(repo, 'VERSION')).toBe('1.2.3.0\n');
    expect(readFile(repo, 'docs/pr-a.md')).toContain('edited meanwhile');
    expect(repo.git('worktree', 'list').split('\n')).toHaveLength(1);
  }, 30_000);
});

describe('gate-ahead (--after), predecessor movement and queue staleness', () => {
  test('a squash-history PR gates ahead of its predecessor: the branch is untouched, the synthetic tree carries N+1 above the predecessor entry, and the record binds the evidence branch key', () => {
    const repo = fixture();
    const aHead = makePr(repo, 'pr-a', { expects: '1.2.4.0' });
    repo.git('checkout', '-q', 'pr-a');
    expect(restamp(repo, ['--next', '--pr', '1']).status).toBe(EXIT.ok);
    repo.git('commit', '-qam', 'stamp a');
    const aStamped = repo.git('rev-parse', 'HEAD');
    const bHead = makePr(repo, 'pr-b', { expects: '1.2.4.0' });
    expect(repo.git('rev-list', '--count', 'origin/main..HEAD')).toBe('1');
    const r = restamp(repo, ['--after', '1', '--predecessor-ref', 'pr-a', '--pr', '2']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('STAMP_VERSION: 1.2.5.0');
    expect(r.out).toContain('claims: ignored (gate-ahead relative to predecessor)');
    expect(r.out).toMatch(/^next: run the verification gate in .*gate-ahead-worktree, then `gstack-evidence bundle --out <file>` there/m);
    expect(r.out).toMatch(/^GATE_AHEAD: head=[0-9a-f]{40} tree=[0-9a-f]{40} predecessor=#1@[0-9a-f]{12} worktree=.* evidence_branch=pr-b$/m);
    expect(repo.git('rev-parse', 'HEAD')).toBe(bHead);
    expect(repo.git('status', '--porcelain')).toBe('');
    expect(repo.git('rev-list', '--count', 'origin/main..HEAD')).toBe('1');
    const rec = JSON.parse(readFile(repo, '.gstack/tmp/gate-ahead.json'));
    expect(rec).toMatchObject({ schema_version: 1, pr: '2', predecessor_pr: '1', predecessor_head: aStamped, branch_head: bHead, version: '1.2.5.0', evidence_branch_key: 'pr-b' });
    expect(rec.gated_head).not.toBe(bHead);
    const show = (rel: string) => runBin(repo, 'gstack-restamp', ['--help'], {}, repo.work) && repo.git('show', `${rec.gated_head}:${rel}`);
    expect(show('VERSION')).toBe('1.2.5.0');
    expect(show('docs/pr-b.md')).toBe('since: 1.2.5.0\nRequires v1.2.5.0 or later.');
    expect(show('CHANGELOG.md').split('\n').filter(l => l.startsWith('## ')).slice(0, 2).join('|')).toMatch(/^## \[1\.2\.5\.0\] - .*\|## \[1\.2\.4\.0\] - /);
    expect(aHead).not.toBe(aStamped);

    // The gate runs in the worktree and exports a bundle; after the real merge + restamp the receipt is eligible except for stamp-sensitive lanes.
    const bundle = path.join(repo.root, 'bundle.json');
    recordAndBundle(repo, rec.worktree, [{ label: 'tests', command: 'true' }, { label: 'digest', command: 'cat generated/digest.md' }], bundle);
    mergeToMain(repo, 'pr-a');
    repo.git('checkout', '-q', 'pr-b');
    mergeMain(repo);
    expect(restamp(repo, ['--next', '--pr', '2']).status).toBe(EXIT.ok);
    repo.git('commit', '-qam', 'stamp b');
    const receipt = runBin(repo, 'gstack-tree-receipt', ['--from', path.join(repo.work, '.gstack/tmp/gate-ahead.json'), '--predecessor-ref', 'pr-a', '--bundle', bundle, '--base', 'main']);
    expect(receipt.status).toBe(EXIT.ok);
    expect(receipt.out).toMatch(/^TREE: same-modulo-stamps$/m);
    expect(receipt.out).toMatch(/^gate-reuse: eligible \(reusable: tests; rerun: digest\)$/m);
    expect(receipt.out).toMatch(/^  gate digest: rerun \(stamp-sensitive/m);
    const json = JSON.parse(runBin(repo, 'gstack-tree-receipt', ['--from', path.join(repo.work, '.gstack/tmp/gate-ahead.json'), '--predecessor-ref', 'pr-a', '--bundle', bundle, '--base', 'main', '--json']).out);
    expect(json.gated_tree).toBe(json.current_tree);
    expect(json.predecessor).toMatchObject({ pr: '1', recorded_head: aStamped, current_head: aStamped, moved: false });

    // PREDECESSOR MOVED: the predecessor PR gains a commit after the gate.
    repo.git('checkout', '-q', 'pr-a');
    fs.appendFileSync(path.join(repo.work, 'pr-a.txt'), 'late\n');
    repo.git('commit', '-qam', 'late fix');
    repo.git('checkout', '-q', 'pr-b');
    const moved = runBin(repo, 'gstack-tree-receipt', ['--from', path.join(repo.work, '.gstack/tmp/gate-ahead.json'), '--predecessor-ref', 'pr-a', '--bundle', bundle, '--base', 'main']);
    expect(moved.status).toBe(EXIT.fail);
    expect(moved.out).toMatch(/^PREDECESSOR MOVED [0-9a-f]{40} -> [0-9a-f]{40} — fix: gstack-restamp --after 1 again \(RESTAMP_PREDECESSOR_MOVED\)$/m);
    expect(moved.out).toMatch(/^gate-reuse: not-eligible \(PREDECESSOR MOVED/m);
    const viaGh = runBin(repo, 'gstack-tree-receipt', ['--from', path.join(repo.work, '.gstack/tmp/gate-ahead.json'), '--predecessor-pr', '1', '--bundle', bundle, '--base', 'main', '--json'], ghShim(repo, { '1': { headRefOid: repo.git('rev-parse', 'pr-a') } }));
    expect(JSON.parse(viaGh.out).predecessor.moved).toBe(true);
    expect(JSON.parse(viaGh.out).code).toBe('RESTAMP_PREDECESSOR_MOVED');
  });

  test('a gate-ahead merge that conflicts outside the stamp files is RESTAMP_MERGE_CONFLICT with nothing written', () => {
    const repo = fixture();
    makePr(repo, 'pr-a', { file: 'shared.txt' });
    makePr(repo, 'pr-b', { file: 'shared.txt' });
    const r = restamp(repo, ['--after', '1', '--predecessor-ref', 'pr-a', '--pr', '2']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/conflicts in .*shared\.txt; nothing written.*\(RESTAMP_MERGE_CONFLICT\)/);
    expect(fs.existsSync(path.join(repo.work, '.gstack', 'tmp', 'gate-ahead.json'))).toBe(false);
    expect(repo.git('worktree', 'list').split('\n')).toHaveLength(1);
  });

  test('two coordinators: --expect-base catches a base that moved between validation and merge (QUEUE_STALE, recompute command, nothing written)', () => {
    const repo = fixture();
    makePr(repo, 'pr-a');
    makePr(repo, 'pr-b');
    const assumed = repo.git('rev-parse', 'origin/main');
    repo.git('checkout', '-q', 'pr-a');
    expect(restamp(repo, ['--next', '--pr', '1', '--expect-base', assumed.slice(0, 12)]).status).toBe(EXIT.ok);
    repo.git('commit', '-qam', 'stamp a');
    mergeToMain(repo, 'pr-a');
    repo.git('checkout', '-q', 'pr-b');
    const r = restamp(repo, ['--next', '--pr', '2', '--expect-base', assumed.slice(0, 12), '--json']);
    expect(r.status).toBe(EXIT.refused);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ status: 'refused', code: 'QUEUE_STALE', expected: { base: assumed.slice(0, 12) } });
    expect(j.actual.base).toBe(repo.git('rev-parse', 'origin/main'));
    expect(j.recompute).toMatch(/^gstack-restamp --next --base main --expect-base [0-9a-f]{12} --pr 2$/);
    expect(repo.git('status', '--porcelain')).toBe('');
    const text = restamp(repo, ['--next', '--pr', '2', '--expect-base', assumed.slice(0, 12)]);
    expect(text.err).toMatch(/base moved.*\(QUEUE_STALE\)\nrecompute: gstack-restamp --next/);
    expect(text.out).toMatch(/status=refused/);
    const ok = restamp(repo, ['--next', '--pr', '2', '--expect-base', repo.git('rev-parse', 'origin/main')]);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toMatch(/^MERGE_CONDITION: sha=[0-9a-f]{40}$/m);
  });

  test('--expect-order: an unmerged predecessor or a merged successor is QUEUE_STALE; the assumed order is re-validated through gh', () => {
    const repo = fixture();
    makePr(repo, 'pr-a');
    makePr(repo, 'pr-b');
    repo.git('checkout', '-q', 'pr-a');
    expect(restamp(repo, ['--next', '--pr', '1']).status).toBe(EXIT.ok);
    repo.git('commit', '-qam', 'stamp a');
    const aMerge = mergeToMain(repo, 'pr-a');
    repo.git('checkout', '-q', 'pr-b');
    const merged = { state: 'MERGED', mergeCommit: { oid: aMerge }, headRefOid: repo.git('rev-parse', 'pr-a') };
    const open = { state: 'OPEN', mergeCommit: null, headRefOid: 'x' };
    const good = restamp(repo, ['--next', '--pr', '2', '--expect-order', '1,2,3', '--dry-run'], ghShim(repo, { '1': merged, '3': open }));
    expect(good.status).toBe(EXIT.ok);
    const stale = restamp(repo, ['--next', '--pr', '2', '--expect-order', '1,2,3', '--json'], ghShim(repo, { '1': merged, '3': merged }));
    expect(stale.status).toBe(EXIT.refused);
    expect(JSON.parse(stale.out)).toMatchObject({ code: 'QUEUE_STALE', actual: { prs: { '1': 'merged', '3': 'merged' } } });
    // The recompute is the corrected order (merged PRs dropped), never the stale list again.
    expect(JSON.parse(stale.out).recompute).toMatch(/ --pr 2 --expect-order 2$/);
    const unmerged = restamp(repo, ['--next', '--pr', '2', '--expect-order', '1,4,2', '--json'], ghShim(repo, { '1': merged, '4': open }));
    expect(JSON.parse(unmerged.out)).toMatchObject({ code: 'QUEUE_STALE', actual: { prs: { '4': 'open' } } });
    expect(JSON.parse(unmerged.out).message).toContain('#4 must merge before this PR stamps');
    expect(JSON.parse(unmerged.out).recompute).toMatch(/ --expect-order 4,2$/);
    // A predecessor GitHub calls merged that the local base does not carry yet (the slot call came before the lane fetched)
    // stays ahead in the recompute: dropping it would let --next allocate from the stale base the version it already took.
    const unfetched = { state: 'MERGED', mergeCommit: { oid: repo.git('rev-parse', 'pr-b') }, headRefOid: 'y' };
    const stale2 = restamp(repo, ['--next', '--pr', '2', '--expect-order', '1,4,2', '--json'], ghShim(repo, { '1': merged, '4': unfetched }));
    expect(JSON.parse(stale2.out)).toMatchObject({ code: 'QUEUE_STALE', actual: { prs: { '4': 'merged-not-in-base' } }, fix: 'git fetch origin main' });
    expect(JSON.parse(stale2.out).message).toContain('#4 merged but the local main does not carry the merge yet: git fetch origin main, then rerun');
    expect(JSON.parse(stale2.out).recompute).toMatch(/ --expect-order 4,2$/);
  });

  // The slot-call lesson (GSTA-123, 2026-10-27): a lane given "remaining order 3487" ran --expect-order 3487 without its own
  // PR, so every entry read as an unmerged predecessor and the refusal repeated the same list as its recompute.
  test('--expect-order without the lane\'s own PR: the refusal says so and the recompute lists this PR first, then the remaining order', () => {
    const repo = fixture();
    makePr(repo, 'pr-a');
    makePr(repo, 'pr-b');
    repo.git('checkout', '-q', 'pr-a');
    const open = { state: 'OPEN', mergeCommit: null, headRefOid: 'x' };
    const r = restamp(repo, ['--next', '--pr', '1', '--expect-order', '2,3', '--json'], ghShim(repo, { '2': open, '3': open }));
    expect(r.status).toBe(EXIT.refused);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ code: 'QUEUE_STALE', actual: { prs: { '2': 'open', '3': 'open' } } });
    expect(j.message).toContain('--pr 1 is not in --expect-order, so every listed PR read as a predecessor: list this PR first, then the remaining order');
    expect(j.recompute).toMatch(/^gstack-restamp --next --base main --expect-base [0-9a-f]{12} --pr 1 --expect-order 1,2,3$/);
    // The corrected command passes against the same gh answers.
    expect(restamp(repo, ['--next', '--pr', '1', '--expect-order', '1,2,3', '--dry-run'], ghShim(repo, { '2': open, '3': open })).status).toBe(EXIT.ok);
    expect(repo.git('status', '--porcelain')).toBe('');
  });
});

describe('version-source shapes', () => {
  test('a package.json pin (3-digit) stamps the manifest and lockfile only and bumps patch', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, release_tool: null, release_outputs: [] } });
    fs.rmSync(path.join(repo.work, 'VERSION'));
    fs.writeFileSync(path.join(repo.work, '.gstack', 'version-path'), 'package.json\n');
    fs.writeFileSync(path.join(repo.work, 'docs', 'notes.md'), 'since: 1.2.4\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'pin manifest'); repo.git('push', '-q', 'origin', 'main');
    makePr(repo, 'pr-a');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('STAMP_VERSION: 1.2.4');
    expect(JSON.parse(readFile(repo, 'package.json')).version).toBe('1.2.4');
    expect(JSON.parse(readFile(repo, 'package-lock.json')).version).toBe('1.2.4');
    expect(fs.existsSync(path.join(repo.work, 'VERSION'))).toBe(false);
    expect(readFile(repo, 'docs/notes.md')).toBe('since: 1.2.4\n');
    const again = restamp(repo, ['--version', '1.2.5']);
    expect(again.out).toContain('(1.2.4 -> 1.2.5)');
    expect(readFile(repo, 'docs/notes.md')).toBe('since: 1.2.5\n');
  });

  test('a monorepo with a pinned frontend/package.json stamps that manifest, not the root', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, release_tool: null, release_outputs: [] } });
    fs.mkdirSync(path.join(repo.work, 'frontend'));
    fs.writeFileSync(path.join(repo.work, 'frontend', 'package.json'), JSON.stringify({ name: 'web', version: '1.2.3' }, null, 2) + '\n');
    fs.writeFileSync(path.join(repo.work, '.gstack', 'version-path'), 'frontend/package.json\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'monorepo'); repo.git('push', '-q', 'origin', 'main');
    makePr(repo, 'pr-a');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(JSON.parse(readFile(repo, 'frontend/package.json')).version).toBe('1.2.4');
    expect(JSON.parse(readFile(repo, 'package.json')).version).toBe('1.2.3');
    expect(r.out).toMatch(/^FILES: CHANGELOG\.md frontend\/package\.json$/m);
  });

  test('an absent version source is RESTAMP_VERSION_SOURCE (exit 3), never an invented 0.0.0.0', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, release_tool: null, release_outputs: [] } });
    repo.git('rm', '-q', 'VERSION'); repo.git('commit', '-q', '-m', 'no version'); repo.git('push', '-q', 'origin', 'main');
    makePr(repo, 'pr-a');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/VERSION does not exist at [0-9a-f]{40}; nothing written.*\(RESTAMP_VERSION_SOURCE\)/);
    expect(fs.existsSync(path.join(repo.work, 'VERSION'))).toBe(false);
  });
});
