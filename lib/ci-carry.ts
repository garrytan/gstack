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
 *   prints (a lane carries only what CI provably ran); with named jobs instead
 *   (a lane with no test files, GST-1189), each of those jobs succeeded in the
 *   run's newest attempt, read by verifyRun like the profile's own jobs;
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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalPath, runChanged, runInventory, runReceiptFields, uncoveredFiles, verifyRun, type ApiRun, type RunDeps, type RunEvidence, type RunProfile, type RunSource } from './run-evidence';

export type CarryRefusal = 'dirty_tree' | 'no_profile' | 'no_run' | 'no_verified_run' | 'tree_mismatch' | 'no_tests'
  | 'inventory_failed' | 'inventory_empty' | 'inventory_uncovered' | 'inventory_skipped' | 'run_changed' | 'tree_changed' | 'api_error';
/** `diagnosis`: one line per uncovered inventory file another inventory file imports (importedTestLines). */
export type CarryRefused = { ok: false; reason: CarryRefusal; detail: string; diagnosis?: string[] };
/**
 * `tests` never claims a whole run's count for a narrow lane: with an inventory it is the number of the lane's inventory files
 * the runs' tree.json covers (`unit: 'files'`; tree.json has no per-file test counts yet), with named jobs `n/a`, and only
 * without either (the whole run carried) the runs' test count. `remainder`: inventory files every run skipped entirely
 * (tree.json `skipped_files`), which the caller must run here with the lane's per_file runner before the lane counts.
 */
export type CarryVerdict = { ok: true; runs: RunEvidence[]; tests: number | 'n/a'; unit?: 'files'; notOwed?: string; remainder?: string[]; excepted?: string[]; exceptedBy?: string; receipt: string } | CarryRefused;

/** How many of HEAD's runs per workflow are tried, newest first. */
const CANDIDATES = 10;
const no = (reason: CarryRefusal, detail: string): CarryRefused => ({ ok: false, reason, detail });
const newestFirst = (a: ApiRun, b: ApiRun) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || b.id - a.id;

/** The newest run of `profile` on `head` that verifies; a refusal lists each candidate's reason, newest first. */
function newestVerified(src: RunSource, name: string, profile: RunProfile, head: string, jobs: string[]): { ok: true; evidence: RunEvidence } | CarryRefused {
  if (jobs.length) profile = { ...profile, jobs: [...new Set([...profile.jobs, ...jobs])] };
  const listed = src.deps.runsForHead(profile.workflow, head).filter(r => profile.events.includes(r.event)).sort(newestFirst).slice(0, CANDIDATES);
  if (!listed.length) return no('no_run', `no ${profile.workflow} run (${profile.events.join(', ')}) on ${head.slice(0, 12)} yet`);
  const refusals: string[] = [];
  for (const run of listed) {
    const v = verifyRun(src.deps, { repo: src.repo, runRef: String(run.id), profileName: name, profile, vetoHeads: [head], now: src.now, unchanged: src.unchanged });
    if (v.ok) return v;
    refusals.push(`run ${run.id}: ${v.reason}${v.fix ? ` (the pull request's base moved after the run; fix: ${v.fix})` : ''}`);
  }
  return no('no_verified_run', `${name}: ${refusals.join('; ')}`);
}

/**
 * The CI evidence for HEAD's tree under `profiles` (one verified run each), or why there is none. `wtree` reads the
 * working-tree fingerprint (before the lookup and after it); `inventory` lists the files the runs must cover, or `jobs`
 * names the jobs that must have succeeded in each run's newest attempt (a lane with no test files; no test count needed).
 * `excepted` holds the owner's test-lane exceptions at HEAD (lib/test-lane-exception.ts): when the inventory files no run lists
 * are exactly one grant's files, they come back as `excepted` (with that grant's `exceptedBy`) for the caller to preflight here
 * with the per_file runner instead of refusing the lane (GST-1595).
 */
export function findCarry(src: RunSource, o: { profiles: string[]; head: string; tree: string; wtree: () => string | null; inventory?: () => string[] | { error: string }; jobs?: string[]; perFile?: boolean;
  importers?: (missing: string[], listed: string[]) => string[]; excepted?: { files: string[]; approval: string }[] }): CarryVerdict {
  const jobs = o.jobs ?? [];
  let covered: number | undefined;
  let remainder: string[] = [];
  let excused: string[] = [];
  let exceptedBy: string | undefined;
  const before = o.wtree();
  if (before !== o.tree) return no('dirty_tree', `the working tree (${before ? before.slice(0, 12) : 'fingerprint unavailable'}) is not HEAD's committed tree ${o.tree.slice(0, 12)}; only a clean, committed tree carries`);
  if (!o.profiles.length) return no('no_profile', 'no run profile is named');
  const runs: RunEvidence[] = [];
  try {
    for (const name of o.profiles) {
      const profile = src.profiles[name];
      if (!profile) return no('no_profile', `${name} is not a run_profiles name on the base branch`);
      const v = newestVerified(src, name, profile, o.head, jobs);
      if (!v.ok) return v;
      runs.push(v.evidence);
    }
    const other = runs.find(e => e.tree !== o.tree);
    if (other) return no('tree_mismatch', `run ${other.run_id} tested tree ${other.tree.slice(0, 12)}, not ${o.tree.slice(0, 12)}`);
    const empty = jobs.length ? undefined : runs.find(e => !e.files.length || e.tests === 0);
    if (empty) return no('no_tests', `run ${empty.run_id}'s tree.json ${empty.files.length ? 'records 0 tests' : 'lists no test files'}`);
    if (o.inventory) {
      const listed = o.inventory();
      if ('error' in listed) return no('inventory_failed', listed.error);
      if (!listed.length) return no('inventory_empty', 'the inventory command printed no files');
      const absent = uncoveredFiles(listed, runs, 'covered');
      const some = (fs: string[]) => `${fs.slice(0, 5).join(', ')}${fs.length > 5 ? ', …' : ''}`;
      const grants = o.excepted ?? [];
      const granted = absent.length ? grants.find(g => sameFiles(absent, g.files)) : undefined;
      if (absent.length && (!granted || !o.perFile)) {
        const grant = !grants.length ? '' : granted ? `; test-lane exception ${granted.approval} names them, but the lane declares no per_file runner to preflight them here`
          : `; test-lane exception ${grants.map(g => `${g.approval} names ${some(g.files)}`).join('; ')}, not exactly these`;
        const diagnosis = o.importers?.(absent, listed) ?? [];
        return { ...no('inventory_uncovered', `${absent.length} of ${listed.length} inventory file(s) are in no run's tree.json: ${some(absent)}${grant}`), ...(diagnosis.length ? { diagnosis } : {}) };
      }
      excused = absent;
      exceptedBy = granted?.approval;
      remainder = uncoveredFiles(listed, runs, 'uncovered').filter(f => !excused.includes(f));
      if (remainder.length && !o.perFile) return no('inventory_skipped', `${remainder.length} of ${listed.length} inventory file(s) skipped every test in CI and the lane declares no per_file runner: ${some(remainder)}`);
      covered = new Set(listed.map(normalPath)).size - remainder.length - excused.length;
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
  if (jobs.length) {
    const gates = [...new Set(o.profiles.map(n => src.profiles[n]?.skippable?.gate).filter(Boolean))];
    const allSkipped = runs.every(e => jobs.every(j => e.skipped_jobs?.includes(j)));
    const notOwed = allSkipped ? `CI skipped at this tree (gate job ${gates.join(', ')}, workflow unchanged)` : undefined;
    return { ok: true, runs, tests: 'n/a', ...(notOwed ? { notOwed } : {}), receipt: `ci-carry tree=${o.tree.slice(0, 12)} jobs=${jobs.join(',')}${notOwed ? ` not_owed=${gates.join(',')}` : ''} ${runReceiptFields(runs, src.now)}` };
  }
  if (covered !== undefined) return { ok: true, runs, tests: covered, unit: 'files', ...(remainder.length ? { remainder } : {}), ...(excused.length ? { excepted: excused, exceptedBy } : {}), receipt: `ci-carry tree=${o.tree.slice(0, 12)} files=${covered}${remainder.length ? ` skipped_here=${remainder.length}` : ''}${excused.length ? ` excepted=${excused.length} approval=${exceptedBy}` : ''} ${runReceiptFields(runs, src.now)}` };
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

/**
 * `ship_lanes_from` (base branch only): exact lane command → the profiles whose runs carry it and either the command listing
 * its test files (`inventory`) or the CI jobs that run it (`jobs`, for a lane with no test files such as a typecheck; GST-1189).
 */
export interface ShipLaneMapping { profiles: string[]; inventory?: string; jobs?: string[]; aliases?: string[]; per_file?: string }

/**
 * The `ship_lanes_from` entry for an exact lane command: the entry it keys, else the entry that declares it in `aliases`
 * (GST-1190: the same lane run under another exact spelling, such as an env prefix). Never normalized: an alias is a
 * second exact command the base's owner declared, not a pattern.
 */
export function laneMapping(from: Record<string, ShipLaneMapping>, command: string): ShipLaneMapping | undefined {
  if (Object.prototype.hasOwnProperty.call(from, command)) return from[command];
  return Object.values(from).find(m => m.aliases?.includes(command));
}

/** findCarry's coverage rule for one mapping: its inventory (a pin-file command run in `cwd`, with a per_file runner or not) or its named jobs. */
export const mappingCoverage = (m: ShipLaneMapping, cwd: string): { inventory?: () => string[] | { error: string }; jobs?: string[]; perFile?: boolean; importers?: (missing: string[], listed: string[]) => string[] } =>
  m.jobs ? { jobs: m.jobs } : { inventory: () => runInventory(m.inventory!, cwd), perFile: !!m.per_file, importers: (missing, listed) => importedTestLines(cwd, missing, listed) };

const sameFiles = (a: string[], b: string[]) => { const x = new Set(a.map(normalPath)), y = new Set(b.map(normalPath)); return x.size === y.size && [...x].every(f => y.has(f)); };
const IMPORT_SPEC = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](\.{1,2}\/[^'"\n]+)['"]/g;
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.js'];

/**
 * One line per file in `missing` (test files no run's tree.json lists) that another file in `candidates` imports by a
 * relative path: bun registers an imported test file's tests under the importing file, so the imported file's own JUnit
 * suite never appears (GST-1595, gstack-evals #240). Read from the working tree in `cwd`; an unreadable file is skipped.
 */
export function importedTestLines(cwd: string, missing: string[], candidates: string[]): string[] {
  const want = new Map(missing.map(f => [normalPath(f), f]));
  const lines = new Map<string, string>();
  for (const importer of candidates) {
    const from = normalPath(importer);
    let text: string;
    try { text = fs.readFileSync(path.join(cwd, from), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(IMPORT_SPEC)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), m[1]!));
      const hit = RESOLVE_SUFFIXES.map(s => want.get(target + s)).find(Boolean);
      if (hit && normalPath(hit) !== from && !lines.has(hit)) lines.set(hit, `bun registers ${hit} under ${importer}; its JUnit suite won't appear`);
    }
  }
  return missing.flatMap(f => lines.get(f) ?? []);
}

/**
 * What `gstack-evidence record-ci` reported, read from its own last record line onward (the per_file remainder's output comes
 * first, so a test printing look-alike lines cannot change the reading): the carried runs, count, unit and remainder, any
 * not-owed reason, or the last CARRY_NONE reason.
 */
export function recordCiResult(stderr: string): { runs?: string; tests?: string; files?: boolean; notOwed?: string; here?: string; exception?: string; none?: string; diagnosis?: string[] } {
  const lines = stderr.split('\n');
  const at = lines.findLastIndex(x => x.startsWith('gstack-evidence: recorded label=') && x.includes(' log=- source=ci runs='));
  const noneAt = lines.findLastIndex(x => x.startsWith('CARRY_NONE: '));
  const none = noneAt < 0 ? undefined : lines[noneAt]!.slice('CARRY_NONE: '.length);
  const diagnosis = noneAt < 0 ? [] : lines.slice(noneAt + 1).filter(x => x.startsWith('CARRY_DIAGNOSIS: ')).map(x => x.slice('CARRY_DIAGNOSIS: '.length));
  if (at < 0) return none ? { none, ...(diagnosis.length ? { diagnosis } : {}) } : {};
  const exception = lines.slice(at + 1).find(x => x.startsWith('TEST_LANE_EXCEPTION: '))?.slice('TEST_LANE_EXCEPTION: '.length);
  const got = / tests_ran=(\d+|n\/a)( unit=files)? log=- source=ci runs=(\S+)/.exec(lines[at]!);
  const here = / skipped_here=(\d+) tests_ran_here=(\S+)( not_owed_here=\d+)?$/.exec(lines[at]!);
  const notOwed = lines.slice(at + 1).find(x => x.startsWith('gstack-evidence: not owed: '))?.slice('gstack-evidence: not owed: '.length);
  return { runs: got?.[3], tests: got?.[1], files: !!got?.[2], ...(notOwed ? { notOwed } : {}), ...(here ? { here: `skipped_here=${here[1]} file(s) tests_ran_here=${here[2]}${here[3] ?? ''}` } : {}), ...(exception ? { exception } : {}) };
}

/** The per_file runner command for `files`: `{files}` replaced by the paths, each anchored with ./ (Bun reads a bare relative path as a substring filter) and single-quoted for bash. */
export const perFileCommand = (template: string, files: string[]): string =>
  template.replaceAll('{files}', files.map(f => `'${(/^(\/|\.\/)/.test(f) ? f : `./${f}`).replace(/'/g, `'\\''`)}'`).join(' '));

/** `<path>: <message>` errors for `ship_lanes_from`; empty when valid. Shared with lib/pregate/config.ts. */
export function shipLanesErrors(raw: unknown, profileNames: readonly string[]): Array<{ path: string; message: string }> {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [{ path: 'ship_lanes_from', message: 'must be an object of exact lane command → { profiles: [run_profiles names], inventory: command } or { profiles, jobs: [job names] }' }];
  const errors: Array<{ path: string; message: string }> = [];
  const oneLine = (s: unknown) => typeof s === 'string' && !!s.trim() && s.length <= 512 && !/[\0\r\n]/.test(s);
  const declared = new Map<string, string>(Object.keys(raw as object).map(k => [k, 'a key']));
  for (const [command, m] of Object.entries(raw as Record<string, unknown>)) {
    const at = `ship_lanes_from[${JSON.stringify(command)}]`;
    if (!oneLine(command)) errors.push({ path: at, message: 'the key must be the exact lane command: one line under 512 characters' });
    if (!m || typeof m !== 'object' || Array.isArray(m)) { errors.push({ path: at, message: 'must be { profiles, inventory } or { profiles, jobs }' }); continue; }
    const o = m as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!['profiles', 'inventory', 'jobs', 'aliases', 'per_file'].includes(k)) errors.push({ path: `${at}.${k}`, message: 'unknown key; valid keys: profiles, inventory, jobs, aliases, per_file' });
    if ('per_file' in o && (!oneLine(o.per_file) || !(o.per_file as string).includes('{files}') || !('inventory' in o))) errors.push({ path: `${at}.per_file`, message: 'must be one command line under 512 characters containing {files}, on an entry with an inventory (it runs the inventory files CI skipped entirely)' });
    if ('aliases' in o) {
      const aliases = o.aliases;
      if (!Array.isArray(aliases) || !aliases.length || aliases.some(a => !oneLine(a)) || new Set(aliases).size !== aliases.length) errors.push({ path: `${at}.aliases`, message: 'must be a non-empty array of distinct exact lane commands, each one line under 512 characters' });
      else for (const a of aliases as string[]) {
        if (declared.has(a)) errors.push({ path: `${at}.aliases`, message: `${JSON.stringify(a)} is already ${declared.get(a)}; each exact command maps to one entry` });
        else declared.set(a, `an alias of ${JSON.stringify(command)}`);
      }
    }
    if (!Array.isArray(o.profiles) || !o.profiles.length || o.profiles.some(p => typeof p !== 'string')) errors.push({ path: `${at}.profiles`, message: 'must be a non-empty array of run_profiles names' });
    else for (const p of o.profiles as string[]) if (!profileNames.includes(p)) errors.push({ path: `${at}.profiles`, message: `${JSON.stringify(p)} is not a run_profiles name` });
    if (('inventory' in o) === ('jobs' in o)) errors.push({ path: at, message: 'declare exactly one of inventory (a command listing the lane\'s test files) or jobs (the CI jobs that run it)' });
    else if ('jobs' in o) {
      const jobs = o.jobs;
      if (!Array.isArray(jobs) || !jobs.length || jobs.some(j => typeof j !== 'string' || !oneLine(j) || j.length > 128) || new Set(jobs).size !== jobs.length) errors.push({ path: `${at}.jobs`, message: 'must be a non-empty array of distinct CI job names, each one line under 128 characters' });
    } else if (!oneLine(o.inventory)) errors.push({ path: `${at}.inventory`, message: 'must be one command line under 512 characters that prints the lane\'s test files, one per line' });
  }
  return errors;
}
