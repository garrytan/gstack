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

const JAM_ID = /(?<![A-Za-z0-9])jam_[A-Za-z0-9]{8,}/g;
const CAPY_ID = /(?<![A-Za-z0-9])jam_[A-Za-z0-9]{8,}|capy\.ai\/thread\/(?!anon-[0-9a-f]{12}(?![A-Za-z0-9_-]))[^\s"'`<>)\]]+/g;
const BADGE = /<a href="https:\/\/capy\.ai\/thread\/jam_[A-Za-z0-9]+"><picture>(?:(?!<\/a>)[\s\S]){0,800}?capy\.ai\/badge\/(?:(?!<\/a>)[\s\S]){0,800}?<\/picture><\/a>/g;
const COSTS = [
  /(?<![\w$\\])\$\s?\d[\d,]*(?:\.\d+)?/g,
  /[€£]\s?\d[\d,]*(?:\.\d+)?/g,
  /\b\d[\d,]*(?:\.\d+)?\s?(?:USD|usd|dollars?)\b/g,
  /\b\d[\d,]*(?:\.\d+)?\s?[kKmM]?\s+(?:(?:capy|input|output|prompt|completion|cached|reasoning)\s)?(?:credits?|tokens?)\b/g,
  /\b(?:[A-Za-z]+_)*(?:usd|cost|costs|credits|tokens|spend)"?\s*[:=]\s*"?[$€£]?\d/gi,
];

const PATH_CHAR = /[A-Za-z0-9._\-+~/\\]/;
const SEGMENT = "[^\\s\\\\/`'\"()[\\]<>,;=*|:]";
const HOME_DIR = new RegExp(`(?<=[\\\\/])(home|root|[Uu][Ss][Ee][Rr][Ss])[\\\\/]+(?=${SEGMENT})`, "g");
const TILDE = new RegExp(`~(?:[A-Za-z_][\\w.-]*[\\\\/]|[\\\\/](?:\\.gstack|\\.capy|(?:tmp|scratch)(?!${SEGMENT})))`, "g");

/**
 * Where the home paths in text are, as [start, end) spans. The detector anchors on the pattern itself
 * wherever it sits: a home, Users or root folder followed by a user segment, ~user/, or ~/ into gstack or
 * Capy state or scratch (.gstack…, .capy…, tmp, scratch), so a generic install path like ~/.claude/skills
 * stays. Whether the path is absolute is read by looking back from the match over path characters
 * (letters, digits, . _ - + ~ / \\) to where the path starts: it is relative only when that start is a
 * letter, digit, ., _ or ~ (src/home/x, ./home/x, ~/x/home/y), and a URL's own path (scheme://host/home/x)
 * is skipped, except file://. Users in any case counts only right after a drive letter (C:\\users\\x), and
 * root only as the path's first folder. The look-back runs twice, once reading a literal \\n, \\t or \\r as
 * an escape that ends the previous text (raw JSON, a pasted log) and once not (a Windows folder named
 * new); either reading being absolute counts. Run starts are computed in one pass, so the scan is linear.
 */
function homeSpans(text: string): Array<[number, number]> {
  const n = text.length;
  const plain = new Int32Array(n);
  const escaped = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (!PATH_CHAR.test(text[i]!)) { plain[i] = escaped[i] = -1; continue; }
    plain[i] = i > 0 && plain[i - 1]! >= 0 ? plain[i - 1]! : i;
    const escapeEnd = i > 1 && text[i - 2] === "\\" && "ntr".includes(text[i - 1]!) && text[i - 3] !== "\\";
    escaped[i] = i > 0 && escaped[i - 1]! >= 0 && !escapeEnd ? escaped[i - 1]! : i;
  }
  const pathEnd = (at: number) => {
    let e = at;
    while (e < n && PATH_CHAR.test(text[e]!)) e++;
    return e;
  };
  const absoluteFrom = (rs: number, slash: number, name: string): number | undefined => {
    if (/^[\\/]{2}/.test(text.slice(rs, rs + 2)) && text[rs] === "/" && text[rs - 1] === ":") {
      const scheme = /[A-Za-z][A-Za-z0-9+.-]*$/.exec(text.slice(Math.max(0, rs - 32), rs - 1))?.[0];
      if (scheme !== undefined) return scheme.toLowerCase() === "file" ? rs : undefined;
    }
    if (!/[\\/\-+]/.test(text[rs]!)) return undefined;
    const drive = text[rs - 1] === ":" && /[A-Za-z]/.test(text[rs - 2] ?? "") && !/[A-Za-z0-9]/.test(text[rs - 3] ?? "");
    if (name === "root" && rs !== slash) return undefined;
    if (name !== "home" && name !== "root" && name !== "Users" && !drive) return undefined;
    return drive ? rs - 2 : rs;
  };
  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(HOME_DIR)) {
    const name = m[1]!;
    let slash = m.index! - 1;
    while (slash > 0 && plain[slash - 1]! >= 0 && /[\\/]/.test(text[slash - 1]!)) slash--;
    if (name === "root" && !(slash === 0 || plain[slash - 1]! < 0)) continue;
    const at = [plain[slash]!, escaped[slash]!].map(rs => absoluteFrom(rs, slash, name)).find(a => a !== undefined);
    if (at === undefined) continue;
    const lead = /[-+]/.test(text[at]!) ? 1 : 0;
    spans.push([at + lead, pathEnd(m.index!)]);
  }
  for (const m of text.matchAll(TILDE)) {
    const at = m.index!;
    const before = escaped[at] === at ? "" : text[at - 1]!;
    if (/[A-Za-z0-9._~/\\]/.test(before)) continue;
    spans.push([at, pathEnd(at)]);
  }
  return spans.sort((a, b) => a[0] - b[0]);
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
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  return hits.sort((a, b) => a.at - b.at).flatMap(h => {
    for (; scanned < h.at; scanned++) if (text[scanned] === "\n") { line++; lineStart = scanned + 1; }
    const f = { rule: h.rule, line, col: h.at - lineStart + 1 };
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
const SPEND_PAIR = /[ \t]*\b(?:[\w.-]*[_.-])?(?:usd|costs?|credits?|tokens?|spend|used)=[^\s`]*/gi;
const DOLLARS = /[ \t]*\$\s?\d[\d,]*(?:\.\d+)?/g;
const MIRROR_LINE = /^([ \t]*(?:Review-loop exception|Documentation exception|Ruled note|Mechanical retake|Test-lane exception): )(.*)$/gm;

/**
 * The public form of what machines write into PR text: the receipt and receipt-runs blocks
 * lose every cost, credits or token field at any depth, their top-level `run` and `thread`
 * become an opaque `anon-<sha256 prefix>` id (deduplication still works, the jam id or thread
 * code is gone), and home paths in any string are cut to their file name and jam ids hashed. A
 * result line led by an ALL_CAPS label (`REVIEW_LOOP:`, `BUDGET_FINAL:`, `CI_CARRY:`, after an
 * optional bullet or backtick) drops each key=value whose key is, or ends in _ . or - and, usd, cost,
 * credits, tokens, spend or used (so refused= and reused= stay) and each $ amount, and gets the same path and id scrub. The lines
 * the receipt check wants word for word from receipt fields (`Review-loop exception:`, `Documentation exception:`, `Ruled note:`,
 * `Mechanical retake:`, `Test-lane exception:`) get the same scrub as those fields, so they still match. A block that is
 * unchanged, or not JSON, keeps its bytes; privateDetails still reads whatever stays, and a scrubbed `capy.ai/thread/anon-<hash>` passes it.
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
  const mirrored = machine.replace(MIRROR_LINE, (all, label: string, rest: string) => {
    const out = scrub(rest);
    if (out === rest) return all;
    changed.add(`${label.trim().slice(0, -1)} line`);
    return label + out;
  });
  return { text: mirrored, changed: [...changed].sort() };
}
