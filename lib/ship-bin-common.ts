/**
 * ship-bin-common — what gstack-ship-preflight and gstack-ship-release share: running git
 * and sibling bins with timeouts, flag reading, the effective ship policy, and the compact
 * result every step prints (KEY: lines, STOP: where the agent must judge, NEXT: what it
 * does next). The bins chain existing commands and never make a decision the /ship prose
 * assigns to the agent.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fragmentSlug } from './changelog-fragments';
import { laneMapping, recordCiResult, type ShipLaneMapping } from './ci-carry';
import { isConfigUnavailable, loadConfigFromBase } from './pregate/config';
import { parseUnifiedDiff, versionAtRef } from './restamp';
import { branchSides, stampOnlyLine } from './stamp-only';
import { DEFAULT_POLICY, matchesAny } from './ship-policy';
import { extractVersion } from './version-source';
import { BIN_DIR, runBashSync, runScriptSync, scriptInvocation } from './script-invocation';

export interface Run { status: number | null; stdout: string; stderr: string }
const done = (r: { status: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null; error?: Error }): Run =>
  ({ status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') + (r.error ? r.error.message : '') });

export function git(cwd: string, args: string[], timeout = 120_000): Run {
  return done(spawnSync('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }));
}
/** GST-1204: the /ship run that passed Steps 1-3 on this checkout, recorded in its own git dir (per worktree) until finish clears it; empty outside a checkout. */
export function shipRunMarker(cwd: string): string {
  const p = git(cwd, ['rev-parse', '--git-path', 'gstack-ship-run']);
  return p.status === 0 && p.stdout.trim() ? path.resolve(cwd, p.stdout.trim()) : '';
}
export function bin(cwd: string, name: string, args: string[], timeout = 600_000): Run {
  return done(runScriptSync(path.join(BIN_DIR, name), args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 }));
}
/** Whether origin's configured URL names a host (https, ssh or scp form), before any insteadOf rewrite; a local path or file:// remote has none, so gh cannot map it to a repository. */
export function hostedOrigin(cwd: string): boolean {
  const url = git(cwd, ['config', '--get', 'remote.origin.url']).stdout.trim();
  return /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?[^/:\s]+[:/]|[^@/\s]+@[^/:\s]+:)\S+$/i.test(url) && !/^file:/i.test(url);
}
/** gh with argv, never a shell, so a branch name cannot change what runs. */
export function gh(cwd: string, args: string[], timeout = 60_000): Run {
  return done(spawnSync('gh', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }));
}
export function sh(cwd: string, command: string, timeout = 1_800_000): Run {
  return done(runBashSync(command, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 }));
}
/** A sibling bin run without blocking, so independent test lanes run in parallel. */
export function binAsync(cwd: string, name: string, args: string[], timeout = 3_600_000): Promise<Run> {
  const inv = scriptInvocation(path.join(BIN_DIR, name), args);
  if (!inv.ok) return Promise.resolve({ status: null, stdout: '', stderr: inv.error });
  return new Promise(resolve => {
    const child = spawn(inv.cmd, inv.argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout = (stdout + d).slice(-200_000); });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-200_000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

export function flagReader(argv: readonly string[]) {
  const all = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));
  return { all, flag: (n: string) => all(n).at(-1), has: (n: string) => argv.includes(n) };
}

/** --lane <label>=<command> pairs (Step 5's labels and exact commands). */
export function lanes(argv: readonly string[]): { label: string; command: string }[] | string {
  const out: { label: string; command: string }[] = [];
  for (const raw of flagReader(argv).all('--lane')) {
    const at = raw.indexOf('=');
    if (at < 1 || at === raw.length - 1) return `--lane ${raw} is not <label>=<command>`;
    out.push({ label: raw.slice(0, at), command: raw.slice(at + 1) });
  }
  return out;
}

/** The base branch's effective ship policy (gstack-ship-policy show-effective --json), or null when unreadable. */
export function shipPolicy(cwd: string, base: string): Record<string, any> | null {
  const r = bin(cwd, 'gstack-ship-policy', ['show-effective', '--base', base, '--json'], 60_000);
  try { return JSON.parse(r.stdout).policy ?? null; } catch { return null; }
}

/** Manifests a version stamp writes: release metadata only while the edit changes nothing but the version. */
export const VERSIONED_MANIFESTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'];

/** True when `p` in the working tree differs from `p` at `ref` (a commit or tree) in its version fields alone; a new, deleted or unparseable file never qualifies. */
export function versionOnlyEdit(cwd: string, ref: string, p: string): boolean {
  const before = git(cwd, ['show', `${ref}:${p}`]);
  if (before.status !== 0) return false;
  let now: string;
  try { now = fs.readFileSync(path.join(cwd, p), 'utf8'); } catch { return false; }
  const strip = (s: string) => {
    const o = JSON.parse(s);
    delete o.version;
    if (o.packages?.['']) delete o.packages[''].version;
    return JSON.stringify(o);
  };
  try { return strip(before.stdout) === strip(now); } catch { return false; }
}

/**
 * Release metadata a version stamp and Steps 13-14 write, compared against `ref`: the release commit's paths,
 * never a behavior change. A manifest counts only while its edit is version-only (a dependency, script or
 * lockfile change is a build input); bun.lock never counts. `stampOnly` (a landed stack parent's checks, GST-1399)
 * counts a `stamp_paths` or `release_outputs` file only while its edit is a version stamp, as `stamp_files` are.
 */
export function releasePaths(policy: Record<string, any> | null, cwd: string, ref: string, base: string, stampOnly = false): string[] {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  const fragment = fragmentPath(policy, cwd);
  const declared = [...list(policy?.release_outputs), ...list(policy?.stamp_paths)];
  return [...new Set(['VERSION', 'CHANGELOG.md', 'TODOS.md', 'agents-digest/gstack-AGENTS.md', ...VERSIONED_MANIFESTS.filter(p => versionOnlyEdit(cwd, ref, p)),
    ...(typeof policy?.changelog === 'string' ? [policy.changelog] : []), ...(fragment ? [fragment] : []), ...(stampOnly ? [] : declared),
    ...stampedFiles(stampOnly ? { ...policy, stamp_files: [...list(policy?.stamp_files), ...declared] } : policy, cwd, ref, base)])];
}

/**
 * `stamp_files` paths whose working-tree edit against `ref` is a version stamp alone: every changed line swaps the
 * old version for the new one under a built-in form or a `stamp_patterns` template (lib/tree-receipt.ts classifyFile).
 * A moved version is floored at `ref`'s VERSION, except on a line the branch added itself (gstack-restamp's own rule:
 * added since the merge base with origin/<base>, and not added by the base since): after a lost slot and a merge of the
 * base its stale stamp is older than `ref`'s VERSION, so it must be at or newer than the fork point's version instead,
 * the bound gstack-restamp's stamp_paths stage uses (GST-895; the fork version itself since GST-963). A branch line is
 * named by its position, and with a kept VERSION only such a line may move (GST-979, GST-980); on it a declared
 * `stamp_placeholders` value may also become the new version inside a `stamp_patterns` template (GST-1026).
 */
export function stampedFiles(policy: Record<string, any> | null, cwd: string, ref: string, base: string): string[] {
  const globs = Array.isArray(policy?.stamp_files) ? policy.stamp_files.filter((s: unknown): s is string => typeof s === 'string') : [];
  if (!globs.length) return [];
  const before = versionAtRef(cwd, ref);
  if (!('version' in before)) return [];
  let after = '';
  try { after = extractVersion(fs.readFileSync(path.join(cwd, before.rel), 'utf8'), before.rel); } catch { return []; }
  if (!after) return [];
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  const templates = strings(policy?.stamp_patterns);
  const placeholders = strings(policy?.stamp_placeholders);
  const diff = git(cwd, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', ref]);
  if (diff.status !== 0) return [];
  const side = branchSides(cwd, `origin/${base}`, 'HEAD', before.version, ref);
  const stamp = (rel: string, removed: string, added: string, at: number): boolean => stampOnlyLine(removed, added, before.version, after, templates, side(rel), at, placeholders);
  return parseUnifiedDiff(diff.stdout).filter(f => f.status === 'M' && !f.binary && !f.modeChanged && matchesAny(globs, f.path) && f.hunks.length > 0 &&
    f.hunks.every(h => h.removed.length === h.added.length && h.removed.every((line, i) => stamp(f.path, line, h.added[i]!, h.removedAt[i]!)))).map(f => f.path);
}

/** Under `changelog_fragments`, the branch's own Step 13 entry `<dir>/<branch-slug>.md` (docs/ship-policy.md#changelog-fragments); null without the key. */
export function fragmentPath(policy: Record<string, any> | null, cwd: string): string | null {
  const dir = policy?.changelog_fragments?.dir;
  if (typeof dir !== 'string') return null;
  return `${dir.replace(/\/+$/, '')}/${fragmentSlug(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim())}.md`;
}

/** The paths a lane receipt may ignore: release metadata except TODOS.md, whose Step 14 edit reruns the lanes (ship/SKILL.md Step 16). */
export const evidenceExempt = (release: readonly string[]) => release.filter(p => p !== 'TODOS.md');

export const short = (list: readonly string[], n = 6) => list.slice(0, n).join(',') + (list.length > n ? `,+${list.length - n} more` : '');
export const firstLine = (s: string) => s.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 240) ?? '';

/** The compact result: at most MAX_LINES lines; STOP and NEXT always survive the cap. */
export const MAX_LINES = 30;
export class Report {
  readonly lines: string[] = [];
  exit = 0;
  add(line: string): this { this.lines.push(line); return this; }
  next(what: string): this { return this.add(`NEXT: ${what}`); }
  stop(what: string): Report { this.exit = 3; return this.add(`STOP: ${what}`); }
  render(): string {
    const keep = this.lines.length <= MAX_LINES ? this.lines
      : [...this.lines.filter(l => !/^(STOP|NEXT):/.test(l)).slice(0, MAX_LINES - 1 - this.lines.filter(l => /^(STOP|NEXT):/.test(l)).length), `… ${this.lines.length - MAX_LINES + 1} line(s) cut`, ...this.lines.filter(l => /^(STOP|NEXT):/.test(l))];
    return keep.join('\n') + '\n';
  }
}

/**
 * How many lanes run at once (GST-851): `--lanes serial` one, `--lanes parallel` all; unset, one on a machine with 4 or fewer
 * cores (six lanes at once took 4-core machines down on gstack-evals) and all above that. Any other value is a usage error.
 */
export function laneConcurrency(mode: string | undefined, cpus = os.availableParallelism()): number | string {
  if (mode === 'serial') return 1;
  if (mode === 'parallel') return Infinity;
  if (mode !== undefined) return `--lanes ${mode} is not serial or parallel`;
  return cpus <= 4 ? 1 : Infinity;
}

export interface LaneResult { label: string; exit: number | null; testsRan: string; log: string; carried?: string; reused?: string; carryNone?: string; diagnosis?: string[]; notOwed?: string; here?: string; exception?: string }

/** The base branch's `ship_lanes_from` entry for each lane whose command is a key or a declared alias, byte for byte (the ledger binds its sha256). */
export function mappedLanes(cwd: string, base: string, list: { label: string; command: string }[]): Map<string, ShipLaneMapping> {
  const loaded = loadConfigFromBase(cwd, base);
  const map = new Map<string, ShipLaneMapping>();
  if (isConfigUnavailable(loaded) || loaded.errors.length) return map;
  const from = loaded.config.ship_lanes_from;
  for (const l of list) { const m = laneMapping(from, l.command); if (m) map.set(l.label, m); }
  return map;
}

/**
 * A mapped lane carried from CI at HEAD's clean tree: gstack-evidence record-ci finds and verifies the run (lib/ci-carry.ts)
 * and records the CI-sourced ledger row; or why it was not (`carryNone`), so the caller runs it.
 */
export function carryLane(cwd: string, base: string, l: { label: string; command: string }, timeoutS = DEFAULT_POLICY.ci_record_timeout_s): LaneResult {
  const rec = bin(cwd, 'gstack-evidence', ['record-ci', '--label', l.label, '--base', base, '--', l.command], timeoutS * 1000);
  const got = recordCiResult(rec.stderr);
  if (rec.status === 0 && got.runs) return { label: l.label, exit: 0, testsRan: got.files ? `${got.tests} (files)` : got.tests!, log: '-', carried: got.runs, ...(got.notOwed ? { notOwed: got.notOwed } : {}), ...(got.here ? { here: got.here } : {}), ...(got.exception ? { exception: got.exception } : {}) };
  return { label: l.label, exit: null, testsRan: 'unknown', log: '-', carryNone: got.none ?? `record_failed: ${firstLine(rec.stderr)}`, ...(got.diagnosis ? { diagnosis: got.diagnosis } : {}) };
}

/** accept's bound on one record-ci (GST-1606): the base policy's `ci_record_timeout_s`, 600 s by default, clamped to 3600 s. */
export function recordCiTimeout(policy: Record<string, any> | null, base: string): { seconds: number; line: string } {
  const set = policy?.ci_record_timeout_s;
  if (typeof set !== 'number' || set === DEFAULT_POLICY.ci_record_timeout_s) return { seconds: DEFAULT_POLICY.ci_record_timeout_s, line: `CI_RECORD_TIMEOUT: ${DEFAULT_POLICY.ci_record_timeout_s}s (default)` };
  if (set > 3600) return { seconds: 3600, line: `CI_RECORD_TIMEOUT: 3600s (origin/${base} ci_record_timeout_s ${set} is over the 3600s ceiling)` };
  return { seconds: set, line: `CI_RECORD_TIMEOUT: ${set}s (origin/${base} ci_record_timeout_s)` };
}

/**
 * Run each lane, at most `concurrency` at a time; results keep the lanes' order. With `base`, a lane the base branch maps in
 * `ship_lanes_from` is carried from a verified CI run at this exact tree when one exists. Every other lane runs through
 * gstack-evidence run --reuse (a pass at this tree, command and runtime is reused; `reuse: false` forces a run).
 */
export async function runLanes(cwd: string, list: { label: string; command: string }[], concurrency = Infinity, opts: { base?: string; reuse?: boolean } = {}): Promise<LaneResult[]> {
  const out: LaneResult[] = [];
  const mapped = opts.base ? mappedLanes(cwd, opts.base, list) : new Map<string, ShipLaneMapping>();
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const l = list[i]!;
      const m = mapped.get(l.label);
      const carry = m ? carryLane(cwd, opts.base!, l) : null;
      if (carry?.carried) { out[i] = carry; continue; }
      const r = await binAsync(cwd, 'gstack-evidence', ['run', ...(opts.reuse === false ? [] : ['--reuse']), '--label', l.label, '--', l.command]);
      const rec = /gstack-evidence: recorded label=\S+ exit=(\S+) tests_ran=(\S+) log=(\S+)/.exec(r.stderr);
      const reused = /gstack-evidence: reused label=\S+ tree=\S+ from=(\S+)/.exec(r.stderr)?.[1];
      out[i] = { label: l.label, exit: r.status, testsRan: rec?.[2] ?? 'unknown', log: rec?.[3] ?? '-', ...(reused ? { reused } : {}), ...(carry?.carryNone ? { carryNone: carry.carryNone } : {}) };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  return out;
}

/** Step 5's lane verdict: a lane passes on its runner count, never exit 0 alone; a carried lane names its CI runs. */
export function laneLine(l: LaneResult): { line: string; ok: boolean } {
  if (l.notOwed) return { line: `LANE: ${l.label} not owed: ${l.notOwed} run=${l.carried}`, ok: true };
  if (l.carried) return { line: `LANE: ${l.label} carried run=${l.carried} tests_ran=${l.testsRan}${l.here ? ` ${l.here}` : ''}`, ok: true };
  const zero = l.exit === 0 && l.testsRan === '0';
  const state = l.exit !== 0 ? 'FAIL' : zero ? 'ZERO-RUN' : l.testsRan === 'unknown' ? 'pass (count unavailable)' : 'pass';
  return { line: `LANE: ${l.label} ${state} exit=${l.exit} tests_ran=${l.testsRan} log=${l.log}${l.reused ? ` reused=${l.reused}` : ''}`, ok: l.exit === 0 && !zero };
}

/** The CI_CARRY line for a mapped lane that ran here instead, then a CARRY_DIAGNOSIS line per uncovered file another test file imports. */
export const carryNoneLines = (l: LaneResult): string[] => (l.carryNone ? [`CI_CARRY: none label=${l.label} (${l.carryNone.length > 220 ? `${l.carryNone.slice(0, 220)}…` : l.carryNone})`, ...(l.diagnosis ?? []).map(d => `CARRY_DIAGNOSIS: ${d}`)] : []);
