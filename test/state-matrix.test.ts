/**
 * W3 (field list 2): the round-trip matrix for proposal, hold and approval
 * state machines, as a free regression on a captured review. The capture
 * (test/fixtures/state-matrix-6792/captured-output.jsonl, provenance in
 * capture.json) is a real state-machines specialist run on the #6792-shaped
 * fixture: a PR that adds deactivate and replace proposal kinds and lets a
 * deactivate or a same-claim replace fall through to the remove path, with
 * tests only for add, remove and a new-claim replace. `gstack-state-matrix
 * check` must pass it against the fixture's ground truth, and fail each
 * negative control derived from it. The paid behavior case that reruns the
 * specialist live is `review-army-state-matrix` in
 * test/skill-e2e-review-army.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { VERDICT_ASK, workspaceStep } from '../lib/review-brief';
import { checkStateMatrix, detectStateMachine, words } from '../lib/state-matrix';
import { makeStateMatrixRepo, STATE_MATRIX_FIXTURE, type StateMatrixRepo } from './helpers/state-matrix-fixture';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-state-matrix');
const CAPTURED = fs.readFileSync(path.join(STATE_MATRIX_FIXTURE, 'captured-output.jsonl'), 'utf8');
const EXPECT = JSON.parse(fs.readFileSync(path.join(STATE_MATRIX_FIXTURE, 'expect.json'), 'utf8'));
const repos: StateMatrixRepo[] = [];
const repo = () => { const r = makeStateMatrixRepo(); repos.push(r); return r; };
afterAll(() => { for (const r of repos) fs.rmSync(r.root, { recursive: true, force: true }); });

function run(cwd: string, args: string[], input?: string) {
  const r = spawnSync(BIN, args, { cwd, encoding: 'utf8', timeout: 60_000, input });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

type Line = Record<string, any>;
const lines = (): Line[] => CAPTURED.trim().split('\n').map(l => JSON.parse(l));
const render = (ls: Line[]) => ls.map(l => JSON.stringify(l)).join('\n') + '\n';
const isCell = (l: Line, kind: string, action: string) => l.category === 'state-matrix' && l.cell?.kind === kind && l.cell?.action === action;

describe('gstack-state-matrix detect', () => {
  test('the #6792-shaped diff is a state machine; the dispatch line is shell-safe', () => {
    const r = repo();
    const d = run(r.work, ['detect', '--base', 'main']);
    expect(d.status).toBe(EXIT.ok);
    expect(d.out.split('\n')[0]).toBe('SCOPE_STATE_MACHINE=true');
    expect(d.out).toMatch(/^# state-machine: src\/takes\/proposals\.ts:\d+ /m);
    expect(d.out.trim().split('\n').every(l => /^SCOPE_STATE_MACHINE=(true|false)$/.test(l) || l.startsWith('# '))).toBe(true);
  });

  test('review #3235 P1-4: diff.external and a textconv driver cannot hide the state machine from detect', () => {
    const r = repo();
    r.git('config', 'diff.external', '/bin/true');
    expect(run(r.work, ['detect', '--base', 'main']).out.split('\n')[0]).toBe('SCOPE_STATE_MACHINE=true');
    r.git('config', '--unset', 'diff.external');
    fs.writeFileSync(path.join(r.work, '.git', 'info', 'attributes'), '*.ts diff=blank\n');
    r.git('config', 'diff.blank.textconv', 'true');
    expect(run(r.work, ['detect', '--base', 'main']).out.split('\n')[0]).toBe('SCOPE_STATE_MACHINE=true');
  });

  test('negative controls: a test-only change and words that merely contain "hold" or "accept" do not dispatch', () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'unrelated', 'origin/main');
    fs.writeFileSync(path.join(r.work, 'src', 'limits.ts'), 'export const threshold = 3;\nexport const householdSize = 4;\nexport const acceptance = threshold;\n');
    fs.writeFileSync(path.join(r.work, 'test', 'more.test.ts'), "test('accepting a pending proposal', () => {});\n");
    r.git('add', '-A');
    r.git('commit', '-qm', 'limits');
    expect(run(r.work, ['detect', '--base', 'main']).out).toBe('SCOPE_STATE_MACHINE=false\n');
    expect(words('acceptProposal(takes_deactivate) holdPending')).toEqual(['accept', 'proposal', 'takes', 'deactivate', 'hold', 'pending']);
    expect(detectStateMachine(new Map([['src/a.ts', [{ line: 1, text: 'const proposal = load();' }]]])).detected).toBe(false);
  });
});

describe('gstack-state-matrix outfile', () => {
  test('each call prints a new empty private file under an excluded .gstack/tmp, so a rerun never checks or commits the last output', () => {
    const r = repo();
    const sub = path.join(r.work, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const first = run(sub, ['outfile']);
    expect(first.status).toBe(EXIT.ok);
    const a = first.out.trim();
    fs.writeFileSync(a, 'previous run output\n');
    const b = run(r.work, ['outfile']).out.trim();
    const tmp = path.join(fs.realpathSync(r.work), '.gstack', 'tmp');
    for (const file of [a, b]) expect(path.dirname(fs.realpathSync(file))).toBe(tmp);
    expect(b).not.toBe(a);
    expect(fs.readFileSync(b, 'utf8')).toBe('');
    expect(fs.statSync(b).mode & 0o777).toBe(0o600);
    expect(fs.statSync(tmp).mode & 0o777).toBe(0o700);
    const exclude = fs.readFileSync(path.join(r.work, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter(l => l === '/.gstack/tmp/')).toHaveLength(1);
    expect(spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: r.work, encoding: 'utf8', timeout: 30_000 }).stdout).not.toContain('.gstack');
  });

  test('outside a git repository it refuses with a usage exit and prints no path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-outfile-'));
    try {
      const r = run(dir, ['outfile']);
      expect(r.status).toBe(EXIT.usage);
      expect(r.out).toBe('');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('gstack-state-matrix check on the captured #6792 review', () => {
  test('the capture passes: every kind × action has a row, real tests, and each untested cell is CRITICAL; the destructive cells are named', () => {
    const r = repo();
    const file = path.join(r.root, 'out.jsonl');
    fs.writeFileSync(file, CAPTURED);
    const c = run(r.work, ['check', file, '--expect', path.join(STATE_MATRIX_FIXTURE, 'expect.json')]);
    expect(c.status, c.out + c.err).toBe(EXIT.ok);
    expect(c.out).toMatch(/^STATE_MATRIX: take proposals \(src\/takes\/proposals\.ts\) kinds=5 actions=2 cells=10 tested=4 untested=6 reported=6$/m);
    expect(c.out).toMatch(/^STATE_MATRIX_CHECK: ok machines=1$/m);
    const critical = lines().filter(l => l.severity === 'CRITICAL');
    expect(critical.some(l => isCell(l, 'takes_deactivate', 'accept') && /wrong row/.test(l.summary))).toBe(true);
    expect(critical.some(l => l.cell?.kind?.includes('same claim') && l.cell?.action === 'accept')).toBe(true);
    expect(run(r.work, ['check', '-'], CAPTURED).status).toBe(EXIT.ok);
  });

  const controls: Array<[string, (ls: Line[]) => Line[], RegExp]> = [
    ['an untested cell with its findings removed', ls => ls.filter(l => !isCell(l, 'takes_deactivate', 'drop')), /^STATE_MATRIX_GAP: unreported takes_deactivate×drop /m],
    ['an untested cell downgraded below High', ls => ls.map(l => (isCell(l, 'takes_add', 'drop') ? { ...l, severity: 'INFORMATIONAL' } : l)), /^STATE_MATRIX_GAP: not-high takes_add×drop — reported as INFORMATIONAL/m],
    ['a missing row', ls => ls.map(l => (l.matrix ? { ...l, matrix: { ...l.matrix, cells: l.matrix.cells.filter((c: Line) => !(c.kind === 'takes_replace' && c.action === 'drop')) } } : l)), /^STATE_MATRIX_GAP: cell-absent takes_replace×drop /m],
    ['a dropped kind', ls => ls.map(l => (l.matrix ? { ...l, matrix: { ...l.matrix, kinds: l.matrix.kinds.filter((k: string) => k !== 'takes_deactivate'), cells: l.matrix.cells.filter((c: Line) => c.kind !== 'takes_deactivate') } } : l)), /^STATE_MATRIX_GAP: kind-missing — no matrix lists the kind deactivate$/m],
    ['an untested cell claimed by a sibling kind\'s test', ls => ls.map(l => (l.matrix ? { ...l, matrix: { ...l.matrix, cells: l.matrix.cells.map((c: Line) => (c.kind === 'takes_deactivate' && c.action === 'accept' ? { ...c, test: 'test/proposals.test.ts:18' } : c)) } } : l)), /^STATE_MATRIX_GAP: untested-cell-claimed deactivate×accept — mapped to test\/proposals\.test\.ts:18/m],
    ['an invented test path', ls => ls.map(l => (l.matrix ? { ...l, matrix: { ...l.matrix, cells: l.matrix.cells.map((c: Line) => (c.test === 'test/proposals.test.ts:25' ? { ...c, test: 'test/takes-drop.test.ts:4' } : c)) } } : l)), /^STATE_MATRIX_GAP: test-unresolved takes_remove×drop — test\/takes-drop\.test\.ts:4 is not a file/m],
    ['a test line past the end of the file', ls => ls.map(l => (l.matrix ? { ...l, matrix: { ...l.matrix, cells: l.matrix.cells.map((c: Line) => (c.test === 'test/proposals.test.ts:25' ? { ...c, test: 'test/proposals.test.ts:999' } : c)) } } : l)), /^STATE_MATRIX_GAP: test-unresolved takes_remove×drop /m],
    ['no matrix record', ls => ls.filter(l => !l.matrix), /^STATE_MATRIX_GAP: no-matrix /m],
  ];
  for (const [name, mutate, gap] of controls) {
    test(`negative control: ${name}`, () => {
      const r = repos[0] ?? repo();
      const c = run(r.work, ['check', '-', '--expect', path.join(STATE_MATRIX_FIXTURE, 'expect.json')], render(mutate(lines())));
      expect(c.status).toBe(EXIT.fail);
      expect(c.out).toMatch(gap);
      expect(c.out).toMatch(/^STATE_MATRIX_CHECK: incomplete gaps=\d+ machines=\d$/m);
      expect(c.err).toMatch(/\(STATE_MATRIX_INCOMPLETE\)$/m);
    });
  }

  test('NO FINDINGS is complete only when nothing was expected; prose is a gap', () => {
    const r = repos[0] ?? repo();
    expect(run(r.work, ['check', '-'], 'NO FINDINGS\n').out).toBe('STATE_MATRIX_CHECK: ok machines=0\n');
    expect(checkStateMatrix('NO FINDINGS\n', r.work, EXPECT).gaps.map(g => g.code)).toEqual(['no-matrix']);
    expect(checkStateMatrix('Here is my review:\n' + CAPTURED, r.work, EXPECT).gaps.map(g => g.code)).toEqual(['unparsed-line']);
  });

  /** The two header lines a /ship reader's brief asks for, made the way the brief says: its fingerprint command run in the checkout, then its verdict line with n=0. */
  function briefHeader(dir: string): string {
    const command = /run `([^`]+)`/.exec(workspaceStep(dir, true))![1]!;
    const tree = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: 30_000 });
    expect(tree.status, tree.stderr).toBe(0);
    const verdict = /`(REVIEW_VERDICT: blocking=)<n>`/.exec(VERDICT_ASK)![1]! + '0';
    return `${tree.stdout.trim()}\n${verdict}\n`;
  }

  // Value: protects=a /ship state-machines reader that follows its brief is checked on its matrix, not stopped as incomplete; fails_when=the REVIEWED_TREE or REVIEW_VERDICT header the brief requires is read as an unparsed-line gap (CAPY-1 on yc-software/qm#3728), or any other prose line stops being one.
  test('a reply that opens with the REVIEWED_TREE and REVIEW_VERDICT lines its brief requires is complete; other prose is still a gap', () => {
    const r = repos[0] ?? repo();
    const header = briefHeader(r.work);
    const c = run(r.work, ['check', '-', '--expect', path.join(STATE_MATRIX_FIXTURE, 'expect.json')], header + CAPTURED);
    expect(c.status, c.out + c.err).toBe(EXIT.ok);
    expect(c.out).toMatch(/^STATE_MATRIX_CHECK: ok machines=1$/m);
    expect(c.out).not.toContain('STATE_MATRIX_GAP');
    expect(run(r.work, ['check', '-'], header + 'NO FINDINGS\n').out).toBe('STATE_MATRIX_CHECK: ok machines=0\n');
    expect(checkStateMatrix(header.split('\n')[0] + '\n' + CAPTURED, r.work, EXPECT).gaps).toEqual([]);

    const gaps = (text: string) => checkStateMatrix(text, r.work, EXPECT).gaps.map(g => `${g.code}: ${g.detail}`);
    expect(gaps(header + 'Here is my review:\n' + CAPTURED)).toEqual(['unparsed-line: Here is my review:']);
    expect(gaps(header + CAPTURED + header)).toEqual(header.trim().split('\n').map(l => `unparsed-line: ${l}`));
    expect(gaps(header.replace('blocking=0', 'blocking=none') + CAPTURED)).toEqual(['unparsed-line: REVIEW_VERDICT: blocking=none']);
    const [tree, verdict] = header.trim().split('\n');
    expect(gaps(`${verdict}\n${tree}\n` + CAPTURED)).toEqual([verdict, tree].map(l => `unparsed-line: ${l}`));
  });
});

describe('gstack-specialist-stats', () => {
  test('state-machines is NEVER_GATE like security and data-migration', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stats-'));
    try {
      expect(spawnSync('git', ['init', '-q'], { cwd: root, timeout: 30_000 }).status).toBe(0);
      const stats = path.resolve(import.meta.dir, '..', 'bin', 'gstack-specialist-stats');
      const env = { ...process.env, GSTACK_STATE_ROOT: path.join(root, 'state') };
      const slug = spawnSync(path.resolve(import.meta.dir, '..', 'bin', 'gstack-slug'), [], { cwd: root, encoding: 'utf8', timeout: 30_000, env }).stdout.match(/^SLUG=(.+)$/m)![1];
      const dir = path.join(root, 'state', 'projects', slug);
      fs.mkdirSync(dir, { recursive: true });
      const entry = { specialists: Object.fromEntries(['state-machines', 'testing'].map(n => [n, { dispatched: true, findings: 0 }])) };
      fs.writeFileSync(path.join(dir, 'main-reviews.jsonl'), Array(10).fill(JSON.stringify(entry)).join('\n') + '\n');
      const r = spawnSync(stats, [], { cwd: root, encoding: 'utf8', timeout: 60_000, env });
      expect(r.stdout).toContain('state-machines: 10/10 dispatched, 0 findings (0%) [NEVER_GATE]');
      expect(r.stdout).toContain('testing: 10/10 dispatched, 0 findings (0%) [GATE_CANDIDATE]');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
