/**
 * inventory — every part of gstack, its load per run and its evidence (ETHOS.md: 9. Earn Its Place).
 *
 * Keys are the skill directories discoverTemplates() finds (the root skill as `gstack`) plus
 * SHARED_KEYS. The ledger, docs/inventory/evidence.json, is hand-kept: each row is checked by its
 * status's own fields (validateEntry). buildInventory joins the ledger with lib/context-bill.ts
 * buildBill (offline token estimates) and the dispatch counts ship and autoplan already document,
 * each found by its quoted line so a citation that drifts is named. Read-only except the CLI's write.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverTemplates } from '../scripts/discover-skills';
import { buildBill, contentClass, TOKEN_DIVISOR, TOKEN_DIVISORS } from './context-bill';
import { CAPY_INSTALL_ROOT } from './doctor-components';

export const LEDGER_PATH = 'docs/inventory/evidence.json';
export const DOC_PATH = 'docs/inventory.md';
export const ROOT_KEY = 'gstack';

export interface SharedPart { key: string; label: string; load: string; files: string[] }
/** Shared parts: sized from their files (catalog from the bill's frontmatter). */
export const SHARED_PARTS: SharedPart[] = [
  { key: 'preamble', label: 'shared preamble (sections/preamble.md, identical in every tier 2+ skill)', load: 'every tier 2+ skill run, inside that skill\'s load', files: ['ship/sections/preamble.md'] },
  { key: 'catalog', label: 'skill catalog (every skill\'s frontmatter)', load: 'every session', files: [] },
  { key: 'capy-skill', label: 'capy/skill/gstack/SKILL.md', load: 'every Capy session', files: ['capy/skill/gstack/SKILL.md'] },
  { key: 'capy-factory', label: 'capy/skill/gstack/factory.md', load: 'every Capy session', files: ['capy/skill/gstack/factory.md'] },
  { key: 'ship-review-panel', label: '/ship review panel (review-army and adversarial sections)', load: 'every /ship run, by depth', files: ['ship/sections/review-army.md', 'ship/sections/adversarial.md'] },
  { key: 'ship-docs-audit', label: '/ship docs audit (Step 14.5)', load: 'every /ship run', files: ['ship/sections/documentation.md'] },
  { key: 'autoplan-phases', label: '/autoplan CEO, design, DX and eng phases', load: 'every /autoplan run, by scope', files: ['autoplan/sections/ceo-phase.md', 'autoplan/sections/design-phase.md', 'autoplan/sections/dx-phase.md', 'autoplan/sections/eng-phase.md'] },
];
export const SHARED_KEYS = SHARED_PARTS.map(p => p.key);

export interface Dispatch { skill: 'ship' | 'autoplan'; what: string; count: string; file: string; quote: string }
/** Paid dispatches per run, from the budget tables and docs that already state them (no new instrumentation). */
export const DISPATCHES: Dispatch[] = [
  { skill: 'ship', what: 'Step 9 review, pass 1, light depth, docs or tests only', count: '1 reader (the core checklist)', file: 'docs/review-policy.md', quote: '| **light**, runtime 0 |' },
  { skill: 'ship', what: 'Step 9 review, pass 1, light depth, code', count: '3 readers (core, one batched specialist, native adversarial), plus the outside voice on a diff that publishes numbers', file: 'docs/review-policy.md', quote: '| **light**, runtime above 0 |' },
  { skill: 'ship', what: 'Step 9 review, pass 1, standard depth', count: 'the batched specialist, the Red Team at 200 runtime lines, adversarial and outside voice', file: 'docs/review-policy.md', quote: '| **standard** |' },
  { skill: 'ship', what: 'Step 9 review, pass 1, full depth', count: 'the batched specialist on the whole diff and the Red Team always', file: 'docs/review-policy.md', quote: '| **full** |' },
  { skill: 'ship', what: 'targeted reader on money, gate, auth or secret code', count: '+1 at every depth', file: 'docs/review-policy.md', quote: '`gstack-review-plan` dispatches one' },
  { skill: 'ship', what: 'audits (Steps 7, 8 and 14.5)', count: '3', file: 'lib/ship-budget-calibration.json', quote: 'each audit dispatch (Steps 7, 8, 14.5)' },
  { skill: 'ship', what: 'measured: one /ship child (gstack-evals#31)', count: '10 review dispatches', file: 'lib/ship-budget-calibration.json', quote: 'its 10 review dispatches' },
  { skill: 'ship', what: 'prior cost of one dispatch on the Capy meter', count: '7,430,000 tokens', file: 'lib/ship-budget-calibration.json', quote: '"per_dispatch": 7430000' },
  { skill: 'autoplan', what: 'voices per phase (native and outside)', count: '2', file: 'autoplan/DRIVER.md.tmpl', quote: 'per voice. Dispatch the native prompt to a subagent on your model and the outside prompt to' },
  { skill: 'autoplan', what: 'phases per round: CEO and Eng always, Design with UI scope, DX with developer-facing scope', count: '2 to 4, so 4 to 8 voice dispatches a round', file: 'autoplan/SKILL.md.tmpl', quote: 'Phases MUST run in strict order: CEO → Design (if UI scope) → DX (if developer-facing' },
  { skill: 'autoplan', what: 'CEO spec review loop', count: 'up to 3 launches', file: 'autoplan/sections/ceo-phase.md.tmpl', quote: 'three-launch cap' },
  { skill: 'autoplan', what: 'review rounds per phase (new unattended runs)', count: 'up to 2', file: 'lib/autoplan-budget.ts', quote: 'export const DEFAULT_MAX_ROUNDS = 2;' },
  { skill: 'autoplan', what: 'reserved per voice on Capy or under a spend cap', count: '$5', file: 'lib/autoplan-budget.ts', quote: 'export const DEFAULT_HOST_ESTIMATE_USD = 5;' },
];

export const STATUSES = ['helps', 'no-effect', 'hurts', 'untested', 'safety'] as const;
export type Status = (typeof STATUSES)[number];
export const R48_VERDICTS = ['KEEP', 'FIX-METHOD', 'CUT-CANDIDATE'] as const;
/** R54: the frontier models under test; a row may add at most one named low-cost primary, never Haiku or Sonnet. */
export const FRONTIER_MODELS = ['claude-opus-5-5', 'gpt-6.1-sol'];
/** Why an earlier result does not count as fair evidence yet. */
export const PRIOR_WHY: Record<string, string> = {
  stub: 'ran on the Agent SDK stub prompt, not the claude_code preset',
  'small-tier': 'Haiku, Sonnet or another non-frontier model only',
  unmasked: 'no mask recorded: the no-gstack arm predates the masking rule and was not re-checked',
  ceiling: 'control at the ceiling, so no difference could show',
  'no-true-no-gstack-arm': 'the none arm still had gstack installed',
  'no-exposure': 'the model never used the part',
  'not-claude-code': 'ran outside Claude Code (Messages API, Codex or Capy)',
  'variant-only': 'variant against variant, no no-gstack arm',
};
const FIELDS = ['status', 'grandfathered', 'plan', 'prior', 'reason', 'owner', 'measure_by', 'sources', 'models', 'prompt', 'scope', 'masked', 'r48', 'caveats', 'seed', 'aliases', 'note'];

export type LedgerCode =
  | 'LEDGER_PARSE' | 'LEDGER_KEY_MISSING' | 'LEDGER_KEY_EXTRA' | 'LEDGER_STATUS_INVALID' | 'LEDGER_FIELD_UNKNOWN'
  | 'LEDGER_SOURCES_MISSING' | 'LEDGER_MODELS_NOT_FRONTIER' | 'LEDGER_PROMPT_NOT_PRESET' | 'LEDGER_SCOPE_MISSING'
  | 'LEDGER_UNMASKED' | 'LEDGER_R48_MISSING' | 'LEDGER_PLAN_MISSING' | 'LEDGER_PLAN_NONE_NEW' | 'LEDGER_PLAN_NOT_CONCRETE'
  | 'LEDGER_REASON_MISSING' | 'LEDGER_OWNER_MISSING' | 'LEDGER_MEASURE_BY_MISSING' | 'LEDGER_PRIOR_INVALID' | 'LEDGER_FIELD_INVALID'
  | 'INVENTORY_SOURCE_MISSING' | 'INVENTORY_PART_MISSING';
export interface LedgerProblem { key: string; code: LedgerCode; message: string }
export interface LedgerEntry { status: Status; grandfathered?: boolean; plan?: string; prior?: Array<{ ref: string; why: string[]; note?: string }>; reason?: string; owner?: string; measure_by?: string; sources?: string[]; models?: string[]; prompt?: string; scope?: string; masked?: boolean; r48?: { verdict: string; ref: string }; caveats?: string[]; seed?: string; aliases?: string[]; note?: string }
export interface Ledger { parts: Record<string, LedgerEntry>; unmapped?: Array<{ row: string; why: string }>; [k: string]: unknown }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const validR48 = (v: unknown) => isObj(v) && (R48_VERDICTS as readonly string[]).includes(v.verdict as string) && str(v.ref);

function frontierModels(v: unknown): boolean {
  if (!Array.isArray(v) || !v.length || !v.every(str)) return false;
  const ids = v.map(m => m.slice(m.lastIndexOf('/') + 1));
  const other = ids.filter(m => !FRONTIER_MODELS.includes(m));
  return ids.length > other.length && other.length <= 1 && !other.some(m => /haiku|sonnet/i.test(m));
}

/** Problems with one ledger row, by its status's own fields (helps, no-effect, hurts, untested, safety). */
export function validateEntry(key: string, entry: unknown): LedgerProblem[] {
  const problems: LedgerProblem[] = [];
  const add = (code: LedgerCode, message: string) => problems.push({ key, code, message });
  if (!isObj(entry)) { add('LEDGER_STATUS_INVALID', 'the row is not an object'); return problems; }
  for (const f of Object.keys(entry)) if (!FIELDS.includes(f)) add('LEDGER_FIELD_UNKNOWN', `unknown field ${f}; fields: ${FIELDS.join(', ')}`);
  const prior = entry.prior;
  if (prior !== undefined && !(Array.isArray(prior) && prior.every(p => isObj(p) && str(p.ref) && Array.isArray(p.why) && p.why.length > 0 && p.why.every(w => typeof w === 'string' && Object.hasOwn(PRIOR_WHY, w)))))
    add('LEDGER_PRIOR_INVALID', `prior needs [{ref, why: [...]}] with why from: ${Object.keys(PRIOR_WHY).join(', ')}`);
  if (entry.aliases !== undefined && !(Array.isArray(entry.aliases) && entry.aliases.length > 0 && entry.aliases.every(str))) add('LEDGER_FIELD_INVALID', 'aliases needs a list of names');
  const status = entry.status;
  if (entry.caveats !== undefined && !((status === 'helps' || status === 'no-effect' || status === 'hurts') && Array.isArray(entry.caveats) && entry.caveats.length > 0 && entry.caveats.every(str)))
    add('LEDGER_FIELD_INVALID', 'caveats is a list of limits on a helps, no-effect or hurts result');
  if (status === 'helps' || status === 'no-effect' || status === 'hurts') {
    if (!Array.isArray(entry.sources) || !entry.sources.length || !entry.sources.every(str)) add('LEDGER_SOURCES_MISSING', `${status} needs sources: one or more run ids or results files`);
    if (!frontierModels(entry.models)) add('LEDGER_MODELS_NOT_FRONTIER', `models must include ${FRONTIER_MODELS.join(' or ')} plus at most one named low-cost primary, never Haiku or Sonnet (R54)`);
    if (entry.prompt !== 'preset') add('LEDGER_PROMPT_NOT_PRESET', 'prompt must be "preset" (the claude_code system prompt, not the Agent SDK stub)');
    if (!str(entry.scope)) add('LEDGER_SCOPE_MISSING', 'scope must say what was measured');
    if (entry.masked !== true) add('LEDGER_UNMASKED', 'masked must be true: the no-gstack arm was masked from the Capy drives and gstack installs');
    if (status !== 'helps' && !validR48(entry.r48)) add('LEDGER_R48_MISSING', `${status} needs r48: {verdict: ${R48_VERDICTS.join('|')}, ref}`);
  } else if (status === 'untested') {
    const grandfathered = entry.grandfathered === true;
    if (!str(entry.plan)) add('LEDGER_PLAN_MISSING', 'untested needs plan: a reference, or "none" on a grandfathered row');
    else if (entry.plan === 'none') { if (!grandfathered) add('LEDGER_PLAN_NONE_NEW', 'plan: none is only for grandfathered rows; a new part names its measurement plan'); }
    else if (!grandfathered && !/^\S+\/tasks\.json$|^\S*prereg[^\s/]*\.md$/i.test(entry.plan)) add('LEDGER_PLAN_NOT_CONCRETE', 'a new part\'s plan is the path of a test/fixtures/skill-evals/<name>/tasks.json or of an /eval-plan preregistration (a .md file named for its prereg)');
    if (!grandfathered) {
      if (!str(entry.reason)) add('LEDGER_REASON_MISSING', 'a new untested part states its reason');
      if (!str(entry.owner)) add('LEDGER_OWNER_MISSING', 'a new untested part names its owner');
      if (!str(entry.measure_by) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.measure_by) || Number.isNaN(Date.parse(entry.measure_by))) add('LEDGER_MEASURE_BY_MISSING', 'a new untested part needs measure_by: YYYY-MM-DD');
    }
  } else if (status === 'safety') {
    if (!str(entry.reason)) add('LEDGER_REASON_MISSING', 'safety needs reason: what the guard protects');
  } else add('LEDGER_STATUS_INVALID', `status must be one of ${STATUSES.join(', ')}`);
  if (entry.r48 !== undefined && !validR48(entry.r48) && status !== 'no-effect' && status !== 'hurts') add('LEDGER_R48_MISSING', `r48 needs {verdict: ${R48_VERDICTS.join('|')}, ref}`);
  return problems;
}

/** Coverage (no missing, no extra key) then every row's own schema. */
export function validateLedger(ledger: unknown, keys: string[]): LedgerProblem[] {
  if (!isObj(ledger) || !isObj(ledger.parts)) return [{ key: '(ledger)', code: 'LEDGER_PARSE', message: `${LEDGER_PATH} needs a parts object` }];
  const parts = ledger.parts;
  return [
    ...keys.filter(k => !(k in parts)).map(k => ({ key: k, code: 'LEDGER_KEY_MISSING' as const, message: `no row in ${LEDGER_PATH}` })),
    ...Object.keys(parts).filter(k => !keys.includes(k)).map(k => ({ key: k, code: 'LEDGER_KEY_EXTRA' as const, message: 'not an inventory key (the key list is in docs/inventory.md)' })),
    ...keys.filter(k => k in parts).flatMap(k => validateEntry(k, parts[k])),
  ];
}

export function loadLedger(root: string): { ledger: Ledger | null; problems: LedgerProblem[] } {
  try {
    return { ledger: JSON.parse(fs.readFileSync(path.join(root, LEDGER_PATH), 'utf8')), problems: [] };
  } catch (e) {
    return { ledger: null, problems: [{ key: '(ledger)', code: 'LEDGER_PARSE', message: `cannot read ${LEDGER_PATH}: ${(e as Error).message}` }] };
  }
}

/** Why root is a gstack install the CLI must never write into, or null: setup's skills/gstack folders and the Capy checkout (GSTACK_CAPY_ROOT, else CAPY_INSTALL_ROOT). */
export function installReason(root: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  if ([path.resolve(root), real(root)].some(p => /[\\/]skills[\\/]gstack$/.test(p))) return 'a skills/gstack install';
  const capy = (env.GSTACK_CAPY_ROOT || CAPY_INSTALL_ROOT).replace(/^\$HOME/, home);
  return real(root) === real(capy) ? `the Capy install (${capy})` : null;
}

/** The skill keys (discoverTemplates, root skill as gstack, symlinked folders excluded) then SHARED_KEYS. */
export function inventoryKeys(root: string): string[] {
  const skills = discoverTemplates(root).map(t => path.dirname(t.tmpl)).map(d => (d === '.' ? ROOT_KEY : d));
  return [...skills.sort(), ...SHARED_KEYS];
}

/** Installed skill name to key: gstack-<name> is <name>; gstack-upgrade keeps its name. */
export const keyOf = (name: string) => (name !== 'gstack-upgrade' && name.startsWith('gstack-') ? name.slice('gstack-'.length) : name);

/** The status's evidence in one phrase: sources, plan or reason. */
export function evidenceRef(e: LedgerEntry): string {
  if (e.status === 'untested') return `plan: ${e.plan}${e.grandfathered ? ' (grandfathered)' : ` (owner ${e.owner}, measure by ${e.measure_by})`}`;
  if (e.status === 'safety') return `reason: ${e.reason}`;
  return `sources: ${(e.sources ?? []).join(', ')}${e.r48 ? `; R48 ${e.r48.verdict}` : ''}${e.caveats ? `; caveats: ${e.caveats.join('; ')}` : ''}`;
}

/** gstack-skill-bill's EVIDENCE line for one skill folder in a gstack checkout. */
export function skillEvidence(root: string, dir: string): { key: string; status: Status | 'missing' | 'unreadable'; ref: string; line: string } {
  const key = path.relative(root, dir) || ROOT_KEY;
  const loaded = loadLedger(root);
  if (loaded.problems.length) {
    const ref = `${loaded.problems[0]!.message}; fix the file, then run bin/gstack-inventory --check`;
    return { key, status: 'unreadable', ref, line: `EVIDENCE: unreadable: ${ref}` };
  }
  const entry = loaded.ledger?.parts?.[key];
  if (!entry) {
    const ref = `no ${key} row in ${LEDGER_PATH}; add one (ETHOS.md: 9. Earn Its Place)`;
    return { key, status: 'missing', ref, line: `EVIDENCE: missing: ${ref}` };
  }
  const ref = evidenceRef(entry);
  return { key, status: entry.status, ref, line: `EVIDENCE: ${entry.status} ${ref}` };
}

export interface CitedDispatch extends Dispatch { line: number | null }
const tokensOf = (rel: string, bytes: number) => Math.round(bytes / (TOKEN_DIVISORS[contentClass(rel)] ?? TOKEN_DIVISOR));

/** Ledger, dispatch citations and shared-part files; no bill, so --check stays fast. */
export function checkInventory(root: string): { keys: string[]; ledger: Ledger | null; dispatches: CitedDispatch[]; problems: LedgerProblem[] } {
  const keys = inventoryKeys(root);
  const loaded = loadLedger(root);
  const problems = [...loaded.problems, ...(loaded.ledger ? validateLedger(loaded.ledger, keys) : [])];
  const dispatches = DISPATCHES.map(d => {
    const file = path.join(root, d.file);
    const idx = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').findIndex(l => l.includes(d.quote)) : -1;
    if (idx < 0) problems.push({ key: `dispatch:${d.skill}`, code: 'INVENTORY_SOURCE_MISSING', message: `${d.file} no longer holds "${d.quote}"; update DISPATCHES in lib/inventory.ts` });
    return { ...d, line: idx < 0 ? null : idx + 1 };
  });
  for (const part of SHARED_PARTS) for (const f of part.files) if (!fs.existsSync(path.join(root, f)))
    problems.push({ key: part.key, code: 'INVENTORY_PART_MISSING', message: `${f} is missing; update SHARED_PARTS in lib/inventory.ts` });
  return { keys, ledger: loaded.ledger, dispatches, problems };
}

export interface PartRow { key: string; kind: 'skill' | 'shared'; label: string; loads: string; loadTokens: number | null; onDemandTokens: number | null; alwaysOnTokens: number | null; status: Status | 'missing'; ref: string }
export interface Inventory {
  commit: string; date: string; tokenSource: string; keys: string[]; parts: PartRow[];
  tiers: Array<{ tier: string; skills: string[] }>; dispatches: CitedDispatch[];
  prior: Array<{ key: string; ref: string; why: string[]; note?: string }>;
  aliases: Array<{ key: string; names: string[] }>;
  unmapped: Array<{ row: string; why: string }>; problems: LedgerProblem[];
}

function git(root: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The commit the snapshot measured, its date, and whether the tree had other changes. */
function measuredAt(root: string): { commit: string; date: string } {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (!top || path.resolve(top) !== path.resolve(root)) return { commit: 'none', date: 'none' };
  const dirty = git(root, ['status', '--porcelain', '--', '.', `:!${DOC_PATH}`]);
  return { commit: (git(root, ['rev-parse', '--short=9', 'HEAD']) ?? 'none') + (dirty ? ' (with uncommitted changes)' : ''), date: git(root, ['log', '-1', '--format=%cs']) ?? 'none' };
}

/** Joins the ledger with the context bill: one row per key, ranked by load per run. */
export function buildInventory(root: string): Inventory {
  const checked = checkInventory(root);
  const bill = buildBill(root);
  const resolved = path.resolve(root);
  const bySkill = new Map(bill.skills.map(s => [path.relative(resolved, s.dir) || ROOT_KEY, s]));
  const parts = checked.ledger?.parts ?? {};
  const skillKeys = checked.keys.filter(k => !SHARED_KEYS.includes(k));
  const evidence = (key: string) => (parts[key] ? { status: parts[key]!.status, ref: evidenceRef(parts[key]!) } : { status: 'missing' as const, ref: 'no row' });
  const rows: PartRow[] = skillKeys.map(key => {
    const s = bySkill.get(key);
    const hoisted = path.join(root, key, 'sections', 'preamble.md');
    const shared = fs.existsSync(hoisted) ? tokensOf(`${key}/sections/preamble.md`, fs.statSync(hoisted).size) : 0;
    const onDemand = s && key !== ROOT_KEY ? Math.max(0, Math.round(s.totalMdTokens - s.perInvocationTokens - shared)) : null;
    return { key, kind: 'skill', label: key === ROOT_KEY ? 'root skill (/gstack router)' : `/${key}`, loads: 'every use', loadTokens: s ? Math.round(s.perInvocationTokens) : null, onDemandTokens: onDemand, alwaysOnTokens: s ? Math.round(s.frontmatterTokens) : null, ...evidence(key) };
  });
  const catalog = skillKeys.reduce((n, k) => n + (bySkill.get(k)?.frontmatterTokens ?? 0), 0);
  for (const part of SHARED_PARTS) {
    const sizes = part.files.map(f => { const file = path.join(root, f); return fs.existsSync(file) ? tokensOf(f, fs.statSync(file).size) : 0; });
    const tokens = part.key === 'catalog' ? Math.round(catalog) : sizes.reduce((a, b) => a + b, 0);
    rows.push({ key: part.key, kind: 'shared', label: part.label, loads: part.load, loadTokens: tokens, onDemandTokens: null, alwaysOnTokens: part.key === 'catalog' ? tokens : null, ...evidence(part.key) });
  }
  rows.sort((a, b) => (b.loadTokens ?? -1) - (a.loadTokens ?? -1) || a.key.localeCompare(b.key));
  const tiers = new Map<string, string[]>();
  for (const key of skillKeys) {
    const tmpl = path.join(root, key === ROOT_KEY ? '' : key, 'SKILL.md.tmpl');
    const tier = /^preamble-tier:\s*(\d+)/m.exec(fs.readFileSync(tmpl, 'utf8'))?.[1] ?? 'none';
    tiers.set(tier, [...(tiers.get(tier) ?? []), key]);
  }
  return {
    ...measuredAt(root),
    tokenSource: bill.tokenSource,
    keys: checked.keys,
    parts: rows,
    tiers: [...tiers].sort(([a], [b]) => a.localeCompare(b)).map(([tier, skills]) => ({ tier, skills })),
    dispatches: checked.dispatches,
    prior: checked.keys.flatMap(key => (parts[key]?.prior ?? []).map(p => ({ key, ...p }))),
    aliases: checked.keys.filter(k => parts[k]?.aliases?.length).map(k => ({ key: k, names: parts[k]!.aliases! })),
    unmapped: checked.ledger?.unmapped ?? [],
    problems: checked.problems,
  };
}

const n = (v: number | null) => (v === null ? 'n/a' : v.toLocaleString('en-US'));
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function renderRanking(inv: Inventory): string[] {
  const out = ['## Parts by load per run', '', 'Load per run: a skill\'s SKILL.md plus the files it must read on every use (`perInvocationTokens` in lib/context-bill.ts); a shared part\'s files. Tier 2+ skills also read the shared preamble once per session (its own row). On demand: the skill\'s other sections/ and references/ files, read when a step asks for them; files a shared row also counts, such as /ship\'s review sections, appear in both. Always-on: frontmatter every session\'s skill scanner reads.', '',
    '| Rank | Part | Kind | Load per run (tokens) | On demand (tokens) | Always-on (tokens) | Loads | Status | Source, plan or reason |', '|---|---|---|---|---|---|---|---|---|'];
  inv.parts.forEach((p, i) => out.push(`| ${i + 1} | ${p.key} | ${p.kind} | ${n(p.loadTokens)} | ${n(p.onDemandTokens)} | ${n(p.alwaysOnTokens)} | ${cell(p.loads)} | ${p.status} | ${cell(p.ref)} |`));
  return out;
}

function renderMeasureNext(inv: Inventory): string[] {
  const out = ['## Measure next', '', 'Untested parts, largest load per run first. A fair test runs the claude_code preset, frontier models (Opus 5.5 and GPT-6.1 Sol, plus at most one named low-cost primary) and a masked no-gstack arm ([TESTING_INTERNALS.md](TESTING_INTERNALS.md#no-gstack-arm)). Safety rows are not on this list.', '',
    '| Order | Part | Load per run (tokens) | Plan |', '|---|---|---|---|'];
  inv.parts.filter(p => p.status === 'untested').forEach((p, i) => out.push(`| ${i + 1} | ${p.key} | ${n(p.loadTokens)} | ${cell(p.ref.replace(/^plan: /, ''))} |`));
  return out;
}

function renderShared(inv: Inventory): string[] {
  const out = ['## Shared parts and preamble tiers', '', '| Tier | Skills | What loads |', '|---|---|---|'];
  const what: Record<string, string> = { '1': 'a short preamble inline in SKILL.md', none: 'no preamble' };
  for (const t of inv.tiers) out.push(`| ${t.tier} | ${t.skills.join(', ')} | ${what[t.tier] ?? 'the shared sections/preamble.md (row preamble), once per session'} |`);
  out.push('', ...SHARED_PARTS.map(p => `- **${p.key}**: ${p.label}${p.files.length ? ` (${p.files.join(', ')})` : ''}; loads ${p.load}.`));
  return out;
}

function renderDispatches(inv: Inventory): string[] {
  const out = ['## Paid dispatches per run', '', 'Each count is quoted from the file and line named; `bin/gstack-inventory --check` fails when a quoted line moves away.', '', '| Skill | What | Count | Source |', '|---|---|---|---|'];
  for (const d of inv.dispatches) out.push(`| ${d.skill} | ${cell(d.what)} | ${cell(d.count)} | ${d.line ? `${d.file}:${d.line}` : `${d.file}: source not found`} |`);
  return out;
}

function renderPrior(inv: Inventory): string[] {
  const out = ['## Earlier results that do not count yet', '', ...Object.entries(PRIOR_WHY).map(([k, v]) => `- \`${k}\`: ${v}.`), '', '| Part | Result | Why it does not count | Note |', '|---|---|---|---|'];
  for (const p of inv.prior) out.push(`| ${p.key} | ${cell(p.ref)} | ${p.why.join(', ')} | ${cell(p.note ?? '')} |`);
  return out;
}

function renderKeys(inv: Inventory): string[] {
  const skills = inv.keys.filter(k => !SHARED_KEYS.includes(k));
  return ['## Key list and aliases', '', `${inv.keys.length} keys: ${skills.length} skills (the folders \`discoverTemplates()\` finds, the root skill as \`gstack\`) and ${SHARED_KEYS.length} shared parts.`, '',
    `- Skills: ${skills.join(', ')}.`, `- Shared: ${SHARED_KEYS.join(', ')}.`,
    '- Installed names: `gstack-<name>` is key `<name>` (`gstack-ship` is `ship`); `gstack-upgrade` keeps its name; the root skill installs as `gstack`.',
    ...(inv.aliases.length ? [`- Other names (the ledger's \`aliases\`): ${inv.aliases.map(a => `${a.names.join(', ')} → ${a.key}`).join('; ')}.`] : [])];
}

function renderNotHere(inv: Inventory): string[] {
  return ['## Not in this inventory', '',
    '- Out of scope: openclaw/skills/* and browser-skills/* (not gstack skills an agent loads from this checkout), and connect-chrome (a symlink to open-gstack-browser, counted once).',
    ...inv.unmapped.map(u => `- Evidence-table row "${u.row}": ${u.why}.`)];
}

export function renderInventory(inv: Inventory): string {
  const count = (s: string) => inv.parts.filter(p => p.status === s).length;
  const planned = inv.parts.filter(p => p.status === 'untested' && !p.ref.startsWith('plan: none')).length;
  return [
    '# gstack inventory: every part, its load per run and its evidence', '',
    `Generated by \`bin/gstack-inventory\` from [evidence.json](inventory/evidence.json), the hand-kept ledger, and lib/context-bill.ts. Measured at commit ${inv.commit} (${inv.date}). This is a dated snapshot: rerun \`bin/gstack-inventory\` to refresh it; \`bin/gstack-inventory --check\` validates the ledger. The rule: [ETHOS.md: 9. Earn Its Place](../ETHOS.md#9-earn-its-place).`, '',
    `Token counts are offline estimates (${inv.tokenSource}, about ±40%), not billed tokens.`, '',
    '| Status | Parts |', '|---|---|',
    ...(['helps', 'no-effect', 'hurts'] as const).map(s => `| ${s} | ${count(s)} |`),
    `| untested, with a plan | ${planned} |`, `| untested, plan none | ${count('untested') - planned} |`, `| safety | ${count('safety')} |`, '',
    ...renderRanking(inv), '', ...renderMeasureNext(inv), '', ...renderShared(inv), '', ...renderDispatches(inv), '',
    ...renderPrior(inv), '', ...renderKeys(inv), '', ...renderNotHere(inv), '',
  ].join('\n');
}
