/**
 * The main backstop (evals-main-backstop.yml; plan GSTA-49 lane T1b): every
 * push to main is covered by a full gate, and a train's merges are covered by
 * the gate the train already ran, so a train costs no second gate.
 *
 *   1. Inert unless main's .gstack/ship-policy.json declares a `train` block.
 *   2. Debounce: wait until no train is merging (refs/notes/gstack-trains
 *      holds no train in state `merging`), up to the settle window; a newer
 *      push to main supersedes this run.
 *   3. Compute main's tree modulo stamps (scripts/train-gate.ts stampFreeTree)
 *      and look for a green-train record that lists it among its prefix trees
 *      T1..Tk: a successful train dispatch of the gate workflow whose record
 *      artifact is GREEN with a complete census and whose `full_gate_check`
 *      check run on the train head succeeded.
 *   4. Otherwise dispatch the full gate on main (eval-bg's backstop nonce),
 *      wait for it, and on anything but success write the freeze record
 *      gstack-ship-queue reads (red cases, their declared inputs, the run, an
 *      issue) to refs/notes/gstack-trains, unless a freeze is already active.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPolicyFromHead, type TrainPolicy } from '../lib/ship-policy';
import { NOTES_REF, fetchNotes, nowIso, persist, repoIdentity, type FreezeRecord } from '../lib/ship-queue-train-record';
import { E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from '../test/helpers/touchfiles-data';
import { DISPATCH_INPUTS, makeNonce, nonceScope } from './eval-bg';
import { ghFailureReason, runGh, type GhRunner } from './recover-receipts';
import { gitIn, stampFreeTree, type Git, type TrainRecord } from './train-gate';

const SHA = /^[0-9a-f]{40}$/;
const GH_MS = 60_000;

export type BackstopAction = 'inert' | 'superseded' | 'covered' | 'deferred' | 'gated' | 'frozen' | 'failed';
export interface BackstopOptions {
  repo: string; branch: string; sha: string; repoRoot: string;
  gh?: GhRunner; git?: Git; now?: () => number; sleep?: (ms: number) => void;
  settleMs?: number; pollMs?: number; gateDeadlineMs?: number; random?: string;
}
interface Run { id: number; status: string; conclusion: string | null; head_sha: string; display_title?: string; html_url?: string }

function json<T>(r: { status: number | null; stdout: string }): T | null {
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout) as T; } catch { return null; }
}

/** Notes records of one kind for this repository (the local notes ref, after a fetch). */
function noteRecords<T extends { kind: string; repo_key?: string }>(git: Git, kind: string, repoKey: string): T[] {
  const listed = git(['notes', `--ref=${NOTES_REF}`, 'list']);
  if (!listed.ok || !listed.out.trim()) return [];
  return listed.out.split('\n').map(line => line.split(' ')[0]!).filter(Boolean).flatMap(blob => {
    try { const r = JSON.parse(git(['cat-file', 'blob', blob]).out) as T; return r?.kind === kind && r.repo_key === repoKey ? [r] : []; } catch { return []; }
  });
}

/**
 * The newest green-train record with a prefix covering main, with its run; null when none. A plain prefix T_i
 * covers main's tree modulo stamps (its digest); a stamped prefix S_i covers only main's exact tree.
 */
export function coveringRecord(gh: GhRunner, repo: string, train: TrainPolicy, main: { digest: string | null; tree: string }, lines: string[]): { run: Run; record: TrainRecord; index: number; exact: boolean } | null {
  const runs = json<{ workflow_runs?: Run[] }>(gh(['api', '-X', 'GET', `repos/${repo}/actions/workflows/${train.gate_workflow}/runs`, '-f', 'event=workflow_dispatch', '-f', 'status=success', '-f', 'per_page=50'], GH_MS));
  if (!runs) { lines.push('cannot list the train gate runs; the backstop gates main'); return null; }
  const trains = (runs.workflow_runs ?? []).map(run => ({ run, nonce: /\[eval-bg ([A-Za-z0-9._-]+)\]/.exec(run.display_title ?? '')?.[1] ?? '' }))
    .filter(t => t.run.conclusion === 'success' && nonceScope(t.nonce)?.purpose === 'train').sort((a, b) => b.run.id - a.run.id).slice(0, 20);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'train-backstop-'));
  try {
    for (const { run, nonce } of trains) {
      const dir = path.join(scratch, String(run.id));
      if (gh(['run', 'download', String(run.id), '-R', repo, '-n', train.record_artifact, '-D', dir], GH_MS).status !== 0) continue;
      const file = fs.existsSync(dir) ? fs.readdirSync(dir).find(name => name.endsWith('.json')) : undefined;
      let record: TrainRecord | null = null;
      try { record = file ? JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as TrainRecord : null; } catch { record = null; }
      if (!record || record.kind !== 'train-gate' || record.verdict !== 'GREEN' || record.census?.complete !== true || record.nonce !== nonce
        || record.head_sha !== run.head_sha || !Array.isArray(record.prefixes)) continue;
      const hit = record.prefixes.find(p => p.exact ? p.tree === main.tree : main.digest !== null && p.stamp_free_tree === main.digest);
      if (!hit) continue;
      const checks = json<{ check_runs?: Array<{ name?: string; conclusion?: string | null }> }>(
        gh(['api', `repos/${repo}/commits/${run.head_sha}/check-runs?check_name=${encodeURIComponent(train.full_gate_check)}`], GH_MS));
      if (!checks?.check_runs?.some(c => c.name === train.full_gate_check && c.conclusion === 'success')) {
        lines.push(`train ${nonce} (run ${run.id}) lists this tree but its ${train.full_gate_check} check run is not a success`);
        continue;
      }
      return { run, record, index: hit.index, exact: !!hit.exact };
    }
    return null;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Red cases of a finished gate run, from its trial outcomes (first attempt), with their declared inputs. */
function redCases(gh: GhRunner, repo: string, run: Run): Array<{ id: string; inputs: string[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'train-backstop-red-'));
  try {
    if (gh(['run', 'download', String(run.id), '-R', repo, '-n', 'trial-outcomes-pr-a1', '-D', dir], GH_MS).status !== 0) return [];
    const text = fs.existsSync(path.join(dir, 'trial-outcomes.jsonl')) ? fs.readFileSync(path.join(dir, 'trial-outcomes.jsonl'), 'utf8') : '';
    const ids = new Set<string>();
    for (const line of text.split('\n').filter(Boolean)) {
      try { const r = JSON.parse(line) as { case?: string; outcome?: string; attempt?: number }; if (r.outcome === 'failed' && (r.attempt ?? 1) === 1 && r.case) ids.add(r.case); } catch { /* skip */ }
    }
    return [...ids].sort().map(id => ({ id, inputs: E2E_TOUCHFILES[id] ?? LLM_JUDGE_TOUCHFILES[id] ?? [] }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Dispatch the full gate on main, find its run by nonce, and follow it to its conclusion. */
function gateMain(o: Required<Pick<BackstopOptions, 'repo' | 'branch' | 'sha'>> & { gh: GhRunner; train: TrainPolicy; now: () => number; sleep: (ms: number) => void; pollMs: number; deadline: number; nonce: string },
  lines: string[]): Run | null {
  const inputs = { [DISPATCH_INPUTS.evalsAll]: 'true', [DISPATCH_INPUTS.expectedSha]: o.sha, [DISPATCH_INPUTS.nonce]: o.nonce };
  const sent = o.gh(['workflow', 'run', o.train.gate_workflow, '--repo', o.repo, '--ref', o.branch, ...Object.entries(inputs).flatMap(([k, v]) => ['-f', `${k}=${v}`])], GH_MS);
  if (sent.status !== 0) { lines.push(`the gate dispatch failed (${ghFailureReason(sent.stderr)})`); return null; }
  lines.push(`BACKSTOP: dispatched ${o.train.gate_workflow} on ${o.branch}@${o.sha.slice(0, 12)} (nonce ${o.nonce})`);
  let run: Run | null = null;
  while (o.now() < o.deadline) {
    if (!run) {
      const runs = json<{ workflow_runs?: Run[] }>(o.gh(['api', '-X', 'GET', `repos/${o.repo}/actions/workflows/${o.train.gate_workflow}/runs`, '-f', 'event=workflow_dispatch', '-f', 'per_page=30'], GH_MS));
      run = runs?.workflow_runs?.find(r => (r.display_title ?? '').includes(`eval-bg ${o.nonce}]`)) ?? null;
      if (run) lines.push(`BACKSTOP: gate run ${run.id} ${run.html_url ?? ''}`.trim());
    } else {
      run = json<Run>(o.gh(['api', `repos/${o.repo}/actions/runs/${run.id}`], GH_MS)) ?? run;
      if (run.status === 'completed') return run;
    }
    o.sleep(o.pollMs);
  }
  lines.push(`the gate ${run ? `run ${run.id}` : 'dispatch'} did not finish before the backstop deadline`);
  return run;
}

export function runBackstop(o: BackstopOptions): { action: BackstopAction; lines: string[] } {
  const gh = o.gh ?? runGh;
  const git = o.git ?? gitIn(o.repoRoot);
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const pollMs = o.pollMs ?? 60_000;
  const lines: string[] = [];
  const done = (action: BackstopAction) => ({ action, lines });
  const loaded = loadPolicyFromHead(o.repoRoot);
  const train = loaded.policy.train;
  if (!train) { lines.push(`BACKSTOP: inert (${loaded.source.label} declares no train block; per-PR gates cover main)`); return done('inert'); }
  if (!SHA.test(o.sha)) { lines.push(`BACKSTOP: ${o.sha} is not a commit SHA`); return done('failed'); }
  const repoKey = repoIdentity(o.repoRoot).key;
  const settleUntil = now() + (o.settleMs ?? 60 * 60_000);
  for (;;) {
    const fetched = fetchNotes(o.repoRoot);
    const merging = noteRecords<{ kind: string; repo_key: string; nonce: string; state: string }>(git, 'train', repoKey).filter(t => t.state === 'merging');
    const tip = git(['ls-remote', 'origin', `refs/heads/${o.branch}`]).out.split(/\s/)[0];
    if (tip && tip !== o.sha) { lines.push(`BACKSTOP: superseded (${o.branch} moved to ${tip.slice(0, 12)}; that push's run gates it)`); return done('superseded'); }
    if (!merging.length) break;
    if (now() >= settleUntil) { lines.push(`BACKSTOP: train(s) ${merging.map(t => t.nonce).join(', ')} still merging after the settle window; gating anyway`); break; }
    lines.push(`BACKSTOP: waiting for train(s) ${merging.map(t => t.nonce).join(', ')} to finish merging${fetched.ok ? '' : ` (${fetched.detail})`}`);
    sleep(pollMs);
  }
  const digest = stampFreeTree(git, o.sha, o.repoRoot, loaded.policy);
  if (typeof digest !== 'string') { lines.push(`BACKSTOP: no tree modulo stamps (${digest.error}); gating main`); }
  const tree = git(['rev-parse', `${o.sha}^{tree}`]).out;
  const covered = coveringRecord(gh, o.repo, train, { digest: typeof digest === 'string' ? digest : null, tree }, lines);
  if (covered) {
    lines.push(`BACKSTOP: covered: main ${o.sha.slice(0, 12)} is ${covered.exact ? `S${covered.index}` : `T${covered.index}`} of green train ${covered.record.nonce} (run ${covered.run.id}, ${covered.exact ? `exact tree ${tree.slice(0, 12)}` : `tree modulo stamps ${String(digest).slice(0, 12)}`}); no gate`);
    return done('covered');
  }
  const owned = noteRecords<FreezeRecord>(git, 'freeze', repoKey).find(f => !f.cleared_at && f.main.sha === o.sha && f.backstop);
  if (owned?.backstop) {
    lines.push(`BACKSTOP: deferred: train ${owned.train} froze the queue on this commit and dispatched backstop run ${owned.backstop.run ?? 'unknown'} (nonce ${owned.backstop.nonce}); no second gate`);
    return done('deferred');
  }
  lines.push(`BACKSTOP: no green-train record lists main's tree modulo stamps${typeof digest === 'string' ? ` ${digest.slice(0, 12)}` : ''}; gating main`);
  const nonce = makeNonce('gate', o.sha, o.sha, o.random ?? randomBytes(3).toString('hex'), { purpose: 'backstop' });
  const run = gateMain({ repo: o.repo, branch: o.branch, sha: o.sha, gh, train, now, sleep, pollMs, deadline: now() + (o.gateDeadlineMs ?? 270 * 60_000), nonce }, lines);
  if (run?.status === 'completed' && run.conclusion === 'success') { lines.push(`BACKSTOP: gated: run ${run.id} is green on main ${o.sha.slice(0, 12)}`); return done('gated'); }
  return freeze(o, { gh, git, repoKey, nonce, run }, lines);
}

/** Write the freeze record (local state, then refs/notes/gstack-trains) unless a freeze is already active. */
function freeze(o: BackstopOptions, c: { gh: GhRunner; git: Git; repoKey: string; nonce: string; run: Run | null }, lines: string[]): { action: BackstopAction; lines: string[] } {
  const active = noteRecords<FreezeRecord>(c.git, 'freeze', c.repoKey).find(f => !f.cleared_at);
  if (active) { lines.push(`BACKSTOP: red, and the queue is already frozen (${active.reason}); the existing freeze stands`); return { action: 'frozen', lines }; }
  const red = c.run?.status === 'completed' ? redCases(c.gh, o.repo, c.run) : [];
  const runText = c.run ? `run ${c.run.id} (${c.run.status}/${c.run.conclusion ?? '-'})` : 'no run';
  const cases = red.length ? red.map(r => `${r.id} (inputs ${r.inputs.slice(0, 4).join(', ') || 'none declared'})`).join('; ') : 'no red case recorded';
  const body = [`The main backstop gate is not green on ${o.sha}: ${runText}.`, '', `Red cases: ${cases}.`, '', 'gstack-ship-queue refuses ordinary trains until a repair train merges (docs/ship-policy.md#run-a-merge-train). Land the revert or fix-forward.'].join('\n');
  const issue = c.gh(['issue', 'create', '-R', o.repo, '--title', `Main backstop red on ${o.sha.slice(0, 12)}`, '--body', body], GH_MS);
  const issueUrl = issue.status === 0 ? issue.stdout.trim().split('\n').at(-1) ?? null : null;
  const at = nowIso();
  const record: FreezeRecord & { red_cases: typeof red; run_url: string | null; issue: string | null } = {
    schema: 1, kind: 'freeze', repo_key: c.repoKey, train: 'backstop', merged: [], unmerged: [],
    main: { sha: o.sha, tree: c.git(['rev-parse', `${o.sha}^{tree}`]).out },
    reason: `backstop red on main ${o.sha.slice(0, 12)}: ${cases}; ${runText}; fix: land the revert or fix-forward${issueUrl ? ` (${issueUrl})` : ''}`,
    backstop: { nonce: c.nonce, run: c.run?.id ?? null, state: c.run ? `${c.run.status}/${c.run.conclusion ?? '-'}` : 'unconfirmed' },
    repair: null, created_at: at, cleared_at: null, cleared_by: null, updated_at: at,
    red_cases: red, run_url: c.run?.html_url ?? null, issue: issueUrl,
  };
  const pushed = persist(o.repoRoot, [record]);
  lines.push(`BACKSTOP: frozen: ${record.reason}`, `BACKSTOP: freeze record ${pushed.detail}`);
  return { action: pushed.pushed ? 'frozen' : 'failed', lines };
}

const USAGE = `usage: bun run scripts/train-backstop.ts run --repo <owner/name> --branch <main> --sha <sha>
    [--settle-minutes 60] [--poll-seconds 60] [--gate-deadline-minutes 270] [--summary <file>] [--outputs <file>]
Exit 0 when inert, superseded, covered, deferred to a freeze's own backstop, or gated green; 1 when it froze the queue or could not finish.
--outputs appends action=<action> (the workflow reads it as a step output and publishes the main-backstop check run from it).`;

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const minutes = (name: string, fallback: number) => Number(flag(name) ?? fallback) * 60_000;
  const [repo, branch, sha] = [flag('repo'), flag('branch'), flag('sha')];
  if (command !== 'run' || !repo || !branch || !sha) { console.error(USAGE); process.exit(2); }
  const { action, lines } = runBackstop({ repo: repo!, branch: branch!, sha: sha!, repoRoot: process.cwd(), settleMs: minutes('settle-minutes', 60),
    pollMs: Number(flag('poll-seconds') ?? 60) * 1000, gateDeadlineMs: minutes('gate-deadline-minutes', 270) });
  const summary = flag('summary');
  for (const line of lines) {
    console.log(line);
    if (summary) fs.appendFileSync(summary, `- ${line}\n`);
  }
  const outputs = flag('outputs');
  if (outputs) fs.appendFileSync(outputs, `action=${action}\n`);
  process.exit(action === 'frozen' || action === 'failed' ? 1 : 0);
}
