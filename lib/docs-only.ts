/**
 * docs-only — the one classifier for a change whose every path is human-facing documentation (R81; docs/pregate.md#docs-only).
 *
 * A docs-only pull request runs the docs lane (link check, generated-page freshness, the credential scan and the tests
 * registered below that read docs by directory) instead of the test suites. Pregate, gstack-ci-carry, land and the CI
 * workflows all call classifyDocsOnly through bin/gstack-docs-only; nothing else decides the class.
 *
 * In gstack most Markdown is agent instructions, so the rule is an allowlist with overrides, never a "*.md" glob. A path
 * is docs only when all of these hold: its mode is a plain file (100644; executables, symlinks, submodules and type
 * changes refuse); it is on the allowlist (root README.md, docs/**.md, changelog.d/*.md, case-sensitive, plus the
 * base revision's .gstack/ship-policy.json docs_only.allow, never the head's); review-depth's classifyPath calls it docs
 * (agent prose, skill directories, policy and rule docs are code there); it matches no built-in denylist entry
 * (lib/ship-policy-docs-only.ts: agent-prose names case-insensitively, prompts, tool configuration, pinned results,
 * preregistrations), no generated output and no docs_only.deny glob; and no tracked file outside human prose names its
 * path (a script, test, workflow or skill that reads it pins it). A rename needs both sides to pass and a deletion needs
 * the old path to pass. Unsure, an unreadable base policy, or any git failure, is never docs-only.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyPath } from './review-depth';
import { matchesAny, SHIP_POLICY_PATH } from './ship-policy';
import { CODE_DIRS, DOCS_ONLY_DENY, DOCS_ONLY_KEYS, docsOnlyPolicyErrors } from './ship-policy-docs-only';

export const DOCS_ONLY_ERROR = 'DOCS_ONLY_ERROR';
export const DOCS_ONLY_ANCHOR = 'docs/troubleshooting.md#docs-only-error';

const ALLOW = [/^README\.md$/, /^docs\/(?:[^/]+\/)*[^/]+\.md$/, /^changelog\.d\/[^/]+\.md$/];
const PROSE_REFERENCE = /^(?:CHANGELOG|TODOS)\.md$/;
const PROSE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;

export interface DiffEntry { status: string; path: string; from?: string; mode: string; oldMode: string }
export interface Refusal { path: string; reason: string }
export interface DocsOnlyResult { docsOnly: boolean; files: string[]; refusals: Refusal[]; tests: string[] }
/** The base revision's docs_only block (`label` names where it came from); `ignored` names unknown keys that dropped its allow list. */
export interface RepoDocs { allow: readonly string[]; deny: readonly string[]; tests: readonly string[]; label: string; ignored?: string }
const NO_REPO_DOCS: RepoDocs = { allow: [], deny: [], tests: [], label: '' };
const builtIn = (p: string) => ALLOW.some(r => r.test(p));

/**
 * Tests that read docs by directory or every tracked file, so a literal-path reference scan cannot see them. The docs
 * lane runs the ones whose tree the change touches. test/docs-only.test.ts fails on a new repo-wide or docs-tree reader
 * that is in neither list.
 */
export const DOCS_READER_TESTS: readonly { tree: RegExp; tests: readonly string[] }[] = [
  { tree: /^docs\//, tests: ['test/docs-config-keys.test.ts'] },
  { tree: /^(?:docs\/|README\.md$)/, tests: ['test/no-stale-gstack-brain-refs.test.ts'] },
  { tree: /./, tests: ['test/bun-entry-isolation.test.ts', 'test/gitattributes-eol.test.ts', 'test/ci-paid-coordination.test.ts', 'test/review-packets-removed.test.ts', 'test/state-root-ratchet.test.ts', 'test/codex-web-search-flag.test.ts'] },
];
/** Repo-wide listers that never read an allowlisted doc, with the reason. */
export const DOCS_READER_EXEMPT: Readonly<Record<string, string>> = {
  'test/bash32-case-in-substitution.test.ts': 'skips .md files',
  'test/branch-slug-hygiene.test.ts': 'lists SKILL.md and sections only',
  'test/cso-cli.test.ts': 'lists a fixture repository',
  'test/free-fixtures.test.ts': 'reads test/fixtures only',
  'test/helpers/docsync-repo.ts': 'lists a fixture repository',
};

export class DocsOnlyError extends Error {
  constructor(readonly command: string, readonly detail: string, readonly fix: string) { super(`${command}: ${detail}`); }
}

function git(root: string, args: string[], okCodes = [0]): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status === null || !okCodes.includes(r.status)) {
    const detail = (r.error?.message ?? r.stderr ?? '').trim().split('\n')[0] || `exit ${r.status}`;
    throw new DocsOnlyError(`git ${args.join(' ')}`, detail, /bad revision|unknown revision|no merge base|ambiguous argument/i.test(detail)
      ? 'fetch both commits (actions/checkout fetch-depth: 2 on the merge ref, or git fetch origin <base>)' : 'rerun in a git checkout of this repository');
  }
  return r.stdout;
}

/** Parse `git diff --raw -z -M` output. */
export function parseRaw(raw: string): DiffEntry[] {
  const parts = raw.split('\0');
  const out: DiffEntry[] = [];
  for (let i = 0; i < parts.length - 1;) {
    const head = parts[i++]!;
    if (!head.startsWith(':')) continue;
    const [oldMode, mode, , , status] = head.slice(1).split(' ');
    const s = status ?? '';
    if (/^[RC]/.test(s)) out.push({ status: s[0]!, from: parts[i++]!, path: parts[i++]!, mode: mode!, oldMode: oldMode! });
    else out.push({ status: s[0] ?? '?', path: parts[i++]!, mode: mode!, oldMode: oldMode! });
  }
  return out;
}

function untracked(root: string): DiffEntry[] {
  return git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean).map(p => {
    const st = fs.lstatSync(path.join(root, p));
    const mode = st.isSymbolicLink() ? '120000' : st.mode & 0o111 ? '100755' : '100644';
    return { status: 'A', path: p, mode, oldMode: '000000' };
  });
}

/** The changed paths: base..head between commits, or the merge base of base and HEAD to the working tree (tracked and untracked) when head is omitted. */
export function readDiff(root: string, base: string, head?: string): DiffEntry[] {
  if (head) return parseRaw(git(root, ['diff', '--raw', '-z', '-M', '--no-ext-diff', base, head, '--']));
  const mb = git(root, ['merge-base', base, 'HEAD']).trim();
  return [...parseRaw(git(root, ['diff', '--raw', '-z', '-M', '--no-ext-diff', mb, '--'])), ...untracked(root)];
}

function generatedOutputs(root: string): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, '.gstack', 'generated.json'), 'utf8'));
    return (j.entries ?? []).flatMap((e: { outputs?: string[] }) => e.outputs ?? []);
  } catch { return []; }
}

/**
 * The base revision's docs_only block (docs/pregate.md#repo-docs-paths), read with git from `base`, never the working
 * tree or the head. No policy file or no block adds nothing; invalid JSON or an invalid block is `{ error }`, which fails
 * the whole change closed; an unknown key keeps deny and drops allow. Throws DocsOnlyError when git cannot read `base`.
 */
export function readRepoDocs(root: string, base: string): RepoDocs | { error: string } {
  const label = `${base}:${SHIP_POLICY_PATH}`;
  if (!git(root, ['ls-tree', '--name-only', base, '--', SHIP_POLICY_PATH]).trim()) return NO_REPO_DOCS;
  const text = git(root, ['show', `${base}:${SHIP_POLICY_PATH}`]);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { error: `${label} is not valid JSON (${(e as Error).message}), so its docs_only block cannot be read` }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} is not a JSON object` };
  const block = (raw as Record<string, unknown>).docs_only;
  if (block === undefined || block === null) return NO_REPO_DOCS;
  const errors = docsOnlyPolicyErrors(block);
  if (errors.length) return { error: `${label} has an invalid docs_only block: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}` };
  const d = block as { allow: string[]; deny?: string[]; tests?: string[] };
  const unknown = Object.keys(d).filter(k => !DOCS_ONLY_KEYS.includes(k));
  if (unknown.length) return { allow: [], deny: d.deny ?? [], tests: [], label, ignored: unknown.map(k => `docs_only.${k}`).join(', ') };
  return { allow: d.allow, deny: d.deny ?? [], tests: d.tests ?? [], label };
}

/** Why one path is not human docs, or null when its name and place qualify. */
export function pathRefusal(p: string, root: string, generated: readonly string[] = generatedOutputs(root), repo: RepoDocs = NO_REPO_DOCS): string | null {
  const repoOnly = !builtIn(p);
  if (repoOnly && !(repo.allow.length && matchesAny(repo.allow, p))) {
    const extra = repo.allow.length ? `, ${repo.allow.join(', ')} from ${repo.label}` : repo.ignored ? `; ${repo.label}'s allow is ignored while it has unknown key ${repo.ignored}` : '';
    return `not on the docs allowlist (README.md, docs/**.md, changelog.d/*.md${extra})`;
  }
  for (const [r, why] of DOCS_ONLY_DENY) if (r.test(p)) return why;
  if (repo.deny.length && matchesAny(repo.deny, p)) return `matches docs_only.deny in ${repo.label}`;
  const codeDir = repoOnly ? p.split('/').slice(0, -1).find(s => CODE_DIRS.has(s.toLowerCase())) : undefined;
  if (codeDir) return `passes through ${codeDir}/, which holds code, tests or agent instructions`;
  if (classifyPath(p, root) !== 'docs') return 'agent-read prose (review-depth classifyPath)';
  if (generated.length && matchesAny(generated, p)) return 'generated output';
  return null;
}

/** Tracked files (at `tree`, else the working tree), limited to `within` when given, that contain any of `needles`. */
function grepFiles(root: string, needles: readonly string[], tree?: string, within: readonly string[] = []): string[] {
  const out = git(root, ['grep', '-l', '-z', '-F', '-I', ...needles.flatMap(n => ['-e', n]), ...(tree ? [tree] : []), '--', ...within], [0, 1]);
  const prefix = tree ? `${tree}:` : '';
  return out.split('\0').filter(Boolean).map(f => f.startsWith(prefix) ? f.slice(prefix.length) : f);
}

/** Tracked files outside human prose that name `p` (the caller excludes changed docs). */
export function referencesTo(root: string, p: string, tree?: string, repo: RepoDocs = NO_REPO_DOCS): string[] {
  const gen = generatedOutputs(root);
  return grepFiles(root, [p], tree).filter(f => f !== p && !PROSE_REFERENCE.test(f) && pathRefusal(f, root, gen, repo) !== null);
}

/**
 * Non-docs tracked files that name a directory holding the repo-admitted path `p` ("wiki/", 'wiki', './wiki', root + '/wiki') and are tied to
 * none of the repository's docs_only.tests: a script that lists a directory reads every post in it, which the literal
 * scan in referencesTo cannot see. A reader is tied when it is a declared test, names one, or one names it (with or
 * without its extension). Prose files are not readers here: one that names a path pins it through referencesTo, and one
 * that names a directory describes it. Built-in paths return none; their directory readers are DOCS_READER_TESTS.
 */
export function directoryReaders(root: string, p: string, repo: RepoDocs, tree?: string): string[] {
  if (builtIn(p) || !repo.allow.length) return [];
  const segs = p.split('/').slice(0, -1);
  if (!segs.length) return [];
  const dirs = segs.map((_, i) => segs.slice(0, i + 1).join('/'));
  const gen = generatedOutputs(root);
  const readers = grepFiles(root, dirs.flatMap(d => [`${d}/`, ...[`'`, `"`, '`'].flatMap(q => [`${q}${d}${q}`, `./${d}${q}`, `${q}/${d}${q}`, `}/${d}${q}`])]), tree)
    .filter(f => f !== SHIP_POLICY_PATH && !PROSE.test(f) && !repo.tests.includes(f) && pathRefusal(f, root, gen, repo) !== null);
  if (!readers.length || !repo.tests.length) return readers;
  return readers.filter(f => !grepFiles(root, repo.tests, tree, [f]).length && !grepFiles(root, [f, f.replace(/\.[^./]+$/, '')], tree, repo.tests).length);
}

/** Classify a parsed diff. `refs` lists the non-docs files naming a path. */
export function classifyEntries(entries: readonly DiffEntry[], root: string, refs: (p: string) => string[], repo: RepoDocs = NO_REPO_DOCS, readers: (p: string) => string[] = () => []): DocsOnlyResult {
  const refusals: Refusal[] = [];
  const files: string[] = [];
  const gen = generatedOutputs(root);
  const check = (p: string) => {
    const why = pathRefusal(p, root, gen, repo);
    if (why) return why;
    const list = (xs: string[]) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ', …' : ''}`;
    const by = refs(p);
    if (by.length) return `named by ${list(by)}`;
    const rd = readers(p);
    return rd.length ? `its directory is read by ${list(rd)}; list a test that covers it in docs_only.tests at ${repo.label}` : null;
  };
  for (const e of entries) {
    files.push(e.path);
    const mode = e.status === 'D' ? e.oldMode : e.mode;
    let why: string | null = null;
    if (!['A', 'M', 'D', 'R', 'C'].includes(e.status)) why = `change type ${e.status}`;
    else if (mode !== '100644' || (e.status !== 'A' && e.status !== 'D' && e.oldMode !== '100644' && e.oldMode !== '000000')) why = `mode ${e.oldMode}->${e.mode}`;
    else if (e.from) why = check(e.from) ?? check(e.path);
    else why = check(e.path);
    if (why) refusals.push({ path: e.path, reason: why });
  }
  if (!entries.length) refusals.push({ path: '-', reason: 'no changed paths' });
  const docsOnly = refusals.length === 0;
  const repoTests = entries.some(e => !builtIn(e.path) || (e.from !== undefined && !builtIn(e.from))) ? repo.tests : [];
  const tests = docsOnly ? [...new Set([...DOCS_READER_TESTS.filter(t => files.some(f => t.tree.test(f))).flatMap(t => t.tests), ...repoTests])] : [];
  return { docsOnly, files, refusals, tests };
}

/**
 * The whole decision for base..head (commits) or base to the working tree. The docs_only block is read at `policyRef`,
 * the base tip every consumer lands on (default `base`; ci-carry and land diff from the merge base but read the tip).
 * A docs_only.tests file the classified tree lacks refuses the change: the docs lane would otherwise pass without it.
 * Throws DocsOnlyError on any git failure.
 */
export function classifyDocsOnly(o: { root: string; base: string; head?: string; policyRef?: string }): DocsOnlyResult {
  const entries = readDiff(o.root, o.base, o.head);
  const policy = readRepoDocs(o.root, o.policyRef ?? o.base);
  const repo = 'error' in policy ? NO_REPO_DOCS : policy;
  const changed = new Set(entries.flatMap(e => [e.path, ...(e.from ? [e.from] : [])]));
  const outside = (f: string) => !changed.has(f) || pathRefusal(f, o.root, undefined, repo) !== null;
  const r = classifyEntries(entries, o.root, p => referencesTo(o.root, p, o.head, repo).filter(outside), repo, p => directoryReaders(o.root, p, repo, o.head).filter(outside));
  if ('error' in policy) return { ...r, docsOnly: false, tests: [], refusals: [{ path: SHIP_POLICY_PATH, reason: policy.error }, ...r.refusals] };
  const missing = r.tests.filter(t => repo.tests.includes(t) && (o.head ? !git(o.root, ['ls-tree', '--name-only', o.head, '--', t]).trim() : !fs.existsSync(path.join(o.root, t))));
  return missing.length ? { ...r, docsOnly: false, tests: [], refusals: missing.map(t => ({ path: t, reason: `listed in docs_only.tests at ${repo.label} but missing from this tree; restore it or correct the list` })) } : r;
}
