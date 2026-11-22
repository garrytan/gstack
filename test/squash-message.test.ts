/**
 * lib/squash-message.ts: every gstack merge lands as one commit titled "<PR title> (#n)" whose body is the PR body's
 * opening lines plus the branch's trailers (docs/writing-prs.md#the-commit-on-main). Real git repositories in a temp
 * directory; no network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { branchTrailers, landMessage, landMethod, mergeArgs, openingLines, sectionText } from '../lib/squash-message';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A repository with one base commit on main; `commit` adds a file as the named author with the given message. */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-squash-msg-'));
  dirs.push(root);
  const git = (args: string[], who = 'Ada <ada@example.com>') => {
    const [name, email] = [who.replace(/ <.*/, ''), /<(.*)>/.exec(who)![1]!];
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  const commit = (file: string, message: string, who?: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), file + '\n'); git(['add', '-A'], who); git(['commit', '-q', '-m', message], who); return git(['rev-parse', 'HEAD']); };
  const base = commit('README.md', 'base');
  return { root, git, commit, base };
}

const OPENING = 'X is faster now: [the cache](https://example.com/c) keeps parsed files.\n\nWhy: big repositories waited a minute.\n\nNothing to do.\n';
const BODY = OPENING + '\n## Tests\n\n- 12 pass\n';
const SQUASH = { history: 'squash-ok' as const, land: null };

describe('the commit message', () => {
  // Value: protects=main's log reads as plain changes with credit kept; fails_when=the subject loses the number, the body pastes the
  // whole PR, a fold leaks in, links keep their URLs, or a trailer is lost or doubled; why_new=R76 as amended 2026-11-15
  test('subject is the title with (#n); body is the opening lines, then each trailer once and every other author', () => {
    const r = repo();
    r.git(['checkout', '-q', '-b', 'pr']);
    r.commit('src/a.ts', 'speed up the parser\n\nRemoved-test: test/old.test.ts\nCo-authored-by: Carol <carol@example.com>');
    const pin = r.commit('src/b.ts', 'tidy\n\nCo-authored-by: Carol <carol@example.com>', 'Bob <bob@example.com>');
    const m = landMessage(r.root, { pr: '5', title: 'Make X faster', prBody: BODY, mergeBase: r.base, pin, tip: r.base, policy: SQUASH });
    if ('error' in m) throw new Error(m.error);
    expect(m.subject).toBe('Make X faster (#5)');
    expect(m.body).toBe('X is faster now: the cache keeps parsed files.\n\nWhy: big repositories waited a minute.\n\nNothing to do.\n\nRemoved-test: test/old.test.ts\nCo-authored-by: Carol <carol@example.com>\nCo-authored-by: Bob <bob@example.com>');
    expect([m.method, m.skippedParent]).toEqual(['squash', null]);
    expect(mergeArgs('5', pin, m)).toEqual(['pr', 'merge', '5', '--squash', '--match-head-commit', pin, '--subject', 'Make X faster (#5)', '--body', m.body]);
  });

  test('an empty or receipt-only opening gives the trailers alone; a long line wraps at 72; at most three lines are kept', () => {
    const r = repo();
    r.git(['checkout', '-q', '-b', 'pr']);
    const pin = r.commit('src/a.ts', 'a\n\nCo-authored-by: Carol <carol@example.com>');
    const receiptOnly = '\`\`\`gstack-ship-receipt\n{ "schema_version": 1 }\n\`\`\`\n\n## What changed\n\nx\n';
    for (const prBody of ['', receiptOnly]) {
      const m = landMessage(r.root, { pr: '5', title: 'T', prBody, mergeBase: r.base, pin, tip: r.base, policy: SQUASH });
      expect('error' in m ? m.error : m.body).toBe('Co-authored-by: Carol <carol@example.com>');
    }
    const long = 'word '.repeat(30).trim();
    expect(openingLines(long).split('\n').every(l => l.length <= 72)).toBe(true);
    expect(openingLines('one\n\ntwo\n\nthree\n\nfour\n')).toBe('one\n\ntwo\n\nthree');
  });

  // Value: protects=a secret never reaches main's history through a commit message; fails_when=the scan is skipped or
  // runs on other bytes than the ones sent; why_new=gate answer "the squash message goes through the redaction scan"
  test('a key in the title, opening or --body-file refuses; a phone-shaped number drops the opening and keeps the trailers', () => {
    const r = repo();
    r.git(['checkout', '-q', '-b', 'pr']);
    const pin = r.commit('src/a.ts', 'a\n\nCo-authored-by: Carol <carol@example.com>');
    const key = 'AKIA' + '1234567890ABCDEF';
    const at = (o: { title?: string; prBody?: string; override?: string }) => landMessage(r.root, { pr: '5', title: o.title ?? 'T', prBody: o.prBody ?? BODY, override: o.override, mergeBase: r.base, pin, tip: r.base, policy: SQUASH });
    for (const o of [{ title: 'T ' + key }, { prBody: 'Uses ' + key + '.\n' }, { override: 'Uses ' + key }]) expect(at(o)).toMatchObject({ error: expect.stringContaining('nothing merged') });
    expect(at({ prBody: 'Call +14155552671 for help.\n' })).toMatchObject({ body: 'Co-authored-by: Carol <carol@example.com>' });
    expect(at({ override: 'The plain line I chose.' })).toMatchObject({ body: 'The plain line I chose.\n\nCo-authored-by: Carol <carol@example.com>' });
    expect(at({ title: '  ' })).toMatchObject({ error: expect.stringContaining('no title') });
  });

  // Value: protects=a stacked PR's commit does not repeat the credit lines of its parent, which already landed;
  // fails_when=landedStackParent is not consulted; why_new=gate answer Addition B
  test('commits of a stacked parent that already landed are left out', () => {
    const r = repo();
    r.git(['checkout', '-q', '-b', 'stack']);
    const parent = r.commit('src/parent.ts', 'parent\n\nCo-authored-by: Dan <dan@example.com>');
    const pin = r.commit('src/child.ts', 'child\n\nCo-authored-by: Erin <erin@example.com>');
    r.git(['checkout', '-q', 'main']);
    r.git(['checkout', '-q', parent, '--', 'src/parent.ts']);
    r.git(['commit', '-q', '-m', 'Parent PR (#4)']);
    const tip = r.git(['rev-parse', 'HEAD']);
    const m = landMessage(r.root, { pr: '6', title: 'Child', prBody: '', mergeBase: r.base, pin, tip, policy: SQUASH });
    expect(m).toMatchObject({ skippedParent: parent, body: 'Co-authored-by: Erin <erin@example.com>' });
    expect(branchTrailers(r.root, r.base, pin)).toEqual(['Co-authored-by: Dan <dan@example.com>', 'Co-authored-by: Erin <erin@example.com>']);
  });
  // Value: protects=a stacked child that merged main after its parent squash-landed still leaves out the parent's credit lines, and
  //   main's own; fails_when=land measures the parent with the reviewed-range rule (a parent the merge base already holds is no
  //   parent, GST-3315) or reads the trailers from the parent alone; why_new=#4580 note: the child's squash body repeated the parent's
  //   trailers; seam=landMessage as land calls it, with the merge base of the pin and main's tip
  test('a stacked child that merged main after its parent landed leaves out the parent\'s and main\'s trailers', () => {
    const r = repo();
    r.git(['checkout', '-q', '-b', 'stack']);
    const parent = r.commit('src/parent.ts', 'parent\n\nCo-authored-by: Dan <dan@example.com>');
    r.commit('src/child.ts', 'child\n\nCo-authored-by: Erin <erin@example.com>');
    r.git(['checkout', '-q', 'main']);
    r.git(['checkout', '-q', parent, '--', 'src/parent.ts']);
    r.git(['commit', '-q', '-m', 'Parent PR (#4)\n\nReview-Finding: p1/red-team#1 reader=red-team']);
    r.commit('docs/other.md', 'Other PR (#5)\n\nCo-authored-by: Fay <fay@example.com>');
    const tip = r.git(['rev-parse', 'HEAD']);
    r.git(['checkout', '-q', 'stack']);
    r.git(['merge', '-q', '--no-edit', 'main']);
    const pin = r.git(['rev-parse', 'HEAD']);
    const mergeBase = r.git(['merge-base', pin, tip]);
    const m = landMessage(r.root, { pr: '6', title: 'Child', prBody: '', mergeBase, pin, tip, policy: SQUASH });
    expect(m).toMatchObject({ skippedParent: parent, body: 'Co-authored-by: Erin <erin@example.com>' });
  });
});

describe('the merge method', () => {
  // Value: protects=repositories that must keep merge commits keep them, with the same subject and body;
  // fails_when=merge-only or a merge_commit_paths match squashes; why_new=G1 and I1
  test('merge-only and a land.merge_commit_paths match merge; no-rewrite and a miss squash', () => {
    const r = repo();
    r.git(['checkout', '-q', '-b', 'pr']);
    const pin = r.commit('evals/results/run-1.json', 'results');
    expect(landMethod(r.root, { history: 'merge-only', land: null }, r.base, pin)).toEqual({ method: 'merge', why: 'history: merge-only' });
    expect(landMethod(r.root, { history: 'no-rewrite', land: null }, r.base, pin)).toEqual({ method: 'squash', why: 'history: no-rewrite' });
    expect(landMethod(r.root, { history: 'squash-ok', land: { merge_commit_paths: ['evals/**'] } }, r.base, pin)).toEqual({ method: 'merge', why: 'land.merge_commit_paths matches evals/results/run-1.json' });
    expect(landMethod(r.root, { history: 'squash-ok', land: { merge_commit_paths: ['docs/**'] } }, r.base, pin)).toEqual({ method: 'squash', why: 'no land.merge_commit_paths match' });
  });

  test("a release PR's commit body is its Release notes section", () => {
    const body = 'v1.2.0.0 ships 2 changes.\n\n<details><summary>Release notes</summary>\n\n- One thing (#1)\n- Another (#2)\n\n</details>\n\n<!-- gstack:agent-notes -->\n<details><summary>Agent notes</summary>\n\nx\n\n</details>\n';
    expect(sectionText(body, 'Release notes')).toBe('- One thing (#1)\n- Another (#2)');
    expect(sectionText(body, 'Missing')).toBe('');
  });
});
