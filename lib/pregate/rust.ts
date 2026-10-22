/**
 * pregate/rust — Cargo crates for the import graph and the `lanes` runner.
 * A crate is the nearest directory holding a Cargo.toml with a `[package]`
 * name. Its `.rs` files are tests when they sit under `<crate>/tests/` or hold
 * a `#[cfg(test)]` (in-source unit tests). Cargo runs tests per crate, never
 * per file, so the graph maps at crate level: every `.rs` file of a crate,
 * and its Cargo.toml, select that crate's tests and the tests of every crate
 * that depends on it (transitively, through the manifests' dependency keys).
 * Uncertainty widens: a renamed dependency counts under both names, and any
 * cfg predicate naming `test` makes a file a test.
 */
import * as path from 'node:path';

export interface CargoManifest { name: string | null; workspace: boolean; deps: string[] }
export interface Crate { root: string; name: string }

const DEP_TABLE = /^(?:target\..+\.)?(?:dependencies|dev-dependencies|build-dependencies)$/;
const DEP_SUBTABLE = /^(?:target\..+\.)?(?:dependencies|dev-dependencies|build-dependencies)\.["']?([A-Za-z0-9_-]+)["']?$/;
const PACKAGE_KEY = /\bpackage\s*=\s*["']([A-Za-z0-9_-]+)["']/;

/** A Cargo.toml's `[package]` name, whether it declares a `[workspace]`, and every dependency key and `package =` rename, in a line scan (no TOML parser; comments dropped). */
export function parseCargoManifest(text: string): CargoManifest {
  let section = '';
  let name: string | null = null;
  let workspace = false;
  const deps = new Set<string>();
  for (const raw of text.replace(/^﻿/, '').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '$1').trim();
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      section = header[1]!.replace(/\s+/g, '');
      if (section === 'workspace' || section.startsWith('workspace.')) workspace = true;
      const sub = DEP_SUBTABLE.exec(section);
      if (sub) deps.add(sub[1]!);
      continue;
    }
    if (section === 'package') { const m = /^name\s*=\s*["']([A-Za-z0-9_-]+)["']/.exec(line); if (m) name = m[1]!; continue; }
    if (DEP_TABLE.test(section)) {
      const key = /^["']?([A-Za-z0-9_-]+)["']?\s*=/.exec(line);
      if (key) deps.add(key[1]!);
    }
    if (DEP_TABLE.test(section) || DEP_SUBTABLE.test(section)) { const renamed = PACKAGE_KEY.exec(line); if (renamed) deps.add(renamed[1]!); }
  }
  return { name, workspace, deps: [...deps] };
}

/** Whether Rust source holds a `#[cfg(...)]` whose predicate names `test` outside a string (`cfg(test)`, `cfg(all(test, unix))`; never `cfg(feature = "test")`). */
export function hasCfgTest(source: string): boolean {
  for (const m of source.matchAll(/#\s*\[\s*cfg\s*\(((?:[^\]"]|"[^"]*")*)\)\s*\]/g)) if (/\btest\b/.test(m[1]!.replace(/"[^"]*"/g, '""'))) return true;
  return false;
}

/** Reads a repo-relative file's text, or null when it is absent or unreadable. */
export type ReadFile = (rel: string) => string | null;

/** A memo of manifests by repo-relative directory (`''` for the repository root). */
export type ManifestCache = Map<string, CargoManifest | null>;

function manifestAt(read: ReadFile, dir: string, cache: ManifestCache): CargoManifest | null {
  if (!cache.has(dir)) { const text = read(path.posix.join(dir, 'Cargo.toml')); cache.set(dir, text === null ? null : parseCargoManifest(text)); }
  return cache.get(dir)!;
}

function ancestors(file: string): string[] {
  const out: string[] = [];
  for (let d = path.posix.dirname(file); ; d = path.posix.dirname(d)) {
    out.push(d === '.' ? '' : d);
    if (d === '.' || d === '/' || d === '') return out;
  }
}

/** The crate owning `file`: the nearest directory at or above it whose Cargo.toml names a `[package]`; null outside any crate. */
export function crateOf(read: ReadFile, file: string, cache: ManifestCache = new Map()): Crate | null {
  for (const dir of ancestors(file)) { const m = manifestAt(read, dir, cache); if (m?.name) return { root: dir, name: m.name }; }
  return null;
}

/** Where `cargo test -p` runs for a crate: the nearest directory at or above its root whose Cargo.toml declares `[workspace]`, else the crate root. */
export function cargoWorkspaceRoot(read: ReadFile, crateRoot: string, cache: ManifestCache = new Map()): string {
  for (const dir of ancestors(path.posix.join(crateRoot, 'Cargo.toml'))) if (manifestAt(read, dir, cache)?.workspace) return dir;
  return crateRoot;
}

/** Whether a crate file is a test by its path alone: under `<crate>/tests/`. */
function inTestsDir(crate: Crate, file: string): boolean { return file.startsWith(crate.root ? `${crate.root}/tests/` : 'tests/'); }

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
  const cache: ManifestCache = new Map();
  const manifests = files.filter(f => path.posix.basename(f) === 'Cargo.toml');
  const crates = new Map<string, Crate & { deps: string[] }>();
  for (const f of manifests) {
    const dir = path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f);
    const m = manifestAt(read, dir, cache);
    if (m?.name) crates.set(dir, { root: dir, name: m.name, deps: m.deps });
  }
  const out: RustGraph = { tests: [], edges: [] };
  if (!crates.size) return out;
  const testsOf = new Map<string, string[]>([...crates.keys()].map(k => [k, []]));
  const manifestOf = (root: string) => (root ? `${root}/Cargo.toml` : 'Cargo.toml');
  for (const f of files) {
    if (!f.endsWith('.rs')) continue;
    const crate = crateOf(read, f, cache);
    if (!crate || !crates.has(crate.root)) continue;
    out.edges.push({ dependency: f, dependent: manifestOf(crate.root), via: 'convention' });
    if (inTestsDir(crate, f) || hasCfgTest(read(f) ?? '')) { out.tests.push(f); testsOf.get(crate.root)!.push(f); }
  }
  const byName = new Map<string, string[]>();
  for (const c of crates.values()) byName.set(c.name, [...(byName.get(c.name) ?? []), c.root]);
  const dependents = new Map<string, Set<string>>();
  for (const c of crates.values()) for (const d of c.deps) for (const root of byName.get(d) ?? []) if (root !== c.root) dependents.set(root, (dependents.get(root) ?? new Set()).add(c.root));
  for (const root of crates.keys()) {
    const reach = new Set<string>([root]);
    const queue = [root];
    while (queue.length) for (const next of dependents.get(queue.shift()!) ?? []) if (!reach.has(next)) { reach.add(next); queue.push(next); }
    for (const r of reach) for (const t of testsOf.get(r)!) out.edges.push({ dependency: manifestOf(root), dependent: t, via: r === root ? 'convention' : 'import' });
  }
  return out;
}
