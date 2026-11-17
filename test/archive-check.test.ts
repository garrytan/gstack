/**
 * gstack-archive-check: a Captain's pre-archive orphan check and the land step's
 * issue close (GST-2188, R86). The Captain does the Capy reads (tools.thread.get,
 * tools.issue.read) and hands them over raw; the bin re-reads every PR from GitHub
 * and fails closed on anything it cannot fully read. R91: a thread that holds an
 * open PR is never archived, successor or not.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkThread, landedIssues, parseIssueList, type CheckOptions } from '../lib/archive-check';
import type { Gh } from '../lib/ship-queue';
import { RESULT_CODES } from '../lib/result-codes';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const STATES = 'States: Needs you, Backlog, Todo (default), In progress, Waiting, In review · closed: Done (default), Canceled';
const issues = (...lines: string[]) => [STATES, 'Labels: none', ...(lines.length ? lines : ['No issues match.'])].join('\n');
const pr = (number: number, repo = 'garrytan/gstack', state = 'open') => ({ repo, number, title: 'A PR', state, relation: 'owner' });
const thread = (code: string, status: string, prs: ReturnType<typeof pr>[] = []) => ({ id: 'jam_' + code, code, status, archived: status === 'archived', pull_requests: prs, pull_requests_total: prs.length });
const NOW = Date.parse('2026-11-09T20:00:00Z');
const reads = (o: Record<string, unknown> = {}) => ({ read_at: '2026-11-09T19:55:00Z', thread: thread('GSTA-1', 'idle'), issues: issues(), ...o });
type Live = { state: string; headRefOid?: string; headRefName?: string; title?: string; number?: number; url?: string } | 'fail';
function ghFor(live: Record<string, Live>, calls: string[] = []): (repo: string) => Gh {
  return (repo: string) => (args: string[]) => {
    calls.push(repo + ' ' + args.join(' '));
    const n = args[2]!;
    const v = live[repo + '#' + n];
    if (!v || v === 'fail') return { ok: false, out: '', err: 'HTTP 502: Bad Gateway' };
    return { ok: true, out: JSON.stringify({ number: Number(n), url: 'https://github.com/' + repo + '/pull/' + n, headRefOid: 'a'.repeat(40), headRefName: 'capy/x', title: 'A PR (GST-9)', ...v }) };
  };
}
const opts = (live: Record<string, Live> = {}, o: Partial<CheckOptions> = {}): CheckOptions => ({ thread: 'GSTA-1', now: NOW, ghFor: ghFor(live), ci: () => 'green at aaaaaaaaaaaa (passed=3 failed=0 pending=0 skipped=0)', ...o });

describe('archive check (reads and verdict)', () => {
  // Value: protects=a thread with nothing open archives cleanly; fails_when=the empty-list text or a Labels line is read as unparsed work
  test('a thread with no open PRs and no open issues is clean', () => {
    const r = checkThread(reads(), opts());
    expect(r.verdict).toBe('clean');
    expect(r.lines.at(-1)).toBe('ARCHIVE_CHECK: clean thread=GSTA-1 prs=0 issues=0');
  });

  // Value: protects=an open PR with nobody named to own it refuses the archive; fails_when=Capy's open state is trusted without a successor
  test('an open PR with no successor is an orphan', () => {
    const r = checkThread(reads({ thread: thread('GSTA-1', 'idle', [pr(4237)]) }), opts({ 'garrytan/gstack#4237': { state: 'OPEN' } }));
    expect(r.verdict).toBe('refused');
    expect(r.lines.some(l => l.startsWith('ORPHAN: pr garrytan/gstack#4237 open head=aaaaaaaaaaaa ci=green'))).toBe(true);
    expect(r.lines.at(-1)).toBe('ARCHIVE_CHECK: refused thread=GSTA-1 prs=1 issues=0');
  });

  // Value: protects=R91, a live successor never makes archiving a thread with an open PR OK; fails_when=a successor read or a successor field clears the PR
  test('R91: an open PR refuses even when a live successor exists', () => {
    const r = checkThread(reads({ thread: thread('GSTA-1', 'idle', [pr(4237)]), successors: [thread('GSTA-9', 'working', [pr(4237)])], successor: 'GSTA-9' }), opts({ 'garrytan/gstack#4237': { state: 'OPEN' } }));
    expect(r.verdict).toBe('refused');
    expect(r.lines[0]).toContain('R91: never archive a thread that holds an open PR');
  });

  // Value: protects=GitHub's live state decides, so a PR Capy still calls open but GitHub merged needs nothing, and a reopened one counts; fails_when=the Capy state is used
  test('the live GitHub state decides, not the Capy row', () => {
    expect(checkThread(reads({ thread: thread('GSTA-1', 'idle', [pr(10)]) }), opts({ 'garrytan/gstack#10': { state: 'MERGED' } })).verdict).toBe('clean');
    expect(checkThread(reads({ thread: thread('GSTA-1', 'idle', [pr(11, 'garrytan/gstack', 'closed')]) }), opts({ 'garrytan/gstack#11': { state: 'OPEN' } })).verdict).toBe('refused');
  });

  // Value: protects=each PR is read in its own repository and a mismatched answer refuses (gate A); fails_when=gh reads the cwd repo and a same-numbered merged PR there passes
  test('cross-repo PRs are read with --repo and a mismatched answer is unreadable', () => {
    const calls: string[] = [];
    const t = thread('GSTA-1', 'idle', [pr(5, 'garrytan/gbrain')]);
    const r = checkThread(reads({ thread: t }), opts({}, { ghFor: ghFor({ 'garrytan/gbrain#5': { state: 'OPEN' } }, calls) }));
    expect(r.verdict).toBe('refused');
    expect(calls[0]).toContain('pr view 5 --repo garrytan/gbrain');
    const wrong = checkThread(reads({ thread: t }), opts({}, { ghFor: ghFor({ 'garrytan/gbrain#5': { state: 'MERGED', url: 'https://github.com/garrytan/gstack/pull/5' } }) }));
    expect(wrong.verdict).toBe('unreadable');
    expect(wrong.failure?.code).toBe('ARCHIVE_GH_READ_FAILED');
  });

  // Value: protects=a failed PR read is never clean and names its fix (gate E); a failed CI read never blocks; fails_when=a gh error reads as merged or as zero work
  test('a gh read failure is unreadable; a CI read failure is ci=unknown', () => {
    const t = thread('GSTA-1', 'idle', [pr(7)]);
    const r = checkThread(reads({ thread: t }), opts({ 'garrytan/gstack#7': 'fail' }));
    expect(r.verdict).toBe('unreadable');
    expect(r.failure?.code).toBe('ARCHIVE_GH_READ_FAILED');
    expect(r.failure?.message).toContain('garrytan/gstack#7');
    expect(r.failure?.message).toContain('HTTP 502');
    const ci = checkThread(reads({ thread: t }), opts({ 'garrytan/gstack#7': { state: 'OPEN' } }, { ci: () => { throw new Error('boom'); } }));
    expect(ci.verdict).toBe('refused');
    expect(ci.lines.some(l => l.includes('ci=unknown'))).toBe(true);
  });

  // Value: protects=only OPEN, CLOSED and MERGED are PR states, anything else fails closed; fails_when=an empty or unknown gh state is read as closed and the thread archives clean
  test('an unknown or empty live PR state is unreadable, never closed', () => {
    const t = thread('GSTA-1', 'idle', [pr(7)]);
    for (const state of ['', 'DRAFT', 'open', 'UNKNOWN']) {
      const r = checkThread(reads({ thread: t }), opts({ 'garrytan/gstack#7': { state } }));
      expect([state, r.verdict, r.failure?.code]).toEqual([state, 'unreadable', 'ARCHIVE_PR_STATE_UNKNOWN']);
      expect(r.failure?.message).toContain('garrytan/gstack#7');
    }
    for (const state of ['CLOSED', 'MERGED']) expect(checkThread(reads({ thread: t }), opts({ 'garrytan/gstack#7': { state } })).verdict).toBe('clean');
  });

  // Value: protects=a failed CI read says so on the ORPHAN line while the open PR still refuses; fails_when=the failure prints as a bare ci=unknown or clears the PR
  test('a failed CI read is named on the ORPHAN line and the PR still blocks', () => {
    const t = thread('GSTA-1', 'idle', [pr(7)]);
    const thrown = checkThread(reads({ thread: t }), opts({ 'garrytan/gstack#7': { state: 'OPEN' } }, { ci: () => { throw new Error('boom'); } }));
    expect(thrown.verdict).toBe('refused');
    expect(thrown.lines[0]).toContain('ci=unknown (CI read failed: boom)');
    const api = checkThread(reads({ thread: t }), opts({ 'garrytan/gstack#7': { state: 'OPEN' } }, { ci: undefined }));
    expect(api.verdict).toBe('refused');
    expect(api.lines[0]).toContain('ci=unknown (CI read failed: check_runs page 1 unreadable');
    expect(api.lines[0]).toContain('HTTP 502');
  });

  // Value: protects=empty, missing or truncated reads never parse as zero work (gate B); fails_when=any of them prints clean
  test('empty, missing or truncated reads are unparsed', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['issues', { issues: '' }],
      ['issues', { issues: 'No issues match.' }],
      ['thread', { thread: { code: 'GSTA-1', status: 'idle' } }],
      ['thread', { thread: { ...thread('GSTA-1', 'idle', [pr(1)]), pull_requests_total: 3 } }],
      ['read_at', { read_at: undefined }],
    ];
    for (const [part, o] of bad) {
      const r = checkThread(reads(o), opts({ 'garrytan/gstack#1': { state: 'MERGED' } }));
      expect([part, r.verdict, r.failure?.code]).toEqual([part, 'unreadable', 'ARCHIVE_READS_UNPARSED']);
      expect(r.failure?.message).toContain(part);
    }
  });

  // Value: protects=a stale read or a read of another thread is refused; fails_when=an old or wrong read certifies the archive
  test('stale reads and another thread are refused', () => {
    expect(checkThread(reads({ read_at: '2026-11-09T19:40:00Z' }), opts()).failure?.code).toBe('ARCHIVE_READS_STALE');
    expect(checkThread(reads({ read_at: '2026-11-09T20:10:00Z' }), opts()).failure?.code).toBe('ARCHIVE_READS_STALE');
    expect(checkThread(reads({ thread: thread('GSTA-2', 'idle') }), opts()).failure?.code).toBe('ARCHIVE_THREAD_MISMATCH');
  });

  // Value: protects=open issues on the thread refuse in every working state, Backlog and Needs you only note; fails_when=a state outside a fixed list is skipped
  test('issues: working states and custom open states are orphans, Backlog and Needs you are notes', () => {
    const custom = 'States: Needs you, Backlog, Todo (default), In progress, Blocked, Waiting, In review · closed: Done (default), Canceled';
    const text = [custom, 'Labels: none',
      '- GST-1 · In progress · @GSTA-1 · Build it · 2m',
      '- GST-2 · Waiting · high · @GSTA-1, @GSTA-5 · Wait for it · 10/12 sub-issues closed · 6d',
      '  - GST-3 · In review · urgent · @GSTA-1 · Review it · 4h',
      '- GST-4 · Blocked · @GSTA-1 · Custom state · 1d',
      '- GST-5 · Backlog · @GSTA-1 · Someday · 3d',
      '- GST-6 · Needs you · @GSTA-1 · Ask · 1h',
      '- GST-7 · Todo · @GSTA-1 · Next · 1h'].join('\n');
    const r = checkThread(reads({ issues: text }), opts());
    expect(r.verdict).toBe('refused');
    expect(r.lines.filter(l => l.startsWith('ORPHAN: issue')).map(l => l.split(' ')[2])).toEqual(['GST-1', 'GST-2', 'GST-3', 'GST-4', 'GST-7']);
    expect(r.lines.filter(l => l.startsWith('NOTE: issue')).map(l => l.split(' ')[2])).toEqual(['GST-5', 'GST-6']);
    expect(checkThread(reads({ issues: issues('- GST-5 · Backlog · @GSTA-1 · Someday · 3d') }), opts()).verdict).toBe('clean');
  });

  // Value: protects=the issue grammar is checked against the States header and fails closed (gate D); fails_when=an unknown line or state is skipped
  // Value: protects=a read cut off before its first issue row never archives; fails_when=header-only issue text parses as an empty list
  test('issue text with headers but no rows and no "No issues match." is unparsed', () => {
    for (const text of [STATES, STATES + '\nLabels: none']) {
      const r = checkThread(reads({ issues: text }), opts());
      expect([r.verdict, r.failure?.code]).toEqual(['unreadable', 'ARCHIVE_READS_UNPARSED']);
    }
  });

  // Value: protects=an issue row cut short (no assignee, title or age) never passes as a whole row; fails_when="- GST-1 · Backlog" parses as a complete issue
  test('issue rows missing the assignee, title or age are unparsed', () => {
    for (const row of ['- GST-1 · Backlog', '- GST-1 · In progress · @GSTA-1', '- GST-1 · In progress · @GSTA-1 · Build it', '- GST-1 · In progress · Build it · 2m', '- GST-1 · In progress · @GSTA-1 · Build it · 2']) {
      expect([row, parseIssueList(issues(row))]).toMatchObject([row, { code: 'ARCHIVE_READS_UNPARSED' }]);
    }
    const whole = parseIssueList(issues('- GST-707 · Waiting · high · blocked · @GGST-1 · Plan it · 8d', '- GST-640 · Backlog · unassigned · Redo it · 9d', '- GST-9 · Todo · @GSTA-1 · A · B title · 1/2 sub-issues closed · 5h'));
    expect(whole).toMatchObject({ issues: [{ code: 'GST-707', title: 'Plan it' }, { code: 'GST-640', title: 'Redo it' }, { code: 'GST-9', title: 'A · B title' }] });
  });

  test('issue lines: unknown states and unknown lines are unparsed', () => {
    expect(parseIssueList(issues('- GST-1 · Doing · @GSTA-1 · x · 1m'))).toMatchObject({ code: 'ARCHIVE_READS_UNPARSED' });
    expect(parseIssueList(issues('Next page: cursor abc'))).toMatchObject({ code: 'ARCHIVE_READS_UNPARSED' });
    expect(parseIssueList(issues())).toEqual({ open: ['Needs you', 'Backlog', 'Todo', 'In progress', 'Waiting', 'In review'], closed: ['Done', 'Canceled'], issues: [] });
  });

  // Value: protects=the successor brief starts from facts (part 3); fails_when=the stub drops the head, CI or issue rows
  test('the handoff stub lists each open PR and open issue', () => {
    const r = checkThread(reads({ thread: thread('GSTA-1', 'idle', [pr(4237), pr(9)]), issues: issues('- GST-2188 · In progress · @GSTA-1 · Catch orphans · 2m') }), opts({ 'garrytan/gstack#4237': { state: 'OPEN', title: 'Keep findings whole' }, 'garrytan/gstack#9': { state: 'MERGED' } }));
    expect(r.stub.startsWith('<!-- handoff-stub -->')).toBe(true);
    expect(r.stub).toContain('| garrytan/gstack#4237 | Keep findings whole | capy/x | ' + 'a'.repeat(40) + ' | green at aaaaaaaaaaaa');
    expect(r.stub).not.toContain('#9 ');
    expect(r.stub).toContain('- GST-2188 · In progress · Catch orphans');
    expect(r.stub.trimEnd().endsWith('<!-- /handoff-stub -->')).toBe(true);
  });
});

describe('landed (issue close on land)', () => {
  const gh = (v: Record<string, unknown> | 'fail'): Gh => (args) => v === 'fail' ? { ok: false, out: '', err: 'HTTP 401' } : { ok: true, out: JSON.stringify({ number: Number(args[2]), url: 'https://github.com/garrytan/gstack/pull/' + args[2], state: 'MERGED', mergeCommit: { oid: 'b'.repeat(40) }, ...v }) };
  const policy = { codes: ['\\b(?:GST|GSTA|GBRA)-\\d+\\b', '\\bR\\d{1,3}\\b'], terms: [], allow: [], since: '2026-01-01', exempt_branch_prefixes: [] };

  // Value: protects=the land step names the issue in the title's trailing group, tracker codes only (gate G); fails_when=R-numbers, #N or other crews' codes are closed
  test('prints one ISSUE_CLOSE per tracker code in the trailing group', () => {
    const r = landedIssues({ pr: 4229, gh: gh({ title: 'Stop the queue from landing parent commits (GST-2153, R86, #4100, ZZZ-4)' }), policy });
    expect(r.exit).toBe(0);
    expect(r.codes).toEqual(['GST-2153']);
    expect(r.lines).toEqual(['ISSUE_CLOSE: GST-2153 pr=garrytan/gstack#4229 merge=bbbbbbbbbbbb']);
  });

  // Value: protects=no code means nothing to close, said plainly; fails_when=a title without a group prints nothing or an error
  // Value: protects=a lowercase policy pattern still closes the PR's issues, as plain-title.ts reads it; fails_when=landed compiles policy codes case-sensitively
  test('policy code patterns match case-insensitively', () => {
    const r = landedIssues({ pr: 1, gh: gh({ title: 'Fix x (GST-12)' }), policy: { ...policy, codes: ['\\bgst-\\d+\\b'] } });
    expect(r.codes).toEqual(['GST-12']);
  });

  test('a title with no tracker code prints none', () => {
    expect(landedIssues({ pr: 1, gh: gh({ title: 'Fix the thing' }), policy }).lines).toEqual(['ISSUE_CLOSE: none (the title names no tracker code)']);
  });

  // Value: protects=only a merged PR closes its issue, and a gh failure is never "none" (gate F); fails_when=an open PR or a failed read closes or skips silently
  test('not merged exits 1; a gh failure exits 3', () => {
    const open = landedIssues({ pr: 2, gh: gh({ state: 'OPEN', title: 'x (GST-1)' }), policy });
    expect([open.exit, open.failure?.code]).toEqual([1, 'ARCHIVE_PR_NOT_MERGED']);
    const failed = landedIssues({ pr: 2, gh: gh('fail'), policy });
    expect([failed.exit, failed.failure?.code]).toEqual([3, 'ARCHIVE_GH_READ_FAILED']);
  });

  // Value: protects=an unknown state on the land step is unreadable, not "not merged"; fails_when=an empty gh state exits 1 as if GitHub said the PR is open
  test('an unknown PR state exits 3', () => {
    for (const state of ['', 'merged', 'DRAFT']) {
      const r = landedIssues({ pr: 2, gh: gh({ state, title: 'x (GST-1)' }), policy });
      expect([state, r.exit, r.failure?.code]).toEqual([state, 3, 'ARCHIVE_PR_STATE_UNKNOWN']);
    }
  });

  // Value: protects=a missing, invalid or empty plain-titles policy refuses with a reason instead of closing every code-shaped ref; fails_when=no policy lets ZZZ-4 through as a tracker code
  test('a missing or empty policy refuses with ARCHIVE_POLICY_UNREADABLE', () => {
    const title = { title: 'Fix x (GST-1, ZZZ-4)' };
    const missing = landedIssues({ pr: 3, gh: gh(title), policy: null });
    expect([missing.exit, missing.codes, missing.failure?.code]).toEqual([3, [], 'ARCHIVE_POLICY_UNREADABLE']);
    expect(missing.failure?.message).toContain('.gstack/plain-titles.json');
    const invalid = landedIssues({ pr: 3, gh: gh(title), policy: null, policyError: '.gstack/plain-titles.json is not valid JSON: x' });
    expect(invalid.failure?.message).toContain('not valid JSON');
    const empty = landedIssues({ pr: 3, gh: gh(title), policy: { ...policy, codes: [] } });
    expect([empty.exit, empty.failure?.code]).toEqual([3, 'ARCHIVE_POLICY_UNREADABLE']);
  });
});

describe('result codes', () => {
  // Value: protects=every code the check prints has a summary, fix and troubleshooting anchor; fails_when=a code prints with no recovery
  test('archive codes are registered with anchors', () => {
    const doc = fs.readFileSync(path.join(import.meta.dir, '..', 'docs', 'troubleshooting.md'), 'utf8');
    for (const code of ['ARCHIVE_READS_STALE', 'ARCHIVE_READS_UNPARSED', 'ARCHIVE_THREAD_MISMATCH', 'ARCHIVE_PR_NOT_MERGED', 'ARCHIVE_GH_READ_FAILED', 'ARCHIVE_PR_STATE_UNKNOWN', 'ARCHIVE_POLICY_UNREADABLE'] as const) {
      const row = (RESULT_CODES as Record<string, { anchor: string }>)[code];
      expect(row?.anchor).toBeTruthy();
      expect(doc).toContain('<a id="' + row!.anchor + '"></a>');
    }
  });
});

describe('gstack-archive-check (bin)', () => {
  const repos: FixtureRepo[] = [];
  afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
  function shim(repo: FixtureRepo, live: Record<string, unknown>): Record<string, string> {
    const dir = path.join(repo.root, 'gh-shim');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(live));
    fs.writeFileSync(path.join(dir, 'gh.js'), [
      'const fs = require("fs"); const p = require("path"); const a = process.argv.slice(2);',
      'fs.appendFileSync(p.join(__dirname, "calls.log"), (process.env.GH_REPO || "-") + " " + a.join(" ") + "\\n");',
      'const live = require(p.join(__dirname, "live.json"));',
      'if (a[0] === "pr" && a[1] === "view") { const r = a[a.indexOf("--repo") + 1]; const v = live[r + "#" + a[2]]; if (!v) { console.error("HTTP 502"); process.exit(1); }',
      '  console.log(JSON.stringify({ number: Number(a[2]), url: "https://github.com/" + r + "/pull/" + a[2], headRefOid: "c".repeat(40), headRefName: "capy/y", title: "T", ...v })); process.exit(0); }',
      'if (a[0] === "api") { console.log(a.includes("--paginate") ? "[]" : JSON.stringify({ check_runs: [], statuses: [], total_count: 0 })); process.exit(0); }',
      'console.error("unexpected gh " + a.join(" ")); process.exit(1);',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nexec node "$(dirname "$0")/gh.js" "$@"\n', { mode: 0o755 });
    return { PATH: dir + path.delimiter + (process.env.PATH ?? '') };
  }

  // Value: protects=the CLI exit codes, the stub file's private mode and the repo-bound gh for CI reads (gate A); fails_when=the bin exits 0 on orphans, writes a world-readable stub or reads CI from the cwd repo
  test('thread: refuses with exit 1, writes the stub 0600, binds CI reads to the PR repo', () => {
    if (process.platform === 'win32') return;
    const repo = makeFixtureRepo(); repos.push(repo);
    const env = shim(repo, { 'garrytan/gbrain#5': { state: 'OPEN' } });
    const file = path.join(repo.root, 'reads.json');
    fs.writeFileSync(file, JSON.stringify({ ...reads({ thread: thread('GSTA-1', 'idle', [pr(5, 'garrytan/gbrain')]) }), read_at: new Date().toISOString() }));
    const stub = path.join(repo.root, 'stub.md');
    const r = runBin(repo, 'gstack-archive-check', ['thread', '--thread', 'GSTA-1', '--reads', file, '--stub-out', stub], env);
    expect(r.status).toBe(1);
    expect(r.out).toContain('ORPHAN: pr garrytan/gbrain#5 open');
    expect(fs.statSync(stub).mode & 0o777).toBe(0o600);
    const stale = path.join(repo.root, 'stale.json');
    fs.writeFileSync(stale, JSON.stringify(reads({ read_at: '2020-01-01T00:00:00Z' })));
    expect(runBin(repo, 'gstack-archive-check', ['thread', '--thread', 'GSTA-1', '--reads', stale, '--stub-out', stub], env).status).toBe(3);
    expect(fs.readFileSync(stub, 'utf8')).toBe('');
    const calls = fs.readFileSync(path.join(repo.root, 'gh-shim', 'calls.log'), 'utf8').split('\n').filter(l => l.includes(' api '));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.startsWith('garrytan/gbrain ')).toBe(true);
    const json = runBin(repo, 'gstack-archive-check', ['thread', '--thread', 'GSTA-1', '--reads', file, '--json'], env);
    expect(json.status).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ verdict: 'refused', thread: 'GSTA-1' });
    fs.writeFileSync(file, JSON.stringify({ ...reads(), read_at: new Date().toISOString() }));
    const clean = runBin(repo, 'gstack-archive-check', ['thread', '--thread', 'GSTA-1', '--reads', file], env);
    expect([clean.status, clean.out.trim().split('\n').at(-1)]).toEqual([0, 'ARCHIVE_CHECK: clean thread=GSTA-1 prs=0 issues=0']);
    expect(runBin(repo, 'gstack-archive-check', ['thread', '--reads', file], env).status).toBe(2);
    const unknownEnv = shim(repo, { 'garrytan/gbrain#5': { state: '' } });
    fs.writeFileSync(file, JSON.stringify({ ...reads({ thread: thread('GSTA-1', 'idle', [pr(5, 'garrytan/gbrain')]) }), read_at: new Date().toISOString() }));
    const unknown = runBin(repo, 'gstack-archive-check', ['thread', '--thread', 'GSTA-1', '--reads', file], unknownEnv);
    expect(unknown.status).toBe(3);
    expect(unknown.out).toContain('ARCHIVE_PR_STATE_UNKNOWN');
  });

  // Value: protects=the land step's CLI: usage guards, the merged-PR close lines and the not-merged refusal; fails_when=a bad --pr or --repo reaches gh, or an open PR prints ISSUE_CLOSE
  test('landed: usage exits 2, a merged PR prints its codes, an open PR exits 1', () => {
    if (process.platform === 'win32') return;
    const repo = makeFixtureRepo(); repos.push(repo);
    const env = shim(repo, { 'garrytan/gstack#7': { state: 'MERGED', title: 'Fix x (GST-12)', mergeCommit: { oid: 'd'.repeat(40) } }, 'garrytan/gstack#8': { state: 'OPEN', title: 'Fix y (GST-13)' } });
    const policyFile = path.join(repo.work, '.gstack', 'plain-titles.json');
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.rmSync(policyFile, { force: true });
    const missing = runBin(repo, 'gstack-archive-check', ['landed', '--pr', '7', '--repo', 'garrytan/gstack'], env);
    expect([missing.status, missing.out]).toEqual([3, expect.stringContaining('ARCHIVE_POLICY_UNREADABLE')]);
    fs.writeFileSync(policyFile, '{ not json');
    const invalid = runBin(repo, 'gstack-archive-check', ['landed', '--pr', '7', '--repo', 'garrytan/gstack'], env);
    expect([invalid.status, invalid.out]).toEqual([3, expect.stringContaining('not valid JSON')]);
    fs.writeFileSync(policyFile, JSON.stringify({ codes: ['\\bGST-\\d+\\b'], terms: ['lane'], since: '2026-01-01' }));
    expect(runBin(repo, 'gstack-archive-check', ['landed', '--pr', 'x'], env).status).toBe(2);
    expect(runBin(repo, 'gstack-archive-check', ['landed', '--pr', '7', '--repo', 'bad'], env).status).toBe(2);
    const merged = runBin(repo, 'gstack-archive-check', ['landed', '--pr', '7', '--repo', 'garrytan/gstack'], env);
    expect([merged.status, merged.out.trim()]).toEqual([0, 'ISSUE_CLOSE: GST-12 pr=garrytan/gstack#7 merge=' + 'd'.repeat(12)]);
    const open = runBin(repo, 'gstack-archive-check', ['landed', '--pr', '8', '--repo', 'garrytan/gstack'], env);
    expect(open.status).toBe(1);
    expect(open.out).toContain('ARCHIVE_PR_NOT_MERGED');
  });
});
