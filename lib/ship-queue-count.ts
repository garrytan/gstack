/**
 * `gstack-ship-queue count` (R119): how many of this repository's PRs are finished and waiting to land, cheap enough
 * to run at every Captain wake. One gh call (one GraphQL query) reads the oldest 100 open PRs with each one's newest
 * commit. A PR is finished when one of the authors opened it (garrytan, capy-ai and garrytan-agents unless --authors
 * says otherwise), it targets the base, it is not a draft, GitHub does not report it conflicting, and the check
 * rollup on its newest commit is SUCCESS. Its wait runs from that commit's date. More than DRAIN_COUNT finished,
 * or one that has waited DRAIN_HOURS or more, prints a DRAIN line: the Captain starts a drain that same turn
 * (docs/captain.md#drain-the-queue).
 */
import type { QueueContext, StepOutput } from './ship-queue';

export const DRAIN_COUNT = 6;
export const DRAIN_HOURS = 24;
export const DEFAULT_AUTHORS = ['garrytan', 'capy-ai', 'garrytan-agents'];
const SHOWN = 10;

export const COUNT_QUERY = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100,orderBy:{field:CREATED_AT,direction:ASC}){totalCount nodes{number title isDraft mergeable baseRefName author{login} commits(last:1){nodes{commit{committedDate statusCheckRollup{state}}}}}}}}';

interface PrNode {
  number: number; title: string; isDraft: boolean; mergeable: string; baseRefName: string; author: { login: string } | null;
  commits: { nodes: Array<{ commit: { committedDate: string; statusCheckRollup: { state: string } | null } }> };
}
export interface FinishedPr { pr: number; title: string; hours: number }

/** A bot's login reads as `capy-ai`, `capy-ai[bot]` or `app/capy-ai` depending on the API; compare the bare name. */
const bare = (login: string) => login.toLowerCase().replace(/^app\//, '').replace(/\[bot\]$/, '');

/** The finished PRs among nodes, oldest wait first. */
export function finishedPrs(nodes: PrNode[], o: { base: string; authors: string[]; now: Date }): FinishedPr[] {
  const authors = new Set(o.authors.map(bare));
  const out: FinishedPr[] = [];
  for (const n of nodes) {
    const head = n.commits?.nodes?.[0]?.commit;
    if (!head || n.isDraft || n.mergeable === 'CONFLICTING' || n.baseRefName !== o.base || !authors.has(bare(n.author?.login ?? ''))) continue;
    if (head.statusCheckRollup?.state !== 'SUCCESS') continue;
    const since = Date.parse(head.committedDate);
    if (Number.isNaN(since)) continue;
    out.push({ pr: n.number, title: n.title, hours: Math.max(0, Math.floor((o.now.getTime() - since) / 3_600_000)) });
  }
  return out.sort((a, b) => b.hours - a.hours || a.pr - b.pr);
}

export function queueCount(ctx: QueueContext, o: { authors?: string[]; now?: Date } = {}): StepOutput {
  const authors = o.authors?.length ? o.authors : DEFAULT_AUTHORS;
  const r = ctx.gh(['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f', `query=${COUNT_QUERY}`]);
  let page: { totalCount: number; nodes: PrNode[] } | undefined;
  try { page = JSON.parse(r.out)?.data?.repository?.pullRequests; } catch { /* reported below */ }
  if (!r.ok || !page || !Array.isArray(page.nodes)) {
    return { ok: false, lines: [], run: 'none', failure: { code: 'QUEUE_NOT_READY', message: `gh could not list the open PRs: ${(r.err || r.out).trim().split('\n')[0]?.slice(0, 200) || 'no data'}`, fix: 'check gh auth status and that this checkout\'s origin is the GitHub repository, then rerun count' } };
  }
  const finished = finishedPrs(page.nodes, { base: ctx.base, authors, now: o.now ?? new Date() });
  const old = finished.filter(f => f.hours >= DRAIN_HOURS);
  const oldest = finished[0];
  const lines = [`QUEUE_COUNT: finished=${finished.length} waited_${DRAIN_HOURS}h=${old.length} oldest=${oldest ? `${oldest.hours}h #${oldest.pr}` : 'none'} open=${page.totalCount} base=${ctx.base} authors=${authors.join(',')}`];
  if (page.totalCount > page.nodes.length) lines.push(`QUEUE_COUNT_PARTIAL: counted the oldest ${page.nodes.length} of ${page.totalCount} open PRs`);
  for (const f of finished.slice(0, SHOWN)) lines.push(`FINISHED: #${f.pr} ${f.hours}h ${f.title}`);
  if (finished.length > SHOWN) lines.push(`FINISHED: and ${finished.length - SHOWN} more`);
  const why = [
    ...(finished.length > DRAIN_COUNT ? [`${finished.length} finished PRs are waiting (more than ${DRAIN_COUNT})`] : []),
    ...(old.length ? [`${old.length} ${old.length === 1 ? 'has' : 'have'} waited ${DRAIN_HOURS}h or more (oldest #${oldest!.pr}, ${oldest!.hours}h)`] : []),
  ];
  if (why.length) lines.push(`DRAIN: ${why.join(' and ')}; start a drain this turn: land them, bundle them, or send each idle owner its next step (docs/captain.md#drain-the-queue)`);
  return { ok: true, lines, run: 'none' };
}
