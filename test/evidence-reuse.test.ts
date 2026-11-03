/**
 * gstack-evidence reuse and CI-sourced rows (GSTA-258 pieces 1-2, design fixes A4 and A5).
 *
 * run --reuse: a lane that passed at this exact working tree, command and execution identity never runs again;
 * the newest matching row decides (a newer failure vetoes), the reused row keeps its original timestamp and the
 * max age applies to it. record-ci: a lane CI carried is an explicit CI-sourced row, never a fictitious local run.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findFilesBySuffix, gitIn } from './helpers/scratch-repo';
import { runBin } from './helpers/run-bin';

setDefaultTimeout(60_000);
const EVIDENCE = path.join(import.meta.dir, '..', 'bin', 'gstack-evidence');
let home: string;
let repo: string;
let counter: string;

const run = (args: string[]) => runBin(EVIDENCE, args, { cwd: repo, env: { GSTACK_HOME: home } });
const ledger = () => findFilesBySuffix(path.join(home, 'projects'), '-evidence.jsonl')[0]!;
const rows = (): any[] => fs.readFileSync(ledger(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const rewrite = (edit: (r: any[]) => any[]) => fs.writeFileSync(ledger(), edit(rows()).map(r => JSON.stringify(r)).join('\n') + '\n');
const executions = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0);
const lane = (pass: number, fail = 0) => `printf x >> '${counter}'; printf ' ${pass} pass\\n ${fail} fail\\nRan ${pass + fail} tests across 1 file. [1.00ms]\\n' >&2; exit ${fail ? 1 : 0}`;
const wtree = () => runBin(path.join(import.meta.dir, '..', 'bin', 'gstack-wtree'), [], { cwd: repo }).stdout.trim();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-reuse-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-reuse-repo-'));
  counter = path.join(home, 'executions');
  gitIn(repo, 'init -q -b main');
  fs.writeFileSync(path.join(repo, 'src.txt'), 'v1\n');
  gitIn(repo, 'add src.txt');
  gitIn(repo, 'commit -q -m init');
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('gstack-evidence run --reuse (A5)', () => {
  // Value: protects=a lane that passed at this tree never reruns, and the reuse is visible; fails_when=--reuse runs the suite again, or reports a pass it never recorded;
  //   why_new=GSTA-258 piece 2; seam=the ledger and the wtree fingerprint; no_claim=cross-machine reuse (CI carries that)
  test('a pass at the same tree, command and identity is reused with its original timestamp and count', () => {
    expect(run(['run', '--label', 'unit', '--', lane(4)]).status).toBe(0);
    const first = rows().at(-1);
    const again = run(['run', '--reuse', '--label', 'unit', '--', lane(4)]);
    expect(again.status).toBe(0);
    expect(executions()).toBe(1);
    expect(again.stderr).toContain(`gstack-evidence: reused label=unit tree=${wtree().slice(0, 12)} from=${first.ts}`);
    expect(again.stderr).toMatch(/gstack-evidence: recorded label=unit exit=0 tests_ran=4 log=\S+/);
    const copy = rows().at(-1);
    expect(copy.ts).toBe(first.ts);
    expect(copy.reused_from).toBe(first.ts);
    expect(copy.identity).toBe(first.identity);
    expect(typeof first.identity).toBe('string');
    expect(run(['check', '--label', 'unit']).stdout).toContain('EVIDENCE: FRESH label=unit exit=0 tests_ran=4');
  });

  // Value: protects=only the newest matching row decides; fails_when=an older pass is reused under a newer failure on the same tree
  test('a newer failure on the same tree vetoes an older pass; without --reuse nothing is reused', () => {
    expect(run(['run', '--label', 'unit', '--', lane(4)]).status).toBe(0);
    expect(run(['run', '--label', 'unit', '--', lane(3, 1)]).status).toBe(1);
    expect(run(['run', '--reuse', '--label', 'unit', '--', lane(3, 1)]).status).toBe(1);
    expect(executions()).toBe(3);
    expect(run(['run', '--label', 'unit', '--', lane(4)]).status).toBe(0);
    expect(run(['run', '--label', 'unit', '--', lane(4)]).status).toBe(0);
    expect(executions()).toBe(5);
  });

  // Value: protects=reuse binds to the exact command, tree, count and identity; fails_when=a changed command, an edited file, a zero-run or unknown row, or another runtime reuses
  test('another command, an edited tree, a zero-run or unknown count, or another identity runs again', () => {
    expect(run(['run', '--label', 'unit', '--', lane(4)]).status).toBe(0);
    expect(run(['run', '--reuse', '--label', 'unit', '--', lane(5)]).status).toBe(0);
    expect(executions()).toBe(2);
    fs.writeFileSync(path.join(repo, 'src.txt'), 'v2\n');
    expect(run(['run', '--reuse', '--label', 'unit', '--', lane(5)]).status).toBe(0);
    expect(executions()).toBe(3);
    rewrite(r => r.map(x => ({ ...x, tests_ran: 0 })));
    expect(run(['run', '--reuse', '--label', 'unit', '--', lane(5)]).status).toBe(0);
    expect(executions()).toBe(4);
    rewrite(r => r.map(x => ({ ...x, tests_ran: 'unknown' })));
    expect(run(['run', '--reuse', '--label', 'unit', '--', lane(5)]).status).toBe(0);
    expect(executions()).toBe(5);
    rewrite(r => r.map(x => ({ ...x, identity: 'f'.repeat(64) })));
    expect(run(['run', '--reuse', '--label', 'unit', '--', lane(5)]).status).toBe(0);
    expect(executions()).toBe(6);
  });

  // Value: protects=the max age applies to the original pass, never to a refreshed copy; fails_when=reuse makes an old pass look new
  test('a pass older than --max-age is not reused, and a reused copy keeps the age check honest', () => {
    expect(run(['run', '--label', 'unit', '--', lane(4)]).status).toBe(0);
    rewrite(r => r.map(x => ({ ...x, ts: new Date(Date.now() - 30 * 3600_000).toISOString() })));
    expect(run(['run', '--reuse', '--label', 'unit', '--', lane(4)]).status).toBe(0);
    expect(executions()).toBe(2);
    rewrite(r => r.map(x => ({ ...x, ts: new Date(Date.now() - 2 * 3600_000).toISOString() })));
    expect(run(['run', '--reuse', '--max-age', '1', '--label', 'unit', '--', lane(4)]).status).toBe(0);
    expect(executions()).toBe(3);
    rewrite(r => r.map(x => ({ ...x, ts: new Date(Date.now() - 3 * 3600_000).toISOString() })));
    expect(run(['run', '--reuse', '--label', 'unit', '--', lane(4)]).status).toBe(0);
    expect(executions()).toBe(3);
    expect(run(['check', '--label', 'unit', '--max-age', '2']).stdout).toContain('EVIDENCE: STALE label=unit');
  });
});

describe('gstack-evidence record-ci and carried (A4)', () => {
  const ci = (extra: string[] = []) => run(['record-ci', '--label', 'free', '--runs', '41/2', '--profiles', 'ci-reuse/free-tests', '--tree', wtree(), '--tests', '900', '--finished', new Date(Date.now() - 600_000).toISOString(), ...extra, '--', 'bun run test']);

  // Value: protects=a carried lane is an explicit CI row the FRESH check accepts by source; fails_when=carry fakes a local run or a check cannot tell them apart
  test('a CI-sourced row names its runs, is FRESH for the exact command, and never runs anything', () => {
    const r = ci();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('gstack-evidence: recorded label=free exit=0 tests_ran=900 log=- source=ci runs=41/2');
    const row = rows().at(-1);
    expect(row).toMatchObject({ label: 'free', source: 'ci', runs: ['41/2'], profiles: ['ci-reuse/free-tests'], exit: 0, tests_ran: 900, wtree: wtree(), duration_s: 0 });
    expect(row.log_path).toBeUndefined();
    const chk = run(['check', '--label', 'free', '--expect-cmd', 'bun run test', '--max-age', '24']);
    expect(chk.status).toBe(0);
    expect(chk.stdout).toContain('EVIDENCE: FRESH label=free exit=0 tests_ran=900');
    expect(chk.stdout).toContain('source=ci runs=41/2');
    const carried = run(['carried', '--json']);
    expect(JSON.parse(carried.stdout)).toEqual([{ lane: 'free', run: 41, attempt: 2, tree: wtree() }]);
  });

  // Value: protects=a carry binds to the working-tree fingerprint (A2); fails_when=a dirty tree or another tree records a carried row
  test('record-ci refuses a tree that is not the working tree, or a dirty tree, and writes nothing', () => {
    const bad = run(['record-ci', '--label', 'free', '--runs', '41/2', '--profiles', 'p', '--tree', 'a'.repeat(40), '--tests', '9', '--finished', new Date().toISOString(), '--', 'bun run test']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('is not the working tree');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    const dirty = ci();
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain('not HEAD\'s committed tree');
    expect(findFilesBySuffix(path.join(home, 'projects'), '-evidence.jsonl')).toEqual([]);
  });

  // Value: protects=the receipt names only carries at the current tree; fails_when=a stale carry from an earlier head reaches ci_carried
  test('carried lists nothing once the tree moves on', () => {
    expect(ci().status).toBe(0);
    fs.writeFileSync(path.join(repo, 'src.txt'), 'v2\n');
    gitIn(repo, 'commit -qam two');
    expect(JSON.parse(run(['carried', '--json']).stdout)).toEqual([]);
  });
});
