/**
 * public-pr-text — what PR text may say on a public repository (GST-1955).
 *
 * On a public repository, or one whose visibility cannot be read (fail closed),
 * PR titles, bodies and comments never carry a home path (an absolute path under
 * a home directory, or a ~ path), a Capy jam id or thread link other than the
 * platform's own badge, or a cost, credits or token figure. gstack-post rewrites
 * the receipt blocks /ship writes into their public form (publicReceiptText) and
 * refuses any other text that still says one of these (privateDetails). Private
 * repositories keep today's bytes.
 */
import { createHash } from "node:crypto";
import type { RepoVisibility } from "./redact-engine";

export type PublicRule = "public.home_path" | "public.capy_id" | "public.cost";
export interface PublicFinding { rule: PublicRule; line: number; col: number }
export type VisibilityRunner = (cmd: string, args: string[]) => { status: number; stdout: string };

/**
 * The repository's visibility: an explicit value, then `gstack-config get redact_repo_visibility`
 * (the policy override), then the host CLI; `unknown` when none answers. Only `private`
 * keeps today's form, so `unknown` is treated as public by every caller.
 */
export function readRepoVisibility(run: VisibilityRunner, o: { explicit?: RepoVisibility; configBin: string; kind: "github" | "gitlab"; repo?: string }): RepoVisibility {
  if (o.explicit) return o.explicit;
  const norm = (s: string) => {
    const v = s.trim().toLowerCase();
    return v === "public" || v === "private" || v === "unknown" ? v : undefined;
  };
  const cfg = run(o.configBin, ["get", "redact_repo_visibility"]);
  const fromConfig = cfg.status === 0 ? norm(cfg.stdout) : undefined;
  if (fromConfig) return fromConfig;
  if (o.kind === "github") {
    const gh = run("gh", ["repo", "view", ...(o.repo ? [o.repo] : []), "--json", "visibility", "--jq", ".visibility"]);
    return (gh.status === 0 && norm(gh.stdout)) || "unknown";
  }
  const gl = run("glab", ["repo", "view", ...(o.repo ? [o.repo] : []), "--output", "json"]);
  if (gl.status !== 0) return "unknown";
  try { return norm(String(JSON.parse(gl.stdout).visibility ?? "")) ?? "unknown"; } catch { return "unknown"; }
}

const HOME_PATH = /(?:[A-Za-z]:)?[\\/](?:home|[Uu]sers)[\\/]+[^\s\\/`'"<>()[\]]+|(?<![\w.~-])\/root\/|(?<![\w~$\\])~(?:[A-Za-z_][\w.-]*)?\//g;
const HTTP_URL = /https?:\/\/[^\s<>"'`)\]]+/g;
const CAPY_ID = /(?<![A-Za-z0-9])jam_[A-Za-z0-9]{8,}|capy\.ai\/thread\/[^\s"'`<>)\]]+/g;
const BADGE = /<a href="https:\/\/capy\.ai\/thread\/jam_[A-Za-z0-9]+"><picture>(?:(?!<\/a>)[\s\S]){0,800}?capy\.ai\/badge\/(?:(?!<\/a>)[\s\S]){0,800}?<\/picture><\/a>/g;
const COSTS = [
  /(?<![\w$\\])\$\s?\d[\d,]*(?:\.\d+)?/g,
  /[€£]\s?\d[\d,]*(?:\.\d+)?/g,
  /\b\d[\d,]*(?:\.\d+)?\s?(?:USD|usd|dollars?)\b/g,
  /\b\d[\d,]*(?:\.\d+)?\s?[kKmM]?\s+(?:(?:capy|input|output|prompt|completion|cached|reasoning)\s)?(?:credits?|tokens?)\b/g,
  /\b(?:[A-Za-z]+_)*(?:usd|cost|costs|credits|tokens|spend)"?\s*[:=]\s*"?[$€£]?\d/gi,
];

function ranges(text: string, re: RegExp): Array<[number, number]> {
  return [...text.matchAll(re)].map(m => [m.index!, m.index! + m[0].length]);
}
const inside = (at: number, rs: Array<[number, number]>) => rs.some(([a, b]) => at >= a && at < b);

/** Code fences and inline code spans, where a lone `$1` is a shell positional, not a price. */
function codeRanges(text: string): Array<[number, number]> {
  const fences = ranges(text, /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm);
  const spans = ranges(text, /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g).filter(([a]) => !inside(a, fences));
  return [...fences, ...spans];
}

/** Every home path, Capy id and cost figure in `text`, by line and column (1-based); the values are never returned. */
export function privateDetails(text: string): PublicFinding[] {
  const hits: Array<{ rule: PublicRule; at: number }> = [];
  const urls = ranges(text, HTTP_URL);
  const badges = ranges(text, BADGE);
  const code = codeRanges(text);
  for (const m of text.matchAll(HOME_PATH)) if (!inside(m.index!, urls)) hits.push({ rule: "public.home_path", at: m.index! });
  for (const m of text.matchAll(CAPY_ID)) if (!inside(m.index!, badges)) hits.push({ rule: "public.capy_id", at: m.index! });
  for (const re of COSTS) {
    for (const m of text.matchAll(re)) {
      if (/^\$\d$/.test(m[0]) && !/[\d.,]/.test(text[m.index! + 2] ?? "") && inside(m.index!, code)) continue;
      hits.push({ rule: "public.cost", at: m.index! });
    }
  }
  const seen = new Set<string>();
  return hits.sort((a, b) => a.at - b.at).flatMap(h => {
    const before = text.slice(0, h.at);
    const line = before.split("\n").length;
    const f = { rule: h.rule, line, col: h.at - before.lastIndexOf("\n") };
    const key = `${f.rule}:${f.line}:${f.col}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [f];
  });
}

const COST_KEY = /(?:^|_)(?:usd|cost|costs|credits?|tokens?|spend)$/i;
const PATH_TOKEN = /(?:[A-Za-z]:)?[\\/](?:home|[Uu]sers)[\\/][^\s"'`<>]*|(?<![\w.~-])\/root\/[^\s"'`<>]*|(?<![\w~$\\])~(?:[A-Za-z_][\w.-]*)?\/[^\s"'`<>]*/g;
const anon = (v: string) => `anon-${createHash("sha256").update(v).digest("hex").slice(0, 12)}`;

function publicValue(v: unknown, key: string, depth: number, changed: Set<string>): unknown {
  if (typeof v === "string") {
    if (depth === 0 && (key === "run" || key === "thread") && !/^anon-[0-9a-f]{12}$/.test(v)) { changed.add(key); return anon(v); }
    const out = v
      .replace(PATH_TOKEN, p => p.split(/[\\/]/).filter(Boolean).pop() ?? "~")
      .replace(/(?<![A-Za-z0-9])jam_[A-Za-z0-9]{8,}/g, j => anon(j));
    if (out !== v) changed.add(`${key || "value"} path or id`);
    return out;
  }
  if (Array.isArray(v)) return v.map(x => publicValue(x, key, depth + 1, changed));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (COST_KEY.test(k)) { changed.add(k); continue; }
      out[k] = publicValue(x, k, depth + 1, changed);
    }
    return out;
  }
  return v;
}

const RECEIPT_BLOCK = /(```gstack-ship-receipt[ \t]*\r?\n)([\s\S]*?)(\r?\n```)/g;
const RUNS_BLOCK = /(```gstack-receipt-runs[ \t]*\r?\n)([\s\S]*?)(\r?\n```)/g;

/**
 * The receipt and receipt-runs blocks in their public form: no cost, credits or token
 * field at any depth, the top-level `run` and `thread` as an opaque `anon-<sha256 prefix>`
 * id (deduplication still works, the jam id or thread code is gone), home paths cut to
 * their file name and jam ids hashed inside any string. A block that is unchanged, or not
 * JSON, keeps its bytes; privateDetails still reads whatever stays. The `REVIEW_LOOP:` line
 * gstack-review-scope prints for the body loses its `est_input_tokens=` count the same way.
 */
export function publicReceiptText(text: string): { text: string; changed: string[] } {
  const changed = new Set<string>();
  const one = (raw: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return undefined; }
    const before = changed.size;
    const out = publicValue(parsed, "", -1, changed);
    return changed.size === before && JSON.stringify(out) === JSON.stringify(parsed) ? undefined : out;
  };
  const receipts = text.replace(RECEIPT_BLOCK, (all, open: string, raw: string, close: string) => {
    const out = one(raw);
    return out === undefined ? all : open + JSON.stringify(out, null, 2) + close;
  });
  const runs = receipts.replace(RUNS_BLOCK, (all, open: string, raw: string, close: string) => {
    let touched = false;
    const lines = raw.split(/\r?\n/).map(l => {
      const out = l.trim() ? one(l) : undefined;
      if (out === undefined) return l;
      touched = true;
      return JSON.stringify(out);
    });
    return touched ? open + lines.join("\n") + close : all;
  });
  const loop = runs.replace(/(REVIEW_LOOP:[^\n]*?) est_input_tokens=\d+/g, (_all, kept: string) => { changed.add("REVIEW_LOOP est_input_tokens"); return kept; });
  return { text: loop, changed: [...changed].sort() };
}
