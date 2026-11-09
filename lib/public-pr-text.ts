/**
 * public-pr-text — what PR text may say on a public repository (GST-1955).
 *
 * On a public repository, or one whose visibility cannot be read (fail closed),
 * PR titles, bodies and comments never carry a home path or a Capy jam id or
 * thread link other than the platform's own badge: privateDetails names them and
 * gstack-post refuses. A cost, credits or token figure in prose is only a LOW note
 * (costNotes), because a write-up may name cost when cost is the lesson. Text a
 * machine wrote gets its public form instead of a refusal (publicReceiptText): the
 * receipt blocks and every result line led by an ALL_CAPS label. Private
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

const TOKEN = /[^\s`'"()[\]<>,;=]+/g;
const ESCAPE = /\\[ntr]/;
const JAM_ID = /(?<![A-Za-z0-9])jam_[A-Za-z0-9]{8,}/g;
const CAPY_ID = /(?<![A-Za-z0-9])jam_[A-Za-z0-9]{8,}|capy\.ai\/thread\/[^\s"'`<>)\]]+/g;
const BADGE = /<a href="https:\/\/capy\.ai\/thread\/jam_[A-Za-z0-9]+"><picture>(?:(?!<\/a>)[\s\S]){0,800}?capy\.ai\/badge\/(?:(?!<\/a>)[\s\S]){0,800}?<\/picture><\/a>/g;
const COSTS = [
  /(?<![\w$\\])\$\s?\d[\d,]*(?:\.\d+)?/g,
  /[€£]\s?\d[\d,]*(?:\.\d+)?/g,
  /\b\d[\d,]*(?:\.\d+)?\s?(?:USD|usd|dollars?)\b/g,
  /\b\d[\d,]*(?:\.\d+)?\s?[kKmM]?\s+(?:(?:capy|input|output|prompt|completion|cached|reasoning)\s)?(?:credits?|tokens?)\b/g,
  /\b(?:[A-Za-z]+_)*(?:usd|cost|costs|credits|tokens|spend)"?\s*[:=]\s*"?[$€£]?\d/gi,
];

/**
 * Whether one token names a home directory. Only an absolute token can: one that starts with
 * /, \\, a drive letter and a slash, or ~. It does when a segment is home or Users (users in
 * any case after a drive letter) with another segment after it, or it starts with /root/.
 * ~user/… always names a user; ~/… only when it points into gstack or Capy state or scratch
 * (.gstack…, .capy…, tmp, scratch), so a generic install path like ~/.claude/skills stays.
 */
function isHomePath(token: string): boolean {
  if (token.startsWith("~")) {
    if (/^~[A-Za-z_][\w.-]*\//.test(token)) return true;
    const first = /^~[\\/]([^\\/]*)/.exec(token)?.[1];
    return first !== undefined && (/^\.(?:gstack|capy)/.test(first) || first === "tmp" || first === "scratch");
  }
  const drive = /^[A-Za-z]:[\\/]/.test(token);
  if (!drive && !/^[\\/]/.test(token)) return false;
  if (token.startsWith("/root/")) return true;
  const segs = token.split(/[\\/]+/).filter(Boolean);
  return segs.some((s, i) => i + 1 < segs.length && (s === "home" || s === "Users" || (drive && s.toLowerCase() === "users")));
}

/**
 * Where the home paths in text are. Text splits into tokens on whitespace and ` ' " ( ) [ ] < > , ; =;
 * a leading diff - or + is not part of a token. A token that is not a home path as a whole is
 * read again in the pieces its literal \\n, \\t and \\r escapes separate (raw JSON, a pasted log),
 * so an escape never hides a path and a Windows user name that starts with n, t or r still counts.
 */
function homeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const check = (piece: string, at: number) => {
    const lead = /^[-+]/.test(piece) ? 1 : 0;
    if (!isHomePath(piece.slice(lead))) return false;
    spans.push([at + lead, at + piece.length]);
    return true;
  };
  for (const m of text.matchAll(TOKEN)) {
    if (check(m[0], m.index!)) continue;
    let at = m.index!;
    for (const piece of m[0].split(ESCAPE)) { check(piece, at); at += piece.length + 2; }
  }
  return spans;
}

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

function located(text: string, hits: Array<{ rule: PublicRule; at: number }>): PublicFinding[] {
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

/** Every home path and Capy id in `text` (what refuses a public post), by line and column (1-based); the values are never returned. */
export function privateDetails(text: string): PublicFinding[] {
  const badges = ranges(text, BADGE);
  return located(text, [
    ...homeSpans(text).map(([at]) => ({ rule: "public.home_path" as const, at })),
    ...[...text.matchAll(CAPY_ID)].filter(m => !inside(m.index!, badges)).map(m => ({ rule: "public.capy_id" as const, at: m.index! })),
  ]);
}

/** Every cost, credits or token figure in `text`: a LOW note on a public post, never a refusal. */
export function costNotes(text: string): PublicFinding[] {
  const code = codeRanges(text);
  const hits: Array<{ rule: PublicRule; at: number }> = [];
  for (const re of COSTS) {
    for (const m of text.matchAll(re)) {
      if (/^\$\d$/.test(m[0]) && !/[\d.,]/.test(text[m.index! + 2] ?? "") && inside(m.index!, code)) continue;
      hits.push({ rule: "public.cost", at: m.index! });
    }
  }
  return located(text, hits);
}

const COST_KEY = /(?:^|_)(?:usd|cost|costs|credits?|tokens?|spend)$/i;
export const anon = (v: string) => `anon-${createHash("sha256").update(v).digest("hex").slice(0, 12)}`;

/** Home paths cut to their file name and jam ids hashed. */
function scrub(s: string): string {
  let out = "";
  let at = 0;
  for (const [a, b] of homeSpans(s)) {
    out += s.slice(at, a) + (s.slice(a, b).split(/[\\/]/).filter(Boolean).pop() ?? "~");
    at = b;
  }
  return (out + s.slice(at)).replace(JAM_ID, j => anon(j));
}

function publicValue(v: unknown, key: string, depth: number, changed: Set<string>): unknown {
  if (typeof v === "string") {
    if (depth === 0 && (key === "run" || key === "thread") && !/^anon-[0-9a-f]{12}$/.test(v)) { changed.add(key); return anon(v); }
    const out = scrub(v);
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
const MACHINE_LINE = /^([ \t]*(?:[-*+][ \t]+|\d+\.[ \t]+)?`?)([A-Z][A-Z0-9_]+:)(.*)$/gm;
const SPEND_PAIR = /[ \t]*\b[\w.-]*(?:usd|cost|credits|tokens|spend|used)=[^\s`]*/gi;
const DOLLARS = /[ \t]*\$\s?\d[\d,]*(?:\.\d+)?/g;

/**
 * The public form of what machines write into PR text: the receipt and receipt-runs blocks
 * lose every cost, credits or token field at any depth, their top-level `run` and `thread`
 * become an opaque `anon-<sha256 prefix>` id (deduplication still works, the jam id or thread
 * code is gone), and home paths in any string are cut to their file name and jam ids hashed. A
 * result line led by an ALL_CAPS label (`REVIEW_LOOP:`, `BUDGET_FINAL:`, `CI_CARRY:`, after an
 * optional bullet or backtick) drops each key=value whose key ends in usd, cost, credits, tokens,
 * spend or used and each $ amount, and gets the same path and id scrub. A block that is
 * unchanged, or not JSON, keeps its bytes; privateDetails still reads whatever stays.
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
  const machine = runs.replace(MACHINE_LINE, (all, lead: string, label: string, rest: string) => {
    const out = scrub(rest.replace(SPEND_PAIR, "").replace(DOLLARS, ""));
    if (out === rest) return all;
    changed.add(`${label.slice(0, -1)} line`);
    return lead + label + out;
  });
  return { text: machine, changed: [...changed].sort() };
}
