/**
 * banned-terms — words a repository forbids outside named locations (plan
 * E3). `.gstack/banned-terms.json` holds `terms` (plain strings, matched
 * case-insensitively on word boundaries) and `allowed_paths` (repo-relative
 * globs, per term or for every term) where a term may still appear: a
 * glossary, a CHANGELOG, a vendored file. `bin/gstack-banned-terms` scans the
 * lines a diff adds and prints one finding per hit naming the term, the file
 * and line, and the allowed locations. Containment rules are C1's: no `..`,
 * no absolute paths, globs confined to the repository, size caps. A missing
 * file means no check (`none`), never a failure.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ResultCodeName } from './result-codes';
import { assertInsideRoot, containedRelative, globToRegExp, matchesAny } from './ship-policy';

export const BANNED_TERMS_PATH = '.gstack/banned-terms.json';
export const BANNED_TERMS_SCHEMA = 'https://github.com/garrytan/gstack/docs/ship-policy.md#banned-terms';
const MAX_TERMS = 200;
const MAX_TERM = 80;
const MAX_PATHS = 200;

export interface BannedTermRule { term: string; allowed_paths: string[]; reason?: string }
export interface BannedTermsConfig {
  $schema?: string;
  /** A plain string, or an object with its own `allowed_paths` and `reason`. */
  terms: Array<string | BannedTermRule>;
  /** Globs where every term is allowed (a glossary, CHANGELOG.md, vendored code). */
  allowed_paths: string[];
}
export interface BannedTermsError { code: ResultCodeName; path: string; message: string }
export interface BannedTermFinding { term: string; file: string; line: number; text: string; allowed_paths: string[]; reason?: string }
export interface BannedTermsResult { source: string; terms: number; scanned_files: number; findings: BannedTermFinding[]; skipped: string[] }

export function exampleBannedTermsJson(): string {
  return JSON.stringify({
    $schema: BANNED_TERMS_SCHEMA,
    terms: [
      'blazing fast',
      { term: 'legacy-name', allowed_paths: ['CHANGELOG.md', 'docs/migration/**'], reason: 'the product was renamed; the old name belongs to history only' },
    ],
    allowed_paths: ['docs/glossary.md', 'vendor/**'],
  }, null, 2) + '\n';
}

function globError(g: unknown): string | null {
  if (typeof g !== 'string') return 'must be a string';
  const why = containedRelative(g);
  if (why) return why;
  try { globToRegExp(g); } catch (e: any) { return e.message; }
  return null;
}

/** Schema and containment: `terms` a non-empty list, every glob repo-relative. Unknown keys are errors. */
export function validateBannedTerms(raw: unknown): BannedTermsError[] {
  const errors: BannedTermsError[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [{ code: 'BANNED_TERMS_INVALID', path: '', message: 'must be a JSON object' }];
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (!['$schema', 'terms', 'allowed_paths'].includes(key)) errors.push({ code: 'BANNED_TERMS_INVALID', path: key, message: 'unknown key; valid keys: terms, allowed_paths' });
  if (!Array.isArray(obj.terms) || obj.terms.length === 0) errors.push({ code: 'BANNED_TERMS_INVALID', path: 'terms', message: 'must be a non-empty array' });
  else {
    if (obj.terms.length > MAX_TERMS) errors.push({ code: 'BANNED_TERMS_INVALID', path: 'terms', message: `more than ${MAX_TERMS} entries` });
    obj.terms.forEach((t, i) => {
      const at = `terms[${i}]`;
      const term = typeof t === 'string' ? t : (t && typeof t === 'object' && !Array.isArray(t)) ? (t as BannedTermRule).term : undefined;
      if (typeof term !== 'string' || !term.trim()) errors.push({ code: 'BANNED_TERMS_INVALID', path: at, message: 'must be a non-empty string or {term, allowed_paths}' });
      else if (term.length > MAX_TERM) errors.push({ code: 'BANNED_TERMS_INVALID', path: at, message: `longer than ${MAX_TERM} characters` });
      else if (/[\0\r\n]/.test(term)) errors.push({ code: 'BANNED_TERMS_INVALID', path: at, message: 'contains a control character' });
      if (t && typeof t === 'object' && !Array.isArray(t)) {
        const rule = t as Record<string, unknown>;
        for (const key of Object.keys(rule)) if (!['term', 'allowed_paths', 'reason'].includes(key)) errors.push({ code: 'BANNED_TERMS_INVALID', path: `${at}.${key}`, message: 'unknown key; valid keys: term, allowed_paths, reason' });
        if (rule.allowed_paths !== undefined) checkPaths(`${at}.allowed_paths`, rule.allowed_paths, errors);
      }
    });
  }
  if (obj.allowed_paths !== undefined) checkPaths('allowed_paths', obj.allowed_paths, errors);
  return errors;
}

function checkPaths(at: string, value: unknown, errors: BannedTermsError[]): void {
  if (!Array.isArray(value)) { errors.push({ code: 'BANNED_TERMS_INVALID', path: at, message: 'must be an array of globs' }); return; }
  if (value.length > MAX_PATHS) errors.push({ code: 'BANNED_TERMS_INVALID', path: at, message: `more than ${MAX_PATHS} entries` });
  value.forEach((g, i) => { const why = globError(g); if (why) errors.push({ code: 'BANNED_TERMS_INVALID', path: `${at}[${i}]`, message: `${JSON.stringify(g)} ${why}` }); });
}

export function normalizeRules(config: BannedTermsConfig): BannedTermRule[] {
  return config.terms.map(t => typeof t === 'string' ? { term: t, allowed_paths: [...(config.allowed_paths ?? [])] } : { term: t.term, allowed_paths: [...(config.allowed_paths ?? []), ...(t.allowed_paths ?? [])], ...(t.reason ? { reason: t.reason } : {}) });
}

export type ConfigLoad = { config: BannedTermsConfig; source: string } | { config: null; source: string; errors: BannedTermsError[] } | { config: null; source: string; absent: true };

/** The committed copy on `<treeish>` when given (C1's reviewed-base posture), else the working tree. */
export function loadBannedTerms(repoRoot: string, treeish?: string): ConfigLoad {
  let text: string | null = null;
  const source = treeish ? `${treeish}:${BANNED_TERMS_PATH}` : BANNED_TERMS_PATH;
  if (treeish) {
    const r = spawnSync('git', ['show', source], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
    text = r.status === 0 ? r.stdout : null;
  } else {
    const file = path.join(repoRoot, BANNED_TERMS_PATH);
    const escape = assertInsideRoot(repoRoot, BANNED_TERMS_PATH);
    if (escape) return { config: null, source, errors: [{ code: 'BANNED_TERMS_INVALID', path: BANNED_TERMS_PATH, message: escape }] };
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }
  if (text === null) return { config: null, source, absent: true };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e: any) { return { config: null, source, errors: [{ code: 'BANNED_TERMS_INVALID', path: '', message: `not valid JSON: ${e.message}` }] }; }
  const errors = validateBannedTerms(parsed);
  if (errors.length) return { config: null, source, errors };
  return { config: parsed as BannedTermsConfig, source };
}

function termRegExp(term: string): RegExp {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const edge = (s: string) => (/^[A-Za-z0-9_]/.test(s) ? '\\b' : '');
  return new RegExp(`${edge(term.trim())}${escaped}${edge(term.trim().slice(-1))}`, 'i');
}

/** Added lines per file from a unified diff (new-side line numbers). */
export function addedLines(diff: string): Map<string, Array<{ line: number; text: string }>> {
  const out = new Map<string, Array<{ line: number; text: string }>>();
  let file = ''; let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw.slice(4).replace(/^b\//, '').replace(/\t.*$/, ''); if (file === '/dev/null') file = ''; continue; }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git') || raw.startsWith('index ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!file) continue;
    if (raw.startsWith('+')) { (out.get(file) ?? out.set(file, []).get(file)!).push({ line, text: raw.slice(1) }); line += 1; }
    else if (!raw.startsWith('-') && !raw.startsWith('\\')) line += 1;
  }
  return out;
}

/** Scan added lines (or whole files) for each term outside its allowed paths. */
export function scanBannedTerms(config: BannedTermsConfig, source: string, files: Map<string, Array<{ line: number; text: string }>>): BannedTermsResult {
  const rules = normalizeRules(config).map(r => ({ ...r, re: termRegExp(r.term) }));
  const findings: BannedTermFinding[] = [];
  const skipped: string[] = [];
  for (const [file, lines] of files) {
    if (file === BANNED_TERMS_PATH) { skipped.push(file); continue; }
    for (const rule of rules) {
      if (matchesAny(rule.allowed_paths, file)) continue;
      for (const l of lines) if (rule.re.test(l.text)) findings.push({ term: rule.term, file, line: l.line, text: l.text.trim().slice(0, 160), allowed_paths: rule.allowed_paths, ...(rule.reason ? { reason: rule.reason } : {}) });
    }
  }
  return { source, terms: rules.length, scanned_files: files.size, findings, skipped };
}

export function wholeFiles(repoRoot: string, rels: string[]): Map<string, Array<{ line: number; text: string }>> {
  const out = new Map<string, Array<{ line: number; text: string }>>();
  for (const rel of rels) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 1024).includes(0)) continue;
    out.set(rel, buf.toString('utf8').split('\n').map((text, i) => ({ line: i + 1, text })));
  }
  return out;
}

export function renderBannedTerms(r: BannedTermsResult): string {
  const lines = r.findings.map(f => `BANNED_TERM: ${JSON.stringify(f.term)} ${f.file}:${f.line} allowed: ${f.allowed_paths.length ? f.allowed_paths.join(', ') : 'nowhere'}${f.reason ? ` (${f.reason})` : ''} — ${f.text}`);
  lines.push(`BANNED_TERMS: ${r.findings.length ? `found=${r.findings.length}` : 'ok'} terms=${r.terms} files=${r.scanned_files} source=${r.source}`);
  return lines.join('\n') + '\n';
}
