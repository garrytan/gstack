/**
 * ci-carry: CI is the one full test run (GSTA-258, R65 item 1). When a verified
 * CI run already passed at the exact tree /ship or pregate is about to test,
 * they use it instead of running the suite again.
 *
 * `findCarry` looks up the newest verified run of each named run profile (the
 * base branch's `.gstack/pregate.json` `run_profiles`) for HEAD and accepts it
 * only when every rule holds:
 *
 *   the working tree is HEAD's committed tree (gstack-wtree), before and after
 *   the lookup, so admitted dirty or untracked work never carries;
 *   each run passes verifyRun (same-repository head, the profile's workflow,
 *   event and jobs, the newest attempt, no newer red or running run on HEAD,
 *   max age, the run's own tree.json naming HEAD's tree);
 *   every run executed tests;
 *   with an inventory command, the runs' tree.json files cover every file it
 *   prints (a lane carries only what CI provably ran);
 *   every run still stands after the inventory ran (runChanged).
 *
 * Anything else returns a refusal with a reason code, and the caller runs the
 * suite as before. Security and advisory scans and the sealed guard are never
 * carried: callers carry test lanes only.
 *
 * waitForRun polls the newest run of one workflow on HEAD until it completes,
 * bounded by a timeout, and returns green, red with the failing jobs, still
 * running, or none.
 */
import { runChanged, runReceiptFields, uncoveredFiles, verifyRun, type ApiRun, type RunDeps, type RunEvidence, type RunProfile, type RunSource } from './run-evidence';

export type CarryRefusal = 'dirty_tree' | 'no_profile' | 'no_run' | 'no_verified_run' | 'tree_mismatch' | 'no_tests'
  | 'inventory_failed' | 'inventory_empty' | 'inventory_uncovered' | 'run_changed' | 'tree_changed' | 'api_error';
export type CarryRefused = { ok: false; reason: CarryRefusal; detail: string };
export type CarryVerdict = { ok: true; runs: RunEvidence[]; tests: number; receipt: string } | CarryRefused;

/** How many of HEAD's runs per workflow are tried, newest first. */
const CANDIDATES = 10;
const no = (reason: CarryRefusal, detail: string): CarryRefused => ({ ok: false, reason, detail });
const newestFirst = (a: ApiRun, b: ApiRun) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || b.id - a.id;

/** The newest run of `profile` on `head` that verifies; a refusal lists each candidate's reason, newest first. */
function newestVerified(src: RunSource, name: string, profile: RunProfile, head: string): { ok: true; evidence: RunEvidence } | CarryRefused {
  const listed = src.deps.runsForHead(profile.workflow, head).filter(r => profile.events.includes(r.event)).sort(newestFirst).slice(0, CANDIDATES);
  if (!listed.length) return no('no_run', `no ${profile.workflow} run (${profile.events.join(', ')}) on ${head.slice(0, 12)} yet`);
  const refusals: string[] = [];
  for (const run of listed) {
    const v = verifyRun(src.deps, { repo: src.repo, runRef: String(run.id), profileName: name, profile, vetoHeads: [head], now: src.now });
    if (v.ok) return v;
    refusals.push(`run ${run.id}: ${v.reason}`);
  }
  return no('no_verified_run', `${name}: ${refusals.join('; ')}`);
}

/**
 * The CI evidence for HEAD's tree under `profiles` (one verified run each), or why there is none. `wtree` reads the
 * working-tree fingerprint (before the lookup and after it); `inventory` lists the files the runs must cover.
 */
export function findCarry(src: RunSource, o: { profiles: string[]; head: string; tree: string; wtree: () => string | null; inventory?: () => string[] | { error: string } }): CarryVerdict {
  const before = o.wtree();
  if (before !== o.tree) return no('dirty_tree', `the working tree (${before ? before.slice(0, 12) : 'fingerprint unavailable'}) is not HEAD's committed tree ${o.tree.slice(0, 12)}; only a clean, committed tree carries`);
  if (!o.profiles.length) return no('no_profile', 'no run profile is named');
  const runs: RunEvidence[] = [];
  try {
    for (const name of o.profiles) {
      const profile = src.profiles[name];
      if (!profile) return no('no_profile', `${name} is not a run_profiles name on the base branch`);
      const v = newestVerified(src, name, profile, o.head);
      if (!v.ok) return v;
      runs.push(v.evidence);
    }
    const other = runs.find(e => e.tree !== o.tree);
    if (other) return no('tree_mismatch', `run ${other.run_id} tested tree ${other.tree.slice(0, 12)}, not ${o.tree.slice(0, 12)}`);
    const empty = runs.find(e => !e.files.length || e.tests === 0);
    if (empty) return no('no_tests', `run ${empty.run_id}'s tree.json ${empty.files.length ? 'records 0 tests' : 'lists no test files'}`);
    if (o.inventory) {
      const listed = o.inventory();
      if ('error' in listed) return no('inventory_failed', listed.error);
      if (!listed.length) return no('inventory_empty', 'the inventory command printed no files');
      const missing = uncoveredFiles(listed, runs);
      if (missing.length) return no('inventory_uncovered', `${missing.length} of ${listed.length} inventory file(s) are in no run's tree.json: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`);
    }
    for (const e of runs) {
      const changed = runChanged(src.deps, e.run_id, e.run_attempt);
      if (changed) return no('run_changed', changed);
    }
  } catch (e) {
    return no('api_error', `reading runs failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  }
  const after = o.wtree();
  if (after !== o.tree) return no('tree_changed', `the working tree changed while the runs were verified (now ${after ? after.slice(0, 12) : 'unreadable'})`);
  const tests = runs.reduce((n, e) => n + (e.tests ?? e.files.length), 0);
  return { ok: true, runs, tests, receipt: `ci-carry tree=${o.tree.slice(0, 12)} tests=${tests} ${runReceiptFields(runs, src.now)}` };
}

export type WaitVerdict = { state: 'green'; run: ApiRun } | { state: 'red'; run: ApiRun; failing: string[] } | { state: 'running'; run: ApiRun } | { state: 'none'; reason: string };
const PASSING = ['success', 'skipped', 'neutral'];

/** Poll the newest `workflow` run on `head` (among `events`) until it completes or `timeoutMs` passes. */
export async function waitForRun(deps: RunDeps, o: { workflow: string; events: string[]; head: string; timeoutMs: number; intervalMs: number; sleep: (ms: number) => Promise<void>; clock: () => number }): Promise<WaitVerdict> {
  const end = o.clock() + o.timeoutMs;
  for (;;) {
    const newest = deps.runsForHead(o.workflow, o.head).filter(r => o.events.includes(r.event)).sort(newestFirst)[0];
    if (newest?.status === 'completed') {
      if (newest.conclusion === 'success') return { state: 'green', run: newest };
      const failing = deps.jobs(newest.id, newest.run_attempt).filter(j => !PASSING.includes(j.conclusion ?? '')).map(j => j.name);
      return { state: 'red', run: newest, failing };
    }
    if (o.clock() >= end) return newest ? { state: 'running', run: newest } : { state: 'none', reason: `no ${o.workflow} run on ${o.head.slice(0, 12)} after ${Math.round(o.timeoutMs / 1000)} s` };
    await o.sleep(Math.max(1, Math.min(o.intervalMs, end - o.clock())));
  }
}

/** `ship_lanes_from` (base branch only): exact lane command → the profiles whose runs carry it and the command listing its test files. */
export interface ShipLaneMapping { profiles: string[]; inventory: string }

/** `<path>: <message>` errors for `ship_lanes_from`; empty when valid. Shared with lib/pregate/config.ts. */
export function shipLanesErrors(raw: unknown, profileNames: readonly string[]): Array<{ path: string; message: string }> {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [{ path: 'ship_lanes_from', message: 'must be an object of exact lane command → { profiles: [run_profiles names], inventory: command }' }];
  const errors: Array<{ path: string; message: string }> = [];
  const oneLine = (s: unknown) => typeof s === 'string' && !!s.trim() && s.length <= 512 && !/[\0\r\n]/.test(s);
  for (const [command, m] of Object.entries(raw as Record<string, unknown>)) {
    const at = `ship_lanes_from[${JSON.stringify(command)}]`;
    if (!oneLine(command)) errors.push({ path: at, message: 'the key must be the exact lane command: one line under 512 characters' });
    if (!m || typeof m !== 'object' || Array.isArray(m)) { errors.push({ path: at, message: 'must be { profiles, inventory }' }); continue; }
    const o = m as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== 'profiles' && k !== 'inventory') errors.push({ path: `${at}.${k}`, message: 'unknown key; valid keys: profiles, inventory' });
    if (!Array.isArray(o.profiles) || !o.profiles.length || o.profiles.some(p => typeof p !== 'string')) errors.push({ path: `${at}.profiles`, message: 'must be a non-empty array of run_profiles names' });
    else for (const p of o.profiles as string[]) if (!profileNames.includes(p)) errors.push({ path: `${at}.profiles`, message: `${JSON.stringify(p)} is not a run_profiles name` });
    if (!oneLine(o.inventory)) errors.push({ path: `${at}.inventory`, message: 'must be one command line under 512 characters that prints the lane\'s test files, one per line' });
  }
  return errors;
}
