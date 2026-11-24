/**
 * release-benchmark (free): the stable cut reads gstack-evals' weekly benchmark records (docs/releases.md#weekly-benchmark).
 * Records here have the shape gstack-evals' lanes/weekly-stable/read.ts weekRecord writes (schema 1). The newest record
 * by run start that is not INCOMPLETE decides; a HOLD never goes stale; with the hold switched on, urgent cuts pass, a
 * regular cut waits, the 7-day forced cut goes red and a hand cut is refused (Garry's "Do it", 2026-11-23).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BENCHMARK, benchmarkGate, benchmarkStatus, newestFirst, parseRecord, readRecords, waiverFromTag, type BenchmarkStatus, type Records, type WeeklyRecord } from '../lib/release-benchmark';
import type { ImportantChange } from '../scripts/release-cadence';
import type { Gh, Git } from '../scripts/release-cut';

const sha = (c: string) => c.repeat(40);
const HELD = sha('a'), STABLE = sha('b'), CAND = sha('c'), OTHER = sha('d');
const DAY = 86_400_000;
const NOW = Date.parse('2026-12-10T12:00:00Z');

function rec(verdict: string, o: { week?: string; start?: string; cand?: string; hi?: number } = {}) {
  const start = o.start ?? '2026-11-28T06:00:00Z', ran = verdict !== 'INCOMPLETE';
  const hi = o.hi ?? (verdict === 'HOLD' ? -0.8 : 4.0);
  return {
    schema: 1, week: o.week ?? '2026-W48', task_set: 'v1', candidate: { sha: o.cand ?? HELD }, stable: { tag: 'v1.103.0.0', sha: STABLE }, window: { start, end: start }, verdict,
    mdd_points: 5.5, interval: 0.95,
    models: ran ? { 'claude-opus-5-5': { host: 'claude-code', n: 390, d: hi - 4, lo: hi - 8, hi, vs_none: { d: -2.1, lo: -6, hi: 1.7 } } } : {},
    areas: [], flags: ['gpt-6.2-sol not run'], incomplete_reason: ran ? null : 'the smoke failed', stopped_early: false,
    stale_after: { verdict: verdict === 'HOLD' ? null : new Date(Date.parse(start) + 9 * DAY).toISOString(), flags: new Date(Date.parse(start) + 9 * DAY).toISOString() },
    realized: null, results_check: 'pass', prereg: 'x', results: 'x', run: 'x',
  };
}
const parsed = (tag: string, r: object) => parseRecord(tag, JSON.stringify(r)) as WeeklyRecord;
const records = (...rs: [string, object][]): Records => ({ ok: true, records: rs.map(([tag, r]) => parsed(tag, r)) });

/** Ancestry as a set of [ancestor, descendant] pairs; every listed sha exists. */
function fakeGit(edges: [string, string][], o: { missing?: string[]; tags?: Record<string, string> } = {}): Git {
  return (args) => {
    if (args[0] === 'cat-file') return { ok: !(o.missing ?? []).some((m) => args[2]!.startsWith(m)), out: '' };
    if (args[0] === 'merge-base') return { ok: args[2] === args[3] || edges.some(([a, d]) => a === args[2] && d === args[3]), out: '' };
    if (args[0] === 'tag') { const t = o.tags?.[args[3]!]; return t === undefined ? { ok: true, out: '' } : { ok: true, out: t }; }
    return { ok: false, out: 'unexpected git ' + args.join(' ') };
  };
}
const inCandidate = fakeGit([[STABLE, CAND], [HELD, CAND], [STABLE, HELD]]);
const status = (read: Records, git: Git = inCandidate, hold = true) => benchmarkStatus({ read, git, candidate: CAND, stable: STABLE, now: NOW, hold });
const urgent = (kind: ImportantChange['kind']): ImportantChange[] => [{ kind, path: 'changelog.d/x.md', commit: OTHER, pr: '1' }];

describe('release-benchmark: reading the records', () => {
  test('parseRecord checks schema, verdict, run start, shas and numbers, and refuses a verdict its model rows contradict', () => {
    expect(parsed('weekly-2026-w48', rec('NO_CHANGE')).verdict).toBe('NO_CHANGE');
    expect(parseRecord('t', 'not json')).toContain('is not JSON');
    expect(parseRecord('t', JSON.stringify({ ...rec('GAIN'), schema: 2 }))).toContain('schema 2, not 1');
    expect(parseRecord('t', JSON.stringify({ ...rec('GAIN'), verdict: 'FLAG' }))).toContain('verdict FLAG is not');
    expect(parseRecord('t', JSON.stringify({ ...rec('GAIN'), window: { start: 'soon' } }))).toContain('window.start is not a time');
    expect(parseRecord('t', JSON.stringify({ ...rec('GAIN'), candidate: { sha: 'abc' } }))).toContain('not a 40-hex sha');
    expect(parseRecord('t', JSON.stringify({ ...rec('HOLD'), models: { m: { n: 1, d: 'x', lo: 0, hi: -1 } } }))).toContain('is not numeric');
    expect(parseRecord('t', JSON.stringify({ ...rec('NO_CHANGE', { hi: -0.1 }) }))).toContain('verdict mismatch');
    expect(parseRecord('t', JSON.stringify({ ...rec('HOLD', { hi: 0.4 }) }))).toContain('verdict mismatch');
    expect(parsed('t', rec('INCOMPLETE')).models).toEqual({});
  });

  test('a vs_none with a non-numeric field is dropped rather than crashing the cut, and record text cannot start a workflow command', () => {
    const odd = (vs: unknown) => ({ ...rec('NO_CHANGE'), models: { 'claude-opus-5-5': { host: 'claude-code', n: 390, d: 0, lo: -4, hi: 4, vs_none: vs } } });
    for (const vs of [{ d: null, lo: null, hi: null }, {}, null]) {
      const s = status(records(['weekly-2026-w48', odd(vs)]));
      expect(s.state).toBe('clear');
      expect(s.line).toContain('claude-opus-5-5 +0.0 [-4.0, +4.0] on 390 pairs; 1 flag');
    }
    expect(status(records(['weekly-2026-w48', rec('NO_CHANGE')])).line).toContain('; vs no gstack -2.1 [-6.0, +1.7]');
    const injected = status(records(['weekly-2026-w48', rec('NO_CHANGE')], ['weekly-2026-w49', { ...rec('INCOMPLETE', { week: '2026-W49', start: '2026-12-05T06:00:00Z' }), incomplete_reason: 'x\n::stop-commands::tok' }]));
    expect(injected.line).toContain('the newer weekly-2026-w49 is INCOMPLETE (x ::stop-commands::tok)');
    expect(injected.line).not.toContain('\n');
  });

  test('a refused schema or verdict cannot start a workflow command in the unreadable line', () => {
    for (const bad of [{ ...rec('GAIN'), verdict: 'x\n::stop-commands::tok' }, { ...rec('GAIN'), schema: '1\n::add-mask::tok' }]) {
      const why = parseRecord('weekly-2026-w48', JSON.stringify(bad));
      expect(typeof why).toBe('string');
      const s = status({ ok: false, why: why as string });
      expect(s.state).toBe('unreadable');
      expect(s.line).not.toContain('\n');
    }
  });

  test('a __proto__ model row still counts toward the verdict, and model ids that clean alike are refused', () => {
    const held = JSON.stringify(rec('HOLD')).replace('"models":{"claude-opus-5-5"', '"models":{"__proto__":{"n":10,"d":-5,"lo":-8,"hi":-2},"claude-opus-5-5"');
    const r = parseRecord('weekly-2026-w48', held) as WeeklyRecord;
    expect(typeof r).toBe('object');
    expect(Object.keys(r.models)).toEqual(['__proto__', 'claude-opus-5-5']);
    const gain = JSON.stringify(rec('GAIN')).replace('"models":{"claude-opus-5-5"', '"models":{"__proto__":{"n":10,"d":-5,"lo":-8,"hi":-1},"claude-opus-5-5"');
    expect(parseRecord('weekly-2026-w48', gain)).toContain('verdict mismatch');
    const twins = { ...rec('GAIN'), models: { 'm\n': { n: 1, d: -2, lo: -4, hi: -1 }, 'm ': { n: 1, d: 1, lo: 0, hi: 2 } } };
    expect(parseRecord('weekly-2026-w48', JSON.stringify(twins))).toContain('collide');
  });

  test('readRecords lists weekly tags only, retries each call once, and any failure makes the whole read unreadable', () => {
    const calls: string[][] = [];
    let flaky = 1;
    const gh: Gh = (args) => {
      calls.push(args);
      if (args[1] === 'list') return flaky-- > 0 ? { status: 1, stdout: '', stderr: 'HTTP 502' } : { status: 0, stdout: JSON.stringify([{ tagName: 'weekly-2026-w48' }, { tagName: 'v1.0.0' }, { tagName: 'weekly-2026-w48-r1' }]), stderr: '' };
      return { status: 0, stdout: JSON.stringify(rec(args[2] === 'weekly-2026-w48' ? 'HOLD' : 'NO_CHANGE')), stderr: '' };
    };
    const read = readRecords(gh);
    expect(read.ok && read.records.map((r) => r.tag)).toEqual(['weekly-2026-w48', 'weekly-2026-w48-r1']);
    expect(calls.filter((c) => c[1] === 'list')).toHaveLength(2);
    expect(calls[0]).toEqual(['release', 'list', '--repo', BENCHMARK.repo, '--limit', '200', '--json', 'tagName']);
    expect(calls.find((c) => c[1] === 'download')).toEqual(['release', 'download', 'weekly-2026-w48', '--repo', BENCHMARK.repo, '-p', 'weekly.json', '-O', '-']);
    const down: Gh = (args) => (args[1] === 'list' ? { status: 0, stdout: '[{"tagName":"weekly-2026-w48"}]', stderr: '' } : { status: 1, stdout: '', stderr: 'not found' });
    expect(readRecords(down)).toEqual({ ok: false, why: 'gh release download weekly-2026-w48 failed: not found' });
    const bad: Gh = (args) => (args[1] === 'list' ? { status: 0, stdout: '[{"tagName":"weekly-2026-w48"}]', stderr: '' } : { status: 0, stdout: '{', stderr: '' });
    expect(readRecords(bad).ok).toBe(false);
  });

  test('newest first by run start, and a -r<k> correction before the record it follows', () => {
    const rs = records(['weekly-2026-w48', rec('HOLD')], ['weekly-2026-w48-r1', rec('NO_CHANGE')], ['weekly-2026-w49', rec('GAIN', { start: '2026-12-05T06:00:00Z' })]);
    expect(newestFirst(rs.ok ? rs.records : []).map((r) => r.tag)).toEqual(['weekly-2026-w49', 'weekly-2026-w48-r1', 'weekly-2026-w48']);
  });
});

describe('release-benchmark: which record decides', () => {
  test('no records is none; only INCOMPLETE records is none and says why', () => {
    expect(status({ ok: true, records: [] })).toMatchObject({ state: 'none', line: 'BENCHMARK: none (no weekly record published yet) (holding)' });
    const s = status(records(['weekly-2026-w48', rec('INCOMPLETE')]));
    expect(s.state).toBe('none');
    expect(s.line).toContain('every record is INCOMPLETE; the newer weekly-2026-w48 is INCOMPLETE (the smoke failed)');
  });

  test('a HOLD whose commit is in the candidate and not on stable holds, and the line carries the numbers', () => {
    const s = status(records(['weekly-2026-w48', rec('HOLD')]));
    expect(s.state).toBe('hold');
    expect(s.line).toBe('BENCHMARK: HOLD weekly-2026-w48 candidate=aaaaaaaaaaaa stable=v1.103.0.0 claude-opus-5-5 -4.8 [-8.8, -0.8] on 390 pairs; vs no gstack -2.1 [-6.0, +1.7]; 1 flag (holding)');
  });

  test('HOLD lifetime: never stale, not cleared by INCOMPLETE weeks, replaced by any later reading (bridge weeks included)', () => {
    const late = NOW + 30 * DAY;
    const held = (read: Records, now = NOW) => benchmarkStatus({ read, git: inCandidate, candidate: CAND, stable: STABLE, now, hold: true }).state;
    expect(held(records(['weekly-2026-w48', rec('HOLD')]), late)).toBe('hold');
    expect(held(records(['weekly-2026-w48', rec('HOLD')], ['weekly-2026-w49', rec('INCOMPLETE', { start: '2026-12-05T06:00:00Z' })], ['weekly-2026-w50', rec('INCOMPLETE', { start: '2026-12-12T06:00:00Z' })], ['weekly-2026-w51', rec('INCOMPLETE', { start: '2026-12-19T06:00:00Z' })]), late)).toBe('hold');
    expect(held(records(['weekly-2026-w48', rec('HOLD')], ['weekly-2026-w49', rec('NO_CHANGE', { start: '2026-12-05T06:00:00Z', cand: OTHER })]))).toBe('clear');
    const bridge = { ...rec('NO_CHANGE', { start: '2026-12-05T06:00:00Z', cand: OTHER }), flags: ['bridge week: the rig changed'] };
    expect(held(records(['weekly-2026-w48', rec('HOLD')], ['weekly-2026-w49', bridge]))).toBe('clear');
    expect(held(records(['weekly-2026-w48', rec('HOLD')], ['weekly-2026-w48-r1', rec('NO_CHANGE', { cand: OTHER })]))).toBe('clear');
    const newer = status(records(['weekly-2026-w48', rec('NO_CHANGE', { cand: OTHER })], ['weekly-2026-w49', rec('HOLD', { start: '2026-12-05T06:00:00Z' })]));
    expect(newer.state).toBe('hold');
    expect(newer.record!.tag).toBe('weekly-2026-w49');
  });

  test('a HOLD already on stable, one the candidate lacks, or one missing from the clone does not hold', () => {
    const one = records(['weekly-2026-w48', rec('HOLD')]);
    const onStable = status(one, fakeGit([[HELD, STABLE], [STABLE, CAND], [HELD, CAND]]));
    expect(onStable.state).toBe('clear');
    expect(onStable.line).toContain('the held commit is already on stable');
    expect(status(one, fakeGit([[STABLE, CAND]])).line).toContain('does not contain the held commit');
    const missing = status(one, fakeGit([], { missing: ['a'] }));
    expect(missing.state).toBe('unreadable');
    expect(missing.line).toContain('is not in this clone');
  });

  test('staleness drops only GAIN, NO_CHANGE and FLAG readings, nine days after their run started', () => {
    for (const v of ['GAIN', 'NO_CHANGE']) {
      const r = records(['weekly-2026-w48', rec(v, { cand: OTHER })]);
      expect(benchmarkStatus({ read: r, git: inCandidate, candidate: CAND, stable: STABLE, now: Date.parse('2026-12-06T00:00:00Z') }).line).not.toContain('stale');
      const s = benchmarkStatus({ read: r, git: inCandidate, candidate: CAND, stable: STABLE, now: Date.parse('2026-12-08T00:00:00Z') });
      expect(s.state).toBe('clear');
      expect(s.line).toContain('BENCHMARK: stale (9 d) ' + v);
      expect(s.line).toEndWith('(report only)');
    }
  });

  test('an unreadable read says why', () => {
    expect(status({ ok: false, why: 'gh release list failed: HTTP 502' })).toMatchObject({ state: 'unreadable', line: 'BENCHMARK: unreadable (gh release list failed: HTTP 502) (holding)' });
  });
});

describe('release-benchmark: what the cut does (benchmarkGate)', () => {
  const hold = status(records(['weekly-2026-w48', rec('HOLD')]));
  const unreadable: BenchmarkStatus = { state: 'unreadable', line: 'x', record: null };
  const gate = (s: BenchmarkStatus, trigger: Parameters<typeof benchmarkGate>[1]['trigger'], o: Partial<Parameters<typeof benchmarkGate>[1]> = {}) =>
    benchmarkGate(s, { hold: true, trigger, important: [], exception: null, waiver: null, ...o });

  test('report only (the shipped default) never stops a cut', () => {
    expect(BENCHMARK.hold).toBe(false);
    for (const t of ['regular', 'forced', 'important', 'hand'] as const) expect(benchmarkGate(hold, { trigger: t, important: [], exception: null, waiver: null })).toEqual({ action: 'pass' });
  });

  test('a HOLD: regular and blocker-only cuts wait, the forced cut is STABLE_STALE, a hand cut is refused', () => {
    expect(gate(hold, 'regular')).toMatchObject({ action: 'wait', code: 'REFUSED_BENCHMARK', level: 'notice' });
    expect(gate(hold, 'important', { important: urgent('blocker') })).toMatchObject({ action: 'wait', code: 'REFUSED_BENCHMARK' });
    const forced = gate(hold, 'forced');
    expect(forced).toMatchObject({ action: 'refuse', code: 'STABLE_STALE', level: 'error' });
    expect(forced.line).toContain('STABLE_STALE: stable is 7 days old and the weekly benchmark holds aaaaaaaaaaaa (weekly-2026-w48)');
    expect(forced.line).toContain('benchmark_waiver');
    expect(gate(hold, 'hand')).toMatchObject({ action: 'refuse', code: 'REFUSED_BENCHMARK', level: 'error' });
  });

  test('urgent spans, exception cuts and waivers pass and say the held commit ships', () => {
    for (const k of ['security', 'data-loss', 'regression'] as const) {
      const g = gate(hold, 'important', { important: [...urgent('blocker'), ...urgent(k)] });
      expect(g.action).toBe('pass');
      expect(g.line).toContain('bypassed by ' + k + '; the held commit ships with the fix');
    }
    expect(gate(hold, 'hand', { exception: 'security' })).toMatchObject({ action: 'pass', level: 'warning' });
    expect(gate(hold, 'hand', { waiver: 'the drop is the new /ship prompt, accepted' }).line).toBe('BENCHMARK: HOLD on aaaaaaaaaaaa (weekly-2026-w48) waived: the drop is the new /ship prompt, accepted');
  });

  test('a finishing cut (no trigger) and a clear status pass', () => {
    expect(gate(hold, null)).toEqual({ action: 'pass' });
    expect(gate({ state: 'clear', line: 'x', record: null }, 'regular')).toEqual({ action: 'pass' });
  });

  test('unreadable records hold back only a regular cut, for a day; everything else goes ahead with a warning', () => {
    expect(gate(unreadable, 'regular')).toMatchObject({ action: 'wait', code: 'BENCHMARK_UNKNOWN', level: 'notice' });
    for (const t of ['important', 'forced', 'hand'] as const) expect(gate(unreadable, t)).toMatchObject({ action: 'pass', level: 'warning' });
  });

  test('a waiver written into the tag is read back for a retry of a half-finished cut', () => {
    const git = fakeGit([], { tags: { 'v1.104.0.0': 'gstack v1.104.0.0 (hotfix release)\n\nBenchmark-waiver: accepted after review\n' } });
    expect(waiverFromTag(git, 'v1.104.0.0')).toBe('accepted after review');
    expect(waiverFromTag(git, 'v1.0.0')).toBeNull();
  });
});

describe('release-benchmark: gstack-evals still loads release-cut.ts', () => {
  test('the module imports only types, and release-cut keeps the exports the weekly resolver imports', async () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'lib', 'release-benchmark.ts'), 'utf8');
    expect(src.split('\n').filter((l) => l.startsWith('import ') && !l.startsWith('import type '))).toEqual([]);
    const cut = await import('../scripts/release-cut');
    for (const k of ['gitIn', 'runGh', 'readTrainNotes', 'gateVerdict', 'WINDOW_DAYS', 'WINDOW_COMMITS']) expect((cut as Record<string, unknown>)[k]).toBeDefined();
  });
});
