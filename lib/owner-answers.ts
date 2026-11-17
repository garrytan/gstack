/**
 * owner-answers — the owner's record of answers and standing yeses that a thread reads before it asks
 * the owner anything (docs/owner-answers.md). The record holds the owner's own words and lives where
 * every thread the owner runs can read it: on Capy, the owner's private user-level Drive folder
 * (`~/.capy/drive/user-<owner>/owner-answers/`); elsewhere, `<state root>/owner-answers/`. gstack ships
 * only this mechanism and the file format; the rows never enter a repository.
 *
 * Layout: `rows/<id>.json` (one answer, written once with O_EXCL; a supersede or revoke is a new row
 * naming the row it replaces), `verifications/<row id>--<verifier key>.json` (a second actor's
 * confirmation that the cited source holds the row's words) and `log/<thread>.jsonl` (each thread's
 * taken and asked decisions; one writer per file).
 *
 * Fail closed: an ask is dropped only on the pilot's confirmation of a PROPOSE_TAKE, and screen proposes
 * one only when the whole record reads cleanly, a verified, current, unlimited standing-yes row
 * matches the ask's typed action, target and scope exactly, and no newer or narrower matching row says
 * otherwise. Anything malformed, conflicting, unverified,
 * superseded, untyped, compound or in a fresh-ask class keeps the ask. One source and action is one row id:
 * a second add with different words is refused (OWNER_ANSWERS_CONFLICT), never silently kept.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ResultCodeName } from './result-codes';
import { scan } from './redact-engine';
import { resolveStateRoot } from './state-root';

export const KINDS = ['standing-yes', 'decision', 'preference', 'ruling-ref', 'revoke'] as const;
export type Kind = typeof KINDS[number];
/** The classes that always need a fresh ask (capy/skill/gstack/captain.md, "Always a fresh ask"). */
export const FRESH_ASK_CLASSES = ['product-decision', 'spend-over-cap', 'access', 'publish', 'threshold-change', 'close-contribution', 'destructive'] as const;
export type FreshAskClass = typeof FRESH_ASK_CLASSES[number];
/** A keyword net over untagged ask text: a hit keeps the ask even when the line was not tagged with the class. */
const FRESH_ASK_WORDS: Record<FreshAskClass, RegExp> = {
  'product-decision': /\b(?:product|feature|design|behaviou?r|scope)\b/i,
  'spend-over-cap': /\$\s?\d|\b(?:spend|budget|cost|cap|dollars?)\b/i,
  access: /\b(?:access|credentials?|keys?|tokens?|passwords?|secrets?|sign[ -]?in|log[ -]?in|permissions?)\b/i,
  publish: /\b(?:publish|post|tweet|release notes?|advisory|announce|blog|email|dm)\b/i,
  'threshold-change': /\b(?:threshold|trial count|trials|test kind|pass rate|bar)\b/i,
  'close-contribution': /\b(?:close (?:their|the|a|his|her) (?:pr|pull request|contribution)|decline|reject (?:the )?(?:pr|contribution))\b/i,
  destructive: /\b(?:delete|destroy|drop|wipe|force[- ]push|rotate|revoke|irreversible|purge|reset)\b/i,
};
export const CAPS = { action: 60, target: 120, scope: 160, limits: 300, words: 2000, asked: 300, thread: 80, event: 120, rule: 20, by: 120 } as const;
const TOKEN = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SCOPE = /^(?:all|repo:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|captain:[a-z0-9][a-z0-9-]{0,59})$/;

export interface Source { thread: string; event: string }
export interface OwnerAnswer {
  schema_version: 1; id: string; owner: string; kind: Kind; action: string; target: string; scope: string; limits: string;
  words: string; words_by: string; source: Source; rule: string; asked: string; supersedes: string; recorded_by: string; recorded_at: string;
}
export interface Verification { schema_version: 1; row: string; verified_by: string; verified_at: string; words_sha256: string }
export interface Store { dir: string; owner: string; on_capy: boolean }
export interface AnswerError { code: ResultCodeName; message: string }
export interface StoreRead {
  state: 'present' | 'empty' | 'unavailable' | 'uncertain';
  rows: OwnerAnswer[]; verifications: Verification[]; problems: string[];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const isErr = (x: unknown): x is AnswerError => !!x && typeof x === 'object' && 'code' in (x as object);
export { isErr as isAnswerError };

function contained(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The owner's store. On Capy (GSTACK_CAPY=1) it is the one mounted `user-<owner>` Drive folder (or the one
 * --owner names), never an environment override and never the thrown-away state root. Off Capy it is
 * GSTACK_OWNER_ANSWERS_DIR, else `<state root>/owner-answers`.
 */
export function resolveStore(env: NodeJS.ProcessEnv, owner?: string): Store | AnswerError {
  if (env.GSTACK_CAPY === '1') {
    const drive = path.join(env.HOME || os.homedir(), '.capy', 'drive');
    let folders: string[];
    try { folders = fs.readdirSync(drive).filter(d => d.startsWith('user-') && fs.statSync(path.join(drive, d)).isDirectory()); } catch { folders = []; }
    if (owner) folders = folders.filter(d => d === `user-${owner}`);
    if (!folders.length) return { code: 'OWNER_ANSWERS_NO_DRIVE', message: owner ? `no mounted Drive folder user-${owner}` : `no user-* folder under ${drive}` };
    if (folders.length > 1) return { code: 'OWNER_ANSWERS_AMBIGUOUS', message: `${folders.length} user-* folders are mounted; pass --owner <name>` };
    const folder = path.join(drive, folders[0]!);
    let real: string;
    try { real = fs.realpathSync(folder); } catch { return { code: 'OWNER_ANSWERS_NO_DRIVE', message: `${folder} cannot be resolved` }; }
    const realDrive = fs.realpathSync(drive);
    if (!contained(realDrive, real)) return { code: 'OWNER_ANSWERS_INVALID', message: `${folder} resolves outside ${drive}` };
    return { dir: path.join(real, 'owner-answers'), owner: folders[0]!.slice('user-'.length), on_capy: true };
  }
  const dir = env.GSTACK_OWNER_ANSWERS_DIR || path.join(resolveStateRoot(env), 'owner-answers');
  return { dir, owner: owner || env.GSTACK_OWNER || 'owner', on_capy: false };
}

function field(name: keyof typeof CAPS, value: unknown, required: boolean): string | AnswerError {
  const v = typeof value === 'string' ? value.trim() : '';
  if (required && !v) return { code: 'OWNER_ANSWERS_INVALID', message: `--${name} is required` };
  if (v.length > CAPS[name]) return { code: 'OWNER_ANSWERS_INVALID', message: `--${name} is ${v.length} characters (cap ${CAPS[name]})` };
  if (/[\u0000-\u0008\u000b-\u001f]/.test(v)) return { code: 'OWNER_ANSWERS_INVALID', message: `--${name} holds a control character` };
  const s = scan(v);
  if (s.oversize || s.findings.some(f => f.severity === 'HIGH' || f.severity === 'MEDIUM')) return { code: 'OWNER_ANSWERS_SECRET', message: `field ${name}: ${s.oversize ? 'oversize input' : [...new Set(s.findings.map(f => f.id))].join(', ')}` };
  return v;
}

/** The id is a hash of who said what, where, about which action: the same answer recorded twice is one row. */
export function rowId(r: Pick<OwnerAnswer, 'owner' | 'kind' | 'action' | 'target' | 'scope' | 'source' | 'supersedes'>): string {
  return 'oa-' + sha([r.owner, r.kind, r.action, r.target, r.scope, r.source.thread, r.source.event, r.supersedes].join('\u0000')).slice(0, 16);
}

export interface NewAnswer {
  kind?: string; action?: string; target?: string; scope?: string; limits?: string; words?: string; words_by?: string;
  thread?: string; event?: string; rule?: string; asked?: string; supersedes?: string; by?: string;
}

/** Validate and secret-scan one answer; the error names the field and rule, never the text. */
export function buildAnswer(store: Store, input: NewAnswer, now = new Date()): OwnerAnswer | AnswerError {
  const kind = (input.kind ?? 'standing-yes') as Kind;
  if (!KINDS.includes(kind)) return { code: 'OWNER_ANSWERS_INVALID', message: `--kind must be one of ${KINDS.join('|')}` };
  const out: Record<string, string> = {};
  const need: Array<[keyof typeof CAPS, unknown, boolean]> = [
    ['action', input.action, kind !== 'revoke'], ['target', input.target, kind !== 'revoke'], ['scope', input.scope ?? 'all', true],
    ['limits', input.limits, false], ['words', input.words, true], ['thread', input.thread, true], ['event', input.event, true],
    ['rule', input.rule, false], ['asked', input.asked, false], ['by', input.by, true],
  ];
  for (const [name, value, required] of need) {
    const v = field(name, value, required);
    if (isErr(v)) return v;
    out[name] = v;
  }
  if (out.action && !TOKEN.test(out.action)) return { code: 'OWNER_ANSWERS_INVALID', message: '--action must be one lower-case token (letters, digits, hyphens)' };
  if (out.target && !TOKEN.test(out.target)) return { code: 'OWNER_ANSWERS_INVALID', message: '--target must be one lower-case token (letters, digits, hyphens)' };
  if (!SCOPE.test(out.scope!)) return { code: 'OWNER_ANSWERS_INVALID', message: '--scope must be all, repo:<owner>/<name> or captain:<name>' };
  if (out.rule && !/^R\d{1,4}$/.test(out.rule)) return { code: 'OWNER_ANSWERS_INVALID', message: '--rule must look like R6' };
  const wordsBy = (input.words_by ?? '').trim() || `agent:${out.by}`;
  if (wordsBy !== 'owner') {
    if (!/^agent:\S.*$/.test(wordsBy)) return { code: 'OWNER_ANSWERS_INVALID', message: '--words-by must be owner or agent:<id> on one line' };
    const agent = field('by', wordsBy.slice('agent:'.length), true);
    if (isErr(agent)) return { code: agent.code, message: agent.message.replace('--by', '--words-by') };
  }
  if (kind === 'revoke' && !input.supersedes?.trim()) return { code: 'OWNER_ANSWERS_INVALID', message: 'a revoke names the row it cancels with --supersedes' };
  const supersedes = (input.supersedes ?? '').trim();
  if (supersedes && !/^oa-[0-9a-f]{16}$/.test(supersedes)) return { code: 'OWNER_ANSWERS_INVALID', message: '--supersedes must be a row id (oa-…)' };
  const base = {
    schema_version: 1 as const, owner: store.owner, kind, action: out.action ?? '', target: out.target ?? '', scope: out.scope!, limits: out.limits ?? '',
    words: out.words!, words_by: wordsBy, source: { thread: out.thread!, event: out.event! }, rule: out.rule ?? '', asked: out.asked ?? '',
    supersedes, recorded_by: out.by!, recorded_at: now.toISOString(),
  };
  return { id: rowId(base), ...base };
}

function validRow(r: any, owner: string): string | undefined {
  if (!r || r.schema_version !== 1 || typeof r.id !== 'string') return 'not a v1 row';
  if (!KINDS.includes(r.kind)) return 'unknown kind';
  for (const k of ['owner', 'action', 'target', 'scope', 'limits', 'words', 'words_by', 'rule', 'asked', 'supersedes', 'recorded_by', 'recorded_at']) if (typeof r[k] !== 'string') return `field ${k} is not a string`;
  if (!r.source || typeof r.source.thread !== 'string' || typeof r.source.event !== 'string') return 'no source';
  if (r.owner !== owner) return 'another owner';
  if (rowId(r) !== r.id) return 'id does not match its fields';
  return undefined;
}

function readJsonDir(dir: string): Array<{ name: string; value?: unknown; error?: string }> | 'unavailable' | 'missing' {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch (e: any) { return e?.code === 'ENOENT' ? 'missing' : 'unavailable'; }
  return names.filter(n => n.endsWith('.json')).sort().map(name => {
    try {
      const st = fs.lstatSync(path.join(dir, name));
      if (!st.isFile()) return { name, error: 'not a regular file' };
      return { name, value: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) };
    } catch { return { name, error: 'unreadable or not JSON' }; }
  });
}

/**
 * The record and each of its existing directories must resolve inside the owner's folder on Capy (inside the record
 * itself elsewhere): a link out of it is refused, so a planted link can neither receive rows nor feed them back.
 */
export function storeEscape(store: Store): AnswerError | undefined {
  const root = store.on_capy ? path.dirname(store.dir) : store.dir;
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return undefined; }
  for (const d of [store.dir, ...['rows', 'verifications', 'log'].map(s => path.join(store.dir, s))]) {
    let real: string;
    try { real = fs.realpathSync(d); } catch {
      try { fs.lstatSync(d); } catch { continue; }
      return { code: 'OWNER_ANSWERS_INVALID', message: `${path.relative(root, d) || '.'} is a link that cannot be resolved` };
    }
    if (real !== realRoot && !contained(realRoot, real)) return { code: 'OWNER_ANSWERS_INVALID', message: `${path.relative(root, d) || '.'} resolves outside the record's folder` };
  }
  return undefined;
}

/** Every row and verification; any doubt about the whole record makes it `uncertain`, which keeps every ask. */
export function readStore(store: Store): StoreRead {
  const problems: string[] = [];
  if (!fs.existsSync(store.dir)) return { state: 'empty', rows: [], verifications: [], problems };
  const escape = storeEscape(store);
  if (escape) return { state: 'unavailable', rows: [], verifications: [], problems: [escape.message] };
  const rowFiles = readJsonDir(path.join(store.dir, 'rows'));
  if (rowFiles === 'unavailable') return { state: 'unavailable', rows: [], verifications: [], problems: ['rows/ cannot be read'] };
  const rows: OwnerAnswer[] = [];
  for (const f of rowFiles === 'missing' ? [] : rowFiles) {
    const bad = f.error ?? validRow(f.value, store.owner) ?? (`${(f.value as OwnerAnswer).id}.json` === f.name ? undefined : 'file name does not match its id');
    if (bad) problems.push(`rows/${f.name}: ${bad}`);
    else rows.push(f.value as OwnerAnswer);
  }
  const verFiles = readJsonDir(path.join(store.dir, 'verifications'));
  const verifications: Verification[] = [];
  if (verFiles === 'unavailable') problems.push('verifications/ cannot be read');
  for (const f of verFiles === 'missing' || verFiles === 'unavailable' ? [] : verFiles) {
    const v = f.value as Verification | undefined;
    if (f.error || !v || v.schema_version !== 1 || typeof v.row !== 'string' || typeof v.verified_by !== 'string' || typeof v.words_sha256 !== 'string') problems.push(`verifications/${f.name}: ${f.error ?? 'not a v1 verification'}`);
    else verifications.push(v);
  }
  const ids = new Set(rows.map(r => r.id));
  const replacedBy = new Map<string, string[]>();
  for (const r of rows) if (r.supersedes) replacedBy.set(r.supersedes, [...(replacedBy.get(r.supersedes) ?? []), r.id]);
  for (const [old, by] of replacedBy) {
    if (!ids.has(old)) problems.push(`${by.join(', ')} supersede${by.length === 1 ? 's' : ''} ${old}, which is not in the record`);
    if (by.length > 1) problems.push(`${old} is superseded by ${by.length} rows (${by.join(', ')})`);
  }
  rows.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id));
  return { state: problems.length ? 'uncertain' : rows.length ? 'present' : 'empty', rows, verifications, problems };
}

/** A row is current when no row supersedes it and it is not itself a revoke. */
export function currentRows(read: StoreRead): OwnerAnswer[] {
  const replaced = new Set(read.rows.map(r => r.supersedes).filter(Boolean));
  return read.rows.filter(r => !replaced.has(r.id) && r.kind !== 'revoke');
}

/** Why a row cannot be taken, or undefined when it can: the owner's own words, verified by someone else, current, unlimited. */
export function notTakeable(row: OwnerAnswer, read: StoreRead): string | undefined {
  if (read.state !== 'present') return `the record is ${read.state}`;
  if (row.kind !== 'standing-yes') return `a ${row.kind} row is context only`;
  if (row.words_by !== 'owner') return `the words were typed by ${row.words_by}`;
  if (row.limits) return 'it carries limits the tool cannot check';
  if (!currentRows(read).some(r => r.id === row.id)) return 'it was superseded or revoked';
  const ok = read.verifications.some(v => v.row === row.id && v.verified_by !== row.recorded_by && v.words_sha256 === sha(row.words));
  return ok ? undefined : 'no second actor has verified its words at the source';
}

/** Create the directory for a record file, checking the record's directories before and after. */
function prepareDir(store: Store, file: string): AnswerError | undefined {
  const before = storeEscape(store);
  if (before) return before;
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); } catch (e: any) {
    return { code: 'OWNER_ANSWERS_WRITE_FAILED', message: `${path.basename(path.dirname(file))}: ${e?.code ?? e?.message}` };
  }
  return storeEscape(store);
}

/** One file, created with O_EXCL; a write that fails after the create removes the file, so a retry starts clean. */
export function writeExclusive(store: Store, file: string, value: unknown): 'written' | 'present' | AnswerError {
  const failed = (e: any): AnswerError => ({ code: 'OWNER_ANSWERS_WRITE_FAILED', message: `${path.basename(file)}: ${e?.code ?? e?.message}` });
  const dir = prepareDir(store, file);
  if (dir) return dir;
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); } catch (e: any) {
    return e?.code === 'EEXIST' ? 'present' : failed(e);
  }
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 1) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return 'written';
  } catch (e: any) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(file); } catch { /* left for readStore to report */ }
    return failed(e);
  }
}

export function addAnswer(store: Store, row: OwnerAnswer): 'written' | 'present' | AnswerError {
  if (row.supersedes) {
    const read = readStore(store);
    if (!read.rows.some(r => r.id === row.supersedes)) return { code: 'OWNER_ANSWERS_NOT_FOUND', message: `no row ${row.supersedes} to supersede` };
    const other = read.rows.find(r => r.supersedes === row.supersedes && r.id !== row.id);
    if (other) return { code: 'OWNER_ANSWERS_CONFLICT', message: `${row.supersedes} is already superseded by ${other.id}; supersede or revoke the current row instead` };
  }
  const file = path.join(store.dir, 'rows', `${row.id}.json`);
  const res = writeExclusive(store, file, row);
  if (res !== 'present') return res;
  let have: Partial<OwnerAnswer> = {};
  try { have = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* an unreadable twin is a conflict too */ }
  return have.words === row.words && have.words_by === row.words_by && have.limits === row.limits
    ? 'present'
    : { code: 'OWNER_ANSWERS_CONFLICT', message: `${row.id} already records different words, author or limits for this source and action; supersede it instead` };
}

/**
 * A second actor confirms the cited source holds the row's words: it reads the source event itself and names it
 * (--event must equal the row's source event). The adder can never verify its own row.
 */
export function verifyAnswer(store: Store, id: string, by: string, event: string, now = new Date()): 'written' | 'present' | AnswerError {
  const verifier = field('by', by, true);
  if (isErr(verifier)) return verifier;
  const row = readStore(store).rows.find(r => r.id === id);
  if (!row) return { code: 'OWNER_ANSWERS_NOT_FOUND', message: `no row ${id}` };
  if (row.recorded_by === verifier) return { code: 'OWNER_ANSWERS_SELF_VERIFY', message: `${id} was recorded by ${verifier}` };
  if (event.trim() !== row.source.event) return { code: 'OWNER_ANSWERS_INVALID', message: `--event must name the source event the verifier read (${id} cites ${row.source.thread})` };
  const v: Verification = { schema_version: 1, row: id, verified_by: verifier, verified_at: now.toISOString(), words_sha256: sha(row.words) };
  return writeExclusive(store, path.join(store.dir, 'verifications', `${id}--${sha(verifier).slice(0, 12)}.json`), v);
}

/** origin is "captain" for a standalone Captain ask; anything else (an autoplan gate item, an unknown draft) is never screened out. */
export interface AskLine { line: string; text: string; origin?: string; action?: string; target?: string; scope?: string; limits?: string; classes?: string[]; compound?: boolean }

/** An ask file: JSON `{ "asks": [AskLine, ...] }`, or plain text with one ask per non-blank line (all untyped). */
export function parseAskFile(text: string): AskLine[] | AnswerError {
  const t = text.trim();
  if (t.startsWith('{')) {
    let j: any;
    try { j = JSON.parse(t); } catch { return { code: 'OWNER_ANSWERS_INVALID', message: 'the ask file starts with { but is not JSON' }; }
    if (!Array.isArray(j?.asks)) return { code: 'OWNER_ANSWERS_INVALID', message: 'the ask file needs an "asks" array' };
    return j.asks.map((a: any, i: number) => ({
      line: typeof a?.line === 'string' && a.line ? a.line : String(i + 1), text: typeof a?.text === 'string' ? a.text : '', origin: typeof a?.origin === 'string' ? a.origin : undefined,
      action: typeof a?.action === 'string' ? a.action : undefined, target: typeof a?.target === 'string' ? a.target : undefined,
      scope: typeof a?.scope === 'string' ? a.scope : undefined, limits: typeof a?.limits === 'string' ? a.limits : undefined, classes: Array.isArray(a?.classes) ? a.classes.map(String) : [], compound: a?.compound === true,
    }));
  }
  return t.split('\n').map(l => l.trim()).filter(Boolean).map((l, i) => {
    const m = /^([A-Z][0-9]*)\s*[:.)]\s*(.*)$/.exec(l);
    return { line: m ? m[1]! : String(i + 1), text: m ? m[2]! : l };
  });
}

const STOP = new Set('the a an and or to of for in on at is it be we you your this that with as by from not no do can could should would will any all our its are was were has have if then than so but'.split(' '));
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)));

/** Rows ranked by word overlap with the ask (advisory only: ranking never makes a row takeable). */
export function rankRows(rows: OwnerAnswer[], ask: AskLine, k = 5): Array<{ row: OwnerAnswer; score: number }> {
  const want = words([ask.text, ask.action ?? '', ask.target ?? ''].join(' '));
  return rows
    .filter(r => !ask.scope || r.scope === 'all' || r.scope === ask.scope)
    .map(row => { const have = words([row.asked, row.action, row.target, row.words].join(' ')); let score = 0; for (const w of want) if (have.has(w)) score++; return { row, score }; })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.row.recorded_at.localeCompare(a.row.recorded_at))
    .slice(0, k);
}

export interface Screened { line: string; text: string; verdict: 'KEEP' | 'PROPOSE_TAKE'; reason: string; take?: OwnerAnswer; related: OwnerAnswer[] }

/** Per ask line: a proposal to take only on an exact typed match with a takeable row; otherwise keep, with related rows as context. */
export function screenAsks(asks: AskLine[], read: StoreRead): Screened[] {
  const current = currentRows(read);
  return asks.map(ask => {
    const related = rankRows(current, ask, 3).map(x => x.row);
    const keep = (reason: string): Screened => ({ line: ask.line, text: ask.text, verdict: 'KEEP', reason, related });
    if (read.state !== 'present') return keep(`the record is ${read.state}`);
    if (ask.origin !== 'captain') return keep(ask.origin === 'gate' ? 'a gate item is answered at its gate, never screened out' : 'the ask does not say it is a standalone Captain ask (origin: captain)');
    if (ask.compound) return keep('the line holds more than one decision');
    if (ask.limits?.trim()) return keep('the ask carries limits (an amount, a count, a deadline) the record cannot check');
    const tagged = (ask.classes ?? []).filter(c => (FRESH_ASK_CLASSES as readonly string[]).includes(c));
    const unknownTag = (ask.classes ?? []).find(c => !(FRESH_ASK_CLASSES as readonly string[]).includes(c));
    if (unknownTag) return keep(`unknown class ${unknownTag}`);
    if (tagged.length) return keep(`always a fresh ask: ${tagged.join(', ')}`);
    const netted = FRESH_ASK_CLASSES.filter(c => FRESH_ASK_WORDS[c].test(ask.text));
    if (netted.length) return keep(`its words read as a fresh-ask class: ${netted.join(', ')}`);
    if (!ask.action || !ask.target || !ask.scope) return keep('the line has no typed action, target and scope');
    const exact = current.filter(r => r.action === ask.action && r.target === ask.target && (r.scope === 'all' || r.scope === ask.scope));
    const take = exact.filter(r => !notTakeable(r, read)).at(-1);
    if (!take) return keep(exact.length ? `matching rows are not takeable: ${notTakeable(exact.at(-1)!, read)}` : 'no standing yes matches its action, target and scope');
    const veto = exact.find(r => r !== take && notTakeable(r, read) && (r.recorded_at > take.recorded_at || (take.scope === 'all' && r.scope !== 'all')));
    if (veto) return keep(`a newer or narrower answer for this action is not takeable: ${veto.id} (${notTakeable(veto, read)})`);
    return { line: ask.line, text: ask.text, verdict: 'PROPOSE_TAKE', reason: 'a verified, current standing yes matches exactly', take, related };
  });
}

/** The line a Captain adds to its message for each confirmed take. */
export function takenLine(row: OwnerAnswer): string {
  const words = row.words.length > 160 ? row.words.slice(0, 159).trimEnd() + '…' : row.words;
  return `Not asked, you already said: "${words.replace(/\s+/g, ' ')}" (${row.recorded_at.slice(0, 10)}, ${row.source.thread}${row.rule ? `, ${row.rule}` : ''}).`;
}

export const LOG_DECISIONS = ['taken', 'asked'] as const;

/** One line in the thread's own log: what the pilot did with a line, and which row it took. */
export function logDecision(store: Store, o: { thread: string; line: string; decision: string; row?: string; by: string }, now = new Date()): string | AnswerError {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(o.thread)) return { code: 'OWNER_ANSWERS_INVALID', message: '--thread must be the thread code or id (letters, digits, - and _)' };
  if (!(LOG_DECISIONS as readonly string[]).includes(o.decision)) return { code: 'OWNER_ANSWERS_INVALID', message: `--decision must be ${LOG_DECISIONS.join('|')}` };
  if (o.decision === 'taken') {
    const read = readStore(store);
    const row = read.rows.find(r => r.id === o.row);
    if (!row) return { code: 'OWNER_ANSWERS_NOT_FOUND', message: `no row ${o.row ?? '(none given)'}` };
    const why = notTakeable(row, read);
    if (why) return { code: 'OWNER_ANSWERS_NOT_TAKEABLE', message: `${row.id}: ${why}` };
  }
  const file = path.join(store.dir, 'log', `${o.thread}.jsonl`);
  const dir = prepareDir(store, file);
  if (dir) return dir;
  try {
    fs.appendFileSync(file, JSON.stringify({ at: now.toISOString(), thread: o.thread, line: o.line.slice(0, 20), decision: o.decision, row: o.row ?? '', by: o.by.slice(0, CAPS.by) }) + '\n', { mode: 0o600 });
  } catch (e: any) { return { code: 'OWNER_ANSWERS_WRITE_FAILED', message: `log: ${e?.code ?? e?.message}` }; }
  return file;
}
