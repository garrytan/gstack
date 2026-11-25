/**
 * An ended or dead /ship run stops holding gstack upgrades on its machine (gskills#25, GST-3546). Before, an ended /ship run held
 * upgrades for an hour. Moved from round-cap-ruling-path.test.ts when GST-3562 part 4 deleted the round-grant path it also covered.
 * Fixtures are synthetic.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { liveRun } from '../lib/ship-run-live';
import { abandonRefusal, readRunRecord, thisRunOwner, type RunOwner } from '../lib/ship-run-record';
import { RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.dirname(RELEASE);
const fxs: ShipFx[] = [];
const kids: ChildProcess[] = [];
const tmps: string[] = [];
afterEach(() => {
  while (fxs.length) fxs.pop()!.cleanup();
  for (const k of kids.splice(0)) k.kill('SIGKILL');
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const TEST = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); });\n";
const ok = (r: { status: number | null; stderr: string; stdout: string }) => { expect(r.status, r.stderr + r.stdout).toBe(0); return r.stdout; };
const headOf = (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim();
const marker = (f: ShipFx, run: string) => fs.writeFileSync(path.resolve(f.work, f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim()), run + '\n');

interface Cap { f: ShipFx; S: string }

/** A fixture whose round-2 review row is logged under /ship run r2 at head S. */
function atCap(): Cap {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n', 'test/x.test.ts': TEST });
  fxs.push(f);
  const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
  marker(f, 'r2');
  const start = ok(run('gstack-review-log', ['--start', 'review'])).trim();
  ok(run('gstack-review-log', [JSON.stringify({ skill: 'review', timestamp: new Date().toISOString(), via: 'ship', review_scope: 'frozen', pass: 2, completed: true, converged: true, status: 'clean', issues_found: 0, critical: 0, informational: 0, findings: [] }), '--finish', start]));
  return { f, S: headOf(f) };
}

describe('an ended or dead /ship run stops holding gstack upgrades (gskills#25)', () => {
  const stateRoot = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-live-'))); tmps.push(d); return d; };
  const ledger = (sr: string, run: string, extra: Record<string, unknown>) => {
    fs.mkdirSync(path.join(sr, 'ship-runs', run), { recursive: true });
    fs.writeFileSync(path.join(sr, 'ship-runs', run, 'budget.json'), JSON.stringify({ kind: 'gstack-ship-budget', run, created_at: new Date(Date.now() - 60_000).toISOString(), ...extra }));
  };
  const sleeper = () => { const k = spawn('sleep', ['300'], { stdio: 'ignore' }); kids.push(k); return k.pid!; };
  const ownerOf = (pid: number): RunOwner => { const o = thisRunOwner(pid)!; expect(o).not.toBeNull(); return o; };
  const deadOwner = (): RunOwner => { const k = spawnSync('sleep', ['0'], { timeout: 10_000 }); const { shared: _shared, ...here } = ownerOf(process.pid); return { ...here, pid: k.pid!, comm: 'claude' }; };

  // Value: protects=an ended run (its harness gone, or its own checkout run record finished or abandoned) no longer holds upgrades,
  //   while a live, stopped (it may still claim its grant) or unprovable one still does; fails_when=a dead run holds, a stopped run or
  //   an earlier run's finished record releases, or a run on a shared harness is released; seam=liveRun
  test('dead owner and this run\'s finished record release; a live owner, a stopped run, an older record and a shared harness hold', () => {
    if (process.platform !== 'linux') return;
    const sr = stateRoot();
    ledger(sr, 'dead', { owner: deadOwner() });
    expect(liveRun(sr)).toMatchObject({ ended: [expect.stringContaining('/ship run dead: its owner process')] });
    expect(liveRun(sr).live).toBeUndefined();
    const c = atCap();
    const recordFile = path.resolve(c.f.work, c.f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim());
    const record = (state: string, started: number) => fs.writeFileSync(recordFile, JSON.stringify({ v: 1, run: 'r2', state, head: c.S, started_at: new Date(started).toISOString(), beat_at: new Date().toISOString() }) + '\n');
    const shared = { ...ownerOf(process.pid), shared: true };
    record('stopped', Date.now());
    ledger(sr, 'mine', { checkout: c.f.work, owner: shared });
    expect(liveRun(sr).live).toContain('/ship run mine');
    record('finished', Date.now() - 3_600_000);
    expect(liveRun(sr).live).toContain('/ship run mine');
    ledger(sr, 'other', { checkout: c.f.work, owner: shared, created_at: new Date(Date.now() - 30_000).toISOString() });
    record('finished', Date.now());
    expect(liveRun(sr).live).toContain('/ship run mine');
    fs.rmSync(path.join(sr, 'ship-runs', 'other'), { recursive: true });
    expect(liveRun(sr).live).toBeUndefined();
    ledger(sr, 'alive', { owner: ownerOf(sleeper()) });
    expect(liveRun(sr).live).toContain('/ship run alive');
    fs.rmSync(path.join(sr, 'ship-runs', 'alive'), { recursive: true });
    ledger(sr, 'legacy', {});
    expect(liveRun(sr).live).toContain('/ship run legacy');
    const out = spawnSync(path.join(BIN, 'gstack-ship-run'), ['live', '--state-root', sr], { encoding: 'utf8', timeout: 60_000 });
    expect(out.stdout).toContain('RUN_LIVE: /ship run legacy');
    expect(out.stdout).toContain('RUN_HOLD_RELEASED: /ship run dead');
  });

  // Value: protects=abandon takes a run whose owner is provably gone at once, instead of after 60 minutes; fails_when=
  //   SHIP_RUN_ABANDON_REFUSED for a run whose harness exited; seam=abandonRefusal
  test('abandon refuses a fresh run under a live or shared owner and takes one whose owner is gone', () => {
    if (process.platform !== 'linux') return;
    const c = atCap();
    const now = new Date().toISOString();
    const file = path.resolve(c.f.work, c.f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim());
    const put = (owner: RunOwner) => { fs.writeFileSync(file, JSON.stringify({ v: 1, run: 'r2', state: 'open', head: c.S, started_at: now, beat_at: now, owner }) + '\n'); return readRunRecord(c.f.work); };
    expect(abandonRefusal(put(ownerOf(sleeper())), 'r2', undefined)).toContain('still working');
    expect(abandonRefusal(put({ ...ownerOf(process.pid), shared: true }), 'r2', undefined)).toContain('still working');
    expect(abandonRefusal(put(deadOwner()), 'r2', undefined)).toBeNull();
  });
});
