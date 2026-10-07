/**
 * greptile-early: /ship's early Greptile review (B2).
 *
 * When a repo uses Greptile (a root `.greptile/` folder, which takes
 * precedence, a root `greptile.json`, or a Greptile comment on the repo in the
 * last 90 days), /ship pushes and opens a draft PR right after its free tests
 * pass, so Greptile reviews while /ship runs its own passes. It is on by
 * default; `gstack-config set ship_greptile_early false` turns it off per user.
 * On a public (or unknown-visibility) repo the first early push asks once,
 * remembered per repo in the project's state.
 *
 *   detect                         signal, triggerOnDrafts, visibility, consent, on/off
 *   consent yes|no                 remember the public-repo answer for this repo
 *   open --base B --title-file F [--ready] [--confirm T]
 *                                  open the early PR through gstack-post and post one
 *                                  `@greptileai` comment when Greptile skips drafts
 *   wait <pr> --since <epoch>      poll (30 s) for a completed Greptile review of the
 *                                  PR's head commit; returns within ~90 s per call,
 *                                  `timeout` once 10 minutes have passed since <epoch>
 *
 * bin/gstack-greptile-early is the CLI; tests drive `runGreptileEarly` with a
 * fake runner so the logic runs on every platform.
 */
import * as fs from "fs";
import * as path from "path";
import { resolveStateRoot, readConfigKey, type StateRootEnv } from "./state-root";
import { remoteSlug } from "./remote-identity";

export interface EarlyEnv {
  run(cmd: string, args: string[], input?: string): { status: number; stdout: string; stderr: string };
  vars: StateRootEnv;
  /** Directory holding gstack-config and gstack-post (absolute; printed in user-facing lines). */
  binDir: string;
  /** How to run a Bun script in binDir. */
  bun: string;
  now(): number;
  sleep(ms: number): void;
  out(text: string): void;
  err(text: string): void;
}

export const WAIT_CAP_SECONDS = 600;
export const POLL_SECONDS = 30;
const CALL_BUDGET_SECONDS = 90;
const COMMENT_WINDOW_DAYS = 90;
const TRIGGER = "@greptileai";
export const EARLY_BODY = "/ship opened this pull request early so Greptile can review it while /ship runs its own checks. /ship will replace this title and description, and marks it ready for review unless a draft was requested.\n";

const isGreptile = (login: unknown) => typeof login === "string" && /greptile/i.test(login);

function json<T>(text: string): T | undefined {
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

function gitRoot(env: EarlyEnv): string | undefined {
  const r = env.run("git", ["rev-parse", "--show-toplevel"]);
  return r.status === 0 ? r.stdout.trim() : undefined;
}

export type Signal = "config-folder" | "greptile.json" | "comment" | "none";

/** Root config files only: the folder takes precedence, and triggerOnDrafts must be literally true. */
export function configSignal(root: string): { signal: Signal; triggerOnDrafts: boolean } {
  const folder = path.join(root, ".greptile");
  if (fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
    const cfg = json<{ triggerOnDrafts?: unknown }>(readOr(path.join(folder, "config.json")));
    return { signal: "config-folder", triggerOnDrafts: cfg?.triggerOnDrafts === true };
  }
  const file = path.join(root, "greptile.json");
  if (fs.existsSync(file)) {
    const cfg = json<{ triggerOnDrafts?: unknown }>(readOr(file));
    return { signal: "greptile.json", triggerOnDrafts: cfg?.triggerOnDrafts === true };
  }
  return { signal: "none", triggerOnDrafts: false };
}

function readOr(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

/** A Greptile comment on any PR of this repo in the last 90 days (conversation or review comments). */
function recentComment(env: EarlyEnv): boolean {
  const since = new Date(env.now() - COMMENT_WINDOW_DAYS * 86_400_000).toISOString();
  for (const kind of ["issues", "pulls"]) {
    const r = env.run("gh", ["api", `repos/{owner}/{repo}/${kind}/comments?sort=created&direction=desc&per_page=100&since=${since}`,
      "--jq", "[.[] | {login: .user.login, created: .created_at}]"]);
    const rows = r.status === 0 ? json<Array<{ login: string; created: string }>>(r.stdout) : undefined;
    if (rows?.some(c => isGreptile(c.login) && c.created >= since)) return true;
  }
  return false;
}

function visibility(env: EarlyEnv): "public" | "private" | "unknown" {
  const r = env.run("gh", ["repo", "view", "--json", "visibility", "--jq", ".visibility"]);
  const v = r.status === 0 ? r.stdout.trim().toLowerCase() : "";
  return v === "private" || v === "internal" ? "private" : v === "public" ? "public" : "unknown";
}

function consentFile(env: EarlyEnv): string | undefined {
  const slug = env.run(path.join(env.binDir, "gstack-slug"), ["--get", "SLUG"]);
  let id = slug.status === 0 ? slug.stdout.trim() : "";
  if (!id) {
    const origin = env.run("git", ["remote", "get-url", "origin"]);
    id = origin.status === 0 ? remoteSlug(origin.stdout.trim()) : "";
  }
  return id ? path.join(resolveStateRoot(env.vars), "projects", id, "ship-greptile-early.json") : undefined;
}

function storedConsent(env: EarlyEnv): "yes" | "no" | undefined {
  const file = consentFile(env);
  const v = file ? json<{ consent?: string }>(readOr(file))?.consent : undefined;
  return v === "yes" || v === "no" ? v : undefined;
}

const config = (env: EarlyEnv) => path.join(env.binDir, "gstack-config");
const SIGNAL_TEXT: Record<Exclude<Signal, "none">, string> = {
  "config-folder": "a .greptile/ config folder",
  "greptile.json": "greptile.json",
  comment: `a Greptile comment on this repo in the last ${COMMENT_WINDOW_DAYS} days`,
};

function detect(env: EarlyEnv): number {
  const line = (k: string, v: string) => env.out(`${k}: ${v}\n`);
  const off = (reason: string) => { line("GREPTILE_EARLY", "off"); line("GREPTILE_EARLY_REASON", reason); return 0; };
  if (readConfigKey("ship_greptile_early", env.vars) === "false") {
    off("ship_greptile_early is false");
    env.out(`Greptile early review is off for you. Turn it back on: ${config(env)} set ship_greptile_early true\n`);
    return 0;
  }
  const root = gitRoot(env);
  if (!root) return off("not in a git repository");
  if (env.run("gh", ["auth", "status"]).status !== 0) return off("gh is missing or not logged in");
  if (env.run("gh", ["repo", "view", "--json", "nameWithOwner"]).status !== 0) return off("not a GitHub repository");
  const cfg = configSignal(root);
  const signal: Signal = cfg.signal !== "none" ? cfg.signal : recentComment(env) ? "comment" : "none";
  line("GREPTILE_SIGNAL", signal);
  if (signal === "none") return off("no Greptile signal (.greptile/, greptile.json, or a Greptile comment in 90 days)");
  line("GREPTILE_TRIGGER_ON_DRAFTS", String(cfg.triggerOnDrafts));
  const vis = visibility(env);
  line("REPO_VISIBILITY", vis);
  const stored = vis === "private" ? undefined : storedConsent(env);
  const consent = vis === "private" ? "not-needed" : stored === "yes" ? "granted" : stored === "no" ? "declined" : "ask";
  line("GREPTILE_CONSENT", consent);
  if (consent === "declined") return off("you declined early pushes for this public repo");
  line("GREPTILE_EARLY", consent === "ask" ? "ask" : "on");
  env.out(`Greptile: found ${SIGNAL_TEXT[signal]}. /ship will push this branch and open a draft PR now so Greptile reviews while /ship runs, then wait up to ${WAIT_CAP_SECONDS / 60} minutes for that review at Step 10. Turn this off: ${config(env)} set ship_greptile_early false\n`);
  return 0;
}

function consent(env: EarlyEnv, answer: string | undefined): number {
  if (answer !== "yes" && answer !== "no") { env.err("usage: gstack-greptile-early consent yes|no\n"); return 64; }
  const file = consentFile(env);
  if (!file) { env.err("gstack-greptile-early: cannot resolve this project's state directory.\n"); return 1; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ consent: answer, decided_at: new Date(env.now()).toISOString() }) + "\n");
  env.out(`GREPTILE_CONSENT: ${answer === "yes" ? "granted" : "declined"}\n`);
  return 0;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function privateFile(root: string, stem: string, text: string): string {
  const dir = path.join(root, ".gstack", "tmp");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${stem}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

function open(env: EarlyEnv, args: string[]): number {
  const base = flag(args, "--base");
  const titleFile = flag(args, "--title-file");
  const confirm = flag(args, "--confirm");
  const ready = args.includes("--ready");
  if (!base || !titleFile) { env.err("usage: gstack-greptile-early open --base <branch> --title-file <file> [--ready] [--confirm <token>]\n"); return 64; }
  const root = gitRoot(env);
  if (!root) { env.err("gstack-greptile-early: not in a git repository.\n"); return 64; }
  const branch = env.run("git", ["branch", "--show-current"]).stdout.trim();
  const existing = env.run("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"]);
  const found = existing.status === 0 ? json<Array<{ number: number; url: string }>>(existing.stdout) : undefined;
  if (!found) { env.err(`gstack-greptile-early: could not look up open PRs for ${branch}; not opening one.\n${existing.stderr}`); return 3; }
  if (found.length) {
    env.out(`EARLY_PR: none (PR ${found[0]!.number} is already open; Step 10 triages it as before)\n`);
    return 0;
  }
  const post = path.join(env.binDir, "gstack-post");
  const body = privateFile(root, "greptile-early-body", EARLY_BODY);
  try {
    const created = env.run(env.bun, [post, "pr-create", "--base", base, "--title-file", titleFile, "--body-file", body, ...(ready ? [] : ["--draft"]), ...(confirm ? ["--confirm", confirm] : [])]);
    env.out(created.stdout);
    if (created.status !== 0) { env.err(created.stderr); return created.status; }
    const url = /^https?:\/\/\S+\/pull\/(\d+)\s*$/m.exec(created.stdout);
    if (!url) { env.err("gstack-post did not print the new PR URL.\n"); return 3; }
    env.out(`EARLY_PR: ${url[1]}\nEARLY_PR_URL: ${url[0].trim()}\nEARLY_PR_OPENED_AT: ${Math.floor(env.now() / 1000)}\n`);
    if (ready) { env.out("GREPTILE_TRIGGER: not needed (ready PR; Greptile reviews it when opened)\n"); return 0; }
    if (configSignal(root).triggerOnDrafts) { env.out("GREPTILE_TRIGGER: not needed (triggerOnDrafts: true)\n"); return 0; }
    const comment = privateFile(root, "greptile-trigger", TRIGGER + "\n");
    try {
      const posted = env.run(env.bun, [post, "pr-comment", url[1]!, "--body-file", comment]);
      env.out(posted.status === 0 ? "GREPTILE_TRIGGER: posted\n" : `GREPTILE_TRIGGER: failed (gstack-post exit ${posted.status}); Greptile may not review the draft\n`);
    } finally { fs.rmSync(comment, { force: true }); }
    return 0;
  } finally { fs.rmSync(body, { force: true }); }
}

type Done = "check run" | "review" | "summary comment";

/** A completed Greptile check run on the head, a Greptile review of the head, or a summary comment naming it. */
export function reviewDone(env: EarlyEnv, pr: string, sha: string): Done | undefined {
  const checks = env.run("gh", ["api", `repos/{owner}/{repo}/commits/${sha}/check-runs`, "--jq", "[.check_runs[] | {name, status, app: .app.slug}]"]);
  if (json<Array<{ name: string; status: string; app: string }>>(checks.stdout)?.some(c => c.status === "completed" && (isGreptile(c.name) || isGreptile(c.app)))) return "check run";
  const reviews = env.run("gh", ["api", `repos/{owner}/{repo}/pulls/${pr}/reviews`, "--jq", "[.[] | {login: .user.login, commit: .commit_id}]"]);
  if (json<Array<{ login: string; commit: string }>>(reviews.stdout)?.some(r => isGreptile(r.login) && r.commit === sha)) return "review";
  const comments = env.run("gh", ["api", `repos/{owner}/{repo}/issues/${pr}/comments`, "--jq", '[.[] | select(.user.login | test("greptile"; "i")) | .body]']);
  if (json<string[]>(comments.stdout)?.some(b => b.includes(sha.slice(0, 7)))) return "summary comment";
  return undefined;
}

function wait(env: EarlyEnv, args: string[]): number {
  const pr = args[0];
  const since = Number(flag(args, "--since"));
  if (!pr || !/^[1-9][0-9]*$/.test(pr) || !Number.isInteger(since) || since <= 0) { env.err("usage: gstack-greptile-early wait <pr-number> --since <epoch-seconds>\n"); return 64; }
  const head = env.run("gh", ["pr", "view", pr, "--json", "headRefOid", "--jq", ".headRefOid"]);
  const sha = head.stdout.trim();
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) { env.out("GREPTILE_REVIEW: unavailable (could not read the PR head commit)\n"); return 0; }
  const started = env.now();
  for (;;) {
    const done = reviewDone(env, pr, sha);
    if (done) { env.out(`GREPTILE_REVIEW: complete (${done} on ${sha.slice(0, 7)})\n`); return 0; }
    const elapsed = Math.floor(env.now() / 1000) - since;
    if (elapsed >= WAIT_CAP_SECONDS) { env.out(`GREPTILE_REVIEW: timeout (no completed Greptile review of ${sha.slice(0, 7)} after ${WAIT_CAP_SECONDS / 60} minutes)\n`); return 0; }
    const mmss = `${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, "0")}s`;
    env.out(`Greptile: waiting for its review of ${sha.slice(0, 7)} (${mmss} of ${WAIT_CAP_SECONDS / 60}m). Turn early review off: ${config(env)} set ship_greptile_early false\n`);
    if ((env.now() - started) / 1000 + POLL_SECONDS > CALL_BUDGET_SECONDS) { env.out("GREPTILE_REVIEW: pending\n"); return 0; }
    env.sleep(POLL_SECONDS * 1000);
  }
}

export function runGreptileEarly(argv: string[], env: EarlyEnv): number {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "detect": return detect(env);
    case "consent": return consent(env, rest[0]);
    case "open": return open(env, rest);
    case "wait": return wait(env, rest);
    default:
      env.err("usage: gstack-greptile-early {detect | consent yes|no | open --base B --title-file F [--ready] [--confirm T] | wait <pr> --since <epoch>}\n");
      return cmd === "help" || cmd === "--help" ? 0 : 64;
  }
}
