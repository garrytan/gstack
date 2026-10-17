/**
 * pregate/import-graph — which test files depend on which repo files (plan
 * C8 `lanes`). The reverse graph unions four sources, each kept as provenance
 * for `--explain`:
 *   1. static imports and requires (Bun.Transpiler.scanImports), and Python
 *      `import` / `from … import` statements resolved from the repository root
 *      or, when relative, from the importing file's package;
 *   2. repo-path string literals, including `join('a', 'b')` segment runs
 *      (a test that spawns `bin/gstack-doctor` names it in a string, never an
 *      import) and literal directories (`test/fixtures/x` → `x/**`), and in
 *      Python, dotted `mock.patch` targets (`'pkg.mod.Class.method'`);
 *   3. the `bin/<name>` → `test/<name>*.test.*` convention (with and without
 *      the `gstack-` prefix);
 *   4. explicit `.gstack/pregate.json` `dependencies` declarations.
 * Uncertainty selects more tests, never fewer: a dependency on a directory
 * selects every test under it; a touched file with no path to a test is the
 * caller's `no lane` failure, not a pass. test/helpers/touchfile-closure.ts
 * (helpers and fixtures only, a lower bound by its own words) is the precedent.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchesAny } from '../ship-policy';

export const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|rb|sh|bash|go|rs)$/;
export const TEST_FILE_RE = /(?:^|\/)(?:test|tests|spec|__tests__)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go|rb)$|_spec\.rb$|(?:^|\/)[^/]*\.bats$/;

export interface Edge { from: string; via: 'import' | 'literal' | 'convention' | 'declared' | 'generated' }
export interface Graph {
  files: Set<string>;
  tests: Set<string>;
  /** dependency → dependents with the kind of edge. */
  reverse: Map<string, Edge[]>;
  /** Test file → import specifiers that looked like repo paths but resolved nowhere (for the no-lane explanation). */
  unresolved?: Map<string, string[]>;
  /** tsconfig/jsconfig `extends` hops that were not followed (for the no-lane explanation). */
  aliasNotes?: string[];
}

const scanner = new Bun.Transpiler({ loader: 'tsx' });
// `( ) [ ] +` appear in framework route paths: Next.js route groups `(app)`,
// dynamic segments `[id]` / `[[...slug]]`, SvelteKit `+page.svelte`. A literal
// that matches more text only gains an edge when it resolves to a repo file.
const QUOTED = /['"`]([A-Za-z0-9_@][A-Za-z0-9_./@()[\]+-]*)['"`]/g;
const JOIN = /\bjoin\(([^()]*)\)/g;
const RESOLVE_EXT = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'];
// A statement starts a line or follows `;` or a compound statement's `:`. The module spec is
// non-empty and starts with a dot or a word character, so no two repetitions can share a dot or a space.
const PY_IMPORT = /(?:^|[;:])[ \t\f]*(?:from[ \t]+(\.+(?:\w[\w.]*)?|\w[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]+)|import[ \t]+([^\n;]+))/gm;
const PY_DOTTED = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/;

export function isTestFile(rel: string): boolean { return TEST_FILE_RE.test(rel); }

export function listRepoFiles(repoRoot: string): string[] {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? '').split('\0').filter(p => p && !p.startsWith('node_modules/'));
}

function normalize(p: string): string { return path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, ''); }

/** One tsconfig/jsconfig `compilerOptions.paths` entry: `@/*` → [`./*`], already joined to its base. */
export interface PathAlias { prefix: string; suffix: string; wildcard: boolean; targets: string[] }
/** The effective `paths` of the root config, its `baseUrl` (repo-relative, or null) and what could not be read. */
export interface PathAliases { aliases: PathAlias[]; baseUrl: string | null; notes: string[] }

/** How many relative `extends` hops are followed from the root tsconfig/jsconfig. */
export const MAX_TSCONFIG_EXTENDS = 4;

/** JSONC → JSON: drop comments, and a comma whose next token closes an object or array, outside strings. */
function stripJsonc(text: string): string {
  const skipTrivia = (from: number): number => {
    let j = from;
    while (j < text.length) {
      if (/\s/.test(text[j]!)) { j++; continue; }
      if (text.startsWith('//', j)) { const e = text.indexOf('\n', j); j = e < 0 ? text.length : e; continue; }
      if (text.startsWith('/*', j)) { const e = text.indexOf('*/', j + 2); j = e < 0 ? text.length : e + 2; continue; }
      break;
    }
    return j;
  };
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') { const end = /"(?:[^"\\]|\\.)*"/y; end.lastIndex = i; const m = end.exec(text); const s = m ? m[0] : text.slice(i); out += s; i += s.length - 1; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (c === ',' && (text[skipTrivia(i + 1)] === '}' || text[skipTrivia(i + 1)] === ']')) continue;
    out += c;
  }
  return out;
}

interface Located<T> { value: T; dir: string }
interface ConfigOptions { baseUrl?: Located<string>; paths?: Located<Record<string, unknown>> }

/** `baseUrl` and `paths` of one config after its relative `extends` chain (later entries and the config itself override). */
function effectiveOptions(repoRoot: string, rel: string, depth: number, seen: Set<string>, notes: string[]): ConfigOptions | null {
  let json: { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
  try { json = JSON.parse(stripJsonc(fs.readFileSync(path.join(repoRoot, rel), 'utf8'))) ?? {}; } catch { return null; }
  const dir = path.posix.dirname(rel);
  let options: ConfigOptions = {};
  const parents = typeof json.extends === 'string' ? [json.extends] : Array.isArray(json.extends) ? json.extends.filter((e): e is string => typeof e === 'string') : [];
  for (const parent of parents) {
    if (!parent.startsWith('./') && !parent.startsWith('../')) { notes.push(`${rel} extends ${parent}: not a relative path, not followed`); continue; }
    if (depth >= MAX_TSCONFIG_EXTENDS) { notes.push(`${rel} extends ${parent}: not followed (tsconfig extends depth limit ${MAX_TSCONFIG_EXTENDS})`); continue; }
    let target = normalize(path.posix.join(dir, parent));
    if (!target.endsWith('.json') && !fs.existsSync(path.join(repoRoot, target))) target += '.json';
    if (target.startsWith('../') || seen.has(target)) { notes.push(`${rel} extends ${parent}: outside the repo or a cycle, not followed`); continue; }
    const inherited = effectiveOptions(repoRoot, target, depth + 1, new Set([...seen, target]), notes);
    if (inherited) options = { ...options, ...inherited };
    else notes.push(`${rel} extends ${parent}: unreadable`);
  }
  const own = json.compilerOptions ?? {};
  if (typeof own.baseUrl === 'string') options.baseUrl = { value: own.baseUrl, dir };
  if (own.paths && typeof own.paths === 'object') options.paths = { value: own.paths as Record<string, unknown>, dir };
  return options;
}

/**
 * The root tsconfig.json (else jsconfig.json) `paths`, relative to the repo,
 * following relative `extends` up to MAX_TSCONFIG_EXTENDS hops. Targets join
 * `baseUrl` when one is set, else the directory of the config declaring
 * `paths`. What is not followed is recorded in `notes` for the no-lane
 * explanation; a missing alias leaves no edge (so `no lane`), never a wrong one.
 */
export function readPathAliases(repoRoot: string): PathAliases {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const notes: string[] = [];
    const options = effectiveOptions(repoRoot, name, 0, new Set([name]), notes);
    if (!options) continue;
    const baseUrl = options.baseUrl ? normalize(path.posix.join(options.baseUrl.dir, options.baseUrl.value)) : null;
    const base = baseUrl ?? options.paths?.dir ?? '.';
    const aliases: PathAlias[] = [];
    for (const [pattern, targets] of Object.entries(options.paths?.value ?? {})) {
      if (!Array.isArray(targets)) continue;
      const star = pattern.indexOf('*');
      const resolved = targets.filter((t): t is string => typeof t === 'string').map(t => normalize(path.posix.join(base, t)));
      aliases.push(star < 0 ? { prefix: pattern, suffix: '', wildcard: false, targets: resolved } : { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), wildcard: true, targets: resolved });
    }
    return { aliases, baseUrl, notes };
  }
  return { aliases: [], baseUrl: null, notes: [] };
}

const NO_ALIASES: PathAliases = { aliases: [], baseUrl: null, notes: [] };

/**
 * TypeScript's pattern choice: an exact pattern, else the matching wildcard
 * with the longest prefix. `chosen` is that pattern's expanded targets in
 * order; `others` are the other matching patterns' targets.
 */
function matchAliases(aliases: readonly PathAlias[], ref: string): { chosen: string[] | null; others: string[] } {
  const expand = (a: PathAlias) => a.wildcard ? a.targets.map(t => normalize(t.replace('*', ref.slice(a.prefix.length, ref.length - a.suffix.length)))) : a.targets;
  const matching = aliases.filter(a => a.wildcard ? ref.startsWith(a.prefix) && ref.endsWith(a.suffix) && ref.length >= a.prefix.length + a.suffix.length : ref === a.prefix);
  if (matching.length === 0) return { chosen: null, others: [] };
  const best = matching.find(a => !a.wildcard) ?? matching.reduce((a, b) => (b.prefix.length > a.prefix.length ? b : a));
  return { chosen: expand(best), others: matching.filter(a => a !== best).flatMap(expand) };
}

/** One candidate repo path → the file it names (trying extensions), `dir/**`, a bare bin, or null. */
function resolveCandidate(files: Set<string>, dirs: Set<string>, c: string, literal: boolean): string | null {
  if (c.startsWith('../') || c === '..' || c === '.' || c === '') return null;
  for (const ext of RESOLVE_EXT) if (files.has(c + ext)) return c + ext;
  // A directory literal needs two segments (`test/fixtures/x`): a bare word is a name, not a path.
  if (dirs.has(c) && (!literal || c.includes('/'))) return `${c}/**`;
  // A bare bin name in a test (spawned through PATH or a helper's bin dir) names bin/<name>.
  if (literal && !c.includes('/') && files.has(`bin/${c}`)) return `bin/${c}`;
  return null;
}

/**
 * A module specifier or literal → the repo files it names. A relative ref
 * and an alias whose chosen pattern has a target that exists name one file
 * (targets tried in order). Otherwise no single target is established, so
 * every plausible reading (other matching patterns, `baseUrl`, the repo
 * root) contributes: uncertainty selects more tests, never fewer.
 */
function resolveRefs(files: Set<string>, dirs: Set<string>, fromFile: string, ref: string, literal = false, config: PathAliases = NO_ALIASES): string[] {
  if (!ref || ref.startsWith('node:') || ref.startsWith('bun:')) return [];
  if (ref.startsWith('.')) { const t = resolveCandidate(files, dirs, normalize(path.posix.join(path.posix.dirname(fromFile), ref)), literal); return t ? [t] : []; }
  const { chosen, others } = matchAliases(config.aliases, ref);
  for (const c of chosen ?? []) { const t = resolveCandidate(files, dirs, c, literal); if (t) return [t]; }
  if (!chosen && others.length === 0 && ref.startsWith('@') && !ref.includes('/')) return [];
  const plausible = [...others, ...(config.baseUrl ? [normalize(path.posix.join(config.baseUrl, ref))] : []), normalize(ref)];
  return [...new Set(plausible.map(c => resolveCandidate(files, dirs, c, literal)).filter((t): t is string => t !== null))];
}

/** A specifier worth naming when it resolves nowhere: relative, aliased, or alias-shaped (`@/`, `~`, `#`); never a package. */
function pathLike(config: PathAliases, ref: string): boolean {
  if (ref.startsWith('.') || /^(?:@\/|~|#)/.test(ref)) return true;
  const { chosen, others } = matchAliases(config.aliases, ref);
  return chosen !== null || others.length > 0;
}

const pathDepths = new WeakMap<Set<string>, number>();
/**
 * Segments in the repo's deepest path. No module name resolves deeper, so
 * dotted-name resolution is bounded by the repo rather than by the source.
 */
function maxPathDepth(files: Set<string>): number {
  let depth = pathDepths.get(files);
  if (depth === undefined) { depth = 0; for (const f of files) depth = Math.max(depth, f.split('/').length); pathDepths.set(files, depth); }
  return depth;
}

/** The leading dotted name of each comma-separated `name [as alias]` clause. */
function pyNames(list: string): string[] {
  return list.replace(/[()]/g, '').split(',').map(p => p.trim().split(/\s+/)[0]!).filter(n => n && n !== '*');
}

/** `from <dots><rest>` → the absolute dotted package it names, or null when it climbs above the repository root. */
function pyFromBase(rel: string, spec: string): string | null {
  const dots = /^\.*/.exec(spec)![0].length;
  const rest = spec.slice(dots);
  if (!dots) return rest;
  const pkg = path.posix.dirname(rel).split('/').filter(s => s !== '.');
  if (dots - 1 > pkg.length) return null;
  return [...pkg.slice(0, pkg.length - (dots - 1)), ...(rest ? [rest] : [])].join('.');
}

/**
 * Python source with every string blanked to `''` and every comment dropped, in
 * one linear pass, so a `#` inside a string and a quote inside a comment both
 * stay inert. Backslash escapes are honoured; an unterminated string runs to
 * its line end, or to the end of the file when triple-quoted.
 */
function pythonCode(source: string): string {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < source.length;) {
    const c = source[i]!;
    if (c === '#') { parts.push(source.slice(from, i)); const end = source.indexOf('\n', i); i = from = end < 0 ? source.length : end; continue; }
    if (c !== '"' && c !== "'") { i++; continue; }
    parts.push(source.slice(from, i), "''");
    const close = source.startsWith(c + c + c, i) ? c + c + c : c;
    let j = i + close.length;
    while (j < source.length && !source.startsWith(close, j) && (close.length === 3 || source[j] !== '\n')) j += source[j] === '\\' ? 2 : 1;
    i = from = Math.min(source.length, source.startsWith(close, j) ? j + close.length : j);
  }
  parts.push(source.slice(from));
  return parts.join('');
}

/** Dotted modules a Python source imports; `from a import b` also yields `a.b`, which may be a submodule. */
function pythonImports(rel: string, source: string): string[] {
  const code = pythonCode(source).replace(/\\\r?\n/g, ' ');
  const out: string[] = [];
  for (const m of code.matchAll(PY_IMPORT)) {
    if (m[3]) { out.push(...pyNames(m[3])); continue; }
    const base = pyFromBase(rel, m[1]!);
    if (base === null) continue;
    if (base) out.push(base);
    for (const name of pyNames(m[2]!)) out.push(base ? `${base}.${name}` : name);
  }
  return out;
}

/**
 * A dotted module → its repo files (`a/b/__init__.py`, which Python prefers,
 * and `a/b.py`; both when both exist) plus the package `__init__.py` files
 * Python executes on the way; [] for a module outside the repo (stdlib,
 * site-packages), including one deeper than any repo path.
 */
function pythonModuleFiles(files: Set<string>, dotted: string): string[] {
  const parts = dotted.split('.');
  if (parts.length > maxPathDepth(files) || parts.some(p => !p)) return [];
  const p = parts.join('/');
  const found = [`${p}/__init__.py`, `${p}.py`].filter(f => files.has(f));
  if (!found.length) return [];
  const inits = parts.slice(0, -1).map((_, i) => `${parts.slice(0, i + 1).join('/')}/__init__.py`).filter(f => files.has(f));
  return [...found, ...inits];
}

/** `'pkg.mod.Class.attr'` (a `mock.patch` target) → the longest dotted prefix that is a repo module. */
function pythonPatchTarget(files: Set<string>, ref: string): string[] {
  const parts = ref.split('.').slice(0, maxPathDepth(files));
  for (let n = parts.length; n >= 1; n--) {
    const hit = pythonModuleFiles(files, parts.slice(0, n).join('.'));
    if (hit.length) return hit;
  }
  return [];
}

function addEdge(graph: Graph, dependency: string, dependent: string, via: Edge['via']): void {
  if (dependency === dependent) return;
  const list = graph.reverse.get(dependency) ?? [];
  if (!list.some(e => e.from === dependent && e.via === via)) { list.push({ from: dependent, via }); graph.reverse.set(dependency, list); }
}

/**
 * Every dependency reference one source file makes: imports, requires, quoted
 * repo paths and join() segment runs. Import specifiers that resolve nowhere
 * and look like repo paths go to `unresolved` when given.
 */
export function referencesIn(files: Set<string>, dirs: Set<string>, rel: string, source: string, config: PathAliases = NO_ALIASES, unresolved?: string[]): Array<{ target: string; via: Edge['via'] }> {
  const out: Array<{ target: string; via: Edge['via'] }> = [];
  const importOf = (spec: string) => {
    const targets = resolveRefs(files, dirs, rel, spec, false, config);
    for (const target of targets) out.push({ target, via: 'import' });
    if (targets.length === 0 && unresolved && pathLike(config, spec) && !unresolved.includes(spec)) unresolved.push(spec);
  };
  if (/\.[cm]?[jt]sx?$/.test(rel)) {
    let imports: Array<{ path: string }> = [];
    try { imports = scanner.scanImports(source); } catch { imports = []; }
    for (const { path: spec } of imports) importOf(spec);
    // The transpiler erases type-only imports; a types module still binds its importers' contracts.
    for (const m of source.matchAll(/^\s*(?:import|export)\s+type\b[^;'"]*?\bfrom\s+['"]([^'"]+)['"]/gm)) importOf(m[1]!);
  }
  const python = rel.endsWith('.py');
  if (python) for (const mod of pythonImports(rel, source)) for (const t of pythonModuleFiles(files, mod)) out.push({ target: t, via: 'import' });
  // Literals carry dependencies only from the test tree and from bin/ and shell
  // sources (a test spawns a bin; a bash bin calls a sibling). Prose and
  // manifests name everything and would make every file a hub.
  if (!scansLiterals(rel)) return out;
  for (const m of source.matchAll(QUOTED)) {
    const targets = resolveRefs(files, dirs, rel, m[1]!, true, config);
    for (const target of targets) out.push({ target, via: 'literal' });
    if (python && PY_DOTTED.test(m[1]!)) for (const f of pythonPatchTarget(files, m[1]!)) out.push({ target: f, via: 'literal' });
  }
  for (const m of source.matchAll(JOIN)) {
    const segments = [...m[1]!.matchAll(/['"`]([^'"`]+)['"`]/g)].map(s => s[1]!);
    if (segments.length < 2) continue;
    const joined = segments.join('/');
    const direct = resolveRefs(files, dirs, rel, joined, true);
    for (const target of direct.length ? direct : resolveRefs(files, dirs, rel, './' + joined, true)) out.push({ target, via: 'literal' });
  }
  return out;
}

/** Test-tree files (tests, helpers, fixtures), bin/ entrypoints and shell sources carry literal dependencies. */
export function scansLiterals(rel: string): boolean {
  return /(?:^|\/)(?:test|tests|spec|__tests__)\//.test(rel) || isTestFile(rel) || rel.startsWith('bin/') || /\.(?:sh|bash)$/.test(rel);
}

export interface BuildOptions {
  declarations?: Record<string, string[]>; maxBytes?: number;
  /** Paths that no longer exist (deleted or renamed-from) but that tests may still name; they resolve as dependencies so their consumers are found. */
  extraFiles?: string[];
}

/** The whole-repo reverse graph. Files over maxBytes (default 2 MiB) are skipped: generated bundles, not tests. */
export function buildGraph(repoRoot: string, opts: BuildOptions = {}): Graph {
  const all = listRepoFiles(repoRoot);
  const files = new Set([...all, ...(opts.extraFiles ?? [])]);
  const dirs = new Set<string>();
  for (const f of all) { let d = path.posix.dirname(f); while (d && d !== '.') { dirs.add(d); d = path.posix.dirname(d); } }
  const config = readPathAliases(repoRoot);
  const graph: Graph = { files, tests: new Set(all.filter(isTestFile)), reverse: new Map(), unresolved: new Map(), aliasNotes: config.notes };
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  for (const rel of all) {
    if (!SOURCE_EXT.test(rel) && !rel.startsWith('bin/')) continue;
    let source: string;
    try { const st = fs.statSync(path.join(repoRoot, rel)); if (!st.isFile() || st.size > maxBytes) continue; source = fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { continue; }
    const unresolved: string[] = [];
    for (const { target, via } of referencesIn(files, dirs, rel, source, config, graph.tests.has(rel) ? unresolved : undefined)) addEdge(graph, target, rel, via);
    if (unresolved.length) graph.unresolved!.set(rel, unresolved);
  }
  for (const test of graph.tests) {
    const m = /^(?:[\w.-]+\/)*?test\/([\w-]+)\.(?:test|spec)\./.exec(test);
    if (!m) continue;
    // test/gstack-ship-receipt-census.test.ts names bin/gstack-ship-receipt-census, then bin/gstack-ship-receipt, then bin/gstack-ship, …
    const parts = m[1]!.split('-');
    for (let n = parts.length; n >= 1; n--) {
      const name = parts.slice(0, n).join('-');
      for (const bin of [`bin/${name}`, `bin/gstack-${name}`, `bin/${name}.ts`, `bin/gstack-${name}.ts`]) if (files.has(bin)) addEdge(graph, bin, test, 'convention');
    }
  }
  for (const [glob, tests] of Object.entries(opts.declarations ?? {})) {
    for (const f of files) if (matchesAny([glob], f)) for (const t of tests) addEdge(graph, f, t, 'declared');
  }
  return graph;
}

export interface LaneMapping { file: string; tests: string[]; provenance: string[]; declaredNone: boolean }

/**
 * Tests that depend on `file`, transitively through non-test files and
 * through `dir/**` edges. `declarations` with an empty list declare "no lane
 * needed" and win when nothing else maps.
 */
export function testsFor(graph: Graph, file: string, declarations: Record<string, string[]> = {}, maxDepth = 12): LaneMapping {
  const tests = new Set<string>();
  const provenance: string[] = [];
  const seen = new Set<string>([file]);
  const queue: Array<{ node: string; chain: string[] }> = [{ node: file, chain: [file] }];
  const dirEdges = [...graph.reverse.keys()].filter(k => k.endsWith('/**'));
  while (queue.length) {
    const { node, chain } = queue.shift()!;
    if (chain.length > maxDepth) continue;
    const edges = [...(graph.reverse.get(node) ?? [])];
    for (const dir of dirEdges) if (node.startsWith(dir.slice(0, -3) + '/')) edges.push(...(graph.reverse.get(dir) ?? []).map(e => ({ ...e, via: e.via })));
    for (const e of edges) {
      if (seen.has(e.from)) continue;
      seen.add(e.from);
      if (graph.tests.has(e.from)) { tests.add(e.from); provenance.push(`${e.from} ← ${[...chain].reverse().join(' ← ')} (${e.via})`); }
      else queue.push({ node: e.from, chain: [...chain, e.from] });
    }
  }
  if (graph.tests.has(file)) { tests.add(file); provenance.push(`${file} (itself a test)`); }
  const declaredNone = tests.size === 0 && Object.entries(declarations).some(([glob, list]) => list.length === 0 && matchesAny([glob], file));
  if (declaredNone) provenance.push(`${file}: declared no lane needed (.gstack/pregate.json dependencies)`);
  if (tests.size === 0 && !declaredNone) provenance.push(...noLaneExplanation(graph, file));
  return { file, tests: [...tests].sort(), provenance, declaredNone };
}

/** Why the graph may have missed a file's tests: unresolved repo-path specifiers in test files and unfollowed `extends`. */
function noLaneExplanation(graph: Graph, file: string): string[] {
  const seen = [...(graph.unresolved ?? new Map<string, string[]>())].sort(([a], [b]) => a.localeCompare(b));
  const notes = graph.aliasNotes ?? [];
  if (seen.length === 0 && notes.length === 0) return [];
  const lines = notes.map(n => `${file}: path aliases may be incomplete: ${n}`);
  const shown = seen.slice(0, 10).map(([test, specs]) => `${test}: ${specs.slice(0, 5).map(s => `'${s}'`).join(' ')}${specs.length > 5 ? ' …' : ''}`);
  if (shown.length) lines.push(`${file}: no lane; specifiers in test files that resolve to no repo file: ${shown.join('; ')}${seen.length > 10 ? `; +${seen.length - 10} more test file(s)` : ''}`);
  lines.push(`${file}: if a test covers it, declare the file under dependencies in .gstack/pregate.json, or report the resolver gap`);
  return lines;
}
