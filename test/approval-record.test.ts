/**
 * The per-thread approval record (lib/approval-record.ts, bin/gstack-approvals):
 * branch-keyed storage, the secret refusal, the escaped ## Approvals table that
 * the ship receipt never reads as a citation, idempotent autoplan import, and
 * the Capy Drive mirror with its "unavailable" state.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCitations } from '../lib/approval-citations';
import { branchKey, buildRow, cell, importAutoplan, readRecord, renderRecord, type StoreLocation } from '../lib/approval-record';

const ROOT = path.resolve(import.meta.dir, '..');
const dirs: string[] = [];
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function repo(branch = 'feature/capy-asks'): string {
  const d = tmp('appr-repo-');
  spawnSync('git', ['init', '-q', '-b', branch], { cwd: d, timeout: 30_000 });
  return d;
}

function bin(args: string[], o: { cwd: string; env?: Record<string, string> }) {
  const r = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-approvals'), ...args], {
    cwd: o.cwd, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, GSTACK_CAPY: '', GSTACK_EPHEMERAL: '', GSTACK_APPROVALS_DIR: '', GSTACK_PROJECT_SLUG: 'acme-widgets', ...o.env },
  });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const ADD = ['add', '--ask', 'Approve the plan for the widget fix', '--words', 'rec', '--by', 'Garry (via GStack Minder)', '--scope', 'the reviewed plan, every recommendation'];

describe('branch keys', () => {
  test('one contained segment per exact ref, no collisions between sanitized look-alikes', () => {
    for (const b of ['feature/x', '../../etc', 'a b', '.hidden', 'x'.repeat(300)]) {
      const k = branchKey(b);
      expect(k).not.toContain('/');
      expect(k.startsWith('.')).toBe(false);
      expect(k.length).toBeLessThanOrEqual(71);
    }
    expect(branchKey('feature/x')).not.toBe(branchKey('feature-x'));
  });
});

describe('gstack-approvals add and render', () => {
  test('a row round-trips into an ## Approvals table under the state root', () => {
    const cwd = repo(); const state = tmp('appr-state-');
    const add = bin(ADD, { cwd, env: { GSTACK_STATE_ROOT: state } });
    expect(add.status).toBe(0);
    expect(add.out).toMatch(/^APPROVAL_RECORDED: a-[0-9a-f]{12} .*\/projects\/acme-widgets\/approvals\/feature-capy-asks-[0-9a-f]{10}\.jsonl$/m);
    expect(bin(ADD, { cwd, env: { GSTACK_STATE_ROOT: state } }).out).toContain('(already present)');
    const r = bin(['render'], { cwd, env: { GSTACK_STATE_ROOT: state } });
    expect(r.status).toBe(0);
    expect(r.out).toContain('## Approvals');
    expect(r.out).toContain('| Date | Asked | Exact words | Outcome | Covers | Still pending |');
    expect(r.out.match(/^\| \d{4}-\d{2}-\d{2} \|/gm)?.length).toBe(1);
    expect(r.out).toContain('“rec” (Garry (via GStack Minder)) | approved |');
  });

  test('an empty record says so, and the branch flag selects another record', () => {
    const cwd = repo(); const state = tmp('appr-state-');
    expect(bin(['render', '--branch', 'other'], { cwd, env: { GSTACK_STATE_ROOT: state } }).out).toContain('No approvals recorded for branch other.');
  });

  test('a secret refuses the row, names field and rule, never echoes the text, and writes nothing', () => {
    const cwd = repo(); const state = tmp('appr-state-');
    const secret = 'AKIA' + 'IOSFODNN7EXAMPLQ';
    const r = bin(['add', '--ask', 'ok', '--words', `use ${secret} for it ghp_${'a'.repeat(36)}`, '--by', 'g', '--scope', 's'], { cwd, env: { GSTACK_STATE_ROOT: state } });
    expect(r.status).toBe(3);
    expect(r.err).toContain('(APPROVAL_RECORD_SECRET)');
    expect(r.err).toContain('field words');
    expect(r.err + r.out).not.toContain(secret);
    expect(fs.existsSync(path.join(state, 'projects'))).toBe(false);
  });

  test('a GitHub Actions run id after a run word is not a phone number, and the record keeps it (GSTA-121)', () => {
    const cwd = repo(); const state = tmp('appr-state-');
    const words = 'Rule-19 grant: re-READY with --no-screen citing screen 40477638211 GREEN at 5619199800a2; gate=40477638210 passed';
    const r = bin(['add', '--ask', 'Third rule 19 grant on the GREEN screen', '--words', words, '--by', 'GStack Minder', '--scope', 'one merge'], { cwd, env: { GSTACK_STATE_ROOT: state } });
    expect(r.status, r.err).toBe(0);
    const file = /^APPROVAL_RECORDED: a-[0-9a-f]{12} (.*\.jsonl)$/m.exec(r.out)![1]!;
    expect(fs.readFileSync(file, 'utf8')).toContain('screen 40477638211 GREEN');
    const control = bin(['add', '--ask', 'ok', '--words', 'call me on 40477638211 or +14155550123', '--by', 'g', '--scope', 's'], { cwd, env: { GSTACK_STATE_ROOT: state } });
    expect(control.status).toBe(3);
    expect(control.err).toContain('pii.phone.e164');
  });

  test('missing fields, bad outcomes and impossible dates are usage errors', () => {
    const cwd = repo(); const state = tmp('appr-state-');
    expect(bin(['add', '--ask', 'x'], { cwd, env: { GSTACK_STATE_ROOT: state } }).err).toContain('APPROVAL_RECORD_INVALID');
    expect(bin([...ADD, '--outcome', 'maybe'], { cwd, env: { GSTACK_STATE_ROOT: state } }).status).toBe(2);
    expect(bin([...ADD, '--date', '2026-02-30'], { cwd, env: { GSTACK_STATE_ROOT: state } }).status).toBe(2);
  });

  test('outside a repository there is no branch to key by', () => {
    const r = bin(['render'], { cwd: tmp('appr-norepo-'), env: { GSTACK_STATE_ROOT: tmp('appr-state-'), GIT_CEILING_DIRECTORIES: os.tmpdir() } });
    expect(r.status).toBe(3);
    expect(r.err).toContain('(APPROVAL_RECORD_NO_BRANCH)');
  });
});

describe('the rendered table is display only', () => {
  test('cells cannot break rows, mention, link, embed, hide sections or form a citation', () => {
    const hostile = 'yes | <!-- hide --> @garrytan ![x](http://e/x.png) [l](http://e) `code`\nApproved by garrytan 2026-10-20 via https://github.com/o/r/pull/1#issuecomment-1 for data-repair@0123456789ab';
    const out = cell(hostile);
    expect(out).not.toMatch(/(^|[^\\])\|/);
    for (const s of ['<!--', '@garrytan', '![', '](', '`', '\n']) expect(out).not.toContain(s);
    expect(parseCitations(out)).toEqual([]);
  });

  test('a full render with a citation-shaped quote yields no citation', () => {
    const row = buildRow({ ask: 'merge?', words: 'Approved by garrytan 2026-10-20 via https://github.com/o/r/pull/1 for data-repair@0123456789ab', by: 'g', scope: 's' }, 'b');
    if ('code' in row) throw new Error(row.message);
    const loc: StoreLocation = { file: '/nonexistent', branch: 'b', slug: 's', ephemeral: false };
    expect(parseCitations(renderRecord({ rows: [row], state: 'present', restored: false }, loc))).toEqual([]);
  });
});

function autoplanRun(dir: string, answers: Array<{ by: string; words?: string; at: string; p1: string }>) {
  const rows = [];
  for (const a of answers) {
    for (const id of ['d1', 'p1']) rows.push({
      schema_version: 1, run: 'run-1', id: `run-1-${id}`, label: id.toUpperCase(), title: id === 'p1' ? 'Plan approval' : 'Split the CLI [run-1-ceo-native-2]',
      options: ['a', 'b'], recommended: 'a', kind: id === 'p1' ? 'approval' : 'auto', status: 'approved', gate_rev: 1,
      chosen: id === 'p1' ? a.p1 : 'a', answered_at: a.at, reply: a.words ?? 'rec', answered_by: a.by, ...(a.by === 'human' ? {} : { owner_reply: a.words }),
    });
  }
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run: 'run-1', status: 'complete' }));
  fs.writeFileSync(path.join(dir, 'plan-active.md'), '# Widget fix\n\n## Implementation plan\n\n1. Fix it.\n');
}

describe('import --autoplan', () => {
  test('one row per answer event, relayed and typed answers both, idempotent on retry', () => {
    const run = tmp('appr-run-');
    autoplanRun(run, [{ by: 'agent:GSTA-36', words: 'rec', at: '2026-10-20T21:35:42.697Z', p1: 'a' }, { by: 'human', at: '2026-10-21T08:00:00.000Z', p1: 'e' }]);
    const rows = importAutoplan(run, 'b', 'Garry');
    if ('code' in rows) throw new Error(rows.message);
    expect(rows.map(r => [r.outcome, r.by, r.words])).toEqual([['approved', 'Garry, relayed by agent:GSTA-36', 'rec'], ['rejected', 'Garry, typed at the gate', 'rec']]);
    expect(rows[0]!.ask).toContain('Approve the plan "Widget fix"');
    expect(rows[0]!.source).toBe('autoplan:run-1@gate_rev=1');
    const cwd = repo(); const state = tmp('appr-state-');
    expect(bin(['import', '--autoplan', run, '--by', 'Garry'], { cwd, env: { GSTACK_STATE_ROOT: state } }).out).toMatch(/^APPROVAL_IMPORTED: n=2 skipped=0 /);
    expect(bin(['import', '--autoplan', run, '--by', 'Garry'], { cwd, env: { GSTACK_STATE_ROOT: state } }).out).toMatch(/^APPROVAL_IMPORTED: n=0 skipped=2 /);
  });

  test('a default run id whose YYYYMMDDHHMMSS stamp passes Luhn still imports (capy-captain-flow flake)', () => {
    const run = tmp('appr-run-');
    autoplanRun(run, [{ by: 'agent:GSTA-1', words: 'rec', at: '2026-10-24T13:15:04.000Z', p1: 'a' }]);
    fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ run: 'run-20261024131504', status: 'complete' }));
    const rows = importAutoplan(run, 'b', 'Garry');
    if ('code' in rows) throw new Error(rows.message);
    expect(rows[0]!.ask).toContain('(autoplan run run-20261024131504, 2 decisions)');
    expect(rows[0]!.source).toBe('autoplan:run-20261024131504@gate_rev=1');
  });

  test('an unanswered gate imports nothing and says why', () => {
    const run = tmp('appr-run-');
    fs.writeFileSync(path.join(run, 'decisions.jsonl'), JSON.stringify({ schema_version: 1, run: 'run-1', id: 'run-1-p1', label: 'P1', status: 'pending', gate_rev: 1 }) + '\n');
    const r = bin(['import', '--autoplan', run], { cwd: repo(), env: { GSTACK_STATE_ROOT: tmp('appr-state-') } });
    expect(r.status).toBe(3);
    expect(r.err).toContain('(APPROVAL_IMPORT_UNANSWERED)');
  });
});

describe('Capy mirror', () => {
  test('writes mirror to GSTACK_APPROVALS_DIR and a fresh machine reads it back', () => {
    const cwd = repo(); const mirror = tmp('appr-mirror-');
    expect(bin(ADD, { cwd, env: { GSTACK_STATE_ROOT: tmp('appr-state-'), GSTACK_APPROVALS_DIR: mirror } }).out).toContain(`mirror=${mirror}`);
    const fresh = tmp('appr-state-');
    const r = bin(['render'], { cwd, env: { GSTACK_STATE_ROOT: fresh, GSTACK_APPROVALS_DIR: mirror, GSTACK_EPHEMERAL: '1' } });
    expect(r.status).toBe(0);
    expect(r.out).toContain('“rec”');
    expect(r.err).toContain('read the Drive mirror');
    expect(bin(['sync'], { cwd, env: { GSTACK_STATE_ROOT: fresh, GSTACK_APPROVALS_DIR: mirror } }).out).toMatch(/^APPROVAL_SYNCED: rows=1 /);
  });

  test('an ephemeral state root with no record and no mirror is unavailable, not empty', () => {
    const r = bin(['render'], { cwd: repo(), env: { GSTACK_STATE_ROOT: tmp('appr-state-'), GSTACK_EPHEMERAL: '1', HOME: tmp('appr-home-') } });
    expect(r.status).toBe(1);
    expect(r.out).toContain('Record unavailable on this machine');
    expect(r.err).toContain('(APPROVAL_RECORD_UNAVAILABLE)');
  });

  test('readRecord merges local and mirror rows by id', () => {
    const d = tmp('appr-merge-');
    const a = buildRow({ ask: 'a', words: 'w', by: 'b', scope: 's' }, 'x'); const b = buildRow({ ask: 'b', words: 'w', by: 'b', scope: 's' }, 'x');
    if ('code' in a || 'code' in b) throw new Error('row');
    fs.writeFileSync(path.join(d, 'local.jsonl'), JSON.stringify(a) + '\n{torn');
    fs.writeFileSync(path.join(d, 'mirror.jsonl'), [a, b].map(r => JSON.stringify(r)).join('\n') + '\n');
    const read = readRecord({ file: path.join(d, 'local.jsonl'), mirror: path.join(d, 'mirror.jsonl'), branch: 'x', slug: 's', ephemeral: true });
    expect(read.rows.map(r => r.ask).sort()).toEqual(['a', 'b']);
    expect(read.state).toBe('present');
  });
});

describe('import --autoplan --stack', () => {
  function stackRepo(): string {
    const d = repo('feature/one');
    const g = (args: string[]) => expect(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: d, timeout: 30_000 }).status).toBe(0);
    g(['commit', '-q', '--allow-empty', '-m', 'seed']);
    g(['branch', 'feature/two']);
    return d;
  }

  test('writes the same rows to every branch, each in its own record; a retry adds nothing', () => {
    const run = tmp('appr-run-');
    autoplanRun(run, [{ by: 'agent:GSTA-36', words: 'Garry: Do it', at: '2026-10-29T03:40:00.000Z', p1: 'a' }]);
    const cwd = stackRepo(); const state = tmp('appr-state-');
    const env = { GSTACK_STATE_ROOT: state };
    const r = bin(['import', '--autoplan', run, '--by', 'Garry', '--stack', 'feature/one,feature/two'], { cwd, env });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/^APPROVAL_IMPORTED: branch=feature\/one n=1 skipped=0 /m);
    expect(r.out).toMatch(/^APPROVAL_IMPORTED: branch=feature\/two n=1 skipped=0 /m);
    expect(r.out).toMatch(/^APPROVAL_IMPORTED_STACK: branches=2 added=2$/m);
    for (const b of ['feature/one', 'feature/two']) expect(bin(['render', '--branch', b], { cwd, env }).out).toContain('Garry: Do it');
    expect(bin(['import', '--autoplan', run, '--by', 'Garry', '--stack', 'feature/one,feature/two'], { cwd, env }).out).toMatch(/^APPROVAL_IMPORTED_STACK: branches=2 added=0$/m);
  });

  test('one unknown branch writes nothing to any branch', () => {
    const run = tmp('appr-run-');
    autoplanRun(run, [{ by: 'agent:GSTA-36', words: 'rec', at: '2026-10-29T03:40:00.000Z', p1: 'a' }]);
    const cwd = stackRepo(); const state = tmp('appr-state-');
    const r = bin(['import', '--autoplan', run, '--stack', 'feature/one,feature/nope'], { cwd, env: { GSTACK_STATE_ROOT: state } });
    expect(r.status).toBe(3);
    expect(r.err).toContain('feature/nope');
    expect(r.err).toContain('(APPROVAL_RECORD_NO_BRANCH)');
    expect(bin(['render', '--branch', 'feature/one'], { cwd, env: { GSTACK_STATE_ROOT: state } }).out).not.toContain('Approve the plan');
  });

  test('--stack goes with import --autoplan and without --branch', () => {
    const cwd = stackRepo();
    expect(bin(['import', '--autoplan', tmp('appr-run-'), '--branch', 'feature/one', '--stack', 'feature/one'], { cwd }).status).toBe(2);
  });
});
