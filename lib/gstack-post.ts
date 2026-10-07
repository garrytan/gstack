/**
 * gstack-post: the one write path for PR and issue text (B4).
 *
 * Every value reaches `gh`/`glab` as its own argv element in `--flag=<value>`
 * form, or on stdin, never through a shell string. The text comes from files
 * the agent wrote with its file tool; the helper reads each file once, scans
 * those exact bytes with the shared redaction engine, and sends the same bytes.
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
import { canonicalRemote } from "./remote-identity";

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

  gstack-post pr-comment    <pr>    --body-file F
  gstack-post issue-comment <issue> --body-file F
  gstack-post reply         <pr>    --to <review-comment-id> --body-file F   (GitHub only)
  gstack-post pr-title      <pr>    --title-file F
  gstack-post pr-body       <pr>    --body-file F
  gstack-post pr-create --base <branch> [--head <branch>] [--draft] --title-file F --body-file F
  gstack-post issue-create  --title-file F --body-file F

  <pr>/<issue> is a number or a URL of this repository on the same host.
  Options: --host github|gitlab (default: detected from the origin remote)
           --repo-visibility public|private|unknown (default: config, then gh/glab)
           --confirm <token>   post bytes whose MEDIUM findings the user confirmed

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
  titleFile?: string;
  bodyFile?: string;
  host?: HostKind;
  visibility?: RepoVisibility;
  confirm?: string;
}

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["--to", "--base", "--head", "--title-file", "--body-file", "--host", "--repo-visibility", "--confirm"]);

function parseArgs(argv: string[]): Request {
  const [op, ...rest] = argv;
  if (!OPS.includes(op as Op)) throw new UsageError(op ? `unknown operation "${op}"` : "missing operation");
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let draft = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--draft") { draft = true; continue; }
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
    op: op as Op, draft,
    target: positional[0], to: flags.get("--to"), base: flags.get("--base"), head: flags.get("--head"),
    titleFile: flags.get("--title-file"), bodyFile: flags.get("--body-file"),
    host: host as HostKind | undefined, visibility: vis as RepoVisibility | undefined, confirm: flags.get("--confirm"),
  };
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
  return req;
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

function scanParts(parts: Array<[Part, string]>, vis: RepoVisibility, selfEmail: string | undefined) {
  const found: Located[] = [];
  let oversize = false;
  for (const [part, text] of parts) {
    const result = scan(text, { repoVisibility: vis, ...(selfEmail ? { selfEmail } : {}) });
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
  env.out(`POSTED: ${req.op}${n ? ` ${n}` : ""}\n`);
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
    const body = req.bodyFile ? readText(env, req.bodyFile, "body") : undefined;
    const parts: Array<[Part, string]> = [];
    if (title !== undefined) parts.push(["title", title]);
    if (body !== undefined) parts.push(["body", body]);

    const vis = visibility(env, req, remote.kind, configBin);
    const email = env.run("git", ["config", "user.email"]);
    const { found, oversize } = scanParts(parts, vis, email.status === 0 ? email.stdout.trim() || undefined : undefined);
    env.out(`REPO_VISIBILITY: ${vis}\n`);
    const line = (m: Located) => `RULE: ${m.finding.id} LINE: ${m.finding.line} PART: ${m.part}\n`;
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
        { op: req.op, host: remote.kind, repo: [remote.host, ...remote.segments].join("/"), target: n ?? null, to: req.to ?? null, base: req.base ?? null, head: req.head ?? null, draft: req.draft },
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
