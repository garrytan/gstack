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
 *   - A closure issue that cannot be read through gstack-issue-guard is
 *     downgraded to `Refs #N` with ISSUE_UNREADABLE (never Fixes).
 *   - Failing CI run ids map to bot-opened flake issues whose body names the
 *     run id: `Flake: #N (run <id>)`.
 */

export type IssueIntent = 'fixes' | 'refs';
export interface IssueMention { issue: number; intent: IssueIntent; repo?: string; source: string }
export interface IssueLinks { fixes: number[]; refs: number[]; flakes: Array<{ issue: number; run: string }>; cross: string[]; unreadable: number[] }

const CLOSURE = /^\s*(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s+(?:#|GH-)(\d+)\s*$/i;
const PARTIAL = /\b(?:partial(?:ly)?|part of|defer(?:red)?|follow-?up|related|refs?|see|context)\b/i;
const CROSS = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g;
const BARE = /(?<![A-Za-z0-9_./-])#(\d+)\b/g;

/** Mentions in one commit message: trailer lines carry closure intent, everything else is a reference. */
export function mentionsIn(message: string, source = 'commit'): IssueMention[] {
  const out: IssueMention[] = [];
  const seen = new Set<string>();
  const add = (m: IssueMention) => { const k = `${m.repo ?? ''}#${m.issue}:${m.intent}`; if (!seen.has(k)) { seen.add(k); out.push(m); } };
  for (const raw of message.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const trailer = CLOSURE.exec(line);
    if (trailer && !PARTIAL.test(line)) { add({ issue: Number(trailer[1]), intent: 'fixes', source: `${source}: ${line.trim()}` }); continue; }
    for (const c of line.matchAll(CROSS)) add({ issue: Number(c[2]), intent: 'refs', repo: c[1], source: `${source}: ${line.trim()}` });
    const stripped = line.replace(CROSS, '');
    for (const b of stripped.matchAll(BARE)) add({ issue: Number(b[1]), intent: 'refs', source: `${source}: ${line.trim()}` });
  }
  return out;
}

/**
 * Resolve the final link set. `readable(n)` is the gstack-issue-guard probe
 * for a closure candidate; a false answer downgrades it to Refs.
 */
export function resolveLinks(mentions: IssueMention[], explicit: number[], readable: (issue: number) => boolean, flakes: Array<{ issue: number; run: string }> = []): IssueLinks {
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
  return { fixes: [...fixes].sort(asc), refs: [...refs].sort(asc), flakes: [...flakes].sort((a, b) => a.issue - b.issue), cross: [...cross].sort(), unreadable: unreadable.sort(asc) };
}

/** The `## Issues` lines for the PR body; an empty set renders nothing. */
export function renderIssueLines(links: IssueLinks): string[] {
  const lines: string[] = [];
  for (const n of links.fixes) lines.push(`Fixes #${n}`);
  for (const n of links.refs) lines.push(links.unreadable.includes(n) ? `Refs #${n} (unreadable through gstack-issue-guard; not auto-closed)` : `Refs #${n}`);
  for (const c of links.cross) lines.push(`Refs ${c}`);
  for (const f of links.flakes) lines.push(`Flake: #${f.issue} (run ${f.run})`);
  return lines;
}

/** The receipt's `issues` field (lib/headless-artifacts.ts ship-receipt schema). */
export function receiptIssues(links: IssueLinks): { fixes: number[]; refs: number[]; flakes: Array<{ issue: number; run: string }> } {
  return { fixes: links.fixes, refs: links.refs, flakes: links.flakes };
}
