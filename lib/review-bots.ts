/**
 * review-bots: the PR review-bot comments /review Step 2.5 and /ship Step 10 triage (#3122).
 *
 * The bots are the two gstack-pr-wait lists (`pr_wait_gating_bots`, `pr_wait_advisory_bots`;
 * `none` in both turns triage off), owned by login with gstack-pr-wait's rule (`botOwning`),
 * and only Bot accounts count, so a human named `greptile-ci` is never triaged.
 *
 *   fetch [--pr <n>]     every root review comment, conversation comment and the newest review
 *                        body of each configured bot, all pages; prints REVIEW_BOTS: skip|error
 *                        (<reason>) or REVIEW_BOTS_DIR: <dir> with comments.jsonl and the counts
 *   record --bot B --type fix|fp|already-fixed --file P --category C
 *                        append a triage outcome to review-bot-history.md (project and global)
 *
 * fetch marks each record with the false-positive rows that could suppress it: same repo, same
 * bot, matching file. Rows in the old greptile-history.md count as Greptile's.
 * bin/gstack-review-bots is the CLI; tests drive `runReviewBots` with a fake runner.
 */
import * as fs from "fs";
import * as path from "path";
import { botLists, botOwning } from "./pr-wait";
import { remoteSlug } from "./remote-identity";
import { resolveStateRoot, type StateRootEnv } from "./state-root";

export interface ReviewBotsEnv {
  run(cmd: string, args: string[]): { status: number; stdout: string; stderr: string };
  vars: StateRootEnv;
  /** Directory holding gstack-slug. */
  binDir: string;
  /** Parent directory for the private fetch directory. */
  tmpDir: string;
  now(): number;
  out(text: string): void;
  err(text: string): void;
}

export const HISTORY_FILE = "review-bot-history.md";
export const LEGACY_HISTORY_FILE = "greptile-history.md";
export const HISTORY_TYPES = ["fix", "fp", "already-fixed"] as const;

export interface BotComment {
  id: number;
  bot: string;
  source: "line" | "top" | "review";
  path?: string;
  line?: number | null;
  url: string;
  body: string;
  suppress_candidates: string[];
}

interface GhUser { login?: string; type?: string }
interface GhItem {
  id: number; user?: GhUser | null; body?: string | null; html_url?: string; path?: string;
  line?: number | null; position?: number | null; in_reply_to_id?: number | null; submitted_at?: string | null;
}
interface HistoryRow { repo: string; type: string; pattern: string; category: string; bot: string }

const firstLine = (text: string) => text.trim().split("\n")[0] || "no detail";

/** The bot that owns an item's author, or null for humans, other bots and deleted accounts. */
function ownerOf(item: GhItem, bots: readonly string[]): string | null {
  return item.user?.type === "Bot" ? botOwning(item.user.login, bots) : null;
}

function slug(env: ReviewBotsEnv): string {
  const s = env.run(path.join(env.binDir, "gstack-slug"), ["--get", "SLUG"]);
  if (s.status === 0 && s.stdout.trim()) return s.stdout.trim();
  const origin = env.run("git", ["remote", "get-url", "origin"]);
  return origin.status === 0 ? remoteSlug(origin.stdout.trim()) : "";
}

function historyFiles(env: ReviewBotsEnv, name: string): string[] {
  const root = resolveStateRoot(env.vars);
  const id = slug(env);
  return [...(id ? [path.join(root, "projects", id, name)] : []), path.join(root, name)];
}

/** Rows of one history file; a five-column row is Greptile's (the old format). */
export function parseHistory(text: string): HistoryRow[] {
  return text.split("\n").flatMap(line => {
    const cells = line.split(" | ").map(c => c.trim());
    if (cells.length !== 5 && cells.length !== 6) return [];
    const [, repo, type, pattern, category, bot] = cells as [string, string, string, string, string, string?];
    return repo && type && pattern && category ? [{ repo, type, pattern, category, bot: (bot || "greptile").toLowerCase() }] : [];
  });
}

/** An exact path, or a glob where `*` stays inside one directory and `**` crosses them. */
export function patternMatches(pattern: string, file: string): boolean {
  if (pattern === file) return true;
  const re = pattern.split("**").map(part => part.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp(`^${re}$`).test(file);
}

function readOr(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

/** All pages of one REST list, or the reason it could not be read whole. */
function pages(env: ReviewBotsEnv, endpoint: string): GhItem[] | string {
  const r = env.run("gh", ["api", "--paginate", "--slurp", `${endpoint}?per_page=100`]);
  if (r.status !== 0) return `${endpoint}: ${firstLine(r.stderr)}`;
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed) || !parsed.every(Array.isArray)) return `${endpoint}: not a list of pages`;
    return (parsed as GhItem[][]).flat();
  } catch { return `${endpoint}: invalid JSON`; }
}

function fetch(env: ReviewBotsEnv, args: string[]): number {
  const skip = (reason: string) => { env.out(`REVIEW_BOTS: skip (${reason})\n`); return 0; };
  const error = (reason: string) => { env.out(`REVIEW_BOTS: error (${reason})\n`); return 0; };
  const lists = botLists(env.vars);
  const bots = [...new Set([...lists.gating, ...lists.advisory])];
  if (bots.length === 0) return skip("pr_wait_gating_bots and pr_wait_advisory_bots are both none");
  if (env.run("gh", ["--version"]).status !== 0) return skip("gh not installed");
  if (env.run("gh", ["auth", "status"]).status !== 0) return skip("gh not logged in");
  const repoRun = env.run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const repo = repoRun.stdout.trim();
  if (repoRun.status !== 0 || !repo) return skip(`not a GitHub remote: ${firstLine(repoRun.stderr)}`);
  const i = args.indexOf("--pr");
  let pr = i >= 0 ? args[i + 1] ?? "" : "";
  if (!pr) {
    const view = env.run("gh", ["pr", "view", "--json", "number", "--jq", ".number"]);
    if (view.status !== 0) return skip(/no pull requests found/.test(view.stderr) ? "no PR yet" : `PR lookup failed: ${firstLine(view.stderr)}`);
    pr = view.stdout.trim();
  }
  if (!/^[1-9][0-9]*$/.test(pr)) return error(`'${pr}' is not a PR number`);
  const line = pages(env, `repos/${repo}/pulls/${pr}/comments`);
  const top = pages(env, `repos/${repo}/issues/${pr}/comments`);
  const reviews = pages(env, `repos/${repo}/pulls/${pr}/reviews`);
  for (const r of [line, top, reviews]) if (typeof r === "string") return error(r);
  const records: BotComment[] = [];
  const add = (item: GhItem, bot: string, source: BotComment["source"], extra: Partial<BotComment> = {}) =>
    records.push({ id: item.id, bot, source, url: item.html_url ?? "", body: item.body ?? "", suppress_candidates: [], ...extra });
  for (const c of line as GhItem[]) {
    const bot = ownerOf(c, bots);
    if (bot && c.in_reply_to_id == null && c.position != null) add(c, bot, "line", { path: c.path, line: c.line ?? null });
  }
  for (const c of top as GhItem[]) {
    const bot = ownerOf(c, bots);
    if (bot) add(c, bot, "top");
  }
  const newest = new Map<string, GhItem>();
  for (const r of reviews as GhItem[]) {
    const bot = ownerOf(r, bots);
    if (bot && (r.body ?? "").trim() && (r.submitted_at ?? "") >= (newest.get(bot)?.submitted_at ?? "")) newest.set(bot, r);
  }
  for (const [bot, r] of newest) add(r, bot, "review");
  const id = slug(env);
  const rows = id ? [HISTORY_FILE, LEGACY_HISTORY_FILE].flatMap(name => {
    const rows = parseHistory(readOr(path.join(resolveStateRoot(env.vars), "projects", id, name)));
    return name === LEGACY_HISTORY_FILE ? rows.map(r => ({ ...r, bot: "greptile" })) : rows;
  }) : [];
  for (const rec of records) {
    if (!rec.path) continue;
    rec.suppress_candidates = [...new Set(rows.filter(r => r.type === "fp" && r.repo === repo && r.bot === rec.bot && patternMatches(r.pattern, rec.path!)).map(r => r.category))];
  }
  const dir = fs.mkdtempSync(path.join(env.tmpDir, "gstack-review-bots-"));
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, "comments.jsonl"), records.map(r => JSON.stringify(r) + "\n").join(""), { mode: 0o600 });
  env.out(`REVIEW_BOTS_DIR: ${dir}\n`);
  env.out(`REVIEW_BOTS_COUNTS: ${bots.map(b => `${b}=${records.filter(r => r.bot === b).length}`).join(" ")}\n`);
  env.out(`REVIEW_BOTS_SUPPRESSION_CANDIDATES: ${records.filter(r => r.suppress_candidates.length > 0).length}\n`);
  return 0;
}

function record(env: ReviewBotsEnv, args: string[]): number {
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const [bot, type, file, category] = [flag("--bot"), flag("--type"), flag("--file"), flag("--category")];
  const usage = "usage: gstack-review-bots record --bot <bot> --type fix|fp|already-fixed --file <path|top-level> --category <category>\n";
  if (!bot || !type || !file || !category) { env.err(usage); return 64; }
  if (!(HISTORY_TYPES as readonly string[]).includes(type)) { env.err(`gstack-review-bots: --type must be one of ${HISTORY_TYPES.join(", ")}\n`); return 64; }
  if ([bot, file, category].some(v => /[|\r\n]/.test(v))) { env.err("gstack-review-bots: values cannot contain | or a line break\n"); return 64; }
  const repoRun = env.run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const repo = repoRun.status === 0 ? repoRun.stdout.trim() : "";
  if (!repo) { env.err(`gstack-review-bots: cannot resolve the GitHub repository: ${firstLine(repoRun.stderr)}\n`); return 1; }
  const row = `${new Date(env.now()).toISOString().slice(0, 10)} | ${repo} | ${type} | ${file} | ${category} | ${bot.toLowerCase()}\n`;
  for (const target of historyFiles(env, HISTORY_FILE)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, row);
  }
  env.out(`REVIEW_BOT_HISTORY: recorded ${type} for ${bot.toLowerCase()}\n`);
  return 0;
}

export function runReviewBots(argv: string[], env: ReviewBotsEnv): number {
  const [cmd, ...rest] = argv;
  if (cmd === "fetch") return fetch(env, rest);
  if (cmd === "record") return record(env, rest);
  env.err("usage: gstack-review-bots {fetch [--pr <n>] | record --bot B --type fix|fp|already-fixed --file P --category C}\n");
  return cmd === "help" || cmd === "--help" ? 0 : 64;
}
