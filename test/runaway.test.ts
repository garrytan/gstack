/**
 * gstack-runaway (/runaway-stopper, org rule R70): find runaway threads and subagents from host data,
 * read-only. Fixtures are shaped like tools.thread.get / tools.subagent.list / transcript items.
 * FOUN4 is a 7-row subset of FOUN-4's 325 subagents, with its real 2026-11-03 totals (6.89B, Subagent 40 at 485M).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-runaway');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runaway-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const NOW = '2026-11-03T22:00:00Z';
const run = (...args: string[]) => {
  const r = spawnSync(BIN, args, { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const write = (name: string, value: unknown) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(value)); return f; };
const task = (n: number, title: string, tokens: number, status = 'done') => ({ label: 'Subagent ' + n, title, status, cost: { credits: tokens / 3000, tokens } });

const FOUN4 = {
  code: 'FOUN-4', status: 'waiting', created_at: '2026-10-21T19:00:59.514Z', updated_at: '2026-11-03T21:27:09.192Z',
  cost: { credits: 2298258.99, tokens: 6889624959 }, tasks_total: 325,
  tasks: [
    task(40, 'Run /ship on PR #442 (careless margin)', 484697736),
    task(55, 'Fix #13 gates on sys/bite', 344437575),
    task(126, 'Targeted money reader on PR #501 HEAD 15438a14', 363426),
    task(127, 'Targeted money reader on PR #501 at df8c3fcb (rules 55)', 559678),
    task(129, 'Targeted money reader on PR #501 at af8b235a', 540450),
    task(130, 'Targeted money reader at 21ef9cf2 (#501 rules 57)', 531872),
    task(132, 'Targeted money reader on #501 at 7ed85c37', 374220),
  ],
};

describe('gstack-runaway scan', () => {
  test('FOUN-4: own tokens and age rotate, the reused /ship subagent is flagged, review rounds counted per PR', () => {
    const r = run('scan', '--thread', write('foun4.json', FOUN4), '--now', NOW);
    expect(r.code).toBe(0);
    expect(r.out).toContain('RUNAWAY: thread=FOUN-4 verdict=ROTATE');
    expect(r.out).toMatch(/own=6\.06B\(upper\)/);
    expect(r.out).toContain('FLAG: ROTATE own_tokens 6.06B > 500M (upper bound)');
    expect(r.out).toMatch(/FLAG: ROTATE age 13\.1d > 3d and active/);
    expect(r.out).toContain('FLAG: LOOK subagent 40 "Run /ship on PR #442 (careless margin)" 485M > 100M (done)');
    expect(r.out).toContain('FLAG: WARN review_rounds 5 on #501 > 2');
    expect(r.out).toContain('review_subagents=5(unattributed 0)');
  });

  test('review titles without a PR number are counted but never attributed; @<sha> names a head', () => {
    const doc = { code: 'FOUN-71', status: 'idle', created_at: '2026-11-03T02:00:00Z', cost: { tokens: 50e6 }, tasks: [
      task(33, 'Cold read A @dc982c25 (poach_fail_1) #526', 1e5), task(65, 'Cold reader A at e2efb180 #526', 1e5),
      task(90, 'cold read A m6 w3m6c', 1e5), task(91, 'cold read B m6 w3m6c', 1e5), task(89, 'ship docs audit w3', 1e5)] };
    const r = run('scan', '--thread', write('unattr.json', doc), '--now', NOW);
    expect(r.out).toContain('max_rounds=2(#526) review_subagents=4(unattributed 2)');
    expect(r.out).not.toContain('review_rounds');
  });

  test('DEFER holds a rotation and a stop of the mid-/ship subagent itself; stopping another subagent goes ahead', () => {
    const doc = { code: 'GSTA-9', status: 'working', created_at: '2026-11-03T10:00:00Z', cost: { tokens: 300e6 },
      tasks: [task(3, 'gate fix lane', 150e6, 'idle'), task(4, 'ship 1 outside-voice (#535)', 2e6, 'working')] };
    const other = run('scan', '--thread', write('defer.json', doc), '--now', NOW);
    expect(other.out).toContain('verdict=STOP');
    expect(other.out).toContain('FLAG: STOP subagent 3 "gate fix lane" 150M > 100M (idle)');
    expect(other.out).not.toContain('DEFER:');
    const self = { ...doc, tasks: [task(5, 'ship #4001 at abc1234 q7x2', 140e6, 'working')] };
    const s = run('scan', '--thread', write('defer-self.json', self), '--now', NOW);
    expect(s.out).toContain('verdict=DEFER');
    expect(s.out).toContain('DEFER: mid-ship or mid-merge: 5 "ship #4001 at abc1234 q7x2" working');
    const rot = { ...doc, created_at: '2026-10-25T00:00:00Z', tasks: [task(4, 'ship 1 outside-voice (#535)', 2e6, 'working')] };
    expect(run('scan', '--thread', write('defer-rot.json', rot), '--now', NOW).out).toContain('verdict=DEFER');
    const watcher = { ...rot, tasks: [task(6, 'pregate watcher', 1e6, 'waiting')] };
    expect(run('scan', '--thread', write('defer-wait.json', watcher), '--now', NOW).out).toContain('verdict=ROTATE');
    const waitingShip = { ...doc, tasks: [task(7, 'ship #4001 at abc1234 q7x2', 150e6, 'waiting')] };
    expect(run('scan', '--thread', write('defer-wship.json', waitingShip), '--now', NOW).out).toContain('verdict=DEFER');
    const parent = { ...doc, tasks: [{ path: '1', title: 'Implement feature', status: 'working', cost: { tokens: 150e6 } }, { path: '1.1', title: 'ship #4001', status: 'working', cost: { tokens: 10e6 } }] };
    expect(run('scan', '--thread', write('defer-parent.json', parent), '--now', NOW).out).toContain('verdict=DEFER');
  });

  test('active means working, waiting, or a turn in the last 24 hours; an old quiet thread is not rotated', () => {
    const base = { code: 'HARN-11', created_at: '2026-10-25T00:00:00Z', cost: { tokens: 10e6 }, tasks: [] };
    const idleRecent = run('scan', '--thread', write('idle-recent.json', { ...base, status: 'idle', updated_at: '2026-11-03T21:50:00Z' }), '--now', NOW);
    expect(idleRecent.out).toContain('active=yes');
    expect(idleRecent.out).toContain('FLAG: ROTATE age 9.9d > 3d and active');
    const quiet = run('scan', '--thread', write('quiet.json', { ...base, status: 'idle', updated_at: '2026-10-30T00:00:00Z' }), '--now', NOW);
    expect(quiet.out).toContain('verdict=OK');
    expect(quiet.out).toContain('active=no');
  });

  test('a Captain is measured with the same numbers and reported, never rotated', () => {
    const cap = { code: 'GSTA-36', status: 'waiting', created_at: '2026-10-16T00:00:00Z', cost: { tokens: 3.9e9 }, tasks: [], captain_thread: {} };
    const r = run('scan', '--thread', write('captain.json', cap), '--now', NOW);
    expect(r.out).toContain('verdict=REPORT captain=yes');
    expect(r.out).not.toContain('FLAG: ROTATE');
    expect(r.out).toContain('FLAG: REPORT own_tokens 3.90B > 500M');
  });

  test('empty-wake rate: turns whose only calls are status reads, waits and end_turn', () => {
    const at = (m: number) => new Date(Date.parse('2026-11-03T12:00:00Z') + m * 60_000).toISOString();
    const items: unknown[] = [];
    for (let k = 0; k < 30; k++) {
      const t = k * 10;
      if (k % 3 === 0) items.push({ source: 'tool', tool: 'execute', calls: [{ tool: 'bash' }, { tool: 'edit' }], createdAt: at(t) });
      else items.push({ source: 'tool', tool: 'execute', calls: [{ tool: 'subagent_list' }], createdAt: at(t) });
      items.push({ source: 'tool', tool: k % 2 ? 'end_turn' : 'wait', createdAt: at(t + 1) });
    }
    items.push({ source: 'tool', tool: 'message_agent', input: { text: '{"state":"working","text":"x"}' }, createdAt: at(400) });
    items.push({ source: 'tool', tool: 'message_agent', input: { text: '{"state":"final","text":"done"}' }, createdAt: at(401) });
    const doc = { code: 'FOUN-71', status: 'idle', created_at: '2026-11-03T02:00:00Z', updated_at: at(401), cost: { tokens: 50e6 }, tasks: [] };
    const r = run('scan', '--thread', write('ew.json', doc), '--events', write('ew.events.json', { items, cursor: null }), '--now', NOW);
    expect(r.out).toContain('empty_wake=65%/31');
    expect(r.out).toContain('FLAG: WARN empty_wake 65% of 31 turns > 25%');
  });

  const at = (s: number) => new Date(Date.parse('2026-11-06T12:00:00Z') + s * 1000).toISOString();
  const wait = (s: number, input: Record<string, unknown>) => ({ source: 'tool', tool: 'wait', input: { text: JSON.stringify({ description: 'w', ...input }) }, createdAt: at(s) });
  const work = (s: number) => ({ source: 'tool', tool: 'execute', calls: [{ tool: 'bash' }, { tool: 'edit' }], createdAt: at(s) });
  const scan = (items: unknown[], name: string) => {
    const doc = { code: 'GSTA-999', status: 'idle', created_at: '2026-11-06T02:00:00Z', cost: { tokens: 1e6 }, tasks: [] };
    return run('scan', '--thread', write(name + '.json', doc), '--events', write(name + '.events.json', { items, cursor: null }), '--now', NOW).out;
  };

  // Value: protects=warm-wait check-ins (crew/docs/captain.md Warm waits, #4060) are not empty wakes: a turn whose only call re-issues the
  //   wait on the same operation, or a 240 s timer, inside 30 minutes of the wait that began the run is left out; a re-wait past 30
  //   minutes, a different wait, or a turn that also reads status still counts; fails_when=/runaway-stopper flags a lane that follows the
  //   rule (GST-1597); seam=emptyWakes; no_claim=whether the lane should have warm-waited at all
  test('warm-wait check-ins inside 30 minutes are not empty wakes; past the window they count again', () => {
    const lane: unknown[] = [];
    for (let k = 0; k < 20; k++) { lane.push(work(k * 2000)); lane.push(wait(k * 2000 + 1, { operation_ids: ['op' + k], duration_seconds: 240 })); for (let c = 1; c <= 7; c++) lane.push(wait(k * 2000 + 1 + c * 240, c % 2 ? { duration_seconds: 240 } : { operation_ids: ['op' + k] })); }
    expect(scan(lane, 'warm')).toContain('empty_wake=0%/20');
    const late: unknown[] = [];
    for (let k = 0; k < 20; k++) { late.push(work(k * 4000)); late.push(wait(k * 4000 + 1, { operation_ids: ['op' + k] })); late.push(wait(k * 4000 + 1 + 1900, { operation_ids: ['op' + k] })); }
    expect(scan(late, 'late')).toContain('empty_wake=50%/40');
    const other: unknown[] = [];
    for (let k = 0; k < 20; k++) { other.push(work(k * 2000)); other.push(wait(k * 2000 + 1, { operation_ids: ['op' + k] })); other.push(wait(k * 2000 + 241, { operation_ids: ['other' + k], duration_seconds: 600 })); }
    expect(scan(other, 'other')).toContain('empty_wake=50%/40');
    const reads: unknown[] = [];
    for (let k = 0; k < 20; k++) { reads.push(work(k * 2000)); reads.push(wait(k * 2000 + 1, { operation_ids: ['op' + k] })); reads.push({ source: 'tool', tool: 'execute', calls: [{ tool: 'subagent_list' }], createdAt: at(k * 2000 + 241) }); reads.push(wait(k * 2000 + 242, { operation_ids: ['op' + k] })); }
    expect(scan(reads, 'reads')).toContain('empty_wake=50%/40');
    const chain: unknown[] = [work(0), wait(1, { operation_ids: ['op'], duration_seconds: 240 })];
    for (let c = 1; c <= 60; c++) chain.push(wait(1 + c * 240, { operation_ids: ['op'], duration_seconds: 240 }));
    expect(scan(chain, 'chain')).toContain('FLAG: WARN empty_wake 100% of 40 turns > 25%');
  });

  // Value: protects=a 240 s timer chains only on the run's operations or none, and a counted turn that re-waits on the run's operation
  //   keeps the run's start, so polling one operation for hours with a status read every 28 minutes still counts; fails_when=a timer
  //   naming other operations is left out, or a status-read turn restarts the 30-minute window (GST-1597 /ship findings 2 and 3);
  //   seam=emptyWakes; no_claim=how often a lane should read status
  test('a 240 s timer on other operations counts; a status-read turn does not restart the warm window', () => {
    const timer = (ops: (k: number) => Record<string, unknown>) => {
      const items: unknown[] = [];
      for (let k = 0; k < 20; k++) { items.push(work(k * 2000)); items.push(wait(k * 2000 + 1, { operation_ids: ['op' + k] })); items.push(wait(k * 2000 + 241, { ...ops(k), duration_seconds: 240 })); }
      return items;
    };
    expect(scan(timer(k => ({ operation_ids: ['other' + k] })), 'timer-other')).toContain('empty_wake=50%/40');
    expect(scan(timer(k => ({ operation_ids: ['op' + k] })), 'timer-same')).toContain('empty_wake=0%/20');
    expect(scan(timer(() => ({})), 'timer-none')).toContain('empty_wake=0%/20');
    const polled: unknown[] = [work(0), wait(1, { operation_ids: ['op'], duration_seconds: 240 })];
    for (let c = 1; c <= 60; c++) {
      if (c % 7 === 0) polled.push({ source: 'tool', tool: 'execute', calls: [{ tool: 'subagent_list' }], createdAt: at(c * 240) });
      polled.push(wait(1 + c * 240, { operation_ids: ['op'], duration_seconds: 240 }));
    }
    expect(scan(polled, 'polled')).toContain('FLAG: WARN empty_wake 100% of 40 turns > 25%');
  });

  test('a subagent.list file replaces thread.get tasks: own sums top-level paths only, truncation makes it an upper bound', () => {
    const doc = { code: 'GSTA-266', status: 'working', created_at: '2026-11-03T20:00:00Z', cost: { tokens: 700e6 }, tasks: [] };
    const subs = { total: 3, tasks: [
      { path: '1', title: 'build', status: 'done', cost: { tokens: 150e6, credits: 1 } },
      { path: '1.1', title: 'reader', status: 'done', cost: { tokens: 50e6, credits: 1 } },
      { path: '2', title: 'docs', status: 'done', cost: { tokens: 120e6, credits: 1 } },
    ] };
    const r = run('scan', '--thread', write('sl.json', doc), '--subagents', write('sl.subagents.json', subs), '--now', NOW);
    expect(r.out).toContain('own=430M(exact)');
    expect(r.out).toContain('FLAG: WARN own_tokens 430M > 400M warn line');
    expect(r.out).toContain('FLAG: LOOK subagent 1 "build" 150M > 100M (done)');
    const t = run('scan', '--thread', write('sl2.json', doc), '--subagents', write('sl2.subagents.json', { ...subs, truncated: true }), '--now', NOW);
    expect(t.out).toContain('own=430M(upper)');
  });

  test('--dir sweeps every thread file, largest own tokens first, with a SWEEP total', () => {
    const d = path.join(tmp, 'crew');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'FOUN-4.thread.json'), JSON.stringify(FOUN4));
    fs.writeFileSync(path.join(d, 'GSTA-1.thread.json'), JSON.stringify({ code: 'GSTA-1', status: 'idle', created_at: '2026-11-03T20:00:00Z', cost: { tokens: 1e6 }, tasks: [] }));
    const r = run('scan', '--dir', d, '--now', NOW);
    expect(r.out.indexOf('thread=FOUN-4')).toBeLessThan(r.out.indexOf('thread=GSTA-1'));
    expect(r.out).toContain('SWEEP: threads=2 rotate=1 stop=0 defer=0 report=0 warn=0 look=0 ok=1 unreadable=0');
    expect(r.code).toBe(0);
  });

  // Value: protects=a sweep from a thread outside every crew (the fresh automation thread the skill recommends) never reports a clean SWEEP over its own thread alone; fails_when=an empty crew list scans only "this" and exits 0; why_new=#3975 open note 3 (red-team, cross-family trail read)
  test('an empty crew list in crew.json is RUNAWAY_INPUT and fails the sweep; a listed crew scans clean', () => {
    const d = path.join(tmp, 'empty-crew');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'AUTO-1.thread.json'), JSON.stringify({ code: 'AUTO-1', status: 'working', created_at: '2026-11-03T21:00:00Z', cost: { tokens: 1e6 }, tasks: [] }));
    fs.writeFileSync(path.join(d, 'crew.json'), JSON.stringify({ items: [] }));
    const r = run('scan', '--dir', d, '--now', NOW);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/RUNAWAY_INPUT: file=\S*crew\.json the crew list is empty/);
    expect(r.out).toContain('unreadable=1');
    fs.writeFileSync(path.join(d, 'crew.json'), JSON.stringify({ items: ['AUTO-1'] }));
    const ok = run('scan', '--dir', d, '--now', NOW);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('ok=1 unreadable=0');
    fs.writeFileSync(path.join(d, 'crew.json'), JSON.stringify({ codes: [] }));
    expect(run('scan', '--dir', d, '--now', NOW).out).toMatch(/crew\.json field=items expected=array/);
  });

  test('an unreadable or incomplete thread file is named, skipped and fails the sweep; the rest still scan', () => {
    const d = path.join(tmp, 'bad');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'FOUN-4.thread.json'), JSON.stringify(FOUN4));
    fs.writeFileSync(path.join(d, 'BAD-1.thread.json'), '{"code": "BAD-1", "cost": ');
    fs.writeFileSync(path.join(d, 'BAD-2.thread.json'), JSON.stringify({ code: 'BAD-2', status: 'working', tasks: [] }));
    fs.writeFileSync(path.join(d, 'BAD-3.thread.json'), JSON.stringify({ code: 'BAD-3', cost: { tokens: 1 }, tasks: [] }));
    fs.writeFileSync(path.join(d, 'BAD-4.thread.json'), JSON.stringify({ code: 'BAD-4', cost: { tokens: 1 }, created_at: NOW, tasks: [{ title: 'x' }] }));
    fs.writeFileSync(path.join(d, 'BAD-5.thread.json'), '[]');
    const r = run('scan', '--dir', d, '--now', NOW);
    expect(r.code).toBe(1);
    expect(r.out).toContain('thread=FOUN-4 verdict=ROTATE');
    expect(r.out).toMatch(/RUNAWAY_INPUT: file=\S*BAD-1\.thread\.json /);
    expect(r.out).toMatch(/RUNAWAY_INPUT: file=\S*BAD-2\.thread\.json field=cost\.tokens expected=number/);
    expect(r.out).toMatch(/BAD-3\.thread\.json field=created_at expected=ISO time/);
    expect(r.out).toMatch(/BAD-4\.thread\.json field=tasks\[\]\.cost\.tokens expected=number/);
    expect(r.out).toMatch(/BAD-5\.thread\.json expected a tools\.thread\.get object/);
    expect(r.out).not.toContain('thread=BAD-2');
    expect(r.out).toContain('rotate=1 stop=0 defer=0 report=0 warn=0 look=0 ok=0 unreadable=5');
  });

  test('a malformed --subagents file is named as RUNAWAY_INPUT, not scanned as exact', () => {
    const doc = { code: 'X-1', status: 'working', created_at: '2026-11-03T20:00:00Z', cost: { tokens: 300e6 }, tasks: [] };
    const r = run('scan', '--thread', write('m.json', doc), '--subagents', write('m.subagents.json', [{ path: '1', title: 'big', status: 'working' }]), '--now', NOW);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/RUNAWAY_INPUT: file=\S*m\.subagents\.json expected a tools\.subagent\.list object/);
    expect(r.out).not.toContain('own=300M(exact)');
  });

  test('--events accepts a bare array and a thread.get result with transcript.items', () => {
    const at = (m: number) => new Date(Date.parse('2026-11-03T12:00:00Z') + m * 60_000).toISOString();
    const items = Array.from({ length: 20 }, (_, k) => ({ source: 'tool', tool: 'end_turn', createdAt: at(k) }));
    const doc = { code: 'E-1', status: 'idle', created_at: '2026-11-03T02:00:00Z', cost: { tokens: 1e6 }, tasks: [] };
    for (const shape of [items, { transcript: { items } }])
      expect(run('scan', '--thread', write('e.json', doc), '--events', write('e.events.json', shape), '--now', NOW).out).toContain('empty_wake=100%/20');
  });

  test('a finished subagent past 100M makes the verdict LOOK, not OK', () => {
    const doc = { code: 'GSTA-245', status: 'idle', created_at: '2026-11-03T10:00:00Z', cost: { tokens: 200e6 }, tasks: [task(1, '/ship #3749', 150e6)] };
    expect(run('scan', '--thread', write('look.json', doc), '--now', NOW).out).toContain('verdict=LOOK');
  });

  test('events embedded in the thread file: an inbound message starts a turn, and a "working" report is not action', () => {
    const at = (m: number) => new Date(Date.parse('2026-11-03T12:00:00Z') + m * 60_000).toISOString();
    const events: unknown[] = [];
    for (let k = 0; k < 24; k++) {
      events.push({ source: 'user', createdAt: at(k * 10) });
      if (k % 4 === 0) events.push({ source: 'tool', tool: 'execute', calls: [{ tool: 'bash' }], createdAt: at(k * 10 + 1) });
      else events.push({ source: 'tool', tool: 'message_agent', state: 'working', createdAt: at(k * 10 + 1) });
    }
    const doc = { code: 'GSTA-258', status: 'idle', created_at: '2026-11-03T02:00:00Z', cost: { tokens: 50e6 }, tasks: [], events };
    const r = run('scan', '--thread', write('emb.json', doc), '--now', NOW);
    expect(r.out).toContain('empty_wake=75%/24');
  });

  test('usage errors exit 2 with a named code', () => {
    expect(run('scan').code).toBe(2);
    expect(run('scan', '--thread', path.join(tmp, 'missing.json')).err).toContain('RUNAWAY_USAGE: no file');
    expect(run('frob').err).toContain('RUNAWAY_USAGE: unknown command');
    expect(run('--help').code).toBe(0);
    expect(run('scan', '--thread', write('ok.json', FOUN4), '--now').err).toContain('RUNAWAY_USAGE: --now needs a value');
    expect(run('scan', '--thread', write('ok2.json', FOUN4), '--now', 'yesterday').err).toContain('RUNAWAY_USAGE: --now is not an ISO time');
    expect(run('scan', '--thread', write('ok3.json', FOUN4), '--dir', tmp).err).toContain('RUNAWAY_USAGE: pass exactly one of');
    expect(run('scan', '--dir', path.join(tmp, 'nope')).err).toContain('RUNAWAY_USAGE: no directory');
    expect(run('scan', '--thread', write('ok4.json', FOUN4), '--event', 'x.json').err).toContain('RUNAWAY_USAGE: unknown argument "--event"');
  });
});

describe('/runaway-stopper skill', () => {
  const skill = fs.readFileSync(path.resolve(import.meta.dir, '..', 'runaway-stopper', 'SKILL.md.tmpl'), 'utf8');
  test('the fetch program stays under the 256-call limit at every documented page count, pages the list, and cleans up', () => {
    expect(skill).toContain('const max = Math.floor(240 / (pages + 1));');
    expect(skill).toContain('limit: Math.min(100, max)');
    expect(skill).toContain('Promise.allSettled');
    for (const pages of [1, 3]) expect(Math.floor(240 / (pages + 1)) * (pages + 1) + 2).toBeLessThan(256);
    expect(skill).toContain('NEXT_CURSOR');
    expect(skill).toContain('rm -rf');
    expect(skill).toContain('calls: i.calls?.map(c => ({ tool: c.tool }))');
  });
  // Value: protects=the skill's fetch program keeps each wait's input, so the warm-wait exclusion runs through /runaway-stopper and not
  //   only on hand-built files; fails_when=the projection drops input and every warm check-in counts as an empty wake (GST-1597 /ship
  //   finding 1); seam=the template's projection run over items shaped like a tools.thread.get page (tools: true, read 2026-11-06),
  //   then gstack-runaway scan on the file it writes
  test('the fetch program keeps wait input, so warm check-ins on a thread.get page are left out through the skill', () => {
    const src = skill.match(/transcript\.items\.map\((i => \(\{[\s\S]*?\}\))\)\);/)?.[1];
    expect(src).toBeDefined();
    const project = new Function('return ' + src)() as (i: unknown) => unknown;
    const at = (s: number) => new Date(Date.parse('2026-11-06T12:00:00Z') + s * 1000).toISOString();
    const text = (v: unknown) => ({ text: JSON.stringify(v), chars: JSON.stringify(v).length });
    const waitItem = (s: number, input: Record<string, unknown>) => ({ id: 'toolu_w' + s, source: 'tool', tool: 'wait', text: 'Waiting for CI', createdAt: at(s),
      input: text({ description: 'Waiting for CI', ...input }), result: { text: 'Waiting on 1 operation, resuming when any completes.', chars: 52, is_error: false } });
    const page: unknown[] = [];
    for (let k = 0; k < 20; k++) {
      page.push({ id: 'toolu_x' + k, source: 'tool', tool: 'execute', text: 'Fix and push', createdAt: at(k * 2000),
        calls: [{ tool: 'bash', durationMs: 700, input: text({ command: 'git push' }) }, { tool: 'edit', durationMs: 20, input: text({ path: 'a.ts' }) }], input: text({ code: '...' }) });
      page.push(waitItem(k * 2000 + 1, { operation_ids: ['op' + k], duration_seconds: 240 }));
      for (let c = 1; c <= 7; c++) page.push(waitItem(k * 2000 + 1 + c * 240, { operation_ids: ['op' + k], duration_seconds: 240 }));
    }
    const doc = { code: 'GSTA-998', status: 'idle', created_at: '2026-11-06T02:00:00Z', cost: { tokens: 1e6 }, tasks: [], events: page.map(project) };
    const out = run('scan', '--thread', write('skill-warm.thread.json', doc), '--now', NOW).out;
    expect(out).toContain('empty_wake=0%/20');
    expect(out).not.toContain('FLAG: WARN empty_wake');
  });
  test('rotation stops or lists live subagents, the successor subscribes to open PRs, and archiving waits for it', () => {
    expect(skill).toContain('stop your working and waiting subagents, or list each with its run');
    expect(skill).toContain('subscribes to each open PR in the handoff');
    expect(skill).toContain('Archive the old thread once the successor reports its subscriptions');
    expect(fs.readFileSync(path.resolve(import.meta.dir, '..', 'runaway-stopper', 'templates', 'successor-brief.md'), 'utf8')).toContain('subscribe to every open PR');
  });
});
