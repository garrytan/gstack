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
export const TEST_FILE_RE = /(?:^|\/)(?:test|tests|spec|__tests__)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go|rb)$|_spec\.rb$/;

export interface Edge { from: string; via: 'import' | 'literal' | 'convention' | 'declared' | 'generated' }
export interface Graph {
  files: Set<string>;
  tests: Set<string>;
  /** dependency → dependents with the kind of edge. */
  reverse: Map<string, Edge[]>;
}

const scanner = new Bun.Transpiler({ loader: 'tsx' });
const QUOTED = /['"`]([A-Za-z0-9_@][A-Za-z0-9_./@-]*)['"`]/g;
const JOIN = /\bjoin\(([^()]*)\)/g;
const RESOLVE_EXT = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'];
// One left-to-right pass, so a `#` inside a string and a quote inside a comment both stay inert.
const PY_STRING_OR_COMMENT = /("""|''')[\s\S]*?\1|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#[^\n]*/g;
const PY_IMPORT = /^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]+)|import[ \t]+([^\n;]+))/gm;
const PY_DOTTED = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/;

export function isTestFile(rel: string): boolean { return TEST_FILE_RE.test(rel); }

export function listRepoFiles(repoRoot: string): string[] {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout ?? '').split('\0').filter(p => p && !p.startsWith('node_modules/'));
}

function normalize(p: string): string { return path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, ''); }

/** A module specifier or literal → the repo file it names, or a directory → `dir/**`, or null. */
function resolveRef(files: Set<string>, dirs: Set<string>, fromFile: string, ref: string, literal = false): string | null {
  if (!ref || ref.startsWith('node:') || ref.startsWith('bun:') || ref.startsWith('@') && !ref.includes('/')) return null;
  const candidates: string[] = [];
  if (ref.startsWith('.')) candidates.push(normalize(path.posix.join(path.posix.dirname(fromFile), ref)));
  else candidates.push(normalize(ref));
  for (const c of candidates) {
    if (c.startsWith('../') || c === '..' || c === '.' || c === '') continue;
    for (const ext of RESOLVE_EXT) if (files.has(c + ext)) return c + ext;
    // A directory literal needs two segments (`test/fixtures/x`): a bare word is a name, not a path.
    if (dirs.has(c) && (!literal || c.includes('/'))) return `${c}/**`;
    // A bare bin name in a test (spawned through PATH or a helper's bin dir) names bin/<name>.
    if (literal && !c.includes('/') && files.has(`bin/${c}`)) return `bin/${c}`;
  }
  return null;
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

/** Dotted modules a Python source imports; `from a import b` also yields `a.b`, which may be a submodule. */
function pythonImports(rel: string, source: string): string[] {
  const code = source.replace(PY_STRING_OR_COMMENT, m => (m.startsWith('#') ? '' : "''")).replace(/\\\r?\n/g, ' ');
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
 * A dotted module → its repo file (`a/b.py` or `a/b/__init__.py`) plus the
 * package `__init__.py` files Python executes on the way; [] for a module
 * outside the repo (stdlib, site-packages).
 */
function pythonModuleFiles(files: Set<string>, dotted: string): string[] {
  const parts = dotted.split('.');
  if (parts.some(p => !p)) return [];
  const p = parts.join('/');
  const file = [`${p}.py`, `${p}/__init__.py`].find(f => files.has(f));
  if (!file) return [];
  const inits = parts.slice(0, -1).map((_, i) => `${parts.slice(0, i + 1).join('/')}/__init__.py`).filter(f => files.has(f));
  return [file, ...inits];
}

/** `'pkg.mod.Class.attr'` (a `mock.patch` target) → the longest dotted prefix that is a repo module. */
function pythonPatchTarget(files: Set<string>, ref: string): string[] {
  const parts = ref.split('.');
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

/** Every dependency reference one source file makes: imports, requires, quoted repo paths and join() segment runs. */
export function referencesIn(files: Set<string>, dirs: Set<string>, rel: string, source: string): Array<{ target: string; via: Edge['via'] }> {
  const out: Array<{ target: string; via: Edge['via'] }> = [];
  if (/\.[cm]?[jt]sx?$/.test(rel)) {
    let imports: Array<{ path: string }> = [];
    try { imports = scanner.scanImports(source); } catch { imports = []; }
    for (const { path: spec } of imports) { const t = resolveRef(files, dirs, rel, spec); if (t) out.push({ target: t, via: 'import' }); }
    // The transpiler erases type-only imports; a types module still binds its importers' contracts.
    for (const m of source.matchAll(/^\s*(?:import|export)\s+type\b[^;'"]*?\bfrom\s+['"]([^'"]+)['"]/gm)) { const t = resolveRef(files, dirs, rel, m[1]!); if (t) out.push({ target: t, via: 'import' }); }
  }
  const python = rel.endsWith('.py');
  if (python) for (const mod of pythonImports(rel, source)) for (const t of pythonModuleFiles(files, mod)) out.push({ target: t, via: 'import' });
  // Literals carry dependencies only from the test tree and from bin/ and shell
  // sources (a test spawns a bin; a bash bin calls a sibling). Prose and
  // manifests name everything and would make every file a hub.
  if (!scansLiterals(rel)) return out;
  for (const m of source.matchAll(QUOTED)) {
    const t = resolveRef(files, dirs, rel, m[1]!, true);
    if (t) out.push({ target: t, via: 'literal' });
    else if (python && PY_DOTTED.test(m[1]!)) for (const f of pythonPatchTarget(files, m[1]!)) out.push({ target: f, via: 'literal' });
  }
  for (const m of source.matchAll(JOIN)) {
    const segments = [...m[1]!.matchAll(/['"`]([^'"`]+)['"`]/g)].map(s => s[1]!);
    if (segments.length < 2) continue;
    const joined = segments.join('/');
    const t = resolveRef(files, dirs, rel, joined, true) ?? resolveRef(files, dirs, rel, './' + joined, true);
    if (t) out.push({ target: t, via: 'literal' });
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
  const graph: Graph = { files, tests: new Set(all.filter(isTestFile)), reverse: new Map() };
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  for (const rel of all) {
    if (!SOURCE_EXT.test(rel) && !rel.startsWith('bin/')) continue;
    let source: string;
    try { const st = fs.statSync(path.join(repoRoot, rel)); if (!st.isFile() || st.size > maxBytes) continue; source = fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { continue; }
    for (const { target, via } of referencesIn(files, dirs, rel, source)) addEdge(graph, target, rel, via);
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
  return { file, tests: [...tests].sort(), provenance, declaredNone };
}
