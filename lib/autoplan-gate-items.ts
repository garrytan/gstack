/**
 * autoplan-gate-items — the gate items that keep a product challenge on the
 * owner's page (GST-2947). Only the owner's own words are the plan's
 * direction (lib/autoplan-owner-text.ts): a reviewer's scope, ordering,
 * direction, cost or packaging change to anything else the plan says becomes
 * a lettered proposal recommending the reviewer's change, at any severity and
 * from one voice; a challenge that names a quoted owner line keeps today's
 * keep-direction rules in buildGate (lib/autoplan-gate.ts). A plan with no
 * Owner's words section keeps today's defaults and gets one item asking the
 * owner to confirm its direction. The day-one items ask about every assumed
 * day-one row, a missing day-one page on an app plan, and each cut that drops
 * a day-one row (the other cuts are one grouped item, or one item each on a
 * first version). A quote the plan leaves for later (its line says `choice`),
 * a cut that drops a quote, and a reviewer's `narrows_quote` finding each become
 * one choice to build what the owner asked for, recommended unless the plan
 * gives a reason to leave it out (GST-3608).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { branchKey, captainApprovalsDir } from './approval-record';
import { readVersionedSlugCache, sanitizeSlug } from './bin-context';
import { cutDrops, cutQuote, isFirstVersion, parseCuts, parseDayOne, parseOwnerWords, quoteGaps, quoteWhen, wordKey, type DayOneTable, type OwnerQuote, type OwnerWordsSection } from './autoplan-owner-text';
import { SETTLEABLE_CHANGES } from './autoplan-reconcile';
import { readDecisions, readJournal, type RunState } from './autoplan-state';
import { resolveStateRoot } from './state-root';
import type { GateItem } from './gate-list';
import type { FindingRow } from './headless-artifacts';

export type ChallengeRow = FindingRow & { user_challenge?: boolean; changes?: string; settled_by?: string; owner_quote?: number; narrows_quote?: number; resolves?: string };
export type NewItem = Omit<GateItem, 'id'> & { idKind: 'd' | 'uc'; key: string };
export interface GateOwnerWords { status: OwnerWordsSection['status']; quotes: Array<OwnerQuote & { verified: boolean }>; reason?: string; fix?: string }
export interface OwnerContext { words: OwnerWordsSection; verified: Set<number>; dayOne: DayOneTable; cuts: string[]; app: boolean; lean: boolean; firstVersion: boolean }

/**
 * The owner's words in this repository's approvals record for the branch checked out at `cwd` (lib/approval-record.ts
 * layout: <state root>/projects/<slug>/approvals/<branch key>.jsonl and <mirror>/<slug>/<branch key>.jsonl). Read-only:
 * the slug comes from GSTACK_PROJECT_SLUG or the repository's slug cache entry gstack-slug already wrote (repository
 * scope, which ignores project markers, as the writer resolves it), never a fresh resolution (that
 * writes the cache, and building a gate must not write outside the run). No known slug reads no record, so a quote stays
 * unverified rather than matching another repository's branch of the same name.
 */
export function ledgerWords(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const head = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10_000 });
  const branch = head.status === 0 ? head.stdout.trim() : '';
  if (!branch) return [];
  const stateRoot = resolveStateRoot(env);
  const pinned = sanitizeSlug((env.GSTACK_PROJECT_SLUG ?? '').trim());
  const slug = pinned && pinned !== '.' && pinned !== '..' ? pinned : readVersionedSlugCache(stateRoot, cwd, { scope: 'repository' });
  if (!slug) return [];
  const name = `${branchKey(branch)}.jsonl`;
  const files = [path.join(stateRoot, 'projects', slug, 'approvals', name),
    ...[env.GSTACK_APPROVALS_DIR, captainApprovalsDir(env)].flatMap(root => (root ? [path.join(root, slug, name)] : []))];
  const words: string[] = [];
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      try { const row = JSON.parse(line); if (typeof row?.words === 'string' && !row.words_by) words.push(row.words); } catch { /* a torn line */ }
    }
  }
  return words;
}

/** Every owner reply this run recorded, plus the owner's words in the approvals records for the plan's branch. */
export function recordedOwnerWords(state: RunState, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const r of readJournal(state.out)) if (typeof r.owner_reply === 'string') out.push(r.owner_reply);
  for (const d of readDecisions(state.out)) if (typeof d.owner_reply === 'string') out.push(d.owner_reply);
  return [...out, ...ledgerWords(path.dirname(state.plan_input ?? state.plan_source), env)];
}

export function ownerContext(state: RunState, recorded: string[] = recordedOwnerWords(state)): OwnerContext {
  let text = '';
  try { text = fs.readFileSync(state.active_plan, 'utf8'); } catch { /* no plan text: nothing is quoted */ }
  const words = parseOwnerWords(text);
  const keys = recorded.map(wordKey);
  const verified = new Set(words.quotes.filter(q => keys.some(k => k.includes(wordKey(q.text)))).map(q => q.n));
  return { words, verified, dayOne: parseDayOne(text), cuts: parseCuts(text), app: !!state.scope?.ui, lean: !!state.lean,
    firstVersion: isFirstVersion(text, !!state.scope?.first_version) };
}

export function gateOwnerWords(ctx: OwnerContext): GateOwnerWords {
  return { status: ctx.words.status, quotes: ctx.words.quotes.map(q => ({ ...q, verified: ctx.verified.has(q.n) })),
    ...(ctx.words.reason ? { reason: ctx.words.reason, fix: ctx.words.fix } : {}) };
}

/** The quote a reviewer says the plan narrows (a cut or a "does it" line that does less than the owner asked), when the plan quotes it. */
export const narrowedQuoteOf = (ctx: OwnerContext, f: ChallengeRow | undefined): OwnerQuote | undefined =>
  f?.narrows_quote ? ctx.words.quotes.find(q => q.n === f.narrows_quote) : undefined;

/** The owner line a challenge names, when the plan quotes one there. */
export const ownerQuoteOf = (ctx: OwnerContext, f: ChallengeRow | undefined): OwnerQuote | undefined =>
  f?.owner_quote ? ctx.words.quotes.find(q => q.n === f.owner_quote) : undefined;

/** Today's keep-direction rules apply: the plan quotes no owner, or the challenge goes against a quoted owner line. */
export const directionIsOwners = (ctx: OwnerContext, rows: Array<ChallengeRow | undefined>): boolean =>
  ctx.words.status === 'none' || rows.some(r => !!ownerQuoteOf(ctx, r));

/** What choosing the reviewer's change costs, as revise actually discharges it (lib/autoplan-revise.ts). */
export function proposalCost(ctx: OwnerContext, phase: string, changes: string): string {
  if (ctx.lean) return 'a applies without re-review (lean run: one gate revision)';
  if (SETTLEABLE_CHANGES.includes(changes)) return 'a is settled with revise --settle: no plan edit, no re-review';
  return `a reopens ${phase}${phase === 'eng' ? '' : ' and eng'} once the plan is revised`;
}

/** A proposal behind a Critical or High row keeps the finding path's b: the draft stands and the finding becomes a blocking build task. */
export const blockingProposal = (rows: ChallengeRow[]): boolean => rows.some(r => r.severity === 'Critical' || r.severity === 'High');

/** The heaviest `changes` any row names: scope, cost or direction before packaging or ordering, so a pair never settles a scope change. */
export function heaviestChanges(rows: Array<{ changes?: string } | undefined>): string | undefined {
  const named = rows.flatMap(r => (r?.changes ? [r.changes] : []));
  return ['scope', 'cost', 'direction'].find(c => named.includes(c)) ?? named[0];
}

/**
 * One proposal from one or both voices (a paired twin) against agent-written plan text: a takes the change, b keeps the draft.
 * Its `changes` is the heaviest any row names (scope, cost, direction, then packaging or ordering), so a pair never settles a scope change.
 */
export function proposalItem(ctx: OwnerContext, phase: string, rows: ChallengeRow[], o: { carried?: boolean } = {}): NewItem {
  const changes = heaviestChanges(rows) ?? 'direction';
  const keep = blockingProposal(rows) ? "keep the plan's draft; carry it into the build as a blocking task (no plan change)" : "keep the plan's draft";
  const fixes = [...new Set(rows.map(r => r.resolution).filter((r): r is string => !!r))];
  const voices = rows.map(r => r.voice).join(' + ');
  const ids = rows.map(r => r.id).join(' + ');
  return { idKind: 'uc', key: rows.map(r => r.id).join('+'), title: `${rows[0]!.title} [${ids}]`, kind: 'approval', recommended: 'a', phase, item_class: 'proposal', changes,
    recommended_basis: "the reviewer's change: only the owner's words are direction, and this changes text the planning agent wrote",
    why: `${voices} recommend${rows.length > 1 ? '' : 's'} changing the plan's ${changes} (${rows[0]!.severity}); no quoted owner line says otherwise${o.carried ? '; raised in an earlier round and still open' : ''}`,
    cost: proposalCost(ctx, phase, changes),
    options: [{ key: 'a', text: `take the change: ${fixes.length ? fixes.join('; ') : rows[0]!.title}`, changes_plan: true }, { key: 'b', text: keep, changes_plan: false }] };
}

/**
 * No Owner's words section: a one-voice challenge keeps the plan's direction by default, so the owner is asked to confirm
 * the direction is theirs (auto: today's default stands unanswered). A two-voice challenge already recommends the change
 * on a shared proposal (challengeDefault), so it adds no confirm item.
 */
export function confirmDirectionItem(challenges: string[]): NewItem {
  return { idKind: 'd', key: 'confirm-direction', kind: 'auto', recommended: 'a', item_class: 'confirm_direction',
    title: `Confirm the plan's direction is yours: the plan quotes no owner words, so ${challenges.join(', ')} default to the plan as written`,
    recommended_basis: "today's default for a plan with no Owner's words section",
    why: "only the owner's words are direction; without an Owner's words section the gate cannot tell your direction from the planning agent's draft",
    options: [{ key: 'a', text: 'yes, the plan as written is what I asked for', changes_plan: false },
      { key: 'b', text: "no, it is a draft: quote what I said in an Owner's words section and revise, so the challenges are judged against it", changes_plan: true }] };
}

/**
 * The owner-page questions: on a first version, missing quotes or lines; each assumed day-one row; a missing page on an
 * app plan; one build-it choice per quote the plan leaves out (its `choice` line, a cut that drops it, or a reviewer's
 * narrows_quote finding); and the cuts, one item each on a first version, else those matching a day-one row alone.
 */
export function dayOneItems(ctx: OwnerContext, narrowed: ChallengeRow[] = []): NewItem[] {
  const items: NewItem[] = [];
  const reopen = ctx.lean ? 'applies without re-review (lean run)' : 'reopens ceo and eng once the plan is revised';
  if (ctx.firstVersion && ctx.words.status === 'none') {
    items.push({ idKind: 'uc', key: 'owner-words', kind: 'approval', recommended: 'a', item_class: 'owner_words', changes: 'scope', cost: `a ${reopen}`,
      title: 'This is a first version, but the plan quotes none of your messages that ask for it',
      why: 'a first version is checked against your own words for the job, not against the plan: each quoted message, with its time, gets a line saying what this version does with it',
      options: [{ key: 'a', text: "add it: an ### Owner's words section quoting each message that states the job, with its time and a line each (does it or choice), then revise", changes_plan: true },
        { key: 'b', text: 'approve without it', changes_plan: false }] });
  }
  const gaps = ctx.firstVersion ? ctx.words.quotes.filter(q => quoteGaps(q).length) : [];
  if (gaps.length) {
    items.push({ idKind: 'uc', key: `owner-lines:${gaps.map(q => q.n).join(',')}`, kind: 'approval', recommended: 'a', item_class: 'owner_words', changes: 'scope', cost: `a ${reopen}`,
      title: `${gaps.length} of your quoted messages ${gaps.length === 1 ? 'has' : 'have'} no time or no line saying what this version does with ${gaps.length === 1 ? 'it' : 'them'}: ${gaps.map(q => `“${q.text}” (missing ${quoteGaps(q).join(' and ')})`).join('; ')}`,
      why: 'on a first version every quote says when it was said and whether this version does it or leaves it as a lettered choice',
      options: [{ key: 'a', text: 'add the time and the line to each, then revise', changes_plan: true }, { key: 'b', text: 'approve without them', changes_plan: false }] });
  }
  if (ctx.app && ctx.dayOne.status !== 'ok') {
    items.push({ idKind: 'uc', key: 'day-one-page', kind: 'approval', recommended: 'a', item_class: 'day_one', changes: 'scope', cost: `a ${reopen}`,
      title: `The plan has no day-one page${ctx.dayOne.reason ? ` (${ctx.dayOne.reason})` : ''}: the first things you will do with it, how often, and which build puts each on your device`,
      why: 'an app plan names what its owner does on day one so the most-used thing is built first and every feature has a way in',
      options: [{ key: 'a', text: 'add it: a ### Day one table (action, frequency, source, feature, route, first build, check), then revise', changes_plan: true }, { key: 'b', text: 'approve without it', changes_plan: false }] });
  }
  for (const row of ctx.dayOne.rows.filter(r => r.assumed)) {
    items.push({ idKind: 'uc', key: `day-one:${wordKey(row.action).trim()}`, kind: 'approval', recommended: 'a', item_class: 'day_one', cost: `b ${reopen}`,
      title: `Day one: the plan assumes you will do "${row.action.replace(/[.]$/, '')}" (${row.frequency || 'how often unstated'}); is that right?`,
      why: `no owner words or owner evidence back this row; feature: ${row.feature || 'none named'}; first build: ${row.first_build || 'none named'}`,
      options: [{ key: 'a', text: 'yes, I do that: keep the row', changes_plan: false }, { key: 'b', text: 'no, or not like that: say what you do instead, then revise', changes_plan: true }] });
  }
  const left = new Map<number, string[]>();
  const note = (q: OwnerQuote, why: string) => left.set(q.n, [...(left.get(q.n) ?? []), why]);
  for (const q of ctx.words.quotes) if (q.line?.kind === 'choice') note(q, "the plan's line for it says this version doesn't do it yet");
  const quoteCuts = ctx.cuts.filter(c => cutQuote(c, ctx.words.quotes));
  for (const cut of quoteCuts) note(cutQuote(cut, ctx.words.quotes)!, `the plan cuts it: "${cut}"`);
  for (const f of narrowed) { const q = ctx.words.quotes.find(x => x.n === f.narrows_quote); if (q) note(q, `a reviewer (${f.voice}) says the plan narrows it: ${f.title}`); }
  for (const q of ctx.words.quotes.filter(x => left.has(x.n))) {
    const choice = q.line?.kind === 'choice' ? q.line : undefined;
    const blocking = narrowed.find(f => f.narrows_quote === q.n && (f.severity === 'Critical' || f.severity === 'High'));
    const leave = blocking ? undefined : choice?.leave_out;
    const size = choice?.size ? `about ${choice.size}` : 'size not stated';
    items.push({ idKind: 'uc', key: `quote:${q.n}`, kind: 'approval', recommended: leave ? 'b' : 'a', item_class: 'owner_choice', changes: 'scope',
      recommended_basis: blocking ? `your own words asked for it, and a ${blocking.severity} finding says the plan falls short of them` : leave ? `the plan's reason to leave it out: ${leave}` : 'your own words asked for it, and only your words are direction',
      cost: `a adds ${size} to this version and ${reopen}`,
      title: `Your words${quoteWhen(q) ? ` (${quoteWhen(q)})` : ''}: “${q.text}”, which this version doesn't fully do`,
      why: left.get(q.n)!.join('; '),
      options: [{ key: 'a', text: `build it in this version (${size})`, changes_plan: true }, { key: 'b', text: `leave it out for now${leave ? `: ${leave}` : ''}`, changes_plan: false }] });
  }
  const rest = ctx.cuts.filter(c => !quoteCuts.includes(c));
  const rowTargets = ctx.dayOne.rows.flatMap(r => [r.action, r.feature]).filter(Boolean);
  const named = ctx.firstVersion ? rest : rest.filter(c => rowTargets.some(t => cutDrops(c, t)));
  for (const cut of named) {
    const drops = rowTargets.some(t => cutDrops(cut, t));
    items.push({ idKind: 'uc', key: `cut:${wordKey(cut).trim()}`, kind: 'approval', recommended: 'a', item_class: 'cut', changes: 'scope', cost: `b ${reopen}`,
      title: `Cut: ${cut}`, why: drops ? 'this cut drops something on the day-one page' : 'on a first version every cut is your decision, one letter each',
      options: [{ key: 'a', text: 'keep the cut: not in the first build', changes_plan: false }, { key: 'b', text: 'put it back in the first build', changes_plan: true }] });
  }
  const grouped = rest.filter(c => !named.includes(c));
  if (grouped.length) {
    items.push({ idKind: 'd', key: 'cuts', kind: 'auto', recommended: 'a', item_class: 'cuts', changes: 'scope', cost: `b ${reopen}`,
      title: `${grouped.length} other cut${grouped.length === 1 ? '' : 's'}: ${grouped.join('; ')}`, why: 'none of these drops a day-one row or a quoted owner line',
      options: [{ key: 'a', text: 'keep these cuts', changes_plan: false }, { key: 'b', text: 'put some back: name them, then revise', changes_plan: true }] });
  }
  return items;
}
