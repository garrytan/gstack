/**
 * gstack context-bill — token bill-of-materials for an installed gstack skills tree.
 *
 * Read-only, offline, deterministic. Ledgers over pure file reads:
 *   ALWAYS-ON  per-skill YAML frontmatter bytes (what every session's skill
 *              scanner loads), flagging frontmatter keys the router never
 *              reads and foreign-host files in scanner scope.
 *   EAGER      SKILL.md plus any references the skill's prose forces "for
 *              every invocation".
 *
 * This is a STRIPPED port of the v2 fork's six-ledger bill: the CONDITIONAL,
 * TRANSITIVE, LAZY, and FAST-PATH parsers only understand the fork's
 * dispatcher-skill layout, which this repo's skills don't use, so they were
 * dropped rather than shipped dead. The tier fields stay in the report shape
 * (empty arrays / zeros / nulls) so re-adding a parser is additive: nothing
 * downstream needs a schema change.
 *
 * Token figures come from one of two sources, always named in the output:
 *   ESTIMATE (default, offline)  bytes / TOKEN_DIVISOR, calibrated against real
 *                               count_tokens measurements.
 *   EXACT (--exact, opt-in)      Anthropic's count_tokens for every file the
 *                               bill touches. Sends file content off-machine,
 *                               so it is never implicit: an egress receipt is
 *                               written before the POSTs (sink
 *                               'context-bill-exact'), and if the receipt
 *                               cannot be written the run degrades to the
 *                               offline estimate with a warning instead of
 *                               sending unrecorded.
 * Both bytes and tokens are always shown, and the estimate's measured error
 * band is printed with it. The tool never writes state anywhere (the egress
 * receipt under --exact is the one exception, and it is the point).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeReceipt } from "./egress-receipt";

const FORCED_PHRASE = "for every invocation";
// Backticked reference in prose. `<...>` is excluded: a path template such as
// `references/templates/<Name>.md` names a family of files, not one on disk.
const PROSE_REF = /`(references\/[^`<>]+\.md)`/g;
// Upstream frontmatter contract: the keys the router/host actually reads.
const ROUTER_KEYS = new Set(["name", "description", "version", "allowed-tools", "triggers", "preamble-tier"]);
// Skill-shaped files other hosts drop into scanner scope.
const FOREIGN_SKILL_FILE = /^(skill\.(ya?ml|json)|agents?\.md|\.cursorrules|\.windsurfrules)$/i;

/**
 * Bytes per token, per content class, fitted to real count_tokens measurements.
 *
 * Calibration corpus: 219 `.md` skill files plus their frontmatter blocks,
 * measured 2026-08-01 against `claude-opus-4-5` with the per-request message
 * envelope subtracted. Regenerate with `gstack-context-bill <tree> --exact
 * --json` and read the `calibration` block, which grades this estimate
 * against measured counts file by file.
 *
 * Why classes and not one divisor: measured bytes-per-token spans 2.36 to 4.72
 * across the corpus, and the spread is largely structural. Legacy specialist
 * modules cluster at 3.47 (n=50, range 3.10-3.83) and SKILL.md bodies at 4.21
 * (n=50, range 3.65-4.50) -- tight enough that one divisor for both charges
 * some ledgers about 19% under while charging others about right. Splitting on
 * path roles cuts mean per-file error from 11.1% to 7.4% and removes the
 * systematic bias, which is what a cost tool owes.
 *
 * What classes do NOT fix: the `reference` class is genuinely heterogeneous
 * (2.36 to 4.72 -- dense path/table files sit at one end, prose at the other),
 * so worst-case per-file error stays near 40%. Use --exact when a single
 * file's number has to be right.
 *
 * These divisors are tokenizer-specific. Opus 4.7 and later tokenize
 * differently; on those models use --exact.
 */
export const TOKEN_DIVISORS: Record<string, number> = {
  frontmatter: 3.99,
  skillmd: 4.21,
  reference: 4.15,
  artifact: 3.67,
  legacy: 3.47,
};
/** Fallback for content that matches no class. Corpus-wide aggregate. */
export const TOKEN_DIVISOR = 3.9;
/** Worst-case per-file residual of the estimate over the calibration corpus. */
export const TOKEN_ESTIMATE_ERROR_PCT = 40;

export type TokensOf = (key: string, bytes: number) => number;

export interface RefEntry {
  path: string;
  bytes: number;
  tokens: number;
  missing: boolean;
  via?: string;
  condition?: string;
}

export interface SkillBill {
  name: string;
  dir: string;
  frontmatterBytes: number;
  frontmatterTokens: number;
  frontmatterKeys: string[];
  deadKeys: string[];
  skillMdBytes: number;
  skillMdTokens: number;
  forcedRefs: RefEntry[];
  eagerBytes: number;
  eagerTokens: number;
  /** Stripped tiers: kept in the shape (empty/zero/null) so re-adding the
   * fork's parsers is additive. */
  fastPath: null;
  conditionalRefs: RefEntry[];
  conditionalBytes: number;
  conditionalTokens: number;
  transitiveRefs: RefEntry[];
  transitiveBytes: number;
  transitiveTokens: number;
  perInvocationBytes: number;
  perInvocationTokens: number;
  routeCeiling: { label: string; bytes: number; tokens: number } | null;
  lazy: { label: string; modules: RefEntry[]; bytes: number; tokens: number }[];
  orphans: RefEntry[];
  foreignFiles: { path: string; bytes: number; tokens: number }[];
  totalMdBytes: number;
  totalMdTokens: number;
}

/**
 * Content class from the path role. Legacy/artifact roles are kept even
 * though their tiers are stripped: the divisors are per-content measurements
 * and --exact calibration still grades them.
 */
export function contentClass(key: string): string {
  if (key.endsWith("#frontmatter")) return "frontmatter";
  if (/references[/\\]legacy[/\\]/.test(key)) return "legacy";
  if (/references[/\\](artifacts|sections|support)[/\\]/.test(key)) return "artifact";
  if (/(^|[/\\])SKILL\.md$/.test(key)) return "skillmd";
  if (/references[/\\]/.test(key)) return "reference";
  return "other";
}

/** Path-less callers get the corpus-wide aggregate divisor. */
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / TOKEN_DIVISOR);
}

/** Default token source: the calibrated offline estimate. Unrounded, so sums round once. */
function estimateTokensOf(key: string, bytes: number): number {
  return bytes / (TOKEN_DIVISORS[contentClass(key)] ?? TOKEN_DIVISOR);
}

function bytesOf(file: string): number | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function refEntry(skillDir: string, rel: string, tokensOf: TokensOf): RefEntry {
  const abs = path.join(skillDir, rel);
  const bytes = bytesOf(abs);
  return {
    path: rel,
    bytes: bytes ?? 0,
    tokens: bytes == null ? 0 : tokensOf(abs, bytes),
    missing: bytes == null,
  };
}

function sumBytes(entries: { bytes: number }[]): number {
  return entries.reduce((n, e) => n + e.bytes, 0);
}

function sumTokens(entries: { tokens: number }[]): number {
  return entries.reduce((n, e) => n + e.tokens, 0);
}

/** Cache key for a SKILL.md's frontmatter block, which is a slice, not a whole file. */
function frontmatterKey(skillMdPath: string): string {
  return `${skillMdPath}#frontmatter`;
}

function parseFrontmatter(text: string): { bytes: number; keys: string[]; block: string } {
  if (!text.startsWith("---")) return { bytes: 0, keys: [], block: "" };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { bytes: 0, keys: [], block: "" };
  const closeEol = text.indexOf("\n", end + 1);
  const block = text.slice(0, closeEol === -1 ? text.length : closeEol + 1);
  const inner = text.slice(text.indexOf("\n") + 1, end);
  const keys: string[] = [];
  for (const line of inner.split("\n")) {
    const m = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (m) keys.push(m[1]);
  }
  return { bytes: Buffer.byteLength(block, "utf8"), keys, block };
}

/**
 * Every .md file under a tree, for the on-disk total and for exact
 * measurement. Skips node_modules and dot-directories: a skills tree that is
 * also a repo checkout (dev symlink installs) would otherwise bill its
 * dependency tree and CI state as skill content.
 */
export function walkMd(dir: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try {
          isDir = fs.statSync(p).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) {
        let real: string;
        try {
          real = fs.realpathSync(p);
        } catch {
          continue;
        }
        if (visited.has(real)) continue;
        visited.add(real);
        walk(p);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

function totalMd(dir: string, tokensOf: TokensOf): { bytes: number; tokens: number } {
  let bytes = 0;
  let tokens = 0;
  for (const p of walkMd(dir)) {
    // A skill dir that CONTAINS other skill dirs (the gstack root skill wraps
    // the whole tree) must not swallow its children's files: each nested
    // skill reports its own totalMd, and the grand total sums per-skill
    // figures — counting them here again double-counted every nested skill
    // in the TOTAL line (v1.63 deferred polish, fixed in fork port wave 2).
    const rel = path.relative(dir, p);
    const topSeg = rel.split(path.sep)[0];
    if (
      topSeg &&
      topSeg !== rel && // p is inside a subdirectory
      fs.existsSync(path.join(dir, topSeg, "SKILL.md"))
    ) {
      continue;
    }
    const b = bytesOf(p) ?? 0;
    bytes += b;
    tokens += tokensOf(p, b);
  }
  return { bytes, tokens };
}

export function parseSkill(skillDir: string, name: string, tokensOf: TokensOf = estimateTokensOf): SkillBill {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const text = fs.readFileSync(skillMdPath, "utf8");
  const skillMdBytes = bytesOf(skillMdPath) ?? 0;
  const skillMdTokens = tokensOf(skillMdPath, skillMdBytes);
  const fm = parseFrontmatter(text);
  // The frontmatter block is a slice of SKILL.md, so it carries its own key.
  const frontmatterTokens = tokensOf(frontmatterKey(skillMdPath), fm.bytes);
  const deadKeys = fm.keys.filter((k) => !ROUTER_KEYS.has(k));

  // EAGER: references a prose CLAUSE forces "for every invocation". Clause
  // granularity matters: a line can carry a forced clause and a conditional
  // one, and only the forced clause's references are eager. Routing tables
  // never count (they were the fork's LAZY tier).
  const forcedRefs: RefEntry[] = [];
  const seenForced = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("|")) continue;
    for (const clause of line.split(/(?<=[.;])\s+/)) {
      if (!clause.includes(FORCED_PHRASE)) continue;
      for (const m of clause.matchAll(PROSE_REF)) {
        const p = m[1];
        if (seenForced.has(p)) continue;
        seenForced.add(p);
        forcedRefs.push(refEntry(skillDir, p, tokensOf));
      }
    }
  }

  // Foreign-host skill files sitting next to SKILL.md.
  const foreignFiles: { path: string; bytes: number; tokens: number }[] = [];
  for (const entry of fs.readdirSync(skillDir, { withFileTypes: true })) {
    if (entry.isFile() && FOREIGN_SKILL_FILE.test(entry.name)) {
      const abs = path.join(skillDir, entry.name);
      const bytes = bytesOf(abs) ?? 0;
      foreignFiles.push({ path: entry.name, bytes, tokens: tokensOf(abs, bytes) });
    }
  }

  const total = totalMd(skillDir, tokensOf);
  const eagerBytes = skillMdBytes + sumBytes(forcedRefs);
  const eagerTokens = skillMdTokens + sumTokens(forcedRefs);
  return {
    name,
    dir: skillDir,
    frontmatterBytes: fm.bytes,
    frontmatterTokens,
    frontmatterKeys: fm.keys,
    deadKeys,
    skillMdBytes,
    skillMdTokens,
    forcedRefs,
    eagerBytes,
    eagerTokens,
    // Stripped tiers, shape preserved (see the module docblock).
    fastPath: null,
    conditionalRefs: [],
    conditionalBytes: 0,
    conditionalTokens: 0,
    transitiveRefs: [],
    transitiveBytes: 0,
    transitiveTokens: 0,
    // With the conditional/transitive tiers stripped, the per-invocation
    // ceiling IS the eager figure. Re-adding a tier changes these sums only.
    perInvocationBytes: eagerBytes,
    perInvocationTokens: eagerTokens,
    routeCeiling: null,
    lazy: [],
    orphans: [],
    foreignFiles,
    totalMdBytes: total.bytes,
    totalMdTokens: total.tokens,
  };
}

/**
 * Every skill directory under a tree.
 *
 * Root-as-container (upstream fix): this repo's ROOT has a router SKILL.md
 * AND fifty skill directories under it — the fork's walker short-circuited at
 * the root and billed one "skill". The root is counted as a skill (the router
 * costs what it costs) and the walk continues into its children. A NON-root
 * dir with SKILL.md is still a leaf: its subtree (references/, test
 * fixtures) is never another skill.
 *
 * Repo-checkout subdirs are skipped (upstream install layout fix): an
 * installed ~/.claude/skills tree contains flat skill dirs PLUS a full gstack
 * repo checkout (`gstack/`, with .git). Its nested SKILL.md files are the
 * repo's sources, not installed skills of the tree being billed.
 *
 * Directory symlinks are followed (setup's shell glob follows them, so a
 * symlinked skill like connect-chrome/ is real scanner load); a realpath
 * seen-set breaks cycles.
 */
export function findSkillDirs(root: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (dir: string, isRoot: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      out.push(dir);
      // Two symlinked paths to the same skill dir are BOTH billed (each is
      // real scanner load); only container recursion below is cycle-guarded.
      if (!isRoot) return;
    }
    // Cycle guard for container recursion (a symlink loop of directories).
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const child = path.join(dir, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try {
          isDir = fs.statSync(child).isDirectory();
        } catch {
          continue; // dangling symlink
        }
      }
      if (!isDir) continue;
      if (fs.existsSync(path.join(child, ".git"))) continue; // repo checkout, not a skill
      walk(child, false);
    }
  };
  walk(path.resolve(root), true);
  return out.sort();
}

export interface Bill {
  root: string;
  tokenSource: string;
  tokenEstimate: Record<string, number>;
  tokenEstimateErrorPct:

# ... [truncated]