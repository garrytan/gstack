/**
 * Issue links for /ship Step 18 (plan C6). Pure classification over commit
 * messages and explicit flags; the bin (bin/gstack-issue-links) owns the
 * gh / gstack-issue-guard calls.
 *
 * Intent rules:
 *   - `Fixes #N` is written only on explicit closure intent: a `Fixes|Closes|
 *     Resolves #N` trailer line in a commit of the branch, or `--issue N`.
 *   - A bare `#N` mention, a `Refs|See|Part of|Partially fixes|Related` line, a
 *     deferred ask (`defer`, `follow-up`) and every cross-repo id
 *     (`owner/repo#N`) are `Refs #N` — never auto-closed.
 *   - A parenthesised named reference, `(name #N, #M)`, `(name PR #N)` or
 *     `(name issue #N)` where name is one token that is not a closure,
 *     reference, filler or version word (`closing`, `cf.`, `e.g.`, `v1.2`
 *     name nothing), is a cross-repo reference to `name`: rendered as
 *     `Refs name#N`, never a same-repo Refs line or a promotion candidate.
 *     Several in one parenthesis, `(founderstar #837, harness-evals #393)`,
 *     are each their own name's reference.
 *   - `owner/repo#N` naming this repository (ownRepoMentions) is this
 *     repository's own issue, so `Fixes garrytan/gstack#N` closes it.
 *   - A closure issue that cannot be read through gstack-issue-guard is
 *     downgraded to `Refs #N` with ISSUE_UNREADABLE (never Fixes).
 *   - Same-repo references are promotion candidates: the owner's `fix #N`
 *     reply becomes `--issue N`; unattended runs keep them as Refs.
 *   - Failing CI run ids map to bot-opened flake issues of this repository
 *     that name the run (their `flake:json` first_seen.run_id or this repo's
 *     actions/runs/<id> URL) and a test (`flake:json` file › test or a
 *     `Flake: <test>` title): `Flake: #N (run <id>)`. Duplicate test names
 *     keep the lowest issue number.
 *   - Open PRs by other authors that close an issue this PR fixes are
 *     `Related: #N (@author)`; `Supersedes #N` and `Contributed by @author`
 *     (lib/contributor-mode.ts credit lines) only with the owner's
 *     confirmation (--supersedes / --credit).
 */

export type IssueIntent = 'fixes' | 'refs';
export interface IssueMention { issue: number; intent: IssueIntent; repo?: string; source: string }
export interface FlakeLink { issue: number; run: string; test?: string }
export interface RelatedPr { pr: number; repo?: string; author: string; closes: number[]; supersedes?: boolean; credit?: boolean }
export interface IssueLinks {
  fixes: number[]; refs: number[]; flakes: FlakeLink[]; cross: string[]; unreadable: number[]; related?: RelatedPr[];
}
/** One `gh issue list --json number,title,body,author` row. */
export interface IssueRow { number: number; title?: string; body?: string; author?: { login?: string; is_bot?: boolean } }
/** One `closedByPullRequestsReferences` node of an issue this PR fixes. */
export interface ClosingPr { number: number; state?: string; headRefName?: string; author?: { login?: string } | null; repository?: { nameWithOwner?: string } }

const CLOSURE = /^\s*(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#|#|GH-)(\d+)\s*$/i;
const PARTIAL = /\b(?:partial(?:ly)?|part of|defer(?:red)?|follow-?up|related|refs?|see|context)\b/i;
const CROSS = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g;
const BARE = /(?<![A-Za-z0-9_./-])#(\d+)\b/g;
/** One `name #N[, #M]…`, `name PR #N` or `name issue #N`: the name, then every number. */
const NAMED_PART = /([A-Za-z][\w.-]*(?:\/[\w.-]+)?)\s+(?:(?:PR|issue)\s+)?(#\d+(?:,\s*#\d+)*)/gi;
/** A parenthesis holding one or more NAMED_PARTs separated by commas or semicolons. */
const NAMED = new RegExp(`\\((?:${NAMED_PART.source})(?:[,;]\\s*(?:${NAMED_PART.source}))*\\)`, 'gi');
/** Words that open a reference in parentheses without naming a repository. */
const NOT_A_NAME = /^(?:fix(?:es|ed|ing)?|clos(?:e[sd]?|ing)|resolv(?:e[sd]?|ing)|address(?:es|ed|ing)?|implement(?:s|ed|ing)?|supersed(?:es|ed|ing)|replac(?:es|ed|ing)|track(?:s|ed|ing)?|block(?:s|ed|ing)?|dup|duplicates?|bugs?|upstream|refs?|see|related|partial(?:ly)?|part|context|follow-?up|defer(?:red)?|prs?|issues?|gh|via|from|after|since|with|in|by|for|also|cf\.?|e\.?g\.?|i\.?e\.?|and|or|per|of|to|on|at|as|is|was|the|an?|this|that|not|no|vs\.?|like|v\d[\w.-]*)$/i;

/** Mentions in one commit message: trailer lines carry closure intent, everything else is a reference. */
export function mentionsIn(message: string, source = 'commit'): IssueMention[] {
  const out: IssueMention[] = [];
  const seen = new Set<string>();
  const add = (m: IssueMention) => { const k = `${m.repo ?? ''}#${m.issue}:${m.intent}`; if (!seen.has(k)) { seen.add(k); out.push(m); } };
  for (const raw of message.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const trailer = CLOSURE.exec(line);
    if (trailer && !PARTIAL.test(line)) { add({ issue: Number(trailer[2]), intent: 'fixes', ...(trailer[1] ? { repo: trailer[1] } : {}), source: `${source}: ${line.trim()}` }); continue; }
    const rest = line.replace(NAMED, whole => whole.replace(NAMED_PART, (part, name: string, numbers: string) => {
      if (NOT_A_NAME.test(name)) return part;
      for (const n of numbers.matchAll(/#(\d+)/g)) add({ issue: Number(n[1]), intent: 'refs', repo: name, source: `${source}: ${line.trim()}` });
      return ' ';
    }));
    for (const c of rest.matchAll(CROSS)) add({ issue: Number(c[2]), intent: 'refs', repo: c[1], source: `${source}: ${line.trim()}` });
    const stripped = rest.replace(CROSS, '');
    for (const b of stripped.matchAll(BARE)) add({ issue: Number(b[1]), intent: 'refs', source: `${source}: ${line.trim()}` });
  }
  return out;
}

/** Mentions whose `owner/repo` is `repo` (case-insensitive) become this repository's own; the rest are unchanged. */
export function ownRepoMentions(mentions: IssueMention[], repo: string | undefined): IssueMention[] {
  if (!repo) return mentions;
  const out: IssueMention[] = [];
  for (const m of mentions) {
    const { repo: named, ...own } = m;
    const next: IssueMention = named?.toLowerCase() === repo.toLowerCase() ? own : m;
    if (!out.some(o => o.repo === next.repo && o.issue === next.issue && o.intent === next.intent)) out.push(next);
  }
  return out;
}

/**
 * Resolve the final link set. `readable(n)` is the gstack-issue-guard probe
 * for a closure candidate; a false answer downgrades it to Refs.
 */
export function resolveLinks(mentions: IssueMention[], explicit: number[], readable: (issue: number) => boolean, flakes: FlakeLink[] = [], related: RelatedPr[] = []): IssueLinks {
  const fixes = new Set<number>(explicit);
  const refs = new Set<number>();
  const cross = new Set<string>();
  for (const m of mentions) {
    if (m.repo) { cross.add(`${m.repo}#${m.issue}`); continue; }
    if (m.intent === 'fixes') fixes.add(m.issue); else refs.add(m.issue);
  }
  const unreadable: number[] = [];
  for (const n of [...fixes]) if (!readable(n)) { fixes.delete(n); refs.add(n); unreadable.push(n); }
  for (const n of fixes) refs.delete(n);
  for (const f of flakes) refs.delete(f.issue);
  const asc = (a: number, b: number) => a - b;
  return {
    fixes: [...fixes].sort(asc), refs: [...refs].sort(asc), flakes: [...flakes].sort((a, b) => a.issue - b.issue), cross: [...cross].sort(), unreadable: unreadable.sort(asc),
    ...(related.length ? { related } : {}),
  };
}

/** Same-repo references the owner may promote with `fix #N` (unreadable closure issues excluded), with the first line naming each. */
export function promotionCandidates(mentions: IssueMention[], links: IssueLinks): Array<{ issue: number; source: string }> {
  const out: Array<{ issue: number; source: string }> = [];
  for (const m of mentions) {
    if (!m.repo && links.refs.includes(m.issue) && !links.unreadable.includes(m.issue) && !out.some(c => c.issue === m.issue)) out.push({ issue: m.issue, source: m.source });
  }
  return out.sort((a, b) => a.issue - b.issue);
}

const isBot = (author: IssueRow['author']): boolean => author?.is_bot === true || /^app\/|\[bot\]$/.test(author?.login ?? '');
const FLAKE_JSON = /<!--\s*flake:json\s*-->\s*```json\s*\r?\n([\s\S]*?)\r?\n```/;
const RUN_URL = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/(\d+)(?!\d)/g;

/** The test an issue is a flake of and the runs it names; undefined test when it names none. */
function flakeIdentity(row: IssueRow): { test?: string; jsonRun?: string } {
  const block = FLAKE_JSON.exec(row.body ?? '');
  if (block) {
    try {
      const j = JSON.parse(block[1]!) as { file?: unknown; test?: unknown; first_seen?: { run_id?: unknown } };
      if (typeof j.file === 'string' && j.file) {
        return { test: typeof j.test === 'string' && j.test ? `${j.file} › ${j.test}` : j.file, jsonRun: j.first_seen?.run_id === undefined ? undefined : String(j.first_seen.run_id) };
      }
    } catch { /* an unparsable block names no test; the title may */ }
  }
  const title = /^flake:\s*(\S.*)$/i.exec((row.title ?? '').trim());
  return { test: title?.[1] };
}

/**
 * The open issues a `"<run>" in:body` search returned, narrowed to bot-opened
 * flake issues of `repo` that name this run and a test. Every other row is
 * rejected with its reason; two issues for the same test keep the lowest number.
 */
export function selectFlakes(run: string, repo: string, rows: IssueRow[]): { flakes: FlakeLink[]; rejected: Array<{ issue: number; reason: string }> } {
  const flakes: FlakeLink[] = [];
  const rejected: Array<{ issue: number; reason: string }> = [];
  for (const row of [...rows].sort((a, b) => a.number - b.number)) {
    if (!isBot(row.author)) { rejected.push({ issue: row.number, reason: `opened by @${row.author?.login ?? 'unknown'}, not a bot` }); continue; }
    const { test, jsonRun } = flakeIdentity(row);
    if (!test) { rejected.push({ issue: row.number, reason: 'names no test (no flake:json file, no "Flake: <test>" title)' }); continue; }
    const urls = [...(row.body ?? '').matchAll(RUN_URL)].filter(m => m[2] === run).map(m => m[1]!);
    if (jsonRun !== run && !urls.some(u => u.toLowerCase() === repo.toLowerCase())) {
      rejected.push({ issue: row.number, reason: urls.length ? `names run ${run} of ${[...new Set(urls)].join(', ')}, not ${repo}` : `does not name run ${run} of ${repo}` });
      continue;
    }
    const first = flakes.find(f => f.test === test);
    if (first) { rejected.push({ issue: row.number, reason: `duplicate of #${first.issue} (${test})` }); continue; }
    flakes.push({ issue: row.number, run, test });
  }
  return { flakes, rejected };
}

/**
 * Open PRs by other authors whose closing set overlaps `fixes`. `closing`
 * maps each fixed issue to the PRs that close it; this branch's own PR and the
 * viewer's PRs are excluded. A PR in another repository keeps its repo.
 */
export function relatedPrs(closing: Map<number, ClosingPr[]>, ctx: { repo: string; viewer: string; branch?: string }): RelatedPr[] {
  const byKey = new Map<string, RelatedPr>();
  for (const [issue, prs] of closing) {
    for (const pr of prs) {
      const prRepo = pr.repository?.nameWithOwner;
      const same = !prRepo || prRepo.toLowerCase() === ctx.repo.toLowerCase();
      const author = pr.author?.login ?? 'ghost';
      if ((pr.state ?? 'OPEN') !== 'OPEN' || author.toLowerCase() === ctx.viewer.toLowerCase() || (same && ctx.branch && pr.headRefName === ctx.branch)) continue;
      const key = `${same ? '' : prRepo}#${pr.number}`;
      const row = byKey.get(key) ?? { pr: pr.number, ...(same ? {} : { repo: prRepo }), author, closes: [] };
      if (!row.closes.includes(issue)) row.closes.push(issue);
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].map(r => ({ ...r, closes: r.closes.sort((a, b) => a - b) })).sort((a, b) => (a.repo ?? '').localeCompare(b.repo ?? '') || a.pr - b.pr);
}

const prId = (r: RelatedPr) => `${r.repo ?? ''}#${r.pr}`;

/** The `## Issues` lines for the PR body; an empty set renders nothing. */
export function renderIssueLines(links: IssueLinks): string[] {
  const lines: string[] = [];
  for (const n of links.fixes) lines.push(`Fixes #${n}`);
  for (const n of links.refs) lines.push(links.unreadable.includes(n) ? `Refs #${n} (unreadable through gstack-issue-guard; not auto-closed)` : `Refs #${n}`);
  for (const c of links.cross) lines.push(`Refs ${c}`);
  for (const f of links.flakes) lines.push(`Flake: #${f.issue} (run ${f.run})`);
  for (const r of links.related ?? []) {
    lines.push(r.supersedes ? `Supersedes ${prId(r)}` : `Related: ${prId(r)} (@${r.author})`);
    if (r.credit) lines.push(`Contributed by @${r.author}`);
  }
  return lines;
}

/** Where each added line came from, for the PR-body preview (one `<line> ← <source>` per Related/Supersedes/Contributed/Flake line). */
export function lineSources(links: IssueLinks): string[] {
  const out: string[] = [];
  for (const f of links.flakes) out.push(`Flake: #${f.issue} (run ${f.run}) ← bot flake issue for ${f.test ?? 'an unnamed test'}`);
  for (const r of links.related ?? []) {
    const closes = `open PR closing ${r.closes.map(n => `#${n}`).join(', ')}`;
    out.push(r.supersedes ? `Supersedes ${prId(r)} ← ${closes} by @${r.author}; owner confirmed --supersedes` : `Related: ${prId(r)} (@${r.author}) ← ${closes}`);
    if (r.credit) out.push(`Contributed by @${r.author} ← ${prId(r)}, ${closes}; owner confirmed --credit`);
  }
  return out;
}

/** The receipt's `issues` field (lib/headless-artifacts.ts ship-receipt schema); `related` only when a PR is listed. */
export function receiptIssues(links: IssueLinks): { fixes: number[]; refs: number[]; flakes: Array<{ issue: number; run: string }>; related?: RelatedPr[] } {
  return { fixes: links.fixes, refs: links.refs, flakes: links.flakes.map(f => ({ issue: f.issue, run: f.run })), ...(links.related ? { related: links.related } : {}) };
}
