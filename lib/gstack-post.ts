/**
 * gstack-post: the one write path for PR and issue text (B4).
 *
 * Every value reaches `gh`/`glab` as its own argv element in `--flag=<value>`
 * form, or on stdin, never through a shell string. The text comes from files
 * the agent wrote with its file tool; the helper reads each file once, scans
 * those exact bytes with the shared redaction engine, and sends the same bytes.
 *
 * `pr-body` merges by `## ` section into the PR's current body (read through
 * the same runner): a section in the file replaces the same-titled one, the
 * ship-receipt block is a section of its own, sections the file does not
 * rewrite are kept, new ones are appended, and a file with a receipt above
 * its first `## ` section replaces the text above the first heading;
 * `--replace` overwrites instead.
 * The scan runs on the merged bytes, which are the bytes sent.
 *
 * Exit codes: 0 posted; 1 HIGH finding (or oversize input) refused;
 * 2 MEDIUM findings need confirmation, printed as `RULE:` lines plus a
 * `TOKEN:` that binds the bytes, destination, operation and findings;
 * 3 `gh`/`glab` failed; 64 usage or invalid input. Nothing is posted on any
 * non-zero exit. bin/gstack-post is the CLI; tests drive `runPost` with a fake
 * runner so the logic is covered on every platform.
 */
import { createHash } from "crypto";
import { scan, type Finding, type RepoVisibility } from "./redact-engine";
import { CI_RUN_WORD_BEFORE } from "./redact-patterns";
import { RECEIPT_FENCE } from "./ship-receipt";
import { canonicalRemote } from "./remote-identity";
import { parseChangelog } from "./changelog-check";
import { versionWidth } from "./version-source";

export const OPS = ["pr-comment", "issue-comment", "reply", "pr-title", "pr-body", "pr-create", "issue-create"] as const;
export type Op = (typeof OPS)[number];
export type HostKind = "github" | "gitlab";

export interface RunResult { status: number; stdout: string; stderr: string }
export interface PostEnv {
  /** Runs `cmd` with an argv array (no shell). `input` goes to stdin. */
  run(cmd: string, args: string[], input?: string): RunResult;
  readFile(path: string): string;
  out(text: string): void;
  err(text: string): void;
}

export const EXIT = { posted: 0, refused: 1, confirm: 2, cliFailed: 3, usage: 64 } as const;

export const USAGE = `usage: gstack-post <op> [<target>] [options]

  gstack-post pr-comment    <pr>    --body-file F [--attribute "<model> on behalf of <login>"]
  gstack-post issue-comment <issue> --body-file F [--attribute ...]
  gstack-post reply         <pr>    --to <review-comment-id> --body-file F [--attribute ...]   (GitHub only)
  gstack-post pr-title      <pr>    --title-file F
  gstack-post pr-body       <pr>    --body-file F [--replace]
  gstack-post pr-create --base <branch> [--head <branch>] [--draft] --title-file F --body-file F
  gstack-post issue-create  --title-file F --body-file F

  <pr>/<issue> is a number or a URL of this repository on the same host.
  Options: --host github|gitlab (default: detected from the origin remote)
           --repo-visibility public|private|unknown (default: config, then gh/glab)
           --confirm <token>   post bytes whose MEDIUM findings the user confirmed
           --replace           pr-body: overwrite the whole body instead of merging it by
                               ## section into the current one (the default keeps every
                               section the file does not rewrite, the ship receipt included)
           --attribute <text>  comments only; opens the comment with a "> [!NOTE]"
                               callout naming who wrote it (one line, off by default)

  Write the text files with your file-write tool; never put the text in a
  shell command. The helper scans the exact bytes it sends.

  Exit: 0 posted · 1 HIGH finding refused · 2 MEDIUM findings need
  confirmation (RULE:/TOKEN: lines on stdout) · 3 gh/glab failed · 64 usage
`;

interface Request {
  op: Op;
  target?: string;
  to?: string;
  base?: string;
  head?: string;
  draft: boolean;
  replace: boolean;
  titleFile?: string;
  bodyFile?: string;
  host?: HostKind;
  visibility?: RepoVisibility;
  confirm?: string;
  attribute?: string;
}

/** Operations that post a comment, the only ones an attribution callout applies to. */
const COMMENT_OPS: ReadonlySet<Op> = new Set<Op>(["pr-comment", "issue-comment", "reply"]);

/**
 * The opt-in attribution callout (Garry, 2026-10-26: yes, opt-in, off by
 * default): a GitHub alert block that opens an agent-posted comment with who
 * wrote it, so a maintainer reading the thread sees the author before the text.
 * GitLab renders it as a plain blockquote. Applied to comments and replies only,
 * never to a PR body, a title or an issue body.
 */
export function attributionCallout(attribute: string): string {
  return `> [!NOTE]\n> 🤖 **${attribute}**\n\n`;
}

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--to", "--base", "--head", "--title-file", "--body-file", "--host", "--repo-visibility", "--confirm", "--attribute"]);

function parseArgs(argv: string[]): Request {
  const [op, ...rest] = argv;
  if (!OPS.includes(op as Op)) throw new UsageError(op ? `unknown operation "${op}"` : "missing operation");
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let draft = false;
  let replace = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--draft") { draft = true; continue; }
    if (a === "--replace") { replace = true; continue; }
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.has(name)) {
      const value = name === a ? rest[++i] : a.slice(eq + 1);
      if (value === undefined || value === "") throw new UsageError(`${name} needs a value`);
      if (flags.has(name)) throw new UsageError(`${name} given twice`);
      flags.set(name, value);
      continue;
    }
    if (a.startsWith("-")) throw new UsageError(`unknown option "${a}"`);
    positional.push(a);
  }
  const host = flags.get("--host");
  if (host !== undefined && host !== "github" && host !== "gitlab") throw new UsageError("--host must be github or gitlab");
  const vis = flags.get("--repo-visibility");
  if (vis !== undefined && !["public", "private", "unknown"].includes(vis)) throw new UsageError("--repo-visibility must be public, private or unknown");
  const req: Request = {
    op: op as Op, draft, replace,
    target: positional[0], to: flags.get("--to"), base: flags.get("--base"), head: flags.get("--head"),
    titleFile: flags.get("--title-file"), bodyFile: flags.get("--body-file"),
    host: host as HostKind | undefined, visibility: vis as RepoVisibility | undefined, confirm: flags.get("--confirm"),
    attribute: flags.get("--attribute")?.trim(),
  };
  if (req.attribute !== undefined) {
    if (!COMMENT_OPS.has(req.op)) throw new UsageError("--attribute applies to pr-comment, issue-comment and reply only");
    if (!req.attribute || /[\r\n\u0000-\u001f]/.test(req.attribute)) throw new UsageError("--attribute needs one line of text, like \"<model> on behalf of <login>\"");
    if (req.attribute.length > 200) throw new UsageError("--attribute must be 200 characters or fewer");
  }
  const creates = req.op === "pr-create" || req.op === "issue-create";
  if (positional.length > (creates ? 0 : 1)) throw new UsageError(`unexpected argument "${positional[creates ? 0 : 1]}"`);
  if (!creates && !req.target) throw new UsageError(`${req.op} needs a target (a number or a URL)`);
  const needsTitle = req.op === "pr-title" || creates;
  const needsBody = req.op !== "pr-title";
  if (needsTitle !== !!req.titleFile) throw new UsageError(needsTitle ? `${req.op} needs --title-file` : `${req.op} takes no --title-file`);
  if (needsBody !== !!req.bodyFile) throw new UsageError(needsBody ? `${req.op} needs --body-file` : `${req.op} takes no --body-file (use --title-file)`);
  if ((req.op === "reply") !== !!req.to) throw new UsageError(req.op === "reply" ? "reply needs --to <review-comment-id>" : "--to applies to reply only");
  if (req.to !== undefined && !/^[1-9][0-9]*$/.test(req.to)) throw new UsageError("--to must be a numeric comment id");
  if ((req.op === "pr-create") !== !!req.base) throw new UsageError(req.op === "pr-create" ? "pr-create needs --base <branch>" : "--base applies to pr-create only");
  if (req.op !== "pr-create" && (req.head || req.draft)) throw new UsageError("--head and --draft apply to pr-create only");
  if (req.op !== "pr-body" && req.replace) throw new UsageError("--replace applies to pr-body only");
  return req;
}

/** One piece of a PR body: the leading text, a `## ` section, the ship-receipt block, or text after a receipt block. */
interface Section { key: string; label: string; text: string }

/**
 * Split a body into its sections, in order. A `## ` line outside a code
 * fence opens a section keyed by its title (trimmed, case-insensitive); the
 * ````gstack-ship-receipt```` block is its own section (lib/ship-receipt.ts
 * extractReceipt reads it); text before the first heading is the leading
 * text, and text after a receipt block before the next heading is kept with
 * a key of its own, so it is never replaced. A fence closes only on a run of
 * its own character at least as long as the opener with nothing after it
 * (CommonMark), so a ``` line inside a ```` block and a ```js line close
 * nothing; a receipt fence that never closes makes the body from that line
 * on one section the merge never matches (`unclosed-receipt`), so it is kept
 * byte for byte instead of being read as a receipt or as replaceable text.
 */
function splitSections(body: string): Section[] {
  const out: Section[] = [];
  let fence: string | null = null;
  let plain = 0;
  const open = (key: string, label: string) => out.push({ key, label, text: "" });
  const openText = () => out.length === 0 ? open("text:lead", "leading text") : open(`text:${plain++}`, "trailing text");
  const closes = (run: string) => new RegExp(`^ {0,3}${run[0] === "`" ? "`" : "~"}{${run.length},}\\s*$`).test(bare);
  let bare = "";
  for (const line of body.split(/(?<=\n)/)) {
    bare = line.replace(/\r?\n$/, "");
    const fenceOpen: RegExpExecArray | null = fence === null ? /^ {0,3}(`{3,}|~{3,})/.exec(bare) : null;
    if (fenceOpen && bare.trim() === "```" + RECEIPT_FENCE) { open("receipt", "ship receipt"); fence = "receipt"; }
    else if (fence === "receipt") { out.at(-1)!.text += line; if (closes("```")) { fence = null; openText(); } continue; }
    else if (fenceOpen) fence = fenceOpen[1]!;
    else if (fence && closes(fence)) fence = null;
    else if (fence === null && /^ {0,3}## /.test(bare)) { const title = bare.replace(/^ {0,3}## /, "").trim(); open(`h2:${title.toLowerCase()}`, title); }
    if (out.length === 0) openText();
    out.at(-1)!.text += line;
  }
  if (fence === "receipt") Object.assign(out.at(-1)!, { key: "unclosed-receipt", label: "unclosed receipt fence" });
  return out.filter(s => s.text !== "");
}

/**
 * The body to send for `pr-body` without `--replace`: each section of the
 * file replaces the same-keyed section of the current body in place, current
 * sections the file does not rewrite are kept byte for byte, new `## `
 * sections are appended after them, and a new receipt or leading text goes
 * first (where lib/ship-receipt.ts puts the receipt). Text outside sections
 * matches by role (the file's leading text replaces the leading text; text
 * after a receipt block never replaces an intro), and whitespace-only text in
 * the file is dropped, so reposting the body /ship composes (receipt, blank
 * line, sections) yields the same bytes. A blank
 * line separates the two sides of every seam the merge creates; two kept
 * neighbours keep their bytes. An empty current body yields the file unchanged.
 * A file section whose title the current body holds more than once (an old
 * description pasted under the new one) matches no single section, so the
 * merge refuses instead of replacing one copy and keeping the stale other.
 * A full post (a file with a receipt block above its first `## ` section, as
 * /ship composes it) manages the preamble (GST-412): every
 * non-blank text section before the current body's first heading (the leading
 * text, text after a receipt block) is dropped, the file's own text before its
 * first heading takes its place (leading text first, text after the file's
 * receipt right after the receipt), a dropped piece the file brings no text for
 * is listed in `dropped` with its first line (withheld when the redaction scan
 * flags it, since the merged bytes no longer hold it), and the receipt keeps the rules
 * above. Any other file (`## ` sections with no receipt above them, or no
 * `## ` section) merges as described above, so the current intro is kept.
 */
export function mergeBodySections(current: string, incoming: string): { body: string; replaced: string[]; kept: string[]; added: string[]; dropped: string[] } {
  const now = splitSections(current);
  const next = splitSections(incoming).filter(n => !(n.key.startsWith("text:") && n.text.trim() === ""));
  const ambiguous = next.filter(n => now.filter(s => s.key === n.key).length > 1).map(n => `"${n.label}"`);
  if (ambiguous.length) throw new UsageError(`the PR's current body holds ${[...new Set(ambiguous)].join(", ")} more than once, so the file's copy matches no single section; nothing was posted. Rerun with --replace and the whole body`);
  const preamble = (list: Section[]) => {
    const end = list.findIndex(s => s.key.startsWith("h2:"));
    return list.slice(0, end < 0 ? list.length : end).filter(s => s.key.startsWith("text:") && s.text.trim() !== "");
  };
  const firstHeading = next.findIndex(n => n.key.startsWith("h2:"));
  const managed = firstHeading > 0 && next.slice(0, firstHeading).some(n => n.key === "receipt");
  const stale = managed ? preamble(now) : [];
  const ours = managed ? preamble(next) : [];
  const role = (s: Section) => (s.key === "text:lead" ? "lead" : "trailing");
  const paired = new Set<Section>();
  for (const r of ["lead", "trailing"]) {
    const theirs = ours.filter(n => role(n) === r);
    stale.filter(s => role(s) === r).slice(0, theirs.length).forEach((s, i) => { paired.add(s); paired.add(theirs[i]!); });
  }
  const used = new Set<Section>(ours);
  const replaced: string[] = [], kept: string[] = [], added: string[] = [], dropped: string[] = [];
  const merged: Section[] = [];
  for (const s of now) {
    if (stale.includes(s)) {
      const line = s.text.trim().split(/\r?\n/)[0]!;
      if (paired.has(s)) replaced.push(s.label);
      else if (scan(line).findings.length) dropped.push(`${s.label} (first line withheld: the redaction scan flagged it)`);
      else dropped.push(`${s.label} ("${line.length > 60 ? line.slice(0, 59).trimEnd() + "…" : line}")`);
      continue;
    }
    const match = s.key === "unclosed-receipt" ? undefined : next.find(n => !used.has(n) && n.key === s.key);
    if (!match) { if (s.text.trim()) kept.push(s.label); merged.push(s); continue; }
    used.add(match); replaced.push(s.label); merged.push(match);
  }
  const fresh = next.filter(n => !used.has(n));
  for (const n of next) if (fresh.includes(n) || (ours.includes(n) && !paired.has(n))) added.push(n.label);
  const first = fresh.filter(n => !n.key.startsWith("h2:"));
  if (now.length === 0) return { body: incoming, replaced, kept, added, dropped };
  const all = [...ours.filter(n => role(n) === "lead"), ...first, ...merged, ...fresh.filter(n => n.key.startsWith("h2:"))];
  for (const t of ours.filter(n => role(n) === "trailing").reverse()) all.splice(all.indexOf(next[next.indexOf(t) - 1]!) + 1, 0, t);
  const fromFile = (s: Section) => next.includes(s);
  const body = all.map((s, i) => {
    const after = all[i + 1];
    if (!after) return s.text;
    const seam = (fromFile(s) || fromFile(after)) && s.text.trim() !== "" && !/^\r?\n/.test(after.text);
    return seam ? s.text.replace(/\n*$/, "\n\n") : s.text.endsWith("\n") ? s.text : s.text + "\n";
  }).join("");
  return { body, replaced, kept, added, dropped };
}

/** The PR's current body for a merge; GitHub's `--jq .body` prints it raw, GitLab's JSON carries `description`. */
function currentBody(env: PostEnv, kind: HostKind, n: string): { body: string } | { error: string } {
  const r = kind === "github" ? env.run("gh", ["pr", "view", n, "--json", "body", "--jq", ".body"]) : env.run("glab", ["mr", "view", n, "--output", "json"]);
  if (r.status !== 0) return { error: r.stderr.trim() || `exit ${r.status}` };
  if (kind === "github") return { body: r.stdout.replace(/\r?\n$/, "") };
  if (!r.stdout.trim()) return { body: "" };
  try { return { body: String(JSON.parse(r.stdout).description ?? "") }; } catch { return { error: "glab returned no JSON" }; }
}

interface Remote { host: string; segments: string[]; kind: HostKind }

function hostedId(url: string) {
  const id = canonicalRemote(url.trim());
  return id.hosted && id.segments.length >= 2 ? { host: id.canonical.split("/")[0]!, segments: id.segments } : undefined;
}

/**
 * The origin remote's host and path. A hostname that names neither GitHub nor
 * GitLab (an enterprise host, a proxy) is resolved by asking gh, then glab,
 * for the repository URL.
 */
function resolveRemote(env: PostEnv, forced?: HostKind): Remote {
  const r = env.run("git", ["remote", "get-url", "origin"]);
  const origin = r.status === 0 ? hostedId(r.stdout) : undefined;
  if (!origin) throw new UsageError("cannot read a hosted origin remote (git remote get-url origin)");
  const named: HostKind | undefined = origin.host.includes("github") ? "github" : origin.host.includes("gitlab") ? "gitlab" : undefined;
  if (named && (!forced || forced === named)) return { ...origin, kind: named };
  for (const kind of forced ? [forced] : (["github", "gitlab"] as const)) {
    const q = kind === "github"
      ? env.run("gh", ["repo", "view", "--json", "url", "--jq", ".url"])
      : env.run("glab", ["repo", "view", "--output", "json"]);
    let url = q.status === 0 ? q.stdout : "";
    if (kind === "gitlab" && url) { try { url = String(JSON.parse(url).web_url ?? ""); } catch { url = ""; } }
    const id = url ? hostedId(url) : undefined;
    if (id) return { ...id, kind };
  }
  if (forced) return { ...origin, kind: forced };
  throw new UsageError(`cannot tell whether ${origin.host} is GitHub or GitLab; pass --host github|gitlab`);
}

/** A number, or a URL of this repository on the remote's host, as a number. */
function targetNumber(target: string, op: Op, remote: Remote): string {
  if (/^[1-9][0-9]*$/.test(target)) return target;
  let url: URL;
  try { url = new URL(target); } catch { throw new UsageError(`target "${target}" is neither a number nor a URL`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError("target URL must be http(s)");
  if (url.hostname.toLowerCase() !== remote.host) throw new UsageError(`target URL host ${url.hostname} is not this repository's host ${remote.host}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const issue = op === "issue-comment";
  const markers = remote.kind === "github" ? [issue ? "issues" : "pull"] : ["-", issue ? "issues" : "merge_requests"];
  const at = parts.findIndex((p, i) => markers.every((m, j) => parts[i + j] === m));
  const repo = at < 0 ? [] : parts.slice(0, at);
  const num = at < 0 ? undefined : parts[at + markers.length];
  const same = repo.length === remote.segments.length && repo.every((s, i) => s.toLowerCase() === remote.segments[i]!.toLowerCase());
  if (!same || !num || !/^[1-9][0-9]*$/.test(num)) throw new UsageError(`target URL is not ${issue ? "an issue" : "a pull/merge request"} of ${remote.segments.join("/")}`);
  return num;
}

function readText(env: PostEnv, file: string, what: "title" | "body"): string {
  let text: string;
  try { text = env.readFile(file); } catch { throw new UsageError(`cannot read ${what} file ${file}; write it with your file-write tool first`); }
  if (what === "title") {
    text = text.replace(/\r?\n$/, "");
    if (/[\r\n]/.test(text)) throw new UsageError("title file must hold one line");
  }
  if (!text.trim()) throw new UsageError(`${what} file ${file} is empty; write the text first`);
  return text;
}

function visibility(env: PostEnv, req: Request, kind: HostKind, configBin: string): RepoVisibility {
  if (req.visibility) return req.visibility;
  const norm = (s: string) => {
    const v = s.trim().toLowerCase();
    return v === "public" || v === "private" || v === "unknown" ? v : undefined;
  };
  const cfg = env.run(configBin, ["get", "redact_repo_visibility"]);
  const fromConfig = cfg.status === 0 ? norm(cfg.stdout) : undefined;
  if (fromConfig) return fromConfig;
  if (kind === "github") {
    const gh = env.run("gh", ["repo", "view", "--json", "visibility", "--jq", ".visibility"]);
    return (gh.status === 0 && norm(gh.stdout)) || "unknown";
  }
  const gl = env.run("glab", ["repo", "view", "--output", "json"]);
  if (gl.status !== 0) return "unknown";
  try { return norm(String(JSON.parse(gl.stdout).visibility ?? "")) ?? "unknown"; } catch { return "unknown"; }
}

type Part = "title" | "body";
interface Located { part: Part; finding: Finding }

/**
 * The repository's own four-part release versions: the root VERSION file's
 * value and every version in a root CHANGELOG.md release heading, read with
 * the same parser gstack-restamp uses (`## [1.2.3.4]`, `## v1.2.3.4`, an
 * optional `- date`; a heading that only mentions a quad is not one). A
 * four-part version is byte-for-byte a dotted quad, and `1.91.191.0` is a
 * public address, so "(1.91.191.0)" in a PR body raised pii.ip_public
 * (MEDIUM), which an unattended /ship cannot confirm. The engine's own version
 * exemption reads only the declaration right before the span, so prose that
 * merely names a release gets no help from it. These exact strings are
 * allowlisted for the scan wherever they appear (the allowlist is exact-string
 * and context-free, so `host: <released quad>` is exempt too, a trade the
 * repo's own release set is small enough to carry); any other dotted quad
 * (8.8.8.8, 203.0.113.7, a version this repo never released) still reports.
 * The files are read from the checked-out tree, so a branch that adds a
 * four-part heading widens the set for posts made from that checkout.
 */
function repoReleaseVersions(env: PostEnv): string[] {
  const top = env.run("git", ["rev-parse", "--show-toplevel"]);
  const root = top.status === 0 ? top.stdout.trim() : "";
  if (!root) return [];
  const read = (name: string) => { try { return env.readFile(`${root}/${name}`); } catch { return ""; } };
  const versions = new Set<string>();
  const current = read("VERSION").trim();
  if (versionWidth(current) === 4) versions.add(current);
  for (const s of parseChangelog(read("CHANGELOG.md")).sections) if (s.version && versionWidth(s.version) === 4) versions.add(s.version);
  return [...versions];
}

/** Between two 11-digit tokens of one list: `, `, ` and `, ` & `, ` or `, ` / `, with an optional `(#1234)` after the first. */
const RUN_ID_CHAIN = /^(?:\s*\(#\d+\))?\s*(?:,|and|&|or|\/)\s*$/i;

/**
 * All-digit identifiers a ship receipt or a CI report names, which
 * pii.phone.e164 reads as phone numbers: a 12-hex receipt sha that happens to
 * be all digits (`tree=704992822996`, `tree 704992822996`, and the receipt's
 * `head=`, `gated_tree=` and `predecessor=` keys), an 11-digit GitHub Actions
 * run id inside an /actions/runs/ URL (the engine already exempts the URL
 * itself; this covers its link text), and an 11-digit run id right after a run
 * word on the same line (run, runs, screen, screens, gate, gates, backstop,
 * bisect, rerun, dispatched, dispatch, failed, passed, with an optional ':'
 * '#' '=' between: `failed 40269992077`, `gate 40323989742`,
 * `run #19368712345`; the engine's isCiRunIdentifier exempts that position on
 * its own since the run-id fix for approval records, and the same regex drives
 * the chain below; generic words such as id, job, attempt and workflow
 * exempt nothing, since `customer id 14155551234` is a number), plus every 11-digit id chained
 * after an allowlisted one through ", ", " and ", " & ", " or " or " / ",
 * optionally with a "(#1234)" between (`screen 40269992077 (#3434) and
 * 40275443393 (#3453)`). Only the exact tokens found in those positions are
 * allowlisted, so a bare 11-digit number, a 10-digit national number and an
 * E.164 `+14155551234` still report.
 */
function receiptDigitTokens(texts: string[]): string[] {
  const tokens = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/(?:^|[^\w])(?:tree|gated_tree|head|predecessor)[= ](\d{12})\b/g)) tokens.add(m[1]!);
    for (const m of text.matchAll(/\/actions\/runs\/(\d{11})\b/g)) tokens.add(m[1]!);
    for (const line of text.split("\n")) {
      let chainFrom = -1;
      for (const m of line.matchAll(/(?<![\d+])\d{11}(?!\d)/g)) {
        const at = m.index!;
        const listed = CI_RUN_WORD_BEFORE.test(line.slice(0, at)) || (chainFrom >= 0 && RUN_ID_CHAIN.test(line.slice(chainFrom, at)));
        if (listed) tokens.add(m[0]);
        chainFrom = listed ? at + m[0].length : -1;
      }
    }
  }
  return [...tokens];
}

function scanParts(parts: Array<[Part, string]>, vis: RepoVisibility, selfEmail: string | undefined, releaseVersions: string[]) {
  const found: Located[] = [];
  let oversize = false;
  const allowlist = [...releaseVersions, ...receiptDigitTokens(parts.map(([, text]) => text))];
  for (const [part, text] of parts) {
    const result = scan(text, { repoVisibility: vis, allowlist, ...(selfEmail ? { selfEmail } : {}) });
    oversize ||= result.oversize;
    for (const finding of result.findings) found.push({ part, finding });
  }
  return { found, oversize };
}

export function confirmationToken(fields: Record<string, unknown>, parts: Array<[Part, string]>, medium: Located[]): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(fields));
  for (const [part, text] of parts) h.update(`\0${part}\0${Buffer.byteLength(text)}\0`).update(text);
  h.update(JSON.stringify(medium.map(m => [m.part, m.finding.id, m.finding.line, m.finding.col])));
  return h.digest("hex").slice(0, 24);
}

/** The argv that sends one operation; `stdin` carries the body where the CLI reads it from "-". */
function command(kind: HostKind, op: Op, n: string | undefined, req: Request, title?: string, body?: string): { cmd: string; args: string[]; stdin?: string } {
  if (kind === "github") {
    switch (op) {
      case "pr-comment": return { cmd: "gh", args: ["pr", "comment", n!, "--body-file=-"], stdin: body };
      case "issue-comment": return { cmd: "gh", args: ["issue", "comment", n!, "--body-file=-"], stdin: body };
      case "reply": return { cmd: "gh", args: ["api", "--method=POST", `repos/{owner}/{repo}/pulls/${n}/comments/${req.to}/replies`, "--field=body=@-"], stdin: body };
      case "pr-title": return { cmd: "gh", args: ["pr", "edit", n!, `--title=${title}`] };
      case "pr-body": return { cmd: "gh", args: ["pr", "edit", n!, "--body-file=-"], stdin: body };
      case "pr-create": return { cmd: "gh", args: ["pr", "create", `--base=${req.base}`, ...(req.head ? [`--head=${req.head}`] : []), `--title=${title}`, "--body-file=-", ...(req.draft ? ["--draft"] : [])], stdin: body };
      case "issue-create": return { cmd: "gh", args: ["issue", "create", `--title=${title}`, "--body-file=-"], stdin: body };
    }
  }
  switch (op) {
    case "pr-comment": return { cmd: "glab", args: ["mr", "note", n!, `--message=${body}`] };
    case "issue-comment": return { cmd: "glab", args: ["issue", "note", n!, `--message=${body}`] };
    case "pr-title": return { cmd: "glab", args: ["mr", "update", n!, `--title=${title}`] };
    case "pr-body": return { cmd: "glab", args: ["mr", "update", n!, `--description=${body}`] };
    case "pr-create": return { cmd: "glab", args: ["mr", "create", `--target-branch=${req.base}`, ...(req.head ? [`--source-branch=${req.head}`] : []), `--title=${title}`, `--description=${body}`, "--yes", ...(req.draft ? ["--draft"] : [])] };
    case "issue-create": return { cmd: "glab", args: ["issue", "create", `--title=${title}`, `--description=${body}`, "--yes"] };
    default: throw new UsageError(`${op} is not supported on GitLab`);
  }
}

/** `gh pr edit` can fail on the retired projectCards GraphQL field; the REST PATCH sends the same bytes. */
function restEdit(op: Op, n: string, title?: string, body?: string) {
  return op === "pr-title"
    ? { cmd: "gh", args: ["api", "--method=PATCH", `repos/{owner}/{repo}/pulls/${n}`, `--raw-field=title=${title}`] }
    : { cmd: "gh", args: ["api", "--method=PATCH", `repos/{owner}/{repo}/pulls/${n}`, "--field=body=@-", "--silent"], stdin: body };
}

function readBackTitle(env: PostEnv, kind: HostKind, n: string): string | undefined {
  const r = kind === "github"
    ? env.run("gh", ["pr", "view", n, "--json", "title", "--jq", ".title"])
    : env.run("glab", ["mr", "view", n, "--output", "json"]);
  if (r.status !== 0) return undefined;
  if (kind === "github") return r.stdout.replace(/\r?\n$/, "");
  try { return String(JSON.parse(r.stdout).title); } catch { return undefined; }
}

function send(env: PostEnv, kind: HostKind, req: Request, n: string | undefined, title?: string, body?: string): number {
  let c = command(kind, req.op, n, req, title, body);
  let r = env.run(c.cmd, c.args, c.stdin);
  if (r.status !== 0 && kind === "github" && (req.op === "pr-title" || req.op === "pr-body") && /projectCards/.test(r.stderr)) {
    c = restEdit(req.op, n!, title, body);
    r = env.run(c.cmd, c.args, c.stdin);
  }
  if (r.status !== 0) {
    env.err(`gstack-post: ${c.cmd} failed (exit ${r.status}); nothing more was sent.\n${r.stderr}`);
    return EXIT.cliFailed;
  }
  if (req.op === "pr-title") {
    for (let attempt = 0; readBackTitle(env, kind, n!) !== title; attempt++) {
      if (attempt === 1) {
        env.err("gstack-post: the PR title still differs from the title file after one retry.\n");
        return EXIT.cliFailed;
      }
      if (env.run(c.cmd, c.args, c.stdin).status !== 0) {
        env.err("gstack-post: retrying the title edit failed.\n");
        return EXIT.cliFailed;
      }
    }
  }
  if (r.stdout.trim()) env.out(r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n");
  env.out(`POSTED: ${req.op}${n ? ` ${n}` : ""}${req.attribute ? ` (attributed: ${req.attribute})` : ""}\n`);
  return EXIT.posted;
}

export function runPost(argv: string[], env: PostEnv, configBin = "gstack-config"): number {
  if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0]!)) {
    (argv.length === 0 ? env.err : env.out)(USAGE);
    return argv.length === 0 ? EXIT.usage : EXIT.posted;
  }
  try {
    const req = parseArgs(argv);
    const remote = resolveRemote(env, req.host);
    if (req.op === "reply" && remote.kind !== "github") throw new UsageError("reply is supported on GitHub only");
    const n = req.target === undefined ? undefined : targetNumber(req.target, req.op, remote);
    const title = req.titleFile ? readText(env, req.titleFile, "title") : undefined;
    let body = req.bodyFile ? readText(env, req.bodyFile, "body") : undefined;
    if (req.op === "pr-body" && !req.replace) {
      const current = currentBody(env, remote.kind, n!);
      if ("error" in current) {
        env.err(`gstack-post: cannot read PR ${n}'s current body to merge into (${current.error}); nothing was posted. Rerun with --replace to overwrite the whole body.\n`);
        return EXIT.cliFailed;
      }
      const m = mergeBodySections(current.body, body!);
      body = m.body;
      const list = (names: string[]) => (names.length ? names.join(", ") : "none");
      env.err(`gstack-post: pr-body merged by section: replaced ${list(m.replaced)}; kept ${list(m.kept)}; added ${list(m.added)}${m.dropped.length ? `; dropped ${m.dropped.join(", ")}` : ""}\n`);
    }
    if (body !== undefined && req.attribute) body = attributionCallout(req.attribute) + body;
    const parts: Array<[Part, string]> = [];
    if (title !== undefined) parts.push(["title", title]);
    if (body !== undefined) parts.push(["body", body]);

    const vis = visibility(env, req, remote.kind, configBin);
    const email = env.run("git", ["config", "user.email"]);
    const hasQuad = parts.some(([, text]) => /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text));
    const { found, oversize } = scanParts(parts, vis, email.status === 0 ? email.stdout.trim() || undefined : undefined, hasQuad ? repoReleaseVersions(env) : []);
    env.out(`REPO_VISIBILITY: ${vis}\n`);
    const calloutLines = req.attribute ? attributionCallout(req.attribute).split("\n").length - 1 : 0;
    const line = (m: Located) => {
      if (m.part === "body" && m.finding.line <= calloutLines) return `RULE: ${m.finding.id} LINE: 1 PART: attribute\n`;
      return `RULE: ${m.finding.id} LINE: ${m.part === "body" ? m.finding.line - calloutLines : m.finding.line} PART: ${m.part}\n`;
    };
    const high = found.filter(m => m.finding.severity === "HIGH");
    if (oversize || high.length) {
      for (const m of high) env.out(`HIGH ${line(m)}`);
      env.err(oversize
        ? "gstack-post: refused, the text is too large to scan safely. Nothing was posted.\n"
        : `gstack-post: refused, HIGH finding (${[...new Set(high.map(m => m.finding.id))].join(", ")}). Remove the value at its source and rotate it if it is a credential; no confirmation can post it.\n`);
      return EXIT.refused;
    }
    for (const m of found.filter(f => f.finding.severity === "LOW" || f.finding.severity === "WARN")) env.err(`note: ${m.finding.severity} ${line(m)}`);
    const medium = found.filter(m => m.finding.severity === "MEDIUM");
    if (medium.length) {
      const token = confirmationToken(
        { op: req.op, host: remote.kind, repo: [remote.host, ...remote.segments].join("/"), target: n ?? null, to: req.to ?? null, base: req.base ?? null, head: req.head ?? null, draft: req.draft, attribute: req.attribute ?? null },
        parts, medium);
      if (req.confirm !== token) {
        for (const m of medium) env.out(line(m));
        env.out(`TOKEN: ${token}\n`);
        env.err(req.confirm
          ? "gstack-post: the text, destination or findings changed since that token; nothing was posted. Ask about these findings again.\n"
          : "gstack-post: MEDIUM findings; nothing was posted. Ask the user about each finding; to post these exact bytes, rerun with --confirm <token>. Any edit needs a new scan.\n");
        return EXIT.confirm;
      }
    }
    return send(env, remote.kind, req, n, title, body);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    env.err(`gstack-post: ${e.message} (gstack-post --help shows usage)\n`);
    return EXIT.usage;
  }
}
