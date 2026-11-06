import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseReviewTargeted, plainDocsSince, targetedClassesSince } from '../lib/ship-receipt-depth';

const BIN = path.join(import.meta.dir, '..', 'bin');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const money = (cap: number) => `export const spendCapUsd = ${cap};\nexport function charge(amountUsd: number) { if (amountUsd > spendCapUsd) throw new Error("over cap"); return amountUsd; }\n`;

/**
 * The harness-evals #271 shape: the targeted reader read R, the loop stopped at the cap on S (a fix after R), the owner
 * granted one scoped fix-check naming S, and the granted round's fix commit moved HEAD past S.
 */
function granted(file: string, body: (n: number) => string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-targeted-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-targeted-state-'));
  dirs.push(dir, state);
  const env: NodeJS.ProcessEnv = { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_APPROVALS_MIRROR: '0' };
  delete env.GSTACK_APPROVALS_DIR;
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
  const commit = (files: Record<string, string>, msg: string) => {
    for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
    git('add', '.'); git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  commit({ 'README.md': '# x\n' }, 'base');
  git('checkout', '-qb', 'feat');
  const read = commit({ [file]: body(25) }, 'feature');
  const plan = (args: string[]) => spawnSync(path.join(BIN, 'gstack-review-plan'), ['--base', 'main', '--gate-tagged', '0', ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
  const patchOf = () => JSON.parse(plan(['--json']).stdout).targeted.targeted_patch_id as string;
  const readPatch = patchOf();
  const stop = commit({ [file]: body(30) }, 'round 2 fix');
  const add = spawnSync(path.join(BIN, 'gstack-approvals'), ['add', '--ask', `Owner grant: one scoped fix-check after round 2 (review_loop_grant ${stop.slice(0, 12)})`, '--words', 'do it', '--by', 'GStack Minder', '--scope', 'this /ship invocation', '--json'], { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
  expect(add.status, add.stderr).toBe(0);
  const grant = JSON.parse(add.stdout).added[0] as string;
  const head = commit({ [file]: body(35) }, 'granted round fix');
  const doneArgs = (ran: string) => ['--pass', '2', '--last', 'fix-check', '--fix-checks', '1', '--range-base', read, '--targeted-ran', ran];
  return { dir, read, readPatch, head, grant, plan, patchOf, doneArgs };
}
const dispatches = (stdout: string) => stdout.split('\n').filter(l => l.startsWith('DISPATCH: '));

describe('GST-1607: a granted fix round after the targeted read gets one targeted-only reader', () => {
  // Value: protects=the #271 shape has an exit: after the granted fix-check the loop is done, the granted round's fix moved the
  //   product patch the targeted record names, and with that grant the plan dispatches exactly one targeted reader for the head's
  //   classes, then plans done once its id comes back; the receipt refuses the record read before the fix and binds the one read
  //   at HEAD; fails_when=the plan prints NEXT: done with no reader (harness-evals #271), or keeps dispatching after the read;
  //   seam=bin/gstack-review-plan, parseReviewTargeted with the receipt's own carry predicates; no_claim=what the reader finds
  test('the #271 shape: one targeted reader under the grant, then the receipt binds its record', () => {
    const r = granted('src/billing.ts', money);
    const p = r.plan([...r.doneArgs(r.readPatch), '--grant', r.grant]);
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toContain(`NEXT: targeted (the loop is done and the owner's grant ${r.grant}`);
    expect(dispatches(p.stdout)).toEqual(['DISPATCH: targeted targeted effort=full classes=money']);
    expect(p.stdout).toContain(`TARGETED_DELTA: range_base=${r.read} paths=src/billing.ts classes=money`);
    const after = r.plan([...r.doneArgs(r.patchOf()), '--grant', r.grant]);
    expect(after.stdout).toContain('NEXT: done');
    expect(dispatches(after.stdout)).toEqual([]);
    const record = (at: string) => ({ classes: ['money'], rules: 'r', brief_sha: 'a'.repeat(64), status: 'done', findings: 0, raised_by: 'targeted', head: at });
    const productOf = (c: string) => spawnSync('git', ['patch-id', '--verbatim'], { input: spawnSync('git', ['diff', 'main', c], { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout, cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.split(' ')[0];
    const bind = (at: string) => parseReviewTargeted(record(at), productOf(r.head)!, productOf, from => targetedClassesSince(r.dir, from, r.head, 'main'), from => plainDocsSince(r.dir, from, r.head, 'main'));
    expect(bind(r.read).ok).toBe(false);
    expect(bind(r.head)).toMatchObject({ ok: true, targeted: { classes: ['money'], status: 'done' } });
  });

  // Value: protects=a granted round on a head with no targeted class adds no reader; fails_when=the grant alone dispatches the targeted
  //   reader; seam=bin/gstack-review-plan; no_claim=the fix-check itself
  test('a granted fix on a head with no targeted class adds no reader', () => {
    const r = granted('src/format.ts', n => `export const width = ${n};\nexport const pad = (s: string) => s.padEnd(width);\n`);
    const p = r.plan([...r.doneArgs(r.readPatch), '--grant', r.grant]);
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toContain('TARGETED: classes=none');
    expect(p.stdout).toContain('NEXT: done');
    expect(dispatches(p.stdout)).toEqual([]);
  });

  // Value: protects=without the owner's grant a code change after the read keeps today's route; fails_when=a code change alone
  //   dispatches the targeted-only reader; seam=bin/gstack-review-plan; no_claim=how finish routes it
  test('the same code change with no grant keeps done', () => {
    const r = granted('src/billing.ts', money);
    const p = r.plan(r.doneArgs(r.readPatch));
    expect(p.stdout).toContain('NEXT: done');
    expect(dispatches(p.stdout)).toEqual([]);
    expect(p.stdout).toContain('SKIP: targeted-only read (the change since range_base');
  });

  // Value: protects=a grant the approval record does not hold refuses before any plan; fails_when=a fabricated --grant prints a plan or
  //   dispatches the reader; seam=bin/gstack-review-plan's grant check; no_claim=who may grant
  test('a fabricated grant refuses', () => {
    const r = granted('src/billing.ts', money);
    const p = r.plan([...r.doneArgs(r.readPatch), '--grant', 'a-000000000000']);
    expect([p.status, p.stdout]).toEqual([3, '']);
    expect(p.stderr).toContain('--grant a-000000000000');
  });
});
