/**
 * Generic train gates (docs/ship-policy.md#run-a-merge-train; plan GSTA-157 PR 2): a train whose base policy
 * declares `train.gates` gates every prefix T0..Tk (or T0 and S1..Sk when the train stamps) on its own
 * `train-prefix/<nonce>/t<i>` ref, with every gate in the list:
 *
 * - `workflows`: each workflow is dispatched on the prefix ref with a `nonce` input, recorded before it is sent,
 *   and only the workflow_dispatch run whose run-name carries `[eval-bg <nonce>]` is adopted, never a run found by
 *   sha. GREEN needs that run at exactly the prefix head, every required job (`<workflow>/<job name>`) concluded
 *   success, the run concluded success and, when the gate declares `record`, an artifact reporting at least one
 *   executed test. A red run gets one `gh run rerun --failed` (CREW rule 16): a pass is GREEN with FLAKY lines,
 *   a second red is real; both attempts' jobs are kept.
 * - `command`: a clean detached checkout of the prefix head runs on a Ubicloud VM through
 *   scripts/ubicloud/ubi-runner.sh, forwarding only `pass_env`; the VM's `git write-tree` must equal the prefix
 *   tree and exit 0 is GREEN. One spend cap covers every run of the train.
 *
 * The verdict is per prefix; the train is GREEN when every prefix is, and otherwise the first red prefix after a
 * green one names the culprit (classifyPrefixes). Slot 1's READY may declare FIXES_BASE_RED: T0 is then allowed
 * red on exactly those cases and nothing else.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { awaitNonceRun, listDispatchRuns, makeNonce, runForNonce } from '../scripts/eval-bg';
import { scriptInvocation } from './script-invocation';
import type { ShipReceipt } from './headless-artifacts';
import { extractReceipt, placeReceiptFirst } from './ship-receipt';
import { bindShippedReceipt } from './ship-receipt-depth';
import type { CommandGate, TrainGate, WorkflowsGate } from './ship-policy';
import { git, type QueueFailure } from './ship-queue-gate';
import { execFor, repoSlug } from './ship-queue-train-github';
import {
  attemptsOf, listTrains, loadTrain, nowIso, queueRoot, trainDir, trainFile,
  type AttemptRecord, type GateOutcome, type GatedPrefix, type GenericVerdict, type TrainPrefix, type TrainRecord, type TrainSlot,
} from './ship-queue-train-record';
import { effect, outFailed, outOk, outPending, outRefused, prsArgs, save, type TrainEnv, type TrainOut } from './ship-queue-train';

const Q = 'gstack-ship-queue';
const UBI_RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ubicloud', 'ubi-runner.sh');
/** Ubicloud list price per minute of the size command gates run on (scripts/ubicloud/pregate-remote.sh). */
export const COMMAND_SIZE = 'standard-16';
export const COMMAND_USD_PER_MIN = 0.00831;
/** Create, upload and teardown minutes reserved beside a command's own timeout. */
const COMMAND_OVERHEAD_MIN = 10;
const FAILED = ['failure', 'timed_out', 'startup_failure'];

/** One dispatch unit: a workflow of a workflows gate, or a command gate (workflow 'command'). */
export interface GateUnit { gate: number; workflow: string }
export const gateUnits = (gates: readonly TrainGate[]): GateUnit[] =>
  gates.flatMap((g, i) => (g.kind === 'workflows' ? g.workflows.map(workflow => ({ gate: i, workflow })) : [{ gate: i, workflow: 'command' }]));

/** The commits a generic train gates, with their refs: T0, then T1..Tk, or S1..Sk when the train stamps. */
export function gatedChain(nonce: string, prefixes: readonly TrainPrefix[], stamped?: ReadonlyArray<{ commit: string; tree: string }>): GatedPrefix[] {
  const chain = [prefixes[0]!, ...(stamped ?? prefixes.slice(1))];
  return chain.map((p, i) => ({ index: i, ref: `train-prefix/${nonce}/${stamped && i ? 's' : 't'}${i}`, commit: p.commit, tree: p.tree, outcome: null, red: [], detail: null }));
}

/**
 * bindShippedReceipt for a train slot. A conditional receipt (its base_red block) binds only for a slot whose READY
 * carried the condition (`ready --base-red --fixer`): the owner-exception and review-depth checks then run on the
 * receipt without that block, so the condition is the READY's to carry and every other check still applies.
 */
export function bindTrainReceipt(root: string, baseRef: string, body: string, pr: string, accepted: readonly string[], conditional: boolean): ReturnType<typeof bindShippedReceipt> {
  const b = bindShippedReceipt(root, baseRef, body, pr, accepted);
  if (b.ok || b.code !== 'QUEUE_RECEIPT_CONDITIONAL' || !conditional) return b;
  const { base_red: _, ...rest } = extractReceipt(body).receipt!;
  return bindShippedReceipt(root, baseRef, placeReceiptFirst(body, rest as ShipReceipt), pr, accepted);
}

/** Per-run price reservation of a command gate: its timeout plus overhead, at the list price. */
export const commandReservation = (g: CommandGate) => Math.ceil((g.timeout_sec / 60 + COMMAND_OVERHEAD_MIN) * COMMAND_USD_PER_MIN * 100) / 100;

/**
 * A conditional slot rides only a generic train whose slot 1 is its fixer, and a fixer (FIXES_BASE_RED) rides only
 * at slot 1. Without an explicit order the fixer moves to slot 1; with one, a fixer elsewhere is refused.
 */
export function baseRedAdmission(slots: TrainSlot[], generic: boolean, explicit: boolean): { slots: TrainSlot[]; lines: string[] } | QueueFailure {
  const conditional = slots.filter(s => s.base_red);
  const fixers = slots.filter(s => s.fixes_base_red?.length);
  if (!conditional.length && !fixers.length) return { slots, lines: [] };
  const named = [...new Set([...conditional, ...fixers])].map(s => '#' + s.pr).join(', ');
  if (!generic) return { code: 'QUEUE_TRAIN_BASE_RED', message: `${named}: a base-red condition rides only a train with gates, which gates every prefix; a gstack-evals train gates only its tip` };
  if (fixers.length > 1) return { code: 'QUEUE_TRAIN_BASE_RED', message: `${fixers.map(s => '#' + s.pr).join(' and ')} each declare FIXES_BASE_RED; only slot 1 may, so one train carries one fixer` };
  const fixer = fixers[0];
  let order = slots;
  if (fixer && slots[0] !== fixer) {
    if (explicit) return { code: 'QUEUE_TRAIN_BASE_RED', message: `#${fixer.pr} declares FIXES_BASE_RED but --order seats it at slot ${slots.indexOf(fixer) + 1}; a fixer must be slot 1` };
    order = [fixer, ...slots.filter(s => s !== fixer)];
  }
  for (const s of conditional) {
    if (s === fixer) return { code: 'QUEUE_TRAIN_BASE_RED', message: `#${s.pr} is conditional and declares FIXES_BASE_RED; a fixer's own head must be green` };
    if (!fixer || s.base_red!.fixer !== fixer.pr) return { code: 'QUEUE_TRAIN_BASE_RED', message: `#${s.pr} is conditional on fixer #${s.base_red!.fixer}, which is not in this train at slot 1 with FIXES_BASE_RED` };
    if (!(Date.parse(s.base_red!.expires_at) >= Date.parse(nowIso()))) return { code: 'QUEUE_TRAIN_BASE_RED', message: `#${s.pr}'s base-red condition expired at ${s.base_red!.expires_at}; its lane classifies again` };
  }
  return { slots: order, lines: [`BASE_RED: fixer #${fixer!.pr} at slot 1 (FIXES_BASE_RED: ${fixer!.fixes_base_red!.join(', ')}); conditional ${conditional.map(s => '#' + s.pr).join(', ') || '(none)'}; every prefix is gated with nothing excluded`] };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * The train verdict over its prefix verdicts. T0 red is red on main, unless slot 1 declares FIXES_BASE_RED and
 * T0's red cases are exactly those. Then the first non-green prefix decides: incomplete stops the train; red with
 * any later prefix green is unattributed (a repair or a new order, never an unchanged rebuild); otherwise its slot
 * is the culprit and the slots before it may land.
 */
export function classifyPrefixes(p: ReadonlyArray<Pick<GatedPrefix, 'outcome' | 'red'>>, slots: ReadonlyArray<Pick<TrainSlot, 'pr' | 'fixes_base_red'>>): Omit<GenericVerdict, 'at'> | { kind: 'pending' } {
  if (p.some(x => !x.outcome || x.outcome === 'PENDING')) return { kind: 'pending' };
  const none = { landable: 0, culprit: null };
  const t0 = p[0]!;
  if (t0.outcome === 'INCOMPLETE') return { kind: 'incomplete', ...none };
  const fixes = slots[0]?.fixes_base_red ?? [];
  if (t0.outcome === 'RED' && !(fixes.length && sameSet(t0.red, fixes))) return { kind: 'red-on-main', ...none };
  const j = p.findIndex((x, i) => i > 0 && x.outcome !== 'GREEN');
  if (j < 0) return { kind: 'green', landable: slots.length, culprit: null };
  if (p[j]!.outcome === 'INCOMPLETE') return { kind: 'incomplete', ...none };
  if (p.slice(j + 1).some(x => x.outcome === 'GREEN')) return { kind: 'unattributed', ...none };
  return { kind: 'attributed', landable: j - 1, culprit: slots[j - 1]!.pr };
}

export interface RunFacts { status: string; conclusion: string | null; head_sha: string; event: string; run_attempt: number }
export interface JobFacts { name: string; conclusion: string | null }
export interface RecordFacts { executed: number; failed: string[] }

/** One workflow run against its prefix: PENDING until completed, RED on a failed job (or failed record tests), GREEN only when nothing is missing. */
export function classifyWorkflowRun(o: { run: RunFacts; head: string; workflow: string; jobs: JobFacts[]; required: string[]; record?: RecordFacts | null }): { outcome: GateOutcome; red: string[]; detail: string } {
  const { run } = o;
  if (run.status !== 'completed') return { outcome: 'PENDING', red: [], detail: `run is ${run.status}` };
  if (run.event !== 'workflow_dispatch') return { outcome: 'INCOMPLETE', red: [], detail: `the adopted run is a ${run.event} run, not the nonce dispatch` };
  if (run.head_sha !== o.head) return { outcome: 'INCOMPLETE', red: [], detail: `the run tested ${run.head_sha.slice(0, 12) || 'no commit'}, not the prefix head ${o.head.slice(0, 12)}` };
  const failedJobs = o.jobs.filter(j => FAILED.includes(j.conclusion ?? '')).map(j => `${o.workflow}/${j.name}`);
  const red = o.record?.failed.length ? o.record.failed.map(id => `${o.workflow}:${id}`) : failedJobs;
  if (red.length) return { outcome: 'RED', red: [...new Set(red)].sort(), detail: `${red.length} red: ${red.slice(0, 8).join(', ')}` };
  const gaps: string[] = [];
  for (const name of o.required) {
    const hits = o.jobs.filter(j => j.name === name);
    if (!hits.length) gaps.push(`required job ${o.workflow}/${name} is missing`);
    else if (hits.some(j => j.conclusion !== 'success')) gaps.push(`required job ${o.workflow}/${name} concluded ${hits.map(j => j.conclusion ?? 'unknown').join('/')}`);
  }
  if (o.record === null) gaps.push('the declared record artifact is missing or unreadable');
  else if (o.record && o.record.executed < 1) gaps.push('the record reports no executed test');
  if (run.conclusion !== 'success') gaps.push(`the run concluded ${run.conclusion ?? 'unknown'}`);
  if (gaps.length) return { outcome: 'INCOMPLETE', red: [], detail: gaps.join('; ') };
  return { outcome: 'GREEN', red: [], detail: `${o.required.length} required job(s) green${o.record ? `, ${o.record.executed} test(s) executed` : ''}` };
}

/** JUnit XML (testcase elements) or a JSON test list ({ tests: [{ id, status }] }) to executed and failed test ids. */
export function parseTestRecord(files: Array<{ name: string; text: string }>): RecordFacts | null {
  let executed = 0; const failed: string[] = []; let read = false;
  for (const f of files) {
    if (f.name.endsWith('.json')) {
      let tests: unknown;
      try { tests = (JSON.parse(f.text) as { tests?: unknown }).tests; } catch { continue; }
      if (!Array.isArray(tests)) continue;
      read = true;
      for (const t of tests as Array<{ id?: unknown; status?: unknown }>) {
        if (typeof t?.id !== 'string' || t.status === 'skip' || t.status === 'skipped') continue;
        executed++;
        if (t.status !== 'pass' && t.status !== 'passed') failed.push(t.id);
      }
    } else if (f.name.endsWith('.xml')) {
      read = true;
      for (const m of f.text.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
        const attr = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(m[1]!)?.[1] ?? '';
        const body = m[3] ?? '';
        if (/<skipped\b/.test(body)) continue;
        executed++;
        if (/<(failure|error)\b/.test(body)) failed.push([attr('classname'), attr('name')].filter(Boolean).join('.'));
      }
    }
  }
  return read ? { executed, failed: failed.sort() } : null;
}

/** Whether a workflow's concurrency groups key on the ref, the run or the nonce; a global group (or one keyed only on github.head_ref, empty on a dispatch) serializes the prefix dispatches. */
export function concurrencyKeyed(yaml: string): boolean {
  const groups = [...yaml.matchAll(/^\s*concurrency:[ \t]*(.*)$/gm)].map(m => {
    const inline = m[1]!.trim();
    if (inline && !inline.startsWith('#')) return inline;
    const after = yaml.slice(m.index! + m[0].length).split('\n').slice(1, 4).join('\n');
    return /^\s*group:\s*(.+)$/m.exec(after)?.[1] ?? '';
  });
  return groups.every(g => /github\.(ref|run_id)\b|inputs\.nonce/.test(g));
}

const json = <T>(r: { ok: boolean; out: string }): T | null => { if (!r.ok) return null; try { return JSON.parse(r.out) as T; } catch { return null; } };

function readRun(env: TrainEnv, slug: string, id: number): RunFacts | null {
  const r = json<Partial<RunFacts>>(env.ctx.gh(['api', `repos/${slug}/actions/runs/${id}`]));
  return r && typeof r.status === 'string' ? { status: r.status, conclusion: r.conclusion ?? null, head_sha: r.head_sha ?? '', event: r.event ?? '', run_attempt: Number(r.run_attempt) || 1 } : null;
}

function readJobs(env: TrainEnv, slug: string, id: number, attempt: number): JobFacts[] | string {
  const r = json<{ total_count?: number; jobs?: Array<{ name?: string; conclusion?: string | null }> }>(env.ctx.gh(['api', `repos/${slug}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`]));
  if (!Array.isArray(r?.jobs)) return `the jobs of run ${id} attempt ${attempt} are unreadable`;
  if ((r.total_count ?? 0) > 100) return `run ${id} has ${r.total_count} jobs; a gate reads at most 100`;
  return r.jobs.map(j => ({ name: String(j.name ?? ''), conclusion: j.conclusion ?? null }));
}

function readRecord(env: TrainEnv, slug: string, t: TrainRecord, id: number, name: string): RecordFacts | null {
  const dir = path.join(trainDir(t.nonce), 'scratch', `${id}-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (!env.ctx.gh(['run', 'download', String(id), '--repo', slug, '-n', name, '-D', dir]).ok) return null;
    const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter(f => /\.(xml|json)$/.test(f) && fs.statSync(path.join(dir, f)).isFile());
    return parseTestRecord(files.map(f => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') })));
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The newest attempt of one unit on one prefix. */
export const unitAttempt = (all: AttemptRecord[], u: GateUnit, index: number) =>
  all.filter(a => a.gate === u.gate && a.workflow === u.workflow && a.prefixes[0] === index).at(-1);

function newAttempt(t: TrainRecord, u: GateUnit, p: GatedPrefix, nonce: string, inputs: Record<string, string>): AttemptRecord {
  const now = nowIso();
  return {
    schema: 1, kind: 'train-attempt', train: t.nonce, id: `a${t.attempts.filter(id => id.startsWith('a')).length + 1}`, purpose: 'gate', nonce, workflow: u.workflow, ref: p.ref,
    inputs, state: 'dispatching', run: null, outcome: null, detail: null, red_cases: [], panels: [], infra_eligible: false, cost_usd: null, prefixes: [p.index],
    gate: u.gate, created_at: now, updated_at: now,
  };
}

/** A green run of the same unit at main's exact sha in another train's record: T0 needs no new run. */
function reusedT0(env: TrainEnv, t: TrainRecord, u: GateUnit, gate: TrainGate): AttemptRecord | null {
  const same = (a: AttemptRecord) => a.workflow === u.workflow && a.outcome === 'GREEN' && a.prefixes[0] === 0 && !a.reused
    && (gate.kind === 'workflows' || a.inputs.command === gate.command);
  for (const other of listTrains(env.repo.keys)) {
    if (other.nonce === t.nonce || other.gated?.[0]?.commit !== t.base.sha) continue;
    const hit = attemptsOf(other).find(same);
    if (hit) return { ...newAttempt(t, u, t.gated![0]!, hit.nonce, hit.inputs), state: 'completed', run: hit.run, outcome: 'GREEN', detail: `reused ${other.nonce}/${hit.id} (green at main ${t.base.sha.slice(0, 12)})`, reused: `${other.nonce}/${hit.id}` };
  }
  return null;
}

/** Push the prefix refs (one atomic push); the record says so before any dispatch. */
function pushPrefixes(env: TrainEnv, t: TrainRecord): string | null {
  if (t.state !== 'built') return null;
  const p = git(env.ctx.repoRoot, ['push', '-q', '--atomic', env.remote, ...t.gated!.map(x => `${x.commit}:refs/heads/${x.ref}`)]);
  if (!p.ok) { t.error = `prefix push failed: ${p.err.slice(0, 160)}`; save(env, t); return t.error; }
  t.state = 'pushed';
  effect(t, `prefix refs pushed: ${t.gated!.map(x => x.ref).join(', ')}`);
  save(env, t);
  return null;
}

/** Dispatch every workflow unit that has no live attempt on a prefix; a workflow with a global concurrency group gets one prefix at a time. A unit is sent at most twice per prefix: two sends no run adopted refuse. */
async function dispatchWorkflows(env: TrainEnv, slug: string, t: TrainRecord, units: GateUnit[], lines: string[]): Promise<QueueFailure | null> {
  const exec = execFor(env.ctx);
  for (const u of units.filter(x => x.workflow !== 'command')) {
    const yaml = git(env.ctx.repoRoot, ['show', `${env.remote}/${env.ctx.base}:.github/workflows/${u.workflow}`]);
    const serial = yaml.ok && !concurrencyKeyed(yaml.out);
    if (serial) lines.push(`SERIAL: ${u.workflow} has a concurrency group not keyed by ref; its prefixes run one at a time`);
    for (const p of t.gated!) {
      const all = attemptsOf(t);
      const prior = unitAttempt(all, u, p.index);
      if (prior && prior.state !== 'absent') continue;
      if (all.filter(a => a.gate === u.gate && a.workflow === u.workflow && a.prefixes[0] === p.index && a.state === 'absent').length >= 2) return { code: 'QUEUE_TRAIN_DISPATCH_UNKNOWN', message: `${u.workflow} on T${p.index} was sent twice under nonce ${prior!.nonce} and no run carrying it appeared; it is not sent a third time (check that its run-name names the nonce: train doctor)` };
      if (serial && t.gated!.some(q => { const a = unitAttempt(all, u, q.index); return !!a && a.state !== 'absent' && a.state !== 'completed'; })) break;
      const reuse = p.index === 0 ? reusedT0(env, t, u, env.train.gates![u.gate]!) : null;
      const nonce = prior?.nonce ?? makeNonce('gate', p.commit, t.base.sha, randomBytes(3).toString('hex'), { purpose: 'train' });
      const a = reuse ?? newAttempt(t, u, p, nonce, { nonce });
      t.attempts.push(a.id);
      save(env, t, a);
      if (reuse) { lines.push(`REUSED: T0 ${u.workflow} ${a.detail}`); continue; }
      const sent = env.ctx.gh(['workflow', 'run', u.workflow, '--repo', slug, '--ref', p.ref, '-f', `nonce=${a.nonce}`]).ok;
      const found = sent ? await awaitNonceRun(u.workflow, a.nonce, exec, slug) : null;
      a.state = found ? 'dispatched' : 'unknown';
      a.run = found ? { id: found.databaseId, url: found.url } : null;
      effect(t, `gate ${u.gate} ${u.workflow} on T${p.index}: ${found ? `run ${found.databaseId}` : 'dispatch unconfirmed'} (nonce ${a.nonce})`);
      save(env, t, a);
      lines.push(`DISPATCH: ${u.workflow} on ${p.ref} ${found ? `run ${found.databaseId}` : 'unconfirmed'} nonce ${a.nonce}`);
      if (serial) break;
    }
  }
  return null;
}

/** Dollars reserved by one command gate's runs in this train (an interrupted run stays counted); each gate has its own cap. */
function commandSpend(t: TrainRecord, gate: number): number {
  return Math.round(attemptsOf(t).filter(a => a.workflow === 'command' && a.gate === gate && !a.reused).reduce((s, a) => s + (a.spend_usd ?? 0), 0) * 100) / 100;
}

const pidAlive = (pid: unknown): boolean => {
  if (typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Whether a command attempt's process may still be running: its owner is alive on this host, or on another host within the run's time. */
function commandLive(a: AttemptRecord, g: TrainGate | undefined): boolean {
  if (a.workflow !== 'command' || a.state !== 'dispatching' || !a.owner) return false;
  if (a.owner.host !== os.hostname()) return g?.kind === 'command' && Date.now() - Date.parse(a.updated_at) < (g.timeout_sec + COMMAND_OVERHEAD_MIN * 60) * 2000;
  return pidAlive(a.owner.pid);
}

/** One build or verdict at a time writes a generic train's attempts: a lock file naming its owner, taken over once that owner is gone (another host's after six hours). */
function trainLease(t: TrainRecord): { release: () => void } | QueueFailure {
  const file = path.join(trainDir(t.nonce), 'gate.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname() }), { flag: 'wx' });
      return { release: () => fs.rmSync(file, { force: true }) };
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    let o: { pid?: unknown; host?: unknown } | null = null;
    try { o = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { o = null; }
    const age = Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    const held = !o ? age < 10_000 : o.host === os.hostname() ? pidAlive(o.pid) : age < 6 * 3600_000;
    if (held) return { code: 'QUEUE_TRAIN_PENDING', message: `another train build or verdict (process ${String(o?.pid ?? '?')} on ${String(o?.host ?? '?')}) holds ${file}; nothing read or sent` };
    fs.rmSync(file, { force: true });
  }
  return { code: 'QUEUE_TRAIN_PENDING', message: `${file} changed hands twice while this process waited; nothing read or sent` };
}

/** Run one command gate on a prefix through ubi-runner; resolves with the outcome. */
async function runCommand(env: TrainEnv, t: TrainRecord, a: AttemptRecord, g: CommandGate, p: GatedPrefix): Promise<{ outcome: GateOutcome; detail: string; tree: string | null }> {
  const wt = path.join(queueRoot(), 'gw', `${a.nonce.slice(-6)}-${p.index}-${a.id}`);
  fs.rmSync(wt, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  if (!git(env.ctx.repoRoot, ['worktree', 'add', '--detach', '-q', wt, p.commit]).ok) return { outcome: 'INCOMPLETE', detail: `cannot check out T${p.index}`, tree: null };
  try {
    const dirty = git(wt, ['status', '--porcelain', '--untracked-files=all']);
    if (!dirty.ok || dirty.out) return { outcome: 'INCOMPLETE', detail: 'the checkout of the prefix is not clean', tree: null };
    const remote = `git add -A >/dev/null 2>&1 && printf 'GSTACK_GATE_TREE=%s\n' "$(git write-tree)" && ( ${g.command} )`;
    const inv = scriptInvocation(process.env.GSTACK_TRAIN_UBI_RUNNER || UBI_RUNNER, ['run', '--src', wt, ...(g.pass_env ?? []).flatMap(n => ['--pass', n]), '--', remote]);
    if (!inv.ok) return { outcome: 'INCOMPLETE', detail: inv.error, tree: null };
    const childEnv = { ...process.env, UBI_SIZE: COMMAND_SIZE, UBI_RUN_TIMEOUT: String(g.timeout_sec), UBI_TTL_HOURS: String(Math.ceil(g.timeout_sec / 3600) + 1) };
    const child = spawn(inv.cmd, inv.argv, { cwd: wt, env: childEnv, timeout: (g.timeout_sec + COMMAND_OVERHEAD_MIN * 60) * 1000 });
    let out = '';
    let tree = null as string | null;
    const keep = (b: Buffer) => { const all = out + b.toString('utf8'); tree ??= /^GSTACK_GATE_TREE=([0-9a-f]{40,64})$/m.exec(all)?.[1] ?? null; out = all.slice(-1_000_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const code = await new Promise<number | null>(resolve => { child.on('close', c => resolve(c)); child.on('error', () => resolve(null)); });
    const log = path.join(trainDir(t.nonce), 'attempts', `${a.id}.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, out, { mode: 0o600 });
    const left = [...out.matchAll(/UBICLOUD: left=(\S+)/g)].at(-1)?.[1];
    if (!tree) return { outcome: 'INCOMPLETE', detail: `the VM reported no tree (exit ${code ?? 'none'}; log ${log})`, tree };
    if (tree !== p.tree) return { outcome: 'INCOMPLETE', detail: `the VM tested tree ${tree.slice(0, 12)}, not the prefix tree ${p.tree.slice(0, 12)}`, tree };
    if (left !== undefined && left !== '0') return { outcome: 'INCOMPLETE', detail: `ubi-runner reports left=${left}; the run is not counted`, tree };
    if (code === 0) return { outcome: 'GREEN', detail: `exit 0 on tree ${tree.slice(0, 12)}`, tree };
    if (code === 124 || code === null) return { outcome: 'INCOMPLETE', detail: `the command ${code === 124 ? 'timed out' : 'did not finish'} (log ${log})`, tree };
    return { outcome: 'RED', detail: `exit ${code} (log ${log})`, tree };
  } finally {
    git(env.ctx.repoRoot, ['worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
  }
}

/** Run one command attempt; a red run gets one rerun while the cap allows: a pass is GREEN and FLAKY, a second red is real. */
async function settleCommand(env: TrainEnv, t: TrainRecord, a: AttemptRecord, g: CommandGate, p: GatedPrefix, lines: string[]): Promise<void> {
  const price = commandReservation(g);
  let r = await runCommand(env, t, a, g, p);
  if (r.outcome === 'RED' && commandSpend(t, a.gate!) + price <= g.spend_cap_usd) {
    a.spend_usd = (a.spend_usd ?? 0) + price;
    save(env, t, a);
    const again = await runCommand(env, t, a, g, p);
    if (again.outcome === 'GREEN') { a.flaky = [`command:${a.gate}`]; r = { ...again, detail: `${again.detail}; FLAKY: the first run was red (${r.detail})` }; }
    else r = again.outcome === 'RED' ? { ...again, detail: `red twice: ${again.detail}` } : again;
  }
  Object.assign(a, { state: 'completed', outcome: r.outcome, detail: r.detail, tree: r.tree, red_cases: r.outcome === 'RED' ? [`command:${a.gate}`] : [] });
  effect(t, `gate ${a.gate} command on T${p.index}: ${r.outcome}`);
  save(env, t, a);
  lines.push(`COMMAND: gate ${a.gate} on T${p.index} ${r.outcome} (${r.detail})`);
}

/** Run every command unit that has no finished attempt, all prefixes in parallel, under the train's one spend cap. */
async function runCommands(env: TrainEnv, t: TrainRecord, units: GateUnit[], lines: string[]): Promise<QueueFailure | null> {
  const commands = units.filter(u => u.workflow === 'command');
  if (!commands.length) return null;
  if (!process.env.UBI_OWNER) return { code: 'QUEUE_TRAIN_SPEND_CAP', message: 'a command gate runs on a Ubicloud VM, and UBI_OWNER is not set (every VM names its owner); nothing ran' };
  const jobs: Array<Promise<void>> = [];
  for (const u of commands) {
    const g = env.train.gates![u.gate] as CommandGate;
    const price = commandReservation(g);
    for (const p of t.gated!) {
      if (unitAttempt(attemptsOf(t), u, p.index)?.state === 'completed') continue;
      const reuse = p.index === 0 ? reusedT0(env, t, u, g) : null;
      if (reuse) { t.attempts.push(reuse.id); save(env, t, reuse); lines.push(`REUSED: T0 command ${reuse.detail}`); continue; }
      if (commandSpend(t, u.gate) + price > g.spend_cap_usd) {
        await Promise.all(jobs);
        return { code: 'QUEUE_TRAIN_SPEND_CAP', message: `gate ${u.gate}'s run on T${p.index} reserves $${price.toFixed(2)}; with $${commandSpend(t, u.gate).toFixed(2)} reserved, this train would pass the gate's cap $${g.spend_cap_usd.toFixed(2)}` };
      }
      const a = newAttempt(t, u, p, makeNonce('gate', p.commit, t.base.sha, randomBytes(3).toString('hex'), { purpose: 'train' }), { command: g.command });
      a.spend_usd = price;
      a.owner = { pid: process.pid, host: os.hostname() };
      t.attempts.push(a.id);
      save(env, t, a);
      jobs.push(settleCommand(env, t, a, g, p, lines));
    }
  }
  await Promise.all(jobs);
  return null;
}

/** `train build` for a generic train: push the prefix refs, dispatch every workflow unit, run every command unit. */
export async function advanceGeneric(env: TrainEnv, t: TrainRecord, lines: string[], describe: (t: TrainRecord) => string[]): Promise<TrainOut> {
  const run = trainFile(t.nonce);
  const slug = repoSlug(env.ctx);
  if (!slug) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: 'gh repo view could not name the repository' }, lines, `${Q} train build --train ${t.nonce}`, run);
  const lease = trainLease(t);
  if ('code' in lease) return outPending(lease, lines, `${Q} train build --train ${t.nonce} (once that process finishes)`, run);
  try {
    Object.assign(t, loadTrain(t.nonce) ?? {});
    const pushed = pushPrefixes(env, t);
    if (pushed) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: pushed }, lines, `${Q} train build --train ${t.nonce}`, run);
    const units = gateUnits(env.train.gates!);
    if (t.verdict) return outOk([...lines, ...describe(t), `VERDICT: ${t.verdict.kind.toUpperCase()} (settled; nothing dispatched)`], genericNext(t), run);
    const live = attemptsOf(t).find(a => commandLive(a, env.train.gates![a.gate ?? -1]));
    if (live) return outPending({ code: 'QUEUE_TRAIN_PENDING', message: `command run ${live.id} is still running under process ${live.owner!.pid} on ${live.owner!.host}` }, lines, `${Q} train verdict --train ${t.nonce} (once that run finishes)`, run);
    reconcile(env, slug, t);
    const unsent = await dispatchWorkflows(env, slug, t, units, lines);
    const capped = unsent ? null : await runCommands(env, t, units, lines);
    t.state = 'gate-pending';
    save(env, t);
    if (unsent) return outRefused(unsent, [...lines, ...describe(t)], `run ${Q} train doctor and fix the workflow on the base branch, then build a new train on the new main: ${Q} train build ${prsArgs(t.slots, t.explicit_order)}`, run);
    if (capped) return outRefused(capped, [...lines, ...describe(t)], `raise the gate's spend_cap_usd (or lower its timeout_sec) on the base branch, then build a new train on the new main: ${Q} train build ${prsArgs(t.slots, t.explicit_order)}`, run);
    return outOk([...lines, ...describe(t), `GATES: ${units.length} unit(s) on ${t.gated!.length} prefix(es); record: ${run}`], `${Q} train verdict --train ${t.nonce}`, run);
  } finally { lease.release(); }
}

/** Settle unconfirmed workflow dispatches by nonce (found, or absent so the next build re-sends the same nonce); an interrupted command run is absent. */
function reconcile(env: TrainEnv, slug: string, t: TrainRecord): void {
  for (const a of attemptsOf(t)) {
    if (a.state !== 'dispatching' && a.state !== 'unknown') continue;
    if (a.workflow === 'command') {
      if (commandLive(a, env.train.gates?.[a.gate ?? -1])) continue;
      a.state = 'absent'; effect(t, `command run ${a.id} was interrupted; it runs again`); save(env, t, a); continue;
    }
    const runs = listDispatchRuns(a.workflow, execFor(env.ctx), slug, 100);
    if (!runs) continue;
    const hit = runForNonce(runs, a.nonce);
    a.state = hit ? 'dispatched' : 'absent';
    a.run = hit ? { id: hit.databaseId, url: hit.url } : null;
    effect(t, `reconciled ${a.id} (nonce ${a.nonce}): ${hit ? `run ${hit.databaseId}` : 'absent'}`);
    save(env, t, a);
  }
}

/** Read one workflow attempt's run; a first red asks for one rerun of the failed jobs and waits for it. */
function readWorkflowAttempt(env: TrainEnv, slug: string, t: TrainRecord, a: AttemptRecord): void {
  const gate = env.train.gates![a.gate!] as WorkflowsGate;
  const run = readRun(env, slug, a.run!.id);
  if (!run) { a.detail = `run ${a.run!.id} is unreadable`; return; }
  if (run.status !== 'completed' || (a.rerun === 'requested' && run.run_attempt < 2)) {
    Object.assign(a, { outcome: 'PENDING', detail: `run ${a.run!.id} attempt ${run.run_attempt} is ${run.status}${a.rerun === 'requested' ? ' (waiting for the rerun)' : ''}` });
    return;
  }
  const jobs = readJobs(env, slug, a.run!.id, run.run_attempt);
  if (typeof jobs === 'string') { Object.assign(a, { outcome: 'INCOMPLETE', state: 'completed', detail: jobs }); return; }
  const earlier = (a.jobs ?? []).filter(j => j.attempt < run.run_attempt);
  const merged = new Map(earlier.filter(j => j.attempt === run.run_attempt - 1).map(j => [j.name, j.conclusion] as const));
  for (const j of jobs) merged.set(j.name, j.conclusion);
  a.jobs = [...earlier, ...jobs.map(j => ({ attempt: run.run_attempt, ...j }))];
  a.run_attempt = run.run_attempt;
  const required = gate.required_jobs.filter(r => r.startsWith(`${a.workflow}/`)).map(r => r.slice(a.workflow.length + 1));
  const record = gate.record ? readRecord(env, slug, t, a.run!.id, gate.record) : undefined;
  const c = classifyWorkflowRun({ run, head: t.gated![a.prefixes[0]!]!.commit, workflow: a.workflow, jobs: [...merged].map(([name, conclusion]) => ({ name, conclusion })), required, record });
  if (c.outcome === 'RED' && !a.rerun) {
    const sent = env.ctx.gh(['run', 'rerun', String(a.run!.id), '--failed', '--repo', slug]).ok;
    a.rerun = sent ? 'requested' : 'refused';
    a.red_cases = c.red;
    if (sent) { Object.assign(a, { outcome: 'PENDING', detail: `red on ${c.red.join(', ')}; one rerun of the failed jobs requested (CREW rule 16)` }); effect(t, `rerun requested for run ${a.run!.id}`); return; }
  }
  const firstRed = a.rerun === 'requested' ? a.red_cases : [];
  Object.assign(a, { state: 'completed', outcome: c.outcome, red_cases: c.red, detail: c.detail });
  if (c.outcome === 'GREEN' && firstRed.length) { a.flaky = firstRed; a.detail = `${c.detail}; FLAKY: ${firstRed.join(', ')} red on attempt 1, green on the rerun`; }
  else if (c.outcome === 'RED' && a.rerun === 'requested') a.detail = `red on the rerun too: ${c.detail}`;
}

/** Per prefix: PENDING while any unit is, then INCOMPLETE, then RED (red cases united), else GREEN. */
function aggregate(env: TrainEnv, t: TrainRecord): void {
  const all = attemptsOf(t);
  const units = gateUnits(env.train.gates!);
  for (const p of t.gated!) {
    const attempts = units.map(u => unitAttempt(all, u, p.index));
    const outs = attempts.map(a => (!a || a.state === 'absent' ? 'PENDING' : a.outcome ?? 'PENDING'));
    p.outcome = outs.includes('PENDING') ? 'PENDING' : outs.includes('INCOMPLETE') ? 'INCOMPLETE' : outs.includes('RED') ? 'RED' : 'GREEN';
    p.red = p.outcome === 'RED' ? [...new Set(attempts.flatMap(a => (a?.outcome === 'RED' ? a.red_cases : [])))].sort() : [];
    p.detail = attempts.map((a, i) => `${units[i]!.workflow}: ${!a || a.state === 'absent' ? 'not dispatched' : a.detail ?? a.state}`).join('; ');
  }
}

const VERDICT_STATE = { green: 'green', attributed: 'attributed', 'red-on-main': 'red-on-main', unattributed: 'unattributed', incomplete: 'incomplete' } as const;

/** The coded failure for a settled, non-green verdict. */
function verdictFailure(t: TrainRecord, v: GenericVerdict): QueueFailure {
  if (v.kind === 'attributed') {
    return t.slots[0]?.fixes_base_red?.length && v.culprit === t.slots[0]!.pr && t.slots.some(s => s.base_red)
      ? { code: 'QUEUE_TRAIN_BASE_RED', message: `fixer #${v.culprit}'s prefix T1 is red (${t.gated![1]!.red.join(', ')}); its conditional PRs cannot ride without it` }
      : { code: 'QUEUE_TRAIN_RED', message: `T${v.landable + 1} is the first red prefix after a green one: #${v.culprit} is held${v.landable ? `; slots 1..${v.landable} may land` : ''}` };
  }
  if (v.kind === 'red-on-main') {
    const fixes = t.slots[0]?.fixes_base_red;
    return { code: 'QUEUE_TRAIN_RED_ON_MAIN', message: `T0 (main ${t.base.sha.slice(0, 12)}) is red on ${t.gated![0]!.red.join(', ') || 'its gate'}${fixes?.length ? `, not exactly slot 1's FIXES_BASE_RED (${fixes.join(', ')})` : ''}` };
  }
  if (v.kind === 'unattributed') return { code: 'QUEUE_TRAIN_UNATTRIBUTED', message: 'a red prefix is followed by a green one, so no slot is the culprit; a generic train gets no unchanged rebuild' };
  return { code: 'QUEUE_TRAIN_INCOMPLETE', message: `a prefix gate is incomplete: ${t.gated!.find(p => p.outcome === 'INCOMPLETE')?.detail ?? 'see the PREFIX lines'}` };
}

/** `train verdict` for a generic train: read every run, settle reruns, then classify the prefixes. */
export function genericVerdict(env: TrainEnv, t: TrainRecord): TrainOut {
  const run = trainFile(t.nonce);
  const slug = repoSlug(env.ctx);
  if (!slug) return outPending({ code: 'QUEUE_PROOF_MISSING', message: 'gh repo view could not name the repository' }, [], `${Q} train verdict --train ${t.nonce}`, run);
  if (!t.verdict) {
    const lease = trainLease(t);
    if ('code' in lease) return outPending(lease, [], `${Q} train verdict --train ${t.nonce} (once that process finishes)`, run);
    try {
      Object.assign(t, loadTrain(t.nonce) ?? {});
      const live = t.verdict ? null : attemptsOf(t).find(a => commandLive(a, env.train.gates![a.gate ?? -1]));
      if (live) return outPending({ code: 'QUEUE_TRAIN_PENDING', message: `command run ${live.id} is still running under process ${live.owner!.pid} on ${live.owner!.host}; nothing read or saved` }, [], `${Q} train verdict --train ${t.nonce} (once that run finishes)`, run);
      if (!t.verdict) {
        reconcile(env, slug, t);
        for (const a of attemptsOf(t)) {
          if (a.workflow === 'command' || a.state !== 'dispatched' || !a.run) continue;
          readWorkflowAttempt(env, slug, t, a);
          save(env, t, a);
        }
        aggregate(env, t);
        const c = classifyPrefixes(t.gated!, t.slots);
        if (c.kind !== 'pending') { t.verdict = { ...c, at: nowIso() }; t.state = VERDICT_STATE[c.kind]; effect(t, `verdict: ${c.kind}${c.culprit ? ` (culprit #${c.culprit})` : ''}`); }
        save(env, t);
      }
    } finally { lease.release(); }
  }
  const lines = [
    ...t.gated!.map(p => `PREFIX: T${p.index} ${p.outcome ?? 'PENDING'} ${p.commit.slice(0, 12)} ${p.ref}${p.red.length ? ` red=${p.red.join(',')}` : ''}${p.detail ? ` (${p.detail})` : ''}`),
    ...attemptsOf(t).filter(a => a.flaky?.length).map(a => `FLAKY: T${a.prefixes[0]} ${a.workflow} ${a.flaky!.join(', ')} (run ${a.run?.id ?? '-'}; flake recorded on ${a.id})`),
  ];
  const v = t.verdict;
  if (!v) {
    const waiting = t.gated!.some(p => /not dispatched/.test(p.detail ?? ''));
    return outPending({ code: 'QUEUE_TRAIN_PENDING', message: `prefix gates still running${waiting ? ' or waiting for their serial turn' : ''}` }, lines, waiting ? `${Q} train build --train ${t.nonce}` : `${Q} train verdict --train ${t.nonce}`, run);
  }
  lines.push(`VERDICT: ${v.kind.toUpperCase()} train ${t.nonce} landable=${v.landable}/${t.slots.length}${v.culprit ? ` culprit=#${v.culprit}` : ''}`);
  return v.kind === 'green' ? outOk(lines, genericNext(t), run) : outFailed(verdictFailure(t, v), lines, genericNext(t), run);
}

/** NEXT for a generic train. */
export function genericNext(t: TrainRecord): string {
  const n = t.nonce;
  const merged = (pr: string) => t.merged.some(m => m.pr === pr);
  if (t.state === 'built' || t.state === 'pushed') return `${Q} train build --train ${n}`;
  if (!t.verdict) return `${Q} train verdict --train ${n}`;
  const v = t.verdict;
  const next = t.slots.slice(0, v.landable).find(s => !merged(s.pr));
  if (next) return `${Q} train land --train ${n} --pr ${next.pr}`;
  const rest = t.slots.filter(s => !merged(s.pr) && s.pr !== v.culprit);
  if (v.kind === 'green' || v.kind === 'attributed') return rest.length ? `${Q} train build ${prsArgs(rest, t.explicit_order)}` : `${Q} train prune --train ${n}`;
  if (v.kind === 'red-on-main') return `fix forward on main first, then ${Q} train build ${prsArgs(t.slots, t.explicit_order)}`;
  if (v.kind === 'unattributed') return `repair the red cases, or seat the PRs in another order (never this train unchanged): ${Q} train build --prs ${t.slots.map(s => `${s.pr}@${s.head}`).join(',')} --order <new order>`;
  return `diagnose the incomplete prefix run, then ${Q} train build ${prsArgs(t.slots, t.explicit_order)} (a new train)`;
}

/** Freeze backstop for a generic train: every workflow unit dispatched on the base branch by nonce; the first run is recorded. */
export async function genericBackstop(env: TrainEnv, mainSha: string): Promise<{ nonce: string; run: number | null; state: string }> {
  const slug = repoSlug(env.ctx);
  const nonce = makeNonce('gate', mainSha, mainSha, randomBytes(3).toString('hex'), { purpose: 'backstop' });
  const units = gateUnits(env.train.gates!).filter(u => u.workflow !== 'command');
  let first: number | null = null;
  for (const u of units) {
    if (!slug || !env.ctx.gh(['workflow', 'run', u.workflow, '--repo', slug, '--ref', env.ctx.base, '-f', `nonce=${nonce}`]).ok) continue;
    const found = await awaitNonceRun(u.workflow, nonce, execFor(env.ctx), slug);
    first ??= found?.databaseId ?? null;
  }
  return { nonce, run: first, state: first ? 'dispatched' : units.length ? 'unconfirmed' : 'not dispatched (command gates only: run the gate command on main)' };
}
