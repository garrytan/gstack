#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * ci-tree-reuse — run each free suite once per tree (GSTA-156, docs/pregate.md#ci-reuse).
 *
 *   bun run scripts/ci-tree-reuse.ts record --plan <plan.json> --results <dir> --os <OS>[,<OS>…] --out <tree.json>
 *       The producer. A Free Tests or Windows Free Tests aggregate runs it only after its strict verification
 *       passed, and uploads the file as the `tested-tree` artifact: run_id, run_attempt, event, sha (GITHUB_SHA),
 *       head_sha (the pull request head for pull_request, else GITHUB_SHA), tree (git's tree of GITHUB_SHA),
 *       workflow, os (the OSes the run's test jobs ran on), files (every test file in the plan) and tests.
 *
 *   bun run scripts/ci-tree-reuse.ts find --workflow <file.yml> --profile <run_profiles name>
 *       The main-push consumer (the `reuse` job). A push to main whose tree a pull request already tested green
 *       needs no second run: it finds the pull request whose merge commit is the pushed commit (same-repository
 *       head, merged into main), requires that head's tree to equal the pushed tree, lists that head's runs of
 *       this workflow (pull_request or workflow_dispatch, newest first, at most MAX_CANDIDATES), and accepts the
 *       first one lib/run-evidence.ts verifyRun accepts under the profile in the pushed tree's
 *       .gstack/pregate.json. A pull_request run counts only when its merge commit's tree is its head's tree
 *       (verifyRun). It writes reused=true, run_id, run_url and tree to GITHUB_OUTPUT, or reused=false and a
 *       reason, with one REUSE: line in the step summary. Every lookup failure is a refusal, never a pass: the
 *       workflow then runs every job as before. Pull request and dispatch runs never consume.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ghApiJson, ghRunDeps, runProfileErrors, verifyRun, type ApiRun, type RunDeps, type RunProfile } from '../lib/run-evidence';

export const MAX_PULLS = 10;
export const MAX_CANDIDATES = 10;
const SHA = /^[0-9a-f]{40}$/;
const OSES = ['Linux', 'macOS', 'Windows'];

export interface ApiPull { number: number; merged_at: string | null; merge_commit_sha: string | null; base: { ref: string; repo?: { full_name: string } | null }; head: { sha: string; repo: { full_name: string } | null } }
export interface ReuseDeps extends RunDeps { pullsForCommit(sha: string): ApiPull[] }
export type ReuseVerdict =
  | { reused: true; run_id: number; run_attempt: number; event: string; pr: number; head_sha: string; tree: string }
  | { reused: false; reason: string; detail: string };

const refuse = (reason: string, detail: string): ReuseVerdict => ({ reused: false, reason, detail });
const startedAt = (r: ApiRun) => r.run_started_at ?? r.created_at ?? '';

/** The run a push of `pushSha` to `base` may reuse, or why none. Pure over `deps`, so every refusal has a fixture. */
export function findReuse(deps: ReuseDeps, o: { repo: string; base: string; pushSha: string; workflow: string; profileName: string; profile: RunProfile; now: Date }): ReuseVerdict {
  if (!SHA.test(o.pushSha)) return refuse('usage', `${JSON.stringify(o.pushSha)} is not a commit sha`);
  if (o.profile.workflow !== o.workflow) return refuse('profile_mismatch', `profile ${o.profileName} names ${o.profile.workflow}, not ${o.workflow}`);
  try {
    const pulls = deps.pullsForCommit(o.pushSha).slice(0, MAX_PULLS);
    const merged = pulls.filter(p => p.merged_at && p.base.ref === o.base && p.merge_commit_sha === o.pushSha && (!p.base.repo || p.base.repo.full_name.toLowerCase() === o.repo.toLowerCase()));
    if (!merged.length) return refuse('no_pr', `no pull request merged into ${o.base} has ${o.pushSha.slice(0, 12)} as its merge commit (${pulls.length} associated)`);
    if (merged.length > 1) return refuse('ambiguous_pr', `${merged.length} merged pull requests name ${o.pushSha.slice(0, 12)}: ${merged.map(p => `#${p.number}`).join(', ')}`);
    const pr = merged[0]!;
    if ((pr.head.repo?.full_name ?? '').toLowerCase() !== o.repo.toLowerCase()) return refuse('fork_head', `#${pr.number}'s head is on ${pr.head.repo?.full_name ?? 'a deleted repository'}, not ${o.repo}`);
    if (!SHA.test(pr.head.sha)) return refuse('api_error', `#${pr.number} has no head commit`);
    const pushTree = deps.commitTree(o.pushSha);
    const headTree = deps.commitTree(pr.head.sha);
    if (!pushTree || !headTree) return refuse('api_error', `cannot read the tree of ${pushTree ? pr.head.sha : o.pushSha}`);
    if (headTree !== pushTree) return refuse('tree_mismatch', `#${pr.number}'s head ${pr.head.sha.slice(0, 12)} has tree ${headTree.slice(0, 12)}, the push has ${pushTree.slice(0, 12)}`);
    const events: string[] = o.profile.events.filter(e => e === 'pull_request' || e === 'workflow_dispatch');
    const candidates = deps.runsForHead(o.workflow, pr.head.sha).filter(r => events.includes(r.event))
      .sort((a, b) => startedAt(b).localeCompare(startedAt(a)) || b.id - a.id).slice(0, MAX_CANDIDATES);
    if (!candidates.length) return refuse('no_candidate', `#${pr.number}'s head ${pr.head.sha.slice(0, 12)} has no ${events.join(' or ') || 'pull_request or workflow_dispatch'} run of ${o.workflow}`);
    const refusals: string[] = [];
    for (const run of candidates) {
      const v = verifyRun(deps, { repo: o.repo, runRef: String(run.id), profileName: o.profileName, profile: o.profile, now: o.now });
      if (!v.ok) { refusals.push(`run ${run.id} (${run.event}) reason=${v.reason} ${v.detail}`); continue; }
      if (v.evidence.tree !== pushTree) { refusals.push(`run ${run.id} tested tree ${v.evidence.tree.slice(0, 12)}`); continue; }
      return { reused: true, run_id: v.evidence.run_id, run_attempt: v.evidence.run_attempt, event: v.evidence.event, pr: pr.number, head_sha: pr.head.sha, tree: pushTree };
    }
    return refuse('no_verified_run', refusals.join(' | '));
  } catch (e: any) {
    return refuse('api_error', String(e?.message ?? e).slice(0, 300));
  }
}

/** tree.json for the `tested-tree` artifact; throws on any missing or malformed input, so a broken record fails the aggregate instead of uploading. */
export function treeRecord(env: NodeJS.ProcessEnv, o: { plan: { shards: Array<{ files: string[] }> }; results: Array<{ outcome?: { summary?: { testsRan?: number } } }>; os: string[]; tree: string }) {
  const int = (name: string) => { const v = Number(env[name]); if (!Number.isSafeInteger(v) || v < 1) throw new Error(`${name} is not a positive integer`); return v; };
  const sha = env.GITHUB_SHA ?? '';
  const event = env.GITHUB_EVENT_NAME ?? '';
  const head = event === 'pull_request' ? env.PR_HEAD_SHA ?? '' : sha;
  if (!SHA.test(sha) || !SHA.test(head)) throw new Error(`GITHUB_SHA ${JSON.stringify(sha)} or the head ${JSON.stringify(head)} is not a commit sha (PR_HEAD_SHA is required for pull_request)`);
  if (!/^[a-z_]+$/.test(event)) throw new Error(`GITHUB_EVENT_NAME ${JSON.stringify(event)} is not an event name`);
  const workflow = /^[^/]+\/[^/]+\/(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)@/.exec(env.GITHUB_WORKFLOW_REF ?? '')?.[1];
  if (!workflow) throw new Error(`GITHUB_WORKFLOW_REF ${JSON.stringify(env.GITHUB_WORKFLOW_REF)} names no workflow file`);
  if (!/^[0-9a-f]{40,64}$/.test(o.tree)) throw new Error(`${JSON.stringify(o.tree)} is not a tree id`);
  if (!o.os.length || o.os.some(x => !OSES.includes(x))) throw new Error(`--os must list some of ${OSES.join(', ')}`);
  const files = [...new Set(o.plan.shards.flatMap(s => s.files))].sort();
  if (!files.length) throw new Error('the plan lists no test files');
  const counts = o.results.map(r => r.outcome?.summary?.testsRan);
  const tests = o.results.length && counts.every(n => Number.isSafeInteger(n) && n! >= 0) ? counts.reduce((a, b) => a! + b!, 0)! : files.length;
  return { run_id: int('GITHUB_RUN_ID'), run_attempt: int('GITHUB_RUN_ATTEMPT'), event, sha, head_sha: head, tree: o.tree, workflow, os: o.os, files, tests };
}

function flag(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function need(args: string[], name: string): string { const v = flag(args, name); if (!v || v.startsWith('--')) throw new Error(`${name} <value> is required`); return v; }

function record(args: string[]): number {
  const plan = JSON.parse(fs.readFileSync(need(args, '--plan'), 'utf8'));
  const dir = need(args, '--results');
  const results = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const git = spawnSync('git', ['rev-parse', '--verify', `${process.env.GITHUB_SHA ?? ''}^{tree}`], { encoding: 'utf8', timeout: 30_000 });
  const rec = treeRecord(process.env, { plan, results, os: need(args, '--os').split(','), tree: git.status === 0 ? git.stdout.trim() : '' });
  const out = need(args, '--out');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rec, null, 2) + '\n');
  console.log(`TESTED_TREE: run ${rec.run_id}/${rec.run_attempt} ${rec.event} head ${rec.head_sha.slice(0, 12)} tree ${rec.tree.slice(0, 12)} files=${rec.files.length} tests=${rec.tests} os=${rec.os.join(',')}`);
  return 0;
}

/** The consumer's GITHUB_OUTPUT and step-summary text for a verdict. reused=true is written last, after the run it names. */
export function reuseOutputs(v: ReuseVerdict, repo: string, server = 'https://github.com'): { line: string; output: string } {
  if (!v.reused) return { line: `REUSE: refused reason=${v.reason} — ${v.detail}; every job runs`, output: `reused=false\nreason=${v.reason}\n` };
  const url = `${server}/${repo}/actions/runs/${v.run_id}`;
  return { line: `REUSE: accepted run ${v.run_id} (${v.event}, attempt ${v.run_attempt}) of #${v.pr} at ${v.head_sha.slice(0, 12)}, tree ${v.tree.slice(0, 12)}: ${url}`, output: `run_id=${v.run_id}\nrun_url=${url}\ntree=${v.tree}\nreused=true\n` };
}

function find(args: string[]): number {
  const env = process.env;
  const workflow = need(args, '--workflow');
  const profileName = need(args, '--profile');
  const repo = env.GITHUB_REPOSITORY ?? '';
  const settle = (v: ReuseVerdict) => {
    const { line, output } = reuseOutputs(v, repo, env.GITHUB_SERVER_URL);
    console.log(line);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, output);
    return 0;
  };
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') return settle(refuse('not_main_push', `${env.GITHUB_EVENT_NAME ?? 'no'} event on ${env.GITHUB_REF ?? 'no ref'}; only a push to main consumes`));
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return settle(refuse('usage', `GITHUB_REPOSITORY ${JSON.stringify(repo)} is not owner/name`));
  let profiles: Record<string, RunProfile>;
  try {
    const config = JSON.parse(fs.readFileSync('.gstack/pregate.json', 'utf8'));
    const errors = runProfileErrors(config.run_profiles, undefined);
    if (errors.length) return settle(refuse('profile_invalid', errors.map(e => `${e.path}: ${e.message}`).join('; ')));
    profiles = config.run_profiles ?? {};
  } catch (e: any) { return settle(refuse('profile_invalid', `.gstack/pregate.json: ${String(e?.message ?? e).slice(0, 200)}`)); }
  const profile = profiles[profileName];
  if (!profile) return settle(refuse('profile_invalid', `.gstack/pregate.json declares no run profile ${profileName}`));
  const deps: ReuseDeps = {
    ...ghRunDeps(repo, process.cwd()),
    commitTree: sha => (SHA.test(sha) ? ghApiJson<{ tree?: { sha?: string } }>(`repos/${repo}/git/commits/${sha}`).tree?.sha ?? null : null),
    pullsForCommit: sha => ghApiJson<ApiPull[]>(`repos/${repo}/commits/${sha}/pulls?per_page=${MAX_PULLS}`),
  };
  return settle(findReuse(deps, { repo, base: 'main', pushSha: env.GITHUB_SHA ?? '', workflow, profileName, profile, now: new Date() }));
}

if (import.meta.main) {
  const [verb, ...args] = process.argv.slice(2);
  try {
    if (verb === 'record') process.exitCode = record(args);
    else if (verb === 'find') process.exitCode = find(args);
    else { console.error('usage: ci-tree-reuse.ts record --plan <f> --results <dir> --os <OS,…> --out <f> | find --workflow <f.yml> --profile <name>'); process.exitCode = 2; }
  } catch (e: any) {
    console.error(`ci-tree-reuse ${verb}: ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}
