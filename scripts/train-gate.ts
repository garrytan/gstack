/**
 * The merge-train side of evals.yml (plan GSTA-49 lane T1b;
 * docs/ship-policy.md#run-a-merge-train). gstack-ship-queue (lib/ship-queue-train*.ts)
 * dispatches the runs and reads what they publish; this file is the workflow's half.
 *
 *   route          (route job, dispatches) names the run's mode and validates
 *                  its inputs: a screen needs a PR, its pinned merge SHA and a
 *                  policy; a bisect needs case ids from the full gate's own plan
 *                  and prefix SHAs that are ancestors of the train head on
 *                  train/<nonce>. Anything else is refused before any spend.
 *   bisect-plan    (plan-slices) one executor per prefix, each expecting its SHA.
 *   bisect-prefix  (eval-slices) one prefix: every red case once, one trial,
 *                  written as the per-prefix record `train bisect` reads.
 *   train-record   (slices-report, train runs) the green-train record: the census
 *                  from the run's own plan manifest, one panel per planned case,
 *                  and the prefix trees T1..Tk modulo stamps. GREEN only for a
 *                  complete census: every planned case executed and passed, no
 *                  unbound result, partial or cancelled shard, or slice killed
 *                  before its upload step.
 *   screen-summary (plan-slices, PR runs under a train policy) the screening
 *                  selection and its estimated cost; no paid case runs.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeChangelog } from '../lib/changelog-check';
import { normalizeLockfile } from '../lib/evidence-bundle';
import { stampMentions, rewriteStamps, versionAtRef } from '../lib/restamp';
import { loadPolicyFromHead, matchesAny, type ShipPolicy } from '../lib/ship-policy';
import type { BisectPrefixRecord, TrainGateRecord } from '../lib/ship-queue-train-verdict';
import type { CasePanel } from '../lib/ship-queue-train-record';
import { E2E_TIERS, LLM_JUDGE_TOUCHFILES } from '../test/helpers/touchfiles-data';
import { panelVerdict } from '../test/helpers/eval-store';
import { UNRECORDED_SHARD_MS, nonceScope, plannedSerialMs } from './eval-bg';
import { caseTrialPlan, fileCaseRegistration, shardCaseId, shardFile } from './lib/paid-cases';
import { buildRunManifest, loadPaidTestDurations, parseRunManifest, recordedShardMs, type PaidRunManifest } from './lib/paid-plan';
import { loadSliceArtifacts } from './lib/paid-report';
import type { FlakeRecord } from './lib/paid-rerun';
import { paidSelectionEnv } from './lib/paid-select';
import { ROOT } from './lib/paid-types';

const SHA = /^[0-9a-f]{40}$/;
const CASE_ID = /^[A-Za-z0-9 _.:/-]{1,128}$/;
export const JUDGE_FILE = 'test/skill-llm-eval.test.ts';
/** T1 caps a train at 6 PRs, so a bisect has at most 7 prefixes (T0..T6). */
export const MAX_PREFIXES = 7;
export const MAX_BISECT_CASES = 40;
/** A full gate's recorded cost (MEASUREMENT.md: $90.93 to $94.70; lib/gate-cost.ts uses the same scale). */
export const FULL_GATE_USD = 93.14;
/** T1's prefix commits: `train T<i>: merge #<pr> at <sha12>` (lib/ship-queue-train.ts buildChain). */
const PREFIX_SUBJECT = /^train (?:T(\d+): merge #(\d+) at [0-9a-f]{12}|S(\d+): merge #(\d+) at [0-9a-f]{12} v[0-9.]+)$/;

export type Git = (args: string[]) => { ok: boolean; out: string };
export const gitIn = (cwd: string): Git => (args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? { ok: true, out: (r.stdout ?? '').replace(/\n$/, '') } : { ok: false, out: (r.stderr || String(r.error ?? '')).trim() };
};

export type RunMode = 'screen' | 'train' | 'bisect' | 'dispatch';
export interface RouteInput {
  nonce: string; refName: string; head: string; expectedSha: string; evalsAll: boolean; trainPolicy: boolean;
  cases: string; prefixShas: string; screenPr: string; screenMergeSha: string; screenPolicy: string;
}
export interface Route { mode: RunMode; cases: string[]; prefixes: string[] }

const list = (text: string) => text.split(',').map(item => item.trim()).filter(Boolean);

/**
 * The run's mode from a dispatch's inputs, or why it is refused. Screens,
 * trains and bisects exist only under a train policy; a bisect's case ids must
 * be in the full gate's plan and each prefix an ancestor of the train head.
 */
export function routeDispatch(i: RouteInput, deps: { isAncestor(commit: string, head: string): boolean; gateCases(): Map<string, string> }): Route | { error: string } {
  const scope = i.nonce ? nonceScope(i.nonce) : null;
  const trainOnly = (mode: string) => (i.trainPolicy ? null : { error: `a ${mode} dispatch needs a train block in the default branch's .gstack/ship-policy.json` });
  if (i.screenPr || i.screenMergeSha || i.screenPolicy) {
    if (!/^[1-9]\d{0,8}$/.test(i.screenPr)) return { error: `screen_pr ${JSON.stringify(i.screenPr)} is not a PR number` };
    if (!SHA.test(i.screenMergeSha)) return { error: `screen_merge_sha ${JSON.stringify(i.screenMergeSha)} is not a full commit SHA` };
    if (i.screenPolicy !== 'narrow' && i.screenPolicy !== 'broad') return { error: `screen_policy ${JSON.stringify(i.screenPolicy)} is not narrow or broad` };
    if (i.cases || i.prefixShas) return { error: 'a screen takes no cases or prefix_shas' };
    if (i.evalsAll) return { error: 'a screen runs the PR selection: dispatch it with evals_all=false' };
    if (i.expectedSha && i.expectedSha !== i.screenMergeSha) return { error: `expected_sha ${i.expectedSha.slice(0, 12)} is not the screen's merge SHA ${i.screenMergeSha.slice(0, 12)}` };
    if (scope && (scope.purpose !== 'screen' || scope.policy !== i.screenPolicy)) return { error: `nonce ${i.nonce} is not a ${i.screenPolicy} screen nonce` };
    return trainOnly('screen') ?? { mode: 'screen', cases: [], prefixes: [] };
  }
  if (i.cases || i.prefixShas || scope?.purpose === 'bisect') {
    const cases = list(i.cases);
    const prefixes = list(i.prefixShas);
    if (scope?.purpose !== 'bisect') return { error: `a bisect needs a bisect nonce (got ${JSON.stringify(i.nonce)})` };
    if (!i.refName.startsWith('train/')) return { error: `a bisect runs on train/<nonce>, not ${i.refName}` };
    if (i.expectedSha !== i.head) return { error: `expected_sha ${i.expectedSha.slice(0, 12) || '(empty)'} is not the train head ${i.head.slice(0, 12)} checked out from ${i.refName}` };
    if (!cases.length || cases.length > MAX_BISECT_CASES || new Set(cases).size !== cases.length) return { error: `cases must name 1 to ${MAX_BISECT_CASES} distinct case ids` };
    if (!prefixes.length || prefixes.length > MAX_PREFIXES || new Set(prefixes).size !== prefixes.length) return { error: `prefix_shas must name 1 to ${MAX_PREFIXES} distinct commits` };
    const bad = prefixes.find(sha => !SHA.test(sha));
    if (bad) return { error: `prefix ${JSON.stringify(bad)} is not a full commit SHA` };
    const outside = prefixes.find(sha => !deps.isAncestor(sha, i.head));
    if (outside) return { error: `prefix ${outside.slice(0, 12)} is not an ancestor of the train head ${i.head.slice(0, 12)} on ${i.refName}` };
    const plan = deps.gateCases();
    const unknown = cases.filter(id => !CASE_ID.test(id) || !plan.has(id));
    if (unknown.length) return { error: `case(s) not in the full gate's plan: ${unknown.slice(0, 5).join(', ')}` };
    return trainOnly('bisect') ?? { mode: 'bisect', cases, prefixes };
  }
  if (scope?.purpose === 'train') {
    if (!i.refName.startsWith('train/')) return { error: `a train gate runs on train/<nonce>, not ${i.refName}` };
    if (!i.evalsAll) return { error: 'a train gate is the full gate: dispatch it with evals_all=true' };
    if (i.expectedSha !== i.head) return { error: `expected_sha ${i.expectedSha.slice(0, 12) || '(empty)'} is not the train head ${i.head.slice(0, 12)}` };
    return trainOnly('train') ?? { mode: 'train', cases: [], prefixes: [] };
  }
  return { mode: 'dispatch', cases: [], prefixes: [] };
}

/** Every case a plan manifest plans, with its kind: the census a complete gate must execute. */
export function plannedCases(manifest: PaidRunManifest, rootDir = ROOT): Map<string, string> {
  const cases = new Map<string, string>();
  const e2e = manifest.selection?.e2e ?? null;
  for (const entry of manifest.entries.filter(item => item.status === 'planned')) {
    const file = shardFile(entry.file);
    if (entry.trial) { cases.set(shardCaseId(entry.file)!, entry.trial.kind); continue; }
    if (file === JUDGE_FILE) { for (const id of manifest.selection?.judges ?? Object.keys(LLM_JUDGE_TOUCHFILES)) cases.set(id, 'judge'); continue; }
    const only = shardCaseId(entry.file);
    const source = fs.readFileSync(path.join(rootDir, file), 'utf8');
    for (const id of fileCaseRegistration(file, source).registered) {
      if (E2E_TIERS[id] === manifest.tier && (only === null || id === only) && (e2e === null || e2e.includes(id)) && !(entry.excludeCases ?? []).includes(id)) cases.set(id, 'rule');
    }
  }
  return cases;
}

/** The full gate's planned cases on this checkout (what a bisect may name). */
export function fullGateCases(rootDir = ROOT): Map<string, string> {
  return plannedCases(buildRunManifest({ tier: 'gate', profile: 'full', sliceCount: 1, evalsAll: true, env: { EVALS_ALL: '1' }, rootDir }), rootDir);
}

/**
 * A release output or stamp path without its stamps: every version mentioned
 * in a stamp form (the built-in forms and the policy's `stamp_patterns`
 * templates) collapses to one placeholder. Normalising only the commit's own
 * version left a tentative `*_KEY_VERSION = '<next minor>'` as written on the
 * unstamped prefix and normalised once the slot stamp moved it to the released
 * version, so the two digests differed and train-backstop found no covering
 * record for main after that train (#3512), and a base-version mention on a
 * line the base already carried was normalised on the prefix and kept on the
 * stamped main. Every stamp-form mention collapsing makes the digest blind to
 * which version a stamp names; the receipt (`stampOnlyLine`) is what judges a
 * stamp commit's content.
 */
export function stampFreeText(text: string, templates: readonly string[]): string {
  let out = text;
  for (const v of [...stampMentions(text, templates)].sort((a, b) => b.length - a.length)) out = rewriteStamps(out, v, '\0VERSION', templates).text;
  return out;
}

/**
 * A commit's tree modulo stamps: every path with its mode and blob, except the
 * files a restamp rewrites, which contribute their content without the stamp
 * (the version file nothing, package.json without its version, lockfiles
 * without their root version, the CHANGELOG with its headings normalized,
 * release outputs and stamp paths with every stamp-form version mention
 * replaced). Two commits that differ only by a restamp have the same digest.
 */
export function stampFreeTree(git: Git, commit: string, repoRoot: string, policy: ShipPolicy): string | { error: string } {
  const listed = git(['ls-tree', '-r', '-z', '--full-tree', commit]);
  if (!listed.ok) return { error: `cannot list ${commit.slice(0, 12)} (${listed.out.split('\n')[0]})` };
  const at = versionAtRef(repoRoot, commit);
  const versionRel = 'rel' in at ? at.rel : 'VERSION';
  const lines: string[] = [];
  for (const item of listed.out.split('\0').filter(Boolean)) {
    const [meta, rel] = [item.slice(0, item.indexOf('\t')), item.slice(item.indexOf('\t') + 1)];
    const [mode, , blob] = meta.split(' ') as [string, string, string];
    const base = path.basename(rel);
    const stamp = rel === versionRel ? 'version' : base === 'package.json' ? 'manifest' : ['bun.lock', 'package-lock.json', 'npm-shrinkwrap.json'].includes(base) ? 'lockfile'
      : rel === policy.changelog ? 'changelog' : matchesAny([...policy.stamp_paths, ...policy.release_outputs, ...policy.stamp_files], rel) ? 'release' : null;
    if (!stamp) { lines.push(`${rel}\0${mode}\0${blob}`); continue; }
    if (stamp === 'version') { lines.push(`${rel}\0${mode}\0(version)`); continue; }
    const shown = git(['cat-file', 'blob', blob]);
    if (!shown.ok) return { error: `cannot read ${rel} at ${commit.slice(0, 12)}` };
    let text = shown.out;
    if (stamp === 'manifest') { try { const parsed = JSON.parse(text); delete parsed.version; text = JSON.stringify(parsed); } catch { /* not JSON: kept verbatim */ } }
    else if (stamp === 'lockfile') text = normalizeLockfile(base, text);
    else if (stamp === 'changelog') text = normalizeChangelog(text);
    else text = stampFreeText(text, policy.stamp_patterns);
    lines.push(`${rel}\0${mode}\0${createHash('sha256').update(text).digest('hex')}`);
  }
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

/** `exact`: a stamped prefix S_i (changelog_fragments trains), which covers only its exact tree. */
export interface TrainPrefixTree { index: number; commit: string; tree: string; stamp_free_tree: string; exact?: true }

/** T1..Tk (or stamped S1..Sk, never mixed) from the train head, walking first parents over the prefix commits. */
export function trainPrefixes(git: Git, head: string, repoRoot: string, policy: ShipPolicy): TrainPrefixTree[] | { error: string } {
  const log = git(['log', '--first-parent', `--max-count=${MAX_PREFIXES}`, '--format=%H%x00%P%x00%s', head]);
  if (!log.ok) return { error: `cannot walk ${head.slice(0, 12)}'s first parents (${log.out.split('\n')[0]})` };
  const found: TrainPrefixTree[] = [];
  for (const line of log.out.split('\n')) {
    const [commit, parents, subject] = line.split('\0') as [string, string, string];
    const m = PREFIX_SUBJECT.exec(subject ?? '');
    if (!m || parents.split(' ').length !== 2) break;
    const index = Number(m[1] ?? m[3]);
    const exact = m[3] !== undefined;
    if (found.length && exact !== !!found[0]!.exact) return { error: `${commit.slice(0, 12)} mixes stamped and plain prefixes` };
    if (found.length && index !== found.at(-1)!.index - 1) return { error: `prefix T${index} follows T${found.at(-1)!.index} at ${commit.slice(0, 12)}` };
    const digest = stampFreeTree(git, commit, repoRoot, policy);
    if (typeof digest !== 'string') return digest;
    found.push({ index, commit, tree: git(['rev-parse', `${commit}^{tree}`]).out, stamp_free_tree: digest, ...(exact ? { exact: true as const } : {}) });
  }
  if (!found.length || found.at(-1)!.index !== 1) return { error: `${head.slice(0, 12)} is not a train head (no T1..Tk prefix chain)` };
  return found.reverse();
}

interface OutcomeLine { case?: string; kind?: string; attempt?: number; outcome?: string; failure_class?: string; cost_usd?: number; cost_known?: boolean; execution?: string }
interface CollectorPanel { case: string; status: string; redClass: string | null }

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

/** One panel per planned case from the run's trial outcomes (trial panels from the collector's panelVerdict). */
function casePanels(planned: Map<string, string>, outcomes: OutcomeLine[], collector: CollectorPanel[], flaky: FlakeRecord[] = []): CasePanel[] {
  return [...planned].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, kind]) => {
    const mine = outcomes.filter(o => o.case === id && o.execution !== 'reused');
    const cost = mine.length && mine.every(o => o.cost_known !== false && typeof o.cost_usd === 'number')
      ? Math.round(mine.reduce((sum, o) => sum + o.cost_usd!, 0) * 10_000) / 10_000 : null;
    // Rule 16: the report resolved this case FLAKY (failed once, passed its one rerun): a PASS that names both runs.
    const flake = flaky.find(f => f.case === id);
    if (flake) return { case: id, kind, status: 'PASS', red_class: null, cost_usd: cost, flaky: { first: flake.first.where, rerun: flake.rerun.where } };
    const panel = collector.find(p => p.case === id);
    if (panel) return { case: id, kind, status: panel.status, red_class: panel.redClass, cost_usd: cost };
    const failed = mine.filter(o => o.outcome === 'failed');
    if (failed.length) return { case: id, kind, status: 'FAIL', red_class: failed.every(o => o.failure_class === 'infra') ? 'INFRA' : 'VERDICT', cost_usd: cost };
    if (mine.some(o => o.outcome === 'passed')) return { case: id, kind, status: 'PASS', red_class: null, cost_usd: cost };
    return { case: id, kind, status: mine.length ? 'SKIPPED' : 'MISSING', red_class: 'INCOMPLETE', cost_usd: cost };
  });
}

export type TrainRecord = TrainGateRecord & { run: { id: number; attempt: number; url: string }; prefixes: TrainPrefixTree[] };

/** The green-train record a train's own run publishes (T1's TrainGateRecord plus the run and the prefix trees). */
export function buildTrainRecord(o: { reportDir: string; nonce: string; head: string; tree: string; reconcileExit: number; rootDir?: string;
  prefixes: TrainPrefixTree[]; run: TrainRecord['run'] }): TrainRecord {
  const manifest = parseRunManifest(fs.readFileSync(path.join(o.reportDir, 'manifest.json'), 'utf8'));
  const planned = plannedCases(manifest, o.rootDir);
  let lines: OutcomeLine[] = [];
  try { lines = fs.readFileSync(path.join(o.reportDir, 'trial-outcomes.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as OutcomeLine); } catch { lines = []; }
  const primary = Math.min(...lines.map(l => l.attempt ?? 1), Infinity);
  const collector = readJson<{ verdict?: { verdict?: string }; census?: { unattributed?: unknown[] }; panels?: CollectorPanel[]; flaky?: FlakeRecord[] }>(path.join(o.reportDir, 'collector-outcomes.json'));
  const panels = casePanels(planned, lines.filter(l => (l.attempt ?? 1) === primary), collector?.panels ?? [], collector?.flaky ?? []);
  const artifacts = loadSliceArtifacts(o.reportDir);
  const first = Math.min(...artifacts.map(a => a.result.attempt ?? 1), Infinity);
  const results = artifacts.filter(a => (a.result.attempt ?? 1) === first).map(a => a.result);
  const reportedSlices = new Set(results.map(r => r.sliceIndex));
  const reportedFiles = new Set(results.flatMap(r => r.outcomes.flatMap(outcome => outcome.files)));
  const count = (judge: boolean, from: Iterable<[string, string]>) => [...from].filter(([, kind]) => (kind === 'judge') === judge).length;
  const executed = panels.filter(p => p.status === 'PASS' || p.status === 'FAIL').map(p => [p.case, p.kind] as [string, string]);
  const census = {
    complete: false,
    planned: { rule: count(false, planned), judge: count(true, planned) },
    executed: { rule: count(false, executed), judge: count(true, executed) },
    unbound: collector?.census?.unattributed?.length ?? 0,
    partial_shards: results.filter(r => r.checkpoint).length,
    cancelled_shards: manifest.entries.filter(e => e.status === 'planned' && reportedSlices.has(e.slice) && !reportedFiles.has(e.file)).length,
    killed_before_upload: Array.from({ length: manifest.sliceCount }, (_, i) => i + 1).filter(index => !reportedSlices.has(index)).length,
  };
  census.complete = o.reconcileExit === 0 && !!collector && planned.size > 0 && census.executed.rule === census.planned.rule
    && census.executed.judge === census.planned.judge && !census.unbound && !census.partial_shards && !census.cancelled_shards
    && !census.killed_before_upload && panels.every(p => p.status === 'PASS');
  const verdict = census.complete && collector?.verdict?.verdict === 'GREEN' ? 'GREEN' : 'RED';
  return { schema: 1, kind: 'train-gate', nonce: o.nonce, head_sha: o.head, tree: o.tree, verdict, census, panels, run: o.run, prefixes: o.prefixes };
}

export interface BisectPlan { schema: 1; nonce: string; cases: Array<{ id: string; kind: string }>; prefixes: string[] }

/** One executor per prefix; each case runs one trial (and at most one rule-16 rerun inside its 30 minutes), so a slice's ceiling grows with the case count. */
export function bisectMatrix(plan: BisectPlan): { slices: number[]; timeouts: number[]; refs: string[] } {
  const minutes = Math.min(350, 20 + 30 * plan.cases.length);
  return { slices: plan.prefixes.map((_, i) => i + 1), timeouts: [0, ...plan.prefixes.map(() => minutes)], refs: ['', ...plan.prefixes] };
}

export type CaseRunner = (id: string, kind: string, evalDir: string) => Promise<{ status: string; redClass: string | null }>;

/**
 * Run every red case once on the checked-out prefix; a case that leaves no
 * verdict is INCOMPLETE (T1 relaunches it). Rule 16 holds here as in the
 * gate: a case verdict that fails (red class VERDICT) reruns once on the same
 * prefix; passing makes it a flaky PASS naming both runs, failing again keeps
 * it red. INFRA and INCOMPLETE are never rerun.
 */
export async function runBisectPrefix(plan: BisectPlan, index: number, o: { rootDir: string; evalDir: string; checkedOut: string; runCase?: CaseRunner }): Promise<BisectPrefixRecord> {
  const sha = plan.prefixes[index - 1];
  if (!sha) throw new Error(`bisect slice ${index} names no prefix (${plan.prefixes.length} planned)`);
  if (o.checkedOut !== sha) throw new Error(`bisect slice ${index} checked out ${o.checkedOut.slice(0, 12)}, not its prefix ${sha.slice(0, 12)}`);
  const runCase = o.runCase ?? ((id, kind, evalDir) => runOneTrial(id, kind, evalDir, o.rootDir));
  const panels: CasePanel[] = [];
  for (const c of plan.cases) {
    const dir = path.join(o.evalDir, c.id.replace(/[^A-Za-z0-9._-]/g, '_'));
    const run = async (evalDir: string): Promise<{ status: string; redClass: string | null }> => {
      try { return await runCase(c.id, c.kind, evalDir); }
      catch (error) { console.error(`[train-gate] ${c.id}: ${error instanceof Error ? error.message : String(error)}`); return { status: 'INCOMPLETE', redClass: 'INCOMPLETE' }; }
    };
    const verdict = await run(dir);
    const rerun = verdict.status === 'FAIL' && verdict.redClass === 'VERDICT' ? await run(`${dir}.rerun`) : null;
    const flaky = rerun?.status === 'PASS';
    const final = flaky ? rerun! : verdict;
    panels.push({ case: c.id, kind: c.kind, status: final.status, red_class: final.redClass, cost_usd: null,
      ...(flaky ? { flaky: { first: `prefix ${sha.slice(0, 12)} slice ${index}`, rerun: `prefix ${sha.slice(0, 12)} slice ${index} rerun` } } : {}) });
    console.log(`[train-gate] prefix ${sha.slice(0, 12)} (slice ${index}): ${c.id} ${verdict.status}${verdict.redClass ? ` (${verdict.redClass})` : ''}`
      + `${rerun ? `; rule-16 rerun ${rerun.status}${rerun.redClass ? ` (${rerun.redClass})` : ''}${flaky ? ': FLAKY, counted as PASS' : ': failed twice, red'}` : ''}`);
  }
  return { schema: 1, kind: 'train-bisect-prefix', nonce: plan.nonce, prefix_sha: sha, checked_out_sha: o.checkedOut, panels };
}

/** One trial of one case exactly as CI runs it: E2E cases through the panel runner, a judge through its file with only it selected. */
async function runOneTrial(id: string, kind: string, evalDir: string, rootDir: string): Promise<{ status: string; redClass: string | null }> {
  const { runPaidShards } = await import('./test-paid-shards');
  if (kind !== 'judge') {
    const { runCaseDiagnosis } = await import('./lib/paid-report');
    const v = await runCaseDiagnosis(id, { trials: 1, jobs: 1, rootDir, evalDirBase: evalDir, runShards: runPaidShards });
    return { status: v.status, redClass: v.redClass };
  }
  const env = { ...process.env, EVALS: '1', EVALS_TIER: 'gate', EVALS_PREFLIGHT_OK: '1', EVALS_ALL: '1', ...paidSelectionEnv('full', { e2e: [], judges: [id] }, 'train bisect') };
  const [outcome] = (await runPaidShards([[JUDGE_FILE]], { jobs: 1, rootDir, env, evalDirBase: evalDir })).outcomes;
  const trials = outcome && outcome.runnerError === undefined && ['passed', 'failed', 'timed-out'].includes(outcome.status)
    ? [{ trial: 1, outcome: outcome.status === 'passed' ? 'passed' as const : 'failed' as const,
      ...(outcome.status === 'passed' ? {} : { failure_class: outcome.status === 'timed-out' ? 'timeout' as const : 'assertion' as const }) }] : [];
  const v = panelVerdict({ case: id, kind: 'judge', panel: { n: 1, k: 1 }, trials, quarantined: caseTrialPlan(id).quarantined });
  return { status: v.status, redClass: v.redClass };
}

/** The free summary of a PR push under a train policy: how to ask for the screen, then its selection and estimated cost. */
export function screenSummary(manifest: PaidRunManifest, pr: string, rootDir = ROOT): string[] {
  const planned = plannedCases(manifest, rootDir);
  const recorded = loadPaidTestDurations(rootDir, manifest.tier);
  const serial = manifest.entries.filter(e => e.status === 'planned').reduce((sum, e) => sum + (recordedShardMs(recorded, e.file) ?? UNRECORDED_SHARD_MS), 0);
  const full = plannedSerialMs('gate', rootDir);
  const usd = full > 0 ? Math.min(FULL_GATE_USD, FULL_GATE_USD * serial / full) : null;
  const judges = [...planned.values()].filter(kind => kind === 'judge').length;
  return [
    `To run the paid screen of this head: \`gstack-ship-queue ready --pr ${pr} --screen\` (add \`--broad\` for today's full PR selection). PR pushes start no paid slices under this repository's train policy; the train's full gate covers every merge.`,
    `- Screening selection: ${planned.size - judges} case(s) + ${judges} judge(s), PR coverage mode \`${manifest.prCoverage?.mode ?? 'broad'}\``,
    `- Estimated screen cost: ${usd === null ? 'unknown' : `~$${usd.toFixed(2)}`} (recorded shard durations scaled to the $${FULL_GATE_USD} full gate; shards without a recorded duration count ${UNRECORDED_SHARD_MS / 60_000} min). No paid case ran on this push.`,
  ];
}

const USAGE = `usage:
  bun run scripts/train-gate.ts route --github-output <file>   (inputs from the route job's env)
  bun run scripts/train-gate.ts bisect-plan --cases <ids> --prefixes <shas> --nonce <nonce> --out <bisect.json> [--github-output <file>]
  bun run scripts/train-gate.ts bisect-prefix --plan <bisect.json> --index <n> --out <dir>
  bun run scripts/train-gate.ts train-record <report dir> --nonce <nonce> --head <sha> --reconcile-exit <n> --run-id <id> --run-attempt <n> --repo <owner/name> --out <file>
  bun run scripts/train-gate.ts screen-summary <manifest.json> --pr <n>`;

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const fail = (message: string): never => { console.error(`::error::${message}`); process.exit(1); };
  const usage = (): never => { console.error(USAGE); process.exit(2); };
  const output = (lines: string[]) => { const file = flag('github-output'); if (file) fs.appendFileSync(file, `${lines.join('\n')}\n`); };
  const git = gitIn(process.cwd());
  if (command === 'route') {
    const env = process.env;
    const route = routeDispatch({ nonce: env.NONCE ?? '', refName: env.GITHUB_REF_NAME ?? '', head: git(['rev-parse', 'HEAD']).out, expectedSha: env.EXPECTED_SHA ?? '',
      evalsAll: env.EVALS_ALL === 'true', trainPolicy: env.TRAIN_POLICY === 'true', cases: env.CASES ?? '', prefixShas: env.PREFIX_SHAS ?? '',
      screenPr: env.SCREEN_PR ?? '', screenMergeSha: env.SCREEN_MERGE_SHA ?? '', screenPolicy: env.SCREEN_POLICY ?? '' },
    { isAncestor: (commit, head) => git(['merge-base', '--is-ancestor', commit, head]).ok, gateCases: () => fullGateCases(process.cwd()) });
    if ('error' in route) fail(`dispatch refused before any paid work: ${route.error}`);
    const ok = route as Route;
    output([`mode=${ok.mode}`, `cases=${ok.cases.join(',')}`, `prefixes=${ok.prefixes.join(',')}`]);
    console.log(`- Run mode: ${ok.mode}${ok.prefixes.length ? ` (${ok.cases.length} case(s) on ${ok.prefixes.length} prefix(es))` : ''}`);
  } else if (command === 'bisect-plan') {
    const [cases, prefixes, nonce, out] = [list(flag('cases') ?? ''), list(flag('prefixes') ?? ''), flag('nonce'), flag('out')];
    if (!cases.length || !prefixes.length || !nonce || !out) usage();
    const plan = fullGateCases(process.cwd());
    const bisect: BisectPlan = { schema: 1, nonce: nonce!, cases: cases.map(id => ({ id, kind: plan.get(id) ?? fail(`case ${id} is not in the full gate's plan`) })), prefixes };
    fs.mkdirSync(path.dirname(out!), { recursive: true });
    fs.writeFileSync(out!, `${JSON.stringify(bisect, null, 2)}\n`);
    const m = bisectMatrix(bisect);
    output([`slices=${JSON.stringify(m.slices)}`, `slice_timeouts=${JSON.stringify(m.timeouts)}`, `prefix_refs=${JSON.stringify(m.refs)}`]);
    console.log(`- Bisect: ${cases.length} case(s) x ${prefixes.length} prefix(es), one trial each`);
  } else if (command === 'bisect-prefix') {
    const [planPath, index, out] = [flag('plan'), Number(flag('index')), flag('out')];
    if (!planPath || !Number.isSafeInteger(index) || index < 1 || !out) usage();
    const plan = readJson<BisectPlan>(planPath!) ?? fail(`unreadable bisect plan ${planPath}`);
    const record = await runBisectPrefix(plan, index, { rootDir: process.cwd(), evalDir: path.join(out!, 'eval'), checkedOut: git(['rev-parse', 'HEAD']).out });
    fs.mkdirSync(out!, { recursive: true });
    fs.writeFileSync(path.join(out!, 'bisect-prefix.json'), `${JSON.stringify(record, null, 2)}\n`);
  } else if (command === 'train-record') {
    const [reportDir, nonce, head, repo, out] = [rest[0], flag('nonce'), flag('head'), flag('repo'), flag('out')];
    if (!reportDir || !nonce || !head || !SHA.test(head) || !repo || !out) usage();
    const prefixes = trainPrefixes(git, head!, process.cwd(), loadPolicyFromHead(process.cwd()).policy);
    if ('error' in prefixes) fail(`no train record: ${prefixes.error}`);
    const runId = Number(flag('run-id'));
    const record = buildTrainRecord({ reportDir: reportDir!, nonce: nonce!, head: head!, tree: git(['rev-parse', `${head}^{tree}`]).out,
      reconcileExit: /^\d+$/.test(flag('reconcile-exit') ?? '') ? Number(flag('reconcile-exit')) : -1, prefixes: prefixes as TrainPrefixTree[],
      run: { id: runId, attempt: Number(flag('run-attempt')), url: `https://github.com/${repo}/actions/runs/${runId}` } });
    fs.mkdirSync(path.dirname(out!), { recursive: true });
    fs.writeFileSync(out!, `${JSON.stringify(record, null, 2)}\n`);
    const c = record.census;
    console.log(`- Train record: ${record.verdict} (rule ${c.executed.rule}/${c.planned.rule}, judge ${c.executed.judge}/${c.planned.judge}, unbound ${c.unbound}, partial ${c.partial_shards}, cancelled ${c.cancelled_shards}, killed before upload ${c.killed_before_upload}); prefixes T1..T${record.prefixes.length}`);
  } else if (command === 'screen-summary') {
    const [manifestPath, pr] = [rest[0], flag('pr')];
    if (!manifestPath || !pr) usage();
    for (const line of screenSummary(parseRunManifest(fs.readFileSync(manifestPath!, 'utf8')), pr!)) console.log(line);
  } else usage();
}
