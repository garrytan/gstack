/**
 * gstack-evidence reuse and CI-sourced rows (GSTA-258 pieces 1-2, design fixes A4 and A5).
 *
 * run --reuse: a lane that passed at this exact working tree, command and execution identity never runs again;
 * the newest matching row decides (a newer failure vetoes), the reused row keeps its original timestamp and the
 * max age applies to it. record-ci: a lane CI carried is an explicit CI-sourced row for a run it verified itself, never a fictitious local run.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
  const ciRow = () => {
    const tree = wtree();
    return { ts: new Date(Date.now() - 600_000).toISOString(), label: 'free', command: 'bun run test', cmd_sha256: createHash('sha256').update('bun run test').digest('hex'), exit: 0, duration_s: 0, commit: gitIn(repo, 'rev-parse HEAD').trim(), tree, dirty: false, wtree: tree, tests_ran: 900, source: 'ci', runs: ['41/2'], profiles: ['ci-reuse/free-tests'], policy: 'origin/main@000000000000:.gstack/pregate.json' };
  };

  // Value: protects=a carried lane is an explicit CI row the FRESH check accepts by source, and the receipt lists it only at its own tree;
  //   fails_when=a check cannot tell a CI row from a local run, or a stale carry from an earlier head reaches ci_carried
  test('a CI-sourced row is FRESH for its exact command, and carried lists it only at its tree', () => {
    expect(run(['run', '--label', 'unit', '--', lane(2)]).status).toBe(0);
    fs.appendFileSync(ledger(), JSON.stringify(ciRow()) + '\n');
    const chk = run(['check', '--label', 'free', '--expect-cmd', 'bun run test', '--max-age', '24']);
    expect(chk.status).toBe(0);
    expect(chk.stdout).toContain('EVIDENCE: FRESH label=free exit=0 tests_ran=900');
    expect(chk.stdout).toContain('source=ci runs=41/2');
    expect(JSON.parse(run(['carried', '--base', 'main', '--json']).stdout)).toEqual([{ lane: 'free', run: 41, attempt: 2, tree: wtree() }]);
    expect(JSON.parse(run(['carried', '--base', 'release', '--json']).stdout)).toEqual([]);
    fs.writeFileSync(path.join(repo, 'src.txt'), 'v2\n');
    gitIn(repo, 'commit -qam two');
    expect(JSON.parse(run(['carried', '--json']).stdout)).toEqual([]);
  });

  // Value: protects=record-ci finds and verifies the CI run itself, so no caller supplies run ids, a test count or a tree (/ship pass 1 red-team#1);
  //   fails_when=the forged call from that finding writes a FRESH carried row; seam=no origin, so the base's ship_lanes_from is unreadable
  test('record-ci takes no run facts from its caller and records nothing without a verified run', () => {
    const forged = run(['record-ci', '--label', 'free', '--runs', '1/1', '--profiles', 'anything', '--tree', wtree(), '--tests', '999', '--finished', new Date().toISOString(), '--', 'bun run test']);
    expect(forged.status).toBe(2);
    expect(forged.stderr).toContain('usage: gstack-evidence record-ci --label <L> --base <base> -- <command>');
    const unverified = run(['record-ci', '--label', 'free', '--base', 'main', '--', 'bun run test']);
    expect(unverified.status).toBe(1);
    expect(unverified.stderr).toMatch(/^CARRY_NONE: config_unavailable: /m);
    expect(findFilesBySuffix(path.join(home, 'projects'), '-evidence.jsonl')).toEqual([]);
  });
});
