/**
 * Train verdict, bisect and the one preregistered rebuild
 * (docs/ship-policy.md#run-a-merge-train; plan GSTA-49 lane T1, P3).
 *
 * The verdict reads the train's own gate run and the record artifact that run
 * publishes (with the `gstack/full-gate` check run) on the train head; it
 * only reads, never writes a check. Green needs a complete census from the
 * run's own plan manifest. A red train stays red: the bisect runs only its
 * red cases, one trial on every prefix T0..Tk, and attributes by pattern.
 * Rebuild-once (Garry, 2026-10-18; to be recorded in EVAL_POLICY beside
 * infraRedispatch): an all-green bisect earns one unchanged rebuild.
 */
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DISPATCH_INPUTS, listDispatchRuns, makeNonce, runForNonce } from '../scripts/eval-bg';
import type { QueueContext } from './ship-queue';
import { git } from './ship-queue-gate';
import {
  checkRun, downloadJson, execFor, asRun, remoteBranchSha, repoSlug, runView, type CheckInfo, type RunInfo,
} from './ship-queue-train-github';
import {
  attemptsOf, loadBisect, nowIso, persist, trainDir, trainFile,
  type AttemptRecord, type BisectRecord, type CasePanel, type GateOutcome, type PrefixResult, type TrainRecord,
} from './ship-queue-train-record';
import {
  dispatchAttempt, effect, findTrain, gateDispatch, nextFor, outFailed, outOk, outPending, outRefused, prsArgs, save, trainEnv,
  type TrainEnv, type TrainOut,
} from './ship-queue-train';

/** EVAL_POLICY.infraRedispatch (test/helpers/periodic-exclude-data.ts): one re-dispatch of an INFRA/INCOMPLETE-only census. */
export const INFRA_REDISPATCH = 1;
/** Rebuild-once (Garry, 2026-10-18): an all-green bisect earns exactly one unchanged rebuild; pinned to EVAL_POLICY by its test. */
export const REBUILD_ONCE = 1;

const Q = 'gstack-ship-queue';

/** The record artifact the train's own gate run publishes (plan T1b), read by verdict, verify and the backstop. */
export interface TrainGateRecord {
  schema: 1; kind: 'train-gate'; nonce: string; head_sha: string; tree: string; verdict: 'GREEN' | 'RED';
  census: { complete: boolean; planned: { rule: number; judge: number }; executed: { rule: number; judge: number };
    unbound: number; partial_shards: number; cancelled_shards: number; killed_before_upload: number };
  panels: CasePanel[];
}
/** One bisect prefix's artifact: the red cases on that prefix, one trial each. */
export interface BisectPrefixRecord { schema: 1; kind: 'train-bisect-prefix'; nonce: string; prefix_sha: string; checked_out_sha: string; panels: CasePanel[] }

export const bisectArtifact = (recordArtifact: string, sha: string) => `${recordArtifact}-bisect-${sha.slice(0, 12)}`;

export interface GateClass { outcome: GateOutcome; detail: string; red: string[]; panels: CasePanel[]; infraEligible: boolean; cost: number | null }

/** Every paid-report class mapped to one train outcome; green only for a complete, bound, published census. */
export function classifyGate(raw: unknown, expect: { nonce: string; head: string; tree: string }, run: Pick<RunInfo, 'status' | 'conclusion'>, check: CheckInfo | null): GateClass {
  const base = { red: [] as string[], panels: [] as CasePanel[], infraEligible: false, cost: null as number | null };
  if (run.status !== 'completed') return { ...base, outcome: 'PENDING', detail: `run is ${run.status}` };
  const rec = raw as TrainGateRecord | null;
  if (!rec || rec.schema !== 1 || rec.kind !== 'train-gate' || !Array.isArray(rec.panels) || !rec.census) {
    return { ...base, outcome: 'INCOMPLETE', infraEligible: true, detail: `no train record artifact (run concluded ${run.conclusion ?? 'unknown'}; a slice killed before its upload step counts here)` };
  }
  const panels = rec.panels;
  const known = panels.map(p => p.cost_usd).filter((c): c is number => typeof c === 'number');
  const cost = known.length ? Math.round(known.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  const withPanels = { ...base, panels, cost };
  if (rec.nonce !== expect.nonce || rec.head_sha !== expect.head || rec.tree !== expect.tree) {
    return { ...withPanels, outcome: 'INCOMPLETE', detail: `the record is bound to nonce ${rec.nonce} head ${String(rec.head_sha).slice(0, 12)} tree ${String(rec.tree).slice(0, 12)}, not this train's attempt` };
  }
  const red = panels.filter(p => p.status === 'FAIL' && p.red_class === 'VERDICT').map(p => p.case).sort();
  if (red.length) return { ...withPanels, outcome: 'RED', red, detail: `${red.length} red case(s): ${red.join(', ')}` };
  const c = rec.census;
  const gaps = [
    ...(c.planned.rule + c.planned.judge <= 0 ? ['the plan manifest lists no cases'] : []),
    ...(c.executed.rule !== c.planned.rule ? [`rule ${c.executed.rule}/${c.planned.rule} executed`] : []),
    ...(c.executed.judge !== c.planned.judge ? [`judge ${c.executed.judge}/${c.planned.judge} executed`] : []),
    ...(c.unbound ? [`${c.unbound} unbound result`] : []), ...(c.partial_shards ? [`${c.partial_shards} partial shard`] : []),
    ...(c.cancelled_shards ? [`${c.cancelled_shards} cancelled shard`] : []), ...(c.killed_before_upload ? [`${c.killed_before_upload} slice killed before upload`] : []),
    ...(!c.complete ? ['census marked incomplete'] : []),
    ...panels.filter(p => p.status !== 'PASS').map(p => `${p.case} ${p.status}${p.red_class ? ` (${p.red_class})` : ''}`),
  ];
  if (gaps.length) return { ...withPanels, outcome: 'INCOMPLETE', infraEligible: !panels.some(p => p.status === 'SKIPPED'), detail: gaps.join('; ') };
  if (run.conclusion !== 'success' || rec.verdict !== 'GREEN') return { ...withPanels, outcome: 'INCOMPLETE', detail: `run concluded ${run.conclusion ?? 'unknown'} with record verdict ${rec.verdict}` };
  if (!check || check.conclusion !== 'success') return { ...withPanels, outcome: 'INCOMPLETE', detail: `the run did not publish a successful check run on the train head (${check ? `${check.status}/${check.conclusion}` : 'missing'})` };
  return { ...withPanels, outcome: 'GREEN', detail: `rule ${c.executed.rule}/${c.planned.rule}, judge ${c.executed.judge}/${c.planned.judge}` };
}

const gateAttempts = (t: TrainRecord) => attemptsOf(t).filter(a => a.purpose !== 'bisect');
const costText = (a: AttemptRecord) => {
  if (a.cost_usd === null) return '';
  const unknown = a.panels.filter(p => p.cost_usd === null).length;
  return ` cost=$${a.cost_usd.toFixed(2)}${unknown ? ` known + ${unknown} of ${a.panels.length} case(s) cost unknown` : ''}`;
};
const attemptLine = (a: AttemptRecord) => `ATTEMPT: ${a.id} ${a.purpose} run ${a.run?.id ?? '-'} ${a.outcome ?? a.state}${a.red_cases.length ? ` red=${a.red_cases.join(',')}` : ''}${costText(a)}${a.detail ? ` (${a.detail})` : ''}`;

function casePrice(env: TrainEnv, red: AttemptRecord, id: string): number {
  return red.panels.find(p => p.case === id)?.cost_usd ?? env.train.trial_reservation_usd;
}

/** The whole-bisect reservation for a red attempt: every red case on every prefix. */
export function bisectReservation(env: TrainEnv, t: TrainRecord, red: AttemptRecord): number {
  const perPrefix = red.red_cases.reduce((sum, id) => sum + casePrice(env, red, id), 0);
  return Math.ceil(perPrefix * t.prefixes.length * 100) / 100;
}

function unknownDispatch(t: TrainRecord, a: AttemptRecord): TrainOut {
  return outPending({ code: 'QUEUE_TRAIN_DISPATCH_UNKNOWN', message: `the ${a.purpose} dispatch ${a.id} (nonce ${a.nonce}) is unconfirmed` }, [attemptLine(a)], `${Q} train status --train ${t.nonce}`, trainFile(t.nonce));
}

/** `train verdict`: read the current gate attempt's run and record; print every attempt, so a rebuild reports both runs. */
export function trainVerdict(ctx: QueueContext, o: { train: string }): TrainOut {
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  const t = findTrain(env, o.train);
  if (!t) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no train record ${o.train} here or in refs/notes/gstack-trains` }, [], `${Q} train status`, 'none');
  const run = trainFile(t.nonce);
  const a = gateAttempts(t).at(-1);
  if (!a) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `train ${t.nonce} has no gate dispatch yet` }, [], nextFor(t), run);
  if (a.state === 'dispatching' || a.state === 'unknown') return unknownDispatch(t, a);
  if (a.state === 'absent') return outRefused({ code: 'QUEUE_TRAIN_DISPATCH_UNKNOWN', message: `the dispatch ${a.nonce} never started (train status found no run)` }, [attemptLine(a)], `${Q} train build --train ${t.nonce}`, run);
  const slug = repoSlug(ctx);
  if (!a.outcome || a.outcome === 'PENDING') {
    const view = slug && a.run ? runView(ctx, slug, a.run.id) : null;
    if (!slug || !view) return outPending({ code: 'QUEUE_TRAIN_PENDING', message: `cannot read run ${a.run?.id} through gh` }, [attemptLine(a)], `${Q} train verdict --train ${t.nonce}`, run);
    const record = view.status === 'completed' ? downloadJson(ctx, slug, a.run!.id, env.train.record_artifact, path.join(trainDir(t.nonce), 'scratch')) : null;
    const check = view.status === 'completed' ? checkRun(ctx, t.head, env.train.full_gate_check) : null;
    const c = classifyGate(record, { nonce: a.nonce, head: t.head, tree: t.tree }, view, check);
    Object.assign(a, { outcome: c.outcome, detail: c.detail, red_cases: c.red, panels: c.panels, infra_eligible: c.infraEligible, cost_usd: c.cost, state: view.status === 'completed' ? 'completed' : a.state });
    if (c.outcome !== 'PENDING') {
      t.state = c.outcome === 'GREEN' ? 'green' : c.outcome === 'RED' ? (a.purpose === 'rebuild' ? 'unattributed' : 'red') : 'incomplete';
      effect(t, `verdict ${a.id}: ${c.outcome}`);
    }
    save(env, t, a);
  }
  const lines = [...gateAttempts(t).map(attemptLine), `VERDICT: ${a.outcome} train ${t.nonce} run ${a.run?.id ?? '-'} head ${t.head.slice(0, 12)} tree ${t.tree.slice(0, 12)}`];
  if (a.outcome === 'PENDING') return outPending({ code: 'QUEUE_TRAIN_PENDING', message: `the gate run ${a.run?.id} has not finished (${a.detail})` }, lines, `${Q} train verdict --train ${t.nonce}`, run);
  if (a.outcome === 'GREEN') return outOk(lines, nextFor(t), run);
  if (a.outcome === 'RED') {
    const next = a.purpose === 'rebuild'
      ? `second red stays red: route ${a.red_cases.join(',')} to a repair lane (GStack Minder), then ${Q} train build --prs <pins without the PRs held>`
      : `${Q} train bisect --train ${t.nonce} --spend-cap ${bisectReservation(env, t, a).toFixed(2)}`;
    return outFailed({ code: 'QUEUE_TRAIN_RED', message: `train ${t.nonce} is red on ${a.red_cases.join(', ')}` }, lines, next, run);
  }
  const used = gateAttempts(t).filter(x => x.purpose === 'infra-redispatch').length;
  const next = a.infra_eligible && used < INFRA_REDISPATCH
    ? `${Q} train rebuild --train ${t.nonce} --infra (the single re-dispatch EVAL_POLICY.infraRedispatch allows; report both runs)`
    : `diagnose run ${a.run?.url ?? a.run?.id}; the train stays incomplete (GStack Minder routes it)`;
  return outFailed({ code: 'QUEUE_TRAIN_INCOMPLETE', message: `train ${t.nonce} gate is incomplete: ${a.detail}` }, lines, next, run);
}

export interface BisectClass { kind: 'attributed' | 'red-on-main' | 'unattributed'; all_green: boolean; prs: string[]; patterns: Record<string, string> }

/**
 * Pattern attribution over T0..Tk (one trial each, so only shapes count):
 * monotone green-then-red from Ti blames slot i's PR; red everywhere,
 * T0 included, is main; all green, or anything else, is unattributed.
 */
export function classifyBisect(cases: string[], results: Array<Record<string, PrefixResult>>, slots: Array<{ pr: string }>): BisectClass {
  const patterns: Record<string, string> = {};
  const blamed = new Set<string>();
  let main = false; let other = false; let green = 0;
  for (const c of cases) {
    const seq = results.map(r => (r[c] === 'red' ? 'R' : 'G')).join('');
    patterns[c] = seq;
    const first = seq.indexOf('R');
    if (first < 0) green++;
    else if (first === 0 && !seq.includes('G')) main = true;
    else if (first > 0 && !seq.slice(first).includes('G')) blamed.add(slots[first - 1]!.pr);
    else other = true;
  }
  if (main) return { kind: 'red-on-main', all_green: false, prs: [], patterns };
  if (other || !blamed.size) return { kind: 'unattributed', all_green: green === cases.length, prs: [], patterns };
  return { kind: 'attributed', all_green: false, prs: [...blamed].sort((a, b) => Number(a) - Number(b)), patterns };
}

function prefixResults(raw: unknown, sha: string, nonce: string, cases: string[]): { results: Record<string, PrefixResult>; cost: number } | null {
  const rec = raw as BisectPrefixRecord | null;
  if (!rec || rec.schema !== 1 || rec.kind !== 'train-bisect-prefix' || rec.nonce !== nonce || rec.prefix_sha !== sha || rec.checked_out_sha !== sha || !Array.isArray(rec.panels)) return null;
  const results: Record<string, PrefixResult> = {};
  let cost = 0;
  for (const p of rec.panels) {
    if (!cases.includes(p.case)) continue;
    cost += typeof p.cost_usd === 'number' ? p.cost_usd : 0;
    if (p.status === 'PASS') results[p.case] = 'green';
    else if (p.status === 'FAIL' && p.red_class === 'VERDICT') results[p.case] = 'red';
  }
  return { results, cost };
}

/** Collect a finished bisect dispatch's prefix artifacts into the ledger; a still-running one returns its run state. */
function collect(env: TrainEnv, slug: string, t: TrainRecord, b: BisectRecord, a: AttemptRecord): string | null {
  const view = a.run ? runView(env.ctx, slug, a.run.id) : null;
  if (!view) return 'unreadable through gh';
  if (view.status !== 'completed') return view.status;
  let got = 0;
  for (const index of a.prefixes) {
    const p = b.prefixes[index]!;
    const r = prefixResults(downloadJson(env.ctx, slug, a.run!.id, bisectArtifact(env.train.record_artifact, p.sha), path.join(trainDir(t.nonce), 'scratch')), p.sha, a.nonce, b.cases);
    if (!r) continue;
    Object.assign(p.results, r.results);
    b.spent_usd = Math.round((b.spent_usd + r.cost) * 100) / 100;
    got++;
  }
  Object.assign(a, { state: 'completed', detail: `collected ${got} of ${a.prefixes.length} prefix result(s)` });
  return null;
}

function bisectOutcome(env: TrainEnv, t: TrainRecord, b: BisectRecord): TrainOut {
  const c = classifyBisect(b.cases, b.prefixes.map(p => p.results), t.slots);
  b.outcome = { ...c, at: nowIso() };
  t.state = c.kind;
  effect(t, `bisect: ${c.kind}${c.prs.length ? ' #' + c.prs.join(',#') : ''}`);
  b.updated_at = nowIso();
  persist(env.ctx.repoRoot, [b], { remote: env.remote });
  save(env, t);
  const run = trainFile(t.nonce);
  const lines = [...Object.entries(c.patterns).map(([id, s]) => `PATTERN: ${id} ${s.split('').map((x, i) => `T${i}=${x}`).join(' ')}`), `BISECT: spent $${b.spent_usd.toFixed(2)} of cap $${b.spend_cap.toFixed(2)}`];
  if (c.kind === 'attributed') return outOk([...lines, `BISECT: ATTRIBUTED ${c.prs.map(p => '#' + p).join(',')}`], nextFor(t), run);
  if (c.kind === 'red-on-main') return outFailed({ code: 'QUEUE_TRAIN_RED_ON_MAIN', message: `${b.cases.join(', ')} red on every prefix, T0 (main) included` }, [...lines, 'BISECT: RED_ON_MAIN'], nextFor(t), run);
  return outFailed({ code: 'QUEUE_TRAIN_UNATTRIBUTED', message: c.all_green ? 'every prefix was green: the red is unattributed; recovery: the one preregistered rebuild' : 'the pattern is not monotone: recovery: a repair lane, then a changed train' },
    [...lines, `BISECT: UNATTRIBUTED (${c.all_green ? 'all green' : 'not monotone'})`], nextFor(t), run);
}

/** The commits a bisect tests: T0 and the plain prefixes, or for a stamped train T0 and S_1..S_k, the chain its gate ran. */
const bisectPrefixes = (t: TrainRecord) => t.stamped ? [t.prefixes[0]!, ...t.stamped] : t.prefixes;

/** Validate bisect inputs: red cases from the gate's own plan, every prefix an ancestor of train/<nonce>'s head. */
function bisectInputs(env: TrainEnv, t: TrainRecord, red: AttemptRecord): string | null {
  for (const id of red.red_cases) {
    if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(id) || !red.panels.some(p => p.case === id)) return `red case ${id} is not in the gate's plan`;
  }
  const ref = `refs/gstack/${t.branch}`;
  const f = git(env.ctx.repoRoot, ['fetch', '--no-tags', '-q', env.remote, `+refs/heads/${t.branch}:${ref}`]);
  if (!f.ok) return `cannot fetch ${t.branch}: ${f.err.slice(0, 120)}`;
  const tip = git(env.ctx.repoRoot, ['rev-parse', ref]).out;
  if (tip !== t.head) return `${t.branch} is at ${tip.slice(0, 12)}, not the recorded train head ${t.head.slice(0, 12)}`;
  for (const p of bisectPrefixes(t)) {
    if (!git(env.ctx.repoRoot, ['merge-base', '--is-ancestor', p.commit, tip]).ok) return `prefix T${p.index} ${p.commit.slice(0, 12)} is not an ancestor of ${t.branch}`;
  }
  return null;
}

/**
 * `train bisect`: resumable and spend-capped. Each run reconciles the earlier
 * dispatch by nonce, records every prefix result it published, then reserves
 * the remaining case×prefix trials at their recorded price (unknown at the
 * policy reservation) and launches only the prefixes that fit under the cap.
 */
export async function trainBisect(ctx: QueueContext, o: { train: string; spendCap: number; dryRun: boolean }): Promise<TrainOut> {
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  const t = findTrain(env, o.train);
  if (!t) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no train record ${o.train} here or in refs/notes/gstack-trains` }, [], `${Q} train status`, 'none');
  const run = trainFile(t.nonce);
  const red = gateAttempts(t).at(-1);
  if (!red || red.outcome !== 'RED') return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `bisect needs a red verdict; the train's last gate is ${red?.outcome ?? 'missing'}` }, [], nextFor(t), run);
  if (red.purpose === 'rebuild') return outRefused({ code: 'QUEUE_PROOF_MISSING', message: 'a rebuild\'s second red is not bisected again' }, [], nextFor(t), run);
  const prior = loadBisect(t.nonce);
  if (prior?.outcome) return bisectOutcome(env, t, prior);
  const bad = bisectInputs(env, t, red);
  if (bad) return outRefused({ code: 'QUEUE_TRAIN_PREFIX_INVALID', message: bad }, [], `${Q} train status --train ${t.nonce}`, run);
  const b: BisectRecord = prior ?? { schema: 1, kind: 'train-bisect', train: t.nonce, cases: red.red_cases, spend_cap: o.spendCap, spent_usd: 0,
    prefixes: bisectPrefixes(t).map(p => ({ index: p.index, sha: p.commit, results: {}, attempts: [] })), outcome: null, updated_at: nowIso() };
  b.spend_cap = o.spendCap;
  const slug = repoSlug(ctx);
  if (!slug) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: 'gh repo view could not name the repository' }, [], `${Q} train bisect --train ${t.nonce} --spend-cap ${o.spendCap}`, run);
  for (const a of attemptsOf(t).filter(x => x.purpose === 'bisect' && x.state !== 'completed' && x.state !== 'absent')) {
    if (a.state === 'dispatching' || a.state === 'unknown') {
      const hit = runForNonce(listDispatchRuns(a.workflow, execFor(ctx), slug, 100) ?? [], a.nonce);
      if (!hit) return unknownDispatch(t, a);
      Object.assign(a, { state: 'dispatched', run: asRun(hit) });
    }
    const waiting = collect(env, slug, t, b, a);
    save(env, t, a);
    persist(ctx.repoRoot, [b], { remote: env.remote });
    if (waiting) return outPending({ code: 'QUEUE_TRAIN_PENDING', message: `bisect run ${a.run?.id} is ${waiting}` }, [attemptLine(a)], `${Q} train bisect --train ${t.nonce} --spend-cap ${o.spendCap}`, run);
  }
  const pending = b.prefixes.filter(p => b.cases.some(c => !p.results[c]));
  if (!pending.length) return bisectOutcome(env, t, b);
  const perPrefix = b.cases.reduce((sum, id) => sum + casePrice(env, red, id), 0);
  const admitted: typeof pending = [];
  let reserved = b.spent_usd;
  for (const p of pending) if (reserved + perPrefix <= o.spendCap + 1e-9) { admitted.push(p); reserved += perPrefix; }
  const higher = Math.ceil((b.spent_usd + perPrefix * pending.length) * 100) / 100;
  const lines = [`BISECT: cases ${b.cases.join(',')} prefixes ${pending.map(p => 'T' + p.index).join(',')} need results; $${perPrefix.toFixed(2)} reserved per prefix; spent $${b.spent_usd.toFixed(2)}, cap $${o.spendCap.toFixed(2)}`,
    `BISECT: launch ${admitted.map(p => 'T' + p.index).join(',') || '(none)'}${admitted.length < pending.length ? `; ${pending.length - admitted.length} prefix(es) wait for a higher cap` : ''}`];
  if (o.dryRun) return outOk([...lines, 'DRY-RUN: nothing dispatched'], `${Q} train bisect --train ${t.nonce} --spend-cap ${o.spendCap}`, run);
  persist(ctx.repoRoot, [b], { remote: env.remote });
  if (!admitted.length) {
    return outPending({ code: 'QUEUE_TRAIN_BISECT_CAPPED', message: `the next prefix needs $${perPrefix.toFixed(2)}; $${(o.spendCap - b.spent_usd).toFixed(2)} of the cap is left; the outcome stays unattributed` }, lines,
      `${Q} train bisect --train ${t.nonce} --spend-cap ${higher.toFixed(2)}`, run);
  }
  const nonce = makeNonce('gate', t.head, t.base.sha, randomBytes(3).toString('hex'), { purpose: 'bisect' });
  const a = await dispatchAttempt(env, slug, t, 'bisect', { workflow: env.train.gate_workflow, inputs: {
    [DISPATCH_INPUTS.cases]: b.cases.join(','), [DISPATCH_INPUTS.prefixShas]: admitted.map(p => p.sha).join(','),
    [DISPATCH_INPUTS.expectedSha]: t.head, [DISPATCH_INPUTS.nonce]: nonce,
  } }, admitted.map(p => p.index));
  for (const p of admitted) p.attempts.push(a.id);
  b.updated_at = nowIso();
  persist(ctx.repoRoot, [b], { remote: env.remote });
  if (a.state !== 'dispatched') return unknownDispatch(t, a);
  lines.push(attemptLine(a));
  if (admitted.length < pending.length) {
    return outPending({ code: 'QUEUE_TRAIN_BISECT_CAPPED', message: `${pending.length - admitted.length} prefix(es) are past the cap; completed prefixes are kept and the outcome stays unattributed` }, lines,
      `${Q} train bisect --train ${t.nonce} --spend-cap ${higher.toFixed(2)}`, run);
  }
  return outOk(lines, `${Q} train bisect --train ${t.nonce} --spend-cap ${o.spendCap} (collects run ${a.run?.id} once it finishes)`, run);
}

/**
 * `train rebuild`: the unchanged train dispatched once more. Without
 * `--infra`, only after an all-green bisect and only once (rebuild-once);
 * with `--infra`, only after an INFRA/INCOMPLETE-only census and at most
 * EVAL_POLICY.infraRedispatch times. Both runs stay in the record.
 */
export async function trainRebuild(ctx: QueueContext, o: { train: string; infra: boolean }): Promise<TrainOut> {
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  const t = findTrain(env, o.train);
  if (!t) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no train record ${o.train} here or in refs/notes/gstack-trains` }, [], `${Q} train status`, 'none');
  const run = trainFile(t.nonce);
  const gates = gateAttempts(t);
  const last = gates.at(-1);
  const repair = `route ${last?.red_cases.join(',') || 'the red cases'} to a repair lane (GStack Minder); the train is rebuilt only once the repair merges: ${Q} train build ${prsArgs(t.slots, t.explicit_order)}`;
  const refuse = (reason: string) => outRefused({ code: 'QUEUE_TRAIN_REBUILD_REFUSED', message: `rebuild refused: ${reason}` }, gates.map(attemptLine), repair, run);
  if (o.infra) {
    if (!last || last.outcome !== 'INCOMPLETE' || !last.infra_eligible) return refuse(`no INFRA/INCOMPLETE-only record (the last gate is ${last?.outcome ?? 'missing'})`);
    if (gates.filter(a => a.purpose === 'infra-redispatch').length >= INFRA_REDISPATCH) return refuse('already re-dispatched once (EVAL_POLICY.infraRedispatch)');
  } else {
    const b = loadBisect(t.nonce);
    if (!b?.outcome) return refuse('no bisect record');
    if (gates.filter(a => a.purpose === 'rebuild').length >= REBUILD_ONCE) return refuse('already rebuilt once');
    if (b.outcome.kind !== 'unattributed' || !b.outcome.all_green) return refuse(`the bisect was not all green (${Object.entries(b.outcome.patterns).map(([c, s]) => `${c}=${s}`).join(' ')})`);
  }
  const tip = remoteBranchSha(args => git(ctx.repoRoot, args), env.remote, t.branch);
  if (tip !== t.head) return outRefused({ code: 'QUEUE_TRAIN_MOVED', message: `${t.branch} is at ${tip?.slice(0, 12) ?? 'nothing'}, not the recorded head ${t.head.slice(0, 12)}` }, [], `${Q} train build ${prsArgs(t.slots, t.explicit_order)}`, run);
  const slug = repoSlug(ctx);
  if (!slug) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: 'gh repo view could not name the repository' }, [], `${Q} train rebuild --train ${t.nonce}${o.infra ? ' --infra' : ''}`, run);
  const a = await dispatchAttempt(env, slug, t, o.infra ? 'infra-redispatch' : 'rebuild', gateDispatch(env, t, `${t.nonce}.${gates.length + 1}`));
  t.state = a.state === 'dispatched' ? 'gate-pending' : 'dispatch-unknown';
  save(env, t);
  if (a.state !== 'dispatched') return unknownDispatch(t, a);
  return outOk([...gateAttempts(t).map(attemptLine), `REBUILD: ${a.purpose} of the unchanged train ${t.nonce} (head ${t.head.slice(0, 12)}); both runs are reported`], nextFor(t), run);
}
