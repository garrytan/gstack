/**
 * approval-classes — changes a repository says need the owner's approval
 * (field list 2, W2). `.gstack/approval-classes.json`, read only from the
 * committed copy on `origin/<base>` so a branch cannot declare or drop its
 * own classes, lists named classes; each matches changed files by `paths`
 * globs, added lines by literal `patterns`, and the ship policy's
 * `migrations` files when `migrations: true`, minus its `allowed_paths`.
 *
 * Every declared class with hits gets a scope: the sorted effects (a path hit
 * is the file and its blob at the scanned head; a pattern hit is the file and
 * the added line's text) and a digest over them, printed as the token
 * `<class>@<digest12>`. An approval citation binds to that token (or to the
 * class name plus every effect path), so an approval for other work, or one
 * given before an effect was added, does not cover the change
 * (lib/approval-citations.ts). Built-in detectors (the ship policy's
 * migration files when no declared class claims them) only report.
 * Callers: bin/gstack-approval-classes, bin/gstack-ship-receipt.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from './spawn-sync';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { addedLines } from './banned-terms';
import type { ResultCodeName } from './result-codes';
import { assertInsideRoot, containedRelative, globToRegExp, isUnavailable, loadPolicyFromBase, matchesAny } from './ship-policy';

export const APPROVAL_CLASSES_PATH = '.gstack/approval-classes.json';
export const APPROVAL_CLASSES_SCHEMA = 'https://github.com/garrytan/gstack/docs/ship-policy.md#approval-classes';
const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_CLASSES = 32;
const MAX_LIST = 64;
const MAX_PATTERN = 200;
const CLASS_KEYS = ['name', 'description', 'paths', 'patterns', 'allowed_paths', 'migrations'];

export interface ApprovalClass { name: string; description?: string; paths?: string[]; patterns?: string[]; allowed_paths?: string[]; migrations?: boolean }
export interface ApprovalClassesConfig { $schema?: string; classes: ApprovalClass[] }
export interface ApprovalClassesError { code: ResultCodeName; path: string; message: string }
export interface ApprovalHit { class: string; file: string; line: number; via: 'path' | 'pattern' | 'migration'; text: string; declared: boolean; effect: string }
export interface ApprovalScope { class: string; digest: string; token: string; effects: string[]; files: string[]; hits: string[] }
export interface ApprovalScan { source: string; classes: number; hits: ApprovalHit[]; report_only: ApprovalHit[]; scopes: ApprovalScope[] }
export interface MigrationRule { dir: string; id: RegExp }

export function exampleApprovalClassesJson(): string {
  return JSON.stringify({
    $schema: APPROVAL_CLASSES_SCHEMA,
    classes: [
      { name: 'upgrade-data-rewrite', description: 'a migration that rewrites existing rows when a user upgrades', migrations: true },
      { name: 'trust-visibility', description: 'who can see or act on data', paths: ['src/auth/**', 'src/visibility/**'], patterns: ['visibility:'], allowed_paths: ['test/**'] },
      { name: 'data-repair', description: 'a command that rewrites user data; explicit and preview-first, never run at upgrade', paths: ['src/commands/repair/**'] },
      { name: 'default-change', description: 'a default that changes behavior for existing users', patterns: ['DEFAULT_'], allowed_paths: ['test/**', 'docs/**'] },
    ],
  }, null, 2) + '\n';
}

function listErrors(at: string, value: unknown, kind: 'glob' | 'pattern', errors: ApprovalClassesError[]): void {
  if (!Array.isArray(value)) { errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: at, message: `must be an array of ${kind}s` }); return; }
  if (value.length > MAX_LIST) errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: at, message: `more than ${MAX_LIST} entries` });
  value.forEach((v, i) => {
    let why: string | null = null;
    if (typeof v !== 'string' || !v.trim()) why = 'must be a non-empty string';
    else if (kind === 'pattern') why = v.length > MAX_PATTERN ? `longer than ${MAX_PATTERN} characters` : /[\0\r\n]/.test(v) ? 'contains a control character' : null;
    else {
      why = containedRelative(v);
      if (!why) try { globToRegExp(v); } catch (e: any) { why = e.message; }
    }
    if (why) errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: `${at}[${i}]`, message: `${JSON.stringify(v)} ${why}` });
  });
}

function classErrors(c: unknown, at: string, seen: Set<string>, errors: ApprovalClassesError[]): void {
  if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: at, message: 'must be an object' }); return; }
  const cls = c as Record<string, unknown>;
  for (const key of Object.keys(cls)) if (!CLASS_KEYS.includes(key)) errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: `${at}.${key}`, message: `unknown key; valid keys: ${CLASS_KEYS.join(', ')}` });
  if (typeof cls.name !== 'string' || !NAME_RE.test(cls.name)) errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: `${at}.name`, message: 'must be lowercase letters, digits and dashes (1-40 characters, starting with a letter)' });
  else if (seen.has(cls.name)) errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: `${at}.name`, message: `duplicate class ${cls.name}` });
  else seen.add(cls.name);
  if (cls.description !== undefined && (typeof cls.description !== 'string' || cls.description.length > MAX_PATTERN)) errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: `${at}.description`, message: `must be a string of at most ${MAX_PATTERN} characters` });
  if (cls.migrations !== undefined && typeof cls.migrations !== 'boolean') errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: `${at}.migrations`, message: 'must be true or false' });
  if (cls.paths !== undefined) listErrors(`${at}.paths`, cls.paths, 'glob', errors);
  if (cls.allowed_paths !== undefined) listErrors(`${at}.allowed_paths`, cls.allowed_paths, 'glob', errors);
  if (cls.patterns !== undefined) listErrors(`${at}.patterns`, cls.patterns, 'pattern', errors);
  const matches = (Array.isArray(cls.paths) && cls.paths.length > 0) || (Array.isArray(cls.patterns) && cls.patterns.length > 0) || cls.migrations === true;
  if (!matches) errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: at, message: 'matches nothing: give paths, patterns or migrations: true' });
}

/** Schema and containment: a non-empty `classes` list of uniquely named classes, each with something to match. Unknown keys are errors. */
export function validateApprovalClasses(raw: unknown): ApprovalClassesError[] {
  const errors: ApprovalClassesError[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [{ code: 'APPROVAL_CLASSES_INVALID', path: '', message: 'must be a JSON object' }];
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (key !== '$schema' && key !== 'classes') errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: key, message: 'unknown key; valid keys: classes' });
  if (!Array.isArray(obj.classes) || obj.classes.length === 0) return [...errors, { code: 'APPROVAL_CLASSES_INVALID', path: 'classes', message: 'must be a non-empty array' }];
  if (obj.classes.length > MAX_CLASSES) errors.push({ code: 'APPROVAL_CLASSES_INVALID', path: 'classes', message: `more than ${MAX_CLASSES} classes` });
  const seen = new Set<string>();
  obj.classes.forEach((c, i) => classErrors(c, `classes[${i}]`, seen, errors));
  return errors;
}

export type ApprovalLoad =
  | { config: ApprovalClassesConfig; source: string }
  | { config: null; source: string; errors: ApprovalClassesError[] }
  | { config: null; source: string; absent: true }
  | { config: null; source: string; unavailable: string };

function git(repoRoot: string, args: string[], timeout = 30_000): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

function parseConfig(text: string, source: string): ApprovalLoad {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e: any) { return { config: null, source, errors: [{ code: 'APPROVAL_CLASSES_INVALID', path: '', message: `not valid JSON: ${e.message}` }] }; }
  const errors = validateApprovalClasses(parsed);
  return errors.length ? { config: null, source, errors } : { config: parsed as ApprovalClassesConfig, source };
}

/** `origin/<base>` for a branch name; a leading `origin/` is not doubled. */
export function baseRef(base: string): string {
  return `origin/${base.replace(/^origin\//, '')}`;
}

/** The committed copy on `origin/<base>`; never the working tree. An unresolvable base is `unavailable`, never a silent pass. */
export function loadApprovalClasses(repoRoot: string, base: string): ApprovalLoad {
  const ref = baseRef(base);
  const sha = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!sha.ok || !sha.out.trim()) return { config: null, source: `${ref}:${APPROVAL_CLASSES_PATH}`, unavailable: `${ref} is not a resolvable commit` };
  const commit = sha.out.trim();
  const source = `${ref}@${commit.slice(0, 12)}:${APPROVAL_CLASSES_PATH}`;
  if (!git(repoRoot, ['cat-file', '-e', `${commit}:${APPROVAL_CLASSES_PATH}`]).ok) return { config: null, source, absent: true };
  const show = git(repoRoot, ['show', `${commit}:${APPROVAL_CLASSES_PATH}`]);
  return show.ok ? parseConfig(show.out, source) : { config: null, source, errors: [{ code: 'APPROVAL_CLASSES_INVALID', path: '', message: 'unreadable' }] };
}

/** The working-tree file, for `validate` while editing it (enforcement never reads it). */
export function loadWorkingApprovalClasses(repoRoot: string): ApprovalLoad {
  const escape = assertInsideRoot(repoRoot, APPROVAL_CLASSES_PATH);
  if (escape) return { config: null, source: APPROVAL_CLASSES_PATH, errors: [{ code: 'APPROVAL_CLASSES_INVALID', path: APPROVAL_CLASSES_PATH, message: escape }] };
  const file = path.join(repoRoot, APPROVAL_CLASSES_PATH);
  if (!fs.existsSync(file)) return { config: null, source: APPROVAL_CLASSES_PATH, absent: true };
  return parseConfig(fs.readFileSync(file, 'utf8'), APPROVAL_CLASSES_PATH);
}

/** The ship policy's migration rule on the same reviewed base, or null. */
export function baseMigrationRule(repoRoot: string, base: string): MigrationRule | null {
  const load = loadPolicyFromBase(repoRoot, base);
  if (isUnavailable(load) || load.errors.length || !load.policy.migrations) return null;
  return { dir: load.policy.migrations.dir.replace(/\/+$/, ''), id: new RegExp(load.policy.migrations.id) };
}

export interface ChangedFile { file: string; status: string; blob: string; added: Array<{ line: number; text: string }> }

/** Native, unquoted git diff output: no external diff driver and no textconv, whatever the repository's config says. */
const NATIVE_DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];

/**
 * Files changed between `diffBase` and `head` (the working tree when `head` is omitted), with added lines and blob ids.
 * Fails closed (`unreadable`) when the content diff cannot be read or its added lines disagree with git's numstat count.
 */
export function changedFiles(repoRoot: string, diffBase: string, head?: string): ChangedFile[] | { error: string; unreadable: true } {
  const range = head ? [diffBase, head] : [diffBase];
  const names = git(repoRoot, [...NATIVE_DIFF, '--name-status', '-z', ...range], 120_000);
  const counts = git(repoRoot, [...NATIVE_DIFF, '--numstat', '-z', ...range], 120_000);
  const diff = git(repoRoot, [...NATIVE_DIFF, '--unified=0', ...range], 120_000);
  if (!names.ok || !counts.ok || !diff.ok) return { error: `git diff ${range.join(' ')} failed; the content diff could not be read`, unreadable: true };
  const added = addedLines(diff.out);
  for (const entry of counts.out.split('\0').filter(Boolean)) {
    const [n, , file] = entry.split('\t');
    if (!file || n === '-') continue;
    const got = added.get(file)?.length ?? 0;
    if (got !== Number(n)) return { error: `the content diff for ${file} shows ${got} added line(s) but git counts ${n}; the content diff could not be read`, unreadable: true };
  }
  const parts = names.out.split('\0').filter(Boolean);
  const out: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!.slice(0, 1);
    const file = parts[i + 1]!;
    let blob = 'deleted';
    if (status !== 'D') {
      const r = head ? git(repoRoot, ['rev-parse', `${head}:${file}`]) : git(repoRoot, ['hash-object', '--', file]);
      blob = r.ok ? r.out.trim() : 'unreadable';
    }
    out.push({ file, status, blob, added: added.get(file) ?? [] });
  }
  return out;
}

function isMigration(rule: MigrationRule | null, file: string): boolean {
  return !!rule && file.startsWith(`${rule.dir}/`) && rule.id.test(path.posix.basename(file));
}

const STATUS_WORD: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', T: 'type changed' };

function classHits(cls: ApprovalClass, files: ChangedFile[], migrations: MigrationRule | null): ApprovalHit[] {
  const hits: ApprovalHit[] = [];
  const pathRes = (cls.paths ?? []).map(globToRegExp);
  for (const f of files) {
    if (f.file === APPROVAL_CLASSES_PATH || matchesAny(cls.allowed_paths ?? [], f.file)) continue;
    const byMigration = cls.migrations === true && isMigration(migrations, f.file);
    if (byMigration || pathRes.some(re => re.test(f.file))) {
      hits.push({ class: cls.name, file: f.file, line: f.added[0]?.line ?? 1, via: byMigration ? 'migration' : 'path', text: STATUS_WORD[f.status] ?? f.status, declared: true, effect: `path\0${f.file}\0${f.blob}` });
    }
    for (const pattern of cls.patterns ?? []) for (const l of f.added) {
      if (l.text.includes(pattern)) hits.push({ class: cls.name, file: f.file, line: l.line, via: 'pattern', text: l.text.trim().slice(0, 160), declared: true, effect: `line\0${f.file}\0${l.text.trim()}` });
    }
  }
  return hits;
}

/** The scope token binds a citation to these exact effects: any added, removed or edited effect changes the digest. */
export function scopeOf(name: string, hits: ApprovalHit[]): ApprovalScope {
  const effects = [...new Set(hits.map(h => h.effect))].sort();
  const digest = createHash('sha256').update(`${name}\n${effects.join('\n')}`).digest('hex');
  return { class: name, digest, token: `${name}@${digest.slice(0, 12)}`, effects, files: [...new Set(hits.map(h => h.file))].sort(), hits: hits.map(h => `${h.file}:${h.line}`) };
}

/** Declared hits, report-only built-in hits, and one scope per declared class with hits. */
export function scanApprovalClasses(config: ApprovalClassesConfig | null, source: string, files: ChangedFile[], migrations: MigrationRule | null): ApprovalScan {
  const classes = config?.classes ?? [];
  const hits = classes.flatMap(cls => classHits(cls, files, migrations));
  const claimsMigrations = classes.some(c => c.migrations === true);
  const report_only: ApprovalHit[] = claimsMigrations ? [] : files.filter(f => isMigration(migrations, f.file)).map(f => ({
    class: 'migrations', file: f.file, line: f.added[0]?.line ?? 1, via: 'migration' as const, text: STATUS_WORD[f.status] ?? f.status, declared: false, effect: `path\0${f.file}\0${f.blob}`,
  }));
  const scopes = classes.map(cls => hits.filter(h => h.class === cls.name)).filter(own => own.length).map(own => scopeOf(own[0]!.class, own));
  return { source, classes: classes.length, hits, report_only, scopes };
}

export interface ScanRequest { repoRoot: string; base: string; head?: string; diffBase?: string }
export type ScanOutcome =
  | { scan: ApprovalScan; absent: boolean }
  | { errors: ApprovalClassesError[]; source: string }
  | { unavailable: string; source: string }
  | { error: string; unreadable?: true };

/** Load the base's classes and migration rule, diff since the merge base, scan. Skips the diff when nothing could match. */
export function runApprovalScan(req: ScanRequest): ScanOutcome {
  const load = loadApprovalClasses(req.repoRoot, req.base);
  if ('unavailable' in load) return { unavailable: load.unavailable, source: load.source };
  if ('errors' in load) return { errors: load.errors, source: load.source };
  const migrations = baseMigrationRule(req.repoRoot, req.base);
  const absent = 'absent' in load;
  if (absent && !migrations) return { scan: scanApprovalClasses(null, load.source, [], null), absent };
  const mergeBase = req.diffBase ? undefined : git(req.repoRoot, ['merge-base', baseRef(req.base), req.head ?? 'HEAD']);
  const diffBase = req.diffBase ?? (mergeBase?.ok ? mergeBase.out.trim() : undefined);
  if (!diffBase) return { error: `no merge base between ${baseRef(req.base)} and ${req.head ?? 'HEAD'}; pass --diff-base <sha>` };
  const files = changedFiles(req.repoRoot, diffBase, req.head);
  if ('error' in files) return files;
  return { scan: scanApprovalClasses(load.config, load.source, files, migrations), absent };
}

export const CITATION_TEMPLATE = 'Approved by <owner> <YYYY-MM-DD> via <plan sha|comment or review URL|ref>';

export function renderApprovalScan(scan: ApprovalScan, absent: boolean): string {
  const lines = [
    ...scan.hits.map(h => `APPROVAL_CLASS: ${h.class} ${h.file}:${h.line} (${h.via}) — ${h.text}`),
    ...scan.report_only.map(h => `APPROVAL_CLASS: ${h.class} ${h.file}:${h.line} (built-in, report-only) — ${h.text}`),
    ...scan.scopes.map(s => `APPROVAL_SCOPE: ${s.token} effects=${s.effects.length} files=${s.files.join(',')}; cite: ${CITATION_TEMPLATE} for ${s.token}`),
  ];
  const summary = absent ? `none (no ${APPROVAL_CLASSES_PATH} on the base)` : scan.hits.length ? `found=${scan.hits.length}` : 'ok';
  lines.push(`APPROVAL_CLASSES: ${summary} classes=${scan.classes} report_only=${scan.report_only.length} source=${scan.source}`);
  return lines.join('\n') + '\n';
}
