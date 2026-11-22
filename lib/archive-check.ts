/**
 * gstack-archive-check logic (GST-2188; R86, R91). A Captain runs it right
 * before archiving a crew thread. Capy's thread and issue state lives behind
 * Capy tools a bin cannot call, so the Captain does those reads
 * (tools.thread.get, tools.issue.read) in one execute program and hands them
 * over raw; this module parses them, failing closed on anything it cannot
 * fully read, and re-reads every PR the thread holds from GitHub.
 *
 * R91: a thread that holds an open PR is never archived, successor or not.
 * An open issue still assigned to the thread refuses too until it is
 * re-assigned to a live thread or closed. Every run prints a handoff stub
 * (PR, branch, head, CI at that head, open issues) for a successor brief.
 *
 * landedIssues serves the land step: the tracker codes in a merged PR's
 * trailing title group (R76), which the Captain then closes with
 * tools.issue.update in the same program (crew/docs/captain.md).
 */
import { splitTitle, type PlainTitlePolicy } from './plain-title';
import { ciAtHead, type Gh } from './ship-queue';

export type ArchiveCode = 'ARCHIVE_READS_STALE' | 'ARCHIVE_READS_UNPARSED' | 'ARCHIVE_THREAD_MISMATCH' | 'ARCHIVE_PR_NOT_MERGED' | 'ARCHIVE_GH_READ_FAILED' | 'ARCHIVE_PR_STATE_UNKNOWN' | 'ARCHIVE_POLICY_UNREADABLE';
export interface ArchiveFailure { code: ArchiveCode; message: string }
export interface IssueRow { code: string; state: string; title: string }
export interface IssueList { open: string[]; closed: string[]; issues: IssueRow[] }
interface ThreadPr { repo: string; number: number; state: string; relation: string }
interface ThreadRead { code: string; status: string; prs: ThreadPr[] }
interface LivePr { repo: string; number: number; state: string; head: string; branch: string; title: string; ci: string }

export const MAX_READ_AGE_MS = 15 * 60_000;
const MAX_CLOCK_SKEW_MS = 2 * 60_000;
const NOT_WORK = new Set(['Backlog', 'Needs you']);
const ISSUE_CODE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);
const AGE = /^\d+[mhd]$/;
const SUB_ISSUES = /^\d+\/\d+ sub-issues closed$/;
const stateUnknown = (ref: string, state: unknown): ArchiveFailure => ({ code: 'ARCHIVE_PR_STATE_UNKNOWN', message: ref + ': gh pr view returned state ' + JSON.stringify(state) + ', not OPEN, CLOSED or MERGED' });

export interface CheckOptions {
  thread: string;
  now: number;
  ghFor: (repo: string) => Gh;
  ci?: (repo: string, sha: string) => string;
}
export interface CheckResult {
  verdict: 'clean' | 'refused' | 'unreadable';
  lines: string[];
  stub: string;
  failure?: ArchiveFailure;
  json: Record<string, unknown>;
}

const unparsed = (part: string, why: string): ArchiveFailure => ({ code: 'ARCHIVE_READS_UNPARSED', message: part + ': ' + why });
const isFailure = (v: unknown): v is ArchiveFailure => typeof v === 'object' && v !== null && 'code' in v && 'message' in v && !('issues' in v);

/** tools.issue.read list text: the States header is required; each row is "- CODE · state · [markers ·] @assignee|unassigned · title · [n/m sub-issues closed ·] age". */
export function parseIssueList(text: unknown): IssueList | ArchiveFailure {
  if (typeof text !== 'string' || !text.trim()) return unparsed('issues', 'empty or not the text of tools.issue.read');
  const lines = text.split('\n');
  const header = lines.find(l => l.startsWith('States:'));
  if (!header) return unparsed('issues', 'no "States:" header line, so this is not a whole tools.issue.read list');
  const [openPart, closedPart = ''] = header.slice('States:'.length).split(/\s+·\s+closed:/);
  const names = (s: string) => s.split(',').map(x => x.replace(/\(default\)/, '').trim()).filter(Boolean);
  const open = names(openPart!);
  const closed = names(closedPart);
  const issues: IssueRow[] = [];
  let none = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'No issues match.') { none = true; continue; }
    if (!line || line === header.trim() || line.startsWith('Labels:')) continue;
    const parts = line.startsWith('- ') ? line.slice(2).split(/\s+·\s+/) : [];
    const [code, state] = parts;
    if (!code || !ISSUE_CODE.test(code) || !state) return unparsed('issues', 'unrecognized line ' + JSON.stringify(line.slice(0, 80)));
    if (!open.includes(state) && !closed.includes(state)) return unparsed('issues', code + ' has state ' + JSON.stringify(state) + ', which the States header does not name');
    const at = parts.findIndex((p, i) => i >= 2 && (p.startsWith('@') || p === 'unassigned'));
    const end = parts.length - 1 - (SUB_ISSUES.test(parts.at(-2) ?? '') ? 1 : 0);
    if (at < 0 || !AGE.test(parts.at(-1)!) || end <= at + 1) return unparsed('issues', code + ' row is cut short (no assignee, title or age): ' + JSON.stringify(line.slice(0, 80)));
    issues.push({ code, state, title: parts.slice(at + 1, end).join(' · ') });
  }
  if (!issues.length && !none) return unparsed('issues', 'no issue rows and no "No issues match." line, so the list may be cut off');
  return { open, closed, issues };
}

function parseThread(v: unknown): ThreadRead | ArchiveFailure {
  const t = v as Record<string, unknown> | null;
  if (!t || typeof t !== 'object' || typeof t.code !== 'string' || typeof t.status !== 'string') return unparsed('thread', 'not a tools.thread.get result (code and status missing)');
  if (!Array.isArray(t.pull_requests)) return unparsed('thread', 'no pull_requests array');
  if (typeof t.pull_requests_total !== 'number' || t.pull_requests_total !== t.pull_requests.length) return unparsed('thread', 'pull_requests_total ' + String(t.pull_requests_total) + ' differs from the ' + t.pull_requests.length + ' listed, so the list is truncated');
  const prs: ThreadPr[] = [];
  for (const p of t.pull_requests as Array<Record<string, unknown>>) {
    if (typeof p?.repo !== 'string' || !REPO.test(p.repo) || !Number.isInteger(p.number) || typeof p.state !== 'string') return unparsed('thread', 'a pull_requests row lacks repo, number or state');
    prs.push({ repo: p.repo, number: p.number as number, state: p.state, relation: typeof p.relation === 'string' ? p.relation : '' });
  }
  return { code: t.code, status: t.status, prs };
}

function readPr(gh: Gh, repo: string, n: number): Omit<LivePr, 'ci'> | ArchiveFailure {
  const ghFail = (why: string): ArchiveFailure => ({ code: 'ARCHIVE_GH_READ_FAILED', message: repo + '#' + n + ': ' + why });
  const r = gh(['pr', 'view', String(n), '--repo', repo, '--json', 'number,url,state,headRefOid,headRefName,title']);
  if (!r.ok) return ghFail((r.err ?? r.out).trim().slice(0, 160) || 'gh pr view failed');
  let j: Record<string, unknown>;
  try { j = JSON.parse(r.out); } catch { return ghFail('gh pr view printed no JSON'); }
  const url = typeof j.url === 'string' ? j.url.toLowerCase() : '';
  if (j.number !== n || !url.endsWith(('github.com/' + repo + '/pull/' + n).toLowerCase())) return ghFail('gh answered for ' + (url || 'another PR') + ', not this PR');
  if (typeof j.state !== 'string' || !PR_STATES.has(j.state)) return stateUnknown(repo + '#' + n, j.state);
  return { repo, number: n, state: j.state, head: typeof j.headRefOid === 'string' ? j.headRefOid : '', branch: typeof j.headRefName === 'string' ? j.headRefName : '', title: typeof j.title === 'string' ? j.title : '' };
}

function renderStub(thread: string, readAt: string, prs: LivePr[], issues: IssueRow[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  return [
    '<!-- handoff-stub -->',
    '### Handoff from ' + thread + ' (Capy read ' + readAt + ')',
    '',
    prs.length ? '| PR | Title | Branch | Head | CI at head |\n|---|---|---|---|---|\n' + prs.map(p => '| ' + p.repo + '#' + p.number + ' | ' + cell(p.title) + ' | ' + cell(p.branch) + ' | ' + p.head + ' | ' + cell(p.ci) + ' |').join('\n') : 'Open PRs: none',
    '',
    issues.length ? 'Open issues:\n' + issues.map(i => '- ' + i.code + ' · ' + i.state + (i.title ? ' · ' + i.title : '')).join('\n') : 'Open issues: none',
    '<!-- /handoff-stub -->',
    '',
  ].join('\n');
}

/** The pre-archive check: clean only when the thread holds no open PR (read live) and no open working issue. */
export function checkThread(raw: unknown, o: CheckOptions): CheckResult {
  const r = raw as Record<string, unknown> | null;
  const fail = (failure: ArchiveFailure): CheckResult => ({ verdict: 'unreadable', lines: ['ARCHIVE_CHECK: unreadable thread=' + o.thread + ' (' + failure.code + ')'], stub: '', failure, json: { verdict: 'unreadable', thread: o.thread, prs: [], issues: [], notes: [], failure } });
  if (!r || typeof r !== 'object') return fail(unparsed('reads', 'not a JSON object'));
  const readAt = typeof r.read_at === 'string' ? Date.parse(r.read_at) : NaN;
  if (Number.isNaN(readAt)) return fail(unparsed('read_at', 'missing or not an ISO time'));
  const age = o.now - readAt;
  if (age > MAX_READ_AGE_MS || age < -MAX_CLOCK_SKEW_MS) return fail({ code: 'ARCHIVE_READS_STALE', message: 'read_at ' + String(r.read_at) + ' is ' + Math.round(age / 60_000) + ' min from now; reads must be under ' + MAX_READ_AGE_MS / 60_000 + ' min old' });
  const thread = parseThread(r.thread);
  if (isFailure(thread)) return fail(thread);
  if (thread.code !== o.thread) return fail({ code: 'ARCHIVE_THREAD_MISMATCH', message: 'the reads are for ' + thread.code + ', not ' + o.thread });
  const list = parseIssueList(r.issues);
  if (isFailure(list)) return fail(list);

  const live: LivePr[] = [];
  for (const p of thread.prs) {
    const pr = readPr(o.ghFor(p.repo), p.repo, p.number);
    if (isFailure(pr)) return fail(pr);
    if (pr.state !== 'OPEN') continue;
    let ci: string;
    try {
      ci = (o.ci ?? ((repo, sha) => {
        const line = ciAtHead({ repoRoot: process.cwd(), base: 'main', gh: o.ghFor(repo) }, sha).line;
        const failed = /^unknown at \S+ \((.*)\)$/.exec(line);
        if (failed) throw new Error(failed[1]);
        return line;
      }))(p.repo, pr.head);
    } catch (e: any) { ci = 'unknown (CI read failed: ' + String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 160) + ')'; }
    live.push({ ...pr, ci });
  }
  const openIssues = list.issues.filter(i => list.open.includes(i.state));
  const work = openIssues.filter(i => !NOT_WORK.has(i.state));
  const lines = [
    ...live.map(p => 'ORPHAN: pr ' + p.repo + '#' + p.number + ' open head=' + p.head.slice(0, 12) + ' ci=' + p.ci + ' (R91: never archive a thread that holds an open PR; it stays until the PR merges or closes)'),
    ...work.map(i => 'ORPHAN: issue ' + i.code + ' ' + i.state + ' (re-assign it to a live thread or close it)'),
    ...openIssues.filter(i => NOT_WORK.has(i.state)).map(i => 'NOTE: issue ' + i.code + ' ' + i.state + ' (not live work; re-assign or close it when the work is dropped)'),
  ];
  const verdict = live.length || work.length ? 'refused' : 'clean';
  lines.push('ARCHIVE_CHECK: ' + verdict + ' thread=' + o.thread + ' prs=' + live.length + ' issues=' + work.length);
  return {
    verdict, lines,
    stub: renderStub(o.thread, String(r.read_at), live, openIssues),
    json: { verdict, thread: o.thread, prs: live, issues: openIssues.map(i => ({ code: i.code, state: i.state, orphan: !NOT_WORK.has(i.state) })), notes: lines.filter(l => l.startsWith('NOTE: ')) },
  };
}

export interface LandedResult { exit: 0 | 1 | 3; lines: string[]; codes: string[]; failure?: ArchiveFailure; json: Record<string, unknown> }

/** The tracker codes a merged PR names in its title's trailing group: what the land step closes. */
export function landedIssues(o: { pr: number; repo?: string; gh: Gh; policy: PlainTitlePolicy | null; policyError?: string }): LandedResult {
  const ref = (o.repo ?? '') + '#' + o.pr;
  const fail = (exit: 1 | 3, failure: ArchiveFailure): LandedResult => ({ exit, lines: ['ISSUE_CLOSE: refused pr=' + ref + ' (' + failure.code + ')'], codes: [], failure, json: { pr: o.pr, repo: o.repo ?? null, codes: [], failure } });
  if (!o.policy?.codes.length) return fail(3, { code: 'ARCHIVE_POLICY_UNREADABLE', message: o.policyError ?? (o.policy ? '.gstack/plain-titles.json lists no tracker codes' : '.gstack/plain-titles.json is missing') + ', so no ref can be proven a tracker code' });
  const r = o.gh(['pr', 'view', String(o.pr), ...(o.repo ? ['--repo', o.repo] : []), '--json', 'number,url,state,title,mergeCommit']);
  if (!r.ok) return fail(3, { code: 'ARCHIVE_GH_READ_FAILED', message: ref + ': ' + ((r.err ?? r.out).trim().slice(0, 160) || 'gh pr view failed') });
  let j: Record<string, unknown>;
  try { j = JSON.parse(r.out); } catch { return fail(3, { code: 'ARCHIVE_GH_READ_FAILED', message: ref + ': gh pr view printed no JSON' }); }
  const repo = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(typeof j.url === 'string' ? j.url : '')?.[1] ?? o.repo ?? '';
  if (j.number !== o.pr || (o.repo && repo.toLowerCase() !== o.repo.toLowerCase())) return fail(3, { code: 'ARCHIVE_GH_READ_FAILED', message: ref + ': gh answered for another PR' });
  if (typeof j.state !== 'string' || !PR_STATES.has(j.state)) return fail(3, stateUnknown(repo + '#' + o.pr, j.state));
  if (j.state !== 'MERGED') return fail(1, { code: 'ARCHIVE_PR_NOT_MERGED', message: repo + '#' + o.pr + ' is ' + String(j.state) });
  const merge = String((j.mergeCommit as { oid?: unknown } | null)?.oid ?? '').slice(0, 12);
  const refs = splitTitle(typeof j.title === 'string' ? j.title : '').refs?.split(/[\s,]+/) ?? [];
  const patterns = o.policy.codes.map(c => new RegExp(c, 'i'));
  const codes = [...new Set(refs.map(x => x.toUpperCase()).filter(x => ISSUE_CODE.test(x) && patterns.some(p => p.test(x))))];
  const lines = codes.length ? codes.map(c => 'ISSUE_CLOSE: ' + c + ' pr=' + repo + '#' + o.pr + ' merge=' + merge) : ['ISSUE_CLOSE: none (the title names no tracker code)'];
  return { exit: 0, lines, codes, json: { pr: o.pr, repo, merge, codes } };
}
