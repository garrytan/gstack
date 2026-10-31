/**
 * pr-wait — gstack-pr-wait's event logic: watch one pull request and print one
 * line per real event on stdout, so a monitor wakes the agent once per event
 * and never for a poll that found nothing. Progress goes to stderr. The GitHub
 * reads are lib/pr-wait-github.ts.
 *
 * Design ported from tstack's `pr-wait` (t3dotgg/tstack,
 * skills/babysit-pr/scripts/pr-wait at 7de017b, MIT, Copyright (c) 2026 Theo
 * Browne; NOTICE.md and licenses/MIT-tstack.txt), rewritten in TypeScript:
 * state lives under gstack's state root (lib/state-root.ts) instead of
 * ~/.local/state, and the review-bot lists are `gstack-config` keys
 * (`pr_wait_gating_bots`, `pr_wait_advisory_bots`) instead of constants.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { GhRunner } from './ci-gate';
import {
  GhError, behindBy, bucketClass, compareFiles, confirmPullRequest, currentRepo, fetchChecks, fetchPullRequest,
  pullRequestFiles, requiredChecks, type Check, type GhEnv, type PullRequest,
} from './pr-wait-github';
import { readConfigKey, resolveStateRoot, type StateRootEnv } from './state-root';
import { resultCodeSuffix, resultLineWithDocs } from './result-codes';

export type Until = 'green' | 'ready' | 'any-change';
export const PR_WAIT_EXIT = { met: 0, blocked: 1, refused: 2 } as const;
export const DEFAULT_GATING_BOTS = ['greptile', 'macroscope'];
export const DEFAULT_ADVISORY_BOTS = ['coderabbit'];
/** CI and deploy bots report through checks; their PR comments repeat that news. */
const STATUS_BOTS = ['github-actions', 'vercel', 'netlify', 'railway', 'cloudflare'];
/** A state file older than this describes an old session: start a fresh baseline instead of replaying it. */
export const STALE_STATE_MS = 6 * 3600 * 1000;
const MAX_FAILED_POLLS = 10;
const MIN_INTERVAL_SECONDS = 5;
/** Minutes before a watch that met nothing ends as PR_WAIT_BLOCKED, naming what is still pending; 0 waits without limit. */
export const DEFAULT_TIMEOUT_MINUTES = 60;

export interface PrWaitEnv {
  gh: GhRunner;
  vars: StateRootEnv;
  pid: number;
  now(): number;
  sleep(ms: number): void;
  out(text: string): void;
  err(text: string): void;
  pidAlive(pid: number): boolean;
}

export interface PrWaitOptions { target?: string; repo?: string; until: Until; interval: number; timeout: number; excludes: string[] }
export interface BotLists { gating: string[]; advisory: string[] }

interface State { reported: string[]; summaries: Record<string, string>; base_oid: string | null; merge_state: string | null }

/**
 * The base-overlap event, one shape for the watcher and for `gstack-ship-queue
 * ready` / `train build`, which read the same fact from git (handoff
 * GSTA-119): the base moved and its new commits touch files this PR changes.
 */
export function baseOverlapLine(base: string, baseOid: string, touched: readonly string[]): string {
  const more = touched.length > 5 ? ` and ${touched.length - 5} more` : '';
  return `${base} moved to ${baseOid.slice(0, 7)} and touches files in this PR: ${touched.slice(0, 5).join(', ')}${more}`;
}

export const PR_WAIT_USAGE = `gstack-pr-wait <pr> [--repo owner/name] [--until green|ready|any-change] [--interval SECONDS] [--timeout MINUTES] [--exclude CHECK,...]

Watches one pull request and prints one line per real event on stdout (prefixed
#<pr>), so a monitor wakes the agent once per event. Progress and recoverable
errors go to stderr. <pr> is a PR number or URL; without --repo the repository
comes from the URL or the current checkout.

--until
  green       every CI check on the current head passed, confirmed by two
              identical polls; a check the base branch requires counts as
              pending until it appears
  ready       green, a gating review bot reviewed the current head (none
              configured: green alone), no review thread is unresolved and the
              merge state is known (default)
  any-change  stop after the first poll that prints an event

--timeout   minutes before a watch that met nothing ends as PR_WAIT_BLOCKED,
            naming what is still pending (default 60; 0 waits without limit)
--exclude   check names (comma-separated, repeatable) left out of the verdict,
            as gstack-ci-gate --exclude does: a named check neither holds green
            while pending nor blocks when it fails. A check the base branch
            requires cannot be excluded; the name is logged as refused and gates

Events: a check failed (name and link); all checks finished on the
head (one summary line); a comment, review, thread or thread reply from someone
other than the PR author or the gh user; a review bot finished on the head, or
a gating bot's summary changed afterwards; the base branch moved and the new
commits touch files in this PR; merge state became BEHIND or DIRTY; the PR
merged or closed. Comment edits are never events, and top-level comments from
CI and deploy bots are skipped because checks carry that news.

Review bots: gstack-config set pr_wait_gating_bots greptile,macroscope
             gstack-config set pr_wait_advisory_bots coderabbit
A bot owns the logins that start with its name (greptile-apps[bot]) and the
checks that mention it. An advisory bot's review is reported, never waited on;
its checks gate like any other. The value none empties a list.

Exit codes
  0  the --until condition is met, or the PR merged
  1  the condition needs action (PR_WAIT_BLOCKED): a check failed, the
     branch conflicts with its base, the PR closed, ready is blocked by
     unresolved threads or a BEHIND branch, GitHub stayed unreachable, or
     --timeout passed
  2  bad arguments, an unknown PR, another watcher holds this PR, or a local
     error stopped the watch before a verdict (PR_WAIT_REFUSED)

Required checks come from rulesets and classic branch protection, so a
required check that has not started yet is pending, never green by omission.
State: <state root>/pr-wait/<owner>__<name>__<pr>.json and .lock; a baseline
older than 6 hours is discarded. Stopping the watcher (Ctrl-C, kill) leaves its
lock, which the next watcher for the PR takes over once the pid is gone.
Docs: docs/troubleshooting.md#gstack-pr-wait`;

export function parsePrWaitArgs(argv: string[]): PrWaitOptions | { help: true } | { error: string } {
  const opts: PrWaitOptions = { until: 'ready', interval: 20, timeout: DEFAULT_TIMEOUT_MINUTES, excludes: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--repo' || flag === '-R') { opts.repo = argv[++i]; continue; }
    if (flag === '--until') {
      const value = argv[++i];
      if (value !== 'green' && value !== 'ready' && value !== 'any-change') return { error: `--until needs green, ready or any-change, not '${value ?? ''}'` };
      opts.until = value;
      continue;
    }
    if (flag === '--interval') {
      const value = argv[++i] ?? '';
      if (!/^[0-9]+$/.test(value)) return { error: `--interval needs a whole number of seconds, not '${value}'` };
      opts.interval = Math.max(Number(value), MIN_INTERVAL_SECONDS);
      continue;
    }
    if (flag === '--timeout') {
      const value = argv[++i] ?? '';
      if (!/^[0-9]+$/.test(value)) return { error: `--timeout needs a whole number of minutes, not '${value}'` };
      opts.timeout = Number(value);
      continue;
    }
    if (flag === '--exclude') {
      const names = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
      if (!names.length) return { error: '--exclude needs one or more check names, comma-separated' };
      for (const name of names) if (!opts.excludes.includes(name)) opts.excludes.push(name);
      continue;
    }
    if (flag.startsWith('-') && !/^-?\d+$/.test(flag)) return { error: `unknown argument ${flag}` };
    if (opts.target !== undefined) return { error: `unexpected argument ${flag}` };
    opts.target = flag;
  }
  return opts;
}

/** The PR number and, when the target is a URL, its repository. */
export function parsePrTarget(raw: string | undefined, repo?: string): { repo?: string; pr: number } | { error: string } {
  const text = (raw ?? '').trim();
  if (!text) return { error: 'missing PR number. Did a variable expand to nothing? Usage: gstack-pr-wait <pr> [--repo owner/name]' };
  const url = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/.exec(text);
  const number = /^#?(\d+)$/.exec(text);
  const pr = url ? Number(url[2]) : number ? Number(number[1]) : 0;
  if (!url && !number) return { error: `'${text}' is not a PR number or PR URL` };
  if (pr <= 0) return { error: `'${text}' is not a valid PR number` };
  const resolved = repo || (url ? url[1] : undefined);
  if (resolved !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(resolved)) return { error: `'${resolved}' is not owner/name` };
  return { repo: resolved, pr };
}

/** The configured bot that owns a login: the first name the lowercased login starts with (greptile-apps[bot] is greptile, notgreptile is nobody). */
export function botOwning(login: string | null | undefined, bots: readonly string[]): string | null {
  const lowered = (login ?? '').toLowerCase();
  if (!lowered) return null;
  return bots.filter(bot => bot !== '' && lowered.startsWith(bot)).sort((a, b) => b.length - a.length)[0] ?? null;
}

function botList(value: string | null, fallback: string[]): string[] {
  if (value === null) return fallback;
  return value.split(',').map(s => s.trim().toLowerCase()).filter(s => s && s !== 'none');
}

/** The review-bot lists, from gstack-config with tstack's defaults; `none` empties a list. */
export function botLists(vars: StateRootEnv): BotLists {
  return {
    gating: botList(readConfigKey('pr_wait_gating_bots', vars), DEFAULT_GATING_BOTS),
    advisory: botList(readConfigKey('pr_wait_advisory_bots', vars), DEFAULT_ADVISORY_BOTS),
  };
}

export function stateDir(vars: StateRootEnv): string {
  return path.join(resolveStateRoot(vars), 'pr-wait');
}

const plain = (body: string): string => body.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' })[m] ?? m);
export function snippet(body: string, limit = 100): string {
  const text = plain(body).replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}
/** The verdict line of a review bot's summary, if it has one. */
export function verdictLine(body: string): string {
  const line = plain(body).split(/\r?\n/).find(l => /verdict|confidence score/i.test(l));
  return line ? snippet(line.replace(/\*/g, ''), 80) : '';
}
const digest = (body: string): string => createHash('sha1').update(plain(body).replace(/\s+/g, ' ')).digest('hex').slice(0, 12);

export class Watcher {
  readonly stateFile: string;
  readonly lockFile: string;
  private state: State;
  private reported: Set<string>;
  private printed = new Set<string>();
  private events = 0;
  /** First run for this PR: record what exists and report nothing. */
  baseline: boolean;
  private required: Set<string> | null = null;
  /** False when a required-check source could not be read: the set may be short, so no --exclude name is excluded. */
  private requiredKnown = true;
  private prevSnapshot: string | null = null;
  private prFiles = new Map<string, Set<string>>();
  private pending: string[] = [];
  private readonly gh: GhEnv;

  constructor(readonly env: PrWaitEnv, readonly repo: string, readonly pr: number, readonly until: Until, readonly interval: number, readonly bots: BotLists, readonly timeoutMinutes = DEFAULT_TIMEOUT_MINUTES, readonly excludes: readonly string[] = []) {
    const stem = path.join(stateDir(env.vars), `${repo.replace('/', '__')}__${pr}`);
    this.stateFile = `${stem}.json`;
    this.lockFile = `${stem}.lock`;
    this.gh = { gh: env.gh, sleep: ms => env.sleep(ms), log: message => this.log(message) };
    const loaded = this.load();
    this.baseline = loaded === null;
    this.state = loaded ?? { reported: [], summaries: {}, base_oid: null, merge_state: null };
    this.reported = new Set(this.state.reported);
  }

  private log(message: string): void { this.env.err(`gstack-pr-wait: ${message}\n`); }

  private load(): State | null {
    try {
      if (this.env.now() - fs.statSync(this.stateFile).mtimeMs > STALE_STATE_MS) return null;
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.reported)) return null;
      return { reported: parsed.reported, summaries: parsed.summaries ?? {}, base_oid: parsed.base_oid ?? null, merge_state: parsed.merge_state ?? null };
    } catch {
      return null;
    }
  }

  save(): void {
    this.state.reported = [...this.reported].sort();
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.stateFile);
  }

  /** Hold the per-PR lock for the life of the process; a live holder means this watcher must not start. */
  lock(): { held: string } | null {
    fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
    try {
      fs.writeFileSync(this.lockFile, String(this.env.pid), { flag: 'wx' });
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = fs.readFileSync(this.lockFile, 'utf8').trim();
    if (/^\d+$/.test(holder) && Number(holder) !== this.env.pid && this.env.pidAlive(Number(holder))) return { held: holder };
    fs.writeFileSync(this.lockFile, String(this.env.pid));
    return null;
  }

  unlock(): void {
    try {
      if (fs.readFileSync(this.lockFile, 'utf8').trim() === String(this.env.pid)) fs.unlinkSync(this.lockFile);
    } catch { /* already gone */ }
  }

  /** One event is one line: control characters from GitHub text can never start a second one. */
  private say(line: string): void {
    if (this.printed.has(line)) return;
    this.printed.add(line);
    this.env.out(`#${this.pr} ${line.replace(/[\x00-\x1f\x7f]+/g, ' ')}\n`);
  }

  /** Print an event once per PR, across restarts. */
  private emit(key: string, line: string): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    if (this.baseline) return;
    this.events += 1;
    this.say(line);
  }

  private finish(code: number, lines: string[] = []): number {
    for (const line of lines) this.say(line);
    if (code === PR_WAIT_EXIT.blocked) this.say(`stopped: action needed ${resultCodeSuffix('PR_WAIT_BLOCKED')}`);
    // The verdict is printed; a state file that cannot be written must not turn it into a refusal.
    try { this.save(); } catch (error) { this.log(`could not save state: ${error instanceof Error ? error.message : String(error)}`); }
    return code;
  }

  /** The configured bot a check name mentions, or (for a login) that the login starts with: greptile-apps[bot] is greptile, notgreptile is nobody. */
  private botOf(text: string, login = false): string | null {
    const bots = [...this.bots.gating, ...this.bots.advisory];
    if (login) return botOwning(text, bots);
    const lowered = text.toLowerCase();
    return bots.find(bot => lowered.includes(bot)) ?? null;
  }

  private isAdvisory(name: string): boolean {
    const bot = this.botOf(name);
    return bot !== null && this.bots.advisory.includes(bot);
  }

  private baseOverlap(head: string, from: string, to: string): string[] {
    try {
      if (!this.prFiles.has(head)) this.prFiles.set(head, pullRequestFiles(this.gh, this.repo, this.pr));
      const mine = this.prFiles.get(head)!;
      return compareFiles(this.gh, this.repo, from, to).filter(file => mine.has(file)).sort();
    } catch (error) {
      this.log(`could not compare base commits: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private behindSuffix(base: string, baseOid: string | null, head: string): string {
    if (!baseOid) return '';
    const count = behindBy(this.gh, this.repo, baseOid, head);
    return count === null ? '' : `; ${count} commit${count === '1' ? '' : 's'} behind ${base}`;
  }

  /**
   * `--exclude` names that are not required checks: the ones the verdict leaves out, as gstack-ci-gate does. While the
   * required set is unknown (a source could not be read) nothing is excluded, as gstack-ci-gate refuses its overrides.
   */
  private excluded(): Set<string> {
    return new Set(this.requiredKnown ? this.excludes.filter(name => !this.required?.has(name)) : []);
  }

  private evaluateChecks(all: Map<string, Check>, head: string) {
    const required = this.required ?? new Set<string>();
    // Every check on the head gates, as gstack-ci-gate does, so land-and-deploy's two gates never
    // disagree; a required check gates even before it appears. An advisory bot's review is never
    // waited for, but its check is a check like any other. A --exclude name that is not required
    // is left out of the verdict; a required one cannot be excluded and gates.
    const excluded = this.excluded();
    const checks = new Map([...all].filter(([name]) => !excluded.has(name)));
    const watched = checks;
    const gate = new Set([...required, ...watched.keys()]);
    const bucketOf = (name: string) => checks.get(name)?.bucket ?? 'pending';
    const failLines: string[] = [];
    for (const name of [...gate].sort()) {
      if (bucketClass(bucketOf(name)) !== 'fail') continue;
      const line = `${required.has(name) ? 'required check' : 'check'} failed: ${name} ${checks.get(name)?.link ?? ''}`.trimEnd();
      failLines.push(line);
      this.emit(`fail:${head}:${name}:${checks.get(name)?.link ?? ''}`, line);
    }
    this.pending = [...gate].filter(name => bucketClass(bucketOf(name)) === 'pending').sort();
    const allDone = gate.size > 0 && this.pending.length === 0;
    // Checks appear a few seconds after a push: two identical polls in a row
    // guard against calling a half-registered set of checks finished.
    const snapshot = JSON.stringify([...watched].map(([name, check]) => [name, check.bucket]).sort());
    const stable = snapshot === this.prevSnapshot;
    this.prevSnapshot = snapshot;
    return { watched, failLines, allDone, stable, green: allDone && stable && failLines.length === 0, requiredGreen: [...required].filter(name => bucketClass(bucketOf(name)) === 'pass').length };
  }

  /** People talking. Edits are never events. Returns the unresolved threads' first-comment URLs. */
  private emitConversation(pr: PullRequest, mine: Set<string>): string[] {
    for (const c of pr.comments) {
      const { login, bot } = c.author;
      if (mine.has(login) || this.botOf(login, true) || (bot && STATUS_BOTS.some(b => login.includes(b)))) continue;
      this.emit(`c:${c.id}`, `comment from ${login}: ${snippet(c.body)} ${c.url}`);
    }
    for (const r of pr.reviews) {
      if (mine.has(r.author.login) || r.author.bot) continue;
      if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.body.trim()) {
        this.emit(`c:${r.id}`, `review from ${r.author.login} (${r.state.toLowerCase().replace(/_/g, ' ')}): ${snippet(r.body)} ${r.url}`);
      }
    }
    const unresolved: string[] = [];
    for (const thread of pr.threads) {
      if (!thread.isResolved && thread.comments.length > 0) unresolved.push(thread.comments[0].url);
      const where = thread.line ? `${thread.path}:${thread.line}` : thread.path;
      thread.comments.forEach((c, index) => {
        if (mine.has(c.author.login)) return;
        this.emit(`c:${c.id}`, `${index === 0 ? 'new thread' : 'thread reply'} from ${c.author.login} on ${where}: ${snippet(c.body)} ${c.url}`);
      });
    }
    return unresolved;
  }

  /**
   * Review bots on the current head. A gating bot with checks is done when they
   * pass (an advisory one when they finish); otherwise once it reviewed the head
   * commit or its summary names it.
   */
  private emitBots(pr: PullRequest, checks: Map<string, Check>, head: string): { status: string[]; reviewed: string[] } {
    const short = head.slice(0, 7);
    const status: string[] = [];
    const reviewed: string[] = [];
    for (const bot of [...this.bots.gating, ...this.bots.advisory]) {
      const advisory = this.bots.advisory.includes(bot);
      const ownChecks = [...checks.values()].filter(c => this.botOf(c.name) === bot);
      const summaries = pr.comments.filter(c => this.botOf(c.author.login, true) === bot);
      const ownReviews = pr.reviews.filter(r => this.botOf(r.author.login, true) === bot);
      const onHead = ownReviews.some(r => r.commitOid === head);
      // A bot that reports through checks is done when they pass; a failed gating check is a failed check, never a review.
      const done = ownChecks.length > 0
        ? ownChecks.every(c => bucketClass(c.bucket) === 'pass' || (advisory && bucketClass(c.bucket) !== 'pending'))
        : onHead || summaries.some(s => s.body.includes(short));
      const seen = ownChecks.length > 0 || summaries.length > 0 || ownReviews.length > 0;
      if (advisory && ownChecks.length > 0) status.push(`${bot} ${ownChecks[0].description || ownChecks[0].bucket} (advisory)`);
      else if (seen) status.push(`${bot} ${done ? 'done' : 'pending'}${advisory ? ' (advisory)' : ''}`);
      const key = `bot:${bot}:${head}`;
      const wasDone = this.reported.has(key);
      if (done) {
        if (!advisory) reviewed.push(bot);
        const failed = ownChecks.filter(c => bucketClass(c.bucket) === 'fail').map(c => c.name);
        const detail = [summaries.map(s => verdictLine(s.body)).find(Boolean) ?? '', failed.length ? `failed: ${failed.join(', ')}` : ''].filter(Boolean).join('; ');
        this.emit(key, `${bot} finished on ${short}${detail ? `: ${detail}` : ''}${advisory ? ' (advisory, not waited on)' : ''}`);
      }
      if (advisory) continue;
      for (const s of summaries) {
        const fresh = digest(s.body);
        const old = this.state.summaries[s.id];
        this.state.summaries[s.id] = fresh;
        if (wasDone && old && old !== fresh) this.emit(`summary:${s.id}:${fresh}`, `${bot} summary changed on ${short}: ${verdictLine(s.body) || snippet(s.body)} ${s.url}`);
      }
    }
    return { status, reviewed };
  }

  /** The base branch moving under the PR, and BEHIND / DIRTY merge states. */
  private emitBaseAndMerge(pr: PullRequest, head: string): void {
    const base = pr.baseRefName;
    const oldBase = this.state.base_oid;
    if (pr.baseOid && oldBase && pr.baseOid !== oldBase && !this.baseline) {
      const touched = this.baseOverlap(head, oldBase, pr.baseOid);
      if (touched.length > 0) this.emit(`base:${pr.baseOid}`, baseOverlapLine(base, pr.baseOid, touched));
    }
    if (pr.baseOid) this.state.base_oid = pr.baseOid;
    const mergeState = pr.mergeStateStatus;
    if (mergeState === 'UNKNOWN') return;
    // Keyed on the head alone, so each state is announced once per head: not once per transition, and
    // not again for every base commit while the branch stays behind.
    if (mergeState === 'BEHIND' || mergeState === 'DIRTY') {
      this.emit(`merge:${mergeState}:${head}`, mergeState === 'DIRTY' ? this.dirtyLine(base, head) : this.behindLine(base, head));
    }
    this.state.merge_state = mergeState;
  }

  private dirtyLine(base: string, head: string): string { return `merge state is DIRTY on ${head.slice(0, 7)}: the branch conflicts with ${base}, rebase it`; }
  private behindLine(base: string, head: string): string { return `merge state is BEHIND on ${head.slice(0, 7)}: update the branch from ${base} before merging`; }

  /** One poll. Returns an exit code when the watch ends, null to keep polling. Throws GhError. */
  poll(): number | null {
    const pr = fetchPullRequest(this.gh, this.repo, this.pr);
    if (pr.state === 'MERGED') return this.finish(PR_WAIT_EXIT.met, [`merged: ${pr.url}`]);
    if (pr.state === 'CLOSED') return this.finish(PR_WAIT_EXIT.blocked, [`closed without merging: ${pr.url}`]);
    const base = pr.baseRefName;
    if (this.required === null) {
      const read = requiredChecks(this.gh, this.repo, base);
      this.required = read.names;
      this.requiredKnown = read.known;
      const gate = [...this.required].sort().join(', ') || 'none set';
      this.log(`watching ${this.repo}#${this.pr} until ${this.until}; required checks: ${gate}; every check on the head gates`);
      if (this.excludes.length && !this.requiredKnown) {
        this.log(`exclude refused for ${this.excludes.join(', ')}: the required checks could not be read, so every check gates`);
      } else if (this.excludes.length) {
        const refused = this.excludes.filter(name => this.required!.has(name));
        const dropped = this.excludes.filter(name => !this.required!.has(name));
        if (dropped.length) this.log(`excluded from the verdict: ${dropped.join(', ')}`);
        if (refused.length) this.log(`exclude refused for required check${refused.length === 1 ? '' : 's'} ${refused.join(', ')}: a required check gates`);
      }
    }
    const checks = fetchChecks(this.gh, this.repo, this.pr);
    const head = pr.headRefOid;
    const short = head.slice(0, 7);
    this.events = 0;

    const ci = this.evaluateChecks(checks, head);
    const unresolved = this.emitConversation(pr, new Set([pr.author, pr.viewer]));
    const bots = this.emitBots(pr, checks, head);
    this.emitBaseAndMerge(pr, head);
    const mergeState = pr.mergeStateStatus;

    const counts = new Map<string, number>();
    for (const check of ci.watched.values()) counts.set(check.bucket, (counts.get(check.bucket) ?? 0) + 1);
    const failedNames = [...ci.watched.values()].filter(c => bucketClass(c.bucket) === 'fail').map(c => c.name).sort();
    const summary = [
      [...counts].sort().map(([bucket, n]) => `${n} ${bucket}`).join(', ') + (failedNames.length ? ` (${failedNames.join(', ')})` : ''),
      this.required.size > 0 ? `required ${ci.requiredGreen}/${this.required.size} green` : '',
      bots.status.join(', ') || `no ${this.bots.gating.join(' or ') || 'review bot'} yet`,
      `${unresolved.length} unresolved threads`,
      `merge state ${mergeState}`,
    ].filter(Boolean).join('; ');
    const checksKey = `checks:${head}`;

    // A green or ready line carries the same summary as the checks line, so it marks that event as reported.
    if (this.until !== 'any-change') {
      if (mergeState === 'DIRTY') return this.finish(PR_WAIT_EXIT.blocked, [this.dirtyLine(base, head)]);
      if (ci.failLines.length > 0) return this.finish(PR_WAIT_EXIT.blocked, ci.failLines);
      if (ci.green && this.until === 'green') {
        this.reported.add(checksKey);
        return this.finish(PR_WAIT_EXIT.met, [`green on ${short}: ${summary}${this.behindSuffix(base, pr.baseOid, head)}`]);
      }
      // ready waits for a gating bot, never for an advisory one; with no gating bot configured, green is the review.
      if (ci.green && (bots.reviewed.length > 0 || this.bots.gating.length === 0)) {
        if (unresolved.length > 0) return this.finish(PR_WAIT_EXIT.blocked, [`blocked by ${unresolved.length} unresolved threads on ${short}: ${unresolved.join(' ')}`]);
        if (mergeState === 'BEHIND') return this.finish(PR_WAIT_EXIT.blocked, [this.behindLine(base, head)]);
        // GitHub reports UNKNOWN while it recomputes mergeability after a push: not ready until it knows.
        if (mergeState === 'UNKNOWN') return null;
        this.reported.add(checksKey);
        return this.finish(PR_WAIT_EXIT.met, [`ready on ${short}: ${summary}${this.behindSuffix(base, pr.baseOid, head)}`]);
      }
    }
    if (ci.allDone && (ci.stable || this.baseline)) this.emit(checksKey, `checks finished on ${short}: ${summary}`);
    if (this.until === 'any-change' && this.events > 0) return this.finish(PR_WAIT_EXIT.met);
    return null;
  }

  /** Poll until the watch ends; returns the exit code. */
  run(): number {
    let failures = 0;
    const deadline = this.timeoutMinutes > 0 ? this.env.now() + this.timeoutMinutes * 60_000 : Infinity;
    for (;;) {
      try {
        const code = this.poll();
        if (code !== null) return code;
        failures = 0;
        this.save();
        if (this.baseline) this.log(`baseline recorded for ${this.repo}#${this.pr}; reporting only new events`);
        this.baseline = false;
        if (this.env.now() >= deadline) {
          const still = this.pending.length > 0 ? `still pending: ${this.pending.join(', ')}` : 'nothing pending, the condition was not met';
          return this.finish(PR_WAIT_EXIT.blocked, [`gstack-pr-wait stopped: no ${this.until} after ${this.timeoutMinutes} minutes; ${still}`]);
        }
      } catch (error) {
        if (!(error instanceof GhError)) throw error;
        if (!error.transient) return this.finish(PR_WAIT_EXIT.blocked, [`gstack-pr-wait stopped: ${error.message}`]);
        failures += 1;
        this.log(`poll failed (${failures}/${MAX_FAILED_POLLS}): ${error.message}`);
        if (failures >= MAX_FAILED_POLLS) return this.finish(PR_WAIT_EXIT.blocked, [`gstack-pr-wait stopped: GitHub unreachable for ${failures} polls: ${error.message}`]);
      }
      this.env.sleep(this.interval * 1000);
    }
  }
}

function refuse(env: PrWaitEnv, message: string): number {
  // Fatal lines go to stdout so a monitor shows the agent why the watcher stopped.
  env.out(`${resultLineWithDocs('gstack-pr-wait', 'PR_WAIT_REFUSED', message)}\n`);
  return PR_WAIT_EXIT.refused;
}

/** Resolve the target to a repository and PR number the current gh login can read. */
export function resolveTarget(env: PrWaitEnv, opts: PrWaitOptions): { repo: string; pr: number } | { error: string } {
  const target = parsePrTarget(opts.target, opts.repo);
  if ('error' in target) return target;
  const gh: GhEnv = { gh: env.gh, sleep: ms => env.sleep(ms), log: m => env.err(`gstack-pr-wait: ${m}\n`) };
  let repo = target.repo;
  if (!repo) {
    try { repo = currentRepo(gh); } catch (error) {
      return { error: `no --repo given and the current directory has no GitHub repo (${error instanceof Error ? error.message : String(error)})` };
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: `'${repo}' is not owner/name` };
  }
  try { confirmPullRequest(gh, repo, target.pr); } catch (error) {
    // A transient failure is retried by the poll loop.
    if (!(error instanceof GhError) || !error.transient) return { error: `cannot read ${repo}#${target.pr}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { repo, pr: target.pr };
}

export function prWaitMain(argv: string[], env: PrWaitEnv): number {
  const parsed = parsePrWaitArgs(argv);
  if ('help' in parsed) {
    env.out(`${PR_WAIT_USAGE}\n`);
    return PR_WAIT_EXIT.met;
  }
  if ('error' in parsed) return refuse(env, parsed.error);
  const target = resolveTarget(env, parsed);
  if ('error' in target) return refuse(env, target.error);
  const watcher = new Watcher(env, target.repo, target.pr, parsed.until, parsed.interval, botLists(env.vars), parsed.timeout, parsed.excludes);
  // Exit 1 always carries a PR_WAIT_BLOCKED line, so a local fault (an unwritable state root, a full disk) is a refusal, never a verdict.
  try {
    const lock = watcher.lock();
    if (lock) {
      return refuse(env, `pid ${lock.held} already watches ${target.repo}#${target.pr}, so this watcher exits to avoid duplicate events. If no events reach you from it, run \`kill ${lock.held}\` and start again`);
    }
    return watcher.run();
  } catch (error) {
    return refuse(env, `a local error stopped the watch before a verdict: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    watcher.unlock();
  }
}
