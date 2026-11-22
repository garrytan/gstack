/**
 * autoplan-owner-text — the parts of a plan that say what the owner asked for
 * and what they will do on day one (GST-2947). `### Owner's words` quotes the
 * owner, one bullet per quote with who and when: only these lines are the
 * plan's direction, so a reviewer's challenge to anything else the plan says
 * is an ordinary proposal (lib/autoplan-gate-items.ts). `### Day one` is the
 * table of the owner's first actions (action, frequency, source, feature,
 * route, first build, check); a row whose source is `assumed` becomes an
 * owner question at the gate. `### What it won't do yet` lists the plan's
 * cuts. Read by the gate builder and the owner and captain briefs.
 */
import { findSection } from './markdown-sections';

export const OWNER_WORDS_TITLES = ["Owner's words", 'Owner words'];
export const DAY_ONE_TITLES = ['Day one', 'Day-one page', 'Day one page'];
export const CUTS_TITLES = ["What it won't do yet", 'What it will not do yet', "Won't do yet"];
export const DAY_ONE_COLUMNS = ['action', 'frequency', 'source', 'feature', 'route', 'first build', 'check'] as const;

export interface OwnerQuote { n: number; who: string; text: string }
export interface OwnerWordsSection { status: 'none' | 'ok' | 'malformed'; quotes: OwnerQuote[]; reason?: string; fix?: string }
export interface DayOneRow { action: string; frequency: string; source: string; feature: string; route: string; first_build: string; check: string; assumed: boolean }
export interface DayOneTable { status: 'none' | 'ok' | 'malformed'; rows: DayOneRow[]; reason?: string }

const BULLET = /^\s*[-*+]\s+(.*)$/;
const QUOTED = /[“"](.+)[”"]/;

/** The quotes under `### Owner's words`; a bullet with no quoted words makes the section malformed (its other quotes still count). */
export function parseOwnerWords(planText: string): OwnerWordsSection {
  const section = findSection(planText, OWNER_WORDS_TITLES);
  if (!section) return { status: 'none', quotes: [] };
  const bullets = section.body.split('\n').map(l => BULLET.exec(l)?.[1]?.trim()).filter((b): b is string => !!b);
  const fix = 'one bullet per quote: - <who>, <when>: "<their exact words>"';
  if (!bullets.length) return { status: 'malformed', quotes: [], reason: 'the section has no bullet list', fix };
  const quotes: OwnerQuote[] = [];
  const bad: number[] = [];
  bullets.forEach((b, i) => {
    const m = QUOTED.exec(b);
    if (!m || !m[1]!.trim()) { bad.push(i + 1); return; }
    quotes.push({ n: i + 1, who: b.slice(0, m.index).replace(/[\s:,-]+$/, '').trim() || 'unattributed', text: m[1]!.trim() });
  });
  return bad.length ? { status: 'malformed', quotes, reason: `bullet ${bad.join(', ')} quotes no words`, fix } : { status: 'ok', quotes };
}

/** The OWNER_WORDS line `next` and the gate print. */
export function ownerWordsLine(w: OwnerWordsSection, unverified = 0): string {
  if (w.status === 'none') return "OWNER_WORDS: none (no ### Owner's words section: reviewer challenges keep the plan's direction, and the gate asks the owner to confirm it)";
  if (w.status === 'malformed') return `OWNER_WORDS: malformed (${w.reason}; fix: ${w.fix}); ${w.quotes.length} quote${w.quotes.length === 1 ? '' : 's'} read`;
  return `OWNER_WORDS: ${w.quotes.length} quote${w.quotes.length === 1 ? '' : 's'}${unverified ? ` (${unverified} unverified: not found in a recorded owner reply)` : ''}`;
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const header = (c: string) => c.toLowerCase().replace(/[*_`]/g, '').replace(/[-\s]+/g, ' ').trim();

/** The `### Day one` table: the first table under the heading, with every DAY_ONE_COLUMNS column in any order. */
export function parseDayOne(planText: string): DayOneTable {
  const section = findSection(planText, DAY_ONE_TITLES);
  if (!section) return { status: 'none', rows: [] };
  const lines = section.body.split('\n');
  const start = lines.findIndex((l, i) => /^\s*\|/.test(l) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? ''));
  if (start < 0) return { status: 'malformed', rows: [], reason: `no table (columns: ${DAY_ONE_COLUMNS.join(', ')})` };
  const head = cells(lines[start]!).map(header);
  const missing = DAY_ONE_COLUMNS.filter(c => !head.includes(c));
  if (missing.length) return { status: 'malformed', rows: [], reason: `the table has no ${missing.join(', ')} column` };
  const at = (row: string[], c: string) => row[head.indexOf(c)] ?? '';
  const rows: DayOneRow[] = [];
  for (let i = start + 2; i < lines.length && /^\s*\|/.test(lines[i]!); i++) {
    const row = cells(lines[i]!);
    if (!at(row, 'action')) continue;
    const source = at(row, 'source');
    rows.push({ action: at(row, 'action'), frequency: at(row, 'frequency'), source, feature: at(row, 'feature'), route: at(row, 'route'),
      first_build: at(row, 'first build'), check: at(row, 'check'), assumed: /^\W*assumed\b/i.test(source) });
  }
  return rows.length ? { status: 'ok', rows } : { status: 'malformed', rows: [], reason: 'the table has no rows' };
}

/**
 * What the owner reads first at the gate (lib/captain-brief.ts, lib/owner-brief.ts): the day-one table, what the first
 * build won't do yet, and the quoted owner words a reviewer needs the owner's answer to change. Empty when the plan has none.
 */
export function renderDayOne(planText: string, quotes: Array<OwnerQuote & { verified?: boolean }> = []): string[] {
  const day = parseDayOne(planText);
  const cuts = parseCuts(planText);
  const out: string[] = [];
  if (day.status === 'ok') {
    out.push('### Day one', '', 'What you can do with it on day one:', '', '| What you do | How often | Feature | How you get there | First build with it | How we check it works |', '|---|---|---|---|---|---|',
      ...day.rows.map(r => `| ${r.action}${r.assumed ? ' (our guess: asked below)' : ''} | ${r.frequency} | ${r.feature} | ${r.route} | ${r.first_build} | ${r.check} |`), '');
  }
  if (cuts.length) out.push("### What it won't do yet", '', ...cuts.map(c => `- ${c}`), '');
  if (quotes.length) out.push('### Your words this plan follows', '', ...quotes.map(q => `- ${q.who}: “${q.text}”${q.verified === false ? ' (not found in your recorded replies)' : ''}`), '',
    'A reviewer who wants to change one of these needs your answer. Anything else in the plan was written by the planning agent, so a reviewer\'s change to it is recommended below.', '');
  return out;
}

/** The bullets under `### What it won't do yet`. */
export function parseCuts(planText: string): string[] {
  const section = findSection(planText, CUTS_TITLES);
  return section ? section.body.split('\n').map(l => BULLET.exec(l)?.[1]?.trim()).filter((b): b is string => !!b) : [];
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'its', 'not', 'yet', 'will', 'won', 'are', 'has', 'have', 'one', 'all', 'any', 'each', 'every', 'day', 'first', 'build', 'v0', 'v1']);
const words = (t: string) => [...new Set((t.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length >= 3 && !STOP.has(w)))];
const covers = (want: string[], have: Set<string>) => {
  const hit = want.filter(w => have.has(w)).length;
  return want.length > 0 && hit >= Math.min(2, want.length) && hit / want.length >= 0.6;
};
/** A cut drops `target` (a feature, an action or a quote) when either names most of the other's words. */
export function cutDrops(cut: string, target: string): boolean {
  const c = words(cut), t = words(target);
  return covers(t, new Set(c)) || covers(c, new Set(t));
}

/** Text compared as words: case, punctuation and spacing ignored. */
export const wordKey = (t: string) => ` ${(t.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(' ')} `;
