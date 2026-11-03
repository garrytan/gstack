/**
 * runaway — read-only detection of runaway Capy threads and subagents (/runaway-stopper, org rule R70).
 * Input is what the host already returns: tools.thread.get (cost, tasks, status, created_at),
 * optionally tools.subagent.list (the whole tree) and transcript items (tools.thread.get transcript,
 * tools: true). Output is one RUNAWAY line per thread, FLAG lines, a DEFER line when the thread is
 * mid-/ship or mid-merge, and a SWEEP total for a directory. It never acts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isKeepalive, type TranscriptItem } from './ship-calls';

export const LIMITS = {
  ownRotate: 500e6,
  ownWarn: 400e6,
  ageDays: 3,
  activeHours: 24,
  subagentStop: 100e6,
  emptyRate: 0.25,
  emptyWindow: 40,
  emptyMinTurns: 20,
  maxRounds: 2,
} as const;

export interface Task { label?: string; path?: string; title?: string; status?: string; cost?: { tokens?: number; credits?: number } }
export interface ThreadDoc {
  code?: string; id?: string; title?: string | null; status?: string; created_at?: string; updated_at?: string;
  cost?: { tokens?: number; credits?: number }; tasks?: Task[]; tasks_total?: number; captain_thread?: unknown; crew?: unknown;
}
export interface Item extends TranscriptItem { input?: { text?: string } | string }
export interface Flag { action: 'ROTATE' | 'STOP' | 'LOOK' | 'WARN' | 'REPORT'; text: string }
export interface Verdict {
  code: string; verdict: 'OK' | 'WARN' | 'STOP' | 'ROTATE' | 'REPORT' | 'DEFER'; captain: boolean;
  own: number; ownBound: 'exact' | 'upper'; total: number; credits: number; ageDays: number; active: boolean;
  empty: { turns: number; empty: number } | null; rounds: ReturnType<typeof reviewRounds>;
  flags: Flag[]; defer: string[];
}

const TERMINAL = new Set(['done', 'failed', 'stopped', 'draft']);
const MID_SHIP = /\/ship|\bship\b|\bmerge\b|\btrain\b|\bstamp\b|pregate/i;
const REVIEWISH = /reader|fix-check|cold.?read|panel|outside.?voice|specialist|red.?team|adversarial|review/i;

export const fmtTokens = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? Math.round(n / 1e6) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
const tok = (t: Task) => t.cost?.tokens ?? 0;
const pathOf = (t: Task) => t.path ?? (t.label ?? '').replace(/^Subagent\s+/, '');
const quote = (s: string | undefined) => JSON.stringify((s ?? '').slice(0, 80));

function reportState(item: Item): string | undefined {
  const raw = typeof item.input === 'string' ? item.input : item.input?.text;
  return raw?.match(/\\?"state\\?"\s*:\s*\\?"(final|needs_you|working)/)?.[1];
}

/** Turns from transcript items: a turn ends at end_turn, wait, or a final/needs_you report. */
export function emptyWakes(items: readonly Item[]): { turns: number; empty: number } {
  const tools = items.filter(i => i.source === 'tool' && i.createdAt).sort((a, b) => a.createdAt!.localeCompare(b.createdAt!));
  const turns: boolean[] = [];
  let acted = false, open = false;
  for (const i of tools) {
    open = true;
    const state = i.tool === 'message_agent' || i.tool === 'message_user' ? reportState(i) : undefined;
    if (i.tool !== 'end_turn' && !isKeepalive(i)) acted = true;
    if (i.tool === 'end_turn' || i.tool === 'wait' || state === 'final' || state === 'needs_you') { turns.push(!acted); acted = false; open = false; }
  }
  if (open) turns.push(!acted);
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
  const rotate = (text: string) => flags.push({ action: captain ? 'REPORT' : 'ROTATE', text });

  if (own > LIMITS.ownRotate) rotate('own_tokens ' + fmtTokens(own) + ' > ' + fmtTokens(LIMITS.ownRotate) + (ownBound === 'upper' ? ' (upper bound)' : ''));
  else if (own > LIMITS.ownWarn) flags.push({ action: 'WARN', text: 'own_tokens ' + fmtTokens(own) + ' > ' + fmtTokens(LIMITS.ownWarn) + ' warn line' });
  if (active && ageDays > LIMITS.ageDays) rotate('age ' + ageDays.toFixed(1) + 'd > ' + LIMITS.ageDays + 'd and active');
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

  const defer = listed.filter(t => (t.status === 'working' || t.status === 'waiting') && MID_SHIP.test(t.title ?? ''))
    .map(t => pathOf(t) + ' ' + quote(t.title) + ' ' + t.status);
  const worst = (['ROTATE', 'REPORT', 'STOP', 'WARN'] as const).find(a => flags.some(f => f.action === a));
  const acts = flags.some(f => f.action === 'ROTATE' || f.action === 'STOP');
  const verdict: Verdict['verdict'] = acts && defer.length ? 'DEFER' : (worst ?? 'OK');
  return { code, verdict, captain, own, ownBound, total, credits: doc.cost?.credits ?? 0, ageDays, active, empty, rounds, flags, defer };
}

export function render(v: Verdict): string[] {
  const e = v.empty ? Math.round(100 * v.empty.empty / Math.max(1, v.empty.turns)) + '%/' + v.empty.turns : 'unmeasured';
  const out = ['RUNAWAY: thread=' + v.code + ' verdict=' + v.verdict + (v.captain ? ' captain=yes' : '') + ' own=' + fmtTokens(v.own) + '(' + v.ownBound + ')'
    + ' total=' + fmtTokens(v.total) + ' credits=' + Math.round(v.credits) + ' age_days=' + v.ageDays.toFixed(1) + ' active=' + (v.active ? 'yes' : 'no')
    + ' empty_wake=' + e + ' max_rounds=' + (v.rounds?.pr ? v.rounds.rounds + '(#' + v.rounds.pr + ')' : '0')
    + ' review_subagents=' + (v.rounds?.reviewers ?? 0) + '(unattributed ' + (v.rounds?.unattributed ?? 0) + ')'];
  for (const f of v.flags) out.push('FLAG: ' + f.action + ' ' + f.text);
  if (v.verdict === 'DEFER') for (const d of v.defer) out.push('DEFER: mid-ship or mid-merge: ' + d + '; act at the next clean point');
  return out;
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
function itemsOf(x: unknown): Item[] {
  if (Array.isArray(x)) return x;
  const o = x as { items?: Item[]; transcript?: { items?: Item[] } } | null;
  return o?.items ?? o?.transcript?.items ?? [];
}

const USAGE = [
  'gstack-runaway — find runaway Capy threads and subagents (read-only; /runaway-stopper)',
  '  scan --thread <thread.get json> [--events <transcript json>] [--subagents <subagent.list json>] [--now <iso>]',
  '  scan --dir <dir> [--now <iso>]   reads every <code>.thread.json with its <code>.events.json and <code>.subagents.json',
  'Lines: RUNAWAY (one per thread, largest own tokens first), FLAG ROTATE|STOP|LOOK|WARN|REPORT, DEFER, SWEEP (--dir).',
  'Review rounds count only subagent titles that name the PR (#N); the rest show as unattributed.',
  'Limits (R70): own > 500M or active > 3d rotate (warn 400M); subagent > 100M stop (LOOK when it already ended);',
  'empty wakes > 25% of the last 40 turns (20+); review rounds > 2 per PR; Captains REPORT, never rotate.',
  'Exit 0 after a scan, 2 on a usage error.',
];

export function runawayMain(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h') { console.log(USAGE.join('\n')); return 0; }
  const fail = (msg: string) => { console.error('RUNAWAY_USAGE: ' + msg + '\n' + USAGE.join('\n')); return 2; };
  if (cmd !== 'scan') return fail(cmd ? 'unknown command ' + JSON.stringify(cmd) : 'no command');
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
  const verdicts = sets.map(s => assess(readJson(s.thread), {
    now, items: s.events ? itemsOf(readJson(s.events)) : undefined, subagents: s.subagents ? readJson(s.subagents) : undefined,
  })).sort((a, b) => b.own - a.own);
  for (const v of verdicts) console.log(render(v).join('\n'));
  if (dir) {
    const n = (k: Verdict['verdict']) => verdicts.filter(v => v.verdict === k).length;
    console.log('SWEEP: threads=' + verdicts.length + ' rotate=' + n('ROTATE') + ' stop=' + n('STOP') + ' defer=' + n('DEFER')
      + ' report=' + n('REPORT') + ' warn=' + n('WARN') + ' ok=' + n('OK'));
  }
  return 0;
}
