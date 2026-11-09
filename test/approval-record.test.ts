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
import { APPROVALS_TABLE_HEADER, branchKey, buildRow, cell, importAutoplan, pathLabels, readRecord, renderRecord, type StoreLocation } from '../lib/approval-record';

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
    const r = bin(['render', '--full'], { cwd, env: { GSTACK_STATE_ROOT: state } });
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

  test("the owner's grant for a stop head whose short sha is all digits records (Free Tests 41667825418, 41766865679)", () => {
    const cwd = repo(); const state = tmp('appr-state-');
    const ask = 'Owner grant: one scoped fix-check after round 2 (review_loop_grant 367120488513)';
    const r = bin(['add', '--ask', ask, '--words', 'do it', '--by', 'GStack Minder', '--scope', 'this /ship invocation'], { cwd, env: { GSTACK_STATE_ROOT: state } });
    expect(r.status, r.err).toBe(0);
    const file = /^APPROVAL_RECORDED: a-[0-9a-f]{12} (.*\.jsonl)$/m.exec(r.out)![1]!;
    expect(fs.readFileSync(file, 'utf8')).toContain('review_loop_grant 367120488513');
    const control = bin(['add', '--ask', 'Owner grant (review_loop_grant 367120488513), call 367120488513 first', '--words', 'do it', '--by', 'g', '--scope', 's'], { cwd, env: { GSTACK_STATE_ROOT: state } });
    expect(control.status).toBe(3);
    expect(control.err).toContain('field ask: pii.phone.e164');
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

describe('public repositories get no identifying approval text (GST-1160)', () => {
  const fakeGh = (out: string, code = 0) => {
    const d = tmp('appr-gh-');
    fs.writeFileSync(path.join(d, 'gh'), `#!/bin/sh\nprintf '%s\\n' '${out}'\nexit ${code}\n`, { mode: 0o755 });
    return { PATH: `${d}:${process.env.PATH}` };
  };
  const QUOTE = ['add', '--ask', 'Approve the plan "Qm leak fix" (autoplan run 20261102-qm-77, 4 decisions)', '--words', 'do it, ship the leak fix', '--by', 'Garry (via QM Minder)', '--scope', 'the reviewed plan (sha256 9f2c1e0b7a6d5c4b3a29180716f5e4d3c2b1a0f9e8d7c6b5a4938271605f4e3d)'];
  const leaks = (out: string) => ['do it, ship the leak fix', '20261102-qm-77', '9f2c1e0b7a6d', 'Garry', 'Qm leak fix'].filter(s => out.includes(s));

  for (const [label, env] of [['public', () => fakeGh('PUBLIC')], ['unknown (gh fails)', () => fakeGh('', 1)]] as const) {
    test(`a ${label} repository renders only that it was approved and an opaque record id`, () => {
      const cwd = repo(); const state = tmp('appr-state-');
      expect(bin(QUOTE, { cwd, env: { GSTACK_STATE_ROOT: state } }).status).toBe(0);
      const r = bin(['render'], { cwd, env: { GSTACK_STATE_ROOT: state, ...env() } });
      expect(r.status, r.err).toBe(0);
      expect(leaks(r.out)).toEqual([]);
      expect(r.out).toContain('## Approvals');
      expect(r.out).toMatch(/^Approved: yes \(record r-[0-9a-f]{12}\)/m);
      expect(r.out).not.toContain(APPROVALS_TABLE_HEADER);
      expect(r.err).toContain('APPROVALS_RENDER: redacted');
    });
  }

  test('a private repository keeps the full table, and --full is the explicit override when visibility is unknown', () => {
    const cwd = repo(); const state = tmp('appr-state-');
    expect(bin(QUOTE, { cwd, env: { GSTACK_STATE_ROOT: state } }).status).toBe(0);
    const priv = bin(['render'], { cwd, env: { GSTACK_STATE_ROOT: state, ...fakeGh('PRIVATE') } });
    expect(priv.out).toContain(APPROVALS_TABLE_HEADER);
    expect(priv.out).toContain('do it, ship the leak fix');
    const forced = bin(['render', '--full'], { cwd, env: { GSTACK_STATE_ROOT: state, ...fakeGh('', 1) } });
    expect(forced.out).toContain('do it, ship the leak fix');
  });

  test('--full never prints identifying text for a repository GitHub reports as public', () => {
    const cwd = repo(); const state = tmp('appr-state-');
    expect(bin(QUOTE, { cwd, env: { GSTACK_STATE_ROOT: state } }).status).toBe(0);
    const r = bin(['render', '--full'], { cwd, env: { GSTACK_STATE_ROOT: state, ...fakeGh('PUBLIC') } });
    expect(leaks(r.out)).toEqual([]);
    expect(r.err).toContain('public');
  });

  test('a private repository gh picks by default does not unlock the table for a public origin', () => {
    const cwd = repo(); const state = tmp('appr-state-'); const d = tmp('appr-gh-');
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/public-widgets.git'], { cwd, timeout: 30_000 });
    fs.writeFileSync(path.join(d, 'gh'), '#!/bin/sh\ncase " $* " in *" acme/public-widgets "*) echo PUBLIC ;; *) echo PRIVATE ;; esac\n', { mode: 0o755 });
    expect(bin(QUOTE, { cwd, env: { GSTACK_STATE_ROOT: state } }).status).toBe(0);
    const r = bin(['render'], { cwd, env: { GSTACK_STATE_ROOT: state, GH_REPO: 'acme/private-upstream', PATH: `${d}:${process.env.PATH}` } });
    expect(leaks(r.out)).toEqual([]);
    expect(r.err).toContain('APPROVALS_RENDER: redacted (repository visibility public');
  });

  test('the redacted record id is stable for the same rows and changes when a row is added', () => {
    const cwd = repo(); const state = tmp('appr-state-');
    const id = () => /record (r-[0-9a-f]{12})/.exec(bin(['render'], { cwd, env: { GSTACK_STATE_ROOT: state, ...fakeGh('PUBLIC') } }).out)![1];
    bin(QUOTE, { cwd, env: { GSTACK_STATE_ROOT: state } });
    const first = id();
    expect(id()).toBe(first);
    bin(ADD, { cwd, env: { GSTACK_STATE_ROOT: state } });
    expect(id()).not.toBe(first);
  });

  describe('full rows never carry a local path in Covers (GST-2048)', () => {
    const LEDGER = '/home/user/.capy/drive/project-user-gstack-garry-tan/ship-budget/ledger.jsonl';
    const SCOPES = [
      `spend cap 25000 credits, counted in ${LEDGER}`,
      'the plan at ~/.gstack/projects/acme-widgets/plans/fix.md, and /Users/dana/work/widgets/notes.txt',
      'the checkout /workspace/gstack/lib/approval-record.ts; C:\\Users\\dana\\gstack\\plan.md',
    ];
    const pathLike = /(?:^|[\s(])(?:~[\\/]|\/[^\s/|]+\/|[A-Za-z]:[\\/])/;
    const addScoped = (cwd: string, state: string) => SCOPES.forEach((scope, i) =>
      expect(bin(['add', '--ask', `Spend cap ${i}`, '--words', 'do it', '--by', 'Garry (via GStack Minder)', '--scope', scope], { cwd, env: { GSTACK_STATE_ROOT: state } }).status).toBe(0));
    const post = (body: string) => {
      const d = tmp('appr-post-'); const stubs = tmp('appr-post-gh-');
      fs.writeFileSync(path.join(stubs, 'gitconfig'), '');
      const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(stubs, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
      spawnSync('git', ['init', '-q'], { cwd: d, timeout: 30_000, env: gitEnv });
      spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widget.git'], { cwd: d, timeout: 30_000, env: gitEnv });
      fs.writeFileSync(path.join(stubs, 'gh'), '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 });
      const file = path.join(d, 'body.md'); fs.writeFileSync(file, body);
      const r = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-post'), 'pr-body', '7', '--replace', '--repo-visibility', 'private', '--body-file', file], {
        cwd: d, encoding: 'utf8', timeout: 60_000, env: { ...gitEnv, PATH: `${stubs}:${process.env.PATH}`, GSTACK_STATE_ROOT: tmp('appr-post-state-') },
      });
      return { status: r.status ?? -1, err: r.stderr ?? '' };
    };

    test('a private render labels each path by its file name, and gstack-post finds no internal.user_path in it', () => {
      const cwd = repo(); const state = tmp('appr-state-');
      addScoped(cwd, state);
      const r = bin(['render'], { cwd, env: { GSTACK_STATE_ROOT: state, ...fakeGh('PRIVATE') } });
      expect(r.status, r.err).toBe(0);
      expect(r.out).toContain(APPROVALS_TABLE_HEADER);
      const control = post(`## Approvals\n\nCovers ${LEDGER}\n`);
      expect(control.status, control.err).toBe(0);
      expect(control.err).toContain('internal.user_path');
      const posted = post(r.out);
      expect(posted.status, posted.err).toBe(0);
      expect(posted.err).not.toContain('internal.user_path');
      const covers = r.out.split('\n').filter(l => /^\| \d{4}-/.test(l)).map(l => l.split(' | ')[4]!);
      expect(covers).toHaveLength(3);
      for (const c of covers) expect(c).not.toMatch(pathLike);
      expect(r.out).toContain('ledger.jsonl');
      expect(r.out).toContain('fix.md');
      expect(r.out).not.toContain('garry-tan');
      expect(r.out).not.toContain('dana');
      const list = bin(['list', '--json'], { cwd, env: { GSTACK_STATE_ROOT: state } });
      expect(JSON.parse(list.out).rows.map((row: { scope: string }) => row.scope).sort()).toEqual([...SCOPES].sort());
    });

    test('--redacted on a private repository prints the same bytes as the public render', () => {
      const cwd = repo(); const state = tmp('appr-state-');
      addScoped(cwd, state);
      const pub = bin(['render'], { cwd, env: { GSTACK_STATE_ROOT: state, ...fakeGh('PUBLIC') } });
      const forced = bin(['render', '--redacted'], { cwd, env: { GSTACK_STATE_ROOT: state, ...fakeGh('PRIVATE') } });
      expect(forced.status, forced.err).toBe(0);
      expect(forced.out).toBe(pub.out);
      expect(forced.out).not.toContain(APPROVALS_TABLE_HEADER);
      expect(forced.err).toContain('APPROVALS_RENDER: redacted (--redacted');
    });

    test('--redacted with --full refuses and prints nothing', () => {
      const cwd = repo(); const state = tmp('appr-state-');
      addScoped(cwd, state);
      for (const args of [['render', '--redacted', '--full'], ['render', '--full', '--redacted']]) {
        const r = bin(args, { cwd, env: { GSTACK_STATE_ROOT: state, ...fakeGh('PRIVATE') } });
        expect(r.status).toBe(2);
        expect(r.out).toBe('');
        expect(r.err).toContain('--redacted and --full conflict');
      }
    });

    test('Asked and Still pending get the same labels as Covers; Exact words stays verbatim', () => {
      const cwd = repo(); const state = tmp('appr-state-');
      expect(bin(['add', '--ask', `Raise the cap in ${LEDGER}?`, '--words', 'do it', '--by', 'Garry', '--scope', 'spend cap', '--pending', `settle file:///home/dana/ledger.json`], { cwd, env: { GSTACK_STATE_ROOT: state } }).status).toBe(0);
      const r = bin(['render'], { cwd, env: { GSTACK_STATE_ROOT: state, ...fakeGh('PRIVATE') } });
      expect(r.status, r.err).toBe(0);
      expect(r.out).toContain('Raise the cap in …/ledger.jsonl?');
      expect(r.out).toContain('settle …/ledger.json');
      expect(r.out).not.toContain('garry-tan');
      expect(r.out).not.toContain('dana');
    });

    test('paths glued onto a colon or dash and file: in any case are labelled, and gstack-post finds no internal.user_path', () => {
      const GLUED = ['ledger:/home/u/.capy/drive/project-user-x-y/x.md', 'garry@host:/home/u/x.md', 'file:/home/u/x', 'FILE:///home/u/a/b', 'run-/home/u/a.md'];
      const cwd = repo(); const state = tmp('appr-state-');
      for (const [i, scope] of [...GLUED, 'see https://github.com/o/r'].entries()) expect(bin(['add', '--ask', `Glued path ${i}`, '--words', 'do it', '--by', 'Garry', '--scope', scope], { cwd, env: { GSTACK_STATE_ROOT: state } }).status).toBe(0);
      const r = bin(['render'], { cwd, env: { GSTACK_STATE_ROOT: state, ...fakeGh('PRIVATE') } });
      expect(r.status, r.err).toBe(0);
      for (const label of ['ledger:…/x.md', 'host:…/x.md', '…/x', '…/b', 'run-…/a.md', 'see https://github.com/o/r']) expect(r.out).toContain(label);
      expect(r.out).not.toContain('/home/u');
      const posted = post(r.out);
      expect(posted.status, posted.err).toBe(0);
      expect(posted.err).not.toContain('internal.user_path');
    });

    test.each([
      ['see https://github.com/acme/widget/pull/12', 'see https://github.com/acme/widget/pull/12'],
      ['https://github.com/o/r', 'https://github.com/o/r'],
      ['ledger:/home/u/.capy/drive/project-user-x-y/x.md', 'ledger:…/x.md'],
      ['garry@host:/home/u/x.md', 'garry@host:…/x.md'],
      ['file:/home/u/x', '…/x'],
      ['FILE:///home/u/a/b', '…/b'],
      ['run-/home/u/a.md', 'run-…/a.md'],
      ['lib/approval-record.ts and 3/4 done', 'lib/approval-record.ts and 3/4 done'],
      ['/home/dana', '~'],
      ['~/.gstack/plans/fix.md.', '…/fix.md.'],
      ['~dana/notes/x.md', '…/x.md'],
      ['$HOME/.capy/drive/project-user-acme-dana/l.json', '…/l.json'],
      ['.capy/drive/project-user-acme-dana/l.json', '…/l.json'],
      ['file:///Users/dana/a/b.json', '…/b.json'],
      ['\\\\server\\share\\dana\\x.md', '…/x.md'],
      ['%USERPROFILE%\\dana\\a.md', '…/a.md'],
    ])('pathLabels(%p) is %p', (input, label) => {
      expect(pathLabels(input)).toBe(label);
    });
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

function autoplanRun(dir: string, answers: Array<{ by: string; words?: string; at: string; p1: string; own?: boolean }>) {
  const rows = [];
  for (const a of answers) {
    for (const id of ['d1', 'p1']) rows.push({
      schema_version: 1, run: 'run-1', id: `run-1-${id}`, label: id.toUpperCase(), title: id === 'p1' ? 'Plan approval' : 'Split the CLI [run-1-ceo-native-2]',
      options: ['a', 'b'], recommended: 'a', kind: id === 'p1' ? 'approval' : 'auto', status: 'approved', gate_rev: 1,
      chosen: id === 'p1' ? a.p1 : 'a', answered_at: a.at, reply: a.words ?? 'rec', answered_by: a.by, ...(a.by === 'human' ? {} : a.own ? { answer_words: a.words, words_by: a.by } : { owner_reply: a.words }),
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

  test("each row names its own answerer: --by names only the owner's words, an agent's own words import under the agent (GEVA-2)", () => {
    const run = tmp('appr-run-');
    autoplanRun(run, [{ by: 'agent:GSTA-36', words: 'Do it', at: '2026-10-20T21:35:42.697Z', p1: 'a' }, { by: 'agent:GSTA-36', words: 'Accepted on the standing approval', at: '2026-10-21T08:00:00.000Z', p1: 'a', own: true }]);
    const rows = importAutoplan(run, 'b', 'Garry');
    if ('code' in rows) throw new Error(rows.message);
    expect(rows.map(r => [r.by, r.words])).toEqual([['Garry, relayed by agent:GSTA-36', 'Do it'], ["agent:GSTA-36, its own decision (not the owner's words)", 'Accepted on the standing approval']]);
    expect(rows.map(r => r.words_by ?? null)).toEqual([null, 'agent:GSTA-36']);
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

  // Value: protects=an autoplan run id (<out dir name>-<14-digit stamp>) in the two places import puts it (the ask's "autoplan run <id>" and the
  //   source's "autoplan:<id>@") never trips pii.phone.e164 or pii.cc, so a crew whose thread code ends in digits can record its gate (GST-2047,
  //   HARN-1); fails_when=import refuses HARN-64-20261109177601 (phone) or GEVA-2-20261109173601 (Luhn), or the exemption reaches past those two
  //   positions: a phone number in the same row's words or plan title, in the directory-name half of a minted id, a run id that is not the minted shape, or the same id typed into add
  //   --ask; why_new=the Luhn-stamp test covers only a stamp the scanner already skips; seam=none; no_claim=other callers of the scanner
  test('a minted autoplan run id in its own fields imports; a phone number in the same row, or the id anywhere else, still refuses', () => {
    const importWith = (o: { runId: string; words?: string; title?: string }) => {
      const run = tmp('appr-run-');
      autoplanRun(run, [{ by: 'agent:GSTA-36', words: o.words ?? 'do it', at: '2026-11-09T17:36:01.000Z', p1: 'a' }]);
      fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ run: o.runId, status: 'complete' }));
      if (o.title) fs.writeFileSync(path.join(run, 'plan-active.md'), `# ${o.title}\n\n## Implementation plan\n\n1. Fix it.\n`);
      return { run, rows: importAutoplan(run, 'b', 'Garry') };
    };
    for (const runId of ['HARN-64-20261109177601', 'GEVA-2-20261109173601']) {
      const { run, rows } = importWith({ runId });
      if ('code' in rows) throw new Error(`${runId}: ${rows.message}`);
      expect([rows[0]!.ask, rows[0]!.source]).toEqual([`Approve the plan "Widget fix" (autoplan run ${runId}, 2 decisions)`, `autoplan:${runId}@gate_rev=1`]);
      expect(bin(['import', '--autoplan', run, '--by', 'Garry'], { cwd: repo(), env: { GSTACK_STATE_ROOT: tmp('appr-state-') } }).out).toMatch(/^APPROVAL_IMPORTED: n=1 skipped=0 /);
    }
    const refused: Array<[{ runId: string; words?: string; title?: string }, string]> = [
      [{ runId: 'HARN-64-20261109177601', words: 'do it, call +14155552671 if it breaks' }, 'field words: pii.phone.e164'],
      [{ runId: 'HARN-64-20261109177601', words: 'do it, call 14155552671 if it breaks' }, 'field words: pii.phone.e164'],
      [{ runId: 'HARN-64-20261109177601', title: 'Call 14155552671 first' }, 'field ask: pii.phone.e164'],
      [{ runId: 'call-14155552671' }, 'field ask: pii.phone.e164'],
      [{ runId: '+14155552671-20261109173601' }, 'field ask: pii.phone.e164'],
      [{ runId: '14155552671-20261109173601' }, 'field source: pii.phone.e164'],
      [{ runId: 'call-415-555-2671-20261109173601' }, 'field ask: pii.phone.e164'],
    ];
    for (const [o, message] of refused) expect([o, importWith(o).rows]).toEqual([o, { code: 'APPROVAL_RECORD_SECRET', message }]);
    const typed = bin(['add', '--ask', 'Approve the plan (autoplan run HARN-64-20261109177601, 2 decisions)', '--words', 'do it', '--by', 'Garry', '--scope', 'the plan'], { cwd: repo(), env: { GSTACK_STATE_ROOT: tmp('appr-state-') } });
    expect([typed.status, typed.out + typed.err]).toEqual([typed.status, expect.stringContaining('field ask: pii.phone.e164')]);
    expect(typed.status).not.toBe(0);
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
    const r = bin(['render', '--full'], { cwd, env: { GSTACK_STATE_ROOT: fresh, GSTACK_APPROVALS_DIR: mirror, GSTACK_EPHEMERAL: '1' } });
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
    for (const b of ['feature/one', 'feature/two']) expect(bin(['render', '--full', '--branch', b], { cwd, env }).out).toContain('Garry: Do it');
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
    expect(bin(['render', '--full', '--branch', 'feature/one'], { cwd, env: { GSTACK_STATE_ROOT: state } }).out).not.toContain('Approve the plan');
  });

  test('--stack goes with import --autoplan and without --branch', () => {
    const cwd = stackRepo();
    expect(bin(['import', '--autoplan', tmp('appr-run-'), '--branch', 'feature/one', '--stack', 'feature/one'], { cwd }).status).toBe(2);
  });
});
