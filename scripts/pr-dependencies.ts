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
   * Files whose import scan failed for a reason other than a leading `#!`
   * line (their imports are unknown). PR selection restores the full gate
   * while this is non-empty; it fills as the derivation reads files.
   */
  scanErrors: Map<string, string>;
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
/** An extensionless script Bun or Node runs: its imports are code, not shell. */
const CODE_SHEBANG = /^#![^\n]*\b(?:bun|node)\b/;
const TEXT = /\.(?:[cm]?[jt]s|tsx|jsx|sh|md|tmpl|json|ya?ml|toml|txt|py)$/;
const REPO_PATH = /(?:^|[^\w.@-])((?:bin|lib|scripts|browse|design|make-pdf|hosts|extension|model-overlays|agents|capy|test\/helpers|test\/fixtures)\/[\w.@-]+(?:\/[\w.@-]+)*)/g;
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
  // The reason-code table: its `fix:` prose names the command a person reruns, not a file the module consumes.
  'lib/result-codes.ts', 'lib/result-codes-release.ts',
  // The exercised-path map: observed commands per case, read only by exercisedConsumers() (shadow data; a change selects no paid case).
  'test/helpers/exercised-commands.json',
];
const DEFAULT_JUDGE_OWNER = 'test/skill-llm-eval.test.ts';

const transpilers = {
  ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }),
  js: new Bun.Transpiler({ loader: 'js' }), jsx: new Bun.Transpiler({ loader: 'jsx' }),
};

/** Code by extension, or an extensionless file whose shebang runs Bun or Node. */
export function isCodeFile(file: string, text: string): boolean {
  return CODE.test(file) || (!/\.[^/]+$/.test(path.posix.basename(file)) && CODE_SHEBANG.test(text));
}

/**
 * Relative import specifiers of a code file. A leading `#!` line is blanked
 * first (`scanImports` rejects it), and each extension gets its own loader
 * (the TSX loader misreads `.ts` generics and casts). Any other parse error
 * throws, so callers fail closed.
 */
export function scanCodeImports(file: string, text: string): string[] {
  const loader = /\.tsx$/.test(file) ? 'tsx' : /\.jsx$/.test(file) ? 'jsx' : /\.[cm]?js$/.test(file) ? 'js' : 'ts';
  return transpilers[loader].scanImports(text.replace(/^#![^\n]*/, '')).map(item => item.path);
}

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

  const scanErrors = new Map<string, string>();
  const importsOf = (file: string): string[] => {
    try { return scanCodeImports(file, read(file)); } catch (error) { scanErrors.set(file, String(error)); return []; }
  };
  const edges = new Map<string, string[]>();
  const refs = (file: string): string[] => {
    if (edges.has(file)) return edges.get(file)!;
    const raw = read(file);
    const text = (SELECTION_DATA_MODULES as readonly string[]).includes(file) ? '' : referenceText(file, raw);
    const out = new Set<string>();
    if (isCodeFile(file, raw)) for (const specifier of importsOf(file)) { const hit = resolveSpecifier(root, specifier, file); if (hit) out.add(hit); }
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
    const queue = [...entries].filter(file => trackedSet.has(file)).reverse();
    for (let head = 0; head < queue.length; head++) {
      const file = queue[head]!;
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
    if (!isCodeFile(file, read(file))) continue;
    for (const specifier of importsOf(file)) { const hit = resolveSpecifier(root, specifier, file); if (hit && !global.has(hit)) pending.push(hit); }
  }
  const importTargets = new Map<string, string[]>();
  const targetsOf = (file: string): string[] => {
    if (!importTargets.has(file)) {
      const targets: string[] = [];
      if (isCodeFile(file, read(file)) && !(SELECTION_DATA_MODULES as readonly string[]).includes(file)) {
        for (const specifier of importsOf(file)) {
          if (specifier.startsWith('.')) targets.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
        }
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
  return { e2e, judges: consumers(maps.judgeTouchfiles, DEFAULT_JUDGE_OWNER), everyCase, global, tracked: trackedSet, trace, referencers, scanErrors };
}

const cache = new Map<string, DerivedDependencies>();

/** Derived dependencies of the checkout at `root`, computed once per process and map set. */
export function derivedDependencies(maps: DependencyMaps, root: string): DerivedDependencies {
  const key = `${root}\0${Object.keys(maps.e2eTouchfiles).length}\0${Object.keys(maps.judgeTouchfiles).length}`;
  if (!cache.has(key)) cache.set(key, deriveDependencies(maps, root));
  return cache.get(key)!;
}

// ─── Exercised-path consumer map (W2-A2, shadow mode) ──────────────────────

/** The committed per-case observed commands (generated by scripts/exercised-map.ts; union-only refreshes). */
export const EXERCISED_MAP_PATH = 'test/helpers/exercised-commands.json';

export interface ExercisedCase {
  /** Recorded trials (run, case) the commands were taken from. */
  observations: number;
  /** Of those, trials that recorded at least one command. */
  withCommands: number;
  /** Bins and compiled outfiles the case invoked (binsInCommand over every recorded command). */
  commands: string[];
  /** Mean known trial cost per run, for the shadow cost estimate. */
  costUsd?: number;
  costRuns?: number;
}

export interface ExercisedMap {
  schema: 1;
  generatedAt: string;
  observedThrough: string;
  sourceRuns: string[];
  cases: Record<string, ExercisedCase>;
}

export function isExercisedMap(value: unknown): value is ExercisedMap {
  const map = value as ExercisedMap;
  return !!map && map.schema === 1 && typeof map.generatedAt === 'string' && typeof map.observedThrough === 'string'
    && Array.isArray(map.sourceRuns) && map.sourceRuns.every(run => typeof run === 'string')
    && !!map.cases && typeof map.cases === 'object' && Object.values(map.cases).every(entry => !!entry
      && Number.isSafeInteger(entry.observations) && Number.isSafeInteger(entry.withCommands)
      && Array.isArray(entry.commands) && entry.commands.every(command => typeof command === 'string'));
}

/** Parse an exercised map's text; throws on malformed input so callers fail closed. */
export function parseExercisedMap(text: string): ExercisedMap {
  const parsed = JSON.parse(text);
  if (!isExercisedMap(parsed)) throw new Error(`${EXERCISED_MAP_PATH}: not a schema-1 exercised map`);
  return parsed;
}

export interface ExercisedConsumers {
  /** Repository file -> case ids whose exercised closure contains it. */
  e2e: Map<string, Set<string>>;
  /** One case's exercised closure: file -> how it is reached (touchfile, import, skill bash via <file>, observed <command>, declared via <file>, host). */
  closure(caseId: string): Map<string, string>;
  /** Bins (repo paths) and compiled outfiles one recorded command invokes. */
  binsInCommand(command: string): string[];
  /** The tracked files a bin or compiled outfile runs. */
  commandFiles(command: string): string[];
  /** The observed map the consumers were built with. */
  map: ExercisedMap | null;
}

const SHELL_SHEBANG = /^#![^\n]*\b(?:ba|z|da)?sh\b/;
const MESSAGE_CALL = /^(?:echo|printf|say|warn|die|fail|err|log|info|note|_dc_row|row)\b/;
const CMD_START = /(?:^|[;|&({\x60]|\$\(|\b(?:then|do|else|exec|command|nohup|bash|sh|bun|node|timeout\s+\S+|env(?:\s+\w+=\S*)*|if|while|until|!|time))\s*"?$/;
const CMD_PREFIX = /(?:"?(?:\$\{?\w+\}?|\$\(dirname\s+"?\$0"?\)|~|\.)?(?:\/(?:[\w.@-]+\/)*|(?:[\w.@-]+\/)+))?"?$/;
const INTERPRETER = /\b(?:bash|sh|zsh|bun|node|eval|source|python3?)\b/;

/** Text between `$(`…`)` and backticks in a span: substitutions run even inside a message. */
function substitutions(span: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < span.length; i++) {
    if (span[i] === '\\') { i++; continue; }
    if (span[i] === '\x60') { const end = span.indexOf('\x60', i + 1); if (end < 0) break; out.push(`$(${span.slice(i + 1, end)})`); i = end; continue; }
    if (span[i] !== '$' || span[i + 1] !== '(') continue;
    let depth = 0, j = i + 1;
    for (; j < span.length; j++) { if (span[j] === '(') depth++; else if (span[j] === ')' && --depth === 0) break; }
    out.push(span.slice(i, j + 1));
    i = j;
  }
  return out;
}

/** Message calls (echo, printf, die …) are prose; their command substitutions still execute and are kept. */
function stripMessages(text: string): string {
  let out = '', i = 0;
  while (i < text.length) {
    const prev = i === 0 ? '\n' : text[i - 1]!;
    const call = /[\s;|&(\x60{]/.test(prev) ? MESSAGE_CALL.exec(text.slice(i, i + 8)) : null;
    if (!call) { out += text[i]; i++; continue; }
    let j = i + call[0].length, quote: string | null = null, depth = 0;
    while (j < text.length) {
      const c = text[j]!;
      if (c === '\\') { j += 2; continue; }
      if (quote) { if (c === quote) quote = null; else if (quote === '"' && c === '$' && text[j + 1] === '(') { depth++; j++; } else if (c === ')' && depth) depth--; j++; continue; }
      if (c === '"' || c === "'") { quote = c; j++; continue; }
      if (c === '$' && text[j + 1] === '(') { depth++; j += 2; continue; }
      if (c === ')' && depth) { depth--; j++; continue; }
      if (c === '\n' || c === ';' || c === '|' || c === '&' || c === ')') break;
      j++;
    }
    out += ` ${substitutions(text.slice(i, j)).join('; ')} `;
    i = j;
  }
  return out;
}

/**
 * Executable shell text: comments, case patterns and message calls are
 * prose. A heredoc an interpreter reads stays whole; an expanding (unquoted)
 * heredoc keeps its command substitutions; a quoted one fed to anything else
 * is dropped.
 */
export function executableShell(text: string): string {
  return stripMessages(text
    .replace(/^(.*?)<<-?\s*(['"]?)(\w+)\2([^\n]*)\n([\s\S]*?)\n\s*\3\s*$/gm, (whole, head: string, quote: string, _word: string, rest: string, body: string) =>
      INTERPRETER.test(head + rest) ? whole : quote ? head : [head, ...substitutions(body)].join('\n'))
    .split('\n').filter(line => !/^\s*#(?!!)/.test(line))
    .map(line => line.replace(/(^\s*|\bin\s+|;;\s*)[\w*."'-]+(?:\s*\|\s*[\w*."'-]+)*\)(?=\s|$)/g, '$1').replace(/\s#\s.*$/, ''))
    .join('\n'));
}

function commandPosition(before: string): boolean {
  const head = before.replace(CMD_PREFIX, '');
  return CMD_START.test(head) || (/\/$/.test(before) && /\b\w+="?$/.test(head));
}

/**
 * Consumers by exercised paths: a case consumes its touchfile matches, the
 * closure of its test file, the executable shell of its loaded skill
 * (template and generated SKILL.md) and of every bin, lib and script that
 * shell runs, and the bins its recorded trials invoked (`observed`). The
 * closure stops at `stopAt` (the full-gate files) and the global set,
 * which stay full.
 */
export function exercisedConsumers(maps: DependencyMaps, root: string, options: { observed: ExercisedMap | null; stopAt: readonly string[] }): ExercisedConsumers {
  const base = derivedDependencies(maps, root);
  const tracked = [...base.tracked];
  const texts = new Map<string, string>();
  const read = (file: string): string => {
    if (!texts.has(file)) {
      let text = '';
      try { if (base.tracked.has(file) && fs.statSync(path.join(root, file)).size < 3_000_000) text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { /* unreadable */ }
      texts.set(file, text);
    }
    return texts.get(file)!;
  };
  const isShell = (file: string) => !isCodeFile(file, read(file)) && (/\.sh$/.test(file) || file === 'setup' || SHELL_SHEBANG.test(read(file)));
  const dirs = new Set(tracked.flatMap(file => file.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  const expandRef = (ref: string): string[] => {
    const clean = ref.replace(/[.]+$/, '');
    if (base.tracked.has(clean)) return [clean];
    return dirs.has(clean) ? tracked.filter(file => file.startsWith(`${clean}/`)) : [];
  };
  const expanded = new Map<string, string[]>();
  const expand = (pattern: string): string[] => {
    if (!pattern.includes('*')) return base.tracked.has(pattern) ? [pattern] : [];
    if (!expanded.has(pattern)) expanded.set(pattern, tracked.filter(file => matchGlob(file, pattern)));
    return expanded.get(pattern)!;
  };
  const binByName = new Map<string, string>();
  for (const file of tracked.filter(file => file.startsWith('bin/') || file.startsWith('browse/bin/'))) {
    binByName.set(path.posix.basename(file), file);
    binByName.set(path.posix.basename(file).replace(/\.(?:ts|sh|js)$/, ''), file);
  }
  const binaries = [...read('scripts/build.sh').matchAll(/--compile\b[^\n]*?\s([\w./-]+\.ts)\s+--outfile\s+([\w./-]+)/g)]
    .map(match => ({ outfile: match[2]!, tree: match[1]!.startsWith('bin/') ? [match[1]!] : tracked.filter(file => matchGlob(file, `${path.posix.dirname(match[1]!)}/**`)) }));
  const outfileHit = (outfile: string, text: string) => text.includes(outfile)
    || (outfile === 'browse/dist/browse' && /\$B\b|\$\{B\}|find-browse/.test(text)) || (outfile === 'design/dist/design' && /\$D\b|\$\{D\}/.test(text));
  let scripts: Record<string, string> = {};
  try { scripts = JSON.parse(read('package.json')).scripts ?? {}; } catch { /* no package scripts */ }

  const shellEdges = (text: string, from: string, out: Set<string>) => {
    for (const match of text.matchAll(/gstack-[a-z0-9][a-z0-9-]*[a-z0-9](?:\.(?:sh|ts))?\b/g)) {
      const start = text.lastIndexOf('\n', match.index! - 1) + 1;
      const bin = binByName.get(match[0]);
      if (bin && commandPosition(text.slice(start, match.index))) out.add(bin);
    }
    for (const match of text.matchAll(/(?:bin|lib|scripts|browse|design|make-pdf)\/[\w.@-]+(?:\/[\w.@-]+)*/g)) {
      const before = text.slice(text.lastIndexOf('\n', match.index! - 1) + 1, match.index);
      if (/[\w.@-]$/.test(before)) continue;
      if (commandPosition(before) || /\bbun\s+(?:run\s+)?"?(?:\$\{?\w+\}?\/)?$/.test(before)) for (const file of expandRef(match[0])) out.add(file);
    }
    for (const match of text.matchAll(/(?:bin|lib|scripts|browse|design|make-pdf|hosts|capy|test\/fixtures|test\/helpers)\/[\w.@-]+(?:\/[\w.@-]+)*\.(?:json|jsonl|env|txt|ya?ml|toml|csv|tsv)\b/g)) for (const file of expandRef(match[0])) out.add(file);
    for (const match of text.matchAll(/(?:^|[\s;&|({])(?:\.|source)\s+([^;|&\n]+)/gm)) {
      for (const ref of match[1]!.matchAll(/(?:bin|lib|scripts)\/[\w.@-]+(?:\/[\w.@-]+)*\.sh\b/g)) for (const file of expandRef(ref[0])) out.add(file);
      const name = [...match[1]!.matchAll(/([\w.-]+\.sh|gstack-[\w.-]+)/g)].map(found => found[1]!).at(-1);
      if (!name) continue;
      const sibling = path.posix.join(path.posix.dirname(from), name);
      if (base.tracked.has(sibling)) out.add(sibling);
      else if (binByName.has(name)) out.add(binByName.get(name)!);
    }
    if (/(?:^|[\s;&|(])"?(?:\.|\$\{?\w+\}?)\/setup\b/m.test(text) && base.tracked.has('setup')) out.add('setup');
    for (const { outfile, tree } of binaries) if (outfileHit(outfile, text)) for (const file of tree) out.add(file);
    for (const match of text.matchAll(PACKAGE_RUN)) {
      const command = scripts[match[1]!];
      if (command) for (const ref of command.matchAll(REPO_PATH)) for (const file of expandRef(ref[1]!)) out.add(file);
    }
  };
  const edges = new Map<string, string[]>();
  const execRefs = (file: string): string[] => {
    if (edges.has(file)) return edges.get(file)!;
    const raw = read(file);
    const out = new Set<string>();
    if (raw && !(SELECTION_DATA_MODULES as readonly string[]).includes(file)) {
      if (isCodeFile(file, raw)) {
        try { for (const specifier of scanCodeImports(file, raw)) { const hit = resolveSpecifier(root, specifier, file); if (hit) out.add(hit); } }
        catch (error) { base.scanErrors.set(file, String(error)); }
        const code = raw.replace(/^#![^\n]*/, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        for (const match of code.matchAll(/['"\x60](?:\$\{[^}]+\}\/)?((?:bin|lib|scripts|browse|design|make-pdf|hosts|extension|model-overlays|agents|test\/helpers|test\/fixtures)\/[\w.@-]+(?:\/[\w.@-]+)*)['"\x60]/g)) for (const hit of expandRef(match[1]!)) out.add(hit);
        for (const match of code.matchAll(JOINED_PATH)) for (const hit of expandRef(`${match[1]}/${match[2]}`)) out.add(hit);
        if (/join\([^)\n]*['"]setup['"]\s*\)/.test(code) && base.tracked.has('setup')) out.add('setup');
        for (const { outfile, tree } of binaries) if (code.includes(`'${outfile}'`) || code.includes(`"${outfile}"`)) for (const hit of tree) out.add(hit);
      } else if (isShell(file)) {
        shellEdges(executableShell(raw), file, out);
      } else if (/\.(?:md|tmpl)$/.test(file)) {
        shellEdges(executableShell([...raw.matchAll(/\x60\x60\x60(?:bash|sh|shell)\n([\s\S]*?)\x60\x60\x60/g)].map(match => match[1]!).join('\n')), file, out);
      }
    }
    out.delete(file);
    edges.set(file, [...out]);
    return edges.get(file)!;
  };
  const stopped = new Map<string, boolean>();
  const stops = (file: string): boolean => {
    if (!stopped.has(file)) stopped.set(file, base.global.has(file) || options.stopAt.some(pattern => matchGlob(file, pattern)));
    return stopped.get(file)!;
  };
  const binsInCommand = (command: string): string[] => {
    const out = new Set<string>();
    const pty = command.startsWith('PTY:');
    for (const match of command.matchAll(/gstack-[a-z0-9-]*[a-z0-9](?:\.(?:sh|ts))?/g)) {
      let token = match[0];
      if (pty) while (token.length > 7 && !binByName.has(token)) { const cut = token.lastIndexOf('-'); token = cut > 6 ? token.slice(0, cut) : ''; }
      const at = match.index!;
      if (command[at - 1] === '/' && at >= 2 && /[\s"'\x60(]/.test(command[at - 2]!)) continue;
      const bin = binByName.get(token);
      if (bin) out.add(bin);
    }
    for (const match of command.matchAll(/browse\/bin\/([a-z-]+)/g)) { const bin = binByName.get(match[1]!); if (bin) out.add(bin); }
    for (const { outfile } of binaries) if (outfileHit(outfile, command) || (outfile === 'make-pdf/dist/pdf' && command.includes(outfile))) out.add(outfile);
    return [...out];
  };
  const commandFiles = (command: string) => base.tracked.has(command) ? [command] : binaries.find(binary => binary.outfile === command)?.tree ?? [];

  const hostIds = tracked.filter(file => /^hosts\/[\w-]+\.ts$/.test(file) && file !== 'hosts/index.ts').map(file => path.posix.basename(file, '.ts'));
  const closures = new Map<string, Map<string, string>>();
  const caseClosure = (id: string): Map<string, string> => {
    if (closures.has(id)) return closures.get(id)!;
    const patterns = maps.e2eTouchfiles[id] ?? [];
    const owners = patterns.filter(pattern => OWNER.test(pattern) && isPaidTestFile(pattern));
    const declared = patterns.flatMap(expand);
    const generated = declared.filter(file => file.endsWith('.tmpl')).map(file => file.replace(/\.tmpl$/, '')).filter(file => base.tracked.has(file));
    const touchfiles = new Set([...declared, ...generated]);
    const skillDoc = (file: string) => /\.(?:md|tmpl)$/.test(file);
    const seeds: Array<[string, string]> = [
      ...owners.map(file => [file, 'import'] as [string, string]),
      ...[...declared, ...generated].map(file => [file, skillDoc(file) ? 'skill' : `declared via ${file}`] as [string, string]),
      ...(options.observed?.cases[id]?.commands ?? []).flatMap(command => commandFiles(command).map(file => [file, `observed ${command}`] as [string, string])),
    ];
    const ownerText = owners.map(read).join('\n');
    for (const host of hostIds) {
      if (new RegExp(`['"\x60]${host}['"\x60]|--host[ =]${host}\\b`).test(ownerText)) for (const file of [`hosts/${host}.ts`, ...expand(`hosts/${host}/**`)]) seeds.push([file, 'host']);
    }
    const reached = new Map<string, string>();
    const queue = seeds.filter(([file]) => base.tracked.has(file));
    for (let head = 0; head < queue.length; head++) {
      const [file, label] = queue[head]!;
      if (reached.has(file)) continue;
      reached.set(file, touchfiles.has(file) ? 'touchfile' : label);
      if (stops(file)) continue;
      for (const next of execRefs(file)) {
        if (reached.has(next) || (/\.test\.tsx?$/.test(next) && isPaidTestFile(next))) continue;
        queue.push([next, label === 'skill' ? `skill bash via ${next}` : label]);
      }
    }
    closures.set(id, reached);
    return reached;
  };
  const e2e = new Map<string, Set<string>>();
  for (const id of Object.keys(maps.e2eTouchfiles)) {
    for (const file of caseClosure(id).keys()) {
      if (!e2e.has(file)) e2e.set(file, new Set());
      e2e.get(file)!.add(id);
    }
  }
  return { e2e, closure: caseClosure, binsInCommand, commandFiles, map: options.observed };
}

const exercisedCache = new Map<string, ExercisedConsumers>();

/** The exercised consumers of the checkout at `root` with its committed map, computed once per process; throws when the map is malformed. */
export function checkoutExercisedConsumers(maps: DependencyMaps, root: string, stopAt: readonly string[]): ExercisedConsumers {
  const key = `${root}\0${Object.keys(maps.e2eTouchfiles).length}`;
  if (!exercisedCache.has(key)) {
    const observed = parseExercisedMap(fs.readFileSync(path.join(root, EXERCISED_MAP_PATH), 'utf8'));
    exercisedCache.set(key, exercisedConsumers(maps, root, { observed, stopAt }));
  }
  return exercisedCache.get(key)!;
}
