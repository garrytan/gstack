/**
 * pregate/rust — Cargo crates for the import graph and the `lanes` runner.
 * A crate is the nearest directory holding a Cargo.toml with a `[package]`
 * name. Its `.rs` files are tests when they sit under `<crate>/tests/` or hold
 * a `#[cfg(test)]` (in-source unit tests). Cargo runs tests per crate, never
 * per file, so the graph maps at crate level: every `.rs` file of a crate,
 * and its Cargo.toml, select that crate's tests and the tests of every crate
 * that depends on it, transitively.
 * Manifests are parsed as TOML (Bun.TOML, as lib/model-policy.ts does), so
 * dotted keys, `[dependencies.<name>]` tables, target-specific tables and
 * `{ workspace = true }` inheritance read as Cargo reads them. A dependency
 * resolves by `path` (relative to the manifest declaring it) to a tracked
 * crate, else by package name (`package = ` or the key); a name match only
 * widens. The workspace a crate runs in follows Cargo's membership rules:
 * `package.workspace`, else the nearest `[workspace]` above it, when that
 * workspace is the crate's own manifest, lists it in `members` or reaches it
 * by a path dependency, and does not `exclude` it; otherwise the crate
 * directory. Nothing here runs cargo: pregate reads files only.
 */
import * as path from 'node:path';
import { matchesAny } from '../ship-policy';

/** Reads a repo-relative file's text, or null when it is absent or unreadable. */
export type ReadFile = (rel: string) => string | null;

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const DEP_TABLES = ['dependencies', 'dev-dependencies', 'build-dependencies'] as const;

/** One dependency: the crate directory its `path` names (repo-relative, normalized) and the package name it asks for. */
interface DepSpec { path: string | null; name: string }

export interface Crate {
  root: string;
  name: string;
  /** Where `cargo test -p <name>` runs: the root of the workspace it is a member of, else the crate directory. */
  workspace: string;
  /** Roots of the tracked crates it depends on. */
  deps: string[];
}

export interface CargoModel { crates: Map<string, Crate>; crateOf(file: string): Crate | null }

interface Manifest { dir: string; toml: Table }

const dirOf = (manifest: string) => (path.posix.dirname(manifest) === '.' ? '' : path.posix.dirname(manifest));
/** `dir` joined with a manifest-relative path, normalized; null when it leaves the repository. */
function joinRel(dir: string, rel: string): string | null {
  const joined = path.posix.normalize(path.posix.join(dir || '.', rel.replace(/\\/g, '/'))).replace(/\/+$/, '');
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return null;
  return joined === '.' ? '' : joined;
}
const inside = (dir: string, root: string) => root === '' || dir === root || dir.startsWith(`${root}/`);
const relTo = (dir: string, root: string) => (root === '' ? dir : dir === root ? '' : dir.slice(root.length + 1));

/** Every dependency of a manifest: `[*dependencies]` and `[target.<cfg>.*dependencies]`, `{ workspace = true }` read from `ws`'s `[workspace.dependencies]` (its paths relative to the workspace root). */
function depSpecs(m: Manifest, ws: Manifest | null): DepSpec[] {
  const tables: Table[] = [];
  for (const key of DEP_TABLES) if (isTable(m.toml[key])) tables.push(m.toml[key] as Table);
  if (isTable(m.toml.target)) for (const cfg of Object.values(m.toml.target)) if (isTable(cfg)) for (const key of DEP_TABLES) if (isTable(cfg[key])) tables.push(cfg[key] as Table);
  const inherited = ws && isTable(ws.toml.workspace) && isTable(ws.toml.workspace.dependencies) ? ws.toml.workspace.dependencies : {};
  const out: DepSpec[] = [];
  for (const table of tables) {
    for (const [key, raw] of Object.entries(table)) {
      const fromWorkspace = isTable(raw) && raw.workspace === true;
      const spec = fromWorkspace ? inherited[key] : raw;
      const renamed = [spec, raw].find(s => isTable(s) && typeof s.package === 'string') as Table | undefined;
      const p = isTable(spec) && typeof spec.path === 'string' ? joinRel(fromWorkspace ? ws!.dir : m.dir, spec.path) : null;
      out.push({ path: p, name: (renamed?.package as string | undefined) ?? key });
    }
  }
  return out;
}

/** The tracked crates among `files` (the paths `git ls-files` reports), what each depends on, and the workspace each runs in. */
export function cargoModel(files: readonly string[], read: ReadFile): CargoModel {
  const manifests = new Map<string, Manifest>();
  for (const f of files) {
    if (path.posix.basename(f) !== 'Cargo.toml') continue;
    const text = read(f);
    if (text === null) continue;
    try { const toml = Bun.TOML.parse(text); if (isTable(toml)) manifests.set(dirOf(f), { dir: dirOf(f), toml }); } catch { /* an unparsable manifest names no crate */ }
  }
  const nameOf = (dir: string) => { const pkg = manifests.get(dir)?.toml.package; return isTable(pkg) && typeof pkg.name === 'string' ? pkg.name : null; };
  const roots = [...manifests.keys()].filter(d => nameOf(d) !== null);
  const workspaces = [...manifests.values()].filter(m => isTable(m.toml.workspace));
  const byName = new Map<string, string[]>();
  for (const r of roots) byName.set(nameOf(r)!, [...(byName.get(nameOf(r)!) ?? []), r]);

  // `package.workspace` names the workspace; otherwise Cargo consults only the nearest [workspace] at or above the crate.
  const candidate = (root: string): Manifest | null => {
    const pkg = manifests.get(root)!.toml.package as Table;
    if (typeof pkg.workspace === 'string') { const w = manifests.get(joinRel(root, pkg.workspace) ?? '\0'); return w && isTable(w.toml.workspace) ? w : null; }
    return workspaces.filter(w => inside(root, w.dir)).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
  };
  const memberCache = new Map<string, Set<string>>();
  const membersOf = (ws: Manifest): Set<string> => {
    const cached = memberCache.get(ws.dir);
    if (cached) return cached;
    const conf = ws.toml.workspace as Table;
    const norm = (g: string) => joinRel('', g) ?? '\0';
    const globs = strings(conf.members).map(norm);
    const exclude = strings(conf.exclude).map(norm);
    const own = new Set(roots.filter(r => candidate(r)?.dir === ws.dir));
    const excluded = (r: string) => exclude.some(e => { const rel = relTo(r, ws.dir); return rel === e || rel.startsWith(`${e}/`); });
    // Cargo's rules: the root package and a literally listed member always belong; a glob match or a path dependency of a
    // member inside the workspace belongs unless `exclude` names it or a directory above it.
    const literal = (r: string) => globs.some(g => !/[*?[]/.test(g) && relTo(r, ws.dir) === g);
    const members = new Set([...own].filter(r => r === ws.dir || literal(r) || (matchesAny(globs, relTo(r, ws.dir)) && !excluded(r))));
    memberCache.set(ws.dir, members);
    const queue = [...members];
    while (queue.length) {
      for (const dep of depSpecs(manifests.get(queue.shift()!)!, ws)) {
        if (dep.path === null || members.has(dep.path) || !own.has(dep.path) || !inside(dep.path, ws.dir) || excluded(dep.path)) continue;
        members.add(dep.path);
        queue.push(dep.path);
      }
    }
    return members;
  };

  // A path names one crate; without a path (or when it names no tracked crate) every crate of that package name is a candidate.
  const resolve = (specs: DepSpec[]) => [...new Set(specs.flatMap(s => (s.path !== null && nameOf(s.path) !== null ? [s.path] : byName.get(s.name) ?? [])))];
  const crates = new Map<string, Crate>();
  for (const root of roots) {
    const ws = candidate(root);
    const member = ws !== null && membersOf(ws).has(root) ? ws : null;
    crates.set(root, { root, name: nameOf(root)!, workspace: member?.dir ?? root, deps: resolve(depSpecs(manifests.get(root)!, member)).filter(d => d !== root) });
  }
  const crateOf = (file: string): Crate | null => {
    for (let d = path.posix.dirname(file); ; d = path.posix.dirname(d)) {
      const c = crates.get(d === '.' ? '' : d);
      if (c) return c;
      if (d === '.' || d === '/' || d === '') return null;
    }
  };
  return { crates, crateOf };
}

/** Whether Rust source holds a `#[cfg(...)]` whose predicate names `test` outside a string (`cfg(test)`, `cfg(all(test, unix))`; never `cfg(feature = "test")`). */
export function hasCfgTest(source: string): boolean {
  for (const m of source.matchAll(/#\s*\[\s*cfg\s*\(((?:[^\]"]|"[^"]*")*)\)\s*\]/g)) if (/\btest\b/.test(m[1]!.replace(/"[^"]*"/g, '""'))) return true;
  return false;
}

export interface RustGraph {
  tests: string[];
  edges: Array<{ dependency: string; dependent: string; via: 'import' | 'convention' }>;
}

/**
 * The Rust part of the reverse graph over the tracked `files`: each crate's
 * test files, an edge from every `.rs` file of a crate to its Cargo.toml (the
 * crate's node), and an edge from each Cargo.toml to the tests of its crate
 * (`convention`) and of every crate depending on it, transitively (`import`).
 */
export function rustEdges(files: readonly string[], read: ReadFile): RustGraph {
  const { crates, crateOf } = cargoModel(files, read);
  const out: RustGraph = { tests: [], edges: [] };
  if (!crates.size) return out;
  const testsOf = new Map<string, string[]>([...crates.keys()].map(k => [k, []]));
  const manifestOf = (root: string) => (root ? `${root}/Cargo.toml` : 'Cargo.toml');
  for (const f of files) {
    if (!f.endsWith('.rs')) continue;
    const crate = crateOf(f);
    if (!crate) continue;
    out.edges.push({ dependency: f, dependent: manifestOf(crate.root), via: 'convention' });
    if (f.startsWith(crate.root ? `${crate.root}/tests/` : 'tests/') || hasCfgTest(read(f) ?? '')) { out.tests.push(f); testsOf.get(crate.root)!.push(f); }
  }
  const dependents = new Map<string, Set<string>>();
  for (const c of crates.values()) for (const d of c.deps) dependents.set(d, (dependents.get(d) ?? new Set()).add(c.root));
  for (const root of crates.keys()) {
    const reach = new Set<string>([root]);
    const queue = [root];
    while (queue.length) for (const next of dependents.get(queue.shift()!) ?? []) if (!reach.has(next)) { reach.add(next); queue.push(next); }
    for (const r of reach) for (const t of testsOf.get(r)!) out.edges.push({ dependency: manifestOf(root), dependent: t, via: r === root ? 'convention' : 'import' });
  }
  return out;
}
