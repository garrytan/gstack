/**
 * review-depth — the one policy owner for how much review a /ship run dispatches
 * (docs/review-policy.md#review-depth). A pure function from the changed paths and
 * their line counts, gstack-diff-scope flags, the base registry's generated outputs,
 * the gate scan and the pass history to a diff class, a review depth (light,
 * standard, full), the next step of the loop and the reviewers that step
 * dispatches, each with its effort tier and the pathspecs it leaves out. Git reads
 * live in lib/review-collect.ts; bin/gstack-review-plan prints the plan; the
 * review-army resolver and the skills read the same definitions.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResultCodeName } from './result-codes';
import { matchesAny } from './ship-policy';
import { decodeCharRefs, DOC_SECRET_LINE, matchRisk, RISK_CLASSES, RISK_RULES, SECRET_PATH, secretPath, SVG_PATH, svgActive, TOKEN_PATH, type RiskClass } from './review-risk';

export type DiffClass = 'docs' | 'tests' | 'code' | 'gate';
export type PathClass = 'docs' | 'tests' | 'code';
export type Depth = 'light' | 'standard' | 'full';
export type Effort = 'light' | 'medium' | 'full' | 'host';
export type Role = 'specialist' | 'red-team' | 'adversarial-native' | 'outside-voice' | 'fix-check' | 'targeted';
export type Step = 'full' | 'scoped' | 'fix-check' | 'voices' | 'platform' | 'targeted' | 'done' | 'stop';

export const SPECIALISTS = ['testing', 'maintainability', 'security', 'performance', 'data-migration', 'api-contract', 'design', 'simplification', 'state-machines'] as const;
export type Specialist = (typeof SPECIALISTS)[number];
/** The review rounds one /ship invocation runs (R51): a full, scoped or fix-check step is a round. */
export const FULL_PASS_CAP = 2;
export const SMALL_DIFF_LINES = 50;
export const RED_TEAM_LINES = 200;
export const LARGE_DIFF_LINES = 100;
/** The largest fix range, in runtime lines, a pass 2 after a blocking fix reviews as a scoped pass (GSTA-152 D6); a starting value. */
export const SCOPED_RANGE_LINES = 150;
/** The checklists the batched specialist always reads on code and gate class, whatever the depth or scope (GSTA-167 part 2). */
export const LIGHT_FIXED: readonly Specialist[] = ['testing', 'security'];
/** The checklists the batched specialist adds when scope asks; maintainability, performance and simplification are read only when forced. */
export const BATCH_SCOPED: readonly Specialist[] = ['data-migration', 'api-contract', 'design', 'state-machines'];
/**
 * Each blocking role's effort (GSTA-167 part 3, CREW 30c): specialists at medium, which is how the no-loss controls ran
 * them; the Red Team, the native adversarial pass and the fix-check at full (the lane's reasoning); the outside voice at
 * its own provider's. Light's batched specialist carries the Red Team prompt, so it stays full.
 */
export const ROLE_EFFORT = { specialist: 'medium', 'red-team': 'full', 'adversarial-native': 'full', 'fix-check': 'full', 'outside-voice': 'host', targeted: 'full' } as const satisfies Record<Role, Effort>;
/** Why light with runtime above 0 keeps the native adversarial pass as its own dispatch. */
export const LIGHT_ADVERSARIAL_REASON = 'backtest inconclusive (GSTA-147 D5)';
const CLASS_RANK: Record<DiffClass, number> = { docs: 0, tests: 1, code: 2, gate: 3 };
const DEPTH_RANK: Record<Depth, number> = { light: 0, standard: 1, full: 2 };

const AGENT_PROSE = [/(^|\/)SKILL\.md(\.tmpl)?$/, /(^|\/)sections\//, /^scripts\/resolvers\//, /^docs\/[^/]*-policy\.md$/, /^docs\/(captain|unattended|pregate)\.md$/, /(^|\/)DRIVER\.md(\.tmpl)?$/, /(^|\/)templates\//, /(^|\/)(AGENTS|CLAUDE|ETHOS)\.md$/, /(^|\/)specialists\//, /(^|\/)checklist\.md$/, /^\.gstack\//];
/** gstack-diff-scope's TEST_PATH_RE (the test-bootstrap rule), plus fixture directories. */
const TEST_PATH = [/(^|\/)(tests?|spec|__tests__)\/|(^|\/)tests?\.py$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|ts|js|exs|dart)$|\.(test|spec)\.[jt]sx?$|_spec\.rb$|Test\.(java|kt)$/, /(^|\/)fixtures?\//];
const DOC_PATH = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
/** Release metadata a version stamp writes: never a reason for review depth on its own. */
const RELEASE_METADATA = [/^CHANGELOG\.md$/, /^VERSION$/, /^agents-digest\//];
/** The harness pins scripts/bump-harness-version.ts writes per harness file: code, though their paths repeat a test/ segment. */
const HARNESS_PINS = /^scripts\/harness-pins\//;
/** Gate paths, the review-depth machinery included: an edit to how much review runs gets the most review. */
const GATE_PATH = [
  /(^|\/)\.github\/workflows\//, SECRET_PATH, /state-root/, /(^|\/)(pregate|gate|ship-receipt|ship-policy)[^/]*\.(ts|sh|json)$/, /(^|\/)bin\/gstack-(pregate|gate|ship-receipt|verify-gate|ci-gate)$/,
  /^lib\/review-(depth|collect|scope|targeted|risk|exclude)\.ts$/, /^lib\/redact-(engine|patterns)\.ts$/, /^lib\/default-base\.ts$/, /^review\/specialists\/targeted\.md$/, /^bin\/gstack-review-plan$/, /^lib\/ship-queue[^/]*\.ts$/, /^lib\/regen\.ts$/, /^\.gstack\/(generated|always-run)\.json$/, /^ship\/sections\/(review-army|adversarial)\.md\.tmpl$/, /^scripts\/resolvers\/review-army\.ts$/,
];

/** The path rules lib/review-exclude.ts keeps a matched file for: a gate path, agent prose, or a data-shaped config file. */
export const isGatePath = (p: string) => GATE_PATH.some(r => r.test(p));
export const isAgentProse = (p: string) => AGENT_PROSE.some(r => r.test(p));
export const isDataConfig = (p: string) => DATA_CONFIG.some(r => r.test(p));

/** Binary data, media and run logs (HARN-1: committed sqlite ledgers, trial logs): data by path wherever they sit, never code, consumed or not. */
export const BINARY_DATA_PATH = /\.(sqlite3?|db|duckdb|parquet|arrow|feather|avro|orc|npy|npz|h5|hdf5|pdf|mp3|mp4|mov|wav|webm|log|out)$|(^|\/)logs\/[^/.]+$/i;
/** Data files: JSON, CSV, TSV and raster images. YAML and TOML are never data here: deploy configs and API specs stay code. An SVG is data only as a drawing (svgDrawing); executable SVG stays code. */
export const DATA_PATH = /\.(json|jsonl|ndjson|csv|tsv|png|jpe?g|gif|webp|bmp|ico|avif)$/i;
/** Data-shaped files tools read by convention, with no code naming them: always code. */
const DATA_CONFIG = [
  /(^|\/)\.github\//, /(^|\/)config\//, /(^|\/)\.[^/]+$/, /(^|\/)[^/]+\.config\.[^/]+$/, HARNESS_PINS,
  /(^|\/)(package|package-lock|npm-shrinkwrap|composer|deno|jsr|tsconfig[^/]*|jsconfig[^/]*|manifest|app|vercel|netlify|firebase|renovate|turbo|nx|lerna|biome|angular|nest-cli|lint-staged|components|pyrightconfig|cdk|serverless|appsettings[^/]*)\.json$/i,
];

/**
 * The SVG elements a chart is drawn with, lowercased, under any namespace prefix: shapes, text, paint servers, clip paths,
 * filters (feImage loads a document, so it is left out), CSS, and the RDF metadata plotting libraries write. No script,
 * foreignObject, link, animation or embedded document.
 */
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'title', 'desc',
  'metadata', 'clippath', 'mask', 'pattern', 'marker', 'lineargradient', 'radialgradient', 'stop', 'style', 'image', 'filter',
  'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feconvolvematrix', 'fediffuselighting', 'fedisplacementmap', 'fedistantlight',
  'fedropshadow', 'feflood', 'fefunca', 'fefuncb', 'fefuncg', 'fefuncr', 'fegaussianblur', 'femerge', 'femergenode', 'femorphology', 'feoffset',
  'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
  'rdf', 'work', 'agent', 'type', 'date', 'format', 'creator', 'description', 'license',
]);
/** Markup a drawing may hold besides elements: comments, CDATA, the XML declaration, and a DOCTYPE that names no document but W3C's SVG DTD. */
const SVG_MARKUP = /^<(?:!--|!\[CDATA\[|\?xml\s|!DOCTYPE\s+svg(?:\s+PUBLIC\s+(["'])-\/\/W3C\/\/DTD SVG [\w .]+\/\/EN\1\s+(["'])https?:\/\/www\.w3\.org\/[\w.\/-]+\.dtd\2)?\s*>)/i;
/**
 * What a drawing never holds: a named entity beyond the five XML ones, a backslash (a CSS escape such as @\69mport), a CSS
 * import, a url() to another document, a CSS expression or binding.
 */
export const SVG_REFUSED = [/&(?!(?:amp|lt|gt|quot|apos);)/, /\\/, /@import/i, /url\((?!\s*#|['"]\s*#)/i, /expression\s*\(/i, /-moz-binding|\bbehavior\s*:/i];
/** A drawing's CSS, a style element's text or a style attribute's value, holds declarations only: no @ rule and no function but url(#id). */
const SVG_STYLE_OPEN = /<(?:[A-Za-z_][\w.-]*:)?style\b/gi;
const SVG_STYLE_CLOSE = /^<\/(?:[A-Za-z_][\w.-]*:)?style[ \t\n\r]*>/i;
/**
 * A style element's opening tag, read as quoted name="value" pairs separated by the ASCII whitespace XML and HTML share: any
 * other shape (a value holding < or >, an unquoted or valueless attribute, />, another space) refuses, so it cannot hide a closing tag.
 */
const SVG_STYLE_TAG = /^<(?:[A-Za-z_][\w.-]*:)?style(?:[ \t\n\r]+[\w.:-]+[ \t\n\r]*=[ \t\n\r]*(?:"[^"<>]*"|'[^'<>]*'))*[ \t\n\r]*>/i;
/** An element name, ended by ASCII whitespace, / or >: a non-ASCII character in the name (a prefix such as gé:) refuses rather than reading as its ASCII start. */
const SVG_TAG_NAME = /^<\/?(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(?=[ \t\n\r/>]|$)/;
/** Every name= in the text, non-ASCII letters included so a prefix such as xé:href is read whole and refused. */
const SVG_ATTR = /(?<![\w.:\-\u0080-\uffff])([A-Za-z_\u0080-\uffff][\w.:\-\u0080-\uffff]*)\s*=\s*(?=(?:"([^"]*)"|'([^']*)'|([^\s"'<>=]+)))/g;
const SVG_CSS_REF = /url\(\s*(['"]?)#[\w.:-]*\1\s*\)/gi;
const SVG_CSS_REFUSED = /[@(]/;
/** An href or src value a drawing may hold: a same-document reference, or a raster image inline. */
const SVG_HREF = /^\s*(?:#|data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]*$)/i;

/**
 * Whether an SVG's whole text is a drawing (GST-911): every element in SVG_ELEMENTS, no event handler, every href or src a
 * same-document reference or an inline raster image, CSS of declarations only, and nothing SVG_REFUSED names, read after character references are
 * decoded. Every name= in the text is read (SVG_ATTR), so a stray quote cannot hide a later attribute inside its value, and a name
 * holding a non-ASCII character refuses, like an element name (SVG_TAG_NAME); an unquoted value
 * stops at the next =, which keeps the scan linear. A style element's opening tag is read quote by quote (SVG_STYLE_TAG), and its CSS is walked with indexOf to its closing tag over the raw
 * text, so a character reference cannot fake a closing tag or a comment, and any & in it refuses (GST-940). Comments and CDATA are
 * read as CSS, so neither can hide a closing tag and an HTML-only comment end (<!--> or --!>) exposes nothing unread; any other
 * markup inside it, or a style element that never closes, refuses. Anything else, an SVG that can run code included, stays code.
 */
export function svgDrawing(text: string): boolean {
  const t = decodeCharRefs(text);
  if (SVG_REFUSED.some(r => r.test(t)) || svgActive(t)) return false;
  const cssDrawing = (css: string) => !SVG_CSS_REFUSED.test(css.replace(SVG_CSS_REF, ''));
  for (let at = 0; ;) {
    SVG_STYLE_OPEN.lastIndex = at;
    const open = SVG_STYLE_OPEN.exec(text);
    if (!open) break;
    const tag = SVG_STYLE_TAG.exec(text.slice(open.index, open.index + 4096));
    if (!tag) return false;
    let i = open.index + tag[0].length;
    let css = '';
    for (;;) {
      const lt = text.indexOf('<', i);
      if (lt === -1) return false;
      css += text.slice(i, lt);
      const [start, close] = text.startsWith('<!--', lt) ? [lt + 4, '-->'] : text.startsWith('<![CDATA[', lt) ? [lt + 9, ']]>'] : [-1, ''];
      if (start !== -1) {
        const end = text.indexOf(close, start);
        if (end === -1) return false;
        css += ' ' + text.slice(start, end) + ' ';
        i = end + 3;
      } else if (SVG_STYLE_CLOSE.test(text.slice(lt, lt + 256))) {
        at = lt + 1;
        break;
      } else return false;
    }
    if (css.includes('&') || !cssDrawing(css)) return false;
  }
  for (let at = t.indexOf('<'); at !== -1; at = t.indexOf('<', at + 1)) {
    if (SVG_MARKUP.test(t.slice(at, at + 512))) continue;
    const tag = SVG_TAG_NAME.exec(t.slice(at, at + 256));
    if (!tag || !SVG_ELEMENTS.has(tag[1]!.toLowerCase())) return false;
  }
  for (const m of t.matchAll(SVG_ATTR)) {
    if (/[^\x00-\x7f]/.test(m[1]!)) return false;
    const local = m[1]!.slice(m[1]!.lastIndexOf(':') + 1).toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (local.startsWith('on') || ((local === 'href' || local === 'src') && !SVG_HREF.test(value)) || (local === 'style' && !cssDrawing(value))) return false;
  }
  return true;
}

/** A hash of the constants and patterns that decide a depth, not of this file's bytes: a comment edit keeps it, a threshold edit changes it. */
export const DEPTH_RULES = createHash('sha256').update(JSON.stringify({
  RISK_RULES, SMALL_DIFF_LINES, RED_TEAM_LINES, LARGE_DIFF_LINES, FULL_PASS_CAP, LIGHT_FIXED, BATCH_SCOPED, SCOPED_RANGE_LINES, ROLE_EFFORT, SVG_ELEMENTS: [...SVG_ELEMENTS],
  patterns: Object.entries({ BINARY_DATA_PATH: [BINARY_DATA_PATH], GATE_PATH, AGENT_PROSE, TEST_PATH, RELEASE_METADATA, DOC_PATH: [DOC_PATH], DATA_PATH: [DATA_PATH], DATA_CONFIG, SVG_MARKUP: [SVG_MARKUP], SVG_REFUSED, SVG_HREF: [SVG_HREF], SVG_STYLE_OPEN: [SVG_STYLE_OPEN], SVG_STYLE_CLOSE: [SVG_STYLE_CLOSE], SVG_STYLE_TAG: [SVG_STYLE_TAG], SVG_TAG_NAME: [SVG_TAG_NAME], SVG_ATTR: [SVG_ATTR], SVG_CSS_REF: [SVG_CSS_REF], SVG_CSS_REFUSED: [SVG_CSS_REFUSED] }).map(([k, v]) => [k, v.map(r => `/${r.source}/${r.flags}`)]),
})).digest('hex').slice(0, 16);

/**
 * One changed path's class. Markdown an agent or a gate reads (skills, sections, resolvers, policy and rule docs,
 * templates, any markdown in a skill directory) is code: it is gstack's product. `root` is the repository root
 * (skill directories probed on disk) or the top-level skill directory names read from a commit.
 */
export function classifyPath(p: string, root?: string | readonly string[]): PathClass {
  if (RELEASE_METADATA.some(r => r.test(p))) return 'docs';
  if (AGENT_PROSE.some(r => r.test(p)) || HARNESS_PINS.test(p)) return 'code';
  if (TEST_PATH.some(r => r.test(p))) return 'tests';
  if (!DOC_PATH.test(p)) return 'code';
  const top = p.includes('/') ? p.split('/')[0]! : '';
  if (!top || !root) return 'docs';
  if (typeof root === 'string') return ['SKILL.md', 'SKILL.md.tmpl'].some(f => fs.existsSync(path.join(root, top, f))) ? 'code' : 'docs';
  return root.includes(top) ? 'code' : 'docs';
}

/**
 * A code-class path the data rule may move to docs: a data extension, and not agent prose, a gate path or a config file.
 * Only classifyDiff applies the rule, and only to a candidate its collector found no consumer for (ClassInput.consumed);
 * classifyPath and every path-only caller keep data files code.
 */
export function dataCandidate(p: string, root?: string | readonly string[]): boolean {
  return DATA_PATH.test(p) && classifyPath(p, root) === 'code' && ![...AGENT_PROSE, ...GATE_PATH, TOKEN_PATH, ...DATA_CONFIG].some(r => r.test(p));
}

/** An SVG the data rule may move to docs once the collector reads its whole text as a drawing (ClassInput.drawings); never a data file another file is named through. */
export function svgCandidate(p: string, root?: string | readonly string[]): boolean {
  return SVG_PATH.test(p) && classifyPath(p, root) === 'code' && ![...AGENT_PROSE, ...GATE_PATH, TOKEN_PATH, ...DATA_CONFIG].some(r => r.test(p));
}

/** Whether a range needs the gate scan: any path that is not docs by the path-only rule. The data rule never skips it. */
export function gateScanNeeded(paths: readonly string[], root?: string | readonly string[]): boolean {
  return paths.some(p => classifyPath(p, root) !== 'docs');
}

export type DepthErrorCode = 'scope_error' | 'gate_scan_unavailable' | 'registry_unavailable' | 'registry_invalid' | 'numstat_failed' | 'binary_code_path' | 'consumer_scan_failed';
/** Why a depth failed closed to full: the input it could not read, a sanitized cause and the repair; `result` is the result code behind it when one exists. */
export interface DepthError { code: DepthErrorCode; detail: string; input: string; repair: string; result?: ResultCodeName }
export interface PathLines { path: string; lines: number; binary: boolean }
/** The base commit's `.gstack/generated.json`: outputs of entries with a command only; `error` when it could not be read or validated. */
export interface RegistryInfo { sha: string | null; outputs: readonly string[]; error?: DepthError }

export interface ClassInput {
  paths: readonly string[];
  /** gstack-diff-scope output (SCOPE_* keys). */
  scope?: Record<string, string>;
  /** Gate hunks the gate scan tagged (an RH rule: a relaxed threshold, a skipped test, a loosened check); null when the scan did not run or failed. Plain test edits are listed, never tagged, and do not count. */
  gateTagged: number | null;
  /** Paths the diff deletes or renames away. */
  deleted?: readonly string[];
  /** Paths whose whole change is a version stamp (package.json's version key): classified as docs. */
  stampOnly?: readonly string[];
  /** The repository root, or the skill directory names at the reviewed commit: markdown inside a skill directory is code. */
  root?: string | readonly string[];
  /** Changed lines per path; without it a code diff counts every line as runtime. */
  perPath?: readonly PathLines[];
  registry?: RegistryInfo;
  /** Collector failures (a diff git could not list): each fails the depth closed. */
  errors?: readonly DepthError[];
  /**
   * The data candidates (dataCandidate) a non-docs file names at the head, the merge base or in the working tree
   * (lib/review-collect.ts). A candidate not listed counts as docs; 'all' or no scan keeps every data file code.
   */
  consumed?: readonly string[] | 'all';
  /** Paths the diff creates (untracked files included): their added lines are the whole file. */
  created?: readonly string[];
  /** The SVG candidates (svgCandidate) whose whole text the collector read as a drawing (svgDrawing); any other SVG stays code. */
  drawings?: readonly string[];
  /** Docs-, data- or log-named paths the collector found executable (exec bit, a symlink or a "#!" first line): code whatever their name or directory, never judged by path alone. */
  executables?: readonly string[];
  /** Added and deleted lines per path (lib/review-collect.ts): the risk classes read them; without them no line signal applies. */
  added?: Record<string, readonly string[]>;
  removed?: Record<string, readonly string[]>;
  /** Paths the base policy's review_exclude_paths leave out of every reader's diff (lib/review-exclude.ts): classified as docs. */
  excluded?: ReadonlySet<string>;
  /** The base policy's review.risk_paths: a code path they match is risk class `policy`; data and binary files under them never are. */
  riskPaths?: readonly string[];
  /** Risk classes the lane declares for the diff (GST-1129, --declare-risk): they join the detected ones and can only raise the depth. */
  declared?: readonly RiskClass[];
}
/** risk is detected plus declared; `detected` is what the matchers found, `declared` what the lane added. */
export interface ClassResult { class: DiffClass; reasons: string[]; errors: DepthError[]; runtimeLines: number | null; risk: RiskClass[]; detected: RiskClass[]; declared: RiskClass[] }

const sanitize = (s: string) => s.replace(/[\0-\x1f]+/g, ' ').slice(0, 200);
const isOutput = (i: ClassInput, p: string) => !!i.registry?.outputs.length && matchesAny(i.registry.outputs, p);
export const unconsumedData = (i: Pick<ClassInput, 'consumed' | 'drawings' | 'root' | 'executables'>, p: string) => !i.executables?.includes(p) && Array.isArray(i.consumed) && !i.consumed.includes(p) && (dataCandidate(p, i.root) || (!!i.drawings?.includes(p) && svgCandidate(p, i.root)));
const binaryData = (i: ClassInput, p: string) => !i.executables?.includes(p) && BINARY_DATA_PATH.test(p) && classifyPath(p, i.root) === 'code' && ![...AGENT_PROSE, ...GATE_PATH, TOKEN_PATH, ...DATA_CONFIG].some(r => r.test(p));
const pathClass = (i: ClassInput, p: string): PathClass => i.executables?.includes(p) && !i.excluded?.has(p) ? 'code' : (i.excluded?.has(p) || (i.stampOnly ?? []).includes(p) || unconsumedData(i, p) || binaryData(i, p) ? 'docs' : classifyPath(p, i.root));

/** The diff's class, raised to gate by any gate signal; `errors` lists every input that fails the depth closed; `runtimeLines` counts code-class lines outside the base registry's outputs. */
export function classifyDiff(i: ClassInput): ClassResult {
  const reasons: string[] = [];
  const errors: DepthError[] = [...(i.errors ?? [])];
  let cls: DiffClass = 'docs';
  const raise = (c: DiffClass, why: string) => { if (CLASS_RANK[c] > CLASS_RANK[cls]) cls = c; reasons.push(why); };
  if (!i.paths.length) raise('docs', 'no changed paths');
  for (const p of i.paths) { const c = pathClass(i, p); if (CLASS_RANK[c] > CLASS_RANK[cls]) raise(c, `${c}: ${p}`); }
  const data = i.paths.filter(p => unconsumedData(i, p));
  if (data.length) reasons.push(`docs: ${data.length} data path(s) no code names`);
  const s = i.scope ?? {};
  if (s.SCOPE_ERROR) {
    raise('code', `scope error: ${s.SCOPE_ERROR}`);
    errors.push({ code: 'scope_error', detail: sanitize(s.SCOPE_ERROR), input: 'gstack-diff-scope <base>', repair: 'run gstack-diff-scope <base> by hand and fix what it reports' });
  }
  if (CLASS_RANK[cls] >= CLASS_RANK.tests) {
    if (i.gateTagged === null) {
      raise('gate', 'gate scan unavailable');
      errors.push({ code: 'gate_scan_unavailable', detail: 'gstack-gate-diff reported no GATE_SUMMARY', input: 'gstack-gate-diff <base>', repair: 'run gstack-gate-diff <base> and read its GATE_ERROR line, or pass the recorded scan as --gate-tagged <n>' });
    } else if (i.gateTagged > 0) raise('gate', `gate scan tagged ${i.gateTagged} hunk(s)`);
    const deletedGuarded = (i.deleted ?? []).filter(p => !i.excluded?.has(p) && classifyPath(p, i.root) !== 'docs');
    if (deletedGuarded.length) raise('gate', `deletes ${deletedGuarded.length} code or test path(s)`);
  }
  if (CLASS_RANK[cls] >= CLASS_RANK.code) {
    if (s.SCOPE_AUTH === 'true') raise('gate', 'auth paths');
    if (s.SCOPE_MIGRATIONS === 'true') raise('gate', 'migrations');
    for (const p of i.paths) if (GATE_PATH.some(r => r.test(p)) || secretPath(p, [...(i.added?.[p] ?? []), ...(i.removed?.[p] ?? [])])) { raise('gate', `gate path: ${p}`); break; }
    if (i.registry?.error) errors.push(i.registry.error);
  }
  const riskHits = CLASS_RANK[cls] >= CLASS_RANK.code ? matchRisk({ codePaths: i.paths.filter(p => pathClass(i, p) === 'code'), executables: i.executables, added: i.added, removed: i.removed, scopeAuth: s.SCOPE_AUTH === 'true', ...(i.riskPaths?.length ? { isRiskPath: (p: string) => matchesAny(i.riskPaths!, p) && !DATA_PATH.test(p) } : {}) }) : new Map<RiskClass, string>();
  const docSecret = i.paths.find(p => DOC_PATH.test(p) && (i.added?.[p] ?? []).some(l => DOC_SECRET_LINE.some(r => r.test(l))));
  if (docSecret && !riskHits.has('security')) riskHits.set('security', `docs that can print a credential: ${docSecret}`);
  const byRank = (a: RiskClass, b: RiskClass) => RISK_CLASSES.indexOf(a) - RISK_CLASSES.indexOf(b);
  const detected = [...riskHits.keys()].sort(byRank);
  const declared = [...new Set(i.declared ?? [])].sort(byRank);
  for (const d of declared) if (!riskHits.has(d)) riskHits.set(d, `declared: ${d}`);
  const risk = [...riskHits.keys()].sort(byRank);
  reasons.push(...[...riskHits.values()].map(r => `risk: ${r}`));
  if (!i.perPath) return { class: cls, reasons, errors, runtimeLines: null, risk, detected, declared };
  let runtimeLines = 0;
  for (const e of i.perPath) {
    if (pathClass(i, e.path) !== 'code' || isOutput(i, e.path)) continue;
    if (e.binary) errors.push({ code: 'binary_code_path', detail: 'git reports a binary change, so its lines cannot be counted', input: e.path, repair: "register it as an output of an entry with a command in the base branch's .gstack/generated.json, or accept the full review" });
    else runtimeLines += e.lines;
  }
  return { class: cls, reasons, errors, runtimeLines, risk, detected, declared };
}

/** Risk, not size (R51): any classifier error, gate class or risk class is full; everything else is light. A floor only raises; a fixed blocker or a CRITICAL raises light to standard for the next step (planReview). */
export function depthFor(o: { cls: DiffClass; runtimeLines: number; errors: readonly DepthError[]; risk?: readonly RiskClass[]; floor?: Depth }): Depth {
  const d: Depth = o.errors.length || o.cls === 'gate' || o.risk?.length ? 'full' : 'light';
  return o.floor && DEPTH_RANK[o.floor] > DEPTH_RANK[d] ? o.floor : d;
}

export interface DepthResult { depth: Depth; class: DiffClass; runtimeLines: number; reasons: string[]; errors: DepthError[]; codes: ResultCodeName[]; rules: string; risk: RiskClass[]; detected: RiskClass[]; declared: RiskClass[] }

function decideDepth(c: ClassResult, runtimeLines: number, floor?: Depth): DepthResult {
  const unfloored = depthFor({ cls: c.class, runtimeLines, errors: c.errors, risk: c.risk });
  const reasons = [...c.errors.map(e => `error:${e.code}`), ...(c.class === 'gate' ? ['gate-class'] : []), ...c.risk.map(r => `risk:${r}`), `runtime=${runtimeLines}`];
  if (floor && DEPTH_RANK[floor] > DEPTH_RANK[unfloored]) reasons.push(`floor:${floor}`);
  const codes = [...new Set(c.errors.flatMap(e => (e.result ? [e.result] : [])))];
  return { depth: depthFor({ cls: c.class, runtimeLines, errors: c.errors, risk: c.risk, floor }), class: c.class, runtimeLines, reasons, errors: c.errors, codes, rules: DEPTH_RULES, risk: c.risk, detected: c.detected, declared: c.declared };
}

/** The depth of a collected range (lib/review-collect.ts) plus a recorded gate-scan result: what the queue recomputes at a head. */
export function depthOfCommitInput(input: ClassInput & { floor?: Depth }): DepthResult {
  const c = classifyDiff(input);
  return decideDepth(c, c.runtimeLines ?? 0, input.floor);
}

// ---------------------------------------------------------------------------
// numeric claims: the outside voice's trigger on docs and tests diffs
// ---------------------------------------------------------------------------
const CLAIM = new RegExp([
  String.raw`\d+(?:\.\d+)?\s?%`, String.raw`[$€£]\s?\d`, String.raw`\b\d+(?:\.\d+)?\s?x\b`,
  String.raw`\b\d+(?:\.\d+)?\s?(?:ms|s|seconds?|minutes?|hours?|tokens?|credits?|[kKmM]tok)\b`,
  String.raw`(?<![\d.])\d+\.\d+(?![\d.])`,
  String.raw`[=≈<>≤≥]\s*-?\d`, String.raw`\b\d+\s*/\s*\d+\b`, String.raw`\b\d+(?:\.\d+)?e-?\d+\b`,
  String.raw`\b(?:p|n|median|mean|average|rate|score|accuracy|recall|precision|speedup|faster|slower|cheaper|cost|hits?|misses)\b[^\n]{0,40}\d`,
].join('|'), 'i');
/** Not claims: dates, versions, issue numbers, step numbers. Stripped before the scan. */
const NOT_CLAIM = /\b\d{4}-\d{2}-\d{2}\b|\bv?\d+(?:\.\d+){2,}\b|#\d+\b|\b(?:step|phase|pass|rule|item|round)\s+\d+(?:\.\d+)?\b/gi;
export interface NumbersResult { publishes: boolean; claims: number; fingerprint: string }

/** Where a number is published: prose and data files. Code and test source are not publications. */
const PUBLISHED = /\.(md|mdx|markdown|rst|txt|adoc|json|csv|tsv)$/i;

/** Added lines (path → lines) → whether the diff publishes numeric claims in prose or data files, and a fingerprint of those claims and their files. */
export function scanNumbers(added: Record<string, readonly string[]>): NumbersResult {
  const hits: string[] = [];
  for (const p of Object.keys(added).filter(f => PUBLISHED.test(f)).sort()) for (const line of added[p] ?? []) if (CLAIM.test(line.replace(NOT_CLAIM, ' '))) hits.push(`${p}\t${line.trim()}`);
  const fingerprint = hits.length ? createHash('sha256').update(hits.join('\n')).digest('hex').slice(0, 16) : 'none';
  return { publishes: hits.length > 0, claims: hits.length, fingerprint };
}

// ---------------------------------------------------------------------------
// the loop: which step comes next
// ---------------------------------------------------------------------------
export interface History {
  /** Full review passes already run in this invocation (0 before pass 1). */
  fullPasses: number;
  /** The step that just finished; none before pass 1. */
  last: 'none' | 'full' | 'fix-check';
  /** The finished step fixed at least one blocking finding. */
  fixedBlocking?: boolean;
  /** The finished step fixed findings below the floor (pass 1 only fixes those). */
  fixedBelow?: boolean;
  /** A blocking finding is still open in fix scope (unfixed). */
  blockingOpen?: boolean;
  /** A fix in the finished step touched a gate-class path. */
  touchedGate?: boolean;
  /** Runtime lines of the fix range (RANGE_BASE..HEAD) as classifyDiff counts them, 0 when it touches none; undefined or null when the range was not read. */
  rangeRuntimeLines?: number | null;
  pass1Depth?: Depth;
  /** The diff is gate class (planReview sets it): Step 11's voices run before any stop. */
  gate?: boolean;
  /** Step 11's native adversarial pass already ran (planReview sets it from PlanInput.adversarialRan). */
  adversarialRan?: boolean;
  /** The approval id of the owner's recorded grant of one scoped fix-check after round 2 (review_loop_exception). */
  granted?: string;
  /** R65's lean table (planReview sets it from the base policy's review.panel): one reviewer, then at most one fix-check. */
  lean?: boolean;
  /** Fix-checks already run in this invocation (lean: the grant adds one only after the first). */
  fixChecks?: number;
  /** The Step 9 /ship Step 16 stage 2.1 inserted for edits after the review bound (gstack-review-plan --post-review). */
  postReview?: boolean;
  /** In the loop, the CLI bound `granted` to the last fix-check's own stop head, its commit (--range-base): a new grant, never the previous link's. */
  chained?: boolean;
}
export interface NextStep { step: Step; reason: string }

/**
 * The transition table (docs/review-policy.md#transitions). Pass 1 is full. A fixed
 * blocking finding earns a second full pass on the range, scoped when `depth` (known
 * only to planReview) is below full and the fix range has at most SCOPED_RANGE_LINES
 * runtime lines; any other fix earns one fix-check, except a light pass whose fix range
 * changes no runtime lines; two rounds is the cap (R51: a scoped pass or a fix-check is
 * one): after round 2, below-floor fixes finish with notes, and a blocker open or fixed
 * there, or a gate-class edit there, stops for the owner, whose grant may add one scoped fix-check.
 * The cap limits fix rounds, not Step 11's voices: on gate class any stop waits for them (GST-967),
 * and the owner's recorded grant (`granted`) turns the stop after a round-2 full pass with a fixed finding, or after a round-2
 * fix-check when `fixChecks` says it was the only one (GEVA-223), into its one fix-check; a fix-check never earns another, so
 * the grant cannot repeat. Edits after the review bound (`postReview`) that follow a fix-check are a new stop, and a new grant
 * there adds one fix-check, the next link of the chain finish counts (GST-1676, docs/ship-policy.md#fix-check-chain). In the
 * loop, a grant the CLI bound to the last fix-check's own stop head (`chained`) adds one more the same way (GST-1681).
 */
export function nextStep(h: History, depth?: Depth): NextStep {
  const n = h.lean ? leanStep(h, depth) : loopStep(h, depth);
  if (n.step !== 'stop') return n;
  if (h.gate && !h.adversarialRan) return { step: 'voices', reason: `gate class: Step 11's ${h.lean ? 'one reader' : 'voices (adversarial, outside, targeted)'} run${h.lean ? 's' : ''} before the owner's exit, then ask again with --adversarial-ran (${n.reason})` };
  const afterFixCheck = h.last === 'fix-check' && h.fullPasses === FULL_PASS_CAP - 1 && h.fixChecks === 1;
  if (h.postReview && h.last === 'fix-check' && h.granted && !h.blockingOpen) return { step: 'fix-check', reason: `the owner's grant ${h.granted} adds one scoped fix-check for the edits after the last fix-check, a new link of the fix-check chain (docs/ship-policy.md#fix-check-chain); a later post-review edit needs a grant of its own` };
  if (h.chained && h.last === 'fix-check' && h.granted && !h.blockingOpen) return { step: 'fix-check', reason: `the owner's grant ${h.granted} adds one scoped fix-check at the last fix-check's stop, a new link of the fix-check chain (docs/ship-policy.md#fix-check-chain); another stop needs a grant of its own` };
  if (!h.lean && h.granted && !h.blockingOpen && (afterFixCheck || (h.last === 'full' && h.fullPasses === FULL_PASS_CAP))) return { step: 'fix-check', reason: `the owner's grant ${h.granted} adds one scoped fix-check after round ${FULL_PASS_CAP} (review_loop_exception), ${afterFixCheck ? 'never a second' : 'never a fourth round'}` };
  return n;
}

/**
 * R65's lean table (GSTA-258): pass 1 is the one reviewer; any fix on a risk-class diff, and a fixed blocker or a gate-class
 * edit on any diff, earns one scoped fix-check (round 2, the cap); below-floor fixes on a light diff ship as notes. After the
 * fix-check a blocker or gate-class edit stops for the owner, whose recorded grant adds one more fix-check, never two.
 */
function leanStep(h: History, depth?: Depth): NextStep {
  if (h.last === 'none') return { step: 'full', reason: 'pass 1: one reviewer reads the whole diff (R65)' };
  if (h.last === 'fix-check') {
    if (!h.blockingOpen && !h.fixedBlocking && !h.touchedGate) return { step: 'done', reason: h.fixedBelow ? 'round cap 2 reached: the below-floor fixes ship as notes in the PR body and receipt' : 'the fix-check found nothing blocking' };
    if (h.granted && !h.blockingOpen && h.fixChecks === 1) return { step: 'fix-check', reason: `the owner's grant ${h.granted} adds one scoped fix-check after round ${FULL_PASS_CAP} (review_loop_exception), never a second` };
    return { step: 'stop', reason: `the fix-check ${h.blockingOpen || h.fixedBlocking ? 'found a blocking finding' : 'edited a gate-class path'}: name it for the owner, whose grant may add one scoped fix-check, never a third round` };
  }
  if (h.blockingOpen) return { step: 'stop', reason: 'a blocking finding is still open in fix scope: name it for the owner' };
  if (!h.fixedBlocking && !h.fixedBelow && !h.touchedGate) return { step: 'done', reason: 'the step applied no edits' };
  if (depth === 'light' && !h.fixedBlocking && !h.touchedGate) return { step: 'done', reason: 'light depth: the below-floor fixes ship as notes in the PR body and receipt without a fix-check (R65)' };
  return { step: 'fix-check', reason: `${h.fixedBlocking ? 'a blocking finding was fixed' : h.touchedGate ? 'a fix touched a gate-class path' : 'below-floor fixes on a risk-class diff'}: one scoped fix-check reads the touched hunks (round 2, the cap)` };
}

function loopStep(h: History, depth?: Depth): NextStep {
  if (h.last === 'none') return { step: 'full', reason: 'pass 1 reviews the whole diff' };
  const fixed = !!(h.fixedBlocking || h.fixedBelow);
  if (h.last === 'fix-check') return h.blockingOpen || h.fixedBlocking || h.touchedGate ? { step: 'stop', reason: `the fix-check ${h.touchedGate && !h.blockingOpen && !h.fixedBlocking ? 'edited a gate-class path' : 'found a blocking finding'}: name it for the owner, whose grant may add one scoped fix-check, never a third round` } : { step: 'done', reason: fixed ? 'round cap 2 reached: the below-floor fixes ship as notes in the PR body and receipt' : 'the fix-check found nothing blocking' };
  if (h.blockingOpen && h.fullPasses >= FULL_PASS_CAP) return { step: 'stop', reason: `a blocking finding is open after ${FULL_PASS_CAP} rounds: name it for the owner` };
  if (h.blockingOpen) return { step: 'stop', reason: 'a blocking finding is still open in fix scope: name it for the owner' };
  if (!fixed) return { step: 'done', reason: 'the step applied no edits' };
  if (h.fullPasses >= FULL_PASS_CAP) return h.fixedBlocking || h.touchedGate
    ? { step: 'stop', reason: `${h.fixedBlocking ? 'a blocking finding was fixed' : 'a fix edited a gate-class path'} in round ${FULL_PASS_CAP}, the cap: name it for the owner, whose grant may add one scoped fix-check (review_loop_exception)` }
    : { step: 'done', reason: `round cap ${FULL_PASS_CAP} reached: the below-floor fixes ship as notes in the PR body and receipt` };
  if (!h.fixedBlocking && !h.touchedGate && depth === 'light' && h.rangeRuntimeLines === 0) return { step: 'done', reason: 'light depth: the below-floor fixes change no runtime lines, so they ship as notes without a fix-check' };
  if (h.fixedBlocking || h.touchedGate) {
    if (!h.fixedBlocking) return { step: 'full', reason: 'a fix touched a gate-class path: full pass on the range' };
    const n = h.rangeRuntimeLines;
    const keep = h.touchedGate ? 'a fix touched a gate-class path' : depth === undefined ? 'the depth is unknown' : h.pass1Depth === 'full' ? 'pass 1 ran at full depth' : depth === 'full' ? 'the diff is at full depth'
      : typeof n !== 'number' || !Number.isFinite(n) || n < 0 ? 'the fix range was not read' : n > SCOPED_RANGE_LINES ? `the fix range has ${n} runtime lines (> ${SCOPED_RANGE_LINES})` : null;
    if (keep) return { step: 'full', reason: `a blocking finding was fixed and ${keep}: full pass on the range` };
    return { step: 'scoped', reason: `a blocking finding was fixed on a ${depth} diff with ${n} runtime lines in the fix range (<= ${SCOPED_RANGE_LINES}): scoped pass on the range` };
  }
  return { step: 'fix-check', reason: 'only below-floor fixes: one fix-check reads the touched hunks (round 2)' };
}

// ---------------------------------------------------------------------------
// the dispatch plan of one step
// ---------------------------------------------------------------------------
export interface PlanInput extends ClassInput {
  diffLines: number;
  history: History;
  numbers: NumbersResult;
  /** Specialists force-included by prompt flags; 'all' for --all-specialists. */
  force?: readonly string[] | 'all';
  /** Specialists the hit-rate stats tag GATE_CANDIDATE. */
  gated?: readonly string[];
  /** A specialist produced a CRITICAL finding (Red Team activation on code class; raises light to standard). */
  criticalFound?: boolean;
  /** Step 11's native adversarial pass already ran in this invocation. */
  adversarialRan?: boolean;
  /** The numeric-claim fingerprint the outside voice last reviewed; a change reruns it. */
  reviewedNumbers?: string;
  /** --depth-floor: raises the depth, never lowers it. */
  floor?: Depth;
  /** false under --no-tiers or review_effort_tiers off: specialists run at the host's default effort. */
  tiers?: boolean;
  /** The targeted classes (lib/review-targeted.ts) and whether the targeted reader already read this product patch. */
  targeted?: { classes: readonly string[]; ran?: boolean };
  /** The base policy's exclusion: one `:(top,exclude,glob)` pathspec per applied pattern, added to every reader, and the kept files under them as `:(top,literal)` pathspecs. */
  exclusion?: { specs: readonly string[]; keep: readonly string[] };
  /** The base policy's review key and the platform evidence at HEAD; absent plans today's panel (review.panel all). */
  shape?: ReviewShape;
}
/** How much review a repo runs (lib/ship-policy-review.ts) plus HEAD and the platform review found at it (lib/review-platform.ts). */
export interface ReviewShape { panel: 'off' | 'risk' | 'all'; readerModel: string; platform: 'off' | 'on'; head: string; platformReview: { id: string; head: string; reviewer: string } | null }
/** One reviewer. `exclude` holds git pathspec argv items the reviewer's diff leaves out; `checklists` names what the batched specialist reads. */
export interface Dispatch { role: Role; name: string; effort: Effort; exclude: string[]; checklists?: string[]; reason?: string; keep?: string[]; model?: string; classes?: string[] }
/** lean: R65's one reviewer; panel: today's panel (review.panel); platform: the platform review at HEAD stands in for every reader. */
export type ReviewMode = 'lean' | 'panel' | 'platform';
export interface ReviewPlan extends DepthResult {
  /** The depth this step runs at: light raised to standard by a fixed blocker, a CRITICAL or an open blocker. */
  stepDepth: Depth;
  depthReasons: string[];
  next: NextStep; numbers: NumbersResult; dispatches: Dispatch[]; skipped: string[]; mode: ReviewMode;
}

const scopeWants: Partial<Record<Specialist, (s: Record<string, string>) => boolean>> = {
  performance: s => s.SCOPE_BACKEND === 'true' || s.SCOPE_FRONTEND === 'true',
  'data-migration': s => s.SCOPE_MIGRATIONS === 'true',
  'api-contract': s => s.SCOPE_API === 'true',
  design: s => s.SCOPE_FRONTEND === 'true',
  'state-machines': s => s.SCOPE_STATE_MACHINE === 'true' || s.SCOPE_STATE_MACHINE === 'unknown' || s.SCOPE_STATE_MACHINE === undefined,
};
const forcedBy = (i: PlanInput) => (n: string) => i.force === 'all' || (Array.isArray(i.force) && i.force.includes(n));

/** The specialists a full pass selects for a class: class sets the eligible set, hit-rate gating applies inside it, gate class ignores gating. */
export function specialistsFor(cls: DiffClass, i: PlanInput, skipped: string[] = []): Specialist[] {
  const s = i.scope ?? {};
  const forced = forcedBy(i);
  if (cls === 'docs') { skipped.push('specialists (docs class)'); return SPECIALISTS.filter(forced); }
  if (cls === 'tests') { skipped.push('specialists except testing (tests class)'); return SPECIALISTS.filter(n => n === 'testing' || forced(n)); }
  const want = (n: Specialist): boolean => {
    if (forced(n)) return true;
    if (n === 'state-machines') return scopeWants[n]!(s);
    if (i.diffLines < SMALL_DIFF_LINES) return false;
    switch (n) {
      case 'testing': case 'maintainability': return true;
      case 'security': return s.SCOPE_AUTH === 'true' || (s.SCOPE_BACKEND === 'true' && i.diffLines > LARGE_DIFF_LINES);
      case 'simplification': return i.diffLines > LARGE_DIFF_LINES;
      default: return scopeWants[n]!(s);
    }
  };
  return SPECIALISTS.filter(n => {
    if (!want(n)) return false;
    if (cls !== 'gate' && !forced(n) && (i.gated ?? []).includes(n)) { skipped.push(`${n} (gated by hit rate)`); return false; }
    return true;
  });
}

/**
 * The checklists the one batched specialist reads (the lean ensemble, GSTA-167 part 2): the class sets the base (none for docs,
 * testing for tests, LIGHT_FIXED for code and gate), BATCH_SCOPED joins when scope asks and hit-rate gating allows (gate class
 * ignores gating), and a forced checklist always joins.
 */
export function batchChecklists(cls: DiffClass, i: PlanInput, skipped: string[] = []): Specialist[] {
  const forced = forcedBy(i);
  const codeLike = cls === 'code' || cls === 'gate';
  const base: readonly Specialist[] = codeLike ? LIGHT_FIXED : cls === 'tests' ? ['testing'] : [];
  if (cls === 'docs') skipped.push('specialists (docs class)');
  if (cls === 'tests') skipped.push('specialists except testing (tests class)');
  const extra = SPECIALISTS.filter(n => {
    if (base.includes(n)) return false;
    if (forced(n)) return true;
    if (!codeLike || !BATCH_SCOPED.includes(n) || !scopeWants[n]!(i.scope ?? {})) return false;
    if (cls !== 'gate' && (i.gated ?? []).includes(n)) { skipped.push(`${n} (gated by hit rate)`); return false; }
    return true;
  });
  const dropped = SPECIALISTS.filter(n => codeLike && !BATCH_SCOPED.includes(n) && !base.includes(n) && !extra.includes(n));
  if (dropped.length) skipped.push(`${dropped.join(', ')} (lean ensemble: read only when forced)`);
  return [...base, ...extra];
}

/** A path as one git exclude pathspec; a glob character or a leading colon makes it literal. */
const excludeSpec = (p: string) => `:(exclude${/[*?[\]\\]/.test(p) || p.startsWith(':') ? ',literal' : ''})${p}`;
const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** The diff command a dispatched reviewer runs; `<diff-base>` is the literal sha the parent writes in. */
export function diffCommand(d: Dispatch): string {
  return d.exclude.length ? `git diff <diff-base> -- . ${d.exclude.map(shellQuote).join(' ')}` : 'git diff <diff-base>';
}

/** The second command a reader runs when the base policy's exclusion keeps files its patterns match (a git exclude beats any positive pathspec); null otherwise. */
export function keepCommand(d: Dispatch): string | null {
  return d.keep?.length ? `git diff <diff-base> -- ${d.keep.map(shellQuote).join(' ')}` : null;
}

/** The reviewers the next step dispatches at its depth, with each role's effort tier and excluded pathspecs. */
export function planReview(i: PlanInput): ReviewPlan {
  const c = classifyDiff(i);
  const depth = decideDepth(c, c.runtimeLines ?? (CLASS_RANK[c.class] >= CLASS_RANK.code ? i.diffLines : 0), i.floor);
  const { class: cls, runtimeLines } = depth;
  const sh = i.shape;
  const platformNow = !!sh && sh.platform === 'on' && sh.platformReview?.head === sh.head && i.history.fullPasses === 0 && !riskClass(c, depth) && platformFits(c.class, i.paths, depth.runtimeLines, i.numbers);
  const panel = !platformNow && (!sh || sh.panel === 'all' || (sh.panel === 'risk' && riskClass(c, depth)));
  const next = nextStep({ ...i.history, gate: cls === 'gate', adversarialRan: !!i.adversarialRan, lean: !panel }, depth.depth);
  if (!panel) return leanPlan(i, c, depth, next);
  const h = i.history;
  const raise = depth.depth === 'light' && (h.fixedBlocking || h.blockingOpen || i.criticalFound);
  const stepDepth: Depth = raise ? 'standard' : depth.depth;
  const depthReasons = [...depth.reasons, ...(raise ? [`history:${h.fixedBlocking ? 'fixed-blocking' : h.blockingOpen ? 'blocking-open' : 'critical-found'}`] : [])];
  const skipped: string[] = [];
  const dispatches: Dispatch[] = [];
  const x = i.exclusion;
  const add = (role: Role, name: string, effort: Effort, exclude: string[] = [], extra: Partial<Dispatch> = {}) =>
    dispatches.push({ role, name, effort, exclude: x ? [...exclude, ...x.specs] : exclude, ...extra, ...(x?.keep.length ? { keep: [...x.keep] } : {}) });
  const docsAndOutputs = i.paths.filter(p => !i.excluded?.has(p) && ((pathClass(i, p) === 'docs' && !(i.numbers.publishes && DOC_PATH.test(p))) || isOutput(i, p))).map(excludeSpec);
  const numbersChanged = i.numbers.publishes && i.reviewedNumbers !== undefined && i.reviewedNumbers !== i.numbers.fingerprint;
  const firstVoices = h.fullPasses === 0 || !i.adversarialRan;
  const specialist: Effort = i.tiers === false ? 'host' : ROLE_EFFORT.specialist;
  if (next.step === 'full' && stepDepth === 'light') {
    const forced = forcedBy(i);
    if (runtimeLines > 0) {
      add('specialist', 'batched', ROLE_EFFORT['red-team'], docsAndOutputs, { checklists: [...batchChecklists('code', i, skipped), 'red-team'] });
      skipped.push('red-team (light depth: the batched specialist carries the Red Team prompt)');
      if (firstVoices) add('adversarial-native', 'adversarial', 'full', [], { reason: LIGHT_ADVERSARIAL_REASON });
    } else {
      for (const n of SPECIALISTS.filter(forced)) add('specialist', n, specialist);
      skipped.push('specialists, red-team and adversarial-native (light depth, runtime 0)');
    }
    if (h.fullPasses === 0 && i.numbers.publishes) add('outside-voice', 'outside-voice', 'host');
    else if (numbersChanged) add('outside-voice', 'outside-voice (numbers changed)', 'host');
    else skipped.push(`outside-voice (${cls} class, no numeric claims)`);
  } else if (next.step === 'full') {
    const full = stepDepth === 'full';
    const dcls: DiffClass = full ? 'gate' : cls;
    const raised = !full && (raise || runtimeLines <= SMALL_DIFF_LINES);
    const lines = full ? i.diffLines : Math.max(runtimeLines, raised ? SMALL_DIFF_LINES : 0);
    const checklists = batchChecklists(dcls, i, skipped);
    if (checklists.length) add('specialist', 'batched', specialist, full ? [] : docsAndOutputs, { checklists });
    const redTeam = dcls === 'gate' || (dcls === 'code' && (lines > RED_TEAM_LINES || !!i.criticalFound || raised));
    if (redTeam) add('red-team', 'red-team', 'full');
    else skipped.push(`red-team (${dcls} class${dcls === 'code' ? `, ${lines} runtime lines, no critical` : ''})`);
    const codeLike = dcls === 'code' || dcls === 'gate';
    if (h.fullPasses === 0 || (!i.adversarialRan && codeLike)) {
      if (codeLike) add('adversarial-native', 'adversarial', 'full');
      else skipped.push(`adversarial-native (${dcls} class)`);
      if (codeLike || i.numbers.publishes) add('outside-voice', 'outside-voice', 'host');
      else skipped.push(`outside-voice (${dcls} class, no numeric claims)`);
    } else {
      skipped.push('adversarial-native and outside-voice (run once per invocation)');
      if (numbersChanged) add('outside-voice', 'outside-voice (numbers changed)', 'host');
    }
  } else if (next.step === 'scoped') {
    add('fix-check', 'fix-check', 'full');
    const forced = SPECIALISTS.filter(forcedBy(i));
    for (const n of forced) add('specialist', n, specialist);
    skipped.push(forced.length ? 'specialists (scoped pass; forced ones dispatched)' : 'specialists (scoped pass)');
    add('red-team', 'red-team', 'full');
    const stepElevenPending = !i.adversarialRan && cls === 'code';
    if ((h.rangeRuntimeLines ?? 0) > 0 || stepElevenPending) add('adversarial-native', 'adversarial', 'full');
    else skipped.push('adversarial-native (scoped pass: the fix range changes no runtime lines)');
    if (stepElevenPending) add('outside-voice', 'outside-voice', 'host');
    else if (numbersChanged) add('outside-voice', 'outside-voice (numbers changed)', 'host');
    else skipped.push('outside-voice (scoped pass)');
  } else if (next.step === 'fix-check') {
    add('fix-check', 'fix-check', 'full');
    if (numbersChanged) add('outside-voice', 'outside-voice (numbers changed)', 'host');
  } else if (next.step === 'voices') {
    add('adversarial-native', 'adversarial', 'full');
    add('outside-voice', 'outside-voice', 'host');
  }
  if (i.targeted?.classes.length && ['full', 'scoped', 'fix-check', 'voices'].includes(next.step)) {
    if (i.targeted.ran) skipped.push('targeted (already read this product patch)');
    else add('targeted', 'targeted', ROLE_EFFORT.targeted);
  }
  return { ...depth, stepDepth, depthReasons, reasons: c.reasons, next, numbers: i.numbers, dispatches, skipped, mode: 'panel' };
}

/**
 * R65's lean dispatch (docs/review-policy.md#review-depth): pass 1 runs one native adversarial reader at the lane's reasoning, on
 * review.reader_model (the lane's model by default: FOUN-32, ggstack#52). A risk-class diff under review.panel off gets the merged
 * reader: the gate-class checklists, the Red Team checklist and the targeted brief for its classes; a non-risk code diff gets the
 * code-class checklists and the Red Team. Docs and tests keep the core read. A docs or tests diff with no numeric, results or prereg
 * claims, under review.platform on, with the platform review at HEAD, runs no reader at all (mode platform).
 */
/** Risk class read from the paths and lines (gate class, an R51 or review.risk_paths class, a classifier error), or a floor above light (FOUN-64 item 7: never the recorded review_depth). */
const riskClass = (c: ClassResult, depth: DepthResult) => c.class === 'gate' || c.risk.length > 0 || c.errors.length > 0 || depth.depth !== 'light';
/** Whether a light diff may take the platform depth (FOUN-64 item 2): docs or tests only, no numeric claims, no results, prereg, eval or checker path. The receipt and the queue ask the same. */
export const platformFits = (cls: DiffClass, paths: readonly string[], runtimeLines: number, numbers: NumbersResult) => (cls === 'docs' || cls === 'tests') && runtimeLines === 0 && !numbers.publishes && !paths.some(p => CLAIM_PATH.test(p));
/** Paths that carry results or preregistration claims: never the platform depth (FOUN-64 item 2). */
const CLAIM_PATH = /(^|\/|[-_.])(results?|prereg|preregistration|benchmarks?|evals?|scorers?|checkers?)([-_./]|$)/i;

function leanPlan(i: PlanInput, c: ClassResult, depth: DepthResult, next: NextStep): ReviewPlan {
  const sh = i.shape!;
  const risky = riskClass(c, depth);
  const skipped: string[] = [];
  const dispatches: Dispatch[] = [];
  const x = i.exclusion;
  const add = (role: Role, name: string, effort: Effort, exclude: string[] = [], extra: Partial<Dispatch> = {}) =>
    dispatches.push({ role, name, effort, exclude: x ? [...exclude, ...x.specs] : exclude, ...extra, ...(x?.keep.length ? { keep: [...x.keep] } : {}) });
  const plan = (n: NextStep, mode: ReviewMode): ReviewPlan => ({ ...depth, stepDepth: depth.depth, depthReasons: depth.reasons, reasons: c.reasons, next: n, numbers: i.numbers, dispatches, skipped, mode });
  const pr = sh.platformReview;
  const platformFit = !risky && platformFits(c.class, i.paths, depth.runtimeLines, i.numbers);
  if (next.step === 'full' && platformFit && sh.platform === 'on' && pr && pr.head === sh.head) {
    const why = `planned skip: platform review ${pr.id} by ${pr.reviewer} at ${pr.head.slice(0, 12)}`;
    for (const r of ['core checklist', 'specialists', 'red-team', 'adversarial-native', 'outside-voice', 'targeted']) skipped.push(`${r} (${why})`);
    return plan({ step: 'platform', reason: `review.platform on: the platform review ${pr.id} read HEAD ${pr.head.slice(0, 12)}, so /ship runs no reader (Step 11.5 binds the planned skip)` }, 'platform');
  }
  if (sh.platform === 'on' && next.step === 'full' && !risky) skipped.push(`platform depth (${depth.runtimeLines > 0 ? 'runtime code' : i.numbers.publishes ? 'the diff publishes numbers' : !platformFit ? 'a results, prereg, eval or checker path' : pr ? `the platform review read ${pr.head.slice(0, 12)}, not HEAD` : 'no platform review at HEAD'}: the light read runs)`);
  const classes = i.targeted?.classes.length && !i.targeted.ran ? { classes: [...i.targeted.classes] } : {};
  const docsAndOutputs = i.paths.filter(p => !i.excluded?.has(p) && ((pathClass(i, p) === 'docs' && !(i.numbers.publishes && DOC_PATH.test(p))) || isOutput(i, p))).map(excludeSpec);
  const reader = () => risky
    ? add('adversarial-native', 'merged', 'full', [], { checklists: [...batchChecklists('gate', i, skipped), 'red-team'], model: sh.readerModel, ...classes })
    : add('adversarial-native', 'single', 'full', docsAndOutputs, { checklists: [...batchChecklists('code', i, skipped), 'red-team'], model: sh.readerModel, ...classes });
  if (next.step === 'full' && (risky || depth.runtimeLines > 0)) {
    reader();
    skipped.push(`specialists, red-team and outside-voice as their own readers (R65: the one ${risky ? 'risk-class' : 'light'} reader carries them)`);
  } else if (next.step === 'full') {
    for (const n of SPECIALISTS.filter(forcedBy(i))) add('specialist', n, i.tiers === false ? 'host' : ROLE_EFFORT.specialist);
    if (i.numbers.publishes) add('outside-voice', 'outside-voice', 'host');
    else skipped.push(`outside-voice (${depth.class} class, no numeric claims)`);
  } else if (next.step === 'voices') reader();
  else if (next.step === 'fix-check') {
    add('fix-check', 'fix-check', 'full');
    if (i.numbers.publishes && i.reviewedNumbers !== undefined && i.reviewedNumbers !== i.numbers.fingerprint) add('outside-voice', 'outside-voice (numbers changed)', 'host');
  }
  if (next.step === 'fix-check' && i.targeted?.classes.length) {
    if (i.targeted.ran) skipped.push('targeted (already read this product patch)');
    else add('targeted', 'targeted', ROLE_EFFORT.targeted);
  }
  return plan(next, 'lean');
}

export function reviewPlanLine(p: ReviewPlan, pass: number): string {
  return `REVIEW_PLAN: class=${p.class} pass=${pass} next=${p.next.step} dispatches=${p.dispatches.length} numbers=${p.numbers.publishes ? `yes(${p.numbers.claims})` : 'no'} fingerprint=${p.numbers.fingerprint} reason=${JSON.stringify(p.next.reason)}`;
}

export function reviewDepthLine(p: ReviewPlan): string {
  return `REVIEW_DEPTH: ${p.depth} runtime_lines=${p.runtimeLines} rules=${p.rules} reasons=${p.depthReasons.join(',')} codes=${p.codes.join(',') || 'none'}${p.stepDepth !== p.depth ? ` step=${p.stepDepth}` : ''}`;
}
