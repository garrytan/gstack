/**
 * docs-only — the one classifier for a change whose every path is human-facing documentation (R81; docs/pregate.md#docs-only).
 *
 * A docs-only pull request runs the docs lane (link check, generated-page freshness, the credential scan and the tests
 * registered below that read docs by directory) instead of the test suites. Pregate, gstack-ci-carry, land and the CI
 * workflows all call classifyDocsOnly through bin/gstack-docs-only; nothing else decides the class.
 *
 * In gstack most Markdown is agent instructions, so the rule is an allowlist with overrides, never a "*.md" glob. A path
 * is docs only when all of these hold: its mode is a plain file (100644; executables, symlinks, submodules and type
 * changes refuse); it is on the allowlist (root README.md, docs/**.md, changelog.d/*.md, case-sensitive); review-depth's
 * classifyPath calls it docs (agent prose, skill directories, policy and rule docs are code there); it matches no
 * denylist entry (agent-prose names case-insensitively, pinned results, preregistrations, generated outputs); and no
 * tracked file outside human prose names its path (a script, test, workflow or skill that reads it pins it). A rename
 * needs both sides to pass and a deletion needs the old path to pass. Unsure, or any git failure, is never docs-only.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyPath } from './review-depth';
import { matchesAny } from './ship-policy';

export const DOCS_ONLY_ERROR = 'DOCS_ONLY_ERROR';
export const DOCS_ONLY_ANCHOR = 'docs/troubleshooting.md#docs-only-error';

const ALLOW = [/^README\.md$/, /^docs\/(?:[^/]+\/)*[^/]+\.md$/, /^changelog\.d\/[^/]+\.md$/];
const DENY: readonly [RegExp, string][] = [
  [/(?:^|\/)(?:skill|agents|claude|gemini|ethos|crew|captain|factory|driver|checklist|unattended|pregate|lane-card|notes|digest|soul)\.md$/i, 'agent instructions'],
  [/-policy\.md$/i, 'policy doc'],
  [/(?:^|\/)preferences[^/]*$/i, 'preferences'],
  [/(?:^|\/)(?:sections|templates|specialists|skills)\//i, 'agent instructions'],
  [/\.tmpl$/i, 'template'],
  [/^docs\/(?:evals|inventory)\//, 'pinned results'],
  [/prereg/i, 'preregistration'],
  [/^changelog\.d\/README\.md$/i, 'fragment instructions'],
];
const PROSE_REFERENCE = /^(?:CHANGELOG|TODOS)\.md$/;

export interface DiffEntry { status: string; path: string; from?: string; mode: string; oldMode: string }
export interface Refusal { path: string; reason: string }
export interface DocsOnlyResult { docsOnly: boolean; files: string[]; refusals: Refusal[]; tests: string[] }

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

/** Why one path is not human docs, or null when its name and place qualify. */
export function pathRefusal(p: string, root: string, generated: readonly string[] = generatedOutputs(root)): string | null {
  if (!ALLOW.some(r => r.test(p))) return 'not on the docs allowlist (README.md, docs/**.md, changelog.d/*.md)';
  for (const [r, why] of DENY) if (r.test(p)) return why;
  if (classifyPath(p, root) !== 'docs') return 'agent-read prose (review-depth classifyPath)';
  if (generated.length && matchesAny(generated, p)) return 'generated output';
  return null;
}

/** Tracked files outside human prose that name `p` (the caller excludes changed docs). */
export function referencesTo(root: string, p: string, tree?: string): string[] {
  const out = git(root, ['grep', '-l', '-z', '-F', '-I', '-e', p, ...(tree ? [tree] : []), '--'], [0, 1]);
  const prefix = tree ? `${tree}:` : '';
  const gen = generatedOutputs(root);
  return out.split('\0').filter(Boolean).map(f => f.startsWith(prefix) ? f.slice(prefix.length) : f)
    .filter(f => f !== p && !PROSE_REFERENCE.test(f) && pathRefusal(f, root, gen) !== null);
}

/** Classify a parsed diff. `refs` lists the non-docs files naming a path. */
export function classifyEntries(entries: readonly DiffEntry[], root: string, refs: (p: string) => string[]): DocsOnlyResult {
  const refusals: Refusal[] = [];
  const files: string[] = [];
  const gen = generatedOutputs(root);
  const check = (p: string) => {
    const why = pathRefusal(p, root, gen);
    if (why) return why;
    const by = refs(p);
    return by.length ? `named by ${by.slice(0, 3).join(', ')}${by.length > 3 ? ', …' : ''}` : null;
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
  const tests = docsOnly ? [...new Set(DOCS_READER_TESTS.filter(t => files.some(f => t.tree.test(f))).flatMap(t => t.tests))] : [];
  return { docsOnly, files, refusals, tests };
}

/** The whole decision for base..head (commits) or base to the working tree. Throws DocsOnlyError on any git failure. */
export function classifyDocsOnly(o: { root: string; base: string; head?: string }): DocsOnlyResult {
  const entries = readDiff(o.root, o.base, o.head);
  const changed = new Set(entries.flatMap(e => [e.path, ...(e.from ? [e.from] : [])]));
  return classifyEntries(entries, o.root, p => referencesTo(o.root, p, o.head).filter(f => !changed.has(f) || pathRefusal(f, o.root) !== null));
}
