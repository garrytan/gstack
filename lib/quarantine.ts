/**
 * gstack-flaky quarantine (GSTA-158 P2): a registry of known-flaky tests at
 * `.gstack/quarantine.json`. A quarantined test still runs; it gets a larger
 * attempt budget (lib/flaky-run.ts, QUARANTINE_ATTEMPTS) under the same full
 * green verdict, and it is never counted as a pass. This file holds the
 * registry: schema, validation, add/renew/release, `check` against the base
 * branch, and `report` over downloaded ledgers.
 *
 * Rules (docs/flaky.md § Quarantine):
 * - Every entry has an owner, a ledger link, a failure class (detector,
 *   harness, timing, model-latency; product defects and infra are refused),
 *   evidence and an expiry: 7 days by default, at most 14 from entry, and one
 *   renewal of at most 7 days with new evidence and the owner named again.
 * - An expired or invalid entry is not quarantined; nothing needs editing.
 * - Live entries are capped at max(1, 10% of the suite's tests), and 5 for a
 *   suite under 50 tests.
 * - `run --base` reads the registry from the base branch so a change cannot
 *   quarantine the test it breaks; `check --base` refuses an entry added in
 *   the change that edits its test's file, an entry that disappears without a
 *   release record, a release record that was removed, and rewritten history.
 * - gstack's own CASE_QUARANTINE / EVAL_POLICY (paid evals) is a separate
 *   registry; the two share no schema.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parseTestId, readJunit, type JunitRunner } from './junit';
import { safeText } from './flaky-run';

export const REGISTRY_PATH = '.gstack/quarantine.json';
export const FAILURE_CLASSES = ['detector', 'harness', 'timing', 'model-latency'] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 14;
export const RENEW_MAX_DAYS = 7;
export const EXIT_RULE_PASSES = 10;
const DAY = 86_400_000;

export interface Renewal { renewedAt: string; previousExpiresAt: string; expiresAt: string; owner: string; evidence: string[] }

export interface QuarantineEntry {
  owner: string;
  /** Link to the flaky ledger line or issue that tracks the fix. */
  ledger: string;
  failureClass: FailureClass;
  reason: string;
  evidence: string[];
  enteredAt: string;
  expiresAt: string;
  renewals: Renewal[];
  /** The suite's test count when the entry was added (`add --junit`), the base of the cap. */
  suiteTests: number;
}

export type ReleasedEntry = Omit<QuarantineEntry, 'reason'> & { id: string; releasedAt: string; reason: string; pr: string };

export interface Registry { schema: 1; entries: Record<string, QuarantineEntry>; released: ReleasedEntry[] }

export class QuarantineError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: 1 | 2 | 3 = 3) { super(message); }
}

export const emptyRegistry = (): Registry => ({ schema: 1, entries: {}, released: [] });

/** Live entries allowed for a suite of `tests` tests. */
export const suiteCap = (tests: number) => tests < 50 ? 5 : Math.max(1, Math.floor(tests / 10));

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 15_000 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

export function repoRoot(cwd: string): string {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  return r.ok && r.out.trim() ? r.out.trim() : cwd;
}

export function parseRegistry(text: string, source: string): Registry {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) {
    throw new QuarantineError('FLAKY_QUARANTINE_INVALID', `${source} is not valid JSON (${(e as Error).message})`);
  }
  const r = data as Partial<Registry> | null;
  if (!r || typeof r !== 'object' || r.schema !== 1 || !r.entries || typeof r.entries !== 'object' || Array.isArray(r.entries) || !Array.isArray(r.released)) {
    throw new QuarantineError('FLAKY_QUARANTINE_INVALID', `${source} is not a schema 1 quarantine registry ({"schema":1,"entries":{},"released":[]})`);
  }
  return r as Registry;
}

function resolveCommit(ref: string, cwd: string): string {
  if (!ref || ref.startsWith('-')) throw new QuarantineError('FLAKY_QUARANTINE_BASE', `--base ${JSON.stringify(ref)} is not a git ref`, 2);
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  if (!r.ok) throw new QuarantineError('FLAKY_QUARANTINE_BASE', `--base ${ref} does not resolve to a commit in ${cwd}`);
  return r.out.trim();
}

function registryAt(commit: string, root: string, label: string): Registry {
  if (!git(['cat-file', '-e', `${commit}:${REGISTRY_PATH}`], root).ok) return emptyRegistry();
  const shown = git(['show', `${commit}:${REGISTRY_PATH}`], root);
  if (!shown.ok) throw new QuarantineError('FLAKY_QUARANTINE_BASE', `cannot read ${REGISTRY_PATH} at ${label}`);
  return parseRegistry(shown.out, `${REGISTRY_PATH} at ${label}`);
}

/** The registry in the working tree, or at `base` when given; a missing file is an empty registry. */
export function readRegistry(cwd: string, base?: string): Registry {
  const root = repoRoot(cwd);
  if (base !== undefined) return registryAt(resolveCommit(base, root), root, base);
  const file = path.join(root, REGISTRY_PATH);
  if (!fs.existsSync(file)) return emptyRegistry();
  return parseRegistry(fs.readFileSync(file, 'utf-8'), REGISTRY_PATH);
}

export function writeRegistry(cwd: string, reg: Registry): string {
  const file = path.join(repoRoot(cwd), REGISTRY_PATH);
  const entries = Object.fromEntries(Object.keys(reg.entries).sort().map(id => [id, reg.entries[id]!]));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 1, entries, released: reg.released }, null, 2) + '\n');
  return file;
}

const filled = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
const filledList = (l: unknown): l is string[] => Array.isArray(l) && l.length > 0 && l.every(filled);

export function classRefusal(c: unknown): string | undefined {
  if (FAILURE_CLASSES.includes(c as FailureClass)) return undefined;
  if (c === 'product') return 'class product is refused: a product defect is a real red; fix it instead of quarantining it';
  if (c === 'infra') return 'class infra is refused: an infrastructure red is rerun or fixed as infra, never quarantined';
  return `class ${JSON.stringify(c)} is not one of ${FAILURE_CLASSES.join(', ')}`;
}

/** What makes one entry invalid; an invalid entry is never quarantined and `check` refuses it. */
export function entryProblems(id: string, e: QuarantineEntry, now: Date): string[] {
  if (!e || typeof e !== 'object') return ['not an object'];
  const p: string[] = [];
  if (!parseTestId(id)) p.push('not a test id (<file>::<project>::<title>; gstack-flaky ids prints them)');
  if (!filled(e.owner)) p.push('no owner');
  if (!filled(e.ledger)) p.push('no ledger link');
  if (!filled(e.reason)) p.push('no reason');
  const cls = classRefusal(e.failureClass);
  if (cls) p.push(cls);
  if (!filledList(e.evidence)) p.push('no evidence');
  if (!(Number.isInteger(e.suiteTests) && e.suiteTests > 0)) p.push('no suiteTests (add records the suite size from --junit)');
  const entered = Date.parse(e.enteredAt);
  const expires = Date.parse(e.expiresAt);
  if (Number.isNaN(entered) || Number.isNaN(expires)) return [...p, 'enteredAt or expiresAt is not a date'];
  if (entered > now.getTime() + DAY) p.push('enteredAt is in the future');
  if (!Array.isArray(e.renewals)) return [...p, 'renewals is not a list'];
  if (e.renewals.length > 1) p.push(`renewed ${e.renewals.length} times; one renewal is allowed, then fix the test or release it`);
  const firstExpiry = e.renewals.length ? Date.parse(e.renewals[0]?.previousExpiresAt) : expires;
  if (!(firstExpiry > entered)) p.push('expires before it entered');
  if (firstExpiry - entered > MAX_DAYS * DAY) p.push(`expires more than ${MAX_DAYS} days after it entered`);
  for (const r of e.renewals) {
    if (!r || typeof r !== 'object') { p.push('a renewal is not an object'); continue; }
    const renewed = Date.parse(r.renewedAt);
    if (!(renewed >= entered && renewed <= now.getTime() + DAY)) p.push('a renewal is dated before the entry or in the future');
    if (!filled(r?.owner)) p.push('a renewal names no owner');
    if (!filledList(r?.evidence) || r.evidence.every(x => filledList(e.evidence) && e.evidence.includes(x))) p.push('a renewal carries no new evidence');
    const from = Math.max(Date.parse(r?.renewedAt), Date.parse(r?.previousExpiresAt));
    const until = Date.parse(r?.expiresAt);
    if (Number.isNaN(from) || Number.isNaN(until) || until - from > RENEW_MAX_DAYS * DAY) p.push(`a renewal is not a date range of at most ${RENEW_MAX_DAYS} days`);
  }
  const last = e.renewals.at(-1);
  if (last && last.expiresAt !== e.expiresAt) p.push('expiresAt differs from the last renewal');
  return p;
}

export const isLive = (e: QuarantineEntry, now: Date) => Date.parse(e.expiresAt) > now.getTime();

/** Ids `run` gives the quarantine budget, plus one notice per entry it ignores (expired or invalid). */
export function liveQuarantine(reg: Registry, now: Date): { ids: Set<string>; notices: string[] } {
  const ids = new Set<string>();
  const notices: string[] = [];
  for (const [id, e] of Object.entries(reg.entries)) {
    const problems = entryProblems(id, e, now);
    if (problems.length) notices.push(`FLAKY_QUARANTINE_IGNORED: ${safeText(id)} is not quarantined: ${problems.join('; ')}`);
    else if (!isLive(e, now)) notices.push(expiredNotice(id, e));
    else ids.add(id);
  }
  return { ids, notices };
}

const shq = (s: string) => "'" + s.split("'").join(`'"'"'`) + "'";
export const renewCommand = (id: string) => `gstack-flaky quarantine renew ${shq(safeText(id))} --owner <you> --evidence <new evidence url>`;
export const releaseCommand = (id: string) => `gstack-flaky quarantine release ${shq(safeText(id))} --reason <why> --pr <fix pr url>`;

export function expiredNotice(id: string, e: QuarantineEntry): string {
  return `FLAKY_QUARANTINE_EXPIRED: ${safeText(id)} expired ${e.expiresAt.slice(0, 10)} and is not quarantined; renew: ${renewCommand(id)} | release: ${releaseCommand(id)}`;
}

export interface AddInput { owner?: string; ledger?: string; failureClass?: string; reason?: string; evidence: string[]; days?: number; suiteIds: string[] }

const refuse = (msg: string): never => { throw new QuarantineError('FLAKY_QUARANTINE_REFUSED', msg, 1); };

export function addEntry(reg: Registry, id: string, a: AddInput, now: Date): QuarantineEntry {
  const days = a.days ?? DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) refuse(`--days must be a whole number from 1 to ${MAX_DAYS}, got ${a.days}`);
  const cls = classRefusal(a.failureClass);
  if (cls) refuse(cls);
  if (!a.evidence.length) refuse('no evidence: pass --evidence <url> (a failing run, a ledger line) at least once');
  if (!a.suiteIds.includes(id)) refuse(`${safeText(id)} is not a test in the --junit report (gstack-flaky ids --junit <file> prints the ids)`);
  if (reg.entries[id]) refuse(`${safeText(id)} already has an entry; renew or release it`);
  const live = Object.values(reg.entries).filter(e => isLive(e, now)).length;
  const cap = suiteCap(a.suiteIds.length);
  if (live + 1 > cap) refuse(`the registry holds ${live} live entries and the cap for a ${a.suiteIds.length}-test suite is ${cap}; fix or release one first`);
  const entry: QuarantineEntry = {
    owner: a.owner ?? '', ledger: a.ledger ?? '', failureClass: a.failureClass as FailureClass, reason: a.reason ?? '', evidence: a.evidence,
    enteredAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * DAY).toISOString(), renewals: [], suiteTests: a.suiteIds.length,
  };
  const problems = entryProblems(id, entry, now);
  if (problems.length) refuse(problems.join('; '));
  reg.entries[id] = entry;
  return entry;
}

export function renewEntry(reg: Registry, id: string, r: { owner?: string; evidence: string[]; days?: number }, now: Date): QuarantineEntry {
  const e = reg.entries[id] ?? refuse(`${safeText(id)} has no entry to renew`);
  if (e.renewals.length) refuse(`${safeText(id)} was renewed once already; a second renewal is refused: fix the test or release it`);
  if (!filled(r.owner)) refuse('renew names the owner again: pass --owner');
  if (!r.evidence.some(x => filled(x) && !e.evidence.includes(x))) refuse('renew needs new evidence: pass --evidence <url> not already on the entry');
  const days = r.days ?? RENEW_MAX_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > RENEW_MAX_DAYS) refuse(`a renewal is 1 to ${RENEW_MAX_DAYS} days, got ${r.days}`);
  const from = Math.max(now.getTime(), Date.parse(e.expiresAt));
  const expiresAt = new Date(from + days * DAY).toISOString();
  e.renewals.push({ renewedAt: now.toISOString(), previousExpiresAt: e.expiresAt, expiresAt, owner: r.owner!, evidence: r.evidence });
  e.expiresAt = expiresAt;
  return e;
}

export function releaseEntry(reg: Registry, id: string, r: { reason?: string; pr?: string }, now: Date): ReleasedEntry {
  const e = reg.entries[id] ?? refuse(`${safeText(id)} has no entry to release`);
  if (!filled(r.reason) || !filled(r.pr)) refuse('release needs --reason and --pr (the fix, or the decision to stop quarantining)');
  const record: ReleasedEntry = { id, ...e, releasedAt: now.toISOString(), reason: r.reason!, pr: r.pr! };
  reg.released.push(record);
  delete reg.entries[id];
  return record;
}

const liveEntries = (reg: Registry, now: Date) => Object.values(reg.entries).filter(e => e && typeof e === 'object' && isLive(e, now));
const smallestSuite = (live: QuarantineEntry[]) => Math.min(...live.map(e => e.suiteTests).filter(n => Number.isInteger(n) && n > 0));

/** Structural problems of a whole registry plus the cap, for `check`. */
export function registryProblems(reg: Registry, now: Date, suiteTests?: number): string[] {
  const p: string[] = [];
  for (const [id, e] of Object.entries(reg.entries)) for (const x of entryProblems(id, e, now)) p.push(`${safeText(id)}: ${x}`);
  for (const r of reg.released) {
    if (!r || !filled(r.id) || Number.isNaN(Date.parse(r.releasedAt)) || !filled(r.reason) || !filled(r.pr)) p.push(`released record ${JSON.stringify(r?.id)}: needs id, releasedAt, reason and pr`);
  }
  const live = liveEntries(reg, now);
  const tests = suiteTests ?? smallestSuite(live);
  if (live.length && Number.isFinite(tests) && live.length > suiteCap(tests)) p.push(`${live.length} live entries, over the cap of ${suiteCap(tests)} for a ${tests}-test suite`);
  return p;
}

const editsFile = (changed: string[], file: string) => changed.some(f => f === file || f.endsWith(`/${file}`));

/** What a change did to the registry that `check --base` refuses. */
export function baseProblems(base: Registry, head: Registry, changed: string[]): string[] {
  const p: string[] = [];
  for (const [id, e] of Object.entries(head.entries)) {
    const was = base.entries[id];
    const t = parseTestId(id);
    if (!was) {
      if (t && editsFile(changed, t.file)) p.push(`${safeText(id)}: added in the same change that edits ${t.file}; a change cannot quarantine the test it touches (land the entry on its own, or fix the test)`);
      continue;
    }
    if (was.enteredAt !== e?.enteredAt) p.push(`${safeText(id)}: enteredAt changed from ${was.enteredAt}; release the entry instead of restarting it`);
    if (JSON.stringify((e?.renewals ?? []).slice(0, was.renewals.length)) !== JSON.stringify(was.renewals)) p.push(`${safeText(id)}: its renewal history was rewritten`);
  }
  for (const [id, was] of Object.entries(base.entries)) {
    if (!(id in head.entries) && !head.released.some(r => r?.id === id && r.enteredAt === was.enteredAt)) p.push(`${safeText(id)}: removed without a release record (use: ${releaseCommand(id)})`);
  }
  for (const r of base.released) {
    if (!head.released.some(h => h?.id === r.id && h.releasedAt === r.releasedAt)) p.push(`${safeText(r.id)}: its release record of ${r.releasedAt} was removed`);
  }
  return p;
}

/** `check`: the working-tree registry alone, and with `base` against what this change did since the merge base. */
export function checkRegistry(cwd: string, o: { base?: string; suiteTests?: number }, now: Date): { problems: string[]; live: number; cap?: number } {
  const head = readRegistry(cwd);
  const problems = registryProblems(head, now, o.suiteTests);
  if (o.base !== undefined) {
    const root = repoRoot(cwd);
    const commit = resolveCommit(o.base, root);
    const mb = git(['merge-base', commit, 'HEAD'], root);
    if (!mb.ok) throw new QuarantineError('FLAKY_QUARANTINE_BASE', `no merge base between ${o.base} and HEAD (a shallow clone?)`);
    const changed = git(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', mb.out.trim()], root);
    if (!changed.ok) throw new QuarantineError('FLAKY_QUARANTINE_BASE', `cannot diff against the merge base of ${o.base}`);
    problems.push(...baseProblems(registryAt(mb.out.trim(), root, `the merge base of ${o.base}`), head, changed.out.split('\0').filter(Boolean)));
  }
  const live = liveEntries(head, now);
  const tests = o.suiteTests ?? smallestSuite(live);
  return { problems, live: live.length, ...(Number.isFinite(tests) ? { cap: suiteCap(tests) } : {}) };
}

export interface LedgerRecord { ts: string; kind: string; id: string; attempts?: string[] }

/** Read every JSON line of the given ledger files, and of every .jsonl file under the given directories. */
export function readLedgers(paths: string[]): { records: LedgerRecord[]; skipped: number } {
  const files: string[] = [];
  const walk = (p: string) => {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) throw new QuarantineError('FLAKY_QUARANTINE_USAGE', `--ledger ${p} does not exist`, 2);
    if (!st.isDirectory()) { files.push(p); return; }
    for (const n of fs.readdirSync(p).sort()) {
      const c = path.join(p, n);
      if (fs.statSync(c).isDirectory() || n.endsWith('.jsonl')) walk(c);
    }
  };
  paths.forEach(walk);
  const records: LedgerRecord[] = [];
  let skipped = 0;
  for (const f of files) {
    for (const l of fs.readFileSync(f, 'utf-8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l) as LedgerRecord;
        if (filled(r?.id) && filled(r.kind) && filled(r.ts)) records.push(r); else skipped++;
      } catch { skipped++; }
    }
  }
  return { records, skipped };
}

const cleanPass = (r: LedgerRecord) => r.kind === 'quarantined-pass' && !(r.attempts ?? []).includes('fail');
const shortKind = (r: LedgerRecord) => cleanPass(r) ? 'pass' : r.kind === 'quarantined-pass' ? 'flaky' : r.kind === 'quarantined-fail' ? 'fail' : r.kind;

/** `report`: expired entries first, then live entries soonest-expiring first, with ledger history when given. */
export function reportLines(reg: Registry, now: Date, ledgers?: LedgerRecord[]): string[] {
  const out: string[] = [];
  const all = Object.entries(reg.entries).sort((a, b) => Date.parse(a[1].expiresAt) - Date.parse(b[1].expiresAt));
  const expired = all.filter(([, e]) => !isLive(e, now));
  const live = all.filter(([, e]) => isLive(e, now));
  for (const [id, e] of expired) out.push(expiredNotice(id, e));
  let expiring = 0, ready = 0;
  for (const [id, e] of live) {
    const daysLeft = Math.ceil((Date.parse(e.expiresAt) - now.getTime()) / DAY);
    if (daysLeft <= 2) expiring++;
    let history = '';
    if (ledgers) {
      const sid = safeText(id);
      const mine = ledgers.filter(r => r.id === sid && Date.parse(r.ts) >= Date.parse(e.enteredAt)).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      let streak = 0;
      for (let i = mine.length - 1; i >= 0 && cleanPass(mine[i]!); i--) streak++;
      const isReady = streak >= EXIT_RULE_PASSES;
      if (isReady) ready++;
      history = ` recent=${mine.slice(-5).map(shortKind).join(',') || 'none'} clean_streak=${streak}${isReady ? ` READY_TO_RELEASE: ${releaseCommand(id)}` : ''}`;
    }
    const renewal = e.renewals.length ? 'renewed once; fix or release' : `renew: ${renewCommand(id)}`;
    out.push(`QUARANTINE: ${safeText(id)} owner=${safeText(e.owner)} class=${e.failureClass} days_left=${daysLeft} expires=${e.expiresAt.slice(0, 10)} ledger=${safeText(e.ledger)}${history}${daysLeft <= 2 ? ` EXPIRING (${renewal})` : ''}`);
  }
  out.push(`QUARANTINE_REPORT: live=${live.length} expired=${expired.length} expiring=${expiring} ready=${ledgers ? ready : 'unchecked'} exit_rule=${ledgers ? `checked (${EXIT_RULE_PASSES} consecutive clean passes)` : 'not checked (no --ledger given)'}`);
  return out;
}

export const QUARANTINE_USAGE = `Usage:
  gstack-flaky quarantine add <id> --owner <who> --ledger <url> --class detector|harness|timing|model-latency
                              --reason <text> --evidence <url> [--evidence <url>...] --junit <file> [--runner <r>] [--days <1-${MAX_DAYS}>]
  gstack-flaky quarantine renew <id> --owner <who> --evidence <new url> [--days <1-${RENEW_MAX_DAYS}>]
  gstack-flaky quarantine release <id> --reason <text> --pr <url>
  gstack-flaky quarantine check [--base <ref>] [--junit <file>]
  gstack-flaky quarantine report [--ledger <file|dir>...] [--base <ref>]

add/renew/release edit ${REGISTRY_PATH} at the repository root. check validates it
(owner, ledger, class, evidence, expiry, one renewal, the cap) and, with --base,
refuses an entry added in the change that edits its test's file, an entry removed
without a release record, and a removed release record. report lists expired and
live entries, soonest-expiring first; with --ledger (files or directories of
downloaded ledgers) it shows recent outcomes and marks entries with ${EXIT_RULE_PASSES}
consecutive clean passes READY_TO_RELEASE.
Exit: 0 ok, 1 refused, 2 usage, 3 unreadable registry or base.
`;

interface CliIO { cwd: string; out: (s: string) => void; now: Date }

const usage = (msg: string): never => { throw new QuarantineError('FLAKY_QUARANTINE_USAGE', msg, 2); };

function parseArgs(argv: string[]) {
  const flags: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const v = argv[++i];
    if (v === undefined) usage(`${a} needs a value`);
    (flags[a.slice(2)] ??= []).push(v!);
  }
  return { flags, positional };
}

function intFlag(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) usage(`--${name} must be a whole number`);
  return n;
}

const ALLOWED: Record<string, string[]> = {
  add: ['owner', 'ledger', 'class', 'reason', 'evidence', 'junit', 'runner', 'days'], renew: ['owner', 'evidence', 'days'],
  release: ['reason', 'pr'], check: ['base', 'junit', 'runner'], report: ['ledger', 'base'],
};

/** The `gstack-flaky quarantine` subcommands; returns the exit code. A JunitError from --junit propagates to the bin. */
export function quarantineMain(argv: string[], io: CliIO): number {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') { io.out(QUARANTINE_USAGE); return sub ? 0 : 2; }
  if (!ALLOWED[sub]) usage(`unknown quarantine command ${sub}\n${QUARANTINE_USAGE}`);
  const { flags, positional } = parseArgs(rest);
  const unknown = Object.keys(flags).find(f => !ALLOWED[sub]!.includes(f));
  if (unknown) usage(`${sub} does not take --${unknown}`);
  const one = (f: string) => flags[f]?.at(-1);
  const runner = one('runner') as JunitRunner | undefined;
  if (runner !== undefined && !['playwright', 'bun', 'generic'].includes(runner)) usage('--runner must be playwright, bun or generic');
  const needsId = sub === 'add' || sub === 'renew' || sub === 'release';
  if (needsId !== (positional.length === 1) || positional.length > 1) usage(needsId ? `${sub} takes one test id` : `${sub} takes no test id`);
  if (sub === 'check') {
    const junit = one('junit');
    const r = checkRegistry(io.cwd, { base: one('base'), suiteTests: junit ? readJunit(junit, runner).tests.length : undefined }, io.now);
    for (const p of r.problems) io.out(`QUARANTINE_REFUSED: ${p}\n`);
    io.out(`QUARANTINE_CHECK: live=${r.live} cap=${r.cap ?? 'none'} base=${one('base') ?? 'none'} verdict=${r.problems.length ? 'fail' : 'pass'}\n`);
    return r.problems.length ? 1 : 0;
  }
  if (sub === 'report') {
    const ledgers = flags.ledger ? readLedgers(flags.ledger) : undefined;
    if (ledgers?.skipped) io.out(`QUARANTINE_LEDGER: skipped ${ledgers.skipped} unreadable line(s)\n`);
    for (const l of reportLines(readRegistry(io.cwd, one('base')), io.now, ledgers?.records)) io.out(`${l}\n`);
    return 0;
  }
  const id = positional[0]!;
  const reg = readRegistry(io.cwd);
  let line: string;
  if (sub === 'add') {
    const junit = one('junit') ?? refuse('add needs --junit <file> to count the suite and confirm the id exists');
    const suiteIds = readJunit(junit, runner).tests.map(t => t.id);
    const e = addEntry(reg, id, { owner: one('owner'), ledger: one('ledger'), failureClass: one('class'), reason: one('reason'), evidence: flags.evidence ?? [], days: intFlag(one('days'), 'days'), suiteIds }, io.now);
    line = `QUARANTINE_ADDED: ${safeText(id)} owner=${safeText(e.owner)} class=${e.failureClass} expires=${e.expiresAt}`;
  } else if (sub === 'renew') {
    const e = renewEntry(reg, id, { owner: one('owner'), evidence: flags.evidence ?? [], days: intFlag(one('days'), 'days') }, io.now);
    line = `QUARANTINE_RENEWED: ${safeText(id)} owner=${safeText(e.renewals[0]!.owner)} expires=${e.expiresAt} (no further renewal)`;
  } else {
    const r = releaseEntry(reg, id, { reason: one('reason'), pr: one('pr') }, io.now);
    line = `QUARANTINE_RELEASED: ${safeText(id)} pr=${safeText(r.pr)}`;
  }
  writeRegistry(io.cwd, reg);
  io.out(`${line} registry=${REGISTRY_PATH}\n`);
  return 0;
}
