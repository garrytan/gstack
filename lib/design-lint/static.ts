/**
 * The static tier: collect files, group them into contexts (a page with the
 * stylesheets it links, or a directory of components), build the token table,
 * run every rule family, then apply the page's waivers.
 *
 * Ported from Nutlope/hallmark's sloplint.mjs (collectFiles, buildContext,
 * shareProjects; MIT, see NOTICE.md).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LintContext, SharedStyles, CssFile } from './context';
import { buildTokens, isTokenRule, parseCss, stripComments, type CssRule, type Tokens } from './css';
import { docKindOf, getAttr, parseDoc, type Doc } from './html';
import { oneLine, relPath, Reporter, type Finding } from './report';
import { FAMILIES } from './rules';
import { setTwTokens, twVariants } from './tailwind';
import { applyWaivers, findWaivers, resolveWaivers, suspectedRules, type WaiverSet } from './waivers';

export interface StaticOptions {
  scope?: 'page' | 'component';
  job?: string | null;
  cwd?: string;
  /** Receives a line for every file skipped or rule that threw; defaults to stderr. */
  warn?: (line: string) => void;
}

export interface StaticResult {
  files: string[];
  contexts: LintContext[];
  findings: Finding[];
}

/** A source file the lint did not read, and why; it is reported, because a page the lint could not read is not a pass. */
export interface Skipped { file: string; kind: 'unreadable' | 'unparseable' | 'oversize'; why: string }

/** The static tier before waivers: every context with the findings its rule families reported, so a caller can add the render tier's findings and settle the page's waivers once over both. */
export interface RawStaticResult {
  files: string[];
  contexts: LintContext[];
  raw: Finding[][];
  /** One internal-error finding per skipped source file. */
  skipped: Finding[];
}

const BUILD_DIRS = new Set(['dist', 'build', 'coverage']);

/** A source file past this size is a bundle or a generated artefact, not a page to read; it is skipped with a warning so the lint answers in bounded time. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Every .css page and component file under the paths; node_modules, dot folders and (below the top) build output are skipped, a link cycle is walked once, and a file over MAX_FILE_BYTES is skipped with a warning. */
export function collectFiles(paths: string[], warn: (l: string) => void = () => {}, skipped: Skipped[] = []): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const visit = (p: string, top: boolean) => {
    let abs = path.resolve(p);
    let st: fs.Stats;
    try { abs = fs.realpathSync(abs); st = fs.statSync(abs); } catch { warn(`design-lint: cannot read ${p}`); if (top) skipped.push({ file: realDir(abs), kind: 'unreadable', why: 'it cannot be read' }); return; }
    if (seen.has(abs)) return;
    if (st.isDirectory()) {
      seen.add(abs);
      const base = path.basename(abs);
      if (base === 'node_modules' || base.startsWith('.') || (!top && BUILD_DIRS.has(base))) return;
      for (const e of fs.readdirSync(abs).sort()) visit(path.join(abs, e), false);
      return;
    }
    if (path.extname(abs).toLowerCase() !== '.css' && !docKindOf(abs)) return;
    seen.add(abs);
    if (st.size > MAX_FILE_BYTES) {
      const why = `${Math.round(st.size / 1024 / 1024)} MB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`;
      warn(`design-lint: skipped ${p} (${why})`);
      skipped.push({ file: abs, kind: 'oversize', why });
      return;
    }
    files.push(abs);
  };
  for (const p of paths) visit(p, true);
  return files;
}

/**
 * A local stylesheet reference as a path: relative to the referring file, or
 * for a root-relative href (`/css/site.css`, the common form on a real site)
 * relative to the lint root the page was found under. Schemes and
 * protocol-relative URLs are not local.
 */
export function resolveRef(href: string | null, from: string, root: string | null, bound: string | null = null): string | null {
  if (!href || /^(?:[a-z]+:|\/\/)/i.test(href)) return null;
  const ref = href.split(/[?#]/)[0];
  if (!ref) return null;
  const within = (abs: string, top: string) => abs === top || abs.startsWith(top + path.sep);
  const inside = (abs: string, top: string) => {
    if (!within(abs, top)) return false;
    try { return within(fs.realpathSync(abs), realDir(top)); } catch { return true; }
  };
  if (ref.startsWith('/')) {
    if (!root) return null;
    const abs = path.join(root, ref);
    return inside(abs, root) ? abs : null;
  }
  const abs = path.resolve(from, ref);
  const top = projectRoot(from) ?? bound;
  return top && !inside(abs, top) ? null : abs;
}

export function importsOf(css: string, from: string, root: string | null = null, bound: string | null = null): string[] {
  const out: string[] = [];
  for (const m of stripComments(css).matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/gi)) {
    const ref = resolveRef(m[1], from, root, bound);
    if (ref) out.push(ref);
  }
  return out;
}

export function linksOf(doc: Doc, from: string, root: string | null = null, bound: string | null = null): string[] {
  const out: string[] = [];
  for (const t of doc.tags) {
    if (t.close || t.name !== 'link' || !/stylesheet/i.test(getAttr(t.attrs, 'rel') || '')) continue;
    const ref = resolveRef(getAttr(t.attrs, 'href'), from, root, bound);
    if (ref) out.push(ref);
  }
  return out;
}

/** The lint root a file was collected under: the longest top-level directory that contains it, else its own directory. */
const rootOf = (file: string, roots: string[]): string =>
  roots.filter((r) => file.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0] ?? path.dirname(file);

interface CssRead { raw: string; rules: CssRule[]; imports: string[] }

/** Stylesheets read once per run: a bundle shared by forty pages is parsed once, not forty times. */
class CssCache {
  private readonly files = new Map<string, CssRead | null>();
  constructor(readonly roots: string[], readonly warn: (l: string) => void, readonly skipped: Skipped[] = [], readonly bound: string | null = null) {}
  read(f: string): CssRead | null {
    if (this.files.has(f)) return this.files.get(f)!;
    let out: CssRead | null = null;
    try {
      const size = fs.statSync(f).size;
      if (size > MAX_FILE_BYTES) { const why = `${Math.round(size / 1024 / 1024)} MB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`; this.warn(`design-lint: skipped ${f} (${why})`); this.skipped.push({ file: f, kind: 'oversize', why }); this.files.set(f, null); return null; }
      const raw = fs.readFileSync(f, 'utf8');
      out = { raw, rules: parseCss(raw, f), imports: importsOf(raw, path.dirname(f), rootOf(f, this.roots), this.bound) };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') this.warn(`design-lint: skipped ${f}, not found`);
      else { const why = code ? `it cannot be read (${code})` : `it could not be parsed (${(e as Error).message})`; this.warn(`design-lint: skipped ${f}, ${why}`); this.skipped.push({ file: f, kind: code ? 'unreadable' : 'unparseable', why }); }
    }
    this.files.set(f, out);
    return out;
  }
}

/** Follow @import and <link rel=stylesheet> from the group's files to every local .css they reach. */
function attachStylesheets(cssFiles: CssFile[], rules: CssRule[], pending: string[], inGroup: Set<string>, cache: CssCache): void {
  while (pending.length) {
    const p = pending.shift()!;
    if (inGroup.has(p) || path.extname(p).toLowerCase() !== '.css') continue;
    inGroup.add(p);
    const got = cache.read(p);
    if (!got) continue;
    cssFiles.push({ file: p, raw: got.raw });
    for (const rule of got.rules) rules.push(rule);
    pending.push(...got.imports);
  }
}

export function buildContext(key: string, cssList: string[], docList: Doc[], opts: StaticOptions, cache: CssCache): LintContext {
  const cssFiles: CssFile[] = [];
  const rules: CssRule[] = [];
  const inGroup = new Set<string>([...cssList, ...docList.map((d) => d.file)]);
  const pending: string[] = [];
  for (const f of cssList) {
    const got = cache.read(f);
    cssFiles.push({ file: f, raw: got?.raw ?? '' });
    if (got) { for (const rule of got.rules) rules.push(rule); pending.push(...got.imports); }
  }
  for (const doc of docList) {
    const root = rootOf(doc.file, cache.roots);
    for (const st of doc.styles) {
      try { for (const rule of parseCss(st.css, doc.file, st.lineOffset)) rules.push(rule); } catch (e) { cache.warn(`design-lint: skipped a <style> block in ${doc.file}, it could not be parsed (${(e as Error).message})`); cache.skipped.push({ file: doc.file, kind: 'unparseable', why: `a <style> block could not be parsed (${(e as Error).message})` }); continue; }
      pending.push(...importsOf(st.css, path.dirname(doc.file), root, cache.bound));
    }
    pending.push(...linksOf(doc, path.dirname(doc.file), root, cache.bound));
  }
  attachStylesheets(cssFiles, rules, pending, inGroup, cache);
  const allCss = cssFiles.map((c) => c.raw).join('\n') + '\n' + docList.map((d) => d.styles.map((st) => st.css).join('\n')).join('\n');
  return {
    key, rules, tokens: buildTokens(rules), docs: docList, cssFiles, allCss,
    scope: opts.scope ?? 'page', job: opts.job ?? null,
    tokensOnly: !docList.length && rules.length > 0 && rules.every(isTokenRule),
    shared: null, twTokens: null, cache: {},
  };
}

/** The .css files a page reaches through <link> and @import, transitively. */
function linkedCss(page: Doc, cache: CssCache): Set<string> {
  const linked = new Set<string>();
  const root = rootOf(page.file, cache.roots);
  const queue = [...linksOf(page, path.dirname(page.file), root, cache.bound), ...page.styles.flatMap((st) => importsOf(st.css, path.dirname(page.file), root, cache.bound))];
  while (queue.length) {
    const q = queue.shift()!;
    if (linked.has(q) || path.extname(q).toLowerCase() !== '.css') continue;
    const got = cache.read(q);
    if (!got) continue;
    linked.add(q);
    queue.push(...got.imports);
  }
  return linked;
}

/**
 * One context per page (with its own stylesheets), plus one per directory for
 * components and unlinked CSS. A stylesheet some page links, from any
 * directory, belongs to that page and is not linted again on its own.
 */
export function groupContexts(files: string[], opts: StaticOptions, warn: (l: string) => void, roots: string[] = [], skipped: Skipped[] = []): LintContext[] {
  const cache = new CssCache(roots, warn, skipped, realDir(opts.cwd ?? process.cwd()));
  const groups = new Map<string, { css: string[]; pages: Doc[]; parts: Doc[] }>();
  for (const f of files) {
    const dir = path.dirname(f);
    if (!groups.has(dir)) groups.set(dir, { css: [], pages: [], parts: [] });
    const g = groups.get(dir)!;
    if (path.extname(f).toLowerCase() === '.css') { g.css.push(f); continue; }
    try {
      const doc = parseDoc(f, fs.readFileSync(f, 'utf8'));
      (doc.kind === 'html' ? g.pages : g.parts).push(doc);
    } catch (e) {
      const kind = (e as NodeJS.ErrnoException).code ? 'unreadable' : 'unparseable';
      const why = kind === 'unreadable' ? `it cannot be read (${(e as NodeJS.ErrnoException).code})` : `it could not be parsed (${(e as Error).message})`;
      warn(`design-lint: skipped ${f}, ${why}`);
      skipped.push({ file: f, kind, why });
    }
  }
  const linkedBy = new Map<Doc, Set<string>>();
  const owned = new Set<string>();
  for (const g of groups.values()) for (const page of g.pages) {
    const linked = linkedCss(page, cache);
    linkedBy.set(page, linked);
    for (const c of linked) owned.add(c);
  }
  const contexts: LintContext[] = [];
  for (const [dir, g] of groups) {
    const free = g.css.filter((c) => !owned.has(c));
    if (!g.pages.length) { if (free.length || g.parts.length) contexts.push(buildContext(dir, free, g.parts, opts, cache)); continue; }
    const used = new Set<string>();
    for (const page of g.pages) {
      const linked = linkedBy.get(page)!;
      const own = g.pages.length === 1 ? g.css.filter((c) => !owned.has(c) || linked.has(c)) : g.css.filter((c) => linked.has(c));
      own.forEach((c) => used.add(c));
      contexts.push(buildContext(page.file, own, [page], opts, cache));
    }
    const rest = free.filter((c) => !used.has(c));
    if (rest.length || g.parts.length) contexts.push(buildContext(dir, rest, g.parts, opts, cache));
  }
  return contexts;
}

/** The nearest directory above dir holding a package.json or a .git entry: the project a relative stylesheet href may not climb out of. Null outside any project, where a relative href is bounded by the working directory the lint runs in instead (only .css files are read, and only their declarations are printed). */
function projectRoot(dir: string): string | null {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json')) || fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/**
 * Within one package, a directory of components without its own stylesheet
 * borrows the project's tokens and its global state styles, so a focus ring
 * declared once in globals.css is not reported missing on every component.
 */
export function shareProjects(contexts: LintContext[]): void {
  const byRoot = new Map<string, LintContext[]>();
  for (const ctx of contexts) {
    const root = projectRoot(fs.existsSync(ctx.key) && fs.statSync(ctx.key).isDirectory() ? ctx.key : path.dirname(ctx.key));
    if (!root) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(ctx);
  }
  for (const list of byRoot.values()) {
    const parts = list.filter((c) => !c.cssFiles.length && c.docs.length && c.docs.every((d) => d.kind !== 'html'));
    if (!parts.length || parts.length === list.length) continue;
    const tokens: Tokens = {};
    const shared: SharedStyles = { focus: false, active: false, disabled: false, reducedMotion: false };
    for (const c of list) {
      Object.assign(tokens, c.tokens);
      const tv = twVariants(c);
      const sel = (re: RegExp) => c.rules.some((r) => re.test(r.selector));
      shared.focus = shared.focus || sel(/:focus/) || [...tv].some((v) => /^focus/.test(v));
      shared.active = shared.active || sel(/:active/) || tv.has('active');
      shared.disabled = shared.disabled || sel(/:disabled|\[disabled\]|aria-disabled/) || tv.has('disabled') || tv.has('aria-disabled');
      shared.reducedMotion = shared.reducedMotion || /prefers-reduced-motion/i.test(stripComments(c.allCss)) || tv.has('motion-reduce') || tv.has('motion-safe');
    }
    for (const c of list) c.shared = shared;
    for (const c of parts) setTwTokens(c, { ...tokens, ...c.tokens });
  }
}

/**
 * The waiver comments of a context, in its documents and every stylesheet it reads, weighed against what its rules found.
 * A stylesheet's claims answer for that stylesheet on every page that links it. A context that is one html page keeps
 * page semantics under either scope: its claims answer for the page and the stylesheets it links. In a directory of
 * components (under either scope) each file's claims answer for that file alone, weighed against its own text and its
 * own suspected rules, with the house-style count per file.
 */
export function contextWaivers(ctx: LintContext, cwd: string, findings: Finding[] = []): WaiverSet {
  const sheets = ctx.cssFiles.flatMap((c) => findWaivers(c.file, c.raw));
  if (ctx.docs.length <= 1 && ctx.docs.every((d) => d.kind === 'html')) return resolveWaivers([...ctx.docs.flatMap((d) => findWaivers(d.file, d.raw)), ...sheets], ctx.docs.map((d) => d.text).join(' '), cwd, suspectedRules(findings));
  const sets = [
    ...ctx.docs.map((d) => { const file = oneLine(relPath(d.file, cwd)); return resolveWaivers(findWaivers(d.file, d.raw), d.text, cwd, suspectedRules(findings.filter((f) => f.file === file)), true); }),
    resolveWaivers(sheets, '', cwd, suspectedRules(findings)),
  ];
  return { accepted: new Map(sets.flatMap((s) => [...s.accepted])), refused: sets.flatMap((s) => s.refused) };
}

/** A context's findings with its waivers applied: waived grades, refusals and the house-style note. */
export function settleContext(ctx: LintContext, findings: Finding[], cwd: string): Finding[] {
  return applyWaivers(findings, contextWaivers(ctx, cwd, findings));
}

/** Run every rule family over every context, without waivers. */
export function lintStaticRaw(paths: string[], opts: StaticOptions = {}): RawStaticResult {
  const warn = opts.warn ?? ((l: string) => console.error(l));
  const cwd = realDir(opts.cwd ?? process.cwd());
  const skippedFiles: Skipped[] = [];
  const files = collectFiles(paths, warn, skippedFiles);
  const roots = paths.map((p) => { try { const real = fs.realpathSync(p); return fs.statSync(real).isDirectory() ? real : path.dirname(real); } catch { return null; } }).filter((p): p is string => p !== null);
  const contexts = groupContexts(files, opts, warn, roots, skippedFiles);
  shareProjects(contexts);
  const raw: Finding[][] = [];
  for (const ctx of contexts) {
    const reporter = new Reporter(ctx.scope, cwd);
    for (const family of FAMILIES) {
      try { family.run(ctx, reporter); } catch (e) {
        warn(`design-lint: internal error in ${family.name} rules for ${ctx.key}: ${(e as Error).message}`);
        reporter.report('internal-error', ctx.docs[0]?.file ?? ctx.cssFiles[0]?.file ?? ctx.key, 1, `the ${family.name} rules threw and did not run: ${(e as Error).message}`);
      }
    }
    raw.push(reporter.findings);
    ctx.cache = {};
    for (const doc of ctx.docs) doc.cache = {};
  }
  const skippedReporter = new Reporter(opts.scope ?? 'page', cwd);
  for (const s of new Map(skippedFiles.map((s) => [s.file + '|' + s.why, s])).values()) skippedReporter.report('internal-error', s.file, 1, `skipped: ${s.why}; a page the lint could not read is not a pass`, { fix: s.kind === 'unreadable' ? 'check the path' : s.kind === 'unparseable' ? 'fix the markup the parser stopped on' : 'split the file, or lint the page that links it' });
  return { files, contexts, raw, skipped: skippedReporter.findings };
}

/** A path's real path, so a cwd or lint root reached through a symlink still matches the files collected under it; a path that cannot be resolved (missing, a dangling or looping link, no permission) keeps its unresolved tail under the real path of its nearest resolvable ancestor. */
export const realDir = (p: string): string => {
  const tail: string[] = [];
  for (let dir = path.resolve(p); ; dir = path.dirname(dir)) {
    try { return path.join(fs.realpathSync(dir), ...tail.reverse()); } catch {}
    if (path.dirname(dir) === dir) return path.resolve(p);
    tail.push(path.basename(dir));
  }
};

export function lintStatic(paths: string[], opts: StaticOptions = {}): StaticResult {
  const cwd = realDir(opts.cwd ?? process.cwd());
  const { files, contexts, raw, skipped } = lintStaticRaw(paths, opts);
  return { files, contexts, findings: [...contexts.flatMap((ctx, i) => settleContext(ctx, raw[i], cwd)), ...skipped] };
}
