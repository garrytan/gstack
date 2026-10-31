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

export type DiffClass = 'docs' | 'tests' | 'code' | 'gate';
export type PathClass = 'docs' | 'tests' | 'code';
export type Depth = 'light' | 'standard' | 'full';
export type Effort = 'light' | 'medium' | 'full' | 'host';
export type Role = 'specialist' | 'red-team' | 'adversarial-native' | 'outside-voice' | 'fix-check' | 'targeted';
export type Step = 'full' | 'scoped' | 'fix-check' | 'done' | 'stop';

export const SPECIALISTS = ['testing', 'maintainability', 'security', 'performance', 'data-migration', 'api-contract', 'design', 'simplification', 'state-machines'] as const;
export type Specialist = (typeof SPECIALISTS)[number];
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
/** Gate paths, the review-depth machinery included: an edit to how much review runs gets the most review. */
const GATE_PATH = [
  /(^|\/)\.github\/workflows\//, /(^|\/)(secrets?|credentials?|keychain|token[s]?)([._/-]|$)/i, /state-root/, /(^|\/)(pregate|gate|ship-receipt|ship-policy)[^/]*\.(ts|sh|json)$/, /(^|\/)bin\/gstack-(pregate|gate|ship-receipt|verify-gate|ci-gate)$/,
  /^lib\/review-(depth|collect|scope|targeted)\.ts$/, /^review\/specialists\/targeted\.md$/, /^bin\/gstack-review-plan$/, /^lib\/ship-queue[^/]*\.ts$/, /^lib\/regen\.ts$/, /^\.gstack\/generated\.json$/, /^ship\/sections\/(review-army|adversarial)\.md\.tmpl$/, /^scripts\/resolvers\/review-army\.ts$/,
];

/** Data files: JSON, CSV, TSV and raster images. YAML, TOML and SVG are never data here: deploy configs, API specs and executable SVG stay code. */
export const DATA_PATH = /\.(json|jsonl|ndjson|csv|tsv|png|jpe?g|gif|webp|bmp|ico|avif)$/i;
/** Data-shaped files tools read by convention, with no code naming them: always code. */
const DATA_CONFIG = [
  /(^|\/)\.github\//, /(^|\/)config\//, /(^|\/)\.[^/]+$/, /(^|\/)[^/]+\.config\.[^/]+$/,
  /(^|\/)(package|package-lock|npm-shrinkwrap|composer|deno|jsr|tsconfig[^/]*|jsconfig[^/]*|manifest|app|vercel|netlify|firebase|renovate|turbo|nx|lerna|biome|angular|nest-cli|lint-staged|components|pyrightconfig|cdk|serverless|appsettings[^/]*)\.json$/i,
];

/** A hash of the constants and patterns that decide a depth, not of this file's bytes: a comment edit keeps it, a threshold edit changes it. */
export const DEPTH_RULES = createHash('sha256').update(JSON.stringify({
  SMALL_DIFF_LINES, RED_TEAM_LINES, LARGE_DIFF_LINES, FULL_PASS_CAP, LIGHT_FIXED, BATCH_SCOPED, SCOPED_RANGE_LINES, ROLE_EFFORT,
  patterns: Object.entries({ GATE_PATH, AGENT_PROSE, TEST_PATH, RELEASE_METADATA, DOC_PATH: [DOC_PATH], DATA_PATH: [DATA_PATH], DATA_CONFIG }).map(([k, v]) => [k, v.map(r => `/${r.source}/${r.flags}`)]),
})).digest('hex').slice(0, 16);

/**
 * One changed path's class. Markdown an agent or a gate reads (skills, sections, resolvers, policy and rule docs,
 * templates, any markdown in a skill directory) is code: it is gstack's product. `root` is the repository root
 * (skill directories probed on disk) or the top-level skill directory names read from a commit.
 */
export function classifyPath(p: string, root?: string | readonly string[]): PathClass {
  if (RELEASE_METADATA.some(r => r.test(p))) return 'docs';
  if (AGENT_PROSE.some(r => r.test(p))) return 'code';
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
  return DATA_PATH.test(p) && classifyPath(p, root) === 'code' && ![...AGENT_PROSE, ...GATE_PATH, ...DATA_CONFIG].some(r => r.test(p));
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
}
export interface ClassResult { class: DiffClass; reasons: string[]; errors: DepthError[]; runtimeLines: number | null }

const sanitize = (s: string) => s.replace(/[\0-\x1f]+/g, ' ').slice(0, 200);
const isOutput = (i: ClassInput, p: string) => !!i.registry?.outputs.length && matchesAny(i.registry.outputs, p);
const unconsumedData = (i: ClassInput, p: string) => Array.isArray(i.consumed) && !i.consumed.includes(p) && dataCandidate(p, i.root);
const pathClass = (i: ClassInput, p: string): PathClass => ((i.stampOnly ?? []).includes(p) || unconsumedData(i, p) ? 'docs' : classifyPath(p, i.root));

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
    const deletedGuarded = (i.deleted ?? []).filter(p => classifyPath(p, i.root) !== 'docs');
    if (deletedGuarded.length) raise('gate', `deletes ${deletedGuarded.length} code or test path(s)`);
  }
  if (CLASS_RANK[cls] >= CLASS_RANK.code) {
    if (s.SCOPE_AUTH === 'true') raise('gate', 'auth paths');
    if (s.SCOPE_MIGRATIONS === 'true') raise('gate', 'migrations');
    for (const p of i.paths) if (GATE_PATH.some(r => r.test(p))) { raise('gate', `gate path: ${p}`); break; }
    if (i.registry?.error) errors.push(i.registry.error);
  }
  if (!i.perPath) return { class: cls, reasons, errors, runtimeLines: null };
  let runtimeLines = 0;
  for (const e of i.perPath) {
    if (pathClass(i, e.path) !== 'code' || isOutput(i, e.path)) continue;
    if (e.binary) errors.push({ code: 'binary_code_path', detail: 'git reports a binary change, so its lines cannot be counted', input: e.path, repair: "register it as an output of an entry with a command in the base branch's .gstack/generated.json, or accept the full review" });
    else runtimeLines += e.lines;
  }
  return { class: cls, reasons, errors, runtimeLines };
}

/** Any classifier error or gate class is full; runtime above SMALL_DIFF_LINES is standard; otherwise light. A floor only raises. */
export function depthFor(o: { cls: DiffClass; runtimeLines: number; errors: readonly DepthError[]; floor?: Depth }): Depth {
  const d: Depth = o.errors.length || o.cls === 'gate' ? 'full' : o.runtimeLines > SMALL_DIFF_LINES ? 'standard' : 'light';
  return o.floor && DEPTH_RANK[o.floor] > DEPTH_RANK[d] ? o.floor : d;
}

export interface DepthResult { depth: Depth; class: DiffClass; runtimeLines: number; reasons: string[]; errors: DepthError[]; codes: ResultCodeName[]; rules: string }

function decideDepth(c: ClassResult, runtimeLines: number, floor?: Depth): DepthResult {
  const unfloored = depthFor({ cls: c.class, runtimeLines, errors: c.errors });
  const reasons = [...c.errors.map(e => `error:${e.code}`), ...(c.class === 'gate' ? ['gate-class'] : []), `runtime=${runtimeLines}${runtimeLines > SMALL_DIFF_LINES ? '>' : '<='}${SMALL_DIFF_LINES}`];
  if (floor && DEPTH_RANK[floor] > DEPTH_RANK[unfloored]) reasons.push(`floor:${floor}`);
  const codes = [...new Set(c.errors.flatMap(e => (e.result ? [e.result] : [])))];
  return { depth: depthFor({ cls: c.class, runtimeLines, errors: c.errors, floor }), class: c.class, runtimeLines, reasons, errors: c.errors, codes, rules: DEPTH_RULES };
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
}
export interface NextStep { step: Step; reason: string }

/**
 * The transition table (docs/review-policy.md#transitions). Pass 1 is full. A fixed
 * blocking finding earns a second full pass on the range, scoped when `depth` (known
 * only to planReview) is below full and the fix range has at most SCOPED_RANGE_LINES
 * runtime lines; any other fix earns one fix-check; two full passes is the cap (a
 * scoped pass is one); a blocker still open after any step stops for the owner.
 */
export function nextStep(h: History, depth?: Depth): NextStep {
  if (h.last === 'none') return { step: 'full', reason: 'pass 1 reviews the whole diff' };
  const fixed = !!(h.fixedBlocking || h.fixedBelow);
  if (h.last === 'fix-check') return h.blockingOpen || fixed ? { step: 'stop', reason: 'the fix-check found a blocking finding: name it for the owner, never a third full pass' } : { step: 'done', reason: 'the fix-check found nothing blocking' };
  if (h.blockingOpen && h.fullPasses >= FULL_PASS_CAP) return { step: 'stop', reason: `a blocking finding is open after ${FULL_PASS_CAP} full passes: name it for the owner` };
  if (h.blockingOpen) return { step: 'stop', reason: 'a blocking finding is still open in fix scope: name it for the owner' };
  if (!fixed) return { step: 'done', reason: 'the step applied no edits' };
  if ((h.fixedBlocking || h.touchedGate) && h.fullPasses < FULL_PASS_CAP) {
    if (!h.fixedBlocking) return { step: 'full', reason: 'a fix touched a gate-class path: full pass on the range' };
    const n = h.rangeRuntimeLines;
    const keep = h.touchedGate ? 'a fix touched a gate-class path' : depth === undefined ? 'the depth is unknown' : h.pass1Depth === 'full' ? 'pass 1 ran at full depth' : depth === 'full' ? 'the diff is at full depth'
      : typeof n !== 'number' || !Number.isFinite(n) || n < 0 ? 'the fix range was not read' : n > SCOPED_RANGE_LINES ? `the fix range has ${n} runtime lines (> ${SCOPED_RANGE_LINES})` : null;
    if (keep) return { step: 'full', reason: `a blocking finding was fixed and ${keep}: full pass on the range` };
    return { step: 'scoped', reason: `a blocking finding was fixed on a ${depth} diff with ${n} runtime lines in the fix range (<= ${SCOPED_RANGE_LINES}): scoped pass on the range` };
  }
  return { step: 'fix-check', reason: h.fixedBlocking ? `full-pass cap ${FULL_PASS_CAP} reached: one fix-check reads the fix` : 'only below-floor fixes: one fix-check reads the touched hunks' };
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
}
/** One reviewer. `exclude` holds git pathspec argv items the reviewer's diff leaves out; `checklists` names what the batched specialist reads. */
export interface Dispatch { role: Role; name: string; effort: Effort; exclude: string[]; checklists?: string[]; reason?: string }
export interface ReviewPlan extends DepthResult {
  /** The depth this step runs at: light raised to standard by a fixed blocker, a CRITICAL or an open blocker. */
  stepDepth: Depth;
  depthReasons: string[];
  next: NextStep; numbers: NumbersResult; dispatches: Dispatch[]; skipped: string[];
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

/** The reviewers the next step dispatches at its depth, with each role's effort tier and excluded pathspecs. */
export function planReview(i: PlanInput): ReviewPlan {
  const c = classifyDiff(i);
  const depth = decideDepth(c, c.runtimeLines ?? (CLASS_RANK[c.class] >= CLASS_RANK.code ? i.diffLines : 0), i.floor);
  const { class: cls, runtimeLines } = depth;
  const next = nextStep(i.history, depth.depth);
  const h = i.history;
  const raise = depth.depth === 'light' && (h.fixedBlocking || h.blockingOpen || i.criticalFound);
  const stepDepth: Depth = raise ? 'standard' : depth.depth;
  const depthReasons = [...depth.reasons, ...(raise ? [`history:${h.fixedBlocking ? 'fixed-blocking' : h.blockingOpen ? 'blocking-open' : 'critical-found'}`] : [])];
  const skipped: string[] = [];
  const dispatches: Dispatch[] = [];
  const add = (role: Role, name: string, effort: Effort, exclude: string[] = [], extra: Partial<Dispatch> = {}) => dispatches.push({ role, name, effort, exclude, ...extra });
  const docsAndOutputs = i.paths.filter(p => pathClass(i, p) === 'docs' || isOutput(i, p)).map(excludeSpec);
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
    const raised = !full && runtimeLines <= SMALL_DIFF_LINES;
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
  }
  if (i.targeted?.classes.length && ['full', 'scoped', 'fix-check'].includes(next.step)) {
    if (i.targeted.ran) skipped.push('targeted (already read this product patch)');
    else add('targeted', 'targeted', ROLE_EFFORT.targeted);
  }
  return { ...depth, stepDepth, depthReasons, reasons: c.reasons, next, numbers: i.numbers, dispatches, skipped };
}

export function reviewPlanLine(p: ReviewPlan, pass: number): string {
  return `REVIEW_PLAN: class=${p.class} pass=${pass} next=${p.next.step} dispatches=${p.dispatches.length} numbers=${p.numbers.publishes ? `yes(${p.numbers.claims})` : 'no'} fingerprint=${p.numbers.fingerprint} reason=${JSON.stringify(p.next.reason)}`;
}

export function reviewDepthLine(p: ReviewPlan): string {
  return `REVIEW_DEPTH: ${p.depth} runtime_lines=${p.runtimeLines} rules=${p.rules} reasons=${p.depthReasons.join(',')} codes=${p.codes.join(',') || 'none'}${p.stepDepth !== p.depth ? ` step=${p.stepDepth}` : ''}`;
}
