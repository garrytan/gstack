/**
 * B10: phase wall time to timing.json and the analytics log, the Phase 0
 * estimate from history (median of the last 10, `no history` when empty), and
 * the ephemeral-root skip line. Pins file contents, tokens and exit codes.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TIMING_SKIPPED_LINE, estimate, median, phaseClose, phaseStart, readTiming, renderEstimate, renderSummary, runStart } from '../lib/autoplan-timing';
import { EXIT, validateFile } from '../lib/headless-artifacts';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-autoplan-timing');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-timing-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(BIN, args, { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH!, HOME: tmp, GSTACK_STATE_ROOT: path.join(tmp, 'state'), ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('phase timing', () => {
  test('start then close writes started_at/ended_at/wall_s/voices to timing.json (valid timing v1) and appends one analytics row', () => {
    const file = path.join(tmp, 'run', 'timing.json');
    const analytics = path.join(tmp, 'state', 'analytics', 'autoplan-timing.jsonl');
    const t0 = new Date('2026-10-10T20:30:29Z');
    phaseStart(file, 'r1', 'ceo', t0);
    const closed = phaseClose(file, 'r1', 'ceo', { outside_s: 169, native_s: 384, session_kind: 'unattended', now: new Date('2026-10-10T20:44:52Z'), env: {}, analytics });
    expect(closed.entry).toEqual({ phase: 'ceo', started_at: '2026-10-10T20:30:29.000Z', ended_at: '2026-10-10T20:44:52.000Z', wall_s: 863, outside_s: 169, native_s: 384 });
    expect(closed.analytics).toBe('appended');
    phaseStart(file, 'r1', 'eng', new Date('2026-10-10T20:54:02Z'));
    const eng = phaseClose(file, 'r1', 'eng', { outside_s: 227, now: new Date('2026-10-10T21:18:00Z'), env: {}, analytics });
    expect(eng.total_wall_s).toBe(2851);
    const timing = readTiming(file, 'r1');
    expect(timing.schema_version).toBe(1);
    expect(timing.session_kind).toBe('unattended');
    expect(timing.phases.map(p => p.phase)).toEqual(['ceo', 'eng']);
    expect(validateFile(file, 'timing')).toEqual([]);
    const rows = fs.readFileSync(analytics, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ event: 'phase', run: 'r1', phase: 'ceo', wall_s: 863, outside_s: 169, native_s: 384, session_kind: 'unattended' });
    expect(rows[1]).toMatchObject({ phase: 'eng', native_s: null });
  });

  test('close without a start measures from the previous close, else the run start, else now', () => {
    const file = path.join(tmp, 'timing.json');
    const analytics = path.join(tmp, 'a.jsonl');
    expect(phaseClose(file, 'r2', 'dx', { env: {}, analytics }).entry.wall_s).toBe(0);
    const file2 = path.join(tmp, 'run2', 'timing.json');
    runStart(file2, 'r3', new Date('2026-10-10T20:30:00Z'));
    const ceo = phaseClose(file2, 'r3', 'ceo', { now: new Date('2026-10-10T20:45:00Z'), env: {}, analytics });
    expect(ceo.entry).toMatchObject({ started_at: '2026-10-10T20:30:00.000Z', wall_s: 900 });
    const eng = phaseClose(file2, 'r3', 'eng', { now: new Date('2026-10-10T21:18:00Z'), env: {}, analytics });
    expect(eng.entry).toMatchObject({ started_at: '2026-10-10T20:45:00.000Z', wall_s: 1980 });
    expect(eng.total_wall_s).toBe(2880);
    expect(readTiming(file2, 'r3').phases.map(p => p.phase)).toEqual(['ceo', 'eng']);
  });

  test('ephemeral state root: timing.json is written, analytics is skipped with the explicit line', () => {
    const file = path.join(tmp, 'timing.json');
    const analytics = path.join(tmp, 'state', 'analytics', 'autoplan-timing.jsonl');
    const r = phaseClose(file, 'r3', 'ceo', { env: { GSTACK_EPHEMERAL: '1' }, analytics });
    expect(r.analytics).toBe('skipped_ephemeral');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(analytics)).toBe(false);
    const bin = run(['close', '--run', 'r3', '--phase', 'eng', '--out', tmp], { GSTACK_EPHEMERAL: '1' });
    expect(bin.code).toBe(EXIT.ok);
    expect(bin.err.trim()).toBe(TIMING_SKIPPED_LINE);
    expect(bin.out).toMatch(/^TIMING: phase=eng wall_s=\d+ total_wall_s=\d+ analytics=skipped_ephemeral$/m);
    expect(fs.existsSync(path.join(tmp, 'state'))).toBe(false);
  });
});

describe('estimate', () => {
  test('median of the last 10 recorded closes per phase; `no history` when empty', () => {
    expect(median([])).toBeUndefined();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(3);
    const analytics = path.join(tmp, 'a.jsonl');
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({ event: 'phase', run: `r${i}`, phase: 'ceo', wall_s: 100 + i * 100 })),
      { event: 'phase', run: 'x', phase: 'eng', wall_s: 1438 },
      { event: 'ack', run: 'x', consumer: 'c' },
      { event: 'phase', run: 'x', phase: 'eng', wall_s: 'bad' },
    ];
    fs.writeFileSync(analytics, rows.map(r => JSON.stringify(r)).join('\n') + '\nnot json\n');
    const est = estimate(analytics, ['ceo', 'design', 'eng']);
    expect(est).toEqual([
      { phase: 'ceo', median_s: 750, samples: 10 },
      { phase: 'design', median_s: undefined, samples: 0 },
      { phase: 'eng', median_s: 1438, samples: 1 },
    ]);
    expect(renderEstimate(est)).toBe('ESTIMATE: ceo ~13m (n=10) | design no history | eng ~24m (n=1) | total: partial history');
    expect(renderEstimate(estimate(path.join(tmp, 'missing.jsonl'), ['ceo', 'eng']))).toBe('ESTIMATE: ceo no history | eng no history');
    expect(renderEstimate(estimate(analytics, ['ceo', 'eng']))).toBe('ESTIMATE: ceo ~13m (n=10) | eng ~24m (n=1) | total ~36m');
  });

  test('bin: estimate reads the state root; summary prints actual beside estimate', () => {
    const state = path.join(tmp, 'state');
    expect(run(['estimate', '--phases', 'ceo,eng']).out.trim()).toBe('ESTIMATE: ceo no history | eng no history');
    const out = path.join(tmp, 'run');
    expect(run(['estimate', '--run', 'r', '--out', out]).code).toBe(EXIT.ok);
    expect(typeof readTiming(path.join(out, 'timing.json'), 'r').started_at).toBe('string');
    expect(run(['estimate', '--run', 'r']).code).toBe(EXIT.usage);
    expect(run(['start', '--run', 'r', '--phase', 'ceo', '--out', out]).code).toBe(EXIT.ok);
    const close = run(['close', '--run', 'r', '--phase', 'ceo', '--out', out, '--outside-s', '169', '--json']);
    expect(close.code).toBe(EXIT.ok);
    expect(JSON.parse(close.out)).toMatchObject({ analytics: 'appended', entry: { phase: 'ceo', outside_s: 169 } });
    expect(fs.existsSync(path.join(state, 'analytics', 'autoplan-timing.jsonl'))).toBe(true);
    const est = JSON.parse(run(['estimate', '--phases', 'ceo,eng', '--json']).out);
    expect(est.phases[0]).toMatchObject({ phase: 'ceo', samples: 1 });
    expect(est.phases[1]).toMatchObject({ phase: 'eng', samples: 0 });
    const summary = run(['summary', '--run', 'r', '--out', out, '--phases', 'ceo']);
    expect(summary.out).toMatch(/^CYCLE: actual \d+s \(estimate \d+s\) \| ceo \d+s \(outside 3m\)$/m);
    expect(summary.out).not.toContain('GSTACK_RESULT');
    expect(renderSummary({ schema_version: 1, run: 'r', phases: [] })).toBe('CYCLE: actual 0s (estimate no history) | no phases closed');
  });

  test('exit table: usage 2 on missing flags, help prints the table, bad seconds is usage', () => {
    expect(run(['close', '--run', 'r']).code).toBe(EXIT.usage);
    expect(run(['start', '--run', 'r', '--out', tmp]).code).toBe(EXIT.usage);
    expect(run(['close', '--run', 'r', '--phase', 'ceo', '--out', tmp, '--outside-s', 'ten']).code).toBe(EXIT.usage);
    expect(run([]).code).toBe(EXIT.usage);
    expect(run(['--help']).out).toContain('Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag');
  });
});
