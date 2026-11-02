/**
 * Restamp mention scanning and rewriting (gbrain #7640, gstack 1.91.246.0): a
 * PR that stamped X lost its slot, merged the base, and the base was X by
 * then, so the branch's VERSION equalled the base's (no branch stamp) and its
 * quoted `since: 'X'` rows never moved: the mention scanner could not pass
 * the opening quote and, with no branch stamp, nothing else named X. Pins
 * the quoted forms (single, double, unquoted unchanged, quote style kept) in
 * both the scanner and the rewrite table, the equal-version rule (the base
 * version moves only on lines the branch added), and the negative control
 * (a base-side quoted row carrying that version stays).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { rewriteStamps, tentativeMentions } from '../lib/restamp';
import type { GitFixtureTemplate } from './helpers/git-fixture-template';
import { BASE_POLICY, cleanup, cloneFixture, fixtureTemplate, makePr, mergeMain, mergeToMain, readFile, restamp, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

/** The helper's makeFixtureRepo, built once per policy for this file and copied per test. */
const templates = new Map<string, GitFixtureTemplate<null>>();
afterAll(() => { for (const t of templates.values()) t.dispose(); });
function makeFixtureRepo(opts: { prefix: string; policy: Record<string, unknown> }): FixtureRepo {
  const key = JSON.stringify(opts.policy);
  if (!templates.has(key)) templates.set(key, fixtureTemplate({ policy: opts.policy, prefix: 'restamp-mentions-' }));
  return cloneFixture(templates.get(key)!, opts.prefix);
}

const stageDetail = (out: string, name: string) => new RegExp(`^stage ${name}: (\\w+)(?: \\((.*)\\))?$`, 'm').exec(out);

describe('quoted stamp forms (pure)', () => {
  test('rewriteStamps: since: with a single or double quote moves and keeps its quote; the unquoted form is unchanged', () => {
    expect(rewriteStamps("{ since: '1.2.3.0', id: 'a' }", '1.2.3.0', '1.2.4.0')).toEqual({ text: "{ since: '1.2.4.0', id: 'a' }", count: 1 });
    expect(rewriteStamps('{ since: "1.2.3.0", id: "a" }', '1.2.3.0', '1.2.4.0')).toEqual({ text: '{ since: "1.2.4.0", id: "a" }', count: 1 });
    expect(rewriteStamps("since:'1.2.3.0'", '1.2.3.0', '1.2.4.0')).toEqual({ text: "since:'1.2.4.0'", count: 1 });
    expect(rewriteStamps('since: 1.2.3.0', '1.2.3.0', '1.2.4.0')).toEqual({ text: 'since: 1.2.4.0', count: 1 });
    // A quote is an exact boundary too: a longer version behind it is not X.
    expect(rewriteStamps("since: '1.2.3.01'", '1.2.3.0', '1.2.4.0').count).toBe(0);
    expect(rewriteStamps("since: '1.2.3.0.1'", '1.2.3.0', '1.2.4.0').count).toBe(0);
    // An opened quote must close right after X: a quoted prerelease or a mismatched pair is not the form
    // (the tree receipt and gate reuse share this table, so a looser match would call a real change a stamp).
    expect(rewriteStamps("since: '1.2.3.0-beta'", '1.2.3.0', '1.2.4.0').count).toBe(0);
    expect(rewriteStamps('since: "1.2.3.0-beta"', '1.2.3.0', '1.2.4.0').count).toBe(0);
    expect(rewriteStamps("since: '1.2.3.0\"", '1.2.3.0', '1.2.4.0').count).toBe(0);
    expect(rewriteStamps('since: 1.2.3.0-beta', '1.2.3.0', '1.2.4.0').count).toBe(1);
  });

  test('rewriteStamps: (was X) accepts a matching quote pair and keeps it; a mismatched pair is not the form; a quoted vX already matched', () => {
    expect(rewriteStamps("(was '1.2.3.0')", '1.2.3.0', '1.2.4.0')).toEqual({ text: "(was '1.2.4.0')", count: 1 });
    expect(rewriteStamps('(was "1.2.3.0")', '1.2.3.0', '1.2.4.0')).toEqual({ text: '(was "1.2.4.0")', count: 1 });
    expect(rewriteStamps('(was 1.2.3.0)', '1.2.3.0', '1.2.4.0')).toEqual({ text: '(was 1.2.4.0)', count: 1 });
    expect(rewriteStamps("(was '1.2.3.0\")", '1.2.3.0', '1.2.4.0').count).toBe(0);
    expect(rewriteStamps("'v1.2.3.0'", '1.2.3.0', '1.2.4.0')).toEqual({ text: "'v1.2.4.0'", count: 1 });
    // A bare pin equal to X is still not a stamp form, quoted or not.
    expect(rewriteStamps("pinned: '1.2.3.0'", '1.2.3.0', '1.2.4.0').count).toBe(0);
  });

  test('rewriteStamps: a policy template that overlaps the built-in quoted form counts the mention once', () => {
    const r = rewriteStamps("  { since: '1.2.3.0', id: 'x', text: 't' },", '1.2.3.0', '1.2.4.0', ["since: '{version}'"]);
    expect(r).toEqual({ text: "  { since: '1.2.4.0', id: 'x', text: 't' },", count: 1 });
  });

  test('tentativeMentions: quoted since: rows and template forms on branch-added lines are candidates like the unquoted ones', () => {
    const added = new Map([['src/notice.ts', new Set([
      "  { since: '1.2.4.0', id: 'single', text: 't' },",
      '  { since: "1.2.5.0", id: "double", text: "t" },',
      '  since: 1.2.6.0',
      '<!-- x-tree-stamp: 1.2.7.0 -->',
      "  pinned: '1.2.8.0'",
    ])]]);
    expect(tentativeMentions(added, '1.2.3.0', '1.2.9.0').sort()).toEqual(['1.2.4.0', '1.2.5.0', '1.2.6.0']);
    expect(tentativeMentions(added, '1.2.3.0', '1.2.9.0', ['<!-- x-tree-stamp: {version} -->']).sort()).toEqual(['1.2.4.0', '1.2.5.0', '1.2.6.0', '1.2.7.0']);
    // The fork-version floor and the allocated version still apply to quoted mentions.
    expect(tentativeMentions(added, '1.2.5.0', '1.2.6.0').sort()).toEqual([]);
    // A quoted prerelease, a mismatched pair and an unclosed (was are not candidates; the bare prerelease still is.
    const odd = new Map([['x', new Set(["since: '1.2.4.0-rc'", 'since: "1.2.5.0\'', "(was '1.2.6.0'x", '(was 1.2.7.0-rc)', 'since: 1.2.8.0-rc'])]]);
    expect(tentativeMentions(odd, '1.2.3.0', '1.2.9.0').sort()).toEqual(['1.2.8.0']);
  });
});

/** A gbrain-shaped fixture: a quoted-row source file in stamp_files, with and without the since: template. */
const NOTICE = 'src/notice.ts';
const row = (v: string, id: string) => `  { since: '${v}', id: '${id}', text: '${id}' },`;
const notice = (rows: string[]) => ['export const ROWS = [', ...rows, '];', ''].join('\n');
function policy(templates: boolean) {
  return { ...BASE_POLICY, release_tool: null, stamp_files: ['VERSION', 'package.json', 'CHANGELOG.md', NOTICE], ...(templates ? { stamp_patterns: ["since: '{version}'"] } : {}) };
}
function write(repo: FixtureRepo, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo.work, rel), text);
}
/** The repo's own stamp on the branch, the way gbrain's release:restamp leaves it: VERSION and the rows at X. */
function stampBranch(repo: FixtureRepo, v: string, rows: string[]): void {
  write(repo, 'VERSION', v + '\n');
  write(repo, NOTICE, notice(rows));
  repo.git('commit', '-qam', `chore: bump version (v${v})`);
}

/**
 * The reporter's state: the PR stamped 1.2.4.0 (VERSION and its row), another PR took the slot and the base
 * is 1.2.4.0 with its own quoted 1.2.4.0 row, the PR merged the base. VERSION equals the base's on both sides.
 */
function lostSlot(repo: FixtureRepo): void {
  write(repo, NOTICE, notice([row('1.2.3.0', 'base_row')]));
  repo.git('add', '-A'); repo.git('commit', '-qm', 'notice rows'); repo.git('push', '-q', 'origin', 'main');
  makePr(repo, 'pr-mine');
  stampBranch(repo, '1.2.4.0', [row('1.2.3.0', 'base_row'), '', '', '', row('1.2.4.0', 'mine')]);
  // The other PR takes the slot through the real stamp: VERSION 1.2.4.0, its CHANGELOG entry headed, its own 1.2.4.0 row.
  makePr(repo, 'pr-other');
  write(repo, NOTICE, notice([row('1.2.4.0', 'other'), row('1.2.3.0', 'base_row')]));
  repo.git('commit', '-qam', 'other row');
  expect(restamp(repo, ['--next']).status).toBe(EXIT.ok);
  repo.git('commit', '-qam', 'stamp other');
  mergeToMain(repo, 'pr-other');
  repo.git('checkout', '-q', 'pr-mine');
  mergeMain(repo);
  expect(readFile(repo, 'VERSION')).toBe('1.2.4.0\n');
  expect(repo.git('show', 'origin/main:VERSION')).toBe('1.2.4.0');
}

describe('a PR whose VERSION already equals the base (gbrain #7640)', () => {
  test.each([['with the since: template', true], ['built-in quoted form alone', false]])('%s: the PR\'s quoted row moves, the base\'s own quoted rows stay, and the stage says why', (_, templates) => {
    const repo = makeFixtureRepo({ prefix: 'restamp-mentions-', policy: policy(templates) }); repos.push(repo);
    lostSlot(repo);
    const dry = restamp(repo, ['--next', '--dry-run']);
    expect(dry.status).toBe(EXIT.ok);
    expect(dry.out).toMatch(/^-  \{ since: '1\.2\.4\.0', id: 'mine', text: 'mine' \},$/m);
    expect(dry.out).toMatch(/^\+  \{ since: '1\.2\.5\.0', id: 'mine', text: 'mine' \},$/m);
    expect(repo.git('status', '--porcelain')).toBe('');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('RESTAMP: 1.2.4.0 -> 1.2.5.0 (stamped;');
    const sp = stageDetail(r.out, 'stamp_paths')!;
    expect(sp[1]).toBe('done');
    expect(sp[2]).toBe(`1 mention(s) in 1 file(s) (1.2.4.0 -> 1.2.5.0); VERSION equals base 1.2.4.0, so 1.2.4.0 moved only on lines this branch added and stayed on the base's own lines (${NOTICE}: 1 moved, 1 kept)`);
    expect(readFile(repo, NOTICE)).toBe(notice([row('1.2.4.0', 'other'), row('1.2.3.0', 'base_row'), '', '', '', row('1.2.5.0', 'mine')]));
    expect(readFile(repo, 'VERSION')).toBe('1.2.5.0\n');
    // The base's rows are byte-identical to origin/main's: the 1.2.4.0 row is the base's release and never moved.
    expect(repo.git('show', `origin/main:${NOTICE}`) + '\n').toBe(notice([row('1.2.4.0', 'other'), row('1.2.3.0', 'base_row')]));
    const journal = JSON.parse(readFile(repo, '.gstack/tmp/restamp-journal.json'));
    expect(journal.inputs).toMatchObject({ old_version: '1.2.4.0', new_version: '1.2.5.0' });
    expect(journal.stages.find((s: any) => s.name === 'stamp_paths').detail).toContain('1 moved, 1 kept');
  });

  test('negative control: with no branch-added mention of the base version nothing moves, every base-side quoted row stays, and the stage says so', () => {
    const repo = makeFixtureRepo({ prefix: 'restamp-mentions-neg-', policy: policy(true) }); repos.push(repo);
    write(repo, NOTICE, notice([row('1.2.3.0', 'base_row')]));
    repo.git('add', '-A'); repo.git('commit', '-qm', 'notice rows'); repo.git('push', '-q', 'origin', 'main');
    makePr(repo, 'pr-mine');
    // The PR adds a row of its own in another form entirely, plus an unrelated line in the stamp file.
    write(repo, NOTICE, notice([row('1.2.3.0', 'base_row'), "  { since: 'TBD', id: 'mine', text: 'mine' },"]));
    repo.git('commit', '-qam', 'my row');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    const sp = stageDetail(r.out, 'stamp_paths')!;
    expect(sp[1]).toBe('skipped');
    expect(sp[2]).toBe('no tentative mention newer than the fork version 1.2.3.0 and none of base 1.2.3.0 on a line this branch added; VERSION equals base 1.2.3.0, so 1.2.3.0 moved only on lines this branch added and stayed on the base\'s own lines (src/notice.ts: 0 moved, 1 kept)');
    expect(readFile(repo, NOTICE)).toBe(notice([row('1.2.3.0', 'base_row'), "  { since: 'TBD', id: 'mine', text: 'mine' },"]));
    expect(r.out).not.toMatch(/^[-+]  \{ since: '1\.2\.3\.0'/m);
  });

  test('a branch forked at the base version (fork equals base, nothing stamped) still moves its own base-version row and keeps the base\'s', () => {
    const repo = makeFixtureRepo({ prefix: 'restamp-mentions-fork-', policy: policy(true) }); repos.push(repo);
    write(repo, NOTICE, notice([row('1.2.3.0', 'base_row')]));
    repo.git('add', '-A'); repo.git('commit', '-qm', 'notice rows'); repo.git('push', '-q', 'origin', 'main');
    makePr(repo, 'pr-mine');
    write(repo, NOTICE, notice([row('1.2.3.0', 'base_row'), row('1.2.3.0', 'mine')]));
    write(repo, 'docs/pr-mine.md', 'Requires v1.2.3.0 or later.\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'my row');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(stageDetail(r.out, 'stamp_paths')![2]).toBe('2 mention(s) in 2 file(s) (1.2.3.0 -> 1.2.4.0); VERSION equals base 1.2.3.0, so 1.2.3.0 moved only on lines this branch added and stayed on the base\'s own lines (docs/pr-mine.md: 1 moved, 0 kept; src/notice.ts: 1 moved, 1 kept)');
    expect(readFile(repo, NOTICE)).toBe(notice([row('1.2.3.0', 'base_row'), row('1.2.4.0', 'mine')]));
    expect(readFile(repo, 'docs/pr-mine.md')).toBe('Requires v1.2.4.0 or later.\n');
    expect(readFile(repo, 'docs/notes.md')).toBe('Previous release v1.2.3.0.\nleft-pad pinned at 1.2.3 (was 1.2.2)\n');
  });

  test('provenance is by position: a branch-added line whose text equals a base line moves alone, and the base copy stays', () => {
    const repo = makeFixtureRepo({ prefix: 'restamp-mentions-dup-', policy: policy(true) }); repos.push(repo);
    write(repo, NOTICE, notice([row('1.2.3.0', 'dup')]));
    repo.git('add', '-A'); repo.git('commit', '-qm', 'notice rows'); repo.git('push', '-q', 'origin', 'main');
    makePr(repo, 'pr-mine');
    write(repo, NOTICE, notice([row('1.2.3.0', 'dup'), '', '', '', row('1.2.3.0', 'dup')]));
    repo.git('commit', '-qam', 'my row, same text as the base row');
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(stageDetail(r.out, 'stamp_paths')![2]).toBe(`1 mention(s) in 1 file(s) (1.2.3.0 -> 1.2.4.0); VERSION equals base 1.2.3.0, so 1.2.3.0 moved only on lines this branch added and stayed on the base's own lines (${NOTICE}: 1 moved, 1 kept)`);
    expect(readFile(repo, NOTICE)).toBe(notice([row('1.2.3.0', 'dup'), '', '', '', row('1.2.4.0', 'dup')]));
  });

  test('diff.interHunkContext joining two hunks around a base row still places each branch row by position', () => {
    const repo = makeFixtureRepo({ prefix: 'restamp-mentions-ihc-', policy: policy(true) }); repos.push(repo);
    write(repo, NOTICE, notice(['  { since: "0.0.0.0", id: "first_placeholder" },', row('1.2.3.0', 'base_row'), '  { since: "0.0.0.0", id: "second_placeholder" },']));
    repo.git('add', '-A'); repo.git('commit', '-qm', 'notice rows'); repo.git('push', '-q', 'origin', 'main');
    repo.git('config', 'diff.interHunkContext', '1');
    makePr(repo, 'pr-mine');
    write(repo, NOTICE, notice([row('1.2.3.0', 'first'), row('1.2.3.0', 'base_row'), row('1.2.3.0', 'second')]));
    repo.git('commit', '-qam', 'two rows around the base row');
    // The joined hunk carries the base row as context between the two added lines.
    expect(repo.git('diff', '--unified=0', 'origin/main', '--', NOTICE)).toMatch(/\n\+  \{ since: '1\.2\.3\.0', id: 'first'.*\n   \{ since: '1\.2\.3\.0', id: 'base_row'.*\n-.*\n\+  \{ since: '1\.2\.3\.0', id: 'second'/);
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(stageDetail(r.out, 'stamp_paths')![2]).toContain(`${NOTICE}: 2 moved, 1 kept`);
    expect(readFile(repo, NOTICE)).toBe(notice([row('1.2.4.0', 'first'), row('1.2.3.0', 'base_row'), row('1.2.4.0', 'second')]));
  });

  test('a CRLF checkout (core.autocrlf, eol=crlf) whose diff is LF-normalized still finds the branch-added row', () => {
    const repo = makeFixtureRepo({ prefix: 'restamp-mentions-crlf-', policy: policy(true) }); repos.push(repo);
    write(repo, '.gitattributes', `${NOTICE} text eol=crlf\n`);
    write(repo, NOTICE, notice([row('1.2.3.0', 'base_row')]));
    repo.git('config', 'core.autocrlf', 'true');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'notice rows'); repo.git('push', '-q', 'origin', 'main');
    makePr(repo, 'pr-mine');
    write(repo, NOTICE, notice([row('1.2.3.0', 'base_row'), row('1.2.3.0', 'mine')]).replace(/\n/g, '\r\n'));
    repo.git('commit', '-qam', 'my row');
    expect(repo.git('diff', '--unified=0', 'origin/main', '--', NOTICE)).toContain("+  { since: '1.2.3.0', id: 'mine'");
    const r = restamp(repo, ['--next']);
    expect(r.status).toBe(EXIT.ok);
    expect(stageDetail(r.out, 'stamp_paths')![2]).toContain(`${NOTICE}: 1 moved, 1 kept`);
    expect(readFile(repo, NOTICE)).toBe(notice([row('1.2.3.0', 'base_row'), row('1.2.4.0', 'mine')]).replace(/\n/g, '\r\n'));
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a stamp interrupted after VERSION was written retries as a stamp, not a noop: the journal restores the equal-base provenance', () => {
    const repo = makeFixtureRepo({ prefix: 'restamp-mentions-retry-', policy: policy(true) }); repos.push(repo);
    lostSlot(repo);
    const dir = path.join(repo.work, path.dirname(NOTICE));
    fs.chmodSync(dir, 0o555);
    try {
      const first = restamp(repo, ['--next']);
      expect(first.status).not.toBe(EXIT.ok);
      expect(first.err).toMatch(/EACCES|permission denied/i);
    } finally { fs.chmodSync(dir, 0o755); }
    expect(readFile(repo, 'VERSION')).toBe('1.2.5.0\n');
    expect(readFile(repo, NOTICE)).toContain(row('1.2.4.0', 'mine'));
    const again = restamp(repo, ['--next']);
    expect(again.status).toBe(EXIT.ok);
    expect(again.out).toContain('RESTAMP: 1.2.5.0 -> 1.2.5.0 (stamped;');
    expect(stageDetail(again.out, 'stamp_paths')![2]).toContain(`${NOTICE}: 1 moved, 1 kept`);
    expect(readFile(repo, NOTICE)).toBe(notice([row('1.2.4.0', 'other'), row('1.2.3.0', 'base_row'), '', '', '', row('1.2.5.0', 'mine')]));
    expect(JSON.parse(readFile(repo, '.gstack/tmp/restamp-journal.json')).status).toBe('complete');
  });

  test('--was still rewrites every line, the base\'s rows included: it is not the fix for this state', () => {
    const repo = makeFixtureRepo({ prefix: 'restamp-mentions-was-', policy: policy(true) }); repos.push(repo);
    lostSlot(repo);
    const r = restamp(repo, ['--next', '--was', '1.2.4.0']);
    expect(r.status).toBe(EXIT.ok);
    expect(stageDetail(r.out, 'stamp_paths')![2]).toBe('2 mention(s) in 1 file(s) (1.2.4.0 -> 1.2.5.0)');
    expect(readFile(repo, NOTICE)).toBe(notice([row('1.2.5.0', 'other'), row('1.2.3.0', 'base_row'), '', '', '', row('1.2.5.0', 'mine')]));
  });
});
