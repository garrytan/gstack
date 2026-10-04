/**
 * Derived PR-lane dependencies (W1 follow-up): which paid cases consume a
 * repository file that no touchfile names, computed from real references on
 * the checked-out tree instead of hand lists.
 *
 * A case consumes the transitive reference closure of its owning paid test
 * file plus every tracked file its touchfiles declare. References are:
 *   - static and literal dynamic imports of code (resolved relative paths);
 *   - repository paths written in code, shell or skill text (bin/, lib/,
 *     scripts/, browse/, design/, make-pdf/, hosts/, test/helpers/ ...),
 *     including `path.join(..., 'lib', 'x.ts')` segments;
 *   - bin script names (`gstack-*`) a skill, test or script invokes;
 *   - compiled binaries (scripts/build.sh `--outfile`): text naming
 *     `design/dist/design` consumes the whole `design/src/**` tree;
 *   - package scripts invoked as `bun run <name>`;
 *   - template placeholders: a skill whose template uses `{{NAME}}` consumes
 *     the resolver module behind RESOLVERS.NAME and that module's imports;
 *   - host configs: `hosts/<id>.ts` and `hosts/<id>/**` feed cases whose test
 *     names that host id.
 * Selection data modules are opaque (their literals classify files rather
 * than consume them), and the walk never enters another paid test file.
 *
 * A file the derivation cannot place is not guessed: PR selection restores
 * the full gate for it (scripts/test-pr-profile.ts), and PR_FULL_GATE_FILES
 * there lists the inputs every case consumes that must always do so.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchGlob } from '../test/helpers/test-selection';
import { isPaidTestFile } from '../test/helpers/paid-test-set';

export interface DependencyMaps {
  e2eTouchfiles: Record<string, string[]>;
  judgeTouchfiles: Record<string, string[]>;
  globalTouchfiles: readonly string[];
}

export interface DerivedDependencies {
  /** Repository file -> E2E case ids whose reference closure contains it. */
  e2e: Map<string, Set<string>>;
  /** Repository file -> LLM-judge ids whose reference closure contains it. */
  judges: Map<string, Set<string>>;
  /** Files every E2E case's closure contains: an edit there is as broad as a global touchfile. */
  everyCase: Set<string>;
  /** The global touchfiles and their code-import closure (the paid runner and harness every case runs through). */
  global: Set<string>;
  /** Every tracked file at derivation time. */
  tracked: Set<string>;
  /** The reference chain from an E2E case's declared inputs to `file` (for fix text and audits), else null. */
  trace(caseId: string, file: string): string[] | null;
  /**
   * Tracked files whose reference text still names `missing`, a path absent
   * from the tree (deleted in the diff): its path or extensionless import
   * target, a relative import resolving to it, its bin name, an ancestor
   * directory below the top two levels, or the outfile of a binary built from
   * its tree. Whole-line comments and selection data never count.
   */
  referencers(missing: string): string[];
}

const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const TEXT = /\.(?:[cm]?[jt]s|tsx|jsx|sh|md|tmpl|json|ya?ml|toml|txt|py)$/;
const REPO_PATH = /(?:^|[^\w.@-])((?:bin|lib|scripts|browse|design|make-pdf|hosts|extension|model-overlays|agents|test\/helpers|test\/fixtures)\/[\w.@-]+(?:\/[\w.@-]+)*)/g;
/** `path.join(ROOT, 'lib', 'x.ts')`: a top-level directory and its entry as separate string literals. */
const JOINED_PATH = /['"`](bin|lib|scripts|browse|design|make-pdf|hosts|extension|model-overlays|agents)['"`]\s*,\s*['"`]([\w.@-]+)['"`]/g;
const BIN_NAME = /\bgstack-[a-z0-9][a-z0-9-]*[a-z0-9]\b/g;
const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)/g;
const PACKAGE_RUN = /\b(?:bun|npm) run ([a-z][\w:.-]*)/g;
const OWNER = /^test\/[^/]+\.test\.ts$/;
/**
 * Selection and inventory data: their string literals name files they
 * classify, not files they consume, so references inside them are not
 * followed (the same rule as test/helpers/touchfile-closure.ts).
 */
export const SELECTION_DATA_MODULES: readonly string[] = [
  'test/helpers/touchfiles-data.ts', 'test/helpers/touchfiles.ts', 'test/helpers/test-selection.ts',
  'test/helpers/touchfile-closure.ts', 'test/helpers/free-fixtures-data.ts', 'test/helpers/paid-test-set.ts',
  'test/helpers/periodic-exclude-data.ts', 'test/helpers/eval-budgets.ts', 'scripts/test-pr-profile.ts',
  'scripts/pr-dependencies.ts', 'scripts/lib/paid-cases.ts', 'scripts/lib/paid-select.ts', 'scripts/lib/paid-types.ts',
  // The build entry list: every compiled binary, which skills reach through their `--outfile` path instead.
  'scripts/build.sh',
];
const DEFAULT_JUDGE_OWNER = 'test/skill-llm-eval.test.ts';

const transpiler = new Bun.Transpiler({ loader: 'tsx' });

/**
 * Text a reference scan reads: whole-line comments are prose about other
 * files, not consumption (block comments that open a line, `//` lines, and
 * shell `#` lines). Trailing comments stay, so a stripped reference is never
 * one the code executes.
 */
export function referenceText(file: string, text: string): string {
  if (CODE.test(file)) return text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/.*$/gm, '');
  if (/\.json$/.test(file)) return '';
  if (!/\.(?:md|tmpl|txt)$/.test(file)) return text.replace(/^[ \t]*#(?!!).*$/gm, '');
  return text;
}

function trackedFiles(root: string): string[] {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error('git ls-files failed; dependency derivation needs a git checkout');
  return listed.stdout.split('\0').filter(Boolean);
}

/** Resolver module (repo path) -> placeholder names whose RESOLVERS entry calls into it. */
function placeholderModules(root: string, read: (file: string) => string): Map<string, string[]> {
  const index = 'scripts/resolvers/index.ts';
  const source = read(index);
  const fnModule = new Map<string, string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w./-]+)'/g)) {
    const file = resolveSpecifier(root, `./${match[2]}`, index);
    if (!file) continue;
    for (const name of match[1]!.split(',').map(part => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!).filter(Boolean)) fnModule.set(name, file);
  }
  const body = source.slice(source.indexOf('export const RESOLVERS'));
  const byModule = new Map<string, string[]>();
  for (const entry of body.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*(.+?),?\s*$/gm)) {
    for (const ident of entry[2]!.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const file = fnModule.get(ident[1]!);
      if (file) byModule.set(file, [...new Set([...(byModule.get(file) ?? []), entry[1]!])]);
    }
  }
  return byModule;
}

function resolveSpecifier(root: string, specifier: string, from: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.js`]) {
    try { if (fs.statSync(path.join(root, candidate)).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

/** Binary outfile path -> the source tree it is compiled from (scripts/build.sh). */
function compiledBinaries(read: (file: string) => string): Array<{ outfile: string; tree: string }> {
  return [...read('scripts/build.sh').matchAll(/--compile\b[^\n]*?\s([\w./-]+\.ts)\s+--outfile\s+([\w./-]+)/g)]
    .map(match => ({ outfile: match[2]!, tree: match[1]!.startsWith('bin/') ? match[1]! : `${path.posix.dirname(match[1]!)}/**` }));
}

export function deriveDependencies(maps: DependencyMaps, root: string): DerivedDependencies {
  const tracked = trackedFiles(root);
  const trackedSet = new Set(tracked);
  const sources = new Map<string, string>();
  const read = (file: string): string => {
    if (!sources.has(file)) {
      let text = '';
      try { if (trackedSet.has(file) && (TEXT.test(file) || file.startsWith('bin/') || file === 'setup')) text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { /* unreadable */ }
      sources.set(file, text);
    }
    return sources.get(file)!;
  };
  const binNames = new Map(tracked.filter(file => file.startsWith('bin/')).map(file => [path.posix.basename(file).replace(/\.ts$/, ''), file]));
  const binaries = compiledBinaries(read);
  let scripts: Record<string, string> = {};
  try { scripts = JSON.parse(read('package.json')).scripts ?? {}; } catch { /* no package scripts */ }
  const placeholders = placeholderModules(root, read);
  const placeholderOwners = new Map<string, string>();
  for (const [file, names] of placeholders) for (const name of names) placeholderOwners.set(name, file);
  const expanded = new Map<string, string[]>();
  const expand = (pattern: string): string[] => {
    if (!expanded.has(pattern)) expanded.set(pattern, pattern.includes('*') ? tracked.filter(file => matchGlob(file, pattern)) : trackedSet.has(pattern) ? [pattern] : []);
    return expanded.get(pattern)!;
  };
  const dirs = new Set(tracked.flatMap(file => file.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));

  const edges = new Map<string, string[]>();
  const refs = (file: string): string[] => {
    if (edges.has(file)) return edges.get(file)!;
    const raw = read(file);
    const text = (SELECTION_DATA_MODULES as readonly string[]).includes(file) ? '' : referenceText(file, raw);
    const out = new Set<string>();
    if (CODE.test(file)) {
      try { for (const item of transpiler.scanImports(raw)) { const hit = resolveSpecifier(root, item.path, file); if (hit) out.add(hit); } } catch { /* literal scan below still applies */ }
    }
    for (const match of text.matchAll(REPO_PATH)) {
      const ref = match[1]!.replace(/[.]+$/, '');
      if (trackedSet.has(ref)) out.add(ref);
      else if (dirs.has(ref)) for (const child of expand(`${ref}/**`)) out.add(child);
    }
    for (const match of text.matchAll(JOINED_PATH)) {
      const ref = `${match[1]}/${match[2]}`;
      if (trackedSet.has(ref)) out.add(ref);
      else if (dirs.has(ref)) for (const child of expand(`${ref}/**`)) out.add(child);
    }
    for (const match of text.matchAll(BIN_NAME)) { const bin = binNames.get(match[0]); if (bin) out.add(bin); }
    for (const { outfile, tree } of binaries) if (text.includes(outfile)) for (const child of expand(tree)) out.add(child);
    for (const match of text.matchAll(PACKAGE_RUN)) {
      const command = scripts[match[1]!];
      if (command) for (const ref of command.matchAll(REPO_PATH)) for (const child of expand(ref[1]!)) out.add(child);
    }
    if (/\.(?:md|tmpl)$/.test(file)) for (const match of text.matchAll(PLACEHOLDER)) { const owner = placeholderOwners.get(match[1]!); if (owner) out.add(owner); }
    out.delete(file);
    const list = [...out];
    edges.set(file, list);
    return list;
  };
  const closure = (entries: Iterable<string>, parents?: Map<string, string>): Set<string> => {
    const seen = new Set<string>();
    const queue = [...entries].filter(file => trackedSet.has(file));
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const next of refs(file)) if (!seen.has(next) && !/\.test\.tsx?$/.test(next)) { queue.push(next); if (parents && !parents.has(next)) parents.set(next, file); }
    }
    return seen;
  };

  const hostIds = tracked.filter(file => /^hosts\/[\w-]+\.ts$/.test(file) && file !== 'hosts/index.ts').map(file => path.posix.basename(file, '.ts'));
  const consumers = (table: Record<string, string[]>, defaultOwner: string | null): Map<string, Set<string>> => {
    const byFile = new Map<string, Set<string>>();
    for (const [id, patterns] of Object.entries(table)) {
      const owners = patterns.filter(pattern => OWNER.test(pattern) && isPaidTestFile(pattern));
      const declared = [...(owners.length ? owners : defaultOwner ? [defaultOwner] : []), ...patterns.flatMap(expand)];
      const files = closure(declared);
      const ownerText = (owners.length ? owners : defaultOwner ? [defaultOwner] : []).map(read).join('\n');
      for (const host of hostIds) {
        if (new RegExp(`['"\`]${host}['"\`]|--host[ =]${host}\\b`).test(ownerText)) for (const file of closure([`hosts/${host}.ts`, ...expand(`hosts/${host}/**`)])) files.add(file);
      }
      for (const file of files) {
        if (!byFile.has(file)) byFile.set(file, new Set());
        byFile.get(file)!.add(id);
      }
    }
    return byFile;
  };
  const e2e = consumers(maps.e2eTouchfiles, null);
  const total = Object.keys(maps.e2eTouchfiles).length;
  const everyCase = new Set([...e2e].filter(([, ids]) => ids.size === total).map(([file]) => file));
  const global = new Set<string>();
  const pending = maps.globalTouchfiles.flatMap(expand);
  while (pending.length) {
    const file = pending.pop()!;
    if (global.has(file)) continue;
    global.add(file);
    if (!CODE.test(file)) continue;
    try { for (const item of transpiler.scanImports(read(file))) { const hit = resolveSpecifier(root, item.path, file); if (hit && !global.has(hit)) pending.push(hit); } } catch { /* unparseable: its own entry stays global */ }
  }
  const importTargets = new Map<string, string[]>();
  const targetsOf = (file: string): string[] => {
    if (!importTargets.has(file)) {
      const targets: string[] = [];
      if (CODE.test(file) && !(SELECTION_DATA_MODULES as readonly string[]).includes(file)) {
        try {
          for (const item of transpiler.scanImports(read(file))) {
            if (item.path.startsWith('.')) targets.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), item.path)));
          }
        } catch { /* literal mentions below still apply */ }
      }
      importTargets.set(file, targets);
    }
    return importTargets.get(file)!;
  };
  const referencerCache = new Map<string, string[]>();
  const referencers = (missing: string): string[] => {
    if (!referencerCache.has(missing)) referencerCache.set(missing, findReferencers(missing));
    return referencerCache.get(missing)!;
  };
  const findReferencers = (missing: string): string[] => {
    const bare = missing.replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/, '');
    const parts = missing.split('/');
    const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')).filter(dir => dir.split('/').length >= 3);
    const binName = missing.startsWith('bin/') ? path.posix.basename(bare) : null;
    const outfiles = binaries.filter(({ tree }) => matchGlob(missing, tree)).map(({ outfile }) => outfile);
    const needles = [missing, ...(bare !== missing ? [bare] : []), ...ancestors.map(dir => `${dir}/`), ...outfiles];
    return tracked.filter(file => {
      if (file === missing || (SELECTION_DATA_MODULES as readonly string[]).includes(file)) return false;
      const raw = read(file);
      if (!raw) return false;
      const text = referenceText(file, raw);
      if (needles.some(needle => text.includes(needle))) return true;
      if (binName && new RegExp(`\\b${binName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) return true;
      return targetsOf(file).some(target => target === missing || target === bare || `${target}/index.ts` === missing);
    });
  };
  const trace = (caseId: string, file: string): string[] | null => {
    const patterns = maps.e2eTouchfiles[caseId] ?? [];
    const parents = new Map<string, string>();
    const reached = closure([...patterns.filter(pattern => OWNER.test(pattern)), ...patterns.flatMap(expand)], parents);
    if (!reached.has(file)) return null;
    const chain = [file];
    while (parents.has(chain[0]!)) chain.unshift(parents.get(chain[0]!)!);
    return chain;
  };
  return { e2e, judges: consumers(maps.judgeTouchfiles, DEFAULT_JUDGE_OWNER), everyCase, global, tracked: trackedSet, trace, referencers };
}

const cache = new Map<string, DerivedDependencies>();

/** Derived dependencies of the checkout at `root`, computed once per process and map set. */
export function derivedDependencies(maps: DependencyMaps, root: string): DerivedDependencies {
  const key = `${root}\0${Object.keys(maps.e2eTouchfiles).length}\0${Object.keys(maps.judgeTouchfiles).length}`;
  if (!cache.has(key)) cache.set(key, deriveDependencies(maps, root));
  return cache.get(key)!;
}

