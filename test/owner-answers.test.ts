/**
 * The owner's answer record (lib/owner-answers.ts, bin/gstack-owner-answers, docs/owner-answers.md):
 * store binding on Capy, one-file rows, second-actor verification, fail-closed reads, and the screen
 * rules that decide when an ask may be left out. Every owner here is made up.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import {
  addAnswer, buildAnswer, currentRows, notTakeable, parseAskFile, readStore, resolveStore, screenAsks, verifyAnswer,
  type AskLine, type NewAnswer, type OwnerAnswer, type Store,
} from '../lib/owner-answers';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-owner-answers');
const dirs: string[] = [];
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A fake home with a mounted Drive holding the given user folders. */
function home(...users: string[]): string {
  const h = tmp('oa-home-');
  for (const u of users) fs.mkdirSync(path.join(h, '.capy', 'drive', `user-${u}`), { recursive: true });
  fs.mkdirSync(path.join(h, '.capy', 'drive'), { recursive: true });
  return h;
}
const capyEnv = (h: string) => ({ GSTACK_CAPY: '1', HOME: h, GSTACK_OWNER_ANSWERS_DIR: '' }) as NodeJS.ProcessEnv;
function store(h = home('alice')): Store {
  const s = resolveStore(capyEnv(h));
  if ('code' in s) throw new Error(s.message);
  return s;
}

const MERGE: NewAnswer = { action: 'merge-when-green', target: 'pull-request', scope: 'all', words: 'yes merge when green', words_by: 'owner', thread: 'CAPT-1', event: 'evt_1', by: 'Example Captain' };
function put(s: Store, input: NewAnswer = MERGE): OwnerAnswer {
  const row = buildAnswer(s, input);
  if ('code' in row) throw new Error(row.message);
  expect(addAnswer(s, row)).toBe('written');
  return row;
}
function takeable(s: Store, input: NewAnswer = MERGE): OwnerAnswer {
  const row = put(s, input);
  expect(verifyAnswer(s, row.id, 'second reader', row.source.event)).toBe('written');
  return row;
}
const ASK: AskLine = { line: 'A', origin: 'captain', text: 'Merge #12 now that it is green?', action: 'merge-when-green', target: 'pull-request', scope: 'repo:example/widgets' };

function cli(args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync('bun', [...bunIsolationArgs(), BIN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('where the record lives', () => {
  test('on Capy: the one user-* Drive folder; none, two or an unknown --owner refuse, and the env override is ignored', () => {
    const h = home('alice');
    const s = resolveStore({ ...capyEnv(h), GSTACK_OWNER_ANSWERS_DIR: tmp('oa-forged-') });
    expect('code' in s ? s.code : s.dir).toBe(path.join(fs.realpathSync(h), '.capy', 'drive', 'user-alice', 'owner-answers'));
    expect('code' in s ? '' : s.owner).toBe('alice');
    expect((resolveStore(capyEnv(home())) as any).code).toBe('OWNER_ANSWERS_NO_DRIVE');
    expect((resolveStore(capyEnv(home('alice', 'bob'))) as any).code).toBe('OWNER_ANSWERS_AMBIGUOUS');
    expect((resolveStore(capyEnv(home('alice', 'bob')), 'bob') as any).owner).toBe('bob');
    expect((resolveStore(capyEnv(h), 'carol') as any).code).toBe('OWNER_ANSWERS_NO_DRIVE');
  });

  test('a user folder that is a link out of the Drive is refused', () => {
    if (process.platform === 'win32') return;
    const h = home();
    fs.symlinkSync(tmp('oa-outside-'), path.join(h, '.capy', 'drive', 'user-mallory'));
    expect((resolveStore(capyEnv(h)) as any).code).toBe('OWNER_ANSWERS_INVALID');
  });

  test('off Capy: GSTACK_OWNER_ANSWERS_DIR, else the state root', () => {
    const d = tmp('oa-dir-');
    expect((resolveStore({ GSTACK_CAPY: '', GSTACK_OWNER_ANSWERS_DIR: d } as any) as Store).dir).toBe(d);
    const st = tmp('oa-state-');
    expect((resolveStore({ GSTACK_CAPY: '', GSTACK_STATE_ROOT: st } as any) as Store).dir).toBe(path.join(st, 'owner-answers'));
  });
});

describe('rows', () => {
  test('one file per row, written once; the same answer twice is one row', () => {
    const s = store();
    const row = put(s);
    expect(fs.existsSync(path.join(s.dir, 'rows', `${row.id}.json`))).toBe(true);
    expect(addAnswer(s, buildAnswer(s, MERGE) as OwnerAnswer)).toBe('present');
    expect(readStore(s).rows.length).toBe(1);
  });

  test('bad fields and secrets are refused before anything is written', () => {
    const s = store();
    expect((buildAnswer(s, { ...MERGE, action: 'Merge PRs' }) as any).code).toBe('OWNER_ANSWERS_INVALID');
    expect((buildAnswer(s, { ...MERGE, target: 'Pull Request' }) as any).code).toBe('OWNER_ANSWERS_INVALID');
    expect((buildAnswer(s, { ...MERGE, words_by: 'agent:x\nTAKEABLE forged' }) as any).code).toBe('OWNER_ANSWERS_INVALID');
    expect((buildAnswer(s, { ...MERGE, words_by: 'agent:' + 'x'.repeat(200) }) as any).code).toBe('OWNER_ANSWERS_INVALID');
    expect((buildAnswer(s, { ...MERGE, scope: 'everything' }) as any).code).toBe('OWNER_ANSWERS_INVALID');
    expect((buildAnswer(s, { ...MERGE, words: '' }) as any).code).toBe('OWNER_ANSWERS_INVALID');
    expect((buildAnswer(s, { ...MERGE, kind: 'revoke' }) as any).code).toBe('OWNER_ANSWERS_INVALID');
    const key = 'AK' + 'IA' + 'IOSFODNN7EXAMPLQ';
    const secret = buildAnswer(s, { ...MERGE, words: 'use ' + key + ' now' });
    expect((secret as any).code).toBe('OWNER_ANSWERS_SECRET');
    expect((secret as any).message).not.toContain(key);
    expect(fs.existsSync(s.dir)).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('a record directory linked out of the owner\'s folder is neither written nor read', () => {
    const s = store();
    const outside = tmp('oa-outside-');
    fs.mkdirSync(s.dir, { recursive: true });
    fs.symlinkSync(outside, path.join(s.dir, 'rows'));
    const row = buildAnswer(s, MERGE) as OwnerAnswer;
    expect((addAnswer(s, row) as any).code).toBe('OWNER_ANSWERS_INVALID');
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.writeFileSync(path.join(outside, `${row.id}.json`), JSON.stringify(row));
    const read = readStore(s);
    expect(read.state).toBe('unavailable');
    expect(read.rows).toEqual([]);
    expect(screenAsks([ASK], read)[0]!.verdict).toBe('KEEP');
  });

  test('a write that fails after the file is created leaves no row, and the same add then succeeds', () => {
    const s = store();
    const row = buildAnswer(s, MERGE) as OwnerAnswer;
    const res = addAnswer(s, { ...row, limits: 1n as unknown as string });
    expect((res as any).code).toBe('OWNER_ANSWERS_WRITE_FAILED');
    expect(fs.readdirSync(path.join(s.dir, 'rows'))).toEqual([]);
    expect(addAnswer(s, row)).toBe('written');
    expect(readStore(s).state).toBe('present');
  });

  test('two processes adding at once: one row written, one told it is present, no torn file', async () => {
    const h = home('alice');
    const args = ['add', '--action', 'merge-when-green', '--target', 'pull-request', '--words', 'yes merge when green', '--words-by', 'owner', '--thread', 'CAPT-1', '--event', 'evt_1', '--by', 'Example Captain'];
    const run = () => new Promise<string>(resolve => {
      const c = spawn('bun', [...bunIsolationArgs(), BIN, ...args], { cwd: ROOT, env: { ...process.env, ...capyEnv(h) }, timeout: 60_000 });
      let out = '';
      c.stdout.on('data', b => { out += b; });
      c.on('close', () => resolve(out));
    });
    const outs = await Promise.all([run(), run()]);
    expect(outs.filter(o => /^OWNER_ANSWER_RECORDED: oa-[0-9a-f]{16}\n$/.test(o)).length).toBe(1);
    expect(outs.filter(o => o.includes('(already present)')).length).toBe(1);
    const read = readStore(store(h));
    expect(read.state).toBe('present');
    expect(read.rows.length).toBe(1);
  }, 120_000);
});

describe('what can be taken', () => {
  test('the owner\'s own words, verified by a second actor, current and unlimited', () => {
    const s = store();
    const row = takeable(s);
    expect(notTakeable(row, readStore(s))).toBeUndefined();
  });

  test('agent-typed words, limits, other kinds and unverified rows are context only', () => {
    const s = store();
    const typed = takeable(s, { ...MERGE, words_by: undefined, event: 'evt_2' });
    const limited = takeable(s, { ...MERGE, limits: 'only under $50', event: 'evt_3' });
    const decision = takeable(s, { ...MERGE, kind: 'decision', event: 'evt_4' });
    const unverified = put(s, { ...MERGE, event: 'evt_5' });
    const read = readStore(s);
    expect(notTakeable(typed, read)).toContain('typed by agent:Example Captain');
    expect(notTakeable(limited, read)).toContain('limits');
    expect(notTakeable(decision, read)).toContain('context only');
    expect(notTakeable(unverified, read)).toContain('verified');
  });

  test('the recorder cannot verify its own row, and a verification of other words does not count', () => {
    const s = store();
    const row = put(s);
    expect((verifyAnswer(s, row.id, 'Example Captain', row.source.event) as any).code).toBe('OWNER_ANSWERS_SELF_VERIFY');
    expect((verifyAnswer(s, row.id, 'second reader', 'evt_other') as any).code).toBe('OWNER_ANSWERS_INVALID');
    expect(notTakeable(row, readStore(s))).toContain('verified');
    fs.mkdirSync(path.join(s.dir, 'verifications'), { recursive: true });
    fs.writeFileSync(path.join(s.dir, 'verifications', `${row.id}--forged.json`), JSON.stringify({ schema_version: 1, row: row.id, verified_by: 'x', verified_at: 'now', words_sha256: '0'.repeat(64) }));
    expect(notTakeable(row, readStore(s))).toContain('verified');
  });

  test('a superseded or revoked row stops counting; two revokes in one reply cancel both grants', () => {
    const s = store();
    const merge = takeable(s);
    const rerun = takeable(s, { ...MERGE, action: 'rerun-flaky-once', target: 'test', words: 'just run the failed test again', event: 'evt_9' });
    const cancel = (id: string) => put(s, { kind: 'revoke', supersedes: id, words: 'ask me again about both', words_by: 'owner', thread: 'CAPT-1', event: 'evt_10', by: 'Example Captain' });
    cancel(merge.id); cancel(rerun.id);
    const read = readStore(s);
    expect(read.state).toBe('present');
    expect(currentRows(read).map(r => r.id)).toEqual([]);
    expect(notTakeable(merge, read)).toContain('superseded');
    expect(notTakeable(rerun, read)).toContain('superseded');
  });
});

describe('fail closed', () => {
  const uncertain = (mutate: (s: Store, row: OwnerAnswer) => void) => {
    const s = store();
    const row = takeable(s);
    mutate(s, row);
    const read = readStore(s);
    expect(read.state).toBe('uncertain');
    expect(read.problems.length).toBeGreaterThan(0);
    expect(screenAsks([ASK], read)[0]!.verdict).toBe('KEEP');
  };
  test('a malformed row file', () => uncertain(s => fs.writeFileSync(path.join(s.dir, 'rows', 'oa-0000000000000000.json'), '{ torn')));
  test('a row whose words were edited after it was written', () => uncertain((s, row) => {
    const f = path.join(s.dir, 'rows', `${row.id}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...row, scope: 'captain:other' }));
  }));
  test('a row of another owner', () => uncertain(s => {
    const other = resolveStore(capyEnv(home('bob'))) as Store;
    const row = buildAnswer(other, { ...MERGE, event: 'evt_7' }) as OwnerAnswer;
    fs.writeFileSync(path.join(s.dir, 'rows', `${row.id}.json`), JSON.stringify(row));
  }));
  test('a supersede that names a missing row', () => uncertain(s => {
    const row = buildAnswer(s, { ...MERGE, event: 'evt_8', supersedes: 'oa-ffffffffffffffff' }) as OwnerAnswer;
    fs.writeFileSync(path.join(s.dir, 'rows', `${row.id}.json`), JSON.stringify(row));
  }));
  test('two rows that supersede the same row (two machines writing before their Drives sync)', () => uncertain((s, row) => {
    put(s, { ...MERGE, words: 'merge when green, any repo', event: 'evt_11', supersedes: row.id });
    const twin = buildAnswer(s, { ...MERGE, words: 'merge when green, gstack only', event: 'evt_12', supersedes: row.id }) as OwnerAnswer;
    fs.writeFileSync(path.join(s.dir, 'rows', `${twin.id}.json`), JSON.stringify(twin));
  }));
  test('a second supersede or revoke of an already-replaced row is refused, not written', () => {
    const s = store();
    const row = put(s);
    expect(addAnswer(s, buildAnswer(s, { ...MERGE, kind: 'revoke', supersedes: row.id, event: 'evt_2' }) as OwnerAnswer)).toBe('written');
    expect(addAnswer(s, buildAnswer(s, { ...MERGE, kind: 'revoke', supersedes: row.id, event: 'evt_2' }) as OwnerAnswer)).toBe('present');
    expect((addAnswer(s, buildAnswer(s, { ...MERGE, kind: 'revoke', supersedes: row.id, event: 'evt_3' }) as OwnerAnswer) as any).code).toBe('OWNER_ANSWERS_CONFLICT');
    expect(readStore(s).state).toBe('present');
  });
  test('a second add with different words for one source and action is refused, not kept', () => {
    const s = store();
    put(s);
    const twin = buildAnswer(s, { ...MERGE, words: 'merge whenever' }) as OwnerAnswer;
    expect((addAnswer(s, twin) as any).code).toBe('OWNER_ANSWERS_CONFLICT');
    expect(readStore(s).rows.map(r => r.words)).toEqual(['yes merge when green']);
  });
  test('an add that finds its row created but not yet written waits for the other add, then reports it present', async () => {
    const s = store();
    const row = buildAnswer(s, MERGE) as OwnerAnswer;
    const file = path.join(s.dir, 'rows', `${row.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    const writer = spawn('bun', [...bunIsolationArgs(), '-e', 'console.log("ready"); setTimeout(() => require("fs").writeFileSync(process.env.F, process.env.J), 200)'], { env: { ...process.env, F: file, J: JSON.stringify(row) }, timeout: 60_000 });
    const closed = new Promise(resolve => writer.on('close', resolve));
    await new Promise(resolve => writer.stdout.once('data', resolve));
    expect(addAnswer(s, row)).toBe('present');
    await closed;
    expect(readStore(s).rows.map(r => r.id)).toEqual([row.id]);
  }, 120_000);
  test('a row file that stays empty is still a conflict once the wait runs out', () => {
    const s = store();
    const row = buildAnswer(s, MERGE) as OwnerAnswer;
    const file = path.join(s.dir, 'rows', `${row.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    expect((addAnswer(s, row) as any).code).toBe('OWNER_ANSWERS_CONFLICT');
  });
  test('supersede through the API refuses a missing row', () => {
    const s = store();
    const row = buildAnswer(s, { ...MERGE, supersedes: 'oa-ffffffffffffffff' }) as OwnerAnswer;
    expect((addAnswer(s, row) as any).code).toBe('OWNER_ANSWERS_NOT_FOUND');
  });
});

describe('screen', () => {
  const verdicts = (asks: AskLine[], s: Store) => screenAsks(asks, readStore(s)).map(x => `${x.verdict}: ${x.reason}`);
  test('an exact typed match with a takeable row is proposed, with the line the Captain adds', () => {
    const s = store();
    const row = takeable(s, { ...MERGE, rule: 'R6' });
    const [line] = screenAsks([ASK], readStore(s));
    expect(line!.verdict).toBe('PROPOSE_TAKE');
    expect(line!.take!.id).toBe(row.id);
  });

  test('gate items, untyped, compound, fresh-ask, near-miss and wrong-scope lines are kept', () => {
    const s = store();
    takeable(s, { ...MERGE, scope: 'captain:alpha' });
    const out = verdicts([
      { ...ASK, origin: 'gate', scope: 'captain:alpha' },
      { ...ASK, origin: undefined, scope: 'captain:alpha' },
      { line: 'C', origin: 'captain', text: 'Merge #12?' },
      { ...ASK, compound: true, scope: 'captain:alpha' },
      { ...ASK, limits: 'only PRs under 50 lines', scope: 'captain:alpha' },
      { ...ASK, classes: ['destructive'], scope: 'captain:alpha' },
      { ...ASK, classes: ['made-up'], scope: 'captain:alpha' },
      { ...ASK, text: 'Merge #12 and spend $400 on a rerun?', scope: 'captain:alpha' },
      { ...ASK, action: 'merge-now', scope: 'captain:alpha' },
      { ...ASK, scope: 'captain:beta' },
      { ...ASK, scope: 'repo:example/widgets' },
    ], s);
    expect(out.every(v => v.startsWith('KEEP'))).toBe(true);
    expect(out[0]).toContain('gate item');
    expect(out[2]).toContain('no typed action');
    expect(out[4]).toContain('limits');
    expect(out[7]).toContain('spend-over-cap');
    expect(screenAsks([{ ...ASK, scope: 'captain:alpha' }], readStore(s))[0]!.verdict).toBe('PROPOSE_TAKE');
  });

  test('a newer or narrower matching row that cannot be taken keeps the ask', () => {
    const s = store();
    takeable(s);
    put(s, { ...MERGE, kind: 'decision', scope: 'repo:example/widgets', words: 'not in widgets, wait for the owners', event: 'evt_20' });
    const [line] = screenAsks([ASK], readStore(s));
    expect(line!.verdict).toBe('KEEP');
    expect(line!.reason).toContain('newer or narrower');
    expect(screenAsks([{ ...ASK, scope: 'repo:example/other' }], readStore(s))[0]!.verdict).toBe('PROPOSE_TAKE');
  });

  test('an empty record keeps everything', () => {
    expect(screenAsks([ASK], readStore(store()))[0]!.reason).toContain('empty');
  });

  test('plain-text ask files parse as untyped lines', () => {
    const asks = parseAskFile('A: Merge #12?\nB) Spend $400?\n\n') as AskLine[];
    expect(asks.map(a => a.line)).toEqual(['A', 'B']);
    expect(asks.every(a => !a.action)).toBe(true);
    expect((parseAskFile('{ nope') as any).code).toBe('OWNER_ANSWERS_INVALID');
  });
});

describe('gstack-owner-answers', () => {
  test('add, verify, screen, log and status end to end; logging a take of an untakeable row refuses', () => {
    const h = home('alice');
    const env = capyEnv(h);
    const add = cli(['add', '--action', 'merge-when-green', '--target', 'pull-request', '--words', 'yes merge when green', '--words-by', 'owner', '--thread', 'CAPT-1', '--event', 'evt_1', '--by', 'Example Captain', '--rule', 'R6'], env);
    expect(add.status).toBe(0);
    const id = /OWNER_ANSWER_RECORDED: (oa-[0-9a-f]{16})/.exec(add.out)![1]!;
    expect(cli(['log', '--thread', 'CAPT-1', '--line', 'A', '--decision', 'taken', '--row', id, '--by', 'Example Captain'], env).err).toContain('(OWNER_ANSWERS_NOT_TAKEABLE)');
    expect(cli(['verify', id, '--event', 'evt_1', '--by', 'Example Captain'], env).err).toContain('(OWNER_ANSWERS_SELF_VERIFY)');
    expect(cli(['verify', id, '--event', 'evt_1', '--by', 'second reader'], env).status).toBe(0);
    const askFile = path.join(tmp('oa-ask-'), 'ask.json');
    fs.writeFileSync(askFile, JSON.stringify({ asks: [ASK, { line: 'B', origin: 'captain', text: 'Close their PR?', classes: ['close-contribution'] }] }));
    const screen = cli(['screen', '--ask-file', askFile], env);
    expect(screen.status).toBe(0);
    expect(screen.out).toContain(`PROPOSE_TAKE A ${id}: Not asked, you already said: "yes merge when green"`);
    expect(screen.out).toMatch(/already said: "yes merge when green" \(\d{4}-\d{2}-\d{2}, CAPT-1, R6\)\./);
    expect(screen.out).toMatch(/^KEEP B: always a fresh ask: close-contribution$/m);
    expect(screen.out).not.toContain(h);
    expect(fs.readFileSync(askFile, 'utf8')).toContain('"line":"B"');
    expect(cli(['log', '--thread', 'CAPT-1', '--line', 'A', '--decision', 'taken', '--row', id, '--by', 'Example Captain'], env).status).toBe(0);
    expect(cli(['log', '--thread', '../x', '--line', 'A', '--decision', 'asked', '--by', 'x'], env).status).toBe(2);
    const status = cli(['status'], env);
    expect(status.out).toMatch(/^STATE: present$/m);
    expect(status.out).toMatch(/^ROWS: 1 current=1 takeable=1 verifications=1$/m);
    expect(cli(['add', '--action', 'x'], capyEnv(home())).err).toContain('(OWNER_ANSWERS_NO_DRIVE)');
  }, 120_000);
});
