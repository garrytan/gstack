/**
 * Plain-English public record (R76): PR titles, branch names, PR openings,
 * changelog entries and commit subjects say in everyday words what changed for
 * someone using the project. Each repository opts in with
 * `.gstack/plain-titles.json` (docs/ship-policy.md#plain-titles): `codes` are
 * tracker-code regexes, `terms` are the project's own coined words, `allow`
 * entries (each with a reason) suppress a match they contain, `since` exempts
 * PRs created before that date, and `exempt_branch_prefixes` names generated
 * branches. Front for humans, end for machines: one trailing group of
 * references such as `(GST-1713)` or `(#4122)` is never checked. A repository
 * without the file gets no findings. Callers: bin/gstack-plain-title,
 * gstack-post and the "Plain title" CI check.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitAgentNotes } from './agent-notes';
import { maskProse } from './prose-lint';
import { redactFindingSpans } from './redact-engine';

export interface PlainTitlePolicy { codes: string[]; terms: string[]; allow: { text: string; reason: string }[]; since: string; exempt_branch_prefixes: string[] }
export interface PlainFinding { code: 'PLAIN_TITLE_REFUSED' | 'PLAIN_BRANCH_REFUSED' | 'PLAIN_OPENING_REFUSED' | 'PLAIN_CHANGELOG_REFUSED' | 'PLAIN_COMMIT_REFUSED'; kind: 'code' | 'term' | 'scope-prefix' | 'opening-shape'; match: string; hint: string }
export const PLAIN_TITLE_POLICY_PATH = '.gstack/plain-titles.json';

const KEYS = ['$schema', 'codes', 'terms', 'allow', 'since', 'exempt_branch_prefixes'];
const HINTS = {
  code: 'move the tracker code to one trailing group like (ABC-123)',
  PLAIN_BRANCH_REFUSED: 'keep at most one tracker code, at the very end of the branch name',
  PLAIN_OPENING_REFUSED: 'move tracker codes to the end of the PR body',
  PLAIN_CHANGELOG_REFUSED: 'leave tracker codes out of changelog entries',
  term: 'say what it does for someone using the project, in everyday words',
  'scope-prefix': 'drop the type(scope): prefix and start with what changed',
  'opening-shape': 'open with one or two plain sentences: what changed and which goal of the project it serves',
} as const;

type Code = PlainFinding['code'];
type Hit = { kind: 'code' | 'term'; match: string };

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string' && s.trim().length > 0);

/** Reads and validates the policy; null when the repository has no file. Throws an Error naming the bad key. */
export function loadPlainTitlePolicy(repoRoot: string): PlainTitlePolicy | null {
  const file = path.join(repoRoot, PLAIN_TITLE_POLICY_PATH);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new Error(`${PLAIN_TITLE_POLICY_PATH} is not valid JSON: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${PLAIN_TITLE_POLICY_PATH} must be a JSON object`);
  const obj = raw as Record<string, unknown>;
  const bad = (key: string, why: string) => new Error(`${PLAIN_TITLE_POLICY_PATH}: ${key} ${why}`);
  for (const key of Object.keys(obj)) if (!KEYS.includes(key)) throw bad(key, `is not a known key (valid keys: ${KEYS.slice(1).join(', ')})`);
  if (!isStringList(obj.codes)) throw bad('codes', 'must be a list of non-empty regex strings');
  obj.codes.forEach((src, i) => {
    let re: RegExp;
    try { re = new RegExp(src, 'i'); } catch (e: any) { throw bad(`codes[${i}]`, `is not a valid regex: ${e.message}`); }
    if (re.test('')) throw bad(`codes[${i}]`, 'matches empty text');
  });
  if (!isStringList(obj.terms)) throw bad('terms', 'must be a list of non-empty strings');
  const allow = obj.allow ?? [];
  if (!Array.isArray(allow)) throw bad('allow', 'must be a list of { text, reason }');
  allow.forEach((a, i) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad(`allow[${i}]`, 'must be { text, reason }');
    const entry = a as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (key !== 'text' && key !== 'reason') throw bad(`allow[${i}].${key}`, 'is not a known key (valid keys: text, reason)');
    if (typeof entry.text !== 'string' || !entry.text.trim()) throw bad(`allow[${i}].text`, 'must be a non-empty string');
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) throw bad(`allow[${i}].reason`, 'must say why the entry is allowed');
  });
  if (typeof obj.since !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(obj.since) || Number.isNaN(Date.parse(obj.since))) throw bad('since', 'must be a date like 2026-11-08');
  const prefixes = obj.exempt_branch_prefixes ?? [];
  if (!Array.isArray(prefixes) || !prefixes.every(p => typeof p === 'string' && p.length > 0)) throw bad('exempt_branch_prefixes', 'must be a list of non-empty strings');
  return { codes: obj.codes, terms: obj.terms, allow: allow as PlainTitlePolicy['allow'], since: obj.since, exempt_branch_prefixes: prefixes as string[] };
}

/** A whole-word, case-insensitive regex for a term; a space in the term matches any run of spaces. */
function wordRegExp(term: string): RegExp {
  const t = term.trim();
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const edge = (c: string) => (/[A-Za-z0-9_]/.test(c) ? '\\b' : '');
  return new RegExp(`${edge(t[0]!)}${escaped}${edge(t.slice(-1))}`, 'gi');
}

/** Every refused code and term in the text, minus matches an allow entry contains; one hit per distinct match. */
function scan(text: string, policy: PlainTitlePolicy, normalize: (s: string) => string = s => s): Hit[] {
  const allowed = policy.allow.flatMap(a => [...text.matchAll(wordRegExp(normalize(a.text)))].map(m => [m.index!, m.index! + m[0].length] as const));
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const push = (kind: Hit['kind'], m: RegExpMatchArray) => {
    const start = m.index!, end = start + m[0].length;
    if (!m[0] || allowed.some(([s, e]) => s <= start && end <= e)) return;
    const key = `${kind}:${m[0].toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind, match: m[0] });
  };
  for (const src of policy.codes) for (const m of text.matchAll(new RegExp(src, 'gi'))) push('code', m);
  for (const term of policy.terms) for (const m of text.matchAll(wordRegExp(normalize(term)))) push('term', m);
  return hits;
}

/** A match as it may be printed: a credential the title or branch carries is masked before any line shows it, and a match the redactor cannot mask in place prints as a fixed placeholder. */
const shown = (match: string): string => redactFindingSpans(match) ?? '<REDACTED>';

const toFindings = (code: Code, hits: Hit[]): PlainFinding[] => hits.map(h => ({
  code, kind: h.kind, match: shown(h.match),
  hint: h.kind === 'code' && (code === 'PLAIN_BRANCH_REFUSED' || code === 'PLAIN_OPENING_REFUSED' || code === 'PLAIN_CHANGELOG_REFUSED') ? HINTS[code] : HINTS[h.kind],
}));

const REF = /^(?:#\d+|[A-Z][A-Z0-9]{1,9}-\d+|R\d{1,4})$/i;

/** Splits off one trailing "(...)" group made only of references (#123, ABC-123, R76), comma or space separated. */
export function splitTitle(title: string): { front: string; refs: string | null } {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/s.exec(title);
  const refs = m ? m[2]!.split(/[\s,]+/).filter(Boolean) : [];
  if (!m || !refs.length || !refs.every(r => REF.test(r))) return { front: title.trim(), refs: null };
  return { front: m[1]!.trim(), refs: m[2]!.trim() };
}

function titleFindings(title: string, policy: PlainTitlePolicy, code: Code): PlainFinding[] {
  const front = splitTitle(title).front.replace(/^v\d+(?:\.\d+)+\s*/i, '');
  const scope = /^[A-Za-z][\w.-]*\([^()]{0,60}\)!?:/.exec(front);
  return [
    ...(scope ? [{ code, kind: 'scope-prefix' as const, match: shown(scope[0]), hint: HINTS['scope-prefix'] }] : []),
    ...toFindings(code, scan(front, policy)),
  ];
}

/** Refused codes, terms and a leading `word(scope):` prefix in the title's front; the trailing reference group is never checked. */
export function checkTitle(title: string, policy: PlainTitlePolicy | null): PlainFinding[] {
  return policy ? titleFindings(title, policy, 'PLAIN_TITLE_REFUSED') : [];
}

/** Commit subjects follow the title rule under their own code, because CI only warns on them. */
export function checkCommitSubject(subject: string, policy: PlainTitlePolicy | null): PlainFinding[] {
  return policy ? titleFindings(subject, policy, 'PLAIN_COMMIT_REFUSED') : [];
}

/** Generated branches (exempt prefixes) pass; one trailing code segment (`-gst-1713`) is allowed; `-` and `_` separate words. */
export function checkBranch(branch: string, policy: PlainTitlePolicy | null): PlainFinding[] {
  if (!policy || policy.exempt_branch_prefixes.some(p => branch.startsWith(p))) return [];
  const segments = branch.replace(/_/g, '-').split('/').filter(Boolean);
  let last = segments.pop() ?? '';
  for (const src of policy.codes) {
    const m = new RegExp(`(?:^|-)(?:${src})$`, 'i').exec(last);
    if (m) { last = last.slice(0, m.index); break; }
  }
  const rest = [...segments, last].join('/');
  const words = (s: string) => s.replace(/[-_/]+/g, ' ');
  return toFindings('PLAIN_BRANCH_REFUSED', [
    ...scan(rest, { ...policy, terms: [] }),
    ...scan(words(rest), { ...policy, codes: [] }, words),
  ]);
}

function openingShape(line: string): string | null {
  if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) return 'heading';
  if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) return 'fenced block';
  if (/^\s{0,3}([-*+]|\d+[.)])\s/.test(line)) return 'list';
  if (/^\s*\|/.test(line)) return 'table';
  if (/^\s*!\[/.test(line)) return 'image';
  if (/^\s*</.test(line)) return 'HTML';
  return null;
}

/** The readable part (above the Agent notes marker) opens with a prose paragraph of at most two sentences and no refused code or term. */
export function checkOpening(body: string, policy: PlainTitlePolicy | null): PlainFinding[] {
  if (!policy) return [];
  const code: Code = 'PLAIN_OPENING_REFUSED';
  const shapeFinding = (match: string): PlainFinding => ({ code, kind: 'opening-shape', match, hint: HINTS['opening-shape'] });
  const lines = splitAgentNotes(body).readable.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex(l => l.trim() !== '');
  if (start < 0) return [shapeFinding('no opening paragraph')];
  const shape = openingShape(lines[start]!);
  if (shape) return [shapeFinding(`${shape} first`)];
  const end = lines.findIndex((l, i) => i > start && l.trim() === '');
  const paragraph = lines.slice(start, end < 0 ? undefined : end).join(' ')
    .replace(/\]\([^)\s]*\)/g, m => ']' + ' '.repeat(m.length - 1))
    .replace(/https?:\/\/\S+/g, 'URL');
  const sentences = paragraph.replace(/`[^`]*`/g, 'x').replace(/\b(?:e\.g|i\.e|etc|vs)\./gi, 'x')
    .split(/[.!?]+["')\]]*(?:\s+|$)/).filter(s => s.trim()).length;
  return [
    ...(sentences > 2 ? [shapeFinding(`${sentences} sentences`)] : []),
    ...toFindings(code, scan(paragraph.replace(/`/g, ' '), policy)),
  ];
}

/** No tracker code anywhere in the entry; refused terms only in its bold lead. Fenced and inline code, URLs and quoted words are skipped. */
export function checkChangelogEntry(text: string, policy: PlainTitlePolicy | null): PlainFinding[] {
  if (!policy) return [];
  const masked = maskProse(text).masked;
  const lead = /\*\*([^*]+)\*\*/.exec(masked);
  return toFindings('PLAIN_CHANGELOG_REFUSED', [
    ...scan(masked, { ...policy, terms: [] }),
    ...(lead ? scan(lead[1]!, { ...policy, codes: [] }) : []),
  ]);
}
