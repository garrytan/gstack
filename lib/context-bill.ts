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
 *   EXACT (--exact, opt-in)      Anthropic's count_tokens for every billed .md
 *                               file inside the tree, the linked gstack
 *                               checkout or $GSTACK_STATE_ROOT/render; anything
 *                               else a symlink reaches is named and estimated,
 *                               and the bill is labelled mixed. Sends file
 *                               content off-machine, so it is never implicit:
 *                               an egress receipt is written before the POSTs
 *                               (sink 'context-bill-exact'), and if the
 *                               receipt cannot be written the run degrades to
 *                               the offline estimate with a warning instead of
 *                               sending unrecorded.
 * Both bytes and tokens are always shown, and the estimate's measured error
 * band is printed with it. The tool never writes state anywhere (the egress
 * receipt under --exact is the one exception, and it is the point).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeReceipt } from "./egress-receipt";
import { resolveStateRoot } from "./state-root";

const FORCED_PHRASE = "for every invocation";
// Backticked reference in prose. `<...>` is excluded: a path template such as
// `references/templates/<Name>.md` names a family of files, not one on disk.
const PROSE_REF = /`(references\/[^`<>]+\.md)`/g;
// Upstream frontmatter contract: the keys the router/host actually reads.
const ROUTER_KEYS = new Set(["name", "description", "version", "allowed-tools", "triggers", "preamble-tier"]);
// Skill-shaped files other hosts drop into scanner scope.
const FOREIGN_SKILL_FILE = /^(skill\.(ya?ml|json)|agents?\.md|\.cursorrules|\.windsurfrules)$/i;
/** Directory entries one walkMdFiles or findSkillDirs call may examine before it refuses the tree. */
const WALK_ENTRY_CAP = 200_000;
/** tokenSource prefix of a bill that --exact priced partly by estimate. */
const MIXED_PREFIX = "mixed: ";

function entryCapError(dir: string, cap: number): Error {
  return new Error(
    `${dir} has more than ${cap} entries to walk; a symlink in it probably points at a large tree. ` +
      `Nothing was billed or sent. Remove or narrow that link and run again.`,
  );
}

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

/**
 * Cache key for a .md file's frontmatter block, which is a slice, not a whole
 * file. The bill looks it up through a SKILL.md path; --exact measures it once
 * per real SKILL.md the bill prices, keyed by the first path the send set
 * reached that file by, so a SKILL.md first walked under another name still
 * has one.
 */
function frontmatterKey(mdPath: string): string {
  return `${mdPath}#frontmatter`;
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

/** Whether a path is a regular file once symlinks are followed; a dangling link is not. */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * What a directory entry is once symlinks are followed. Installed skills are
 * symlinks into the gstack checkout (`review/SKILL.md -> <checkout>/review/SKILL.md`,
 * `office-hours/sections -> <checkout>/office-hours/sections`), so a plain
 * Dirent type check sees none of them. Dangling links and anything that is
 * neither a file nor a directory are null.
 */
function entryKind(p: string, e: fs.Dirent): "file" | "dir" | null {
  if (e.isFile()) return "file";
  if (e.isDirectory()) return "dir";
  if (!e.isSymbolicLink()) return null;
  try {
    const st = fs.statSync(p);
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : null;
  } catch {
    return null;
  }
}

/**
 * The realpath of `p`, resolved one component at a time the way the walk
 * reads directories, so a lexical path that crosses more links than the
 * kernel's limit still resolves.
 */
function realpathStepwise(p: string): string {
  const abs = path.resolve(p);
  const { root } = path.parse(abs);
  let real = fs.realpathSync(root);
  for (const segment of abs.slice(root.length).split(path.sep)) {
    if (segment) real = fs.realpathSync(path.join(real, segment));
  }
  return real;
}

/**
 * Whether directory `outer` contains (or is) `inner`, both realpaths. A
 * followed directory symlink that contains the tree being walked (`..`, `/`,
 * `$HOME`) would climb out of that tree, so walkers refuse it.
 */
function encloses(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** walkMdFiles(dir)'s lexical paths, with no billedRoot fence or nested-skill skip. Only tests call it; the bill and --exact use walkMdFiles. */
export function walkMd(dir: string): string[] {
  return walkMdFiles(dir).map((f) => f.path);
}

export interface WalkedFile {
  /** The lexical path under the walked dir; the key the bill and --exact use. */
  path: string;
  /** The file's realpath when it was walked. */
  real: string;
  /** The file's identity, taken without following links when it was walked; --exact reads only that same file. */
  dev: number;
  ino: number;
  /** Its size and mtime when it was walked; a measurement is reused only for a file that still has them. */
  size: number;
  mtimeMs: number;
}

/**
 * Every .md file under a tree, with its realpath and identity, for the
 * on-disk total and for exact measurement. Skips node_modules and
 * dot-directories: a skills tree that is also a repo checkout (dev symlink
 * installs) would otherwise bill its dependency tree and CI state as skill
 * content. A child repo checkout (the
 * `gstack/` link inside ~/.claude/skills) is skipped for the same reason.
 *
 * Symlinked files and directories are followed, and every returned path stays
 * the lexical path under `dir`, so buildBill and --exact key the same files.
 * Each real directory is expanded once and each real file returned once per
 * walk, under the first lexical path reached with entries in sorted order: a
 * skill loads a file once however many links reach it, and links that fan out
 * into each other cannot multiply the walk. A directory that encloses `dir`,
 * or `billedRoot` (the tree a skill is billed under), is never entered. A link
 * named *.md counts only when its target is a .md file too, so --exact never
 * sends a non-markdown file through a markdown-named link. More than
 * WALK_ENTRY_CAP entries is an error, never a silent cut.
 *
 * With `skipNestedSkills`, a top-level subdirectory holding its own SKILL.md is
 * not entered, so a container skill keeps the files it shares with a nested
 * skill instead of losing them to whichever path sorted first. The root
 * container also skips a nested skill reached through a directory link at any
 * depth: discovery bills that skill on its own, and the plain walk this
 * replaced never followed directory links, so counting it here too would bill
 * it twice.
 *
 * Every directory is read through its realpath, so a lookup crosses at most
 * one link however deep the lexical path runs: a chain of links never hits
 * the kernel's link-depth limit (ELOOP) and silently loses the files past it.
 */
export function walkMdFiles(dir: string, opts: { billedRoot?: string; skipNestedSkills?: boolean } = {}): WalkedFile[] {
  const out: WalkedFile[] = [];
  let rootReal: string;
  let billedReal: string;
  try {
    rootReal = fs.realpathSync(dir);
    billedReal = fs.realpathSync(opts.billedRoot ?? dir);
  } catch {
    return out;
  }
  const seen = new Set<string>([rootReal]);
  const container = rootReal === billedReal;
  let entryCount = 0;
  const walk = (current: string, currentReal: string, viaLink: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentReal, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++entryCount > WALK_ENTRY_CAP) throw entryCapError(dir, WALK_ENTRY_CAP);
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const viaReal = path.join(currentReal, e.name);
      const kind = entryKind(viaReal, e);
      if (kind === "file") {
        if (!e.name.endsWith(".md")) continue;
      } else if (
        kind !== "dir" ||
        fs.existsSync(path.join(viaReal, ".git")) ||
        (opts.skipNestedSkills &&
          (current === dir || (container && (viaLink || e.isSymbolicLink()))) &&
          isFile(path.join(viaReal, "SKILL.md")))
      ) {
        continue;
      }
      let real: string;
      try {
        real = fs.realpathSync(viaReal);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      const p = path.join(current, e.name);
      if (kind === "file") {
        if (!real.endsWith(".md")) continue;
        let st: fs.Stats;
        try {
          st = fs.lstatSync(real);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        seen.add(real);
        out.push({ path: p, real, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
        continue;
      }
      if (encloses(real, rootReal) || encloses(real, billedReal)) continue;
      seen.add(real);
      walk(p, real, viaLink || e.isSymbolicLink());
    }
  };
  walk(dir, rootReal, false);
  return out;
}

function totalMd(dir: string, tokensOf: TokensOf, billedRoot: string): { bytes: number; tokens: number } {
  let bytes = 0;
  let tokens = 0;
  // A skill dir that CONTAINS other skill dirs (the gstack root skill wraps
  // the whole tree) must not swallow its children's files: each nested
  // skill reports its own totalMd, and the grand total sums per-skill
  // figures — counting them here again double-counted every nested skill
  // in the TOTAL line (v1.63 deferred polish, fixed in fork port wave 2).
  for (const { path: p, real } of walkMdFiles(dir, { billedRoot, skipNestedSkills: true })) {
    const b = bytesOf(real) ?? 0;
    bytes += b;
    tokens += tokensOf(p, b);
  }
  return { bytes, tokens };
}

export function parseSkill(
  skillDir: string,
  name: string,
  tokensOf: TokensOf = estimateTokensOf,
  billedRoot: string = skillDir,
): SkillBill {
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
    const abs = path.join(skillDir, entry.name);
    if (FOREIGN_SKILL_FILE.test(entry.name) && entryKind(abs, entry) === "file") {
      const bytes = bytesOf(abs) ?? 0;
      foreignFiles.push({ path: entry.name, bytes, tokens: tokensOf(abs, bytes) });
    }
  }

  const total = totalMd(skillDir, tokensOf, billedRoot);
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
 * Symlinks are followed. Directory links: setup's shell glob follows them, so
 * a symlinked skill like connect-chrome/ is real scanner load. File links:
 * setup installs every skill as a real directory whose SKILL.md is a symlink
 * into the checkout, so skipping them billed a real install as two skills.
 * A realpath seen-set breaks cycles, a link to a directory that encloses the
 * root is never followed, and every returned path stays under the root.
 */
export function findSkillDirs(root: string, entryCap: number = WALK_ENTRY_CAP): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const rootDir = path.resolve(root);
  let entryCount = 0;
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(rootDir);
  } catch {
    return out;
  }
  // Each directory is read through its realpath (see walkMdFiles), so a deep
  // chain of links cannot hit the kernel's link limit and drop a skill.
  const walk = (dir: string, real: string, isRoot: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === "SKILL.md" && entryKind(path.join(real, e.name), e) === "file")) {
      out.push(dir);
      // Two symlinked paths to the same skill dir are BOTH billed (each is
      // real scanner load); only container recursion below is cycle-guarded.
      if (!isRoot) return;
    }
    // Cycle guard for container recursion (a symlink loop of directories).
    if (visited.has(real)) return;
    visited.add(real);
    for (const e of entries) {
      if (++entryCount > entryCap) throw entryCapError(rootDir, entryCap);
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const viaReal = path.join(real, e.name);
      if (entryKind(viaReal, e) !== "dir") continue;
      if (fs.existsSync(path.join(viaReal, ".git"))) continue; // repo checkout, not a skill
      let childReal: string;
      try {
        childReal = fs.realpathSync(viaReal);
      } catch {
        continue;
      }
      if (encloses(childReal, rootReal)) continue; // would climb out of the root
      walk(path.join(dir, e.name), childReal, false);
    }
  };
  walk(rootDir, rootReal, true);
  return out.sort();
}

export interface Bill {
  root: string;
  tokenSource: string;
  tokenEstimate: Record<string, number>;
  tokenEstimateErrorPct: number;
  calibration?: Calibration;
  skills: SkillBill[];
  totals: {
    skillCount: number;
    alwaysOnBytes: number;
    alwaysOnTokens: number;
    eagerBytesBySkill: Record<string, number>;
    eagerTokensBySkill: Record<string, number>;
    perInvocationBytesBySkill: Record<string, number>;
    perInvocationTokensBySkill: Record<string, number>;
    totalMdBytes: number;
    totalMdTokens: number;
  };
}

export function buildBill(
  root: string,
  { tokensOf = estimateTokensOf, tokenSource, calibration, missedKeys }: {
    tokensOf?: TokensOf;
    tokenSource?: string;
    calibration?: Calibration;
    /** Keys a measured tokensOf had to estimate; filled while the bill is priced. */
    missedKeys?: ReadonlySet<string>;
  } = {},
): Bill {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) throw new Error(`No such tree: ${resolved}`);
  const skills = findSkillDirs(resolved).map((dir) =>
    parseSkill(dir, path.relative(resolved, dir) || path.basename(resolved), tokensOf, resolved),
  );
  const total = skills.reduce((n, s) => n + s.totalMdBytes, 0);
  const totalTokens = skills.reduce((n, s) => n + s.totalMdTokens, 0);
  const estimated = tokenSource ? (missedKeys?.size ?? 0) : 0;
  return {
    root: resolved,
    // Named so a reader never has to guess whether a figure was measured.
    tokenSource: !tokenSource
      ? "estimate: calibrated bytes/token per content class"
      : estimated
        ? `${MIXED_PREFIX}${tokenSource}, with ${estimated} item(s) estimated offline`
        : tokenSource,
    tokenEstimate: TOKEN_DIVISORS,
    tokenEstimateErrorPct: tokenSource && !estimated ? 0 : TOKEN_ESTIMATE_ERROR_PCT,
    // Present only under --exact: how far the offline estimate was off, per file.
    ...(calibration ? { calibration } : {}),
    skills,
    totals: {
      skillCount: skills.length,
      alwaysOnBytes: skills.reduce((n, s) => n + s.frontmatterBytes, 0),
      alwaysOnTokens: skills.reduce((n, s) => n + s.frontmatterTokens, 0),
      eagerBytesBySkill: Object.fromEntries(skills.map((s) => [s.name, s.eagerBytes])),
      eagerTokensBySkill: Object.fromEntries(skills.map((s) => [s.name, Math.round(s.eagerTokens)])),
      perInvocationBytesBySkill: Object.fromEntries(skills.map((s) => [s.name, s.perInvocationBytes])),
      perInvocationTokensBySkill: Object.fromEntries(
        skills.map((s) => [s.name, Math.round(s.perInvocationTokens)]),
      ),
      totalMdBytes: total,
      totalMdTokens: totalTokens,
    },
  };
}

export interface DiffRow {
  ledger: string;
  label: string;
  before: number;
  after: number;
  delta: number;
  tokenDelta: number;
}

export function diffBills(a: Bill, b: Bill): { rows: DiffRow[]; grew: boolean } {
  const rows: DiffRow[] = [];
  const push = (ledger: string, label: string, before: number, after: number, tokBefore: number, tokAfter: number) => {
    if (before !== after) {
      rows.push({ ledger, label, before, after, delta: after - before, tokenDelta: Math.round(tokAfter - tokBefore) });
    }
  };
  const skillNames = [...new Set([...a.skills, ...b.skills].map((s) => s.name))].sort();
  for (const name of skillNames) {
    const sa = a.skills.find((s) => s.name === name);
    const sb = b.skills.find((s) => s.name === name);
    push(
      "always-on", name,
      sa?.frontmatterBytes ?? 0, sb?.frontmatterBytes ?? 0,
      sa?.frontmatterTokens ?? 0, sb?.frontmatterTokens ?? 0,
    );
    push("eager", name, sa?.eagerBytes ?? 0, sb?.eagerBytes ?? 0, sa?.eagerTokens ?? 0, sb?.eagerTokens ?? 0);
    // Stripped tiers stay in the diff contract so re-adding them is additive.
    push(
      "conditional", name,
      sa?.conditionalBytes ?? 0, sb?.conditionalBytes ?? 0,
      sa?.conditionalTokens ?? 0, sb?.conditionalTokens ?? 0,
    );
    push(
      "transitive", name,
      sa?.transitiveBytes ?? 0, sb?.transitiveBytes ?? 0,
      sa?.transitiveTokens ?? 0, sb?.transitiveTokens ?? 0,
    );
  }
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const grew =
    b.totals.alwaysOnBytes > a.totals.alwaysOnBytes ||
    rows.some((r) => ["eager", "conditional", "transitive"].includes(r.ledger) && r.delta > 0);
  return { rows, grew };
}

export interface BudgetViolation {
  ceiling: string;
  limit: number;
  actual: number | null;
  files: string[];
}

/**
 * Budget file: user-authored plain JSON, ceilings in ~tokens.
 *   { "alwaysOnTotal": 4000, "eagerPerInvocation": { "qa": 5000 },
 *     "perInvocation": { "qa": 9000 } }
 * With the conditional/transitive tiers stripped, `perInvocation` and
 * `routeCeiling` gate the same figure as `eagerPerInvocation`; the keys stay
 * accepted so budgets survive the tiers returning.
 */
export function checkBudget(bill: Bill, budget: Record<string, any>): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  if (typeof budget.alwaysOnTotal === "number") {
    const actual = Math.round(bill.totals.alwaysOnTokens);
    if (actual > budget.alwaysOnTotal) {
      violations.push({
        ceiling: "alwaysOnTotal",
        limit: budget.alwaysOnTotal,
        actual,
        files: bill.skills.map((s) => `${s.name}/SKILL.md (frontmatter ${s.frontmatterBytes}B)`),
      });
    }
  }
  for (const key of ["eagerPerInvocation", "perInvocation", "routeCeiling"]) {
    for (const [name, limit] of Object.entries(budget[key] ?? {}) as [string, number][]) {
      const skill = bill.skills.find((s) => s.name === name);
      if (!skill) {
        violations.push({ ceiling: `${key}.${name}`, limit, actual: null, files: ["<skill not found in tree>"] });
        continue;
      }
      const tokens =
        key === "routeCeiling"
          ? (skill.routeCeiling?.tokens ?? skill.perInvocationTokens)
          : key === "perInvocation"
            ? skill.perInvocationTokens
            : skill.eagerTokens;
      const actual = Math.round(tokens);
      if (actual > limit) {
        violations.push({
          ceiling: `${key}.${name}`,
          limit,
          actual,
          files: [
            `${skill.name}/SKILL.md (${skill.skillMdBytes}B)`,
            ...skill.forcedRefs.map((r) => `${skill.name}/${r.path} (${r.bytes}B)`),
          ],
        });
      }
    }
  }
  return violations;
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${b}B`;
}

/** Exact counts are measurements, so they lose the "~" the estimate wears. */
function fmtTok(tokens: number, exact: boolean): string {
  const t = Math.round(tokens);
  const tilde = exact ? "" : "~";
  return t >= 1000 ? `${tilde}${(t / 1000).toFixed(1)}K tok` : `${tilde}${t} tok`;
}

export function renderBill(bill: Bill, { skill }: { skill?: string } = {}): string {
  const skills = skill ? bill.skills.filter((s) => s.name === skill) : bill.skills;
  const exact = bill.tokenEstimateErrorPct === 0;
  const size = (bytes: number, tokens: number) => `${fmtBytes(bytes)} (${fmtTok(tokens, exact)})`;
  const lines = [`Context bill for ${bill.root}`, `Token source: ${bill.tokenSource}`, ""];

  lines.push(
    `ALWAYS-ON (every session): ${skills.length} skills, ` +
      `${size(skills.reduce((n, s) => n + s.frontmatterBytes, 0), skills.reduce((n, s) => n + s.frontmatterTokens, 0))}`,
  );
  // The host wraps each skill's frontmatter in its own available_skills XML
  // element before the model sees it. That wrapper is host-specific and cannot
  // be read from this tree, so it is excluded here — the real always-on cost is
  // this figure plus one wrapper per skill.
  lines.push("  (frontmatter only; excludes the host's per-skill available_skills XML wrapper)");
  for (const s of skills) lines.push(`  ${s.name.padEnd(20)} ${size(s.frontmatterBytes, s.frontmatterTokens)}`);
  for (const s of skills) {
    if (s.deadKeys.length) lines.push(`  ! ${s.name}: frontmatter key(s) the router never reads: ${s.deadKeys.join(", ")}`);
    for (const f of s.foreignFiles) lines.push(`  ! ${s.name}: foreign-host file in scanner scope: ${f.path} (${size(f.bytes, f.tokens)})`);
  }
  lines.push("");

  lines.push("EAGER (per invocation): SKILL.md + forced-read references");
  for (const s of skills) {
    const refs = s.forcedRefs.length
      ? ` = SKILL.md ${fmtBytes(s.skillMdBytes)} + refs ${fmtBytes(sumBytes(s.forcedRefs))} (${s.forcedRefs.map((r) => path.basename(r.path)).join(", ")})`
      : "";
    lines.push(`  ${s.name.padEnd(20)} ${size(s.eagerBytes, s.eagerTokens)}${refs}`);
    for (const r of s.forcedRefs.filter((r) => r.missing)) lines.push(`  ! ${s.name}: forced-read reference missing on disk: ${r.path}`);
  }
  lines.push("");

  lines.push(
    `TOTAL on disk: ${size(bill.totals.totalMdBytes, bill.totals.totalMdTokens)} across ${bill.totals.skillCount} skill(s).`,
  );
  lines.push(tokenDisclaimer(bill));
  return lines.join("\n") + "\n";
}

/**
 * Names the error band instead of hand-waving about "estimates". The band is the
 * worst-case residual measured over the calibration corpus, not a guess.
 */
export function tokenDisclaimer(bill: Pick<Bill, "tokenEstimateErrorPct" | "tokenSource">): string {
  if (bill.tokenEstimateErrorPct === 0) {
    return `Token counts measured with ${bill.tokenSource}. Bytes are exact.`;
  }
  if (bill.tokenSource.startsWith(MIXED_PREFIX)) {
    return (
      `Token counts are MIXED (${bill.tokenSource.slice(MIXED_PREFIX.length)}). Any figure that includes an estimated ` +
      `item can be off by up to ${bill.tokenEstimateErrorPct}% for that item. Bytes are always exact.`
    );
  }
  const per = Object.entries(TOKEN_DIVISORS).map(([k, v]) => `${k} /${v}`).join(", ");
  return (
    `Token counts are ESTIMATES: bytes divided per content class (${per}), calibrated against ` +
    `count_tokens on 219 skill files. Measured accuracy of that estimate: mean ` +
    `per-file error 7.4%, systematic bias under 0.5%, worst single file ` +
    `${bill.tokenEstimateErrorPct}% (dense path/table files). Ledger rows ` +
    `land tighter than single files because errors partly cancel across a sum. Run --exact for ` +
    `measured counts when a number has to be right. Bytes are always exact.`
  );
}

export function renderDiff(diff: { rows: DiffRow[]; grew: boolean }): string {
  if (diff.rows.length === 0) return "No context-cost changes between trees.\n";
  const lines = ["Context-cost changes (sorted by |delta|):", ""];
  for (const r of diff.rows) {
    const sign = r.delta > 0 ? "+" : "-";
    lines.push(
      `  ${r.ledger.padEnd(11)} ${r.label.padEnd(28)} ${sign}${fmtBytes(Math.abs(r.delta))} (${sign}${Math.abs(r.tokenDelta)} tok)  ${fmtBytes(r.before)} -> ${fmtBytes(r.after)}`,
    );
  }
  lines.push("");
  lines.push(
    diff.grew
      ? "RESULT: context cost GREW (always-on or eager)."
      : "RESULT: no always-on or eager growth.",
  );
  return lines.join("\n") + "\n";
}

// --exact defaults to the current model, so it counts what a session pays today.
// The offline divisors were fitted on claude-opus-4-5's tokenizer; the
// calibration block shows how far they sit from the current one.
export const EXACT_DEFAULT_MODEL = "claude-opus-5-5";
const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";
const EXACT_CONCURRENCY = 8;

/** Typed failures, so callers branch on a code rather than on message text. */
export class ExactModeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ExactModeError";
    this.code = code;
  }
}

type FetchLike = typeof globalThis.fetch;

interface CountTokensOptions {
  model: string;
  apiKey: string;
  fetchImpl: FetchLike;
}

async function countTokens(text: string, { model, apiKey, fetchImpl }: CountTokensOptions): Promise<number> {
  let res: Response;
  try {
    res = await fetchImpl(COUNT_TOKENS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
    });
  } catch (error) {
    throw new ExactModeError("exact_network_unreachable", `count_tokens unreachable: ${(error as Error)?.message ?? error}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const code = res.status === 401 || res.status === 403 ? "exact_auth_rejected" : "exact_request_failed";
    throw new ExactModeError(code, `count_tokens returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const json: any = await res.json();
  if (typeof json?.input_tokens !== "number") {
    throw new ExactModeError("exact_response_malformed", "count_tokens response had no input_tokens");
  }
  return json.input_tokens;
}

export interface ExactSendSet {
  /** Each real file once, under the first lexical path a skill's walk reaches it by. */
  files: WalkedFile[];
  /** Files the bill walks outside the root, the gstack checkout and gstack's render folder: never sent, estimated offline. */
  refused: WalkedFile[];
  /** Realpath of the gstack checkout the root's gstack/ entry links to, when there is one. */
  checkout?: string;
  /** Realpath of gstack's render folder ($GSTACK_STATE_ROOT/render) when it is a real directory; a render link is not trusted. */
  render?: string;
  /** Realpaths of the SKILL.md files whose frontmatter the bill prices. */
  frontmatter: Set<string>;
}

/** The realpath of `dir` when it is a real directory, not a link; otherwise (missing, unreadable, a file) undefined. */
function realDirectory(dir: string): string | undefined {
  try {
    return fs.lstatSync(dir).isDirectory() ? fs.realpathSync(dir) : undefined;
  } catch {
    return undefined;
  }
}

/** A git checkout with VERSION, setup and a SKILL.md named gstack. */
function isGstackCheckout(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, ".git"))) return false;
  if (!["VERSION", "setup", "SKILL.md"].every((name) => isFile(path.join(dir, name)))) return false;
  const { block } = parseFrontmatter(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
  return /^name:\s*gstack\s*$/m.test(block);
}

/**
 * What --exact sends: the same per-skill walks totalMd bills, with the same
 * fences, so nothing is walked or sent that no skill bills. Of those, only
 * files inside the root or inside the gstack checkout the skills link into
 * (the root's gstack/ entry, when it is a git checkout whose SKILL.md is named
 * gstack and which has VERSION and setup) or inside gstack's render folder
 * ($GSTACK_STATE_ROOT/render, where setup renders the SKILL.md files some
 * installs link to; trusted only as a real directory, not a link) are sent; anything else a link reaches is refused and
 * estimated offline. Each file is judged by its realpath, so a link out of
 * one of those folders is refused too.
 *
 * The root is resolved before keying. buildBill resolves its root, so a
 * relative root here would produce keys that never match and every lookup
 * would fall back to the estimate.
 */
export function exactSendSet(root: string, stateRoot: string = resolveStateRoot()): ExactSendSet {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) throw new Error(`No such tree: ${resolved}`);
  const files: WalkedFile[] = [];
  const refused: WalkedFile[] = [];
  const frontmatter = new Set<string>();
  const seen = new Set<string>();
  const rootReal = fs.realpathSync(resolved);
  const gstackEntry = path.join(resolved, "gstack");
  const checkout = isGstackCheckout(gstackEntry) ? fs.realpathSync(gstackEntry) : undefined;
  const render = realDirectory(path.join(stateRoot, "render"));
  const approved = [rootReal, checkout, render].filter((d): d is string => d !== undefined);
  for (const dir of findSkillDirs(resolved)) {
    frontmatter.add(fs.realpathSync(path.join(dir, "SKILL.md")));
    for (const file of walkMdFiles(dir, { billedRoot: resolved, skipNestedSkills: true })) {
      if (seen.has(file.real)) continue;
      seen.add(file.real);
      if (!approved.some((d) => encloses(d, file.real))) {
        refused.push(file);
        continue;
      }
      files.push(file);
    }
  }
  return { files, refused, frontmatter, checkout, render };
}

/**
 * Reads the exact file the walk approved: its realpath, opened without
 * following a final link, and only if it is still the same regular file at
 * the same realpath. A link retargeted, a file replaced, or a parent directory
 * swapped for a link after the walk is refused, so nothing the bill did not
 * walk can be sent. The open does not block, so a file swapped for a FIFO is
 * refused as not a regular file instead of hanging the run.
 */
function readWalkedFile({ path: file, real, dev, ino, size, mtimeMs }: WalkedFile, root: string): string {
  const changed = () => new Error(`${file} changed after it was walked; nothing from ${root} was sent. Run again.`);
  let fd: number;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    throw changed();
  }
  try {
    const st = fs.fstatSync(fd);
    if (
      !st.isFile() ||
      st.dev !== dev ||
      st.ino !== ino ||
      st.size !== size ||
      st.mtimeMs !== mtimeMs ||
      fs.realpathSync(real) !== real
    ) {
      throw changed();
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function fileIdentity(real: string, { dev, ino, size, mtimeMs }: { dev: number; ino: number; size: number; mtimeMs: number }): string {
  return `${real}\0${dev}\0${ino}\0${size}\0${mtimeMs}`;
}

export interface ExactMeasurement {
  tokenSource: string;
  tokensOf: TokensOf;
  /** Texts sent to count_tokens (file bodies plus frontmatter blocks). */
  measuredFiles: number;
  counts: Map<string, number>;
  /** The realpath each measured file was read from, by its key. */
  realOf: Map<string, string>;
  /** Keys priced by estimate because measurement missed them. Read after buildBill. */
  missedKeys: Set<string>;
}

/**
 * Measures every text in the send set: what the bill prices inside the root,
 * the linked gstack checkout or gstack's render folder. Returns a `tokensOf`
 * lookup.
 *
 * count_tokens prices a whole request, so it includes a fixed message envelope.
 * That envelope is measured once and subtracted, leaving the tokens each file's
 * own content contributes — otherwise every small reference is overcharged by a
 * constant that has nothing to do with the file.
 *
 * Egress receipt BEFORE any POST (sink 'context-bill-exact'): if the receipt
 * cannot be written this throws exact_egress_receipt_failed, which the CLI
 * degrades to the offline estimate — nothing is sent unrecorded.
 */
export async function measureExactTokens(
  root: string,
  { sendSet, model, apiKey, fetchImpl = fetch, onProgress, onSend, egressHome }: {
    /** The send set from exactSendSet(root), when the caller already computed it. */
    sendSet?: ExactSendSet;
    model: string;
    apiKey: string;
    fetchImpl?: FetchLike;
    onProgress?: (done: number, total: number) => void;
    /** Called with the files about to be sent, after they are read and before the receipt; not called when nothing is sent. */
    onSend?: (files: WalkedFile[]) => void;
    egressHome?: string;
  },
): Promise<ExactMeasurement> {
  if (!apiKey) {
    throw new ExactModeError(
      "exact_missing_api_key",
      "--exact needs ANTHROPIC_API_KEY. Without it the offline estimate is used; nothing was sent.",
    );
  }
  const opts: CountTokensOptions = { model, apiKey, fetchImpl };

  const texts = new Map<string, string>();
  // count_tokens rejects content with no non-whitespace text, so such texts
  // are not sent: an empty one is measured as zero tokens, and a
  // whitespace-only one is left unmeasured, so the bill estimates it and says
  // so. When nothing is left to send, no receipt is written and no request is
  // made.
  const counts = new Map<string, number>();
  // The send set holds each real file once, so each is sent once. The bill keys
  // the same file by every lexical path it is billed under; measuredAs maps a
  // real file, at the inode, size and mtime it was walked with, back to the
  // one key that was measured.
  const measuredAs = new Map<string, string>();
  const realOf = new Map<string, string>();
  const { files, frontmatter } = sendSet ?? exactSendSet(root);
  for (const walked of files) {
    const { path: file, real } = walked;
    const text = readWalkedFile(walked, root);
    measuredAs.set(fileIdentity(real, walked), file);
    realOf.set(file, real);
    if (/\S/.test(text)) texts.set(file, text);
    else if (text === "") counts.set(file, 0);
    if (!frontmatter.has(real)) continue;
    const fm = parseFrontmatter(text);
    if (fm.block) texts.set(frontmatterKey(file), fm.block);
    else counts.set(frontmatterKey(file), 0);
  }

  // A key the send set does not hold (a non-.md foreign-host file, or a file
  // refused as outside the root, the checkout and the render folder) falls back to the
  // estimate rather than billing zero. So does a key whose file is no longer
  // the one measured (a link retargeted, or the file rewritten, since the walk).
  // Misses are counted, not swallowed: a bill that is part-measured and
  // part-estimated must not present itself as measured.
  const missed = new Set<string>();
  const fmSuffix = frontmatterKey("");
  const measuredKey = (key: string): string | undefined => {
    const isFm = key.endsWith(fmSuffix);
    let real: string;
    let st: fs.Stats;
    try {
      real = realpathStepwise(isFm ? key.slice(0, -fmSuffix.length) : key);
      st = fs.lstatSync(real);
    } catch {
      return undefined;
    }
    const lexical = measuredAs.get(fileIdentity(real, st));
    return lexical === undefined ? undefined : isFm ? frontmatterKey(lexical) : lexical;
  };
  const tokensOf: TokensOf = (key, bytes) => {
    const alias = measuredKey(key);
    const exact = alias === undefined ? undefined : counts.get(alias);
    if (exact !== undefined) return exact;
    missed.add(key);
    return estimateTokensOf(key, bytes);
  };
  const measurement: ExactMeasurement = {
    tokenSource: `count_tokens (${model})`,
    tokensOf,
    measuredFiles: 0,
    counts,
    realOf,
    missedKeys: missed,
  };
  if (texts.size === 0) return measurement;
  onSend?.(files.filter((f) => texts.has(f.path)));

  // Receipt-before-send. Content-free: file count + total bytes only.
  try {
    let totalBytes = 0;
    for (const t of texts.values()) totalBytes += Buffer.byteLength(t, "utf8");
    writeReceipt({
      home: egressHome,
      sink: "context-bill-exact",
      host: "api.anthropic.com",
      payloadClass: `count-tokens skill-tree texts=${texts.size} (${totalBytes}B across ${EXACT_CONCURRENCY}-way POSTs)`,
      bytes: totalBytes,
      sha256: null,
      consent: "user passed --exact",
    });
  } catch (error) {
    throw new ExactModeError(
      "exact_egress_receipt_failed",
      `egress receipt could not be written (${(error as Error)?.message ?? error}); refusing to send unrecorded`,
    );
  }

  // One-char body: subtracting its single content token leaves the envelope.
  const envelope = (await countTokens("x", opts)) - 1;

  const keys = [...texts.keys()];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next++];
      const raw = await countTokens(texts.get(key)!, opts);
      counts.set(key, Math.max(0, raw - envelope));
      onProgress?.(++done, keys.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXACT_CONCURRENCY, keys.length) }, worker));
  measurement.measuredFiles = texts.size;
  return measurement;
}

export interface Calibration {
  rows: {
    path: string;
    contentClass: string;
    bytes: number;
    estimatedTokens: number;
    tokens: number;
    bytesPerToken: number;
    errorPct: number;
  }[];
  worstErrorPct: number;
  meanAbsErrorPct: number;
  biasPct: number;
}

/**
 * Estimate-vs-measured residual per file. This is what makes the divisor
 * auditable: run --exact and the tool grades its own offline estimate.
 */
export function calibrationTable(counts: Map<string, number>, root: string, realOf?: Map<string, string>): Calibration {
  const rows: Calibration["rows"] = [];
  for (const [key, tokens] of counts) {
    if (key.endsWith("#frontmatter") || tokens === 0) continue;
    const bytes = bytesOf(realOf?.get(key) ?? key);
    if (bytes == null) continue;
    // Grade the estimate the tool actually uses, class divisor included.
    const estimated = Math.round(estimateTokensOf(key, bytes));
    rows.push({
      path: path.relative(root, key),
      contentClass: contentClass(key),
      bytes,
      estimatedTokens: estimated,
      tokens,
      bytesPerToken: Number((bytes / tokens).toFixed(3)),
      errorPct: Number((((estimated - tokens) / tokens) * 100).toFixed(1)),
    });
  }
  rows.sort((a, b) => Math.abs(b.errorPct) - Math.abs(a.errorPct));
  const abs = rows.map((r) => Math.abs(r.errorPct));
  return {
    rows,
    worstErrorPct: abs.length ? Math.max(...abs) : 0,
    meanAbsErrorPct: abs.length ? Number((abs.reduce((a, b) => a + b, 0) / abs.length).toFixed(2)) : 0,
    biasPct: rows.length
      ? Number((rows.reduce((n, r) => n + r.errorPct, 0) / rows.length).toFixed(2))
      : 0,
  };
}

// Where installed skills actually live: `.agents/skills` (the host-neutral
// canonical path) alongside `.claude/skills`, project then user.
const DEFAULT_TREES: string[][] = [
  ["cwd", "skills"],
  ["cwd", ".agents", "skills"],
  ["cwd", ".claude", "skills"],
  ["home", ".agents", "skills"],
  ["home", ".claude", "skills"],
];

function defaultTreeCandidates(cwd: string, homeDir: string): string[] {
  return DEFAULT_TREES.map(([base, ...rest]) => path.join(base === "cwd" ? cwd : homeDir, ...rest));
}

function detectDefaultTree(cwd: string, homeDir: string): string | null {
  return defaultTreeCandidates(cwd, homeDir).find((c) => fs.existsSync(c)) ?? null;
}

const USAGE =
  "Usage:\n" +
  "  gstack-context-bill [TREE] [--json] [--skill <name>]\n" +
  "  gstack-context-bill --diff <treeA> <treeB> [--json]\n" +
  "  gstack-context-bill [TREE] --budget <budget.json> [--json]\n" +
  "\n" +
  "  --exact              measure tokens with Anthropic's count_tokens instead of\n" +
  "                       estimating. Off by default: it sends the content of every\n" +
  "                       .md file the bill prices inside the tree, inside\n" +
  "                       the gstack checkout its gstack/ entry links to, or\n" +
  "                       inside gstack's render folder ($GSTACK_STATE_ROOT/render)\n" +
  "                       to api.anthropic.com. Files that symlinks reach anywhere\n" +
  "                       else are named, not sent, and estimated offline. Needs\n" +
  "                       ANTHROPIC_API_KEY; passing --exact is the consent. An\n" +
  "                       egress receipt is written before the send (see\n" +
  "                       gstack-egress); if it cannot be written, the run falls\n" +
  "                       back to the offline estimate.\n" +
  "                       --exact also recalibrates: the --json output's\n" +
  "                       `calibration` block grades the offline divisors\n" +
  "                       (TOKEN_DIVISORS) file by file against measured counts.\n" +
  "  --exact-model <id>   model whose tokenizer to count against\n" +
  `                       (default ${EXACT_DEFAULT_MODEL}, the current model).\n`;

export interface MainOptions {
  cwd?: string;
  stdout?: { write(s: string): unknown };
  stderr?: { write(s: string): unknown };
  homeDir?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  egressHome?: string;
  stateRoot?: string;
}

export async function contextBillMain(argv: string[], options: MainOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const homeDir = options.homeDir ?? os.homedir();

  const positional: string[] = [];
  const flags: { json: boolean; diff: boolean; exact: boolean; exactModel: string; skill?: string; budget?: string } =
    { json: false, diff: false, exact: false, exactModel: EXACT_DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--diff") flags.diff = true;
    else if (arg === "--skill") flags.skill = argv[++i];
    else if (arg === "--budget") flags.budget = argv[++i];
    else if (arg === "--exact") flags.exact = true;
    else if (arg === "--exact-model") flags.exactModel = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith("--")) {
      stderr.write(`Unknown flag: ${arg}\n${USAGE}`);
      return 2;
    } else positional.push(arg);
  }

  // Exact mode is the only path that leaves the machine. Announce what is sent
  // before sending it, and degrade to the estimate rather than failing the run.
  const sendSet = (tree: string) => (flags.exact ? exactSendSet(tree, options.stateRoot) : undefined);
  const exactFor = async (tree: string, set: ExactSendSet | undefined): Promise<{
    tokensOf?: TokensOf;
    tokenSource?: string;
    missedKeys?: ReadonlySet<string>;
    calibration?: Calibration;
    onDone?: () => void;
  }> => {
    if (!set) return {};
    if (set.refused.length) {
      const outsideDirs: string[] = [];
      const kept = new Set<string>();
      for (const d of [...new Set(set.refused.map((f) => path.dirname(f.real)))].sort()) {
        let covered = false;
        for (let a = d; !covered; a = path.dirname(a)) {
          covered = kept.has(a);
          if (path.dirname(a) === a) break;
        }
        if (covered) continue;
        kept.add(d);
        outsideDirs.push(d);
      }
      stderr.write(
        `--exact: not sending ${set.refused.length} .md file(s) that symlinks reach outside ${tree}, the gstack checkout and gstack's render folder ` +
          `(under ${outsideDirs.join(", ")}); they are estimated offline:\n` +
          set.refused.map((f) => `  ${path.relative(tree, f.path)}\n`).join(""),
      );
    }
    if (set.files.length === 0) {
      if (set.refused.length) {
        stderr.write(`--exact: every billed .md file is outside ${tree}, the gstack checkout and gstack's render folder; nothing was sent, so the bill uses the offline estimate.\n`);
      } else if (set.frontmatter.size) {
        stderr.write(`--exact: no markdown skill file to measure under ${tree}; nothing was sent, so the bill uses the offline estimate.\n`);
      }
      return {};
    }
    let announced = false;
    const announce = (sent: WalkedFile[]) => {
      announced = true;
      const treeReal = fs.realpathSync(tree);
      const outsideTree = sent.filter((f) => !encloses(treeReal, f.real));
      const inCheckout = outsideTree.filter((f) => set.checkout && encloses(set.checkout, f.real)).length;
      const inRender = outsideTree.length - inCheckout;
      const from = [
        inCheckout ? `${inCheckout} of them in the gstack checkout ${set.checkout}` : "",
        inRender ? `${inRender} in gstack's render folder ${set.render}` : "",
      ].filter(Boolean);
      stderr.write(
        `--exact: sending the content of ${sent.length} .md file(s) under ${tree}` +
          (from.length ? ` (${from.join(", ")})` : "") +
          ` to api.anthropic.com for count_tokens (${flags.exactModel}). No other data leaves this machine.\n`,
      );
    };
    try {
      const measured = await measureExactTokens(tree, {
        sendSet: set,
        model: flags.exactModel,
        apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
        fetchImpl: options.fetchImpl,
        onSend: announce,
        egressHome: options.egressHome,
      });
      if (!announced) {
        stderr.write(
          `--exact: every .md file --exact could send under ${tree} is blank` +
            (set.refused.length ? `, and the rest are outside the folders it sends from` : "") +
            `; nothing was sent, so the bill uses the offline estimate.\n`,
        );
        return {};
      }
      return {
        tokensOf: measured.tokensOf,
        tokenSource: measured.tokenSource,
        missedKeys: measured.missedKeys,
        calibration: calibrationTable(measured.counts, tree, measured.realOf),
        onDone: () => {
          if (measured.missedKeys.size) {
            stderr.write(
              `--exact: ${measured.missedKeys.size} item(s) had no measurement and were estimated ` +
                `(${[...measured.missedKeys].slice(0, 3).join(", ")}). Those figures are not measurements.\n`,
            );
          }
        },
      };
    } catch (error) {
      if (!(error instanceof ExactModeError)) throw error;
      stderr.write(`--exact unavailable [${error.code}]: ${error.message}\nFalling back to the offline estimate.\n`);
      return {};
    }
  };

  try {
    if (flags.diff) {
      if (positional.length !== 2) {
        stderr.write(`--diff needs exactly two trees.\n${USAGE}`);
        return 2;
      }
      const treeA = path.resolve(cwd, positional[0]);
      const treeB = path.resolve(cwd, positional[1]);
      const setA = sendSet(treeA);
      const setB = sendSet(treeB);
      const optsA = await exactFor(treeA, setA);
      const optsB = await exactFor(treeB, setB);
      const diff = diffBills(buildBill(treeA, optsA), buildBill(treeB, optsB));
      optsA.onDone?.();
      optsB.onDone?.();
      stdout.write(flags.json ? JSON.stringify(diff, null, 2) + "\n" : renderDiff(diff));
      return diff.grew ? 2 : 0;
    }

    const tree = positional[0] ? path.resolve(cwd, positional[0]) : detectDefaultTree(cwd, homeDir);
    if (!tree) {
      stderr.write(
        `No skills tree found (tried ${defaultTreeCandidates(cwd, homeDir).join(", ")}). Pass a path.\n`,
      );
      return 2;
    }
    const exactOpts = await exactFor(tree, sendSet(tree));
    const bill = buildBill(tree, exactOpts);
    exactOpts.onDone?.();
    if (bill.skills.length === 0) {
      stderr.write(`No SKILL.md files found under ${tree}.\n`);
      return 2;
    }
    if (flags.skill && !bill.skills.some((s) => s.name === flags.skill)) {
      stderr.write(`No skill named "${flags.skill}" in ${tree}. Skills: ${bill.skills.map((s) => s.name).join(", ")}\n`);
      return 2;
    }

    if (flags.budget) {
      const budget = JSON.parse(fs.readFileSync(path.resolve(cwd, flags.budget), "utf8"));
      const violations = checkBudget(bill, budget);
      if (flags.json) {
        stdout.write(JSON.stringify({ ok: violations.length === 0, violations }, null, 2) + "\n");
      } else if (violations.length === 0) {
        stdout.write("Within budget.\n");
      } else {
        for (const v of violations) {
          stdout.write(`OVER BUDGET: ${v.ceiling} at ~${v.actual} tok (ceiling ~${v.limit} tok)\n`);
          for (const f of v.files) stdout.write(`  ${f}\n`);
        }
      }
      return violations.length === 0 ? 0 : 2;
    }

    stdout.write(flags.json ? JSON.stringify(bill, null, 2) + "\n" : renderBill(bill, flags));
    return 0;
  } catch (error) {
    stderr.write(`${(error as Error)?.message ?? error}\n`);
    return 1;
  }
}
