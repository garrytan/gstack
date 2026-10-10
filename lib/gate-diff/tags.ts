/**
 * gate-diff tags — best-effort RH labels on top of the floor (W1 table of
 * docs/designs/HONEST_WORK_GATE_INTEGRITY.md, after the Eng amendments).
 *
 * Tags are FACTUAL: a test deleted beside its deleted source is still RH-1;
 * the agent's judgment, never this module, decides whether a tag is a finding.
 * Nothing here suppresses: a citation found beside a hunk is reported, not
 * used to drop the tag. Pure functions over one hunk's lines.
 *
 *   RH-1   test removed or disabled          RH-13  suppression pragma added
 *   RH-3   snapshot changed without owner    RH-14  gate bypass
 *   RH-4   placeholder committed             RH-15  gate value relaxed (RH-15? unpaired)
 *   RH-12  env sniffing in product code      RH-16  exception swallowed
 */
import { TEST_DECLARATION, type PathClass } from './classify';
import type { Hunk } from './types';

export const COVERAGE_TAGS = ['RH-1', 'RH-3', 'RH-4', 'RH-12', 'RH-13', 'RH-14', 'RH-15', 'RH-16'] as const;

export interface TagContext {
  floor: PathClass | null;
  path: string;
  /** Every changed path in the candidate (new paths), for RH-3 owner lookup. */
  allPaths: ReadonlySet<string>;
}

/** Prose files (docs, prompt templates) carry no code idioms: only the path-based RH-3 applies. */
export const PROSE_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc|asciidoc)(?:\.tmpl)?$/i;
/** Generated, vendored or minified files: unreadable as hunks, so floor inventory only. */
export const GENERATED_FILE = /(?:^|\/)(?:dist|build|vendor|node_modules|\.yarn)\/|\.min\.(?:js|css)$|(?:^|\/)[^/]*lock(?:\.json|\.yaml|b)?$/i;

export interface TagResult {
  tags: string[];
  notes: string[];
  citation: string | null;
}

const SKIP_IDIOMS: RegExp[] = [
  /\b(?:test|it|describe|suite|context|specify|bench)\s*\.\s*(?:skip|only)\b/,
  /\bx(?:it|describe|test|context|specify)\s*\(/,
  /\bf(?:it|describe|test)\s*\(/,
  /@pytest\.mark\.skip/,
  /#\[ignore\b/,
  /\bt\.Skip\w*\(/,
  /@Disabled\b/,
  /@Ignore\b/,
  /\bXCTSkip/,
  /@tag\s+:skip\b/,
];
/** Bare rspec `skip`/`pending` statements: only meaningful inside a test file. */
const SKIP_IDIOMS_TEST_ONLY: RegExp[] = [/^\s*(?:skip|pending)\s*(?:\(|["']|$)/];

const PLACEHOLDER_IDIOMS: RegExp[] = [
  /\btodo!\s*\(/, /\bunimplemented!\s*\(/, /\braise\s+NotImplementedError\b/,
  /throw\s+new\s+Error\s*\(\s*["'`][^"'`]*not\s+implemented/i, /\bpass\s+#\s*TODO\b/i,
];

const ENV_SNIFF_IDIOMS: RegExp[] = [
  /process\.env\.CI\b/, /\bNODE_ENV\s*[!=]==?\s*["']test["']/, /["']test["']\s*[!=]==?\s*process\.env\.NODE_ENV/,
  /\bRAILS_ENV\s*==\s*["']test["']/, /\bRails\.env\.test\?/, /\bPYTEST_CURRENT_TEST\b/, /\bGITHUB_ACTIONS\b/,
];

const SUPPRESSION_IDIOMS: RegExp[] = [
  /eslint-disable/, /@ts-ignore\b/, /@ts-expect-error\b/, /#\s*type:\s*ignore\b/, /#\s*noqa\b/,
  /#\[allow\(/, /\/\/\s*nolint\b/, /rubocop:disable\b/, /@SuppressWarnings\b/,
];

const BYPASS_IDIOMS: RegExp[] = [/\bcontinue-on-error:\s*true\b/, /\ballow_failure:\s*true\b/, /--no-verify\b/];

const SWALLOW_SINGLE_LINE: RegExp[] = [
  /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/, /\bexcept(?:\s+[\w.,\s()]+)?\s*:\s*pass\b/, /\brescue\s+nil\b/, /(?:^|[^\w.])_\s*=\s*err\b/,
];

const GATE_KEYS_UP = ['timeout', 'retries', 'retry', 'tolerance', 'epsilon', 'delta', 'maxdiff', 'jitter'];
const GATE_KEYS_DOWN = ['threshold', 'min_score', 'minscore', 'minimum', 'coverage', 'required'];
/** API calls that carry a gate keyword without being a gate value. */
const NOT_GATE_KEYS = new Set(['settimeout', 'cleartimeout', 'setinterval', 'clearinterval']);
const NUMBER = /-?\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?/g;
/** `key: 5`, `key = 5`, `key(5)`, `key => 5`, `--key=5`, `--key 5`; the number may be quoted and may carry a unit. */
const KEY_VALUE = /(?:--([A-Za-z][A-Za-z0-9_-]*)[= ]|([A-Za-z_][A-Za-z0-9_-]*)\s*(?::|=>?|\()\s*)['"`]?(-?\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/g;
const EXACT_COUNT = /^(?<subject>.*?)\.(?:toBe|toEqual|toStrictEqual|toHaveLength)\(\s*-?\d+(?:\.\d+)?\s*\)/;
const BOUND = /^(?<subject>.*?)\.(?:toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual|toBeTruthy|toBeDefined)\(/;

const CITATION_IDIOMS: RegExp[] = [/ship-measure[\w./-]*/i, /\bdec-[a-z0-9]+(?:-[a-z0-9]+)*\b/, /\bmeasured\b/i];

function added(h: Hunk): string[] {
  return h.lines.filter((l) => l.kind === 'add').map((l) => l.text);
}
function removed(h: Hunk): string[] {
  return h.lines.filter((l) => l.kind === 'del').map((l) => l.text);
}
function anyMatch(lines: string[], idioms: RegExp[]): boolean {
  return lines.some((l) => idioms.some((re) => re.test(l)));
}

/** Multi-line empty catch / `except:` + `pass` across consecutive added lines. */
function swallowsAcrossLines(adds: string[]): boolean {
  for (let i = 0; i + 1 < adds.length; i++) {
    const a = adds[i].trim();
    const b = adds[i + 1].trim();
    if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/.test(a) && b === '}') return true;
    if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/.test(a) && /^\/[/*]/.test(b) && adds[i + 2]?.trim() === '}') return true;
    if (/^except\b[^:]*:\s*$/.test(a) && /^pass\b/.test(b)) return true;
  }
  return false;
}

function parseNumber(text: string): number {
  return Number(text.replace(/_/g, ''));
}

/** The gate value assignment on a line: its key, the direction that relaxes it, and the assigned number. */
function relaxDirection(key: string): 'up' | 'down' | null {
  const low = key.toLowerCase();
  if (NOT_GATE_KEYS.has(low)) return null;
  if (GATE_KEYS_UP.some((k) => low.includes(k))) return 'up';
  if (GATE_KEYS_DOWN.some((k) => low.includes(k))) return 'down';
  return null;
}

/** A gate keyword opening a nested structure on one line: `coverage: { thresholds: { lines: 90 } }`. */
const KEY_OPENS_STRUCTURE = /([A-Za-z_][A-Za-z0-9_-]*)\s*(?::|=>?|\()\s*[[{(]/g;

export function gateKey(line: string): { key: string; relaxes: 'up' | 'down'; value: number } | null {
  const pairs = [...line.matchAll(KEY_VALUE)].map((m) => ({ key: m[1] ?? m[2], value: m[3], index: m.index ?? 0 }));
  for (const p of pairs) {
    const relaxes = relaxDirection(p.key);
    if (relaxes) return { key: p.key, relaxes, value: parseNumber(p.value) };
  }
  for (const m of line.matchAll(KEY_OPENS_STRUCTURE)) {
    const relaxes = relaxDirection(m[1]);
    if (!relaxes) continue;
    const inner = pairs.find((p) => p.index > (m.index ?? 0));
    if (inner) return { key: m[1], relaxes, value: parseNumber(inner.value) };
  }
  return null;
}

function numericShape(line: string): string {
  return line.replace(NUMBER, '#').replace(/\s+/g, ' ').replace(/[,;]\s*$/, '').trim();
}

interface ValueLine {
  text: string;
  key: string;
  relaxes: 'up' | 'down';
  shape: string;
  value: number;
  paired: boolean;
}

function valueLines(lines: string[]): ValueLine[] {
  const out: ValueLine[] = [];
  for (const text of lines) {
    const k = gateKey(text);
    if (!k) continue;
    out.push({ text, key: k.key, relaxes: k.relaxes, shape: numericShape(text), value: k.value, paired: false });
  }
  return out;
}

/**
 * RH-15 inside one hunk: removed/added pairs with the same gate key and the
 * same numeric shape whose numbers differ (direction shown in notes), an
 * exact-count assertion relaxed to a bound, and RH-15? for unpaired values.
 */
export function detectRelaxation(h: Hunk): { tags: string[]; notes: string[] } {
  const dels = valueLines(removed(h));
  const adds = valueLines(added(h));
  const tags = new Set<string>();
  const notes: string[] = [];
  for (const d of dels) {
    const a = adds.find((x) => !x.paired && x.key === d.key && x.shape === d.shape);
    if (!a) continue;
    d.paired = true;
    a.paired = true;
    if (d.value === a.value) continue;
    const relaxed = d.relaxes === 'up' ? a.value > d.value : a.value < d.value;
    tags.add('RH-15');
    notes.push(`RH-15: ${d.key} ${d.value} -> ${a.value} (${relaxed ? 'relaxed' : 'tightened'}: ${d.relaxes === 'up' ? 'higher' : 'lower'} relaxes)`);
  }
  for (const d of removed(h)) {
    const m = EXACT_COUNT.exec(d.trim());
    if (!m?.groups) continue;
    const subject = m.groups.subject;
    const a = added(h).find((x) => BOUND.exec(x.trim())?.groups?.subject === subject);
    if (!a) continue;
    tags.add('RH-15');
    notes.push(`RH-15: exact-count assertion relaxed to a bound (${subject.trim()})`);
  }
  for (const v of [...dels, ...adds]) {
    if (v.paired) continue;
    tags.add('RH-15?');
    notes.push(`RH-15?: unpaired gate value ${v.key} = ${v.value}`);
  }
  return { tags: [...tags], notes };
}

/** Conventional snapshot owner: `__snapshots__/<name>.snap` → `<name>` beside it; `<name>.snap` → `<name>` or `<stem>.*` beside it. */
export function snapshotOwnerChanged(path: string, allPaths: ReadonlySet<string>): boolean {
  const norm = path.replace(/\\/g, '/');
  const segs = norm.split('/');
  const base = segs.pop() ?? '';
  const name = base.replace(/\.snap$/i, '');
  const dir = segs.length && segs[segs.length - 1].toLowerCase() === '__snapshots__' ? segs.slice(0, -1) : segs;
  const stem = name.split('.')[0];
  for (const p of allPaths) {
    const ps = p.replace(/\\/g, '/').split('/');
    const pb = ps.pop() ?? '';
    if (ps.join('/') !== dir.join('/')) continue;
    if (pb === name) return true;
    if (!name.includes('.') && pb.startsWith(stem + '.')) return true;
  }
  return false;
}

export function findCitation(lines: string[]): string | null {
  for (const l of lines) {
    if (CITATION_IDIOMS.some((re) => re.test(l))) return l.trim().slice(0, 200);
  }
  return null;
}

export function tagHunk(h: Hunk, ctx: TagContext): TagResult {
  const adds = added(h);
  const dels = removed(h);
  const tags = new Set<string>();
  const notes: string[] = [];
  const nonTest = ctx.floor !== 'test';

  if (ctx.floor === 'snapshot') {
    if (!snapshotOwnerChanged(ctx.path, ctx.allPaths)) tags.add('RH-3');
  } else if (ctx.floor === 'golden') tags.add('RH-3?');
  if (PROSE_FILE.test(ctx.path) || GENERATED_FILE.test(ctx.path)) return { tags: [...tags], notes, citation: null };

  const removedDecls = dels.filter((l) => TEST_DECLARATION.test(l)).length;
  const addedDecls = adds.filter((l) => TEST_DECLARATION.test(l)).length;
  if (removedDecls > addedDecls) {
    tags.add('RH-1');
    notes.push(`RH-1: ${removedDecls - addedDecls} test declaration(s) removed`);
  }
  if (anyMatch(adds, SKIP_IDIOMS) || (ctx.floor === 'test' && anyMatch(adds, SKIP_IDIOMS_TEST_ONLY))) tags.add('RH-1');

  if (nonTest && anyMatch(adds, PLACEHOLDER_IDIOMS)) tags.add('RH-4');
  if (nonTest && anyMatch(adds, ENV_SNIFF_IDIOMS)) tags.add('RH-12');
  if (anyMatch(adds, SUPPRESSION_IDIOMS)) tags.add('RH-13');
  if (anyMatch(adds, BYPASS_IDIOMS)) tags.add('RH-14');
  if (ctx.floor === 'test' || ctx.floor === 'ci' || ctx.floor === 'config') {
    const r = detectRelaxation(h);
    for (const t of r.tags) tags.add(t);
    notes.push(...r.notes);
  }
  if (nonTest && (anyMatch(adds, SWALLOW_SINGLE_LINE) || swallowsAcrossLines(adds))) tags.add('RH-16');

  const sorted = [...tags].sort(compareTags);
  return { tags: sorted, notes, citation: sorted.length ? findCitation(adds) : null };
}

/** RH ids in numeric order; a `?` variant follows its base. */
export function compareTags(a: string, b: string): number {
  const num = (t: string) => Number.parseInt(t.replace(/^RH-/, ''), 10);
  return num(a) - num(b) || a.localeCompare(b);
}
