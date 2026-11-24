/**
 * release-benchmark: the stable cut reads gstack-evals' weekly benchmark (docs/releases.md#weekly-benchmark).
 * Garry, 2026-11-21: "Is Gstack this week significantly better than last week?" gstack-evals measures the release
 * candidate against stable and no gstack every Saturday and publishes weekly.json on a GitHub release tagged
 * weekly-<yyyy>-w<nn> (-r<k> for a re-measure or correction; lanes/weekly-stable in garrytan/gstack-evals). The
 * newest record by run start that is not INCOMPLETE decides, the same rule gstack-evals' own resolver uses, so both
 * sides agree on whether a HOLD stands. A HOLD never goes stale; GAIN, NO_CHANGE and FLAG lines stop counting at
 * their stale_after time. With BENCHMARK.hold false (the first two weekly records) the cut only prints the
 * BENCHMARK: line. Repo-local type imports only, so gstack-evals' shim still loads release-cut.ts in a bare clone.
 */
import type { ImportantChange, Trigger } from '../scripts/release-cadence';
import type { Gh, Git } from '../scripts/release-cut';

export const BENCHMARK = { repo: 'garrytan/gstack-evals', asset: 'weekly.json', hold: false } as const;
export const VERDICTS = ['HOLD', 'GAIN', 'NO_CHANGE', 'INCOMPLETE'] as const;
export type Verdict = (typeof VERDICTS)[number];
const TAG = /^weekly-\d{4}-w\d{2}(-r\d+)?$/;
const SHA = /^[0-9a-f]{40}$/;
const DAY = 86_400_000;
const URGENT = new Set(['security', 'data-loss', 'regression']);

export interface ModelRow { host?: string; n: number; d: number; lo: number; hi: number; vs_none?: { d: number; lo: number; hi: number } }
export interface WeeklyRecord {
  tag: string; week: string; verdict: Verdict; start: number;
  candidate: { sha: string }; stable: { tag: string; sha: string };
  models: Record<string, ModelRow>; flags: string[]; incomplete_reason: string | null; stale_after: string | null;
}
export type Records = { ok: true; records: WeeklyRecord[] } | { ok: false; why: string };
export interface BenchmarkStatus { state: 'none' | 'clear' | 'hold' | 'unreadable'; line: string; record: WeeklyRecord | null }
export interface Gate { action: 'pass' | 'wait' | 'refuse'; code?: 'REFUSED_BENCHMARK' | 'STABLE_STALE' | 'BENCHMARK_UNKNOWN'; line?: string; level?: 'notice' | 'warning' | 'error' }

const clean = (s: unknown) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ');
const short = (s: string) => clean(s.trim()).slice(0, 200);
const retried = (gh: Gh, args: string[]) => { const r = gh(args); return r.status === 0 ? r : gh(args); };
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
const f1 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(1);

/** One record, checked: schema 1, a known verdict, a run start, 40-hex shas, numeric model rows, and a verdict its model rows agree with (HOLD exactly when some row's interval lies wholly below 0). A vs_none with a non-numeric field is dropped, since it never decides; text is stripped of control characters so it cannot start a workflow command in the job log. */
export function parseRecord(tag: string, text: string): WeeklyRecord | string {
  let r: any;
  try { r = JSON.parse(text); } catch { return tag + "'s " + BENCHMARK.asset + ' is not JSON'; }
  if (r?.schema !== 1) return tag + ': schema ' + r?.schema + ', not 1';
  if (!VERDICTS.includes(r.verdict)) return tag + ': verdict ' + r.verdict + ' is not ' + VERDICTS.join(', ');
  const start = Date.parse(r.window?.start);
  if (!Number.isFinite(start)) return tag + ': window.start is not a time';
  if (!SHA.test(r.candidate?.sha ?? '') || !SHA.test(r.stable?.sha ?? '')) return tag + ': candidate or stable is not a 40-hex sha';
  const models = (r.models && typeof r.models === 'object' ? r.models : {}) as Record<string, ModelRow>;
  const rows: Record<string, ModelRow> = Object.create(null);
  for (const [id, m] of Object.entries(models)) {
    if (![m?.n, m?.d, m?.lo, m?.hi].every(num)) return tag + ': model row ' + clean(id) + ' is not numeric';
    const v = m.vs_none;
    if (clean(id) in rows) return tag + ': model ids ' + JSON.stringify(clean(id)) + ' collide once control characters are stripped';
    rows[clean(id)] = { host: m.host, n: m.n, d: m.d, lo: m.lo, hi: m.hi, ...(v && [v.d, v.lo, v.hi].every(num) ? { vs_none: { d: v.d, lo: v.lo, hi: v.hi } } : {}) };
  }
  if (Object.values(rows).some((m) => m.hi < 0) !== (r.verdict === 'HOLD')) return tag + ': verdict ' + r.verdict + ' disagrees with its model rows (verdict mismatch)';
  return {
    tag, week: clean(r.week ?? tag), verdict: r.verdict, start, candidate: { sha: r.candidate.sha }, stable: { tag: clean(r.stable.tag ?? '?'), sha: r.stable.sha },
    models: rows, flags: Array.isArray(r.flags) ? r.flags.map(clean) : [], incomplete_reason: r.incomplete_reason == null ? null : clean(r.incomplete_reason),
    stale_after: typeof r.stale_after?.verdict === 'string' ? r.stale_after.verdict : null,
  };
}

/** Every published weekly record, each list or download retried once; any failure makes the whole read unreadable, so an older record never decides past a newer one nobody could read. */
export function readRecords(gh: Gh, repo: string = BENCHMARK.repo): Records {
  const list = retried(gh, ['release', 'list', '--repo', repo, '--limit', '200', '--json', 'tagName']);
  if (list.status !== 0) return { ok: false, why: 'gh release list failed: ' + short(list.stderr) };
  let tags: string[];
  try { tags = (JSON.parse(list.stdout) as { tagName: string }[]).map((x) => x.tagName).filter((t) => TAG.test(t)); } catch { return { ok: false, why: 'gh release list did not return JSON' }; }
  const records: WeeklyRecord[] = [];
  for (const tag of tags) {
    const d = retried(gh, ['release', 'download', tag, '--repo', repo, '-p', BENCHMARK.asset, '-O', '-']);
    if (d.status !== 0) return { ok: false, why: 'gh release download ' + tag + ' failed: ' + short(d.stderr) };
    const rec = parseRecord(tag, d.stdout);
    if (typeof rec === 'string') return { ok: false, why: rec };
    records.push(rec);
  }
  return { ok: true, records };
}

/** gstack-evals' order (lanes/weekly-stable/cli.ts holdFromReleases: run start, then resolve.ts byWeekDesc): newest run first, and on a tie a -r<k> correction before the record it follows. */
const byTag = (a: string, b: string) => (a.slice(0, 15) !== b.slice(0, 15) ? (a.slice(0, 15) < b.slice(0, 15) ? 1 : -1) : Number(b.slice(17) || 0) - Number(a.slice(17) || 0));
export const newestFirst = (records: WeeklyRecord[]) => [...records].sort((a, b) => b.start - a.start || byTag(a.tag, b.tag));

function summary(r: WeeklyRecord): string {
  const rows = Object.entries(r.models).map(([id, m]) => id + ' ' + f1(m.d) + ' [' + f1(m.lo) + ', ' + f1(m.hi) + '] on ' + m.n + ' pairs' + (m.vs_none ? '; vs no gstack ' + f1(m.vs_none.d) + ' [' + f1(m.vs_none.lo) + ', ' + f1(m.vs_none.hi) + ']' : ''));
  return r.verdict + ' ' + r.tag + ' candidate=' + r.candidate.sha.slice(0, 12) + ' stable=' + r.stable.tag + (rows.length ? ' ' + rows.join('; ') : '') + '; ' + r.flags.length + ' flag' + (r.flags.length === 1 ? '' : 's');
}

/** What the records say about cutting candidate over stable. A HOLD applies when its commit is in the candidate and not yet on stable. */
export function benchmarkStatus(o: { read: Records; git: Git; candidate: string; stable: string | null; now: number; hold?: boolean }): BenchmarkStatus {
  const mode = ' (' + ((o.hold ?? BENCHMARK.hold) ? 'holding' : 'report only') + ')';
  if (!o.read.ok) return { state: 'unreadable', line: 'BENCHMARK: unreadable (' + clean(o.read.why) + ')' + mode, record: null };
  const sorted = newestFirst(o.read.records), r = sorted.find((x) => x.verdict !== 'INCOMPLETE') ?? null, newest = sorted[0];
  const later = newest && newest !== r ? '; the newer ' + newest.tag + ' is INCOMPLETE (' + (newest.incomplete_reason ?? 'no reason given') + ')' : '';
  if (!r) return { state: 'none', line: 'BENCHMARK: none (' + (newest ? 'every record is INCOMPLETE' + later : 'no weekly record published yet') + ')' + mode, record: null };
  if (r.verdict !== 'HOLD') {
    const stale = r.stale_after !== null && o.now > Date.parse(r.stale_after);
    return { state: 'clear', line: 'BENCHMARK: ' + (stale ? 'stale (' + Math.floor((o.now - r.start) / DAY) + ' d) ' : '') + summary(r) + later + mode, record: r };
  }
  const held = r.candidate.sha;
  if (!o.git(['cat-file', '-e', held + '^{commit}']).ok) return { state: 'unreadable', line: 'BENCHMARK: unreadable (the held commit ' + held.slice(0, 12) + ' is not in this clone) ' + summary(r) + mode, record: r };
  if (o.stable && o.git(['merge-base', '--is-ancestor', held, o.stable]).ok) return { state: 'clear', line: 'BENCHMARK: ' + summary(r) + '; the held commit is already on stable, so GStack Minder picks fix-forward or rollback (docs/releases.md#rolling-stable-back)' + later + mode, record: r };
  if (!o.git(['merge-base', '--is-ancestor', held, o.candidate]).ok) return { state: 'clear', line: 'BENCHMARK: ' + summary(r) + '; the candidate ' + o.candidate.slice(0, 12) + ' does not contain the held commit' + later + mode, record: r };
  return { state: 'hold', line: 'BENCHMARK: ' + summary(r) + later + mode, record: r };
}

const WAIVE = "a later weekly record on a newer commit replaces the HOLD; or revert, or cut by hand: gh workflow run weekly-release.yml -f ref=<sha> -f benchmark_waiver='<why>' -f dry_run=false (docs/releases.md#weekly-benchmark)";

/**
 * What the cut does about the status (Garry's "Do it", 2026-11-23: A1 to E1). trigger is the daily check's trigger,
 * or 'hand' for a plain or --ref cut. Urgent spans (important: security, data-loss or regression) and exception cuts
 * pass with the held commit riding along. A regular or blocker-only cut waits quietly; the 7-day forced cut is
 * STABLE_STALE, red, so someone fixes, reverts or waives (E1); a hand cut is refused. Unreadable records hold back only
 * a regular cut, for a day; every other cut goes ahead with a warning.
 */
export function benchmarkGate(s: BenchmarkStatus, o: { hold?: boolean; trigger: Trigger | 'hand' | null; important: ImportantChange[]; exception: string | null; waiver: string | null }): Gate {
  if (!(o.hold ?? BENCHMARK.hold)) return { action: 'pass' };
  if (s.state === 'unreadable') {
    if (o.trigger === 'regular') return { action: 'wait', code: 'BENCHMARK_UNKNOWN', level: 'notice', line: 'BENCHMARK_UNKNOWN: the weekly records could not be read, so a HOLD cannot be ruled out; the regular cut waits for the next daily run' };
    return { action: 'pass', level: 'warning', line: 'BENCHMARK: this ' + (o.trigger ?? 'finishing') + ' cut goes ahead without the weekly benchmark check' };
  }
  if (s.state !== 'hold' || o.trigger === null) return { action: 'pass' };
  const held = s.record!.candidate.sha.slice(0, 12) + ' (' + s.record!.tag + ')';
  const urgent = o.exception ?? o.important.filter((c) => URGENT.has(c.kind)).map((c) => c.kind).join(', ');
  if (urgent) return { action: 'pass', level: 'warning', line: 'BENCHMARK: HOLD on ' + held + ' bypassed by ' + urgent + '; the held commit ships with the fix' };
  if (o.waiver) return { action: 'pass', level: 'warning', line: 'BENCHMARK: HOLD on ' + held + ' waived: ' + o.waiver };
  if (o.trigger === 'forced') return { action: 'refuse', code: 'STABLE_STALE', level: 'error', line: 'STABLE_STALE: stable is 7 days old and the weekly benchmark holds ' + held + '; ' + WAIVE };
  if (o.trigger === 'hand') return { action: 'refuse', code: 'REFUSED_BENCHMARK', level: 'error', line: 'REFUSED_BENCHMARK: the weekly benchmark holds ' + held + '; ' + WAIVE };
  return { action: 'wait', code: 'REFUSED_BENCHMARK', level: 'notice', line: 'REFUSED_BENCHMARK: the ' + o.trigger + ' cut waits: the weekly benchmark holds ' + held + '; ' + WAIVE };
}

/** The waiver an earlier run of this cut wrote into its annotated tag, so a retry of a half-finished cut is not held again. */
export function waiverFromTag(git: Git, tag: string): string | null {
  const t = git(['tag', '-l', '--format=%(contents)', tag]);
  return t.ok ? /^Benchmark-waiver: (.+)$/m.exec(t.out)?.[1]?.trim() ?? null : null;
}
