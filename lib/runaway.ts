/**
 * runaway — read-only detection of runaway Capy threads and subagents (/runaway-stopper, org rule R70).
 * Input is what the host already returns: tools.thread.get (cost, tasks, status, created_at),
 * optionally tools.subagent.list (the whole tree) and transcript items (tools.thread.get transcript,
 * tools: true). Output is one RUNAWAY line per thread, FLAG lines, a DEFER line when the thread is
 * mid-/ship or mid-merge or a standing thread holds an open PR, and a SWEEP total for a directory. It never acts.
 * Only a thread the Captain marks `standing: true` rotates; a crew thread checks in once past 1B own tokens (R70 as
 * amended 2026-11-09), and a thread holding an open PR, or whose PRs the file doesn't list, is never rotated (R91).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isKeepalive, type TranscriptItem } from './ship-calls';

export const LIMITS = {
  ownRotate: 500e6,
  ownWarn: 400e6,
  ownCheckIn: 1e9,
  ageDays: 3,
  activeHours: 24,
  subagentStop: 100e6,
  emptyRate: 0.25,
  emptyWindow: 40,
  emptyMinTurns: 20,
  warmWaitS: 240,
  warmWindowS: 30 * 60,
  maxRounds: 2,
} as const;

export interface Task { label?: string; path?: string; title?: string; status?: string; cost?: { tokens?: number; credits?: number } }
export interface ThreadDoc {
  code?: string; id?: string; title?: string | null; status?: string; created_at?: string; updated_at?: string;
  cost?: { tokens?: number; credits?: number }; tasks?: Task[]; tasks_total?: number; captain_thread?: unknown; crew?: unknown;
  events?: Item[]; standing?: boolean; pull_requests?: Array<{ number?: number; state?: string }>; pull_requests_total?: number;
}
export interface Item extends TranscriptItem { input?: { text?: string } | string; state?: string }
export interface Flag { action: 'ROTATE' | 'STOP' | 'LOOK' | 'WARN' | 'REPORT' | 'CHECK_IN'; text: string }
export interface Verdict {
  code: string; verdict: 'OK' | 'LOOK' | 'WARN' | 'STOP' | 'ROTATE' | 'REPORT' | 'CHECK_IN' | 'DEFER'; captain: boolean;
  own: number; ownBound: 'exact' | 'upper'; total: number; credits: number; ageDays: number; active: boolean;
  empty: { turns: number; empty: number } | null; rounds: ReturnType<typeof reviewRounds>;
  flags: Flag[]; defer: string[]; held: string[];
}

const TERMINAL = new Set(['done', 'failed', 'stopped', 'draft']);
const PR_DONE = new Set(['merged', 'closed']);
const MID_SHIP = /\/ship|\bship\b|\bmerge\b|\btrain\b|\bstamp\b|pregate/i;
const REVIEWISH = /reader|fix-check|cold.?read|panel|outside.?voice|specialist|red.?team|adversarial|review/i;

export const fmtTokens = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? Math.round(n / 1e6) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
const tok = (t: Task) => t.cost?.tokens ?? 0;
const pathOf = (t: Task) => t.path ?? (t.label ?? '').replace(/^Subagent\s+/, '');
const quote = (s: string | undefined) => JSON.stringify((s ?? '').slice(0, 80));

function reportState(item: Item): string | undefined {
  if (item.state) return item.state;
  const raw = typeof item.input === 'string' ? item.input : item.input?.text;
  return raw?.match(/\\?"state\\?"\s*:\s*\\?"(final|needs_you|working)/)?.[1];
}

/** A wait call's operations and timer, from its recorded input; null when the input is unreadable. */
function waitArgs(item: Item): { ops: string; seconds: number | null } | null {
  const raw = typeof item.input === 'string' ? item.input : item.input?.text;
  try {
    const v = JSON.parse(raw ?? '') as { operation_ids?: unknown; duration_seconds?: unknown };
    return { ops: Array.isArray(v.operation_ids) ? [...v.operation_ids].map(String).sort().join(',') : '', seconds: typeof v.duration_seconds === 'number' ? v.duration_seconds : null };
  } catch { return null; }
}

/**
 * Turns from transcript items: an inbound message starts one; end_turn, wait or a final/needs_you report
 * ends one. A turn is empty when it made no call beyond status reads, waits and "working" reports. A warm-wait
 * check-in (crew/docs/captain.md, Warm waits; GST-1597) is not a turn: one whose only call re-issues a wait on the
 * operations the previous turn waited on, or a 240-second timer naming those operations or none, within 30 minutes
 * of the wait that started the run. Any turn that closes on such a wait keeps the run's start, so a status read
 * between check-ins counts but never restarts the 30 minutes.
 */
export function emptyWakes(items: readonly Item[]): { turns: number; empty: number } {
  const sorted = items.filter(i => i.createdAt && i.source !== 'assistant').sort((a, b) => a.createdAt!.localeCompare(b.createdAt!));
  const turns: boolean[] = [];
  let acted = false, open = false;
  let calls: Item[] = [];
  let last: { ops: string; since: number } | null = null;
  const close = () => {
    if (!open) return;
    const closing = calls.at(-1);
    const args = closing?.tool === 'wait' ? waitArgs(closing) : null;
    const at = Date.parse(closing?.createdAt ?? '');
    const same = !!args && !!last && (args.ops ? args.ops === last.ops : args.seconds === LIMITS.warmWaitS);
    if (!(same && calls.length === 1 && at - last!.since <= LIMITS.warmWindowS * 1000)) turns.push(!acted);
    last = args ? (same ? last : { ops: args.ops, since: at }) : null;
    acted = false; open = false; calls = [];
  };
  for (const i of sorted) {
    if (i.source !== 'tool') { close(); continue; }
    open = true;
    calls.push(i);
    const state = i.tool === 'message_agent' || i.tool === 'message_user' ? reportState(i) : undefined;
    if (i.tool !== 'end_turn' && state !== 'working' && !isKeepalive(i)) acted = true;
    if (i.tool === 'end_turn' || i.tool === 'wait' || state === 'final' || state === 'needs_you') close();
  }
  close();
  const window = turns.slice(-LIMITS.emptyWindow);
  return { turns: window.length, empty: window.filter(Boolean).length };
}

/**
 * Review rounds per PR from subagent titles: distinct heads named (at <sha>, @<sha>), or the highest
 * pass/round number. Review subagents whose title names no PR are counted, never attributed.
 */
export function reviewRounds(tasks: readonly Task[]): { pr: string; rounds: number; reviewers: number; unattributed: number } | null {
  const byPr = new Map<string, { heads: Set<string>; pass: number }>();
  let reviewers = 0, unattributed = 0;
  for (const t of tasks) {
    const title = t.title ?? '';
    if (!REVIEWISH.test(title)) continue;
    reviewers++;
    const pr = title.match(/#(\d{2,6})\b/)?.[1];
    if (!pr) { unattributed++; continue; }
    const e = byPr.get(pr) ?? { heads: new Set<string>(), pass: 0 };
    const head = title.match(/(?:\b(?:at|head)\s+\x60?|@)([0-9a-f]{7,40})\b/i)?.[1];
    if (head) e.heads.add(head.slice(0, 7));
    e.pass = Math.max(e.pass, Number(title.match(/\b(?:pass|round|ship)\s*(\d{1,3})\b/i)?.[1] ?? 0));
    byPr.set(pr, e);
  }
  if (!reviewers) return null;
  let worst = { pr: '', rounds: 0, reviewers, unattributed };
  for (const [pr, e] of byPr) {
    const rounds = Math.max(e.heads.size, e.pass, 1);
    if (rounds > worst.rounds) worst = { pr, rounds, reviewers, unattributed };
  }
  return worst;
}

export function assess(doc: ThreadDoc, opts: { items?: Item[]; subagents?: { tasks: Task[]; truncated?: boolean }; now: number }): Verdict {
  const code = doc.code ?? doc.id ?? 'unknown';
  const listed = opts.subagents?.tasks ?? doc.tasks ?? [];
  const total = doc.cost?.tokens ?? 0;
  const own = Math.max(0, total - listed.filter(t => !pathOf(t).includes('.')).reduce((s, t) => s + tok(t), 0));
  const ownBound = (opts.subagents ? opts.subagents.truncated === true : (doc.tasks_total ?? listed.length) > listed.length) ? 'upper' : 'exact';
  const created = Date.parse(doc.created_at ?? '');
  const ageDays = Number.isFinite(created) ? (opts.now - created) / 864e5 : 0;
  const lastItem = (opts.items ?? []).reduce((m, i) => (i.createdAt && i.createdAt > m ? i.createdAt : m), '');
  const lastTurn = Date.parse(lastItem || doc.updated_at || '');
  const active = doc.status === 'working' || doc.status === 'waiting'
    || (Number.isFinite(lastTurn) && opts.now - lastTurn < LIMITS.activeHours * 36e5);
  const captain = doc.captain_thread !== undefined || doc.crew !== undefined;
  const flags: Flag[] = [];
  const held: string[] = [];
  const bound = ownBound === 'upper' ? ' (upper bound)' : '';
  const due = [
    own > LIMITS.ownRotate && 'own_tokens ' + fmtTokens(own) + ' > ' + fmtTokens(LIMITS.ownRotate) + bound,
    active && ageDays > LIMITS.ageDays && 'age ' + ageDays.toFixed(1) + 'd > ' + LIMITS.ageDays + 'd and active',
  ].filter((t): t is string => !!t);
  const warn = own <= LIMITS.ownRotate && own > LIMITS.ownWarn ? 'own_tokens ' + fmtTokens(own) + ' > ' + fmtTokens(LIMITS.ownWarn) + ' warn line' : null;
  const prs = Array.isArray(doc.pull_requests) ? doc.pull_requests : null;
  const openPrs = (prs ?? []).filter(p => !PR_DONE.has(p.state ?? '')).map(p => '#' + (p.number ?? '?'));
  const unseen = !prs || (doc.pull_requests_total ?? prs.length) > prs.length;

  if (captain) {
    for (const text of due) flags.push({ action: 'REPORT', text });
    if (warn) flags.push({ action: 'WARN', text: warn });
  } else if (doc.standing === true) {
    if (openPrs.length || unseen) {
      if (due.length) held.push((openPrs.length ? 'holds an open PR' : "holds PRs it can't see") + '; rotate after every PR merges or closes (R91): '
        + [...openPrs, ...(unseen ? ['unlisted'] : [])].join(' ') + '; due: ' + due.join(', '));
    } else {
      for (const text of due) flags.push({ action: 'ROTATE', text });
      if (warn) flags.push({ action: 'WARN', text: warn });
    }
  } else if (own > LIMITS.ownCheckIn) {
    flags.push({ action: 'CHECK_IN', text: 'own_tokens ' + fmtTokens(own) + ' > ' + fmtTokens(LIMITS.ownCheckIn) + bound + '; a crew thread checks in with its Captain once and keeps its PR (R70)' });
  }
  for (const t of listed) {
    if (tok(t) <= LIMITS.subagentStop) continue;
    const live = !TERMINAL.has(t.status ?? '');
    flags.push({ action: live ? 'STOP' : 'LOOK', text: 'subagent ' + pathOf(t) + ' ' + quote(t.title) + ' ' + fmtTokens(tok(t)) + ' > ' + fmtTokens(LIMITS.subagentStop) + ' (' + (t.status ?? 'unknown') + ')' });
  }
  const empty = opts.items?.length ? emptyWakes(opts.items) : null;
  if (empty && empty.turns >= LIMITS.emptyMinTurns && empty.empty / empty.turns > LIMITS.emptyRate)
    flags.push({ action: 'WARN', text: 'empty_wake ' + Math.round(100 * empty.empty / empty.turns) + '% of ' + empty.turns + ' turns > ' + LIMITS.emptyRate * 100 + '%' });
  const rounds = reviewRounds(listed);
  if (rounds && rounds.rounds > LIMITS.maxRounds) flags.push({ action: 'WARN', text: 'review_rounds ' + rounds.rounds + ' on #' + rounds.pr + ' > ' + LIMITS.maxRounds });

  const shipping = listed.filter(t => MID_SHIP.test(t.title ?? '') && (t.status === 'working' || (t.status === 'waiting' && /#\d+/.test(t.title ?? ''))));
  const stopPaths = listed.filter(t => tok(t) > LIMITS.subagentStop && !TERMINAL.has(t.status ?? '')).map(pathOf);
  const stopsShipping = stopPaths.some(p => shipping.some(t => pathOf(t) === p || pathOf(t).startsWith(p + '.')));
  const defer = shipping.map(t => 'mid-ship or mid-merge: ' + pathOf(t) + ' ' + quote(t.title) + ' ' + t.status + '; act at the next clean point');
  const worst = (['ROTATE', 'REPORT', 'STOP', 'WARN', 'CHECK_IN', 'LOOK'] as const).find(a => flags.some(f => f.action === a));
  const holds = flags.some(f => f.action === 'ROTATE') || stopsShipping;
  const verdict: Verdict['verdict'] = holds && defer.length ? 'DEFER' : held.length && (!worst || worst === 'LOOK') ? 'DEFER' : (worst ?? 'OK');
  return { code, verdict, captain, own, ownBound, total, credits: doc.cost?.credits ?? 0, ageDays, active, empty, rounds, flags, defer, held };
}

export function render(v: Verdict): string[] {
  const e = v.empty ? Math.round(100 * v.empty.empty / Math.max(1, v.empty.turns)) + '%/' + v.empty.turns : 'unmeasured';
  const out = ['RUNAWAY: thread=' + v.code + ' verdict=' + v.verdict + (v.captain ? ' captain=yes' : '') + ' own=' + fmtTokens(v.own) + '(' + v.ownBound + ')'
    + ' total=' + fmtTokens(v.total) + ' credits=' + Math.round(v.credits) + ' age_days=' + v.ageDays.toFixed(1) + ' active=' + (v.active ? 'yes' : 'no')
    + ' empty_wake=' + e + ' max_rounds=' + (v.rounds?.pr ? v.rounds.rounds + '(#' + v.rounds.pr + ')' : '0')
    + ' review_subagents=' + (v.rounds?.reviewers ?? 0) + '(unattributed ' + (v.rounds?.unattributed ?? 0) + ')'];
  for (const f of v.flags) out.push('FLAG: ' + f.action + ' ' + f.text);
  if (v.verdict === 'DEFER') for (const d of v.defer) out.push('DEFER: ' + d);
  for (const h of v.held) out.push('DEFER: ' + h);
  return out;
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** A tools.subagent.list result: an object whose tasks rows carry a path and numeric cost.tokens. */
export function subagentsProblem(x: unknown): string | null {
  const o = x as { tasks?: Task[] } | null;
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.tasks)) return 'expected a tools.subagent.list object with tasks';
  if (o.tasks.some(t => typeof t?.path !== 'string' || typeof t?.cost?.tokens !== 'number')) return 'field=tasks[].path,cost.tokens expected=string,number';
  return null;
}

/** The fields assess reads, checked before it runs, so a bad file is named instead of passing as OK. */
export function inputProblem(doc: unknown): string | null {
  const d = doc as ThreadDoc | null;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'expected a tools.thread.get object';
  if (typeof d.cost?.tokens !== 'number') return 'field=cost.tokens expected=number';
  if (!Number.isFinite(Date.parse(d.created_at ?? ''))) return 'field=created_at expected=ISO time';
  if (d.tasks !== undefined && (!Array.isArray(d.tasks) || d.tasks.some(t => typeof t?.cost?.tokens !== 'number'))) return 'field=tasks[].cost.tokens expected=number';
  return null;
}

function itemsOf(x: unknown): Item[] {
  if (Array.isArray(x)) return x;
  const o = x as { items?: Item[]; transcript?: { items?: Item[] } } | null;
  return o?.items ?? o?.transcript?.items ?? [];
}

const USAGE = [
  'gstack-runaway — find runaway Capy threads and subagents (read-only; /runaway-stopper)',
  '  scan --thread <thread.get json> [--events <transcript json>] [--subagents <subagent.list json>] [--now <iso>]',
  '  scan --dir <dir> [--now <iso>]   reads every <code>.thread.json with its <code>.events.json and <code>.subagents.json',
  '  and <dir>/crew.json (the thread.list codes, {"items": [...]}): an empty crew list is RUNAWAY_INPUT, never a clean SWEEP.',
  'Lines: RUNAWAY (one per thread, largest own tokens first), FLAG ROTATE|STOP|LOOK|WARN|REPORT|CHECK_IN, DEFER, SWEEP (--dir).',
  'Review rounds count only subagent titles that name the PR (#N); the rest show as unattributed.',
  'Limits (R70 as amended 2026-11-09): only a thread file with "standing": true (a merge lane, a watcher, an automation\'s',
  'standing thread) rotates, at own > 500M or active > 3d (warn 400M), and never while it holds an open PR or its',
  'pull_requests are missing or partial (DEFER, R91); any other thread is a crew thread that keeps its PR and gets one',
  'CHECK_IN past 1B own; subagent > 100M stop (LOOK when it already ended); empty wakes > 25% of the last 40 turns',
  '(20+; warm-wait check-ins left out); review rounds > 2 per PR; Captains REPORT, never rotate.',
  'A thread file that is not valid JSON or lacks cost.tokens or created_at prints RUNAWAY_INPUT and is skipped.',
  'Exit 0 after a clean scan, 1 when any input was unreadable, 2 on a usage error.',
];

export function runawayMain(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h') { console.log(USAGE.join('\n')); return 0; }
  const fail = (msg: string) => { console.error('RUNAWAY_USAGE: ' + msg + '\n' + USAGE.join('\n')); return 2; };
  if (cmd !== 'scan') return fail(cmd ? 'unknown command ' + JSON.stringify(cmd) : 'no command');
  const known = ['--thread', '--events', '--subagents', '--dir', '--now'];
  const unknown = rest.find((a, k) => (k % 2 === 0) !== known.includes(a) || (k % 2 === 0 && !a.startsWith('--')));
  const missing = rest.find((a, k) => a.startsWith('--') && (rest[k + 1] === undefined || rest[k + 1]!.startsWith('--')));
  if (missing) return fail(missing + ' needs a value');
  if (unknown) return fail('unknown argument ' + JSON.stringify(unknown));
  const opt = (name: string) => { const k = rest.indexOf('--' + name); return k >= 0 ? rest[k + 1] : undefined; };
  const now = opt('now') ? Date.parse(opt('now')!) : Date.now();
  if (!Number.isFinite(now)) return fail('--now is not an ISO time');
  const dir = opt('dir');
  const threadFile = opt('thread');
  if (!dir === !threadFile) return fail('pass exactly one of --thread <file> or --dir <dir>');
  const sets: Array<{ thread: string; events?: string; subagents?: string }> = [];
  if (threadFile) sets.push({ thread: threadFile, events: opt('events'), subagents: opt('subagents') });
  else {
    if (!fs.existsSync(dir!)) return fail('no directory ' + dir);
    for (const f of fs.readdirSync(dir!).filter(f => f.endsWith('.thread.json')).sort()) {
      const base = path.join(dir!, f.slice(0, -'.thread.json'.length));
      const maybe = (ext: string) => (fs.existsSync(base + ext) ? base + ext : undefined);
      sets.push({ thread: base + '.thread.json', events: maybe('.events.json'), subagents: maybe('.subagents.json') });
    }
  }
  for (const s of sets) for (const f of [s.thread, s.events, s.subagents]) if (f && !fs.existsSync(f)) return fail('no file ' + f);
  const verdicts: Verdict[] = [];
  let unreadable = 0;
  const crewFile = dir ? path.join(dir, 'crew.json') : undefined;
  if (crewFile && fs.existsSync(crewFile)) {
    let problem: string | null = null;
    try {
      const items = (readJson(crewFile) as { items?: unknown })?.items;
      if (!Array.isArray(items)) problem = 'field=items expected=array of thread codes';
      else if (!items.length) problem = 'the crew list is empty; a thread outside every crew lists none, so pass thread.list captain: "<Captain code>"';
    } catch (e) { problem = (e instanceof Error ? e.message : String(e)).split('\n')[0]!; }
    if (problem) { unreadable++; console.log('RUNAWAY_INPUT: file=' + crewFile + ' ' + problem); }
  }
  for (const s of sets) {
    let file = s.thread;
    try {
      const doc = readJson(s.thread);
      const problem = inputProblem(doc);
      if (problem) throw new Error(problem);
      file = s.events ?? file;
      const items = s.events ? itemsOf(readJson(s.events)) : (doc as ThreadDoc).events;
      file = s.subagents ?? file;
      const subagents = s.subagents ? readJson(s.subagents) : undefined;
      const subProblem = subagents === undefined ? null : subagentsProblem(subagents);
      if (subProblem) throw new Error(subProblem);
      verdicts.push(assess(doc, { now, items, subagents }));
    } catch (e) {
      unreadable++;
      console.log('RUNAWAY_INPUT: file=' + file + ' ' + (e instanceof Error ? e.message : String(e)).split('\n')[0] + '; fetch this thread again and rerun');
    }
  }
  verdicts.sort((a, b) => b.own - a.own);
  for (const v of verdicts) console.log(render(v).join('\n'));
  if (dir) {
    const n = (k: Verdict['verdict']) => verdicts.filter(v => v.verdict === k).length;
    console.log('SWEEP: threads=' + verdicts.length + ' rotate=' + n('ROTATE') + ' stop=' + n('STOP') + ' defer=' + n('DEFER')
      + ' report=' + n('REPORT') + ' warn=' + n('WARN') + ' check_in=' + n('CHECK_IN') + ' look=' + n('LOOK') + ' ok=' + n('OK') + ' unreadable=' + unreadable);
  }
  return unreadable ? 1 : 0;
}
